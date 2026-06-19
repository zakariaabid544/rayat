'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const {
    ensureWeeklyPdfSchema,
    loadWeeklyPdfSource,
    sha256
} = require('../utils/weekly-pdf-export');
const {
    runWeeklyPdfCycle,
    isEnabled
} = require('../src/jobs/weeklyPdfJob');

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

async function fileRows(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, week_start, report_id,
                file_name, file_path, file_size, checksum, generated_at
         FROM agro_weekly_report_files
         ORDER BY owner_user_id, device_id, context_id, week_start`
    );
}

async function seedWeeklyReport(executor, identity, strong, benchmarkAvailable = true) {
    const health = {
        available: true, health_score: strong ? 86 : 34, health_band: strong ? 'excellent' : 'risk',
        resilience_score: strong ? 88 : 35, stress_load_score: strong ? 18 : 82,
        recovery_score: strong ? 84 : 32, stability_score: strong ? 90 : 38,
        data_confidence_score: strong ? 91 : 56
    };
    const intelligence = {
        available: true, intelligence_score: strong ? 88 : 36,
        intelligence_band: strong ? 'excellent' : 'risk', confidence: strong ? 0.9 : 0.55
    };
    const subscores = {
        available: true, stability: strong ? 90 : 38, stress: strong ? 86 : 22,
        recovery: strong ? 84 : 32, resilience: strong ? 88 : 35,
        data_quality: strong ? 91 : 56, maturity: strong ? 95 : 50
    };
    const trends = {
        available: true,
        items: [{
            metric: strong ? 'intelligence_score' : 'stress',
            direction: strong ? 'improving' : 'degrading', strength: strong ? 0.7 : 0.8
        }]
    };
    const benchmark = benchmarkAvailable ? {
        available: true, status: 'ok', percentile_rank: strong ? 88 : 22,
        relative_position: strong ? 'top_quartile' : 'bottom_quartile',
        cohort_size: 12, distinct_owner_count: 6
    } : { available: false, status: 'insufficient_population' };
    const factRows = await executor(
        `INSERT INTO agro_weekly_fact_packages
          (owner_user_id, device_id, context_id, week_start, week_end,
           health_summary, intelligence_score_summary, subscore_summary, trend_summary,
           benchmark_summary, positive_factors, negative_factors, recommended_focus,
           data_quality_notes, limitations, rule_version)
         VALUES (?, ?, ?, '2026-06-15', '2026-06-21', CAST(? AS JSONB), CAST(? AS JSONB),
           CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB),
           CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), 's5.1')
         RETURNING id`,
        [identity.ownerId, identity.deviceId, identity.contextId,
            JSON.stringify(health), JSON.stringify(intelligence), JSON.stringify(subscores),
            JSON.stringify(trends), JSON.stringify(benchmark),
            JSON.stringify(strong ? [{ label: 'stabilità ambientale', score: 90 }] : []),
            JSON.stringify(strong ? [] : [{ label: 'pressione da stress', score: 82 }]),
            JSON.stringify(strong ? ['maintain_current_practices'] : ['reduce_ec_stress']),
            JSON.stringify([`Qualità dei dati: ${strong ? 91 : 56}/100.`]),
            JSON.stringify(strong ? [] : ['Apprendimento ancora in corso.'])]
    );
    const factId = Number(factRows[0].id);
    const reports = await executor(
        `INSERT INTO agro_weekly_reports
          (fact_package_id, owner_user_id, device_id, context_id, week_start, week_end, language,
           executive_summary, greenhouse_status, improvements, deteriorations, stress_recovery,
           benchmark, recommended_focus, data_quality_notes, report_text, rule_version)
         VALUES (?, ?, ?, ?, '2026-06-15', '2026-06-21', 'it', ?, ?, ?, ?, ?, ?, ?, ?, ?, 's5.2')
         RETURNING id`,
        [factId, identity.ownerId, identity.deviceId, identity.contextId,
            strong
                ? 'La serra presenta un profilo complessivamente eccellente.'
                : 'La serra richiede attenzione sui principali indicatori.',
            strong ? 'Indicatori locali stabili e affidabili.' : 'Stress elevato e recupero fragile.',
            strong ? 'Miglioramento del punteggio complessivo.' : 'Nessun miglioramento affidabile.',
            strong ? 'Nessun peggioramento affidabile.' : 'La gestione dello stress è in peggioramento.',
            strong
                ? 'Carico di stress 18/100. Capacità di recupero 84/100.'
                : 'Carico di stress 82/100. Capacità di recupero 32/100.',
            benchmarkAvailable ? 'Confronto nel quartile di riferimento.' : 'Benchmark non disponibile.',
            strong ? '- Mantenere le pratiche attuali.' : '- Ridurre gli episodi di stress associati a EC.',
            `- Qualità dei dati: ${strong ? 91 : 56}/100.`,
            strong ? 'Report settimanale forte.' : 'Report settimanale debole.']
    );
    return Number(reports[0].id);
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const requestedOutput = String(process.env.AGRO_PDF_TEST_OUTPUT_DIR || '').trim();
    const outputDir = requestedOutput
        ? path.resolve(requestedOutput)
        : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rayat-weekly-pdf-'));
    const protectedTables = ['sensor_readings', 'alarm_events', 'active_alerts', 'users', 'devices', 'sensors'];
    const sourceTables = ['agro_weekly_fact_packages', 'agro_weekly_reports'];
    try {
        await fs.promises.rm(outputDir, { recursive: true, force: true });
        await fs.promises.mkdir(outputDir, { recursive: true });
        const configuredFlag = process.env.AGRO_WEEKLY_PDF_ENABLED;
        delete process.env.AGRO_WEEKLY_PDF_ENABLED;
        assert.equal(await isEnabled({ executor }), false, 'weekly PDF job must be disabled by default');
        if (configuredFlag === undefined) { delete process.env.AGRO_WEEKLY_PDF_ENABLED; }
        else { process.env.AGRO_WEEKLY_PDF_ENABLED = configuredFlag; }

        await executor(`
          CREATE TABLE users (id INTEGER PRIMARY KEY, owner_user_id INTEGER NULL REFERENCES users(id));
          CREATE TABLE devices (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
          CREATE TABLE sensors (id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES devices(id));
          CREATE TABLE sensor_readings (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER, value NUMERIC, timestamp TIMESTAMPTZ);
          CREATE TABLE alarm_events (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER);
          CREATE TABLE active_alerts (id BIGSERIAL PRIMARY KEY, sensor_id INTEGER);
          CREATE TABLE agro_context_segments (
            id BIGINT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
            device_id INTEGER NOT NULL REFERENCES devices(id), usage_type VARCHAR(20) NOT NULL,
            is_production BOOLEAN NOT NULL, valid_from TIMESTAMPTZ NOT NULL);
          CREATE TABLE agro_weekly_fact_packages (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL, week_start DATE NOT NULL, week_end DATE NOT NULL,
            health_summary JSONB NOT NULL, intelligence_score_summary JSONB NOT NULL,
            subscore_summary JSONB NOT NULL, trend_summary JSONB NOT NULL,
            benchmark_summary JSONB NOT NULL, positive_factors JSONB NOT NULL,
            negative_factors JSONB NOT NULL, recommended_focus JSONB NOT NULL,
            data_quality_notes JSONB NOT NULL, limitations JSONB NOT NULL,
            rule_version VARCHAR(20) NOT NULL);
          CREATE TABLE agro_weekly_reports (
            id BIGSERIAL PRIMARY KEY, fact_package_id BIGINT NOT NULL REFERENCES agro_weekly_fact_packages(id),
            owner_user_id INTEGER NOT NULL, device_id INTEGER NOT NULL, context_id BIGINT NOT NULL,
            week_start DATE NOT NULL, week_end DATE NOT NULL, language VARCHAR(8) NOT NULL,
            executive_summary TEXT NOT NULL, greenhouse_status TEXT NOT NULL,
            improvements TEXT NOT NULL, deteriorations TEXT NOT NULL, stress_recovery TEXT NOT NULL,
            benchmark TEXT NOT NULL, recommended_focus TEXT NOT NULL, data_quality_notes TEXT NOT NULL,
            report_text TEXT NOT NULL, rule_version VARCHAR(20) NOT NULL);
        `);
        await executor('INSERT INTO users (id) VALUES (1), (2)');
        await executor('INSERT INTO devices (id, user_id) VALUES (10, 1), (11, 1), (20, 2)');
        await executor('INSERT INTO sensors (id, device_id) VALUES (1000, 10), (1100, 11), (2000, 20)');
        await executor("INSERT INTO sensor_readings (sensor_id, value, timestamp) VALUES (1000, 20, '2026-06-01')");
        await executor('INSERT INTO alarm_events (sensor_id) VALUES (1000)');
        await executor('INSERT INTO active_alerts (sensor_id) VALUES (1000)');
        await executor(
            `INSERT INTO agro_context_segments (id, owner_user_id, device_id, usage_type, is_production, valid_from)
             VALUES (100, 1, 10, 'production', TRUE, '2026-01-01'),
                    (101, 1, 10, 'production', TRUE, '2026-01-01'),
                    (110, 1, 11, 'production', TRUE, '2026-01-01'),
                    (200, 2, 20, 'production', TRUE, '2026-01-01')`
        );
        const report100 = await seedWeeklyReport(executor, { ownerId: 1, deviceId: 10, contextId: 100 }, true, true);
        await seedWeeklyReport(executor, { ownerId: 1, deviceId: 10, contextId: 101 }, false, false);
        await seedWeeklyReport(executor, { ownerId: 1, deviceId: 11, contextId: 110 }, true, true);
        await seedWeeklyReport(executor, { ownerId: 2, deviceId: 20, contextId: 200 }, false, true);

        await ensureWeeklyPdfSchema({ executor });
        const constraints = await executor(
            `SELECT conname FROM pg_constraint WHERE conrelid = 'agro_weekly_report_files'::regclass`
        );
        const constraintNames = new Set(constraints.map((row) => row.conname));
        assert.ok(constraintNames.has('uniq_weekly_report_file'));
        assert.ok(constraintNames.has('uniq_weekly_report_file_report'));
        assert.ok(constraintNames.has('weekly_report_file_values_check'));
        const triggers = await executor(
            `SELECT tgname FROM pg_trigger
             WHERE tgrelid = 'agro_weekly_report_files'::regclass AND NOT tgisinternal`
        );
        assert.ok(triggers.some((row) => row.tgname === 'weekly_pdf_identity_guard'));

        const protectedBefore = await snapshot(executor, protectedTables);
        const sourcesBefore = await snapshot(executor, sourceTables);
        const dryRun = await runWeeklyPdfCycle({
            dryRun: true, weekStart: '2026-06-15', outputDir, executor
        });
        assert.equal(dryRun.reports, 4);
        assert.equal(dryRun.generated, 0);
        assert.equal((await fileRows(executor)).length, 0, 'dry-run must not write metadata');
        assert.equal((await fs.promises.readdir(outputDir)).length, 0, 'dry-run must not write files');

        const first = await runWeeklyPdfCycle({ weekStart: '2026-06-15', outputDir, executor });
        assert.equal(first.reports, 4);
        assert.equal(first.generated, 4);
        assert.equal(first.reused, 0);
        const metadata = await fileRows(executor);
        assert.equal(metadata.length, 4);
        assert.equal(metadata.filter((row) => Number(row.device_id) === 10).length, 2, 'contexts stay isolated');
        assert.equal(metadata.filter((row) => Number(row.owner_user_id) === 1).length, 3, 'owners stay isolated');
        const checksums = new Map();
        const mtimes = new Map();
        for (const row of metadata) {
            const bytes = await fs.promises.readFile(row.file_path);
            const stat = await fs.promises.stat(row.file_path);
            assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
            assert.equal(bytes.length, Number(row.file_size));
            assert.equal(sha256(bytes), row.checksum);
            checksums.set(Number(row.context_id), row.checksum);
            mtimes.set(Number(row.context_id), stat.mtimeMs);
        }
        assert.notEqual(checksums.get(100), checksums.get(101), 'different contexts must have different PDFs');

        const metadataBeforeRerun = JSON.stringify(metadata);
        const second = await runWeeklyPdfCycle({ weekStart: '2026-06-15', outputDir, executor });
        assert.equal(second.generated, 0);
        assert.equal(second.reused, 4);
        assert.equal(JSON.stringify(await fileRows(executor)), metadataBeforeRerun, 'idempotent rerun keeps metadata');
        for (const row of metadata) {
            assert.equal((await fs.promises.stat(row.file_path)).mtimeMs, mtimes.get(Number(row.context_id)));
        }

        const regenerated = await runWeeklyPdfCycle({
            weekStart: '2026-06-15', outputDir, executor, regenerate: true
        });
        assert.equal(regenerated.generated, 4);
        for (const row of await fileRows(executor)) {
            const bytes = await fs.promises.readFile(row.file_path);
            assert.equal(sha256(bytes), checksums.get(Number(row.context_id)), 'regeneration must be deterministic');
        }

        const ownerScope = await runWeeklyPdfCycle({
            dryRun: true, weekStart: '2026-06-15', scope: { ownerUserId: 2 }, outputDir, executor
        });
        assert.equal(ownerScope.reports, 1);
        assert.equal(Number(ownerScope.files[0].report_id) > 0, true);
        await assert.rejects(
            () => loadWeeklyPdfSource({ ownerUserId: 2, deviceId: 20, contextId: 100, weekStart: '2026-06-15' }, executor),
            /not found/
        );
        await assert.rejects(
            () => executor(
                `INSERT INTO agro_weekly_report_files
                  (owner_user_id, device_id, context_id, week_start, report_id,
                   file_name, file_path, file_size, checksum)
                 VALUES (2, 20, 200, '2026-06-22', ?, 'bad.pdf', '/tmp/bad.pdf', 1, ?)` ,
                [report100, 'a'.repeat(64)]
            ),
            /report identity mismatch/
        );
        assert.deepEqual(await snapshot(executor, protectedTables), protectedBefore, 'protected tables unchanged');
        assert.deepEqual(await snapshot(executor, sourceTables), sourcesBefore, 'weekly sources unchanged');

        const visualFile = (await fileRows(executor)).find((row) => Number(row.context_id) === 100).file_path;
        console.log('PASS embedded PostgreSQL weekly PDF export validation');
        console.log(JSON.stringify({
            pdf_files: 4,
            owners: 2,
            devices: 3,
            contexts: 4,
            tenant_context_isolation: true,
            deterministic_regeneration: true,
            idempotent_reuse: true,
            dry_run_no_writes: true,
            protected_tables_unchanged: true,
            visual_fixture: visualFile
        }));
    } finally {
        await db.close();
        if (!requestedOutput) { await fs.promises.rm(outputDir, { recursive: true, force: true }); }
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
