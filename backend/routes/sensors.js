const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticateToken, checkSubscription } = require('../middleware/auth');
const { upsertAlarmEvent, resolveAlarmEvent } = require('../utils/alerts');
const {
    VALID_SENSOR_TYPES,
    createHttpError,
    ingestDeviceReadings,
    ingestTrustedReadings,
    ingestPublicReadings,
    recordGatewaySignal,
    validateDeviceCredentials // RAYAT-FIX
} = require('../utils/sensor-ingest');
const {
    getGatewayHeartbeatWindowMinutes, // RAYAT-FIX
    getMonitoringConfig,
    getOfflineAfterMinutes,
    getPostgresMinuteIntervalLiteral,
    getSensorDataFreshMinutes // RAYAT-FIX
} = require('../utils/monitoring-config');
const { cleanString, parseGatewaySignalUpdate, parseSensorUpdate } = require('../utils/sensor-update-parser');

const DEFAULT_BRIDGE_TOKEN_HEADER = 'x-rayat-bridge-token';
const SENSOR_UPDATE_UNAUTHORIZED = { error: 'Non autorizzato' }; // RAYAT-FIX

function parseNumericValue(value) {
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function shouldSwapSoilPair(soilTemperature, soilMoisture) {
    const temperature = parseNumericValue(soilTemperature);
    const moisture = parseNumericValue(soilMoisture);

    if (!Number.isFinite(temperature) || !Number.isFinite(moisture)) {
        return false;
    }

    // Hotfix difensivo per la pipeline live: quando i due valori arrivano invertiti
    // vediamo coppie come 38.6°C / 19%. In quel caso li scambiamo.
    return temperature > 35 && moisture < 25;
}

function getSoilPairGroupKey(reading, includeTimestamp = true) {
    return [
        cleanString(reading?.device_id || reading?.deviceId),
        cleanString(reading?.topic),
        includeTimestamp ? cleanString(reading?.timestamp) : '',
        cleanString(reading?.type)
    ].join('::');
}

function normalizeSoilReadingPairs(readings = [], options = {}) {
    const includeTimestamp = options.includeTimestamp !== false;
    const normalized = readings.map((reading) => (reading && typeof reading === 'object' ? { ...reading } : reading));
    const groups = new Map();

    normalized.forEach((reading, index) => {
        if (!reading || reading.type !== 'terreno') {
            return;
        }

        if (reading.subtype !== 'terreno_temperature' && reading.subtype !== 'terreno_moisture') {
            return;
        }

        const key = getSoilPairGroupKey(reading, includeTimestamp);
        const group = groups.get(key) || { temperatureIndex: null, moistureIndex: null };

        if (reading.subtype === 'terreno_temperature') {
            group.temperatureIndex = index;
        } else {
            group.moistureIndex = index;
        }

        groups.set(key, group);
    });

    groups.forEach(({ temperatureIndex, moistureIndex }) => {
        if (!Number.isInteger(temperatureIndex) || !Number.isInteger(moistureIndex)) {
            return;
        }

        const temperatureReading = normalized[temperatureIndex];
        const moistureReading = normalized[moistureIndex];

        if (!shouldSwapSoilPair(temperatureReading?.value, moistureReading?.value)) {
            return;
        }

        const originalTemperature = temperatureReading.value;
        temperatureReading.value = moistureReading.value;
        moistureReading.value = originalTemperature;
    });

    return normalized;
}

function getBridgeAuthorization(req) {
    const configuredToken = cleanString(process.env.MQTT_INGEST_TOKEN);
    const headerName = cleanString(process.env.MQTT_INGEST_TOKEN_HEADER) || DEFAULT_BRIDGE_TOKEN_HEADER;
    const providedToken = cleanString(req.get(headerName) || req.get(DEFAULT_BRIDGE_TOKEN_HEADER)); // RAYAT-FIX

    if (!configuredToken) {
        return {
            tokenConfigured: false,
            trustedBridge: false // RAYAT-FIX
        };
    }

    return {
        tokenConfigured: true,
        trustedBridge: providedToken === configuredToken // RAYAT-FIX
    };
}

function sendSensorUpdateUnauthorized(res) { // RAYAT-FIX
    return res.status(401).json(SENSOR_UPDATE_UNAUTHORIZED); // RAYAT-FIX
} // RAYAT-FIX

function extractUpdateApiKey(body = {}) { // RAYAT-FIX
    const payload = body && typeof body.payload === 'object' ? body.payload : {}; // RAYAT-FIX
    const value = body && typeof body.value === 'object' ? body.value : {}; // RAYAT-FIX
    return cleanString(body.api_key || payload.api_key || value.api_key); // RAYAT-FIX
} // RAYAT-FIX

function extractTopicDeviceId(topic) { // RAYAT-FIX
    const segments = cleanString(topic).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean); // RAYAT-FIX
    const strippedSegments = segments[0] === 'sensors' ? segments.slice(1) : segments; // RAYAT-FIX
    const firstSegment = cleanString(strippedSegments[0]); // RAYAT-FIX
    return strippedSegments.length > 1 && !VALID_SENSOR_TYPES.has(firstSegment) ? firstSegment : ''; // RAYAT-FIX
} // RAYAT-FIX

