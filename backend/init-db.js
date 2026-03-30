require('./config/env');

const { pool, testConnection } = require('./config/database');
const { ensurePlatformSchema } = require('./utils/platform-schema');
const { ensureSuperAdmin } = require('./utils/super-admin');

(async () => {
  try {
    const connected = await testConnection();
    if (!connected) {
      throw new Error('PostgreSQL connection failed');
    }

    const schemaChanges = await ensurePlatformSchema();
    if (schemaChanges.length > 0) {
      console.log(`✅ Schema ensured: ${schemaChanges.join(', ')}`);
    } else {
      console.log('ℹ️ Schema already up to date');
    }

    await ensureSuperAdmin();
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Init failed:', error);
    if (pool) {
      await pool.end().catch(() => {});
    }
    process.exit(1);
  }
})();
