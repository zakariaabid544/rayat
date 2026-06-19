'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const { resolveWeekWindow } = require('../../utils/weekly-fact-assembler');
const {
    ensureWeeklyPdfSchema,
    exportWeeklyPdf,
    DEFAULT_OUTPUT_DIR
} = require('../../utils/weekly-pdf-export');

const CRON_EXPRESSION = process.env.AGRO_WEEKLY_PDF_CRON || '30 6 * * 1';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_WEEKLY_PDF_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_weekly_pdf_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) {
        return false;
    }
}

function previousWeekReference(referenceDate) {
    const date = referenceDate instanceof Date ? new Date(referenceDate.getTime()) : new Date(referenceDate);
    if (Number.isNaN(date.getTime())) { throw new Error('[weekly-pdf-job] invalid referenceDate'); }
    date.setUTCDate(date.getUTCDate() - 7);
    return date;
}

function normalizeScope(scope) {
    if (!scope) { return null; }
    const ownerUserId = scope.ownerUserId == null ? null : Number(scope.ownerUserId);
    const deviceId = scope.deviceId == null ? null : Number(scope.deviceId);
    const contextId = scope.contextId == null ? null : Number(scope.contextId);
    for (const [label, value] of Object.entries({ ownerUserId, deviceId, contextId })) {
        if (value !== null && (!Number.isInteger(value) || value < 1)) {
            throw new Error(`[weekly-pdf-job] invalid ${label} scope`);
        }
    }
    return { ownerUserId, deviceId, contextId };
}

async function listWeeklyReports({ weekStart, scope = null, executor = query }) {
    const normalized = normalizeScope(scope);
    const clauses = ['week_start = ?'];
    const params = [weekStart];
    if (normalized && normalized.ownerUserId) { clauses.push('owner_user_id = ?'); params.push(normalized.ownerUserId); }
    if (normalized && normalized.deviceId) { clauses.push('device_id = ?'); params.push(normalized.deviceId); }
    if (normalized && normalized.contextId) { clauses.push('context_id = ?'); params.push(normalized.contextId); }
    return executor(
        `SELECT owner_user_id, device_id, context_id, week_start
         FROM agro_weekly_reports WHERE ${clauses.join(' AND ')}
         ORDER BY owner_user_id, device_id, context_id`,
        params
    );
}

async function runWeeklyPdfCycle({
    dryRun = false,
    regenerate = false,
    weekStart = null,
    referenceDate = new Date(),
    scope = null,
    outputDir = process.env.AGRO_WEEKLY_PDF_DIR || DEFAULT_OUTPUT_DIR,
    executor = query
} = {}) {
    if (cycleRunning) {
        return { skipped_concurrent: true, reports: 0, generated: 0, reused: 0, dry_run: dryRun };
    }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureWeeklyPdfSchema({ executor });
            schemaReady = true;
        }
        const window = resolveWeekWindow({
            weekStart,
            referenceDate: weekStart ? referenceDate : previousWeekReference(referenceDate)
        });
        const identities = await listWeeklyReports({ weekStart: window.week_start, scope, executor });
        const files = [];
        for (const identity of identities) {
            files.push(await exportWeeklyPdf({
                ownerUserId: identity.owner_user_id,
                deviceId: identity.device_id,
                contextId: identity.context_id,
                weekStart: window.week_start,
                dryRun,
                regenerate,
                outputDir,
                executor
            }));
        }
        const summary = {
            reports: identities.length,
            generated: dryRun ? 0 : files.filter((file) => !file.reused).length,
            reused: files.filter((file) => file.reused).length,
            dry_run: dryRun,
            regenerate: Boolean(regenerate),
            week_start: window.week_start,
            week_end: window.week_end,
            files
        };
        console.log(
            `[weekly-pdf] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            `reports=${summary.reports}`,
            `generated=${summary.generated}`,
            `reused=${summary.reused}`,
            `week=${summary.week_start}`
        );
        return summary;
    } finally {
        cycleRunning = false;
    }
}

function startWeeklyPdfJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log(
                    '[weekly-pdf] disabled - not scheduled. Enable with AGRO_WEEKLY_PDF_ENABLED=true '
                    + 'or runtime_config agro_weekly_pdf_enabled=true.'
                );
                return;
            }
            if (scheduledTask) { return; }
            ensureWeeklyPdfSchema()
                .then(() => { schemaReady = true; })
                .catch((error) => console.error('[weekly-pdf] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runWeeklyPdfCycle({ dryRun: false, regenerate: false })
                    .catch((error) => console.error('[weekly-pdf] cycle error:', error.message));
            });
            console.log(`[weekly-pdf] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[weekly-pdf] start failed:', error.message));
}

function stopWeeklyPdfJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = {
    startWeeklyPdfJob,
    stopWeeklyPdfJob,
    runWeeklyPdfCycle,
    listWeeklyReports,
    isEnabled,
    previousWeekReference
};
