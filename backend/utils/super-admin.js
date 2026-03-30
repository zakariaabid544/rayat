const bcrypt = require('bcrypt');

const { query } = require('../config/database');

const PLACEHOLDER_PASSWORDS = new Set([
  '',
  'CHANGE_ME',
  'CHANGE_THIS_PASSWORD',
  'CHANGE_ME_TO_A_STRONG_ADMIN_PASSWORD'
]);

function getConfiguredSuperAdminEmail() {
  return String(process.env.ADMIN_DEFAULT_EMAIL || '').trim().toLowerCase();
}

function getConfiguredSuperAdminPassword() {
  return String(process.env.ADMIN_DEFAULT_PASSWORD || '').trim();
}

async function ensureSuperAdmin() {
  const email = getConfiguredSuperAdminEmail();
  const password = getConfiguredSuperAdminPassword();

  if (!email || PLACEHOLDER_PASSWORDS.has(password)) {
    console.warn(
      'Super admin bootstrap skipped: set ADMIN_DEFAULT_EMAIL and ADMIN_DEFAULT_PASSWORD.'
    );
    return {
      status: 'skipped',
      email
    };
  }

  const existingSuperAdmins = await query(
    `SELECT id, email, role
     FROM users
     WHERE role IN ('super_admin', 'admin')
     LIMIT 1`
  );

  if (existingSuperAdmins.length > 0) {
    console.log('ℹ️ Super admin already exists');
    return {
      status: 'existing',
      id: existingSuperAdmins[0].id,
      email: existingSuperAdmins[0].email
    };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existingUser = await query(
    `SELECT id, role
     FROM users
     WHERE email = ?
     LIMIT 1`,
    [email]
  );

  if (existingUser.length > 0) {
    await query(
      `UPDATE users
       SET password_hash = ?,
           role = 'super_admin',
           is_verified = TRUE,
           active = TRUE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [passwordHash, existingUser[0].id]
    );
  } else {
    await query(
      `INSERT INTO users (email, password_hash, name, role, is_verified, active)
       VALUES (?, ?, ?, 'super_admin', TRUE, TRUE)`,
      [email, passwordHash, 'Super Admin']
    );
  }

  console.log('✅ Super admin created');
  return {
    status: 'created',
    email
  };
}

module.exports = {
  ensureSuperAdmin,
  getConfiguredSuperAdminEmail
};
