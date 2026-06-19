// Rayat Intelligence — Sprint 2.4 · Recovery Intelligence Engine (additivo)
// Per ogni tipo di stress (EC/Humidity/Temperature/pH/NPK) apprende speed/quality/stability/success_rate/score
// dagli eventi recovery reali (Sprint 1.5) e classifica Fast/Slow, Stable/Fragile, Improving/Declining.
// READ-ONLY su agro_actions_detected. SCRIVE SOLO su agro_recovery_intelligence. Deterministico, esplicabile.
'use strict';
const { query } = require('../config/database');
const C = require('./intelligence-common');
const {
    assertLocalIdentity,
    assertScopedIdentity,
    ensureScopedTenantSchema,
    fleetEligibility,
    fleetSafeEvidence,
    fleetSafeExamples
} = require('./intelligence-tenancy');

const RULE_VERSION = 's2.4-recovery';

const RI = {
    SPEED_REF_HOURS: Number(process.env.AGRO_RI_SPEED_REF_HOURS || 72),
    FAST_HOURS: Number(process.env.AGRO_RI_FAST_HOURS || 48),
    STABLE_THR: Number(process.env.AGRO_RI_STABLE_THR || 0.6),
    RECENCY_REF_DAYS: Number(process.env.AGRO_RI_RECENCY_DAYS || 90),
    MIN_RECOVERIES: Number(process.env.AGRO_RI_MIN_RECOVERIES || 2),
    W_SPEED: Number(process.env.AGRO_RI_W_SPEED || 0.25),
    W_QUALITY: Number(process.env.AGRO_RI_W_QUALITY || 0.30),
    W_STABILITY: Number(process.env.AGRO_RI_W_STABILITY || 0.20),
    W_SUCCESS: Number(process.env.AGRO_RI_W_SUCCESS || 0.15),
    W_RECENCY: Number(process.env.AGRO_RI_W_RECENCY || 0.10)
};

function metricToClass(metric) {
    const m = String(metric || '').toLowerCase();
    if (m.includes('humid')) { return 'Humidity'; }
    if (m === 'ec') { return 'EC'; }
    if (m === 'ph') { return 'pH'; }
    if (m.includes('temp')) { return 'Temperature'; }
    if (['nitrogen', 'phosphorus', 'potassium', 'npk'].includes(m)) { return 'NPK'; }
    return null; // fuori dalle 5 classi di stress richieste
}

// Calcola intelligence di recovery da una lista di episodi {qualityVal, durationHours, startMs}. Puro/testabile.
function computeRecoveryIntelligence(episodes, outOfRangeCount, nowMs) {
    const durations = episodes.map((e) => e.durationHours).filter(Number.isFinite);
    const qualities = episodes.map((e) => e.qualityVal).filter(Number.isFinite);
    const avgDuration = C.mean(durations);
    const avgQuality = qualities.length ? C.mean(qualities) : 0.5;
    const speedFactor = C.clamp01(1 - C.normLog(avgDuration, RI.SPEED_REF_HOURS)); // piu veloce -> piu alto
    const stability = C.clamp01(1 - 0.5 * C.cv(qualities) - 0.5 * C.cv(durations));
    const successRate = outOfRangeCount > 0 ? C.clamp01(episodes.length / outOfRangeCount) : (episodes.length ? 1 : 0);
    const lastMs = episodes.reduce((mx, e) => Math.max(mx, e.startMs), 0);
    const recencyDays = lastMs ? C.daysBetween(nowMs, lastMs) : 999;
    const recency = C.recencyFactor(recencyDays, RI.RECENCY_REF_DAYS);

    const score01 = RI.W_SPEED * speedFactor + RI.W_QUALITY * C.clamp01(avgQuality)
        + RI.W_STABILITY * stability + RI.W_SUCCESS * successRate + RI.W_RECENCY * recency;

    // classificazione
    const sorted = episodes.slice().sort((a, b) => a.startMs - b.startMs);
    const half = Math.floor(sorted.length / 2);
    const olderQ = half > 0 ? C.mean(sorted.slice(0, half).map((e) => e.qualityVal).filter(Number.isFinite)) : avgQuality;
    const recentQ = half > 0 ? C.mean(sorted.slice(sorted.length - half).map((e) => e.qualityVal).filter(Number.isFinite)) : avgQuality;
    const is_fast = avgDuration <= RI.FAST_HOURS;
    const is_stable = stability >= RI.STABLE_THR;
    const is_improving = episodes.length >= 2 ? recentQ >= olderQ : false;

    return {
        recovery_speed_hours: C.round1(avgDuration),
        recovery_quality: C.round3(avgQuality),
        recovery_stability: C.round3(stability),
        recovery_success_rate: C.round3(successRate),
        recovery_score: Math.round(100 * C.clamp01(score01)),
        is_fast, is_slow: !is_fast, is_stable, is_fragile: !is_stable, is_improving, is_declining: episodes.length >= 2 ? !is_improving : false,
        factors: { speed_factor: C.round3(speedFactor), avg_quality: C.round3(avgQuality), stability: C.round3(stability), success_rate: C.round3(successRate), recency: C.round3(recency), recovery_count: episodes.length, out_of_range_count: outOfRangeCount, weights: { wSpeed: RI.W_SPEED, wQuality: RI.W_QUALITY, wStability: RI.W_STABILITY, wSuccess: RI.W_SUCCESS, wRecency: RI.W_RECENCY } }
    };
}

