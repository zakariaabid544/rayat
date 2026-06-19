'use strict';

const { query } = require('../config/database');
const { resolveCustomerScope } = require('./customer-access');
const { isSuperAdmin, httpError } = require('./weekly-report-history');

const RULE_VERSION = 's5.5';
const NOTIFICATION_TYPE = 'weekly_report_ready';
const CHANNELS = Object.freeze(['in_app', 'email_pending']);
const STATUSES = Object.freeze(['pending', 'delivered', 'read', 'cancelled', 'failed']);

function positiveInteger(value, label, required = false) {
    if (value === undefined || value === null || value === '') {
        if (required) { throw httpError(400, `${label} obbligatorio`, 'notification_validation'); }
        return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw httpError(400, `${label} non valido`, 'notification_validation');
    }
    return parsed;
}

function extractRows(result) {
    if (Array.isArray(result)) { return result; }
    return result && Array.isArray(result.rows) ? result.rows : [];
}

async function ensureWeeklyNotificationSchema({ executor = query } = {}) {
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_weekly_report_notifications (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           report_file_id BIGINT NOT NULL REFERENCES agro_weekly_report_files(id) ON DELETE CASCADE,
           notification_type VARCHAR(40) NOT NULL DEFAULT 'weekly_report_ready',
           channel VARCHAR(20) NOT NULL,
           status VARCHAR(20) NOT NULL,
           recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           recipient_email TEXT NULL,
           title TEXT NOT NULL,
           message TEXT NOT NULL,
           payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           sent_at TIMESTAMPTZ NULL,
           read_at TIMESTAMPTZ NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_weekly_report_notification
             UNIQUE (report_file_id, recipient_user_id, channel),
           CONSTRAINT weekly_report_notification_values_check CHECK (
             notification_type = 'weekly_report_ready'
             AND channel IN ('in_app','email_pending')
             AND status IN ('pending','delivered','read','cancelled','failed')
             AND btrim(title) <> '' AND btrim(message) <> ''
             AND jsonb_typeof(payload_json) = 'object'
             AND NOT jsonb_exists_any(payload_json, ARRAY[
               'raw_evidence','event_ids','supporting_event_ids','supporting_examples','other_owner_ids'
             ])
             AND (channel = 'in_app' OR NULLIF(btrim(recipient_email), '') IS NOT NULL)
             AND (read_at IS NULL OR (channel = 'in_app' AND status = 'read')))
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count
         FROM agro_weekly_report_notifications n
         LEFT JOIN devices d ON d.id = n.device_id
         LEFT JOIN users du ON du.id = d.user_id
         LEFT JOIN users ru ON ru.id = n.recipient_user_id
         LEFT JOIN agro_context_segments c ON c.id = n.context_id
         LEFT JOIN agro_weekly_report_files f ON f.id = n.report_file_id
         WHERE n.owner_user_id IS DISTINCT FROM COALESCE(du.owner_user_id, du.id)
            OR n.owner_user_id IS DISTINCT FROM COALESCE(ru.owner_user_id, ru.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM n.owner_user_id
            OR c.device_id IS DISTINCT FROM n.device_id
            OR f.id IS NULL OR f.owner_user_id IS DISTINCT FROM n.owner_user_id
            OR f.device_id IS DISTINCT FROM n.device_id OR f.context_id IS DISTINCT FROM n.context_id`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[weekly-notification-schema] existing rows have invalid tenant/context/recipient identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_weekly_notification_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; recipient_owner INTEGER; context_owner INTEGER;
           context_device INTEGER; file_owner INTEGER; file_device INTEGER; file_context BIGINT;
         BEGIN
           SELECT COALESCE(u.owner_user_id, u.id) INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = NEW.device_id;
           SELECT COALESCE(owner_user_id, id) INTO recipient_owner
             FROM users WHERE id = NEW.recipient_user_id;
           SELECT owner_user_id, device_id INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           SELECT owner_user_id, device_id, context_id INTO file_owner, file_device, file_context
             FROM agro_weekly_report_files WHERE id = NEW.report_file_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'weekly notification owner_user_id does not own device_id'; END IF;
           IF recipient_owner IS NULL OR recipient_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'weekly notification recipient belongs to another owner'; END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'weekly notification context mismatch'; END IF;
           IF file_owner IS NULL OR file_owner IS DISTINCT FROM NEW.owner_user_id
              OR file_device IS DISTINCT FROM NEW.device_id OR file_context IS DISTINCT FROM NEW.context_id THEN
             RAISE EXCEPTION 'weekly notification report file mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS weekly_notification_identity_guard ON agro_weekly_report_notifications');
    await executor(
        `CREATE TRIGGER weekly_notification_identity_guard
         BEFORE INSERT OR UPDATE ON agro_weekly_report_notifications
         FOR EACH ROW EXECUTE FUNCTION rayat_assert_weekly_notification_identity()`
    );
    await executor(
        `CREATE INDEX IF NOT EXISTS idx_weekly_notification_recipient_unread
         ON agro_weekly_report_notifications (recipient_user_id, read_at, created_at DESC)
         WHERE channel = 'in_app'`
    );
    await executor(
        `CREATE INDEX IF NOT EXISTS idx_weekly_notification_owner_created
         ON agro_weekly_report_notifications (owner_user_id, created_at DESC)`
    );
    await executor(
        `CREATE INDEX IF NOT EXISTS idx_weekly_notification_report_file
         ON agro_weekly_report_notifications (report_file_id)`
    );
}

function buildWeeklyNotification(candidate, channel) {
    if (!CHANNELS.includes(channel)) { throw new Error('[weekly-notification] unsupported channel'); }
    const identity = {
        owner_user_id: positiveInteger(candidate.owner_user_id, 'owner_user_id', true),
        device_id: positiveInteger(candidate.device_id, 'device_id', true),
        context_id: positiveInteger(candidate.context_id, 'context_id', true),
        report_file_id: positiveInteger(candidate.report_file_id, 'report_file_id', true),
        report_id: positiveInteger(candidate.report_id, 'report_id', true),
        recipient_user_id: positiveInteger(candidate.recipient_user_id, 'recipient_user_id', true)
    };
    const weekStart = String(candidate.week_start).slice(0, 10);
    const weekEnd = String(candidate.week_end).slice(0, 10);
    const recipientEmail = channel === 'email_pending' ? String(candidate.recipient_email || '').trim() : null;
    if (channel === 'email_pending' && !recipientEmail) {
        throw new Error('[weekly-notification] email_pending requires recipient email');
    }
    return {
        ...identity,
        notification_type: NOTIFICATION_TYPE,
        channel,
        status: channel === 'in_app' ? 'delivered' : 'pending',
        recipient_email: recipientEmail,
        title: 'Il report settimanale Rayat è pronto',
        message: `Il report del dispositivo ${identity.device_id} per la settimana ${weekStart} - ${weekEnd} è disponibile.`,
        payload_json: {
            report_file_id: identity.report_file_id,
            report_id: identity.report_id,
            device_id: identity.device_id,
            context_id: identity.context_id,
            week_start: weekStart,
            week_end: weekEnd,
            report_url: `/api/reports/weekly/${identity.report_id}`,
            download_url: `/api/reports/weekly/${identity.report_id}/download`,
            rule_version: RULE_VERSION
        }
    };
}

function normalizeCandidateScope(scope) {
    if (!scope) { return {}; }
    return {
        owner_user_id: positiveInteger(scope.ownerUserId, 'ownerUserId'),
        device_id: positiveInteger(scope.deviceId, 'deviceId'),
        context_id: positiveInteger(scope.contextId, 'contextId'),
        report_file_id: positiveInteger(scope.reportFileId, 'reportFileId')
    };
}

async function loadNotificationCandidates({ scope = null, executor = query } = {}) {
    const normalized = normalizeCandidateScope(scope);
    const clauses = ["u.role IN ('client','farmer')", 'COALESCE(u.active, TRUE) = TRUE'];
    const params = [];
    for (const [field, value] of Object.entries(normalized)) {
        if (value) {
            clauses.push(`${field === 'report_file_id' ? 'f.id' : `f.${field}`} = ?`);
            params.push(value);
        }
    }
    return executor(
        `SELECT f.id AS report_file_id, f.owner_user_id, f.device_id, f.context_id,
                f.generated_at, r.id AS report_id, r.week_start, r.week_end,
                u.id AS recipient_user_id, u.email AS recipient_email
         FROM agro_weekly_report_files f
         JOIN agro_weekly_reports r ON r.id = f.report_id
           AND r.owner_user_id = f.owner_user_id AND r.device_id = f.device_id
           AND r.context_id = f.context_id AND r.week_start = f.week_start
         JOIN users u ON COALESCE(u.owner_user_id, u.id) = f.owner_user_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY f.generated_at, f.id, u.id`,
        params
    );
}

async function notificationExists(notification, executor = query) {
    const rows = await executor(
        `SELECT id FROM agro_weekly_report_notifications
         WHERE report_file_id = ? AND recipient_user_id = ? AND channel = ? LIMIT 1`,
        [notification.report_file_id, notification.recipient_user_id, notification.channel]
    );
    return rows.length ? Number(rows[0].id) : null;
}

async function storeNotification(notification, executor = query) {
    const result = await executor(
        `INSERT INTO agro_weekly_report_notifications
          (owner_user_id, device_id, context_id, report_file_id, notification_type,
           channel, status, recipient_user_id, recipient_email, title, message,
           payload_json, sent_at, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB),
           CASE WHEN ? = 'in_app' THEN NOW() ELSE NULL END, NULL, NOW(), NOW())
         ON CONFLICT (report_file_id, recipient_user_id, channel) DO NOTHING
         RETURNING id`,
        [notification.owner_user_id, notification.device_id, notification.context_id,
            notification.report_file_id, notification.notification_type, notification.channel,
            notification.status, notification.recipient_user_id, notification.recipient_email,
            notification.title, notification.message, JSON.stringify(notification.payload_json),
            notification.channel]
    );
    const rows = extractRows(result);
    return rows.length ? Number(rows[0].id) : null;
}

async function runWeeklyNotificationCycle({
    dryRun = false,
    includeEmailPending = false,
    scope = null,
    executor = query
} = {}) {
    const candidates = await loadNotificationCandidates({ scope, executor });
    const channels = includeEmailPending ? CHANNELS : ['in_app'];
    const rows = [];
    let existing = 0;
    let created = 0;
    let wouldCreate = 0;
    const byChannel = { in_app: 0, email_pending: 0 };
    for (const candidate of candidates) {
        for (const channel of channels) {
            if (channel === 'email_pending' && !String(candidate.recipient_email || '').trim()) { continue; }
            const notification = buildWeeklyNotification(candidate, channel);
            const existingId = await notificationExists(notification, executor);
            if (existingId) {
                existing += 1;
                rows.push({ ...notification, id: existingId, existing: true });
                continue;
            }
            if (dryRun) {
                wouldCreate += 1;
                rows.push({ ...notification, existing: false });
                continue;
            }
            const id = await storeNotification(notification, executor);
            if (id) {
                created += 1;
                byChannel[channel] += 1;
                rows.push({ ...notification, id, existing: false });
            } else {
                existing += 1;
            }
        }
    }
    return {
        report_recipients: candidates.length,
        created,
        would_create: wouldCreate,
        existing,
        by_channel: byChannel,
        dry_run: dryRun,
        include_email_pending: includeEmailPending,
        rows
    };
}

function normalizeNotificationFilters(raw = {}) {
    const channel = raw.channel ? String(raw.channel) : null;
    const status = raw.status ? String(raw.status) : null;
    if (channel && !CHANNELS.includes(channel)) { throw httpError(400, 'channel non valido', 'notification_validation'); }
    if (status && !STATUSES.includes(status)) { throw httpError(400, 'status non valido', 'notification_validation'); }
    const limit = Math.min(positiveInteger(raw.limit, 'limit') || 50, 100);
    const offset = raw.offset === undefined || raw.offset === '' ? 0 : Number(raw.offset);
    if (!Number.isInteger(offset) || offset < 0) { throw httpError(400, 'offset non valido', 'notification_validation'); }
    return {
        owner_user_id: positiveInteger(raw.owner_user_id, 'owner_user_id'),
        recipient_user_id: positiveInteger(raw.recipient_user_id, 'recipient_user_id'),
        device_id: positiveInteger(raw.device_id, 'device_id'),
        context_id: positiveInteger(raw.context_id, 'context_id'),
        channel, status, limit, offset
    };
}

function userNotificationScope(user) {
    const recipientUserId = positiveInteger(user && user.id, 'user_id', true);
    const ownerUserId = positiveInteger(resolveCustomerScope(user), 'owner scope', true);
    return { recipient_user_id: recipientUserId, owner_user_id: ownerUserId };
}

async function listNotifications({ user, filters = {}, admin = false, executor = query } = {}) {
    const normalized = normalizeNotificationFilters(filters);
    const clauses = [];
    const params = [];
    if (admin) {
        if (!isSuperAdmin(user)) { throw httpError(403, 'Accesso riservato al Super Admin', 'notification_admin'); }
        if (normalized.owner_user_id) { clauses.push('n.owner_user_id = ?'); params.push(normalized.owner_user_id); }
        if (normalized.recipient_user_id) { clauses.push('n.recipient_user_id = ?'); params.push(normalized.recipient_user_id); }
    } else {
        const scope = userNotificationScope(user);
        clauses.push('n.owner_user_id = ?', 'n.recipient_user_id = ?');
        params.push(scope.owner_user_id, scope.recipient_user_id);
        if (normalized.channel && normalized.channel !== 'in_app') {
            throw httpError(403, 'Il canale email_pending è riservato alla coda amministrativa', 'notification_channel');
        }
        clauses.push("n.channel = 'in_app'");
    }
    if (normalized.device_id) { clauses.push('n.device_id = ?'); params.push(normalized.device_id); }
    if (normalized.context_id) { clauses.push('n.context_id = ?'); params.push(normalized.context_id); }
    if (admin && normalized.channel) { clauses.push('n.channel = ?'); params.push(normalized.channel); }
    if (normalized.status) { clauses.push('n.status = ?'); params.push(normalized.status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const countRows = await executor(
        `SELECT COUNT(*)::integer AS count FROM agro_weekly_report_notifications n ${where}`,
        params
    );
    const rows = await executor(
        `SELECT n.id, n.owner_user_id, n.device_id, n.context_id, n.report_file_id,
                n.notification_type, n.channel, n.status, n.recipient_user_id,
                n.recipient_email, n.title, n.message, n.payload_json,
                n.sent_at, n.read_at, n.created_at, n.updated_at
         FROM agro_weekly_report_notifications n ${where}
         ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
        [...params, normalized.limit, normalized.offset]
    );
    return {
        total: Number(countRows[0] && countRows[0].count) || 0,
        limit: normalized.limit,
        offset: normalized.offset,
        notifications: rows
    };
}

