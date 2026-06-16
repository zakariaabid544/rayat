const express = require('express');

const { query } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { resolveCustomerScope } = require('../utils/customer-access');
const { sendDatabaseAwareError } = require('../utils/database-http');
const { ingestDeviceReadings, prepareIncomingSensorPayload } = require('../utils/sensor-ingest');

const router = express.Router();

function getRequestIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return (forwarded || String(req.ip || '').trim()).replace(/^::ffff:/, '');
}

// POST /api/iot/upload - Endpoint per dispositivi IoT (HTTP POST)
router.post('/upload', async (req, res) => {
    try {
        const prepared = prepareIncomingSensorPayload(req.body);
        const {
            deviceId: device_id,
            apiKey: api_key,
            timestamp,
            readings
        } = prepared;

        if (!device_id || !readings.length) {
            return res.status(400).json({
                error: 'Dati mancanti o non validi',
                required: ['device_id', 'readings | flat_payload']
            });
        }

        if (readings.length > 100) {
            return res.status(400).json({ error: 'Massimo 100 letture per richiesta' });
        }
        const result = await ingestDeviceReadings({
            deviceId: device_id,
            apiKey: api_key,
            timestamp,
            readings,
            requestIp: getRequestIp(req)
        });

        res.json({
            success: true,
            message: 'Dati ricevuti con successo',
            device_id,
            readings_count: result.insertedReadings.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('IoT upload error:', error);
        return sendDatabaseAwareError(res, error, {
            fallbackMessage: 'Errore nel salvataggio dati',
            databaseMessage: 'Persistenza dati IoT temporaneamente non disponibile'
        });
    }
});

// GET /api/iot/devices - Lista dispositivi dell'utente autenticato
router.get('/devices', authenticateToken, async (req, res) => {
    try {
        const devices = await query(
            `SELECT
                d.id,
                d.device_id,
                d.name,
                d.status,
                d.last_seen,
                d.created_at,
                COALESCE(sm.sensor_count, 0) AS sensor_count,
                sm.sensor_types,
                sm.last_reading
             FROM devices d
             LEFT JOIN (
                SELECT
                    s.device_id,
                    COUNT(*) AS sensor_count,
                    GROUP_CONCAT(DISTINCT s.type ORDER BY s.type SEPARATOR ',') AS sensor_types,
                    MAX(sl.timestamp) AS last_reading
                FROM sensors s
                LEFT JOIN sensor_latest sl ON sl.sensor_id = s.id
                WHERE s.enabled = TRUE
                GROUP BY s.device_id
             ) sm ON sm.device_id = d.id
             WHERE d.user_id = ?
             ORDER BY d.created_at DESC, d.id DESC`,
            [resolveCustomerScope(req.user)]
        );

        res.json({
            success: true,
            data: devices
        });
    } catch (error) {
        console.error('Get devices error:', error);
        return sendDatabaseAwareError(res, error, {
            fallbackMessage: 'Errore nel recupero dispositivi',
            databaseMessage: 'Elenco dispositivi temporaneamente non disponibile'
        });
    }
});

module.exports = router;
