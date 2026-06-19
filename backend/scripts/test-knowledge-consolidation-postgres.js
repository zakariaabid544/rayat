'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
    ensureKnowledgeSchema,
    runKnowledgeConsolidationCycle
} = require('../utils/knowledge-consolidation');

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

async function knowledgeSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, baseline_summary, stress_summary,
                recovery_summary, behavioral_signature, top_strengths, top_weaknesses,
                recurring_risks, recurring_recoveries, knowledge_maturity, confidence,
                evidence_json, rule_version
         FROM agro_greenhouse_knowledge
         ORDER BY owner_user_id, device_id, context_id`
    );
}

async function seedCompleteContext(executor, identity, profile) {
    const params = [identity.ownerId, identity.deviceId, identity.contextId];
    await executor(
        `INSERT INTO agro_greenhouse_baselines
            (owner_user_id, device_id, context_id, metric, sample_count, mean_value,
             min_value, max_value, stddev_value, p10_value, p50_value, p90_value,
             ewma_value, confidence, maturity_level)
         VALUES (?, ?, ?, 'temperature', 100, 20, 10, 30, ?, 12, 20, 28, 21, ?, ?)`,
        [...params, profile.weak ? 10 : 1, profile.weak ? 0.6 : 0.9, profile.weak ? 'learning' : 'mature']
    );
    await executor(
        `INSERT INTO agro_stress_memory
            (owner_user_id, device_id, context_id, metric, stress_type, stress_count,
             average_severity_score, recurrence_score, stress_load_score,
             trend_direction, confidence, maturity_level)
         VALUES (?, ?, ?, 'ec', 'out_of_range', ?, ?, ?, ?, ?, 0.8, 'stable')`,
        [...params, profile.weak ? 10 : 2, profile.weak ? 0.8 : 0.4,
            profile.weak ? 0.8 : 0.2, profile.weak ? 80 : 25, profile.weak ? 'rising' : 'stable']
    );
    if (profile.weak) {
        await executor(
            `INSERT INTO agro_stress_memory
                (owner_user_id, device_id, context_id, metric, stress_type, stress_count,
                 average_severity_score, recurrence_score, stress_load_score,
                 trend_direction, confidence, maturity_level)
             VALUES (?, ?, ?, 'temperature', 'sensor_drift', 4, 0.7, 0.7, 75, 'rising', 0.8, 'stable')`,
            params
        );
    }
    await executor(
        `INSERT INTO agro_recovery_memory
            (owner_user_id, device_id, context_id, metric, recovery_count,
             average_recovery_duration, recovery_quality_score, recovery_stability_score,
             relapse_rate, fast_recovery_rate, slow_recovery_rate, confidence, maturity_level)
         VALUES (?, ?, ?, 'temperature', 5, ?, ?, ?, ?, ?, ?, 0.8, ?)`,
        [...params, profile.weak ? 259200 : 3600, profile.weak ? 0.3 : 0.85,
            profile.weak ? 0.3 : 0.8, profile.weak ? 0.6 : 0.1,
            profile.weak ? 0.1 : 0.8, profile.weak ? 0.9 : 0.2,
            profile.weak ? 'learning' : 'stable']
    );
    await executor(
        `INSERT INTO agro_behavioral_signature
            (owner_user_id, device_id, context_id, signature_label, recovery_behavior,
             stress_behavior, stability_behavior, volatility_behavior, sensor_behavior,
             dominant_stress_metric, dominant_recovery_metric, resilience_level,
             risk_tendency, confidence, maturity_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ec', 'temperature', ?, ?, ?, ?)`,
        [...params,
            profile.weak ? 'high_risk_tendency' : 'strong_fast_recovery',
            profile.weak ? 'fragile_recovery' : 'fast_recovery',
            profile.weak ? 'high_stress' : 'low_stress',
            profile.weak ? 'unstable' : 'stable',
            profile.weak ? 'high_volatility' : 'low_volatility',
            profile.weak ? 'drift_risk' : 'reliable',
            profile.weak ? 'weak' : 'strong', profile.weak ? 'high' : 'low',
            profile.weak ? 0.75 : 0.9, profile.weak ? 'stable' : 'mature']
    );
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const protectedTables = [
        'users', 'devices', 'sensors', 'sensor_readings', 'alarm_events', 'active_alerts',
        'agro_actions_detected', 'agro_context_segments', 'agro_greenhouse_baselines',
        'agro_stress_memory', 'agro_recovery_memory', 'agro_behavioral_signature'
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
              context_id BIGINT NOT NULL, metric VARCHAR(80) NOT NULL, sample_count INTEGER NOT NULL,
              mean_value NUMERIC, min_value NUMERIC, max_value NUMERIC, stddev_value NUMERIC,
              p10_value NUMERIC, p50_value NUMERIC, p90_value NUMERIC, ewma_value NUMERIC,
              confidence NUMERIC NOT NULL, maturity_level VARCHAR(12) NOT NULL
            );
            CREATE TABLE agro_stress_memory (
              id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL, metric VARCHAR(80) NOT NULL, stress_type VARCHAR(40) NOT NULL,
              stress_count INTEGER NOT NULL, average_severity_score NUMERIC NOT NULL,
              recurrence_score NUMERIC NOT NULL, stress_load_score NUMERIC NOT NULL,
              trend_direction VARCHAR(10) NOT NULL, confidence NUMERIC NOT NULL, maturity_level VARCHAR(12) NOT NULL
            );
            CREATE TABLE agro_recovery_memory (
              id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL, metric VARCHAR(80) NOT NULL, recovery_count INTEGER NOT NULL,
              average_recovery_duration NUMERIC NOT NULL, recovery_quality_score NUMERIC NOT NULL,
              recovery_stability_score NUMERIC NOT NULL, relapse_rate NUMERIC NOT NULL,
              fast_recovery_rate NUMERIC NOT NULL, slow_recovery_rate NUMERIC NOT NULL,
              confidence NUMERIC NOT NULL, maturity_level VARCHAR(12) NOT NULL
            );
            CREATE TABLE agro_behavioral_signature (
              id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
              context_id BIGINT NOT NULL, signature_label VARCHAR(120) NOT NULL,
              recovery_behavior VARCHAR(24) NOT NULL, stress_behavior VARCHAR(24) NOT NULL,
              stability_behavior VARCHAR(24) NOT NULL, volatility_behavior VARCHAR(24) NOT NULL,
              sensor_behavior VARCHAR(24) NOT NULL, dominant_stress_metric VARCHAR(80),
              dominant_recovery_metric VARCHAR(80), resilience_level VARCHAR(12) NOT NULL,
              risk_tendency VARCHAR(12) NOT NULL, confidence NUMERIC NOT NULL, maturity_level VARCHAR(12) NOT NULL
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
        await seedCompleteContext(executor, { ownerId: 1, deviceId: 10, contextId: 100 }, { weak: false });
        await seedCompleteContext(executor, { ownerId: 1, deviceId: 10, contextId: 101 }, { weak: true });
        await executor(
            `INSERT INTO agro_greenhouse_baselines
                (owner_user_id, device_id, context_id, metric, sample_count, mean_value, stddev_value, confidence, maturity_level)
             VALUES (1, 11, 110, 'humidity', 30, 60, 12, 0.7, 'learning'),
                    (2, 20, 200, 'temperature', 50, 25, 2, 0.8, 'stable'),
                    (1, 10, 102, 'temperature', 50, 20, 1, 0.8, 'stable')`
        );

        await ensureKnowledgeSchema({ executor, ensureContext: async () => {} });
        const constraintRows = await executor(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'agro_greenhouse_knowledge'::regclass ORDER BY conname`
        );
        const constraints = new Set(constraintRows.map((row) => row.conname));
        assert.ok(constraints.has('uniq_greenhouse_knowledge'));
        assert.ok(constraints.has('agro_greenhouse_knowledge_context_fk'));
        assert.ok(constraints.has('agro_greenhouse_knowledge_values_check'));
        const indexRows = await executor(
            `SELECT indexname FROM pg_indexes
             WHERE tablename = 'agro_greenhouse_knowledge' ORDER BY indexname`
        );
        const indexes = new Set(indexRows.map((row) => row.indexname));
        assert.ok(indexes.has('idx_greenhouse_knowledge_context'));
        assert.ok(indexes.has('idx_greenhouse_knowledge_device'));
        assert.ok(indexes.has('idx_greenhouse_knowledge_maturity'));

        const first = await runKnowledgeConsolidationCycle({ executor });
        assert.equal(first.stored, 4);
        let rows = await knowledgeSnapshot(executor);
        assert.equal(rows.length, 4);
        const strong = rows.find((row) => Number(row.context_id) === 100);
        assert.equal(Number(strong.baseline_summary.metric_count), 1);
        assert.equal(Number(strong.stress_summary.total_occurrences), 2);
        assert.equal(Number(strong.recovery_summary.total_recoveries), 5);
        assert.equal(strong.behavioral_signature.signature_label, 'strong_fast_recovery');
        assert.ok(strong.top_strengths.includes('strong_resilience'));
        assert.equal(strong.recurring_recoveries[0].metric, 'temperature');
        const weak = rows.find((row) => Number(row.context_id) === 101);
        assert.ok(weak.top_weaknesses.includes('weak_resilience'));
        assert.ok(weak.top_weaknesses.includes('high_stress_load'));
        assert.equal(weak.recurring_risks[0].metric, 'ec');
        assert.equal(rows.filter((row) => Number(row.device_id) === 10).length, 2, 'contexts stay isolated');
        assert.equal(rows.filter((row) => Number(row.device_id) === 11).length, 1, 'devices stay isolated');
        assert.equal(rows.filter((row) => Number(row.owner_user_id) === 2).length, 1, 'owners stay isolated');
        assert.equal(rows.some((row) => Number(row.context_id) === 102), false, 'demo context is excluded');

        const beforeInvalid = JSON.stringify(await knowledgeSnapshot(executor));
        await executor(
            `INSERT INTO agro_greenhouse_baselines
                (owner_user_id, device_id, context_id, metric, sample_count, mean_value, stddev_value, confidence, maturity_level)
             VALUES (2, 10, 103, 'temperature', 10, 20, 1, 0.5, 'cold_start')`
        );
        await assert.rejects(
            () => runKnowledgeConsolidationCycle({ executor }),
            /fail-closed: 1 source rows have invalid tenant\/context identity/
        );
        assert.equal(JSON.stringify(await knowledgeSnapshot(executor)), beforeInvalid, 'fail-closed run must not write');
        await executor('DELETE FROM agro_greenhouse_baselines WHERE context_id = 103');

        const withDemo = await runKnowledgeConsolidationCycle({ includeNonProduction: true, executor });
        assert.equal(withDemo.stored, 5);
        assert.equal((await knowledgeSnapshot(executor)).some((row) => Number(row.context_id) === 102), true);
        const productionOnly = await runKnowledgeConsolidationCycle({ executor });
        assert.equal(productionOnly.removed_stale, 1);
        assert.equal((await knowledgeSnapshot(executor)).some((row) => Number(row.context_id) === 102), false);

        await executor(
            `INSERT INTO agro_context_segments
                (id, owner_user_id, device_id, sensor_id, usage_type, is_production, valid_from)
             VALUES (201, 2, 20, NULL, 'production', TRUE, '2026-01-01')`
        );
        await executor(
            `INSERT INTO agro_greenhouse_baselines
                (owner_user_id, device_id, context_id, metric, sample_count, mean_value, stddev_value, confidence, maturity_level)
             VALUES (2, 20, 201, 'humidity', 20, 60, 6, 0.6, 'learning')`
        );
        const protectedBefore = await tableSnapshot(executor, protectedTables);
        const beforeDryRun = JSON.stringify(await knowledgeSnapshot(executor));
        const dryRun = await runKnowledgeConsolidationCycle({ dryRun: true, executor });
        assert.equal(dryRun.stored, 5);
        assert.equal(dryRun.rows.length, 5);
        assert.equal(JSON.stringify(await knowledgeSnapshot(executor)), beforeDryRun, 'dry-run must not write');

        await runKnowledgeConsolidationCycle({ executor });
        const snapshotOne = JSON.stringify(await knowledgeSnapshot(executor));
        await runKnowledgeConsolidationCycle({ executor });
        const snapshotTwo = JSON.stringify(await knowledgeSnapshot(executor));
        assert.equal(snapshotTwo, snapshotOne, 'rerun must be deterministic and idempotent');
        assert.equal((await knowledgeSnapshot(executor)).length, 5, 'rerun must not create duplicates');
        assert.deepEqual(await tableSnapshot(executor, protectedTables), protectedBefore, 'source and protected tables must not change');
        assert.equal(Number((await executor(
            `SELECT COUNT(*) AS count FROM agro_greenhouse_knowledge
             WHERE owner_user_id IS NULL OR device_id IS NULL OR context_id IS NULL`
        ))[0].count), 0);
        const evidence = JSON.stringify((await knowledgeSnapshot(executor))[0].evidence_json);
        assert.equal(evidence.includes('event_ids'), false);
        assert.equal(evidence.includes('supporting_examples'), false);
        await assert.rejects(
            () => executor(
                `INSERT INTO agro_greenhouse_knowledge
                    (owner_user_id, device_id, context_id)
                 VALUES (2, 20, 100)`
            ),
            /context_id does not belong/
        );

        console.log('PASS embedded PostgreSQL knowledge consolidation validation');
        console.log(JSON.stringify({
            knowledge_rows: 5,
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
