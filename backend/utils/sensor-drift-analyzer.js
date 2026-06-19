// Rayat Intelligence — Sprint 1.8 · Sensor Drift Analyzer (additivo)
// Genera SOLO eventi `sensor_drift`: comportamento SOSPETTO del sensore (calibrazione, usura, sporco,
// saturazione, errore hardware). NON e anomaly (spike), NON e regime_shift (nuovo baseline a gradino),
// NON e worsening/out_of_range (agronomici). Due classi:
//   - slow  : deriva lenta, monotona, bassa volatilita, nessun gradino netto, disconnessa dagli eventi agronomici
//   - stuck : varianza ~0, valori ripetuti identici (flatline) mentre le letture continuano
// Discriminante vs regime_shift: max_step_ratio (un gradino che domina => regime, non drift) + monotonicita + flatline.
// Statistica classica, deterministica. Riusa metricKeyForSensor + Quality Gate SENZA modificarli.
// NON tocca alarm_events / active_alerts. Idempotente: max 1 sensor_drift 'open' per (sensor_id, metric).
const { query } = require('../config/database');
const { metricKeyForSensor } = require('./range-resolver');
const { assertLocalIdentity } = require('./intelligence-tenancy');

const RULE_VERSION = 's1.8';

// Parametri tecnici CONFIGURABILI (statistici, non soglie agronomiche)
const DRIFT = {
    WINDOW_HOURS: Number(process.env.AGRO_DRIFT_WINDOW_HOURS || 72),
    MIN_DURATION_HOURS: Number(process.env.AGRO_DRIFT_MIN_DURATION_HOURS || 12),
    MIN_SAMPLES: Number(process.env.AGRO_DRIFT_MIN_SAMPLES || 10),
    // slow drift
    MONO_MIN: Number(process.env.AGRO_DRIFT_MONO_MIN || 0.8),            // monotonicita: frazione diffs nella direzione dominante
    R2_MIN: Number(process.env.AGRO_DRIFT_R2_MIN || 0.8),               // bonta del fit lineare (rampa pulita)
    MAX_STEP_RATIO: Number(process.env.AGRO_DRIFT_MAX_STEP_RATIO || 0.4), // nessun singolo gradino domina (>0.4 => e uno step = regime)
    MIN_DISP_REL: Number(process.env.AGRO_DRIFT_MIN_DISP_REL || 0.05),   // spostamento totale significativo (frazione del livello)
    MAX_RESID_REL: Number(process.env.AGRO_DRIFT_MAX_RESID_REL || 0.05), // volatilita residua bassa (troppo "liscio")
    // stuck
    FLAT_MIN: Number(process.env.AGRO_DRIFT_FLAT_MIN || 0.95),           // frazione diffs ~0
    FLAT_EPS_REL: Number(process.env.AGRO_DRIFT_FLAT_EPS_REL || 0.001),  // soglia "identico" relativa
    STUCK_STD_REL: Number(process.env.AGRO_DRIFT_STUCK_STD_REL || 0.003),// std/level praticamente nulla
    MIN_CONFIDENCE: Number(process.env.AGRO_DRIFT_MIN_CONFIDENCE || 0.5)
};

