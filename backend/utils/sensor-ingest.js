const crypto = require('crypto');

const { withTransaction } = require('../config/database');
const { checkAlerts } = require('./alerts');
const { notifyMissingDataHeartbeat } = require('../src/jobs/alertJob');
const {
    extractRawEnvelope,
    bufferFromEnvelope,
    decodeModbusTelemetryFrame
} = require('./dtu-decoder');

const VALID_SENSOR_TYPES = new Set(['energia', 'acqua', 'terreno', 'clima']);
const DEFAULT_SENSOR_PROFILES = {
    energia: { subtype: 'energia_consumption', name: 'Sensore Energia', unit: 'kW' },
    acqua: { subtype: 'acqua_level', name: 'Sensore Acqua', unit: 'm' },
    terreno: { subtype: 'terreno_moisture', name: 'Sensore Terreno', unit: '%' },
    clima: { subtype: 'clima_temperature', name: 'Sensore Clima', unit: '°C' }
};

const CANONICAL_SENSOR_PROFILES = {
    energia_consumption: { type: 'energia', subtype: 'energia_consumption', name: 'Sensore Energia', unit: 'kW' },
    acqua_level: { type: 'acqua', subtype: 'acqua_level', name: 'Sensore Acqua', unit: 'm' },
    terreno_moisture: { type: 'terreno', subtype: 'terreno_moisture', name: 'Sensore Umidita Terreno', unit: '%' },
    terreno_temperature: { type: 'terreno', subtype: 'terreno_temperature', name: 'Sensore Temperatura Terreno', unit: '°C' },
    terreno_ec: { type: 'terreno', subtype: 'terreno_ec', name: 'Sensore EC Terreno', unit: 'dS/m' },
    terreno_ph: { type: 'terreno', subtype: 'terreno_ph', name: 'Sensore pH Terreno', unit: 'pH' },
    terreno_n: { type: 'terreno', subtype: 'terreno_n', name: 'Sensore Azoto', unit: 'ppm' },
    terreno_p: { type: 'terreno', subtype: 'terreno_p', name: 'Sensore Fosforo', unit: 'ppm' },
    terreno_k: { type: 'terreno', subtype: 'terreno_k', name: 'Sensore Potassio', unit: 'ppm' },
    clima_temperature: { type: 'clima', subtype: 'clima_temperature', name: 'Sensore Temperatura', unit: '°C' },
    clima_humidity: { type: 'clima', subtype: 'clima_humidity', name: 'Sensore Umidita', unit: '%' },
    clima_co2: { type: 'clima', subtype: 'clima_co2', name: 'Sensore CO2', unit: 'ppm' },
    clima_wind_speed: { type: 'clima', subtype: 'clima_wind_speed', name: 'Sensore Vento', unit: 'km/h' }
};

const TYPE_ALIAS_TO_SUBTYPE = {
    energia: {
        energia_consumption: 'energia_consumption',
        consumption: 'energia_consumption',
        voltage: 'energia_consumption',
        battery: 'energia_consumption'
    },
    acqua: {
        acqua_level: 'acqua_level',
        level: 'acqua_level',
        availability: 'acqua_level',
        water_level: 'acqua_level'
    },
    terreno: {
        terreno_moisture: 'terreno_moisture',
        moisture: 'terreno_moisture',
        humidity: 'terreno_moisture',
        soil_humidity: 'terreno_moisture',
        soil_moisture: 'terreno_moisture',
        terreno_temperature: 'terreno_temperature',
        temperature: 'terreno_temperature',
        soil_temperature: 'terreno_temperature',
        terreno_ec: 'terreno_ec',
        ec: 'terreno_ec',
        conductivity: 'terreno_ec',
        soil_conductivity: 'terreno_ec',
        terreno_ph: 'terreno_ph',
        ph: 'terreno_ph',
        p_h: 'terreno_ph',
        terreno_n: 'terreno_n',
        nitrogen: 'terreno_n',
        n: 'terreno_n',
        terreno_nitrogen: 'terreno_n',
        terreno_p: 'terreno_p',
        phosphorus: 'terreno_p',
        p: 'terreno_p',
        terreno_phosphorus: 'terreno_p',
        terreno_k: 'terreno_k',
        potassium: 'terreno_k',
        k: 'terreno_k',
        terreno_potassium: 'terreno_k'
    },
    clima: {
        clima_temperature: 'clima_temperature',
        temperature: 'clima_temperature',
        clima_humidity: 'clima_humidity',
        humidity: 'clima_humidity',
        clima_co2: 'clima_co2',
        co2: 'clima_co2',
        clima_wind: 'clima_wind_speed',
        clima_wind_speed: 'clima_wind_speed',
        wind: 'clima_wind_speed',
        wind_speed: 'clima_wind_speed'
    }
};

