// Rayat Intelligence — Sprint 4.5 · Explainability Job (additivo, node-cron, local-only)
// Genera/persiste le spiegazioni deterministiche dell'Intelligence Score per (owner,device,context). DEFAULT OFF.
// Idempotente (upsert su chiave unica). Fail-closed. NON tocca tabelle sorgente/protette.
'use strict';
const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureExplanationSchema, runExplainability } = require('../../utils/explainability-engine');

const CRON_EXPRESSION = process.env.AGRO_EXPLAIN_CRON || '5 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_EXPLAIN_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query("SELECT config_value FROM runtime_config WHERE config_key = 'agro_explain_enabled' LIMIT 1");
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

function includeNonProductionEnv() {
    return String(process.env.AGRO_EXPLAIN_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function runExplainabilityCycle({ dryRun = false, includeNonProduction = null } = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, contexts: 0, stored: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) { await ensureExplanationSchema(); schemaReady = true; }
        const includeNP = includeNonProduction === null ? includeNonProductionEnv() : Boolean(includeNonProduction);
        const summary = await runExplainability({ dryRun, includeNonProduction: includeNP });
        console.log(`[explainability] cycle done${dryRun ? ' (dry-run)' : ''}:`, 'stored=' + summary.stored, 'contexts=' + summary.contexts);
        return summary;
    } finally { cycleRunning = false; }
}

function startExplainabilityJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log('[explainability] disabled - not scheduled. Enable with AGRO_EXPLAIN_ENABLED=true or runtime_config agro_explain_enabled=true.');
                return;
            }
            if (scheduledTask) { return; }
            ensureExplanationSchema().then(() => { schemaReady = true; }).catch((error) => console.error('[explainability] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runExplainabilityCycle({ dryRun: false }).catch((error) => console.error('[explainability] cycle error:', error.message));
            });
            console.log(`[explainability] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[explainability] start failed:', error.message));
}

function stopExplainabilityJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startExplainabilityJob, stopExplainabilityJob, runExplainabilityCycle, isEnabled };