const EPS = 1e-9;
const HOUR_MS = 3600000;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round3(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null; }
function round1(x) { return Number.isFinite(x) ? Math.round(x * 10) / 10 : null; }
function meanOf(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stdevOf(a) { if (!a.length) { return 0; } const m = meanOf(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

// Regressione lineare su indice (0..n-1) -> { slope, r2, residStd }
function linReg(values) {
    const n = values.length;
    const meanT = (n - 1) / 2;
    const meanV = meanOf(values);
    let sxx = 0; let sxy = 0; let syy = 0;
    for (let i = 0; i < n; i++) { const dt = i - meanT; const dv = values[i] - meanV; sxx += dt * dt; sxy += dt * dv; syy += dv * dv; }
    const slope = sxx > EPS ? sxy / sxx : 0;
    const r2 = (sxx > EPS && syy > EPS) ? (sxy * sxy) / (sxx * syy) : 0;
    const intercept = meanV - slope * meanT;
    let se = 0;
    for (let i = 0; i < n; i++) { const pred = intercept + slope * i; se += (values[i] - pred) ** 2; }
    return { slope, r2, residStd: Math.sqrt(se / n) };
}

// Profilo del drift (puro, testabile)
function computeDriftProfile(values) {
    const n = values.length;
    const start = values[0];
    const end = values[n - 1];
    const totalDisp = end - start;
    const mean = meanOf(values);
    const std = stdevOf(values);
    const level = Math.max(Math.abs(mean), 1);

    let pos = 0; let neg = 0; let sumAbs = 0; let maxStep = 0; let flat = 0;
    const flatEps = DRIFT.FLAT_EPS_REL * level;
    for (let i = 1; i < n; i++) {
        const dF = values[i] - values[i - 1];
        const a = Math.abs(dF);
        if (dF > EPS) { pos++; } else if (dF < -EPS) { neg++; }
        if (a <= flatEps) { flat++; }
        sumAbs += a; if (a > maxStep) { maxStep = a; }
    }
    const pairs = Math.max(1, n - 1);
    const { slope, r2, residStd } = linReg(values);
    return {
        n, start, end, totalDisp,
        mean, std, stdRel: std / level,
        monotonicity: Math.max(pos, neg) / pairs,
        maxStepRatio: sumAbs > EPS ? maxStep / sumAbs : 0,
        dispRel: Math.abs(totalDisp) / level,
        residRel: residStd / level,
        r2,
        flatlineScore: flat / pairs,
        direction: totalDisp >= 0 ? 'up' : 'down'
    };
}

// Classifica: 'stuck' | 'slow' | null (puro, testabile)
function classifyDrift(p, durationHours, samples) {
    if (samples < DRIFT.MIN_SAMPLES || durationHours < DRIFT.MIN_DURATION_HOURS) {
        return { type: null, reason: 'insufficient' };
    }
    // STUCK: flatline e varianza praticamente nulla
    if (p.flatlineScore >= DRIFT.FLAT_MIN && p.stdRel <= DRIFT.STUCK_STD_REL) {
        return { type: 'stuck', reason: 'flatline_zero_variance' };
    }
    // SLOW: rampa monotona, fit lineare buono, nessun gradino dominante, liscia, spostamento significativo
    if (p.monotonicity >= DRIFT.MONO_MIN
        && p.r2 >= DRIFT.R2_MIN
        && p.maxStepRatio <= DRIFT.MAX_STEP_RATIO
        && p.dispRel >= DRIFT.MIN_DISP_REL
        && p.residRel <= DRIFT.MAX_RESID_REL) {
        return { type: 'slow', reason: 'monotonic_low_volatility_ramp' };
    }
    return { type: null, reason: 'not_drift' };
}

function suspectedCause(type, direction) {
    if (type === 'stuck') { return 'stuck_or_saturated'; }
    return direction === 'up' ? 'calibration_drift_or_fouling' : 'calibration_drift_or_wear';
}

// Confidence 0..1: durata + monotonicita/flatline + bassa varianza + campioni + assenza di supporto agronomico + qualita (gate)
function computeDriftConfidence({ type, profile, durationHours, samples, supportingEvents, qualityOk }) {
    if (!qualityOk) { return { confidence: 0, factors: { qualityOk: false } }; }
    const samplesF = Math.min((samples || 0) / 24, 1);
    const durationF = Math.min((durationHours || 0) / (2 * DRIFT.MIN_DURATION_HOURS), 1);
    const absenceF = clamp01(1 - (supportingEvents || 0) / 3); // disconnessione dagli eventi agronomici -> piu sospetto
    let c;
    if (type === 'stuck') {
        c = 0.4 + 0.3 * profile.flatlineScore + 0.15 * samplesF + 0.15 * durationF;
    } else {
        const smoothness = clamp01(1 - profile.residRel / DRIFT.MAX_RESID_REL);
        c = 0.3 + 0.2 * profile.monotonicity + 0.15 * smoothness + 0.12 * samplesF + 0.1 * durationF + 0.13 * absenceF;
    }
    return {
        confidence: clamp01(c),
        factors: {
            type,
            monotonicity: round3(profile.monotonicity),
            flatline_score: round3(profile.flatlineScore),
            std_rel: round3(profile.stdRel),
            samples: samples || 0,
            duration_hours: round1(durationHours),
            supporting_events: supportingEvents || 0,
            qualityOk: true
        }
    };
}

async function windowReadings(sensorId, fromTs, toTs) {
    return query(
        `SELECT value, timestamp FROM sensor_readings
         WHERE sensor_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
        [sensorId, fromTs, toTs]
    );
}

async function findOpenDrift(sensorId, metric) {
    const rows = await query(
        `SELECT * FROM agro_actions_detected
         WHERE sensor_id = ? AND metric = ? AND event_type = 'sensor_drift' AND status = 'open'
         ORDER BY id DESC LIMIT 1`,
        [sensorId, metric]
    );
    return rows[0] || null;
}

// Eventi agronomici di supporto recenti (un drift "vero" e disconnesso da questi)
async function countSupport(sensorId, metric, fromTs) {
    const rows = await query(
        `SELECT count(*) AS c FROM agro_actions_detected
         WHERE sensor_id = ? AND metric = ?
           AND event_type IN ('out_of_range','regime_shift','worsening','improvement')
           AND (status = 'open' OR started_at >= ?)`,
        [sensorId, metric, fromTs]
    );
    return Number(rows[0].c);
}

async function hasOpenOfType(sensorId, metric, type) {
    const rows = await query(
        `SELECT 1 FROM agro_actions_detected WHERE sensor_id = ? AND metric = ? AND event_type = ? AND status = 'open' LIMIT 1`,
        [sensorId, metric, type]
    );
    return rows.length > 0;
}

async function evaluateSensorDrift({ userId, sensor, range, quality, now = new Date(), dryRun = false }) {
    const actions = [];
    const identity = assertLocalIdentity({ ownerUserId: userId, deviceId: sensor.device_id, context: 'sensor-drift-analyzer' });
    const sensorId = sensor.id;
    const metric = (range && range.metric) || metricKeyForSensor(sensor) || sensor.subtype || sensor.type;

    // Quality gate (riuso Sprint 1.2): offline / data gap / coverage insufficiente -> nessun evento
    if (!quality || !quality.ok) {
        return { suppressed: true, status: quality ? quality.status : 'unknown', actions };
    }

    const nowMs = now.getTime();
    const nowTs = new Date(nowMs).toISOString(); // clock iniettabile (replay storico)
    const fromTs = new Date(nowMs - DRIFT.WINDOW_HOURS * HOUR_MS);
    const rows = await windowReadings(sensorId, fromTs, now);
    const vals = rows.map((r) => Number(r.value)).filter(Number.isFinite);
    const ts = rows.map((r) => new Date(r.timestamp).getTime());
    const durationHours = ts.length > 1 ? (Math.max(...ts) - Math.min(...ts)) / HOUR_MS : 0;

    const open = await findOpenDrift(sensorId, metric);

    // Profilo + classificazione (se abbastanza dati)
    let profile = null; let cls = { type: null, reason: 'insufficient' };
    if (vals.length >= 2) {
        profile = computeDriftProfile(vals);
        cls = classifyDrift(profile, durationHours, vals.length);
    }

    // --- Caso A: drift gia aperto -> chiudi se il sensore e tornato normale ---
    if (open) {
        if (vals.length < DRIFT.MIN_SAMPLES) {
            return { suppressed: true, status: 'insufficient_samples', actions };
        }
        if (!cls.type) {
            actions.push({ type: 'close_sensor_drift', closedEventId: open.id });
            if (!dryRun) {
                await query(
                    `UPDATE agro_actions_detected
                     SET status = 'closed', ended_at = CAST(? AS TIMESTAMPTZ), to_state = 'NORMAL',
                         duration_seconds = CAST(EXTRACT(EPOCH FROM (CAST(? AS TIMESTAMPTZ) - started_at)) AS INTEGER),
                         value_snapshot = ?, updated_at = NOW()
                     WHERE id = ?`,
                    [nowTs, nowTs, round3(profile.end), open.id]
                );
            }
        } else if (!dryRun) {
            await query(`UPDATE agro_actions_detected SET value_snapshot = ?, updated_at = NOW() WHERE id = ?`, [round3(profile.end), open.id]);
        }
        return { suppressed: false, open: true, actions };
    }

    // --- Caso B: nessun aperto -> cerca un NUOVO drift ---
    if (!cls.type) {
        return { suppressed: false, open: false, status: cls.reason, actions };
    }

    // Anti-rumore / differenziazione:
    // - se un regime_shift e aperto, il cambiamento e gia spiegato come nuovo baseline -> niente slow drift
    // - se un'anomaly e aperta, uno spike potrebbe spiegare il movimento -> niente slow drift
    if (cls.type === 'slow') {
        if (await hasOpenOfType(sensorId, metric, 'regime_shift')) {
            return { suppressed: false, open: false, status: 'explained_by_regime_shift', actions };
        }
        if (await hasOpenOfType(sensorId, metric, 'anomaly')) {
            return { suppressed: false, open: false, status: 'explained_by_anomaly', actions };
        }
    }

    const supportingEvents = await countSupport(sensorId, metric, fromTs);
    const { confidence, factors } = computeDriftConfidence({
        type: cls.type, profile, durationHours, samples: vals.length, supportingEvents, qualityOk: true
    });
    if (confidence < DRIFT.MIN_CONFIDENCE) {
        return { suppressed: false, open: false, status: 'low_confidence', actions };
    }

    const driftRate = durationHours > 0 ? profile.totalDisp / durationHours : 0; // unita/ora
    const cause = suspectedCause(cls.type, profile.direction);
    const severity = cls.type === 'stuck' ? 'medium' : 'low';
    const evidence = {
        drift_type: cls.type,
        start_value: round3(profile.start),
        end_value: round3(profile.end),
        drift_rate: round3(driftRate),
        monotonicity: round3(profile.monotonicity),
        variance: round3(profile.std * profile.std),
        stdev: round3(profile.std),
        flatline_score: round3(profile.flatlineScore),
        max_step_ratio: round3(profile.maxStepRatio),
        r2: round3(profile.r2),
        sample_count: profile.n,
        duration_hours: round1(durationHours),
        suspected_cause: cause,
        confidence_factors: factors
    };
    const rangeSnap = range ? JSON.stringify({ min: range.min, max: range.max, source: range.source }) : JSON.stringify({});

    actions.push({ type: 'open_sensor_drift', driftType: cls.type, severity, confidence: round3(confidence), suspectedCause: cause });
    if (!dryRun) {
        await query(
            `INSERT INTO agro_actions_detected
                (user_id, owner_user_id, device_id, sensor_id, metric, event_type, status, severity, confidence,
                 started_at, from_state, to_state, value_snapshot, range_snapshot, evidence_json,
                 linked_alarm_event_id, rule_version)
             VALUES (?, ?, ?, ?, ?, 'sensor_drift', 'open', ?, ?, ?, 'NORMAL', 'DRIFT', ?,
                     CAST(? AS JSONB), CAST(? AS JSONB), NULL, ?)`,
            [
                identity.owner_user_id, identity.owner_user_id, identity.device_id, sensorId, metric,
                severity, confidence, nowTs, round3(profile.end), rangeSnap, JSON.stringify(evidence), RULE_VERSION
            ]
        );
    }

    return { suppressed: false, open: false, drift: cls.type, confidence: round3(confidence), actions };
}

module.exports = { evaluateSensorDrift, computeDriftProfile, classifyDrift, computeDriftConfidence, DRIFT, RULE_VERSION };
