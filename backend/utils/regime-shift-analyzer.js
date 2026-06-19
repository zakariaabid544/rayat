// Rayat Intelligence — Sprint 1.7 · Regime Shift Analyzer (additivo)
// Genera SOLO eventi `regime_shift`: "il comportamento normale della serra e cambiato in modo persistente".
// NON e anomaly (spike momentaneo), NON e out_of_range (soglia), NON e worsening (trend di breve).
// Metodo: confronto FINESTRA CORTA vs FINESTRA LUNGA con statistica classica/robusta (mediana+MAD).
// Robusto agli spike: lo score usa min(|delta_media|, |delta_mediana|) -> un singolo picco (sposta la media
// ma non la mediana) NON genera regime_shift. Riusa metricKeyForSensor + Quality Gate SENZA modificarli.
// NON tocca alarm_events / active_alerts. Idempotente: max 1 regime_shift 'open' per (sensor_id, metric).
const { query } = require('../config/database');
const { metricKeyForSensor } = require('./range-resolver');
const { assertLocalIdentity } = require('./intelligence-tenancy');

const RULE_VERSION = 's1.7';

// Parametri tecnici CONFIGURABILI (statistici, non soglie agronomiche)
const REGIME = {
    SHORT_DAYS: Number(process.env.AGRO_REGIME_SHORT_DAYS || 7),         // "nuovo" comportamento recente
    LONG_DAYS: Number(process.env.AGRO_REGIME_LONG_DAYS || 30),          // riferimento storico ("vecchio" normale)
    MIN_PERSIST_DAYS: Number(process.env.AGRO_REGIME_MIN_PERSIST_DAYS || 3), // durata minima del nuovo regime
    MIN_SHORT_SAMPLES: Number(process.env.AGRO_REGIME_MIN_SHORT_SAMPLES || 5),
    MIN_LONG_SAMPLES: Number(process.env.AGRO_REGIME_MIN_LONG_SAMPLES || 10),
    SHIFT_THRESH: Number(process.env.AGRO_REGIME_SHIFT_THRESH || 1.5),   // spostamento in "sigma" del vecchio baseline
    MIN_DELTA_PCT: Number(process.env.AGRO_REGIME_MIN_DELTA_PCT || 5),   // guardia: spostamento relativo minimo (%)
    CLOSE_THRESH: Number(process.env.AGRO_REGIME_CLOSE_THRESH || 0.8),   // ritorno entro 0.8 sigma dall'originale -> chiusura
    MIN_CONFIDENCE: Number(process.env.AGRO_REGIME_MIN_CONFIDENCE || 0.5)
};

