const mqtt = require('mqtt');
const { TextDecoder } = require('util');
const { getRouterIntervalMinutes } = require('../../utils/monitoring-config'); // RAYAT-FIX

const {
    ingestDeviceReadings,
    ingestTrustedReadings,
    ingestPublicReadings,
    recordGatewaySignal // RAYAT-FIX
} = require('../../utils/sensor-ingest');
const { cleanString, parseGatewaySignalUpdate, parseSensorUpdate } = require('../../utils/sensor-update-parser');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

let mqttClient = null;
let mqttConfigSnapshot = null;
let reconnectDelayMs = 0;
let inFlightMessages = 0;
let shutdownPromise = null;

// RAYAT-FIX: expose live MQTT runtime diagnostics to health checks and logs.
const mqttRuntime = {
    connected: false,
    subscribeOk: false, // RAYAT-FIX
    reconnectCount: 0,
    lastConnectAt: null,
    lastDisconnectAt: null,
    lastMessageAt: null,
    lastMessageTopic: null,
    lastPersistOkAt: null,
    lastPersistErrorAt: null,
    consecutiveErrors: 0
};

function parseBoolean(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
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

function buildIncomingBody(topic, parsedPayload) {
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

function getMqttConfig() {
    const hasExplicitEnabled = String(process.env.MQTT_DIRECT_ENABLED || '').trim() !== '';
    const defaultEnabled = process.env.NODE_ENV === 'production';
    const brokerUrl = cleanString(process.env.MQTT_BROKER) || 'mqtt://45.63.114.40:8080';
    const reconnectPeriod = Math.max(1000, Number(process.env.MQTT_RECONNECT_PERIOD_MS || 5000));

    return {
        enabled: hasExplicitEnabled ? parseBoolean(process.env.MQTT_DIRECT_ENABLED) : defaultEnabled,
        brokerUrl,
        topic: cleanString(process.env.MQTT_TOPIC) || 'sensors/#',
        username: cleanString(process.env.MQTT_USERNAME) || undefined,
        password: cleanString(process.env.MQTT_PASSWORD) || undefined,
        // RAYAT-FIX: keep a stable backend consumer identity across reconnects.
        clientId: cleanString(process.env.MQTT_CLIENT_ID) || 'rayat-backend-prod',
        reconnectPeriod,
        maxReconnectPeriod: Math.max(reconnectPeriod, Number(process.env.MQTT_MAX_RECONNECT_PERIOD_MS || 60000)),
        connectTimeout: Number(process.env.MQTT_CONNECT_TIMEOUT_MS || 30000)
    };
}

function markDisconnected() {
    mqttRuntime.connected = false; // RAYAT-FIX
    mqttRuntime.subscribeOk = false; // RAYAT-FIX
    mqttRuntime.lastDisconnectAt = new Date().toISOString(); // RAYAT-FIX
}

function resetReconnectDelay() {
    if (!mqttConfigSnapshot) {
        return;
    }

    reconnectDelayMs = mqttConfigSnapshot.reconnectPeriod;
    if (mqttClient?.options) {
        mqttClient.options.reconnectPeriod = reconnectDelayMs;
    }
}

function bumpReconnectDelay() {
    if (!mqttConfigSnapshot) {
        return 0;
    }

    const baseDelay = reconnectDelayMs || mqttConfigSnapshot.reconnectPeriod;
    const nextDelay = Math.min(mqttConfigSnapshot.maxReconnectPeriod, baseDelay * 2);
    reconnectDelayMs = nextDelay;

    if (mqttClient?.options) {
        mqttClient.options.reconnectPeriod = reconnectDelayMs;
    }

    return nextDelay;
}

function getConsumerHealthyWindowMinutes() {
    return Math.max(90, getRouterIntervalMinutes() * 3); // RAYAT-FIX
}

function getMqttRuntimeStatus() {
    const consumerHealthyWindowMinutes = getConsumerHealthyWindowMinutes(); // RAYAT-FIX
    const lastMessageDate = mqttRuntime.lastMessageAt ? new Date(mqttRuntime.lastMessageAt) : null; // RAYAT-FIX
    const lastMessageAgeMinutes = lastMessageDate && !Number.isNaN(lastMessageDate.getTime()) // RAYAT-FIX
        ? Math.floor((Date.now() - lastMessageDate.getTime()) / 60000) // RAYAT-FIX
        : null; // RAYAT-FIX
    const consumerHealthy = Boolean( // RAYAT-FIX
        mqttRuntime.connected // RAYAT-FIX
        && mqttRuntime.subscribeOk // RAYAT-FIX
        && lastMessageAgeMinutes !== null // RAYAT-FIX
        && lastMessageAgeMinutes < consumerHealthyWindowMinutes // RAYAT-FIX
    ); // RAYAT-FIX

    return {
        ...mqttRuntime, // RAYAT-FIX
        consumerHealthyWindowMinutes, // RAYAT-FIX
        lastMessageAgeMinutes, // RAYAT-FIX
        consumerHealthy // RAYAT-FIX
    };
}

async function processIncomingMessage(topic, payloadBuffer) {
    const parsedPayload = parsePayload(payloadBuffer);
    const body = buildIncomingBody(topic, parsedPayload);
    const gatewaySignal = parseGatewaySignalUpdate(body); // RAYAT-FIX
    let result;

    if (gatewaySignal) { // RAYAT-FIX
        result = await recordGatewaySignal(gatewaySignal); // RAYAT-FIX
        mqttRuntime.lastPersistOkAt = new Date().toISOString(); // RAYAT-FIX
        mqttRuntime.consecutiveErrors = 0; // RAYAT-FIX
        console.log(`[mqtt-direct] topic=${topic} segnale gateway ${gatewaySignal.event} salvato con successo`); // RAYAT-FIX
        return result; // RAYAT-FIX
    } // RAYAT-FIX

    const prepared = parseSensorUpdate(body);

    if (prepared.apiKey) {
        result = await ingestDeviceReadings({
            deviceId: prepared.deviceId,
            apiKey: prepared.apiKey,
            timestamp: prepared.timestamp,
            readings: prepared.readings
        });
    } else {
        try {
            result = await ingestTrustedReadings({
                deviceId: prepared.deviceId,
                timestamp: prepared.timestamp,
                readings: prepared.readings
            });
        } catch (error) {
            if (
                error.statusCode === 400 &&
                /Più clienti attivi trovati|Nessun cliente attivo trovato/i.test(error.message || '')
            ) {
                result = await ingestPublicReadings({
                    timestamp: prepared.timestamp,
                    readings: prepared.readings
                });
            } else {
                throw error;
            }
        }
    }

    mqttRuntime.lastPersistOkAt = new Date().toISOString();
    mqttRuntime.consecutiveErrors = 0;

    // RAYAT-FIX: structured topic/timestamp success log for production correlation.
    console.log(
        `[mqtt-direct] topic=${topic} timestamp=${prepared.timestamp || mqttRuntime.lastMessageAt} salvato con successo (${result.insertedReadings.length} letture)`
    );
}

function startMqttDirectJob() {
    if (mqttClient) {
        return mqttClient;
    }

    const config = getMqttConfig();
    if (!config.enabled) {
        return null;
    }

    if (!config.brokerUrl) {
        console.warn('[mqtt-direct] MQTT_DIRECT_ENABLED=true ma MQTT_BROKER non è configurato. Job non avviato.');
        return null;
    }

    mqttConfigSnapshot = config;
    reconnectDelayMs = config.reconnectPeriod;

    mqttClient = mqtt.connect(config.brokerUrl, {
        clientId: config.clientId,
        username: config.username,
        password: config.password,
        reconnectPeriod: config.reconnectPeriod,
        connectTimeout: config.connectTimeout,
        keepalive: 30,
        // RAYAT-FIX: durable MQTT subscription across reconnects/restarts.
        clean: false,
        resubscribe: true
    });

    mqttClient.on('connect', () => {
        mqttRuntime.connected = true; // RAYAT-FIX
        mqttRuntime.subscribeOk = false; // RAYAT-FIX
        mqttRuntime.lastConnectAt = new Date().toISOString(); // RAYAT-FIX
        mqttRuntime.consecutiveErrors = 0; // RAYAT-FIX
        resetReconnectDelay();
        console.log(`[mqtt-direct] connesso a ${config.brokerUrl}`);
        mqttClient.subscribe(config.topic, { qos: 1 }, (error) => {
            if (error) {
                mqttRuntime.subscribeOk = false; // RAYAT-FIX
                console.error(`[mqtt-direct] errore subscribe su ${config.topic}:`, error.message);
                return;
            }
            mqttRuntime.subscribeOk = true; // RAYAT-FIX
            console.log(`[mqtt-direct] in ascolto su ${config.topic}`);
        });
    });

    mqttClient.on('reconnect', () => {
        mqttRuntime.connected = false; // RAYAT-FIX
        mqttRuntime.subscribeOk = false; // RAYAT-FIX
        mqttRuntime.reconnectCount += 1; // RAYAT-FIX
        const nextDelay = bumpReconnectDelay();
        console.warn(`[mqtt-direct] broker non disponibile, nuovo tentativo tra ${nextDelay || config.reconnectPeriod}ms...`);
    });

    mqttClient.on('offline', () => {
        markDisconnected();
        console.warn('[mqtt-direct] client offline');
    });

    mqttClient.on('close', () => {
        markDisconnected();
        console.warn('[mqtt-direct] connessione MQTT chiusa');
    });

    mqttClient.on('error', (error) => {
        console.error('[mqtt-direct] errore MQTT:', error.message);
    });

    mqttClient.on('message', (topic, payloadBuffer) => {
        mqttRuntime.lastMessageAt = new Date().toISOString();
        mqttRuntime.lastMessageTopic = topic;
        inFlightMessages += 1;

        processIncomingMessage(topic, payloadBuffer).catch((error) => {
            mqttRuntime.lastPersistErrorAt = new Date().toISOString();
            mqttRuntime.consecutiveErrors += 1;
            // RAYAT-FIX: keep topic + receive timestamp visible for failed ingests.
            console.error(
                `[mqtt-direct] errore ingest topic=${topic} receivedAt=${mqttRuntime.lastMessageAt}:`,
                error.message
            );
        }).finally(() => {
            inFlightMessages = Math.max(0, inFlightMessages - 1);
        });
    });

    return mqttClient;
}

async function waitForInFlightMessages(timeoutMs = 15000) {
    const startTime = Date.now();

    // RAYAT-FIX: finish in-flight persistence before disconnecting MQTT on shutdown.
    while (inFlightMessages > 0 && (Date.now() - startTime) < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

async function stopMqttDirectJob() {
    if (!mqttClient) {
        markDisconnected();
        return;
    }

    if (shutdownPromise) {
        return shutdownPromise;
    }

    const client = mqttClient;

    shutdownPromise = (async () => {
        await waitForInFlightMessages();

        await new Promise((resolve) => {
            let settled = false;
            const finalize = () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };

            const timeoutId = setTimeout(finalize, 5000);
            client.end(false, {}, () => {
                clearTimeout(timeoutId);
                finalize();
            });
        });

        markDisconnected();
        mqttClient = null;
        mqttConfigSnapshot = null;
        reconnectDelayMs = 0;
        inFlightMessages = 0;
        shutdownPromise = null;
    })();

    return shutdownPromise;
}

module.exports = {
    buildIncomingBody,
    getMqttConfig,
    getMqttRuntimeStatus,
    parsePayload,
    processIncomingMessage,
    startMqttDirectJob,
    stopMqttDirectJob
};
