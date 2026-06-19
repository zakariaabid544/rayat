// Rayat Intelligence — Sprint 1 · Orchestratore eventi (additivo, disaccoppiato dall'ingestion)
// Esegue in batch (node-cron) Quality Gate -> Range Resolver -> Range State Machine per ogni sensore.
// DEFAULT OFF: si attiva solo con AGRO_INTELLIGENCE_ENABLED=true o runtime_config.agro_intelligence_enabled='true'.
// Espone runAgroEventsCycle({ dryRun }) per esecuzione manuale / verifica senza scrivere.
const cron = require('node-cron');
const { query } = require('../../config/database');
const { resolveEffectiveRange } = require('../../utils/range-resolver');
const { assessDataQuality } = require('../../utils/data-quality');
const { evaluateSensor } = require('../../utils/range-state-machine');
const { evaluateTrend } = require('../../utils/trend-analyzer'); // Sprint 1.4 (additivo)
const { evaluateRecovery } = require('../../utils/recovery-analyzer'); // Sprint 1.5 (additivo)
const { evaluateAnomaly } = require('../../utils/anomaly-analyzer'); // Sprint 1.6 (additivo)
const { evaluateRegimeShift } = require('../../utils/regime-shift-analyzer'); // Sprint 1.7 (additivo)
const { evaluateSensorDrift } = require('../../utils/sensor-drift-analyzer'); // Sprint 1.8 (additivo)
const { assertLocalIdentity } = require('../../utils/intelligence-tenancy');
const { tagEventsContextWindow } = require('../../utils/agronomic-context'); // Sprint 2.7C (live context tagging)

const CRON_EXPRESSION = process.env.AGRO_EVENTS_CRON || '*/15 * * * *';
const WINDOW_MINUTES = Number(process.env.AGRO_EVENTS_WINDOW_MIN || 60);

let scheduledTask = null;

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

async function loadActiveSensors() {
    return query(
        `SELECT s.id, s.device_id, s.type, s.subtype,
                d.user_id AS assigned_user_id,
                COALESCE(du.owner_user_id, du.id) AS owner_user_id,
                d.status AS device_status, d.last_seen
         FROM sensors s
         INNER JOIN devices d ON d.id = s.device_id
         LEFT JOIN users du ON du.id = d.user_id
         WHERE s.enabled = TRUE`
    );
}

async function loadRecentReadings(sensorId) {
    return query(
        `SELECT value, timestamp FROM sensor_readings
         WHERE sensor_id = ? AND timestamp >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
         ORDER BY timestamp DESC LIMIT 500`,
        [sensorId]
    );
}

