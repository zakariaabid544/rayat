const cron = require('node-cron');
const nodemailer = require('nodemailer');

const { query } = require('../../config/database');
const {
  getMonitoringConfig,
  getMissingDataThresholdMinutes,
  getOfflineAfterMinutes,
  getRouterIntervalMinutes,
  parseMinutes
} = require('../../utils/monitoring-config');

const ALERT_TYPE = 'missing_sensor_data';
const RECOVERY_ALERT_TYPE = 'missing_sensor_data_recovered';
const ALERT_SUBJECT = '⚠️ RAYAT – Nessun dato ricevuto';
const RECOVERY_ALERT_SUBJECT = '✅ RAYAT – Sistema tornato online';
const DEFAULT_PRIMARY_EMAIL = 'zakariaabid544@gmail.com';
const DEFAULT_FALLBACK_EMAIL = 'zakariaabid544@gmail.com';

const inMemoryNotificationState = {
  [ALERT_TYPE]: {
    createdAt: null,
    lastUpdateIso: null,
    alertLastUpdateIso: null,
    recoveredAtIso: null
  },
  [RECOVERY_ALERT_TYPE]: {
    createdAt: null,
    lastUpdateIso: null,
    alertLastUpdateIso: null,
    recoveredAtIso: null
  }
};

const runtimeState = {
  lastKnownDataAt: null,
  nextAlertDueAt: null,
  scheduledForLastUpdate: null,
  lastScheduleSyncAt: null,
  lastAlertCheckAt: null,
  lastAlertCheckTrigger: null,
  smtpConfigSource: 'missing'
};

const ALERT_MAIL_RUNTIME_KEYS = [
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from'
];

let scheduledTask = null;
let exactAlertTimeout = null;
let isRunning = false;
let isSyncingSchedule = false;
let hasLegacySensorDataTable = null;
let hasRuntimeConfigTable = null;

const mailConfigCache = {
  loadedAt: 0,
  values: null
};

