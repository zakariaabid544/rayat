'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const {
    ensureWeeklyNotificationSchema,
    runWeeklyNotificationCycle
} = require('../../utils/weekly-report-notifications');

const CRON_EXPRESSION = process.env.AGRO_WEEKLY_NOTIFICATION_CRON || '0 7 * * 1';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_WEEKLY_NOTIFICATION_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_weekly_notification_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) {
        return false;
    }
}

function emailPendingEnabled() {
    return String(process.env.AGRO_WEEKLY_NOTIFICATION_EMAIL_PENDING || '').trim().toLowerCase() === 'true';
}

async function runWeeklyReportNotificationCycle({
    dryRun = false,
    includeEmailPending = emailPendingEnabled(),
    scope = null,
    executor = query
} = {}) {
    if (cycleRunning) {
        return { skipped_concurrent: true, created: 0, existing: 0, dry_run: dryRun };
    }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureWeeklyNotificationSchema({ executor });
            schemaReady = true;
        }
        const summary = await runWeeklyNotificationCycle({
            dryRun, includeEmailPending, scope, executor
        });
        console.log(
            `[weekly-notification] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            `created=${summary.created}`,
            `existing=${summary.existing}`,
            `would_create=${summary.would_create}`
        );
        return summary;
    } finally {
        cycleRunning = false;
    }
}

function startWeeklyReportNotificationJob() {
    ensureWeeklyNotificationSchema()
        .then(() => {
            schemaReady = true;
            return isEnabled();
        })
        .then((enabled) => {
            if (!enabled) {
                console.log(
                    '[weekly-notification] disabled - not scheduled. Enable with '
                    + 'AGRO_WEEKLY_NOTIFICATION_ENABLED=true or runtime_config '
                    + 'agro_weekly_notification_enabled=true.'
                );
                return;
            }
            if (scheduledTask) { return; }
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runWeeklyReportNotificationCycle({ dryRun: false })
                    .catch((error) => console.error('[weekly-notification] cycle error:', error.message));
            });
            console.log(`[weekly-notification] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[weekly-notification] schema/start failed:', error.message));
}

function stopWeeklyReportNotificationJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = {
    startWeeklyReportNotificationJob,
    stopWeeklyReportNotificationJob,
    runWeeklyReportNotificationCycle,
    isEnabled,
    emailPendingEnabled
};
