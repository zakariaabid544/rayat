// Profile form field mapping:
// - profile-name -> users.name (canonical identity, read-only via profile API)
// - profile-email -> users.email (canonical identity, read-only via profile API)
// - profile-phone -> users.profile_phone
// - photo upload input handled by handleUserProfilePhotoChange() / saveUserProfile() -> users.profile_photo
// - profile-description -> users.profile_description
// - profile_updated_at stores the last successful profile persistence timestamp
const {
  query,
  getTableColumns,
  getTableIndexes,
  clearSchemaCache
} = require('../config/database');

async function tableExists(tableName) {
  const rows = await query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ?
     LIMIT 1`,
    [tableName]
  );

  return rows.length > 0;
}

async function ensureTable(tableName, createSql) {
  const exists = await tableExists(tableName);
  await query(createSql);
  if (!exists) {
    clearSchemaCache();
  }
  return !exists;
}

async function ensureColumn(tableName, columnName, definition) {
  if (!(await tableExists(tableName))) {
    return false;
  }

  const columns = await getTableColumns(tableName);
  if (columns.has(columnName)) {
    return false;
  }

  await query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  clearSchemaCache();
  return true;
}

async function ensureColumnNullable(tableName, columnName) {
  if (!(await tableExists(tableName))) {
    return false;
  }

  const rows = await query(
    `SELECT is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ?
       AND column_name = ?
     LIMIT 1`,
    [tableName, columnName]
  );

  if (!rows.length || rows[0].is_nullable === 'YES') {
    return false;
  }

  await query(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP NOT NULL`);
  clearSchemaCache();
  return true;
}

async function ensureIndex(tableName, indexName, createSql) {
  if (!(await tableExists(tableName))) {
    return false;
  }

  const indexes = await getTableIndexes(tableName);
  if (indexes.has(indexName)) {
    return false;
  }

  await query(createSql);
  clearSchemaCache();
  return true;
}

