const {
    VALID_SENSOR_TYPES,
    createHttpError,
    getSensorProfile,
    buildReadingsFromFlatPayload
} = require('./sensor-ingest');
const {
    extractRawEnvelope,
    bufferFromEnvelope,
    decodeModbusTelemetryFrame
} = require('./dtu-decoder');

const SENSOR_ALIAS_MAP = {
    acqua: { type: 'acqua', subtype: 'acqua_level', unit: 'm', name: 'Sensore Acqua' },
    co2: { type: 'clima', subtype: 'clima_co2', unit: 'ppm', name: 'Sensore CO2' },
    ec: { type: 'terreno', subtype: 'terreno_ec', unit: 'dS/m', name: 'Sensore EC' },
    energy: { type: 'energia', subtype: 'energia_consumption', unit: 'kW', name: 'Sensore Energia' },
    energia: { type: 'energia', subtype: 'energia_consumption', unit: 'kW', name: 'Sensore Energia' },
    h2o: { type: 'acqua', subtype: 'acqua_level', unit: 'm', name: 'Sensore Acqua' },
    humidity: { type: 'clima', subtype: 'clima_humidity', unit: '%', name: 'Sensore Umidita' },
    humidite: { type: 'clima', subtype: 'clima_humidity', unit: '%', name: 'Sensore Umidita' },
    k: { type: 'terreno', subtype: 'terreno_k', unit: 'ppm', name: 'Sensore Potassio' },
    nitrogen: { type: 'terreno', subtype: 'terreno_n', unit: 'ppm', name: 'Sensore Azoto' },
    n: { type: 'terreno', subtype: 'terreno_n', unit: 'ppm', name: 'Sensore Azoto' },
    p: { type: 'terreno', subtype: 'terreno_p', unit: 'ppm', name: 'Sensore Fosforo' },
    ph: { type: 'terreno', subtype: 'terreno_ph', unit: 'pH', name: 'Sensore pH' },
    p_h: { type: 'terreno', subtype: 'terreno_ph', unit: 'pH', name: 'Sensore pH' },
    phosphorus: { type: 'terreno', subtype: 'terreno_p', unit: 'ppm', name: 'Sensore Fosforo' },
    potassium: { type: 'terreno', subtype: 'terreno_k', unit: 'ppm', name: 'Sensore Potassio' },
    soil: { type: 'terreno', subtype: 'terreno_moisture', unit: '%', name: 'Sensore Terreno' },
    soil_ec: { type: 'terreno', subtype: 'terreno_ec', unit: 'dS/m', name: 'Sensore EC' },
    soil_conductivity: { type: 'terreno', subtype: 'terreno_ec', unit: 'dS/m', name: 'Sensore EC' },
    soil_humidity: { type: 'terreno', subtype: 'terreno_moisture', unit: '%', name: 'Sensore Terreno' },
    soil_moisture: { type: 'terreno', subtype: 'terreno_moisture', unit: '%', name: 'Sensore Terreno' },
    soil_ph: { type: 'terreno', subtype: 'terreno_ph', unit: 'pH', name: 'Sensore pH' },
    soil_temperature: { type: 'terreno', subtype: 'terreno_temperature', unit: '°C', name: 'Sensore Temperatura Terreno' },
    temp_suolo: { type: 'terreno', subtype: 'terreno_temperature', unit: '°C', name: 'Sensore Temperatura Terreno' },
    terreno_nitrogen: { type: 'terreno', subtype: 'terreno_n', unit: 'ppm', name: 'Sensore Azoto' },
    terreno_phosphorus: { type: 'terreno', subtype: 'terreno_p', unit: 'ppm', name: 'Sensore Fosforo' },
    terreno_potassium: { type: 'terreno', subtype: 'terreno_k', unit: 'ppm', name: 'Sensore Potassio' },
    terreno: { type: 'terreno', subtype: 'terreno_moisture', unit: '%', name: 'Sensore Terreno' },
    moisture: { type: 'terreno', subtype: 'terreno_moisture', unit: '%', name: 'Sensore Terreno' },
    temp: { type: 'clima', subtype: 'clima_temperature', unit: '°C', name: 'Sensore Temperatura' },
    temperature: { type: 'clima', subtype: 'clima_temperature', unit: '°C', name: 'Sensore Temperatura' },
    temperatura: { type: 'clima', subtype: 'clima_temperature', unit: '°C', name: 'Sensore Temperatura' },
    water: { type: 'acqua', subtype: 'acqua_level', unit: 'm', name: 'Sensore Acqua' },
    clima_wind: { type: 'clima', subtype: 'clima_wind_speed', unit: 'km/h', name: 'Sensore Vento' },
    wind: { type: 'clima', subtype: 'clima_wind_speed', unit: 'km/h', name: 'Sensore Vento' },
    wind_speed: { type: 'clima', subtype: 'clima_wind_speed', unit: 'km/h', name: 'Sensore Vento' }
};

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTopicSegments(topic) {
    return cleanString(topic).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
}

