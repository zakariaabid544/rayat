/**
 * Rayat Admin Seeder
 * Creates the default super_admin user from backend/.env
 * Run: node seed-admin.js
 */
require('./config/env');

const { ensurePlatformSchema } = require('./utils/platform-schema');
const { ensureSuperAdmin } = require('./utils/super-admin');

async function seedAdmin() {
    try {
        await ensurePlatformSchema();
        await ensureSuperAdmin();
        console.log('');
        console.log('🔐 Admin Panel: http://localhost:3000/admin');
        console.log('');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeder error:', error);
        process.exit(1);
    }
}

seedAdmin();
