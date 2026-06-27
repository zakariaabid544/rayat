// Rayat - Per-device Gateway/Data Logger Connectivity Monitor.
// Additive and backward compatible: keeps the old tables/columns but evaluates
// each device independently using that device's latest sensor data.
'use strict';

const { query } = require('../config/database');
const { getMonitoringConfig } = require('./monitoring-config');

const DASHBOARD_STATUSES = ['online', 'delayed', 'offline', 'alert_sent', 'never'];
const LEGACY_LEVELS = ['online', 'warning', 'offline', 'critical'];
const RANK = { online: 0, delayed: 1, warning: 1, offline: 2, alert_sent: 3, critical: 3, never: 2 };

const DEFAULT_COOLDOWN_MINUTES = 60;
const DEFAULT_CONFIG = Object.freeze({
    alerts_enabled: true,
    expected_interval_min: 30,
    dashboard_offline_after_min: 35,
    email_alert_after_min: 45,
    cooldown_min: DEFAULT_COOLDOWN_MINUTES,
    recipients: '',
    custom_offline_message: ''
});

const GW002_DEFAULT_OFFLINE_MESSAGE = `Data logger GW-002 offline.

Il sistema non riceve più segnali dal gateway/data logger.

Possibili motivi:
- credito SIM esaurito
- problema rete 4G
- batteria/alimentazione
- gateway spento
- problema in campo

Azione consigliata:
ricaricare la SIM 4G oppure recarsi in campo per controllare il data logger.`;

const SEED_CONFIGS = Object.freeze({
    'GW-001': {
        alerts_enabled: true,
        expected_interval_min: 30,
        dashboard_offline_after_min: 34,
        email_alert_after_min: 38,
        cooldown_min: 60,
        recipients: '',
        custom_offline_message: ''
    },
    'GW-002': {
        alerts_enabled: true,
        expected_interval_min: 40,
        dashboard_offline_after_min: 44,
        email_alert_after_min: 48,
        cooldown_min: 60,
        recipients: '',
        custom_offline_message: GW002_DEFAULT_OFFLINE_MESSAGE
    }
});

function parsePositiveInteger(value, fallback, max = 10080) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(parsed, max);
}

function parseBoolean(value, fallback = true) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return fallback;
}

