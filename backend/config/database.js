const { Pool } = require('pg');
require('./env');

const schemaCache = {
  columns: new Map(),
  indexes: new Map()
};

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const dbConfig = {
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
};

const pool = databaseUrl ? new Pool(dbConfig) : null;
let hasLoggedConnection = false;

if (pool) {
  pool.on('error', (error) => {
    console.error('❌ PostgreSQL pool error:', error);
  });
}

function ensurePool() {
  if (!pool) {
    throw new Error('DATABASE_URL is not set. Configure the PostgreSQL connection string.');
  }

  return pool;
}

function replaceQuestionPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function formatIntervalLiteral(amount, unit) {
  const normalizedAmount = Number(amount);
  const normalizedUnit = String(unit || '').trim().toLowerCase();
  const suffix = normalizedAmount === 1 ? normalizedUnit : `${normalizedUnit}s`;
  return `${normalizedAmount} ${suffix}`;
}

function normalizeSql(rawSql) {
  let sql = String(rawSql || '').replace(/`/g, '');

  sql = sql.replace(
    /GROUP_CONCAT\(\s*DISTINCT\s+(.+?)\s+ORDER BY\s+(.+?)\s+SEPARATOR\s+',+'\s*\)/gis,
    (_match, expr, orderExpr) =>
      `STRING_AGG(DISTINCT (${expr})::text, ',' ORDER BY (${orderExpr})::text)`
  );
  sql = sql.replace(
    /GROUP_CONCAT\(\s*DISTINCT\s+(.+?)\s+SEPARATOR\s+',+'\s*\)/gis,
    (_match, expr) => `STRING_AGG(DISTINCT (${expr})::text, ',')`
  );
  sql = sql.replace(
    /GROUP_CONCAT\(\s*(.+?)\s+SEPARATOR\s+',+'\s*\)/gis,
    (_match, expr) => `STRING_AGG((${expr})::text, ',')`
  );

  sql = sql.replace(/\bREGEXP\b/gi, '~');
  sql = sql.replace(/CAST\(([^)]+?)\s+AS\s+UNSIGNED\)/gi, 'CAST($1 AS INTEGER)');
  sql = sql.replace(/\b(active|enabled|acknowledged|is_verified)\s*=\s*1\b/gi, '$1 = TRUE');
  sql = sql.replace(/\b(active|enabled|acknowledged|is_verified)\s*=\s*0\b/gi, '$1 = FALSE');
  sql = sql.replace(
    /ON DUPLICATE KEY UPDATE\s+value = VALUES\(value\),\s*timestamp = VALUES\(timestamp\)/gi,
    "ON CONFLICT (sensor_id) DO UPDATE SET value = EXCLUDED.value, timestamp = EXCLUDED.timestamp, updated_at = CURRENT_TIMESTAMP"
  );

  sql = replaceQuestionPlaceholders(sql);

  sql = sql.replace(
    /LIMIT\s+\$(\d+)\s*,\s*\$(\d+)/gi,
    (_match, offsetIndex, limitIndex) => `LIMIT $${limitIndex} OFFSET $${offsetIndex}`
  );
  sql = sql.replace(
    /LIMIT\s+(\d+)\s*,\s*(\d+)/gi,
    (_match, offset, limit) => `LIMIT ${limit} OFFSET ${offset}`
  );
  sql = sql.replace(
    /DATE_SUB\(NOW\(\),\s*INTERVAL\s+\$(\d+)\s+(DAY|MINUTE|HOUR|MONTH|YEAR)\)/gi,
    (_match, valueIndex, unit) => `NOW() - ($${valueIndex} * INTERVAL '1 ${String(unit).toLowerCase()}')`
  );
  sql = sql.replace(
    /DATE_SUB\(NOW\(\),\s*INTERVAL\s+(\d+)\s+(DAY|MINUTE|HOUR|MONTH|YEAR)\)/gi,
    (_match, amount, unit) => `NOW() - INTERVAL '${formatIntervalLiteral(amount, unit)}'`
  );
  sql = sql.replace(
    /FIND_IN_SET\(\$(\d+),\s*([^)]+)\)/gi,
    (_match, valueIndex, columnExpr) =>
      `$${valueIndex} = ANY(string_to_array(COALESCE(${columnExpr}, ''), ','))`
  );

  return sql;
}

function shouldReturnInsertId(sql) {
  const match = sql.match(/^\s*INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/i);
  if (!match || /\bRETURNING\b/i.test(sql)) {
    return false;
  }

  return !['sensor_latest', 'public_sensor_latest'].includes(match[1].toLowerCase());
}

function isSelectQuery(sql) {
  return /^\s*(SELECT|WITH)\b/i.test(sql);
}

async function runQuery(client, rawSql, params = []) {
  const translatedSql = normalizeSql(rawSql);
  const finalSql = shouldReturnInsertId(translatedSql)
    ? `${translatedSql} RETURNING id`
    : translatedSql;
  const result = await client.query(finalSql, params);

  if (isSelectQuery(finalSql)) {
    return result.rows;
  }

  if (/^\s*INSERT\b/i.test(finalSql) && /\bRETURNING\b/i.test(finalSql)) {
    return {
      insertId: result.rows[0] ? result.rows[0].id : null,
      affectedRows: result.rowCount,
      rows: result.rows
    };
  }

  return {
    affectedRows: result.rowCount,
    rows: result.rows
  };
}

async function getDatabaseHealth() {
  if (!databaseUrl) {
    return {
      db: 'error',
      reason: 'DATABASE_URL is not set'
    };
  }

  let client;
  try {
    client = await ensurePool().connect();
    await client.query('SELECT 1');

    if (!hasLoggedConnection) {
      console.log('✅ Database connected');
      hasLoggedConnection = true;
    }

    return { db: 'ok' };
  } catch (error) {
    return {
      db: 'error',
      reason: error.message
    };
  } finally {
    if (client) {
      client.release();
    }
  }
}

async function testConnection() {
  const health = await getDatabaseHealth();

  if (health.db === 'ok') {
    return true;
  }

  console.error('❌ Database connection failed:', health.reason);
  return false;
}

async function query(sql, params = []) {
  try {
    return await runQuery(ensurePool(), sql, params);
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

async function getTableColumns(tableName) {
  const cacheKey = `${databaseUrl}:${tableName}`;
  if (schemaCache.columns.has(cacheKey)) {
    return schemaCache.columns.get(cacheKey);
  }

  const result = await ensurePool().query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1`,
    [tableName]
  );

  const columns = new Set(result.rows.map((row) => row.column_name));
  schemaCache.columns.set(cacheKey, columns);
  return columns;
}

async function getTableIndexes(tableName) {
  const cacheKey = `${databaseUrl}:${tableName}`;
  if (schemaCache.indexes.has(cacheKey)) {
    return schemaCache.indexes.get(cacheKey);
  }

  const result = await ensurePool().query(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = $1`,
    [tableName]
  );

  const indexes = new Set(result.rows.map((row) => row.indexname));
  schemaCache.indexes.set(cacheKey, indexes);
  return indexes;
}

function clearSchemaCache() {
  schemaCache.columns.clear();
  schemaCache.indexes.clear();
}

async function withTransaction(handler) {
  const client = await ensurePool().connect();

  const connection = {
    execute: async (sql, params = []) => [await runQuery(client, sql, params)],
    query: async (sql, params = []) => [await runQuery(client, sql, params)]
  };

  try {
    await client.query('BEGIN');
    const result = await handler(connection);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  dbConfig,
  pool,
  query,
  getDatabaseHealth,
  testConnection,
  getTableColumns,
  getTableIndexes,
  clearSchemaCache,
  withTransaction
};
