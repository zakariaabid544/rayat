const cron = require('node-cron');
const nodemailer = require('nodemailer');

const { query } = require('../../config/database');

const ALERT_TYPE = 'missing_sensor_data';
const ALERT_SUBJECT = '⚠️ RAYAT – Nessun dato ricevuto';
const DEFAULT_PRIMARY_EMAIL = 'zakariaabid544@gmail.com';
const DEFAULT_FALLBACK_EMAIL = 'zakariaabid544@gmail.com';

const inMemoryNotificationState = {
  missing_sensor_data: {
    createdAt: null,
    lastUpdateIso: null
  }
};

const runtimeState = {
  lastKnownDataAt: null,
  nextAlertDueAt: null,
  scheduledForLastUpdate: null,
  lastScheduleSyncAt: null,
  lastAlertCheckAt: null,
  lastAlertCheckTrigger: null
};

let scheduledTask = null;
let exactAlertTimeout = null;
let isRunning = false;
let isSyncingSchedule = false;
let hasLegacySensorDataTable = null;

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

function getAlertCronExpression() {
  return String(process.env.ALERT_JOB_CRON || '* * * * *').trim() || '* * * * *';
}

function getAlertRecipients() {
  const recipientsFromList = String(process.env.ALERT_EMAILS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const primary = String(process.env.ALERT_PRIMARY_EMAIL || '').trim() || DEFAULT_PRIMARY_EMAIL;
  const fallback = String(process.env.ALERT_FALLBACK_EMAIL || '').trim() || DEFAULT_FALLBACK_EMAIL;
  const recipients = Array.from(new Set([
    ...recipientsFromList,
    primary,
    fallback
  ].filter(Boolean)));

  return {
    primary,
    fallback,
    recipients
  };
}

function getNotificationCooldownMs() {
  return getNotificationCooldownMinutes() * 60 * 1000;
}

function getMissingDataThresholdMs() {
  return getMissingDataThresholdMinutes() * 60 * 1000;
}

function buildAlertSubject(options = {}) {
  return options.isTest ? `[TEST] ${ALERT_SUBJECT}` : ALERT_SUBJECT;
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

function toIsoOrNull(value) {
  const date = toDateOrNull(value);
  return date ? date.toISOString() : null;
}

function getAlertDueDate(lastUpdate) {
  if (!lastUpdate) {
    return null;
  }

  return new Date(lastUpdate.getTime() + getMissingDataThresholdMs());
}

function updateRuntimeLastKnownData(lastUpdate) {
  const lastUpdateIso = toIsoOrNull(lastUpdate);
  runtimeState.lastKnownDataAt = lastUpdateIso;
  runtimeState.nextAlertDueAt = lastUpdateIso ? getAlertDueDate(lastUpdate).toISOString() : null;
  return lastUpdateIso;
}

function clearExactAlertTimeout() {
  if (exactAlertTimeout) {
    clearTimeout(exactAlertTimeout);
    exactAlertTimeout = null;
  }

  runtimeState.scheduledForLastUpdate = null;
  runtimeState.nextAlertDueAt = null;
}

function scheduleExactAlertTimeout(lastUpdate, options = {}) {
  clearExactAlertTimeout();

  if (!lastUpdate) {
    runtimeState.lastKnownDataAt = null;
    return;
  }

  const lastUpdateIso = updateRuntimeLastKnownData(lastUpdate);
  const dueAt = getAlertDueDate(lastUpdate);
  const delayMs = dueAt.getTime() - Date.now();

  runtimeState.scheduledForLastUpdate = lastUpdateIso;

  if (delayMs <= 0) {
    return;
  }

  exactAlertTimeout = setTimeout(() => {
    exactAlertTimeout = null;
    void runMissingDataAlertCheck({
      trigger: options.trigger || 'exact_timeout',
      preloadedLastUpdate: lastUpdate
    });
  }, delayMs);
}

async function getLastUpdateTimestamp() {
  if (hasLegacySensorDataTable === null) {
    const rows = await query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = 'sensor_data'
       ) AS exists`
    );
    hasLegacySensorDataTable = Boolean(rows?.[0]?.exists);
  }

  if (hasLegacySensorDataTable) {
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

      hasLegacySensorDataTable = false;
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

async function getLastNotificationTimestamp(lastUpdate) {
  const lastUpdateIso = toIsoOrNull(lastUpdate);

  try {
    const rows = lastUpdateIso
      ? await query(
        `SELECT created_at
         FROM notification_log
         WHERE notification_type = ?
           AND channel = 'email'
           AND COALESCE(metadata->>'lastUpdate', '') = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [ALERT_TYPE, lastUpdateIso]
      )
      : await query(
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

  const memoryState = inMemoryNotificationState[ALERT_TYPE];
  if (!memoryState) {
    return null;
  }

  if (!lastUpdateIso || memoryState.lastUpdateIso === lastUpdateIso) {
    return toDateOrNull(memoryState.createdAt);
  }

  return null;
}

async function rememberNotification(recipient, metadata = {}) {
  const now = new Date();
  inMemoryNotificationState[ALERT_TYPE] = {
    createdAt: now.toISOString(),
    lastUpdateIso: toIsoOrNull(metadata.lastUpdate)
  };

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

function buildAlertText(lastUpdate, minutesSinceLastData, options = {}) {
  const lastUpdateText = lastUpdate ? lastUpdate.toISOString() : 'nessun dato disponibile';
  const lines = [
    'RAYAT ha rilevato assenza di nuovi dati sensore oltre la soglia prevista.',
    '',
    `Ultimo dato ricevuto: ${lastUpdateText}`,
    `Minuti trascorsi dall’ultimo dato: ${minutesSinceLastData}`,
    `Intervallo atteso: ${getExpectedDataMinutes()} minuti`,
    `Soglia alert: ${getMissingDataThresholdMinutes()} minuti`,
    '',
    'Possibile problema: credito SIM insufficiente, SIM non attiva oppure anomalia del router/DTU/broker.',
    'Azione consigliata: recarsi in campo oppure ricaricare la SIM e verificare la connettività del router.'
  ];

  if (options.isTest) {
    lines.unshift('Questo è un messaggio di prova inviato manualmente per verificare il canale di alert del router.', '');
  }

  return lines.join('\n');
}

function inferMailService(emailUser = '') {
  const domain = String(emailUser || '').split('@')[1]?.toLowerCase() || '';

  if (domain.includes('gmail') || domain.includes('googlemail')) {
    return 'gmail';
  }
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) {
    return 'hotmail';
  }
  if (domain.includes('yahoo')) {
    return 'yahoo';
  }

  return null;
}

function resolveAlertMailConfig() {
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpPort = Number.parseInt(String(process.env.SMTP_PORT || ''), 10);
  const smtpUser = String(process.env.SMTP_USER || '').trim();
  const smtpPass = String(process.env.SMTP_PASS || '').trim();
  const emailUser = String(process.env.EMAIL_USER || '').trim();
  const emailPass = String(process.env.EMAIL_PASS || '').trim();
  const user = smtpUser || emailUser;
  const pass = smtpPass || emailPass;
  const service = inferMailService(user);

  return {
    host: smtpHost,
    port: Number.isFinite(smtpPort) ? smtpPort : null,
    user,
    pass,
    from:
      String(process.env.SMTP_FROM || '').trim() ||
      String(process.env.EMAIL_FROM || '').trim() ||
      user ||
      'no-reply@rayat.local',
    service
  };
}

function createMailTransport() {
  const mailConfig = resolveAlertMailConfig();
  if (!mailConfig.user || !mailConfig.pass) {
    return null;
  }

  if (mailConfig.host && Number.isFinite(mailConfig.port)) {
    return nodemailer.createTransport({
      host: mailConfig.host,
      port: mailConfig.port,
      secure: mailConfig.port === 465,
      auth: {
        user: mailConfig.user,
        pass: mailConfig.pass
      }
    });
  }

  if (mailConfig.service) {
    return nodemailer.createTransport({
      service: mailConfig.service,
      auth: {
        user: mailConfig.user,
        pass: mailConfig.pass
      }
    });
  }

  return null;
}

function hasConfiguredSmtp() {
  const mailConfig = resolveAlertMailConfig();
  return Boolean(
    mailConfig.user
    && mailConfig.pass
    && (
      (mailConfig.host && Number.isFinite(mailConfig.port))
      || mailConfig.service
    )
  );
}

async function deliverAlertEmail(lastUpdate, minutesSinceLastData, options = {}) {
  const recipients = getAlertRecipients();
  const subject = buildAlertSubject(options);
  const body = buildAlertText(lastUpdate, minutesSinceLastData, options);
  const alertDueAt = getAlertDueDate(lastUpdate);

  if (!options.forceSmtp && process.env.NODE_ENV !== 'production') {
    console.log(`[alert-job] [DEV] ${subject}`);
    console.log(`[alert-job] [DEV] Destinatari: ${recipients.recipients.join(', ') || 'nessuno configurato'}`);
    console.log(body);
    for (const recipient of recipients.recipients) {
      await rememberNotification(recipient, {
        mode: options.isTest ? 'development_test' : 'development',
        minutesSinceLastData,
        lastUpdate: lastUpdate ? lastUpdate.toISOString() : null,
        alertDueAt: alertDueAt ? alertDueAt.toISOString() : null,
        isTest: Boolean(options.isTest),
        trigger: options.trigger || 'development'
      });
    }
    return;
  }

  const transporter = createMailTransport();
  if (!transporter) {
    throw new Error('SMTP non configurato: imposta SMTP_HOST/SMTP_PORT oppure EMAIL_USER/EMAIL_PASS compatibili, più il mittente.');
  }

  const mailConfig = resolveAlertMailConfig();
  const from = mailConfig.from;

  const sendEmail = async (recipient) => {
    await transporter.sendMail({
      from,
      to: recipient,
      subject,
      text: body
    });
    await rememberNotification(recipient, {
      mode: options.isTest ? 'smtp_test' : 'smtp',
      minutesSinceLastData,
      lastUpdate: lastUpdate ? lastUpdate.toISOString() : null,
      alertDueAt: alertDueAt ? alertDueAt.toISOString() : null,
      isTest: Boolean(options.isTest),
      trigger: options.trigger || 'smtp'
    });
  };

  if (!recipients.recipients.length) {
    console.warn('[alert-job] Nessun destinatario configurato per l\'alert email.');
    return;
  }

  const failedRecipients = [];

  for (const recipient of recipients.recipients) {
    try {
      await sendEmail(recipient);
      console.log(`[alert-job] Alert email inviato a ${recipient}`);
    } catch (error) {
      failedRecipients.push({ recipient, error });
      console.warn(`[alert-job] Invio alert fallito per ${recipient}:`, error.message);
    }
  }

  if (failedRecipients.length === recipients.recipients.length) {
    const aggregatedError = new Error('Invio alert fallito per tutti i destinatari configurati.');
    aggregatedError.details = failedRecipients.map(({ recipient, error }) => ({
      recipient,
      message: error.message
    }));
    throw aggregatedError;
  }
}

async function sendMissingDataTestEmail(options = {}) {
  const thresholdMinutes = getMissingDataThresholdMinutes();
  const requestedMinutes = Number.parseInt(String(options.minutesSinceLastData ?? ''), 10);
  const minutesSinceLastData = Number.isFinite(requestedMinutes) && requestedMinutes > thresholdMinutes
    ? requestedMinutes
    : thresholdMinutes + 1;
  const lastUpdate = new Date(Date.now() - (minutesSinceLastData * 60 * 1000));

  if (!hasConfiguredSmtp()) {
    throw new Error('SMTP del backend non configurato. Per il test server servono SMTP_HOST/SMTP_PORT oppure EMAIL_USER/EMAIL_PASS compatibili, piu il mittente nel backend/.env.');
  }

  await deliverAlertEmail(lastUpdate, minutesSinceLastData, {
    forceSmtp: true,
    isTest: true
  });

  return {
    lastUpdate,
    minutesSinceLastData
  };
}

async function syncMissingDataAlertSchedule(options = {}) {
  if (isSyncingSchedule) {
    return;
  }

  isSyncingSchedule = true;
  runtimeState.lastScheduleSyncAt = new Date().toISOString();

  try {
    const lastUpdate = await getLastUpdateTimestamp();
    const lastUpdateIso = toIsoOrNull(lastUpdate);

    if (!lastUpdate) {
      clearExactAlertTimeout();
      runtimeState.lastKnownDataAt = null;
      return;
    }

    if (runtimeState.scheduledForLastUpdate !== lastUpdateIso) {
      scheduleExactAlertTimeout(lastUpdate, {
        trigger: options.trigger || 'sync'
      });
    } else {
      updateRuntimeLastKnownData(lastUpdate);
    }

    if (getAlertDueDate(lastUpdate).getTime() <= Date.now()) {
      await runMissingDataAlertCheck({
        trigger: options.trigger || 'sync_overdue',
        preloadedLastUpdate: lastUpdate
      });
    }
  } catch (error) {
    console.error('[alert-job] Errore durante la sincronizzazione del timer alert:', error);
  } finally {
    isSyncingSchedule = false;
  }
}

function notifyMissingDataHeartbeat(timestamp) {
  const lastUpdate = toDateOrNull(timestamp) || new Date();
  const currentLastKnown = toDateOrNull(runtimeState.lastKnownDataAt);

  if (currentLastKnown && lastUpdate.getTime() < currentLastKnown.getTime()) {
    return;
  }

  scheduleExactAlertTimeout(lastUpdate, { trigger: 'ingest' });
}

function getMissingDataAlertRuntimeStatus() {
  return {
    mode: 'exact_timer_plus_minute_sync',
    cron: getAlertCronExpression(),
    expectedDataMinutes: getExpectedDataMinutes(),
    missingDataThresholdMinutes: getMissingDataThresholdMinutes(),
    notificationCooldownMinutes: getNotificationCooldownMinutes(),
    smtpConfigured: hasConfiguredSmtp(),
    recipientCount: getAlertRecipients().recipients.length,
    lastKnownDataAt: runtimeState.lastKnownDataAt,
    nextAlertDueAt: runtimeState.nextAlertDueAt,
    scheduledForLastUpdate: runtimeState.scheduledForLastUpdate,
    lastScheduleSyncAt: runtimeState.lastScheduleSyncAt,
    lastAlertCheckAt: runtimeState.lastAlertCheckAt,
    lastAlertCheckTrigger: runtimeState.lastAlertCheckTrigger,
    preciseTimerActive: Boolean(exactAlertTimeout),
    isRunning
  };
}

async function runMissingDataAlertCheck(options = {}) {
  if (isRunning) {
    return;
  }

  isRunning = true;
  runtimeState.lastAlertCheckAt = new Date().toISOString();
  runtimeState.lastAlertCheckTrigger = options.trigger || 'manual';

  try {
    const lastUpdate = options.preloadedLastUpdate || await getLastUpdateTimestamp();
    if (!lastUpdate) {
      clearExactAlertTimeout();
      runtimeState.lastKnownDataAt = null;
      if (process.env.NODE_ENV !== 'production') {
        console.log('[alert-job] Nessun dato disponibile per il controllo alert.');
      }
      return;
    }

    updateRuntimeLastKnownData(lastUpdate);

    const elapsedMs = Date.now() - lastUpdate.getTime();
    if (elapsedMs < getMissingDataThresholdMs()) {
      return;
    }

    const minutesSinceLastData = Math.max(
      getMissingDataThresholdMinutes(),
      Math.floor(elapsedMs / 60000)
    );
    const lastNotification = await getLastNotificationTimestamp(lastUpdate);
    if (lastNotification && (Date.now() - lastNotification.getTime()) < getNotificationCooldownMs()) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[alert-job] Alert saltato per anti-spam: notifica già inviata negli ultimi 60 minuti.');
      }
      return;
    }

    await deliverAlertEmail(lastUpdate, minutesSinceLastData, {
      trigger: options.trigger || 'monitor'
    });
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

  const cronExpression = getAlertCronExpression();
  scheduledTask = cron.schedule(cronExpression, () => {
    void syncMissingDataAlertSchedule({ trigger: 'cron_sync' });
  }, {
    scheduled: false
  });

  scheduledTask.start();
  console.log(`[alert-job] Job attivo con cron "${cronExpression}" e timer preciso sulla soglia alert`);
  void syncMissingDataAlertSchedule({ trigger: 'startup' });

  return scheduledTask;
}

module.exports = {
  buildAlertText,
  buildAlertSubject,
  getMissingDataAlertRuntimeStatus,
  hasConfiguredSmtp,
  notifyMissingDataHeartbeat,
  runMissingDataAlertCheck,
  sendMissingDataTestEmail,
  syncMissingDataAlertSchedule,
  startMissingDataAlertJob
};
