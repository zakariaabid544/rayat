// Rayat Intelligence — Sprint 2.3 · Trigger Discovery Engine (additivo)
// Scopre cosa accade PRIMA di stress (out_of_range/worsening/anomaly) e PRIMA di recovery
// (recovery/stabilization/return_to_range/improvement) via precedenza temporale sugli eventi reali.
// Soglie EMPIRICHE da value_snapshot (mai inventate). Lead-time avg/min/max/var. False-positive-rate.
// READ-ONLY su agro_actions_detected. SCRIVE SOLO su agro_triggers. Scope greenhouse + fleet.
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

const RULE_VERSION = 's2.3';

const TD = {
    LOOKBACK_DAYS: Number(process.env.AGRO_TD_LOOKBACK_DAYS || 365),
    H_HOURS: Number(process.env.AGRO_TD_HORIZON_HOURS || 168),     // finestra di lead-time (7g)
    MIN_OCC: Number(process.env.AGRO_TD_MIN_OCC || 3),             // mai trigger da 1 occorrenza
    OCC_REF: Number(process.env.AGRO_TD_OCC_REF || 20),
    RECENCY_REF_DAYS: Number(process.env.AGRO_TD_RECENCY_DAYS || 90),
    REPEAT_REF: Number(process.env.AGRO_TD_REPEAT_REF || 4),
    MIN_FLEET_GH: Number(process.env.AGRO_TD_MIN_FLEET_GH || 2),   // fleet trigger: >=2 serre
    MIN_CONFIDENCE: Number(process.env.AGRO_TD_MIN_CONFIDENCE || 0.4),
    W_R: Number(process.env.AGRO_TD_W_R || 0.30),
    W_REP: Number(process.env.AGRO_TD_W_REP || 0.30),
    W_L: Number(process.env.AGRO_TD_W_L || 0.40),
    MAX_EXAMPLES: Number(process.env.AGRO_TD_MAX_EXAMPLES || 10)
};

const STRESS = new Set(['out_of_range', 'worsening', 'anomaly']);
const RECOVERY = new Set(['recovery', 'stabilization', 'return_to_range', 'improvement']);

function metricClass(metric, antecedentType, triggerType) {
    if (triggerType === 'recovery' && RECOVERY.has(antecedentType)) { return antecedentType; }
    const m = String(metric || '').toLowerCase();
    if (m.includes('humid')) { return 'humidity'; }
    if (m === 'ec') { return 'EC'; }
    if (m === 'ph') { return 'pH'; }
    if (m.includes('temp')) { return 'temperature'; }
    if (['nitrogen', 'phosphorus', 'potassium', 'npk'].includes(m)) { return 'NPK'; }
    if (antecedentType === 'sensor_drift') { return 'sensor'; }
    return m || 'unknown';
}
function conditionFrom(toState, antecedentType) {
    if (toState === 'OUT_LOW') { return 'below'; }
    if (toState === 'OUT_HIGH') { return 'above'; }
    if (antecedentType === 'improvement' || antecedentType === 'worsening') { return antecedentType === 'improvement' ? 'improving' : 'worsening'; }
    return 'event_present';
}

function triggerConfidence({ occurrences, recencyDays, repeatUnits, leadCV, fpr }) {
    const occGate = C.clamp01(occurrences / TD.OCC_REF);
    const recency = C.recencyFactor(recencyDays, TD.RECENCY_REF_DAYS);
    const repeatability = C.clamp01(repeatUnits / TD.REPEAT_REF);
    const leadConsistency = C.clamp01(1 - (leadCV || 0));
    const confidence = C.clamp01(occGate * (TD.W_R * recency + TD.W_REP * repeatability + TD.W_L * leadConsistency) * (1 - C.clamp01(fpr)));
    return {
        confidence,
        factors: {
            occ_gate: C.round3(occGate), recency: C.round3(recency), repeatability: C.round3(repeatability),
            lead_consistency: C.round3(leadConsistency), false_positive_rate: C.round3(fpr), occurrences
        }
    };
}

