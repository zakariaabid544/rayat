// Rayat Intelligence - Sprint 3.5 Knowledge Consolidation Job (node-cron, default OFF).
'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const {
    ensureKnowledgeSchema,
    runKnowledgeConsolidationCycle
} = require('../../utils/knowledge-consolidation');

const CRON_EXPRESSION = process.env.AGRO_KNOWLEDGE_CONSOLIDATION_CRON || '20 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_KNOWLEDGE_CONSOLIDATION_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_knowledge_consolidation_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) {
        return false;
    }
}

function includeNonProduction() {
    return String(process.env.AGRO_KNOWLEDGE_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function executeKnowledgeConsolidationCycle({ dryRun = false } = {}) {
    if (cycleRunning) {
        return { skipped_concurrent: true, contexts: 0, stored: 0, dry_run: dryRun };
    }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureKnowledgeSchema();
            schemaReady = true;
        }
        const summary = await runKnowledgeConsolidationCycle({
            dryRun,
            includeNonProduction: includeNonProduction()
        });
        console.log(
            `[knowledge-consolidation] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            JSON.stringify(summary.by_maturity || {}),
            `stored=${summary.stored}`
        );
        return summary;
    } finally {
        cycleRunning = false;
    }
}

function startKnowledgeConsolidationJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log(
                    '[knowledge-consolidation] disabled - not scheduled. '
                    + 'Enable with AGRO_KNOWLEDGE_CONSOLIDATION_ENABLED=true '
                    + 'or runtime_config agro_knowledge_consolidation_enabled=true.'
                );
                return;
            }
            if (scheduledTask) { return; }
            ensureKnowledgeSchema()
                .then(() => { schemaReady = true; })
                .catch((error) => console.error('[knowledge-consolidation] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                executeKnowledgeConsolidationCycle({ dryRun: false })
                    .catch((error) => console.error('[knowledge-consolidation] cycle error:', error.message));
            });
            console.log(`[knowledge-consolidation] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[knowledge-consolidation] start failed:', error.message));
}

function stopKnowledgeConsolidationJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = {
    startKnowledgeConsolidationJob,
    stopKnowledgeConsolidationJob,
    runKnowledgeConsolidationCycle: executeKnowledgeConsolidationCycle,
    isEnabled
};
