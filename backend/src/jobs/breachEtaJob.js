'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const {
    ensureBreachEtaSchema,
    runBreachEtaCycle: runBreachEngine
} = require('../../utils/breach-eta');

const CRON_EXPRESSION = process.env.AGRO_BREACH_ETA_CRON || '20 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_BREACH_ETA_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_breach_eta_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

async function runBreachEtaCycle({
    dryRun = false, scope = null, executor = query, rangeResolver, ensureContext = null
} = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, breach_rows: 0, stored: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureBreachEtaSchema({ executor, ...(ensureContext ? { ensureContext } : {}) });
            schemaReady = true;
        }
        const summary = await runBreachEngine({
            dryRun, scope, executor, ...(rangeResolver ? { rangeResolver } : {})
        });
        console.log(
            `[breach-eta] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            `forecasts=${summary.forecast_rows}`, JSON.stringify(summary.by_status)
        );
        return summary;
    } finally { cycleRunning = false; }
}

function startBreachEtaJob() {
    ensureBreachEtaSchema()
        .then(() => { schemaReady = true; return isEnabled(); })
        .then((enabled) => {
            if (!enabled) {
                console.log('[breach-eta] disabled - not scheduled. Enable with AGRO_BREACH_ETA_ENABLED=true.');
                return;
            }
            if (scheduledTask) { return; }
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runBreachEtaCycle({ dryRun: false })
                    .catch((error) => console.error('[breach-eta] cycle error:', error.message));
            });
            console.log(`[breach-eta] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[breach-eta] schema/start failed:', error.message));
}

function stopBreachEtaJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startBreachEtaJob, stopBreachEtaJob, runBreachEtaCycle, isEnabled };
