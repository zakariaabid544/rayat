// Rayat Intelligence — Sprint 2.1 · Pattern Discovery Engine (additivo)
// Scopre sequenze RICORRENTI di eventi da agro_actions_detected e le memorizza in agro_success_patterns.
// Nessuna regola agronomica hardcoded, nessuna assunzione per coltura: SOLO scoperta statistica dalla storia.
// Deterministico ed esplicabile (no black-box). Idempotente: upsert su pattern_id (ON CONFLICT).
// Additivo: crea la propria tabella/indici con IF NOT EXISTS, NON tocca i moduli Sprint 1, ingestion o alarm_events.
const { query } = require('../config/database');

const RULE_VERSION = 's2.1';
const DAY_MS = 86400000;

// Eventi prodotti dallo Sprint 1 (gli unici "token" ammessi nelle sequenze)
const KNOWN_EVENTS = [
    'out_of_range', 'return_to_range', 'improvement', 'worsening',
    'stabilization', 'recovery', 'anomaly', 'regime_shift', 'sensor_drift'
];

// Parametri tecnici CONFIGURABILI (statistici, non agronomici)
const DISCOVERY = {
    LOOKBACK_DAYS: Number(process.env.AGRO_PATTERNS_LOOKBACK_DAYS || 365),
    MIN_LEN: Number(process.env.AGRO_PATTERNS_MIN_LEN || 2),          // lunghezza minima sequenza
    MAX_LEN: Number(process.env.AGRO_PATTERNS_MAX_LEN || 4),          // lunghezza massima sequenza
    MAX_GAP_HOURS: Number(process.env.AGRO_PATTERNS_MAX_GAP_HOURS || 336), // prossimità: max 14g tra step consecutivi
    MIN_OCCURRENCES: Number(process.env.AGRO_PATTERNS_MIN_OCCURRENCES || 3), // sotto questa soglia non si memorizza (rumore)
    OCC_FULL: Number(process.env.AGRO_PATTERNS_OCC_FULL || 15),       // occorrenze per occFactor pieno (=1)
    RECENCY_WINDOW_DAYS: Number(process.env.AGRO_PATTERNS_RECENCY_DAYS || 60),
    W_BASE: Number(process.env.AGRO_PATTERNS_W_BASE || 0.6),
    W_RECENCY: Number(process.env.AGRO_PATTERNS_W_RECENCY || 0.25),
    W_CONSISTENCY: Number(process.env.AGRO_PATTERNS_W_CONSISTENCY || 0.15)
};

