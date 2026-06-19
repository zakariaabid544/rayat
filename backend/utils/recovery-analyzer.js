// Rayat Intelligence — Sprint 1.5 · Recovery Analyzer (additivo)
// Genera SOLO eventi `recovery` (episodio, status='closed') ricostruendo l'episodio dagli eventi
// gia prodotti (out_of_range chiuso + return_to_range [+ improvement/stabilization]) e dalle letture.
// NON tocca alarm_events / active_alerts. Nessuna soglia agronomica inventata (range dal resolver).
const { query } = require('../config/database');
const { resolveEffectiveRange } = require('./range-resolver');
const { assertLocalIdentity } = require('./intelligence-tenancy');

const RULE_VERSION = 's1.5';

// Parametri tecnici configurabili (non soglie agronomiche)
const RECOVERY = {
    CONFIRM_MIN: Number(process.env.AGRO_RECOVERY_CONFIRM_MIN || 30),       // finestra di conferma stabilita post-rientro
    RELAPSE_MIN: Number(process.env.AGRO_RECOVERY_RELAPSE_MIN || 60),       // finestra in cui un nuovo breach = relapse
    MIN_SAMPLES: Number(process.env.AGRO_RECOVERY_MIN_SAMPLES || 5),        // campioni minimi durante il breach
    MIN_CONFIRM_SAMPLES: Number(process.env.AGRO_RECOVERY_MIN_CONFIRM_SAMPLES || 3), // campioni minimi nella conferma
    MIN_CONFIDENCE: Number(process.env.AGRO_RECOVERY_MIN_CONFIDENCE || 0.5),
    MAX_EPISODE_AGE_MIN: Number(process.env.AGRO_RECOVERY_MAX_EPISODE_AGE_MIN || 10080) // 7 giorni
};

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round3(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null; }
function span(range) {
    if (Number.isFinite(range.min) && Number.isFinite(range.max)) { return Math.abs(range.max - range.min) || 1; }
    const ref = Number.isFinite(range.min) ? range.min : range.max;
    return Math.abs(ref) || 1;
}
function deviation(v, range) {
    if (Number.isFinite(range.min) && v < range.min) { return range.min - v; }
    if (Number.isFinite(range.max) && v > range.max) { return v - range.max; }
    return 0;
}
function stdev(values) {
    if (!values.length) { return 0; }
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
}

// Qualita 0..1: monotonicita del rientro + stabilita post-rientro + vicinanza al centro
function computeRecoveryQuality(breachValues, confirmValues, range) {
    const s = span(range);
    const devs = breachValues.map((v) => deviation(v, range));
    let improving = 0;
    for (let i = 1; i < devs.length; i++) { if (devs[i] <= devs[i - 1]) { improving++; } }
    const mono = devs.length > 1 ? improving / (devs.length - 1) : 1;

    const std = stdev(confirmValues);
    const qStab = clamp01(1 - (std / s) / 0.1);

    const finalValue = confirmValues.length ? confirmValues[confirmValues.length - 1] : null;
    let qCenter = 0.5;
    if (finalValue !== null && Number.isFinite(range.min) && Number.isFinite(range.max)) {
        const center = (range.min + range.max) / 2;
        const half = (range.max - range.min) / 2 || 1;
        qCenter = clamp01(1 - Math.abs(finalValue - center) / half);
    }
    const quality = clamp01(0.4 * mono + 0.3 * qStab + 0.3 * qCenter);
    return { quality, mono, qStab, qCenter, std, finalValue };
}

