const express = require('express');

const { query, withTransaction } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { checkAlerts } = require('../utils/alerts');

const router = express.Router();

const VALID_SENSOR_TYPES = new Set(['energia', 'acqua', 'terreno', 'clima']);
const DEFAULT_SENSOR_PROFILES = {
    energia: { subtype: 'energia_consumption', name: 'Sensore Energia', unit: 'kW' },
    acqua: { subtype: 'acqua_level', name: 'Sensore Acqua', unit: 'm' },
    terreno: { subtype: 'terreno_moisture', name: 'Sensore Terreno', unit: '%' },
    clima: { subtype: 'clima_temperature', name: 'Sensore Clima', unit: '°C' }
};

function createHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function createExecutor(connection) {
    return async (sql, params) => {
        const [result] = await connection.execute(sql, params);
        return result;
    };
}

function getSensorProfile(type) {
    return DEFAULT_SENSOR_PROFILES[type] || DEFAULT_SENSOR_PROFILES.clima;
}

function normalizeReading(reading) {
    const type = String(reading.type || '').trim();
    if (!VALID_SENSOR_TYPES.has(type)) {
        return null;
    }

    const value = Number(reading.value);
    if (!Number.isFinite(value)) {
        return null;
    }

    const profile = getSensorProfile(type);
    const subtype = reading.subtype ? String(reading.subtype).trim() : profile.subtype;
    const unit = reading.unit ? String(reading.unit).trim() : profile.unit;
    const name = reading.name ? String(reading.name).trim() : profile.name;

    return {
        type,
        subtype,
        unit,
        name,
        value,
        metadata: reading.metadata ?? null
    };
}

// POST /api/iot/upload - Endpoint per dispositivi IoT (HTTP POST)
router.post('/upload', async (req, res) => {
    try {
        const { device_id, api_key, timestamp, readings } = req.body;

        if (!device_id || !api_key || !Array.isArray(readings)) {
            return res.status(400).json({
                error: 'Dati mancanti o non validi',
                required: ['device_id', 'api_key', 'readings']
            });
        }

        if (!readings.length) {
            return res.status(400).json({ error: 'Almeno una lettura è obbligatoria' });
        }
        if (readings.length > 100) {
            return res.status(400).json({ error: 'Massimo 100 letture per richiesta' });
        }

        const readingTimestamp = timestamp ? new Date(timestamp) : new Date();
        if (Number.isNaN(readingTimestamp.getTime())) {
            return res.status(400).json({ error: 'Timestamp non valido' });
        }

        const normalizedReadings = readings
            .map(normalizeReading)
            .filter(Boolean);

        if (!normalizedReadings.length) {
            return res.status(400).json({ error: 'Nessuna lettura valida trovata nella richiesta' });
        }

        const result = await withTransaction(async (connection) => {
            const execute = createExecutor(connection);
            const devices = await execute(
                `SELECT id, user_id
                 FROM devices
                 WHERE device_id = ?
                   AND api_key = ?`,
                [device_id, api_key]
            );

            if (!devices.length) {
                throw createHttpError(401, 'Device non autorizzato');
            }

            const device = devices[0];

            await execute(
                `UPDATE devices
                 SET last_seen = NOW(),
                     status = 'active',
                     updated_at = NOW()
                 WHERE id = ?`,
                [device.id]
            );

            const existingSensors = await execute(
                `SELECT id, type, subtype
                 FROM sensors
                 WHERE device_id = ?`,
                [device.id]
            );
            const sensorMap = new Map(
                existingSensors.map((sensor) => [
                    `${sensor.type}::${sensor.subtype || ''}`,
                    sensor.id
                ])
            );

            const insertedReadings = [];

            for (const reading of normalizedReadings) {
                const sensorKey = `${reading.type}::${reading.subtype || ''}`;
                let sensorId = sensorMap.get(sensorKey);

                if (!sensorId) {
                    const sensorResult = await execute(
                        `INSERT INTO sensors (device_id, type, subtype, name, unit, enabled)
                         VALUES (?, ?, ?, ?, ?, TRUE)`,
                        [device.id, reading.type, reading.subtype || null, reading.name, reading.unit]
                    );
                    sensorId = sensorResult.insertId;
                    sensorMap.set(sensorKey, sensorId);
                }

                await execute(
                    `INSERT INTO sensor_readings (sensor_id, value, timestamp, metadata)
                     VALUES (?, ?, ?, ?)`,
                    [
                        sensorId,
                        reading.value,
                        readingTimestamp,
                        reading.metadata ? JSON.stringify(reading.metadata) : null
                    ]
                );

                await execute(
                    `INSERT INTO sensor_latest (sensor_id, value, timestamp)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        value = VALUES(value),
                        timestamp = VALUES(timestamp)`,
                    [sensorId, reading.value, readingTimestamp]
                );

                insertedReadings.push({
                    sensor_id: sensorId,
                    type: reading.type,
                    subtype: reading.subtype,
                    value: reading.value,
                    timestamp: readingTimestamp,
                    user_id: device.user_id
                });
            }

            return {
                deviceId: device.id,
                userId: device.user_id,
                insertedReadings
            };
        });

        await Promise.allSettled(
            result.insertedReadings.map((reading) =>
                checkAlerts(
                    result.userId,
                    reading.sensor_id,
                    reading.value,
                    reading.type,
                    reading.subtype
                )
            )
        );

        res.json({
            success: true,
            message: 'Dati ricevuti con successo',
            device_id,
            readings_count: result.insertedReadings.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('IoT upload error:', error);
        res.status(500).json({ error: 'Errore nel salvataggio dati' });
    }
});

// GET /api/iot/devices - Lista dispositivi dell'utente autenticato
router.get('/devices', authenticateToken, async (req, res) => {
    try {
        const devices = await query(
            `SELECT
                d.id,
                d.device_id,
                d.name,
                d.status,
                d.last_seen,
                d.created_at,
                COALESCE(sm.sensor_count, 0) AS sensor_count,
                sm.sensor_types,
                sm.last_reading
             FROM devices d
             LEFT JOIN (
                SELECT
                    s.device_id,
                    COUNT(*) AS sensor_count,
                    GROUP_CONCAT(DISTINCT s.type ORDER BY s.type SEPARATOR ',') AS sensor_types,
                    MAX(sl.timestamp) AS last_reading
                FROM sensors s
                LEFT JOIN sensor_latest sl ON sl.sensor_id = s.id
                WHERE s.enabled = TRUE
                GROUP BY s.device_id
             ) sm ON sm.device_id = d.id
             WHERE d.user_id = ?
             ORDER BY d.created_at DESC, d.id DESC`,
            [req.user.id]
        );

        res.json({
            success: true,
            data: devices
        });
    } catch (error) {
        console.error('Get devices error:', error);
        res.status(500).json({ error: 'Errore nel recupero dispositivi' });
    }
});

module.exports = router;
