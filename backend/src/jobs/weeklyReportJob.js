'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const {
    ensureWeeklyFactSchema,
    runWeeklyFactAssembler
} = require('../../utils/weekly-fact-assembler');
const {
    ensureWeeklyReportSchema,
    renderWeeklyReport,
    upsertWeeklyReport
} = require('../../utils/weekly-template-renderer');

const CRON_EXPRESSION = process.env.AGRO_WEEKLY_REPORT_CRON || '0 6 * * 1';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_WEEKLY_REPORT_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_weekly_report_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) {
        return false;
    }
}

function includeNonProduction() {
    return String(process.env.AGRO_WEEKLY_REPORT_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

function previousWeekReference(referenceDate) {
    const date = referenceDate instanceof Date ? new Date(referenceDate.getTime()) : new Date(referenceDate);
    if (Number.isNaN(date.getTime())) { throw new Error('[weekly-report] invalid referenceDate'); }
    date.setUTCDate(date.getUTCDate() - 7);
    return date;
}

async function ensureWeeklyReportingSchema({ executor = query, ensureContext } = {}) {
    await ensureWeeklyFactSchema({ executor, ...(ensureContext ? { ensureContext } : {}) });
    await ensureWeeklyReportSchema({ executor });
}

async function factPackageId(fact, executor) {
    const rows = await executor(
        `SELECT id FROM agro_weekly_fact_packages
         WHERE owner_user_id = ? AND device_id = ? AND context_id = ? AND week_start = ?`,
        [fact.owner_user_id, fact.device_id, fact.context_id, fact.week_start]
    );
    if (!rows.length) { throw new Error('[weekly-report] persisted fact package not found'); }
    return Number(rows[0].id);
}

async function runWeeklyReportCycle({
    dryRun = false,
    weekStart = null,
    referenceDate = new Date(),
    scope = null,
    includeNonProduction: includeNonProductionOverride = null,
    executor = query,
    ensureContext = null
} = {}) {
    if (cycleRunning) {
        return { skipped_concurrent: true, contexts: 0, fact_packages: 0, reports: 0, dry_run: dryRun };
    }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureWeeklyReportingSchema({ executor, ...(ensureContext ? { ensureContext } : {}) });
            schemaReady = true;
        }
        const include = includeNonProductionOverride === null
            ? includeNonProduction()
            : Boolean(includeNonProductionOverride);
        const facts = await runWeeklyFactAssembler({
            dryRun,
            weekStart,
            referenceDate: weekStart ? referenceDate : previousWeekReference(referenceDate),
            scope,
            includeNonProduction: include,
            executor
        });
        const rows = [];
        for (const fact of facts.rows) {
            const report = renderWeeklyReport(fact);
            if (!dryRun) {
                const id = await factPackageId(fact, executor);
                await upsertWeeklyReport(fact, report, id, executor);
            }
            rows.push({ fact, report });
        }
        const summary = {
            contexts: rows.length,
            fact_packages: dryRun ? 0 : rows.length,
            reports: dryRun ? 0 : rows.length,
            dry_run: dryRun,
            week_start: facts.week_start,
            week_end: facts.week_end,
            rows
        };
        console.log(
            `[weekly-report] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            `contexts=${summary.contexts}`,
            `week=${summary.week_start}`
        );
        return summary;
    } finally {
        cycleRunning = false;
    }
}

function startWeeklyReportJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log(
                    '[weekly-report] disabled - not scheduled. Enable with AGRO_WEEKLY_REPORT_ENABLED=true '
                    + 'or runtime_config agro_weekly_report_enabled=true.'
                );
                return;
            }
            if (scheduledTask) { return; }
            ensureWeeklyReportingSchema()
                .then(() => { schemaReady = true; })
                .catch((error) => console.error('[weekly-report] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runWeeklyReportCycle({ dryRun: false })
                    .catch((error) => console.error('[weekly-report] cycle error:', error.message));
            });
            console.log(`[weekly-report] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[weekly-report] start failed:', error.message));
}

function stopWeeklyReportJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = {
    startWeeklyReportJob,
    stopWeeklyReportJob,
    runWeeklyReportCycle,
    ensureWeeklyReportingSchema,
    isEnabled,
    previousWeekReference
};