function normalizeGatewaySignalEvent(value) {
    const normalizedEvent = cleanString(value).toLowerCase();
    if (normalizedEvent === 'boot' || normalizedEvent === 'heartbeat') {
        return normalizedEvent;
    }

    if (['ping', 'pong', 'keepalive', 'keep_alive', 'alive'].includes(normalizedEvent)) {
        return 'heartbeat';
    }

    return '';
}

function normalizeKey(value) {
    return cleanString(value)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9_/-]+/g, '_');
}

function inferTypeFromSubtype(subtype) {
    const normalized = normalizeKey(subtype);
    if (!normalized) {
        return '';
    }

    for (const type of VALID_SENSOR_TYPES) {
        if (normalized === type || normalized.startsWith(`${type}_`)) {
            return type;
        }
    }

    if (SENSOR_ALIAS_MAP[normalized]) {
        return SENSOR_ALIAS_MAP[normalized].type;
    }

    return '';
}

function normalizeSubtypeForType(type, rawSubtype) {
    const normalizedType = cleanString(type);
    const normalizedSubtype = normalizeKey(rawSubtype);

    if (!normalizedSubtype) {
        return getSensorProfile(normalizedType).subtype;
    }

    if (SENSOR_ALIAS_MAP[normalizedSubtype] && SENSOR_ALIAS_MAP[normalizedSubtype].type === normalizedType) {
        return SENSOR_ALIAS_MAP[normalizedSubtype].subtype;
    }

    if (normalizedSubtype === normalizedType || normalizedSubtype.startsWith(`${normalizedType}_`)) {
        return normalizedSubtype;
    }

    return `${normalizedType}_${normalizedSubtype}`;
}

function parseSensorTopic(topic) {
    const rawTopic = cleanString(topic).replace(/^\/+|\/+$/g, '');
    if (!rawTopic) {
        return {};
    }

    const stripped = rawTopic.startsWith('sensors/') ? rawTopic.slice('sensors/'.length) : rawTopic;
    const segments = stripped.split('/').filter(Boolean);

    if (!segments.length) {
        return {};
    }

    let deviceId = '';
    let readingParts = segments;
    const firstSegmentKey = normalizeKey(segments[0]);

    if (
        segments.length > 1 &&
        !VALID_SENSOR_TYPES.has(firstSegmentKey) &&
        !SENSOR_ALIAS_MAP[firstSegmentKey] &&
        !inferTypeFromSubtype(firstSegmentKey)
    ) {
        deviceId = segments[0];
        readingParts = segments.slice(1);
    }

    const joined = normalizeKey(readingParts.join('_'));
    const firstReading = normalizeKey(readingParts[0]);
    const type = VALID_SENSOR_TYPES.has(firstReading)
        ? firstReading
        : inferTypeFromSubtype(joined || firstReading);

    if (!type) {
        return { deviceId, topic: rawTopic };
    }

    let alias = SENSOR_ALIAS_MAP[firstReading] || SENSOR_ALIAS_MAP[joined] || null;
    if (!alias && readingParts.length > 1) {
        alias = SENSOR_ALIAS_MAP[normalizeKey(readingParts[1])] || null;
    }

    const profile = alias || getSensorProfile(type);
    let subtype;

    if (VALID_SENSOR_TYPES.has(firstReading)) {
        subtype = normalizeSubtypeForType(type, readingParts.slice(1).join('_'));
    } else if (alias) {
        subtype = alias.subtype;
    } else if (joined) {
        subtype = normalizeSubtypeForType(type, joined);
    } else {
        subtype = profile.subtype;
    }

    return {
        deviceId,
        topic: rawTopic,
        type,
        subtype,
        unit: profile.unit,
        name: profile.name
    };
}