const GLOBAL_ALIAS_TO_SUBTYPE = {
    energia_consumption: 'energia_consumption',
    acqua_level: 'acqua_level',
    temperature: 'clima_temperature',
    humidity: 'clima_humidity',
    co2: 'clima_co2',
    soil_temperature: 'terreno_temperature',
    soil_humidity: 'terreno_moisture',
    soil_moisture: 'terreno_moisture',
    soil_conductivity: 'terreno_ec',
    conductivity: 'terreno_ec',
    ec: 'terreno_ec',
    ph: 'terreno_ph',
    p_h: 'terreno_ph',
    nitrogen: 'terreno_n',
    phosphorus: 'terreno_p',
    potassium: 'terreno_k',
    terreno_temperature: 'terreno_temperature',
    terreno_moisture: 'terreno_moisture',
    terreno_ec: 'terreno_ec',
    terreno_ph: 'terreno_ph',
    terreno_n: 'terreno_n',
    terreno_p: 'terreno_p',
    terreno_k: 'terreno_k',
    terreno_nitrogen: 'terreno_n',
    terreno_phosphorus: 'terreno_p',
    terreno_potassium: 'terreno_k',
    clima_temperature: 'clima_temperature',
    clima_humidity: 'clima_humidity',
    clima_co2: 'clima_co2',
    clima_wind: 'clima_wind_speed',
    clima_wind_speed: 'clima_wind_speed',
    wind: 'clima_wind_speed',
    wind_speed: 'clima_wind_speed'
};

const CONTROL_PAYLOAD_KEYS = new Set([
    'sensor_id',
    'topic',
    'device_id',
    'api_key',
    'timestamp',
    'payload',
    'readings',
    'value',
    'type',
    'subtype',
    'unit',
    'name',
    'metadata'
]);

