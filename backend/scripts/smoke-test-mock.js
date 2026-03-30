const assert = require('assert');
const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rayat-test-secret';

const state = {
  users: [
    {
      id: 1,
      email: 'sa@rayat.ma',
      password_hash: bcrypt.hashSync('secret123', 10),
      name: 'Super Admin',
      role: 'super_admin',
      active: 1,
      client_code: null,
      payment_status: 'pagato',
      payment_date: null,
      subscription_expiry: null,
      phone: null,
      crop_type: null,
      location_name: null,
      latitude: null,
      longitude: null,
      created_at: '2026-03-22 10:00:00'
    },
    {
      id: 2,
      email: 'client@rayat.ma',
      password_hash: bcrypt.hashSync('client123', 10),
      name: 'Cliente Demo',
      role: 'client',
      active: 1,
      client_code: '0001',
      payment_status: 'pagato',
      payment_date: '2026-03-01 10:00:00',
      subscription_expiry: '2026-04-01 10:00:00',
      phone: '+212600000000',
      crop_type: 'Banana',
      location_name: 'Agadir',
      latitude: 30.4,
      longitude: -9.6,
      created_at: '2026-03-20 10:00:00'
    }
  ],
  devices: [],
  sensors: [],
  sensorReadings: [],
  sensorLatest: []
};

let nextDeviceId = 1;
let nextSensorId = 1;
let nextReadingId = 1;

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function parseInlineLimit(sql, fallbackLimit = 25, fallbackOffset = 0) {
  const match = sql.match(/LIMIT\s+(\d+)\s*,\s*(\d+)/i);
  if (!match) {
    return { offset: fallbackOffset, limit: fallbackLimit };
  }

  return {
    offset: Number(match[1]),
    limit: Number(match[2])
  };
}

function buildDeviceMetrics(device) {
  const sensors = state.sensors.filter(
    (sensor) => sensor.device_id === device.id && sensor.enabled !== false
  );
  const sensorTypes = [...new Set(sensors.map((sensor) => sensor.type))];
  const latestTimes = sensors
    .map((sensor) => state.sensorLatest.find((entry) => entry.sensor_id === sensor.id))
    .filter(Boolean)
    .map((entry) => entry.timestamp);

  return {
    sensor_count: sensors.length,
    primary_type: sensorTypes[0] || 'clima',
    sensor_types: sensorTypes.join(','),
    last_reading: latestTimes.sort().slice(-1)[0] || null
  };
}

function listClients(offset = 0, limit = 25, singleId = null) {
  return state.users
    .filter((user) => ['client', 'farmer'].includes(user.role))
    .filter((user) => (singleId ? user.id === Number(singleId) : true))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)
    .slice(offset, offset + limit)
    .map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      crop_type: user.crop_type,
      location_name: user.location_name,
      latitude: user.latitude,
      longitude: user.longitude,
      active: user.active,
      created_at: user.created_at,
      role: user.role,
      client_code: user.client_code,
      payment_status: user.payment_status,
      payment_date: user.payment_date,
      subscription_expiry: user.subscription_expiry,
      device_count: state.devices.filter((device) => device.user_id === user.id).length
    }));
}

function listDevices(offset = 0, limit = 50, userId = null) {
  return state.devices
    .filter((device) => (userId ? device.user_id === userId : true))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)
    .slice(offset, offset + limit)
    .map((device) => {
      const user = state.users.find((row) => row.id === device.user_id);
      const metrics = buildDeviceMetrics(device);
      return {
        id: device.id,
        serial_number: device.device_id,
        name: device.name,
        status: device.status,
        last_seen: device.last_seen,
        created_at: device.created_at,
        client_id: device.user_id,
        client_name: user ? user.name : null,
        client_code: user ? user.client_code : null,
        type: metrics.primary_type,
        sensor_types: metrics.sensor_types,
        sensor_count: metrics.sensor_count,
        last_reading: metrics.last_reading,
        online_status: device.last_seen ? 'online' : 'never'
      };
    });
}

