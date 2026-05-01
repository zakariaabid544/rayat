#!/usr/bin/env node

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

const alertLastUpdate = new Date('2026-05-01T10:00:00.000Z');
const recoveredAt = new Date('2026-05-01T11:00:00.000Z');
const recoveryRows = [];
const activeLocks = new Set();
let sentEmails = 0;

const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  async sendMail(message) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    sentEmails += 1;
    assert.equal(message.to, 'ops@example.com');
    assert.match(message.subject, /Sistema tornato online/);
  }
});

const databasePath = path.resolve(__dirname, '../config/database.js');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {
    async query(sql, params = []) {
      if (/pg_try_advisory_lock/i.test(sql)) {
        const key = params[0];
        if (activeLocks.has(key)) {
          return [{ acquired: false }];
        }
        activeLocks.add(key);
        return [{ acquired: true }];
      }

      if (/pg_advisory_unlock/i.test(sql)) {
        activeLocks.delete(params[0]);
        return [{ released: true }];
      }

      if (/metadata->>'alertLastUpdate'/i.test(sql)) {
        const targetAlertLastUpdate = params[1];
        const existing = recoveryRows.find((row) => row.alertLastUpdate === targetAlertLastUpdate);
        return existing ? [{ created_at: existing.createdAt }] : [];
      }

      if (/metadata->>'lastUpdate' AS last_update/i.test(sql)) {
        return [{
          last_update: alertLastUpdate.toISOString(),
          alerted_at: new Date('2026-05-01T10:45:00.000Z').toISOString()
        }];
      }

      if (/created_at AS alerted_at/i.test(sql)) {
        return [];
      }

      if (/INSERT INTO notification_log/i.test(sql)) {
        const [notificationType, recipient, metadataJson, createdAt] = params;
        const metadata = JSON.parse(metadataJson);
        if (notificationType === 'missing_sensor_data_recovered') {
          recoveryRows.push({
            recipient,
            alertLastUpdate: metadata.alertLastUpdate,
            recoveredAt: metadata.recoveredAt,
            createdAt
          });
        }
        return { insertId: recoveryRows.length, affectedRows: 1 };
      }

      if (/information_schema\.tables/i.test(sql) && /runtime_config/i.test(sql)) {
        return [{ exists: false }];
      }

      throw new Error(`Unexpected query in recovery dedupe test: ${sql}`);
    }
  }
};

async function main() {
  const { maybeSendRecoveryEmail } = require('../src/jobs/alertJob');
  const results = await Promise.all([
    maybeSendRecoveryEmail(recoveredAt, { trigger: 'test_1' }),
    maybeSendRecoveryEmail(recoveredAt, { trigger: 'test_2' }),
    maybeSendRecoveryEmail(recoveredAt, { trigger: 'test_3' })
  ]);

  assert.deepEqual(results.sort(), [false, false, true]);
  assert.equal(sentEmails, 1);
  assert.equal(recoveryRows.length, 1);

  const secondAttempt = await maybeSendRecoveryEmail(recoveredAt, { trigger: 'test_after_recorded' });
  assert.equal(secondAttempt, false);
  assert.equal(sentEmails, 1);
  assert.equal(recoveryRows.length, 1);

  console.log('ALERT_RECOVERY_DEDUPE_TEST_OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
