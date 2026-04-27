import process from 'node:process';
import axios from 'axios';
import dotenv from 'dotenv';
import mqtt from 'mqtt';

dotenv.config();

const config = {
  mqttUrl: process.env.MQTT_URL || 'mqtt://45.63.114.40:8080',
  mqttTopic: process.env.MQTT_TOPIC || 'sensors/#',
  mqttUsername: process.env.MQTT_USERNAME || undefined,
  mqttPassword: process.env.MQTT_PASSWORD || undefined,
  mqttClientId:
    process.env.MQTT_CLIENT_ID || `rayat-mqtt-bridge-${Math.random().toString(16).slice(2, 10)}`,
  mqttReconnectPeriodMs: Number(process.env.MQTT_RECONNECT_PERIOD_MS || 5000),
  mqttConnectTimeoutMs: Number(process.env.MQTT_CONNECT_TIMEOUT_MS || 30000),
  apiUrl: process.env.API_URL || 'https://rayat.ma/api/sensors/update',
  apiTimeoutMs: Number(process.env.API_TIMEOUT_MS || 15000),
  apiToken: process.env.API_TOKEN || '',
  apiTokenHeader: process.env.API_TOKEN_HEADER || 'Authorization',
  apiTokenPrefix: process.env.API_TOKEN_PREFIX || 'Bearer',
  apiKey: process.env.API_KEY || '',
  apiKeyHeader: process.env.API_KEY_HEADER || 'x-api-key',
  stripTopicPrefix: process.env.STRIP_TOPIC_PREFIX || 'sensors/'
};

const http = axios.create({
  timeout: config.apiTimeoutMs,
  validateStatus: () => true
});
const BRIDGE_FIELD_MAP = {
  temperature: { type: 'clima', subtype: 'clima_temperature', unit: '°C', name: 'Sensore Temperatura' },
  humidity: { type: 'clima', subtype: 'clima_humidity', unit: '%', name: 'Sensore Umidita' },
  co2: { type: 'clima', subtype: 'clima_co2', unit: 'ppm', name: 'Sensore CO2' },
  soilTemperature: { type: 'terreno', subtype: 'terreno_temperature', unit: '°C', name: 'Sensore Temperatura Terreno' },
  soilHumidity: { type: 'terreno', subtype: 'terreno_moisture', unit: '%', name: 'Sensore Terreno' },
  soilConductivity: { type: 'terreno', subtype: 'terreno_ec', unit: 'dS/m', name: 'Sensore EC' },
  nitrogen: { type: 'terreno', subtype: 'terreno_n', unit: 'ppm', name: 'Sensore Azoto' },
  phosphorus: { type: 'terreno', subtype: 'terreno_p', unit: 'ppm', name: 'Sensore Fosforo' },
  potassium: { type: 'terreno', subtype: 'terreno_k', unit: 'ppm', name: 'Sensore Potassio' },
  pH: { type: 'terreno', subtype: 'terreno_ph', unit: 'pH', name: 'Sensore pH' }
};
const BRIDGE_IGNORED_FIELDS = new Set(['timestamp', 'device_id', 'api_key', 'height']);

function buildApiHeaders() {
  const headers = {
    'Content-Type': 'application/json'
  };

  // Se rayat.ma richiede autenticazione, inserisci il token/API key nel file .env.
  if (config.apiToken) {
    const isAuthorizationHeader = config.apiTokenHeader.toLowerCase() === 'authorization';
    headers[config.apiTokenHeader] =
      isAuthorizationHeader && config.apiTokenPrefix
        ? `${config.apiTokenPrefix} ${config.apiToken}`
        : config.apiToken;
  }

  if (config.apiKey) {
    headers[config.apiKeyHeader] = config.apiKey;
  }

  return headers;
}

function normalizeSensorId(topic) {
  if (!config.stripTopicPrefix) {
    return topic;
  }

  return topic.startsWith(config.stripTopicPrefix)
    ? topic.slice(config.stripTopicPrefix.length)
    : topic;
}

