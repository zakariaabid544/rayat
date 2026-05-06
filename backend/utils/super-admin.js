const bcrypt = require('bcrypt');

const { query } = require('../config/database');

const PLACEHOLDER_PASSWORDS = new Set([
  '',
  'CHANGEME',
  'CHANGE_ME',
  'CHANGE_THIS_PASSWORD',
  'CHANGE_ME_TO_A_STRONG_ADMIN_PASSWORD'
]);

function getConfiguredSuperAdminEmail(env = process.env) {
  return String(env.ADMIN_DEFAULT_EMAIL || '').trim().toLowerCase();
}

function getConfiguredSuperAdminPassword(env = process.env) {
  return String(env.ADMIN_DEFAULT_PASSWORD || '').trim();
}

function isPlaceholderAdminPassword(password) {
  const normalized = String(password || '').trim();
  return !normalized || PLACEHOLDER_PASSWORDS.has(normalized.toUpperCase());
}

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function doesPasswordMatch(password, passwordHash, bcryptImpl) {
  if (!passwordHash) {
    return false;
  }

  try {
    return await bcryptImpl.compare(password, passwordHash);
  } catch (_error) {
    return false;
  }
}

async function ensureSuperAdmin(options = {}) {
  const env = options.env || process.env;
  const executor = options.query || query;
  const bcryptImpl = options.bcrypt || bcrypt;
  const email = getConfiguredSuperAdminEmail(env);
  const password = getConfiguredSuperAdminPassword(env);

  if (!email) {
    console.warn('Super admin bootstrap skipped: ADMIN_DEFAULT_EMAIL is not configured.');
    return {
      status: 'skipped',
      reason: 'missing_email'
    };
  }

  if (isPlaceholderAdminPassword(password)) {
    console.warn(
      'Super admin bootstrap skipped: ADMIN_DEFAULT_PASSWORD is missing or still a placeholder.'
    );
    return {
      status: 'skipped',
      reason: 'unsafe_password',
      email
    };
  }

  const existingUser = await executor(
    `SELECT id, email, password_hash, role, active, is_verified
     FROM users
     WHERE LOWER(email) = ?
     LIMIT 1`,
    [email]
  );

  if (existingUser.length > 0) {
    const user = existingUser[0];
    const passwordMatches = await doesPasswordMatch(password, user.password_hash, bcryptImpl);
    const changed = user.role !== 'super_admin'
      || !isTruthy(user.active)
      || !isTruthy(user.is_verified)
      || !passwordMatches;

    if (!changed) {
      console.log('Super admin account already matches ADMIN_DEFAULT_EMAIL.');
      return {
        status: 'existing',
        id: user.id,
        email: user.email || email
      };
    }

    const setClauses = [
      "role = 'super_admin'",
      'active = TRUE',
      'is_verified = TRUE'
    ];
    const params = [];

    if (!passwordMatches) {
      const passwordHash = await bcryptImpl.hash(password, 12);
      setClauses.push('password_hash = ?');
      params.push(passwordHash);
    }
    params.push(user.id);

    await executor(
      `UPDATE users
       SET ${setClauses.join(', ')},
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      params
    );

    console.log('Super admin account ensured from ADMIN_DEFAULT_EMAIL.');
    return {
      status: 'updated',
      id: user.id,
      email: user.email || email
    };
  }

  const passwordHash = await bcryptImpl.hash(password, 12);
  const result = await executor(
    `INSERT INTO users (email, password_hash, name, role, is_verified, active)
     VALUES (?, ?, ?, 'super_admin', TRUE, TRUE)`,
    [email, passwordHash, 'Super Admin']
  );

  console.log('Super admin account created from ADMIN_DEFAULT_EMAIL.');
  return {
    status: 'created',
    id: result.insertId || result.rows?.[0]?.id || null,
    email
  };
}

module.exports = {
  ensureSuperAdmin,
  getConfiguredSuperAdminEmail,
  isPlaceholderAdminPassword
};
