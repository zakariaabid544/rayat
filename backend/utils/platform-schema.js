const {
  query,
  getTableColumns,
  getTableIndexes,
  clearSchemaCache
} = require('../config/database');

async function tableExists(tableName) {
  const rows = await query(
    `SELECT 1
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
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
         id INT PRIMARY KEY AUTO_INCREMENT,
         email VARCHAR(255) UNIQUE NULL,
         password_hash VARCHAR(255) NOT NULL,
         name VARCHAR(100),
         language VARCHAR(5) DEFAULT 'it',
         phone VARCHAR(20),
         crop_type VARCHAR(100),
         latitude DECIMAL(10, 7),
         longitude DECIMAL(10, 7),
         location_name VARCHAR(255),
         location_address VARCHAR(255),
         verification_code VARCHAR(10),
         is_verified BOOLEAN DEFAULT FALSE,
         role ENUM('admin', 'farmer', 'client', 'super_admin', 'operator', 'operator_admin') DEFAULT 'client',
         client_code VARCHAR(20),
         payment_status ENUM('pagato','non_pagato') DEFAULT 'non_pagato',
         payment_date DATETIME NULL,
         subscription_expiry DATETIME NULL,
         registration_status ENUM('new','active') NOT NULL DEFAULT 'active',
         registration_source VARCHAR(20) NOT NULL DEFAULT 'legacy',
         approved_at DATETIME NULL,
         active BOOLEAN DEFAULT TRUE,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         INDEX idx_email (email),
         INDEX idx_role (role),
         INDEX idx_users_role_active_created (role, active, created_at),
         INDEX idx_users_client_code (client_code),
         INDEX idx_users_location_name (location_name),
         INDEX idx_users_registration_feed (registration_source, registration_status, created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  ) {
    changes.push('users table');
  }

  if (
    await ensureTable(
      'devices',
      `CREATE TABLE IF NOT EXISTS devices (
         id INT PRIMARY KEY AUTO_INCREMENT,
         device_id VARCHAR(100) UNIQUE NOT NULL,
         user_id INT NOT NULL,
         name VARCHAR(100),
         api_key VARCHAR(255) NOT NULL,
         location VARCHAR(255),
         status ENUM('active', 'inactive', 'error') DEFAULT 'active',
         last_seen TIMESTAMP NULL,
         metadata JSON,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
         INDEX idx_device_id (device_id),
         INDEX idx_user_id (user_id),
         INDEX idx_status (status),
         INDEX idx_devices_user_status_last_seen (user_id, status, last_seen),
         INDEX idx_devices_last_seen (last_seen)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  ) {
    changes.push('devices table');
  }

  if (
    await ensureTable(
      'sensors',
      `CREATE TABLE IF NOT EXISTS sensors (
         id INT PRIMARY KEY AUTO_INCREMENT,
         device_id INT NOT NULL,
         type ENUM('energia', 'acqua', 'terreno', 'clima') NOT NULL,
         subtype VARCHAR(50),
         name VARCHAR(100),
         unit VARCHAR(20),
         calibration_offset DECIMAL(10, 4) DEFAULT 0,
         enabled BOOLEAN DEFAULT TRUE,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
         INDEX idx_device_type (device_id, type),
         INDEX idx_enabled (enabled),
         INDEX idx_sensors_device_enabled_type (device_id, enabled, type)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  ) {
    changes.push('sensors table');
  }

  if (
    await ensureTable(
      'sensor_readings',
      `CREATE TABLE IF NOT EXISTS sensor_readings (
         id BIGINT PRIMARY KEY AUTO_INCREMENT,
         sensor_id INT NOT NULL,
         value DECIMAL(10, 2) NOT NULL,
         timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         metadata JSON,
         FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE CASCADE,
         INDEX idx_sensor_time (sensor_id, timestamp DESC),
         INDEX idx_timestamp (timestamp)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  ) {
    changes.push('sensor_readings table');
  }

  if (
    await ensureTable(
      'alert_thresholds',
      `CREATE TABLE IF NOT EXISTS alert_thresholds (
         id INT PRIMARY KEY AUTO_INCREMENT,
         user_id INT NOT NULL,
         sensor_type VARCHAR(50) NOT NULL,
         threshold_type ENUM('min', 'max') NOT NULL,
         threshold_value DECIMAL(10, 2) NOT NULL,
         enabled BOOLEAN DEFAULT TRUE,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
         INDEX idx_user_sensor (user_id, sensor_type),
         INDEX idx_enabled (enabled)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  ) {
    changes.push('alert_thresholds table');
  }

  if (
    await ensureTable(
      'active_alerts',
      `CREATE TABLE IF NOT EXISTS active_alerts (
         id INT PRIMARY KEY AUTO_INCREMENT,
         user_id INT NOT NULL,
         sensor_id INT NOT NULL,
         alert_type ENUM('warning', 'critical') NOT NULL,
         message VARCHAR(255),
         reading_value DECIMAL(10, 2),
         threshold_value DECIMAL(10, 2),
         acknowledged BOOLEAN DEFAULT FALSE,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         acknowledged_at TIMESTAMP NULL,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
         FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE CASCADE,
         INDEX idx_user_unack (user_id, acknowledged),
         INDEX idx_created (created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  ) {
    changes.push('active_alerts table');
  }

  if (
    await ensureTable(
      'alarm_events',
      `CREATE TABLE IF NOT EXISTS alarm_events (
         id INT PRIMARY KEY AUTO_INCREMENT,
         user_id INT NOT NULL,
         sensor_id INT NULL,
         sensor_type VARCHAR(50) NOT NULL,
         sensor_subtype VARCHAR(80) NULL,
         param VARCHAR(80) NOT NULL,
         crop VARCHAR(120) NULL,
         level ENUM('attention', 'alert') NOT NULL,
         priority ENUM('medium', 'high') NOT NULL DEFAULT 'medium',
         value DECIMAL(12, 3) NOT NULL,
         optimal_min DECIMAL(12, 3) NULL,
         optimal_max DECIMAL(12, 3) NULL,
         first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         last_notified_at DATETIME NULL,
         notification_count INT NOT NULL DEFAULT 0,
         is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
         resolved_at DATETIME NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
         FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE SET NULL,
         INDEX idx_alarm_events_active (user_id, sensor_type, param, is_resolved),
         INDEX idx_alarm_events_recent (created_at),
         INDEX idx_alarm_events_sensor (sensor_id, created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  ) {
    changes.push('alarm_events table');
  }

  if (
    await ensureTable(
      'sensor_latest',
      `CREATE TABLE IF NOT EXISTS sensor_latest (
         sensor_id INT PRIMARY KEY,
         value DECIMAL(10, 2) NOT NULL,
         timestamp TIMESTAMP NOT NULL,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
         FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE CASCADE,
         INDEX idx_sensor_latest_timestamp (timestamp)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  ) {
    changes.push('sensor_latest table');
  }

  if (
    await ensureTable(
      'password_resets',
      `CREATE TABLE IF NOT EXISTS password_resets (
         id INT PRIMARY KEY AUTO_INCREMENT,
         user_id INT NOT NULL,
         token_hash VARCHAR(64) NOT NULL,
         expires_at DATETIME NOT NULL,
         used BOOLEAN NOT NULL DEFAULT FALSE,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
         INDEX idx_password_resets_token_hash (token_hash)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  ) {
    changes.push('password_resets table');
  }
}

async function ensurePlatformSchema() {
  const changes = [];

  await ensureCoreTables(changes);

  try {
    await query(
      `ALTER TABLE users
       MODIFY COLUMN email VARCHAR(255) NULL`
    );
    changes.push('users.email nullable');
  } catch (error) {
    console.warn('Schema warning (users.email nullable):', error.message);
  }

  try {
    await query(
      `ALTER TABLE users
       MODIFY COLUMN role ENUM('admin', 'farmer', 'client', 'super_admin', 'operator', 'operator_admin')
       NOT NULL DEFAULT 'client'`
    );
    changes.push('users.role extended');
  } catch (error) {
    console.warn('Schema warning (users.role enum):', error.message);
  }

  if (await ensureColumn('users', 'client_code', "VARCHAR(20) NULL AFTER role")) {
    changes.push('users.client_code');
  }
  if (
    await ensureColumn(
      'users',
      'payment_status',
      "ENUM('pagato','non_pagato') DEFAULT 'non_pagato' AFTER client_code"
    )
  ) {
    changes.push('users.payment_status');
  }
  if (await ensureColumn('users', 'payment_date', 'DATETIME NULL AFTER payment_status')) {
    changes.push('users.payment_date');
  }
  if (
    await ensureColumn(
      'users',
      'subscription_expiry',
      'DATETIME NULL AFTER payment_date'
    )
  ) {
    changes.push('users.subscription_expiry');
  }
  if (
    await ensureColumn(
      'users',
      'registration_status',
      "ENUM('new','active') NOT NULL DEFAULT 'active' AFTER subscription_expiry"
    )
  ) {
    changes.push('users.registration_status');
  }
  if (
    await ensureColumn(
      'users',
      'registration_source',
      "VARCHAR(20) NOT NULL DEFAULT 'legacy' AFTER registration_status"
    )
  ) {
    changes.push('users.registration_source');
  }
  if (
    await ensureColumn(
      'users',
      'approved_at',
      'DATETIME NULL AFTER registration_source'
    )
  ) {
    changes.push('users.approved_at');
  }
  if (
    await ensureColumn(
      'users',
      'location_address',
      'VARCHAR(255) NULL AFTER location_name'
    )
  ) {
    changes.push('users.location_address');
  }

  await query(
    `UPDATE users
     SET client_code = LPAD(id, 4, '0')
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
         WHEN role IN ('client', 'farmer') AND active = 1 THEN 'active'
         WHEN role IN ('client', 'farmer') AND active = 0 THEN 'new'
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

  return changes;
}

module.exports = {
  ensurePlatformSchema
};
