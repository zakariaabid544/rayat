/**
 * Creates or updates the Barakah Perlite client account.
 *
 * Required:
 *   BARAKAH_PERLITE_PASSWORD='...' npm run seed:barakah-perlite
 *
 * Optional:
 *   BARAKAH_PERLITE_EMAIL='support@barakahperlite.com'
 */
require('../config/env');

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { query, getTableColumns } = require('../config/database');
const { ensurePlatformSchema } = require('../utils/platform-schema');

const DEFAULT_EMAIL = 'support@barakahperlite.com';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasColumn(columns, columnName) {
  return columns.has(columnName);
}

function pushAssignment(assignments, params, columns, columnName, value, options = {}) {
  if (!hasColumn(columns, columnName)) {
    return;
  }

  if (options.raw) {
    assignments.push(`${columnName} = ${value}`);
    return;
  }

  if (options.coalesceBlank) {
    assignments.push(`${columnName} = COALESCE(NULLIF(${columnName}, ''), ?)`);
  } else if (options.coalesceRaw) {
    assignments.push(`${columnName} = COALESCE(${columnName}, ${options.coalesceRaw})`);
    return;
  } else {
    assignments.push(`${columnName} = ?`);
  }

  params.push(value);
}

function pushInsertValue(columns, params, tableColumns, columnName, value, options = {}) {
  if (!hasColumn(tableColumns, columnName)) {
    return;
  }

  columns.push(columnName);
  if (options.raw) {
    params.push({ raw: value });
  } else {
    params.push(value);
  }
}

function buildInsertSql(tableName, columns, values) {
  const sqlValues = values.map((value) => (value && typeof value === 'object' && value.raw ? value.raw : '?'));
  const params = values.flatMap((value) => {
    if (value && typeof value === 'object' && value.raw) {
      return Object.prototype.hasOwnProperty.call(value, 'param') ? [value.param] : [];
    }
    return [value];
  });
  return {
    sql: `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${sqlValues.join(', ')})`,
    params
  };
}