function extractUpdateDeviceId(body = {}) { // RAYAT-FIX
    const payload = body && typeof body.payload === 'object' ? body.payload : {}; // RAYAT-FIX
    const value = body && typeof body.value === 'object' ? body.value : {}; // RAYAT-FIX
    const topic = cleanString(body.sensor_id || body.topic || payload.sensor_id || payload.topic || value.sensor_id || value.topic); // RAYAT-FIX
    return cleanString(body.device_id || body.deviceId || payload.device_id || payload.deviceId || value.device_id || value.deviceId) // RAYAT-FIX
        || extractTopicDeviceId(topic); // RAYAT-FIX
} // RAYAT-FIX

async function hasValidUpdateApiKey(deviceId, apiKey) { // RAYAT-FIX
    if (!deviceId || !apiKey) { // RAYAT-FIX
        return false; // RAYAT-FIX
    } // RAYAT-FIX

    try { // RAYAT-FIX
        await validateDeviceCredentials({ deviceId, apiKey }); // RAYAT-FIX
        return true; // RAYAT-FIX
    } catch (error) { // RAYAT-FIX
        if ([400, 401, 404].includes(error.statusCode)) { // RAYAT-FIX
            return false; // RAYAT-FIX
        } // RAYAT-FIX
        throw error; // RAYAT-FIX
    } // RAYAT-FIX
} // RAYAT-FIX

function parseHistoryDate(value, endOfDay = false) {
    const normalized = cleanString(value);
    if (!normalized) {
        return null;
    }

    const candidate = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
        ? new Date(`${normalized}${endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`)
        : new Date(normalized);

    if (Number.isNaN(candidate.getTime())) {
        throw createHttpError(400, `Data non valida: ${normalized}`);
    }

    return candidate;
}

function resolveHistoryRange(queryParams = {}) {
    const start = parseHistoryDate(queryParams.start || queryParams.startDate, false);
    const end = parseHistoryDate(queryParams.end || queryParams.endDate, true);
    const hours = Number.parseInt(queryParams.hours, 10);
    const days = Number.parseInt(queryParams.days, 10);
    const endDate = end || new Date();

    if (start && endDate < start) {
        throw createHttpError(400, 'La data di fine non può precedere la data di inizio');
    }

    if (start) {
        return { startDate: start, endDate };
    }

    const durationHours = Number.isFinite(hours) && hours > 0
        ? hours
        : (Number.isFinite(days) && days > 0 ? days * 24 : 30 * 24);
    const startDate = new Date(endDate.getTime() - durationHours * 60 * 60 * 1000);

    return { startDate, endDate };
}

function normalizeGatewayTimestamp(value) { // RAYAT-FIX
    if (value instanceof Date) { // RAYAT-FIX
        return Number.isNaN(value.getTime()) ? null : value.toISOString(); // RAYAT-FIX
    } // RAYAT-FIX

    const normalized = cleanString(value); // RAYAT-FIX
    if (!normalized) { // RAYAT-FIX
        return null; // RAYAT-FIX
    } // RAYAT-FIX

    const timestamp = new Date(normalized); // RAYAT-FIX
    return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString(); // RAYAT-FIX
}

function getMostRecentGatewayTimestamp(values = []) { // RAYAT-FIX
    return values // RAYAT-FIX
        .map((value) => normalizeGatewayTimestamp(value)) // RAYAT-FIX
        .filter(Boolean) // RAYAT-FIX
        .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null; // RAYAT-FIX
}