function classifyLabel(r) {
    const parts = [r.is_fast ? 'Fast' : 'Slow', r.is_stable ? 'Stable' : 'Fragile'];
    if (r.is_improving) { parts.push('Improving'); } else if (r.is_declining) { parts.push('Declining'); }
    return parts.join(' / ');
}

function groupRecoveryEpisodes(recoveries) {
    const groups = new Map();
    const addEpisode = (scopeType, identity, greenhouseScope, stressClass, episode) => {
        const key = C.deterministicId(scopeType, greenhouseScope == null ? 'FLEET' : greenhouseScope, stressClass);
        let group = groups.get(key);
        if (!group) {
            group = {
                key, scope_type: scopeType, greenhouse_scope: greenhouseScope, metric: stressClass,
                owner_user_id: scopeType === 'greenhouse' ? identity.owner_user_id : null,
                device_id: scopeType === 'greenhouse' ? identity.device_id : null,
                episodes: [], ids: [], ownerIds: new Set(), deviceIds: new Set()
            };
            groups.set(key, group);
        }
        if (scopeType === 'greenhouse' && group.owner_user_id !== identity.owner_user_id) {
            throw new Error('[recovery-intelligence] mixed tenant identities in one device history');
        }
        group.episodes.push(episode);
        group.ownerIds.add(identity.owner_user_id);
        group.deviceIds.add(identity.device_id);
        if (group.ids.length < 20) { group.ids.push(episode.id); }
    };

    for (const row of recoveries || []) {
        const identity = assertLocalIdentity({
            ownerUserId: row.owner_user_id,
            deviceId: row.device_id,
            context: `recovery event ${row.id}`
        });
        const stressClass = metricToClass(row.metric);
        if (!stressClass) { continue; }
        const evidence = C.parseJson(row.evidence_json, {}) || {};
        const durationHours = Number.isFinite(Number(evidence.recovery_duration_minutes))
            ? Number(evidence.recovery_duration_minutes) / 60
            : (Number.isFinite(Number(row.duration_seconds)) ? Number(row.duration_seconds) / 3600 : NaN);
        const quality = Number.isFinite(Number(evidence.recovery_quality)) ? Number(evidence.recovery_quality) : NaN;
        const episode = {
            id: row.id,
            durationHours,
            qualityVal: quality,
            startMs: new Date(row.started_at).getTime()
        };
        addEpisode('fleet', identity, null, stressClass, episode);
        addEpisode('greenhouse', identity, identity.device_id, stressClass, episode);
    }
    return groups;
}

async function ensureRecoveryIntelligenceSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_recovery_intelligence (
           id BIGSERIAL PRIMARY KEY,
           recovery_id TEXT NOT NULL UNIQUE,
           stress_type VARCHAR(20) NOT NULL,
           metric VARCHAR(80) NULL,
           scope_type VARCHAR(12) NOT NULL,
           greenhouse_scope INTEGER NULL,
           fleet_scope BOOLEAN NOT NULL DEFAULT FALSE,
           owner_user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NULL REFERENCES devices(id) ON DELETE CASCADE,
           distinct_owner_count INTEGER NOT NULL DEFAULT 0,
           distinct_device_count INTEGER NOT NULL DEFAULT 0,
           fleet_eligible BOOLEAN NOT NULL DEFAULT FALSE,
           recovery_count INTEGER NOT NULL DEFAULT 0,
           recovery_speed_hours NUMERIC(10,2) NULL,
           recovery_quality NUMERIC(4,3) NULL,
           recovery_stability NUMERIC(4,3) NULL,
           recovery_success_rate NUMERIC(4,3) NULL,
           recovery_score SMALLINT NOT NULL DEFAULT 0,
           recovery_class VARCHAR(40) NULL,
           is_fast BOOLEAN NOT NULL DEFAULT FALSE,
           is_slow BOOLEAN NOT NULL DEFAULT FALSE,
           is_stable BOOLEAN NOT NULL DEFAULT FALSE,
           is_fragile BOOLEAN NOT NULL DEFAULT FALSE,
           is_improving BOOLEAN NOT NULL DEFAULT FALSE,
           is_declining BOOLEAN NOT NULL DEFAULT FALSE,
           ranking_factors JSONB NULL,
           confidence_factors JSONB NULL,
           supporting_event_ids JSONB NULL,
           evidence_json JSONB NULL,
           computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.4-recovery'
         )`
    );
    await query('CREATE INDEX IF NOT EXISTS idx_ri_scope ON agro_recovery_intelligence (scope_type, greenhouse_scope, stress_type)');
    await query('CREATE INDEX IF NOT EXISTS idx_ri_score ON agro_recovery_intelligence (recovery_score DESC)');
    await ensureScopedTenantSchema('agro_recovery_intelligence');
}

async function loadRecoveryEvents() {
    return query(
        `SELECT id, owner_user_id, device_id, metric, started_at, duration_seconds, evidence_json
         FROM agro_actions_detected WHERE event_type = 'recovery'`
    );
}
async function loadOutOfRangeCounts() {
    const rows = await query(
        `SELECT device_id, metric, COUNT(*) AS c FROM agro_actions_detected
         WHERE event_type = 'out_of_range' GROUP BY device_id, metric`
    );
    const fleet = new Map(); const gh = new Map();
    for (const r of rows) {
        const cls = metricToClass(r.metric); if (!cls) { continue; }
        fleet.set(cls, (fleet.get(cls) || 0) + Number(r.c));
        const gk = `${r.device_id}|${cls}`; gh.set(gk, (gh.get(gk) || 0) + Number(r.c));
    }
    return { fleet, gh };
}

async function upsertRI(row) {
    const identity = assertScopedIdentity({
        scopeType: row.scope_type,
        ownerUserId: row.owner_user_id,
        deviceId: row.device_id,
        greenhouseScope: row.greenhouse_scope,
        context: 'recovery-intelligence'
    });
    await query(
        `INSERT INTO agro_recovery_intelligence
            (recovery_id, stress_type, metric, scope_type, greenhouse_scope, fleet_scope, recovery_count,
             owner_user_id, device_id, distinct_owner_count, distinct_device_count, fleet_eligible,
             recovery_speed_hours, recovery_quality, recovery_stability, recovery_success_rate, recovery_score, recovery_class,
             is_fast, is_slow, is_stable, is_fragile, is_improving, is_declining,
             ranking_factors, confidence_factors, supporting_event_ids, evidence_json, computed_at, rule_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), NOW(), ?)
         ON CONFLICT (recovery_id) DO UPDATE SET
             recovery_count=EXCLUDED.recovery_count, recovery_speed_hours=EXCLUDED.recovery_speed_hours,
             recovery_quality=EXCLUDED.recovery_quality, recovery_stability=EXCLUDED.recovery_stability,
             owner_user_id=EXCLUDED.owner_user_id, device_id=EXCLUDED.device_id,
             distinct_owner_count=EXCLUDED.distinct_owner_count, distinct_device_count=EXCLUDED.distinct_device_count,
             fleet_eligible=EXCLUDED.fleet_eligible,
             recovery_success_rate=EXCLUDED.recovery_success_rate, recovery_score=EXCLUDED.recovery_score, recovery_class=EXCLUDED.recovery_class,
             is_fast=EXCLUDED.is_fast, is_slow=EXCLUDED.is_slow, is_stable=EXCLUDED.is_stable, is_fragile=EXCLUDED.is_fragile,
             is_improving=EXCLUDED.is_improving, is_declining=EXCLUDED.is_declining, ranking_factors=EXCLUDED.ranking_factors,
             confidence_factors=EXCLUDED.confidence_factors, supporting_event_ids=EXCLUDED.supporting_event_ids,
             evidence_json=EXCLUDED.evidence_json, computed_at=NOW()
         RETURNING id`,
        [
            row.recovery_id, row.stress_type, row.metric, row.scope_type, row.greenhouse_scope, row.fleet_scope, row.recovery_count,
            identity.owner_user_id, identity.device_id, row.distinct_owner_count, row.distinct_device_count, row.fleet_eligible,
            row.recovery_speed_hours, row.recovery_quality, row.recovery_stability, row.recovery_success_rate, row.recovery_score, row.recovery_class,
            row.is_fast, row.is_slow, row.is_stable, row.is_fragile, row.is_improving, row.is_declining,
            JSON.stringify(row.ranking_factors), JSON.stringify(row.ranking_factors), JSON.stringify(fleetSafeExamples(row.scope_type, row.supporting_event_ids || [])),
            JSON.stringify(fleetSafeEvidence(row.scope_type, row.evidence_json || {})), RULE_VERSION
        ]
    );
}

async function runRecoveryIntelligence({ now = new Date(), dryRun = false } = {}) {
    const summary = { classes: 0, fast: 0, slow: 0, stable: 0, fragile: 0, improving: 0, declining: 0 };
    const nowMs = now.getTime();
    if (!dryRun) { await query("DELETE FROM agro_recovery_intelligence WHERE scope_type = 'fleet'"); }
    const recoveries = await loadRecoveryEvents();
    if (!recoveries.length) { return summary; }
    const oor = await loadOutOfRangeCounts();

    // Raggruppa per device/owner. Mixed ownership fails closed.
    const groups = groupRecoveryEpisodes(recoveries);

    for (const g of groups.values()) {
        if (g.episodes.length < RI.MIN_RECOVERIES) { continue; }
        const privacy = fleetEligibility([...g.ownerIds], [...g.deviceIds]);
        if (g.scope_type === 'fleet' && !privacy.fleet_eligible) { continue; }
        const oorCount = g.scope_type === 'fleet' ? (oor.fleet.get(g.metric) || 0) : (oor.gh.get(`${g.greenhouse_scope}|${g.metric}`) || 0);
        const ri = computeRecoveryIntelligence(g.episodes, oorCount, nowMs);
        const row = {
            recovery_id: g.key, stress_type: g.metric, metric: g.metric, scope_type: g.scope_type,
            greenhouse_scope: g.greenhouse_scope, fleet_scope: g.scope_type === 'fleet', recovery_count: g.episodes.length,
            owner_user_id: g.owner_user_id, device_id: g.device_id,
            distinct_owner_count: privacy.distinct_owner_count, distinct_device_count: privacy.distinct_device_count,
            fleet_eligible: g.scope_type === 'fleet' ? privacy.fleet_eligible : false,
            recovery_speed_hours: ri.recovery_speed_hours, recovery_quality: ri.recovery_quality, recovery_stability: ri.recovery_stability,
            recovery_success_rate: ri.recovery_success_rate, recovery_score: ri.recovery_score, recovery_class: classifyLabel(ri),
            is_fast: ri.is_fast, is_slow: ri.is_slow, is_stable: ri.is_stable, is_fragile: ri.is_fragile,
            is_improving: ri.is_improving, is_declining: ri.is_declining, ranking_factors: ri.factors,
            supporting_event_ids: fleetSafeExamples(g.scope_type, g.ids),
            evidence_json: { recovery_count: g.episodes.length, out_of_range_count: oorCount,
                             distinct_owner_count: privacy.distinct_owner_count, distinct_device_count: privacy.distinct_device_count }
        };
        if (!dryRun) { await upsertRI(row); }
        summary.classes += 1;
        if (ri.is_fast) { summary.fast += 1; } else { summary.slow += 1; }
        if (ri.is_stable) { summary.stable += 1; } else { summary.fragile += 1; }
        if (ri.is_improving) { summary.improving += 1; } if (ri.is_declining) { summary.declining += 1; }
    }
    return summary;
}

module.exports = {
    ensureRecoveryIntelligenceSchema,
    runRecoveryIntelligence,
    computeRecoveryIntelligence,
    groupRecoveryEpisodes,
    metricToClass,
    classifyLabel,
    RULE_VERSION,
    RI
};
