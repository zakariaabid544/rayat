// Rayat Intelligence — Sprint 2.2–2.5 · Intelligence Chain Job (additivo, node-cron)
// Orchestratore READ-ONLY della catena di conoscenza, eseguito dopo l'event engine:
//   Pattern Discovery (2.1) -> Pattern Intelligence (2.2) -> Trigger Discovery (2.3)
//   -> Trigger Intelligence (2.4) -> Recovery Intelligence (2.4) -> Local/Global/Delta Learning (2.5)
// DEFAULT OFF: stessa feature-flag dello Sprint 1 (AGRO_INTELLIGENCE_ENABLED / runtime_config).
// NON tocca ingestion / alarm_events / moduli Sprint 1 / Sprint 2.1-2.3 (li riusa in sola lettura).
'use strict';
const cron = require('node-cron');
const { query } = require('../../config/database');
const PDisc = require('../../utils/pattern-discovery');          // 2.1 (riuso read-only)
const PInt = require('../../utils/pattern-intelligence');         // 2.2
const TDisc = require('../../utils/trigger-discovery');           // 2.3
const TInt = require('../../utils/trigger-intelligence');         // 2.4 trigger
const RInt = require('../../utils/recovery-intelligence');        // 2.4 recovery
const Learn = require('../../utils/learning-engine');             // 2.5

const CRON_EXPRESSION = process.env.AGRO_INTELLIGENCE_CHAIN_CRON || '30 2 * * *'; // default: ogni notte 02:30
let scheduledTask = null;
let schemaReady = false;

async function isEnabled() {
    if (String(process.env.AGRO_INTELLIGENCE_ENABLED || '').toLowerCase() === 'true') { return true; }
    try {
        const rows = await query("SELECT config_value FROM runtime_config WHERE config_key = 'agro_intelligence_enabled' LIMIT 1");
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

async function ensureAllSchemas() {
    await PDisc.ensurePatternSchema();
    await PInt.ensurePatternIntelligenceSchema();
    await TDisc.ensureTriggerSchema();
    await TInt.ensureTriggerIntelligenceSchema();
    await RInt.ensureRecoveryIntelligenceSchema();
    await Learn.ensureLearningSchema();
    schemaReady = true;
}

async function runIntelligenceChain({ dryRun = false } = {}) {
    if (!schemaReady && !dryRun) { await ensureAllSchemas(); }
    const summary = {};
    summary.discovery = await PDisc.discoverPatterns({ dryRun });          // 2.1
    summary.pattern_intelligence = await PInt.runPatternIntelligence({ dryRun }); // 2.2
    summary.trigger_discovery = await TDisc.runTriggerDiscovery({ dryRun }); // 2.3
    summary.trigger_intelligence = await TInt.runTriggerIntelligence({ dryRun }); // 2.4a
    summary.recovery_intelligence = await RInt.runRecoveryIntelligence({ dryRun }); // 2.4b
    summary.learning = await Learn.runLearning({ dryRun });                 // 2.5
    console.log(`[intelligence-chain] cycle done${dryRun ? ' (dry-run)' : ''}:`, JSON.stringify(summary));
    return summary;
}

function startIntelligenceChainJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log('[intelligence-chain] disabled — not scheduled. Enable with AGRO_INTELLIGENCE_ENABLED=true or runtime_config agro_intelligence_enabled=true.');
                return;
            }
            if (scheduledTask) { return; }
            ensureAllSchemas().catch((error) => console.error('[intelligence-chain] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runIntelligenceChain({ dryRun: false }).catch((error) => console.error('[intelligence-chain] cycle error:', error.message));
            });
            console.log(`[intelligence-chain] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[intelligence-chain] start failed:', error.message));
}

function stopIntelligenceChainJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startIntelligenceChainJob, stopIntelligenceChainJob, runIntelligenceChain, ensureAllSchemas };
