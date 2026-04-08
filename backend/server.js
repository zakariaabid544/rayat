const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
require('./config/env');
const { getDatabaseHealth, testConnection, query } = require('./config/database');
const { ensurePlatformSchema } = require('./utils/platform-schema');
const { ensureSuperAdmin } = require('./utils/super-admin');
const { startMissingDataAlertJob } = require('./src/jobs/alertJob');
const {
    extractAdminSessionToken,
    isPrivilegedAdminRole,
    normalizeAdminRole
} = require('./utils/admin-auth');

// Inizializza Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logger middleware
app.use((req, res, next) => {
    if (process.env.NODE_ENV !== 'production') {
        console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    }
    next();
});

const rateLimit = require('express-rate-limit');

const iotLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minuto
  max: 60,               // max 60 richieste per minuto per IP
  message: { error: 'Troppe richieste, riprova tra un minuto' }
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/sensors/simple', require('./routes/simple')); // Simplified API format - registered broad first
app.use('/api/sensors/update', iotLimiter);
app.use('/api/sensors', require('./routes/sensors'));
app.use('/api/iot/upload', iotLimiter);
app.use('/api/iot', require('./routes/iot'));
app.use('/api/admin', require('./routes/admin'));

const adminIndexPath = path.join(__dirname, '../admin/index.html');
const publicIndexPath = path.join(__dirname, '../index.html');

async function requireProtectedAdminPage(req, res, next) {
    const token = extractAdminSessionToken(req);
    if (!token) {
        return res.redirect('/admin/');
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const tokenRole = normalizeAdminRole(decoded.role);
        const rows = await query(
            'SELECT id, role, active FROM users WHERE id = ?',
            [decoded.id]
        );

        if (!rows.length || !rows[0].active) {
            return res.redirect('/admin/');
        }

        const normalizedRole = normalizeAdminRole(rows[0].role);
        if (!isPrivilegedAdminRole(tokenRole) || !isPrivilegedAdminRole(normalizedRole)) {
            return res.redirect('/admin/');
        }

        if (normalizedRole !== tokenRole) {
            return res.redirect('/admin/');
        }

        req.adminPageUser = {
            id: rows[0].id,
            role: normalizedRole
        };
        next();
    } catch (error) {
        return res.redirect('/admin/');
    }
}

app.get(
    [
        '/admin/clients',
        '/admin/clients/',
        '/admin/clients.html',
        '/admin/recent-clients',
        '/admin/recent-clients/',
        '/admin/recent-clients.html',
        '/admin/sensors',
        '/admin/sensors/',
        '/admin/sensors.html',
        '/admin/devices',
        '/admin/devices/',
        '/admin/devices.html',
        '/admin/analytics',
        '/admin/analytics/',
        '/admin/analytics.html'
    ],
    requireProtectedAdminPage,
    (req, res) => {
        res.sendFile(adminIndexPath);
    }
);

// Admin Panel static files
app.use('/admin', express.static(path.join(__dirname, '../admin')));

// Public site static files (icons, manifest, sw.js, etc.)
app.use('/icons', express.static(path.join(__dirname, '../icons')));
app.use(express.static(path.join(__dirname, '../'), {
    index: false  // we handle / manually below
}));

app.get(['/demo', '/demo/'], (_req, res) => {
    res.redirect(302, '/dashboard');
});

app.get(['/demo/:sensor(acqua|energia|terreno|clima)', '/demo/:sensor(acqua|energia|terreno|clima)/'], (req, res) => {
    res.redirect(302, `/dashboard/${req.params.sensor}`);
});

function shouldServePublicApp(req) {
    if (req.method !== 'GET') {
        return false;
    }

    if (
        req.path.startsWith('/api')
        || req.path.startsWith('/admin')
        || req.path.startsWith('/icons')
    ) {
        return false;
    }

    if (path.extname(req.path)) {
        return false;
    }

    const acceptHeader = String(req.headers.accept || '');
    return !acceptHeader || acceptHeader.includes('text/html') || acceptHeader.includes('*/*');
}

app.get('*', (req, res, next) => {
    if (!shouldServePublicApp(req)) {
        return next();
    }

    return res.sendFile(publicIndexPath);
});

// API info (moved to /api)
app.get('/api', (req, res) => {
    res.json({
        name: 'Rayat IoT API',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            auth: '/api/auth',
            sensors: '/api/sensors',
            iot: '/api/iot'
        }
    });
});

// Health check endpoint
app.get(['/api/health', '/health'], async (req, res) => {
    const health = await getDatabaseHealth();
    res.status(health.db === 'ok' ? 200 : 503).json(health);
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint non trovato' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        error: 'Errore interno del server',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Avvia server
async function startServer() {
    try {
        // Test connessione database
        const dbConnected = await testConnection();

        if (!dbConnected) {
            console.warn('⚠️  ATTENZIONE: Database non connesso. Alcune funzionalità potrebbero non funzionare.');
            console.warn('   Verifica DATABASE_URL e assicurati che PostgreSQL Render sia raggiungibile.');
        } else {
            try {
                const schemaChanges = await ensurePlatformSchema();
                if (schemaChanges.length > 0) {
                    console.log(`🛠️  Schema Rayat aggiornato: ${schemaChanges.join(', ')}`);
                }
            } catch (schemaError) {
                console.warn('⚠️  Impossibile completare l\'allineamento automatico dello schema:', schemaError.message);
            }

            try {
                await ensureSuperAdmin();
            } catch (superAdminError) {
                console.warn('⚠️  Impossibile completare il bootstrap del super admin:', superAdminError.message);
            }
        }

        // Avvia server
        app.listen(PORT, () => {
            console.log('');
            console.log('🌾 ========================================');
            console.log('   RAYAT IoT Platform - Backend API');
            console.log('   ========================================');
            console.log('');
            console.log(`   🚀 Server in esecuzione su: http://localhost:${PORT}`);
            console.log(`   📊 Health check: http://localhost:${PORT}/api/health`);
            console.log(`   🔐 Auth endpoint: http://localhost:${PORT}/api/auth`);
            console.log(`   📡 Sensors endpoint: http://localhost:${PORT}/api/sensors`);
            console.log(`   🌐 IoT endpoint: http://localhost:${PORT}/api/iot`);
            console.log('');
            console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`   Database: ${dbConnected ? '✅ Connected' : '❌ Disconnected'}`);
            console.log('');
            console.log('   Premi CTRL+C per fermare il server');
            console.log('========================================');
            console.log('');
        });

        if (dbConnected) {
            startMissingDataAlertJob();
        } else {
            console.warn('[alert-job] Job notifiche non avviato: database non disponibile.');
        }

    } catch (error) {
        console.error('❌ Errore avvio server:', error);
        process.exit(1);
    }
}

// Gestione shutdown graceful
process.on('SIGTERM', () => {
    console.log('SIGTERM ricevuto, chiusura server...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\nSIGINT ricevuto, chiusura server...');
    process.exit(0);
});

// Avvia server
startServer();

module.exports = app;
