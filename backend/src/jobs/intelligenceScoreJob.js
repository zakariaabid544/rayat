// Rayat Intelligence — Sprint 4.1/4.2 · Intelligence Score Job (additivo, node-cron, local-only)
// Calcola sub-score (4.1) + intelligence_score aggregato (4.2) per (owner,device,context). DEFAULT OFF.
// Idempotente (upsert su chiave unica). Fail-closed. NON tocca tabelle sorgente/protette.
'use strict';
const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensureScoreSchema, runIntelligenceScore } = require('../../utils/intelligence-score');

const CRON_EXPRESSION = process.env.AGRO_INTELLIGENCE_SCORE_CRON || '45 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_INTELLIGENCE_SCORE_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query("SELECT config_value FROM runtime_config WHERE config_key = 'agro_intelligence_score_enabled' LIMIT 1");
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

function includeNonProductionEnv() {
    return String(process.env.AGRO_INTELLIGENCE_SCORE_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function runIntelligenceScoreCycle({ dryRun = false, includeNonProduction = null } = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, contexts: 0, scores_stored: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) { await ensureScoreSchema(); schemaReady = true; }
        const includeNP = includeNonProduction === null ? includeNonProductionEnv() : Boolean(includeNonProduction);
        const summary = await runIntelligenceScore({ dryRun, includeNonProduction: includeNP });
        console.log(`[intelligence-score] cycle done${dryRun ? ' (dry-run)' : ''}:`, JSON.stringify(summary.by_band || {}), 'scores=' + summary.scores_stored);
        return summary;
    } finally { cycleRunning = false; }
}

function startIntelligenceScoreJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log('[intelligence-score] disabled - not scheduled. Enable with AGRO_INTELLIGENCE_SCORE_ENABLED=true or runtime_config agro_intelligence_score_enabled=true.');
                return;
            }
            if (scheduledTask) { return; }
            ensureScoreSchema().then(() => { schemaReady = true; }).catch((error) => console.error('[intelligence-score] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runIntelligenceScoreCycle({ dryRun: false }).catch((error) => console.error('[intelligence-score] cycle error:', error.message));
            });
            console.log(`[intelligence-score] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[intelligence-score] start failed:', error.message));
}

function stopIntelligenceScoreJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startIntelligenceScoreJob, stopIntelligenceScoreJob, runIntelligenceScoreCycle, isEnabled };
