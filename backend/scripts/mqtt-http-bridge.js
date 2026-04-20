#!/usr/bin/env node

const mqtt = require('mqtt');
const { TextDecoder } = require('util');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const SNAPSHOT_WINDOW_MS = Math.max(10000, Number(process.env.MQTT_BRIDGE_SNAPSHOT_WINDOW_MS || 90000)); // RAYAT-FIX
const TELEMETRY_FRAME_LAYOUTS = new Map([ // RAYAT-FIX
    [1, [ // RAYAT-FIX
        { key: 'temperature', scale: 0.1, signed: true }, // RAYAT-FIX
        { key: 'humidity', scale: 0.1 } // RAYAT-FIX
    ]], // RAYAT-FIX
    [2, [ // RAYAT-FIX
        { key: 'co2', scale: 1 } // RAYAT-FIX
    ]], // RAYAT-FIX
    [3, [ // RAYAT-FIX
        { key: 'soilTemperature', scale: 0.1, signed: true }, // RAYAT-FIX
        { key: 'soilHumidity', scale: 0.1 }, // RAYAT-FIX
        { key: 'soilConductivity', scale: 0.001 }, // RAYAT-FIX
        { key: 'nitrogen', scale: 1 }, // RAYAT-FIX
        { key: 'phosphorus', scale: 1 }, // RAYAT-FIX
        { key: 'potassium', scale: 1 }, // RAYAT-FIX
        { key: 'pH', scale: 0.01 } // RAYAT-FIX
    ]] // RAYAT-FIX
]); // RAYAT-FIX
const TELEMETRY_REQUIRED_SLAVES = new Set(TELEMETRY_FRAME_LAYOUTS.keys()); // RAYAT-FIX
const telemetrySnapshots = new Map(); // RAYAT-FIX

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function containsBinaryControlCharacters(value) {
    return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value);
}

function parsePayload(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        return { value: null, raw: '' };
    }

    let raw = '';

    try {
        raw = utf8Decoder.decode(buffer).trim();
    } catch (_error) {
        return {
            value: null,
            raw: '',
            rawHex: buffer.toString('hex'),
            rawBase64: buffer.toString('base64'),
            isBinary: true
        };
    }

    if (!raw) {
        return { value: null, raw: '' };
    }

    if (containsBinaryControlCharacters(raw)) {
        return {
            value: null,
            raw: '',
            rawHex: buffer.toString('hex'),
            rawBase64: buffer.toString('base64'),
            isBinary: true
        };
    }

    try {
        return { value: JSON.parse(raw), raw };
    } catch (_error) {
        const numeric = Number(raw);
        return { value: Number.isNaN(numeric) ? raw : numeric, raw };
    }
}

function buildRequestBody(topic, parsedPayload) {
    const now = new Date().toISOString();
    const payload = parsedPayload.value;

    if (parsedPayload.isBinary && parsedPayload.rawHex) {
        return {
            sensor_id: topic,
            timestamp: now,
            raw_hex: parsedPayload.rawHex,
            raw_base64: parsedPayload.rawBase64,
            payload_encoding: 'modbus_rtu'
        };
    }

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return {
            sensor_id: topic,
            ...payload
        };
    }

    return {
        sensor_id: topic,
        value: payload,
        timestamp: now
    };
}

function computeModbusCrc(buffer) { // RAYAT-FIX
    let crc = 0xFFFF; // RAYAT-FIX
    for (const byte of buffer) { // RAYAT-FIX
        crc ^= byte; // RAYAT-FIX
        for (let bit = 0; bit < 8; bit += 1) { // RAYAT-FIX
            crc = crc & 1 ? (crc >> 1) ^ 0xA001 : crc >> 1; // RAYAT-FIX
        } // RAYAT-FIX
    } // RAYAT-FIX
    return crc & 0xFFFF; // RAYAT-FIX
} // RAYAT-FIX

function readSignedRegister(value) { // RAYAT-FIX
    return value > 0x7FFF ? value - 0x10000 : value; // RAYAT-FIX
} // RAYAT-FIX

