// Rayat Intelligence — Sprint 4.3 · Trend Intelligence Job (additivo, node-cron, local-only)
// Snapshot giornaliero dei punteggi + calcolo trend per (owner,device,context,metric). DEFAULT OFF.
// Idempotente (upsert su chiave unica). Fail-closed. NON tocca tabelle sorgente/protette.
'use strict';
const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureTrendSchema, runTrendIntelligence } = require('../../utils/trend-intelligence');

const CRON_EXPRESSION = process.env.AGRO_TREND_CRON || '50 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_TREND_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query("SELECT config_value FROM runtime_config WHERE config_key = 'agro_trend_enabled' LIMIT 1");
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

async function runTrendIntelligenceCycle({ dryRun = false } = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, contexts: 0, trends_stored: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) { await ensureTrendSchema(); schemaReady = true; }
        const summary = await runTrendIntelligence({ dryRun });
        console.log(`[trend-intelligence] cycle done${dryRun ? ' (dry-run)' : ''}:`, JSON.stringify(summary.by_direction || {}), 'trends=' + summary.trends_stored);
        return summary;
    } finally { cycleRunning = false; }
}

function startTrendIntelligenceJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log('[trend-intelligence] disabled - not scheduled. Enable with AGRO_TREND_ENABLED=true or runtime_config agro_trend_enabled=true.');
                return;
            }
            if (scheduledTask) { return; }
            ensureTrendSchema().then(() => { schemaReady = true; }).catch((error) => console.error('[trend-intelligence] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runTrendIntelligenceCycle({ dryRun: false }).catch((error) => console.error('[trend-intelligence] cycle error:', error.message));
            });
            console.log(`[trend-intelligence] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[trend-intelligence] start failed:', error.message));
}

function stopTrendIntelligenceJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startTrendIntelligenceJob, stopTrendIntelligenceJob, runTrendIntelligenceCycle, isEnabled };
