// Rayat — Per-device Gateway Monitor Job (additivo, node-cron, DEFAULT OFF)
// Esegue il controllo connettività PER SINGOLO gateway (warning/offline/critical/recovery) su devices.last_seen.
// NON sostituisce l'alert globale di alertJob (che resta come fallback di sistema).
'use strict';
const cron = require('node-cron');
const { query } = require('../../config/database');
const {
    ensureGatewayMonitorSchema, runGatewayMonitor, seedDefaultGatewayConfigs
} = require('../../utils/gateway-monitor');

const CRON_EXPRESSION = process.env.GATEWAY_MONITOR_CRON || '* * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled() {
    const explicit = String(process.env.GATEWAY_MONITOR_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await query("SELECT config_value FROM runtime_config WHERE config_key = 'gateway_monitor_enabled' LIMIT 1");
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (error) { return false; }
}

function alertRecipients(customerEmail, configuredRecipients = []) {
    const deviceRecipients = Array.isArray(configuredRecipients)
        ? configuredRecipients
        : String(configuredRecipients || '').split(',');
    const list = String(process.env.ALERT_EMAILS || '').split(',').map((v) => v.trim()).filter(Boolean);
    const primary = String(process.env.ALERT_PRIMARY_EMAIL || '').trim();
    const fallback = String(process.env.ALERT_FALLBACK_EMAIL || '').trim();
    return Array.from(new Set([
        ...deviceRecipients.map((v) => String(v || '').trim()).filter(Boolean),
        customerEmail,
        ...list,
        primary,
        fallback
    ].filter(Boolean)));
}

// Sender reale: in sviluppo logga; in produzione invia via SMTP (env) se configurato. Non blocca lo stato.
async function defaultSendEmail(alert) {
    const recipients = alertRecipients(alert.customer_email, alert.recipients);
    if (process.env.NODE_ENV !== 'production' || !process.env.SMTP_HOST) {
        console.log(`[gateway-monitor] [${alert.alert_type.toUpperCase()}] ${alert.subject} -> ${recipients.join(', ') || 'nessun destinatario'}`);
        return;
    }
    try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
        });
        await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: recipients.join(','),
            subject: alert.subject,
            text: alert.body
        });
    } catch (error) {
        console.error('[gateway-monitor] invio email fallito:', error.message);
    }
}

async function runGatewayMonitorCycle({ dryRun = false, sendEmail = defaultSendEmail } = {}) {
    if (cycleRunning) { return { skipped_concurrent: true, evaluated: 0, dry_run: dryRun }; }
    cycleRunning = true;
    try {
        if (!schemaReady && !dryRun) { await ensureGatewayMonitorSchema(); await seedDefaultGatewayConfigs(); schemaReady = true; }
        const summary = await runGatewayMonitor({ dryRun, sendEmail });
        const s = summary.sent || {};
        if (((s.offline || 0) + (s.recovery || 0)) > 0) {
            console.log('[gateway-monitor] cycle:', JSON.stringify(summary.sent), 'evaluated=' + summary.evaluated);
        }
        return summary;
    } finally { cycleRunning = false; }
}

function startGatewayMonitorJob() {
    isEnabled()
        .then((enabled) => {
            if (!enabled) {
                console.log('[gateway-monitor] disabled - not scheduled. Enable with GATEWAY_MONITOR_ENABLED=true or runtime_config gateway_monitor_enabled=true.');
                return;
            }
            if (scheduledTask) { return; }
            ensureGatewayMonitorSchema().then(() => seedDefaultGatewayConfigs()).then(() => { schemaReady = true; })
                .catch((error) => console.error('[gateway-monitor] schema ensure failed:', error.message));
            scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
                runGatewayMonitorCycle({ dryRun: false }).catch((error) => console.error('[gateway-monitor] cycle error:', error.message));
            });
            console.log(`[gateway-monitor] scheduled: ${CRON_EXPRESSION}`);
        })
        .catch((error) => console.error('[gateway-monitor] start failed:', error.message));
}

function stopGatewayMonitorJob() {
    if (scheduledTask) { try { scheduledTask.stop(); } catch (error) { /* noop */ } scheduledTask = null; }
}

module.exports = { startGatewayMonitorJob, stopGatewayMonitorJob, runGatewayMonitorCycle, isEnabled };
