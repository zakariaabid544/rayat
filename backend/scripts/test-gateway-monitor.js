#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    GW002_DEFAULT_OFFLINE_MESSAGE,
    runGatewayMonitor
} = require('../utils/gateway-monitor');

const NOW = new Date('2026-06-27T10:00:00.000Z');

function minutesAgo(minutes) {
    return new Date(NOW.getTime() - minutes * 60000).toISOString();
}

function fakeExecutorFactory() {
    const calls = [];
    const executor = async (sql, params = []) => {
        calls.push({ sql, params });
        return { affectedRows: 1, rows: [] };
    };
    executor.calls = calls;
    return executor;
}

function baseDevice(deviceId, minutesWithoutData, overrides = {}) {
    const isGw2 = deviceId === 'GW-002';
    return {
        device_pk: isGw2 ? 2 : 1,
        device_id: deviceId,
        device_name: deviceId,
        customer_name: 'Rayat Test',
        customer_email: 'test@example.com',
        last_data_at: minutesAgo(minutesWithoutData),
        alerts_enabled: true,
        expected_interval_min: isGw2 ? 40 : 30,
        dashboard_offline_after_min: isGw2 ? 44 : 34,
        email_alert_after_min: isGw2 ? 48 : 38,
        cooldown_min: 60,
        recipients: '',
        custom_offline_message: isGw2 ? GW002_DEFAULT_OFFLINE_MESSAGE : '',
        ...overrides
    };
}

async function runCase(devices) {
    const emails = [];
    const summary = await runGatewayMonitor({
        now: NOW,
        devices,
        executor: fakeExecutorFactory(),
        sendEmail: async (email) => {
            emails.push(email);
        }
    });
    return { summary, emails };
}

async function main() {
    {
        const { summary, emails } = await runCase([baseDevice('GW-001', 35)]);
        assert.strictEqual(summary.by_device['GW-001'].status, 'offline', 'A: GW-001 deve essere offline in dashboard a 35 min');
        assert.strictEqual(summary.sent.offline, 0, 'A: GW-001 non deve inviare email prima di 38 min');
        assert.strictEqual(emails.length, 0, 'A: nessuna email attesa');
    }

    {
        const { summary, emails } = await runCase([baseDevice('GW-001', 39)]);
        assert.strictEqual(summary.by_device['GW-001'].status, 'alert_sent', 'B: GW-001 deve risultare offline con alert inviato a 39 min');
        assert.strictEqual(summary.sent.offline, 1, 'B: GW-001 deve inviare email a 39 min');
        assert.strictEqual(emails[0].device_id, 'GW-001', 'B: email del device corretto');
    }

    {
        const { summary, emails } = await runCase([baseDevice('GW-002', 45)]);
        assert.strictEqual(summary.by_device['GW-002'].status, 'offline', 'C: GW-002 deve essere offline in dashboard a 45 min');
        assert.strictEqual(summary.sent.offline, 0, 'C: GW-002 non deve inviare email prima di 48 min');
        assert.strictEqual(emails.length, 0, 'C: nessuna email attesa');
    }

    {
        const { summary, emails } = await runCase([baseDevice('GW-002', 49)]);
        assert.strictEqual(summary.by_device['GW-002'].status, 'alert_sent', 'D: GW-002 deve risultare offline con alert inviato a 49 min');
        assert.strictEqual(summary.sent.offline, 1, 'D: GW-002 deve inviare email a 49 min');
        assert.strictEqual(emails[0].device_id, 'GW-002', 'D: email del device corretto');
        assert.ok(emails[0].body.includes('Data logger GW-002 offline.'), 'D: deve usare il messaggio default GW-002');
        assert.ok(emails[0].body.includes('credito SIM esaurito'), 'D: messaggio GW-002 deve includere cause operative');
    }

    {
        const { summary, emails } = await runCase([
            baseDevice('GW-001', 5),
            baseDevice('GW-002', 49)
        ]);
        assert.strictEqual(summary.by_device['GW-001'].status, 'online', 'E: GW-001 deve restare online');
        assert.strictEqual(summary.by_device['GW-002'].status, 'alert_sent', 'E: GW-002 deve risultare offline con alert inviato');
        assert.strictEqual(summary.sent.offline, 1, 'E: deve partire un solo alert');
        assert.deepStrictEqual(emails.map((email) => email.device_id), ['GW-002'], 'E: deve partire alert solo per GW-002');
    }

    {
        const { summary, emails } = await runCase([
            baseDevice('GW-002', 90, {
                offline_notified: true,
                last_offline_alert_sent_at: minutesAgo(10),
                offline_since: minutesAgo(88)
            })
        ]);
        assert.strictEqual(summary.by_device['GW-002'].status, 'alert_sent', 'F: GW-002 resta in alert inviato');
        assert.strictEqual(summary.sent.offline, 0, 'F: cooldown blocca email ripetute');
        assert.strictEqual(emails.length, 0, 'F: nessuna email durante cooldown');
    }

    {
        const { summary, emails } = await runCase([
            baseDevice('GW-002', 5, {
                offline_notified: true,
                offline_since: minutesAgo(90),
                last_offline_alert_sent_at: minutesAgo(80)
            })
        ]);
        assert.strictEqual(summary.by_device['GW-002'].status, 'online', 'G: GW-002 deve tornare online');
        assert.strictEqual(summary.sent.recovery, 1, 'G: deve inviare una email di rientro');
        assert.strictEqual(emails[0].alert_type, 'recovery', 'G: email recovery attesa');

        const second = await runCase([
            baseDevice('GW-002', 5, {
                offline_notified: false,
                last_recovery_sent_at: NOW.toISOString()
            })
        ]);
        assert.strictEqual(second.summary.sent.recovery, 0, 'G: nessuna seconda email recovery se lo stato e gia ripulito');
        assert.strictEqual(second.emails.length, 0, 'G: nessuna seconda email');
    }

    console.log('gateway-monitor tests passed: A, B, C, D, E, F, G');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
