// Rayat Intelligence — Sprint 2.7B · Historical Replay Engine (additivo)
// Riproduce cronologicamente sensor_readings storiche e RICOSTRUISCE solo agro_actions_detected,
// guidando i detector Sprint 1 con un clock storico iniettato (timestamp delle letture, mai NOW()).
// Identita tenant risolta FAIL-CLOSED (owner_user_id/device_id/sensor_id); nessun raggruppamento sotto NULL.
// Resumable (checkpoint), idempotente (resume + indici unique), batched, cancellabile, dry-run, deterministico.
// NON scrive su sensor_readings / alarm_events / active_alerts. La catena Sprint 2 rigenera le tabelle derivate.
'use strict';
const { query } = require('../config/database');
const { resolveEffectiveRange } = require('./range-resolver');
const { assessDataQuality } = require('./data-quality');
const { evaluateSensor } = require('./range-state-machine');
const { evaluateTrend } = require('./trend-analyzer');
const { evaluateRecovery } = require('./recovery-analyzer');
const { evaluateAnomaly } = require('./anomaly-analyzer');
const { evaluateRegimeShift } = require('./regime-shift-analyzer');
const { evaluateSensorDrift } = require('./sensor-drift-analyzer');
const { assertLocalIdentity } = require('./intelligence-tenancy');
const { ensureContextSchema } = require('./agronomic-context'); // Sprint 2.7C (context-aware replay)

const RULE_VERSION = 's2.7b';
const WINDOW_MINUTES = Number(process.env.AGRO_EVENTS_WINDOW_MIN || 180);
const DEFAULT_BATCH = Number(process.env.AGRO_REPLAY_BATCH || 500);
const SPRINT1_RULE_VERSIONS = ['s1.3', 's1.4', 's1.5', 's1.6', 's1.7', 's1.8'];

function toIso(v) { return (v instanceof Date ? v : new Date(v)).toISOString(); }

// Deterministic replay_id (tenant-namespaced friendly): non deriva da label nullable.
function replayKey({ fromTs, toTs, scope }) {
    const sc = scope && scope.deviceId != null ? `dev${scope.deviceId}` : (scope && scope.ownerUserId != null ? `own${scope.ownerUserId}` : 'ALL');
    return `replay|${sc}|${toIso(fromTs)}|${toIso(toTs)}`;
}