function cleanString(value, maxLength = 2000) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function parseRecipients(value) {
    return cleanString(value, 2000)
        .split(/[,\n;]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function serializeRecipients(value) {
    return parseRecipients(value).join(', ');
}

function fallbackConfigFromEnv() {
    const monitoring = getMonitoringConfig();
    return {
        ...DEFAULT_CONFIG,
        expected_interval_min: monitoring.expectedDataMinutes,
        dashboard_offline_after_min: monitoring.offlineAfterMinutes,
        email_alert_after_min: monitoring.emailAfterMinutes,
        cooldown_min: parsePositiveInteger(process.env.GATEWAY_ALERT_COOLDOWN_MINUTES, DEFAULT_COOLDOWN_MINUTES)
    };
}

function normalizeMonitoringConfig(row = {}) {
    const fallback = fallbackConfigFromEnv();
    const expected = parsePositiveInteger(
        row.expected_interval_min ?? row.expected_interval_minutes,
        fallback.expected_interval_min
    );
    const dashboardOffline = parsePositiveInteger(
        row.dashboard_offline_after_min ?? row.offline_after_minutes,
        Math.max(expected + 1, fallback.dashboard_offline_after_min)
    );
    const emailAfter = parsePositiveInteger(
        row.email_alert_after_min ?? row.critical_after_minutes,
        Math.max(dashboardOffline + 1, fallback.email_alert_after_min)
    );

    return {
        alerts_enabled: parseBoolean(row.alerts_enabled ?? row.enabled, fallback.alerts_enabled),
        expected_interval_min: expected,
        dashboard_offline_after_min: Math.max(expected + 1, dashboardOffline),
        email_alert_after_min: Math.max(Math.max(expected + 1, dashboardOffline), emailAfter),
        cooldown_min: parsePositiveInteger(row.cooldown_min, fallback.cooldown_min),
        recipients: serializeRecipients(row.recipients ?? fallback.recipients),
        custom_offline_message: cleanString(row.custom_offline_message ?? fallback.custom_offline_message, 4000)
    };
}

function validateMonitoringConfigPayload(payload = {}) {
    const cfg = normalizeMonitoringConfig(payload);
    if (cfg.dashboard_offline_after_min <= cfg.expected_interval_min) {
        throw new Error('dashboard_offline_after_min deve essere maggiore di expected_interval_min');
    }
    if (cfg.email_alert_after_min < cfg.dashboard_offline_after_min) {
        throw new Error('email_alert_after_min deve essere maggiore o uguale a dashboard_offline_after_min');
    }
    return cfg;
}

function fmtTs(value) {
    return value ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'mai';
}

function lastDataTimestamp(device = {}) {
    return device.last_data_at || device.last_seen || null;
}

function computeDashboardStatus(minutesWithoutData, cfg) {
    if (!(minutesWithoutData >= 0)) {
        return 'never';
    }
    if (minutesWithoutData >= cfg.dashboard_offline_after_min) {
        return 'offline';
    }
    if (minutesWithoutData >= cfg.expected_interval_min) {
        return 'delayed';
    }
    return 'online';
}

function legacyLevelForStatus(status) {
    if (status === 'delayed') {
        return 'warning';
    }
    if (status === 'alert_sent') {
        return 'offline';
    }
    if (status === 'never') {
        return 'offline';
    }
    return status;
}

function computeLevel(minutes, cfg) {
    return legacyLevelForStatus(computeDashboardStatus(minutes, normalizeMonitoringConfig(cfg)));
}

function warningAfter(cfg) {
    return Number(normalizeMonitoringConfig(cfg).expected_interval_min);
}

function minutesBetween(left, right) {
    const leftMs = left ? new Date(left).getTime() : NaN;
    const rightMs = right ? new Date(right).getTime() : NaN;
    if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
        return null;
    }
    return Math.max(0, Math.floor((rightMs - leftMs) / 60000));
}

function evaluateDeviceMonitoring(device = {}, now = new Date()) {
    const cfg = normalizeMonitoringConfig(device);
    const lastDataAt = lastDataTimestamp(device);
    const nowMs = now.getTime();
    const lastMs = lastDataAt ? new Date(lastDataAt).getTime() : NaN;
    const minutesWithoutData = Number.isFinite(lastMs)
        ? Math.max(0, Math.floor((nowMs - lastMs) / 60000))
        : null;
    const baseStatus = computeDashboardStatus(minutesWithoutData, cfg);
    const wasNotified = parseBoolean(device.offline_notified, false);
    const lastOfflineAlertAt = device.last_offline_alert_sent_at || device.last_alert_sent_at || null;
    const cooldownElapsed = !lastOfflineAlertAt
        || minutesBetween(lastOfflineAlertAt, now) >= cfg.cooldown_min;

    let dashboardStatus = baseStatus;
    let alertType = null;
    let shouldSendEmail = false;
    let offlineNotified = wasNotified;
    let offlineSince = device.offline_since || null;
    let lastOfflineAlert = lastOfflineAlertAt;
    let lastRecovery = device.last_recovery_sent_at || null;

    if (baseStatus === 'online') {
        if (wasNotified) {
            alertType = 'recovery';
            shouldSendEmail = true;
            lastRecovery = now.toISOString();
        }
        offlineNotified = false;
        offlineSince = null;
    } else if (baseStatus === 'offline') {
        offlineSince = offlineSince || (
            lastDataAt
                ? new Date(new Date(lastDataAt).getTime() + cfg.dashboard_offline_after_min * 60000).toISOString()
                : now.toISOString()
        );

        if (minutesWithoutData >= cfg.email_alert_after_min) {
            if (cooldownElapsed) {
                alertType = 'offline';
                shouldSendEmail = true;
                offlineNotified = true;
                lastOfflineAlert = now.toISOString();
            }
            if (offlineNotified || lastOfflineAlertAt) {
                dashboardStatus = 'alert_sent';
            }
        }
    } else if (baseStatus === 'never') {
        offlineSince = offlineSince || now.toISOString();
    }

    return {
        config: cfg,
        last_data_at: lastDataAt,
        minutes_without_data: minutesWithoutData,
        dashboard_status: dashboardStatus,
        legacy_level: legacyLevelForStatus(dashboardStatus),
        alert_type: alertType,
        should_send_email: shouldSendEmail,
        next_state: {
            dashboard_status: dashboardStatus,
            current_level: legacyLevelForStatus(dashboardStatus),
            offline_since: offlineSince,
            offline_notified: offlineNotified,
            last_offline_alert_sent_at: lastOfflineAlert,
            last_recovery_sent_at: lastRecovery,
            last_seen_evaluated: lastDataAt
        }
    };
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
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`
    );
    await executor('ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE');
    await executor('ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS expected_interval_min INTEGER NOT NULL DEFAULT 30');
    await executor('ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS dashboard_offline_after_min INTEGER NOT NULL DEFAULT 35');
    await executor('ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS email_alert_after_min INTEGER NOT NULL DEFAULT 45');
    await executor('ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS cooldown_min INTEGER NOT NULL DEFAULT 60');
    await executor('ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS recipients TEXT NULL');
    await executor('ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS custom_offline_message TEXT NULL');
    await executor('ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS admin_updated_at TIMESTAMPTZ NULL');

    await executor(
        `CREATE TABLE IF NOT EXISTS gateway_alert_state (
           device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
           current_level VARCHAR(10) NOT NULL DEFAULT 'online',
           level_since TIMESTAMPTZ NULL,
           last_alert_sent_at TIMESTAMPTZ NULL,
           last_seen_evaluated TIMESTAMPTZ NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`
    );
    await executor('ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS dashboard_status VARCHAR(16) NOT NULL DEFAULT \'online\'');
    await executor('ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS offline_since TIMESTAMPTZ NULL');
    await executor('ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS offline_notified BOOLEAN NOT NULL DEFAULT FALSE');
    await executor('ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS last_offline_alert_sent_at TIMESTAMPTZ NULL');
    await executor('ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS last_recovery_sent_at TIMESTAMPTZ NULL');

    await executor(
        `CREATE TABLE IF NOT EXISTS gateway_alerts (
           id BIGSERIAL PRIMARY KEY,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           alert_type VARCHAR(10) NOT NULL,
           minutes_without_data INTEGER NOT NULL DEFAULT 0,
           last_seen_at TIMESTAMPTZ NULL,
           level_from VARCHAR(16) NULL,
           subject TEXT NOT NULL DEFAULT '',
           body TEXT NOT NULL DEFAULT '',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`
    );
    await executor('ALTER TABLE gateway_alerts ADD COLUMN IF NOT EXISTS recipients TEXT NULL');
    await executor('ALTER TABLE gateway_alerts ADD COLUMN IF NOT EXISTS status_snapshot VARCHAR(16) NULL');
    await executor('ALTER TABLE gateway_alerts ADD COLUMN IF NOT EXISTS cooldown_minutes INTEGER NULL');
    await executor('CREATE INDEX IF NOT EXISTS idx_gw_alerts_device ON gateway_alerts (device_id, created_at DESC)');
}

async function seedGatewayConfig(deviceCode, cfg, executor = query) {
    const rows = await executor('SELECT id FROM devices WHERE device_id = ?', [deviceCode]);
    if (!rows.length) {
        return false;
    }

    const normalized = validateMonitoringConfigPayload(cfg);
    await executor(
        `INSERT INTO gateway_monitor_config (
            device_id, alerts_enabled, expected_interval_min, dashboard_offline_after_min,
            email_alert_after_min, cooldown_min, recipients, custom_offline_message,
            expected_interval_minutes, offline_after_minutes, critical_after_minutes,
            enabled, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON CONFLICT (device_id) DO UPDATE SET
           alerts_enabled = EXCLUDED.alerts_enabled,
           expected_interval_min = EXCLUDED.expected_interval_min,
           dashboard_offline_after_min = EXCLUDED.dashboard_offline_after_min,
           email_alert_after_min = EXCLUDED.email_alert_after_min,
           cooldown_min = EXCLUDED.cooldown_min,
           recipients = COALESCE(gateway_monitor_config.recipients, EXCLUDED.recipients),
           custom_offline_message = COALESCE(gateway_monitor_config.custom_offline_message, EXCLUDED.custom_offline_message),
           expected_interval_minutes = EXCLUDED.expected_interval_minutes,
           offline_after_minutes = EXCLUDED.offline_after_minutes,
           critical_after_minutes = EXCLUDED.critical_after_minutes,
           enabled = EXCLUDED.enabled,
           updated_at = NOW()
         WHERE gateway_monitor_config.admin_updated_at IS NULL
         RETURNING device_id`,
        [
            rows[0].id,
            normalized.alerts_enabled,
            normalized.expected_interval_min,
            normalized.dashboard_offline_after_min,
            normalized.email_alert_after_min,
            normalized.cooldown_min,
            normalized.recipients || null,
            normalized.custom_offline_message || null,
            normalized.expected_interval_min,
            normalized.dashboard_offline_after_min,
            normalized.email_alert_after_min,
            normalized.alerts_enabled
        ]
    );
    return true;
}

async function seedDefaultGatewayConfigs(executor = query) {
    const out = {};
    for (const [code, cfg] of Object.entries(SEED_CONFIGS)) {
        out[code] = await seedGatewayConfig(code, cfg, executor);
    }
    return out;
}

function monitoredDevicesSql(whereClause = '1 = 1') {
    return `
        SELECT
            d.id AS device_pk,
            d.device_id,
            d.name AS device_name,
            d.status AS device_status,
            d.last_seen,
            u.name AS customer_name,
            u.email AS customer_email,
            c.alerts_enabled,
            c.enabled,
            c.expected_interval_min,
            c.expected_interval_minutes,
            c.dashboard_offline_after_min,
            c.offline_after_minutes,
            c.email_alert_after_min,
            c.critical_after_minutes,
            c.cooldown_min,
            c.recipients,
            c.custom_offline_message,
            c.admin_updated_at,
            st.current_level,
            st.dashboard_status,
            st.level_since,
            st.offline_since,
            st.offline_notified,
            st.last_alert_sent_at,
            st.last_offline_alert_sent_at,
            st.last_recovery_sent_at,
            st.last_seen_evaluated,
            lm.last_data_at
        FROM devices d
        LEFT JOIN users u ON u.id = d.user_id
        LEFT JOIN gateway_monitor_config c ON c.device_id = d.id
        LEFT JOIN gateway_alert_state st ON st.device_id = d.id
        LEFT JOIN (
            SELECT s.device_id, MAX(sl.timestamp) AS last_data_at
            FROM sensors s
            LEFT JOIN sensor_latest sl ON sl.sensor_id = s.id
            WHERE s.enabled = TRUE
            GROUP BY s.device_id
        ) lm ON lm.device_id = d.id
        WHERE ${whereClause}
    `;
}

async function loadMonitoredDevices(executor = query) {
    return executor(
        `${monitoredDevicesSql(`
            COALESCE(c.alerts_enabled, c.enabled, TRUE) = TRUE
            AND COALESCE(d.status, 'active') NOT IN ('inactive', 'error')
        `)}
         ORDER BY d.device_id ASC`
    );
}

async function listDeviceMonitoringConfigs({ now = new Date(), executor = query } = {}) {
    const rows = await executor(
        `${monitoredDevicesSql("COALESCE(d.status, 'active') NOT IN ('inactive', 'error')")}
         ORDER BY d.device_id ASC`
    );

    return rows.map((row) => {
        const evaluated = evaluateDeviceMonitoring(row, now);
        return {
            device_pk: row.device_pk,
            device_id: row.device_id,
            device_name: row.device_name,
            device_status: row.device_status,
            customer_name: row.customer_name || null,
            customer_email: row.customer_email || null,
            last_seen: row.last_seen || null,
            last_data_at: evaluated.last_data_at,
            minutes_without_data: evaluated.minutes_without_data,
            dashboard_status: evaluated.dashboard_status,
            last_email_alert_sent_at: row.last_offline_alert_sent_at || row.last_alert_sent_at || null,
            last_recovery_sent_at: row.last_recovery_sent_at || null,
            config: evaluated.config,
            configured: row.alerts_enabled !== null && row.alerts_enabled !== undefined,
            admin_updated_at: row.admin_updated_at || null
        };
    });
}

async function updateDeviceMonitoringConfig(devicePk, payload, executor = query) {
    const id = parsePositiveInteger(devicePk, null, 2147483647);
    if (!id) {
        throw new Error('device_id non valido');
    }
    const cfg = validateMonitoringConfigPayload(payload);
    const rows = await executor('SELECT id FROM devices WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
        const error = new Error('Device non trovato');
        error.statusCode = 404;
        throw error;
    }

    await executor(
        `INSERT INTO gateway_monitor_config (
            device_id, alerts_enabled, expected_interval_min, dashboard_offline_after_min,
            email_alert_after_min, cooldown_min, recipients, custom_offline_message,
            expected_interval_minutes, offline_after_minutes, critical_after_minutes,
            enabled, admin_updated_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON CONFLICT (device_id) DO UPDATE SET
           alerts_enabled = EXCLUDED.alerts_enabled,
           expected_interval_min = EXCLUDED.expected_interval_min,
           dashboard_offline_after_min = EXCLUDED.dashboard_offline_after_min,
           email_alert_after_min = EXCLUDED.email_alert_after_min,
           cooldown_min = EXCLUDED.cooldown_min,
           recipients = EXCLUDED.recipients,
           custom_offline_message = EXCLUDED.custom_offline_message,
           expected_interval_minutes = EXCLUDED.expected_interval_minutes,
           offline_after_minutes = EXCLUDED.offline_after_minutes,
           critical_after_minutes = EXCLUDED.critical_after_minutes,
           enabled = EXCLUDED.enabled,
           admin_updated_at = NOW(),
           updated_at = NOW()
         RETURNING device_id`,
        [
            id,
            cfg.alerts_enabled,
            cfg.expected_interval_min,
            cfg.dashboard_offline_after_min,
            cfg.email_alert_after_min,
            cfg.cooldown_min,
            cfg.recipients || null,
            cfg.custom_offline_message || null,
            cfg.expected_interval_min,
            cfg.dashboard_offline_after_min,
            cfg.email_alert_after_min,
            cfg.alerts_enabled
        ]
    );

    return cfg;
}

function recipientsForDevice(device = {}) {
    return parseRecipients(device.recipients);
}

function buildAlertPayload(dev, type, minutes, downtimeMinutes) {
    const cfg = normalizeMonitoringConfig(dev);
    const name = dev.device_name || dev.device_id;
    const deviceId = dev.device_id || name;
    const customer = dev.customer_name || dev.customer_email || 'cliente non assegnato';
    const lastData = fmtTs(lastDataTimestamp(dev));
    const recipients = recipientsForDevice(cfg);

    if (type === 'offline') {
        const custom = cfg.custom_offline_message || (deviceId === 'GW-002' ? GW002_DEFAULT_OFFLINE_MESSAGE : '');
        const body = custom || `Data logger ${deviceId} offline.

Il sistema non riceve più dati dal gateway/data logger.

Ultimo dato ricevuto: ${lastData}
Minuti senza dati: ${minutes}
Cliente: ${customer}`;
        return {
            subject: `[OFFLINE] Data logger ${deviceId} offline`,
            body,
            recipients
        };
    }

    return {
        subject: `[RECOVERY] Data logger ${deviceId} rientrato online`,
        body: `Data logger ${deviceId} rientrato online.

Il gateway/data logger ha ripreso a inviare dati.

Ultimo dato ricevuto: ${lastData}
Downtime stimato: ${downtimeMinutes != null ? downtimeMinutes + ' minuti' : 'n/d'}
Cliente: ${customer}`,
        recipients
    };
}

async function upsertState(devicePk, state, executor) {
    await executor(
        `INSERT INTO gateway_alert_state (
            device_id, current_level, dashboard_status, level_since, offline_since,
            offline_notified, last_alert_sent_at, last_offline_alert_sent_at,
            last_recovery_sent_at, last_seen_evaluated, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON CONFLICT (device_id) DO UPDATE SET
           current_level = EXCLUDED.current_level,
           dashboard_status = EXCLUDED.dashboard_status,
           level_since = EXCLUDED.level_since,
           offline_since = EXCLUDED.offline_since,
           offline_notified = EXCLUDED.offline_notified,
           last_alert_sent_at = EXCLUDED.last_alert_sent_at,
           last_offline_alert_sent_at = EXCLUDED.last_offline_alert_sent_at,
           last_recovery_sent_at = EXCLUDED.last_recovery_sent_at,
           last_seen_evaluated = EXCLUDED.last_seen_evaluated,
           updated_at = NOW()
         RETURNING device_id`,
        [
            devicePk,
            state.current_level,
            state.dashboard_status,
            state.offline_since,
            state.offline_since,
            state.offline_notified,
            state.last_offline_alert_sent_at || state.last_recovery_sent_at || null,
            state.last_offline_alert_sent_at || null,
            state.last_recovery_sent_at || null,
            state.last_seen_evaluated || null
        ]
    );
}

async function runGatewayMonitor({ now = new Date(), sendEmail = null, dryRun = false, executor = query, devices = null } = {}) {
    const summary = {
        evaluated: 0,
        sent: { offline: 0, recovery: 0 },
        dry_run: dryRun,
        by_device: {}
    };
    const rows = devices || await loadMonitoredDevices(executor);

    for (const row of rows) {
        const dev = { ...row, ...normalizeMonitoringConfig(row) };
        if (!dev.alerts_enabled) {
            summary.by_device[dev.device_id] = { action: 'disabled' };
            continue;
        }

        const evaluation = evaluateDeviceMonitoring(dev, now);
        summary.evaluated += 1;
        summary.by_device[dev.device_id] = {
            status: evaluation.dashboard_status,
            minutes_without_data: evaluation.minutes_without_data,
            action: evaluation.should_send_email ? 'email' : 'state_only',
            alert_type: evaluation.alert_type || null
        };

        if (!dryRun) {
            await upsertState(dev.device_pk, evaluation.next_state, executor);
        }

        if (!evaluation.should_send_email) {
            continue;
        }

        const downtime = evaluation.alert_type === 'recovery'
            ? minutesBetween(dev.offline_since, now)
            : null;
        const payload = buildAlertPayload(dev, evaluation.alert_type, evaluation.minutes_without_data, downtime);
        summary.sent[evaluation.alert_type] += 1;

        if (!dryRun) {
            await executor(
                `INSERT INTO gateway_alerts (
                    device_id, alert_type, minutes_without_data, last_seen_at,
                    level_from, subject, body, recipients, status_snapshot,
                    cooldown_minutes, created_at
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW()) RETURNING id`,
                [
                    dev.device_pk,
                    evaluation.alert_type,
                    evaluation.minutes_without_data || 0,
                    evaluation.last_data_at,
                    dev.dashboard_status || dev.current_level || 'online',
                    payload.subject,
                    payload.body,
                    payload.recipients.join(', ') || null,
                    evaluation.dashboard_status,
                    evaluation.config.cooldown_min
                ]
            );

            if (typeof sendEmail === 'function') {
                try {
                    await sendEmail({
                        device_id: dev.device_id,
                        device_name: dev.device_name,
                        customer_name: dev.customer_name,
                        customer_email: dev.customer_email,
                        alert_type: evaluation.alert_type,
                        minutes_without_data: evaluation.minutes_without_data,
                        last_seen_at: evaluation.last_data_at,
                        downtime_minutes: downtime,
                        subject: payload.subject,
                        body: payload.body,
                        recipients: payload.recipients
                    });
                } catch (error) {
                    summary.by_device[dev.device_id].email_error = error.message;
                }
            }
        }
    }

    return summary;
}

module.exports = {
    DASHBOARD_STATUSES,
    DEFAULT_CONFIG,
    GW002_DEFAULT_OFFLINE_MESSAGE,
    LEGACY_LEVELS,
    RANK,
    SEED_CONFIGS,
    buildAlertPayload,
    computeDashboardStatus,
    computeLevel,
    ensureGatewayMonitorSchema,
    evaluateDeviceMonitoring,
    listDeviceMonitoringConfigs,
    loadMonitoredDevices,
    normalizeMonitoringConfig,
    runGatewayMonitor,
    seedDefaultGatewayConfigs,
    seedGatewayConfig,
    updateDeviceMonitoringConfig,
    validateMonitoringConfigPayload,
    warningAfter
};