async function ensureTriggerSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_triggers (
           id BIGSERIAL PRIMARY KEY,
           trigger_id TEXT NOT NULL UNIQUE,
           trigger_type VARCHAR(12) NOT NULL,
           trigger_class VARCHAR(24) NOT NULL,
           metric VARCHAR(80) NULL,
           antecedent_event VARCHAR(40) NOT NULL,
           condition VARCHAR(16) NOT NULL,
           threshold NUMERIC(12,3) NULL,
           threshold_basis VARCHAR(24) NULL,
           observed_min NUMERIC(12,3) NULL,
           observed_max NUMERIC(12,3) NULL,
           consequent_event VARCHAR(40) NOT NULL,
           lead_time_avg_hours NUMERIC(10,2) NULL,
           lead_time_min_hours NUMERIC(10,2) NULL,
           lead_time_max_hours NUMERIC(10,2) NULL,
           lead_time_variance NUMERIC(14,3) NULL,
           occurrences INTEGER NOT NULL DEFAULT 0,
           false_positive_rate NUMERIC(4,3) NOT NULL DEFAULT 0,
           confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
           scope_type VARCHAR(12) NOT NULL,
           greenhouse_scope INTEGER NULL,
           fleet_scope BOOLEAN NOT NULL DEFAULT FALSE,
           owner_user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NULL REFERENCES devices(id) ON DELETE CASCADE,
           distinct_owner_count INTEGER NOT NULL DEFAULT 0,
           distinct_device_count INTEGER NOT NULL DEFAULT 0,
           fleet_eligible BOOLEAN NOT NULL DEFAULT FALSE,
           supporting_examples JSONB NULL,
           confidence_factors JSONB NULL,
           evidence_json JSONB NULL,
           first_seen TIMESTAMPTZ NULL,
           last_seen TIMESTAMPTZ NULL,
           computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.3'
         )`
    );
    await query('CREATE INDEX IF NOT EXISTS idx_trg_scope ON agro_triggers (scope_type, greenhouse_scope, trigger_type)');
    await query('CREATE INDEX IF NOT EXISTS idx_trg_conf ON agro_triggers (confidence DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_trg_class ON agro_triggers (trigger_class, trigger_type)');
    await ensureScopedTenantSchema('agro_triggers');
}

async function loadEvents(lookbackTs) {
    return query(
        `SELECT id, owner_user_id, device_id, metric, event_type, started_at, ended_at, value_snapshot, to_state, severity
         FROM agro_actions_detected
         WHERE started_at >= ?
           AND event_type IN ('out_of_range','return_to_range','improvement','worsening','stabilization','recovery','anomaly','regime_shift','sensor_drift')
         ORDER BY device_id ASC, started_at ASC`,
        [lookbackTs]
    );
}

// Costruisce i candidati trigger (puro su array di eventi gia raggruppati per device). Esportato per test.
function mineTriggers(eventsByDevice, { horizonMs, now }) {
    const cand = new Map(); // key -> aggregato
    const antTotal = new Map();    // scopeKey|metric|atype -> count
    const antFollowed = new Map(); // scopeKey|metric|atype|ctype -> count
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

    const ensure = (scopeType, ownerUserId, gh, ttype, tclass, ametric, atype, cond, ctype) => {
        // condition nella chiave: 'below' vs 'above' vs 'event_present' restano trigger semanticamente distinti
        const key = C.deterministicId(scopeType, gh == null ? 'FLEET' : gh, ttype, ametric, atype, cond, ctype);
        let g = cand.get(key);
        if (!g) {
            g = { trigger_id: key, scope_type: scopeType, greenhouse_scope: gh, trigger_type: ttype, trigger_class: tclass,
                  owner_user_id: scopeType === 'greenhouse' ? ownerUserId : null,
                  device_id: scopeType === 'greenhouse' ? gh : null,
                  metric: ametric, antecedent_event: atype, condition: cond, consequent_event: ctype,
                  occurrences: 0, leads: [], values: [], ownerIds: new Set(), greenhouses: new Set(), days: new Set(), examples: [],
                  first: Infinity, last: -Infinity };
            cand.set(key, g);
        }
        return g;
    };

    for (const [deviceId, events] of eventsByDevice) {
        const ownerUserId = events[0] && events[0].ownerUserId;
        assertLocalIdentity({ ownerUserId, deviceId, context: `trigger device ${deviceId}` });
        if (events.some((event) => event.ownerUserId !== ownerUserId)) {
            throw new Error('[trigger-discovery] mixed tenant identities in one device timeline');
        }
        const n = events.length;
        // pass FPR (lato antecedente): per ogni evento A, totale + se seguito entro H da un consequent Ct
        for (let i = 0; i < n; i++) {
            const A = events[i];
            for (const scopeKey of [`fleet|FLEET`, `greenhouse|${deviceId}`]) {
                bump(antTotal, `${scopeKey}|${A.metric}|${A.type}`);
            }
            const followedCt = new Set();
            for (let j = i + 1; j < n; j++) {
                if (events[j].startMs - A.startMs > horizonMs) { break; }
                followedCt.add(events[j].type);
            }
            for (const ct of followedCt) {
                for (const scopeKey of [`fleet|FLEET`, `greenhouse|${deviceId}`]) {
                    bump(antFollowed, `${scopeKey}|${A.metric}|${A.type}|${ct}`);
                }
            }
        }
        // pass candidati (lato consequent): per ogni consequent, antecedente piu vicino per (metric,type)
        for (let i = 0; i < n; i++) {
            const Cev = events[i];
            const ttype = STRESS.has(Cev.type) ? 'stress' : (RECOVERY.has(Cev.type) ? 'recovery' : null);
            if (!ttype) { continue; }
            const nearest = new Map(); // metric|atype -> antecedent
            for (let j = i - 1; j >= 0; j--) {
                const A = events[j];
                if (Cev.startMs - A.startMs > horizonMs) { break; }
                if (A.startMs >= Cev.startMs) { continue; }
                const mk = `${A.metric}|${A.type}`;
                if (!nearest.has(mk)) { nearest.set(mk, A); }
            }
            for (const A of nearest.values()) {
                const tclass = metricClass(A.metric, A.type, ttype);
                const cond = conditionFrom(A.toState, A.type);
                const leadH = (Cev.startMs - A.startMs) / C.HOUR_MS;
                for (const [scopeType, gh] of [['fleet', null], ['greenhouse', deviceId]]) {
                    const g = ensure(scopeType, scopeType === 'greenhouse' ? ownerUserId : null, gh, ttype, tclass, A.metric, A.type, cond, Cev.type);
                    g.occurrences += 1;
                    g.ownerIds.add(ownerUserId);
                    g.leads.push(leadH);
                    if (Number.isFinite(A.value)) { g.values.push(A.value); }
                    g.greenhouses.add(deviceId);
                    g.days.add(Math.floor(Cev.startMs / C.DAY_MS));
                    if (g.examples.length < TD.MAX_EXAMPLES) { g.examples.push({ antecedent_event_id: A.id, consequent_event_id: Cev.id, lead_time_hours: C.round1(leadH) }); }
                    if (Cev.startMs < g.first) { g.first = Cev.startMs; }
                    if (Cev.startMs > g.last) { g.last = Cev.startMs; }
                }
            }
        }
    }
    return { cand, antTotal, antFollowed };
}

async function upsertTrigger(t) {
    const identity = assertScopedIdentity({
        scopeType: t.scope_type,
        ownerUserId: t.owner_user_id,
        deviceId: t.device_id,
        greenhouseScope: t.greenhouse_scope,
        context: 'trigger-discovery'
    });
    await query(
        `INSERT INTO agro_triggers
            (trigger_id, trigger_type, trigger_class, metric, antecedent_event, condition, threshold, threshold_basis,
             observed_min, observed_max, consequent_event, lead_time_avg_hours, lead_time_min_hours, lead_time_max_hours,
             lead_time_variance, occurrences, false_positive_rate, confidence, scope_type, greenhouse_scope, fleet_scope,
             owner_user_id, device_id, distinct_owner_count, distinct_device_count, fleet_eligible,
             supporting_examples, confidence_factors, evidence_json, first_seen, last_seen, computed_at, rule_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?, ?, NOW(), ?)
         ON CONFLICT (trigger_id) DO UPDATE SET
             threshold=EXCLUDED.threshold, observed_min=EXCLUDED.observed_min, observed_max=EXCLUDED.observed_max,
             lead_time_avg_hours=EXCLUDED.lead_time_avg_hours, lead_time_min_hours=EXCLUDED.lead_time_min_hours,
             lead_time_max_hours=EXCLUDED.lead_time_max_hours, lead_time_variance=EXCLUDED.lead_time_variance,
             occurrences=EXCLUDED.occurrences, false_positive_rate=EXCLUDED.false_positive_rate, confidence=EXCLUDED.confidence,
             owner_user_id=EXCLUDED.owner_user_id, device_id=EXCLUDED.device_id,
             distinct_owner_count=EXCLUDED.distinct_owner_count, distinct_device_count=EXCLUDED.distinct_device_count,
             fleet_eligible=EXCLUDED.fleet_eligible,
             supporting_examples=EXCLUDED.supporting_examples, confidence_factors=EXCLUDED.confidence_factors,
             evidence_json=EXCLUDED.evidence_json, first_seen=LEAST(agro_triggers.first_seen, EXCLUDED.first_seen),
             last_seen=GREATEST(agro_triggers.last_seen, EXCLUDED.last_seen), computed_at=NOW()
         RETURNING id`,
        [
            t.trigger_id, t.trigger_type, t.trigger_class, t.metric, t.antecedent_event, t.condition, t.threshold, t.threshold_basis,
            t.observed_min, t.observed_max, t.consequent_event, t.lead_avg, t.lead_min, t.lead_max, t.lead_var,
            t.occurrences, t.false_positive_rate, t.confidence, t.scope_type, t.greenhouse_scope, t.fleet_scope,
            identity.owner_user_id, identity.device_id, t.distinct_owner_count, t.distinct_device_count, t.fleet_eligible,
            JSON.stringify(fleetSafeExamples(t.scope_type, t.supporting_examples)), JSON.stringify(t.confidence_factors), JSON.stringify(fleetSafeEvidence(t.scope_type, t.evidence_json)),
            new Date(t.first).toISOString(), new Date(t.last).toISOString(), RULE_VERSION
        ]
    );
}

async function runTriggerDiscovery({ now = new Date(), lookbackDays = TD.LOOKBACK_DAYS, dryRun = false } = {}) {
    const summary = { scanned_events: 0, candidates: 0, stored: 0, stress: 0, recovery: 0, suppressed: 0, suppressed_fleet_privacy: 0 };
    const nowMs = now.getTime();
    const lookbackTs = new Date(nowMs - lookbackDays * C.DAY_MS).toISOString();
    if (!dryRun) { await query("DELETE FROM agro_triggers WHERE scope_type = 'fleet'"); }
    const rows = await loadEvents(lookbackTs);
    summary.scanned_events = rows.length;
    if (!rows.length) { return summary; }

    const byDevice = new Map();
    for (const r of rows) {
        const identity = assertLocalIdentity({ ownerUserId: r.owner_user_id, deviceId: r.device_id, context: `trigger event ${r.id}` });
        if (!byDevice.has(identity.device_id)) { byDevice.set(identity.device_id, []); }
        byDevice.get(identity.device_id).push({
            id: r.id, metric: r.metric, type: r.event_type,
            ownerUserId: identity.owner_user_id,
            startMs: new Date(r.started_at).getTime(),
            value: C.num(r.value_snapshot), toState: r.to_state
        });
    }
    const { cand, antTotal, antFollowed } = mineTriggers(byDevice, { horizonMs: TD.H_HOURS * C.HOUR_MS, now: nowMs });
    summary.candidates = cand.size;

    const discovered = [];
    for (const g of cand.values()) {
        if (g.occurrences < TD.MIN_OCC) { summary.suppressed += 1; continue; }
        const privacy = fleetEligibility([...g.ownerIds], [...g.greenhouses]);
        g.distinct_owner_count = privacy.distinct_owner_count;
        g.distinct_device_count = privacy.distinct_device_count;
        g.fleet_eligible = g.scope_type === 'fleet' ? privacy.fleet_eligible : false;
        if (g.scope_type === 'fleet' && !privacy.fleet_eligible) { summary.suppressed_fleet_privacy += 1; continue; }
        const scopeKey = g.scope_type === 'fleet' ? 'fleet|FLEET' : `greenhouse|${g.greenhouse_scope}`;
        const total = antTotal.get(`${scopeKey}|${g.metric}|${g.antecedent_event}`) || g.occurrences;
        const followed = antFollowed.get(`${scopeKey}|${g.metric}|${g.antecedent_event}|${g.consequent_event}`) || 0;
        const fpr = total > 0 ? C.clamp01(1 - followed / total) : 0;
        const recencyDays = C.daysBetween(nowMs, g.last);
        const repeatUnits = g.scope_type === 'fleet' ? g.greenhouses.size : g.days.size;
        const leadCV = C.cv(g.leads);
        const conf = triggerConfidence({ occurrences: g.occurrences, recencyDays, repeatUnits, leadCV, fpr });
        if (conf.confidence < TD.MIN_CONFIDENCE) { summary.suppressed += 1; continue; }

        const hasValues = g.values.length > 0;
        const t = {
            ...g,
            threshold: hasValues ? C.round3(C.median(g.values)) : null,
            threshold_basis: hasValues ? 'empirical_p50' : 'qualitative',
            observed_min: hasValues ? C.round3(Math.min(...g.values)) : null,
            observed_max: hasValues ? C.round3(Math.max(...g.values)) : null,
            lead_avg: C.round1(C.mean(g.leads)), lead_min: C.round1(Math.min(...g.leads)),
            lead_max: C.round1(Math.max(...g.leads)), lead_var: C.round3(C.stdev(g.leads) ** 2),
            false_positive_rate: C.round3(fpr), confidence: conf.confidence,
            fleet_scope: g.scope_type === 'fleet',
            supporting_examples: fleetSafeExamples(g.scope_type, g.examples), confidence_factors: conf.factors,
            evidence_json: { antecedent_total: total, antecedent_followed: followed, value_count: g.values.length,
                             distinct_greenhouses: g.greenhouses.size, distinct_days: g.days.size, lead_cv: C.round3(leadCV) }
        };
        discovered.push(t);
        if (!dryRun) { await upsertTrigger(t); }
        summary.stored += 1;
        if (t.trigger_type === 'stress') { summary.stress += 1; } else { summary.recovery += 1; }
    }
    return dryRun ? { ...summary, triggers: discovered } : summary;
}

module.exports = { ensureTriggerSchema, runTriggerDiscovery, mineTriggers, triggerConfidence, metricClass, conditionFrom, STRESS, RECOVERY, RULE_VERSION, TD };