const MAD_TO_SIGMA = 1.4826;
const EPS = 1e-9;
const DAY_MS = 86400000;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round3(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null; }
function round1(x) { return Number.isFinite(x) ? Math.round(x * 10) / 10 : null; }
function meanOf(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function median(a) {
    if (!a.length) { return 0; }
    const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdevOf(a) { if (!a.length) { return 0; } const m = meanOf(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

// Scala robusta del vecchio baseline (per misurare lo spostamento in "sigma")
function baselineScale(values) {
    const med = median(values);
    const mad = median(values.map((v) => Math.abs(v - med)));
    const robust = MAD_TO_SIGMA * mad;
    if (robust > EPS) { return robust; }
    const sd = stdevOf(values);
    if (sd > EPS) { return sd; }
    return 0.1 * Math.max(Math.abs(med), 1); // baseline piatto: scala minima relativa (anti falsi positivi)
}

// Decisione pura: confronta vecchio (long-ref) e nuovo (short). Esportata per i test in-memory.
function computeRegimeDecision({ oldValues, newValues }) {
    const oldMean = meanOf(oldValues);
    const newMean = meanOf(newValues);
    const oldMedian = median(oldValues);
    const newMedian = median(newValues);
    const scale = baselineScale(oldValues);
    const deltaMean = newMean - oldMean;
    const deltaMedian = newMedian - oldMedian;
    // min(|Δmedia|,|Δmediana|): uno spike sposta la media ma non la mediana -> score basso -> niente regime_shift
    const shiftScore = Math.min(Math.abs(deltaMean), Math.abs(deltaMedian)) / (scale || 1);
    const deltaPct = Math.abs(oldMean) > EPS ? (deltaMean / oldMean) * 100 : null;
    const significant = shiftScore >= REGIME.SHIFT_THRESH && (deltaPct === null || Math.abs(deltaPct) >= REGIME.MIN_DELTA_PCT);
    return {
        oldMean, newMean, oldMedian, newMedian, scale,
        deltaMean, deltaMedian, deltaPct, shiftScore, significant,
        direction: deltaMean >= 0 ? 'increase' : 'decrease'
    };
}

function severityForScore(s) {
    if (s >= 2 * REGIME.SHIFT_THRESH) { return 'high'; }
    if (s >= 1.3 * REGIME.SHIFT_THRESH) { return 'medium'; }
    return 'low';
}

// Confidence 0..1: persistenza (durata) + magnitudine spostamento + numerosita + qualita (gate)
function computeRegimeConfidence({ shiftScore, newSamples, durationDays, qualityOk }) {
    if (!qualityOk) { return { confidence: 0, factors: { qualityOk: false } }; }
    const intensity = clamp01((shiftScore - REGIME.SHIFT_THRESH) / (2 * REGIME.SHIFT_THRESH));
    const samplesF = Math.min((newSamples || 0) / 24, 1);
    const persistF = Math.min((durationDays || 0) / (2 * REGIME.MIN_PERSIST_DAYS), 1);
    const c = 0.35 + 0.25 * intensity + 0.2 * samplesF + 0.2 * persistF;
    return {
        confidence: clamp01(c),
        factors: {
            base: 0.35,
            displacement: round3(intensity),
            samples: newSamples || 0,
            persistence_days: round1(durationDays),
            shift_threshold: REGIME.SHIFT_THRESH,
            qualityOk: true
        }
    };
}

async function readingsBetween(sensorId, fromTs, toTs) {
    return query(
        `SELECT value, timestamp FROM sensor_readings
         WHERE sensor_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
        [sensorId, fromTs, toTs]
    );
}

async function findOpenRegime(sensorId, metric) {
    const rows = await query(
        `SELECT * FROM agro_actions_detected
         WHERE sensor_id = ? AND metric = ? AND event_type = 'regime_shift' AND status = 'open'
         ORDER BY id DESC LIMIT 1`,
        [sensorId, metric]
    );
    return rows[0] || null;
}

function parseEvidence(raw) {
    if (!raw) { return {}; }
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (e) { return {}; } }
    return raw;
}

async function evaluateRegimeShift({ userId, sensor, range, quality, now = new Date(), dryRun = false }) {
    const actions = [];
    const identity = assertLocalIdentity({ ownerUserId: userId, deviceId: sensor.device_id, context: 'regime-shift-analyzer' });
    const sensorId = sensor.id;
    const metric = (range && range.metric) || metricKeyForSensor(sensor) || sensor.subtype || sensor.type;

    // Quality gate (riuso Sprint 1.2): offline / data gap / coverage insufficiente -> nessun evento
    if (!quality || !quality.ok) {
        return { suppressed: true, status: quality ? quality.status : 'unknown', actions };
    }

    const nowMs = now.getTime();
    const shortFrom = new Date(nowMs - REGIME.SHORT_DAYS * DAY_MS);
    const shortRows = await readingsBetween(sensorId, shortFrom, now);
    const shortVals = shortRows.map((r) => Number(r.value)).filter(Number.isFinite);
    const shortTs = shortRows.map((r) => new Date(r.timestamp).getTime());
    const newSpanDays = shortTs.length > 1 ? (Math.max(...shortTs) - Math.min(...shortTs)) / DAY_MS : 0;

    const open = await findOpenRegime(sensorId, metric);

    // --- Caso A: esiste gia un regime_shift aperto -> valuta il RITORNO all'originale (chiusura) ---
    if (open) {
        if (shortVals.length < REGIME.MIN_SHORT_SAMPLES) {
            return { suppressed: true, status: 'insufficient_short', actions }; // niente evidenze per chiudere
        }
        const ev = parseEvidence(open.evidence_json);
        const origMean = Number(ev.old_mean);
        const origScale = Number(ev.old_scale) > EPS ? Number(ev.old_scale) : 1;
        const newCenter = median(shortVals);
        const backScore = Math.abs(newCenter - origMean) / origScale;
        if (Number.isFinite(origMean) && backScore < REGIME.CLOSE_THRESH) {
            actions.push({ type: 'close_regime_shift', value: round3(newCenter), closedEventId: open.id });
            if (!dryRun) {
                await query(
                    `UPDATE agro_actions_detected
                     SET status = 'closed', ended_at = NOW(), to_state = 'BASELINE_BACK',
                         duration_seconds = CAST(EXTRACT(EPOCH FROM (NOW() - started_at)) AS INTEGER),
                         value_snapshot = ?, updated_at = NOW()
                     WHERE id = ?`,
                    [median(shortVals), open.id]
                );
            }
        } else if (!dryRun) {
            // ancora nel regime spostato -> aggiorna lo snapshot (NESSUN duplicato)
            await query(
                `UPDATE agro_actions_detected SET value_snapshot = ?, updated_at = NOW() WHERE id = ?`,
                [meanOf(shortVals), open.id]
            );
        }
        return { suppressed: false, open: true, actions };
    }

    // --- Caso B: nessun aperto -> cerca un NUOVO regime_shift (long-ref vs short) ---
    const longFrom = new Date(nowMs - REGIME.LONG_DAYS * DAY_MS);
    const refRows = await readingsBetween(sensorId, longFrom, shortFrom); // riferimento storico ESCLUDENDO la finestra corta
    const refVals = refRows.map((r) => Number(r.value)).filter(Number.isFinite);

    if (refVals.length < REGIME.MIN_LONG_SAMPLES || shortVals.length < REGIME.MIN_SHORT_SAMPLES) {
        return { suppressed: true, status: 'insufficient_samples', actions };
    }
    if (newSpanDays < REGIME.MIN_PERSIST_DAYS) {
        return { suppressed: true, status: 'not_persistent', actions }; // troppo breve: spike/transitorio, non regime
    }

    const dec = computeRegimeDecision({ oldValues: refVals, newValues: shortVals });
    const { confidence, factors } = computeRegimeConfidence({
        shiftScore: dec.shiftScore, newSamples: shortVals.length, durationDays: newSpanDays, qualityOk: true
    });

    if (!dec.significant || confidence < REGIME.MIN_CONFIDENCE) {
        return { suppressed: false, open: false, actions };
    }

    const severity = severityForScore(dec.shiftScore);
    const evidence = {
        old_mean: round3(dec.oldMean),
        new_mean: round3(dec.newMean),
        delta: round3(dec.deltaMean),
        delta_pct: dec.deltaPct === null ? null : round1(dec.deltaPct),
        duration_days: round1(newSpanDays),
        sample_count: refVals.length + shortVals.length,
        old_sample_count: refVals.length,
        new_sample_count: shortVals.length,
        old_median: round3(dec.oldMedian),
        new_median: round3(dec.newMedian),
        old_scale: round3(dec.scale),
        shift_score: round3(dec.shiftScore),
        direction: dec.direction,
        short_days: REGIME.SHORT_DAYS,
        long_days: REGIME.LONG_DAYS,
        confidence_factors: factors
    };
    const rangeSnap = range ? JSON.stringify({ min: range.min, max: range.max, source: range.source }) : JSON.stringify({});

    actions.push({ type: 'open_regime_shift', direction: dec.direction, shiftScore: round3(dec.shiftScore), severity, confidence: round3(confidence) });
    if (!dryRun) {
        await query(
            `INSERT INTO agro_actions_detected
                (user_id, owner_user_id, device_id, sensor_id, metric, event_type, status, severity, confidence,
                 started_at, from_state, to_state, value_snapshot, range_snapshot, evidence_json,
                 linked_alarm_event_id, rule_version)
             VALUES (?, ?, ?, ?, ?, 'regime_shift', 'open', ?, ?, NOW(), 'BASELINE_OLD', 'BASELINE_NEW', ?,
                     CAST(? AS JSONB), CAST(? AS JSONB), NULL, ?)`,
            [
                identity.owner_user_id, identity.owner_user_id, identity.device_id, sensorId, metric,
                severity, confidence, round3(dec.newMean), rangeSnap, JSON.stringify(evidence), RULE_VERSION
            ]
        );
    }

    return { suppressed: false, open: false, shift: true, confidence: round3(confidence), actions };
}

module.exports = { evaluateRegimeShift, computeRegimeDecision, computeRegimeConfidence, baselineScale, REGIME, RULE_VERSION };
