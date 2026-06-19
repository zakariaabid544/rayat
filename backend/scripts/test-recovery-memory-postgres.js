'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
    ensureRecoveryMemorySchema,
    runRecoveryMemoryCycle
} = require('../utils/recovery-memory');

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
    const rows = await executor(
        `INSERT INTO agro_actions_detected
            (owner_user_id, device_id, sensor_id, context_id, metric, event_type,
             confidence, started_at, ended_at, duration_seconds, evidence_json, linked_out_of_range_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS TIMESTAMPTZ), CAST(? AS TIMESTAMPTZ), ?, CAST(? AS JSONB), ?)
         RETURNING id`,
        [
            event.ownerId, event.deviceId, event.sensorId, event.contextId,
            event.metric || 'temperature', event.eventType, event.confidence ?? 0,
            new Date(event.startedAt).toISOString(), event.endedAt || null,
            event.durationSeconds ?? null, JSON.stringify(event.evidence || {}), event.linkedOutOfRangeId || null
        ]
    );
    return Number(rows[0].id);
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
        `SELECT owner_user_id, device_id, context_id, metric, recovery_count,
                first_seen_at, last_seen_at, average_recovery_duration,
                min_recovery_duration, max_recovery_duration,
                recovery_quality_score, recovery_stability_score, relapse_rate,
                fast_recovery_rate, slow_recovery_rate, confidence, maturity_level,
                evidence_json, rule_version
         FROM agro_recovery_memory
         ORDER BY owner_user_id, device_id, context_id, metric`
    );
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
              confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
              started_at TIMESTAMPTZ NOT NULL,
              ended_at TIMESTAMPTZ NULL,
              duration_seconds INTEGER NULL,
              evidence_json JSONB NULL,
              linked_out_of_range_id BIGINT NULL
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
        await ensureRecoveryMemorySchema({ executor, ensureContext: async () => {} });

        const constraintRows = await executor(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'agro_recovery_memory'::regclass ORDER BY conname`
        );
        const constraints = new Set(constraintRows.map((row) => row.conname));
        assert.ok(constraints.has('uniq_recovery_memory'));
        assert.ok(constraints.has('agro_recovery_memory_context_fk'));
        assert.ok(constraints.has('agro_recovery_memory_values_check'));
        const indexRows = await executor(
            `SELECT indexname FROM pg_indexes
             WHERE tablename = 'agro_recovery_memory' ORDER BY indexname`
        );
        const indexes = new Set(indexRows.map((row) => row.indexname));
        assert.ok(indexes.has('idx_recovery_memory_context'));
        assert.ok(indexes.has('idx_recovery_memory_device'));
        assert.ok(indexes.has('idx_recovery_memory_last'));

        const clock = new Date('2026-03-01T00:00:00.000Z');
        const protectedBefore = await tableSnapshot(executor, protectedTables);
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'recovery', confidence: 0.8,
            startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T02:00:00.000Z',
            durationSeconds: 7200, evidence: { recovery_quality: 0.9, recovery_duration_minutes: 120 }
        });
        const first = await runRecoveryMemoryCycle({ now: clock, executor });
        assert.equal(first.stored, 1, 'one context must create one recovery memory row');
        let rows = await memorySnapshot(executor);
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].recovery_count), 1);
        assert.equal(Number(rows[0].average_recovery_duration), 7200);
        assert.equal(Number(rows[0].recovery_quality_score), 0.9);
        const firstConfidence = Number(rows[0].confidence);

        const linkedBreachId = await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'out_of_range', confidence: 0.8,
            startedAt: '2026-01-02T00:00:00.000Z', endedAt: '2026-01-02T04:00:00.000Z',
            durationSeconds: 14400
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'return_to_range', confidence: 0.8,
            startedAt: '2026-01-02T04:00:00.000Z', endedAt: '2026-01-02T04:00:00.000Z',
            linkedOutOfRangeId: linkedBreachId
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'improvement', confidence: 0.7,
            startedAt: '2026-01-03T00:00:00.000Z', endedAt: '2026-01-06T00:00:00.000Z',
            durationSeconds: 259200
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'stabilization', confidence: 0.9,
            startedAt: '2026-01-04T00:00:00.000Z', endedAt: '2026-01-04T01:00:00.000Z',
            durationSeconds: 3600
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
            eventType: 'out_of_range', confidence: 0.8,
            startedAt: '2026-01-06T00:30:00.000Z'
        });

        const aggregate = await runRecoveryMemoryCycle({ now: clock, executor });
        assert.equal(aggregate.stored, 1, 'all recovery signals for one key must update one row');
        rows = await memorySnapshot(executor);
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].recovery_count), 4);
        assert.equal(Number(rows[0].average_recovery_duration), 71100);
        assert.equal(Number(rows[0].min_recovery_duration), 3600);
        assert.equal(Number(rows[0].max_recovery_duration), 259200);
        assert.equal(Number(rows[0].recovery_quality_score), 0.825);
        assert.equal(Number(rows[0].relapse_rate), 0.25);
        assert.equal(Number(rows[0].fast_recovery_rate), 0.75);
        assert.equal(Number(rows[0].slow_recovery_rate), 0.25);
        assert.ok(Number(rows[0].confidence) > firstConfidence, 'confidence must increase with evidence');

        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 101,
            eventType: 'recovery', confidence: 0.7,
            startedAt: '2026-01-10T00:00:00.000Z', durationSeconds: 1800
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 101,
            eventType: 'improvement', confidence: 0.6,
            startedAt: '2026-01-10T01:00:00.000Z'
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 11, sensorId: 1100, contextId: 110,
            eventType: 'recovery', confidence: 0.7,
            startedAt: '2026-01-11T00:00:00.000Z', durationSeconds: 2400
        });
        await insertEvent(executor, {
            ownerId: 2, deviceId: 20, sensorId: 2000, contextId: 200,
            eventType: 'recovery', confidence: 0.7,
            startedAt: '2026-01-12T00:00:00.000Z', durationSeconds: 3000
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: null,
            eventType: 'recovery', confidence: 0.7,
            startedAt: '2026-01-13T00:00:00.000Z', durationSeconds: 1000
        });
        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 102,
            eventType: 'recovery', confidence: 0.7,
            startedAt: '2026-01-13T00:00:00.000Z', durationSeconds: 1000
        });
        await insertEvent(executor, {
            ownerId: 2, deviceId: 10, sensorId: 1000, contextId: 103,
            eventType: 'recovery', confidence: 0.7,
            startedAt: '2026-01-13T00:00:00.000Z', durationSeconds: 1000
        });
        for (const ignoredType of ['worsening', 'anomaly', 'regime_shift', 'sensor_drift']) {
            await insertEvent(executor, {
                ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100,
                eventType: ignoredType, confidence: 0.8,
                startedAt: '2026-02-01T00:00:00.000Z'
            });
        }

        const isolated = await runRecoveryMemoryCycle({ now: clock, executor });
        assert.equal(isolated.stored, 4);
        assert.equal(isolated.skipped_missing_context, 1);
        assert.equal(isolated.skipped_invalid_identity, 1);
        assert.equal(isolated.skipped_non_production, 1);
        rows = await memorySnapshot(executor);
        assert.equal(rows.length, 4);
        assert.equal(rows.filter((row) => Number(row.device_id) === 10).length, 2, 'contexts on one device stay separate');
        assert.equal(rows.filter((row) => Number(row.device_id) === 11).length, 1, 'devices stay separate');
        assert.equal(rows.filter((row) => Number(row.owner_user_id) === 2).length, 1, 'owners stay separate');
        assert.equal(rows.some((row) => Number(row.context_id) === 102), false, 'demo context must be excluded');
        const partialDuration = rows.find((row) => Number(row.context_id) === 101);
        assert.equal(Number(partialDuration.recovery_count), 2);
        assert.equal(Number(partialDuration.evidence_json.duration.sample_count), 1, 'missing duration is not treated as zero');

        const withDemo = await runRecoveryMemoryCycle({ now: clock, includeNonProduction: true, executor });
        assert.equal(withDemo.stored, 5);
        assert.equal((await memorySnapshot(executor)).some((row) => Number(row.context_id) === 102), true);
        const productionOnly = await runRecoveryMemoryCycle({ now: clock, executor });
        assert.equal(productionOnly.removed_stale, 1);
        assert.equal((await memorySnapshot(executor)).some((row) => Number(row.context_id) === 102), false);

        await insertEvent(executor, {
            ownerId: 1, deviceId: 10, sensorId: 1000, contextId: 100, metric: 'humidity',
            eventType: 'recovery', confidence: 0.8,
            startedAt: '2026-02-10T00:00:00.000Z', durationSeconds: 1200
        });
        const beforeDryRun = JSON.stringify(await memorySnapshot(executor));
        const dryRun = await runRecoveryMemoryCycle({ now: clock, dryRun: true, executor });
        assert.equal(dryRun.stored, 5);
        assert.equal(dryRun.rows.length, 5);
        assert.equal(JSON.stringify(await memorySnapshot(executor)), beforeDryRun, 'dry-run must not write');

        const sourceBefore = await tableSnapshot(executor, ['agro_actions_detected']);
        await runRecoveryMemoryCycle({ now: clock, executor });
        const snapshotOne = JSON.stringify(await memorySnapshot(executor));
        await runRecoveryMemoryCycle({ now: clock, executor });
        const snapshotTwo = JSON.stringify(await memorySnapshot(executor));
        assert.equal(snapshotTwo, snapshotOne, 'rerun must be deterministic and idempotent');
        assert.equal((await memorySnapshot(executor)).length, 5, 'rerun must not create duplicates');
        assert.deepEqual(await tableSnapshot(executor, protectedTables), protectedBefore, 'protected tables must not change');
        assert.deepEqual(await tableSnapshot(executor, ['agro_actions_detected']), sourceBefore, 'source events must not change');
        assert.equal(Number((await executor(
            `SELECT COUNT(*) AS count FROM agro_recovery_memory
             WHERE owner_user_id IS NULL OR device_id IS NULL OR context_id IS NULL`
        ))[0].count), 0);

        const evidence = JSON.stringify((await memorySnapshot(executor))[0].evidence_json);
        assert.equal(evidence.includes('event_ids'), false, 'evidence must not contain raw event ids');
        await assert.rejects(
            () => executor(
                `INSERT INTO agro_recovery_memory
                    (owner_user_id, device_id, context_id, metric, recovery_count,
                     first_seen_at, last_seen_at)
                 VALUES (2, 20, 100, 'temperature', 1, NOW(), NOW())`
            ),
            /context_id does not belong/
        );

        console.log('PASS embedded PostgreSQL recovery memory validation');
        console.log(JSON.stringify({
            memories: 5,
            contexts: 4,
            devices: 3,
            owners: 2,
            relapse_isolated_by_context: true,
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
