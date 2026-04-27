const assert = require('assert');
const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rayat-test-secret';
process.env.MQTT_INGEST_TOKEN = process.env.MQTT_INGEST_TOKEN || 'rayat-test-ingest-token'; // RAYAT-FIX
process.env.SENSOR_AGGREGATION_WINDOW_SECONDS = '0.05'; // RAYAT-FIX

const state = {
  users: [
    {
      id: 1,
      email: 'sa@rayat.ma',
      password_hash: bcrypt.hashSync('secret123', 10),
      name: 'Super Admin',
      last_name: null,
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
      name: 'Cliente',
      last_name: 'Demo',
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
  sensorLatest: [],
  publicLatest: [],
  publicSensorReadings: []
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

function parseJsonObject(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return {};
  }
}

function getDeviceSensorDataLastAt(deviceRowId) {
  const sensorIds = state.sensors
    .filter((sensor) => sensor.device_id === deviceRowId && sensor.enabled !== false)
    .map((sensor) => sensor.id);

  const latestTimestamps = state.sensorLatest
    .filter((entry) => sensorIds.includes(entry.sensor_id))
    .map((entry) => entry.timestamp)
    .filter(Boolean)
    .sort((left, right) => new Date(right) - new Date(left));

  return latestTimestamps[0] || null;
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
      last_name: user.last_name || null,
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
        device_id: device.device_id,
        name: device.name,
        status: device.user_id === null ? 'unassigned' : device.status,
        last_seen: device.last_seen,
        last_seen_at: device.last_seen,
        last_seen_ip: parseJsonObject(device.metadata).last_seen_ip || parseJsonObject(device.metadata).first_seen_ip || null,
        created_at: device.created_at,
        updated_at: device.updated_at,
        metadata: parseJsonObject(device.metadata),
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
    text.startsWith('SELECT u.id, u.name,') &&
    text.includes('u.email') &&
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

  if (text === 'SELECT pg_advisory_xact_lock(hashtext(?))') {
    return [];
  }

  if (text.startsWith('SELECT COUNT(*) AS total FROM devices d')) {
    const onlyUnassigned = text.includes("(d.user_id IS NULL OR d.status = 'unassigned')");
    return [{
      total: state.devices.filter((device) => (
        !onlyUnassigned || device.user_id === null || device.status === 'unassigned'
      )).length
    }];
  }

  if (text.startsWith('SELECT d.id, d.device_id AS serial_number')) {
    const inlineLimit = parseInlineLimit(text, 50, 0);
    const limit = Number.isFinite(Number(params[params.length - 2]))
      ? Number(params[params.length - 2])
      : inlineLimit.limit;
    const offset = Number.isFinite(Number(params[params.length - 1]))
      ? Number(params[params.length - 1])
      : inlineLimit.offset;
    const onlyUnassigned = text.includes("(d.user_id IS NULL OR d.status = 'unassigned')");
    const devices = listDevices(0, Number.MAX_SAFE_INTEGER)
      .filter((device) => !onlyUnassigned || device.client_id === null || device.status === 'unassigned');
    return devices.slice(offset, offset + limit);
  }

  if (text.startsWith('INSERT INTO devices')) {
    const now = '2026-03-22 12:00:00';
    let row;

    if (params.length === 3) {
      row = {
        id: nextDeviceId++,
        device_id: params[0],
        user_id: null,
        name: null,
        api_key: params[1],
        status: 'unassigned',
        metadata: params[2],
        last_seen: null,
        created_at: now,
        updated_at: now
      };
    } else {
      const hasExplicitStatusParam = params.length >= 6;
      row = {
        id: nextDeviceId++,
        device_id: params[0],
        user_id: params[1] ? Number(params[1]) : null,
        name: params[2],
        api_key: params[3],
        status: hasExplicitStatusParam ? params[4] : 'inactive',
        metadata: hasExplicitStatusParam ? params[5] : params[4],
        last_seen: null,
        created_at: now,
        updated_at: now
      };
    }

    state.devices.push(row);
    return { insertId: row.id };
  }

  if (text === 'SELECT id, api_key FROM devices WHERE device_id = ? LIMIT 1') {
    return state.devices
      .filter((device) => device.device_id === params[0])
      .slice(0, 1)
      .map((device) => ({ id: device.id, api_key: device.api_key }));
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

  if (text === 'SELECT id FROM devices WHERE device_id = ? LIMIT 1') {
    return state.devices
      .filter((device) => device.device_id === params[0])
      .slice(0, 1)
      .map((device) => ({ id: device.id }));
  }

  if (text === 'SELECT id, user_id, device_id FROM devices WHERE device_id = ? LIMIT 1') {
    return state.devices
      .filter((device) => device.device_id === params[0])
      .slice(0, 1)
      .map((device) => ({
        id: device.id,
        user_id: device.user_id,
        device_id: device.device_id
      }));
  }

  if (text.startsWith('SELECT api_key FROM devices WHERE device_id = ? OR COALESCE(metadata->>\'clientId\'')) {
    const targetDeviceId = params[0];
    return state.devices
      .filter((device) => {
        const metadata = parseJsonObject(device.metadata);
        return device.device_id === targetDeviceId || metadata.clientId === targetDeviceId;
      })
      .sort((left, right) => (left.device_id === targetDeviceId ? -1 : 1) - (right.device_id === targetDeviceId ? -1 : 1))
      .slice(0, 1)
      .map((device) => ({ api_key: device.api_key }));
  }

  if (text.startsWith('SELECT id, user_id, device_id FROM devices WHERE device_id = ? OR COALESCE(metadata->>\'clientId\'')) {
    const targetDeviceId = params[0];
    return state.devices
      .filter((device) => {
        const metadata = parseJsonObject(device.metadata);
        return device.device_id === targetDeviceId || metadata.clientId === targetDeviceId;
      })
      .sort((left, right) => (left.device_id === targetDeviceId ? -1 : 1) - (right.device_id === targetDeviceId ? -1 : 1))
      .slice(0, 1)
      .map((device) => ({
        id: device.id,
        user_id: device.user_id,
        device_id: device.device_id
      }));
  }

  if (text.startsWith('UPDATE devices SET user_id = ?, status = ?, name = COALESCE(NULLIF(name, \'\'), ?), updated_at = NOW() WHERE id = ?')) {
    const device = state.devices.find((row) => row.id === Number(params[3]));
    if (device) {
      device.user_id = params[0] ? Number(params[0]) : null;
      device.status = params[1];
      device.name = device.name || params[2];
    }
    return { affectedRows: device ? 1 : 0 };
  }

  if (text.startsWith(`UPDATE devices SET last_seen = ?, status = 'active', metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb, updated_at = NOW() WHERE id = ?`)
    || text.startsWith(`UPDATE devices SET last_seen = ?, status = CASE WHEN user_id IS NULL THEN 'unassigned' ELSE 'active' END, metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb, updated_at = NOW() WHERE id = ?`)) {
    const device = state.devices.find((row) => row.id === Number(params[2]));
    if (device) {
      const currentMetadata = parseJsonObject(device.metadata);
      const metadataPatch = parseJsonObject(params[1]);
      device.last_seen = params[0];
      device.status = device.user_id === null ? 'unassigned' : 'active';
      device.metadata = {
        ...currentMetadata,
        ...metadataPatch
      };
      device.updated_at = params[0];
    }
    return { affectedRows: device ? 1 : 0 };
  }

  if (text.startsWith('UPDATE devices SET device_id = ?, user_id = ?, status = ?, name = COALESCE(NULLIF(name, \'\'), ?), updated_at = NOW() WHERE id = ?')) {
    const device = state.devices.find((row) => row.id === Number(params[4]));
    if (device) {
      device.device_id = params[0];
      device.user_id = params[1] ? Number(params[1]) : null;
      device.status = params[2];
      device.name = device.name || params[3];
    }
    return { affectedRows: device ? 1 : 0 };
  }

  if (text === 'SELECT id, type, subtype FROM sensors WHERE device_id = ?') {
    return state.sensors
      .filter((sensor) => sensor.device_id === Number(params[0]))
      .map((sensor) => ({ id: sensor.id, type: sensor.type, subtype: sensor.subtype }));
  }

  if (text === 'SELECT id, type FROM sensors WHERE device_id = ? ORDER BY id ASC') {
    return state.sensors
      .filter((sensor) => sensor.device_id === Number(params[0]))
      .sort((left, right) => left.id - right.id)
      .map((sensor) => ({ id: sensor.id, type: sensor.type }));
  }

  if (text === 'UPDATE sensors SET type = ?, subtype = ?, name = ?, unit = ?, updated_at = NOW() WHERE id = ?') {
    const sensor = state.sensors.find((row) => row.id === Number(params[4]));
    if (sensor) {
      sensor.type = params[0];
      sensor.subtype = params[1];
      sensor.name = params[2];
      sensor.unit = params[3];
    }
    return { affectedRows: sensor ? 1 : 0 };
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
      if (new Date(existing.timestamp) <= new Date(params[2])) { // RAYAT-FIX
        existing.value = Number(params[1]); // RAYAT-FIX
        existing.timestamp = params[2]; // RAYAT-FIX
      } // RAYAT-FIX
    } else {
      state.sensorLatest.push({
        sensor_id: Number(params[0]),
        value: Number(params[1]),
        timestamp: params[2]
      });
    }
    return { affectedRows: 1 };
  }

  if (text.startsWith('INSERT INTO public_sensor_latest')) {
    const existing = state.publicLatest.find((row) => row.sensor_subtype === params[1]);
    if (existing) {
      if (new Date(existing.timestamp) <= new Date(params[4])) { // RAYAT-FIX
        existing.sensor_type = params[0]; // RAYAT-FIX
        existing.value = Number(params[2]); // RAYAT-FIX
        existing.topic = params[3]; // RAYAT-FIX
        existing.timestamp = params[4]; // RAYAT-FIX
      } // RAYAT-FIX
    } else {
      state.publicLatest.push({
        sensor_type: params[0],
        sensor_subtype: params[1],
        value: Number(params[2]),
        topic: params[3],
        timestamp: params[4]
      });
    }
    return { affectedRows: 1 };
  }

  if (text.startsWith('INSERT INTO public_sensor_readings')) {
    state.publicSensorReadings.push({
      id: state.publicSensorReadings.length + 1,
      sensor_type: params[0],
      sensor_subtype: params[1],
      value: Number(params[2]),
      topic: params[3],
      timestamp: params[4],
      metadata: params[5]
    });
    return { insertId: state.publicSensorReadings.length };
  }

  if (text === 'SELECT sensor_subtype AS subtype, value FROM public_sensor_latest') {
    return state.publicLatest.map((row) => ({
      subtype: row.sensor_subtype,
      value: row.value
    }));
  }

  if (text.startsWith('SELECT sensor_type AS type, sensor_subtype AS subtype, value, topic, timestamp,')) {
    return state.publicLatest
      .slice()
      .sort((a, b) => {
        const typeCompare = String(a.sensor_type).localeCompare(String(b.sensor_type));
        if (typeCompare !== 0) {
          return typeCompare;
        }
        return String(a.sensor_subtype).localeCompare(String(b.sensor_subtype));
      })
      .map((row) => ({
        type: row.sensor_type,
        subtype: row.sensor_subtype,
        value: row.value,
        topic: row.topic,
        timestamp: row.timestamp,
        online_status: 'online'
      }));
  }

  if (text.startsWith('SELECT sensor_type AS type, sensor_subtype AS subtype, value, topic, timestamp FROM public_sensor_readings WHERE sensor_type = ?')) {
    let rows = state.publicSensorReadings
      .filter((row) => row.sensor_type === params[0])
      .filter((row) => new Date(row.timestamp) >= new Date(params[1]) && new Date(row.timestamp) <= new Date(params[2]));

    if (params[3]) {
      rows = rows.filter((row) => row.sensor_subtype === params[3]);
    }

    return rows
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp) || String(a.sensor_subtype).localeCompare(String(b.sensor_subtype)))
      .map((row) => ({
        type: row.sensor_type,
        subtype: row.sensor_subtype,
        value: row.value,
        topic: row.topic,
        timestamp: row.timestamp
      }));
  }

  if (text === 'SELECT MAX(timestamp) AS sensor_data_last_at FROM public_sensor_latest') {
    const lastTimestamp = state.publicLatest
      .map((row) => row.timestamp)
      .filter(Boolean)
      .sort((left, right) => new Date(right) - new Date(left))[0] || null;

    return [{ sensor_data_last_at: lastTimestamp }];
  }

  if (text.startsWith('SELECT d.id, d.device_id, d.name, d.metadata, MAX(sl.timestamp) AS sensor_data_last_at FROM devices d LEFT JOIN sensors s ON s.device_id = d.id')) {
    const scopedUserId = text.includes('WHERE d.user_id = ?') ? Number(params[0]) : null;

    return state.devices
      .filter((device) => (scopedUserId ? device.user_id === scopedUserId : true))
      .map((device) => ({
        id: device.id,
        device_id: device.device_id,
        name: device.name,
        metadata: parseJsonObject(device.metadata),
        sensor_data_last_at: getDeviceSensorDataLastAt(device.id)
      }));
  }

  if (text.startsWith('SELECT s.subtype, sr.value FROM sensor_readings sr INNER JOIN sensors s ON sr.sensor_id = s.id WHERE sr.timestamp = ( SELECT MAX(timestamp) FROM sensor_readings WHERE sensor_id = s.id )')) {
    return state.sensors
      .map((sensor) => {
        const latestReading = state.sensorReadings
          .filter((reading) => reading.sensor_id === sensor.id)
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

        if (!latestReading || sensor.enabled === false) {
          return null;
        }

        return {
          subtype: sensor.subtype,
          value: latestReading.value
        };
      })
      .filter(Boolean);
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
      getDatabaseHealth: async () => ({ db: 'ok' }), // RAYAT-FIX
      getTableColumns: async (table) =>
        table === 'users'
          ? new Set([
              'id',
              'email',
              'password_hash',
              'name',
              'last_name',
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

  const alertJobPath = path.resolve(__dirname, '../src/jobs/alertJob.js'); // RAYAT-FIX
  require.cache[alertJobPath] = { // RAYAT-FIX
    id: alertJobPath, // RAYAT-FIX
    filename: alertJobPath, // RAYAT-FIX
    loaded: true, // RAYAT-FIX
    exports: { // RAYAT-FIX
      notifyMissingDataHeartbeat: () => {}, // RAYAT-FIX
      getMissingDataAlertRuntimeStatus: async () => ({ enabled: false, runtime: 'mock' }), // RAYAT-FIX
      startMissingDataAlertJob: () => {} // RAYAT-FIX
    } // RAYAT-FIX
  }; // RAYAT-FIX

  const authRouter = require('../routes/auth');
  const adminRouter = require('../routes/admin');
  const iotRouter = require('../routes/iot');
  const simpleRouter = require('../routes/simple');
  const sensorsRouter = require('../routes/sensors');
  const { processIncomingMessage } = require('../src/jobs/mqttDirectJob');

  const app = express();
  const publicIndexPath = path.resolve(__dirname, '../../web/index.html');
  function shouldServePublicApp(req) {
    if (req.method !== 'GET') {
      return false;
    }

    if (
      req.path.startsWith('/api')
      || req.path.startsWith('/admin')
      || req.path.startsWith('/icons')
    ) {
      return false;
    }

    if (path.extname(req.path)) {
      return false;
    }

    const acceptHeader = String(req.headers.accept || '');
    return !acceptHeader || acceptHeader.includes('text/html') || acceptHeader.includes('*/*');
  }

  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/iot', iotRouter);
  app.use('/api/sensors/simple', simpleRouter);
  app.use('/api/sensors', sensorsRouter);
  app.get(['/api/health', '/health'], (_req, res) => { // RAYAT-FIX
    res.json({ status: 'ok' }); // RAYAT-FIX
  }); // RAYAT-FIX
  app.get(['/demo', '/demo/'], (_req, res) => {
    res.redirect(302, '/dashboard');
  });
  app.get(['/demo/:sensor(acqua|energia|terreno|clima)', '/demo/:sensor(acqua|energia|terreno|clima)/'], (req, res) => {
    res.redirect(302, `/dashboard/${req.params.sensor}`);
  });
  app.get('*', (req, res, next) => {
    if (!shouldServePublicApp(req)) {
      return next();
    }

    res.sendFile(publicIndexPath);
  });
  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint non trovato' });
  });

  const adminToken = jwt.sign({ id: 1, role: 'super_admin' }, process.env.JWT_SECRET);
  const clientToken = jwt.sign({ id: 2, role: 'client' }, process.env.JWT_SECRET);

  await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();

      try {
        const dashboardRes = await fetch(`http://127.0.0.1:${port}/dashboard`);
        assert.equal(dashboardRes.status, 200);
        const dashboardHtml = await dashboardRes.text();
        assert.ok(dashboardHtml.includes('<div id="app"></div>'));

        const waterDashboardRes = await fetch(`http://127.0.0.1:${port}/dashboard/acqua`);
        assert.equal(waterDashboardRes.status, 200);
        const waterDashboardHtml = await waterDashboardRes.text();
        assert.ok(waterDashboardHtml.includes('<div id="app"></div>'));

        const energyDashboardRes = await fetch(`http://127.0.0.1:${port}/dashboard/energia`);
        assert.equal(energyDashboardRes.status, 200);
        const energyDashboardHtml = await energyDashboardRes.text();
        assert.ok(energyDashboardHtml.includes('<div id="app"></div>'));

        const contactPageRes = await fetch(`http://127.0.0.1:${port}/contatti`);
        assert.equal(contactPageRes.status, 200);
        const contactPageHtml = await contactPageRes.text();
        assert.ok(contactPageHtml.includes('<div id="app"></div>'));

        const legacyDemoRes = await fetch(`http://127.0.0.1:${port}/demo`, {
          redirect: 'manual'
        });
        assert.equal(legacyDemoRes.status, 302);
        assert.equal(legacyDemoRes.headers.get('location'), '/dashboard');

        const legacySensorDemoRes = await fetch(`http://127.0.0.1:${port}/demo/acqua`, {
          redirect: 'manual'
        });
        assert.equal(legacySensorDemoRes.status, 302);
        assert.equal(legacySensorDemoRes.headers.get('location'), '/dashboard/acqua');

        const missingAssetRes = await fetch(`http://127.0.0.1:${port}/missing.js`);
        assert.equal(missingAssetRes.status, 404);

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

        const adminSessionRes = await fetch(`http://127.0.0.1:${port}/api/admin/session`, {
          headers: { Authorization: `Bearer ${reloginJson.token}` }
        });
        assert.equal(adminSessionRes.status, 200);
        const adminSessionJson = await adminSessionRes.json();
        assert.equal(adminSessionJson.user.role, 'super_admin');
        assert.ok(adminSessionJson.token);
        const adminSessionCookieHeader = adminSessionRes.headers.get('set-cookie') || '';
        assert.ok(adminSessionCookieHeader.includes('rayat_admin_session='));

        const adminLogoutRes = await fetch(`http://127.0.0.1:${port}/api/admin/logout`, {
          method: 'POST',
          headers: adminSessionCookieHeader
            ? { Cookie: adminSessionCookieHeader.split(';')[0] }
            : {}
        });
        assert.equal(adminLogoutRes.status, 200);
        const adminLogoutJson = await adminLogoutRes.json();
        assert.equal(adminLogoutJson.success, true);
        const adminLogoutCookieHeader = adminLogoutRes.headers.get('set-cookie') || '';
        assert.ok(adminLogoutCookieHeader.includes('rayat_admin_session='));
        assert.ok(/Expires=Thu, 01 Jan 1970/i.test(adminLogoutCookieHeader));

        const clientAdminLoginRes = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'client@rayat.ma', password: 'client123' })
        });
        assert.equal(clientAdminLoginRes.status, 403);
        const clientAdminLoginJson = await clientAdminLoginRes.json();
        assert.equal(clientAdminLoginJson.errorCode, 'admin_account_required');

        const clientAdminSessionRes = await fetch(`http://127.0.0.1:${port}/api/admin/session`, {
          headers: { Authorization: `Bearer ${clientToken}` }
        });
        assert.equal(clientAdminSessionRes.status, 403);
        const clientAdminSessionJson = await clientAdminSessionRes.json();
        assert.equal(clientAdminSessionJson.errorCode, 'admin_access_denied');

        const publicHealthRes = await fetch(`http://127.0.0.1:${port}/api/health`); // RAYAT-FIX
        assert.equal(publicHealthRes.status, 200); // RAYAT-FIX
        assert.deepEqual(await publicHealthRes.json(), { status: 'ok' }); // RAYAT-FIX

        const adminHealthWithoutTokenRes = await fetch(`http://127.0.0.1:${port}/api/admin/health`); // RAYAT-FIX
        assert.equal(adminHealthWithoutTokenRes.status, 401); // RAYAT-FIX

        const adminHealthRes = await fetch(`http://127.0.0.1:${port}/api/admin/health`, { // RAYAT-FIX
          headers: { Authorization: `Bearer ${reloginJson.token}` } // RAYAT-FIX
        }); // RAYAT-FIX
        assert.equal(adminHealthRes.status, 200); // RAYAT-FIX
        const adminHealthJson = await adminHealthRes.json(); // RAYAT-FIX
        assert.equal(adminHealthJson.db, 'ok'); // RAYAT-FIX
        assert.ok(adminHealthJson.mqttDirect); // RAYAT-FIX

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
            temperature: 35.1,
            humidity: 56.5,
            co2: 86,
            soilTemperature: 25.2,
            soilHumidity: 44.5,
            soilConductivity: 1270,
            nitrogen: 159,
            phosphorus: 50,
            potassium: 209,
            pH: 7.35,
            height: 91
          })
        });
        assert.equal(uploadRes.status, 200);
        const uploadJson = await uploadRes.json();
        assert.equal(uploadJson.readings_count, 10);

        const unauthorizedUpdateRes = await fetch(`http://127.0.0.1:${port}/api/sensors/update`, { // RAYAT-FIX
          method: 'POST', // RAYAT-FIX
          headers: { 'Content-Type': 'application/json' }, // RAYAT-FIX
          body: JSON.stringify({ // RAYAT-FIX
            sensor_id: 'sensors/GW-001/clima/temperature', // RAYAT-FIX
            value: 18.1 // RAYAT-FIX
          }) // RAYAT-FIX
        }); // RAYAT-FIX
        assert.equal(unauthorizedUpdateRes.status, 401); // RAYAT-FIX

        const invalidApiKeyUpdateRes = await fetch(`http://127.0.0.1:${port}/api/sensors/update`, { // RAYAT-FIX
          method: 'POST', // RAYAT-FIX
          headers: { 'Content-Type': 'application/json' }, // RAYAT-FIX
          body: JSON.stringify({ // RAYAT-FIX
            sensor_id: 'sensors/GW-001/clima/temperature', // RAYAT-FIX
            api_key: 'wrong-key' // RAYAT-FIX
          }) // RAYAT-FIX
        }); // RAYAT-FIX
        assert.equal(invalidApiKeyUpdateRes.status, 401); // RAYAT-FIX

        const bridgeUpdateRes = await fetch(`http://127.0.0.1:${port}/api/sensors/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sensor_id: 'sensors/GW-001/clima/temperature',
            device_id: 'GW-001',
            api_key: createdDevice.api_key,
            value: 29.4
          })
        });
        assert.equal(bridgeUpdateRes.status, 200);
        const bridgeUpdateJson = await bridgeUpdateRes.json();
        assert.equal(bridgeUpdateJson.readings_count, 1);

        const rawFrameTimestamp = new Date().toISOString(); // RAYAT-FIX
        const rawFrames = [
          '01030400d403357aec',
          '0203020117bdda',
          '03030e00c40180031b0069001a008a02a91b3e'
        ];

        for (const rawHex of rawFrames) {
          const rawFrameRes = await fetch(`http://127.0.0.1:${port}/api/sensors/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sensor_id: 'sensors/GW-001/telemetry',
              device_id: 'GW-001',
              api_key: createdDevice.api_key,
              timestamp: rawFrameTimestamp,
              raw_hex: rawHex,
              payload_encoding: 'modbus_rtu'
            })
          });
          assert.equal(rawFrameRes.status, 200);
        }

        const staleLatestRes = await fetch(`http://127.0.0.1:${port}/api/sensors/update`, { // RAYAT-FIX
          method: 'POST', // RAYAT-FIX
          headers: { 'Content-Type': 'application/json' }, // RAYAT-FIX
          body: JSON.stringify({ // RAYAT-FIX
            sensor_id: 'sensors/GW-001/clima/temperature', // RAYAT-FIX
            device_id: 'GW-001', // RAYAT-FIX
            api_key: createdDevice.api_key, // RAYAT-FIX
            timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // RAYAT-FIX
            value: 99.9 // RAYAT-FIX
          }) // RAYAT-FIX
        }); // RAYAT-FIX
        assert.equal(staleLatestRes.status, 200); // RAYAT-FIX

        const bootRes = await fetch(`http://127.0.0.1:${port}/api/sensors/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-rayat-bridge-token': process.env.MQTT_INGEST_TOKEN }, // RAYAT-FIX
          body: JSON.stringify({
            sensor_id: 'sensors/GW-001/status',
            event: 'boot',
            clientId: 'GW-001',
            sentAt: new Date(Date.now() - 120000).toISOString()
          })
        });
        assert.equal(bootRes.status, 200);
        const bootJson = await bootRes.json();
        assert.equal(bootJson.mode, 'gateway_signal');
        assert.equal(bootJson.readings_count, 0);

        await processIncomingMessage(
          'sensors/GW-001/status',
          Buffer.from(JSON.stringify({
            event: 'heartbeat',
            clientId: 'GW-001',
            sentAt: new Date(Date.now() - 60000).toISOString()
          }))
        );

        const publicLatestRes = await fetch(`http://127.0.0.1:${port}/api/sensors/public/latest`);
        assert.equal(publicLatestRes.status, 200);
        const publicLatestJson = await publicLatestRes.json();
        assert.equal(publicLatestJson.success, true);
        assert.equal(publicLatestJson.monitoring.routerIntervalMinutes, 30);
        assert.equal(publicLatestJson.monitoring.offlineAfterMinutes, 35);
        assert.equal(publicLatestJson.monitoring.emailAfterMinutes, 45);
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'clima_temperature'));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'clima_temperature' && Number(row.value) === 21.2));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'clima_humidity' && Number(row.value) === 82.1));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'clima_co2' && Number(row.value) === 279));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'terreno_temperature' && Number(row.value) === 19.6));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'terreno_moisture' && Number(row.value) === 38.4));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'terreno_ec' && Number(row.value) === 0.795));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'terreno_ph' && Number(row.value) === 6.81));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'terreno_n' && Number(row.value) === 105));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'terreno_p' && Number(row.value) === 26));
        assert.ok(publicLatestJson.data.some((row) => row.subtype === 'terreno_k' && Number(row.value) === 138));
        assert.ok(publicLatestJson.data.every((row) => row.online_status === 'online'));

        const publicStatusRes = await fetch(`http://127.0.0.1:${port}/api/sensors/public/status`);
        assert.equal(publicStatusRes.status, 200);
        const publicStatusJson = await publicStatusRes.json();
        assert.equal(publicStatusJson.success, true);
        assert.equal(publicStatusJson.data.deviceId, 'GW-001');
        assert.equal(publicStatusJson.data.routerOnline, true);
        assert.ok(publicStatusJson.data.lastBootAt);
        assert.ok(publicStatusJson.data.lastHeartbeatAt);
        assert.ok(new Date(publicStatusJson.data.lastHeartbeatAt).getTime() >= new Date(publicStatusJson.data.lastBootAt).getTime());
        assert.equal(publicStatusJson.monitoring.routerHeartbeatIntervalMinutes, 10);
        assert.equal(publicStatusJson.monitoring.gatewayHeartbeatWindowMinutes, 12);

        const publicHistoryRes = await fetch(`http://127.0.0.1:${port}/api/sensors/public/history?type=terreno&days=30`);
        assert.equal(publicHistoryRes.status, 200);
        const publicHistoryJson = await publicHistoryRes.json();
        assert.equal(publicHistoryJson.success, true);
        assert.ok(publicHistoryJson.data.some((row) => row.subtype === 'terreno_temperature' && Number(row.value) === 19.6));
        assert.ok(publicHistoryJson.data.some((row) => row.subtype === 'terreno_ec' && Number(row.value) === 0.795));

        const simpleLatestRes = await fetch(`http://127.0.0.1:${port}/api/sensors/simple/latest`);
        assert.equal(simpleLatestRes.status, 200);
        const simpleLatestJson = await simpleLatestRes.json();
        assert.equal(simpleLatestJson.water, null);
        assert.equal(Number(simpleLatestJson.temperature), 21.2);
        assert.equal(Number(simpleLatestJson.humidity), 82.1);
        assert.equal(Number(simpleLatestJson.co2), 279);
        assert.equal(Number(simpleLatestJson.soil), 38.4);

        const sensorsRes = await fetch(`http://127.0.0.1:${port}/api/admin/sensors?page=1&pageSize=25`, {
          headers: { Authorization: `Bearer ${reloginJson.token}` }
        });
        assert.equal(sensorsRes.status, 200);
        const sensorsJson = await sensorsRes.json();
        assert.equal(sensorsJson.data.length, 11);
        const climateSensor = sensorsJson.data.find((sensor) => sensor.subtype === 'clima_temperature');
        const soilPhosphorusSensor = sensorsJson.data.find((sensor) => sensor.subtype === 'terreno_p');
        assert.equal(Number(climateSensor.latest_value), 21.2);
        assert.equal(Number(soilPhosphorusSensor.latest_value), 26);

        const iotDevicesRes = await fetch(`http://127.0.0.1:${port}/api/iot/devices`, {
          headers: { Authorization: `Bearer ${clientToken}` }
        });
        assert.equal(iotDevicesRes.status, 200);
        const iotDevicesJson = await iotDevicesRes.json();
        assert.equal(iotDevicesJson.data.length, 1);
        assert.equal(iotDevicesJson.data[0].sensor_count, 11);

        const unknownDeviceApiKeyRes = await fetch(`http://127.0.0.1:${port}/api/sensors/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sensor_id: 'sensors/AUTO-GW-002/clima/temperature',
            device_id: 'AUTO-GW-002',
            api_key: 'wrong-key',
            value: 18.7
          })
        });
        assert.equal(unknownDeviceApiKeyRes.status, 401);

        const autoRegisterRes = await fetch(`http://127.0.0.1:${port}/api/sensors/update`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-rayat-bridge-token': process.env.MQTT_INGEST_TOKEN
          },
          body: JSON.stringify({
            sensor_id: 'sensors/AUTO-GW-002/clima/temperature',
            device_id: 'AUTO-GW-002',
            value: 23.5
          })
        });
        assert.equal(autoRegisterRes.status, 200);

        const unassignedDevicesRes = await fetch(`http://127.0.0.1:${port}/api/admin/devices?page=1&pageSize=25&status=unassigned`, {
          headers: { Authorization: `Bearer ${reloginJson.token}` }
        });
        assert.equal(unassignedDevicesRes.status, 200);
        const unassignedDevicesJson = await unassignedDevicesRes.json();
        const autoRegisteredDevice = unassignedDevicesJson.data.find((device) => device.serial_number === 'AUTO-GW-002');
        assert.ok(autoRegisteredDevice);
        assert.equal(autoRegisteredDevice.status, 'unassigned');
        assert.equal(autoRegisteredDevice.client_id, null);

        const autoRegisterAgainRes = await fetch(`http://127.0.0.1:${port}/api/sensors/update`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-rayat-bridge-token': process.env.MQTT_INGEST_TOKEN
          },
          body: JSON.stringify({
            sensor_id: 'sensors/AUTO-GW-002/clima/temperature',
            device_id: 'AUTO-GW-002',
            value: 24.1
          })
        });
        assert.equal(autoRegisterAgainRes.status, 200);

        const unassignedDevicesAgainRes = await fetch(`http://127.0.0.1:${port}/api/admin/devices?page=1&pageSize=25&status=unassigned`, {
          headers: { Authorization: `Bearer ${reloginJson.token}` }
        });
        assert.equal(unassignedDevicesAgainRes.status, 200);
        const unassignedDevicesAgainJson = await unassignedDevicesAgainRes.json();
        assert.equal(
          unassignedDevicesAgainJson.data.filter((device) => device.serial_number === 'AUTO-GW-002').length,
          1
        );

        const assignAutoDeviceRes = await fetch(`http://127.0.0.1:${port}/api/admin/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${reloginJson.token}`
          },
          body: JSON.stringify({ type: 'clima', serial_number: 'AUTO-GW-002', client_id: 2 })
        });
        assert.equal(assignAutoDeviceRes.status, 201);
        const assignAutoDeviceJson = await assignAutoDeviceRes.json();
        assert.equal(assignAutoDeviceJson.id, autoRegisteredDevice.id);

        const devicesAfterAssignRes = await fetch(`http://127.0.0.1:${port}/api/admin/devices?page=1&pageSize=25`, {
          headers: { Authorization: `Bearer ${reloginJson.token}` }
        });
        assert.equal(devicesAfterAssignRes.status, 200);
        const devicesAfterAssignJson = await devicesAfterAssignRes.json();
        const assignedAutoDevice = devicesAfterAssignJson.data.find((device) => device.serial_number === 'AUTO-GW-002');
        assert.ok(assignedAutoDevice);
        assert.equal(assignedAutoDevice.client_id, 2);
        assert.equal(assignedAutoDevice.status, 'active');

        const clientDevicesAfterAssignRes = await fetch(`http://127.0.0.1:${port}/api/iot/devices`, {
          headers: { Authorization: `Bearer ${clientToken}` }
        });
        assert.equal(clientDevicesAfterAssignRes.status, 200);
        const clientDevicesAfterAssignJson = await clientDevicesAfterAssignRes.json();
        assert.ok(clientDevicesAfterAssignJson.data.some((device) => device.device_id === 'AUTO-GW-002'));

        const aggregationStartIndex = state.publicSensorReadings.length; // RAYAT-FIX
        const aggregationTimestamp = new Date().toISOString(); // RAYAT-FIX
        const aggregationFirst = processIncomingMessage( // RAYAT-FIX
          'sensors/GW-001/clima/temperature', // RAYAT-FIX
          Buffer.from(JSON.stringify({ timestamp: aggregationTimestamp, temperature: 31.4, humidity: 52.2 })) // RAYAT-FIX
        ); // RAYAT-FIX
        assert.equal(state.publicSensorReadings.length, aggregationStartIndex); // RAYAT-FIX
        const aggregationSecond = processIncomingMessage( // RAYAT-FIX
          'sensors/GW-001/clima/co2', // RAYAT-FIX
          Buffer.from(JSON.stringify({ timestamp: new Date(new Date(aggregationTimestamp).getTime() + 60000).toISOString(), co2: 333 })) // RAYAT-FIX
        ); // RAYAT-FIX
        await Promise.all([aggregationFirst, aggregationSecond]); // RAYAT-FIX
        const aggregatedClimateRows = state.publicSensorReadings.slice(aggregationStartIndex).filter((row) => row.sensor_type === 'clima'); // RAYAT-FIX
        assert.equal(aggregatedClimateRows.length, 3); // RAYAT-FIX
        assert.equal(new Set(aggregatedClimateRows.map((row) => row.timestamp)).size, 1); // RAYAT-FIX
        assert.ok(aggregatedClimateRows.some((row) => row.sensor_subtype === 'clima_temperature' && Number(row.value) === 31.4)); // RAYAT-FIX
        assert.ok(aggregatedClimateRows.some((row) => row.sensor_subtype === 'clima_humidity' && Number(row.value) === 52.2)); // RAYAT-FIX
        assert.ok(aggregatedClimateRows.some((row) => row.sensor_subtype === 'clima_co2' && Number(row.value) === 333)); // RAYAT-FIX

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