function decodeTelemetryFrame(buffer) { // RAYAT-FIX
    if (!Buffer.isBuffer(buffer) || buffer.length < 5) { // RAYAT-FIX
        return null; // RAYAT-FIX
    } // RAYAT-FIX

    const slaveId = buffer[0]; // RAYAT-FIX
    const functionCode = buffer[1]; // RAYAT-FIX
    const byteCount = buffer[2]; // RAYAT-FIX
    const expectedLength = 3 + byteCount + 2; // RAYAT-FIX
    const layout = TELEMETRY_FRAME_LAYOUTS.get(slaveId); // RAYAT-FIX
    if (!layout || functionCode !== 0x03 || buffer.length !== expectedLength || byteCount !== layout.length * 2) { // RAYAT-FIX
        return null; // RAYAT-FIX
    } // RAYAT-FIX

    const receivedCrc = buffer.readUInt16LE(buffer.length - 2); // RAYAT-FIX
    if (computeModbusCrc(buffer.subarray(0, -2)) !== receivedCrc) { // RAYAT-FIX
        return null; // RAYAT-FIX
    } // RAYAT-FIX

    const values = {}; // RAYAT-FIX
    layout.forEach((definition, index) => { // RAYAT-FIX
        const rawValue = buffer.readUInt16BE(3 + index * 2); // RAYAT-FIX
        const sourceValue = definition.signed ? readSignedRegister(rawValue) : rawValue; // RAYAT-FIX
        values[definition.key] = Number((sourceValue * definition.scale).toFixed(definition.scale < 1 ? 3 : 0)); // RAYAT-FIX
    }); // RAYAT-FIX

    return { slaveId, values }; // RAYAT-FIX
} // RAYAT-FIX

function snapshotComplete(snapshot) { // RAYAT-FIX
    return [...TELEMETRY_REQUIRED_SLAVES].every((slaveId) => snapshot.receivedSlaves.has(slaveId)); // RAYAT-FIX
} // RAYAT-FIX

function pruneExpiredSnapshots(nowMs = Date.now()) { // RAYAT-FIX
    for (const [topic, snapshot] of telemetrySnapshots.entries()) { // RAYAT-FIX
        if (nowMs - snapshot.startedAtMs <= SNAPSHOT_WINDOW_MS) { // RAYAT-FIX
            continue; // RAYAT-FIX
        } // RAYAT-FIX
        console.warn(`[bridge] snapshot telemetry incompleto scartato per "${topic}" dopo ${SNAPSHOT_WINDOW_MS}ms`); // RAYAT-FIX
        telemetrySnapshots.delete(topic); // RAYAT-FIX
    } // RAYAT-FIX
} // RAYAT-FIX

function buildAtomicTelemetryBody(topic, payloadBuffer) { // RAYAT-FIX
    const frame = decodeTelemetryFrame(payloadBuffer); // RAYAT-FIX
    if (!frame) { // RAYAT-FIX
        return undefined; // RAYAT-FIX
    } // RAYAT-FIX

    const nowMs = Date.now(); // RAYAT-FIX
    pruneExpiredSnapshots(nowMs); // RAYAT-FIX
    const existing = telemetrySnapshots.get(topic); // RAYAT-FIX
    const snapshot = existing || { startedAtMs: nowMs, timestamp: new Date(nowMs).toISOString(), values: {}, receivedSlaves: new Set() }; // RAYAT-FIX
    snapshot.values = { ...snapshot.values, ...frame.values }; // RAYAT-FIX
    snapshot.receivedSlaves.add(frame.slaveId); // RAYAT-FIX
    telemetrySnapshots.set(topic, snapshot); // RAYAT-FIX

    if (!snapshotComplete(snapshot)) { // RAYAT-FIX
        console.log(`[bridge] frame slave ${frame.slaveId} acquisito per snapshot "${topic}", attendo gli altri sensori`); // RAYAT-FIX
        return null; // RAYAT-FIX
    } // RAYAT-FIX

    telemetrySnapshots.delete(topic); // RAYAT-FIX
    return { sensor_id: topic, timestamp: snapshot.timestamp, ...snapshot.values }; // RAYAT-FIX
} // RAYAT-FIX

function parsePositiveNumber(value, fallback) { // RAYAT-FIX
    const numeric = Number(value); // RAYAT-FIX
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback; // RAYAT-FIX
} // RAYAT-FIX

const config = {
    mqttUrl: process.env.MQTT_BRIDGE_URL || 'mqtt://45.63.114.40:8080',
    mqttTopic: process.env.MQTT_BRIDGE_TOPIC || 'sensors/#',
    mqttUsername: cleanString(process.env.MQTT_BRIDGE_USERNAME) || undefined,
    mqttPassword: cleanString(process.env.MQTT_BRIDGE_PASSWORD) || undefined,
    updateUrl: process.env.SENSOR_UPDATE_URL || 'https://rayat.ma/api/sensors/update',
    bridgeToken: cleanString(process.env.MQTT_INGEST_TOKEN),
    bridgeTokenHeader: cleanString(process.env.MQTT_INGEST_TOKEN_HEADER) || 'x-rayat-bridge-token',
    reconnectPeriod: Number(process.env.MQTT_BRIDGE_RECONNECT_MS || 5000),
    connectTimeout: Number(process.env.MQTT_BRIDGE_CONNECT_TIMEOUT_MS || 30000),
    requestTimeout: Number(process.env.MQTT_BRIDGE_HTTP_TIMEOUT_MS || 15000), // RAYAT-FIX
    maxHttpAttempts: Math.max(1, Math.floor(parsePositiveNumber(process.env.MQTT_BRIDGE_HTTP_MAX_ATTEMPTS, 5))), // RAYAT-FIX
    retryBaseMs: Math.max(1000, parsePositiveNumber(process.env.MQTT_BRIDGE_HTTP_RETRY_BASE_MS, 4000)) // RAYAT-FIX
};

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]); // RAYAT-FIX

