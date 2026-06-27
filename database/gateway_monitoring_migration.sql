-- Rayat - per-device gateway/data logger offline monitoring
-- PostgreSQL migration. Safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS gateway_monitor_config (
  device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  expected_interval_minutes INTEGER NOT NULL DEFAULT 30,
  warning_grace_minutes INTEGER NOT NULL DEFAULT 3,
  offline_after_minutes INTEGER NOT NULL DEFAULT 45,
  critical_after_minutes INTEGER NOT NULL DEFAULT 60,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS expected_interval_min INTEGER NOT NULL DEFAULT 30;
ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS dashboard_offline_after_min INTEGER NOT NULL DEFAULT 35;
ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS email_alert_after_min INTEGER NOT NULL DEFAULT 45;
ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS cooldown_min INTEGER NOT NULL DEFAULT 60;
ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS recipients TEXT NULL;
ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS custom_offline_message TEXT NULL;
ALTER TABLE gateway_monitor_config ADD COLUMN IF NOT EXISTS admin_updated_at TIMESTAMPTZ NULL;

UPDATE gateway_monitor_config
SET
  alerts_enabled = enabled,
  expected_interval_min = expected_interval_minutes,
  dashboard_offline_after_min = offline_after_minutes,
  email_alert_after_min = critical_after_minutes,
  updated_at = CURRENT_TIMESTAMP
WHERE admin_updated_at IS NULL;

CREATE TABLE IF NOT EXISTS gateway_alert_state (
  device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  current_level VARCHAR(10) NOT NULL DEFAULT 'online',
  level_since TIMESTAMPTZ NULL,
  last_alert_sent_at TIMESTAMPTZ NULL,
  last_seen_evaluated TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS dashboard_status VARCHAR(16) NOT NULL DEFAULT 'online';
ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS offline_since TIMESTAMPTZ NULL;
ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS offline_notified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS last_offline_alert_sent_at TIMESTAMPTZ NULL;
ALTER TABLE gateway_alert_state ADD COLUMN IF NOT EXISTS last_recovery_sent_at TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS gateway_alerts (
  id BIGSERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  alert_type VARCHAR(10) NOT NULL,
  minutes_without_data INTEGER NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ NULL,
  level_from VARCHAR(16) NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE gateway_alerts ADD COLUMN IF NOT EXISTS recipients TEXT NULL;
ALTER TABLE gateway_alerts ADD COLUMN IF NOT EXISTS status_snapshot VARCHAR(16) NULL;
ALTER TABLE gateway_alerts ADD COLUMN IF NOT EXISTS cooldown_minutes INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_gw_alerts_device ON gateway_alerts (device_id, created_at DESC);

INSERT INTO gateway_monitor_config (
  device_id,
  alerts_enabled,
  expected_interval_min,
  dashboard_offline_after_min,
  email_alert_after_min,
  cooldown_min,
  recipients,
  custom_offline_message,
  expected_interval_minutes,
  offline_after_minutes,
  critical_after_minutes,
  enabled,
  updated_at
)
SELECT
  d.id,
  TRUE,
  30,
  34,
  38,
  60,
  NULL,
  NULL,
  30,
  34,
  38,
  TRUE,
  CURRENT_TIMESTAMP
FROM devices d
WHERE d.device_id = 'GW-001'
ON CONFLICT (device_id) DO UPDATE SET
  alerts_enabled = EXCLUDED.alerts_enabled,
  expected_interval_min = EXCLUDED.expected_interval_min,
  dashboard_offline_after_min = EXCLUDED.dashboard_offline_after_min,
  email_alert_after_min = EXCLUDED.email_alert_after_min,
  cooldown_min = EXCLUDED.cooldown_min,
  expected_interval_minutes = EXCLUDED.expected_interval_minutes,
  offline_after_minutes = EXCLUDED.offline_after_minutes,
  critical_after_minutes = EXCLUDED.critical_after_minutes,
  enabled = EXCLUDED.enabled,
  updated_at = CURRENT_TIMESTAMP
WHERE gateway_monitor_config.admin_updated_at IS NULL;

INSERT INTO gateway_monitor_config (
  device_id,
  alerts_enabled,
  expected_interval_min,
  dashboard_offline_after_min,
  email_alert_after_min,
  cooldown_min,
  recipients,
  custom_offline_message,
  expected_interval_minutes,
  offline_after_minutes,
  critical_after_minutes,
  enabled,
  updated_at
)
SELECT
  d.id,
  TRUE,
  40,
  44,
  48,
  60,
  NULL,
  $gw002$Data logger GW-002 offline.

Il sistema non riceve più segnali dal gateway/data logger.

Possibili motivi:
- credito SIM esaurito
- problema rete 4G
- batteria/alimentazione
- gateway spento
- problema in campo

Azione consigliata:
ricaricare la SIM 4G oppure recarsi in campo per controllare il data logger.$gw002$,
  40,
  44,
  48,
  TRUE,
  CURRENT_TIMESTAMP
FROM devices d
WHERE d.device_id = 'GW-002'
ON CONFLICT (device_id) DO UPDATE SET
  alerts_enabled = EXCLUDED.alerts_enabled,
  expected_interval_min = EXCLUDED.expected_interval_min,
  dashboard_offline_after_min = EXCLUDED.dashboard_offline_after_min,
  email_alert_after_min = EXCLUDED.email_alert_after_min,
  cooldown_min = EXCLUDED.cooldown_min,
  custom_offline_message = COALESCE(gateway_monitor_config.custom_offline_message, EXCLUDED.custom_offline_message),
  expected_interval_minutes = EXCLUDED.expected_interval_minutes,
  offline_after_minutes = EXCLUDED.offline_after_minutes,
  critical_after_minutes = EXCLUDED.critical_after_minutes,
  enabled = EXCLUDED.enabled,
  updated_at = CURRENT_TIMESTAMP
WHERE gateway_monitor_config.admin_updated_at IS NULL;

COMMIT;
