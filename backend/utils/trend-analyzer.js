// Rayat Intelligence — Sprint 1.4 · Trend Analyzer (additivo)
// Genera SOLO eventi improvement / worsening / stabilization a partire dai range risolti (Sprint 1.1)
// e dalle letture, riusando Quality Gate (Sprint 1.2). NON tocca alarm_events / active_alerts.
// Parametri statistici tecnici e CONFIGURABILI (non soglie agronomiche): finestra/min campioni/slope/varianza.
const { query } = require('../config/database');

const RULE_VERSION = 's1.4';

// Parametri tecnici (configurabili via env; default prudenti, NON soglie agronomiche)
const TREND = {
    MIN_SAMPLES: Number(process.env.AGRO_TREND_MIN_SAMPLES || 5),
    R2_MIN: Number(process.env.AGRO_TREND_R2_MIN || 0.5),            // persistenza: bontà del fit lineare
    MIN_SLOPE_REL: Number(process.env.AGRO_TREND_MIN_SLOPE_REL || 0.03), // movimento sostenuto: >=3% dello span/ora
    FLAT_SLOPE_REL: Number(process.env.AGRO_TREND_FLAT_SLOPE_REL || 0.01), // "piatto": <=1% dello span/ora
    MAX_STD_REL: Number(process.env.AGRO_TREND_MAX_STD_REL || 0.05),  // stabilization: std <=5% dello span
    STAB_MIN_MINUTES: Number(process.env.AGRO_TREND_STAB_MIN_MINUTES || 30)
};

const TREND_TYPES = ['improvement', 'worsening', 'stabilization'];

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round3(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null; }

function rangeSpan(range) {
    if (Number.isFinite(range.min) && Number.isFinite(range.max)) {
        return Math.abs(range.max - range.min) || 1;
    }
    const ref = Number.isFinite(range.min) ? range.min : range.max;
    return Math.abs(ref) || 1;
}

function positionState(value, range) {
    if (Number.isFinite(range.min) && value < range.min) { return 'OUT_LOW'; }
    if (Number.isFinite(range.max) && value > range.max) { return 'OUT_HIGH'; }
    return 'IN_RANGE';
}

