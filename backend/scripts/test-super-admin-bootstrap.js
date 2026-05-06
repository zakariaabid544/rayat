const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const {
  ensureSuperAdmin,
  isPlaceholderAdminPassword
} = require('../utils/super-admin');

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function createMockDatabase(initialUsers = []) {
  let nextUserId = Math.max(0, ...initialUsers.map((user) => Number(user.id) || 0)) + 1;
  const state = {
    users: initialUsers.map((user) => ({ ...user })),
    updates: 0,
    inserts: 0
  };

  async function query(sql, params = []) {
    const text = normalizeSql(sql);

    if (
      text === 'SELECT id, email, password_hash, role, active, is_verified FROM users WHERE LOWER(email) = ? LIMIT 1'
    ) {
      const email = String(params[0] || '').toLowerCase();
      return state.users.filter((user) => String(user.email || '').toLowerCase() === email);
    }

    if (
      text === "INSERT INTO users (email, password_hash, name, role, is_verified, active) VALUES (?, ?, ?, 'super_admin', TRUE, TRUE)"
    ) {
      const row = {
        id: nextUserId++,
        email: params[0],
        password_hash: params[1],
        name: params[2],
        role: 'super_admin',
        is_verified: true,
        active: true,
        updated_at: null
      };
      state.users.push(row);
      state.inserts += 1;
      return { insertId: row.id, affectedRows: 1, rows: [{ id: row.id }] };
    }

    if (text.startsWith('UPDATE users SET ') && text.endsWith('WHERE id = ?')) {
      const id = Number(params[params.length - 1]);
      const user = state.users.find((row) => Number(row.id) === id);
      assert.ok(user, `Expected user ${id} to exist`);

      if (text.includes("role = 'super_admin'")) {
        user.role = 'super_admin';
      }
      if (text.includes('active = TRUE')) {
        user.active = true;
      }
      if (text.includes('is_verified = TRUE')) {
        user.is_verified = true;
      }
      if (text.includes('password_hash = ?')) {
        user.password_hash = params[0];
      }
      user.updated_at = '2026-05-06T00:00:00.000Z';
      state.updates += 1;
      return { affectedRows: 1, rows: [] };
    }

    throw new Error(`Unhandled SQL in super admin bootstrap test: ${text}`);
  }

  return { state, query };
}

async function hashPassword(password) {
  return bcrypt.hash(password, 4);
}

async function run() {
  assert.equal(isPlaceholderAdminPassword(''), true);
  assert.equal(isPlaceholderAdminPassword('CHANGE_ME'), true);
  assert.equal(isPlaceholderAdminPassword('changeme'), true);
  assert.equal(isPlaceholderAdminPassword('safe-admin-password'), false);

  {
    const oldHash = await hashPassword('old-password');
    const db = createMockDatabase([
      {
        id: 1,
        email: 'configured@example.com',
        password_hash: oldHash,
        role: 'super_admin',
        active: false,
        is_verified: false
      }
    ]);

    const result = await ensureSuperAdmin({
      env: {
        ADMIN_DEFAULT_EMAIL: 'configured@example.com',
        ADMIN_DEFAULT_PASSWORD: 'new-safe-password'
      },
      query: db.query
    });

    const user = db.state.users[0];
    assert.equal(result.status, 'updated');
    assert.equal(user.role, 'super_admin');
    assert.equal(user.active, true);
    assert.equal(user.is_verified, true);
    assert.equal(await bcrypt.compare('new-safe-password', user.password_hash), true);
  }

  {
    const oldHash = await hashPassword('old-password');
    const db = createMockDatabase([
      {
        id: 1,
        email: 'configured@example.com',
        password_hash: oldHash,
        role: 'client',
        active: true,
        is_verified: true
      }
    ]);

    const result = await ensureSuperAdmin({
      env: {
        ADMIN_DEFAULT_EMAIL: 'Configured@Example.com',
        ADMIN_DEFAULT_PASSWORD: 'new-safe-password'
      },
      query: db.query
    });

    const user = db.state.users[0];
    assert.equal(result.status, 'updated');
    assert.equal(user.role, 'super_admin');
    assert.equal(user.active, true);
    assert.equal(user.is_verified, true);
    assert.equal(await bcrypt.compare('new-safe-password', user.password_hash), true);
  }

  {
    const db = createMockDatabase([
      {
        id: 1,
        email: 'other-admin@example.com',
        password_hash: await hashPassword('other-password'),
        role: 'admin',
        active: true,
        is_verified: true
      }
    ]);

    const env = {
      ADMIN_DEFAULT_EMAIL: 'configured@example.com',
      ADMIN_DEFAULT_PASSWORD: 'configured-safe-password'
    };

    const created = await ensureSuperAdmin({ env, query: db.query });
    const target = db.state.users.find((user) => user.email === 'configured@example.com');
    assert.equal(created.status, 'created');
    assert.ok(target);
    assert.equal(target.role, 'super_admin');
    assert.equal(target.active, true);
    assert.equal(target.is_verified, true);
    assert.equal(await bcrypt.compare('configured-safe-password', target.password_hash), true);
    assert.equal(db.state.users.length, 2);

    const hashAfterCreate = target.password_hash;
    const existing = await ensureSuperAdmin({ env, query: db.query });
    assert.equal(existing.status, 'existing');
    assert.equal(db.state.users.length, 2);
    assert.equal(target.password_hash, hashAfterCreate);
    assert.equal(db.state.updates, 0);
  }

  {
    const oldHash = await hashPassword('do-not-change');
    const db = createMockDatabase([
      {
        id: 1,
        email: 'configured@example.com',
        password_hash: oldHash,
        role: 'client',
        active: false,
        is_verified: false
      }
    ]);

    const result = await ensureSuperAdmin({
      env: {
        ADMIN_DEFAULT_EMAIL: 'configured@example.com',
        ADMIN_DEFAULT_PASSWORD: 'CHANGE_ME'
      },
      query: db.query
    });

    const user = db.state.users[0];
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'unsafe_password');
    assert.equal(user.password_hash, oldHash);
    assert.equal(user.role, 'client');
    assert.equal(user.active, false);
    assert.equal(user.is_verified, false);
    assert.equal(db.state.updates, 0);
    assert.equal(db.state.inserts, 0);
  }

  console.log('SUPER_ADMIN_BOOTSTRAP_TEST_OK');
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
