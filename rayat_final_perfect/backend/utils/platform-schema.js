const {
  query,
  getTableColumns,
  getTableIndexes,
  clearSchemaCache
} = require('../config/database');

async function ensureColumn(tableName, columnName, definition) {
  const columns = await getTableColumns(tableName);
  if (columns.has(columnName)) {
    return false;
  }

  await query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  clearSchemaCache();
  return true;
}

async function ensureIndex(tableName, indexName, createSql) {
  const indexes = await getTableIndexes(tableName);
  if (indexes.has(indexName)) {
    return false;
  }

  await query(createSql);
  clearSchemaCache();
  return true;
}

async function ensurePlatformSchema() {
  const changes = [];

  try {
    const passwordResetColumns = await getTableColumns('password_resets');
    await query(
      `CREATE TABLE IF NOT EXISTS password_resets (
         id INT PRIMARY KEY AUTO_INCREMENT,
         user_id INT NOT NULL,
         token_hash VARCHAR(64) NOT NULL,
         expires_at DATETIME NOT NULL,
         used BOOLEAN NOT NULL DEFAULT FALSE,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    clearSchemaCache();
    if (!passwordResetColumns.size) {
      changes.push('password_resets table');
    }
  } catch (error) {
    console.warn('Schema warning (password_resets table):', error.message);
  }

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
