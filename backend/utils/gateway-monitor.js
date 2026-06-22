// Rayat — Per-device Gateway Connectivity Monitor (additivo, sola lettura su devices.last_seen)
// Warning / Offline / Critical / Recovery PER SINGOLO gateway, con soglie per-device.
// NON usa MAX(timestamp) globale (quella logica resta come fallback di sistema in alertJob).
// NON tocca MQTT/Modbus/decoder/dashboard/Perlite/api_key/config fisica dei device.
// Dedup: invio solo al cambio di livello (no spam ogni minuto). Recovery solo dopo warning/offline/critical.
'use strict';
const { query } = require('../config/database');

const LEVELS = ['online', 'warning', 'offline', 'critical'];
const RANK = { online: 0, warning: 1, offline: 2, critical: 3 };
const DEFAULT_CONFIG = Object.freeze({
    expected_interval_minutes: 30,
    warning_grace_minutes: 3,
    offline_after_minutes: 45,
    critical_after_minutes: 60
});
// Soglie specifiche richieste per i gateway noti (per device_id testuale).
const SEED_CONFIGS = Object.freeze({
    'GW-001': { expected_interval_minutes: 30, warning_grace_minutes: 3, offline_after_minutes: 40, critical_after_minutes: 60 },
    'GW-002': { expected_interval_minutes: 40, warning_grace_minutes: 3, offline_after_minutes: 45, critical_after_minutes: 60 }
});

function warningAfter(cfg) { return Number(cfg.expected_interval_minutes) + Number(cfg.warning_grace_minutes); }

// ---- pure: livello in base ai minuti senza dati ----
function computeLevel(minutes, cfg) {
    if (!(minutes >= 0)) { return 'online'; }
    if (minutes >= cfg.critical_after_minutes) { return 'critical'; }
    if (minutes >= cfg.offline_after_minutes) { return 'offline'; }
    if (minutes >= warningAfter(cfg)) { return 'warning'; }
    return 'online';
}

async function ensureGatewayMonitorSchema(executor = query) {
    await executor(
        `CREATE TABLE IF NOT EXISTS gateway_monitor_config (
           device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
           expected_interval_minutes INTEGER NOT NULL DEFAULT 30,
           warning_grace_minutes INTEGER NOT NULL DEFAULT 3,
           offline_after_minutes INTEGER NOT NULL DEFAULT 45,
           critical_after_minutes INTEGER NOT NULL DEFAULT 60,
           enabled BOOLEAN NOT NULL DEFAULT TRUE,
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT chk_gw_cfg_ranges CHECK (
             expected_interval_minutes > 0 AND warning_grace_minutes >= 0
             AND offline_after_minutes > (expected_interval_minutes + warning_grace_minutes)
             AND critical_after_minutes >= offline_after_minutes)
         )`
    );
    await executor(
        `CREATE TABLE IF NOT EXISTS gateway_alert_state (
           device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
           current_level VARCHAR(10) NOT NULL DEFAULT 'online',
           level_since TIMESTAMPTZ NULL,
           last_alert_sent_at TIMESTAMPTZ NULL,
           last_seen_evaluated TIMESTAMPTZ NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT chk_gw_state_level CHECK (current_level IN ('online','warning','offline','critical'))
         )`
    );
    await executor(
        `CREATE TABLE IF NOT EXISTS gateway_alerts (
           id BIGSERIAL PRIMARY KEY,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           alert_type VARCHAR(10) NOT NULL,
           minutes_without_data INTEGER NOT NULL DEFAULT 0,
           last_seen_at TIMESTAMPTZ NULL,
           level_from VARCHAR(10) NULL,
           subject TEXT NOT NULL DEFAULT '',
           body TEXT NOT NULL DEFAULT '',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT chk_gw_alert_type CHECK (alert_type IN ('warning','offline','critical','recovery'))
         )`
    );
    await executor('CREATE INDEX IF NOT EXISTS idx_gw_alerts_device ON gateway_alerts (device_id, created_at DESC)');
}

