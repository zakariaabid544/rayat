'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
    ensureWeeklyNotificationSchema,
    countUnreadNotifications,
    markNotificationRead,
    listNotifications
} = require('../utils/weekly-report-notifications');
const {
    runWeeklyReportNotificationCycle,
    isEnabled
} = require('../src/jobs/weeklyReportNotificationJob');

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

async function notificationRows(executor) {
    return executor(
        `SELECT id, owner_user_id, device_id, context_id, report_file_id,
                notification_type, channel, status, recipient_user_id, recipient_email,
                title, message, payload_json, sent_at, read_at
         FROM agro_weekly_report_notifications
         ORDER BY report_file_id, recipient_user_id, channel`
    );
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const protectedTables = ['sensor_readings', 'alarm_events', 'active_alerts', 'users', 'devices', 'sensors'];
    const sourceTables = ['agro_weekly_reports', 'agro_weekly_report_files'];
    try {
        const previousFlag = process.env.AGRO_WEEKLY_NOTIFICATION_ENABLED;
        delete process.env.AGRO_WEEKLY_NOTIFICATION_ENABLED;
        assert.equal(await isEnabled({ executor }), false, 'notification job must be disabled by default');
        if (previousFlag === undefined) { delete process.env.AGRO_WEEKLY_NOTIFICATION_ENABLED; }
        else { process.env.AGRO_WEEKLY_NOTIFICATION_ENABLED = previousFlag; }

        await executor(`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY, email TEXT, role VARCHAR(32) NOT NULL,
            owner_user_id INTEGER NULL REFERENCES users(id), active BOOLEAN DEFAULT TRUE);
          CREATE TABLE devices (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
          CREATE TABLE sensors (id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES devices(id));
          CREATE TABLE sensor_readings (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER, value NUMERIC, timestamp TIMESTAMPTZ);
          CREATE TABLE alarm_events (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER);
          CREATE TABLE active_alerts (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER);
          CREATE TABLE agro_context_segments (
            id BIGINT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
            device_id INTEGER NOT NULL REFERENCES devices(id));
          CREATE TABLE agro_weekly_reports (
            id BIGINT PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, week_start DATE NOT NULL, week_end DATE NOT NULL);
          CREATE TABLE agro_weekly_report_files (
            id BIGINT PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, week_start DATE NOT NULL,
            report_id BIGINT NOT NULL REFERENCES agro_weekly_reports(id),
            file_name TEXT NOT NULL, file_path TEXT NOT NULL, file_size BIGINT NOT NULL,
            checksum CHAR(64) NOT NULL, generated_at TIMESTAMPTZ NOT NULL);
        `);
        await executor(
            `INSERT INTO users (id, email, role, owner_user_id, active)
             VALUES (1, 'owner1@example.test', 'client', NULL, TRUE),
                    (2, 'owner2@example.test', 'client', NULL, TRUE),
                    (3, 'team1@example.test', 'client', 1, TRUE),
                    (4, 'disabled@example.test', 'client', 1, FALSE),
                    (99, 'root@example.test', 'super_admin', NULL, TRUE)`
        );
        await executor('INSERT INTO devices (id, user_id) VALUES (10, 1), (20, 2)');
        await executor('INSERT INTO sensors (id, device_id) VALUES (1000, 10), (2000, 20)');
        await executor("INSERT INTO sensor_readings (sensor_id, value, timestamp) VALUES (1000, 20, '2026-06-01')");
        await executor('INSERT INTO alarm_events (sensor_id) VALUES (1000)');
        await executor('INSERT INTO active_alerts (sensor_id) VALUES (1000)');
        await executor(
            `INSERT INTO agro_context_segments (id, owner_user_id, device_id)
             VALUES (100, 1, 10), (101, 1, 10), (200, 2, 20)`
        );
        await executor(
            `INSERT INTO agro_weekly_reports (id, owner_user_id, device_id, context_id, week_start, week_end)
             VALUES (400, 1, 10, 100, '2026-06-15', '2026-06-21'),
                    (401, 1, 10, 101, '2026-06-15', '2026-06-21'),
                    (500, 2, 20, 200, '2026-06-15', '2026-06-21')`
        );
        await executor(
            `INSERT INTO agro_weekly_report_files
              (id, owner_user_id, device_id, context_id, week_start, report_id,
               file_name, file_path, file_size, checksum, generated_at)
             VALUES (600, 1, 10, 100, '2026-06-15', 400, 'a.pdf', '/tmp/a.pdf', 10, ?, '2026-06-23'),
                    (601, 1, 10, 101, '2026-06-15', 401, 'b.pdf', '/tmp/b.pdf', 10, ?, '2026-06-23'),
                    (700, 2, 20, 200, '2026-06-15', 500, 'c.pdf', '/tmp/c.pdf', 10, ?, '2026-06-23')`,
            ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
        );

        await ensureWeeklyNotificationSchema({ executor });
        const constraints = await executor(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'agro_weekly_report_notifications'::regclass`
        );
        const constraintNames = new Set(constraints.map((row) => row.conname));
        assert.ok(constraintNames.has('uniq_weekly_report_notification'));
        assert.ok(constraintNames.has('weekly_report_notification_values_check'));
        const triggers = await executor(
            `SELECT tgname FROM pg_trigger
             WHERE tgrelid = 'agro_weekly_report_notifications'::regclass AND NOT tgisinternal`
        );
        assert.ok(triggers.some((row) => row.tgname === 'weekly_notification_identity_guard'));

        const protectedBefore = await snapshot(executor, protectedTables);
        const sourcesBefore = await snapshot(executor, sourceTables);
        const dry = await runWeeklyReportNotificationCycle({
            dryRun: true, includeEmailPending: true, executor
        });
        assert.equal(dry.report_recipients, 5);
        assert.equal(dry.would_create, 10);
        assert.equal((await notificationRows(executor)).length, 0, 'dry-run must not write');

        const first = await runWeeklyReportNotificationCycle({ executor });
        assert.equal(first.created, 5);
        assert.deepEqual(first.by_channel, { in_app: 5, email_pending: 0 });
        let rows = await notificationRows(executor);
        assert.equal(rows.length, 5);
        assert.equal(rows.every((row) => row.channel === 'in_app' && row.status === 'delivered'), true);
        assert.equal(rows.filter((row) => Number(row.owner_user_id) === 1).length, 4);
        assert.equal(rows.filter((row) => Number(row.context_id) === 100).length, 2);
        assert.equal(rows.some((row) => Number(row.recipient_user_id) === 4), false, 'disabled user excluded');

        const second = await runWeeklyReportNotificationCycle({ executor });
        assert.equal(second.created, 0);
        assert.equal(second.existing, 5);
        assert.equal((await notificationRows(executor)).length, 5, 'rerun creates no duplicates');

        const emailPass = await runWeeklyReportNotificationCycle({ includeEmailPending: true, executor });
        assert.equal(emailPass.created, 5);
        assert.equal(emailPass.by_channel.email_pending, 5);
        rows = await notificationRows(executor);
        assert.equal(rows.length, 10);
        assert.equal(rows.filter((row) => row.channel === 'email_pending').every((row) => row.status === 'pending'), true);
        assert.equal(rows.filter((row) => row.channel === 'email_pending').every((row) => Boolean(row.recipient_email)), true);
        assert.equal(JSON.stringify(rows.map((row) => row.payload_json)).includes('raw_evidence'), false);
        const ownerList = await listNotifications({
            user: { id: 1, scopeOwnerUserId: 1 }, executor
        });
        assert.equal(ownerList.total, 2, 'customer list exposes in_app only');
        assert.equal(ownerList.notifications.every((row) => row.channel === 'in_app'), true);
        const adminList = await listNotifications({
            user: { id: 99, role: 'super_admin' },
            filters: { owner_user_id: 1 },
            admin: true,
            executor
        });
        assert.equal(adminList.total, 8, 'super admin can inspect both channels');

        assert.deepEqual(
            await countUnreadNotifications({ user: { id: 1, scopeOwnerUserId: 1 }, executor }),
            { unread: 2 }
        );
        assert.deepEqual(
            await countUnreadNotifications({ user: { id: 3, owner_user_id: 1, scopeOwnerUserId: 1 }, executor }),
            { unread: 2 }
        );
        const ownerNotification = rows.find((row) => row.channel === 'in_app' && Number(row.recipient_user_id) === 1);
        const marked = await markNotificationRead({
            notificationId: ownerNotification.id,
            user: { id: 1, scopeOwnerUserId: 1 },
            executor
        });
        assert.equal(marked.status, 'read');
        assert.deepEqual(
            await countUnreadNotifications({ user: { id: 1, scopeOwnerUserId: 1 }, executor }),
            { unread: 1 }
        );
        await assert.rejects(
            () => markNotificationRead({
                notificationId: ownerNotification.id,
                user: { id: 2, scopeOwnerUserId: 2 },
                executor
            }),
            /Notifica non trovata/
        );
        await assert.rejects(
            () => executor(
                `INSERT INTO agro_weekly_report_notifications
                  (owner_user_id, device_id, context_id, report_file_id, notification_type,
                   channel, status, recipient_user_id, title, message)
                 VALUES (1, 10, 100, 600, 'weekly_report_ready', 'in_app',
                         'delivered', 2, 'Bad', 'Bad')`
            ),
            /recipient belongs to another owner/
        );

        assert.deepEqual(await snapshot(executor, protectedTables), protectedBefore, 'protected tables unchanged');
        assert.deepEqual(await snapshot(executor, sourceTables), sourcesBefore, 'report source tables unchanged');
        console.log('PASS embedded PostgreSQL weekly report notification validation');
        console.log(JSON.stringify({
            notifications: 10,
            in_app: 5,
            email_pending: 5,
            owners: 2,
            contexts: 3,
            recipients: 3,
            idempotent: true,
            unread_and_mark_read: true,
            tenant_context_isolation: true,
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
