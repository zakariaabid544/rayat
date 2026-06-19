// Rayat Intelligence - Sprint 2.5/2.7A local learning and fleet benchmark engine.
// Local profiles are computed from one greenhouse only. Fleet data is comparison-only.
'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const {
    assertLocalIdentity,
    ensureLocalTenantSchema,
    fleetEligibility
} = require('./intelligence-tenancy');

const RULE_VERSION = 's2.7a';
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
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
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
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.7a'
         )`
    );
    await query(
        `CREATE TABLE IF NOT EXISTS agro_global_learning (
           id BIGSERIAL PRIMARY KEY,
           global_id TEXT NOT NULL UNIQUE,
           greenhouse_count INTEGER NOT NULL DEFAULT 0,
           distinct_owner_count INTEGER NOT NULL DEFAULT 0,
           distinct_device_count INTEGER NOT NULL DEFAULT 0,
           fleet_eligible BOOLEAN NOT NULL DEFAULT FALSE,
           benchmark_only BOOLEAN NOT NULL DEFAULT TRUE,
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
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.7a'
         )`
    );
    await query(
        `CREATE TABLE IF NOT EXISTS agro_learning_delta (
           id BIGSERIAL PRIMARY KEY,
           delta_id TEXT NOT NULL UNIQUE,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           greenhouse_scope INTEGER NOT NULL,
           fleet_eligible BOOLEAN NOT NULL DEFAULT FALSE,
           benchmark_only BOOLEAN NOT NULL DEFAULT TRUE,
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
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.7a'
         )`
    );

    await query('ALTER TABLE agro_global_learning ADD COLUMN IF NOT EXISTS distinct_owner_count INTEGER NOT NULL DEFAULT 0');
    await query('ALTER TABLE agro_global_learning ADD COLUMN IF NOT EXISTS distinct_device_count INTEGER NOT NULL DEFAULT 0');
    await query('ALTER TABLE agro_global_learning ADD COLUMN IF NOT EXISTS fleet_eligible BOOLEAN NOT NULL DEFAULT FALSE');
    await query('ALTER TABLE agro_global_learning ADD COLUMN IF NOT EXISTS benchmark_only BOOLEAN NOT NULL DEFAULT TRUE');
    await query('ALTER TABLE agro_learning_delta ADD COLUMN IF NOT EXISTS fleet_eligible BOOLEAN NOT NULL DEFAULT FALSE');
    await query('ALTER TABLE agro_learning_delta ADD COLUMN IF NOT EXISTS benchmark_only BOOLEAN NOT NULL DEFAULT TRUE');
    await ensureLocalTenantSchema('agro_local_learning');
    await ensureLocalTenantSchema('agro_learning_delta');
    await query('DELETE FROM agro_learning_delta WHERE fleet_eligible = FALSE');
    await query('DELETE FROM agro_global_learning WHERE fleet_eligible = FALSE');
    await query('CREATE INDEX IF NOT EXISTS idx_local_gh ON agro_local_learning (greenhouse_scope)');
    await query('CREATE INDEX IF NOT EXISTS idx_delta_bench ON agro_learning_delta (benchmark_score DESC) WHERE fleet_eligible = TRUE');
    await query('CREATE INDEX IF NOT EXISTS idx_delta_cat ON agro_learning_delta (benchmark_category) WHERE fleet_eligible = TRUE');
}

function addMetricValue(target, metric, valueSnapshot) {
    const value = C.num(valueSnapshot);
    if (value === null) { return; }
    if (!target.has(metric)) { target.set(metric, []); }
    target.get(metric).push(value);
}

// Pure aggregation used by the runtime and the multi-tenant regression suite.
function aggregateEventRows(rows) {
    const perGh = new Map();
    const fleetMetricVals = new Map();
    const ownerIds = new Set();
    const deviceIds = new Set();
    let fleetTotal = 0;
    let fleetStress = 0;

    for (const row of rows || []) {
        const identity = assertLocalIdentity({
            ownerUserId: row.owner_user_id,
            deviceId: row.device_id,
            context: 'learning-event'
        });
        fleetTotal += 1;
        if (STRESS_TYPES.has(row.event_type)) { fleetStress += 1; }
        addMetricValue(fleetMetricVals, row.metric, row.value_snapshot);
        ownerIds.add(identity.owner_user_id);
        deviceIds.add(identity.device_id);

        let greenhouse = perGh.get(identity.device_id);
        if (!greenhouse) {
            greenhouse = {
                owner_user_id: identity.owner_user_id,
                device_id: identity.device_id,
                total: 0,
                stress: 0,
                metricValues: new Map()
            };
            perGh.set(identity.device_id, greenhouse);
        } else if (greenhouse.owner_user_id !== identity.owner_user_id) {
            throw new Error('[learning-event] device ownership changed inside one learning timeline');
        }
        greenhouse.total += 1;
        if (STRESS_TYPES.has(row.event_type)) { greenhouse.stress += 1; }
        addMetricValue(greenhouse.metricValues, row.metric, row.value_snapshot);
    }
    return { perGh, fleetTotal, fleetStress, fleetMetricVals, ownerIds, deviceIds };
}

async function loadEventAggregates() {
    const rows = await query(
        `SELECT owner_user_id, device_id, metric, event_type, value_snapshot
         FROM agro_actions_detected
         WHERE event_type IN ('out_of_range','return_to_range','improvement','worsening','stabilization','recovery','anomaly','regime_shift','sensor_drift')`
    );
    return aggregateEventRows(rows);
}

const medMap = (metricValues) => {
    const result = {};
    for (const [metric, values] of metricValues) { result[metric] = C.round3(C.median(values)); }
    return result;
};

async function loadRecoveryIntel() {
    const rows = await query(
        `SELECT scope_type, owner_user_id, device_id, greenhouse_scope, stress_type,
                recovery_speed_hours, recovery_quality, recovery_success_rate
         FROM agro_recovery_intelligence
         WHERE scope_type = 'greenhouse' OR fleet_eligible = TRUE`
    );
    const gh = new Map();
    const fleet = [];
    for (const row of rows) {
        if (row.scope_type === 'fleet') { fleet.push(row); continue; }
        const identity = assertLocalIdentity({
            ownerUserId: row.owner_user_id,
            deviceId: row.device_id,
            greenhouseScope: row.greenhouse_scope,
            context: 'learning-recovery'
        });
        if (!gh.has(identity.device_id)) { gh.set(identity.device_id, []); }
        gh.get(identity.device_id).push(row);
    }
    return { gh, fleet };
}

async function loadTopPatterns() {
    const rows = await query(
        `SELECT scope_type, owner_user_id, device_id, greenhouse_scope, pattern_type,
                event_sequence, is_top_success, is_top_failure, importance_score
         FROM agro_pattern_intelligence
         WHERE (is_top_success = TRUE OR is_top_failure = TRUE)
           AND (scope_type = 'greenhouse' OR fleet_eligible = TRUE)`
    );
    for (const row of rows) {
        if (row.scope_type === 'greenhouse') {
            assertLocalIdentity({
                ownerUserId: row.owner_user_id,
                deviceId: row.device_id,
                greenhouseScope: row.greenhouse_scope,
                context: 'learning-pattern'
            });
        }
    }
    return rows;
}

async function loadTriggers() {
    const rows = await query(
        `SELECT scope_type, owner_user_id, device_id, greenhouse_scope, trigger_type,
                trigger_class, occurrences
         FROM agro_triggers
         WHERE scope_type = 'greenhouse' OR fleet_eligible = TRUE`
    );
    const ghStress = new Map();
    const fleetTriggers = [];
    for (const row of rows) {
        if (row.scope_type === 'fleet') { fleetTriggers.push(row); continue; }
        const identity = assertLocalIdentity({
            ownerUserId: row.owner_user_id,
            deviceId: row.device_id,
            greenhouseScope: row.greenhouse_scope,
            context: 'learning-trigger'
        });
        if (row.trigger_type === 'stress') {
            ghStress.set(identity.device_id, (ghStress.get(identity.device_id) || 0) + 1);
        }
    }
    return { ghStress, fleetTriggers };
}

function meanField(rows, field) {
    const values = (rows || []).map((row) => Number(row[field])).filter(Number.isFinite);
    return values.length ? C.mean(values) : null;
}

async function runLearning({ now = new Date(), dryRun = false } = {}) {
    void now;
    const summary = {
        local: 0, global: 0, delta: 0,
        outperforming: 0, matching: 0, underperforming: 0,
        fleet_eligible: false, distinct_customers: 0
    };
    if (!dryRun) {
        // Rebuild benchmark deltas from the current eligible cohort; local profiles are untouched.
        await query('UPDATE agro_learning_delta SET fleet_eligible = FALSE, benchmark_only = TRUE');
        await query('DELETE FROM agro_global_learning');
    }
    const agg = await loadEventAggregates();
    if (agg.fleetTotal === 0) {
        if (!dryRun) { await query('DELETE FROM agro_learning_delta WHERE fleet_eligible = FALSE'); }
        return summary;
    }
    const privacy = fleetEligibility([...agg.ownerIds], [...agg.deviceIds]);
    summary.fleet_eligible = privacy.fleet_eligible;
    summary.distinct_customers = privacy.distinct_owner_count;

    const recIntel = await loadRecoveryIntel();
    const topPatterns = await loadTopPatterns();
    const triggers = await loadTriggers();
    const fleetBaselines = privacy.fleet_eligible ? medMap(agg.fleetMetricVals) : {};
    const fleetRecH = privacy.fleet_eligible ? meanField(recIntel.fleet, 'recovery_speed_hours') : null;
    const fleetRecQ = privacy.fleet_eligible ? meanField(recIntel.fleet, 'recovery_quality') : null;
    const fleetRecSucc = privacy.fleet_eligible ? meanField(recIntel.fleet, 'recovery_success_rate') : null;
    const fleetStressRate = privacy.fleet_eligible && agg.fleetTotal > 0 ? agg.fleetStress / agg.fleetTotal : 0;
    const fleetTopSuccess = privacy.fleet_eligible
        ? topPatterns.filter((p) => p.scope_type === 'fleet' && p.is_top_success).map((p) => p.event_sequence)
        : [];
    const fleetTopFailure = privacy.fleet_eligible
        ? topPatterns.filter((p) => p.scope_type === 'fleet' && p.is_top_failure).map((p) => p.event_sequence)
        : [];
    const fleetCommonTriggers = privacy.fleet_eligible
        ? triggers.fleetTriggers.slice().sort((a, b) => b.occurrences - a.occurrences).slice(0, 5)
            .map((trigger) => ({ class: trigger.trigger_class, type: trigger.trigger_type, occurrences: Number(trigger.occurrences) }))
        : [];
    const globalConfidence = privacy.fleet_eligible ? C.clamp01(C.normLog(agg.fleetTotal, 200)) : 0;
    const globalRow = {
        global_id: 'FLEET', greenhouse_count: privacy.distinct_device_count,
        distinct_owner_count: privacy.distinct_owner_count,
        distinct_device_count: privacy.distinct_device_count,
        fleet_eligible: privacy.fleet_eligible, benchmark_only: true,
        event_count: privacy.fleet_eligible ? agg.fleetTotal : 0,
        baselines: fleetBaselines,
        fleet_recovery: privacy.fleet_eligible
            ? { recovery_time_hours: C.round1(fleetRecH), quality: C.round3(fleetRecQ), success_rate: C.round3(fleetRecSucc) }
            : {},
        best_practices: fleetTopSuccess,
        common_failures: fleetTopFailure,
        common_recoveries: privacy.fleet_eligible
            ? recIntel.fleet.map((row) => ({ stress_type: row.stress_type, score_hours: C.round1(Number(row.recovery_speed_hours)) }))
            : [],
        common_triggers: fleetCommonTriggers,
        recovery_time_hours: C.round1(fleetRecH), confidence: C.round3(globalConfidence),
        evidence_json: {
            distinct_owner_count: privacy.distinct_owner_count,
            distinct_device_count: privacy.distinct_device_count,
            minimum_distinct_customers: privacy.minimum_distinct_customers,
            benchmark_only: true,
            suppressed: !privacy.fleet_eligible
        }
    };
    summary.global = 1;

    const result = { global: globalRow, locals: [], deltas: [] };
    for (const [deviceId, greenhouse] of agg.perGh) {
        if (greenhouse.total < LE.MIN_EVENTS) { continue; }
        const identity = assertLocalIdentity({
            ownerUserId: greenhouse.owner_user_id,
            deviceId,
            context: 'local-learning'
        });
        const baselines = medMap(greenhouse.metricValues);
        const ghRec = recIntel.gh.get(deviceId) || [];
        const localRecH = meanField(ghRec, 'recovery_speed_hours');
        const localRecQ = meanField(ghRec, 'recovery_quality');
        const localRecSucc = meanField(ghRec, 'recovery_success_rate');
        const localStressRate = greenhouse.total > 0 ? greenhouse.stress / greenhouse.total : 0;
        const ghTopSuccess = topPatterns.find((pattern) => pattern.scope_type === 'greenhouse'
            && Number(pattern.greenhouse_scope) === deviceId && pattern.is_top_success);
        const ghTopFailure = topPatterns.find((pattern) => pattern.scope_type === 'greenhouse'
            && Number(pattern.greenhouse_scope) === deviceId && pattern.is_top_failure);
        const localConfidence = C.clamp01(C.normLog(greenhouse.total, 60));
        const localRow = {
            local_id: C.deterministicId('gh', deviceId),
            owner_user_id: identity.owner_user_id,
            device_id: identity.device_id,
            greenhouse_scope: identity.device_id,
            event_count: greenhouse.total,
            baselines,
            behavior_fingerprint: baselines,
            recovery_fingerprint: {
                recovery_time_hours: C.round1(localRecH),
                quality: C.round3(localRecQ),
                success_rate: C.round3(localRecSucc)
            },
            stress_fingerprint: {
                stress_rate: C.round3(localStressRate),
                stress_triggers: triggers.ghStress.get(deviceId) || 0
            },
            recovery_time_hours: C.round1(localRecH),
            most_common_failure: ghTopFailure ? ghTopFailure.event_sequence : null,
            most_common_success: ghTopSuccess ? ghTopSuccess.event_sequence : null,
            confidence: C.round3(localConfidence),
            supporting_patterns: [
                ghTopSuccess && ghTopSuccess.event_sequence,
                ghTopFailure && ghTopFailure.event_sequence
            ].filter(Boolean),
            evidence_json: {
                owner_user_id: identity.owner_user_id,
                device_id: identity.device_id,
                event_count: greenhouse.total,
                stress_count: greenhouse.stress,
                metrics: Object.keys(baselines)
            }
        };
        if (!dryRun) { await upsertLocal(localRow); }
        summary.local += 1;
        result.locals.push(localRow);

        // The benchmark observes the local profile; it never mutates or overrides it.
        if (!privacy.fleet_eligible) { continue; }
        const metrics = Object.keys(baselines).filter((metric) => fleetBaselines[metric] != null && Number(fleetBaselines[metric]) !== 0);
        const baselineDelta = metrics.length
            ? C.mean(metrics.map((metric) => Math.abs(baselines[metric] - fleetBaselines[metric]) / Math.abs(fleetBaselines[metric])))
            : 0;
        const recoveryDelta = localRecH != null && fleetRecH != null ? fleetRecH - localRecH : 0;
        const fleetAvgStressTriggers = triggers.fleetTriggers.filter((trigger) => trigger.trigger_type === 'stress').length
            / Math.max(1, privacy.distinct_device_count);
        const triggerDelta = (triggers.ghStress.get(deviceId) || 0) - fleetAvgStressTriggers;
        const resilienceDelta = localRecSucc != null && fleetRecSucc != null ? localRecSucc - fleetRecSucc : 0;
        const aRecovery = fleetRecH
            ? Math.max(-1, Math.min(1, (fleetRecH - (localRecH || fleetRecH)) / fleetRecH)) : 0;
        const aQuality = localRecQ != null && fleetRecQ != null ? Math.max(-1, Math.min(1, localRecQ - fleetRecQ)) : 0;
        const aResilience = localRecSucc != null && fleetRecSucc != null ? Math.max(-1, Math.min(1, localRecSucc - fleetRecSucc)) : 0;
        const aStress = fleetStressRate > 0
            ? Math.max(-1, Math.min(1, (fleetStressRate - localStressRate) / fleetStressRate))
            : (localStressRate > 0 ? -1 : 0);
        const performanceDelta = C.mean([aRecovery, aQuality, aResilience, aStress]);
        const benchmark = Math.round(Math.max(0, Math.min(100, 50 + 50 * performanceDelta)));
        const category = benchmark >= LE.OUTPERFORM_THR
            ? 'outperforming'
            : (benchmark <= LE.UNDERPERFORM_THR ? 'underperforming' : 'matching');
        const deltaRow = {
            delta_id: C.deterministicId('delta', deviceId),
            owner_user_id: identity.owner_user_id,
            device_id: identity.device_id,
            greenhouse_scope: identity.device_id,
            fleet_eligible: true,
            benchmark_only: true,
            baseline_delta: C.round3(baselineDelta),
            recovery_delta: C.round1(recoveryDelta),
            trigger_delta: C.round3(triggerDelta),
            resilience_delta: C.round3(resilienceDelta),
            performance_delta: C.round3(performanceDelta),
            benchmark_score: benchmark,
            benchmark_category: category,
            ranking_factors: {
                a_recovery: C.round3(aRecovery), a_quality: C.round3(aQuality),
                a_resilience: C.round3(aResilience), a_stress: C.round3(aStress)
            },
            evidence_json: {
                benchmark_only: true,
                distinct_owner_count: privacy.distinct_owner_count,
                local_stress_rate: C.round3(localStressRate),
                fleet_stress_rate: C.round3(fleetStressRate),
                local_recovery_h: C.round1(localRecH),
                fleet_recovery_h: C.round1(fleetRecH)
            }
        };
        summary.delta += 1;
        result.deltas.push(deltaRow);
        if (category === 'outperforming') { summary.outperforming += 1; }
        else if (category === 'underperforming') { summary.underperforming += 1; }
        else { summary.matching += 1; }
    }
    if (!dryRun) {
        // Every local profile is persisted before any fleet benchmark is published.
        await upsertGlobal(globalRow);
        for (const deltaRow of result.deltas) { await upsertDelta(deltaRow); }
        await query('DELETE FROM agro_learning_delta WHERE fleet_eligible = FALSE');
    }
    return dryRun ? { ...summary, ...result } : summary;
}

async function upsertGlobal(row) {
    await query(
        `INSERT INTO agro_global_learning
            (global_id, greenhouse_count, distinct_owner_count, distinct_device_count, fleet_eligible, benchmark_only,
             event_count, baselines, fleet_recovery, best_practices, common_failures, common_recoveries,
             common_triggers, recovery_time_hours, confidence, evidence_json, computed_at, rule_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB),
                 CAST(? AS JSONB), CAST(? AS JSONB), ?, ?, CAST(? AS JSONB), NOW(), ?)
         ON CONFLICT (global_id) DO UPDATE SET
           greenhouse_count=EXCLUDED.greenhouse_count, distinct_owner_count=EXCLUDED.distinct_owner_count,
           distinct_device_count=EXCLUDED.distinct_device_count, fleet_eligible=EXCLUDED.fleet_eligible,
           benchmark_only=TRUE, event_count=EXCLUDED.event_count, baselines=EXCLUDED.baselines,
           fleet_recovery=EXCLUDED.fleet_recovery, best_practices=EXCLUDED.best_practices,
           common_failures=EXCLUDED.common_failures, common_recoveries=EXCLUDED.common_recoveries,
           common_triggers=EXCLUDED.common_triggers, recovery_time_hours=EXCLUDED.recovery_time_hours,
           confidence=EXCLUDED.confidence, evidence_json=EXCLUDED.evidence_json, computed_at=NOW(), rule_version=EXCLUDED.rule_version`,
        [
            row.global_id, row.greenhouse_count, row.distinct_owner_count, row.distinct_device_count,
            row.fleet_eligible, row.benchmark_only, row.event_count, JSON.stringify(row.baselines),
            JSON.stringify(row.fleet_recovery), JSON.stringify(row.best_practices), JSON.stringify(row.common_failures),
            JSON.stringify(row.common_recoveries), JSON.stringify(row.common_triggers), row.recovery_time_hours,
            row.confidence, JSON.stringify(row.evidence_json), RULE_VERSION
        ]
    );
}

async function upsertLocal(row) {
    const identity = assertLocalIdentity({
        ownerUserId: row.owner_user_id,
        deviceId: row.device_id,
        greenhouseScope: row.greenhouse_scope,
        context: 'local-learning-upsert'
    });
    await query(
        `INSERT INTO agro_local_learning
            (local_id, owner_user_id, device_id, greenhouse_scope, event_count, baselines,
             behavior_fingerprint, recovery_fingerprint, stress_fingerprint, recovery_time_hours,
             most_common_failure, most_common_success, confidence, supporting_patterns, evidence_json,
             computed_at, rule_version)
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB),
                 ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), NOW(), ?)
         ON CONFLICT (local_id) DO UPDATE SET
           owner_user_id=EXCLUDED.owner_user_id, device_id=EXCLUDED.device_id,
           greenhouse_scope=EXCLUDED.greenhouse_scope, event_count=EXCLUDED.event_count,
           baselines=EXCLUDED.baselines, behavior_fingerprint=EXCLUDED.behavior_fingerprint,
           recovery_fingerprint=EXCLUDED.recovery_fingerprint, stress_fingerprint=EXCLUDED.stress_fingerprint,
           recovery_time_hours=EXCLUDED.recovery_time_hours, most_common_failure=EXCLUDED.most_common_failure,
           most_common_success=EXCLUDED.most_common_success, confidence=EXCLUDED.confidence,
           supporting_patterns=EXCLUDED.supporting_patterns, evidence_json=EXCLUDED.evidence_json,
           computed_at=NOW(), rule_version=EXCLUDED.rule_version`,
        [
            row.local_id, identity.owner_user_id, identity.device_id, identity.greenhouse_scope,
            row.event_count, JSON.stringify(row.baselines), JSON.stringify(row.behavior_fingerprint),
            JSON.stringify(row.recovery_fingerprint), JSON.stringify(row.stress_fingerprint),
            row.recovery_time_hours, row.most_common_failure, row.most_common_success, row.confidence,
            JSON.stringify(row.supporting_patterns), JSON.stringify(row.evidence_json), RULE_VERSION
        ]
    );
}

async function upsertDelta(row) {
    const identity = assertLocalIdentity({
        ownerUserId: row.owner_user_id,
        deviceId: row.device_id,
        greenhouseScope: row.greenhouse_scope,
        context: 'learning-delta-upsert'
    });
    await query(
        `INSERT INTO agro_learning_delta
            (delta_id, owner_user_id, device_id, greenhouse_scope, fleet_eligible, benchmark_only,
             baseline_delta, recovery_delta, trigger_delta, resilience_delta, performance_delta,
             benchmark_score, benchmark_category, ranking_factors, evidence_json, computed_at, rule_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), NOW(), ?)
         ON CONFLICT (delta_id) DO UPDATE SET
           owner_user_id=EXCLUDED.owner_user_id, device_id=EXCLUDED.device_id,
           greenhouse_scope=EXCLUDED.greenhouse_scope, fleet_eligible=EXCLUDED.fleet_eligible,
           benchmark_only=TRUE, baseline_delta=EXCLUDED.baseline_delta, recovery_delta=EXCLUDED.recovery_delta,
           trigger_delta=EXCLUDED.trigger_delta, resilience_delta=EXCLUDED.resilience_delta,
           performance_delta=EXCLUDED.performance_delta, benchmark_score=EXCLUDED.benchmark_score,
           benchmark_category=EXCLUDED.benchmark_category, ranking_factors=EXCLUDED.ranking_factors,
           evidence_json=EXCLUDED.evidence_json, computed_at=NOW(), rule_version=EXCLUDED.rule_version`,
        [
            row.delta_id, identity.owner_user_id, identity.device_id, identity.greenhouse_scope,
            row.fleet_eligible, row.benchmark_only, row.baseline_delta, row.recovery_delta,
            row.trigger_delta, row.resilience_delta, row.performance_delta, row.benchmark_score,
            row.benchmark_category, JSON.stringify(row.ranking_factors), JSON.stringify(row.evidence_json), RULE_VERSION
        ]
    );
}

module.exports = { ensureLearningSchema, runLearning, aggregateEventRows, RULE_VERSION, LE };
