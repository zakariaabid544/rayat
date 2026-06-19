// Rayat Intelligence — Sprint 2.4 · Stress Trigger Intelligence Engine (additivo)
// Trasforma i trigger grezzi (agro_triggers) in intelligence: strength/severity/stability/recovery_cost/score
// e ranking per scope (Top Dangerous/Frequent/Expensive/Emerging). READ-ONLY su agro_triggers + agro_actions_detected.
// SCRIVE SOLO su agro_trigger_intelligence. Deterministico, esplicabile.
'use strict';
const { query } = require('../config/database');
const C = require('./intelligence-common');

const RULE_VERSION = 's2.4-trigger';

const TI = {
    OCC_REF: Number(process.env.AGRO_TI_OCC_REF || 20),
    COST_REF_HOURS: Number(process.env.AGRO_TI_COST_REF_HOURS || 72),
    RECENCY_REF_DAYS: Number(process.env.AGRO_TI_RECENCY_DAYS || 90),
    W_STRENGTH: Number(process.env.AGRO_TI_W_STRENGTH || 0.35),
    W_SEVERITY: Number(process.env.AGRO_TI_W_SEVERITY || 0.30),
    W_STABILITY: Number(process.env.AGRO_TI_W_STABILITY || 0.20),
    W_COST: Number(process.env.AGRO_TI_W_COST || 0.15)
};

const CONSEQUENT_SEVERITY = { out_of_range: 1.0, worsening: 0.8, anomaly: 0.6, sensor_drift: 0.5, regime_shift: 0.5 };

function computeTriggerIntelligence(t, recoveryCostHours) {
    const fpr = C.clamp01(Number(t.false_positive_rate));
    const occ = Number(t.occurrences);
    const leadAvg = Number(t.lead_time_avg_hours) || 0;
    const leadVar = Number(t.lead_time_variance) || 0;
    const leadCV = leadAvg > 0 ? Math.sqrt(Math.max(0, leadVar)) / leadAvg : 0;
    const recencyDays = t.last_seen ? C.daysBetween(Date.now(), new Date(t.last_seen).getTime()) : 999;

    const strength = C.clamp01(0.5 * (1 - fpr) + 0.5 * C.normLog(occ, TI.OCC_REF));
    const baseSev = CONSEQUENT_SEVERITY[t.consequent_event] != null ? CONSEQUENT_SEVERITY[t.consequent_event] : 0.4;
    const urgency = 1 - C.clamp01(leadAvg / (24 * 7)); // lead piu breve = piu urgente
    const severity = C.clamp01(baseSev * (0.6 + 0.4 * urgency));
    const stability = C.clamp01(0.6 * (1 - C.clamp01(leadCV)) + 0.4 * C.recencyFactor(recencyDays, TI.RECENCY_REF_DAYS));
    const costFactor = C.normLog(recoveryCostHours || 0, TI.COST_REF_HOURS);
    const score01 = TI.W_STRENGTH * strength + TI.W_SEVERITY * severity + TI.W_STABILITY * stability + TI.W_COST * costFactor;

    return {
        trigger_strength: C.round3(strength),
        trigger_severity: C.round3(severity),
        trigger_stability: C.round3(stability),
        recovery_cost_hours: C.round1(recoveryCostHours || 0),
        trigger_intelligence_score: Math.round(100 * C.clamp01(score01)),
        ranking_factors: { strength: C.round3(strength), severity: C.round3(severity), stability: C.round3(stability), cost_factor: C.round3(costFactor), weights: { wS: TI.W_STRENGTH, wSev: TI.W_SEVERITY, wStab: TI.W_STABILITY, wCost: TI.W_COST } },
        _recencyDays: recencyDays
    };
}

async function ensureTriggerIntelligenceSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_trigger_intelligence (
           id BIGSERIAL PRIMARY KEY,
           ti_id TEXT NOT NULL UNIQUE,
           trigger_ref TEXT NOT NULL,
           trigger_type VARCHAR(12) NOT NULL,
           trigger_class VARCHAR(24) NOT NULL,
           consequent_event VARCHAR(40) NOT NULL,
           scope_type VARCHAR(12) NOT NULL,
           greenhouse_scope INTEGER NULL,
           fleet_scope BOOLEAN NOT NULL DEFAULT FALSE,
           occurrences INTEGER NOT NULL DEFAULT 0,
           trigger_strength NUMERIC(4,3) NULL,
           trigger_severity NUMERIC(4,3) NULL,
           trigger_stability NUMERIC(4,3) NULL,
           recovery_cost_hours NUMERIC(10,2) NULL,
           trigger_intelligence_score SMALLINT NOT NULL DEFAULT 0,
           is_top_dangerous BOOLEAN NOT NULL DEFAULT FALSE,
           is_top_frequent BOOLEAN NOT NULL DEFAULT FALSE,
           is_top_expensive BOOLEAN NOT NULL DEFAULT FALSE,
           is_top_emerging BOOLEAN NOT NULL DEFAULT FALSE,
           rank_dangerous SMALLINT NULL,
           importance_factors JSONB NULL,
           confidence_factors JSONB NULL,
           evidence_json JSONB NULL,
           supporting_event_ids JSONB NULL,
           computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.4-trigger'
         )`
    );
    await query('CREATE INDEX IF NOT EXISTS idx_ti_scope ON agro_trigger_intelligence (scope_type, greenhouse_scope, trigger_type)');
    await query('CREATE INDEX IF NOT EXISTS idx_ti_score ON agro_trigger_intelligence (trigger_intelligence_score DESC)');
}

async function loadRecoveryCosts() {
    // costo di recovery (ore) per metric e per scope, da eventi recovery reali
    const rows = await query(
        `SELECT device_id, metric, duration_seconds FROM agro_actions_detected
         WHERE event_type = 'recovery' AND duration_seconds IS NOT NULL`
    );
    const fleetByMetric = new Map(); const ghByMetric = new Map();
    for (const r of rows) {
        const h = Number(r.duration_seconds) / 3600;
        const fk = String(r.metric);
        if (!fleetByMetric.has(fk)) { fleetByMetric.set(fk, []); }
        fleetByMetric.get(fk).push(h);
        const gk = `${r.device_id}|${r.metric}`;
        if (!ghByMetric.has(gk)) { ghByMetric.set(gk, []); }
        ghByMetric.get(gk).push(h);
    }
    return (scopeType, gh, metric) => {
        const arr = scopeType === 'fleet' ? fleetByMetric.get(String(metric)) : ghByMetric.get(`${gh}|${metric}`);
        return arr && arr.length ? C.mean(arr) : 0;
    };
}

async function loadTriggers() {
    return query(
        `SELECT trigger_id, trigger_type, trigger_class, metric, consequent_event, occurrences, false_positive_rate,
                lead_time_avg_hours, lead_time_variance, confidence, confidence_factors, supporting_examples,
                scope_type, greenhouse_scope, fleet_scope, last_seen
         FROM agro_triggers`
    );
}

async function upsertTI(row) {
    await query(
        `INSERT INTO agro_trigger_intelligence
            (ti_id, trigger_ref, trigger_type, trigger_class, consequent_event, scope_type, greenhouse_scope, fleet_scope,
             occurrences, trigger_strength, trigger_severity, trigger_stability, recovery_cost_hours, trigger_intelligence_score,
             is_top_dangerous, is_top_frequent, is_top_expensive, is_top_emerging, rank_dangerous,
             importance_factors, confidence_factors, evidence_json, supporting_event_ids, computed_at, rule_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), NOW(), ?)
         ON CONFLICT (ti_id) DO UPDATE SET
             occurrences=EXCLUDED.occurrences, trigger_strength=EXCLUDED.trigger_strength, trigger_severity=EXCLUDED.trigger_severity,
             trigger_stability=EXCLUDED.trigger_stability, recovery_cost_hours=EXCLUDED.recovery_cost_hours,
             trigger_intelligence_score=EXCLUDED.trigger_intelligence_score, is_top_dangerous=EXCLUDED.is_top_dangerous,
             is_top_frequent=EXCLUDED.is_top_frequent, is_top_expensive=EXCLUDED.is_top_expensive, is_top_emerging=EXCLUDED.is_top_emerging,
             rank_dangerous=EXCLUDED.rank_dangerous, importance_factors=EXCLUDED.importance_factors,
             confidence_factors=EXCLUDED.confidence_factors, evidence_json=EXCLUDED.evidence_json,
             supporting_event_ids=EXCLUDED.supporting_event_ids, computed_at=NOW()
         RETURNING id`,
        [
            row.ti_id, row.trigger_ref, row.trigger_type, row.trigger_class, row.consequent_event, row.scope_type, row.greenhouse_scope, row.fleet_scope,
            row.occurrences, row.trigger_strength, row.trigger_severity, row.trigger_stability, row.recovery_cost_hours, row.trigger_intelligence_score,
            row.is_top_dangerous, row.is_top_frequent, row.is_top_expensive, row.is_top_emerging, row.rank_dangerous,
            JSON.stringify(row.importance_factors), JSON.stringify(row.confidence_factors || {}), JSON.stringify(row.evidence_json || {}),
            JSON.stringify(row.supporting_event_ids || []), RULE_VERSION
        ]
    );
}

async function runTriggerIntelligence({ now = new Date(), dryRun = false } = {}) {
    const summary = { triggers: 0, top_dangerous: 0, top_frequent: 0, top_expensive: 0, top_emerging: 0, scopes: 0 };
    const triggers = await loadTriggers();
    if (!triggers.length) { return summary; }
    const costFor = await loadRecoveryCosts();

    const enriched = triggers.map((t) => {
        const cost = costFor(t.scope_type, t.greenhouse_scope, t.metric);
        const ti = computeTriggerIntelligence(t, cost);
        return {
            ti_id: C.deterministicId('ti', t.trigger_id), trigger_ref: t.trigger_id,
            trigger_type: t.trigger_type, trigger_class: t.trigger_class, consequent_event: t.consequent_event,
            scope_type: t.scope_type, greenhouse_scope: t.greenhouse_scope, fleet_scope: !!t.fleet_scope,
            occurrences: Number(t.occurrences),
            trigger_strength: ti.trigger_strength, trigger_severity: ti.trigger_severity, trigger_stability: ti.trigger_stability,
            recovery_cost_hours: ti.recovery_cost_hours, trigger_intelligence_score: ti.trigger_intelligence_score,
            importance_factors: ti.ranking_factors, confidence_factors: C.parseJson(t.confidence_factors, {}),
            supporting_event_ids: C.parseJson(t.supporting_examples, []),
            evidence_json: { recovery_cost_hours: ti.recovery_cost_hours, false_positive_rate: Number(t.false_positive_rate), confidence: Number(t.confidence) },
            is_top_dangerous: false, is_top_frequent: false, is_top_expensive: false, is_top_emerging: false, rank_dangerous: null,
            // scope key include trigger_type: stress e recovery sono classificati/ranking SEPARATAMENTE
            _recencyDays: ti._recencyDays, _scopeKey: `${t.scope_type}|${t.greenhouse_scope == null ? 'F' : t.greenhouse_scope}|${t.trigger_type}`
        };
    });

    const byScope = new Map();
    for (const e of enriched) { if (!byScope.has(e._scopeKey)) { byScope.set(e._scopeKey, []); } byScope.get(e._scopeKey).push(e); }
    summary.scopes = byScope.size;
    const top = (arr, cmp, flag) => { const s = arr.slice().sort(cmp); if (s[0]) { s[0][flag] = true; return 1; } return 0; };
    for (const arr of byScope.values()) {
        const byDanger = arr.slice().sort((a, b) => b.trigger_severity - a.trigger_severity || b.trigger_intelligence_score - a.trigger_intelligence_score || a.trigger_ref.localeCompare(b.trigger_ref));
        byDanger.forEach((x, i) => { x.rank_dangerous = i + 1; });
        if (byDanger[0]) { byDanger[0].is_top_dangerous = true; summary.top_dangerous += 1; }
        summary.top_frequent += top(arr, (a, b) => b.occurrences - a.occurrences || a.trigger_ref.localeCompare(b.trigger_ref), 'is_top_frequent');
        summary.top_expensive += top(arr, (a, b) => b.recovery_cost_hours - a.recovery_cost_hours || a.trigger_ref.localeCompare(b.trigger_ref), 'is_top_expensive');
        summary.top_emerging += top(arr, (a, b) => a._recencyDays - b._recencyDays || b.occurrences - a.occurrences || a.trigger_ref.localeCompare(b.trigger_ref), 'is_top_emerging');
    }

    for (const e of enriched) { if (!dryRun) { await upsertTI(e); } summary.triggers += 1; }
    return dryRun ? { ...summary, rows: enriched } : summary;
}

module.exports = { ensureTriggerIntelligenceSchema, runTriggerIntelligence, computeTriggerIntelligence, RULE_VERSION, TI };
