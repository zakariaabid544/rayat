// Rayat Intelligence — Sprint 1.3 · Range State Machine (additivo)
// Genera SOLO eventi out_of_range / return_to_range a partire dai range risolti.
// E' una PROIEZIONE collegata ad alarm_events (linked_alarm_event_id): NON crea una seconda
// verita parallela e NON scrive su alarm_events / active_alerts.
const { query } = require('../config/database');

const RULE_VERSION = 's1.3';
const PERSISTENCE_MINUTES = 15;   // anti-rumore: allineato a alerts.js (ATTENTION_PERSISTENCE_MINUTES)
const HYSTERESIS_RATIO = 0.02;    // isteresi 2% del range per evitare flapping (parametro di rilevazione, non agronomico)

// Classifica un valore rispetto al range con isteresi
function classify(value, range) {
    const eps = (Number.isFinite(range.min) && Number.isFinite(range.max))
        ? Math.abs(range.max - range.min) * HYSTERESIS_RATIO
        : 0;
    if (Number.isFinite(range.min) && value < (range.min - eps)) {
        return 'OUT_LOW';
    }
    if (Number.isFinite(range.max) && value > (range.max + eps)) {
        return 'OUT_HIGH';
    }
    return 'IN_RANGE';
}

function severityFor(value, range, state) {
    if (state === 'IN_RANGE') {
        return 'info';
    }
    const ref = state === 'OUT_LOW' ? range.min : range.max;
    if (!Number.isFinite(ref) || !Number.isFinite(value)) {
        return 'medium';
    }
    const span = (Number.isFinite(range.min) && Number.isFinite(range.max))
        ? (Math.abs(range.max - range.min) || Math.abs(ref) || 1)
        : (Math.abs(ref) || 1);
    const distance = Math.abs(value - ref) / span;
    if (distance >= 0.2) { return 'high'; }
    if (distance >= 0.05) { return 'medium'; }
    return 'low';
}

async function findOpenEvent(sensorId, metric, eventType) {
    const rows = await query(
        `SELECT * FROM agro_actions_detected
         WHERE sensor_id = ? AND metric = ? AND event_type = ? AND status = 'open'
         ORDER BY id DESC LIMIT 1`,
        [sensorId, metric, eventType]
    );
    return rows[0] || null;
}

// Collega l'evento agro all'allarme aperto corrispondente (se esiste). alarm_events resta l'autorita.
async function findLinkedAlarmEventId({ userId, sensorId, fullType }) {
    const rows = await query(
        `SELECT id FROM alarm_events
         WHERE is_resolved = FALSE AND (sensor_id = ? OR (user_id = ? AND param = ?))
         ORDER BY id DESC LIMIT 1`,
        [sensorId || null, userId || null, fullType]
    );
    return rows[0] ? rows[0].id : null;
}

