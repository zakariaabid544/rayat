#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const path = require('path');

process.env.NODE_ENV = 'production';
process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_PORT = '587';
process.env.SMTP_USER = 'alerts@example.com';
process.env.SMTP_PASS = 'test-password';
process.env.SMTP_FROM = 'Rayat Alerts <alerts@example.com>';
process.env.ALERT_EMAILS = 'ops@example.com';
process.env.ALERT_PRIMARY_EMAIL = 'ops@example.com';
process.env.ALERT_FALLBACK_EMAIL = 'ops@example.com';
process.env.ALERT_MISSING_DATA_THRESHOLD_MINUTES = '45';
process.env.ALERT_NOTIFICATION_COOLDOWN_MINUTES = '60';

const alertJobPath = path.resolve(__dirname, '../src/jobs/alertJob.js');
const databasePath = path.resolve(__dirname, '../config/database.js');
const nodemailer = require('nodemailer');

const LAST_UPDATE = new Date('2026-06-27T09:00:00.000Z');
let sentEmails = 0;
let notificationRows = [];
let activeLocks = new Set();
let transactionCount = 0;

nodemailer.createTransport = () => ({
  async sendMail(message) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    sentEmails += 1;
    assert.equal(message.to, 'ops@example.com');
    assert.match(message.subject, /Nessun dato ricevuto/);
  }
});

function resetState() {
  sentEmails = 0;
  notificationRows = [];
  activeLocks = new Set();
  transactionCount = 0;
}

async function mockQuery(sql, params = []) {
  if (/information_schema\.tables/i.test(sql) && /sensor_data/i.test(sql)) {
    return [{ exists: false }];
  }

  if (/information_schema\.tables/i.test(sql) && /runtime_config/i.test(sql)) {
    return [{ exists: false }];
  }

  if (/SELECT MAX\(last_update\) AS last_update/i.test(sql)) {
    return [{ last_update: LAST_UPDATE.toISOString() }];
  }

  if (/FROM notification_log/i.test(sql) && /notification_type =/i.test(sql)) {
    const notificationType = params[0];
    const lastUpdateIso = params[1] || null;
    const matches = notificationRows
      .filter((row) => row.notificationType === notificationType)
      .filter((row) => !lastUpdateIso || row.metadata.lastUpdate === lastUpdateIso)
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    return matches.length ? [{ created_at: matches[0].createdAt }] : [];
  }

  if (/pg_try_advisory_xact_lock/i.test(sql)) {
    const key = params[0];
    if (activeLocks.has(key)) {
      return [{ acquired: false }];
    }
    activeLocks.add(key);
    return [{ acquired: true, key }];
  }

  if (/INSERT INTO notification_log/i.test(sql)) {
    const [notificationType, recipient, metadataJson, createdAt] = params;
    notificationRows.push({
      notificationType,
      recipient,
      metadata: JSON.parse(metadataJson),
      createdAt
    });
    return { insertId: notificationRows.length, affectedRows: 1 };
  }

  throw new Error(`Unexpected query in offline dedupe test: ${sql}`);
}

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {
    query: mockQuery,
    async withTransaction(handler) {
      transactionCount += 1;
      const heldLocks = [];
      const connection = {
        async execute(sql, params = []) {
          const result = await mockQuery(sql, params);
          if (/pg_try_advisory_xact_lock/i.test(sql) && result?.[0]?.acquired) {
            heldLocks.push(params[0]);
          }
          return [result];
        },
        async query(sql, params = []) {
          return this.execute(sql, params);
        }
      };

      try {
        return await handler(connection);
      } finally {
        heldLocks.forEach((key) => activeLocks.delete(key));
      }
    }
  }
};

function freshAlertJob() {
  delete require.cache[alertJobPath];
  return require('../src/jobs/alertJob');
}

async function testGatewayMonitorSuppressesLegacyOfflineEmail() {
  resetState();
  process.env.GATEWAY_MONITOR_ENABLED = 'true';
  delete process.env.ALERT_LEGACY_GATEWAY_OFFLINE_EMAIL_ENABLED;

  const job = freshAlertJob();
  await job.runMissingDataAlertCheck({
    trigger: 'gateway_monitor_enabled_test',
    preloadedLastUpdate: LAST_UPDATE
  });

  assert.equal(sentEmails, 0, 'legacy offline email must be suppressed when gateway monitor is enabled');
  assert.equal(notificationRows.length, 0, 'suppressed legacy offline email must not write notification_log');
}

async function testOfflineAdvisoryLockPreventsDoubleSend() {
  resetState();
  process.env.GATEWAY_MONITOR_ENABLED = 'false';
  delete process.env.ALERT_LEGACY_GATEWAY_OFFLINE_EMAIL_ENABLED;

  const jobA = freshAlertJob();
  const jobB = freshAlertJob();

  await Promise.all([
    jobA.runMissingDataAlertCheck({ trigger: 'instance_a', preloadedLastUpdate: LAST_UPDATE }),
    jobB.runMissingDataAlertCheck({ trigger: 'instance_b', preloadedLastUpdate: LAST_UPDATE })
  ]);

  assert.equal(sentEmails, 1, 'two backend instances must produce only one offline email');
  assert.equal(notificationRows.length, 1, 'offline email must be recorded once in notification_log');
  assert.equal(notificationRows[0].notificationType, 'missing_sensor_data');
  assert.equal(notificationRows[0].metadata.lastUpdate, LAST_UPDATE.toISOString());
  assert.ok(transactionCount >= 2, 'both instances should attempt the DB advisory lock');
}

async function main() {
  await testGatewayMonitorSuppressesLegacyOfflineEmail();
  await testOfflineAdvisoryLockPreventsDoubleSend();
  console.log('ALERT_OFFLINE_DEDUPE_TEST_OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
