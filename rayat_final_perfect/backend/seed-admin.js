/**
 * Rayat Admin Seeder
 * Creates the default super_admin user from .env
 * Run: node seed-admin.js
 * Safe to re-run — checks if user already exists first.
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');

async function seedAdmin() {
    const email = process.env.ADMIN_DEFAULT_EMAIL;
    const password = process.env.ADMIN_DEFAULT_PASSWORD;

    if (!email || !password || password === 'CHANGE_THIS_PASSWORD') {
        console.error('❌ ERROR: Set ADMIN_DEFAULT_EMAIL and ADMIN_DEFAULT_PASSWORD in .env before running this script.');
        console.error('   ADMIN_DEFAULT_PASSWORD must NOT be "CHANGE_THIS_PASSWORD".');
        process.exit(1);
    }

    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'rayat_db',
    });

    try {
        console.log('🔄 Esecuzione estensione ruoli nel database...');
        try {
            await pool.query(`ALTER TABLE users MODIFY COLUMN role ENUM('admin', 'client', 'farmer', 'operator', 'operator_admin', 'super_admin') NOT NULL DEFAULT 'client'`);
            console.log('   ✅ Ruoli aggiornati con successo.');
        } catch (mErr) {
            console.log('   ℹ️ (I ruoli potrebbero essere già aggiornati o tabella assente)');
        }

        const [rows] = await pool.execute('SELECT id, role FROM users WHERE email = ?', [email]);

        if (rows.length > 0) {
            const existing = rows[0];
            if (existing.role === 'super_admin') {
                console.log(`✅ super_admin già presente: ${email} (id: ${existing.id})`);
            } else {
                console.warn(`⚠️  Esiste già un utente con email ${email} ma ruolo "${existing.role}". Nessuna modifica automatica eseguita.`);
            }
        } else {
            const passwordHash = await bcrypt.hash(password, 12);
            await pool.execute(
                `INSERT INTO users (email, password_hash, name, role, is_verified, active) VALUES (?, ?, ?, ?, ?, ?)`,
                [email, passwordHash, 'Super Admin', 'super_admin', true, true]
            );
            console.log(`✅ super_admin user created: ${email}`);
        }

        console.log('');
        console.log('🔐 Admin Panel: http://localhost:3000/admin');
        console.log('');
    } catch (error) {
        console.error('❌ Seeder error:', error);
        process.exit(1);
    }

    await pool.end();
    process.exit(0);
}

seedAdmin();