async function evaluateSensor({ userId, sensor, recentReadings, range, quality, now = new Date(), dryRun = false }) {
    const actions = [];
    const sensorId = sensor.id;
    const fullType = sensor.subtype || sensor.type;
    const metric = (range && range.metric) || sensor.subtype || sensor.type;

    // Quality gate: durante data gap / offline / dati non freschi NON generiamo eventi agronomici
    if (!quality || !quality.ok) {
        return { suppressed: true, status: quality ? quality.status : 'unknown', actions };
    }
    // Nessun range effettivo -> astensione (nessun evento)
    if (!range || (range.min === null && range.max === null)) {
        return { suppressed: true, status: 'no_range', actions };
    }
    if (!recentReadings || !recentReadings.length) {
        return { suppressed: true, status: 'no_readings', actions };
    }

    const sorted = [...recentReadings].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    const latest = sorted[0];
    const value = Number(latest.value);
    if (!Number.isFinite(value)) {
        return { suppressed: true, status: 'invalid_value', actions };
    }

    const currentState = classify(value, range);

    // Persistenza: le letture negli ultimi PERSISTENCE_MINUTES devono confermare lo stato di breach
    const windowStart = now.getTime() - (PERSISTENCE_MINUTES * 60 * 1000);
    const persistSet = sorted.filter((r) => new Date(r.timestamp).getTime() >= windowStart);
    const breachConfirmed = currentState !== 'IN_RANGE'
        && persistSet.length >= 1
        && persistSet.every((r) => classify(Number(r.value), range) !== 'IN_RANGE');

    const open = await findOpenEvent(sensorId, metric, 'out_of_range');
    const rangeSnap = JSON.stringify({ min: range.min, max: range.max, source: range.source });

    if (currentState !== 'IN_RANGE') {
        if (!open && breachConfirmed) {
            const linked = await findLinkedAlarmEventId({ userId, sensorId, fullType });
            const severity = severityFor(value, range, currentState);
            const evidence = JSON.stringify({
                samples: persistSet.length,
                latest_value: value,
                persistence_minutes: PERSISTENCE_MINUTES
            });
            actions.push({ type: 'open_out_of_range', state: currentState, value, severity, linkedAlarmEventId: linked });
            if (!dryRun) {
                await query(
                    `INSERT INTO agro_actions_detected
                        (user_id, device_id, sensor_id, metric, event_type, status, severity, confidence,
                         started_at, from_state, to_state, value_snapshot, range_snapshot, evidence_json,
                         linked_alarm_event_id, rule_version)
                     VALUES (?, ?, ?, ?, 'out_of_range', 'open', ?, ?, NOW(), 'IN_RANGE', ?, ?,
                             CAST(? AS JSONB), CAST(? AS JSONB), ?, ?)`,
                    [
                        userId || null, sensor.device_id || null, sensorId, metric,
                        severity, range.confidence || 0.7, currentState, value,
                        rangeSnap, evidence, linked, RULE_VERSION
                    ]
                );
            }
        } else if (open && !dryRun) {
            // Evento gia aperto -> aggiorna (NESSUN duplicato)
            await query(
                `UPDATE agro_actions_detected
                 SET value_snapshot = ?, to_state = ?, updated_at = NOW()
                 WHERE id = ?`,
                [value, currentState, open.id]
            );
        }
    } else if (open) {
        // Rientro nel range -> chiudi out_of_range ed emetti return_to_range
        const linked = open.linked_alarm_event_id || await findLinkedAlarmEventId({ userId, sensorId, fullType });
        actions.push({ type: 'close_out_of_range', value, closedEventId: open.id });
        actions.push({ type: 'emit_return_to_range', value });
        if (!dryRun) {
            await query(
                `UPDATE agro_actions_detected
                 SET status = 'closed', ended_at = NOW(), to_state = 'IN_RANGE',
                     duration_seconds = CAST(EXTRACT(EPOCH FROM (NOW() - started_at)) AS INTEGER),
                     value_snapshot = ?, updated_at = NOW()
                 WHERE id = ?`,
                [value, open.id]
            );
            const evidence = JSON.stringify({ closed_event_id: open.id, latest_value: value });
            await query(
                `INSERT INTO agro_actions_detected
                    (user_id, device_id, sensor_id, metric, event_type, status, severity, confidence,
                     started_at, ended_at, from_state, to_state, value_snapshot, range_snapshot, evidence_json,
                     linked_alarm_event_id, rule_version)
                 VALUES (?, ?, ?, ?, 'return_to_range', 'closed', 'low', ?, NOW(), NOW(), ?, 'IN_RANGE', ?,
                         CAST(? AS JSONB), CAST(? AS JSONB), ?, ?)`,
                [
                    userId || null, sensor.device_id || null, sensorId, metric,
                    range.confidence || 0.7, (open.to_state || open.from_state || 'OUT'), value,
                    rangeSnap, evidence, linked, RULE_VERSION
                ]
            );
        }
    }

    return { suppressed: false, state: currentState, actions };
}

module.exports = { evaluateSensor, classify, severityFor, RULE_VERSION };