function resolveGatewaySignalDeviceId(topic, source = {}) {
    const segments = parseTopicSegments(topic);
    const strippedSegments = segments[0] === 'sensors' ? segments.slice(1) : segments;

    if (strippedSegments.length >= 2) {
        return cleanString(strippedSegments[0]);
    }

    return cleanString(
        source.device_id
        || source.deviceId
        || source.routerId
        || source.router_id
        || source.clientId
        || source.client_id
    );
}

function parseGatewaySignalUpdate(body = {}) {
    const source = isPlainObject(body) ? body : {};
    const payloadObject = isPlainObject(source.payload)
        ? source.payload
        : isPlainObject(source.value)
            ? source.value
            : null;
    const topic = cleanString(source.sensor_id || source.topic);
    const topicSegments = parseTopicSegments(topic);
    const topicEvent = normalizeGatewaySignalEvent(topicSegments[topicSegments.length - 1]);
    const event = normalizeGatewaySignalEvent(
        source.event
        || source.gateway_event
        || source.signal
        || source.eventType
        || source.event_type
        || source.value
        || payloadObject?.event
        || payloadObject?.gateway_event
        || payloadObject?.signal
        || payloadObject?.eventType
        || payloadObject?.event_type
        || payloadObject?.value
        || topicEvent
    );

    if (!event) {
        return null;
    }

    const deviceId = cleanString(
        source.device_id
        || source.deviceId
        || payloadObject?.device_id
        || payloadObject?.deviceId
        || resolveGatewaySignalDeviceId(topic, payloadObject || source)
    );

    if (!deviceId) {
        return null;
    }

    return {
        deviceId,
        event,
        topic,
        receivedAt: new Date().toISOString(),
        sentAt: cleanString(
            source.sentAt
            || source.sent_at
            || payloadObject?.sentAt
            || payloadObject?.sent_at
            || source.timestamp
            || payloadObject?.timestamp
        ),
        bootId: cleanString(source.bootId || source.boot_id || payloadObject?.bootId || payloadObject?.boot_id),
        fwVersion: cleanString(source.fwVersion || source.fw_version || payloadObject?.fwVersion || payloadObject?.fw_version),
        rssi: source.rssi ?? payloadObject?.rssi ?? null,
        clientId: cleanString(source.clientId || source.client_id || payloadObject?.clientId || payloadObject?.client_id),
        routerId: cleanString(source.routerId || source.router_id || payloadObject?.routerId || payloadObject?.router_id)
    };
}

function extractValue(value) {
    if (!isPlainObject(value)) {
        return value;
    }

    if (value.value !== undefined) {
        return value.value;
    }

    if (value.reading !== undefined) {
        return value.reading;
    }

    if (value.data !== undefined) {
        return value.data;
    }

    const entries = Object.entries(value);
    if (entries.length === 1) {
        return entries[0][1];
    }

    return value;
}

