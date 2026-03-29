const mysql = require('mysql2/promise');
require('dotenv').config();

const schemaCache = {
  columns: new Map(),
  indexes: new Map()
};

// Configurazione pool di connessioni MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'rayat_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// Test connessione al database
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Database connesso con successo!');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Errore connessione database:', error.message);
    return false;
  }
}

// Helper per query con gestione errori
async function query(sql, params) {
  try {
    const [results] = await pool.execute(sql, params);
    return results;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

async function getTableColumns(tableName) {
  const cacheKey = `${process.env.DB_NAME || 'rayat_db'}:${tableName}`;
  if (schemaCache.columns.has(cacheKey)) {
    return schemaCache.columns.get(cacheKey);
  }

  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );

  const columns = new Set(rows.map((row) => row.COLUMN_NAME));
  schemaCache.columns.set(cacheKey, columns);
  return columns;
}

async function getTableIndexes(tableName) {
  const cacheKey = `${process.env.DB_NAME || 'rayat_db'}:${tableName}`;
  if (schemaCache.indexes.has(cacheKey)) {
    return schemaCache.indexes.get(cacheKey);
  }

  const [rows] = await pool.execute(
    `SELECT DISTINCT INDEX_NAME
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );

  const indexes = new Set(rows.map((row) => row.INDEX_NAME));
  schemaCache.indexes.set(cacheKey, indexes);
  return indexes;
}

function clearSchemaCache() {
  schemaCache.columns.clear();
  schemaCache.indexes.clear();
}

async function withTransaction(handler) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  pool,
  query,
  testConnection,
  getTableColumns,
  getTableIndexes,
  clearSchemaCache,
  withTransaction
};
