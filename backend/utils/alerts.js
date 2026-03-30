const { query } = require('../config/database');

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
    generateAlertMessage
};
