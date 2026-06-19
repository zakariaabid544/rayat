'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { ensureMetricForecastSchema } = require('../utils/metric-forecast');
const { ensureBreachEtaSchema } = require('../utils/breach-eta');
const {
    runMetricForecastCycle,
    isEnabled: forecastEnabled
} = require('../src/jobs/metricForecastJob');
const {
    runBreachEtaCycle,
    isEnabled: breachEnabled
} = require('../src/jobs/breachEtaJob');

const NOW = new Date('2026-06-20T12:00:00.000Z');

function postgresExecutor(db) {
    return async (sql, params = []) => {
        if (!params.length) {
            const results = await db.exec(String(sql));
            const last = results[results.length - 1];
            return (last && last.rows) || [];
        }
        let index = 0;
        const translated = String(sql).replace(/\?/g, () => `$${++index}`);
        const result = await db.query(translated, params);
        return result.rows || [];
    };
}

async function snapshot(executor, tables) {
    const result = {};
    for (const table of tables) {
        const rows = await executor(
            `SELECT COALESCE(jsonb_agg(to_jsonb(source) ORDER BY source.id), '[]'::jsonb) AS rows FROM ${table} source`
        );
        result[table] = rows[0].rows;
    }
    return result;
}

async function insertSeries(executor, sensorId, values) {
    const start = NOW.getTime() - (values.length - 1) * 3600000;
    for (let index = 0; index < values.length; index += 1) {
        await executor(
            'INSERT INTO sensor_readings (sensor_id, value, timestamp) VALUES (?, ?, ?)',
            [sensorId, values[index], new Date(start + index * 3600000).toISOString()]
        );
    }
}

