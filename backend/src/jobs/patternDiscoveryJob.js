// Rayat Intelligence — Sprint 2.1 · Pattern Discovery Job (additivo, node-cron)
// Esegue periodicamente la scoperta di pattern da agro_actions_detected -> agro_success_patterns.
// DEFAULT OFF: si attiva solo con AGRO_INTELLIGENCE_ENABLED=true o runtime_config.agro_intelligence_enabled='true'
// (stessa feature-flag dello Sprint 1). NON tocca ingestion / alarm_events / moduli Sprint 1.
const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensurePatternSchema, discoverPatterns } = require('../../utils/pattern-discovery');

// Default: ogni ora (al minuto 0). Configurabile.
const CRON_EXPRESSION = process.env.AGRO_PATTERNS_CRON || '0 * * * *';

let scheduledTask = null;
let schemaReady = false;

async function isEnabled() {
    if (String(process.env.AGRO_INTELLIGENCE_ENABLED || '').toLowerCase() === 'true') {
        return true;
    }
    try {
        const rows = await query(
            "SELECT config_value FROM runtime_config WHERE config_key = 'agro_intelligence_enabled' LIMIT 1"
        );
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) {
        return false;
    }
}

async function runPatternDiscoveryCycle({ dryRun = false } = {}) {
    if (!schemaReady && !dryRun) {
        await ensurePatternSchema();
        schemaReady = true;
    }
    const summary = await discoverPatterns({ dryRun });
    console.log(`[pattern-discovery] cycle done${dryRun ? ' (dry-run)' : ''}:`, summary);
    return summary;
}

function startPatternDiscoveryJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log('[pattern-discovery] disabled — not scheduled. Enable with AGRO_INTELLIGENCE_ENABLED=true or runtime_config agro_intelligence_enabled=true.');
                return;
            }
            if (scheduledTask) {
                return;
            }
            // prepara lo schema (additivo, IF NOT EXISTS) all'avvio
            ensurePatternSchema()
                .then(() => { schemaReady = true; })
                .catch((error) => console.error('[pattern-discovery] schema ensure failed:', error.message));

            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runPatternDiscoveryCycle({ dryRun: false }).catch((error) => {
                    console.error('[pattern-discovery] cycle error:', error.message);
                });
            });
            console.log(`[pattern-discovery] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => {
            console.error('[pattern-discovery] start failed:', error.message);
        });
}

function stopPatternDiscoveryJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = { startPatternDiscoveryJob, stopPatternDiscoveryJob, runPatternDiscoveryCycle };
