// Rayat Intelligence - Sprint 3.4 Behavioral Signature Job (node-cron, default OFF).
'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const {
    ensureBehavioralSignatureSchema,
    runBehavioralSignatureCycle
} = require('../../utils/behavioral-signature');

const CRON_EXPRESSION = process.env.AGRO_BEHAVIORAL_SIGNATURE_CRON || '5 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.AGRO_BEHAVIORAL_SIGNATURE_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_behavioral_signature_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) {
        return false;
    }
}

function includeNonProduction() {
    return String(process.env.AGRO_BEHAVIORAL_SIGNATURE_INCLUDE_NON_PRODUCTION || '').trim().toLowerCase() === 'true';
}

async function executeBehavioralSignatureCycle({ dryRun = false } = {}) {
    if (cycleRunning) {
        return { skipped_concurrent: true, contexts: 0, stored: 0, dry_run: dryRun };
    }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) {
            await ensureBehavioralSignatureSchema();
            schemaReady = true;
        }
        const summary = await runBehavioralSignatureCycle({
            dryRun,
            includeNonProduction: includeNonProduction()
        });
        console.log(
            `[behavioral-signature] cycle done${dryRun ? ' (dry-run)' : ''}:`,
            JSON.stringify(summary.by_risk || {}),
            `stored=${summary.stored}`
        );
        return summary;
    } finally {
        cycleRunning = false;
    }
}

function startBehavioralSignatureJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log(
                    '[behavioral-signature] disabled - not scheduled. Enable with AGRO_BEHAVIORAL_SIGNATURE_ENABLED=true '
                    + 'or runtime_config agro_behavioral_signature_enabled=true.'
                );
                return;
            }
            if (scheduledTask) { return; }
            ensureBehavioralSignatureSchema()
                .then(() => { schemaReady = true; })
                .catch((error) => console.error('[behavioral-signature] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                executeBehavioralSignatureCycle({ dryRun: false })
                    .catch((error) => console.error('[behavioral-signature] cycle error:', error.message));
            });
            console.log(`[behavioral-signature] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[behavioral-signature] start failed:', error.message));
}

function stopBehavioralSignatureJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = {
    startBehavioralSignatureJob,
    stopBehavioralSignatureJob,
    runBehavioralSignatureCycle: executeBehavioralSignatureCycle,
    isEnabled
};
