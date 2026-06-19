// Rayat Intelligence - Sprint 3.2 Stress Memory Job (additive, node-cron, default OFF).
'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureStressMemorySchema, runStressMemoryCycle } = require('../../utils/stress-memory');

const CRON_EXPRESSION = process.env.AGRO_STRESS_MEMORY_CRON || '30 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_STRESS_MEMORY_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_stress_memory_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) {
        return false;
    }
}

function includeNonProduction() {
    return String(process.env.AGRO_STRESS_MEMORY_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function executeStressMemoryCycle({ dryRun = false } = {}) {
    if (cycleRunning) {
        return { skipped_concurrent: true, groups: 0, stored: 0, dry_run: dryRun };
    }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureStressMemorySchema();
            schemaReady = true;
        }
        const summary = await runStressMemoryCycle({
            dryRun,
            includeNonProduction: includeNonProduction()
        });
        console.log(
            `[stress-memory] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            JSON.stringify(summary.by_maturity || {}),
            `stored=${summary.stored}`,
            `skipped_context=${summary.skipped_missing_context || 0}`
        );
        return summary;
    } finally {
        cycleRunning = false;
    }
}

function startStressMemoryJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log(
                    '[stress-memory] disabled - not scheduled. Enable with AGRO_STRESS_MEMORY_ENABLED=true '
                    + 'or runtime_config agro_stress_memory_enabled=true.'
                );
                return;
            }
            if (scheduledTask) { return; }
            ensureStressMemorySchema()
                .then(() => { schemaReady = true; })
                .catch((error) => console.error('[stress-memory] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                executeStressMemoryCycle({ dryRun: false })
                    .catch((error) => console.error('[stress-memory] cycle error:', error.message));
            });
            console.log(`[stress-memory] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[stress-memory] start failed:', error.message));
}

function stopStressMemoryJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = {
    startStressMemoryJob,
    stopStressMemoryJob,
    runStressMemoryCycle: executeStressMemoryCycle,
    isEnabled
};
