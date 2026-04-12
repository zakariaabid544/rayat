#!/usr/bin/env node

const mqtt = require('mqtt');
const { TextDecoder } = require('util');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

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
    requestTimeout: Number(process.env.MQTT_BRIDGE_HTTP_TIMEOUT_MS || 15000)
};

const client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    reconnectPeriod: config.reconnectPeriod,
    connectTimeout: config.connectTimeout,
    keepalive: 30,
    clean: true
});

async function forwardMessage(topic, payloadBuffer) {
    const parsedPayload = parsePayload(payloadBuffer);
    const body = buildRequestBody(topic, parsedPayload);
    const headers = {
        'Content-Type': 'application/json'
    };

    if (config.bridgeToken) {
        headers[config.bridgeTokenHeader] = config.bridgeToken;
    }

    const response = await fetch(config.updateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.requestTimeout)
    });

    const responseText = await response.text();

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText}`);
    }

    console.log(`[bridge] ${topic} inoltrato con successo -> ${config.updateUrl}`);
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