const IGNORED_PAYLOAD_KEYS = new Set(['height']);

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

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKey(value) {
    return cleanString(value)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

function getCanonicalSubtype(rawSubtype, explicitType = '') {
    const normalizedType = normalizeKey(explicitType);
    const normalizedSubtype = normalizeKey(rawSubtype);

    if (!normalizedSubtype || IGNORED_PAYLOAD_KEYS.has(normalizedSubtype)) {
        return '';
    }

    const typeAlias = TYPE_ALIAS_TO_SUBTYPE[normalizedType]?.[normalizedSubtype];
    const globalAlias = GLOBAL_ALIAS_TO_SUBTYPE[normalizedSubtype];
    return typeAlias || globalAlias || normalizedSubtype;
}

function inferTypeFromSubtype(subtype) {
    const canonicalSubtype = getCanonicalSubtype(subtype);
    if (!canonicalSubtype) {
        return '';
    }

    for (const type of VALID_SENSOR_TYPES) {
        if (canonicalSubtype === type || canonicalSubtype.startsWith(`${type}_`)) {
            return type;
        }
    }

    const profile = CANONICAL_SENSOR_PROFILES[canonicalSubtype];
    return profile ? profile.type : '';
}

function getSensorProfile(type) {
    return DEFAULT_SENSOR_PROFILES[type] || DEFAULT_SENSOR_PROFILES.clima;
}

function getCanonicalProfile(rawSubtype, explicitType = '') {
    const canonicalSubtype = getCanonicalSubtype(rawSubtype, explicitType);
    if (!canonicalSubtype) {
        return null;
    }

    return CANONICAL_SENSOR_PROFILES[canonicalSubtype] || null;
}

function normalizeReading(reading) {
    if (!isPlainObject(reading)) {
        return null;
    }

    const explicitType = normalizeKey(reading.type);
    const profile = getCanonicalProfile(reading.subtype || reading.key || reading.metric, explicitType)
        || (VALID_SENSOR_TYPES.has(explicitType) ? {
            type: explicitType,
            subtype: getSensorProfile(explicitType).subtype,
            name: getSensorProfile(explicitType).name,
            unit: getSensorProfile(explicitType).unit
        } : null);

    const resolvedType = profile?.type || explicitType;
    if (!VALID_SENSOR_TYPES.has(resolvedType)) {
        return null;
    }

    const value = Number(reading.value);
    if (!Number.isFinite(value)) {
        return null;
    }

    const defaultProfile = getSensorProfile(resolvedType);
    return {
        type: resolvedType,
        subtype: profile?.subtype || defaultProfile.subtype,
        unit: reading.unit ? cleanString(reading.unit) : (profile?.unit || defaultProfile.unit),
        name: reading.name ? cleanString(reading.name) : (profile?.name || defaultProfile.name),
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

function buildReadingsFromFlatPayload(payload) {
    if (!isPlainObject(payload)) {
        return [];
    }

    return Object.entries(payload)
        .filter(([key, value]) => {
            const normalizedKey = normalizeKey(key);

            if (!normalizedKey || CONTROL_PAYLOAD_KEYS.has(normalizedKey) || IGNORED_PAYLOAD_KEYS.has(normalizedKey)) {
                return false;
            }

            if (isPlainObject(value) || Array.isArray(value)) {
                return false;
            }

            return true;
        })
        .map(([key, value]) => normalizeReading({ subtype: key, value }))
        .filter(Boolean);
}

function prepareIncomingSensorPayload(body = {}) {
    const source = isPlainObject(body) ? body : {};
    const payloadObject = isPlainObject(source.payload)
        ? source.payload
        : isPlainObject(source.value)
            ? source.value
            : null;
    const rawReadings = Array.isArray(source.readings)
        ? source.readings
        : Array.isArray(payloadObject?.readings)
            ? payloadObject.readings
            : null;
    const deviceId = cleanString(source.device_id || payloadObject?.device_id);
    const apiKey = cleanString(source.api_key || payloadObject?.api_key);
    const timestamp = cleanString(source.timestamp || payloadObject?.timestamp);

    let readings = [];

    if (rawReadings) {
        readings = normalizeReadings(rawReadings);
    } else {
        const rawEnvelope = extractRawEnvelope(source) || extractRawEnvelope(payloadObject);

        if (rawEnvelope) {
            try {
                const decoded = decodeModbusTelemetryFrame(bufferFromEnvelope(rawEnvelope));
                readings = normalizeReadings(decoded.readings);
            } catch (error) {
                throw createHttpError(400, `Payload DTU non decodificabile: ${error.message}`);
            }
        }

        const flatSource = payloadObject || source;
        if (!readings.length) {
            readings = buildReadingsFromFlatPayload(flatSource);
        }

        if (!readings.length && source.value !== undefined && !isPlainObject(source.value)) {
            const fallback = normalizeReading({
                type: source.type,
                subtype: source.subtype,
                value: source.value,
                unit: source.unit,
                name: source.name
            });

            if (fallback) {
                readings = [fallback];
            }
        }

        if (!readings.length) {
            throw createHttpError(400, 'Nessuna lettura valida trovata nella richiesta');
        }
    }

    return {
        deviceId,
        apiKey,
        timestamp,
        readings
    };
}

async function persistPublicSensorLatest(execute, normalizedReadings, readingTimestamp) {
    for (const reading of normalizedReadings) {
        const topic = reading.metadata && typeof reading.metadata === 'object'
            ? reading.metadata.topic || null
            : null;
        const metadata = reading.metadata ? JSON.stringify(reading.metadata) : null;

        await execute(
            `INSERT INTO public_sensor_readings (sensor_type, sensor_subtype, value, topic, timestamp, metadata)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [reading.type, reading.subtype, reading.value, topic, readingTimestamp, metadata]
        );

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
    // RAYAT-FIX: allow the real gateway MQTT clientId stored in metadata to resolve
    // the same physical device without changing the live topic-based device_id.
    const devices = await execute(
        `SELECT id, user_id, device_id
         FROM devices
         WHERE device_id = ?
            OR COALESCE(metadata->>'clientId', '') = ?
         ORDER BY CASE WHEN device_id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
        [deviceId, deviceId, deviceId]
    );

    if (!devices.length) {
        throw createHttpError(404, 'Dispositivo non trovato');
    }

    return {
        id: devices[0].id,
        user_id: devices[0].user_id,
        device_id: devices[0].device_id
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

    notifyMissingDataHeartbeat(readingTimestamp);
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

    notifyMissingDataHeartbeat(readingTimestamp);
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

    notifyMissingDataHeartbeat(readingTimestamp);

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
    normalizeReadings,
    normalizeKey,
    buildReadingsFromFlatPayload,
    prepareIncomingSensorPayload,
    ingestDeviceReadings,
    ingestTrustedReadings,
    ingestPublicReadings
};
