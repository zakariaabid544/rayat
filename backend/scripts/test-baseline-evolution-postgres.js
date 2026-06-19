'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
    computeEwma,
    ensureBaselineSchema,
    runBaselineEvolution
} = require('../utils/baseline-evolution');

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

async function seedReadings(executor, { sensorId, start, count, days, valueFor }) {
    const startMs = Date.parse(start);
    for (let index = 0; index < count; index += 1) {
        const day = index % days;
        const positionInDay = Math.floor(index / days);
        const timestamp = new Date(startMs + day * 86400000 + positionInDay * 3600000).toISOString();
        await executor(
            'INSERT INTO sensor_readings (sensor_id, value, timestamp) VALUES (?, ?, CAST(? AS TIMESTAMPTZ))',
            [sensorId, valueFor(index), timestamp]
        );
    }
}

async function protectedSnapshot(executor) {
    const tables = ['users', 'devices', 'sensors', 'sensor_readings', 'agro_context_segments'];
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

async function baselineSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, metric, sample_count,
                mean_value, variance_value, stddev_value, min_value, max_value,
                p10_value, p50_value, p90_value, ewma_value, confidence, maturity_level, evidence_json
         FROM agro_greenhouse_baselines
         ORDER BY owner_user_id, device_id, context_id, metric`
    );
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
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
              device_id INTEGER NOT NULL REFERENCES devices(id),
              subtype TEXT NOT NULL
            );
            CREATE TABLE sensor_readings (
              id BIGSERIAL PRIMARY KEY,
              sensor_id INTEGER NOT NULL REFERENCES sensors(id),
              value NUMERIC NOT NULL,
              timestamp TIMESTAMPTZ NOT NULL
            );
            CREATE TABLE agro_context_segments (
              id BIGINT PRIMARY KEY,
              owner_user_id INTEGER NOT NULL REFERENCES users(id),
              device_id INTEGER NOT NULL REFERENCES devices(id),
              sensor_id INTEGER NULL REFERENCES sensors(id),
              is_production BOOLEAN NOT NULL,
              valid_from TIMESTAMPTZ NOT NULL,
              valid_to TIMESTAMPTZ NULL
            );
        `);
        await executor('INSERT INTO users (id) VALUES (1), (2)');
        await executor('INSERT INTO devices (id, user_id) VALUES (10, 1), (20, 2)');
        await executor("INSERT INTO sensors (id, device_id, subtype) VALUES (1000, 10, 'clima_temperature'), (2000, 20, 'clima_temperature')");
        await executor(
            `INSERT INTO agro_context_segments
                (id, owner_user_id, device_id, sensor_id, is_production, valid_from, valid_to)
             VALUES (100, 1, 10, NULL, TRUE, '2026-01-01', '2026-01-03'),
                    (200, 2, 20, NULL, TRUE, '2026-01-01', NULL)`
        );
        await seedReadings(executor, {
            sensorId: 1000,
            start: '2026-01-01T00:00:00.000Z',
            count: 5,
            days: 1,
            valueFor: (index) => (index + 1) * 10
        });

        await ensureBaselineSchema({ executor, ensureContext: async () => {} });
        const clock = new Date('2026-01-20T00:00:00.000Z');

        const first = await runBaselineEvolution({ now: clock, scope: { deviceId: 10 }, executor });
        assert.equal(first.stored, 1, 'one context must create one baseline');
        let rows = await baselineSnapshot(executor);
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].context_id), 100);
        assert.equal(Number(rows[0].sample_count), 5);
        assert.equal(Number(rows[0].mean_value), 30);
        assert.equal(Number(rows[0].variance_value), 250);
        assert.equal(Number(rows[0].stddev_value), 15.811);
        assert.equal(Number(rows[0].min_value), 10);
        assert.equal(Number(rows[0].max_value), 50);
        assert.equal(Number(rows[0].p10_value), 14);
        assert.equal(Number(rows[0].p50_value), 30);
        assert.equal(Number(rows[0].p90_value), 46);
        assert.equal(Number(rows[0].ewma_value), Number(computeEwma([10, 20, 30, 40, 50]).ewma.toFixed(3)));
        assert.equal(rows[0].evidence_json.normal_band_basis, 'empirical_p10_p90');

        await executor(
            `INSERT INTO agro_context_segments
                (id, owner_user_id, device_id, sensor_id, is_production, valid_from, valid_to)
             VALUES (101, 1, 10, NULL, TRUE, '2026-01-03', NULL)`
        );
        await seedReadings(executor, {
            sensorId: 1000,
            start: '2026-01-03T00:00:00.000Z',
            count: 30,
            days: 3,
            valueFor: (index) => 20 + (index % 5)
        });
        const twoContexts = await runBaselineEvolution({ now: clock, scope: { deviceId: 10 }, executor });
        assert.equal(twoContexts.stored, 2, 'two contexts must create two baselines');
        rows = await baselineSnapshot(executor);
        assert.equal(rows.filter((row) => Number(row.device_id) === 10).length, 2);

        await seedReadings(executor, {
            sensorId: 2000,
            start: '2026-01-01T00:00:00.000Z',
            count: 50,
            days: 7,
            valueFor: (index) => 30 + (index % 7)
        });
        const allDevices = await runBaselineEvolution({ now: clock, executor });
        assert.equal(allDevices.stored, 3);
        rows = await baselineSnapshot(executor);
        const device20 = rows.find((row) => Number(row.device_id) === 20);
        assert.ok(device20);
        assert.equal(Number(device20.owner_user_id), 2);
        assert.equal(Number(device20.context_id), 200);
        assert.equal(device20.maturity_level, 'mature');
        assert.equal(rows.find((row) => Number(row.context_id) === 100).maturity_level, 'cold_start');
        assert.equal(rows.find((row) => Number(row.context_id) === 101).maturity_level, 'stable');

        const beforeMissing = JSON.stringify(await baselineSnapshot(executor));
        await executor(
            "INSERT INTO sensor_readings (sensor_id, value, timestamp) VALUES (2000, 99, '2025-12-31T00:00:00Z')"
        );
        await assert.rejects(
            () => runBaselineEvolution({ now: clock, executor }),
            /fail-closed: 1 supported readings without valid tenant context/
        );
        assert.equal(JSON.stringify(await baselineSnapshot(executor)), beforeMissing, 'fail-closed run must not write baselines');
        await executor("DELETE FROM sensor_readings WHERE timestamp = '2025-12-31T00:00:00Z'");

        const protectedBefore = await protectedSnapshot(executor);
        await runBaselineEvolution({ now: clock, executor });
        const snapshotOne = JSON.stringify(await baselineSnapshot(executor));
        await runBaselineEvolution({ now: clock, executor });
        const snapshotTwo = JSON.stringify(await baselineSnapshot(executor));
        assert.equal(snapshotTwo, snapshotOne, 'rerun must be deterministic and idempotent');
        assert.deepEqual(await protectedSnapshot(executor), protectedBefore, 'protected source tables must not change');
        assert.equal(Number((await executor(
            `SELECT COUNT(*) AS count FROM agro_greenhouse_baselines
             WHERE owner_user_id IS NULL OR device_id IS NULL OR context_id IS NULL`
        ))[0].count), 0);

        await assert.rejects(
            () => executor(
                `INSERT INTO agro_greenhouse_baselines
                    (owner_user_id, device_id, context_id, metric, evidence_json)
                 VALUES (2, 20, 100, 'temperature', '{}'::jsonb)`
            ),
            /context_id does not belong/
        );

        console.log('PASS embedded PostgreSQL baseline validation');
        console.log(JSON.stringify({ baselines: rows.length, contexts: 3, devices: 2, protected_tables_unchanged: true }));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
