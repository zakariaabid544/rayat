const cron = require('node-cron');
const nodemailer = require('nodemailer');

const { query } = require('../../config/database');

const ALERT_TYPE = 'missing_sensor_data';
const ALERT_SUBJECT = '⚠️ RAYAT – Nessun dato ricevuto';
const DEFAULT_PRIMARY_EMAIL = 'zakariaabid@hotmail.it';
const DEFAULT_FALLBACK_EMAIL = 'zakariaabid544@gmail.com';

const inMemoryNotificationState = {
  missing_sensor_data: null
};

let scheduledTask = null;
let isRunning = false;

function parseMinutes(value, fallback) {
  const normalized = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function getExpectedDataMinutes() {
  return parseMinutes(process.env.ALERT_EXPECTED_DATA_MINUTES, 30);
}

function getMissingDataThresholdMinutes() {
  return parseMinutes(process.env.ALERT_MISSING_DATA_THRESHOLD_MINUTES, 45);
}

function getNotificationCooldownMinutes() {
  return parseMinutes(process.env.ALERT_NOTIFICATION_COOLDOWN_MINUTES, 60);
}

function getAlertRecipients() {
  const primary = String(process.env.ALERT_PRIMARY_EMAIL || '').trim() || DEFAULT_PRIMARY_EMAIL;
  const fallback = String(process.env.ALERT_FALLBACK_EMAIL || '').trim() || DEFAULT_FALLBACK_EMAIL;
  return { primary, fallback };
}

function getNotificationCooldownMs() {
  return getNotificationCooldownMinutes() * 60 * 1000;
}

function isMissingRelationError(error) {
  return error?.code === '42P01' || /does not exist/i.test(String(error?.message || ''));
}

function toDateOrNull(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getLastUpdateTimestamp() {
  try {
    const rows = await query('SELECT MAX(created_at) AS last_update FROM sensor_data');
    const directMatch = toDateOrNull(rows?.[0]?.last_update);
    if (directMatch) {
      return directMatch;
    }
  } catch (error) {
    if (!isMissingRelationError(error)) {
      throw error;
    }
  }

  const rows = await query(
    `SELECT MAX(last_update) AS last_update
     FROM (
       SELECT MAX(created_at) AS last_update FROM public_sensor_readings
       UNION ALL
       SELECT MAX(timestamp) AS last_update FROM sensor_readings
     ) AS sensor_updates`
  );

  return toDateOrNull(rows?.[0]?.last_update);
}

async function getLastNotificationTimestamp() {
  try {
    const rows = await query(
      `SELECT created_at
       FROM notification_log
       WHERE notification_type = ?
         AND channel = 'email'
       ORDER BY created_at DESC
       LIMIT 1`,
      [ALERT_TYPE]
    );

    const databaseTimestamp = toDateOrNull(rows?.[0]?.created_at);
    if (databaseTimestamp) {
      return databaseTimestamp;
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[alert-job] notification_log non disponibile, uso fallback in memoria:', error.message);
    }
  }

  return toDateOrNull(inMemoryNotificationState[ALERT_TYPE]);
}

async function rememberNotification(recipient, metadata = {}) {
  const now = new Date();
  inMemoryNotificationState[ALERT_TYPE] = now.toISOString();

  try {
    await query(
      `INSERT INTO notification_log (notification_type, channel, recipient, metadata, created_at)
       VALUES (?, 'email', ?, ?, ?)`,
      [ALERT_TYPE, recipient, JSON.stringify(metadata), now.toISOString()]
    );
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[alert-job] impossibile salvare notification_log, continuo con anti-spam in memoria:', error.message);
    }
  }
}

function buildAlertText(lastUpdate, minutesSinceLastData) {
  const lastUpdateText = lastUpdate ? lastUpdate.toISOString() : 'nessun dato disponibile';
  return [
    'RAYAT ha rilevato assenza di nuovi dati sensore oltre la soglia prevista.',
    '',
    `Ultimo dato ricevuto: ${lastUpdateText}`,
    `Minuti trascorsi dall’ultimo dato: ${minutesSinceLastData}`,
    `Intervallo atteso: ${getExpectedDataMinutes()} minuti`,
    `Soglia alert: ${getMissingDataThresholdMinutes()} minuti`,
    '',
    'Verificare immediatamente pipeline sensori/router/DTU/broker.'
  ].join('\n');
}

function createMailTransport() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number.parseInt(String(process.env.SMTP_PORT || ''), 10);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();

  if (!host || !Number.isFinite(port)) {
    return null;
  }

  const transportConfig = {
    host,
    port,
    secure: port === 465
  };

  if (user && pass) {
    transportConfig.auth = { user, pass };
  }

  return nodemailer.createTransport(transportConfig);
}