// Imposta/aggiorna le soglie per un device_id testuale, se il device esiste. Idempotente.
async function seedGatewayConfig(deviceCode, cfg, executor = query) {
    const rows = await executor('SELECT id FROM devices WHERE device_id = ?', [deviceCode]);
    if (!rows.length) { return false; }
    const id = rows[0].id;
    await executor(
        `INSERT INTO gateway_monitor_config (device_id, expected_interval_minutes, warning_grace_minutes, offline_after_minutes, critical_after_minutes, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, TRUE, NOW())
         ON CONFLICT (device_id) DO UPDATE SET
           expected_interval_minutes = EXCLUDED.expected_interval_minutes, warning_grace_minutes = EXCLUDED.warning_grace_minutes,
           offline_after_minutes = EXCLUDED.offline_after_minutes, critical_after_minutes = EXCLUDED.critical_after_minutes,
           enabled = TRUE, updated_at = NOW()
         RETURNING device_id`,
        [id, cfg.expected_interval_minutes, cfg.warning_grace_minutes, cfg.offline_after_minutes, cfg.critical_after_minutes]
    );
    return true;
}

async function seedDefaultGatewayConfigs(executor = query) {
    const out = {};
    for (const [code, cfg] of Object.entries(SEED_CONFIGS)) { out[code] = await seedGatewayConfig(code, cfg, executor); }
    return out;
}

// Carica i gateway monitorati (solo quelli con config abilitata) + dati cliente.
async function loadMonitoredDevices(executor = query) {
    return executor(
        `SELECT d.id AS device_pk, d.device_id, d.name AS device_name, d.last_seen,
                u.name AS customer_name, u.email AS customer_email,
                c.expected_interval_minutes, c.warning_grace_minutes, c.offline_after_minutes, c.critical_after_minutes,
                s.current_level, s.level_since
         FROM gateway_monitor_config c
         JOIN devices d ON d.id = c.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN gateway_alert_state s ON s.device_id = c.device_id
         WHERE c.enabled = TRUE`
    );
}

function fmtTs(d) { return d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'mai'; }

// ---- pure: costruzione email (IT, con tutti i campi richiesti) ----
function buildAlertPayload(dev, type, minutes, downtimeMinutes) {
    const name = dev.device_name || dev.device_id;
    const customer = dev.customer_name || dev.customer_email || 'cliente non assegnato';
    const lastData = fmtTs(dev.last_seen);
    const head = `Gateway ${name} (${dev.device_id}) — cliente: ${customer}`;
    const common = `${head}\nUltimo dato ricevuto: ${lastData}\nMinuti senza dati: ${minutes}\nTipo avviso: ${type.toUpperCase()}`;
    if (type === 'warning') {
        return { subject: `[WARNING] ${name}: invio dati mancante`,
            body: `${common}\n\nIl gateway non ha inviato dati entro l'orario previsto del prossimo invio. Possibile credito SIM esaurito o perdita di rete: controlla per tempo, così eviti che resti offline a lungo.` };
    }
    if (type === 'offline') {
        return { subject: `[OFFLINE] ${name}: gateway offline`,
            body: `${common}\n\nIl gateway risulta OFFLINE (nessun dato oltre la soglia). Verifica credito SIM, copertura rete e alimentazione il prima possibile.` };
    }
    if (type === 'critical') {
        return { subject: `[CRITICAL] ${name}: offline da oltre 60 minuti`,
            body: `${common}\n\nCRITICO: il gateway è offline da oltre ~60 minuti. Verifica SIM (credito/rete) e alimentazione. Attenzione: anche dopo la ricarica della SIM il data logger potrebbe non ripartire da solo — potrebbe essere necessario un intervento fisico in campo per riavviarlo manualmente.` };
    }
    // recovery
    return { subject: `[RECOVERY] ${name}: gateway di nuovo online`,
        body: `${head}\nUltimo dato ricevuto: ${lastData}\nTipo avviso: RECOVERY\nDowntime stimato: ${downtimeMinutes != null ? downtimeMinutes + ' minuti' : 'n/d'}\n\nIl gateway ha ripreso a inviare dati ed è tornato ONLINE.` };
}