function buildReading(rawReading, defaults = {}) {
    const type = cleanString(rawReading.type || defaults.type || inferTypeFromSubtype(rawReading.subtype || defaults.subtype));
    if (!type) {
        throw createHttpError(400, 'Impossibile determinare il tipo del sensore');
    }

    const profile = getSensorProfile(type);
    const subtype = cleanString(rawReading.subtype || defaults.subtype)
        ? normalizeSubtypeForType(type, rawReading.subtype || defaults.subtype)
        : profile.subtype;
    const value = extractValue(
        rawReading.value !== undefined
            ? rawReading.value
            : rawReading.payload !== undefined
                ? rawReading.payload
                : rawReading
    );

    const metadata = {};
    if (defaults.topic) {
        metadata.topic = defaults.topic;
    }
    if (isPlainObject(rawReading.metadata)) {
        metadata.metadata = rawReading.metadata;
    }

    return {
        type,
        subtype,
        name: cleanString(rawReading.name || defaults.name) || profile.name,
        unit: cleanString(rawReading.unit || defaults.unit) || profile.unit,
        value,
        metadata: Object.keys(metadata).length ? metadata : null
    };
}

function parseSensorUpdate(body = {}) {
    const topic = cleanString(body.sensor_id || body.topic);
    const topicInfo = parseSensorTopic(topic);
    const payloadObject = isPlainObject(body.value)
        ? body.value
        : isPlainObject(body.payload)
            ? body.payload
            : null;
    const rawReadings = Array.isArray(body.readings)
        ? body.readings
        : Array.isArray(payloadObject?.readings)
            ? payloadObject.readings
            : null;
    const deviceId = cleanString(body.device_id || payloadObject?.device_id || topicInfo.deviceId);
    const apiKey = cleanString(body.api_key || payloadObject?.api_key);
    const timestamp = cleanString(body.timestamp || payloadObject?.timestamp);
    const readingDefaults = {
        topic,
        type: cleanString(body.type || payloadObject?.type || topicInfo.type),
        subtype: cleanString(body.subtype || payloadObject?.subtype || topicInfo.subtype),
        unit: cleanString(body.unit || payloadObject?.unit || topicInfo.unit),
        name: cleanString(body.name || payloadObject?.name || topicInfo.name)
    };

    let readings;
    const rawEnvelope = extractRawEnvelope(body) || extractRawEnvelope(payloadObject);
    let decodedRawReadings = [];

    if (rawEnvelope) {
        try {
            decodedRawReadings = decodeModbusTelemetryFrame(bufferFromEnvelope(rawEnvelope)).readings.map((reading) => buildReading(reading, {
                ...readingDefaults,
                type: reading.type,
                subtype: reading.subtype
            }));
        } catch (error) {
            throw createHttpError(400, `Payload DTU non decodificabile: ${error.message}`);
        }
    }

    const flatReadings = buildReadingsFromFlatPayload(payloadObject || body)
        .map((reading) => buildReading(reading, {
            ...readingDefaults,
            type: reading.type,
            subtype: reading.subtype
        }));

    if (rawReadings) {
        readings = rawReadings.map((reading) => buildReading(reading, readingDefaults));
    } else if (decodedRawReadings.length) {
        readings = decodedRawReadings;
    } else if (flatReadings.length) {
        readings = flatReadings;
    } else {
        const rawValue = body.value !== undefined
            ? body.value
            : body.payload !== undefined
                ? body.payload
                : payloadObject?.value !== undefined
                    ? payloadObject.value
                    : payloadObject?.reading !== undefined
                        ? payloadObject.reading
                        : payloadObject?.data;

        if (rawValue === undefined) {
            throw createHttpError(400, 'Valore sensore mancante');
        }

        readings = [
            buildReading(
                {
                    type: body.type,
                    subtype: body.subtype,
                    unit: body.unit,
                    name: body.name,
                    value: rawValue
                },
                readingDefaults
            )
        ];
    }

    return {
        deviceId,
        apiKey,
        timestamp,
        readings
    };
}

module.exports = {
    cleanString,
    parseGatewaySignalUpdate,
    parseSensorUpdate
};
