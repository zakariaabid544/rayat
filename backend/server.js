const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // RAYAT-FIX
const path = require('path');
const jwt = require('jsonwebtoken');
require('./config/env');
const { testConnection, query } = require('./config/database'); // RAYAT-FIX
const { ensurePlatformSchema } = require('./utils/platform-schema');
const { ensureSuperAdmin } = require('./utils/super-admin');
const {
    startMissingDataAlertJob
} = require('./src/jobs/alertJob'); // RAYAT-FIX
const {
    startMqttDirectJob,
    stopMqttDirectJob
} = require('./src/jobs/mqttDirectJob'); // RAYAT-FIX
const {
    startAgroEventsJob,
    stopAgroEventsJob
} = require('./src/jobs/agroEventsJob'); // RAYAT-FIX agro intelligence (Sprint 1.1-1.3, default OFF)
const {
    startPatternDiscoveryJob,
    stopPatternDiscoveryJob
} = require('./src/jobs/patternDiscoveryJob'); // RAYAT-FIX agro intelligence (Sprint 2.1 pattern discovery, default OFF)
const {
    startIntelligenceChainJob,
    stopIntelligenceChainJob
} = require('./src/jobs/intelligenceChainJob'); // RAYAT-FIX agro intelligence (Sprint 2.2-2.5 intelligence chain, default OFF)
const {
    extractAdminSessionToken,
    isPrivilegedAdminRole,
    normalizeAdminRole
} = require('./utils/admin-auth');

// Inizializza Express
const app = express();
const PORT = process.env.PORT || 3000;
let httpServer = null;
let shutdownInProgress = false;

// Middleware
app.disable('x-powered-by'); // RAYAT-FIX
app.use(helmet({ // RAYAT-FIX
    contentSecurityPolicy: { // RAYAT-FIX
        useDefaults: false, // RAYAT-FIX
        directives: { // RAYAT-FIX
            defaultSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", '*'] // RAYAT-FIX
        } // RAYAT-FIX
    }, // RAYAT-FIX
    strictTransportSecurity: { // RAYAT-FIX
        maxAge: 31536000 // RAYAT-FIX
    }, // RAYAT-FIX
    xContentTypeOptions: true, // RAYAT-FIX
    xFrameOptions: { // RAYAT-FIX
        action: 'deny' // RAYAT-FIX
    }, // RAYAT-FIX
    referrerPolicy: { // RAYAT-FIX
        policy: 'strict-origin-when-cross-origin' // RAYAT-FIX
    } // RAYAT-FIX
})); // RAYAT-FIX
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Optional HTTP logger for local debugging only
app.use((req, res, next) => {
    if (process.env.RAYAT_HTTP_LOGS === 'true') {
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

const webRootPath = path.join(__dirname, '../web');
const adminRootPath = path.join(webRootPath, 'admin');
const adminIndexPath = path.join(adminRootPath, 'index.html');
const publicIndexPath = path.join(webRootPath, 'index.html');

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
app.use('/admin', express.static(adminRootPath));

// Canonical public frontend source: ./web
app.use(express.static(webRootPath, {
    index: false  // we handle / manually below
}));

// RAYAT-FIX: public health check intentionally exposes no operational detail.
app.get(['/api/health', '/health'], (_req, res) => { // RAYAT-FIX
    res.json({ status: 'ok' }); // RAYAT-FIX
}); // RAYAT-FIX

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
            console.warn('   Verifica DATABASE_URL e assicurati che PostgreSQL sia raggiungibile sul server configurato.');
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
        httpServer = app.listen(PORT, () => {
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
            startMqttDirectJob();
            startAgroEventsJob();
            startPatternDiscoveryJob();
            startIntelligenceChainJob();
        } else {
            console.warn('[alert-job] Job notifiche non avviato: database non disponibile.');
            console.warn('[mqtt-direct] Ingest MQTT diretto non avviato: database non disponibile.');
        }

    } catch (error) {
        console.error('❌ Errore avvio server:', error);
        process.exit(1);
    }
}

// RAYAT-FIX: close MQTT cleanly before exiting so in-flight messages can finish.
async function shutdownServer(signal) {
    if (shutdownInProgress) {
        return;
    }

    shutdownInProgress = true;
    console.log(`${signal} ricevuto, chiusura server...`);

    try {
        await stopMqttDirectJob();
        stopAgroEventsJob();
        stopPatternDiscoveryJob();
        stopIntelligenceChainJob();
        if (httpServer) {
            await new Promise((resolve) => httpServer.close(resolve));
        }
        process.exit(0);
    } catch (error) {
        console.error('Errore durante la chiusura del server:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => {
    void shutdownServer('SIGTERM');
});

process.on('SIGINT', () => {
    void shutdownServer('SIGINT');
});

// Avvia server
startServer();

module.exports = app;
