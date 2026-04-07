const crypto = require('crypto');

const { withTransaction } = require('../config/database');
const { checkAlerts } = require('./alerts');

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

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
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

function normalizeTimestamp(timestamp) {
    const readingTimestamp = timestamp ? new Date(timestamp) : new Date();
    if (Number.isNaN(readingTimestamp.getTime())) {
        throw createHttpError(400, 'Timestamp non valido');
    }
    return readingTimestamp;
}

function normalizeReadings(readings) {
    if (!Array.isArray(readings)) {
        throw createHttpError(400, 'Le letture devono essere un array');
    }

    if (!readings.length) {
        throw createHttpError(400, 'Almeno una lettura è obbligatoria');
    }

    if (readings.length > 100) {
        throw createHttpError(400, 'Massimo 100 letture per richiesta');
    }

    const normalizedReadings = readings
        .map(normalizeReading)
        .filter(Boolean);

    if (!normalizedReadings.length) {
        throw createHttpError(400, 'Nessuna lettura valida trovata nella richiesta');
    }

    return normalizedReadings;
}

async function persistPublicSensorLatest(execute, normalizedReadings, readingTimestamp) {
    for (const reading of normalizedReadings) {
        const topic = reading.metadata && typeof reading.metadata === 'object'
            ? reading.metadata.topic || null
            : null;

        await execute(
            `INSERT INTO public_sensor_latest (sensor_type, sensor_subtype, value, topic, timestamp)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (sensor_subtype) DO UPDATE
             SET sensor_type = EXCLUDED.sensor_type,
                 value = EXCLUDED.value,
                 topic = EXCLUDED.topic,
                 timestamp = EXCLUDED.timestamp,
                 updated_at = CURRENT_TIMESTAMP`,
            [reading.type, reading.subtype, reading.value, topic, readingTimestamp]
        );
    }
}

async function persistReadingsForDevice(execute, device, normalizedReadings, readingTimestamp) {
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

    await persistPublicSensorLatest(execute, normalizedReadings, readingTimestamp);

    return {
        deviceId: device.device_id,
        userId: device.user_id,
        insertedReadings
    };
}

async function triggerAlerts(result) {
    if (!result.userId) {
        return;
    }

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
}

async function findDeviceByCredentials(execute, deviceId, apiKey) {
    const devices = await execute(
        `SELECT id, user_id
         FROM devices
         WHERE device_id = ?
           AND api_key = ?`,
        [deviceId, apiKey]
    );

    if (!devices.length) {
        throw createHttpError(401, 'Device non autorizzato');
    }

    return {
        id: devices[0].id,
        user_id: devices[0].user_id,
        device_id: deviceId
    };
}

async function findDeviceById(execute, deviceId) {
    const devices = await execute(
        `SELECT id, user_id
         FROM devices
         WHERE device_id = ?`,
        [deviceId]
    );

    if (!devices.length) {
        throw createHttpError(404, 'Dispositivo non trovato');
    }

    return {
        id: devices[0].id,
        user_id: devices[0].user_id,
        device_id: deviceId
    };
}

async function ensureBridgeGatewayDevice(execute) {
    const configuredDeviceId = cleanString(process.env.MQTT_BRIDGE_DEVICE_ID) || 'MQTT_BRIDGE_GATEWAY';
    const existing = await execute(
        `SELECT id, user_id
         FROM devices
         WHERE device_id = ?`,
        [configuredDeviceId]
    );

    if (existing.length) {
        return {
            id: existing[0].id,
            user_id: existing[0].user_id,
            device_id: configuredDeviceId
        };
    }

    const configuredUserId = Number.parseInt(process.env.MQTT_BRIDGE_DEFAULT_USER_ID || '', 10);
    let targetUserId = Number.isFinite(configuredUserId) ? configuredUserId : null;

    if (!targetUserId) {
        const users = await execute(
            `SELECT id
             FROM users
             WHERE role IN ('client', 'farmer')
               AND active = TRUE
             ORDER BY id ASC
             LIMIT 2`,
            []
        );

        if (!users.length) {
            throw createHttpError(400, 'Nessun cliente attivo trovato per creare il gateway MQTT');
        }

        if (users.length > 1) {
            throw createHttpError(
                400,
                'Più clienti attivi trovati. Configura MQTT_BRIDGE_DEFAULT_USER_ID oppure invia device_id/api_key.'
            );
        }

        targetUserId = users[0].id;
    }

    const apiKey = cleanString(process.env.MQTT_BRIDGE_DEVICE_API_KEY) || crypto.randomBytes(24).toString('hex');
    const metadata = JSON.stringify({
        created_from: 'mqtt_bridge',
        auto_created: true
    });

    const result = await execute(
        `INSERT INTO devices (device_id, user_id, name, api_key, status, metadata)
         VALUES (?, ?, ?, ?, 'active', ?)`,
        [configuredDeviceId, targetUserId, 'MQTT Bridge Gateway', apiKey, metadata]
    );

    return {
        id: result.insertId,
        user_id: targetUserId,
        device_id: configuredDeviceId
    };
}

async function ingestDeviceReadings({ deviceId, apiKey, timestamp, readings }) {
    const cleanDeviceId = cleanString(deviceId);
    const cleanApiKey = cleanString(apiKey);

    if (!cleanDeviceId || !cleanApiKey) {
        throw createHttpError(400, 'device_id e api_key sono obbligatori');
    }

    const normalizedReadings = normalizeReadings(readings);
    const readingTimestamp = normalizeTimestamp(timestamp);

    const result = await withTransaction(async (connection) => {
        const execute = createExecutor(connection);
        const device = await findDeviceByCredentials(execute, cleanDeviceId, cleanApiKey);
        return persistReadingsForDevice(execute, device, normalizedReadings, readingTimestamp);
    });

    await triggerAlerts(result);
    return result;
}

async function ingestTrustedReadings({ deviceId, timestamp, readings }) {
    const normalizedReadings = normalizeReadings(readings);
    const readingTimestamp = normalizeTimestamp(timestamp);
    const explicitDeviceId = cleanString(deviceId);
    const defaultDeviceId = cleanString(process.env.MQTT_DEFAULT_DEVICE_ID);

    const result = await withTransaction(async (connection) => {
        const execute = createExecutor(connection);
        let device;

        if (explicitDeviceId) {
            device = await findDeviceById(execute, explicitDeviceId);
        } else if (defaultDeviceId) {
            device = await findDeviceById(execute, defaultDeviceId);
        } else {
            device = await ensureBridgeGatewayDevice(execute);
        }

        return persistReadingsForDevice(execute, device, normalizedReadings, readingTimestamp);
    });

    await triggerAlerts(result);
    return result;
}

async function ingestPublicReadings({ timestamp, readings }) {
    const normalizedReadings = normalizeReadings(readings);
    const readingTimestamp = normalizeTimestamp(timestamp);

    await withTransaction(async (connection) => {
        const execute = createExecutor(connection);
        await persistPublicSensorLatest(execute, normalizedReadings, readingTimestamp);
    });

    return {
        mode: 'public_only',
        insertedReadings: normalizedReadings.map((reading) => ({
            sensor_id: null,
            type: reading.type,
            subtype: reading.subtype,
            value: reading.value,
            timestamp: readingTimestamp
        }))
    };
}

module.exports = {
    VALID_SENSOR_TYPES,
    DEFAULT_SENSOR_PROFILES,
    createHttpError,
    getSensorProfile,
    normalizeReading,
    ingestDeviceReadings,
    ingestTrustedReadings,
    ingestPublicReadings
};
