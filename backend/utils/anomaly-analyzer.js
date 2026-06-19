// Rayat Intelligence — Sprint 1.6 · Anomaly Analyzer (additivo)
// Genera SOLO eventi `anomaly`: un valore statisticamente inaspettato rispetto alla storia recente
// del sensore. NON e out_of_range (soglia agronomica), NON e worsening (trend), NON e sensor_drift.
// Deterministico, spiegabile, economico: statistica classica (mediana/MAD + z robusto, fallback stddev).
// Riusa range-resolver (solo metricKeyForSensor) e il Quality Gate (Sprint 1.2) SENZA modificarli.
// NON tocca alarm_events / active_alerts. Idempotente: max 1 anomaly 'open' per (sensor_id, metric).
const { query } = require('../config/database');
const { metricKeyForSensor } = require('./range-resolver');
const { assertLocalIdentity } = require('./intelligence-tenancy');

const RULE_VERSION = 's1.6';

// Parametri tecnici CONFIGURABILI (statistici, non soglie agronomiche)
const ANOMALY = {
    MIN_BASELINE: Number(process.env.AGRO_ANOMALY_MIN_BASELINE || 5),   // campioni minimi di storia per stimare il "normale"
    PERSIST_SAMPLES: Number(process.env.AGRO_ANOMALY_PERSIST || 1),     // letture recenti che devono essere anomale (anti-rumore)
    Z_THRESH: Number(process.env.AGRO_ANOMALY_Z_THRESH || 3.5),         // soglia z robusto (modified z-score, Iglewicz-Hoaglin)
    MIN_CONFIDENCE: Number(process.env.AGRO_ANOMALY_MIN_CONFIDENCE || 0.5),
    CONST_FLOOR_REL: Number(process.env.AGRO_ANOMALY_CONST_FLOOR_REL || 0.1) // baseline piatta: scala minima = 10% del livello
};

const MAD_TO_SIGMA = 1.4826; // rende MAD un estimatore consistente della stddev su dati ~normali
const EPS = 1e-9;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round3(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null; }