async function ensureReplaySchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_replay_runs (
           id BIGSERIAL PRIMARY KEY,
           replay_id TEXT NOT NULL UNIQUE,
           from_ts TIMESTAMPTZ NOT NULL,
           to_ts TIMESTAMPTZ NOT NULL,
           batch_size INTEGER NOT NULL DEFAULT 500,
           status VARCHAR(16) NOT NULL DEFAULT 'pending',
           cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
           cursor_ts TIMESTAMPTZ NULL,
           cursor_id BIGINT NULL,
           target_sensors INTEGER NOT NULL DEFAULT 0,
           processed_readings BIGINT NOT NULL DEFAULT 0,
           reconstructed_events BIGINT NOT NULL DEFAULT 0,
           scope_owner_user_id INTEGER NULL,
           scope_device_id INTEGER NULL,
           params JSONB NULL,
           error TEXT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`
    );
    await query('CREATE INDEX IF NOT EXISTS idx_replay_status ON agro_replay_runs (status)');
}

// Risolve i sensori target con identita tenant. FAIL-CLOSED: se un sensore in range non risolve owner/device -> errore.
async function resolveTargets({ scope }) {
    const where = ['s.enabled = TRUE'];
    const params = [];
    if (scope && scope.deviceId != null) { where.push('s.device_id = ?'); params.push(scope.deviceId); }
    if (scope && scope.ownerUserId != null) { where.push('COALESCE(du.owner_user_id, du.id) = ?'); params.push(scope.ownerUserId); }
    const rows = await query(
        `SELECT s.id AS sensor_id, s.device_id, s.type, s.subtype,
                COALESCE(du.owner_user_id, du.id) AS owner_user_id
         FROM sensors s
         INNER JOIN devices d ON d.id = s.device_id
         LEFT JOIN users du ON du.id = d.user_id
         WHERE ${where.join(' AND ')}`,
        params
    );
    const map = new Map();
    for (const r of rows) {
        // fail-closed: identita deve risolvere, altrimenti throw (nessun NULL grouping)
        const identity = assertLocalIdentity({ ownerUserId: r.owner_user_id, deviceId: r.device_id, context: `replay sensor ${r.sensor_id}` });
        map.set(r.sensor_id, {
            sensorId: r.sensor_id,
            device_id: identity.device_id,
            owner_user_id: identity.owner_user_id,
            type: r.type,
            subtype: r.subtype
        });
    }
    return map;
}

async function loadWindow(sensorId, atIso) {
    return query(
        `SELECT value, timestamp FROM sensor_readings
         WHERE sensor_id = ? AND timestamp <= CAST(? AS TIMESTAMPTZ)
           AND timestamp >= CAST(? AS TIMESTAMPTZ) - INTERVAL '${WINDOW_MINUTES} minutes'
         ORDER BY timestamp DESC LIMIT 1000`,
        [sensorId, atIso, atIso]
    );
}

// Esegue i 6 detector per UNA lettura storica, con clock = timestamp della lettura. Ritorna #azioni (eventi ricostruiti).
async function processReading(target, atIso, dryRun) {
    const sensor = { id: target.sensorId, device_id: target.device_id, owner_user_id: target.owner_user_id, type: target.type, subtype: target.subtype };
    const now = new Date(atIso);
    const window = await loadWindow(target.sensorId, atIso);
    const quality = assessDataQuality({
        device: { status: 'active', last_seen: atIso },
        latestReadingAt: window[0] ? window[0].timestamp : atIso,
        readingsInWindow: window.length,
        now: now.getTime()
    });
    const range = quality.ok ? await resolveEffectiveRange({ userId: target.owner_user_id, sensor }) : null;
    let events = 0;
    const count = (res) => { for (const a of (res && res.actions) || []) { if (/^(open_|close_|emit_)/.test(a.type)) { events += 1; } } };
    count(await evaluateSensor({ userId: target.owner_user_id, sensor, recentReadings: window, range, quality, now, dryRun }));
    count(await evaluateTrend({ userId: target.owner_user_id, sensor, recentReadings: window, range, quality, now, dryRun }));
    count(await evaluateRecovery({ userId: target.owner_user_id, sensor, range, now, dryRun }));
    count(await evaluateAnomaly({ userId: target.owner_user_id, sensor, recentReadings: window, range, quality, now, dryRun }));
    count(await evaluateRegimeShift({ userId: target.owner_user_id, sensor, range, quality, now, dryRun }));
    count(await evaluateSensorDrift({ userId: target.owner_user_id, sensor, range, quality, now, dryRun }));
    return events;
}

async function getRun(replayId) {
    const rows = await query('SELECT * FROM agro_replay_runs WHERE replay_id = ? LIMIT 1', [replayId]);
    return rows[0] || null;
}

async function requestReplayCancel(replayId) {
    await query('UPDATE agro_replay_runs SET cancel_requested = TRUE, updated_at = NOW() WHERE replay_id = ?', [replayId]);
    return getRun(replayId);
}

// Replay storico. Opzioni: { from, to, batchSize, dryRun, rebuild, scope:{ownerUserId, deviceId} }
async function runHistoricalReplay({ from, to, batchSize = DEFAULT_BATCH, dryRun = false, rebuild = false, scope = null, requireContext = false, tagContext = false } = {}) {
    if (!from || !to) { throw new Error('[replay] from/to obbligatori'); }
    const fromTs = toIso(from);
    const toTs = toIso(to);
    if (new Date(fromTs).getTime() > new Date(toTs).getTime()) { throw new Error('[replay] from > to'); }
    await ensureReplaySchema();
    const replayId = replayKey({ fromTs, toTs, scope });
    const targets = await resolveTargets({ scope });
    const targetIds = [...targets.keys()];
    const summary = { replay_id: replayId, dry_run: dryRun, rebuild, target_sensors: targets.size, processed_readings: 0, reconstructed_events: 0, batches: 0, status: 'completed', cancelled: false };
    if (!targetIds.length) { summary.status = 'no_targets'; return summary; }

    // FAIL-CLOSED contesto: se richiesto, nessuna lettura puo restare senza contesto agronomico (no scritture prima del check)
    if (requireContext) {
        const cov = await replayContextCoverage({ from: fromTs, to: toTs, scope });
        if (cov.uncovered_readings > 0) { throw new Error(`[replay] fail-closed: ${cov.uncovered_readings}/${cov.total_readings} letture senza contesto agronomico (copri i gap prima del replay)`); }
        summary.context_required = true;
    }

    // checkpoint (skip in dry-run: nessuna scrittura)
    let run = null;
    if (!dryRun) {
        run = await getRun(replayId);
        if (!run) {
            await query(
                `INSERT INTO agro_replay_runs (replay_id, from_ts, to_ts, batch_size, status, target_sensors, scope_owner_user_id, scope_device_id, params)
                 VALUES (?, ?, ?, ?, 'running', ?, ?, ?, CAST(? AS JSONB))`,
                [replayId, fromTs, toTs, batchSize, targets.size, scope && scope.ownerUserId != null ? scope.ownerUserId : null, scope && scope.deviceId != null ? scope.deviceId : null, JSON.stringify({ window_minutes: WINDOW_MINUTES, rule_version: RULE_VERSION })]
            );
            run = await getRun(replayId);
        } else if (run.status === 'completed' && !rebuild) {
            summary.status = 'already_completed';
            summary.processed_readings = Number(run.processed_readings);
            summary.reconstructed_events = Number(run.reconstructed_events);
            return summary; // idempotente: gia completato
        } else {
            await query("UPDATE agro_replay_runs SET status = 'running', cancel_requested = FALSE, updated_at = NOW() WHERE replay_id = ?", [replayId]);
        }
        // rebuild deterministico: rimuove SOLO eventi Sprint 1 dei sensori target nella finestra (target del replay)
        if (rebuild) {
            await query(
                `DELETE FROM agro_actions_detected
                 WHERE sensor_id = ANY(?) AND started_at >= CAST(? AS TIMESTAMPTZ) AND started_at <= CAST(? AS TIMESTAMPTZ)
                   AND rule_version = ANY(?)`,
                [targetIds, fromTs, toTs, SPRINT1_RULE_VERSIONS]
            );
            await query('UPDATE agro_replay_runs SET cursor_ts = NULL, cursor_id = NULL, processed_readings = 0, reconstructed_events = 0, updated_at = NOW() WHERE replay_id = ?', [replayId]);
            run = await getRun(replayId);
        }
    }

    // cursore di ripresa
    let cursorTs = run && run.cursor_ts ? toIso(run.cursor_ts) : null;
    let cursorId = run && run.cursor_id != null ? Number(run.cursor_id) : null;
    let processed = run ? Number(run.processed_readings) : 0;
    let events = run ? Number(run.reconstructed_events) : 0;

    for (;;) {
        // cancellazione cooperativa
        if (!dryRun) {
            const cur = await getRun(replayId);
            if (cur && cur.cancel_requested) { summary.status = 'cancelled'; summary.cancelled = true; await query("UPDATE agro_replay_runs SET status='cancelled', updated_at=NOW() WHERE replay_id=?", [replayId]); break; }
        }
        // batch cronologico di letture (tuple cursor per resume deterministico)
        const params = [targetIds, fromTs, toTs];
        let cursorClause = '';
        if (cursorTs !== null) { cursorClause = 'AND (timestamp > CAST(? AS TIMESTAMPTZ) OR (timestamp = CAST(? AS TIMESTAMPTZ) AND id > ?))'; params.push(cursorTs, cursorTs, cursorId); }
        params.push(batchSize);
        const batch = await query(
            `SELECT id, sensor_id, timestamp FROM sensor_readings
             WHERE sensor_id = ANY(?) AND timestamp >= CAST(? AS TIMESTAMPTZ) AND timestamp <= CAST(? AS TIMESTAMPTZ)
             ${cursorClause}
             ORDER BY timestamp ASC, id ASC LIMIT ?`,
            params
        );
        if (!batch.length) { break; }
        for (const r of batch) {
            const target = targets.get(r.sensor_id);
            if (!target) { throw new Error(`[replay] fail-closed: lettura ${r.id} su sensore ${r.sensor_id} non risolvibile a owner/device`); }
            events += await processReading(target, toIso(r.timestamp), dryRun);
            processed += 1;
            cursorTs = toIso(r.timestamp); cursorId = Number(r.id);
        }
        summary.batches += 1;
        if (!dryRun) {
            await query(
                'UPDATE agro_replay_runs SET cursor_ts = CAST(? AS TIMESTAMPTZ), cursor_id = ?, processed_readings = ?, reconstructed_events = ?, updated_at = NOW() WHERE replay_id = ?',
                [cursorTs, cursorId, processed, events, replayId]
            );
        }
        if (batch.length < batchSize) { break; }
    }

    summary.processed_readings = processed;
    summary.reconstructed_events = events;
    if (!dryRun && (requireContext || tagContext) && summary.status === 'completed') {
        summary.context_tagged = await tagEventsContext(targetIds, fromTs, toTs, requireContext);
    }
    if (!dryRun && summary.status === 'completed') {
        await query("UPDATE agro_replay_runs SET status = 'completed', updated_at = NOW() WHERE replay_id = ?", [replayId]);
    }
    return summary;
}

// Report di copertura del contesto sulla finestra (DRY-RUN: nessuna scrittura). Precedenza sensor > device.
async function replayContextCoverage({ from, to, scope = null } = {}) {
    await ensureContextSchema();
    const fromTs = toIso(from); const toTs = toIso(to);
    const targets = await resolveTargets({ scope });
    const targetIds = [...targets.keys()];
    if (!targetIds.length) { return { target_sensors: 0, total_readings: 0, covered_readings: 0, uncovered_readings: 0, production_readings: 0, non_production_readings: 0 }; }
    const r = (await query(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE c.id IS NULL) AS uncovered,
                count(*) FILTER (WHERE c.is_production) AS production,
                count(*) FILTER (WHERE c.id IS NOT NULL AND NOT c.is_production) AS non_production
         FROM sensor_readings sr
         JOIN sensors s ON s.id = sr.sensor_id
         LEFT JOIN LATERAL (
            SELECT c.id, c.is_production FROM agro_context_segments c
            WHERE c.device_id = s.device_id AND (c.sensor_id = sr.sensor_id OR c.sensor_id IS NULL)
              AND c.valid_from <= sr.timestamp AND (c.valid_to IS NULL OR c.valid_to > sr.timestamp)
            ORDER BY (c.sensor_id IS NULL) ASC, c.valid_from DESC LIMIT 1) c ON TRUE
         WHERE sr.sensor_id = ANY(?) AND sr.timestamp >= CAST(? AS TIMESTAMPTZ) AND sr.timestamp <= CAST(? AS TIMESTAMPTZ)`,
        [targetIds, fromTs, toTs]
    ))[0];
    const total = Number(r.total); const uncovered = Number(r.uncovered);
    return { target_sensors: targets.size, total_readings: total, covered_readings: total - uncovered, uncovered_readings: uncovered, production_readings: Number(r.production), non_production_readings: Number(r.non_production) };
}

