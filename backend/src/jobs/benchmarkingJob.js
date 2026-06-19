// Rayat Intelligence — Sprint 4.4 · Benchmarking Job (additivo, node-cron, local subject / anonymous cohort)
// Calcola il posizionamento di ogni greenhouse nella propria coorte anonima. DEFAULT OFF.
// Idempotente (upsert su chiave unica). Fail-closed sotto soglia anonimato. NON tocca tabelle sorgente/protette.
'use strict';
const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureBenchmarkSchema, runBenchmarking } = require('../../utils/benchmarking-engine');

const CRON_EXPRESSION = process.env.AGRO_BENCHMARK_CRON || '55 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_BENCHMARK_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query("SELECT config_value FROM runtime_config WHERE config_key = 'agro_benchmark_enabled' LIMIT 1");
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

async function runBenchmarkingCycle({ dryRun = false } = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, cohorts: 0, benchmarked: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) { await ensureBenchmarkSchema(); schemaReady = true; }
        const summary = await runBenchmarking({ dryRun });
        console.log(`[benchmarking] cycle done${dryRun ? ' (dry-run)' : ''}:`, JSON.stringify(summary.by_status || {}), 'benchmarked=' + summary.benchmarked);
        return summary;
    } finally { cycleRunning = false; }
}

function startBenchmarkingJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log('[benchmarking] disabled - not scheduled. Enable with AGRO_BENCHMARK_ENABLED=true or runtime_config agro_benchmark_enabled=true.');
                return;
            }
            if (scheduledTask) { return; }
            ensureBenchmarkSchema().then(() => { schemaReady = true; }).catch((error) => console.error('[benchmarking] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runBenchmarkingCycle({ dryRun: false }).catch((error) => console.error('[benchmarking] cycle error:', error.message));
            });
            console.log(`[benchmarking] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[benchmarking] start failed:', error.message));
}

function stopBenchmarkingJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startBenchmarkingJob, stopBenchmarkingJob, runBenchmarkingCycle, isEnabled };
