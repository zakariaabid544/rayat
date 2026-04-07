#!/usr/bin/env node

const mqtt = require('mqtt');

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function parsePayload(buffer) {
    const raw = buffer.toString('utf8').trim();

    if (!raw) {
        return { value: null, raw: '' };
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

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return {
            sensor_id: topic,
            timestamp: payload.timestamp || now,
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
    client.subscribe(config.mqttTopic, { qos: 0 }, (error) => {
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
