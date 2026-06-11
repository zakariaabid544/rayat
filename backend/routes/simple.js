const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

const DEFAULT_PUBLIC_SENSOR_DEVICE_ID = 'GW-001';

function cleanString(value) {
    return String(value || '').trim();
}

function getPublicSensorDeviceId() {
    return cleanString(process.env.PUBLIC_GATEWAY_DEVICE_ID) || DEFAULT_PUBLIC_SENSOR_DEVICE_ID;
}

function appendPublicTopicScope(sql, params, columnName = 'topic') {
    params.push(`sensors/${getPublicSensorDeviceId()}/%`);
    return `${sql} AND ${columnName} LIKE ?`;
}

function parseNumericValue(value) {
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function shouldSwapSoilPair(soilTemperature, soilMoisture) {
    const temperature = parseNumericValue(soilTemperature);
    const moisture = parseNumericValue(soilMoisture);

    if (!Number.isFinite(temperature) || !Number.isFinite(moisture)) {
        return false;
    }

    return temperature > 35 && moisture < 25;
}

// GET /api/sensors/latest - Formato semplificato per compatibilità
router.get('/latest', async (req, res) => {
    try {
        const params = [];
        const sql = appendPublicTopicScope(
            `SELECT
                sensor_subtype AS subtype,
                value,
                topic
             FROM public_sensor_latest
             WHERE 1 = 1`,
            params
        );

        const publicReadings = await query(sql, params);
        const readingMap = new Map();

        for (const reading of publicReadings) {
            readingMap.set(reading.subtype, reading.value);
        }

        // Mappa i dati al formato semplificato
        const result = {
            co2: null,
            temperature: null,
            humidity: null,
            soil: null,
            water: null,
            energy: null
        };

        for (const [subtype, value] of readingMap.entries()) {
            switch (subtype) {
                case 'clima_temperature':
                    result.temperature = parseFloat(value);
                    break;
                case 'clima_humidity':
                    result.humidity = parseFloat(value);
                    break;
                case 'clima_co2':
                    result.co2 = parseFloat(value);
                    break;
                case 'terreno_moisture':
                    result.soil = parseFloat(value);
                    break;
                case 'acqua_level':
                    result.water = parseFloat(value);
                    break;
                case 'energia_consumption':
                    result.energy = parseFloat(value);
                    break;
            }
        }

        const soilTemperature = parseNumericValue(readingMap.get('terreno_temperature'));
        const soilMoisture = parseNumericValue(readingMap.get('terreno_moisture'));
        if (shouldSwapSoilPair(soilTemperature, soilMoisture)) {
            result.soil = soilTemperature;
        }

        res.json(result);

    } catch (error) {
        console.error('Get simple sensors error:', error);
        res.json({
            co2: null,
            temperature: null,
            humidity: null,
            soil: null,
            water: null,
            energy: null
        });
    }
});

module.exports = router;