async function countUnreadNotifications({ user, executor = query } = {}) {
    const scope = userNotificationScope(user);
    const rows = await executor(
        `SELECT COUNT(*)::integer AS count FROM agro_weekly_report_notifications
         WHERE owner_user_id = ? AND recipient_user_id = ?
           AND channel = 'in_app' AND status = 'delivered' AND read_at IS NULL`,
        [scope.owner_user_id, scope.recipient_user_id]
    );
    return { unread: Number(rows[0] && rows[0].count) || 0 };
}

async function markNotificationRead({ notificationId, user, executor = query } = {}) {
    const id = positiveInteger(notificationId, 'notification_id', true);
    const scope = userNotificationScope(user);
    const result = await executor(
        `UPDATE agro_weekly_report_notifications
         SET status = 'read', read_at = COALESCE(read_at, NOW()), updated_at = NOW()
         WHERE id = ? AND owner_user_id = ? AND recipient_user_id = ? AND channel = 'in_app'
         RETURNING id, status, read_at`,
        [id, scope.owner_user_id, scope.recipient_user_id]
    );
    const rows = extractRows(result);
    if (!rows.length) { throw httpError(404, 'Notifica non trovata', 'notification_not_found'); }
    return rows[0];
}

module.exports = {
    ensureWeeklyNotificationSchema,
    buildWeeklyNotification,
    loadNotificationCandidates,
    runWeeklyNotificationCycle,
    listNotifications,
    countUnreadNotifications,
    markNotificationRead,
    normalizeNotificationFilters,
    userNotificationScope,
    extractRows,
    CHANNELS,
    STATUSES,
    NOTIFICATION_TYPE,
    RULE_VERSION
};
