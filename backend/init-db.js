const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('./config/env');

(async () => {
    try {
        const parsedPort = Number.parseInt(process.env.DB_PORT, 10);
        const dbHost = process.env.DB_HOST || '127.0.0.1';
        const dbPort = Number.isFinite(parsedPort) ? parsedPort : 3306;
        const dbUser = process.env.DB_USER || 'root';
        const dbPassword = process.env.DB_PASSWORD || '';
        const dbName = process.env.DB_NAME || 'rayat_db';

        console.log(`Connecting to MySQL on ${dbHost}:${dbPort}...`);
        const pool = mysql.createPool({
            host: dbHost,
            port: dbPort,
            user: dbUser,
            password: dbPassword
        });
        await pool.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
        console.log(`✅ Created ${dbName}`);
        await pool.end();

        const dbPool = mysql.createPool({
            host: dbHost,
            port: dbPort,
            user: dbUser,
            password: dbPassword,
            database: dbName,
            multipleStatements: true
        });
        const schemaPath = path.join(__dirname, '../database/schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await dbPool.query(`SET FOREIGN_KEY_CHECKS = 0;\n${schema}\nSET FOREIGN_KEY_CHECKS = 1;`);
        console.log('✅ Schema imported successfully');
        
        await dbPool.end();
        process.exit(0);
    } catch(e) {
        console.error('❌ Connection failed:', e.message);
        process.exit(1);
    }
})();