async function seedBarakahPerliteClient() {
  const email = cleanString(process.env.BARAKAH_PERLITE_EMAIL || DEFAULT_EMAIL).toLowerCase();
  const password = cleanString(process.env.BARAKAH_PERLITE_PASSWORD);
  const shouldAssignDevice = cleanString(process.env.BARAKAH_PERLITE_ASSIGN_DEVICE).toLowerCase() === 'true';
  const deviceId = cleanString(process.env.BARAKAH_PERLITE_DEVICE_ID || 'GW-002');

  if (!email) {
    throw new Error('BARAKAH_PERLITE_EMAIL is empty');
  }

  if (!password || password.length < 12) {
    throw new Error('BARAKAH_PERLITE_PASSWORD must be set and at least 12 characters long');
  }

  await ensurePlatformSchema();
  const userColumns = await getTableColumns('users');
  const deviceColumns = await getTableColumns('devices');

  const passwordHash = await bcrypt.hash(password, 12);
  const existingUsers = await query('SELECT id FROM users WHERE lower(email) = lower(?) LIMIT 1', [email]);
  let userId;

  if (existingUsers.length) {
    userId = existingUsers[0].id;
    const assignments = [];
    const params = [];

    pushAssignment(assignments, params, userColumns, 'password_hash', passwordHash);
    pushAssignment(assignments, params, userColumns, 'name', 'Barakah Perlite', { coalesceBlank: true });
    pushAssignment(assignments, params, userColumns, 'role', 'client');
    pushAssignment(assignments, params, userColumns, 'customer_role', 'owner');
    pushAssignment(assignments, params, userColumns, 'is_verified', true);
    pushAssignment(assignments, params, userColumns, 'registration_status', 'active');
    pushAssignment(assignments, params, userColumns, 'registration_source', 'admin');
    pushAssignment(assignments, params, userColumns, 'active', true);
    pushAssignment(assignments, params, userColumns, 'approved_at', null, { coalesceRaw: 'NOW()' });
    pushAssignment(assignments, params, userColumns, 'updated_at', 'NOW()', { raw: true });

    params.push(userId);
    await query(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
    console.log(`Updated Barakah Perlite client: ${email}`);
  } else {
    const columns = [];
    const values = [];

    pushInsertValue(columns, values, userColumns, 'email', email);
    pushInsertValue(columns, values, userColumns, 'password_hash', passwordHash);
    pushInsertValue(columns, values, userColumns, 'name', 'Barakah Perlite');
    pushInsertValue(columns, values, userColumns, 'language', 'it');
    pushInsertValue(columns, values, userColumns, 'role', 'client');
    pushInsertValue(columns, values, userColumns, 'customer_role', 'owner');
    pushInsertValue(columns, values, userColumns, 'client_code', 'BARAKAH-PERLITE');
    pushInsertValue(columns, values, userColumns, 'is_verified', true);
    pushInsertValue(columns, values, userColumns, 'registration_status', 'active');
    pushInsertValue(columns, values, userColumns, 'registration_source', 'admin');
    pushInsertValue(columns, values, userColumns, 'active', true);
    pushInsertValue(columns, values, userColumns, 'approved_at', 'NOW()', { raw: true });
    pushInsertValue(columns, values, userColumns, 'created_at', 'NOW()', { raw: true });
    pushInsertValue(columns, values, userColumns, 'updated_at', 'NOW()', { raw: true });

    const insert = buildInsertSql('users', columns, values);
    const insertResult = await query(insert.sql, insert.params);
    userId = insertResult.insertId || insertResult.rows?.[0]?.id;
    console.log(`Created Barakah Perlite client: ${email}`);
  }

  if (!shouldAssignDevice) {
    console.log('Device assignment skipped. Set BARAKAH_PERLITE_ASSIGN_DEVICE=true to assign GW-002.');
    return;
  }

  if (!deviceId) {
    throw new Error('BARAKAH_PERLITE_DEVICE_ID is empty');
  }

  const metadata = JSON.stringify({
    client: 'barakah_perlite',
    product: 'RAYAT Perlite Track',
    sensor_model: 'Substrate Rayat',
    expected_metrics: ['terreno_moisture', 'terreno_ec', 'terreno_temperature']
  });
  const existingDevices = await query('SELECT id FROM devices WHERE device_id = ? LIMIT 1', [deviceId]);

  if (existingDevices.length) {
    const assignments = [];
    const params = [];

    pushAssignment(assignments, params, deviceColumns, 'user_id', userId);
    pushAssignment(assignments, params, deviceColumns, 'status', 'active');
    pushAssignment(assignments, params, deviceColumns, 'name', 'RAYAT Perlite Track');
    if (hasColumn(deviceColumns, 'metadata')) {
      assignments.push("metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb");
      params.push(metadata);
    }
    pushAssignment(assignments, params, deviceColumns, 'updated_at', 'NOW()', { raw: true });

    params.push(existingDevices[0].id);
    await query(`UPDATE devices SET ${assignments.join(', ')} WHERE id = ?`, params);
    console.log(`Assigned existing device ${deviceId} to ${email}`);
    return;
  }

  const columns = [];
  const values = [];
  pushInsertValue(columns, values, deviceColumns, 'device_id', deviceId);
  pushInsertValue(columns, values, deviceColumns, 'user_id', userId);
  pushInsertValue(columns, values, deviceColumns, 'name', 'RAYAT Perlite Track');
  pushInsertValue(columns, values, deviceColumns, 'api_key', crypto.randomBytes(24).toString('hex'));
  pushInsertValue(columns, values, deviceColumns, 'status', 'active');
  if (hasColumn(deviceColumns, 'metadata')) {
    columns.push('metadata');
    values.push({ raw: '?::jsonb', param: metadata });
  }
  pushInsertValue(columns, values, deviceColumns, 'created_at', 'NOW()', { raw: true });
  pushInsertValue(columns, values, deviceColumns, 'updated_at', 'NOW()', { raw: true });

  const insert = buildInsertSql('devices', columns, values);
  await query(insert.sql, insert.params);
  console.log(`Created and assigned device ${deviceId} to ${email}`);
}

seedBarakahPerliteClient()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Barakah Perlite client seed failed:', error.message);
    process.exit(1);
  });
