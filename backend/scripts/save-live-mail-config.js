#!/usr/bin/env node

require('../config/env');

const { query } = require('../config/database');
const { ensurePlatformSchema } = require('../utils/platform-schema');

const CONFIG_ENTRIES = [
  { key: 'smtp_host', value: String(process.env.SMTP_HOST || '').trim(), secret: false },
  { key: 'smtp_port', value: String(process.env.SMTP_PORT || '').trim(), secret: false },
  { key: 'smtp_user', value: String(process.env.SMTP_USER || process.env.EMAIL_USER || '').trim(), secret: false },
  { key: 'smtp_pass', value: String(process.env.SMTP_PASS || process.env.EMAIL_PASS || '').trim(), secret: true },
  { key: 'smtp_from', value: String(process.env.SMTP_FROM || process.env.EMAIL_FROM || '').trim(), secret: false }
];

async function main() {
  const missing = CONFIG_ENTRIES.filter((entry) => !entry.value).map((entry) => entry.key);
  if (missing.length) {
    throw new Error(`Configurazione email incompleta nel backend/.env: mancano ${missing.join(', ')}`);
  }

  await ensurePlatformSchema();

  for (const entry of CONFIG_ENTRIES) {
    await query(
      `INSERT INTO runtime_config (config_key, config_value, is_secret, updated_at)
       VALUES (?, ?, ?, NOW())
       ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value,
           is_secret = EXCLUDED.is_secret,
           updated_at = NOW()
       RETURNING config_key`,
      [entry.key, entry.value, entry.secret]
    );
  }

  console.log('[runtime-config] Configurazione email live salvata nel database.');
}

main().catch((error) => {
  console.error('[runtime-config] Salvataggio fallito:', error.message);
  process.exit(1);
});