function sleep(ms) { // RAYAT-FIX
    return new Promise((resolve) => setTimeout(resolve, ms)); // RAYAT-FIX
} // RAYAT-FIX

function shorten(value, maxLength = 300) { // RAYAT-FIX
    const normalized = String(value || '').replace(/\s+/g, ' ').trim(); // RAYAT-FIX
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized; // RAYAT-FIX
} // RAYAT-FIX

const client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    reconnectPeriod: config.reconnectPeriod,
    connectTimeout: config.connectTimeout,
    keepalive: 30,
    clean: true
});

async function forwardMessage(topic, payloadBuffer) {
    const atomicTelemetryBody = buildAtomicTelemetryBody(topic, payloadBuffer); // RAYAT-FIX
    if (atomicTelemetryBody === null) { // RAYAT-FIX
        return; // RAYAT-FIX
    } // RAYAT-FIX
    const parsedPayload = parsePayload(payloadBuffer);
    const body = atomicTelemetryBody || buildRequestBody(topic, parsedPayload); // RAYAT-FIX
    const headers = {
        'Content-Type': 'application/json'
    };

    if (config.bridgeToken) {
        headers[config.bridgeTokenHeader] = config.bridgeToken;
    }

    for (let attempt = 1; attempt <= config.maxHttpAttempts; attempt += 1) { // RAYAT-FIX
        try { // RAYAT-FIX
            const response = await fetch(config.updateUrl, { // RAYAT-FIX
                method: 'POST', // RAYAT-FIX
                headers, // RAYAT-FIX
                body: JSON.stringify(body), // RAYAT-FIX
                signal: AbortSignal.timeout(config.requestTimeout) // RAYAT-FIX
            }); // RAYAT-FIX

            const responseText = await response.text(); // RAYAT-FIX

            if (response.ok) { // RAYAT-FIX
                console.log(`[bridge] ${topic} inoltrato con successo -> ${config.updateUrl}`); // RAYAT-FIX
                return; // RAYAT-FIX
            } // RAYAT-FIX

            const retryable = RETRYABLE_HTTP_STATUS.has(response.status); // RAYAT-FIX
            const message = `HTTP ${response.status}: ${shorten(responseText)}`; // RAYAT-FIX

            if (!retryable || attempt >= config.maxHttpAttempts) { // RAYAT-FIX
                const error = new Error(message); // RAYAT-FIX
                error.noRetry = !retryable; // RAYAT-FIX
                throw error; // RAYAT-FIX
            } // RAYAT-FIX

            console.warn(`[bridge] tentativo ${attempt}/${config.maxHttpAttempts} fallito per "${topic}": ${message}`); // RAYAT-FIX
        } catch (error) { // RAYAT-FIX
            if (error.noRetry || attempt >= config.maxHttpAttempts) { // RAYAT-FIX
                throw error; // RAYAT-FIX
            } // RAYAT-FIX

            console.warn(`[bridge] tentativo ${attempt}/${config.maxHttpAttempts} fallito per "${topic}": ${error.message}`); // RAYAT-FIX
        } // RAYAT-FIX

        await sleep(config.retryBaseMs * attempt); // RAYAT-FIX
    } // RAYAT-FIX
}

client.on('connect', () => {
    console.log(`[bridge] connesso a ${config.mqttUrl}`);
    client.subscribe(config.mqttTopic, { qos: 1 }, (error) => {
        if (error) {
            console.error(`[bridge] errore subscribe su ${config.mqttTopic}:`, error.message);
            return;
        }
        console.log(`[bridge] in ascolto su ${config.mqttTopic}`);
    });
});

client.on('reconnect', () => {
    console.warn('[bridge] broker non disponibile, nuovo tentativo...');
});

client.on('offline', () => {
    console.warn('[bridge] client offline');
});

client.on('close', () => {
    console.warn('[bridge] connessione MQTT chiusa');
});

client.on('error', (error) => {
    console.error('[bridge] errore MQTT:', error.message);
});

client.on('message', (topic, payloadBuffer) => {
    forwardMessage(topic, payloadBuffer).catch((error) => {
        console.error(`[bridge] errore inoltro per topic "${topic}":`, error.message);
    });
});

function shutdown(signal) {
    console.log(`[bridge] ricevuto ${signal}, arresto in corso...`);
    client.end(true, () => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