function isGatewayTimestampFresh(timestamp, thresholdMinutes) { // RAYAT-FIX
    const normalizedTimestamp = normalizeGatewayTimestamp(timestamp); // RAYAT-FIX
    if (!normalizedTimestamp) { // RAYAT-FIX
        return false; // RAYAT-FIX
    } // RAYAT-FIX

    return (Date.now() - new Date(normalizedTimestamp).getTime()) < (thresholdMinutes * 60 * 1000); // RAYAT-FIX
}

function buildEmptyGatewayStatus() { // RAYAT-FIX
    return { // RAYAT-FIX
        deviceId: null, // RAYAT-FIX
        deviceName: null, // RAYAT-FIX
        routerOnline: false, // RAYAT-FIX
        lastHeartbeatAt: null, // RAYAT-FIX
        lastBootAt: null, // RAYAT-FIX
        sensorDataLastAt: null, // RAYAT-FIX
        sensorDataFresh: false, // RAYAT-FIX
        lastGatewaySignalAt: null // RAYAT-FIX
    }; // RAYAT-FIX
}

function buildGatewayStatusCandidate(row = {}) { // RAYAT-FIX
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}; // RAYAT-FIX
    const lastHeartbeatAt = normalizeGatewayTimestamp(metadata.lastHeartbeatAt); // RAYAT-FIX
    const lastBootAt = normalizeGatewayTimestamp(metadata.lastBootAt); // RAYAT-FIX
    const sensorDataLastAt = normalizeGatewayTimestamp(row.sensor_data_last_at); // RAYAT-FIX
    const lastGatewaySignalAt = getMostRecentGatewayTimestamp([lastHeartbeatAt, lastBootAt]); // RAYAT-FIX
    return { // RAYAT-FIX
        deviceId: cleanString(row.device_id) || null, // RAYAT-FIX
        deviceName: cleanString(row.name) || null, // RAYAT-FIX
        routerOnline: isGatewayTimestampFresh(lastGatewaySignalAt, getGatewayHeartbeatWindowMinutes()), // RAYAT-FIX
        lastHeartbeatAt, // RAYAT-FIX
        lastBootAt, // RAYAT-FIX
        sensorDataLastAt, // RAYAT-FIX
        sensorDataFresh: isGatewayTimestampFresh(sensorDataLastAt, getSensorDataFreshMinutes()), // RAYAT-FIX
        lastGatewaySignalAt // RAYAT-FIX
    }; // RAYAT-FIX
}

function compareGatewayStatusCandidates(left = {}, right = {}) { // RAYAT-FIX
    const leftActivity = getMostRecentGatewayTimestamp([left.lastGatewaySignalAt, left.sensorDataLastAt]); // RAYAT-FIX
    const rightActivity = getMostRecentGatewayTimestamp([right.lastGatewaySignalAt, right.sensorDataLastAt]); // RAYAT-FIX
    return new Date(rightActivity || 0).getTime() - new Date(leftActivity || 0).getTime(); // RAYAT-FIX
}

async function getPublicSensorDataLastAt() { // RAYAT-FIX
    const rows = await query( // RAYAT-FIX
        `SELECT MAX(timestamp) AS sensor_data_last_at FROM public_sensor_latest` // RAYAT-FIX
    ); // RAYAT-FIX
    return normalizeGatewayTimestamp(rows[0]?.sensor_data_last_at); // RAYAT-FIX
} // RAYAT-FIX

