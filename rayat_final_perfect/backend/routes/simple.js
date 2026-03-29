const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

// GET /api/sensors/latest - Formato semplificato per compatibilità
router.get('/latest', async (req, res) => {
    try {
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

        const readings = await query(sql);

        // Mappa i dati al formato semplificato
        const result = {
            co2: null,
            temperature: null,
            humidity: null,
            soil: null,
            water: null,
            energy: null
        };

        readings.forEach(reading => {
            switch (reading.subtype) {
                case 'clima_temperature':
                    result.temperature = parseFloat(reading.value);
                    break;
                case 'clima_humidity':
                    result.humidity = parseFloat(reading.value);
                    break;
                case 'terreno_moisture':
                    result.soil = parseFloat(reading.value);
                    break;
                case 'acqua_level':
                    result.water = parseFloat(reading.value);
                    break;
                case 'energia_consumption':
                    result.energy = parseFloat(reading.value);
                    break;
            }
        });

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