function listSensors(offset = 0, limit = 50) {
  return state.sensors
    .map((sensor) => {
      const device = state.devices.find((row) => row.id === sensor.device_id);
      const user = state.users.find((row) => row.id === (device ? device.user_id : null));
      const latest = state.sensorLatest.find((row) => row.sensor_id === sensor.id);
      return {
        sensor_id: sensor.id,
        type: sensor.type,
        subtype: sensor.subtype,
        sensor_name: sensor.name,
        unit: sensor.unit,
        enabled: sensor.enabled,
        device_row_id: device ? device.id : null,
        device_id: device ? device.device_id : null,
        device_name: device ? device.name : null,
        device_status: device ? device.status : null,
        last_seen: device ? device.last_seen : null,
        client_id: user ? user.id : null,
        client_name: user ? user.name : null,
        client_code: user ? user.client_code : null,
        location_name: user ? user.location_name : null,
        latest_value: latest ? latest.value : null,
        last_reading: latest ? latest.timestamp : null,
        online_status: device && device.last_seen ? 'online' : 'never'
      };
    })
    .slice(offset, offset + limit);
}

async function fakeQuery(sql, params = []) {
  const text = normalizeSql(sql);

  if (text === 'SELECT id, email, name, role, active FROM users WHERE id = ?') {
    return state.users
      .filter((user) => user.id === Number(params[0]))
      .map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        active: user.active
      }));
  }

  if (text === 'SELECT id, role, active FROM users WHERE id = ?') {
    return state.users
      .filter((user) => user.id === Number(params[0]))
      .map((user) => ({
        id: user.id,
        role: user.role,
        active: user.active
      }));
  }

  if (text.startsWith('SELECT COUNT(*) AS total FROM users u WHERE u.role IN')) {
    return [{ total: state.users.filter((user) => ['client', 'farmer'].includes(user.role)).length }];
  }

  if (
    text.startsWith('SELECT u.id, u.name, u.email') &&
    text.includes('FROM users u') &&
    text.includes('LEFT JOIN ( SELECT user_id, COUNT(*) AS device_count')
  ) {
    if (text.includes('WHERE u.id = ?')) {
      return listClients(0, 1, params[0]);
    }

    const inlineLimit = parseInlineLimit(text);
    const limit = Number.isFinite(Number(params[params.length - 2]))
      ? Number(params[params.length - 2])
      : inlineLimit.limit;
    const offset = Number.isFinite(Number(params[params.length - 1]))
      ? Number(params[params.length - 1])
      : inlineLimit.offset;
    return listClients(offset, limit);
  }

  if (text === 'SELECT id FROM users WHERE email = ?') {
    return state.users
      .filter((user) => user.email === params[0])
      .map((user) => ({ id: user.id }));
  }

  if (text === 'SELECT * FROM users WHERE email = ?') {
    return state.users.filter((user) => user.email === params[0]);
  }

  if (text === `SELECT id FROM users WHERE id = ? AND role IN ('client', 'farmer')`) {
    return state.users
      .filter((user) => user.id === Number(params[0]) && ['client', 'farmer'].includes(user.role))
      .map((user) => ({ id: user.id }));
  }

  if (text.startsWith('SELECT COUNT(*) AS total FROM devices d')) {
    return [{ total: state.devices.length }];
  }

  if (text.startsWith('SELECT d.id, d.device_id AS serial_number')) {
    const inlineLimit = parseInlineLimit(text, 50, 0);
    const limit = Number.isFinite(Number(params[params.length - 2]))
      ? Number(params[params.length - 2])
      : inlineLimit.limit;
    const offset = Number.isFinite(Number(params[params.length - 1]))
      ? Number(params[params.length - 1])
      : inlineLimit.offset;
    return listDevices(offset, limit);
  }

  if (text.startsWith('INSERT INTO devices')) {
    const now = '2026-03-22 12:00:00';
    const row = {
      id: nextDeviceId++,
      device_id: params[0],
      user_id: params[1] ? Number(params[1]) : null,
      name: params[2],
      api_key: params[3],
      status: 'inactive',
      metadata: params[4],
      last_seen: null,
      created_at: now,
      updated_at: now
    };
    state.devices.push(row);
    return { insertId: row.id };
  }

  if (text.startsWith('INSERT INTO sensors')) {
    const row = {
      id: nextSensorId++,
      device_id: Number(params[0]),
      type: params[1],
      subtype: params[2],
      name: params[3],
      unit: params[4],
      enabled: true
    };
    state.sensors.push(row);
    return { insertId: row.id };
  }

  if (text.startsWith('SELECT COUNT(*) AS total FROM sensors s')) {
    return [{ total: state.sensors.length }];
  }

  if (text.startsWith('SELECT s.id AS sensor_id')) {
    const inlineLimit = parseInlineLimit(text, 50, 0);
    const limit = Number.isFinite(Number(params[params.length - 2]))
      ? Number(params[params.length - 2])
      : inlineLimit.limit;
    const offset = Number.isFinite(Number(params[params.length - 1]))
      ? Number(params[params.length - 1])
      : inlineLimit.offset;
    return listSensors(offset, limit);
  }

  if (text === 'SELECT id, user_id FROM devices WHERE device_id = ? AND api_key = ?') {
    return state.devices
      .filter((device) => device.device_id === params[0] && device.api_key === params[1])
      .map((device) => ({ id: device.id, user_id: device.user_id }));
  }

  if (text.startsWith(`UPDATE devices SET last_seen = NOW(), status = 'active'`)) {
    const device = state.devices.find((row) => row.id === Number(params[0]));
    if (device) {
      device.last_seen = '2026-03-22 12:10:00';
      device.status = 'active';
    }
    return { affectedRows: device ? 1 : 0 };
  }

  if (text === 'SELECT id, type, subtype FROM sensors WHERE device_id = ?') {
    return state.sensors
      .filter((sensor) => sensor.device_id === Number(params[0]))
      .map((sensor) => ({ id: sensor.id, type: sensor.type, subtype: sensor.subtype }));
  }

  if (text.startsWith('INSERT INTO sensor_readings')) {
    state.sensorReadings.push({
      id: nextReadingId++,
      sensor_id: Number(params[0]),
      value: Number(params[1]),
      timestamp: params[2],
      metadata: params[3]
    });
    return { insertId: nextReadingId - 1 };
  }

  if (text.startsWith('INSERT INTO sensor_latest')) {
    const existing = state.sensorLatest.find((row) => row.sensor_id === Number(params[0]));
    if (existing) {
      existing.value = Number(params[1]);
      existing.timestamp = params[2];
    } else {
      state.sensorLatest.push({
        sensor_id: Number(params[0]),
        value: Number(params[1]),
        timestamp: params[2]
      });
    }
    return { affectedRows: 1 };
  }

  if (text.startsWith('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')) {
    const user = state.users.find((row) => row.id === Number(params[1]));
    if (user) {
      user.password_hash = params[0];
    }
    return { affectedRows: user ? 1 : 0 };
  }

  if (text.startsWith('SELECT d.id, d.device_id, d.name, d.status')) {
    return listDevices(0, 100, Number(params[0]));
  }

  if (text === 'SELECT * FROM alert_thresholds WHERE user_id = ? AND sensor_type = ? AND enabled = TRUE') {
    return [];
  }

  throw new Error(`Unhandled SQL in smoke test: ${text}`);
}