async function forecastSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, sensor_id, metric, generated_at,
                horizon_minutes, current_value, forecast_value, forecast_low, forecast_high,
                slope_per_hour, method, confidence, data_quality_score, evidence_json, rule_version
         FROM agro_metric_forecasts
         ORDER BY owner_user_id, device_id, context_id, sensor_id, horizon_minutes`
    );
}

async function breachSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, sensor_id, metric, generated_at,
                breach_direction, eta_minutes, eta_confidence, current_value,
                predicted_breach_value, threshold_value, horizon_minutes, status,
                severity, evidence_json, rule_version
         FROM agro_breach_eta
         ORDER BY owner_user_id, device_id, context_id, sensor_id, horizon_minutes`
    );
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const protectedTables = [
        'sensor_readings', 'alarm_events', 'active_alerts', 'users', 'devices', 'sensors'
    ];
    try {
        const forecastFlag = process.env.AGRO_METRIC_FORECAST_ENABLED;
        const breachFlag = process.env.AGRO_BREACH_ETA_ENABLED;
        delete process.env.AGRO_METRIC_FORECAST_ENABLED;
        delete process.env.AGRO_BREACH_ETA_ENABLED;
        assert.equal(await forecastEnabled({ executor }), false);
        assert.equal(await breachEnabled({ executor }), false);
        if (forecastFlag !== undefined) { process.env.AGRO_METRIC_FORECAST_ENABLED = forecastFlag; }
        if (breachFlag !== undefined) { process.env.AGRO_BREACH_ETA_ENABLED = breachFlag; }

        await executor(`
          CREATE TABLE users (id INTEGER PRIMARY KEY, owner_user_id INTEGER NULL REFERENCES users(id));
          CREATE TABLE devices (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
          CREATE TABLE sensors (
            id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id),
            type VARCHAR(32) NOT NULL, subtype VARCHAR(50), enabled BOOLEAN DEFAULT TRUE);
          CREATE TABLE sensor_readings (
            id BIGSERIAL PRIMARY KEY, sensor_id INTEGER NOT NULL REFERENCES sensors(id),
            value NUMERIC NOT NULL, timestamp TIMESTAMPTZ NOT NULL);
          CREATE TABLE alarm_events (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER);
          CREATE TABLE active_alerts (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER);
          CREATE TABLE agro_context_segments (
            id BIGINT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
            device_id INTEGER NOT NULL REFERENCES devices(id), sensor_id INTEGER NULL REFERENCES sensors(id),
            usage_type VARCHAR(20) NOT NULL, is_production BOOLEAN NOT NULL,
            valid_from TIMESTAMPTZ NOT NULL, valid_to TIMESTAMPTZ NULL);
          CREATE TABLE agro_greenhouse_baselines (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, metric VARCHAR(80) NOT NULL,
            stddev_value NUMERIC, confidence NUMERIC, data_quality_score NUMERIC);
        `);
        await executor('INSERT INTO users (id) VALUES (1), (2)');
        await executor('INSERT INTO devices (id, user_id) VALUES (10, 1), (20, 2), (30, 1)');
        await executor(
            `INSERT INTO sensors (id, device_id, type, subtype, enabled) VALUES
             (1000, 10, 'clima', 'clima_temperature', TRUE),
             (1001, 10, 'clima', 'clima_humidity', TRUE),
             (1002, 10, 'clima', 'clima_co2', TRUE),
             (1003, 10, 'clima', 'clima_temperature', TRUE),
             (1004, 10, 'terreno', 'terreno_ec', TRUE),
             (1010, 10, 'clima', 'clima_temperature', TRUE),
             (1020, 10, 'clima', 'clima_temperature', TRUE),
             (1030, 30, 'clima', 'clima_temperature', TRUE),
             (2000, 20, 'clima', 'clima_temperature', TRUE)`
        );
        await executor(
            `INSERT INTO agro_context_segments
              (id, owner_user_id, device_id, sensor_id, usage_type, is_production, valid_from)
             VALUES (100, 1, 10, NULL, 'production', TRUE, '2026-06-01'),
                    (101, 1, 10, 1010, 'production', TRUE, '2026-06-10'),
                    (102, 1, 10, 1020, 'demo', FALSE, '2026-06-10'),
                    (200, 2, 20, NULL, 'production', TRUE, '2026-06-01')`
        );
        await executor(
            `INSERT INTO agro_greenhouse_baselines
              (owner_user_id, device_id, context_id, metric, stddev_value, confidence, data_quality_score)
             VALUES (1, 10, 100, 'temperature', 2, 0.8, 0.8),
                    (1, 10, 100, 'humidity', 2, 0.8, 0.8),
                    (1, 10, 100, 'co2', 3, 0.8, 0.8),
                    (1, 10, 100, 'ec', 0.5, 0.7, 0.7),
                    (1, 10, 101, 'temperature', 1, 0.8, 0.8),
                    (2, 20, 200, 'temperature', 2, 0.8, 0.8)`
        );
        await insertSeries(executor, 1000, [80, 82, 84, 86, 88, 90, 92, 94, 96, 98]);
        await insertSeries(executor, 1001, [40, 38, 36, 34, 32, 30, 28, 26, 24, 22]);
        await insertSeries(executor, 1002, Array(10).fill(50));
        await insertSeries(executor, 1003, [110, 112, 114, 116, 118, 120, 120, 120, 120, 120]);
        await insertSeries(executor, 1004, [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9]);
        await insertSeries(executor, 1010, [60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
        await insertSeries(executor, 1020, [30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
        await insertSeries(executor, 1030, [10, 11, 12, 13, 14, 15]);
        await insertSeries(executor, 2000, [200, 201, 202, 203, 204, 205, 206, 207, 208, 209]);
        await executor('INSERT INTO alarm_events (sensor_id) VALUES (1000)');
        await executor('INSERT INTO active_alerts (sensor_id) VALUES (1000)');

        await ensureMetricForecastSchema({ executor, ensureContext: async () => {} });
        await ensureBreachEtaSchema({ executor, ensureContext: async () => {} });
        const constraints = await executor(
            `SELECT conname FROM pg_constraint
             WHERE conrelid IN ('agro_metric_forecasts'::regclass, 'agro_breach_eta'::regclass)`
        );
        const constraintNames = new Set(constraints.map((row) => row.conname));
        assert.ok(constraintNames.has('uniq_metric_forecast'));
        assert.ok(constraintNames.has('metric_forecast_values_check'));
        assert.ok(constraintNames.has('uniq_breach_eta'));
        assert.ok(constraintNames.has('breach_eta_values_check'));

        const protectedBefore = await snapshot(executor, protectedTables);
        const baselineBefore = await snapshot(executor, ['agro_greenhouse_baselines']);
        const dryForecast = await runMetricForecastCycle({
            dryRun: true, generatedAt: NOW, executor
        });
        assert.equal(dryForecast.sensors, 7);
        assert.equal(dryForecast.forecast_rows, 35);
        assert.equal((await forecastSnapshot(executor)).length, 0, 'forecast dry-run writes nothing');
        const includeDemo = await runMetricForecastCycle({
            dryRun: true, generatedAt: NOW, includeNonProduction: true, executor
        });
        assert.equal(includeDemo.sensors, 8, 'non-production is opt-in');
        assert.equal(includeDemo.forecast_rows, 40);

        const firstForecast = await runMetricForecastCycle({
            generatedAt: NOW, executor, ensureContext: async () => {}
        });
        assert.equal(firstForecast.stored, 35);
        let forecasts = await forecastSnapshot(executor);
        assert.equal(forecasts.length, 35);
        assert.equal(forecasts.filter((row) => Number(row.owner_user_id) === 1).length, 30);
        assert.equal(forecasts.filter((row) => Number(row.context_id) === 100).length, 25);
        assert.equal(forecasts.filter((row) => Number(row.context_id) === 101).length, 5);
        assert.equal(forecasts.some((row) => Number(row.context_id) === 102), false);
        assert.equal(forecasts.some((row) => Number(row.sensor_id) === 1030), false, 'missing context skipped');
        assert.equal(forecasts.every((row) => Number(row.confidence) >= 0 && Number(row.confidence) <= 1), true);

        const forecastBusinessOne = JSON.stringify(forecasts);
        await runMetricForecastCycle({ generatedAt: NOW, executor });
        forecasts = await forecastSnapshot(executor);
        assert.equal(JSON.stringify(forecasts), forecastBusinessOne, 'forecast rerun deterministic');
        assert.equal(forecasts.length, 35, 'forecast rerun idempotent');

        const ranges = new Map([
            [1000, { min: 0, max: 100, confidence: 0.9, source: 'alert_thresholds' }],
            [1001, { min: 20, max: 100, confidence: 0.9, source: 'crop_profile' }],
            [1002, { min: 0, max: 100, confidence: 0.9, source: 'crop_profile' }],
            [1003, { min: 0, max: 100, confidence: 0.9, source: 'alert_thresholds' }],
            [1004, null],
            [1010, { min: 0, max: 150, confidence: 0.9, source: 'crop_profile' }],
            [2000, { min: 0, max: 300, confidence: 0.9, source: 'crop_profile' }]
        ]);
        const rangeResolver = async ({ sensor }) => ranges.get(Number(sensor.id)) || null;
        const dryBreach = await runBreachEtaCycle({ dryRun: true, executor, rangeResolver });
        assert.equal(dryBreach.breach_rows, 35);
        assert.equal((await breachSnapshot(executor)).length, 0, 'breach dry-run writes nothing');
        const forecastBeforeBreach = JSON.stringify(await forecastSnapshot(executor));
        const firstBreach = await runBreachEtaCycle({
            executor, rangeResolver, ensureContext: async () => {}
        });
        assert.equal(firstBreach.stored, 35);
        let breaches = await breachSnapshot(executor);
        assert.equal(breaches.length, 35);
        const rising = breaches.find((row) => Number(row.sensor_id) === 1000 && Number(row.horizon_minutes) === 180);
        assert.equal(rising.breach_direction, 'above_max');
        assert.ok(['breach_possible', 'breach_likely'].includes(rising.status));
        assert.ok(Number(rising.eta_minutes) > 0 && Number(rising.eta_minutes) <= 180);
        const falling = breaches.find((row) => Number(row.sensor_id) === 1001 && Number(row.horizon_minutes) === 180);
        assert.equal(falling.breach_direction, 'below_min');
        const stable = breaches.filter((row) => Number(row.sensor_id) === 1002);
        assert.equal(stable.every((row) => row.status === 'no_breach_expected'), true);
        const already = breaches.filter((row) => Number(row.sensor_id) === 1003);
        assert.equal(already.every((row) => row.status === 'already_breached' && Number(row.eta_minutes) === 0), true);
        const missing = breaches.filter((row) => Number(row.sensor_id) === 1004);
        assert.equal(missing.every((row) => row.status === 'insufficient_data' && row.threshold_value === null), true);
        assert.equal(JSON.stringify(await forecastSnapshot(executor)), forecastBeforeBreach, 'breach engine does not modify forecasts');

        const breachBusinessOne = JSON.stringify(breaches);
        await runBreachEtaCycle({ executor, rangeResolver });
        breaches = await breachSnapshot(executor);
        assert.equal(JSON.stringify(breaches), breachBusinessOne, 'breach rerun deterministic');
        assert.equal(breaches.length, 35, 'breach rerun idempotent');

        await assert.rejects(
            () => executor(
                `INSERT INTO agro_metric_forecasts
                  (owner_user_id, device_id, context_id, sensor_id, metric, generated_at,
                   horizon_minutes, current_value, forecast_value, forecast_low, forecast_high,
                   slope_per_hour, method, confidence, data_quality_score)
                 VALUES (2, 20, 100, 2000, 'temperature', ?, 60, 1, 1, 0, 2, 0,
                         'test', 0.5, 0.5)`,
                [NOW.toISOString()]
            ),
            /context mismatch/
        );
        await assert.rejects(
            () => executor(
                `INSERT INTO agro_metric_forecasts
                  (owner_user_id, device_id, context_id, sensor_id, metric, generated_at,
                   horizon_minutes, current_value, forecast_value, forecast_low, forecast_high,
                   slope_per_hour, method, confidence, data_quality_score)
                 VALUES (1, 10, 101, 1000, 'temperature', ?, 60, 1, 1, 0, 2, 0,
                         'test', 0.5, 0.5)`,
                [NOW.toISOString()]
            ),
            /context mismatch/
        );
        await assert.rejects(
            () => executor(
                `INSERT INTO agro_breach_eta
                  (owner_user_id, device_id, context_id, sensor_id, metric, generated_at,
                   breach_direction, eta_confidence, current_value, predicted_breach_value,
                   horizon_minutes, status, severity)
                 VALUES (2, 20, 100, 2000, 'temperature', ?, 'none', 0.5, 1, 1,
                         60, 'no_breach_expected', 'low')`,
                [NOW.toISOString()]
            ),
            /context mismatch/
        );
        assert.deepEqual(await snapshot(executor, protectedTables), protectedBefore, 'protected tables unchanged');
        assert.deepEqual(await snapshot(executor, ['agro_greenhouse_baselines']), baselineBefore, 'baselines unchanged');

        console.log('PASS embedded PostgreSQL metric forecast and breach ETA validation');
        console.log(JSON.stringify({
            forecasts: 35,
            breach_eta_rows: 35,
            owners: 2,
            production_contexts: 3,
            rising_crosses_max: true,
            falling_crosses_min: true,
            stable_no_breach: true,
            already_breached: true,
            missing_range_insufficient: true,
            missing_context_skipped: true,
            idempotent_deterministic: true,
            protected_tables_unchanged: true
        }));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