async function runAgroEventsCycle({ dryRun = false } = {}) {
    const summary = { processed: 0, suppressed: 0, opened: 0, closed: 0, improvement: 0, worsening: 0, stabilization: 0, recovery: 0, anomaly: 0, regime_shift: 0, sensor_drift: 0, errors: 0 };
    let sensors = [];
    try {
        sensors = await loadActiveSensors();
    } catch (error) {
        console.error('[agro-events] load sensors failed:', error.message);
        return summary;
    }

    for (const s of sensors) {
        try {
            const identity = assertLocalIdentity({
                ownerUserId: s.owner_user_id,
                deviceId: s.device_id,
                context: `agro-events sensor ${s.id}`
            });
            const sensor = {
                id: s.id,
                device_id: identity.device_id,
                owner_user_id: identity.owner_user_id,
                type: s.type,
                subtype: s.subtype
            };
            const device = { status: s.device_status, last_seen: s.last_seen };
            const readings = await loadRecentReadings(s.id);
            const latestReadingAt = readings[0] ? readings[0].timestamp : null;
            const quality = assessDataQuality({ device, latestReadingAt, readingsInWindow: readings.length });
            const range = quality.ok ? await resolveEffectiveRange({ userId: identity.owner_user_id, sensor }) : null;
            const result = await evaluateSensor({ userId: identity.owner_user_id, sensor, recentReadings: readings, range, quality, dryRun });

            summary.processed += 1;
            if (result.suppressed) {
                summary.suppressed += 1;
            }
            for (const action of (result.actions || [])) {
                if (action.type === 'open_out_of_range') { summary.opened += 1; }
                if (action.type === 'close_out_of_range') { summary.closed += 1; }
            }

            // Sprint 1.4 (additivo): trend improvement / worsening / stabilization, stessi input
            const trend = await evaluateTrend({ userId: identity.owner_user_id, sensor, recentReadings: readings, range, quality, dryRun });
            for (const action of (trend.actions || [])) {
                if (action.type === 'open_improvement') { summary.improvement += 1; }
                if (action.type === 'open_worsening') { summary.worsening += 1; }
                if (action.type === 'open_stabilization') { summary.stabilization += 1; }
            }

            // Sprint 1.5 (additivo): recovery (episodio chiuso) dagli out_of_range conclusi e rientrati stabili
            const recovery = await evaluateRecovery({ userId: identity.owner_user_id, sensor, range, dryRun });
            for (const action of (recovery.actions || [])) {
                if (action.type === 'emit_recovery') { summary.recovery += 1; }
            }

            // Sprint 1.6 (additivo): anomaly statistica (z robusto vs storia recente), stessi input gia caricati
            const anomaly = await evaluateAnomaly({ userId: identity.owner_user_id, sensor, recentReadings: readings, range, quality, dryRun });
            for (const action of (anomaly.actions || [])) {
                if (action.type === 'open_anomaly' || action.type === 'close_anomaly') { summary.anomaly += 1; }
            }

            // Sprint 1.7 (additivo): regime_shift (spostamento persistente del baseline, finestra corta vs lunga)
            const regime = await evaluateRegimeShift({ userId: identity.owner_user_id, sensor, range, quality, dryRun });
            for (const action of (regime.actions || [])) {
                if (action.type === 'open_regime_shift' || action.type === 'close_regime_shift') { summary.regime_shift += 1; }
            }

            // Sprint 1.8 (additivo): sensor_drift (deriva lenta / sensore piantato) - comportamento sospetto del sensore
            const drift = await evaluateSensorDrift({ userId: identity.owner_user_id, sensor, range, quality, dryRun });
            for (const action of (drift.actions || [])) {
                if (action.type === 'open_sensor_drift' || action.type === 'close_sensor_drift') { summary.sensor_drift += 1; }
            }
        } catch (error) {
            summary.errors += 1;
            console.error(`[agro-events] sensor ${s.id} failed:`, error.message);
        }
    }

    // Sprint 2.7C (additivo): tagga gli eventi live appena prodotti col contesto agronomico attivo (se configurato).
    if (!dryRun) {
        try {
            const fromTs = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
            summary.context_tagged = await tagEventsContextWindow({ fromTs, toTs: new Date().toISOString() });
        } catch (error) {
            console.error('[agro-events] context tag failed:', error.message);
        }
    }

    console.log(`[agro-events] cycle done${dryRun ? ' (dry-run)' : ''}:`, summary);
    return summary;
}

function startAgroEventsJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log('[agro-events] disabled — not scheduled. Enable with AGRO_INTELLIGENCE_ENABLED=true or runtime_config agro_intelligence_enabled=true.');
                return;
            }
            if (scheduledTask) {
                return;
            }
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runAgroEventsCycle({ dryRun: false }).catch((error) => {
                    console.error('[agro-events] cycle error:', error.message);
                });
            });
            console.log(`[agro-events] scheduled: ${CRON_EXPRESSION} (window ${WINDOW_MINUTES}m)`);
        })
        .catch((error) => {
            console.error('[agro-events] start failed:', error.message);
        });
}

function stopAgroEventsJob() {
    if (scheduledTask) {
        try { scheduledTask.stop(); } catch (error) { /* noop */ }
        scheduledTask = null;
    }
}

module.exports = { startAgroEventsJob, stopAgroEventsJob, runAgroEventsCycle };
