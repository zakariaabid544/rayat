// Rayat Intelligence — Sprint 2.2 · Pattern Intelligence Engine (additivo)
// Trasforma le sequenze scoperte (agro_success_patterns) in conoscenza: ranking di importanza,
// success_rate, elezione delle categorie (Top Success/Failure/Sensor/Emerging) per scope greenhouse+fleet.
// READ-ONLY su agro_success_patterns. SCRIVE SOLO su agro_pattern_intelligence. Deterministico, esplicabile.
'use strict';
const { query } = require('../config/database');
const C = require('./intelligence-common');

const RULE_VERSION = 's2.2';

const PI = {
    OCC_REF: Number(process.env.AGRO_PI_OCC_REF || 40),          // occorrenze per volume pieno
    RECENCY_REF_DAYS: Number(process.env.AGRO_PI_RECENCY_DAYS || 90),
    REPEAT_SPAN_REF_DAYS: Number(process.env.AGRO_PI_REPEAT_SPAN_DAYS || 60),
    W_V: Number(process.env.AGRO_PI_W_V || 0.25),
    W_C: Number(process.env.AGRO_PI_W_C || 0.30),
    W_R: Number(process.env.AGRO_PI_W_R || 0.15),
    W_P: Number(process.env.AGRO_PI_W_P || 0.20),
    W_D: Number(process.env.AGRO_PI_W_D || 0.10),
    EMERGING_AGE_DAYS: Number(process.env.AGRO_PI_EMERGING_AGE_DAYS || 30), // pattern "giovane"
    EMERGING_RECENT_DAYS: Number(process.env.AGRO_PI_EMERGING_RECENT_DAYS || 14),
    MIN_EMERGING_OCC: Number(process.env.AGRO_PI_MIN_EMERGING_OCC || 3)
};

// Importance score 0-100 (modello deterministico e pesato; fattori salvati per esplicabilità)
function computeImportance({ occurrences, confidence, recencyDays, spanDays, durationCV }) {
    const V = C.normLog(occurrences, PI.OCC_REF);
    const Cf = C.clamp01(confidence);
    const R = C.recencyFactor(recencyDays, PI.RECENCY_REF_DAYS);
    const P = C.clamp01((spanDays || 0) / PI.REPEAT_SPAN_REF_DAYS);
    const D = C.clamp01(1 - (durationCV || 0));
    const score01 = PI.W_V * V + PI.W_C * Cf + PI.W_R * R + PI.W_P * P + PI.W_D * D;
    return {
        importance_score: Math.round(100 * C.clamp01(score01)),
        factors: { V: C.round3(V), C: C.round3(Cf), R: C.round3(R), P: C.round3(P), D: C.round3(D), weights: { wV: PI.W_V, wC: PI.W_C, wR: PI.W_R, wP: PI.W_P, wD: PI.W_D } }
    };
}

// success_rate (association-rule): dato il prefisso, quanto spesso termina cosi (da soli output 2.1)
function prefixOf(seq) { const a = seq.split('>'); return a.slice(0, a.length - 1).join('>') || a[0]; }

function buildSuccessRates(rows) {
    // group by scope_type|greenhouse|prefix -> total occurrences
    const totals = new Map();
    for (const r of rows) {
        const key = `${r.scope_type}|${r.greenhouse_scope == null ? 'F' : r.greenhouse_scope}|${prefixOf(r.event_sequence)}`;
        totals.set(key, (totals.get(key) || 0) + Number(r.occurrences));
    }
    return (r) => {
        const key = `${r.scope_type}|${r.greenhouse_scope == null ? 'F' : r.greenhouse_scope}|${prefixOf(r.event_sequence)}`;
        const tot = totals.get(key) || Number(r.occurrences);
        return tot > 0 ? Number(r.occurrences) / tot : 0;
    };
}

function whyImportant(factors, type, score) {
    const ranked = [['frequenza', factors.V], ['confidence', factors.C], ['ripetibilità', factors.P], ['recency', factors.R], ['consistenza durata', factors.D]]
        .sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]);
    return `Pattern ${type} con importance ${score}/100, trainato da ${ranked.join(' e ')}.`;
}

async function ensurePatternIntelligenceSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_pattern_intelligence (
           id BIGSERIAL PRIMARY KEY,
           intelligence_id TEXT NOT NULL UNIQUE,
           pattern_ref TEXT NOT NULL,
           scope_type VARCHAR(12) NOT NULL,
           greenhouse_scope INTEGER NULL,
           fleet_scope BOOLEAN NOT NULL DEFAULT FALSE,
           pattern_type VARCHAR(20) NOT NULL,
           event_sequence TEXT NOT NULL,
           occurrences INTEGER NOT NULL DEFAULT 0,
           confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
           success_rate NUMERIC(4,3) NULL,
           importance_score SMALLINT NOT NULL DEFAULT 0,
           trend_direction VARCHAR(12) NULL,
           is_top_success BOOLEAN NOT NULL DEFAULT FALSE,
           is_top_failure BOOLEAN NOT NULL DEFAULT FALSE,
           is_top_sensor BOOLEAN NOT NULL DEFAULT FALSE,
           is_emerging BOOLEAN NOT NULL DEFAULT FALSE,
           rank_in_category SMALLINT NULL,
           why_important TEXT NULL,
           ranking_factors JSONB NULL,
           confidence_factors JSONB NULL,
           supporting_event_ids JSONB NULL,
           first_seen TIMESTAMPTZ NULL,
           last_seen TIMESTAMPTZ NULL,
           computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.2'
         )`
    );
    await query('CREATE INDEX IF NOT EXISTS idx_api_scope_type ON agro_pattern_intelligence (scope_type, greenhouse_scope, pattern_type)');
    await query('CREATE INDEX IF NOT EXISTS idx_api_importance ON agro_pattern_intelligence (importance_score DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_api_emerging ON agro_pattern_intelligence (is_emerging, scope_type)');
}

async function loadPatterns() {
    return query(
        `SELECT pattern_id, pattern_type, event_sequence, occurrences, confidence,
                average_duration_seconds, duration_stddev_seconds, first_seen, last_seen,
                scope_type, greenhouse_scope, fleet_scope, confidence_factors
         FROM agro_success_patterns`
    );
}

async function upsertIntelligence(row) {
    await query(
        `INSERT INTO agro_pattern_intelligence
            (intelligence_id, pattern_ref, scope_type, greenhouse_scope, fleet_scope, pattern_type, event_sequence,
             occurrences, confidence, success_rate, importance_score, trend_direction,
             is_top_success, is_top_failure, is_top_sensor, is_emerging, rank_in_category,
             why_important, ranking_factors, confidence_factors, supporting_event_ids, first_seen, last_seen, computed_at, rule_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?, ?, NOW(), ?)
         ON CONFLICT (intelligence_id) DO UPDATE SET
             occurrences=EXCLUDED.occurrences, confidence=EXCLUDED.confidence, success_rate=EXCLUDED.success_rate,
             importance_score=EXCLUDED.importance_score, trend_direction=EXCLUDED.trend_direction,
             is_top_success=EXCLUDED.is_top_success, is_top_failure=EXCLUDED.is_top_failure,
             is_top_sensor=EXCLUDED.is_top_sensor, is_emerging=EXCLUDED.is_emerging, rank_in_category=EXCLUDED.rank_in_category,
             why_important=EXCLUDED.why_important, ranking_factors=EXCLUDED.ranking_factors,
             confidence_factors=EXCLUDED.confidence_factors, first_seen=LEAST(agro_pattern_intelligence.first_seen, EXCLUDED.first_seen),
             last_seen=GREATEST(agro_pattern_intelligence.last_seen, EXCLUDED.last_seen), computed_at=NOW()
         RETURNING id`,
        [
            row.intelligence_id, row.pattern_ref, row.scope_type, row.greenhouse_scope, row.fleet_scope, row.pattern_type, row.event_sequence,
            row.occurrences, row.confidence, row.success_rate, row.importance_score, row.trend_direction,
            row.is_top_success, row.is_top_failure, row.is_top_sensor, row.is_emerging, row.rank_in_category,
            row.why_important, JSON.stringify(row.ranking_factors), JSON.stringify(row.confidence_factors || {}),
            JSON.stringify(row.supporting_event_ids || []), row.first_seen, row.last_seen, RULE_VERSION
        ]
    );
}

async function runPatternIntelligence({ now = new Date(), dryRun = false } = {}) {
    const summary = { patterns: 0, top_success: 0, top_failure: 0, top_sensor: 0, emerging: 0, scopes: 0 };
    const nowMs = now.getTime();
    const rows = await loadPatterns();
    if (!rows.length) { return summary; }
    const successRateFor = buildSuccessRates(rows);

    // calcola intelligence per ogni pattern
    const enriched = rows.map((r) => {
        const firstMs = r.first_seen ? new Date(r.first_seen).getTime() : nowMs;
        const lastMs = r.last_seen ? new Date(r.last_seen).getTime() : nowMs;
        const recencyDays = C.daysBetween(nowMs, lastMs);
        const spanDays = C.daysBetween(firstMs, lastMs);
        const ageDays = C.daysBetween(nowMs, firstMs);
        const durationCV = (Number(r.average_duration_seconds) > 0)
            ? Number(r.duration_stddev_seconds || 0) / Number(r.average_duration_seconds) : 0;
        const imp = computeImportance({ occurrences: Number(r.occurrences), confidence: Number(r.confidence), recencyDays, spanDays, durationCV });
        const emerging = (ageDays <= PI.EMERGING_AGE_DAYS) && (recencyDays <= PI.EMERGING_RECENT_DAYS) && (Number(r.occurrences) >= PI.MIN_EMERGING_OCC);
        const trend = emerging ? 'rising' : (recencyDays > PI.RECENCY_REF_DAYS ? 'declining' : 'stable');
        return {
            intelligence_id: C.deterministicId(r.scope_type, r.greenhouse_scope == null ? 'FLEET' : r.greenhouse_scope, r.pattern_id),
            pattern_ref: r.pattern_id, scope_type: r.scope_type, greenhouse_scope: r.greenhouse_scope, fleet_scope: !!r.fleet_scope,
            pattern_type: r.pattern_type, event_sequence: r.event_sequence,
            occurrences: Number(r.occurrences), confidence: Number(r.confidence),
            success_rate: C.round3(successRateFor(r)), importance_score: imp.importance_score,
            trend_direction: trend, ranking_factors: imp.factors, confidence_factors: C.parseJson(r.confidence_factors, {}),
            is_top_success: false, is_top_failure: false, is_top_sensor: false, is_emerging: emerging, rank_in_category: null,
            first_seen: r.first_seen, last_seen: r.last_seen,
            _scopeKey: `${r.scope_type}|${r.greenhouse_scope == null ? 'F' : r.greenhouse_scope}`
        };
    });

    // elezione categorie per scope (greenhouse o fleet)
    const byScope = new Map();
    for (const e of enriched) { if (!byScope.has(e._scopeKey)) { byScope.set(e._scopeKey, []); } byScope.get(e._scopeKey).push(e); }
    summary.scopes = byScope.size;
    const electTop = (arr, type, flag) => {
        const cands = arr.filter((x) => x.pattern_type === type).sort((a, b) => b.importance_score - a.importance_score || b.occurrences - a.occurrences || a.pattern_ref.localeCompare(b.pattern_ref));
        cands.forEach((x, i) => { x.rank_in_category = i + 1; });
        if (cands[0]) { cands[0][flag] = true; return 1; }
        return 0;
    };
    for (const arr of byScope.values()) {
        summary.top_success += electTop(arr, 'success', 'is_top_success');
        summary.top_failure += electTop(arr, 'failure', 'is_top_failure');
        summary.top_sensor += electTop(arr, 'sensor', 'is_top_sensor');
    }

    for (const e of enriched) {
        e.why_important = whyImportant(e.ranking_factors, e.pattern_type, e.importance_score);
        if (e.is_emerging) { summary.emerging += 1; }
        if (!dryRun) { await upsertIntelligence(e); }
        summary.patterns += 1;
    }
    return dryRun ? { ...summary, rows: enriched } : summary;
}

module.exports = { ensurePatternIntelligenceSchema, runPatternIntelligence, computeImportance, buildSuccessRates, RULE_VERSION, PI };
