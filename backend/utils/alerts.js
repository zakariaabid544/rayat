const { query } = require('../config/database');

const ATTENTION_PERSISTENCE_MINUTES = 15;
const NOTIFICATION_COOLDOWN_MINUTES = 30;

function parseDate(value) {
    if (!value) {
        return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

async function findSensorIdForEvent(userId, sensorType, sensorSubtype) {
    if (!userId || !sensorType) {
        return null;
    }

    const params = [userId, sensorType];
    let sql = `
        SELECT s.id
        FROM sensors s
        INNER JOIN devices d ON d.id = s.device_id
        WHERE d.user_id = ?
          AND s.type = ?
    `;

    if (sensorSubtype) {
        sql += ' AND (s.subtype = ? OR s.subtype IS NULL)';
        params.push(sensorSubtype);
    }

    sql += ' ORDER BY s.id DESC LIMIT 1';

    const rows = await query(sql, params);
    return rows[0]?.id || null;
}

async function resolveAlarmEvent({ userId, sensorType, sensorSubtype, param }) {
    if (!userId || !sensorType || !param) {
        return;
    }

    await query(
        `UPDATE alarm_events
         SET is_resolved = TRUE,
             resolved_at = NOW(),
             updated_at = NOW()
         WHERE user_id = ?
           AND sensor_type = ?
           AND param = ?
           AND COALESCE(sensor_subtype, '') = COALESCE(?, '')
           AND is_resolved = FALSE`,
        [userId, sensorType, param, sensorSubtype || null]
    );
}

async function upsertAlarmEvent({
    userId,
    sensorId = null,
    sensorType,
    sensorSubtype = null,
    param,
    level,
    value,
    optimalMin = null,
    optimalMax = null,
    crop = null
}) {
    if (!userId || !sensorType || !param || !['attention', 'alert'].includes(level)) {
        return null;
    }

    const resolvedSensorId = sensorId || await findSensorIdForEvent(userId, sensorType, sensorSubtype);
    const priority = level === 'alert' ? 'high' : 'medium';

    const existingRows = await query(
        `SELECT *
         FROM alarm_events
         WHERE user_id = ?
           AND sensor_type = ?
           AND param = ?
           AND COALESCE(sensor_subtype, '') = COALESCE(?, '')
           AND is_resolved = FALSE
         ORDER BY id DESC
         LIMIT 1`,
        [userId, sensorType, param, sensorSubtype || null]
    );

    let eventId;
    let firstSeenAt = new Date();
    let lastNotifiedAt = null;

    if (!existingRows.length) {
        const result = await query(
            `INSERT INTO alarm_events (
                user_id,
                sensor_id,
                sensor_type,
                sensor_subtype,
                param,
                crop,
                level,
                priority,
                value,
                optimal_min,
                optimal_max,
                first_seen_at,
                last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                userId,
                resolvedSensorId,
                sensorType,
                sensorSubtype || null,
                param,
                crop || null,
                level,
                priority,
                value,
                optimalMin,
                optimalMax
            ]
        );
        eventId = result.insertId;
    } else {
        const existing = existingRows[0];
        eventId = existing.id;
        firstSeenAt = parseDate(existing.first_seen_at) || firstSeenAt;
        lastNotifiedAt = parseDate(existing.last_notified_at);

        await query(
            `UPDATE alarm_events
             SET sensor_id = COALESCE(?, sensor_id),
                 crop = ?,
                 level = ?,
                 priority = ?,
                 value = ?,
                 optimal_min = ?,
                 optimal_max = ?,
                 last_seen_at = NOW(),
                 updated_at = NOW()
             WHERE id = ?`,
            [
                resolvedSensorId,
                crop || null,
                level,
                priority,
                value,
                optimalMin,
                optimalMax,
                eventId
            ]
        );
    }

    const now = new Date();
    const cooldownPassed = !lastNotifiedAt || ((now.getTime() - lastNotifiedAt.getTime()) >= (NOTIFICATION_COOLDOWN_MINUTES * 60000));
    const persistedLongEnough = (now.getTime() - firstSeenAt.getTime()) >= (ATTENTION_PERSISTENCE_MINUTES * 60000);
    const shouldNotify = level === 'alert'
        ? cooldownPassed
        : (persistedLongEnough && cooldownPassed);

    if (shouldNotify) {
        await query(
            `UPDATE alarm_events
             SET last_notified_at = NOW(),
                 notification_count = notification_count + 1,
                 updated_at = NOW()
             WHERE id = ?`,
            [eventId]
        );

        console.log(`Alarm notification ${level === 'alert' ? 'immediate' : 'persistent'}:`, {
            sensorType,
            sensorSubtype,
            param,
            crop,
            value,
            optimalMin,
            optimalMax
        });
    }

    return {
        id: eventId,
        notified: shouldNotify
    };
}

/**
 * Controlla se un valore supera le soglie di allarme e crea alert se necessario
 */
async function checkAlerts(userId, sensorId, value, sensorType, sensorSubtype) {
    try {
        // Ottieni soglie per questo tipo di sensore
        const fullType = sensorSubtype || sensorType;

        const thresholds = await query(
            'SELECT * FROM alert_thresholds WHERE user_id = ? AND sensor_type = ? AND enabled = TRUE',
            [userId, fullType]
        );

        for (const threshold of thresholds) {
            let isViolated = false;
            let alertType = 'warning';

            if (threshold.threshold_type === 'max' && value > threshold.threshold_value) {
                isViolated = true;
                // Critico se supera del 20%
                if (value > threshold.threshold_value * 1.2) {
                    alertType = 'critical';
                }
            } else if (threshold.threshold_type === 'min' && value < threshold.threshold_value) {
                isViolated = true;
                // Critico se sotto del 20%
                if (value < threshold.threshold_value * 0.8) {
                    alertType = 'critical';
                }
            }

            if (isViolated) {
                await upsertAlarmEvent({
                    userId,
                    sensorId,
                    sensorType,
                    sensorSubtype: fullType,
                    param: fullType,
                    level: alertType === 'critical' ? 'alert' : 'attention',
                    value,
                    optimalMin: threshold.threshold_type === 'min' ? threshold.threshold_value : null,
                    optimalMax: threshold.threshold_type === 'max' ? threshold.threshold_value : null
                });

                // Verifica se esiste già un alert non confermato per questo sensore
                const existingAlerts = await query(
                    'SELECT id FROM active_alerts WHERE user_id = ? AND sensor_id = ? AND acknowledged = FALSE',
                    [userId, sensorId]
                );

                if (existingAlerts.length === 0) {
                    // Crea nuovo alert
                    const message = generateAlertMessage(sensorType, sensorSubtype, threshold.threshold_type, value, threshold.threshold_value);

                    await query(
                        'INSERT INTO active_alerts (user_id, sensor_id, alert_type, message, reading_value, threshold_value) VALUES (?, ?, ?, ?, ?, ?)',
                        [userId, sensorId, alertType, message, value, threshold.threshold_value]
                    );

                    if (process.env.NODE_ENV !== 'production') {
                        console.log(`🚨 Alert creato: ${message}`);
                    }
                }
            } else {
                await resolveAlarmEvent({
                    userId,
                    sensorType,
                    sensorSubtype: fullType,
                    param: fullType
                });

                // Se il valore è tornato normale, rimuovi alert esistenti
                await query(
                    'DELETE FROM active_alerts WHERE user_id = ? AND sensor_id = ? AND acknowledged = FALSE',
                    [userId, sensorId]
                );
            }
        }

    } catch (error) {
        console.error('Check alerts error:', error);
        // Non bloccare il flusso principale se c'è un errore negli alert
    }
}

/**
 * Genera messaggio di alert localizzato
 */
function generateAlertMessage(sensorType, sensorSubtype, thresholdType, value, thresholdValue) {
    const type = sensorSubtype || sensorType;

    const messages = {
        'energia_consumption': {
            max: `Consumo energetico elevato: ${value} kW (soglia: ${thresholdValue} kW)`
        },
        'acqua_level': {
            min: `Livello acqua critico: ${value} m (soglia: ${thresholdValue} m)`
        },
        'terreno_moisture': {
            min: `Terreno troppo secco: ${value}% (soglia: ${thresholdValue}%)`
        },
        'clima_temperature': {
            max: `Temperatura troppo alta: ${value}°C (soglia: ${thresholdValue}°C)`,
            min: `Rischio gelo: ${value}°C (soglia: ${thresholdValue}°C)`
        }
    };

    if (messages[type] && messages[type][thresholdType]) {
        return messages[type][thresholdType];
    }

    return `Valore ${thresholdType === 'max' ? 'sopra' : 'sotto'} soglia: ${value} (soglia: ${thresholdValue})`;
}

module.exports = {
    checkAlerts,
    generateAlertMessage,
    upsertAlarmEvent,
    resolveAlarmEvent
};
