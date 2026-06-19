'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { ensureStressEtaSchema } = require('../utils/stress-eta');
const { ensureRiskForecastSchema } = require('../utils/risk-forecast');
const { runStressEtaCycle, isEnabled: stressEnabled } = require('../src/jobs/stressEtaJob');
const { runRiskForecastCycle, isEnabled: riskEnabled } = require('../src/jobs/riskForecastJob');

const NOW = new Date('2026-06-20T12:00:00.000Z');
const HORIZONS = [60, 180, 360, 720, 1440];

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

async function stressSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, generated_at, stress_type, eta_minutes,
                stress_probability, stress_confidence, current_score, predicted_score,
                risk_factors_json, evidence_json, status, severity, rule_version
         FROM agro_stress_eta ORDER BY owner_user_id, device_id, context_id, stress_type`
    );
}

async function riskSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, generated_at, forecast_horizon_minutes,
                overall_risk_score, overall_risk_band, risk_probability, confidence,
                predicted_health_score, predicted_intelligence_score, primary_risk,
                secondary_risks_json, positive_signals_json, evidence_json, rule_version
         FROM agro_risk_forecasts ORDER BY owner_user_id, device_id, context_id, forecast_horizon_minutes`
    );
}

async function addForecastSet(executor, values) {
    const { owner, device, context, sensor, current, predicted, confidence = 0.9, quality = 0.9 } = values;
    for (const horizon of HORIZONS) {
        await executor(
            `INSERT INTO agro_metric_forecasts
              (owner_user_id, device_id, context_id, sensor_id, generated_at, horizon_minutes,
               current_value, forecast_value, confidence, data_quality_score)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [owner, device, context, sensor, NOW.toISOString(), horizon, current,
                current + (predicted - current) * horizon / 1440, confidence, quality]
        );
    }
}

async function addBreachSet(executor, values) {
    const { owner, device, context, sensor, status, eta, confidence = 0.9 } = values;
    for (const horizon of HORIZONS) {
        const applies = status === 'already_breached' || (eta !== null && eta <= horizon);
        const resolvedStatus = status === 'already_breached'
            ? status
            : (applies ? status : 'no_breach_expected');
        await executor(
            `INSERT INTO agro_breach_eta
              (owner_user_id, device_id, context_id, sensor_id, horizon_minutes,
               status, eta_minutes, eta_confidence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [owner, device, context, sensor, horizon, resolvedStatus,
                applies ? eta : null, confidence]
        );
    }
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const protectedTables = ['sensor_readings', 'alarm_events', 'active_alerts', 'users', 'devices', 'sensors'];
    const sourceTables = ['agro_metric_forecasts', 'agro_breach_eta', 'agro_stress_memory',
        'agro_greenhouse_baselines', 'agro_intelligence_score', 'agro_intelligence_trends',
        'agro_greenhouse_health_profile'];
    try {
        const stressFlag = process.env.AGRO_STRESS_ETA_ENABLED;
        const riskFlag = process.env.AGRO_RISK_FORECAST_ENABLED;
        delete process.env.AGRO_STRESS_ETA_ENABLED;
        delete process.env.AGRO_RISK_FORECAST_ENABLED;
        assert.equal(await stressEnabled({ executor }), false);
        assert.equal(await riskEnabled({ executor }), false);
        if (stressFlag !== undefined) { process.env.AGRO_STRESS_ETA_ENABLED = stressFlag; }
        if (riskFlag !== undefined) { process.env.AGRO_RISK_FORECAST_ENABLED = riskFlag; }

        await executor(`
          CREATE TABLE users (id INTEGER PRIMARY KEY, owner_user_id INTEGER NULL REFERENCES users(id));
          CREATE TABLE devices (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
          CREATE TABLE sensors (id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id));
          CREATE TABLE sensor_readings (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER, value NUMERIC, timestamp TIMESTAMPTZ);
          CREATE TABLE alarm_events (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER);
          CREATE TABLE active_alerts (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER);
          CREATE TABLE agro_context_segments (
            id BIGINT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
            device_id INTEGER NOT NULL REFERENCES devices(id), sensor_id INTEGER NULL,
            usage_type VARCHAR(20) NOT NULL, is_production BOOLEAN NOT NULL,
            valid_from TIMESTAMPTZ NOT NULL, valid_to TIMESTAMPTZ NULL);
          CREATE TABLE agro_metric_forecasts (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, sensor_id INTEGER NOT NULL, generated_at TIMESTAMPTZ NOT NULL,
            horizon_minutes INTEGER NOT NULL, current_value NUMERIC NOT NULL, forecast_value NUMERIC NOT NULL,
            confidence NUMERIC NOT NULL, data_quality_score NUMERIC NOT NULL);
          CREATE TABLE agro_breach_eta (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, sensor_id INTEGER NOT NULL, horizon_minutes INTEGER NOT NULL,
            status VARCHAR(24) NOT NULL, eta_minutes INTEGER NULL, eta_confidence NUMERIC NOT NULL);
          CREATE TABLE agro_stress_memory (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, metric VARCHAR(80) NOT NULL, stress_type VARCHAR(40) NOT NULL,
            stress_count INTEGER NOT NULL, recurrence_score NUMERIC NOT NULL, stress_load_score NUMERIC NOT NULL,
            trend_direction VARCHAR(12) NOT NULL, confidence NUMERIC NOT NULL);
          CREATE TABLE agro_greenhouse_baselines (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, metric VARCHAR(80) NOT NULL, mean_value NUMERIC,
            stddev_value NUMERIC, confidence NUMERIC);
          CREATE TABLE agro_intelligence_score (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, intelligence_score NUMERIC NOT NULL, confidence NUMERIC NOT NULL);
          CREATE TABLE agro_intelligence_trends (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, metric VARCHAR(24) NOT NULL,
            trend_direction VARCHAR(20) NOT NULL, trend_confidence NUMERIC NOT NULL);
          CREATE TABLE agro_greenhouse_health_profile (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, health_score NUMERIC NOT NULL,
            recovery_score NUMERIC NOT NULL, confidence NUMERIC NOT NULL);
        `);
        await executor('INSERT INTO users (id) VALUES (1), (2)');
        await executor('INSERT INTO devices (id, user_id) VALUES (10, 1), (20, 2)');
        await executor('INSERT INTO sensors (id, device_id) VALUES (1000, 10), (1001, 10), (1002, 10), (2000, 20)');
        await executor("INSERT INTO sensor_readings (sensor_id, value, timestamp) VALUES (1000, 25, '2026-06-20')");
        await executor('INSERT INTO alarm_events (sensor_id) VALUES (1000)');
        await executor('INSERT INTO active_alerts (sensor_id) VALUES (1000)');
        await executor(
            `INSERT INTO agro_context_segments
              (id, owner_user_id, device_id, sensor_id, usage_type, is_production, valid_from)
             VALUES (100, 1, 10, NULL, 'production', TRUE, '2026-06-01'),
                    (101, 1, 10, NULL, 'production', TRUE, '2026-06-01'),
                    (102, 1, 10, NULL, 'demo', FALSE, '2026-06-01'),
                    (200, 2, 20, NULL, 'production', TRUE, '2026-06-01'),
                    (300, 2, 20, NULL, 'production', TRUE, '2026-06-01')`
        );

        await addForecastSet(executor, { owner: 1, device: 10, context: 100, sensor: 1000, current: 120, predicted: 130 });
        await addForecastSet(executor, { owner: 1, device: 10, context: 101, sensor: 1001, current: 50, predicted: 50 });
        await addForecastSet(executor, { owner: 1, device: 10, context: 102, sensor: 1002, current: 80, predicted: 100 });
        await addForecastSet(executor, { owner: 2, device: 20, context: 200, sensor: 2000, current: 70, predicted: 100 });
        await executor(
            `INSERT INTO agro_metric_forecasts
              (owner_user_id, device_id, context_id, sensor_id, generated_at, horizon_minutes,
               current_value, forecast_value, confidence, data_quality_score)
             VALUES (1, 10, 999, 1000, ?, 60, 1, 2, 0.9, 0.9)`, [NOW.toISOString()]
        );
        await addBreachSet(executor, { owner: 1, device: 10, context: 100, sensor: 1000,
            status: 'already_breached', eta: 0, confidence: 0.95 });
        await addBreachSet(executor, { owner: 1, device: 10, context: 101, sensor: 1001,
            status: 'no_breach_expected', eta: null, confidence: 0.9 });
        await addBreachSet(executor, { owner: 1, device: 10, context: 102, sensor: 1002,
            status: 'breach_likely', eta: 60, confidence: 0.9 });
        await addBreachSet(executor, { owner: 2, device: 20, context: 200, sensor: 2000,
            status: 'breach_likely', eta: 90, confidence: 0.95 });
        await executor(
            `INSERT INTO agro_stress_memory
              (owner_user_id, device_id, context_id, metric, stress_type, stress_count,
               recurrence_score, stress_load_score, trend_direction, confidence)
             VALUES (1,10,100,'temperature','out_of_range',30,0.95,95,'rising',0.95),
                    (1,10,102,'temperature','out_of_range',10,0.7,70,'rising',0.8),
                    (2,20,200,'temperature','out_of_range',30,0.95,90,'rising',0.95),
                    (2,20,200,'temperature','worsening',35,0.98,95,'rising',0.95)`
        );
        await executor(
            `INSERT INTO agro_greenhouse_baselines
              (owner_user_id, device_id, context_id, metric, mean_value, stddev_value, confidence)
             VALUES (1,10,100,'temperature',50,20,0.9), (1,10,101,'temperature',50,1,0.95),
                    (1,10,102,'temperature',50,10,0.8), (2,20,200,'temperature',50,20,0.9),
                    (2,20,300,'temperature',50,2,0.7)`
        );
        await executor(
            `INSERT INTO agro_intelligence_score
              (owner_user_id, device_id, context_id, intelligence_score, confidence)
             VALUES (1,10,100,10,0.95), (1,10,101,90,0.95), (1,10,102,40,0.8),
                    (2,20,200,25,0.9), (2,20,300,60,0.7)`
        );
        await executor(
            `INSERT INTO agro_intelligence_trends
              (owner_user_id, device_id, context_id, metric, trend_direction, trend_confidence)
             VALUES (1,10,100,'intelligence_score','degrading',0.95),
                    (1,10,101,'intelligence_score','improving',0.95),
                    (1,10,102,'intelligence_score','degrading',0.8),
                    (2,20,200,'intelligence_score','degrading',0.95),
                    (2,20,200,'stress','degrading',0.95),
                    (2,20,300,'intelligence_score','stable',0.7)`
        );
        await executor(
            `INSERT INTO agro_greenhouse_health_profile
              (owner_user_id, device_id, context_id, health_score, recovery_score, confidence)
             VALUES (1,10,100,10,10,0.95), (1,10,101,92,92,0.95),
                    (1,10,102,45,45,0.8), (2,20,200,25,25,0.9), (2,20,300,60,60,0.7)`
        );

        await ensureStressEtaSchema({ executor, ensureContext: async () => {} });
        await ensureRiskForecastSchema({ executor, ensureContext: async () => {} });
        const constraints = new Set((await executor(
            `SELECT conname FROM pg_constraint WHERE conrelid IN
              ('agro_stress_eta'::regclass, 'agro_risk_forecasts'::regclass)`
        )).map((row) => row.conname));
        assert.ok(constraints.has('uniq_stress_eta'));
        assert.ok(constraints.has('stress_eta_values_check'));
        assert.ok(constraints.has('uniq_risk_forecast'));
        assert.ok(constraints.has('risk_forecast_values_check'));

        const protectedBefore = await snapshot(executor, protectedTables);
        const sourcesBefore = await snapshot(executor, sourceTables);
        const dryStress = await runStressEtaCycle({ dryRun: true, generatedAt: NOW, executor });
        assert.equal(dryStress.contexts, 4);
        assert.equal((await stressSnapshot(executor)).length, 0, 'stress ETA dry-run writes nothing');
        const demoStress = await runStressEtaCycle({ dryRun: true, generatedAt: NOW,
            includeNonProduction: true, executor });
        assert.equal(demoStress.contexts, 5, 'non-production contexts are opt-in');

        const firstStress = await runStressEtaCycle({ generatedAt: NOW, executor, ensureContext: async () => {} });
        assert.equal(firstStress.contexts, 4);
        let stressRows = await stressSnapshot(executor);
        assert.equal(stressRows.some((row) => Number(row.context_id) === 102), false, 'demo context excluded');
        assert.equal(stressRows.some((row) => Number(row.context_id) === 999), false, 'invalid context skipped');
        assert.equal(stressRows.some((row) => Number(row.owner_user_id) === 1), true);
        assert.equal(stressRows.some((row) => Number(row.owner_user_id) === 2), true);
        assert.equal(stressRows.find((row) => Number(row.context_id) === 100 && row.stress_type === 'out_of_range').status,
            'already_under_stress');
        const imminent = stressRows.find((row) => Number(row.context_id) === 200 && row.stress_type === 'out_of_range');
        assert.ok(['stress_imminent', 'stress_likely'].includes(imminent.status));
        assert.equal(stressRows.find((row) => Number(row.context_id) === 101 && row.stress_type === 'out_of_range').status,
            'no_stress_expected');
        assert.equal(stressRows.find((row) => Number(row.context_id) === 300 && row.stress_type === 'out_of_range').status,
            'insufficient_data');
        const stressBusinessOne = JSON.stringify(stressRows);
        await runStressEtaCycle({ generatedAt: NOW, executor });
        stressRows = await stressSnapshot(executor);
        assert.equal(JSON.stringify(stressRows), stressBusinessOne, 'stress ETA rerun deterministic');
        assert.equal(new Set(stressRows.map((row) => `${row.owner_user_id}:${row.device_id}:${row.context_id}:${row.stress_type}`)).size,
            stressRows.length, 'stress ETA rerun idempotent');

        const dryRisk = await runRiskForecastCycle({ dryRun: true, generatedAt: NOW, executor });
        assert.equal(dryRisk.contexts, 4);
        assert.equal(dryRisk.risk_rows, 20);
        assert.equal((await riskSnapshot(executor)).length, 0, 'risk dry-run writes nothing');
        await runRiskForecastCycle({ generatedAt: NOW, executor, ensureContext: async () => {} });
        let riskRows = await riskSnapshot(executor);
        assert.equal(riskRows.length, 20);
        assert.equal(riskRows.some((row) => Number(row.context_id) === 102), false);
        assert.equal(riskRows.filter((row) => Number(row.owner_user_id) === 1).length, 10);
        assert.equal(riskRows.filter((row) => Number(row.owner_user_id) === 2).length, 10);
        const critical = riskRows.find((row) => Number(row.context_id) === 100 && Number(row.forecast_horizon_minutes) === 180);
        const recurring = riskRows.find((row) => Number(row.context_id) === 200 && Number(row.forecast_horizon_minutes) === 180);
        const healthy = riskRows.find((row) => Number(row.context_id) === 101 && Number(row.forecast_horizon_minutes) === 180);
        assert.equal(critical.overall_risk_band, 'critical');
        assert.ok(['high', 'critical'].includes(recurring.overall_risk_band));
        assert.ok(Number(healthy.overall_risk_score) < Number(recurring.overall_risk_score),
            'healthy greenhouse lowers risk');
        assert.ok(Number(recurring.overall_risk_score) > Number(healthy.overall_risk_score),
            'recurring stress and worsening trend increase risk');
        assert.ok(Number(critical.overall_risk_score) >= Number(recurring.overall_risk_score),
            'active breach raises consolidated risk');
        const riskBusinessOne = JSON.stringify(riskRows);
        await runRiskForecastCycle({ generatedAt: NOW, executor });
        riskRows = await riskSnapshot(executor);
        assert.equal(JSON.stringify(riskRows), riskBusinessOne, 'risk rerun deterministic');
        assert.equal(new Set(riskRows.map((row) => `${row.owner_user_id}:${row.device_id}:${row.context_id}:${row.forecast_horizon_minutes}`)).size,
            riskRows.length, 'risk rerun idempotent');

        await assert.rejects(() => executor(
            `INSERT INTO agro_stress_eta
              (owner_user_id, device_id, context_id, generated_at, stress_type, stress_probability,
               stress_confidence, current_score, predicted_score, status, severity)
             VALUES (2,20,100,?,'out_of_range',0.5,0.5,50,50,'stress_possible','medium')`,
            [NOW.toISOString()]), /context mismatch/);
        await assert.rejects(() => executor(
            `INSERT INTO agro_risk_forecasts
              (owner_user_id, device_id, context_id, generated_at, forecast_horizon_minutes,
               overall_risk_score, overall_risk_band,risk_probability,confidence,
               predicted_health_score,predicted_intelligence_score,primary_risk)
             VALUES (1,10,200,?,60,50,'medium',0.5,0.5,50,50,'test')`,
            [NOW.toISOString()]), /context mismatch/);

        assert.deepEqual(await snapshot(executor, protectedTables), protectedBefore, 'protected tables unchanged');
        assert.deepEqual(await snapshot(executor, sourceTables), sourcesBefore, 'source intelligence tables unchanged');

        console.log('PASS embedded PostgreSQL stress ETA and risk forecast validation');
        console.log(JSON.stringify({ stress_eta_rows: stressRows.length, risk_forecast_rows: riskRows.length,
            owners: 2, production_contexts: 4, already_active: true, imminent_stress: true,
            no_stress_expected: true, insufficient_data: true, critical_risk: true,
            tenant_isolation: true, context_isolation: true, production_only: true,
            idempotent_deterministic: true, protected_tables_unchanged: true }));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
