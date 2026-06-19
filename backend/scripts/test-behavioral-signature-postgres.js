'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
    ensureBehavioralSignatureSchema,
    runBehavioralSignatureCycle
} = require('../utils/behavioral-signature');

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

async function insertBaseline(executor, row) {
    await executor(
        `INSERT INTO agro_greenhouse_baselines
            (owner_user_id, device_id, context_id, metric, sample_count, mean_value,
             stddev_value, confidence, maturity_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.ownerId, row.deviceId, row.contextId, row.metric,
            row.samples || 50, row.mean, row.stddev, row.confidence || 0.8, row.maturity || 'stable'
        ]
    );
}

async function insertStress(executor, row) {
    await executor(
        `INSERT INTO agro_stress_memory
            (owner_user_id, device_id, context_id, metric, stress_type, stress_count,
             first_seen_at, last_seen_at, average_severity_score, recurrence_score,
             stress_load_score, confidence, maturity_level)
         VALUES (?, ?, ?, ?, ?, ?, CAST(? AS TIMESTAMPTZ), CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?, ?)`,
        [
            row.ownerId, row.deviceId, row.contextId, row.metric, row.stressType,
            row.count, row.first || '2026-01-01', row.last || '2026-01-10',
            row.severity, row.recurrence, row.load, row.confidence || 0.8, row.maturity || 'stable'
        ]
    );
}

async function insertRecovery(executor, row) {
    await executor(
        `INSERT INTO agro_recovery_memory
            (owner_user_id, device_id, context_id, metric, recovery_count,
             recovery_quality_score, recovery_stability_score, relapse_rate,
             fast_recovery_rate, slow_recovery_rate, confidence, maturity_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.ownerId, row.deviceId, row.contextId, row.metric, row.count,
            row.quality, row.stability, row.relapse, row.fast, row.slow,
            row.confidence || 0.8, row.maturity || 'stable'
        ]
    );
}

async function tableSnapshot(executor, tables) {
    const snapshot = {};
    for (const table of tables) {
        const rows = await executor(
            `SELECT COALESCE(jsonb_agg(to_jsonb(source) ORDER BY source.id), '[]'::jsonb) AS rows
             FROM ${table} source`
        );
        snapshot[table] = rows[0].rows;
    }
    return snapshot;
}