async function upsertState(devicePk, level, levelSince, lastSeen, executor) {
    await executor(
        `INSERT INTO gateway_alert_state (device_id, current_level, level_since, last_alert_sent_at, last_seen_evaluated, updated_at)
         VALUES (?, ?, ?, NOW(), ?, NOW())
         ON CONFLICT (device_id) DO UPDATE SET
           current_level = EXCLUDED.current_level, level_since = EXCLUDED.level_since,
           last_alert_sent_at = NOW(), last_seen_evaluated = EXCLUDED.last_seen_evaluated, updated_at = NOW()
         RETURNING device_id`,
        [devicePk, level, levelSince, lastSeen]
    );
}

// Esecuzione: valuta ogni gateway monitorato, invia SOLO sulle transizioni, registra in gateway_alerts.
async function runGatewayMonitor({ now = new Date(), sendEmail = null, dryRun = false, executor = query } = {}) {
    const summary = { evaluated: 0, sent: { warning: 0, offline: 0, critical: 0, recovery: 0 }, dry_run: dryRun, by_device: {} };
    const devices = await loadMonitoredDevices(executor);
    for (const dev of devices) {
        summary.evaluated += 1;
        const cfg = {
            expected_interval_minutes: Number(dev.expected_interval_minutes),
            warning_grace_minutes: Number(dev.warning_grace_minutes),
            offline_after_minutes: Number(dev.offline_after_minutes),
            critical_after_minutes: Number(dev.critical_after_minutes)
        };
        const prev = dev.current_level || 'online';
        if (!dev.last_seen) { summary.by_device[dev.device_id] = { level: prev, action: 'skip_never_seen' }; continue; }
        const minutes = Math.floor((now.getTime() - new Date(dev.last_seen).getTime()) / 60000);
        const level = computeLevel(minutes, cfg);

        let type = null; let downtime = null; let newLevelSince = dev.level_since;
        if (RANK[level] > RANK[prev]) {
            type = level; // warning | offline | critical
            if (prev === 'online' || !dev.level_since) { newLevelSince = new Date(now.getTime() - minutes * 60000); }
        } else if (level === 'online' && prev !== 'online') {
            type = 'recovery';
            if (dev.level_since) { downtime = Math.max(0, Math.floor((now.getTime() - new Date(dev.level_since).getTime()) / 60000)); }
            newLevelSince = null;
        }

        if (!type) { summary.by_device[dev.device_id] = { level, minutes, action: 'no_change' }; continue; }

        const payload = buildAlertPayload(dev, type, minutes, downtime);
        summary.by_device[dev.device_id] = { level, minutes, action: 'sent', type };
        summary.sent[type] += 1;
        if (!dryRun) {
            await executor(
                `INSERT INTO gateway_alerts (device_id, alert_type, minutes_without_data, last_seen_at, level_from, subject, body, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW()) RETURNING id`,
                [dev.device_pk, type, minutes, dev.last_seen, prev, payload.subject, payload.body]
            );
            await upsertState(dev.device_pk, level, newLevelSince, dev.last_seen, executor);
            if (typeof sendEmail === 'function') {
                try {
                    await sendEmail({
                        device_id: dev.device_id, device_name: dev.device_name, customer_name: dev.customer_name,
                        customer_email: dev.customer_email, alert_type: type, minutes_without_data: minutes,
                        last_seen_at: dev.last_seen, downtime_minutes: downtime, subject: payload.subject, body: payload.body
                    });
                } catch (e) { /* delivery non blocca lo stato (no spam: stato già aggiornato) */ }
            }
        }
    }
    return summary;
}

module.exports = {
    ensureGatewayMonitorSchema, runGatewayMonitor, computeLevel, warningAfter, buildAlertPayload,
    seedGatewayConfig, seedDefaultGatewayConfigs, loadMonitoredDevices,
    LEVELS, RANK, DEFAULT_CONFIG, SEED_CONFIGS
};
