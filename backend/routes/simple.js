const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

// GET /api/sensors/latest - Formato semplificato per compatibilità
router.get('/latest', async (req, res) => {
    try {
        const publicReadings = await query(
            `SELECT
                sensor_subtype AS subtype,
                value
             FROM public_sensor_latest`
        );

        // Query per ottenere ultimi valori di ogni tipo di sensore
        const sql = `
      SELECT
        s.subtype,
        sr.value
      FROM sensor_readings sr
      INNER JOIN sensors s ON sr.sensor_id = s.id
      WHERE sr.timestamp = (
        SELECT MAX(timestamp)
        FROM sensor_readings
        WHERE sensor_id = s.id
      )
      AND s.enabled = TRUE
    `;

        const dbReadings = await query(sql);
        const readingMap = new Map();

        for (const reading of dbReadings) {
            readingMap.set(reading.subtype, reading.value);
        }

        for (const reading of publicReadings) {
            readingMap.set(reading.subtype, reading.value);
        }

        // Mappa i dati al formato semplificato
        const result = {
            co2: null,
            temperature: null,
            humidity: null,
            soil: null,
            water: null,
            energy: null
        };

        for (const [subtype, value] of readingMap.entries()) {
            switch (subtype) {
                case 'clima_temperature':
                    result.temperature = parseFloat(value);
                    break;
                case 'clima_humidity':
                    result.humidity = parseFloat(value);
                    break;
                case 'clima_co2':
                    result.co2 = parseFloat(value);
                    break;
                case 'terreno_moisture':
                    result.soil = parseFloat(value);
                    break;
                case 'acqua_level':
                    result.water = parseFloat(value);
                    break;
                case 'energia_consumption':
                    result.energy = parseFloat(value);
                    break;
            }
        }

        res.json(result);

    } catch (error) {
        console.error('Get simple sensors error:', error);
        // Ritorna dati di fallback se database non disponibile
        res.json({
            co2: null,
            temperature: 28,
            humidity: 45,
            soil: 60,
            water: 14.2,
            energy: 2.3
        });
    }
});

module.exports = router;
