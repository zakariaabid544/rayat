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
const { query } = require('../config/database');
const { ensurePlatformSchema } = require('../utils/platform-schema');

const DEFAULT_EMAIL = 'support@barakahperlite.com';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function seedBarakahPerliteClient() {
  const email = cleanString(process.env.BARAKAH_PERLITE_EMAIL || DEFAULT_EMAIL).toLowerCase();
  const password = cleanString(process.env.BARAKAH_PERLITE_PASSWORD);
  const shouldAssignDevice = cleanString(process.env.BARAKAH_PERLITE_ASSIGN_DEVICE).toLowerCase() === 'true';
  const deviceId = cleanString(process.env.BARAKAH_PERLITE_DEVICE_ID || 'GW-001');

  if (!email) {
    throw new Error('BARAKAH_PERLITE_EMAIL is empty');
  }

  if (!password || password.length < 12) {
    throw new Error('BARAKAH_PERLITE_PASSWORD must be set and at least 12 characters long');
  }

  await ensurePlatformSchema();

  const passwordHash = await bcrypt.hash(password, 12);
  const existingUsers = await query('SELECT id FROM users WHERE lower(email) = lower(?) LIMIT 1', [email]);
  let userId;

  if (existingUsers.length) {
    userId = existingUsers[0].id;
    await query(
      `UPDATE users
       SET password_hash = ?,
           name = COALESCE(NULLIF(name, ''), ?),
           role = 'client',
           customer_role = COALESCE(NULLIF(customer_role, ''), 'owner'),
           is_verified = TRUE,
           registration_status = 'active',
           registration_source = COALESCE(NULLIF(registration_source, ''), 'admin'),
           active = TRUE,
           approved_at = COALESCE(approved_at, NOW()),
           updated_at = NOW()
       WHERE id = ?`,
      [passwordHash, 'Barakah Perlite', userId]
    );
    console.log(`Updated Barakah Perlite client: ${email}`);
  } else {
    const insertResult = await query(
      `INSERT INTO users (
         email,
         password_hash,
         name,
         language,
         role,
         customer_role,
         client_code,
         is_verified,
         registration_status,
         registration_source,
         active,
         approved_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, 'it', 'client', 'owner', ?, TRUE, 'active', 'admin', TRUE, NOW(), NOW(), NOW())`,
      [email, passwordHash, 'Barakah Perlite', 'BARAKAH-PERLITE']
    );
    userId = insertResult.insertId || insertResult.rows?.[0]?.id;
    console.log(`Created Barakah Perlite client: ${email}`);
  }

  if (!shouldAssignDevice) {
    console.log('Device assignment skipped. Set BARAKAH_PERLITE_ASSIGN_DEVICE=true to assign GW-001.');
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
    await query(
      `UPDATE devices
       SET user_id = ?,
           status = 'active',
           name = COALESCE(NULLIF(name, ''), ?),
           metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb,
           updated_at = NOW()
       WHERE id = ?`,
      [userId, 'RAYAT Perlite Track', metadata, existingDevices[0].id]
    );
    console.log(`Assigned existing device ${deviceId} to ${email}`);
    return;
  }

  await query(
    `INSERT INTO devices (device_id, user_id, name, api_key, status, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?::jsonb, NOW(), NOW())`,
    [deviceId, userId, 'RAYAT Perlite Track', crypto.randomBytes(24).toString('hex'), metadata]
  );
  console.log(`Created and assigned device ${deviceId} to ${email}`);
}

seedBarakahPerliteClient()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Barakah Perlite client seed failed:', error.message);
    process.exit(1);
  });