function median(values) {
    if (!values.length) { return 0; }
    const s = values.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function meanOf(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
function stdevOf(values) {
    if (!values.length) { return 0; }
    const m = meanOf(values);
    return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
}

// Statistiche di baseline: media, stddev (classici) + mediana, MAD, sigma robusta
function computeAnomalyStats(baseline) {
    const med = median(baseline);
    const mad = median(baseline.map((v) => Math.abs(v - med)));
    return {
        n: baseline.length,
        mean: meanOf(baseline),
        stddev: stdevOf(baseline),
        median: med,
        mad,
        sigmaRobust: MAD_TO_SIGMA * mad
    };
}

// z robusto del valore rispetto al baseline. Sceglie il metodo piu robusto disponibile.
// robust_mad: usa mediana + MAD (resistente all'outlier stesso e a 1-2 contaminazioni nel baseline)
// classic_fallback: MAD=0 ma c'e varianza -> mediana costante, uso media + stddev
// constant_floor: baseline piatto (MAD=0 e stddev=0) -> scala minima relativa per evitare falsi positivi da rumore di quantizzazione
function zScoreFor(value, stats) {
    if (stats.sigmaRobust > EPS) {
        return { z: (value - stats.median) / stats.sigmaRobust, center: stats.median, scale: stats.sigmaRobust, method: 'robust_mad' };
    }
    if (stats.stddev > EPS) {
        return { z: (value - stats.mean) / stats.stddev, center: stats.mean, scale: stats.stddev, method: 'classic_fallback' };
    }
    const floor = ANOMALY.CONST_FLOOR_REL * Math.max(Math.abs(stats.median), 1);
    return { z: (value - stats.median) / floor, center: stats.median, scale: floor, method: 'constant_floor' };
}

function severityForZ(absZ) {
    if (absZ >= 2 * ANOMALY.Z_THRESH) { return 'high'; }
    if (absZ >= 1.3 * ANOMALY.Z_THRESH) { return 'medium'; }
    return 'low';
}

// Confidence 0..1: intensita deviazione + numerosita campioni + persistenza. Quality e un gate (binario).
function computeAnomalyConfidence({ baselineCount, z, persistRun, qualityOk }) {
    if (!qualityOk) { return { confidence: 0, factors: { qualityOk: false } }; }
    const absZ = Math.abs(z);
    const intensity = clamp01((absZ - ANOMALY.Z_THRESH) / (2 * ANOMALY.Z_THRESH));
    const samplesF = Math.min((baselineCount || 0) / 12, 1);
    const persistF = Math.min((persistRun || 0) / 3, 1);
    const c = 0.4 + 0.3 * intensity + 0.2 * samplesF + 0.1 * persistF;
    return {
        confidence: clamp01(c),
        factors: {
            base: 0.4,
            intensity: round3(intensity),
            samples: baselineCount || 0,
            persist_run: persistRun || 0,
            z_threshold: ANOMALY.Z_THRESH,
            qualityOk: true
        }
    };
}

async function findOpenAnomaly(sensorId, metric) {
    const rows = await query(
        `SELECT * FROM agro_actions_detected
         WHERE sensor_id = ? AND metric = ? AND event_type = 'anomaly' AND status = 'open'
         ORDER BY id DESC LIMIT 1`,
        [sensorId, metric]
    );
    return rows[0] || null;
}

async function evaluateAnomaly({ userId, sensor, recentReadings, range, quality, now = new Date(), dryRun = false }) {
    const actions = [];
    const identity = assertLocalIdentity({ ownerUserId: userId, deviceId: sensor.device_id, context: 'anomaly-analyzer' });
    const sensorId = sensor.id;
    const metric = (range && range.metric) || metricKeyForSensor(sensor) || sensor.subtype || sensor.type;

    // Quality gate (riuso Sprint 1.2): data gap / offline / non fresco / coverage insufficiente -> nessun evento
    if (!quality || !quality.ok) {
        return { suppressed: true, status: quality ? quality.status : 'unknown', actions };
    }

    const valid = (recentReadings || [])
        .filter((r) => Number.isFinite(Number(r.value)))
        .map((r) => ({ v: Number(r.value), t: new Date(r.timestamp).getTime() }))
        .sort((a, b) => a.t - b.t);

    const persist = Math.max(1, ANOMALY.PERSIST_SAMPLES);
    // Campioni insufficienti per stimare il "normale": astensione (non chiude eventuali open, mancano evidenze)
    if (valid.length < ANOMALY.MIN_BASELINE + persist) {
        return { suppressed: true, status: 'insufficient_samples', actions };
    }

    const baseline = valid.slice(0, valid.length - persist).map((r) => r.v);
    const candidates = valid.slice(valid.length - persist).map((r) => r.v);
    const stats = computeAnomalyStats(baseline);

    // Tutte le letture recenti (persist) devono essere anomale perche l'anomaly sia attiva (anti-rumore)
    const candZ = candidates.map((v) => zScoreFor(v, stats));
    const anomalyActive = candZ.every((c) => Math.abs(c.z) >= ANOMALY.Z_THRESH);
    const latestValue = candidates[candidates.length - 1];
    const latestZ = candZ[candZ.length - 1];

    const { confidence, factors } = computeAnomalyConfidence({
        baselineCount: baseline.length,
        z: latestZ.z,
        persistRun: persist,
        qualityOk: true
    });

    const open = await findOpenAnomaly(sensorId, metric);

    const normalLow = round3(latestZ.center - ANOMALY.Z_THRESH * latestZ.scale);
    const normalHigh = round3(latestZ.center + ANOMALY.Z_THRESH * latestZ.scale);
    const reason = latestValue > latestZ.center ? 'spike_high' : 'spike_low';
    const rangeOut = (range && ((Number.isFinite(range.min) && latestValue < range.min) || (Number.isFinite(range.max) && latestValue > range.max))) || false;
    const evidence = {
        mean: round3(stats.mean),
        stddev: round3(stats.stddev),
        z_score: round3(latestZ.z),
        sample_count: baseline.length,
        anomaly_reason: reason,
        method: latestZ.method,
        median: round3(stats.median),
        mad: round3(stats.mad),
        center: round3(latestZ.center),
        scale: round3(latestZ.scale),
        z_threshold: ANOMALY.Z_THRESH,
        normal_low: normalLow,
        normal_high: normalHigh,
        baseline_min: round3(Math.min(...baseline)),
        baseline_max: round3(Math.max(...baseline)),
        latest_value: round3(latestValue),
        persist_samples: persist,
        also_out_of_range: rangeOut,
        confidence_factors: factors
    };
    const rangeSnap = range ? JSON.stringify({ min: range.min, max: range.max, source: range.source }) : JSON.stringify({});

    if (anomalyActive && confidence >= ANOMALY.MIN_CONFIDENCE) {
        const severity = severityForZ(Math.abs(latestZ.z));
        if (!open) {
            actions.push({ type: 'open_anomaly', reason, z: round3(latestZ.z), severity, confidence: round3(confidence) });
            if (!dryRun) {
                await query(
                    `INSERT INTO agro_actions_detected
                        (user_id, owner_user_id, device_id, sensor_id, metric, event_type, status, severity, confidence,
                         started_at, from_state, to_state, value_snapshot, range_snapshot, evidence_json,
                         linked_alarm_event_id, rule_version)
                     VALUES (?, ?, ?, ?, ?, 'anomaly', 'open', ?, ?, NOW(), 'NORMAL', 'ANOMALY', ?,
                             CAST(? AS JSONB), CAST(? AS JSONB), NULL, ?)`,
                    [
                        identity.owner_user_id, identity.owner_user_id, identity.device_id, sensorId, metric,
                        severity, confidence, latestValue, rangeSnap, JSON.stringify(evidence), RULE_VERSION
                    ]
                );
            }
        } else if (!dryRun) {
            // gia aperto -> aggiorna (NESSUN duplicato)
            await query(
                `UPDATE agro_actions_detected
                 SET value_snapshot = ?, severity = ?, confidence = ?, evidence_json = CAST(? AS JSONB), updated_at = NOW()
                 WHERE id = ?`,
                [latestValue, severity, confidence, JSON.stringify(evidence), open.id]
            );
        }
    } else if (open) {
        // Comportamento tornato normale -> chiudi anomaly
        actions.push({ type: 'close_anomaly', value: latestValue, closedEventId: open.id });
        if (!dryRun) {
            await query(
                `UPDATE agro_actions_detected
                 SET status = 'closed', ended_at = NOW(), to_state = 'NORMAL',
                     duration_seconds = CAST(EXTRACT(EPOCH FROM (NOW() - started_at)) AS INTEGER),
                     value_snapshot = ?, updated_at = NOW()
                 WHERE id = ?`,
                [latestValue, open.id]
            );
        }
    }

    return { suppressed: false, active: anomalyActive, confidence: round3(confidence), actions };
}

module.exports = { evaluateAnomaly, computeAnomalyStats, zScoreFor, computeAnomalyConfidence, ANOMALY, RULE_VERSION };
