'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const weeklyReportsRouter = require('../routes/weekly-reports');
const weeklyNotificationsRouter = require('../routes/weekly-notifications');
const {
    ensureWeeklyNotificationSchema,
    runWeeklyNotificationCycle
} = require('../utils/weekly-report-notifications');

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

function testAuthentication(users) {
    return (req, res, next) => {
        const user = users[req.headers['x-test-user']];
        if (!user) { return res.status(401).json({ error: 'auth required' }); }
        req.user = user;
        return next();
    };
}

async function jsonRequest(baseUrl, route, user, options = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
        ...options,
        headers: { ...(options.headers || {}), ...(user ? { 'x-test-user': user } : {}) }
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_error) { body = text; }
    return { response, body };
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rayat-report-api-'));
    let server = null;
    try {
        await executor(`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY, email TEXT, role VARCHAR(32) NOT NULL,
            owner_user_id INTEGER NULL REFERENCES users(id), active BOOLEAN DEFAULT TRUE);
          CREATE TABLE devices (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
          CREATE TABLE agro_context_segments (
            id BIGINT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
            device_id INTEGER NOT NULL REFERENCES devices(id));
          CREATE TABLE agro_weekly_fact_packages (
            id BIGINT PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, week_start DATE NOT NULL, week_end DATE NOT NULL,
            health_summary JSONB NOT NULL, intelligence_score_summary JSONB NOT NULL,
            subscore_summary JSONB NOT NULL, trend_summary JSONB NOT NULL,
            benchmark_summary JSONB NOT NULL, positive_factors JSONB NOT NULL,
            negative_factors JSONB NOT NULL, recommended_focus JSONB NOT NULL,
            data_quality_notes JSONB NOT NULL, limitations JSONB NOT NULL,
            evidence_json JSONB NOT NULL, rule_version VARCHAR(20) NOT NULL);
          CREATE TABLE agro_weekly_reports (
            id BIGINT PRIMARY KEY, fact_package_id BIGINT NOT NULL REFERENCES agro_weekly_fact_packages(id),
            owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL, context_id BIGINT NOT NULL,
            week_start DATE NOT NULL, week_end DATE NOT NULL, language VARCHAR(8) NOT NULL,
            executive_summary TEXT NOT NULL, greenhouse_status TEXT NOT NULL,
            improvements TEXT NOT NULL, deteriorations TEXT NOT NULL, stress_recovery TEXT NOT NULL,
            benchmark TEXT NOT NULL, recommended_focus TEXT NOT NULL, data_quality_notes TEXT NOT NULL,
            report_text TEXT NOT NULL, evidence_json JSONB NOT NULL, rule_version VARCHAR(20) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
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
                    (3, 'team@example.test', 'client', 1, TRUE),
                    (99, 'root@example.test', 'super_admin', NULL, TRUE),
                    (98, 'admin@example.test', 'admin', NULL, TRUE)`
        );
        await executor('INSERT INTO devices (id, user_id) VALUES (10, 1), (20, 2)');
        await executor('INSERT INTO agro_context_segments (id, owner_user_id, device_id) VALUES (100, 1, 10), (200, 2, 20)');

        const ownerPdf = Buffer.from('%PDF-1.4\nowner-one-report\n%%EOF\n');
        const owner2Pdf = Buffer.from('%PDF-1.4\nowner-two-report\n%%EOF\n');
        const ownerPath = path.join(outputDir, 'owner-1.pdf');
        const owner2Path = path.join(outputDir, 'owner-2.pdf');
        await fs.promises.writeFile(ownerPath, ownerPdf);
        await fs.promises.writeFile(owner2Path, owner2Pdf);

        await executor(
            `INSERT INTO agro_weekly_fact_packages
              (id, owner_user_id, device_id, context_id, week_start, week_end,
               health_summary, intelligence_score_summary, subscore_summary, trend_summary,
               benchmark_summary, positive_factors, negative_factors, recommended_focus,
               data_quality_notes, limitations, evidence_json, rule_version)
             VALUES (300, 1, 10, 100, '2026-06-15', '2026-06-21',
               '{"health_score":86}'::jsonb, '{"intelligence_score":88}'::jsonb,
               '{"stability":90}'::jsonb, '{"improved":["intelligence_score"]}'::jsonb,
               '{"available":true}'::jsonb, '[]'::jsonb, '[]'::jsonb,
               '["maintain_current_practices"]'::jsonb, '["Qualita 91"]'::jsonb,
               '[]'::jsonb, '{}'::jsonb, 's5.1'),
                    (301, 2, 20, 200, '2026-06-15', '2026-06-21',
               '{"health_score":45}'::jsonb, '{"intelligence_score":42}'::jsonb,
               '{"stability":40}'::jsonb, '{"worsened":["stress"]}'::jsonb,
               '{"available":false}'::jsonb, '[]'::jsonb, '[]'::jsonb,
               '["reduce_stress"]'::jsonb, '["Qualita 55"]'::jsonb,
               '["Benchmark non disponibile"]'::jsonb, '{}'::jsonb, 's5.1')`
        );
        await executor(
            `INSERT INTO agro_weekly_reports
              (id, fact_package_id, owner_user_id, device_id, context_id, week_start, week_end,
               language, executive_summary, greenhouse_status, improvements, deteriorations,
               stress_recovery, benchmark, recommended_focus, data_quality_notes, report_text,
               evidence_json, rule_version, created_at, updated_at)
             VALUES (400, 300, 1, 10, 100, '2026-06-15', '2026-06-21', 'it',
               'Serra stabile.', 'Salute buona.', 'Stabilita migliorata.', 'Nessun peggioramento.',
               'Recupero forte.', 'Quartile alto.', 'Mantenere pratiche.', 'Dati affidabili.',
               'REPORT OWNER ONE', '{}'::jsonb, 's5.2', '2026-06-23', '2026-06-23'),
                    (500, 301, 2, 20, 200, '2026-06-15', '2026-06-21', 'it',
               'Serra da monitorare.', 'Salute debole.', 'Nessun miglioramento.', 'Stress peggiore.',
               'Recupero fragile.', 'Benchmark non disponibile.', 'Ridurre stress.', 'Dati medi.',
               'REPORT OWNER TWO', '{}'::jsonb, 's5.2', '2026-06-23', '2026-06-23')`
        );
        await executor(
            `INSERT INTO agro_weekly_report_files
              (id, owner_user_id, device_id, context_id, week_start, report_id,
               file_name, file_path, file_size, checksum, generated_at)
             VALUES (600, 1, 10, 100, '2026-06-15', 400, 'owner-1.pdf', ?, ?, ?, '2026-06-23'),
                    (700, 2, 20, 200, '2026-06-15', 500, 'owner-2.pdf', ?, ?, ?, '2026-06-23')`,
            [ownerPath, ownerPdf.length, crypto.createHash('sha256').update(ownerPdf).digest('hex'),
                owner2Path, owner2Pdf.length, crypto.createHash('sha256').update(owner2Pdf).digest('hex')]
        );
        await ensureWeeklyNotificationSchema({ executor });
        const created = await runWeeklyNotificationCycle({ executor });
        assert.equal(created.created, 3);

        const users = {
            owner1: { id: 1, role: 'client', scopeOwnerUserId: 1 },
            owner2: { id: 2, role: 'client', scopeOwnerUserId: 2 },
            team: { id: 3, role: 'client', owner_user_id: 1, scopeOwnerUserId: 1 },
            root: { id: 99, role: 'super_admin' },
            admin: { id: 98, role: 'admin' }
        };
        const authenticate = testAuthentication(users);
        const app = express();
        app.use(express.json());
        app.use('/api/reports', weeklyReportsRouter.createWeeklyReportsRouter({ executor, authenticate, outputDir }));
        app.use('/api/notifications', weeklyNotificationsRouter.createWeeklyNotificationsRouter({ executor, authenticate }));
        server = await new Promise((resolve) => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        let result = await jsonRequest(baseUrl, '/api/reports/weekly', 'owner1');
        assert.equal(result.response.status, 200);
        assert.equal(result.body.total, 1);
        assert.equal(result.body.reports[0].id, 400);
        assert.equal(JSON.stringify(result.body).includes('file_path'), false, 'server path must not leak');

        result = await jsonRequest(baseUrl, '/api/reports/weekly?context_id=200', 'owner1');
        assert.equal(result.body.total, 0, 'context filter remains owner-scoped');
        result = await jsonRequest(baseUrl, '/api/reports/weekly?owner_user_id=2', 'owner1');
        assert.equal(result.response.status, 403);
        result = await jsonRequest(baseUrl, '/api/reports/weekly?device_id=10&context_id=100&week_start=2026-06-01&week_end=2026-06-30', 'team');
        assert.equal(result.body.total, 1, 'team member can read owner reports');

        result = await jsonRequest(baseUrl, '/api/reports/weekly?owner_user_id=2', 'root');
        assert.equal(result.body.total, 1);
        assert.equal(result.body.reports[0].id, 500);
        result = await jsonRequest(baseUrl, '/api/reports/weekly?owner_user_id=2', 'admin');
        assert.equal(result.response.status, 403, 'non-super admin cannot inspect another owner');

        result = await jsonRequest(baseUrl, '/api/reports/weekly/400', 'owner1');
        assert.equal(result.response.status, 200);
        assert.equal(Number(result.body.health_summary.health_score), 86);
        result = await jsonRequest(baseUrl, '/api/reports/weekly/400/text', 'owner1');
        assert.equal(result.body.report_text, 'REPORT OWNER ONE');
        result = await jsonRequest(baseUrl, '/api/reports/weekly/400/pdf', 'owner1');
        assert.equal(result.body.file_name, 'owner-1.pdf');
        assert.equal(JSON.stringify(result.body).includes('file_path'), false);
        result = await jsonRequest(baseUrl, '/api/reports/weekly/400', 'owner2');
        assert.equal(result.response.status, 404, 'cross-customer report lookup must not leak existence');

        const download = await fetch(`${baseUrl}/api/reports/weekly/400/download`, {
            headers: { 'x-test-user': 'owner1' }
        });
        assert.equal(download.status, 200);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), ownerPdf);
        const forbiddenDownload = await fetch(`${baseUrl}/api/reports/weekly/400/download`, {
            headers: { 'x-test-user': 'owner2' }
        });
        assert.equal(forbiddenDownload.status, 404);

        result = await jsonRequest(baseUrl, '/api/notifications', 'owner1');
        assert.equal(result.body.total, 1);
        const ownerNotificationId = Number(result.body.notifications[0].id);
        result = await jsonRequest(baseUrl, '/api/notifications', 'team');
        assert.equal(result.body.total, 1);
        result = await jsonRequest(baseUrl, '/api/notifications/unread-count', 'owner1');
        assert.deepEqual(result.body, { unread: 1 });
        result = await jsonRequest(baseUrl, `/api/notifications/${ownerNotificationId}/read`, 'owner1', { method: 'PATCH' });
        assert.equal(result.body.status, 'read');
        result = await jsonRequest(baseUrl, '/api/notifications/unread-count', 'owner1');
        assert.deepEqual(result.body, { unread: 0 });
        result = await jsonRequest(baseUrl, `/api/notifications/${ownerNotificationId}/read`, 'owner2', { method: 'PATCH' });
        assert.equal(result.response.status, 404);

        result = await jsonRequest(baseUrl, '/api/notifications/admin?owner_user_id=1', 'root');
        assert.equal(result.body.total, 2);
        result = await jsonRequest(baseUrl, '/api/notifications/admin', 'owner1');
        assert.equal(result.response.status, 403);
        result = await jsonRequest(baseUrl, '/api/reports/weekly', null);
        assert.equal(result.response.status, 401);

        console.log('PASS weekly report history and notification route/API validation');
        console.log(JSON.stringify({
            report_list_and_filters: true,
            metadata_and_text: true,
            pdf_download_authorization: true,
            owner_and_team_scope: true,
            super_admin_inspection: true,
            cross_customer_hidden: true,
            unread_and_mark_read: true
        }));
    } finally {
        if (server) { await new Promise((resolve) => server.close(resolve)); }
        await db.close();
        await fs.promises.rm(outputDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
