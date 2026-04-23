#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInteger(value, fallback) {
    const normalized = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function parseMinutes(value, fallback) {
    return parsePositiveInteger(value, fallback);
}

function parseQos(value, fallback) {
    const normalized = Number.parseInt(String(value ?? '').trim(), 10);
    return [0, 1, 2].includes(normalized) ? normalized : fallback;
}

function readJsonFile(filePath) {
    if (!filePath) {
        return null;
    }

    const absolutePath = path.resolve(process.cwd(), filePath);
    const raw = fs.readFileSync(absolutePath, 'utf8');
    return JSON.parse(raw);
}

const config = {
    brokerUrl: cleanString(process.env.ROUTER_MQTT_BROKER || process.env.MQTT_BROKER) || 'mqtt://45.63.114.40:8080',
    username: cleanString(process.env.ROUTER_MQTT_USERNAME || process.env.MQTT_USERNAME) || undefined,
    password: cleanString(process.env.ROUTER_MQTT_PASSWORD || process.env.MQTT_PASSWORD) || undefined,
    deviceId: cleanString(process.env.ROUTER_DEVICE_ID || process.env.MQTT_DEFAULT_DEVICE_ID) || 'GW-001',
    clientId: cleanString(process.env.ROUTER_CLIENT_ID) || cleanString(process.env.ROUTER_DEVICE_ID || process.env.MQTT_DEFAULT_DEVICE_ID) || 'GW-001',
    fwVersion: cleanString(process.env.ROUTER_FW_VERSION),
    statusTopic: cleanString(process.env.ROUTER_STATUS_TOPIC),
    telemetryTopic: cleanString(process.env.ROUTER_TELEMETRY_TOPIC),
    heartbeatIntervalMs: parseMinutes(process.env.ROUTER_HEARTBEAT_INTERVAL_MINUTES, 10) * 60 * 1000,
    telemetryIntervalMs: parseMinutes(process.env.ROUTER_INTERVAL_MINUTES, 30) * 60 * 1000,
    reconnectPeriodMs: parsePositiveInteger(process.env.ROUTER_MQTT_RECONNECT_MS, 5000),
    connectTimeoutMs: parsePositiveInteger(process.env.ROUTER_MQTT_CONNECT_TIMEOUT_MS, 30000),
    statusQos: parseQos(process.env.ROUTER_STATUS_QOS, 1),
    telemetryQos: parseQos(process.env.ROUTER_TELEMETRY_QOS, 1),
    telemetryPayloadJson: cleanString(process.env.ROUTER_TELEMETRY_PAYLOAD_JSON),
    telemetryPayloadFile: cleanString(process.env.ROUTER_TELEMETRY_PAYLOAD_FILE)
};

if (!config.statusTopic) {
    config.statusTopic = `sensors/${config.deviceId}/status`;
}

if (!config.telemetryTopic) {
    config.telemetryTopic = `sensors/${config.deviceId}/telemetry`;
}

let bootPublished = false;
let bootRequested = false;
let heartbeatTimer = null;
let telemetryTimer = null;
let heartbeatInFlight = false;
let telemetryInFlight = false;

function loadTelemetryTemplate() {
    if (config.telemetryPayloadJson) {
        return JSON.parse(config.telemetryPayloadJson);
    }

    if (config.telemetryPayloadFile) {
        return readJsonFile(config.telemetryPayloadFile);
    }

    return null;
}

