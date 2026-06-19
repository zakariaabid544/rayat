'use strict';

const assert = require('node:assert/strict');
const {
    resolveOwnerAccess,
    normalizeListFilters,
    isSuperAdmin
} = require('../utils/weekly-report-history');
const {
    buildWeeklyNotification,
    normalizeNotificationFilters,
    userNotificationScope
} = require('../utils/weekly-report-notifications');

function candidate(overrides = {}) {
    return {
        owner_user_id: 1,
        device_id: 10,
        context_id: 100,
        report_file_id: 500,
        report_id: 400,
        recipient_user_id: 3,
        recipient_email: 'team@example.test',
        week_start: '2026-06-15',
        week_end: '2026-06-21',
        ...overrides
    };
}

function run() {
    const owner = { id: 1, role: 'client', scopeOwnerUserId: 1 };
    const team = { id: 3, role: 'client', owner_user_id: 1, scopeOwnerUserId: 1 };
    const superAdmin = { id: 99, role: 'super_admin' };
    assert.deepEqual(resolveOwnerAccess(owner), { owner_user_id: 1, super_admin: false });
    assert.deepEqual(resolveOwnerAccess(team), { owner_user_id: 1, super_admin: false });
    assert.deepEqual(resolveOwnerAccess(superAdmin), { owner_user_id: null, super_admin: true });
    assert.deepEqual(resolveOwnerAccess(superAdmin, 2), { owner_user_id: 2, super_admin: true });
    assert.throws(() => resolveOwnerAccess(owner, 2), /Accesso negato/);
    assert.equal(isSuperAdmin(superAdmin), true);
    assert.equal(isSuperAdmin({ id: 98, role: 'admin' }), false);

    assert.deepEqual(normalizeListFilters({
        device_id: '10', context_id: '100', week_start: '2026-06-01',
        week_end: '2026-06-30', limit: '500', offset: '2'
    }), {
        owner_user_id: null, device_id: 10, context_id: 100,
        week_start: '2026-06-01', week_end: '2026-06-30', limit: 100, offset: 2
    });
    assert.throws(() => normalizeListFilters({ week_start: '2026-07-01', week_end: '2026-06-01' }), /Intervallo/);
    assert.throws(() => normalizeListFilters({ context_id: 'nope' }), /non valido/);

    const inApp = buildWeeklyNotification(candidate(), 'in_app');
    assert.equal(inApp.channel, 'in_app');
    assert.equal(inApp.status, 'delivered');
    assert.equal(inApp.recipient_email, null);
    assert.equal(inApp.payload_json.download_url, '/api/reports/weekly/400/download');
    assert.equal(JSON.stringify(inApp.payload_json).includes('raw_evidence'), false);
    assert.deepEqual(buildWeeklyNotification(candidate(), 'in_app'), inApp, 'notification must be deterministic');

    const email = buildWeeklyNotification(candidate(), 'email_pending');
    assert.equal(email.status, 'pending');
    assert.equal(email.recipient_email, 'team@example.test');
    assert.throws(
        () => buildWeeklyNotification(candidate({ recipient_email: null }), 'email_pending'),
        /requires recipient email/
    );
    assert.throws(() => buildWeeklyNotification(candidate(), 'sms'), /unsupported channel/);

    assert.deepEqual(normalizeNotificationFilters({ channel: 'in_app', status: 'delivered' }), {
        owner_user_id: null, recipient_user_id: null, device_id: null, context_id: null,
        channel: 'in_app', status: 'delivered', limit: 50, offset: 0
    });
    assert.throws(() => normalizeNotificationFilters({ channel: 'email' }), /channel non valido/);
    assert.deepEqual(userNotificationScope(team), { recipient_user_id: 3, owner_user_id: 1 });

    console.log('PASS weekly report history and notification unit validation');
}

run();
