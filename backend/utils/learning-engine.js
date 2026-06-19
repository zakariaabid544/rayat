// Rayat Intelligence — Sprint 2.5 · Local / Global Learning + Delta Engine (additivo)
// Apprende come si comporta ogni serra (local) e l'intera flotta (global), poi confronta (delta + benchmark).
// READ-ONLY su agro_actions_detected + agro_pattern_intelligence + agro_triggers + agro_recovery_intelligence.
// SCRIVE SOLO su agro_local_learning, agro_global_learning, agro_learning_delta. Deterministico, esplicabile.
'use strict';
const { query } = require('../config/database');
const C = require('./intelligence-common');

const RULE_VERSION = 's2.5';
const LE = {
    OUTPERFORM_THR: Number(process.env.AGRO_LE_OUTPERFORM || 60),
    UNDERPERFORM_THR: Number(process.env.AGRO_LE_UNDERPERFORM || 40),
    MIN_EVENTS: Number(process.env.AGRO_LE_MIN_EVENTS || 5)
};
const STRESS_TYPES = new Set(['out_of_range', 'worsening', 'anomaly']);

async function ensureLearningSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_local_learning (
           id BIGSERIAL PRIMARY KEY,
           local_id TEXT NOT NULL UNIQUE,
           greenhouse_scope INTEGER NOT NULL,
           event_count INTEGER NOT NULL DEFAULT 0,
           baselines JSONB NULL,
           behavior_fingerprint JSONB NULL,
           recovery_fingerprint JSONB NULL,
           stress_fingerprint JSONB NULL,
           recovery_time_hours NUMERIC(10,2) NULL,
           most_common_failure TEXT NULL,
           most_common_success TEXT NULL,
           confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
           supporting_patterns JSONB NULL,
           evidence_json JSONB NULL,
           computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.5'
         )`
    );
    await query(
        `CREATE TABLE IF NOT EXISTS agro_global_learning (
           id BIGSERIAL PRIMARY KEY,
           global_id TEXT NOT NULL UNIQUE,
           greenhouse_count INTEGER NOT NULL DEFAULT 0,
           event_count INTEGER NOT NULL DEFAULT 0,
           baselines JSONB NULL,
           fleet_recovery JSONB NULL,
           best_practices JSONB NULL,
           common_failures JSONB NULL,
           common_recoveries JSONB NULL,
           common_triggers JSONB NULL,
           recovery_time_hours NUMERIC(10,2) NULL,
           confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
           evidence_json JSONB NULL,
           computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.5'
         )`
    );
    await query(
        `CREATE TABLE IF NOT EXISTS agro_learning_delta (
           id BIGSERIAL PRIMARY KEY,
           delta_id TEXT NOT NULL UNIQUE,
           greenhouse_scope INTEGER NOT NULL,
           baseline_delta NUMERIC(8,3) NULL,
           recovery_delta NUMERIC(8,3) NULL,
           trigger_delta NUMERIC(8,3) NULL,
           resilience_delta NUMERIC(8,3) NULL,
           performance_delta NUMERIC(8,3) NULL,
           benchmark_score SMALLINT NOT NULL DEFAULT 50,
           benchmark_category VARCHAR(20) NOT NULL,
           ranking_factors JSONB NULL,
           evidence_json JSONB NULL,
           computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.5'
         )`
    );
    await query('CREATE INDEX IF NOT EXISTS idx_local_gh ON agro_local_learning (greenhouse_scope)');
    await query('CREATE INDEX IF NOT EXISTS idx_delta_bench ON agro_learning_delta (benchmark_score DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_delta_cat ON agro_learning_delta (benchmark_category)');
}

// ---- loaders (read-only) ----
async function loadEventAggregates() {
    const rows = await query(
        `SELECT device_id, metric, event_type, value_snapshot FROM agro_actions_detected
         WHERE event_type IN ('out_of_range','return_to_range','improvement','worsening','stabilization','recovery','anomaly','regime_shift','sensor_drift')`
    );
    const perGh = new Map(); // device -> { total, stress, metricValues:Map(metric->[vals]) }
    let fleetTotal = 0, fleetStress = 0; const fleetMetricVals = new Map();
    for (const r of rows) {
        fleetTotal += 1; if (STRESS_TYPES.has(r.event_type)) { fleetStress += 1; }
        const v = C.num(r.value_snapshot);
        if (v !== null) { if (!fleetMetricVals.has(r.metric)) { fleetMetricVals.set(r.metric, []); } fleetMetricVals.get(r.metric).push(v); }
        let g = perGh.get(r.device_id);
        if (!g) { g = { total: 0, stress: 0, metricValues: new Map() }; perGh.set(r.device_id, g); }
        g.total += 1; if (STRESS_TYPES.has(r.event_type)) { g.stress += 1; }
        if (v !== null) { if (!g.metricValues.has(r.metric)) { g.metricValues.set(r.metric, []); } g.metricValues.get(r.metric).push(v); }
    }
    return { perGh, fleetTotal, fleetStress, fleetMetricVals };
}
const medMap = (mv) => { const o = {}; for (const [m, arr] of mv) { o[m] = C.round3(C.median(arr)); } return o; };

async function loadRecoveryIntel() {
    const rows = await query(`SELECT scope_type, greenhouse_scope, stress_type, recovery_speed_hours, recovery_quality, recovery_success_rate FROM agro_recovery_intelligence`);
    const gh = new Map(); const fleet = [];
    for (const r of rows) {
        if (r.scope_type === 'fleet') { fleet.push(r); }
        else { const k = r.greenhouse_scope; if (!gh.has(k)) { gh.set(k, []); } gh.get(k).push(r); }
    }
    return { gh, fleet };
}
async function loadTopPatterns() {
    const rows = await query(`SELECT scope_type, greenhouse_scope, pattern_type, event_sequence, is_top_success, is_top_failure, importance_score FROM agro_pattern_intelligence WHERE is_top_success = TRUE OR is_top_failure = TRUE`);
    return rows;
}
async function loadTriggers() {
    const rows = await query(`SELECT scope_type, greenhouse_scope, trigger_type, trigger_class, occurrences FROM agro_triggers`);
    const ghStress = new Map(); const fleetTriggers = [];
    for (const r of rows) {
        if (r.scope_type === 'fleet') { fleetTriggers.push(r); }
        else if (r.trigger_type === 'stress') { ghStress.set(r.greenhouse_scope, (ghStress.get(r.greenhouse_scope) || 0) + 1); }
    }
    return { ghStress, fleetTriggers };
}

function meanField(rows, field) { const a = (rows || []).map((r) => Number(r[field])).filter(Number.isFinite); return a.length ? C.mean(a) : null; }

async function runLearning({ now = new Date(), dryRun = false } = {}) {
    const summary = { local: 0, global: 0, delta: 0, outperforming: 0, matching: 0, underperforming: 0 };
    const agg = await loadEventAggregates();
    if (agg.fleetTotal === 0) { return summary; }
    const recIntel = await loadRecoveryIntel();
    const topPatterns = await loadTopPatterns();
    const triggers = await loadTriggers();

    // ---- GLOBAL ----
    const fleetBaselines = medMap(agg.fleetMetricVals);
    const fleetRecH = meanField(recIntel.fleet, 'recovery_speed_hours');
    const fleetRecQ = meanField(recIntel.fleet, 'recovery_quality');
    const fleetRecSucc = meanField(recIntel.fleet, 'recovery_success_rate');
    const fleetStressRate = agg.fleetTotal > 0 ? agg.fleetStress / agg.fleetTotal : 0;
    const fleetTopSuccess = topPatterns.filter((p) => p.scope_type === 'fleet' && p.is_top_success).map((p) => p.event_sequence);
    const fleetTopFailure = topPatterns.filter((p) => p.scope_type === 'fleet' && p.is_top_failure).map((p) => p.event_sequence);
    const fleetCommonTriggers = triggers.fleetTriggers.slice().sort((a, b) => b.occurrences - a.occurrences).slice(0, 5).map((t) => ({ class: t.trigger_class, type: t.trigger_type, occurrences: Number(t.occurrences) }));
    const globalConfidence = C.clamp01(C.normLog(agg.fleetTotal, 200));
    const globalRow = {
        global_id: 'FLEET', greenhouse_count: agg.perGh.size, event_count: agg.fleetTotal,
        baselines: fleetBaselines, fleet_recovery: { recovery_time_hours: C.round1(fleetRecH), quality: C.round3(fleetRecQ), success_rate: C.round3(fleetRecSucc) },
        best_practices: fleetTopSuccess, common_failures: fleetTopFailure, common_recoveries: recIntel.fleet.map((r) => ({ stress_type: r.stress_type, score_hours: C.round1(Number(r.recovery_speed_hours)) })),
        common_triggers: fleetCommonTriggers, recovery_time_hours: C.round1(fleetRecH), confidence: C.round3(globalConfidence),
        evidence_json: { event_count: agg.fleetTotal, greenhouse_count: agg.perGh.size, stress_rate: C.round3(fleetStressRate) }
    };
    if (!dryRun) { await upsertGlobal(globalRow); }
    summary.global = 1;

    // ---- LOCAL + DELTA per greenhouse ----
    const result = { global: globalRow, locals: [], deltas: [] };
    for (const [deviceId, g] of agg.perGh) {
        if (g.total < LE.MIN_EVENTS) { continue; }
        const baselines = medMap(g.metricValues);
        const ghRec = recIntel.gh.get(deviceId) || [];
        const localRecH = meanField(ghRec, 'recovery_speed_hours');
        const localRecQ = meanField(ghRec, 'recovery_quality');
        const localRecSucc = meanField(ghRec, 'recovery_success_rate');
        const localStressRate = g.total > 0 ? g.stress / g.total : 0;
        const ghTopSuccess = topPatterns.find((p) => p.scope_type === 'greenhouse' && Number(p.greenhouse_scope) === deviceId && p.is_top_success);
        const ghTopFailure = topPatterns.find((p) => p.scope_type === 'greenhouse' && Number(p.greenhouse_scope) === deviceId && p.is_top_failure);
        const localConfidence = C.clamp01(C.normLog(g.total, 60));
        const localRow = {
            local_id: C.deterministicId('gh', deviceId), greenhouse_scope: deviceId, event_count: g.total,
            baselines, behavior_fingerprint: baselines,
            recovery_fingerprint: { recovery_time_hours: C.round1(localRecH), quality: C.round3(localRecQ), success_rate: C.round3(localRecSucc) },
            stress_fingerprint: { stress_rate: C.round3(localStressRate), stress_triggers: triggers.ghStress.get(deviceId) || 0 },
            recovery_time_hours: C.round1(localRecH),
            most_common_failure: ghTopFailure ? ghTopFailure.event_sequence : null,
            most_common_success: ghTopSuccess ? ghTopSuccess.event_sequence : null,
            confidence: C.round3(localConfidence),
            supporting_patterns: [ghTopSuccess && ghTopSuccess.event_sequence, ghTopFailure && ghTopFailure.event_sequence].filter(Boolean),
            evidence_json: { event_count: g.total, stress_count: g.stress, metrics: Object.keys(baselines) }
        };
        if (!dryRun) { await upsertLocal(localRow); }
        summary.local += 1; result.locals.push(localRow);

        // ---- DELTA local vs global ----
        const metrics = Object.keys(baselines).filter((m) => fleetBaselines[m] != null && Number(fleetBaselines[m]) !== 0);
        const baselineDelta = metrics.length ? C.mean(metrics.map((m) => Math.abs(baselines[m] - fleetBaselines[m]) / Math.abs(fleetBaselines[m]))) : 0;
        const recoveryDelta = (localRecH != null && fleetRecH != null) ? (fleetRecH - localRecH) : 0; // ore risparmiate (positivo=meglio)
        const fleetAvgStressTriggers = triggers.fleetTriggers.filter((t) => t.trigger_type === 'stress').length / Math.max(1, agg.perGh.size);
        const triggerDelta = (triggers.ghStress.get(deviceId) || 0) - fleetAvgStressTriggers;
        const resilienceDelta = (localRecSucc != null && fleetRecSucc != null) ? (localRecSucc - fleetRecSucc) : 0;

        // vantaggi normalizzati [-1,1] -> benchmark 0-100 (50 = pari flotta)
        const aRecovery = fleetRecH ? Math.max(-1, Math.min(1, (fleetRecH - (localRecH || fleetRecH)) / fleetRecH)) : 0;
        const aQuality = (localRecQ != null && fleetRecQ != null) ? Math.max(-1, Math.min(1, localRecQ - fleetRecQ)) : 0;
        const aResilience = (localRecSucc != null && fleetRecSucc != null) ? Math.max(-1, Math.min(1, localRecSucc - fleetRecSucc)) : 0;
        const aStress = fleetStressRate > 0 ? Math.max(-1, Math.min(1, (fleetStressRate - localStressRate) / fleetStressRate)) : (localStressRate > 0 ? -1 : 0);
        const advantages = [aRecovery, aQuality, aResilience, aStress];
        const performanceDelta = C.mean(advantages);
        const benchmark = Math.round(Math.max(0, Math.min(100, 50 + 50 * performanceDelta)));
        const category = benchmark >= LE.OUTPERFORM_THR ? 'outperforming' : (benchmark <= LE.UNDERPERFORM_THR ? 'underperforming' : 'matching');

        const deltaRow = {
            delta_id: C.deterministicId('delta', deviceId), greenhouse_scope: deviceId,
            baseline_delta: C.round3(baselineDelta), recovery_delta: C.round1(recoveryDelta), trigger_delta: C.round3(triggerDelta),
            resilience_delta: C.round3(resilienceDelta), performance_delta: C.round3(performanceDelta),
            benchmark_score: benchmark, benchmark_category: category,
            ranking_factors: { a_recovery: C.round3(aRecovery), a_quality: C.round3(aQuality), a_resilience: C.round3(aResilience), a_stress: C.round3(aStress) },
            evidence_json: { local_stress_rate: C.round3(localStressRate), fleet_stress_rate: C.round3(fleetStressRate), local_recovery_h: C.round1(localRecH), fleet_recovery_h: C.round1(fleetRecH) }
        };
        if (!dryRun) { await upsertDelta(deltaRow); }
        summary.delta += 1; result.deltas.push(deltaRow);
        if (category === 'outperforming') { summary.outperforming += 1; } else if (category === 'underperforming') { summary.underperforming += 1; } else { summary.matching += 1; }
    }
    return dryRun ? { ...summary, ...result } : summary;
}

async function upsertGlobal(r) {
    await query(
        `INSERT INTO agro_global_learning (global_id, greenhouse_count, event_count, baselines, fleet_recovery, best_practices, common_failures, common_recoveries, common_triggers, recovery_time_hours, confidence, evidence_json, computed_at, rule_version)
         VALUES (?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?, ?, CAST(? AS JSONB), NOW(), ?)
         ON CONFLICT (global_id) DO UPDATE SET greenhouse_count=EXCLUDED.greenhouse_count, event_count=EXCLUDED.event_count, baselines=EXCLUDED.baselines,
           fleet_recovery=EXCLUDED.fleet_recovery, best_practices=EXCLUDED.best_practices, common_failures=EXCLUDED.common_failures,
           common_recoveries=EXCLUDED.common_recoveries, common_triggers=EXCLUDED.common_triggers, recovery_time_hours=EXCLUDED.recovery_time_hours,
           confidence=EXCLUDED.confidence, evidence_json=EXCLUDED.evidence_json, computed_at=NOW() RETURNING id`,
        [r.global_id, r.greenhouse_count, r.event_count, JSON.stringify(r.baselines), JSON.stringify(r.fleet_recovery), JSON.stringify(r.best_practices), JSON.stringify(r.common_failures), JSON.stringify(r.common_recoveries), JSON.stringify(r.common_triggers), r.recovery_time_hours, r.confidence, JSON.stringify(r.evidence_json), RULE_VERSION]
    );
}
async function upsertLocal(r) {
    await query(
        `INSERT INTO agro_local_learning (local_id, greenhouse_scope, event_count, baselines, behavior_fingerprint, recovery_fingerprint, stress_fingerprint, recovery_time_hours, most_common_failure, most_common_success, confidence, supporting_patterns, evidence_json, computed_at, rule_version)
         VALUES (?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), NOW(), ?)
         ON CONFLICT (local_id) DO UPDATE SET event_count=EXCLUDED.event_count, baselines=EXCLUDED.baselines, behavior_fingerprint=EXCLUDED.behavior_fingerprint,
           recovery_fingerprint=EXCLUDED.recovery_fingerprint, stress_fingerprint=EXCLUDED.stress_fingerprint, recovery_time_hours=EXCLUDED.recovery_time_hours,
           most_common_failure=EXCLUDED.most_common_failure, most_common_success=EXCLUDED.most_common_success, confidence=EXCLUDED.confidence,
           supporting_patterns=EXCLUDED.supporting_patterns, evidence_json=EXCLUDED.evidence_json, computed_at=NOW() RETURNING id`,
        [r.local_id, r.greenhouse_scope, r.event_count, JSON.stringify(r.baselines), JSON.stringify(r.behavior_fingerprint), JSON.stringify(r.recovery_fingerprint), JSON.stringify(r.stress_fingerprint), r.recovery_time_hours, r.most_common_failure, r.most_common_success, r.confidence, JSON.stringify(r.supporting_patterns), JSON.stringify(r.evidence_json), RULE_VERSION]
    );
}
async function upsertDelta(r) {
    await query(
        `INSERT INTO agro_learning_delta (delta_id, greenhouse_scope, baseline_delta, recovery_delta, trigger_delta, resilience_delta, performance_delta, benchmark_score, benchmark_category, ranking_factors, evidence_json, computed_at, rule_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), NOW(), ?)
         ON CONFLICT (delta_id) DO UPDATE SET baseline_delta=EXCLUDED.baseline_delta, recovery_delta=EXCLUDED.recovery_delta, trigger_delta=EXCLUDED.trigger_delta,
           resilience_delta=EXCLUDED.resilience_delta, performance_delta=EXCLUDED.performance_delta, benchmark_score=EXCLUDED.benchmark_score,
           benchmark_category=EXCLUDED.benchmark_category, ranking_factors=EXCLUDED.ranking_factors, evidence_json=EXCLUDED.evidence_json, computed_at=NOW() RETURNING id`,
        [r.delta_id, r.greenhouse_scope, r.baseline_delta, r.recovery_delta, r.trigger_delta, r.resilience_delta, r.performance_delta, r.benchmark_score, r.benchmark_category, JSON.stringify(r.ranking_factors), JSON.stringify(r.evidence_json), RULE_VERSION]
    );
}

module.exports = { ensureLearningSchema, runLearning, RULE_VERSION, LE };
