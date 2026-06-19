'use strict';

const assert = require('node:assert/strict');
const { pool, query } = require('../config/database');

const SCOPED_TABLES = [
    'agro_success_patterns',
    'agro_pattern_intelligence',
    'agro_triggers',
    'agro_trigger_intelligence',
    'agro_recovery_intelligence'
];
const LOCAL_TABLES = ['agro_local_learning', 'agro_learning_delta'];
const ALL_TABLES = ['agro_actions_detected', ...SCOPED_TABLES, ...LOCAL_TABLES, 'agro_global_learning'];

async function inspectSchema() {
    const result = {};
    for (const table of ALL_TABLES) {
        const columns = await query(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = ?
               AND column_name IN (
                 'owner_user_id','device_id','greenhouse_scope','distinct_owner_count',
                 'distinct_device_count','fleet_eligible','benchmark_only'
               )
             ORDER BY ordinal_position`,
            [table]
        );
        const constraints = await query(
            `SELECT contype, COUNT(*)::int AS count
             FROM pg_constraint WHERE conrelid = ?::regclass
             GROUP BY contype ORDER BY contype`,
            [table]
        );
        const triggers = await query(
            `SELECT COUNT(*)::int AS count FROM pg_trigger
             WHERE tgrelid = ?::regclass AND tgname = ? AND NOT tgisinternal`,
            [table, `${table}_tenant_identity_guard`]
        );
        result[table] = {
            columns: columns.map((row) => row.column_name),
            constraints: Object.fromEntries(constraints.map((row) => [row.contype, row.count])),
            identity_triggers: triggers[0].count
        };
    }
    return result;
}

async function inspectData() {
    const result = {};
    const actionOrphans = await query(
        `SELECT COUNT(*)::int AS count
         FROM agro_actions_detected a
         LEFT JOIN devices d ON d.id = a.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN sensors s ON s.id = a.sensor_id
         WHERE a.owner_user_id IS NULL OR a.device_id IS NULL OR a.sensor_id IS NULL
            OR a.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR s.device_id IS DISTINCT FROM a.device_id`
    );
    result.agro_actions_detected = { orphans: actionOrphans[0].count };

    for (const table of SCOPED_TABLES) {
        const rows = await query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE scope_type = 'greenhouse')::int AS local_rows,
                    COUNT(*) FILTER (WHERE scope_type = 'fleet')::int AS fleet_rows,
                    COUNT(*) FILTER (
                      WHERE scope_type = 'greenhouse'
                        AND (owner_user_id IS NULL OR device_id IS NULL OR greenhouse_scope IS DISTINCT FROM device_id)
                    )::int AS local_orphans,
                    COUNT(*) FILTER (
                      WHERE scope_type = 'fleet'
                        AND (owner_user_id IS NOT NULL OR device_id IS NOT NULL OR greenhouse_scope IS NOT NULL)
                    )::int AS fleet_identity_leaks
             FROM ${table}`
        );
        result[table] = rows[0];
    }

    for (const table of LOCAL_TABLES) {
        const rows = await query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (
                      WHERE owner_user_id IS NULL OR device_id IS NULL OR greenhouse_scope IS DISTINCT FROM device_id
                    )::int AS orphans
             FROM ${table}`
        );
        result[table] = rows[0];
    }

    result.agro_global_learning = (await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE fleet_eligible AND distinct_owner_count < 3)::int AS invalid_eligible,
                COUNT(*) FILTER (
                  WHERE NOT fleet_eligible
                    AND (
                      event_count <> 0 OR baselines IS DISTINCT FROM '{}'::jsonb
                      OR best_practices IS DISTINCT FROM '[]'::jsonb
                      OR common_failures IS DISTINCT FROM '[]'::jsonb
                    )
                )::int AS suppressed_payload_leaks
         FROM agro_global_learning`
    ))[0];
    return result;
}

async function inspectFleetEvidence() {
    return {
        pattern: (await query(
            `SELECT COUNT(*)::int AS count FROM agro_pattern_intelligence
             WHERE scope_type = 'fleet' AND supporting_event_ids IS DISTINCT FROM '[]'::jsonb`
        ))[0].count,
        trigger: (await query(
            `SELECT COUNT(*)::int AS count FROM agro_triggers
             WHERE scope_type = 'fleet' AND supporting_examples IS DISTINCT FROM '[]'::jsonb`
        ))[0].count,
        trigger_intelligence: (await query(
            `SELECT COUNT(*)::int AS count FROM agro_trigger_intelligence
             WHERE scope_type = 'fleet' AND supporting_event_ids IS DISTINCT FROM '[]'::jsonb`
        ))[0].count,
        recovery: (await query(
            `SELECT COUNT(*)::int AS count FROM agro_recovery_intelligence
             WHERE scope_type = 'fleet' AND supporting_event_ids IS DISTINCT FROM '[]'::jsonb`
        ))[0].count
    };
}