function buildDefaultTelemetryPayload() {
    return {
        device_id: config.deviceId,
        timestamp: new Date().toISOString(),
        temperature: 27.4,
        humidity: 63.1,
        co2: 418,
        soilTemperature: 21.6,
        soilHumidity: 46.2,
        soilConductivity: 1.12,
        nitrogen: 148,
        phosphorus: 43,
        potassium: 198,
        pH: 6.9
    };
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function buildTelemetryPayload() {
    const template = loadTelemetryTemplate();
    if (!template) {
        return buildDefaultTelemetryPayload();
    }

    return cloneJson(template);
}

function buildStatusPayload(event) {
    const payload = {
        deviceId: config.deviceId,
        clientId: config.clientId,
        event,
        sentAt: new Date().toISOString()
    };

    if (event === 'boot') {
        payload.bootId = crypto.randomUUID();

        if (config.fwVersion) {
            payload.fwVersion = config.fwVersion;
        }
    }

    return payload;
}

function assertStatusPayloadSize(payload) {
    const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (size >= 200) {
        throw new Error(`Status payload troppo grande (${size} byte)`);
    }
}

function publishJson(topic, payload, options = {}) {
    return new Promise((resolve, reject) => {
        if (!client.connected && !options.allowOfflineQueue) {
            resolve(false);
            return;
        }

        client.publish(
            topic,
            JSON.stringify(payload),
            {
                qos: options.qos ?? 1,
                retain: false
            },
            (error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(true);
            }
        );
    });
}

async function publishStatusEvent(event, reason) {
    const payload = buildStatusPayload(event);
    assertStatusPayloadSize(payload);

    const published = await publishJson(config.statusTopic, payload, {
        qos: config.statusQos,
        allowOfflineQueue: event === 'boot'
    });
    if (!published) {
        console.warn(`[router-publisher] ${event} saltato (${reason}): broker non connesso`);
        return false;
    }

    console.log(`[router-publisher] ${event} pubblicato su ${config.statusTopic}`);
    return true;
}

async function publishTelemetry(reason) {
    const payload = buildTelemetryPayload();
    const published = await publishJson(config.telemetryTopic, payload, { qos: config.telemetryQos });
    if (!published) {
        console.warn(`[router-publisher] telemetry saltata (${reason}): broker non connesso`);
        return false;
    }

    console.log(`[router-publisher] telemetry pubblicata su ${config.telemetryTopic}`);
    return true;
}

async function runHeartbeatTick(reason) {
    if (heartbeatInFlight) {
        console.warn('[router-publisher] heartbeat precedente ancora in corso, tick saltato');
        return;
    }

    heartbeatInFlight = true;
    try {
        await publishStatusEvent('heartbeat', reason);
    } catch (error) {
        console.error('[router-publisher] errore publish heartbeat:', error.message);
    } finally {
        heartbeatInFlight = false;
    }
}

async function runTelemetryTick(reason) {
    if (telemetryInFlight) {
        console.warn('[router-publisher] telemetry precedente ancora in corso, tick saltato');
        return;
    }

    telemetryInFlight = true;
    try {
        await publishTelemetry(reason);
    } catch (error) {
        console.error('[router-publisher] errore publish telemetry:', error.message);
    } finally {
        telemetryInFlight = false;
    }
}

function ensureBootPublished(reason) {
    if (bootPublished || bootRequested) {
        return;
    }

    bootRequested = true;
    void publishStatusEvent('boot', reason).then((published) => {
        if (published) {
            bootPublished = true;
            return;
        }
        bootRequested = false;
    }).catch((error) => {
        bootRequested = false;
        console.error('[router-publisher] errore publish boot:', error.message);
    });
}

function startSchedulers() {
    if (!heartbeatTimer) {
        heartbeatTimer = setInterval(() => {
            void runHeartbeatTick('interval');
        }, config.heartbeatIntervalMs);
    }

    if (!telemetryTimer) {
        telemetryTimer = setInterval(() => {
            void runTelemetryTick('interval');
        }, config.telemetryIntervalMs);
    }
}

function stopSchedulers() {
    clearInterval(heartbeatTimer);
    clearInterval(telemetryTimer);
    heartbeatTimer = null;
    telemetryTimer = null;
}

const client = mqtt.connect(config.brokerUrl, {
    clientId: config.clientId,
    username: config.username,
    password: config.password,
    reconnectPeriod: config.reconnectPeriodMs,
    connectTimeout: config.connectTimeoutMs,
    keepalive: 30,
    clean: false
});

client.on('connect', () => {
    console.log(`[router-publisher] connesso a ${config.brokerUrl}`);
    ensureBootPublished('connect');
});

client.on('reconnect', () => {
    console.warn('[router-publisher] broker non disponibile, nuovo tentativo...');
});

client.on('offline', () => {
    console.warn('[router-publisher] client offline');
});

client.on('close', () => {
    console.warn('[router-publisher] connessione MQTT chiusa');
});

client.on('error', (error) => {
    console.error('[router-publisher] errore MQTT:', error.message);
});

function shutdown(signal) {
    console.log(`[router-publisher] ricevuto ${signal}, arresto in corso...`);
    stopSchedulers();
    client.end(false, {}, () => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startSchedulers();
ensureBootPublished('startup');

console.log('[router-publisher] pipeline avviata');
console.log(`[router-publisher] status topic: ${config.statusTopic} (qos=${config.statusQos}, every=${config.heartbeatIntervalMs / 60000}m)`);
console.log(`[router-publisher] telemetry topic: ${config.telemetryTopic} (qos=${config.telemetryQos}, every=${config.telemetryIntervalMs / 60000}m)`);