// Etichetta gli eventi ricostruiti col context_id risolto (sensor-level poi device-level). Fail-closed se richiesto.
async function tagEventsContext(targetIds, fromTs, toTs, requireContext) {
    await query(
        `UPDATE agro_actions_detected AS ev SET context_id = c.id
         FROM agro_context_segments c
         WHERE ev.context_id IS NULL AND ev.sensor_id = ANY(?) AND ev.started_at >= CAST(? AS TIMESTAMPTZ) AND ev.started_at <= CAST(? AS TIMESTAMPTZ)
           AND c.device_id = ev.device_id AND c.sensor_id = ev.sensor_id
           AND c.valid_from <= ev.started_at AND (c.valid_to IS NULL OR c.valid_to > ev.started_at)`,
        [targetIds, fromTs, toTs]
    );
    await query(
        `UPDATE agro_actions_detected AS ev SET context_id = c.id
         FROM agro_context_segments c
         WHERE ev.context_id IS NULL AND ev.sensor_id = ANY(?) AND ev.started_at >= CAST(? AS TIMESTAMPTZ) AND ev.started_at <= CAST(? AS TIMESTAMPTZ)
           AND c.device_id = ev.device_id AND c.sensor_id IS NULL
           AND c.valid_from <= ev.started_at AND (c.valid_to IS NULL OR c.valid_to > ev.started_at)`,
        [targetIds, fromTs, toTs]
    );
    const tagged = Number((await query(`SELECT count(*) c FROM agro_actions_detected WHERE sensor_id = ANY(?) AND started_at >= CAST(? AS TIMESTAMPTZ) AND started_at <= CAST(? AS TIMESTAMPTZ) AND context_id IS NOT NULL`, [targetIds, fromTs, toTs]))[0].c);
    if (requireContext) {
        const missing = Number((await query(`SELECT count(*) c FROM agro_actions_detected WHERE sensor_id = ANY(?) AND started_at >= CAST(? AS TIMESTAMPTZ) AND started_at <= CAST(? AS TIMESTAMPTZ) AND context_id IS NULL`, [targetIds, fromTs, toTs]))[0].c);
        if (missing > 0) { throw new Error(`[replay] fail-closed: ${missing} eventi senza context_id`); }
    }
    return tagged;
}

module.exports = { ensureReplaySchema, runHistoricalReplay, resolveTargets, requestReplayCancel, getRun, replayKey, replayContextCoverage, tagEventsContext, RULE_VERSION, WINDOW_MINUTES };
