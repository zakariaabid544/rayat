// Rayat Intelligence - Sprint 3.6 Greenhouse Health Profile Job (node-cron, default OFF).
'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const {
    ensureHealthProfileSchema,
    runHealthProfileCycle
} = require('../../utils/greenhouse-health-profile');

const CRON_EXPRESSION = process.env.AGRO_HEALTH_PROFILE_CRON || '35 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_HEALTH_PROFILE_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_health_profile_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) {
        return false;
    }
}

function includeNonProduction() {
    return String(process.env.AGRO_HEALTH_PROFILE_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function executeHealthProfileCycle({ dryRun = false } = {}) {
    if (cycleRunning) {
        return { skipped_concurrent: true, contexts: 0, stored: 0, dry_run: dryRun };
    }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureHealthProfileSchema();
            schemaReady = true;
        }
        const summary = await runHealthProfileCycle({
            dryRun,
            includeNonProduction: includeNonProduction()
        });
        console.log(
            `[health-profile] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            JSON.stringify(summary.by_band || {}),
            `stored=${summary.stored}`
        );
        return summary;
    } finally {
        cycleRunning = false;
    }
}

function startHealthProfileJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log(
                    '[health-profile] disabled - not scheduled. Enable with AGRO_HEALTH_PROFILE_ENABLED=true '
                    + 'or runtime_config agro_health_profile_enabled=true.'
                );
                return;
            }
            if (scheduledTask) { return; }
            ensureHealthProfileSchema()
                .then(() => { schemaReady = true; })
                .catch((error) => console.error('[health-profile] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                executeHealthProfileCycle({ dryRun: false })
                    .catch((error) => console.error('[health-profile] cycle error:', error.message));
            });
            console.log(`[health-profile] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[health-profile] start failed:', error.message));
}

function stopHealthProfileJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = {
    startHealthProfileJob,
    stopHealthProfileJob,
    runHealthProfileCycle: executeHealthProfileCycle,
    isEnabled
};