async function resolveGatewayStatusPayload(options = {}) { // RAYAT-FIX
    const monitoring = getMonitoringConfig(); // RAYAT-FIX
    const preferredDeviceId = cleanString(options.preferredDeviceId || process.env.PUBLIC_GATEWAY_DEVICE_ID || process.env.MQTT_DEFAULT_DEVICE_ID); // RAYAT-FIX
    let sql = `
        SELECT
            d.id,
            d.device_id,
            d.name,
            d.metadata,
            MAX(sl.timestamp) AS sensor_data_last_at
        FROM devices d
        LEFT JOIN sensors s ON s.device_id = d.id
           AND s.enabled = TRUE
        LEFT JOIN sensor_latest sl ON sl.sensor_id = s.id
    `; // RAYAT-FIX
    const params = []; // RAYAT-FIX

    if (options.userId) { // RAYAT-FIX
        sql += ' WHERE d.user_id = ?'; // RAYAT-FIX
        params.push(options.userId); // RAYAT-FIX
    } // RAYAT-FIX

    sql += ' GROUP BY d.id, d.device_id, d.name, d.metadata'; // RAYAT-FIX
    const rows = await query(sql, params); // RAYAT-FIX
    const candidates = rows.map((row) => buildGatewayStatusCandidate(row)); // RAYAT-FIX
    const selected = candidates.find((candidate) => candidate.deviceId === preferredDeviceId) // RAYAT-FIX
        || candidates.sort(compareGatewayStatusCandidates)[0] // RAYAT-FIX
        || buildEmptyGatewayStatus(); // RAYAT-FIX
    const publicSensorDataLastAt = !options.userId ? await getPublicSensorDataLastAt() : null; // RAYAT-FIX
    const resolvedSensorDataLastAt = publicSensorDataLastAt || selected.sensorDataLastAt; // RAYAT-FIX
    const resolvedSelection = { // RAYAT-FIX
        ...selected, // RAYAT-FIX
        sensorDataLastAt: resolvedSensorDataLastAt, // RAYAT-FIX
        sensorDataFresh: isGatewayTimestampFresh(resolvedSensorDataLastAt, getSensorDataFreshMinutes()) // RAYAT-FIX
    }; // RAYAT-FIX

    return { // RAYAT-FIX
        success: true, // RAYAT-FIX
        data: resolvedSelection, // RAYAT-FIX
        monitoring // RAYAT-FIX
    }; // RAYAT-FIX
}

// GET /api/sensors/public/latest - Ultimi dati pubblici per la demo senza login
router.get('/public/latest', async (_req, res) => {
    try {
        const offlineIntervalLiteral = getPostgresMinuteIntervalLiteral(getOfflineAfterMinutes());
        const rows = await query(
            `SELECT
                sensor_type AS type,
                sensor_subtype AS subtype,
                value,
                topic,
                timestamp,
                CASE
                    WHEN timestamp >= NOW() - INTERVAL '${offlineIntervalLiteral}' THEN 'online'
                    ELSE 'offline'
                END AS online_status
             FROM public_sensor_latest
             ORDER BY sensor_type ASC, sensor_subtype ASC`
        );
        const normalizedRows = normalizeSoilReadingPairs(rows, { includeTimestamp: true });

        res.json({
            success: true,
            data: normalizedRows,
            monitoring: getMonitoringConfig()
        });
    } catch (error) {
        console.error('Get public latest sensors error:', error);
        res.status(500).json({ error: 'Errore nel recupero dati sensori pubblici' });
    }
});

router.get('/public/status', async (_req, res) => { // RAYAT-FIX
    try { // RAYAT-FIX
        res.json(await resolveGatewayStatusPayload({})); // RAYAT-FIX
    } catch (error) { // RAYAT-FIX
        console.error('Get public gateway status error:', error); // RAYAT-FIX
        res.status(500).json({ error: 'Errore nel recupero stato gateway pubblico' }); // RAYAT-FIX
    } // RAYAT-FIX
}); // RAYAT-FIX