async function deliverAlertEmail(lastUpdate, minutesSinceLastData) {
  const recipients = getAlertRecipients();
  const body = buildAlertText(lastUpdate, minutesSinceLastData);

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[alert-job] [DEV] ${ALERT_SUBJECT}`);
    console.log(body);
    await rememberNotification(recipients.primary, {
      mode: 'development',
      minutesSinceLastData,
      lastUpdate: lastUpdate ? lastUpdate.toISOString() : null
    });
    return;
  }

  const transporter = createMailTransport();
  if (!transporter) {
    console.warn('[alert-job] SMTP non configurato: alert email non inviato.');
    return;
  }

  const from =
    String(process.env.SMTP_FROM || '').trim() ||
    String(process.env.EMAIL_FROM || '').trim() ||
    String(process.env.SMTP_USER || '').trim() ||
    'no-reply@rayat.local';

  const sendEmail = async (recipient) => {
    await transporter.sendMail({
      from,
      to: recipient,
      subject: ALERT_SUBJECT,
      text: body
    });
    await rememberNotification(recipient, {
      mode: 'smtp',
      minutesSinceLastData,
      lastUpdate: lastUpdate ? lastUpdate.toISOString() : null
    });
  };

  try {
    await sendEmail(recipients.primary);
    console.log(`[alert-job] Alert email inviato a ${recipients.primary}`);
  } catch (primaryError) {
    if (!recipients.fallback || recipients.fallback === recipients.primary) {
      throw primaryError;
    }

    console.warn(`[alert-job] Invio al destinatario principale fallito, provo fallback ${recipients.fallback}:`, primaryError.message);
    await sendEmail(recipients.fallback);
    console.log(`[alert-job] Alert email inviato al fallback ${recipients.fallback}`);
  }
}

async function runMissingDataAlertCheck() {
  if (isRunning) {
    return;
  }

  isRunning = true;

  try {
    const lastUpdate = await getLastUpdateTimestamp();
    if (!lastUpdate) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[alert-job] Nessun dato disponibile per il controllo alert.');
      }
      return;
    }

    const minutesSinceLastData = Math.floor((Date.now() - lastUpdate.getTime()) / 60000);
    if (minutesSinceLastData <= getMissingDataThresholdMinutes()) {
      return;
    }

    const lastNotification = await getLastNotificationTimestamp();
    if (lastNotification && (Date.now() - lastNotification.getTime()) < getNotificationCooldownMs()) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[alert-job] Alert saltato per anti-spam: notifica già inviata negli ultimi 60 minuti.');
      }
      return;
    }

    await deliverAlertEmail(lastUpdate, minutesSinceLastData);
  } catch (error) {
    console.error('[alert-job] Errore durante il controllo dati mancanti:', error);
  } finally {
    isRunning = false;
  }
}

function startMissingDataAlertJob() {
  if (scheduledTask) {
    return scheduledTask;
  }

  const cronExpression = String(process.env.ALERT_JOB_CRON || '*/10 * * * *').trim() || '*/10 * * * *';
  scheduledTask = cron.schedule(cronExpression, () => {
    void runMissingDataAlertCheck();
  }, {
    scheduled: false
  });

  scheduledTask.start();
  console.log(`[alert-job] Job attivo con cron "${cronExpression}"`);
  void runMissingDataAlertCheck();

  return scheduledTask;
}

module.exports = {
  runMissingDataAlertCheck,
  startMissingDataAlertJob
};