function extractValue(parsed) {
  if (parsed === null) {
    return null;
  }

  if (['number', 'string', 'boolean'].includes(typeof parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (typeof parsed === 'object') {
    if ('value' in parsed) {
      return parsed.value;
    }

    if ('reading' in parsed) {
      return parsed.reading;
    }

    if ('data' in parsed) {
      return parsed.data;
    }

    const entries = Object.entries(parsed);
    if (entries.length === 1) {
      return entries[0][1];
    }

    return parsed;
  }

  return parsed;
}

function parsePayload(buffer) {
  const raw = buffer.toString('utf8').trim();

  if (!raw) {
    throw new Error('Payload MQTT vuoto');
  }

  try {
    return extractValue(JSON.parse(raw));
  } catch {
    const numeric = Number(raw);
    return Number.isNaN(numeric) ? raw : numeric;
  }
}

async function forwardMessage(topic, payloadBuffer) {
  const value = parsePayload(payloadBuffer);
  const normalizedTopic = normalizeSensorId(topic);
  let body = {
    sensor_id: normalizedTopic,
    value,
    timestamp: new Date().toISOString()
  };

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const readings = Object.entries(value)
      .filter(([key]) => !BRIDGE_IGNORED_FIELDS.has(key) && BRIDGE_FIELD_MAP[key])
      .map(([key, readingValue]) => ({
        type: BRIDGE_FIELD_MAP[key].type,
        subtype: BRIDGE_FIELD_MAP[key].subtype,
        unit: BRIDGE_FIELD_MAP[key].unit,
        name: BRIDGE_FIELD_MAP[key].name,
        value: readingValue
      }));

    if (readings.length) {
      body = {
        sensor_id: normalizedTopic,
        timestamp: value.timestamp || new Date().toISOString(),
        ...(value.device_id ? { device_id: value.device_id } : {}),
        ...(value.api_key ? { api_key: value.api_key } : {}),
        readings
      };
    }
  }

  try {
    const response = await http.post(config.apiUrl, body, {
      headers: buildApiHeaders()
    });

    if (response.status < 200 || response.status >= 300) {
      console.error(
        `[HTTP] API ha risposto con stato ${response.status} per topic "${topic}".`,
        response.data
      );
      return;
    }

    console.log(`[HTTP] Inoltrato con successo topic "${topic}" -> ${config.apiUrl}`);
  } catch (error) {
    const details = error.response?.data || error.message;
    console.error(`[HTTP] Errore nell'invio del topic "${topic}":`, details);
  }
}

const client = mqtt.connect(config.mqttUrl, {
  clientId: config.mqttClientId,
  username: config.mqttUsername,
  password: config.mqttPassword,
  reconnectPeriod: config.mqttReconnectPeriodMs,
  connectTimeout: config.mqttConnectTimeoutMs,
  keepalive: 30,
  clean: true,
  resubscribe: true
});

client.on('connect', () => {
  console.log(`[MQTT] Connesso a ${config.mqttUrl}`);

  client.subscribe(config.mqttTopic, { qos: 0 }, (error) => {
    if (error) {
      console.error(`[MQTT] Errore subscribe su "${config.mqttTopic}":`, error.message);
      return;
    }

    console.log(`[MQTT] In ascolto su "${config.mqttTopic}"`);
  });
});

client.on('reconnect', () => {
  console.warn('[MQTT] Broker non disponibile, nuovo tentativo di connessione in corso...');
});

client.on('offline', () => {
  console.warn('[MQTT] Client offline.');
});

client.on('close', () => {
  console.warn('[MQTT] Connessione chiusa.');
});

client.on('error', (error) => {
  console.error('[MQTT] Errore client:', error.message);
});

client.on('message', (topic, payloadBuffer) => {
  void forwardMessage(topic, payloadBuffer);
});

function shutdown(signal) {
  console.log(`[APP] Ricevuto ${signal}, chiusura in corso...`);
  client.end(true, () => {
    console.log('[APP] Bridge fermato correttamente.');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[APP] Rayat MQTT Bridge avviato.');
