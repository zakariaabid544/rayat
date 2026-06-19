'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureRecoveryForecastSchema, runRecoveryForecastCycle: runEngine } = require('../../utils/recovery-forecast');

const CRON_EXPRESSION = process.env.AGRO_RECOVERY_FORECAST_CRON || '50 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_RECOVERY_FORECAST_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_recovery_forecast_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

async function runRecoveryForecastCycle({
    dryRun = false, generatedAt = new Date(), scope = null, executor = query, ensureContext = null
} = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, recovery_rows: 0, stored: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureRecoveryForecastSchema({ executor, ...(ensureContext ? { ensureContext } : {}) });
            schemaReady = true;
        }
        const summary = await runEngine({ dryRun, generatedAt, scope, executor });
        console.log(`[recovery-forecast] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            `contexts=${summary.contexts}`, JSON.stringify(summary.by_band));
        return summary;
    } finally { cycleRunning = false; }
}

function startRecoveryForecastJob() {
    ensureRecoveryForecastSchema()
        .then(() => { schemaReady = true; return isEnabled(); })
        .then((enabled) => {
            if (!enabled) {
                console.log('[recovery-forecast] disabled - not scheduled. Enable with AGRO_RECOVERY_FORECAST_ENABLED=true.');
                return;
            }
            if (scheduledTask) { return; }
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runRecoveryForecastCycle().catch((error) => console.error('[recovery-forecast] cycle error:', error.message));
            });
            console.log(`[recovery-forecast] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[recovery-forecast] schema/start failed:', error.message));
}

function stopRecoveryForecastJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startRecoveryForecastJob, stopRecoveryForecastJob, runRecoveryForecastCycle, isEnabled };
