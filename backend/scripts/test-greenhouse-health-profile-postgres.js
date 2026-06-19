'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
    ensureHealthProfileSchema,
    runHealthProfileCycle
} = require('../utils/greenhouse-health-profile');

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

async function profileSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, health_score, resilience_score,
                stress_load_score, recovery_score, stability_score, data_confidence_score,
                health_band, top_positive_factors, top_negative_factors, recommended_focus,
                confidence, maturity_level, evidence_json, rule_version
         FROM agro_greenhouse_health_profile
         ORDER BY owner_user_id, device_id, context_id`
    );
}

async function seedComplete(executor, identity, weak) {
    const ids = [identity.ownerId, identity.deviceId, identity.contextId];
    await executor(
        `INSERT INTO agro_greenhouse_baselines
            (owner_user_id, device_id, context_id, metric, mean_value, stddev_value, confidence, maturity_level)
         VALUES (?, ?, ?, 'temperature', 20, ?, ?, ?)`,
        [...ids, weak ? 10 : 1, weak ? 0.7 : 0.9, weak ? 'learning' : 'mature']
    );
    await executor(
        `INSERT INTO agro_stress_memory
            (owner_user_id, device_id, context_id, metric, stress_type, stress_count,
             average_severity_score, recurrence_score, stress_load_score, confidence, maturity_level)
         VALUES (?, ?, ?, 'ec', 'out_of_range', ?, ?, ?, ?, 0.8, 'stable')`,
        [...ids, weak ? 10 : 2, weak ? 0.8 : 0.4, weak ? 0.8 : 0.2, weak ? 80 : 25]
    );
    if (weak) {
        await executor(
            `INSERT INTO agro_stress_memory
                (owner_user_id, device_id, context_id, metric, stress_type, stress_count,
                 average_severity_score, recurrence_score, stress_load_score, confidence, maturity_level)
             VALUES (?, ?, ?, 'temperature', 'sensor_drift', 4, 0.7, 0.7, 75, 0.8, 'stable')`,
            ids
        );
    }
    await executor(
        `INSERT INTO agro_recovery_memory
            (owner_user_id, device_id, context_id, metric, recovery_count,
             recovery_quality_score, recovery_stability_score, relapse_rate,
             fast_recovery_rate, confidence, maturity_level)
         VALUES (?, ?, ?, 'temperature', 5, ?, ?, ?, ?, ?, ?)`,
        [...ids, weak ? 0.3 : 0.85, weak ? 0.3 : 0.8,
            weak ? 0.6 : 0.1, weak ? 0.1 : 0.8, weak ? 0.7 : 0.85,
            weak ? 'learning' : 'stable']
    );
    await executor(
        `INSERT INTO agro_behavioral_signature
            (owner_user_id, device_id, context_id, signature_label, stability_behavior,
             sensor_behavior, dominant_stress_metric, resilience_level, risk_tendency,
             confidence, maturity_level)
         VALUES (?, ?, ?, ?, ?, ?, 'ec', ?, ?, ?, ?)`,
        [...ids, weak ? 'high_risk_tendency' : 'strong_fast_recovery',
            weak ? 'unstable' : 'stable', weak ? 'drift_risk' : 'reliable',
            weak ? 'weak' : 'strong', weak ? 'high' : 'low', weak ? 0.75 : 0.9,
            weak ? 'stable' : 'mature']
    );
    await executor(
        `INSERT INTO agro_greenhouse_knowledge
            (owner_user_id, device_id, context_id, baseline_summary, stress_summary,
             recovery_summary, behavioral_signature, top_strengths, top_weaknesses,
             recurring_risks, recurring_recoveries, knowledge_maturity, confidence)
         VALUES (?, ?, ?, '{}'::jsonb, CAST(? AS JSONB), '{}'::jsonb, '{}'::jsonb,
                 CAST(? AS JSONB), CAST(? AS JSONB), '[]'::jsonb, '[]'::jsonb, ?, ?)`,
        [...ids, JSON.stringify({ dominant_metric: 'ec' }),
            JSON.stringify(weak ? [] : ['strong_resilience', 'fast_recovery']),
            JSON.stringify(weak ? ['weak_resilience', 'high_stress_load', 'sensor_drift_risk'] : []),
            weak ? 'stable' : 'mature', weak ? 0.75 : 0.86]
    );
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const protectedTables = [
        'users', 'devices', 'sensors', 'sensor_readings', 'alarm_events', 'active_alerts',
        'agro_actions_detected', 'agro_context_segments', 'agro_greenhouse_baselines',
        'agro_stress_memory', 'agro_recovery_memory', 'agro_behavioral_signature',
        'agro_greenhouse_knowledge'
    ];
    try {
        await executor(`
            CREATE TABLE users (id INTEGER PRIMARY KEY, owner_user_id INTEGER NULL REFERENCES users(id));
            CREATE TABLE devices (id INTEGER PRIMARY KEY, user_id INTEGER NULL REFERENCES users(id));
            CREATE TABLE sensors (id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id));
            CREATE TABLE sensor_readings (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER, value NUMERIC, timestamp TIMESTAMPTZ);
            CREATE TABLE alarm_events (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER NULL);
            CREATE TABLE active_alerts (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER NULL);
            CREATE TABLE agro_actions_detected (id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT);
            CREATE TABLE agro_context_segments (
              id BIGINT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
              device_id INTEGER NOT NULL REFERENCES devices(id), sensor_id INTEGER NULL,
              usage_type VARCHAR(20) NOT NULL, is_production BOOLEAN NOT NULL, valid_from TIMESTAMPTZ NOT NULL
            );
            CREATE TABLE agro_greenhouse_baselines (
              id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL, metric VARCHAR(80) NOT NULL, mean_value NUMERIC,
              stddev_value NUMERIC, confidence NUMERIC NOT NULL, maturity_level VARCHAR(12) NOT NULL
            );
            CREATE TABLE agro_stress_memory (
              id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL, metric VARCHAR(80) NOT NULL, stress_type VARCHAR(40) NOT NULL,
              stress_count INTEGER NOT NULL, average_severity_score NUMERIC NOT NULL,
              recurrence_score NUMERIC NOT NULL, stress_load_score NUMERIC NOT NULL,
              confidence NUMERIC NOT NULL, maturity_level VARCHAR(12) NOT NULL
            );
            CREATE TABLE agro_recovery_memory (
              id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL, metric VARCHAR(80) NOT NULL, recovery_count INTEGER NOT NULL,
              recovery_quality_score NUMERIC NOT NULL, recovery_stability_score NUMERIC NOT NULL,
              relapse_rate NUMERIC NOT NULL, fast_recovery_rate NUMERIC NOT NULL,
              confidence NUMERIC NOT NULL, maturity_level VARCHAR(12) NOT NULL
            );
            CREATE TABLE agro_behavioral_signature (
              id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL, signature_label VARCHAR(120) NOT NULL,
              stability_behavior VARCHAR(24) NOT NULL, sensor_behavior VARCHAR(24) NOT NULL,
              dominant_stress_metric VARCHAR(80), resilience_level VARCHAR(12) NOT NULL,
              risk_tendency VARCHAR(12) NOT NULL, confidence NUMERIC NOT NULL, maturity_level VARCHAR(12) NOT NULL
            );
            CREATE TABLE agro_greenhouse_knowledge (
              id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL, baseline_summary JSONB NOT NULL, stress_summary JSONB NOT NULL,
              recovery_summary JSONB NOT NULL, behavioral_signature JSONB NOT NULL,
              top_strengths JSONB NOT NULL, top_weaknesses JSONB NOT NULL,
              recurring_risks JSONB NOT NULL, recurring_recoveries JSONB NOT NULL,
              knowledge_maturity VARCHAR(12) NOT NULL, confidence NUMERIC NOT NULL
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
        await seedComplete(executor, { ownerId: 1, deviceId: 10, contextId: 100 }, false);
        await seedComplete(executor, { ownerId: 1, deviceId: 10, contextId: 101 }, true);
        for (const identity of [
            { ownerId: 1, deviceId: 11, contextId: 110 },
            { ownerId: 2, deviceId: 20, contextId: 200 },
            { ownerId: 1, deviceId: 10, contextId: 102 }
        ]) {
            await executor(
                `INSERT INTO agro_greenhouse_baselines
                    (owner_user_id, device_id, context_id, metric, mean_value, stddev_value, confidence, maturity_level)
                 VALUES (?, ?, ?, 'humidity', 60, 6, 0.6, 'learning')`,
                [identity.ownerId, identity.deviceId, identity.contextId]
            );
            await executor(
                `INSERT INTO agro_greenhouse_knowledge
                    (owner_user_id, device_id, context_id, baseline_summary, stress_summary,
                     recovery_summary, behavioral_signature, top_strengths, top_weaknesses,
                     recurring_risks, recurring_recoveries, knowledge_maturity, confidence)
                 VALUES (?, ?, ?, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                         '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'learning', 0.6)`,
                [identity.ownerId, identity.deviceId, identity.contextId]
            );
        }

        await ensureHealthProfileSchema({ executor, ensureContext: async () => {} });
        const constraintRows = await executor(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'agro_greenhouse_health_profile'::regclass ORDER BY conname`
        );
        const constraints = new Set(constraintRows.map((row) => row.conname));
        assert.ok(constraints.has('uniq_greenhouse_health_profile'));
        assert.ok(constraints.has('agro_greenhouse_health_profile_context_fk'));
        assert.ok(constraints.has('agro_greenhouse_health_profile_values_check'));
        const indexRows = await executor(
            `SELECT indexname FROM pg_indexes
             WHERE tablename = 'agro_greenhouse_health_profile' ORDER BY indexname`
        );
        const indexes = new Set(indexRows.map((row) => row.indexname));
        assert.ok(indexes.has('idx_health_profile_context'));
        assert.ok(indexes.has('idx_health_profile_device'));
        assert.ok(indexes.has('idx_health_profile_band_score'));

        const first = await runHealthProfileCycle({ executor });
        assert.equal(first.stored, 4);
        let rows = await profileSnapshot(executor);
        assert.equal(rows.length, 4);
        const strong = rows.find((row) => Number(row.context_id) === 100);
        assert.equal(strong.health_band, 'good');
        assert.ok(Number(strong.health_score) >= 70);
        assert.ok(Number(strong.resilience_score) >= 80);
        assert.equal(strong.recommended_focus[0], 'maintain_current_practices');
        const weak = rows.find((row) => Number(row.context_id) === 101);
        assert.ok(['risk', 'critical'].includes(weak.health_band));
        assert.ok(Number(weak.stress_load_score) >= 70);
        assert.ok(weak.recommended_focus.includes('reduce_ec_stress'));
        assert.equal(rows.find((row) => Number(row.context_id) === 110).health_band, 'unknown');
        assert.equal(rows.filter((row) => Number(row.device_id) === 10).length, 2, 'contexts stay isolated');
        assert.equal(rows.filter((row) => Number(row.device_id) === 11).length, 1, 'devices stay isolated');
        assert.equal(rows.filter((row) => Number(row.owner_user_id) === 2).length, 1, 'owners stay isolated');
        assert.equal(rows.some((row) => Number(row.context_id) === 102), false, 'demo context is excluded');

        const beforeInvalid = JSON.stringify(await profileSnapshot(executor));
        await executor(
            `INSERT INTO agro_greenhouse_baselines
                (owner_user_id, device_id, context_id, metric, mean_value, stddev_value, confidence, maturity_level)
             VALUES (2, 10, 103, 'temperature', 20, 1, 0.5, 'cold_start')`
        );
        await assert.rejects(
            () => runHealthProfileCycle({ executor }),
            /fail-closed: 1 source rows have invalid tenant\/context identity/
        );
        assert.equal(JSON.stringify(await profileSnapshot(executor)), beforeInvalid, 'fail-closed run must not write');
        await executor('DELETE FROM agro_greenhouse_baselines WHERE context_id = 103');

        const withDemo = await runHealthProfileCycle({ includeNonProduction: true, executor });
        assert.equal(withDemo.stored, 5);
        assert.equal((await profileSnapshot(executor)).some((row) => Number(row.context_id) === 102), true);
        const productionOnly = await runHealthProfileCycle({ executor });
        assert.equal(productionOnly.removed_stale, 1);
        assert.equal((await profileSnapshot(executor)).some((row) => Number(row.context_id) === 102), false);

        await executor(
            `INSERT INTO agro_context_segments
                (id, owner_user_id, device_id, sensor_id, usage_type, is_production, valid_from)
             VALUES (201, 2, 20, NULL, 'production', TRUE, '2026-01-01')`
        );
        await executor(
            `INSERT INTO agro_greenhouse_knowledge
                (owner_user_id, device_id, context_id, baseline_summary, stress_summary,
                 recovery_summary, behavioral_signature, top_strengths, top_weaknesses,
                 recurring_risks, recurring_recoveries, knowledge_maturity, confidence)
             VALUES (2, 20, 201, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                     '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'cold_start', 0.4)`
        );
        const protectedBefore = await tableSnapshot(executor, protectedTables);
        const beforeDryRun = JSON.stringify(await profileSnapshot(executor));
        const dryRun = await runHealthProfileCycle({ dryRun: true, executor });
        assert.equal(dryRun.stored, 5);
        assert.equal(dryRun.rows.length, 5);
        assert.equal(JSON.stringify(await profileSnapshot(executor)), beforeDryRun, 'dry-run must not write');

        await runHealthProfileCycle({ executor });
        const snapshotOne = JSON.stringify(await profileSnapshot(executor));
        await runHealthProfileCycle({ executor });
        const snapshotTwo = JSON.stringify(await profileSnapshot(executor));
        assert.equal(snapshotTwo, snapshotOne, 'rerun must be deterministic and idempotent');
        assert.equal((await profileSnapshot(executor)).length, 5, 'rerun must not create duplicates');
        assert.deepEqual(await tableSnapshot(executor, protectedTables), protectedBefore, 'source and protected tables must not change');
        assert.equal(Number((await executor(
            `SELECT COUNT(*) AS count FROM agro_greenhouse_health_profile
             WHERE owner_user_id IS NULL OR device_id IS NULL OR context_id IS NULL`
        ))[0].count), 0);
        const evidence = JSON.stringify((await profileSnapshot(executor))[0].evidence_json);
        assert.equal(evidence.includes('event_ids'), false);
        assert.equal(evidence.includes('supporting_examples'), false);
        await assert.rejects(
            () => executor(
                `INSERT INTO agro_greenhouse_health_profile
                    (owner_user_id, device_id, context_id)
                 VALUES (2, 20, 100)`
            ),
            /context_id does not belong/
        );

        console.log('PASS embedded PostgreSQL greenhouse health profile validation');
        console.log(JSON.stringify({
            health_profiles: 5,
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
