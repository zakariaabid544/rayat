const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

(async () => {
    try {
        console.log("Connecting to MAMP MySQL on 127.0.0.1:8889...");
        const pool = mysql.createPool({ host: '127.0.0.1', port: 8889, user: 'root', password: 'root' });
        await pool.query('CREATE DATABASE IF NOT EXISTS rayat_db');
        console.log("✅ Created rayat_db");
        await pool.end();

        const dbPool = mysql.createPool({ host: '127.0.0.1', port: 8889, user: 'root', password: 'root', database: 'rayat_db', multipleStatements: true });
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
