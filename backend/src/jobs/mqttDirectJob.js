const mqtt = require('mqtt');
const { TextDecoder } = require('util');

const {
    ingestDeviceReadings,
    ingestTrustedReadings,
    ingestPublicReadings
} = require('../../utils/sensor-ingest');
const { cleanString, parseSensorUpdate } = require('../../utils/sensor-update-parser');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

let mqttClient = null;

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

    return {
        enabled: hasExplicitEnabled ? parseBoolean(process.env.MQTT_DIRECT_ENABLED) : defaultEnabled,
        brokerUrl,
        topic: cleanString(process.env.MQTT_TOPIC) || 'sensors/#',
        username: cleanString(process.env.MQTT_USERNAME) || undefined,
        password: cleanString(process.env.MQTT_PASSWORD) || undefined,
        clientId: cleanString(process.env.MQTT_CLIENT_ID) || `rayat-backend-${Math.random().toString(16).slice(2, 10)}`,
        reconnectPeriod: Number(process.env.MQTT_RECONNECT_PERIOD_MS || 5000),
        connectTimeout: Number(process.env.MQTT_CONNECT_TIMEOUT_MS || 30000)
    };
}

async function processIncomingMessage(topic, payloadBuffer) {
    const parsedPayload = parsePayload(payloadBuffer);
    const body = buildIncomingBody(topic, parsedPayload);
    const prepared = parseSensorUpdate(body);
    let result;

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

    console.log(`[mqtt-direct] ${topic} salvato con successo (${result.insertedReadings.length} letture)`);
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

    mqttClient = mqtt.connect(config.brokerUrl, {
        clientId: config.clientId,
        username: config.username,
        password: config.password,
        reconnectPeriod: config.reconnectPeriod,
        connectTimeout: config.connectTimeout,
        keepalive: 30,
        clean: true,
        resubscribe: true
    });

    mqttClient.on('connect', () => {
        console.log(`[mqtt-direct] connesso a ${config.brokerUrl}`);
        mqttClient.subscribe(config.topic, { qos: 0 }, (error) => {
            if (error) {
                console.error(`[mqtt-direct] errore subscribe su ${config.topic}:`, error.message);
                return;
            }
            console.log(`[mqtt-direct] in ascolto su ${config.topic}`);
        });
    });

    mqttClient.on('reconnect', () => {
        console.warn('[mqtt-direct] broker non disponibile, nuovo tentativo...');
    });

    mqttClient.on('offline', () => {
        console.warn('[mqtt-direct] client offline');
    });

    mqttClient.on('close', () => {
        console.warn('[mqtt-direct] connessione MQTT chiusa');
    });

    mqttClient.on('error', (error) => {
        console.error('[mqtt-direct] errore MQTT:', error.message);
    });

    mqttClient.on('message', (topic, payloadBuffer) => {
        processIncomingMessage(topic, payloadBuffer).catch((error) => {
            console.error(`[mqtt-direct] errore ingest per topic "${topic}":`, error.message);
        });
    });

    return mqttClient;
}

module.exports = {
    buildIncomingBody,
    getMqttConfig,
    parsePayload,
    processIncomingMessage,
    startMqttDirectJob
};
