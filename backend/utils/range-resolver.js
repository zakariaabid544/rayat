// Rayat Intelligence — Sprint 1.1 · Range Resolver (additivo, sola lettura)
// Risolve il range agronomico EFFETTIVO per (user, sensore, metrica) riusando SOLO
// fonti esistenti. Priorità: crop_profiles.ranges -> alert_thresholds -> alarm_events snapshot.
// Nessuna soglia inventata: se nessuna fonte fornisce un range, ritorna null (astensione).
const { query } = require('../config/database');

// Mappa subtype sensore -> chiave metrica usata in crop_profiles.ranges (allineata al frontend public.js)
const SUBTYPE_TO_METRIC = {
    terreno_moisture: 'moisture',
    terreno_temperature: 'temperature',
    terreno_ec: 'ec',
    terreno_ph: 'pH',
    terreno_n: 'nitrogen',
    terreno_nitrogen: 'nitrogen',
    terreno_p: 'phosphorus',
    terreno_phosphorus: 'phosphorus',
    terreno_k: 'potassium',
    terreno_potassium: 'potassium',
    clima_temperature: 'temperature',
    clima_humidity: 'humidity',
    clima_co2: 'co2',
    clima_wind_speed: 'windSpeed'
};

function metricKeyForSensor(sensor) {
    if (!sensor) {
        return null;
    }
    const subtype = String(sensor.subtype || '').trim().toLowerCase();
    if (SUBTYPE_TO_METRIC[subtype]) {
        return SUBTYPE_TO_METRIC[subtype];
    }
    // Fallback tollerante: rimuovi prefisso tipo e mappa alias comuni
    const stripped = subtype.replace(/^(terreno|clima|acqua|energia)_/, '');
    const alias = {
        moisture: 'moisture', humidity: 'humidity', temperature: 'temperature',
        ec: 'ec', ph: 'pH', n: 'nitrogen', nitrogen: 'nitrogen',
        p: 'phosphorus', phosphorus: 'phosphorus', k: 'potassium', potassium: 'potassium', co2: 'co2'
    };
    return alias[stripped] || null;
}

// Estrae { min, max } da un oggetto ranges JSONB { metric: { min, max, unit } }, tollerante al casing
function pickRange(rangesObj, metricKey) {
    if (!rangesObj || typeof rangesObj !== 'object' || !metricKey) {
        return null;
    }
    let entry = rangesObj[metricKey];
    if (!entry) {
        const lower = String(metricKey).toLowerCase();
        for (const key of Object.keys(rangesObj)) {
            if (String(key).toLowerCase() === lower) {
                entry = rangesObj[key];
                break;
            }
        }
    }
    if (!entry || typeof entry !== 'object') {
        return null;
    }
    const min = Number(entry.min);
    const max = Number(entry.max);
    if (!Number.isFinite(min) && !Number.isFinite(max)) {
        return null;
    }
    return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
}

async function resolveEffectiveRange({ userId, sensor }) {
    const metric = metricKeyForSensor(sensor);
    if (!metric) {
        return null; // nessun mapping metrica -> astensione
    }
    const fullType = sensor.subtype || sensor.type;

    // 1) crop_profiles.ranges (per la coltura del cliente)
    try {
        if (userId) {
            const userRows = await query('SELECT crop_type FROM users WHERE id = ? LIMIT 1', [userId]);
            const cropKey = userRows[0] && userRows[0].crop_type ? String(userRows[0].crop_type).trim() : null;
            if (cropKey) {
                const profRows = await query(
                    `SELECT ranges FROM crop_profiles
                     WHERE active = TRUE AND LOWER(crop_key) = LOWER(?)
                     ORDER BY updated_at DESC LIMIT 1`,
                    [cropKey]
                );
                if (profRows.length) {
                    let ranges = profRows[0].ranges;
                    if (typeof ranges === 'string') {
                        try { ranges = JSON.parse(ranges); } catch (parseError) { ranges = null; }
                    }
                    const r = pickRange(ranges, metric);
                    if (r) {
                        return { metric, min: r.min, max: r.max, source: 'crop_profile', confidence: 0.9 };
                    }
                }
            }
        }
    } catch (error) {
        console.error('[range-resolver] crop_profiles lookup failed:', error.message);
    }

    // 2) alert_thresholds utente (min/max)
    try {
        if (userId) {
            const rows = await query(
                'SELECT threshold_type, threshold_value FROM alert_thresholds WHERE user_id = ? AND sensor_type = ? AND enabled = TRUE',
                [userId, fullType]
            );
            if (rows.length) {
                let min = null;
                let max = null;
                for (const row of rows) {
                    if (row.threshold_type === 'min') { min = Number(row.threshold_value); }
                    if (row.threshold_type === 'max') { max = Number(row.threshold_value); }
                }
                if (Number.isFinite(min) || Number.isFinite(max)) {
                    return {
                        metric,
                        min: Number.isFinite(min) ? min : null,
                        max: Number.isFinite(max) ? max : null,
                        source: 'alert_thresholds',
                        confidence: 0.75
                    };
                }
            }
        }
    } catch (error) {
        console.error('[range-resolver] alert_thresholds lookup failed:', error.message);
    }

    // 3) alarm_events snapshot (optimal_min/max gia crop-aware, sincronizzato dal frontend)
    try {
        const rows = await query(
            `SELECT optimal_min, optimal_max FROM alarm_events
             WHERE (sensor_id = ? OR (user_id = ? AND param = ?))
               AND (optimal_min IS NOT NULL OR optimal_max IS NOT NULL)
             ORDER BY updated_at DESC LIMIT 1`,
            [sensor.id || null, userId || null, fullType]
        );
        if (rows.length) {
            const min = rows[0].optimal_min != null ? Number(rows[0].optimal_min) : null;
            const max = rows[0].optimal_max != null ? Number(rows[0].optimal_max) : null;
            if (Number.isFinite(min) || Number.isFinite(max)) {
                return {
                    metric,
                    min: Number.isFinite(min) ? min : null,
                    max: Number.isFinite(max) ? max : null,
                    source: 'alarm_events_snapshot',
                    confidence: 0.6
                };
            }
        }
    } catch (error) {
        console.error('[range-resolver] alarm_events snapshot lookup failed:', error.message);
    }

    // 4) Nessun range effettivo -> astensione (nessuna soglia agronomica inventata)
    return null;
}

module.exports = { resolveEffectiveRange, metricKeyForSensor };
