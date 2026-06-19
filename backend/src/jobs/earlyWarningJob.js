'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureEarlyWarningSchema, runEarlyWarningCycle: runEngine } = require('../../utils/early-warning');

const CRON_EXPRESSION = process.env.AGRO_EARLY_WARNING_CRON || '55 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_EARLY_WARNING_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_early_warning_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

async function runEarlyWarningCycle({
    dryRun = false, generatedAt = new Date(), scope = null, executor = query, ensureContext = null
} = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, warning_rows: 0, stored: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureEarlyWarningSchema({ executor, ...(ensureContext ? { ensureContext } : {}) });
            schemaReady = true;
        }
        const summary = await runEngine({ dryRun, generatedAt, scope, executor });
        console.log(`[early-warning] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            `contexts=${summary.contexts}`, JSON.stringify(summary.by_type));
        return summary;
    } finally { cycleRunning = false; }
}

function startEarlyWarningJob() {
    ensureEarlyWarningSchema()
        .then(() => { schemaReady = true; return isEnabled(); })
        .then((enabled) => {
            if (!enabled) {
                console.log('[early-warning] disabled - not scheduled. Enable with AGRO_EARLY_WARNING_ENABLED=true.');
                return;
            }
            if (scheduledTask) { return; }
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runEarlyWarningCycle().catch((error) => console.error('[early-warning] cycle error:', error.message));
            });
            console.log(`[early-warning] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[early-warning] schema/start failed:', error.message));
}

function stopEarlyWarningJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startEarlyWarningJob, stopEarlyWarningJob, runEarlyWarningCycle, isEnabled };