async function signatureSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, signature_label,
                recovery_behavior, stress_behavior, stability_behavior,
                volatility_behavior, sensor_behavior, dominant_stress_metric,
                dominant_recovery_metric, resilience_level, risk_tendency,
                confidence, maturity_level, evidence_json, rule_version
         FROM agro_behavioral_signature
         ORDER BY owner_user_id, device_id, context_id`
    );
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const protectedTables = [
        'users', 'devices', 'sensors', 'sensor_readings', 'alarm_events', 'active_alerts',
        'agro_context_segments', 'agro_greenhouse_baselines', 'agro_stress_memory',
        'agro_recovery_memory', 'agro_actions_detected'
    ];
    try {
        await executor(`
            CREATE TABLE users (id INTEGER PRIMARY KEY, owner_user_id INTEGER NULL REFERENCES users(id));
            CREATE TABLE devices (id INTEGER PRIMARY KEY, user_id INTEGER NULL REFERENCES users(id));
            CREATE TABLE sensors (id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id));
            CREATE TABLE sensor_readings (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER NOT NULL, value NUMERIC, timestamp TIMESTAMPTZ);
            CREATE TABLE alarm_events (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER NULL);
            CREATE TABLE active_alerts (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER NULL);
            CREATE TABLE agro_actions_detected (id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT);
            CREATE TABLE agro_context_segments (
              id BIGINT PRIMARY KEY,
              owner_user_id INTEGER NOT NULL REFERENCES users(id),
              device_id INTEGER NOT NULL REFERENCES devices(id),
              sensor_id INTEGER NULL REFERENCES sensors(id),
              usage_type VARCHAR(20) NOT NULL,
              is_production BOOLEAN NOT NULL,
              valid_from TIMESTAMPTZ NOT NULL
            );
            CREATE TABLE agro_greenhouse_baselines (
              id BIGSERIAL PRIMARY KEY,
              owner_user_id INTEGER NOT NULL,
              device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL,
              metric VARCHAR(80) NOT NULL,
              sample_count INTEGER NOT NULL,
              mean_value NUMERIC NULL,
              stddev_value NUMERIC NULL,
              confidence NUMERIC NOT NULL,
              maturity_level VARCHAR(12) NOT NULL
            );
            CREATE TABLE agro_stress_memory (
              id BIGSERIAL PRIMARY KEY,
              owner_user_id INTEGER NOT NULL,
              device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL,
              metric VARCHAR(80) NOT NULL,
              stress_type VARCHAR(40) NOT NULL,
              stress_count INTEGER NOT NULL,
              first_seen_at TIMESTAMPTZ NOT NULL,
              last_seen_at TIMESTAMPTZ NOT NULL,
              average_severity_score NUMERIC NOT NULL,
              recurrence_score NUMERIC NOT NULL,
              stress_load_score NUMERIC NOT NULL,
              confidence NUMERIC NOT NULL,
              maturity_level VARCHAR(12) NOT NULL
            );
            CREATE TABLE agro_recovery_memory (
              id BIGSERIAL PRIMARY KEY,
              owner_user_id INTEGER NOT NULL,
              device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL,
              metric VARCHAR(80) NOT NULL,
              recovery_count INTEGER NOT NULL,
              recovery_quality_score NUMERIC NOT NULL,
              recovery_stability_score NUMERIC NOT NULL,
              relapse_rate NUMERIC NOT NULL,
              fast_recovery_rate NUMERIC NOT NULL,
              slow_recovery_rate NUMERIC NOT NULL,
              confidence NUMERIC NOT NULL,
              maturity_level VARCHAR(12) NOT NULL
            );
        `);
        await executor('INSERT INTO users (id) VALUES (1), (2)');
        await executor('INSERT INTO devices (id, user_id) VALUES (10, 1), (11, 1), (20, 2)');
        await executor('INSERT INTO sensors (id, device_id) VALUES (1000, 10), (1100, 11), (2000, 20)');
        await executor("INSERT INTO sensor_readings (sensor_id, value, timestamp) VALUES (1000, 20, '2026-01-01')");
        await executor('INSERT INTO alarm_events (sensor_id) VALUES (1000)');
        await executor('INSERT INTO active_alerts (sensor_id) VALUES (1000)');
        await executor(
            `INSERT INTO agro_context_segments
                (id, owner_user_id, device_id, sensor_id, usage_type, is_production, valid_from)
             VALUES (100, 1, 10, NULL, 'production', TRUE, '2026-01-01'),
                    (101, 1, 10, NULL, 'production', TRUE, '2026-01-01'),
                    (102, 1, 10, NULL, 'demo', FALSE, '2026-01-01'),
                    (103, 2, 10, NULL, 'production', TRUE, '2026-01-01'),
                    (110, 1, 11, NULL, 'production', TRUE, '2026-01-01'),
                    (200, 2, 20, NULL, 'production', TRUE, '2026-01-01')`
        );

        for (const metric of ['temperature', 'humidity']) {
            await insertBaseline(executor, {
                ownerId: 1, deviceId: 10, contextId: 100, metric,
                mean: metric === 'temperature' ? 20 : 60,
                stddev: metric === 'temperature' ? 1 : 3,
                samples: 100, confidence: 0.9, maturity: 'mature'
            });
        }
        await insertStress(executor, {
            ownerId: 1, deviceId: 10, contextId: 100, metric: 'ec', stressType: 'out_of_range',
            count: 2, severity: 0.4, recurrence: 0.2, load: 25
        });
        await insertRecovery(executor, {
            ownerId: 1, deviceId: 10, contextId: 100, metric: 'temperature', count: 5,
            quality: 0.85, stability: 0.8, relapse: 0.1, fast: 0.8, slow: 0.2, confidence: 0.85
        });

        await insertBaseline(executor, {
            ownerId: 1, deviceId: 10, contextId: 101, metric: 'temperature',
            mean: 20, stddev: 10, samples: 100, confidence: 0.8, maturity: 'stable'
        });
        await insertStress(executor, {
            ownerId: 1, deviceId: 10, contextId: 101, metric: 'ec', stressType: 'out_of_range',
            count: 10, severity: 0.8, recurrence: 0.8, load: 80
        });
        await insertStress(executor, {
            ownerId: 1, deviceId: 10, contextId: 101, metric: 'temperature', stressType: 'anomaly',
            count: 5, severity: 0.8, recurrence: 0.7, load: 75
        });
        await insertStress(executor, {
            ownerId: 1, deviceId: 10, contextId: 101, metric: 'temperature', stressType: 'sensor_drift',
            count: 4, severity: 0.7, recurrence: 0.8, load: 75
        });
        await insertRecovery(executor, {
            ownerId: 1, deviceId: 10, contextId: 101, metric: 'ec', count: 5,
            quality: 0.3, stability: 0.3, relapse: 0.6, fast: 0.1, slow: 0.9
        });

        await insertBaseline(executor, {
            ownerId: 1, deviceId: 11, contextId: 110, metric: 'humidity',
            mean: 60, stddev: 12, samples: 30, confidence: 0.7, maturity: 'learning'
        });
        await insertBaseline(executor, {
            ownerId: 2, deviceId: 20, contextId: 200, metric: 'temperature',
            mean: 25, stddev: 2, samples: 50, confidence: 0.8, maturity: 'stable'
        });
        await insertBaseline(executor, {
            ownerId: 1, deviceId: 10, contextId: 102, metric: 'temperature',
            mean: 20, stddev: 1, samples: 50, confidence: 0.8, maturity: 'stable'
        });

        await ensureBehavioralSignatureSchema({ executor, ensureContext: async () => {} });
        const constraintRows = await executor(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'agro_behavioral_signature'::regclass ORDER BY conname`
        );
        const constraints = new Set(constraintRows.map((row) => row.conname));
        assert.ok(constraints.has('uniq_behavioral_signature'));
        assert.ok(constraints.has('agro_behavioral_signature_context_fk'));
        assert.ok(constraints.has('agro_behavioral_signature_values_check'));
        const indexRows = await executor(
            `SELECT indexname FROM pg_indexes
             WHERE tablename = 'agro_behavioral_signature' ORDER BY indexname`
        );
        const indexes = new Set(indexRows.map((row) => row.indexname));
        assert.ok(indexes.has('idx_behavior_signature_context'));
        assert.ok(indexes.has('idx_behavior_signature_device'));
        assert.ok(indexes.has('idx_behavior_signature_risk'));

        const first = await runBehavioralSignatureCycle({ executor });
        assert.equal(first.stored, 4);
        let rows = await signatureSnapshot(executor);
        assert.equal(rows.length, 4);
        const strong = rows.find((row) => Number(row.context_id) === 100);
        assert.equal(strong.recovery_behavior, 'fast_recovery');
        assert.equal(strong.stress_behavior, 'low_stress');
        assert.equal(strong.stability_behavior, 'stable');
        assert.equal(strong.volatility_behavior, 'low_volatility');
        assert.equal(strong.sensor_behavior, 'reliable');
        assert.equal(strong.resilience_level, 'strong');
        assert.equal(strong.risk_tendency, 'low');
        assert.equal(strong.dominant_stress_metric, 'ec');
        assert.equal(strong.dominant_recovery_metric, 'temperature');
        const fragile = rows.find((row) => Number(row.context_id) === 101);
        assert.equal(fragile.recovery_behavior, 'fragile_recovery');
        assert.equal(fragile.stress_behavior, 'high_stress');
        assert.equal(fragile.volatility_behavior, 'high_volatility');
        assert.equal(fragile.sensor_behavior, 'drift_risk');
        assert.equal(fragile.resilience_level, 'weak');
        assert.equal(fragile.risk_tendency, 'high');
        assert.equal(rows.filter((row) => Number(row.device_id) === 10).length, 2, 'contexts stay isolated');
        assert.equal(rows.filter((row) => Number(row.device_id) === 11).length, 1, 'devices stay isolated');
        assert.equal(rows.filter((row) => Number(row.owner_user_id) === 2).length, 1, 'owners stay isolated');
        assert.equal(rows.some((row) => Number(row.context_id) === 102), false, 'demo context is excluded');

        const beforeInvalid = JSON.stringify(await signatureSnapshot(executor));
        await insertBaseline(executor, {
            ownerId: 2, deviceId: 10, contextId: 103, metric: 'temperature',
            mean: 20, stddev: 1, samples: 10
        });
        await assert.rejects(
            () => runBehavioralSignatureCycle({ executor }),
            /fail-closed: 1 source rows have invalid tenant\/context identity/
        );
        assert.equal(JSON.stringify(await signatureSnapshot(executor)), beforeInvalid, 'fail-closed run must not write');
        await executor('DELETE FROM agro_greenhouse_baselines WHERE context_id = 103');

        const withDemo = await runBehavioralSignatureCycle({ includeNonProduction: true, executor });
        assert.equal(withDemo.stored, 5);
        assert.equal((await signatureSnapshot(executor)).some((row) => Number(row.context_id) === 102), true);
        const productionOnly = await runBehavioralSignatureCycle({ executor });
        assert.equal(productionOnly.removed_stale, 1);
        assert.equal((await signatureSnapshot(executor)).some((row) => Number(row.context_id) === 102), false);

        await executor(
            `INSERT INTO agro_context_segments
                (id, owner_user_id, device_id, sensor_id, usage_type, is_production, valid_from)
             VALUES (201, 2, 20, NULL, 'production', TRUE, '2026-01-01')`
        );
        await insertBaseline(executor, {
            ownerId: 2, deviceId: 20, contextId: 201, metric: 'humidity',
            mean: 60, stddev: 6, samples: 20, confidence: 0.6, maturity: 'learning'
        });
        const protectedBefore = await tableSnapshot(executor, protectedTables);
        const beforeDryRun = JSON.stringify(await signatureSnapshot(executor));
        const dryRun = await runBehavioralSignatureCycle({ dryRun: true, executor });
        assert.equal(dryRun.stored, 5);
        assert.equal(dryRun.rows.length, 5);
        assert.equal(JSON.stringify(await signatureSnapshot(executor)), beforeDryRun, 'dry-run must not write');

        await runBehavioralSignatureCycle({ executor });
        const snapshotOne = JSON.stringify(await signatureSnapshot(executor));
        await runBehavioralSignatureCycle({ executor });
        const snapshotTwo = JSON.stringify(await signatureSnapshot(executor));
        assert.equal(snapshotTwo, snapshotOne, 'rerun must be deterministic and idempotent');
        assert.equal((await signatureSnapshot(executor)).length, 5, 'rerun must not create duplicates');
        assert.deepEqual(await tableSnapshot(executor, protectedTables), protectedBefore, 'source and protected tables must not change');
        assert.equal(Number((await executor(
            `SELECT COUNT(*) AS count FROM agro_behavioral_signature
             WHERE owner_user_id IS NULL OR device_id IS NULL OR context_id IS NULL`
        ))[0].count), 0);
        const evidence = JSON.stringify((await signatureSnapshot(executor))[0].evidence_json);
        assert.equal(evidence.includes('event_ids'), false);
        assert.equal(evidence.includes('supporting_examples'), false);
        await assert.rejects(
            () => executor(
                `INSERT INTO agro_behavioral_signature
                    (owner_user_id, device_id, context_id, signature_label)
                 VALUES (2, 20, 100, 'invalid')`
            ),
            /context_id does not belong/
        );

        console.log('PASS embedded PostgreSQL behavioral signature validation');
        console.log(JSON.stringify({
            signatures: 5,
            contexts: 5,
            devices: 3,
            owners: 2,
            fail_closed_identity: true,
            non_production_skipped: true,
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
