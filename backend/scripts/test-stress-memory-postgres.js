'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
    ensureStressMemorySchema,
    runStressMemoryCycle
} = require('../utils/stress-memory');

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

async function insertEvent(executor, event) {
    const start = new Date(event.startedAt);
    const endedAt = event.endedAt === undefined
        ? new Date(start.getTime() + 600000).toISOString()
        : event.endedAt;
    await executor(
        `INSERT INTO agro_actions_detected
            (owner_user_id, device_id, sensor_id, context_id, metric, event_type,
             severity, started_at, ended_at, duration_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS TIMESTAMPTZ), CAST(? AS TIMESTAMPTZ), ?)`,
        [
            event.ownerId, event.deviceId, event.sensorId, event.contextId,
            event.metric || 'temperature', event.eventType,
            event.severity || 'info', start.toISOString(), endedAt, event.durationSeconds ?? null
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

async function memorySnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, metric, stress_type, stress_count,
                first_seen_at, last_seen_at, total_duration_seconds, average_duration_seconds,
                max_duration_seconds, severity_distribution_json, average_severity_score,
                max_severity_score, recurrence_score, stress_load_score, trend_direction,
                confidence, maturity_level, evidence_json, rule_version
         FROM agro_stress_memory
         ORDER BY owner_user_id, device_id, context_id, metric, stress_type`
    );
}

async function addTrendEvents(executor, eventType, dates) {
    for (const date of dates) {
        await insertEvent(executor, {
            ownerId: 1,
            deviceId: 10,
            sensorId: 1000,
            contextId: 101,
            eventType,
            severity: 'medium',
            startedAt: `2026-01-${String(date).padStart(2, '0')}T00:00:00.000Z`,
            durationSeconds: 60
        });
    }
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const protectedTables = ['sensor_readings', 'alarm_events', 'active_alerts', 'users', 'devices', 'sensors'];
    try {
        await executor(`
            CREATE TABLE users (
              id INTEGER PRIMARY KEY,
              owner_user_id INTEGER NULL REFERENCES users(id)
            );
            CREATE TABLE devices (
              id INTEGER PRIMARY KEY,
              user_id INTEGER NULL REFERENCES users(id)
            );
            CREATE TABLE sensors (
              id INTEGER PRIMARY KEY,
              device_id INTEGER NOT NULL REFERENCES devices(id)
            );
            CREATE TABLE sensor_readings (
              id BIGSERIAL PRIMARY KEY,
              sensor_id INTEGER NOT NULL REFERENCES sensors(id),
              value NUMERIC NOT NULL,
              timestamp TIMESTAMPTZ NOT NULL
            );
            CREATE TABLE alarm_events (
              id BIGSERIAL PRIMARY KEY,
              sensor_id INTEGER NULL
            );
            CREATE TABLE active_alerts (
              id BIGSERIAL PRIMARY KEY,
              sensor_id INTEGER NULL
            );
            CREATE TABLE agro_context_segments (
              id BIGINT PRIMARY KEY,
              owner_user_id INTEGER NOT NULL REFERENCES users(id),
              device_id INTEGER NOT NULL REFERENCES devices(id),
              sensor_id INTEGER NULL REFERENCES sensors(id),
              usage_type VARCHAR(20) NOT NULL,
              is_production BOOLEAN NOT NULL,
              valid_from TIMESTAMPTZ NOT NULL,
              valid_to TIMESTAMPTZ NULL
            );
            CREATE TABLE agro_actions_detected (
              id BIGSERIAL PRIMARY KEY,
              owner_user_id INTEGER NULL REFERENCES users(id),
              device_id INTEGER NULL REFERENCES devices(id),
              sensor_id INTEGER NOT NULL REFERENCES sensors(id),
              context_id BIGINT NULL,
              metric VARCHAR(80) NOT NULL,
              event_type VARCHAR(40) NOT NULL,
              severity VARCHAR(16) NULL,
              started_at TIMESTAMPTZ NOT NULL,
              ended_at TIMESTAMPTZ NULL,
              duration_seconds INTEGER NULL
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
        await ensureStressMemorySchema({ executor, ensureContext: async () => {} });
        const constraintRows = await executor(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'agro_stress_memory'::regclass ORDER BY conname`
        );
        const constraints = new Set(constraintRows.map((row) => row.conname));
        assert.ok(constraints.has('uniq_stress_memory'));
        assert.ok(constraints.has('agro_stress_memory_context_fk'));
        assert.ok(constraints.has('agro_stress_memory_values_check'));
        const indexRows = await executor(
            `SELECT indexname FROM pg_indexes
             WHERE tablename = 'agro_stress_memory' ORDER BY indexname`
        );
        const indexes = new Set(indexRows.map((row) => row.indexname));
        assert.ok(indexes.has('idx_stress_memory_context'));
        assert.ok(indexes.has('idx_stress_memory_device'));
        assert.ok(indexes.has('idx_stress_memory_type_last'));
        const clock = new Date('2026-01-20T00:00:00.000Z');
        const protectedBefore = await tableSnapshot(executor, protectedTables);

        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'out_of_range', severity: 'low', startedAt: '2026-01-01T00:00:00.000Z'
        });
        const first = await runStressMemoryCycle({ now: clock, executor });
        assert.equal(first.stored, 1, 'one context and stress type must create one row');
        let rows = await memorySnapshot(executor);
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].stress_count), 1);
        assert.equal(Number(rows[0].total_duration_seconds), 600, 'timestamp duration fallback must be used');
        const firstConfidence = Number(rows[0].confidence);

        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'out_of_range', severity: 'high', startedAt: '2026-01-10T00:00:00.000Z',
            durationSeconds: 120
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'out_of_range', severity: 'critical', startedAt: '2026-01-11T00:00:00.000Z',
            endedAt: '2026-01-11T00:05:00.000Z'
        });
        const repeated = await runStressMemoryCycle({ now: clock, executor });
        assert.equal(repeated.stored, 1, 'same key must update one row');
        rows = await memorySnapshot(executor);
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].stress_count), 3);
        assert.equal(Number(rows[0].total_duration_seconds), 1020);
        assert.equal(Number(rows[0].average_duration_seconds), 340);
        assert.equal(Number(rows[0].max_duration_seconds), 600);
        assert.equal(Number(rows[0].average_severity_score), 0.667);
        assert.equal(Number(rows[0].severity_distribution_json.low), 1);
        assert.equal(Number(rows[0].severity_distribution_json.high), 1);
        assert.equal(Number(rows[0].severity_distribution_json.critical), 1);
        assert.ok(Number(rows[0].confidence) > firstConfidence, 'confidence must increase with event count');

        await addTrendEvents(executor, 'anomaly', [1, 2, 3, 4, 5, 6]);
        await addTrendEvents(executor, 'regime_shift', [1, 8, 9, 10, 11]);
        await addTrendEvents(executor, 'sensor_drift', [1, 2, 3, 4, 11]);
        await insertEvent(executor, {
            ownerId: 1, deviceId: 11, sensorId: 1100, contextId: 110,
            eventType: 'worsening', severity: 'medium', startedAt: '2026-01-05T00:00:00.000Z'
        });
        await insertEvent(executor, {
            ownerId: 2, deviceId: 20, sensorId: 2000, contextId: 200,
            eventType: 'sensor_drift', severity: 'high', startedAt: '2026-01-06T00:00:00.000Z'
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: null,
            eventType: 'anomaly', severity: 'high', startedAt: '2026-01-07T00:00:00.000Z'
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 102,
            eventType: 'anomaly', severity: 'high', startedAt: '2026-01-07T00:00:00.000Z'
        });
        await insertEvent(executor, {
            ownerId: 2, deviceId: 10, sensorId: 1000, contextId: 103,
            eventType: 'anomaly', severity: 'high', startedAt: '2026-01-07T00:00:00.000Z'
        });
        for (const ignoredType of ['recovery', 'return_to_range', 'stabilization', 'improvement']) {
            await insertEvent(executor, {
                ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
                eventType: ignoredType, severity: 'critical', startedAt: '2026-01-12T00:00:00.000Z'
            });
        }

        const isolated = await runStressMemoryCycle({ now: clock, executor });
        assert.equal(isolated.stored, 6);
        assert.equal(isolated.skipped_missing_context, 1, 'missing context must be skipped');
        assert.equal(isolated.skipped_invalid_identity, 1, 'non-canonical device ownership must be skipped');
        assert.equal(isolated.skipped_non_production, 1, 'demo context must be skipped');
        rows = await memorySnapshot(executor);
        assert.equal(rows.length, 6);
        assert.equal(rows.filter((row) => Number(row.device_id) === 10 && Number(row.context_id) === 100).length, 1);
        assert.equal(rows.filter((row) => Number(row.device_id) === 10 && Number(row.context_id) === 101).length, 3);
        assert.equal(rows.filter((row) => Number(row.device_id) === 11).length, 1);
        assert.equal(rows.filter((row) => Number(row.owner_user_id) === 2).length, 1);
        assert.equal(rows.some((row) => Number(row.context_id) === 102), false, 'demo context must not create memory');
        assert.equal(
            rows.some((row) => ['recovery', 'return_to_range', 'stabilization', 'improvement'].includes(row.stress_type)),
            false,
            'recovery event types must be ignored'
        );
        assert.equal(rows.find((row) => row.stress_type === 'anomaly').trend_direction, 'stable');
        assert.equal(rows.find((row) => row.stress_type === 'regime_shift').trend_direction, 'rising');
        assert.equal(
            rows.find((row) => row.stress_type === 'sensor_drift' && Number(row.context_id) === 101).trend_direction,
            'declining'
        );

        const explicitlyIncluded = await runStressMemoryCycle({
            now: clock, includeNonProduction: true, executor
        });
        assert.equal(explicitlyIncluded.stored, 7, 'explicit configuration may include a demo context');
        assert.equal(
            (await memorySnapshot(executor)).some((row) => Number(row.context_id) === 102),
            true
        );
        const productionOnly = await runStressMemoryCycle({ now: clock, executor });
        assert.equal(productionOnly.removed_stale, 1, 'non-production memory must be reconciled away');
        assert.equal(
            (await memorySnapshot(executor)).some((row) => Number(row.context_id) === 102),
            false
        );

        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'anomaly', severity: 'medium', startedAt: '2026-01-13T00:00:00.000Z'
        });
        const beforeDryRun = JSON.stringify(await memorySnapshot(executor));
        const dryRun = await runStressMemoryCycle({ now: clock, dryRun: true, executor });
        assert.equal(dryRun.stored, 7);
        assert.equal(dryRun.rows.length, 7);
        assert.equal(JSON.stringify(await memorySnapshot(executor)), beforeDryRun, 'dry-run must not write');

        const sourceBefore = await tableSnapshot(executor, ['agro_actions_detected']);
        await runStressMemoryCycle({ now: clock, executor });
        const snapshotOne = JSON.stringify(await memorySnapshot(executor));
        await runStressMemoryCycle({ now: clock, executor });
        const snapshotTwo = JSON.stringify(await memorySnapshot(executor));
        assert.equal(snapshotTwo, snapshotOne, 'rerun must be deterministic and idempotent');
        assert.equal((await memorySnapshot(executor)).length, 7, 'rerun must create no duplicates');
        assert.deepEqual(await tableSnapshot(executor, protectedTables), protectedBefore, 'protected tables must not change');
        assert.deepEqual(await tableSnapshot(executor, ['agro_actions_detected']), sourceBefore, 'source events must not change');
        assert.equal(Number((await executor(
            `SELECT COUNT(*) AS count FROM agro_stress_memory
             WHERE owner_user_id IS NULL OR device_id IS NULL OR context_id IS NULL`
        ))[0].count), 0);

        const evidence = JSON.stringify((await memorySnapshot(executor))[0].evidence_json);
        assert.equal(evidence.includes('event_ids'), false, 'evidence must not expose raw event ids');
        await assert.rejects(
            () => executor(
                `INSERT INTO agro_stress_memory
                    (owner_user_id, device_id, context_id, metric, stress_type, stress_count,
                     first_seen_at, last_seen_at)
                 VALUES (2, 20, 100, 'temperature', 'anomaly', 1, NOW(), NOW())`
            ),
            /context_id does not belong/
        );

        console.log('PASS embedded PostgreSQL stress memory validation');
        console.log(JSON.stringify({
            memories: 7,
            contexts: 4,
            devices: 3,
            owners: 2,
            missing_context_skipped: true,
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