// GET /api/sensors/public/history - Storico dati pubblici per la demo senza login
router.get('/public/history', async (req, res) => {
    try {
        const sensorType = cleanString(req.query.type);
        const subtype = cleanString(req.query.subtype);

        if (!VALID_SENSOR_TYPES.has(sensorType)) {
            return res.status(400).json({ error: 'Tipo sensore non valido' });
        }

        const { startDate, endDate } = resolveHistoryRange(req.query);
        let sql = `
            SELECT
                sensor_type AS type,
                sensor_subtype AS subtype,
                value,
                topic,
                timestamp
            FROM public_sensor_readings
            WHERE sensor_type = ?
              AND timestamp >= ?
              AND timestamp <= ?
        `;
        const params = [sensorType, startDate, endDate];

        if (subtype) {
            sql += ' AND sensor_subtype = ?';
            params.push(subtype);
        }

        sql += ' ORDER BY timestamp DESC, sensor_subtype ASC';

        const rows = await query(sql, params);
        const normalizedRows = normalizeSoilReadingPairs(rows, { includeTimestamp: true });

        res.json({
            success: true,
            data: normalizedRows.map((row) => ({
                type: row.type,
                subtype: row.subtype,
                value: parseFloat(row.value),
                topic: row.topic || null,
                timestamp: row.timestamp
            })),
            count: rows.length,
            range: {
                start: startDate.toISOString(),
                end: endDate.toISOString()
            }
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }

        console.error('Get public history sensors error:', error);
        res.status(500).json({ error: 'Errore nel recupero storico sensori pubblici' });
    }
});

// POST /api/sensors/update - Ingestione bridge MQTT -> sito
router.post('/update', async (req, res) => {
    try {
        const bridgeAuth = getBridgeAuthorization(req);
        const updateApiKey = extractUpdateApiKey(req.body); // RAYAT-FIX

        const gatewaySignal = parseGatewaySignalUpdate(req.body);

        if (gatewaySignal) {
            const apiKeyAuthorized = !bridgeAuth.trustedBridge && updateApiKey // RAYAT-FIX
                ? await hasValidUpdateApiKey(gatewaySignal.deviceId, updateApiKey) // RAYAT-FIX
                : false; // RAYAT-FIX
            if (!bridgeAuth.trustedBridge && (bridgeAuth.tokenConfigured || updateApiKey) && !apiKeyAuthorized) { // RAYAT-FIX
                return sendSensorUpdateUnauthorized(res); // RAYAT-FIX
            } // RAYAT-FIX

            const result = await recordGatewaySignal(gatewaySignal);
            return res.json({
                success: true,
                device_id: result.deviceId || null,
                mode: result.mode || 'gateway_signal',
                readings_count: result.insertedReadings.length,
                timestamp: new Date().toISOString()
            });
        }

        if (!bridgeAuth.trustedBridge && updateApiKey) { // RAYAT-FIX
            const apiKeyAuthorized = await hasValidUpdateApiKey(extractUpdateDeviceId(req.body), updateApiKey); // RAYAT-FIX
            if (!apiKeyAuthorized) { // RAYAT-FIX
                return sendSensorUpdateUnauthorized(res); // RAYAT-FIX
            } // RAYAT-FIX
        } else if (!bridgeAuth.trustedBridge && bridgeAuth.tokenConfigured) { // RAYAT-FIX
            return sendSensorUpdateUnauthorized(res); // RAYAT-FIX
        } // RAYAT-FIX

        const prepared = parseSensorUpdate(req.body);
        let result;

        if (prepared.apiKey) {
            result = await ingestDeviceReadings({
                deviceId: prepared.deviceId,
                apiKey: prepared.apiKey,
                timestamp: prepared.timestamp,
                readings: prepared.readings
            });
        } else {
            if (!bridgeAuth.trustedBridge && bridgeAuth.tokenConfigured) { // RAYAT-FIX
                return sendSensorUpdateUnauthorized(res); // RAYAT-FIX
            } // RAYAT-FIX

            try {
                result = await ingestTrustedReadings({
                    deviceId: bridgeAuth.trustedBridge ? prepared.deviceId : '',
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

        res.json({
            success: true,
            device_id: result.deviceId || null,
            mode: result.mode || 'device',
            readings_count: result.insertedReadings.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        if (error.statusCode === 401) { // RAYAT-FIX
            return sendSensorUpdateUnauthorized(res); // RAYAT-FIX
        } // RAYAT-FIX

        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }

        console.error('Sensor bridge update error:', error);
        res.status(500).json({ error: 'Errore nel salvataggio dati sensori' });
    }
});

router.get('/status', authenticateToken, checkSubscription, async (req, res) => { // RAYAT-FIX
    try { // RAYAT-FIX
        res.json(await resolveGatewayStatusPayload({ userId: req.user.id })); // RAYAT-FIX
    } catch (error) { // RAYAT-FIX
        console.error('Get gateway status error:', error); // RAYAT-FIX
        res.status(500).json({ error: 'Errore nel recupero stato gateway' }); // RAYAT-FIX
    } // RAYAT-FIX
}); // RAYAT-FIX

// GET /api/sensors/latest - Ultimi dati di tutti i sensori dell'utente
router.get('/latest', authenticateToken, checkSubscription, async (req, res) => {
    try {
        const userId = req.user.id;
        const offlineIntervalLiteral = getPostgresMinuteIntervalLiteral(getOfflineAfterMinutes());

        const sql = `
  SELECT 
    s.id as sensor_id,
    s.type,
    s.subtype,
    s.name,
    s.unit,
    sl.value,
    sl.timestamp,
    d.device_id,
    d.name as device_name,
    d.status as device_status,
    d.last_seen,
    CASE
      WHEN d.last_seen IS NULL THEN 'never'
      WHEN d.last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}' THEN 'online'
      ELSE 'offline'
    END AS online_status
  FROM sensors s
  INNER JOIN devices d ON s.device_id = d.id
  LEFT JOIN sensor_latest sl ON s.id = sl.sensor_id
  WHERE d.user_id = ? 
    AND s.enabled = TRUE
  ORDER BY s.type, s.subtype
`;

        const readings = normalizeSoilReadingPairs(await query(sql, [userId]), { includeTimestamp: true });

        // Raggruppa per tipo di sensore per frontend
        const grouped = {
            energia: {},
            acqua: {},
            terreno: {},
            clima: {}
        };

        readings.forEach(reading => {
            const type = reading.type;
            const subtype = reading.subtype || type;

            if (!grouped[type][subtype]) {
                grouped[type][subtype] = reading;
            }
        });

        res.json({
            success: true,
            data: readings,
            grouped: grouped,
            monitoring: getMonitoringConfig()
        });

    } catch (error) {
        console.error('Get latest sensors error:', error);
        res.status(500).json({ error: 'Errore nel recupero dati sensori' });
    }
});

// GET /api/sensors/:type/latest - Ultimi dati di un tipo di sensore specifico
router.get('/:type/latest', authenticateToken, checkSubscription, async (req, res) => {
    try {
        const userId = req.user.id;
        const sensorType = req.params.type;
        const offlineIntervalLiteral = getPostgresMinuteIntervalLiteral(getOfflineAfterMinutes());

        const sql = `
      SELECT 
        s.id as sensor_id,
        s.type,
        s.subtype,
        s.name,
        s.unit,
        sl.value,
        sl.timestamp,
        d.device_id,
        d.name as device_name,
        d.status as device_status,
        d.last_seen,
        CASE
          WHEN d.last_seen IS NULL THEN 'never'
          WHEN d.last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}' THEN 'online'
          ELSE 'offline'
        END AS online_status
      FROM sensors s
      INNER JOIN devices d ON s.device_id = d.id
      INNER JOIN sensor_latest sl ON s.id = sl.sensor_id
      WHERE d.user_id = ? 
        AND s.type = ?
        AND s.enabled = TRUE
    `;

        const readings = normalizeSoilReadingPairs(await query(sql, [userId, sensorType]), { includeTimestamp: true });
        res.json({
            success: true,
            data: readings,
            monitoring: getMonitoringConfig()
        });

    } catch (error) {
        console.error('Get sensor type error:', error);
        res.status(500).json({ error: 'Errore nel recupero dati sensore' });
    }
});

// GET /api/sensors/:type/history - Storico sensore (ultimi N giorni)
router.get('/:type/history', authenticateToken, checkSubscription, async (req, res) => {
    try {
        const userId = req.user.id;
        const sensorType = req.params.type;
        const subtype = req.query.subtype; // Opzionale per sensori multi-parametro
        const { startDate, endDate } = resolveHistoryRange(req.query);

        let sql = `
      SELECT 
        sr.value,
        sr.timestamp,
        s.subtype,
        s.unit
      FROM sensor_readings sr
      INNER JOIN sensors s ON sr.sensor_id = s.id
      INNER JOIN devices d ON s.device_id = d.id
      WHERE d.user_id = ? 
        AND s.type = ?
        AND sr.timestamp >= ?
        AND sr.timestamp <= ?
    `;

        const params = [userId, sensorType, startDate, endDate];

        // Se specificato subtype (es: terreno_moisture)
        if (subtype) {
            sql += ' AND s.subtype = ?';
            params.push(subtype);
        }

        sql += ' ORDER BY sr.timestamp DESC';

        const history = normalizeSoilReadingPairs(await query(sql, params), { includeTimestamp: true });

        // Formatta per grafico frontend
        const chartData = history.map(h => ({
            value: parseFloat(h.value),
            timestamp: h.timestamp,
            subtype: h.subtype
        }));

        res.json({
            success: true,
            data: chartData,
            count: chartData.length,
            range: {
                start: startDate.toISOString(),
                end: endDate.toISOString()
            }
        });

    } catch (error) {
        console.error('Get sensor history error:', error);
        res.status(500).json({ error: 'Errore nel recupero storico sensore' });
    }
});

// GET /api/sensors/alerts - Allarmi attivi
router.get('/alerts', authenticateToken, checkSubscription, async (req, res) => {
    try {
        const userId = req.user.id;

        const sql = `
      SELECT 
        aa.id,
        aa.alert_type,
        aa.message,
        aa.reading_value,
        aa.threshold_value,
        aa.acknowledged,
        aa.created_at,
        s.type as sensor_type,
        s.subtype,
        s.name as sensor_name
      FROM active_alerts aa
      INNER JOIN sensors s ON aa.sensor_id = s.id
      WHERE aa.user_id = ? 
        AND aa.acknowledged = FALSE
      ORDER BY aa.created_at DESC
    `;

        const alerts = await query(sql, [userId]);
        res.json({ success: true, data: alerts, count: alerts.length });

    } catch (error) {
        console.error('Get alerts error:', error);
        res.status(500).json({ error: 'Errore nel recupero allarmi' });
    }
});

// POST /api/sensors/alarm-events/sync - Sincronizza alert crop-aware dalla dashboard
router.post('/alarm-events/sync', authenticateToken, checkSubscription, async (req, res) => {
    try {
        const userId = req.user.id;
        const incomingEvents = Array.isArray(req.body.events) ? req.body.events.slice(0, 50) : [];

        for (const event of incomingEvents) {
            const level = String(event.level || 'normal').trim();
            const sensorType = String(event.sensorType || '').trim();
            const sensorSubtype = String(event.sensorSubtype || '').trim();
            const param = String(event.param || '').trim();
            const value = Number(event.value);

            if (!sensorType || !param) {
                continue;
            }

            if (level === 'normal') {
                await resolveAlarmEvent({
                    userId,
                    sensorType,
                    sensorSubtype: sensorSubtype || null,
                    param
                });
                continue;
            }

            if (!Number.isFinite(value)) {
                continue;
            }

            await upsertAlarmEvent({
                userId,
                sensorType,
                sensorSubtype: sensorSubtype || null,
                param,
                level,
                value,
                optimalMin: event.optimalMin ?? null,
                optimalMax: event.optimalMax ?? null,
                crop: event.crop ? String(event.crop).trim() : null
            });
        }

        res.json({
            success: true,
            processed: incomingEvents.length
        });
    } catch (error) {
        console.error('Sync alarm events error:', error);
        res.status(500).json({ error: 'Errore nella sincronizzazione degli allarmi' });
    }
});

// POST /api/sensors/alerts/:id/acknowledge - Conferma lettura allarme
router.post('/alerts/:id/acknowledge', authenticateToken, checkSubscription, async (req, res) => {
    try {
        const userId = req.user.id;
        const alertId = req.params.id;

        await query(
            'UPDATE active_alerts SET acknowledged = TRUE, acknowledged_at = NOW() WHERE id = ? AND user_id = ?',
            [alertId, userId]
        );

        res.json({ success: true, message: 'Allarme confermato' });

    } catch (error) {
        console.error('Acknowledge alert error:', error);
        res.status(500).json({ error: 'Errore nella conferma allarme' });
    }
});

// GET /api/sensors/thresholds - Ottieni soglie allarmi utente
router.get('/thresholds', authenticateToken, checkSubscription, async (req, res) => {
    try {
        const userId = req.user.id;

        const thresholds = await query(
            'SELECT * FROM alert_thresholds WHERE user_id = ? AND enabled = TRUE',
            [userId]
        );

        res.json({ success: true, data: thresholds });

    } catch (error) {
        console.error('Get thresholds error:', error);
        res.status(500).json({ error: 'Errore nel recupero soglie' });
    }
});

// PUT /api/sensors/thresholds - Aggiorna soglie allarmi
router.put('/thresholds', authenticateToken, checkSubscription, async (req, res) => {
    try {
        const userId = req.user.id;
        const { thresholds } = req.body; // Array di soglie

        // Elimina soglie esistenti
        await query('DELETE FROM alert_thresholds WHERE user_id = ?', [userId]);

        // Inserisci nuove soglie
        for (const threshold of thresholds) {
            await query(
                'INSERT INTO alert_thresholds (user_id, sensor_type, threshold_type, threshold_value, enabled) VALUES (?, ?, ?, ?, ?)',
                [userId, threshold.sensor_type, threshold.threshold_type, threshold.threshold_value, true]
            );
        }

        res.json({ success: true, message: 'Soglie aggiornate con successo' });

    } catch (error) {
        console.error('Update thresholds error:', error);
        res.status(500).json({ error: 'Errore nell\'aggiornamento soglie' });
    }
});

module.exports = router;