// Classificazione del tipo di pattern (deterministica, esplicabile)
const SUCCESS_END = new Set(['stabilization', 'recovery']);
const FAILURE_END = new Set(['out_of_range', 'worsening', 'anomaly']);

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round3(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null; }
function meanOf(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stdevOf(a) { if (a.length < 2) { return 0; } const m = meanOf(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

// Tipo: 'sensor' se coinvolge sensor_drift; altrimenti per evento finale: success / failure / other
function classifyPatternType(seq) {
    if (seq.indexOf('sensor_drift') !== -1) { return 'sensor'; }
    const last = seq[seq.length - 1];
    if (SUCCESS_END.has(last)) { return 'success'; }
    if (FAILURE_END.has(last)) { return 'failure'; }
    return 'other';
}

// Estrae le sottosequenze contigue (n-gram) da una timeline ordinata di UN sensore.
// Vincolo di prossimità: ogni step consecutivo entro maxGapMs (eventi lontani non vengono concatenati).
// Puro e testabile. events = [{ type, deviceId, startMs, endMs }] ordinati per startMs asc.
function mineSensorTimeline(events, { maxGapMs, minLen, maxLen }) {
    const instances = [];
    const n = events.length;
    for (let i = 0; i < n; i++) {
        for (let L = minLen; L <= maxLen; L++) {
            const end = i + L - 1;
            if (end >= n) { break; }
            // verifica i gap interni della finestra [i .. end]
            let ok = true;
            for (let k = i; k < end; k++) {
                const prevEnd = Number.isFinite(events[k].endMs) ? events[k].endMs : events[k].startMs;
                let gap = events[k + 1].startMs - prevEnd;
                if (gap < 0) { gap = 0; }
                if (gap > maxGapMs) { ok = false; break; }
            }
            if (!ok) { break; } // se la finestra L si rompe, le piu lunghe partono dallo stesso i si romperanno comunque
            const win = events.slice(i, end + 1);
            const seq = win.map((e) => e.type);
            const firstStart = win[0].startMs;
            const lastEnd = Number.isFinite(win[L - 1].endMs) ? win[L - 1].endMs : win[L - 1].startMs;
            instances.push({ seq, deviceId: win[0].deviceId, firstStart, durationMs: Math.max(0, lastEnd - firstStart) });
        }
    }
    return instances;
}

// Confidence 0..1: occorrenze (gate) * (base + recency + consistenza). Puro e testabile.
// occFactor in testa garantisce che pattern rari restino a bassa confidence.
function computePatternConfidence({ occurrences, daysSinceLast, durationCV }) {
    const occF = clamp01((occurrences || 0) / DISCOVERY.OCC_FULL);
    const recF = clamp01(1 - (daysSinceLast || 0) / DISCOVERY.RECENCY_WINDOW_DAYS);
    const consF = clamp01(1 - (durationCV || 0));
    const confidence = clamp01(occF * (DISCOVERY.W_BASE + DISCOVERY.W_RECENCY * recF + DISCOVERY.W_CONSISTENCY * consF));
    return {
        confidence,
        factors: {
            occurrences: occurrences || 0,
            occ_factor: round3(occF),
            recency_factor: round3(recF),
            consistency_factor: round3(consF),
            days_since_last: Math.round(daysSinceLast || 0),
            duration_cv: round3(durationCV || 0)
        }
    };
}

// Aggrega le istanze in pattern a due scope: fleet (tutta la flotta) e greenhouse (per device).
// Ritorna una mappa pattern_id -> aggregato. Puro e testabile.
function aggregatePatterns(instances, nowMs) {
    const groups = new Map();
    const add = (scopeType, greenhouseScope, inst) => {
        const seqStr = inst.seq.join('>');
        const key = `${scopeType}:${greenhouseScope == null ? 'FLEET' : greenhouseScope}:${seqStr}`;
        let g = groups.get(key);
        if (!g) {
            g = {
                pattern_id: key, scope_type: scopeType, greenhouse_scope: greenhouseScope,
                seq: inst.seq, seqStr, occurrences: 0, durations: [], first: inst.firstStart, last: inst.firstStart
            };
            groups.set(key, g);
        }
        g.occurrences += 1;
        g.durations.push(inst.durationMs);
        if (inst.firstStart < g.first) { g.first = inst.firstStart; }
        if (inst.firstStart > g.last) { g.last = inst.firstStart; }
    };
    for (const inst of instances) {
        add('fleet', null, inst);
        if (inst.deviceId != null) { add('greenhouse', inst.deviceId, inst); }
    }
    // finalizza metriche derivate
    for (const g of groups.values()) {
        const avg = meanOf(g.durations);
        const sd = stdevOf(g.durations);
        g.avgDurationSec = Math.round(avg / 1000);
        g.stdDurationSec = Math.round(sd / 1000);
        g.durationCV = avg > 0 ? sd / avg : 0;
        g.daysSinceLast = (nowMs - g.last) / DAY_MS;
        g.pattern_type = classifyPatternType(g.seq);
    }
    return groups;
}

async function ensurePatternSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_success_patterns (
           id BIGSERIAL PRIMARY KEY,
           pattern_id TEXT NOT NULL UNIQUE,
           pattern_type VARCHAR(20) NOT NULL,
           event_sequence TEXT NOT NULL,
           sequence_length SMALLINT NOT NULL,
           occurrences INTEGER NOT NULL DEFAULT 0,
           confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
           average_duration_seconds INTEGER NULL,
           duration_stddev_seconds INTEGER NULL,
           first_seen TIMESTAMPTZ NULL,
           last_seen TIMESTAMPTZ NULL,
           scope_type VARCHAR(12) NOT NULL,
           greenhouse_scope INTEGER NULL,
           fleet_scope BOOLEAN NOT NULL DEFAULT FALSE,
           confidence_factors JSONB NULL,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's2.1',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`
    );
    await query('CREATE INDEX IF NOT EXISTS idx_agro_patterns_type_conf ON agro_success_patterns (pattern_type, confidence DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_agro_patterns_scope ON agro_success_patterns (scope_type, greenhouse_scope)');
    await query('CREATE INDEX IF NOT EXISTS idx_agro_patterns_last_seen ON agro_success_patterns (last_seen DESC)');
    // Indice additivo di supporto alla discovery (lettura per sensore in ordine temporale)
    await query('CREATE INDEX IF NOT EXISTS idx_agro_actions_sensor_started ON agro_actions_detected (sensor_id, started_at)');
}

async function loadEvents(lookbackTs) {
    return query(
        `SELECT sensor_id, device_id, event_type, started_at, ended_at
         FROM agro_actions_detected
         WHERE started_at >= ?
           AND event_type IN ('out_of_range','return_to_range','improvement','worsening','stabilization','recovery','anomaly','regime_shift','sensor_drift')
         ORDER BY sensor_id ASC, started_at ASC`,
        [lookbackTs]
    );
}

async function upsertPattern(g) {
    const conf = computePatternConfidence({ occurrences: g.occurrences, daysSinceLast: g.daysSinceLast, durationCV: g.durationCV });
    await query(
        `INSERT INTO agro_success_patterns
            (pattern_id, pattern_type, event_sequence, sequence_length, occurrences, confidence,
             average_duration_seconds, duration_stddev_seconds, first_seen, last_seen,
             scope_type, greenhouse_scope, fleet_scope, confidence_factors, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (pattern_id) DO UPDATE SET
             pattern_type = EXCLUDED.pattern_type,
             occurrences = EXCLUDED.occurrences,
             confidence = EXCLUDED.confidence,
             average_duration_seconds = EXCLUDED.average_duration_seconds,
             duration_stddev_seconds = EXCLUDED.duration_stddev_seconds,
             first_seen = LEAST(agro_success_patterns.first_seen, EXCLUDED.first_seen),
             last_seen = GREATEST(agro_success_patterns.last_seen, EXCLUDED.last_seen),
             confidence_factors = EXCLUDED.confidence_factors,
             updated_at = NOW()
         RETURNING id`,
        [
            g.pattern_id, g.pattern_type, g.seqStr, g.seq.length, g.occurrences, conf.confidence,
            g.avgDurationSec, g.stdDurationSec, new Date(g.first).toISOString(), new Date(g.last).toISOString(),
            g.scope_type, g.scope_type === 'greenhouse' ? g.greenhouse_scope : null, g.scope_type === 'fleet',
            JSON.stringify(conf.factors), RULE_VERSION
        ]
    );
    return conf.confidence;
}

async function discoverPatterns({ now = new Date(), lookbackDays = DISCOVERY.LOOKBACK_DAYS, dryRun = false } = {}) {
    const summary = { scanned_events: 0, sensors: 0, candidates: 0, stored: 0, fleet: 0, greenhouse: 0, skipped_rare: 0 };
    const nowMs = now.getTime();
    const lookbackTs = new Date(nowMs - lookbackDays * DAY_MS).toISOString();

    let rows = [];
    try {
        rows = await loadEvents(lookbackTs);
    } catch (error) {
        console.error('[pattern-discovery] load events failed:', error.message);
        return summary;
    }
    summary.scanned_events = rows.length;

    // Raggruppa per sensore e costruisci le timeline ordinate
    const bySensor = new Map();
    for (const r of rows) {
        const sid = r.sensor_id;
        if (!bySensor.has(sid)) { bySensor.set(sid, []); }
        bySensor.get(sid).push({
            type: r.event_type,
            deviceId: r.device_id,
            startMs: new Date(r.started_at).getTime(),
            endMs: r.ended_at ? new Date(r.ended_at).getTime() : new Date(r.started_at).getTime()
        });
    }
    summary.sensors = bySensor.size;

    const maxGapMs = DISCOVERY.MAX_GAP_HOURS * 3600000;
    const allInstances = [];
    for (const events of bySensor.values()) {
        const inst = mineSensorTimeline(events, { maxGapMs, minLen: DISCOVERY.MIN_LEN, maxLen: DISCOVERY.MAX_LEN });
        for (const x of inst) { allInstances.push(x); }
    }

    const groups = aggregatePatterns(allInstances, nowMs);
    summary.candidates = groups.size;

    const discovered = [];
    for (const g of groups.values()) {
        if (g.occurrences < DISCOVERY.MIN_OCCURRENCES) { summary.skipped_rare += 1; continue; }
        const conf = computePatternConfidence({ occurrences: g.occurrences, daysSinceLast: g.daysSinceLast, durationCV: g.durationCV });
        discovered.push({ ...g, confidence: conf.confidence, confidence_factors: conf.factors });
        if (!dryRun) {
            await upsertPattern(g);
        }
        summary.stored += 1;
        if (g.scope_type === 'fleet') { summary.fleet += 1; } else { summary.greenhouse += 1; }
    }

    summary.patterns = dryRun ? discovered : undefined;
    return dryRun ? { ...summary, patterns: discovered } : summary;
}

module.exports = {
    ensurePatternSchema,
    discoverPatterns,
    mineSensorTimeline,
    aggregatePatterns,
    classifyPatternType,
    computePatternConfidence,
    DISCOVERY,
    RULE_VERSION
};
