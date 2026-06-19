// Rayat Intelligence - Sprint 3.3 Recovery Memory Job (additive, node-cron, default OFF).
'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureRecoveryMemorySchema, runRecoveryMemoryCycle } = require('../../utils/recovery-memory');

const CRON_EXPRESSION = process.env.AGRO_RECOVERY_MEMORY_CRON || '45 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_RECOVERY_MEMORY_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_recovery_memory_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) {
        return false;
    }
}

function includeNonProduction() {
    return String(process.env.AGRO_RECOVERY_MEMORY_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function executeRecoveryMemoryCycle({ dryRun = false } = {}) {
    if (cycleRunning) {
        return { skipped_concurrent: true, groups: 0, stored: 0, dry_run: dryRun };
    }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureRecoveryMemorySchema();
            schemaReady = true;
        }
        const summary = await runRecoveryMemoryCycle({
            dryRun,
            includeNonProduction: includeNonProduction()
        });
        console.log(
            `[recovery-memory] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            JSON.stringify(summary.by_maturity || {}),
            `stored=${summary.stored}`,
            `skipped_context=${summary.skipped_missing_context || 0}`
        );
        return summary;
    } finally {
        cycleRunning = false;
    }
}

function startRecoveryMemoryJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log(
                    '[recovery-memory] disabled - not scheduled. Enable with AGRO_RECOVERY_MEMORY_ENABLED=true '
                    + 'or runtime_config agro_recovery_memory_enabled=true.'
                );
                return;
            }
            if (scheduledTask) { return; }
            ensureRecoveryMemorySchema()
                .then(() => { schemaReady = true; })
                .catch((error) => console.error('[recovery-memory] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                executeRecoveryMemoryCycle({ dryRun: false })
                    .catch((error) => console.error('[recovery-memory] cycle error:', error.message));
            });
            console.log(`[recovery-memory] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[recovery-memory] start failed:', error.message));
}

function stopRecoveryMemoryJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = {
    startRecoveryMemoryJob,
    stopRecoveryMemoryJob,
    runRecoveryMemoryCycle: executeRecoveryMemoryCycle,
    isEnabled
};
