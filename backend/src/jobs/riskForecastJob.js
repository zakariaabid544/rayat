'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureRiskForecastSchema, runRiskForecastCycle: runEngine } = require('../../utils/risk-forecast');

const CRON_EXPRESSION = process.env.AGRO_RISK_FORECAST_CRON || '40 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_RISK_FORECAST_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_risk_forecast_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

function includeNonProduction() {
    return String(process.env.AGRO_RISK_FORECAST_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function runRiskForecastCycle({
    dryRun = false, generatedAt = new Date(), scope = null,
    includeNonProduction: includeOverride = null, executor = query, ensureContext = null
} = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, risk_rows: 0, stored: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureRiskForecastSchema({ executor, ...(ensureContext ? { ensureContext } : {}) });
            schemaReady = true;
        }
        const summary = await runEngine({ dryRun, generatedAt, scope, executor,
            includeNonProduction: includeOverride === null ? includeNonProduction() : Boolean(includeOverride) });
        console.log(`[risk-forecast] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            `contexts=${summary.contexts}`, JSON.stringify(summary.by_band));
        return summary;
    } finally { cycleRunning = false; }
}

function startRiskForecastJob() {
    ensureRiskForecastSchema()
        .then(() => { schemaReady = true; return isEnabled(); })
        .then((enabled) => {
            if (!enabled) {
                console.log('[risk-forecast] disabled - not scheduled. Enable with AGRO_RISK_FORECAST_ENABLED=true.');
                return;
            }
            if (scheduledTask) { return; }
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runRiskForecastCycle().catch((error) => console.error('[risk-forecast] cycle error:', error.message));
            });
            console.log(`[risk-forecast] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[risk-forecast] schema/start failed:', error.message));
}

function stopRiskForecastJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startRiskForecastJob, stopRiskForecastJob, runRiskForecastCycle, isEnabled };