function computeRecoveryConfidence({ samples, hasImprovement, hasStabilization, hasAlarmLink, noDataGap }) {
    if (!noDataGap) { return { confidence: 0, factors: { noDataGap: false } }; }
    let c = 0.4;
    if (hasImprovement) { c += 0.2; }
    if (hasStabilization) { c += 0.2; }
    if (hasAlarmLink) { c += 0.1; }
    c += 0.15 * Math.min((samples || 0) / 12, 1);
    return {
        confidence: clamp01(c),
        factors: { base: 0.4, hasImprovement: !!hasImprovement, hasStabilization: !!hasStabilization, hasAlarmLink: !!hasAlarmLink, samples: samples || 0, noDataGap: true }
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

async function evaluateRecovery({ userId, sensor, range, now = new Date(), dryRun = false }) {
    const actions = [];
    const identity = assertLocalIdentity({ ownerUserId: userId, deviceId: sensor.device_id, context: 'recovery-analyzer' });
    const nowTs = (now instanceof Date ? now : new Date(now)).toISOString(); // clock iniettabile (replay storico)
    const sensorId = sensor.id;

    // Recovery analizza episodi PASSATI: il range non dipende dalla freschezza dei dati correnti.
    // Se il job non lo fornisce (quality gate sulla finestra attuale), lo risolviamo qui.
    let effRange = range;
    if (!effRange || (effRange.min === null && effRange.max === null)) {
        effRange = await resolveEffectiveRange({ userId, sensor });
    }
    if (!effRange || (effRange.min === null && effRange.max === null)) {
        return { suppressed: true, status: 'no_range', actions };
    }
    const metric = effRange.metric || sensor.subtype || sensor.type;

    const waitMin = Math.max(RECOVERY.CONFIRM_MIN, RECOVERY.RELAPSE_MIN);
    // Episodi candidati: out_of_range CHIUSI, con conferma+relapse gia osservabili, recenti
    const candidates = await query(
        `SELECT * FROM agro_actions_detected
         WHERE sensor_id = ? AND metric = ? AND event_type = 'out_of_range' AND status = 'closed'
           AND ended_at IS NOT NULL
           AND ended_at <= CAST(? AS TIMESTAMPTZ) - INTERVAL '${waitMin} minutes'
           AND ended_at >= CAST(? AS TIMESTAMPTZ) - INTERVAL '${RECOVERY.MAX_EPISODE_AGE_MIN} minutes'
         ORDER BY ended_at DESC LIMIT 20`,
        [sensorId, metric, nowTs, nowTs]
    );

    for (const breach of candidates) {
        const startedAt = breach.started_at;
        const endedAt = breach.ended_at;

        // Idempotenza: recovery gia presente per questo episodio (stessa started_at)?
        const existing = await query(
            `SELECT id FROM agro_actions_detected WHERE sensor_id = ? AND metric = ? AND event_type = 'recovery' AND started_at = ? LIMIT 1`,
            [sensorId, metric, startedAt]
        );
        if (existing.length) { continue; }

        const endedMs = new Date(endedAt).getTime();
        const relapseEnd = new Date(endedMs + RECOVERY.RELAPSE_MIN * 60000);
        const confirmEnd = new Date(endedMs + RECOVERY.CONFIRM_MIN * 60000);

        // Relapse: nuovo out_of_range entro la finestra -> niente recovery
        const relapse = await query(
            `SELECT count(*) AS c FROM agro_actions_detected
             WHERE sensor_id = ? AND metric = ? AND event_type = 'out_of_range'
               AND started_at > ? AND started_at <= ?`,
            [sensorId, metric, endedAt, relapseEnd]
        );
        if (Number(relapse[0].c) > 0) { continue; }

        // Conferma: letture post-rientro tutte in range e sufficienti
        const confirmRows = await readingsBetween(sensorId, endedAt, confirmEnd);
        const confirmValues = confirmRows.map((r) => Number(r.value)).filter(Number.isFinite);
        if (confirmValues.length < RECOVERY.MIN_CONFIRM_SAMPLES) { continue; } // rientro troppo breve / data gap
        const anyOut = confirmValues.some((v) => deviation(v, effRange) > 0);
        if (anyOut) { continue; }

        // Letture durante il breach (per peak deviation, speed, monotonicita)
        const breachRows = await readingsBetween(sensorId, startedAt, endedAt);
        const breachValues = breachRows.map((r) => Number(r.value)).filter(Number.isFinite);
        const noDataGap = breachValues.length >= RECOVERY.MIN_SAMPLES;
        if (!noDataGap) { continue; } // dati insufficienti durante l'episodio

        // Link agli eventi correlati
        const ret = await query(
            `SELECT id FROM agro_actions_detected WHERE sensor_id = ? AND metric = ? AND event_type = 'return_to_range'
             AND started_at >= ? AND started_at <= ? ORDER BY id DESC LIMIT 1`,
            [sensorId, metric, new Date(endedMs - 5 * 60000), new Date(endedMs + 5 * 60000)]
        );
        const imp = await query(
            `SELECT id FROM agro_actions_detected WHERE sensor_id = ? AND metric = ? AND event_type = 'improvement'
             AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY id DESC LIMIT 1`,
            [sensorId, metric, endedAt, startedAt]
        );
        const stab = await query(
            `SELECT id FROM agro_actions_detected WHERE sensor_id = ? AND metric = ? AND event_type = 'stabilization'
             AND started_at >= ? ORDER BY id DESC LIMIT 1`,
            [sensorId, metric, new Date(endedMs - 5 * 60000)]
        );

        const q = computeRecoveryQuality(breachValues, confirmValues, effRange);
        const durationMin = Math.max(0, Math.round((endedMs - new Date(startedAt).getTime()) / 60000));
        const peakDev = breachValues.reduce((mx, v) => Math.max(mx, deviation(v, effRange)), 0);
        const recoverySpeed = durationMin > 0 ? round3(peakDev / (durationMin / 60)) : null; // unita/ora
        const center = (Number.isFinite(effRange.min) && Number.isFinite(effRange.max)) ? (effRange.min + effRange.max) / 2 : q.finalValue;
        const finalDistToCenter = (Number.isFinite(center) && q.finalValue !== null) ? round3(Math.abs(q.finalValue - center) / span(effRange)) : null;

        const { confidence, factors } = computeRecoveryConfidence({
            samples: breachValues.length + confirmValues.length,
            hasImprovement: imp.length > 0,
            hasStabilization: stab.length > 0,
            hasAlarmLink: !!breach.linked_alarm_event_id,
            noDataGap
        });
        if (confidence < RECOVERY.MIN_CONFIDENCE) { continue; }

        const evidence = {
            linked_out_of_range_id: breach.id,
            linked_return_to_range_id: ret[0] ? ret[0].id : null,
            linked_improvement_id: imp[0] ? imp[0].id : null,
            linked_stabilization_id: stab[0] ? stab[0].id : null,
            recovery_duration_minutes: durationMin,
            recovery_speed: recoverySpeed,
            recovery_quality: round3(q.quality),
            initial_severity: breach.severity,
            final_value: round3(q.finalValue),
            final_distance_to_center: finalDistToCenter,
            relapse_window_minutes: RECOVERY.RELAPSE_MIN,
            confidence_factors: factors
        };
        actions.push({ type: 'emit_recovery', breachId: breach.id, confidence: round3(confidence), quality: round3(q.quality) });

        if (!dryRun) {
            await query(
                `INSERT INTO agro_actions_detected
                    (user_id, owner_user_id, device_id, sensor_id, metric, event_type, status, severity, confidence,
                     started_at, ended_at, duration_seconds, from_state, to_state, value_snapshot,
                     range_snapshot, evidence_json, linked_alarm_event_id, linked_out_of_range_id, rule_version)
                 VALUES (?, ?, ?, ?, ?, 'recovery', 'closed', ?, ?, ?, ?, ?, ?, 'IN_RANGE', ?, CAST(? AS JSONB), CAST(? AS JSONB), ?, ?, ?)
                 ON CONFLICT DO NOTHING`,
                [
                    identity.owner_user_id, identity.owner_user_id, identity.device_id, sensorId, metric,
                    breach.severity || 'info', confidence,
                    startedAt, confirmEnd, durationMin * 60,
                    breach.to_state || 'OUT', q.finalValue,
                    JSON.stringify({ min: effRange.min, max: effRange.max, source: effRange.source }),
                    JSON.stringify(evidence),
                    breach.linked_alarm_event_id || null, breach.id, RULE_VERSION
                ]
            );
        }
    }

    return { suppressed: false, actions };
}

module.exports = { evaluateRecovery, computeRecoveryQuality, computeRecoveryConfidence, RECOVERY, RULE_VERSION };