async function run() {
  const dbPath = path.resolve(__dirname, '../config/database.js');
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      query: fakeQuery,
      getTableColumns: async (table) =>
        table === 'users'
          ? new Set([
              'id',
              'email',
              'password_hash',
              'name',
              'role',
              'active',
              'phone',
              'crop_type',
              'location_name',
              'latitude',
              'longitude',
              'client_code',
              'payment_status',
              'payment_date',
              'subscription_expiry',
              'created_at'
            ])
          : new Set(),
      withTransaction: async (handler) =>
        handler({
          execute: async (sql, params) => [await fakeQuery(sql, params)]
        })
    }
  };

  const alertsPath = path.resolve(__dirname, '../utils/alerts.js');
  require.cache[alertsPath] = {
    id: alertsPath,
    filename: alertsPath,
    loaded: true,
    exports: { checkAlerts: async () => {} }
  };

  const authRouter = require('../routes/auth');
  const adminRouter = require('../routes/admin');
  const iotRouter = require('../routes/iot');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/iot', iotRouter);

  const adminToken = jwt.sign({ id: 1, role: 'super_admin' }, process.env.JWT_SECRET);
  const clientToken = jwt.sign({ id: 2, role: 'client' }, process.env.JWT_SECRET);

  await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();

      try {
        const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'sa@rayat.ma', password: 'secret123' })
        });
        assert.equal(loginRes.status, 200);
        const loginJson = await loginRes.json();
        assert.equal(loginJson.user.role, 'super_admin');
        const decodedLoginToken = jwt.verify(loginJson.token, process.env.JWT_SECRET);
        assert.equal(decodedLoginToken.role, 'super_admin');

        const adminResetRes = await fetch(`http://127.0.0.1:${port}/api/auth/admin-reset-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${loginJson.token}`
          },
          body: JSON.stringify({ newPassword: 'newSecret123' })
        });
        assert.equal(adminResetRes.status, 200);
        const adminResetJson = await adminResetRes.json();
        assert.equal(adminResetJson.success, true);

        const reloginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'sa@rayat.ma', password: 'newSecret123' })
        });
        assert.equal(reloginRes.status, 200);
        const reloginJson = await reloginRes.json();
        assert.equal(reloginJson.user.role, 'super_admin');

        const clientsRes = await fetch(`http://127.0.0.1:${port}/api/admin/clients?page=1&pageSize=25`, {
          headers: { Authorization: `Bearer ${reloginJson.token}` }
        });
        assert.equal(clientsRes.status, 200);
        const clientsJson = await clientsRes.json();
        assert.equal(clientsJson.data.length, 1);
        assert.equal(clientsJson.data[0].client_code, '0001');

        const createDeviceRes = await fetch(`http://127.0.0.1:${port}/api/admin/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${reloginJson.token}`
          },
          body: JSON.stringify({ type: 'acqua', serial_number: 'GW-001', client_id: 2 })
        });
        assert.equal(createDeviceRes.status, 201);
        const createdDevice = await createDeviceRes.json();
        assert.ok(createdDevice.api_key);

        const devicesRes = await fetch(`http://127.0.0.1:${port}/api/admin/devices?page=1&pageSize=25`, {
          headers: { Authorization: `Bearer ${reloginJson.token}` }
        });
        assert.equal(devicesRes.status, 200);
        const devicesJson = await devicesRes.json();
        assert.equal(devicesJson.data.length, 1);
        assert.equal(devicesJson.data[0].type, 'acqua');

        const uploadRes = await fetch(`http://127.0.0.1:${port}/api/iot/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: 'GW-001',
            api_key: createdDevice.api_key,
            readings: [{ type: 'acqua', subtype: 'acqua_level', value: 14.2, unit: 'm' }]
          })
        });
        assert.equal(uploadRes.status, 200);
        const uploadJson = await uploadRes.json();
        assert.equal(uploadJson.readings_count, 1);

        const sensorsRes = await fetch(`http://127.0.0.1:${port}/api/admin/sensors?page=1&pageSize=25`, {
          headers: { Authorization: `Bearer ${reloginJson.token}` }
        });
        assert.equal(sensorsRes.status, 200);
        const sensorsJson = await sensorsRes.json();
        assert.equal(sensorsJson.data.length, 1);
        assert.equal(Number(sensorsJson.data[0].latest_value), 14.2);

        const iotDevicesRes = await fetch(`http://127.0.0.1:${port}/api/iot/devices`, {
          headers: { Authorization: `Bearer ${clientToken}` }
        });
        assert.equal(iotDevicesRes.status, 200);
        const iotDevicesJson = await iotDevicesRes.json();
        assert.equal(iotDevicesJson.data.length, 1);
        assert.equal(iotDevicesJson.data[0].sensor_count, 1);

        console.log('SMOKE_TEST_OK');
        server.close(resolve);
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