function getExpectedDataMinutes() {
  return getRouterIntervalMinutes();
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

function buildRecoverySubject(options = {}) {
  return options.isTest ? `[TEST] ${RECOVERY_ALERT_SUBJECT}` : RECOVERY_ALERT_SUBJECT;
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
  const sensorUpdateSources = [];

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
    sensorUpdateSources.push('SELECT MAX(created_at) AS last_update FROM sensor_data');
  }

  sensorUpdateSources.push(
    'SELECT MAX(created_at) AS last_update FROM public_sensor_readings',
    'SELECT MAX(timestamp) AS last_update FROM sensor_readings'
  );

  try {
    const rows = await query(
      `SELECT MAX(last_update) AS last_update
       FROM (
         ${sensorUpdateSources.join('\n         UNION ALL\n         ')}
       ) AS sensor_updates`
    );

    return toDateOrNull(rows?.[0]?.last_update);
  } catch (error) {
    if (!hasLegacySensorDataTable || !isMissingRelationError(error)) {
      throw error;
    }

    hasLegacySensorDataTable = false;
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

async function hasRecoveryNotificationForAlert(alertLastUpdate) {
  const alertLastUpdateIso = toIsoOrNull(alertLastUpdate);
  if (!alertLastUpdateIso) {
    return false;
  }

  try {
    const rows = await query(
      `SELECT created_at
       FROM notification_log
       WHERE notification_type = ?
         AND channel = 'email'
         AND COALESCE(metadata->>'alertLastUpdate', '') = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [RECOVERY_ALERT_TYPE, alertLastUpdateIso]
    );

    if (toDateOrNull(rows?.[0]?.created_at)) {
      return true;
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[alert-job] notification_log recovery non disponibile, uso fallback in memoria:', error.message);
    }
  }

  const memoryState = inMemoryNotificationState[RECOVERY_ALERT_TYPE];
  return Boolean(memoryState?.alertLastUpdateIso && memoryState.alertLastUpdateIso === alertLastUpdateIso);
}

async function getPendingRecoveryAlert(recoveredAt) {
  const recoveredAtIso = toIsoOrNull(recoveredAt);
  if (!recoveredAtIso) {
    return null;
  }

  try {
    const rows = await query(
      `SELECT metadata->>'lastUpdate' AS last_update,
              MAX(created_at) AS alerted_at
       FROM notification_log
       WHERE notification_type = ?
         AND channel = 'email'
         AND COALESCE(metadata->>'lastUpdate', '') <> ''
         AND (metadata->>'lastUpdate')::timestamptz < ?::timestamptz
       GROUP BY metadata->>'lastUpdate'
       ORDER BY MAX((metadata->>'lastUpdate')::timestamptz) DESC
       LIMIT 1`,
      [ALERT_TYPE, recoveredAtIso]
    );

    const alertLastUpdate = toDateOrNull(rows?.[0]?.last_update);
    if (alertLastUpdate) {
      if (await hasRecoveryNotificationForAlert(alertLastUpdate)) {
        return null;
      }

      return {
        alertLastUpdate,
        alertedAt: toDateOrNull(rows?.[0]?.alertedAt || rows?.[0]?.alerted_at)
      };
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[alert-job] impossibile leggere l’alert pendente di recovery, uso fallback in memoria:', error.message);
    }
  }

  try {
    const rows = await query(
      `SELECT created_at AS alerted_at
       FROM notification_log
       WHERE notification_type = ?
         AND channel = 'email'
         AND created_at < ?::timestamptz
         AND (
           metadata IS NULL
           OR COALESCE(metadata->>'lastUpdate', '') = ''
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [ALERT_TYPE, recoveredAtIso]
    );

    const alertedAt = toDateOrNull(rows?.[0]?.alerted_at);
    if (alertedAt && !(await hasRecoveryNotificationForAlert(alertedAt))) {
      return {
        alertLastUpdate: alertedAt,
        alertedAt
      };
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[alert-job] impossibile leggere fallback recovery legacy:', error.message);
    }
  }

  const memoryState = inMemoryNotificationState[ALERT_TYPE];
  const alertLastUpdate = toDateOrNull(memoryState?.lastUpdateIso);
  if (!alertLastUpdate || alertLastUpdate.getTime() >= recoveredAt.getTime()) {
    return null;
  }

  if (await hasRecoveryNotificationForAlert(alertLastUpdate)) {
    return null;
  }

  return {
    alertLastUpdate,
    alertedAt: toDateOrNull(memoryState?.createdAt)
  };
}

async function rememberNotification(notificationType, recipient, metadata = {}) {
  const now = new Date();
  inMemoryNotificationState[notificationType] = {
    createdAt: now.toISOString(),
    lastUpdateIso: toIsoOrNull(metadata.lastUpdate),
    alertLastUpdateIso: toIsoOrNull(metadata.alertLastUpdate),
    recoveredAtIso: toIsoOrNull(metadata.recoveredAt)
  };

  try {
    await query(
      `INSERT INTO notification_log (notification_type, channel, recipient, metadata, created_at)
       VALUES (?, 'email', ?, ?, ?)`,
      [notificationType, recipient, JSON.stringify(metadata), now.toISOString()]
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
    `Intervallo router previsto: ${getExpectedDataMinutes()} minuti`,
    `Stato offline sul sito dopo: ${getOfflineAfterMinutes()} minuti`,
    `Soglia email alert: ${getMissingDataThresholdMinutes()} minuti`,
    '',
    'Possibile problema: credito SIM insufficiente, SIM non attiva oppure anomalia del router/DTU/broker.',
    'Azione consigliata: recarsi in campo oppure ricaricare la SIM e verificare la connettività del router.'
  ];

  if (options.isTest) {
    lines.unshift('Questo è un messaggio di prova inviato manualmente per verificare il canale di alert del router.', '');
  }

  return lines.join('\n');
}

function getRecoveryDowntimeMinutes(alertLastUpdate, recoveredAt) {
  if (!alertLastUpdate || !recoveredAt) {
    return null;
  }

  return Math.max(1, Math.round((recoveredAt.getTime() - alertLastUpdate.getTime()) / 60000));
}

function buildRecoveryText(alertLastUpdate, recoveredAt, options = {}) {
  const alertLastUpdateText = alertLastUpdate ? alertLastUpdate.toISOString() : 'non disponibile';
  const recoveredAtText = recoveredAt ? recoveredAt.toISOString() : 'non disponibile';
  const downtimeMinutes = getRecoveryDowntimeMinutes(alertLastUpdate, recoveredAt);
  const lines = [
    'RAYAT ha rilevato la ripresa della ricezione dati sensore.',
    '',
    `Ultimo dato ricevuto prima dell’interruzione: ${alertLastUpdateText}`,
    `Primo nuovo dato ricevuto: ${recoveredAtText}`,
    `Durata stimata dell’interruzione: ${downtimeMinutes ?? 'non disponibile'} minuti`,
    `Intervallo router previsto: ${getExpectedDataMinutes()} minuti`,
    `Soglia email alert: ${getMissingDataThresholdMinutes()} minuti`,
    '',
    'Il sistema risulta di nuovo online e sta ricevendo nuovi dati.'
  ];

  if (options.isTest) {
    lines.unshift('Questo è un messaggio di prova inviato manualmente per verificare il canale di recovery del router.', '');
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

function getEnvAlertMailConfig() {
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

async function getDbAlertMailConfig(options = {}) {
  const shouldRefresh = Boolean(options.forceRefresh);
  const cacheAgeMs = Date.now() - mailConfigCache.loadedAt;

  if (!shouldRefresh && mailConfigCache.values && cacheAgeMs < 60 * 1000) {
    return mailConfigCache.values;
  }

  if (hasRuntimeConfigTable === null) {
    const rows = await query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = 'runtime_config'
       ) AS exists`
    );
    hasRuntimeConfigTable = Boolean(rows?.[0]?.exists);
  }

  if (!hasRuntimeConfigTable) {
    mailConfigCache.loadedAt = Date.now();
    mailConfigCache.values = {};
    return {};
  }

  const rows = await query(
    `SELECT config_key, config_value
     FROM runtime_config
     WHERE config_key IN (?, ?, ?, ?, ?)`,
    ALERT_MAIL_RUNTIME_KEYS
  );
  const entries = Object.fromEntries(
    rows.map((row) => [String(row.config_key || '').trim(), String(row.config_value || '').trim()])
  );
  const host = entries.smtp_host || '';
  const port = Number.parseInt(entries.smtp_port || '', 10);
  const user = entries.smtp_user || '';
  const pass = entries.smtp_pass || '';
  const from = entries.smtp_from || user || 'no-reply@rayat.local';

  mailConfigCache.loadedAt = Date.now();
  mailConfigCache.values = {
    host,
    port: Number.isFinite(port) ? port : null,
    user,
    pass,
    from,
    service: inferMailService(user)
  };

  return mailConfigCache.values;
}

async function resolveAlertMailConfig(options = {}) {
  const envConfig = getEnvAlertMailConfig();
  const dbConfig = await getDbAlertMailConfig(options);
  const host = envConfig.host || dbConfig.host || '';
  const port = envConfig.port || dbConfig.port || null;
  const user = envConfig.user || dbConfig.user || '';
  const pass = envConfig.pass || dbConfig.pass || '';
  const from =
    envConfig.from && envConfig.from !== 'no-reply@rayat.local'
      ? envConfig.from
      : (dbConfig.from || envConfig.from);
  const service = inferMailService(user);

  const source = envConfig.user && envConfig.pass
    ? 'env'
    : (dbConfig.user && dbConfig.pass ? 'database' : 'missing');

  runtimeState.smtpConfigSource = source;

  return {
    host,
    port,
    user,
    pass,
    from,
    service,
    source
  };
}

async function createMailTransport(options = {}) {
  const mailConfig = await resolveAlertMailConfig(options);
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

async function hasConfiguredSmtp(options = {}) {
  const mailConfig = await resolveAlertMailConfig(options);
  return Boolean(
    mailConfig.user
    && mailConfig.pass
    && (
      (mailConfig.host && Number.isFinite(mailConfig.port))
      || mailConfig.service
    )
  );
}

async function deliverNotificationEmail(notificationType, subject, body, metadata = {}, options = {}) {
  const recipients = getAlertRecipients();

  if (!options.forceSmtp && process.env.NODE_ENV !== 'production') {
    console.log(`[alert-job] [DEV] ${subject}`);
    console.log(`[alert-job] [DEV] Destinatari: ${recipients.recipients.join(', ') || 'nessuno configurato'}`);
    console.log(body);
    for (const recipient of recipients.recipients) {
      await rememberNotification(notificationType, recipient, {
        ...metadata,
        mode: options.isTest ? 'development_test' : 'development',
        isTest: Boolean(options.isTest),
        trigger: options.trigger || 'development'
      });
    }
    return;
  }

  const transporter = await createMailTransport(options);
  if (!transporter) {
    throw new Error('SMTP non configurato: imposta SMTP_HOST/SMTP_PORT oppure EMAIL_USER/EMAIL_PASS compatibili, più il mittente.');
  }

  const mailConfig = await resolveAlertMailConfig(options);
  const from = mailConfig.from;

  const sendEmail = async (recipient) => {
    await transporter.sendMail({
      from,
      to: recipient,
      subject,
      text: body
    });
    await rememberNotification(notificationType, recipient, {
      ...metadata,
      mode: options.isTest ? 'smtp_test' : 'smtp',
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
      console.log(`[alert-job] Notifica email (${notificationType}) inviata a ${recipient}`);
    } catch (error) {
      failedRecipients.push({ recipient, error });
      console.warn(`[alert-job] Invio notifica (${notificationType}) fallito per ${recipient}:`, error.message);
    }
  }

  if (failedRecipients.length === recipients.recipients.length) {
    const aggregatedError = new Error(`Invio notifica ${notificationType} fallito per tutti i destinatari configurati.`);
    aggregatedError.details = failedRecipients.map(({ recipient, error }) => ({
      recipient,
      message: error.message
    }));
    throw aggregatedError;
  }
}

async function deliverAlertEmail(lastUpdate, minutesSinceLastData, options = {}) {
  const subject = buildAlertSubject(options);
  const body = buildAlertText(lastUpdate, minutesSinceLastData, options);
  const alertDueAt = getAlertDueDate(lastUpdate);

  await deliverNotificationEmail(
    ALERT_TYPE,
    subject,
    body,
    {
      minutesSinceLastData,
      lastUpdate: lastUpdate ? lastUpdate.toISOString() : null,
      alertDueAt: alertDueAt ? alertDueAt.toISOString() : null
    },
    options
  );
}

async function deliverRecoveryEmail(alertLastUpdate, recoveredAt, options = {}) {
  const subject = buildRecoverySubject(options);
  const body = buildRecoveryText(alertLastUpdate, recoveredAt, options);
  const downtimeMinutes = getRecoveryDowntimeMinutes(alertLastUpdate, recoveredAt);
  const metadata = {
    alertLastUpdate: alertLastUpdate ? alertLastUpdate.toISOString() : null,
    recoveredAt: recoveredAt ? recoveredAt.toISOString() : null,
    downtimeMinutes
  };

  if (options.readingTimestamp) {
    metadata.readingTimestamp = options.readingTimestamp;
  }

  await deliverNotificationEmail(
    RECOVERY_ALERT_TYPE,
    subject,
    body,
    metadata,
    options
  );
}

async function maybeSendRecoveryEmail(recoveredAt, options = {}) {
  const normalizedRecoveredAt = toDateOrNull(recoveredAt);
  if (!normalizedRecoveredAt) {
    return false;
  }

  const pendingAlert = await getPendingRecoveryAlert(normalizedRecoveredAt);
  if (!pendingAlert?.alertLastUpdate) {
    return false;
  }

  await deliverRecoveryEmail(pendingAlert.alertLastUpdate, normalizedRecoveredAt, {
    ...options,
    trigger: options.trigger || 'recovery'
  });

  return true;
}

async function sendMissingDataTestEmail(options = {}) {
  const thresholdMinutes = getMissingDataThresholdMinutes();
  const requestedMinutes = Number.parseInt(String(options.minutesSinceLastData ?? ''), 10);
  const minutesSinceLastData = Number.isFinite(requestedMinutes) && requestedMinutes > thresholdMinutes
    ? requestedMinutes
    : thresholdMinutes + 1;
  const lastUpdate = new Date(Date.now() - (minutesSinceLastData * 60 * 1000));

  if (!await hasConfiguredSmtp({ forceRefresh: true })) {
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

    await maybeSendRecoveryEmail(lastUpdate, {
      trigger: options.trigger ? `${options.trigger}_recovery` : 'sync_recovery'
    });

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

async function notifyMissingDataHeartbeat(timestamp) {
  const receivedAt = new Date();
  const readingTimestamp = toDateOrNull(timestamp);
  const lastUpdate = receivedAt;
  const currentLastKnown = toDateOrNull(runtimeState.lastKnownDataAt);

  if (currentLastKnown && lastUpdate.getTime() < currentLastKnown.getTime()) {
    return;
  }

  await maybeSendRecoveryEmail(lastUpdate, {
    trigger: 'ingest_recovery',
    readingTimestamp: readingTimestamp ? readingTimestamp.toISOString() : null
  });

  scheduleExactAlertTimeout(lastUpdate, { trigger: 'ingest' });
}

async function getMissingDataAlertRuntimeStatus(options = {}) {
  const mailConfig = await resolveAlertMailConfig(options);
  const monitoringConfig = getMonitoringConfig();

  return {
    mode: 'exact_timer_plus_minute_sync',
    cron: getAlertCronExpression(),
    configSource: monitoringConfig.configSource,
    routerIntervalMinutes: monitoringConfig.routerIntervalMinutes,
    expectedDataMinutes: monitoringConfig.expectedDataMinutes,
    offlineGraceMinutes: monitoringConfig.offlineGraceMinutes,
    offlineAfterMinutes: monitoringConfig.offlineAfterMinutes,
    alertExtraMinutes: monitoringConfig.alertExtraMinutes,
    emailAfterMinutes: monitoringConfig.emailAfterMinutes,
    missingDataThresholdMinutes: monitoringConfig.missingDataThresholdMinutes,
    notificationCooldownMinutes: getNotificationCooldownMinutes(),
    smtpConfigured: Boolean(
      mailConfig.user
      && mailConfig.pass
      && (
        (mailConfig.host && Number.isFinite(mailConfig.port))
        || mailConfig.service
      )
    ),
    smtpConfigSource: mailConfig.source,
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
  buildRecoveryText,
  buildRecoverySubject,
  getMissingDataAlertRuntimeStatus,
  hasConfiguredSmtp,
  maybeSendRecoveryEmail,
  notifyMissingDataHeartbeat,
  runMissingDataAlertCheck,
  sendMissingDataTestEmail,
  syncMissingDataAlertSchedule,
  startMissingDataAlertJob
};
