'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureStressEtaSchema, runStressEtaCycle: runEngine } = require('../../utils/stress-eta');

const CRON_EXPRESSION = process.env.AGRO_STRESS_ETA_CRON || '30 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_STRESS_ETA_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_stress_eta_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

function includeNonProduction() {
    return String(process.env.AGRO_STRESS_ETA_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function runStressEtaCycle({
    dryRun = false, generatedAt = new Date(), scope = null,
    includeNonProduction: includeOverride = null, executor = query, ensureContext = null
} = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, stress_rows: 0, stored: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureStressEtaSchema({ executor, ...(ensureContext ? { ensureContext } : {}) });
            schemaReady = true;
        }
        const summary = await runEngine({ dryRun, generatedAt, scope, executor,
            includeNonProduction: includeOverride === null ? includeNonProduction() : Boolean(includeOverride) });
        console.log(`[stress-eta] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            `contexts=${summary.contexts}`, JSON.stringify(summary.by_status));
        return summary;
    } finally { cycleRunning = false; }
}

function startStressEtaJob() {
    ensureStressEtaSchema()
        .then(() => { schemaReady = true; return isEnabled(); })
        .then((enabled) => {
            if (!enabled) {
                console.log('[stress-eta] disabled - not scheduled. Enable with AGRO_STRESS_ETA_ENABLED=true.');
                return;
            }
            if (scheduledTask) { return; }
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runStressEtaCycle().catch((error) => console.error('[stress-eta] cycle error:', error.message));
            });
            console.log(`[stress-eta] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[stress-eta] schema/start failed:', error.message));
}

function stopStressEtaJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startStressEtaJob, stopStressEtaJob, runStressEtaCycle, isEnabled };
