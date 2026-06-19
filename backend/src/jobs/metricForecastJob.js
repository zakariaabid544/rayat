'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const {
    ensureMetricForecastSchema,
    runMetricForecastCycle: runForecastEngine
} = require('../../utils/metric-forecast');

const CRON_EXPRESSION = process.env.AGRO_METRIC_FORECAST_CRON || '10 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_METRIC_FORECAST_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_metric_forecast_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

function includeNonProduction() {
    return String(process.env.AGRO_METRIC_FORECAST_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function runMetricForecastCycle({
    dryRun = false, generatedAt = new Date(), scope = null,
    includeNonProduction: includeOverride = null, executor = query, ensureContext = null
} = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, forecast_rows: 0, stored: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureMetricForecastSchema({ executor, ...(ensureContext ? { ensureContext } : {}) });
            schemaReady = true;
        }
        const summary = await runForecastEngine({
            dryRun, generatedAt, scope, executor,
            includeNonProduction: includeOverride === null ? includeNonProduction() : Boolean(includeOverride)
        });
        console.log(
            `[metric-forecast] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            `sensors=${summary.sensors}`, `forecasts=${summary.forecast_rows}`
        );
        return summary;
    } finally { cycleRunning = false; }
}

function startMetricForecastJob() {
    ensureMetricForecastSchema()
        .then(() => { schemaReady = true; return isEnabled(); })
        .then((enabled) => {
            if (!enabled) {
                console.log('[metric-forecast] disabled - not scheduled. Enable with AGRO_METRIC_FORECAST_ENABLED=true.');
                return;
            }
            if (scheduledTask) { return; }
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runMetricForecastCycle({ dryRun: false })
                    .catch((error) => console.error('[metric-forecast] cycle error:', error.message));
            });
            console.log(`[metric-forecast] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[metric-forecast] schema/start failed:', error.message));
}

function stopMetricForecastJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startMetricForecastJob, stopMetricForecastJob, runMetricForecastCycle, isEnabled };
