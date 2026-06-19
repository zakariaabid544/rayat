// Rayat Intelligence — Sprint 3.1 · Baseline Evolution Job (additivo, node-cron, LIVE ONLY)
// Aggiorna i baseline evolutivi per (owner, device, context, metric) dai dati live. DEFAULT OFF.
// Idempotente: upsert sulla chiave unica. NON tocca le tabelle sorgente.
'use strict';
const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureBaselineSchema, runBaselineEvolution } = require('../../utils/baseline-evolution');

const CRON_EXPRESSION = process.env.AGRO_BASELINE_CRON || '15 * * * *'; // ogni ora al minuto 15
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_BASELINE_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query("SELECT config_value FROM runtime_config WHERE config_key = 'agro_baseline_enabled' LIMIT 1");
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

async function runBaselineEvolutionCycle({ dryRun = false } = {}) {
    if (cycleRunning) {
        return { skipped_concurrent: true, groups: 0, stored: 0, dry_run: dryRun };
    }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) { await ensureBaselineSchema(); schemaReady = true; }
        const summary = await runBaselineEvolution({ dryRun });
        console.log(`[baseline-evolution] cycle done${dryRun ? ' (dry-run)' : ''}:`, JSON.stringify(summary.by_maturity || {}), 'stored=' + summary.stored);
        return summary;
    } finally {
        cycleRunning = false;
    }
}

function startBaselineEvolutionJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log('[baseline-evolution] disabled - not scheduled. Enable with AGRO_BASELINE_ENABLED=true or runtime_config agro_baseline_enabled=true.');
                return;
            }
            if (scheduledTask) { return; }
            ensureBaselineSchema().then(() => { schemaReady = true; }).catch((error) => console.error('[baseline-evolution] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runBaselineEvolutionCycle({ dryRun: false }).catch((error) => console.error('[baseline-evolution] cycle error:', error.message));
            });
            console.log(`[baseline-evolution] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[baseline-evolution] start failed:', error.message));
}

function stopBaselineEvolutionJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startBaselineEvolutionJob, stopBaselineEvolutionJob, runBaselineEvolutionCycle };
