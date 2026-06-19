'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
    ensureWeeklyReportingSchema,
    runWeeklyReportCycle,
    isEnabled
} = require('../src/jobs/weeklyReportJob');

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

async function factSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, week_start, week_end,
                health_summary, intelligence_score_summary, subscore_summary, trend_summary,
                benchmark_summary, positive_factors, negative_factors, recommended_focus,
                data_quality_notes, limitations, confidence, evidence_json, rule_version
         FROM agro_weekly_fact_packages
         ORDER BY owner_user_id, device_id, context_id, week_start`
    );
}

async function reportSnapshot(executor) {
    return executor(
        `SELECT owner_user_id, device_id, context_id, week_start, week_end, language,
                executive_summary, greenhouse_status, improvements, deteriorations,
                stress_recovery, benchmark, recommended_focus, data_quality_notes,
                report_text, evidence_json, rule_version
         FROM agro_weekly_reports
         ORDER BY owner_user_id, device_id, context_id, week_start`
    );
}

async function seedIntelligence(executor, identity, strong, benchmarkAvailable = true) {
    const ids = [identity.ownerId, identity.deviceId, identity.contextId];
    await executor(
        `INSERT INTO agro_greenhouse_health_profile
          (owner_user_id, device_id, context_id, health_score, resilience_score, stress_load_score,
           recovery_score, stability_score, data_confidence_score, health_band,
           top_positive_factors, top_negative_factors, recommended_focus, confidence, maturity_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?, ?)`,
        [...ids, strong ? 86 : 34, strong ? 88 : 35, strong ? 18 : 82,
            strong ? 84 : 32, strong ? 90 : 38, strong ? 91 : 56,
            strong ? 'excellent' : 'risk',
            JSON.stringify(strong ? [{ factor: 'environmental_stability', score: 90 }] : []),
            JSON.stringify(strong ? [] : [{ factor: 'stress_pressure', score: 82 }]),
            JSON.stringify(strong ? ['maintain_current_practices'] : ['reduce_ec_stress']),
            strong ? 0.91 : 0.56, strong ? 'mature' : 'learning']
    );
    await executor(
        `INSERT INTO agro_greenhouse_knowledge
          (owner_user_id, device_id, context_id, top_strengths, top_weaknesses,
           recurring_risks, recurring_recoveries, knowledge_maturity, confidence)
         VALUES (?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?, ?)`,
        [...ids, JSON.stringify(strong ? ['fast_recovery'] : []),
            JSON.stringify(strong ? [] : ['high_stress_load']),
            JSON.stringify(strong ? [] : ['ec_stress']),
            JSON.stringify(strong ? ['temperature_recovery'] : []),
            strong ? 'mature' : 'learning', strong ? 0.9 : 0.55]
    );
    await executor(
        `INSERT INTO agro_behavioral_signature
          (owner_user_id, device_id, context_id, signature_label, recovery_behavior, stress_behavior,
           stability_behavior, volatility_behavior, sensor_behavior, resilience_level, risk_tendency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...ids, strong ? 'strong_fast_recovery' : 'high_risk_tendency',
            strong ? 'fast_recovery' : 'fragile_recovery', strong ? 'low_stress' : 'recurring_stress',
            strong ? 'stable' : 'unstable', strong ? 'low_volatility' : 'high_volatility',
            strong ? 'reliable' : 'attention_needed', strong ? 'strong' : 'weak', strong ? 'low' : 'high']
    );
    await executor(
        `INSERT INTO agro_intelligence_score
          (owner_user_id, device_id, context_id, intelligence_score, intelligence_band, confidence, maturity_level)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [...ids, strong ? 88 : 36, strong ? 'excellent' : 'risk',
            strong ? 0.9 : 0.55, strong ? 'mature' : 'learning']
    );
    await executor(
        `INSERT INTO agro_intelligence_subscores
          (owner_user_id, device_id, context_id, stability_score, stress_score, recovery_score,
           resilience_score, data_quality_score, maturity_score, confidence, maturity_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...ids, strong ? 90 : 38, strong ? 86 : 22, strong ? 84 : 32,
            strong ? 88 : 35, strong ? 91 : 56, strong ? 95 : 50,
            strong ? 0.9 : 0.55, strong ? 'mature' : 'learning']
    );
    await executor(
        `INSERT INTO agro_intelligence_trends
          (owner_user_id, device_id, context_id, metric, trend_direction, trend_strength,
           trend_confidence, sample_count, slope_per_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, 6, ?)`,
        [...ids, strong ? 'intelligence_score' : 'stress', strong ? 'improving' : 'degrading',
            strong ? 0.7 : 0.8, strong ? 0.8 : 0.75, strong ? 0.3 : -0.4]
    );
    if (benchmarkAvailable) {
        await executor(
            `INSERT INTO agro_intelligence_benchmark
              (owner_user_id, device_id, context_id, benchmark_status, percentile_rank,
               relative_position, cohort_average, cohort_median, cohort_top_quartile,
               cohort_bottom_quartile, benchmark_confidence, cohort_size, distinct_owner_count,
               crop_key, medium, cultivation_type)
             VALUES (?, ?, ?, 'ok', ?, ?, 64, 65, 78, 48, 0.8, 12, 6, 'tomato', 'perlite', 'greenhouse')`,
            [...ids, strong ? 88 : 22, strong ? 'top_quartile' : 'bottom_quartile']
        );
    }
    await executor(
        `INSERT INTO agro_intelligence_explanations
          (owner_user_id, device_id, context_id, recommended_focus, top_positive_factors,
           top_negative_factors, data_limitations, confidence_explanation)
         VALUES (?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?)`,
        [...ids, JSON.stringify(strong ? ['maintain_current_practices'] : ['reduce_ec_stress']),
            JSON.stringify(strong ? [{ key: 'stability', label: 'stabilità ambientale', score: 90 }] : []),
            JSON.stringify(strong ? [] : [{ key: 'stress', label: 'gestione dello stress', score: 22 }]),
            JSON.stringify(strong ? [] : ['Apprendimento ancora in corso.']),
            strong ? 'Affidabilità alta.' : 'Affidabilità media.']
    );
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const protectedTables = ['sensor_readings', 'alarm_events', 'active_alerts', 'users', 'devices', 'sensors'];
    const sourceTables = [
        'agro_greenhouse_health_profile', 'agro_greenhouse_knowledge', 'agro_behavioral_signature',
        'agro_intelligence_score', 'agro_intelligence_subscores', 'agro_intelligence_trends',
        'agro_intelligence_benchmark', 'agro_intelligence_explanations'
    ];
    try {
        const configuredFlag = process.env.AGRO_WEEKLY_REPORT_ENABLED;
        delete process.env.AGRO_WEEKLY_REPORT_ENABLED;
        assert.equal(await isEnabled({ executor }), false, 'weekly job must be disabled by default');
        if (configuredFlag === undefined) { delete process.env.AGRO_WEEKLY_REPORT_ENABLED; }
        else { process.env.AGRO_WEEKLY_REPORT_ENABLED = configuredFlag; }

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
          CREATE TABLE agro_greenhouse_health_profile (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT,
            health_score NUMERIC, resilience_score NUMERIC, stress_load_score NUMERIC,
            recovery_score NUMERIC, stability_score NUMERIC, data_confidence_score NUMERIC,
            health_band VARCHAR(12), top_positive_factors JSONB, top_negative_factors JSONB,
            recommended_focus JSONB, confidence NUMERIC, maturity_level VARCHAR(12));
          CREATE TABLE agro_greenhouse_knowledge (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT,
            top_strengths JSONB, top_weaknesses JSONB, recurring_risks JSONB,
            recurring_recoveries JSONB, knowledge_maturity VARCHAR(12), confidence NUMERIC);
          CREATE TABLE agro_behavioral_signature (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT,
            signature_label VARCHAR(120), recovery_behavior VARCHAR(24), stress_behavior VARCHAR(24),
            stability_behavior VARCHAR(24), volatility_behavior VARCHAR(24), sensor_behavior VARCHAR(24),
            resilience_level VARCHAR(12), risk_tendency VARCHAR(12));
          CREATE TABLE agro_intelligence_score (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT,
            intelligence_score NUMERIC, intelligence_band VARCHAR(12), confidence NUMERIC, maturity_level VARCHAR(12));
          CREATE TABLE agro_intelligence_subscores (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT,
            stability_score NUMERIC, stress_score NUMERIC, recovery_score NUMERIC,
            resilience_score NUMERIC, data_quality_score NUMERIC, maturity_score NUMERIC,
            confidence NUMERIC, maturity_level VARCHAR(12));
          CREATE TABLE agro_intelligence_trends (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT,
            metric VARCHAR(40), trend_direction VARCHAR(24), trend_strength NUMERIC,
            trend_confidence NUMERIC, sample_count INTEGER, slope_per_day NUMERIC);
          CREATE TABLE agro_intelligence_benchmark (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT,
            benchmark_status VARCHAR(30), percentile_rank NUMERIC, relative_position VARCHAR(24),
            cohort_average NUMERIC, cohort_median NUMERIC, cohort_top_quartile NUMERIC,
            cohort_bottom_quartile NUMERIC, benchmark_confidence NUMERIC, cohort_size INTEGER,
            distinct_owner_count INTEGER, crop_key VARCHAR(80), medium VARCHAR(80), cultivation_type VARCHAR(80));
          CREATE TABLE agro_intelligence_explanations (
            id BIGSERIAL PRIMARY KEY, owner_user_id INTEGER, device_id INTEGER, context_id BIGINT,
            recommended_focus JSONB, top_positive_factors JSONB, top_negative_factors JSONB,
            data_limitations JSONB, confidence_explanation TEXT);
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
                    (102, 1, 10, 'demo', FALSE, '2026-01-01'),
                    (103, 2, 10, 'production', TRUE, '2026-01-01'),
                    (110, 1, 11, 'production', TRUE, '2026-01-01'),
                    (200, 2, 20, 'production', TRUE, '2026-01-01')`
        );
        await seedIntelligence(executor, { ownerId: 1, deviceId: 10, contextId: 100 }, true, true);
        await seedIntelligence(executor, { ownerId: 1, deviceId: 10, contextId: 101 }, false, false);
        await seedIntelligence(executor, { ownerId: 1, deviceId: 11, contextId: 110 }, true, true);
        await seedIntelligence(executor, { ownerId: 2, deviceId: 20, contextId: 200 }, false, true);
        await seedIntelligence(executor, { ownerId: 1, deviceId: 10, contextId: 102 }, true, true);

        await ensureWeeklyReportingSchema({ executor, ensureContext: async () => {} });
        const constraints = await executor(
            `SELECT conname FROM pg_constraint
             WHERE conrelid IN ('agro_weekly_fact_packages'::regclass, 'agro_weekly_reports'::regclass)`
        );
        const constraintNames = new Set(constraints.map((row) => row.conname));
        assert.ok(constraintNames.has('uniq_weekly_fact_package'));
        assert.ok(constraintNames.has('uniq_weekly_report'));
        assert.ok(constraintNames.has('weekly_fact_window_check'));
        assert.ok(constraintNames.has('weekly_report_language_check'));
        const triggers = await executor(
            `SELECT tgname FROM pg_trigger
             WHERE tgrelid IN ('agro_weekly_fact_packages'::regclass, 'agro_weekly_reports'::regclass)
               AND NOT tgisinternal`
        );
        const triggerNames = new Set(triggers.map((row) => row.tgname));
        assert.ok(triggerNames.has('weekly_fact_identity_guard'));
        assert.ok(triggerNames.has('weekly_report_identity_guard'));

        const protectedBefore = await snapshot(executor, protectedTables);
        const sourcesBefore = await snapshot(executor, sourceTables);
        const dry = await runWeeklyReportCycle({
            dryRun: true, weekStart: '2026-06-15', executor, ensureContext: async () => {}
        });
        assert.equal(dry.contexts, 4);
        assert.equal(dry.fact_packages, 0);
        assert.equal(dry.reports, 0);
        assert.equal((await factSnapshot(executor)).length, 0, 'dry-run must not write facts');
        assert.equal((await reportSnapshot(executor)).length, 0, 'dry-run must not write reports');

        const first = await runWeeklyReportCycle({
            weekStart: '2026-06-15', executor, ensureContext: async () => {}
        });
        assert.equal(first.fact_packages, 4);
        assert.equal(first.reports, 4);
        let facts = await factSnapshot(executor);
        let reports = await reportSnapshot(executor);
        assert.equal(facts.length, 4);
        assert.equal(reports.length, 4);
        assert.equal(facts.filter((row) => Number(row.device_id) === 10).length, 2, 'contexts stay isolated');
        assert.equal(facts.filter((row) => Number(row.owner_user_id) === 1).length, 3, 'owners stay isolated');
        assert.equal(facts.some((row) => Number(row.context_id) === 102), false, 'demo context excluded by default');
        assert.equal(facts.some((row) => Number(row.context_id) === 200), true, 'second tenant retained independently');

        const strongFact = facts.find((row) => Number(row.context_id) === 100);
        const weakFact = facts.find((row) => Number(row.context_id) === 101);
        const strongReport = reports.find((row) => Number(row.context_id) === 100);
        const weakReport = reports.find((row) => Number(row.context_id) === 101);
        assert.equal(Number(strongFact.intelligence_score_summary.intelligence_score), 88);
        assert.ok(strongReport.report_text.includes('88/100'), 'report must reflect fact score');
        assert.ok(strongReport.improvements.includes('punteggio complessivo'));
        assert.ok(weakReport.benchmark.toLowerCase().includes('benchmark non disponibile'));
        assert.notEqual(strongReport.report_text, weakReport.report_text, 'strong and weak reports differ');
        assert.equal(weakFact.benchmark_summary.available, false);

        const factOne = JSON.stringify(facts);
        const reportOne = JSON.stringify(reports);
        await runWeeklyReportCycle({ weekStart: '2026-06-15', executor, ensureContext: async () => {} });
        facts = await factSnapshot(executor);
        reports = await reportSnapshot(executor);
        assert.equal(JSON.stringify(facts), factOne, 'fact rerun must be deterministic');
        assert.equal(JSON.stringify(reports), reportOne, 'report rerun must be deterministic');
        assert.equal(facts.length, 4, 'idempotent rerun creates no duplicate facts');
        assert.equal(reports.length, 4, 'idempotent rerun creates no duplicate reports');
        assert.deepEqual(await snapshot(executor, protectedTables), protectedBefore, 'protected tables unchanged');
        assert.deepEqual(await snapshot(executor, sourceTables), sourcesBefore, 'intelligence sources unchanged');
        assert.equal(JSON.stringify(strongFact.evidence_json).includes('owner_user_id'), false);
        assert.equal(JSON.stringify(strongReport.evidence_json).includes('device_id'), false);

        await assert.rejects(
            () => executor(
                `INSERT INTO agro_weekly_fact_packages
                  (owner_user_id, device_id, context_id, week_start, week_end)
                 VALUES (2, 20, 100, '2026-06-22', '2026-06-28')`
            ),
            /context_id does not belong/
        );
        await executor(
            `INSERT INTO agro_intelligence_score
              (owner_user_id, device_id, context_id, intelligence_score, intelligence_band, confidence, maturity_level)
             VALUES (2, 10, 103, 50, 'attention', 0.5, 'learning')`
        );
        await assert.rejects(
            () => runWeeklyReportCycle({ dryRun: true, weekStart: '2026-06-15', executor }),
            /fail-closed: 1 source rows have invalid tenant\/context identity/
        );

        console.log('PASS embedded PostgreSQL weekly reporting validation');
        console.log(JSON.stringify({
            weekly_fact_packages: 4,
            weekly_reports: 4,
            owners: 2,
            devices: 3,
            contexts: 4,
            tenant_context_isolation: true,
            deterministic_idempotency: true,
            dry_run_no_writes: true,
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
