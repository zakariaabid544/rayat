const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticateToken, checkSubscription } = require('../middleware/auth');
const { upsertAlarmEvent, resolveAlarmEvent } = require('../utils/alerts');

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
    d.name as device_name
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
        sl.timestamp
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
        const days = parseInt(req.query.days) || 30;
        const subtype = req.query.subtype; // Opzionale per sensori multi-parametro

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
        AND sr.timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY)
    `;

        const params = [userId, sensorType, days];

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
            count: chartData.length
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
