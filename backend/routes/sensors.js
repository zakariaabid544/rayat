const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticateToken, checkSubscription } = require('../middleware/auth');
const { upsertAlarmEvent, resolveAlarmEvent } = require('../utils/alerts');
const {
    VALID_SENSOR_TYPES,
    createHttpError,
    getSensorProfile,
    buildReadingsFromFlatPayload,
    ingestDeviceReadings,
    ingestTrustedReadings,
    ingestPublicReadings
} = require('../utils/sensor-ingest');

const DEFAULT_BRIDGE_TOKEN_HEADER = 'x-rayat-bridge-token';
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
    const flatReadings = buildReadingsFromFlatPayload(payloadObject || body)
        .map((reading) => buildReading(reading, {
            ...readingDefaults,
            type: reading.type,
            subtype: reading.subtype
        }));

    if (rawReadings) {
        readings = rawReadings.map((reading) => buildReading(reading, readingDefaults));
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

function getBridgeAuthorization(req) {
    const configuredToken = cleanString(process.env.MQTT_INGEST_TOKEN);
    const headerName = cleanString(process.env.MQTT_INGEST_TOKEN_HEADER) || DEFAULT_BRIDGE_TOKEN_HEADER;

    if (!configuredToken) {
        return {
            tokenConfigured: false,
            trustedBridge: false
        };
    }

    return {
        tokenConfigured: true,
        trustedBridge: cleanString(req.get(headerName)) === configuredToken
    };
}

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

// GET /api/sensors/public/latest - Ultimi dati pubblici per la demo senza login
router.get('/public/latest', async (_req, res) => {
    try {
        const rows = await query(
            `SELECT
                sensor_type AS type,
                sensor_subtype AS subtype,
                value,
                topic,
                timestamp,
                CASE
                    WHEN timestamp >= NOW() - INTERVAL '10 minutes' THEN 'online'
                    ELSE 'offline'
                END AS online_status
             FROM public_sensor_latest
             ORDER BY sensor_type ASC, sensor_subtype ASC`
        );

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error('Get public latest sensors error:', error);
        res.status(500).json({ error: 'Errore nel recupero dati sensori pubblici' });
    }
});

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

        sql += ' ORDER BY timestamp ASC, sensor_subtype ASC';

        const rows = await query(sql, params);

        res.json({
            success: true,
            data: rows.map((row) => ({
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
            if (bridgeAuth.tokenConfigured && !bridgeAuth.trustedBridge) {
                return res.status(401).json({ error: 'Bridge token non valido' });
            }

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
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }

        console.error('Sensor bridge update error:', error);
        res.status(500).json({ error: 'Errore nel salvataggio dati sensori' });
    }
});

// GET /api/sensors/latest - Ultimi dati di tutti i sensori dell'utente
router.get('/latest', authenticateToken, checkSubscription, async (req, res) => {
    try {
        const userId = req.user.id;

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
      WHEN d.last_seen >= NOW() - INTERVAL '10 minutes' THEN 'online'
      ELSE 'offline'
    END AS online_status
  FROM sensors s
  INNER JOIN devices d ON s.device_id = d.id
  LEFT JOIN sensor_latest sl ON s.id = sl.sensor_id
  WHERE d.user_id = ? 
    AND s.enabled = TRUE
  ORDER BY s.type, s.subtype
`;

        const readings = await query(sql, [userId]);

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
            grouped: grouped
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
          WHEN d.last_seen >= NOW() - INTERVAL '10 minutes' THEN 'online'
          ELSE 'offline'
        END AS online_status
      FROM sensors s
      INNER JOIN devices d ON s.device_id = d.id
      INNER JOIN sensor_latest sl ON s.id = sl.sensor_id
      WHERE d.user_id = ? 
        AND s.type = ?
        AND s.enabled = TRUE
    `;

        const readings = await query(sql, [userId, sensorType]);
        res.json({ success: true, data: readings });

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

        sql += ' ORDER BY sr.timestamp ASC';

        const history = await query(sql, params);

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