async function verifyNegativeWrites() {
    const client = await pool.connect();
    let wrongOwnerRejected = false;
    let fleetIdentityRejected = false;
    let fleetEvidenceRejected = false;
    try {
        const sample = (await client.query(
            `SELECT a.id,
                    (SELECT id FROM users WHERE id <> a.owner_user_id ORDER BY id LIMIT 1) AS wrong_owner
             FROM agro_actions_detected a LIMIT 1`
        )).rows[0];
        assert.ok(sample && sample.wrong_owner, 'negative owner test requires an alternate user');
        await client.query('BEGIN');
        try {
            await client.query('UPDATE agro_actions_detected SET owner_user_id = $1 WHERE id = $2', [sample.wrong_owner, sample.id]);
        } catch (error) {
            wrongOwnerRejected = /does not own/.test(error.message);
        }
        await client.query('ROLLBACK');

        await client.query('BEGIN');
        try {
            await client.query(
                `INSERT INTO agro_success_patterns
                    (pattern_id, pattern_type, event_sequence, sequence_length, occurrences, confidence,
                     scope_type, greenhouse_scope, fleet_scope, owner_user_id, device_id)
                 VALUES ('s27a-negative-fleet', 'other', 'x>y', 2, 3, 0.5, 'fleet', 1, TRUE, 1, 1)`
            );
        } catch (error) {
            fleetIdentityRejected = /cannot retain/.test(error.message);
        }
        await client.query('ROLLBACK');

        const pattern = (await client.query(
            `SELECT id FROM agro_pattern_intelligence WHERE scope_type = 'greenhouse' LIMIT 1`
        )).rows[0];
        assert.ok(pattern, 'negative fleet evidence test requires one local pattern');
        await client.query('BEGIN');
        try {
            await client.query(
                `UPDATE agro_pattern_intelligence
                 SET scope_type = 'fleet', greenhouse_scope = NULL,
                     owner_user_id = NULL, device_id = NULL,
                     supporting_event_ids = '[1]'::jsonb
                 WHERE id = $1`,
                [pattern.id]
            );
        } catch (error) {
            fleetEvidenceRejected = error.code === '23514';
        }
        await client.query('ROLLBACK');
    } finally {
        client.release();
    }
    return {
        wrong_owner_rejected: wrongOwnerRejected,
        fleet_identity_rejected: fleetIdentityRejected,
        fleet_evidence_rejected: fleetEvidenceRejected
    };
}

async function main() {
    const schema = await inspectSchema();
    const data = await inspectData();
    const privacy = await inspectFleetEvidence();
    const negativeWrites = await verifyNegativeWrites();
    const sourceIdentity = (await query(
        `SELECT COUNT(*)::int AS actions,
                COUNT(DISTINCT owner_user_id)::int AS owners,
                COUNT(DISTINCT device_id)::int AS devices
         FROM agro_actions_detected`
    ))[0];

    for (const table of ['agro_actions_detected', ...SCOPED_TABLES, ...LOCAL_TABLES]) {
        assert.equal(schema[table].identity_triggers, 1, `${table} identity trigger`);
        assert.ok(schema[table].constraints.f >= 2, `${table} identity foreign keys`);
        assert.ok(schema[table].constraints.c >= 1, `${table} identity check`);
    }
    assert.equal(data.agro_actions_detected.orphans, 0);
    for (const table of SCOPED_TABLES) {
        assert.equal(data[table].local_orphans, 0, `${table} local orphans`);
        assert.equal(data[table].fleet_identity_leaks, 0, `${table} fleet identity leaks`);
    }
    for (const table of LOCAL_TABLES) { assert.equal(data[table].orphans, 0, `${table} orphans`); }
    assert.equal(data.agro_global_learning.invalid_eligible, 0);
    assert.equal(data.agro_global_learning.suppressed_payload_leaks, 0);
    assert.deepEqual(privacy, { pattern: 0, trigger: 0, trigger_intelligence: 0, recovery: 0 });
    assert.deepEqual(negativeWrites, {
        wrong_owner_rejected: true,
        fleet_identity_rejected: true,
        fleet_evidence_rejected: true
    });

    console.log('schema=' + JSON.stringify(schema));
    console.log('data_audit=' + JSON.stringify(data));
    console.log('fleet_raw_evidence_rows=' + JSON.stringify(privacy));
    console.log('negative_writes=' + JSON.stringify(negativeWrites));
    console.log('source_identity=' + JSON.stringify(sourceIdentity));
    console.log('PASS database tenant isolation audit');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error.stack || error);
        process.exit(1);
    });