// Regressione lineare semplice su points [{ t (ore), v }] -> { slope (unit/ora), r2, mean }
function linearRegression(points) {
    const n = points.length;
    const meanT = points.reduce((a, p) => a + p.t, 0) / n;
    const meanV = points.reduce((a, p) => a + p.v, 0) / n;
    let sxx = 0; let sxy = 0; let syy = 0;
    for (const p of points) {
        const dt = p.t - meanT;
        const dv = p.v - meanV;
        sxx += dt * dt; sxy += dt * dv; syy += dv * dv;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const r2 = (sxx > 0 && syy > 0) ? (sxy * sxy) / (sxx * syy) : 0;
    return { slope, r2, mean: meanV };
}

function stdev(points) {
    const n = points.length;
    const mean = points.reduce((a, p) => a + p.v, 0) / n;
    const variance = points.reduce((a, p) => a + (p.v - mean) ** 2, 0) / n;
    return Math.sqrt(variance);
}

// Determina il trend corrente: 'improvement' | 'worsening' | 'stabilization' | null (+ metriche per evidence)
function classifyTrend({ points, range }) {
    if (!points || points.length < TREND.MIN_SAMPLES) {
        return { label: null, reason: 'insufficient_samples' };
    }
    const span = rangeSpan(range);
    const { slope, r2 } = linearRegression(points);
    const sd = stdev(points);
    const latest = points[points.length - 1].v;
    const pos = positionState(latest, range);
    const slopeRel = Math.abs(slope) / span;
    const windowMinutes = (points[points.length - 1].t - points[0].t) * 60;
    const base = { slope, r2, sd, span, latest, pos, windowMinutes };

    // STABILIZATION: in range, piatto, varianza bassa, finestra significativa
    if (pos === 'IN_RANGE'
        && slopeRel <= TREND.FLAT_SLOPE_REL
        && (sd / span) <= TREND.MAX_STD_REL
        && windowMinutes >= TREND.STAB_MIN_MINUTES) {
        return { ...base, label: 'stabilization', confidence: clamp01(0.55 + 0.45 * Math.min(points.length / 12, 1)) };
    }

    // Movimento sostenuto = slope significativo + buon fit (persistenza)
    const sustained = slopeRel >= TREND.MIN_SLOPE_REL && r2 >= TREND.R2_MIN;
    if (!sustained) {
        return { ...base, label: null, reason: 'no_sustained_trend' };
    }

    let label = null;
    if (pos === 'OUT_HIGH') {
        label = slope < 0 ? 'improvement' : 'worsening';
    } else if (pos === 'OUT_LOW') {
        label = slope > 0 ? 'improvement' : 'worsening';
    } else {
        // IN_RANGE: verso il centro = improvement; verso un bordo = worsening
        const center = (Number.isFinite(range.min) && Number.isFinite(range.max))
            ? (range.min + range.max) / 2 : latest;
        const towardCenter = (latest > center && slope < 0) || (latest < center && slope > 0);
        const towardEdge = (slope > 0 && Number.isFinite(range.max)) || (slope < 0 && Number.isFinite(range.min));
        if (towardCenter) { label = 'improvement'; }
        else if (towardEdge) { label = 'worsening'; }
    }
    if (!label) {
        return { ...base, label: null, reason: 'ambiguous' };
    }
    const confidence = clamp01(0.4 + 0.4 * Math.min(r2, 1) + 0.2 * Math.min(points.length / 12, 1));
    return { ...base, label, confidence };
}

function severityForTrend(type, res, range, latest) {
    if (type === 'improvement') { return 'low'; }
    if (type === 'stabilization') { return 'info'; }
    // worsening: severità per pendenza e vicinanza al bordo
    const span = rangeSpan(range);
    const slopeRel = Math.abs(res.slope) / span;
    if (res.pos !== 'IN_RANGE') { return 'high'; }
    let margin = Infinity;
    if (Number.isFinite(range.max)) { margin = Math.min(margin, Math.abs(range.max - latest) / span); }
    if (Number.isFinite(range.min)) { margin = Math.min(margin, Math.abs(latest - range.min) / span); }
    if (margin <= 0.1 || slopeRel >= 0.1) { return 'high'; }
    if (margin <= 0.25 || slopeRel >= 0.05) { return 'medium'; }
    return 'low';
}

async function findOpenEventByType(sensorId, metric, eventType) {
    const rows = await query(
        `SELECT * FROM agro_actions_detected
         WHERE sensor_id = ? AND metric = ? AND event_type = ? AND status = 'open'
         ORDER BY id DESC LIMIT 1`,
        [sensorId, metric, eventType]
    );
    return rows[0] || null;
}

async function evaluateTrend({ userId, sensor, recentReadings, range, quality, now = new Date(), dryRun = false }) {
    const actions = [];
    const metric = (range && range.metric) || sensor.subtype || sensor.type;

    // Quality gate: durante data gap / offline / dati non freschi NON generiamo eventi
    if (!quality || !quality.ok) {
        return { suppressed: true, status: quality ? quality.status : 'unknown', actions };
    }
    if (!range || (range.min === null && range.max === null)) {
        return { suppressed: true, status: 'no_range', actions };
    }
    const valid = (recentReadings || []).filter((r) => Number.isFinite(Number(r.value)));
    if (valid.length < TREND.MIN_SAMPLES) {
        return { suppressed: true, status: 'insufficient_samples', actions };
    }

    const sorted = valid.slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const t0 = new Date(sorted[0].timestamp).getTime();
    const points = sorted.map((r) => ({ t: (new Date(r.timestamp).getTime() - t0) / 3600000, v: Number(r.value) }));

    const res = classifyTrend({ points, range });
    const activeLabel = res.label;
    const latest = points[points.length - 1].v;
    const rangeSnap = JSON.stringify({ min: range.min, max: range.max, source: range.source });
    const evidence = JSON.stringify({
        slope_per_hour: round3(res.slope),
        r2: round3(res.r2),
        stdev: round3(res.sd),
        samples: points.length,
        window_minutes: round3(res.windowMinutes)
    });

    for (const type of TREND_TYPES) {
        const open = await findOpenEventByType(sensor.id, metric, type);
        if (type === activeLabel) {
            const severity = severityForTrend(type, res, range, latest);
            if (!open) {
                actions.push({ type: 'open_' + type, severity, confidence: res.confidence });
                if (!dryRun) {
                    await query(
                        `INSERT INTO agro_actions_detected
                            (user_id, device_id, sensor_id, metric, event_type, status, severity, confidence,
                             started_at, from_state, to_state, value_snapshot, range_snapshot, evidence_json,
                             linked_alarm_event_id, rule_version)
                         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NOW(), ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), NULL, ?)`,
                        [
                            userId || null, sensor.device_id || null, sensor.id, metric, type,
                            severity, res.confidence || 0.5, res.pos, type, latest,
                            rangeSnap, evidence, RULE_VERSION
                        ]
                    );
                }
            } else if (!dryRun) {
                // gia aperto -> aggiorna (NESSUN duplicato)
                await query(
                    `UPDATE agro_actions_detected
                     SET value_snapshot = ?, severity = ?, confidence = ?, evidence_json = CAST(? AS JSONB), updated_at = NOW()
                     WHERE id = ?`,
                    [latest, severity, res.confidence || 0.5, evidence, open.id]
                );
            }
        } else if (open && !dryRun) {
            // il trend di questo tipo non e piu attivo -> chiudi
            actions.push({ type: 'close_' + type });
            await query(
                `UPDATE agro_actions_detected
                 SET status = 'closed', ended_at = NOW(),
                     duration_seconds = CAST(EXTRACT(EPOCH FROM (NOW() - started_at)) AS INTEGER),
                     value_snapshot = ?, updated_at = NOW()
                 WHERE id = ?`,
                [latest, open.id]
            );
        }
    }

    return { suppressed: false, label: activeLabel, actions };
}

module.exports = { evaluateTrend, classifyTrend, severityForTrend, RULE_VERSION, TREND };