async function ensureCoreTables(changes) {
  if (
    await ensureTable(
      'users',
      `CREATE TABLE IF NOT EXISTS users (
         id SERIAL PRIMARY KEY,
         email TEXT UNIQUE,
         password_hash TEXT NOT NULL,
         name TEXT,
         last_name TEXT,
         language VARCHAR(5) DEFAULT 'it',
         phone TEXT,
         crop_type TEXT,
         latitude NUMERIC(10, 7),
         longitude NUMERIC(10, 7),
         location_name TEXT,
         location_address TEXT,
         profile_phone VARCHAR(50),
         profile_description VARCHAR(2000),
         profile_photo VARCHAR(1048576),
         profile_updated_at TIMESTAMPTZ NULL,
         verification_code VARCHAR(10),
         is_verified BOOLEAN DEFAULT FALSE,
         role VARCHAR(32) NOT NULL DEFAULT 'client',
         owner_user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
         customer_role VARCHAR(32) DEFAULT 'owner',
         client_code VARCHAR(20),
         payment_status VARCHAR(20) DEFAULT 'non_pagato',
         payment_date TIMESTAMPTZ NULL,
         subscription_expiry TIMESTAMPTZ NULL,
         registration_status VARCHAR(20) NOT NULL DEFAULT 'active',
         registration_source VARCHAR(20) NOT NULL DEFAULT 'legacy',
         approved_at TIMESTAMPTZ NULL,
         active BOOLEAN DEFAULT TRUE,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('users table');
  }

  if (
    await ensureTable(
      'devices',
      `CREATE TABLE IF NOT EXISTS devices (
         id SERIAL PRIMARY KEY,
         device_id VARCHAR(100) UNIQUE NOT NULL,
         user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
         name TEXT,
         api_key TEXT NOT NULL,
         location TEXT,
         status VARCHAR(20) DEFAULT 'active',
         last_seen TIMESTAMPTZ NULL,
         metadata JSONB,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('devices table');
  }

  if (
    await ensureTable(
      'sensors',
      `CREATE TABLE IF NOT EXISTS sensors (
         id SERIAL PRIMARY KEY,
         device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
         type VARCHAR(32) NOT NULL,
         subtype VARCHAR(50),
         name TEXT,
         unit VARCHAR(20),
         calibration_offset NUMERIC(10, 4) DEFAULT 0,
         enabled BOOLEAN DEFAULT TRUE,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('sensors table');
  }

  if (
    await ensureTable(
      'sensor_readings',
      `CREATE TABLE IF NOT EXISTS sensor_readings (
         id BIGSERIAL PRIMARY KEY,
         sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
         value NUMERIC(10, 2) NOT NULL,
         timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         metadata JSONB
       )`
    )
  ) {
    changes.push('sensor_readings table');
  }

  if (
    await ensureTable(
      'alert_thresholds',
      `CREATE TABLE IF NOT EXISTS alert_thresholds (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         sensor_type VARCHAR(50) NOT NULL,
         threshold_type VARCHAR(10) NOT NULL,
         threshold_value NUMERIC(10, 2) NOT NULL,
         enabled BOOLEAN DEFAULT TRUE,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('alert_thresholds table');
  }

  if (
    await ensureTable(
      'active_alerts',
      `CREATE TABLE IF NOT EXISTS active_alerts (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
         alert_type VARCHAR(20) NOT NULL,
         message TEXT,
         reading_value NUMERIC(10, 2),
         threshold_value NUMERIC(10, 2),
         acknowledged BOOLEAN DEFAULT FALSE,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         acknowledged_at TIMESTAMPTZ NULL
       )`
    )
  ) {
    changes.push('active_alerts table');
  }

  if (
    await ensureTable(
      'alarm_events',
      // RAYAT FIX - analytics followup
      `CREATE TABLE IF NOT EXISTS alarm_events (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         sensor_id INTEGER NULL REFERENCES sensors(id) ON DELETE SET NULL,
         sensor_type VARCHAR(50) NOT NULL,
         sensor_subtype VARCHAR(80) NULL,
         param VARCHAR(80) NOT NULL,
         crop VARCHAR(120) NULL,
         level VARCHAR(16) NOT NULL,
         priority VARCHAR(16) NOT NULL DEFAULT 'medium',
         value NUMERIC(12, 3) NOT NULL,
         optimal_min NUMERIC(12, 3) NULL,
         optimal_max NUMERIC(12, 3) NULL,
         first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         last_notified_at TIMESTAMPTZ NULL,
         notification_count INTEGER NOT NULL DEFAULT 0,
         is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
         resolved_at TIMESTAMPTZ NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('alarm_events table');
  }

  if (
    await ensureTable(
      'sensor_latest',
      `CREATE TABLE IF NOT EXISTS sensor_latest (
         sensor_id INTEGER PRIMARY KEY REFERENCES sensors(id) ON DELETE CASCADE,
         value NUMERIC(10, 2) NOT NULL,
         timestamp TIMESTAMPTZ NOT NULL,
         updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('sensor_latest table');
  }

  if (
    await ensureTable(
      'public_sensor_latest',
      `CREATE TABLE IF NOT EXISTS public_sensor_latest (
         sensor_subtype VARCHAR(80) PRIMARY KEY,
         sensor_type VARCHAR(32) NOT NULL,
         value NUMERIC(10, 2) NOT NULL,
         topic TEXT NULL,
         timestamp TIMESTAMPTZ NOT NULL,
         updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('public_sensor_latest table');
  }

  if (
    await ensureTable(
      'public_sensor_readings',
      `CREATE TABLE IF NOT EXISTS public_sensor_readings (
         id BIGSERIAL PRIMARY KEY,
         sensor_type VARCHAR(32) NOT NULL,
         sensor_subtype VARCHAR(80) NOT NULL,
         value NUMERIC(12, 3) NOT NULL,
         topic TEXT NULL,
         timestamp TIMESTAMPTZ NOT NULL,
         metadata JSONB NULL,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('public_sensor_readings table');
  }

  if (
    await ensureTable(
      'notification_log',
      `CREATE TABLE IF NOT EXISTS notification_log (
         id BIGSERIAL PRIMARY KEY,
         notification_type VARCHAR(80) NOT NULL,
         channel VARCHAR(32) NOT NULL DEFAULT 'email',
         recipient TEXT NULL,
         metadata JSONB NULL,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('notification_log table');
  }

  if (
    await ensureTable(
      'runtime_config',
      `CREATE TABLE IF NOT EXISTS runtime_config (
         config_key VARCHAR(120) PRIMARY KEY,
         config_value TEXT NULL,
         is_secret BOOLEAN NOT NULL DEFAULT FALSE,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('runtime_config table');
  }

  if (
    await ensureTable(
      'password_resets',
      `CREATE TABLE IF NOT EXISTS password_resets (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         token_hash VARCHAR(64) NOT NULL,
         expires_at TIMESTAMPTZ NOT NULL,
         used BOOLEAN NOT NULL DEFAULT FALSE,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('password_resets table');
  }

  if (
    await ensureTable(
      'analytics_events',
      // RAYAT FIX - analytics followup
      `CREATE TABLE IF NOT EXISTS analytics_events (
         id BIGSERIAL PRIMARY KEY,
         anonymous_id_hash VARCHAR(64),
         event_type VARCHAR(32) NOT NULL,
         event_name VARCHAR(120),
         page_path TEXT,
         referrer_host VARCHAR(120),
         device_type VARCHAR(16),
         country_code VARCHAR(8),
         city_name VARCHAR(120),
         button_name VARCHAR(120),
         occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    )
  ) {
    changes.push('analytics_events table');
  }

  if (
    await ensureTable(
      'sensor_models',
      `CREATE TABLE IF NOT EXISTS sensor_models (
         id SERIAL PRIMARY KEY,
         slug VARCHAR(120) NOT NULL,
         version VARCHAR(40) NOT NULL DEFAULT '1',
         name TEXT NOT NULL,
         manufacturer TEXT NULL,
         primary_type VARCHAR(32) NOT NULL,
         labels JSONB NOT NULL DEFAULT '{}'::jsonb,
         parameters JSONB NOT NULL,
         notes TEXT NULL,
         active BOOLEAN NOT NULL DEFAULT TRUE,
         created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         UNIQUE (slug, version)
       )`
    )
  ) {
    changes.push('sensor_models table');
  }

  if (
    await ensureTable(
      'crop_profiles',
      `CREATE TABLE IF NOT EXISTS crop_profiles (
         id SERIAL PRIMARY KEY,
         slug VARCHAR(120) NOT NULL,
         version VARCHAR(40) NOT NULL DEFAULT '1',
         crop_key VARCHAR(120) NOT NULL,
         medium VARCHAR(120) NULL,
         labels JSONB NOT NULL,
         description JSONB NOT NULL DEFAULT '{}'::jsonb,
         ranges JSONB NOT NULL,
         active BOOLEAN NOT NULL DEFAULT TRUE,
         created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
         UNIQUE (slug, version)
       )`
    )
  ) {
    changes.push('crop_profiles table');
  }
}

async function ensurePlatformSchema() {
  const changes = [];

  await ensureCoreTables(changes);

  if (await ensureColumnNullable('devices', 'user_id')) {
    changes.push('devices.user_id nullable');
  }

  if (await ensureColumn('users', 'client_code', 'VARCHAR(20)')) {
    changes.push('users.client_code');
  }
  // RAYAT FIX - registration/admin
  if (await ensureColumn('users', 'last_name', 'TEXT')) {
    changes.push('users.last_name');
  }
  if (await ensureColumn('users', 'crop_type', 'TEXT')) {
    changes.push('users.crop_type');
  }
  if (await ensureColumn('users', 'payment_status', "VARCHAR(20) DEFAULT 'non_pagato'")) {
    changes.push('users.payment_status');
  }
  if (await ensureColumn('users', 'payment_date', 'TIMESTAMPTZ')) {
    changes.push('users.payment_date');
  }
  if (await ensureColumn('users', 'subscription_expiry', 'TIMESTAMPTZ')) {
    changes.push('users.subscription_expiry');
  }
  if (await ensureColumn('users', 'registration_status', "VARCHAR(20) NOT NULL DEFAULT 'active'")) {
    changes.push('users.registration_status');
  }
  if (await ensureColumn('users', 'registration_source', "VARCHAR(20) NOT NULL DEFAULT 'legacy'")) {
    changes.push('users.registration_source');
  }
  if (await ensureColumn('users', 'approved_at', 'TIMESTAMPTZ')) {
    changes.push('users.approved_at');
  }
  if (await ensureColumn('users', 'location_address', 'TEXT')) {
    changes.push('users.location_address');
  }
  if (await ensureColumn('users', 'profile_phone', 'VARCHAR(50)')) {
    changes.push('users.profile_phone');
  }
  if (await ensureColumn('users', 'profile_description', 'VARCHAR(2000)')) {
    changes.push('users.profile_description');
  }
  if (await ensureColumn('users', 'profile_photo', 'VARCHAR(1048576)')) {
    changes.push('users.profile_photo');
  }
  if (await ensureColumn('users', 'profile_updated_at', 'TIMESTAMPTZ')) {
    changes.push('users.profile_updated_at');
  }
  if (await ensureColumn('users', 'owner_user_id', 'INTEGER NULL REFERENCES users(id) ON DELETE CASCADE')) {
    changes.push('users.owner_user_id');
  }
  if (await ensureColumn('users', 'customer_role', "VARCHAR(32) DEFAULT 'owner'")) {
    changes.push('users.customer_role');
  }

  await query(
    `UPDATE users
     SET client_code = LPAD(id::text, 4, '0')
     WHERE role IN ('client', 'farmer')
       AND (client_code IS NULL OR client_code = '')`
  );
  await query(
    `UPDATE users
     SET role = 'operator_admin'
     WHERE role = 'operator'`
  );
  await query(
    `UPDATE users
     SET registration_source = CASE
         WHEN role IN ('super_admin', 'operator_admin', 'admin') THEN 'admin'
         ELSE 'legacy'
       END
     WHERE registration_source IS NULL
        OR registration_source = ''`
  );
  await query(
    `UPDATE users
     SET registration_status = CASE
         WHEN role IN ('client', 'farmer') AND active = TRUE THEN 'active'
         WHEN role IN ('client', 'farmer') AND active = FALSE THEN 'new'
         ELSE 'active'
       END
     WHERE registration_status IS NULL
        OR registration_status = ''`
  );
  await query(
    `UPDATE users
     SET approved_at = created_at
     WHERE registration_status = 'active'
       AND approved_at IS NULL`
  );
  await query(
    `UPDATE users
     SET customer_role = CASE
         WHEN owner_user_id IS NULL THEN 'owner'
         ELSE 'viewer'
       END
     WHERE role IN ('client', 'farmer')
       AND (customer_role IS NULL OR customer_role = '' OR customer_role = 'owner')`
  );
  await query(
    `UPDATE users
     SET location_address = location_name
     WHERE (location_address IS NULL OR location_address = '')
       AND location_name IS NOT NULL
       AND location_name <> ''`
  );

  if (
    await ensureIndex(
      'alarm_events',
      'idx_alarm_events_active',
      'CREATE INDEX idx_alarm_events_active ON alarm_events (user_id, sensor_type, param, is_resolved)'
    )
  ) {
    changes.push('idx_alarm_events_active');
  }
  if (
    await ensureIndex(
      'alarm_events',
      'idx_alarm_events_recent',
      'CREATE INDEX idx_alarm_events_recent ON alarm_events (created_at)'
    )
  ) {
    changes.push('idx_alarm_events_recent');
  }
  if (
    await ensureIndex(
      'alarm_events',
      'idx_alarm_events_sensor',
      'CREATE INDEX idx_alarm_events_sensor ON alarm_events (sensor_id, created_at)'
    )
  ) {
    changes.push('idx_alarm_events_sensor');
  }
  if (
    await ensureIndex(
      'password_resets',
      'idx_password_resets_token_hash',
      'CREATE INDEX idx_password_resets_token_hash ON password_resets (token_hash)'
    )
  ) {
    changes.push('idx_password_resets_token_hash');
  }
  if (
    await ensureIndex(
      'analytics_events',
      'idx_analytics_events_type_occurred_at',
      'CREATE INDEX idx_analytics_events_type_occurred_at ON analytics_events (event_type, occurred_at)'
    )
  ) {
    changes.push('idx_analytics_events_type_occurred_at');
  }
  if (
    await ensureIndex(
      'analytics_events',
      'idx_analytics_events_page_path',
      'CREATE INDEX idx_analytics_events_page_path ON analytics_events (page_path)'
    )
  ) {
    changes.push('idx_analytics_events_page_path');
  }
  if (
    await ensureIndex(
      'analytics_events',
      'idx_analytics_events_anonymous_id',
      'CREATE INDEX idx_analytics_events_anonymous_id ON analytics_events (anonymous_id_hash)'
    )
  ) {
    changes.push('idx_analytics_events_anonymous_id');
  }
  if (
    await ensureIndex(
      'sensor_models',
      'idx_sensor_models_active_type',
      'CREATE INDEX idx_sensor_models_active_type ON sensor_models (active, primary_type)'
    )
  ) {
    changes.push('idx_sensor_models_active_type');
  }
  if (
    await ensureIndex(
      'sensor_models',
      'idx_sensor_models_parameters_gin',
      'CREATE INDEX idx_sensor_models_parameters_gin ON sensor_models USING GIN (parameters)'
    )
  ) {
    changes.push('idx_sensor_models_parameters_gin');
  }
  if (
    await ensureIndex(
      'crop_profiles',
      'idx_crop_profiles_active_crop',
      'CREATE INDEX idx_crop_profiles_active_crop ON crop_profiles (active, crop_key)'
    )
  ) {
    changes.push('idx_crop_profiles_active_crop');
  }
  if (
    await ensureIndex(
      'crop_profiles',
      'idx_crop_profiles_ranges_gin',
      'CREATE INDEX idx_crop_profiles_ranges_gin ON crop_profiles USING GIN (ranges)'
    )
  ) {
    changes.push('idx_crop_profiles_ranges_gin');
  }
  if (
    await ensureIndex(
      'users',
      'idx_users_role_active_created',
      'CREATE INDEX idx_users_role_active_created ON users (role, active, created_at)'
    )
  ) {
    changes.push('idx_users_role_active_created');
  }
  if (
    await ensureIndex(
      'users',
      'idx_users_owner_user_id',
      'CREATE INDEX idx_users_owner_user_id ON users (owner_user_id)'
    )
  ) {
    changes.push('idx_users_owner_user_id');
  }
  if (
    await ensureIndex(
      'users',
      'idx_users_client_code',
      'CREATE INDEX idx_users_client_code ON users (client_code)'
    )
  ) {
    changes.push('idx_users_client_code');
  }
  if (
    await ensureIndex(
      'users',
      'idx_users_registration_feed',
      'CREATE INDEX idx_users_registration_feed ON users (registration_source, registration_status, created_at)'
    )
  ) {
    changes.push('idx_users_registration_feed');
  }
  if (
    await ensureIndex(
      'users',
      'idx_users_location_name',
      'CREATE INDEX idx_users_location_name ON users (location_name)'
    )
  ) {
    changes.push('idx_users_location_name');
  }
  if (
    await ensureIndex(
      'devices',
      'idx_devices_user_status_last_seen',
      'CREATE INDEX idx_devices_user_status_last_seen ON devices (user_id, status, last_seen)'
    )
  ) {
    changes.push('idx_devices_user_status_last_seen');
  }
  if (
    await ensureIndex(
      'devices',
      'idx_devices_last_seen',
      'CREATE INDEX idx_devices_last_seen ON devices (last_seen)'
    )
  ) {
    changes.push('idx_devices_last_seen');
  }
  if (
    await ensureIndex(
      'sensors',
      'idx_sensors_device_enabled_type',
      'CREATE INDEX idx_sensors_device_enabled_type ON sensors (device_id, enabled, type)'
    )
  ) {
    changes.push('idx_sensors_device_enabled_type');
  }
  if (
    await ensureIndex(
      'sensor_latest',
      'idx_sensor_latest_timestamp',
      'CREATE INDEX idx_sensor_latest_timestamp ON sensor_latest (timestamp)'
    )
  ) {
    changes.push('idx_sensor_latest_timestamp');
  }

  if (
    await ensureIndex(
      'public_sensor_latest',
      'idx_public_sensor_latest_timestamp',
      'CREATE INDEX idx_public_sensor_latest_timestamp ON public_sensor_latest (timestamp)'
    )
  ) {
    changes.push('idx_public_sensor_latest_timestamp');
  }
  if (
    await ensureIndex(
      'public_sensor_readings',
      'idx_public_sensor_readings_type_timestamp',
      'CREATE INDEX idx_public_sensor_readings_type_timestamp ON public_sensor_readings (sensor_type, timestamp)'
    )
  ) {
    changes.push('idx_public_sensor_readings_type_timestamp');
  }
  if (
    await ensureIndex(
      'public_sensor_readings',
      'idx_public_sensor_readings_subtype_timestamp',
      'CREATE INDEX idx_public_sensor_readings_subtype_timestamp ON public_sensor_readings (sensor_subtype, timestamp)'
    )
  ) {
    changes.push('idx_public_sensor_readings_subtype_timestamp');
  }
  if (
    await ensureIndex(
      'notification_log',
      'idx_notification_log_type_channel_created_at',
      'CREATE INDEX idx_notification_log_type_channel_created_at ON notification_log (notification_type, channel, created_at)'
    )
  ) {
    changes.push('idx_notification_log_type_channel_created_at');
  }

  return changes;
}

module.exports = {
  ensurePlatformSchema
};
