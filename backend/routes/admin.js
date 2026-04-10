/**
 * Rayat Admin API Routes
 * /api/admin/*
 *
 * Roles:
 *   super_admin – full access
 *   operator_admin – gestisce registrazioni/clienti/sensori, ma non gli utenti admin
 */
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const {
    query,
    getTableColumns,
    withTransaction
} = require('../config/database');
const {
    getOfflineAfterMinutes,
    getPostgresMinuteIntervalLiteral
} = require('../utils/monitoring-config');
const {
    extractAdminSessionToken,
    getAdminSessionCookieOptions,
    isPrivilegedAdminRole,
    normalizeAdminRole,
    signAdminToken,
    ADMIN_SESSION_COOKIE
} = require('../utils/admin-auth');
const { attachPasswordResetRoutes } = require('../utils/password-reset');
const { buildAnalyticsSummary } = require('../utils/analytics');

const router = express.Router();

attachPasswordResetRoutes(router, {
    resetPath: '/reset-password',
    userScopeSql: `AND role IN ('super_admin', 'operator_admin', 'operator', 'admin')`
});

const VALID_SENSOR_TYPES = new Set(['energia', 'acqua', 'terreno', 'clima']);
const DEFAULT_SENSOR_PROFILES = {
    energia: {
        subtype: 'energia_consumption',
        name: 'Sensore Energia',
        unit: 'kW'
    },
    acqua: {
        subtype: 'acqua_level',
        name: 'Sensore Acqua',
        unit: 'm'
    },
    terreno: {
        subtype: 'terreno_moisture',
        name: 'Sensore Terreno',
        unit: '%'
    },
    clima: {
        subtype: 'clima_temperature',
        name: 'Sensore Clima',
        unit: '°C'
    }
};

function createHttpError(statusCode, message, errorCode = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (errorCode) {
        error.errorCode = errorCode;
    }
    return error;
}

function sendAdminError(res, statusCode, message, errorCode = null) {
    const payload = { error: message };
    if (errorCode) {
        payload.errorCode = errorCode;
    }
    return res.status(statusCode).json(payload);
}

function extractBearerToken(req) {
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
        return null;
    }

    const token = authHeader.slice(7).trim();
    return token || null;
}

function clearAdminSessionCookie(res, req) {
    const cookieOptions = getAdminSessionCookieOptions(req);
    res.clearCookie(ADMIN_SESSION_COOKIE, {
        path: cookieOptions.path,
        sameSite: cookieOptions.sameSite,
        secure: cookieOptions.secure,
        httpOnly: cookieOptions.httpOnly
    });
}

function parsePositiveInt(value, fallback, max = 200) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(parsed, max);
}

function parsePagination(req, fallbackPageSize = 25) {
    const page = parsePositiveInt(req.query.page, 1, 1000000);
    const pageSize = parsePositiveInt(req.query.pageSize || req.query.limit, fallbackPageSize, 100);
    return {
        page,
        pageSize,
        offset: (page - 1) * pageSize
    };
}

function buildPaginationMeta(total, page, pageSize) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return {
        total,
        page,
        pageSize,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
    };
}

function getSensorProfile(type) {
    return DEFAULT_SENSOR_PROFILES[type] || DEFAULT_SENSOR_PROFILES.clima;
}

function buildDeviceName(serialNumber, type) {
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    return `${label} ${serialNumber}`;
}

function createExecutor(connection) {
    return async (sql, params) => {
        const [result] = await connection.execute(sql, params);
        return result;
    };
}

async function ensureClientExists(clientId, executor = query) {
    if (!clientId) {
        return null;
    }

    const clients = await executor(
        `SELECT id
         FROM users
         WHERE id = ?
           AND role IN ('client', 'farmer')`,
        [clientId]
    );

    if (!clients.length) {
        throw createHttpError(404, 'Cliente non trovato');
    }

    return clients[0];
}

async function getUserColumnFlags() {
    const columns = await getTableColumns('users');
    return {
        // RAYAT FIX - registration/admin
        hasLastName: columns.has('last_name'),
        hasClientCode: columns.has('client_code'),
        hasLocationAddress: columns.has('location_address'),
        hasPaymentStatus: columns.has('payment_status'),
        hasPaymentDate: columns.has('payment_date'),
        hasSubscriptionExpiry: columns.has('subscription_expiry'),
        hasRegistrationStatus: columns.has('registration_status'),
        hasRegistrationSource: columns.has('registration_source'),
        hasApprovedAt: columns.has('approved_at')
    };
}

function optionalUserSelect(flags, fieldName) {
    const map = {
        last_name: flags.hasLastName,
        client_code: flags.hasClientCode,
        location_address: flags.hasLocationAddress,
        payment_status: flags.hasPaymentStatus,
        payment_date: flags.hasPaymentDate,
        subscription_expiry: flags.hasSubscriptionExpiry,
        registration_status: flags.hasRegistrationStatus,
        registration_source: flags.hasRegistrationSource,
        approved_at: flags.hasApprovedAt
    };

    return map[fieldName] ? `u.${fieldName} AS ${fieldName}` : `NULL AS ${fieldName}`;
}

function resolvedClientCodeExpr(flags, alias = 'u') {
    const paddedIdExpr = `LPAD(CAST(${alias}.id AS TEXT), 4, '0')`;

    if (!flags.hasClientCode) {
        return paddedIdExpr;
    }

    return `COALESCE(NULLIF(${alias}.client_code, ''), ${paddedIdExpr})`;
}

function normalizeCoordinate(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLocationFields(payload = {}) {
    const locationName = String(payload.location_name || '').trim() || null;
    const locationAddress = String(payload.location_address || payload.address || locationName || '').trim() || null;
    const latitude = normalizeCoordinate(payload.latitude);
    const longitude = normalizeCoordinate(payload.longitude);

    if ((latitude === null) !== (longitude === null)) {
        throw createHttpError(400, 'Latitudine e longitudine devono essere entrambe valorizzate');
    }

    return {
        locationName,
        locationAddress,
        latitude,
        longitude
    };
}

function normalizeRegistrationStatus(status) {
    return status === 'active' ? 'active' : 'new';
}

// RAYAT FIX - full critical admin flow
function normalizeManagedNameParts(payload = {}) {
    const rawFirstName = String(
        payload.name ||
        payload.first_name ||
        ''
    ).trim();
    const rawLastName = String(
        payload.last_name ||
        payload.lastName ||
        payload.surname ||
        ''
    ).trim();

    if (rawFirstName && rawLastName) {
        return {
            firstName: rawFirstName,
            lastName: rawLastName
        };
    }

    if (!rawFirstName) {
        return {
            firstName: '',
            lastName: ''
        };
    }

    const parts = rawFirstName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return {
            firstName: parts.slice(0, -1).join(' '),
            lastName: parts.slice(-1).join('')
        };
    }

    return {
        firstName: rawFirstName,
        lastName: ''
    };
}

// RAYAT FIX - full critical admin flow
function buildConfirmedClientPredicate(flags, alias = 'u') {
    const clauses = [];

    if (flags.hasRegistrationStatus) {
        clauses.push(`${alias}.registration_status = 'active'`);
    }
    if (flags.hasApprovedAt) {
        clauses.push(`${alias}.approved_at IS NOT NULL`);
    }
    if (!clauses.length) {
        clauses.push(`${alias}.active = TRUE`);
    }

    return `(${clauses.join(' OR ')})`;
}

function buildRegistrationWhereClause(req, flags) {
    const where = [`u.role IN ('client', 'farmer')`];
    const params = [];
    const searchTerm = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();

    if (flags.hasRegistrationSource) {
        where.push(`u.registration_source = 'public'`);
    }

    if (flags.hasRegistrationStatus && status && ['new', 'active'].includes(status)) {
        where.push('u.registration_status = ?');
        params.push(status);
    }

    if (searchTerm) {
        const like = `%${searchTerm}%`;
        const normalizedCode = `%${searchTerm.replace(/^#/, '')}%`;
        const searchClauses = [
            'u.name LIKE ?',
            ...(flags.hasLastName ? ['u.last_name LIKE ?'] : []),
            'u.email LIKE ?',
            'u.phone LIKE ?',
            'u.location_name LIKE ?'
        ];

        params.push(like);
        if (flags.hasLastName) {
            params.push(like);
        }
        params.push(like, like, like);

        if (flags.hasLocationAddress) {
            searchClauses.push('u.location_address LIKE ?');
            params.push(like);
        }

        if (flags.hasClientCode) {
            searchClauses.push(`${resolvedClientCodeExpr(flags)} LIKE ?`);
            params.push(normalizedCode);
        }

        where.push(`(${searchClauses.join(' OR ')})`);
    }

    return {
        whereSql: where.join(' AND '),
        params
    };
}

function buildClientWhereClause(searchTerm, flags) {
    const where = [
        `u.role IN ('client', 'farmer')`,
        buildConfirmedClientPredicate(flags)
    ];
    const params = [];

    if (searchTerm) {
        const like = `%${searchTerm}%`;
        const normalizedCode = `%${searchTerm.replace(/^#/, '')}%`;
        const searchClauses = [
            'u.name LIKE ?',
            ...(flags.hasLastName ? ['u.last_name LIKE ?'] : []),
            'u.email LIKE ?',
            'u.phone LIKE ?',
            'u.location_name LIKE ?'
        ];

        params.push(like);
        if (flags.hasLastName) {
            params.push(like);
        }
        params.push(like, like, like);

        if (flags.hasLocationAddress) {
            searchClauses.push('u.location_address LIKE ?');
            params.push(like);
        }

        if (flags.hasClientCode) {
            searchClauses.push(`${resolvedClientCodeExpr(flags)} LIKE ?`);
            params.push(normalizedCode);
        }

        where.push(`(${searchClauses.join(' OR ')})`);
    }

    return {
        whereSql: where.join(' AND '),
        params
    };
}

function buildSensorWhereClause(req, flags) {
    const where = [`(u.role IN ('client', 'farmer') OR u.id IS NULL)`];
    const params = [];
    const searchTerm = (req.query.q || '').trim();
    const clientId = req.query.client_id || req.query.clientId;
    const type = req.query.type;

    if (searchTerm) {
        const like = `%${searchTerm}%`;
        const normalizedCode = `%${searchTerm.replace(/^#/, '')}%`;
        const clauses = [
            'd.device_id LIKE ?',
            'd.name LIKE ?',
            's.name LIKE ?',
            's.subtype LIKE ?',
            'u.name LIKE ?'
        ];

        params.push(like, like, like, like, like);

        if (flags.hasClientCode) {
            clauses.push(`${resolvedClientCodeExpr(flags)} LIKE ?`);
            params.push(normalizedCode);
        }

        where.push(`(${clauses.join(' OR ')})`);
    }

    if (clientId) {
        where.push('u.id = ?');
        params.push(clientId);
    }

    if (type && VALID_SENSOR_TYPES.has(type)) {
        where.push('s.type = ?');
        params.push(type);
    }

    return {
        whereSql: where.join(' AND '),
        params
    };
}

function buildDeviceWhereClause(req, flags) {
    const where = [`(u.role IN ('client', 'farmer') OR u.id IS NULL)`];
    const params = [];
    const searchTerm = (req.query.q || '').trim();
    const clientId = req.query.client_id || req.query.clientId;
    const type = req.query.type;

    if (searchTerm) {
        const like = `%${searchTerm}%`;
        const normalizedCode = `%${searchTerm.replace(/^#/, '')}%`;
        const clauses = [
            'd.device_id LIKE ?',
            'd.name LIKE ?',
            'u.name LIKE ?'
        ];
        params.push(like, like, like);

        if (flags.hasClientCode) {
            clauses.push(`${resolvedClientCodeExpr(flags)} LIKE ?`);
            params.push(normalizedCode);
        }

        where.push(`(${clauses.join(' OR ')})`);
    }

    if (clientId) {
        where.push('d.user_id = ?');
        params.push(clientId);
    }

    if (type && VALID_SENSOR_TYPES.has(type)) {
        where.push('(sm.primary_type = ? OR FIND_IN_SET(?, sm.sensor_types))');
        params.push(type, type);
    }

    return {
        whereSql: where.join(' AND '),
        params
    };
}

async function getNextClientCode(flags) {
    if (!flags.hasClientCode) {
        return null;
    }

    const [row] = await query(
        `SELECT COALESCE(MAX(
            CASE
                WHEN client_code REGEXP '^[0-9]+$' THEN CAST(client_code AS UNSIGNED)
                ELSE 0
            END
         ), 0) AS max_code
         FROM users
         WHERE role IN ('client', 'farmer')`
    );

    const nextCodeNum = Number(row?.max_code || 0) + 1;

    return String(nextCodeNum).padStart(4, '0');
}

async function createManagedDevice({ serialNumber, type, clientId, deviceName }, connection) {
    const executor = createExecutor(connection);
    const cleanSerial = String(serialNumber || '').trim();

    if (!cleanSerial) {
        throw createHttpError(400, 'Numero seriale obbligatorio');
    }
    if (!VALID_SENSOR_TYPES.has(type)) {
        throw createHttpError(400, 'Tipo sensore non valido');
    }

    await ensureClientExists(clientId, executor);

    const apiKey = crypto.randomBytes(24).toString('hex');
    const profile = getSensorProfile(type);
    const metadata = JSON.stringify({
        created_from: 'admin_panel',
        primary_type: type
    });

    const deviceResult = await executor(
        `INSERT INTO devices (device_id, user_id, name, api_key, status, metadata)
         VALUES (?, ?, ?, ?, 'inactive', ?)`,
        [cleanSerial, clientId || null, deviceName || buildDeviceName(cleanSerial, type), apiKey, metadata]
    );

    await executor(
        `INSERT INTO sensors (device_id, type, subtype, name, unit, enabled)
         VALUES (?, ?, ?, ?, ?, TRUE)`,
        [deviceResult.insertId, type, profile.subtype, profile.name, profile.unit]
    );

    return {
        id: deviceResult.insertId,
        apiKey
    };
}

async function syncPrimarySensorForDevice(deviceId, type, connection) {
    const executor = createExecutor(connection);
    const profile = getSensorProfile(type);
    const sensors = await executor(
        `SELECT id, type
         FROM sensors
         WHERE device_id = ?
         ORDER BY id ASC`,
        [deviceId]
    );

    if (!sensors.length) {
        await executor(
            `INSERT INTO sensors (device_id, type, subtype, name, unit, enabled)
             VALUES (?, ?, ?, ?, ?, TRUE)`,
            [deviceId, type, profile.subtype, profile.name, profile.unit]
        );
        return;
    }

    if (sensors.some((sensor) => sensor.type === type)) {
        return;
    }

    await executor(
        `UPDATE sensors
         SET type = ?,
             subtype = ?,
             name = ?,
             unit = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [type, profile.subtype, profile.name, profile.unit, sensors[0].id]
    );
}

// ─── Role Middleware ───────────────────────────────────────────────────────────

async function resolveAdminFromToken(token) {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const tokenRole = normalizeAdminRole(decoded.role);

    if (!isPrivilegedAdminRole(tokenRole)) {
        throw createHttpError(403, 'Accesso negato. Accesso riservato agli amministratori.', 'admin_access_denied');
    }

    const rows = await query(
        'SELECT id, email, name, role, active FROM users WHERE id = ?',
        [decoded.id]
    );

    if (!rows.length || !rows[0].active) {
        throw createHttpError(401, 'Utente non trovato o disattivato', 'admin_session_invalid');
    }

    const user = rows[0];
    const normalizedRole = normalizeAdminRole(user.role);
    if (!isPrivilegedAdminRole(normalizedRole)) {
        throw createHttpError(403, 'Accesso negato. Accesso riservato agli amministratori.', 'admin_access_denied');
    }
    if (normalizedRole !== tokenRole) {
        throw createHttpError(403, 'Ruolo admin non coerente con la sessione corrente.', 'admin_session_invalid');
    }

    return { ...user, role: normalizedRole, originalRole: user.role };
}

const isAdminRole = async (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) {
        return sendAdminError(res, 401, 'Token mancante', 'admin_session_missing');
    }

    try {
        req.adminUser = await resolveAdminFromToken(token);
        next();
    } catch (error) {
        const statusCode = error.statusCode || 403;
        return sendAdminError(
            res,
            statusCode,
            error.message || 'Token non valido o scaduto',
            error.errorCode || (statusCode === 401 ? 'admin_session_missing' : 'admin_session_invalid')
        );
    }
};

const isSuperAdmin = (req, res, next) => {
    if (req.adminUser && req.adminUser.role === 'super_admin') {
        return next();
    }
    return sendAdminError(res, 403, 'Accesso riservato al Super Admin.', 'admin_super_required');
};

// ─── AUTH ──────────────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '').trim();
        if (!email || !password) {
            return sendAdminError(res, 400, 'Email e password obbligatori', 'admin_credentials_required');
        }

        const rows = await query('SELECT * FROM users WHERE email = ?', [email]);
        if (!rows.length) {
            return sendAdminError(res, 401, 'Credenziali non valide', 'admin_invalid_credentials');
        }

        const user = rows[0];
        const normalizedRole = normalizeAdminRole(user.role);

        if (!isPrivilegedAdminRole(normalizedRole)) {
            return sendAdminError(res, 403, 'Accesso negato. Account non amministratore.', 'admin_account_required');
        }
        if (!user.active) {
            return sendAdminError(res, 403, 'Account disattivato.', 'admin_account_disabled');
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return sendAdminError(res, 401, 'Credenziali non valide', 'admin_invalid_credentials');
        }

        const token = signAdminToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: normalizedRole
        });

        res.cookie(
            ADMIN_SESSION_COOKIE,
            token,
            getAdminSessionCookieOptions(req)
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: normalizedRole
            }
        });
    } catch (error) {
        console.error('Admin login error:', error);
        sendAdminError(res, 500, 'Errore interno del server');
    }
});

router.get('/session', async (req, res) => {
    try {
        const cookieToken = extractAdminSessionToken(req);
        const bearerToken = extractBearerToken(req);
        const sessionCandidates = [cookieToken];
        if (bearerToken && bearerToken !== cookieToken) {
            sessionCandidates.push(bearerToken);
        }

        const activeToken = sessionCandidates.find(Boolean);
        if (!activeToken) {
            return sendAdminError(res, 401, 'Sessione admin non trovata', 'admin_session_missing');
        }

        let adminUser = null;
        let resolvedWithToken = null;
        let lastError = null;

        for (const candidate of sessionCandidates.filter(Boolean)) {
            try {
                adminUser = await resolveAdminFromToken(candidate);
                resolvedWithToken = candidate;
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (!adminUser || !resolvedWithToken) {
            throw lastError || createHttpError(403, 'Sessione admin non valida', 'admin_session_invalid');
        }

        let nextToken = resolvedWithToken;
        if (!cookieToken || bearerToken) {
            nextToken = signAdminToken(adminUser);
            res.cookie(
                ADMIN_SESSION_COOKIE,
                nextToken,
                getAdminSessionCookieOptions(req)
            );
        }

        res.json({
            success: true,
            token: nextToken,
            user: {
                id: adminUser.id,
                email: adminUser.email,
                name: adminUser.name,
                role: adminUser.role
            }
        });
    } catch (error) {
        clearAdminSessionCookie(res, req);
        sendAdminError(
            res,
            error.statusCode || 403,
            error.message || 'Sessione admin non valida',
            error.errorCode || 'admin_session_invalid'
        );
    }
});

router.post('/logout', async (req, res) => {
    clearAdminSessionCookie(res, req);
    res.json({ success: true });
});

// ─── STATS ─────────────────────────────────────────────────────────────────────

router.get('/stats', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const offlineIntervalLiteral = getPostgresMinuteIntervalLiteral(getOfflineAfterMinutes());
        const [clientCount] = await query(
            `SELECT COUNT(*) AS count
             FROM users
             WHERE role IN ('client','farmer')
               AND ${buildConfirmedClientPredicate(flags, 'users')}`
        );
        const [deviceCount] = await query('SELECT COUNT(*) AS count FROM devices');
        const [onlineDevices] = await query(
            `SELECT COUNT(*) AS count
             FROM devices
             WHERE last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}'`
        );
        const [sensorCount] = await query('SELECT COUNT(*) AS count FROM sensors WHERE enabled = 1');
        const [latestReading] = await query('SELECT MAX(updated_at) AS last FROM sensor_latest');
        const [adminCount] = await query(
            `SELECT COUNT(*) AS count
             FROM users
             WHERE role IN ('super_admin','operator_admin','operator','admin')`
        );
        let newRegistrations = { count: 0 };
        const whereSource = flags.hasRegistrationSource ? "AND registration_source = 'public'" : '';
        const wherePending = flags.hasRegistrationStatus
            ? "AND registration_status = 'new'"
            : 'AND active = FALSE';
        [newRegistrations] = await query(
            `SELECT COUNT(*) AS count
             FROM users
             WHERE role IN ('client','farmer')
               ${whereSource}
               ${wherePending}`
        );

        res.json({
            success: true,
            data: {
                totalClients: clientCount.count,
                totalDevices: deviceCount.count,
                onlineDevices: onlineDevices.count,
                totalSensors: sensorCount.count,
                lastSensorUpdate: latestReading.last,
                totalAdmins: adminCount.count,
                newRegistrations: newRegistrations.count
            }
        });
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'Errore nel recupero statistiche' });
    }
});

// RAYAT FIX - analytics followup
router.get('/analytics/summary', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const data = await buildAnalyticsSummary();
        if (process.env.NODE_ENV !== 'test') {
            console.info('[analytics] summary served', {
                adminId: req.adminUser?.id || null,
                role: req.adminUser?.role || null
            });
        }
        res.json({
            success: true,
            data
        });
    } catch (error) {
        console.error('Get analytics summary error:', error);
        res.status(500).json({ error: 'Errore nel recupero analytics' });
    }
});

// ─── CLIENTS ───────────────────────────────────────────────────────────────────

router.get('/clients', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const searchTerm = (req.query.q || '').trim();
        const { page, pageSize, offset } = parsePagination(req, 25);
        const { whereSql, params } = buildClientWhereClause(searchTerm, flags);

        const [countRow] = await query(
            `SELECT COUNT(*) AS total
             FROM users u
             WHERE ${whereSql}`,
            params
        );

        const clients = await query(
            `SELECT
                u.id,
                u.name,
                ${optionalUserSelect(flags, 'last_name')},
                u.email,
                u.phone,
                u.crop_type,
                u.location_name,
                ${optionalUserSelect(flags, 'location_address')},
                u.latitude,
                u.longitude,
                u.active,
                u.created_at,
                u.role,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                ${optionalUserSelect(flags, 'payment_status')},
                ${optionalUserSelect(flags, 'payment_date')},
                ${optionalUserSelect(flags, 'subscription_expiry')},
                ${optionalUserSelect(flags, 'registration_status')},
                ${optionalUserSelect(flags, 'registration_source')},
                ${optionalUserSelect(flags, 'approved_at')},
                COALESCE(dc.device_count, 0) AS device_count
             FROM users u
             LEFT JOIN (
                SELECT user_id, COUNT(*) AS device_count
                FROM devices
                GROUP BY user_id
             ) dc ON dc.user_id = u.id
             WHERE ${whereSql}
             ORDER BY u.created_at DESC, u.id DESC
             LIMIT ${offset}, ${pageSize}`,
            params
        );

        res.json({
            success: true,
            data: clients,
            pagination: buildPaginationMeta(countRow.total, page, pageSize)
        });
    } catch (error) {
        console.error('Get clients error:', error);
        res.status(500).json({ error: 'Errore nel recupero clienti' });
    }
});

router.get('/clients/:id', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const [client] = await query(
            `SELECT
                u.id,
                u.name,
                ${optionalUserSelect(flags, 'last_name')},
                u.email,
                u.phone,
                u.crop_type,
                u.location_name,
                ${optionalUserSelect(flags, 'location_address')},
                u.latitude,
                u.longitude,
                u.active,
                u.created_at,
                u.role,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                ${optionalUserSelect(flags, 'payment_status')},
                ${optionalUserSelect(flags, 'payment_date')},
                ${optionalUserSelect(flags, 'subscription_expiry')},
                ${optionalUserSelect(flags, 'registration_status')},
                ${optionalUserSelect(flags, 'registration_source')},
                ${optionalUserSelect(flags, 'approved_at')},
                COALESCE(dc.device_count, 0) AS device_count
             FROM users u
             LEFT JOIN (
                SELECT user_id, COUNT(*) AS device_count
                FROM devices
                GROUP BY user_id
             ) dc ON dc.user_id = u.id
             WHERE u.id = ?
               AND u.role IN ('client','farmer')
               AND ${buildConfirmedClientPredicate(flags)}`,
            [req.params.id]
        );

        if (!client) {
            return res.status(404).json({ error: 'Cliente non trovato' });
        }

        res.json({ success: true, data: client });
    } catch (error) {
        console.error('Get client error:', error);
        res.status(500).json({ error: 'Errore nel recupero cliente' });
    }
});

router.post('/clients', isAdminRole, async (req, res) => {
    try {
        const { firstName, lastName } = normalizeManagedNameParts(req.body);
        const {
            email,
            phone,
            password,
            crop_type,
            payment_status,
            payment_date,
            subscription_expiry
        } = req.body;
        const {
            locationName,
            locationAddress,
            latitude,
            longitude
        } = normalizeLocationFields(req.body);

        if (!firstName || !phone || !password) {
            return res.status(400).json({ error: 'Nome, telefono e password sono obbligatori' });
        }

        if (email) {
            const existing = await query('SELECT id FROM users WHERE email = ?', [email]);
            if (existing.length > 0) {
                return res.status(409).json({ error: 'Email già registrata' });
            }
        }
        if (phone) {
            const existingPhone = await query('SELECT id FROM users WHERE phone = ?', [phone]);
            if (existingPhone.length > 0) {
                return res.status(409).json({ error: 'Numero di telefono già registrato' });
            }
        }

        const flags = await getUserColumnFlags();
        const clientCode = await getNextClientCode(flags);
        const passwordHash = await bcrypt.hash(password, 10);

        const columns = [
            'name',
            ...(flags.hasLastName ? ['last_name'] : []),
            'email',
            'phone',
            'password_hash',
            'crop_type',
            'location_name',
            'latitude',
            'longitude',
            'is_verified',
            'active',
            'role'
        ];
        const values = [
            firstName,
            ...(flags.hasLastName ? [lastName || null] : []),
            email || null,
            phone,
            passwordHash,
            crop_type || null,
            locationName,
            latitude,
            longitude,
            true,
            true,
            'client'
        ];

        if (flags.hasLocationAddress) {
            columns.push('location_address');
            values.push(locationAddress);
        }
        if (flags.hasClientCode) {
            columns.push('client_code');
            values.push(clientCode);
        }
        if (flags.hasPaymentStatus) {
            columns.push('payment_status');
            values.push(payment_status || 'non_pagato');
        }
        if (flags.hasPaymentDate) {
            columns.push('payment_date');
            values.push(payment_status === 'pagato' ? payment_date || null : null);
        }
        if (flags.hasSubscriptionExpiry) {
            columns.push('subscription_expiry');
            values.push(payment_status === 'pagato' ? subscription_expiry || null : null);
        }
        if (flags.hasRegistrationStatus) {
            columns.push('registration_status');
            values.push('active');
        }
        if (flags.hasRegistrationSource) {
            columns.push('registration_source');
            values.push('admin');
        }
        if (flags.hasApprovedAt) {
            columns.push('approved_at');
            values.push(new Date());
        }

        const placeholders = columns.map(() => '?').join(', ');
        const result = await query(
            `INSERT INTO users (${columns.join(', ')})
             VALUES (${placeholders})`,
            values
        );

        res.status(201).json({
            success: true,
            message: 'Cliente creato',
            id: result.insertId,
            client_code: clientCode
        });
    } catch (error) {
        console.error('Create client error:', error);
        res.status(500).json({ error: 'Errore durante la creazione del cliente' });
    }
});

router.put('/clients/:id', isAdminRole, async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const { firstName, lastName } = normalizeManagedNameParts(req.body);
        const hasManagedName = Object.prototype.hasOwnProperty.call(req.body, 'name')
            || Object.prototype.hasOwnProperty.call(req.body, 'first_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'last_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'lastName')
            || Object.prototype.hasOwnProperty.call(req.body, 'surname');
        const {
            email,
            phone,
            crop_type,
            active,
            payment_status,
            payment_date,
            subscription_expiry
        } = req.body;
        const {
            locationName,
            locationAddress,
            latitude,
            longitude
        } = normalizeLocationFields(req.body);
        const flags = await getUserColumnFlags();

        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('client','farmer')
               AND ${buildConfirmedClientPredicate(flags)}`,
            [id]
        );
        if (!existing.length) {
            return res.status(404).json({ error: 'Cliente non trovato' });
        }

        if (email) {
            const duplicate = await query(
                'SELECT id FROM users WHERE email = ? AND id <> ?',
                [email, id]
            );
            if (duplicate.length > 0) {
                return res.status(409).json({ error: 'Email già registrata' });
            }
        }
        if (phone) {
            const duplicatePhone = await query(
                'SELECT id FROM users WHERE phone = ? AND id <> ?',
                [phone, id]
            );
            if (duplicatePhone.length > 0) {
                return res.status(409).json({ error: 'Numero di telefono già registrato' });
            }
        }

        const assignments = [
            'email = ?',
            'phone = COALESCE(?, phone)',
            'crop_type = ?',
            'location_name = ?',
            'latitude = ?',
            'longitude = ?',
            'active = COALESCE(?, active)',
            'updated_at = NOW()'
        ];
        const params = [
            email || null,
            phone || null,
            crop_type || null,
            locationName,
            latitude,
            longitude,
            active === undefined ? null : (active ? 1 : 0)
        ];

        if (hasManagedName) {
            assignments.unshift('name = COALESCE(?, name)');
            params.unshift(firstName || null);
        }

        if (flags.hasLocationAddress) {
            const locationInsertIndex = hasManagedName ? 4 : 3;
            assignments.splice(locationInsertIndex, 0, 'location_address = ?');
            params.splice(locationInsertIndex, 0, locationAddress);
        }
        if (flags.hasLastName && hasManagedName) {
            assignments.splice(1, 0, 'last_name = ?');
            params.splice(1, 0, lastName || null);
        }
        if (flags.hasPaymentStatus) {
            assignments.push('payment_status = COALESCE(?, payment_status)');
            params.push(payment_status || null);
        }
        if (flags.hasPaymentDate) {
            assignments.push('payment_date = ?');
            params.push(payment_status === 'pagato' ? payment_date || null : null);
        }
        if (flags.hasSubscriptionExpiry) {
            assignments.push('subscription_expiry = ?');
            params.push(payment_status === 'pagato' ? subscription_expiry || null : null);
        }
        if (flags.hasRegistrationStatus && req.body.registration_status) {
            assignments.push('registration_status = ?');
            params.push(normalizeRegistrationStatus(req.body.registration_status));
        }
        if (flags.hasApprovedAt && req.body.registration_status) {
            assignments.push('approved_at = ?');
            params.push(
                normalizeRegistrationStatus(req.body.registration_status) === 'active'
                    ? (req.body.approved_at || new Date())
                    : null
            );
        }

        params.push(id);

        await query(
            `UPDATE users
             SET ${assignments.join(', ')}
             WHERE id = ?`,
            params
        );

        res.json({ success: true, message: 'Cliente aggiornato' });
    } catch (error) {
        console.error('Update client error:', error);
        res.status(500).json({ error: 'Errore durante l\'aggiornamento del cliente' });
    }
});

router.delete('/clients/:id', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('client','farmer')
               AND ${buildConfirmedClientPredicate(flags)}`,
            [req.params.id]
        );

        if (!existing.length) {
            return res.status(404).json({ error: 'Cliente non trovato' });
        }

        await query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Cliente eliminato' });
    } catch (error) {
        console.error('Delete client error:', error);
        res.status(500).json({ error: 'Errore durante l\'eliminazione del cliente' });
    }
});

// ─── RECENT REGISTRATIONS ─────────────────────────────────────────────────────

router.get('/registrations', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const { page, pageSize, offset } = parsePagination(req, 20);
        const { whereSql, params } = buildRegistrationWhereClause(req, flags);
        const countSql = `SELECT COUNT(*) AS total
             FROM users u
             WHERE ${whereSql}`;
        const registrationsSql = `SELECT
                u.id,
                u.name,
                ${optionalUserSelect(flags, 'last_name')},
                u.email,
                u.phone,
                u.location_name,
                ${optionalUserSelect(flags, 'location_address')},
                u.crop_type,
                u.latitude,
                u.longitude,
                u.active,
                u.created_at,
                u.updated_at,
                u.role,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                ${optionalUserSelect(flags, 'registration_status')},
                ${optionalUserSelect(flags, 'registration_source')},
                ${optionalUserSelect(flags, 'approved_at')},
                COALESCE(dc.device_count, 0) AS device_count
             FROM users u
             LEFT JOIN (
                SELECT user_id, COUNT(*) AS device_count
                FROM devices
                GROUP BY user_id
             ) dc ON dc.user_id = u.id
             WHERE ${whereSql}
             ORDER BY u.created_at DESC, u.id DESC
             LIMIT ${offset}, ${pageSize}`;

        console.info('[admin] registrations request', {
            adminId: req.adminUser?.id || null,
            adminRole: req.adminUser?.role || null,
            query: req.query,
            columns: {
                registration_status: flags.hasRegistrationStatus,
                registration_source: flags.hasRegistrationSource,
                approved_at: flags.hasApprovedAt,
                client_code: flags.hasClientCode
            }
        });
        console.info('[admin] registrations count query', {
            sqlBeforeNormalization: countSql.replace(/\s+/g, ' ').trim(),
            params
        });

        const [countRow] = await query(countSql, params);

        console.info('[admin] registrations data query', {
            sqlBeforeNormalization: registrationsSql.replace(/\s+/g, ' ').trim(),
            params
        });

        const registrations = await query(registrationsSql, params);

        console.info('[admin] registrations result', {
            total: Number(countRow?.total || 0),
            rowCount: registrations.length,
            page,
            pageSize
        });

        res.json({
            success: true,
            data: registrations,
            pagination: buildPaginationMeta(countRow.total, page, pageSize)
        });
    } catch (error) {
        console.error('[admin] Get registrations error', {
            message: error.message,
            stack: error.stack,
            adminId: req.adminUser?.id || null,
            adminRole: req.adminUser?.role || null,
            query: req.query
        });
        res.status(500).json({ error: 'Errore nel recupero delle registrazioni recenti' });
    }
});

router.get('/registrations/:id', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const sourceFilter = flags.hasRegistrationSource ? `AND u.registration_source = 'public'` : '';
        const [registration] = await query(
            `SELECT
                u.id,
                u.name,
                ${optionalUserSelect(flags, 'last_name')},
                u.email,
                u.phone,
                u.location_name,
                ${optionalUserSelect(flags, 'location_address')},
                u.crop_type,
                u.latitude,
                u.longitude,
                u.active,
                u.created_at,
                u.updated_at,
                u.role,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                ${optionalUserSelect(flags, 'registration_status')},
                ${optionalUserSelect(flags, 'registration_source')},
                ${optionalUserSelect(flags, 'approved_at')},
                COALESCE(dc.device_count, 0) AS device_count
             FROM users u
             LEFT JOIN (
                SELECT user_id, COUNT(*) AS device_count
                FROM devices
                GROUP BY user_id
             ) dc ON dc.user_id = u.id
             WHERE u.id = ?
               AND u.role IN ('client','farmer')
               ${sourceFilter}`,
            [req.params.id]
        );

        if (!registration) {
            return res.status(404).json({ error: 'Registrazione non trovata' });
        }

        res.json({ success: true, data: registration });
    } catch (error) {
        console.error('Get registration detail error:', error);
        res.status(500).json({ error: 'Errore nel recupero della registrazione' });
    }
});

router.put('/registrations/:id', isAdminRole, async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const { firstName, lastName } = normalizeManagedNameParts(req.body);
        const hasManagedName = Object.prototype.hasOwnProperty.call(req.body, 'name')
            || Object.prototype.hasOwnProperty.call(req.body, 'first_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'last_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'lastName')
            || Object.prototype.hasOwnProperty.call(req.body, 'surname');
        const {
            email,
            phone,
            crop_type,
            active,
            registration_status
        } = req.body;
        const {
            locationName,
            locationAddress,
            latitude,
            longitude
        } = normalizeLocationFields(req.body);

        const flags = await getUserColumnFlags();
        const sourceFilter = flags.hasRegistrationSource ? `AND registration_source = 'public'` : '';
        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('client','farmer')
               ${sourceFilter}`,
            [id]
        );
        if (!existing.length) {
            return res.status(404).json({ error: 'Registrazione non trovata' });
        }

        if (email) {
            const duplicateEmail = await query(
                'SELECT id FROM users WHERE email = ? AND id <> ?',
                [email, id]
            );
            if (duplicateEmail.length > 0) {
                return res.status(409).json({ error: 'Email già registrata' });
            }
        }
        if (phone) {
            const duplicatePhone = await query(
                'SELECT id FROM users WHERE phone = ? AND id <> ?',
                [phone, id]
            );
            if (duplicatePhone.length > 0) {
                return res.status(409).json({ error: 'Numero di telefono già registrato' });
            }
        }

        const assignments = [
            'email = COALESCE(?, email)',
            'phone = COALESCE(?, phone)',
            'location_name = COALESCE(?, location_name)',
            'crop_type = ?',
            'latitude = ?',
            'longitude = ?',
            'updated_at = NOW()'
        ];
        const params = [
            email || null,
            phone || null,
            locationName,
            crop_type || null,
            latitude,
            longitude
        ];

        if (hasManagedName) {
            assignments.unshift('name = COALESCE(?, name)');
            params.unshift(firstName || null);
        }

        if (flags.hasLocationAddress) {
            const locationInsertIndex = hasManagedName ? 4 : 3;
            assignments.splice(locationInsertIndex, 0, 'location_address = ?');
            params.splice(locationInsertIndex, 0, locationAddress);
        }
        if (flags.hasLastName && hasManagedName) {
            assignments.splice(1, 0, 'last_name = ?');
            params.splice(1, 0, lastName || null);
        }
        if (flags.hasRegistrationStatus && registration_status) {
            const normalizedStatus = normalizeRegistrationStatus(registration_status);
            assignments.push('registration_status = ?');
            params.push(normalizedStatus);
            assignments.push('active = ?');
            params.push(normalizedStatus === 'active');
        } else {
            assignments.push('active = COALESCE(?, active)');
            params.push(active === undefined ? null : (active ? 1 : 0));
        }
        if (flags.hasApprovedAt && registration_status) {
            const normalizedStatus = normalizeRegistrationStatus(registration_status);
            assignments.push('approved_at = ?');
            params.push(normalizedStatus === 'active' ? new Date() : null);
        }

        params.push(id);

        await query(
            `UPDATE users
             SET ${assignments.join(', ')}
             WHERE id = ?`,
            params
        );

        res.json({ success: true, message: 'Registrazione aggiornata' });
    } catch (error) {
        console.error('Update registration error:', error);
        res.status(500).json({ error: 'Errore durante l\'aggiornamento della registrazione' });
    }
});

router.post('/registrations/:id/approve', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const assignments = ['active = 1', 'updated_at = NOW()'];
        if (flags.hasRegistrationStatus) {
            assignments.push(`registration_status = 'active'`);
        }
        if (flags.hasApprovedAt) {
            assignments.push('approved_at = NOW()');
        }

        const sourceFilter = flags.hasRegistrationSource ? `AND registration_source = 'public'` : '';
        const result = await query(
            `UPDATE users
             SET ${assignments.join(', ')}
             WHERE id = ?
               AND role IN ('client','farmer')
               ${sourceFilter}`,
            [req.params.id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Registrazione non trovata' });
        }

        if (process.env.NODE_ENV !== 'test') {
            console.info('[admin] registration approved', {
                registrationId: Number(req.params.id),
                adminId: req.adminUser?.id || null
            });
        }

        res.json({ success: true, message: 'Registrazione approvata' });
    } catch (error) {
        console.error('Approve registration error:', error);
        res.status(500).json({ error: 'Errore durante l\'approvazione della registrazione' });
    }
});

router.delete('/registrations/:id', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const sourceFilter = flags.hasRegistrationSource ? `AND registration_source = 'public'` : '';
        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('client','farmer')
               ${sourceFilter}`,
            [req.params.id]
        );

        if (!existing.length) {
            return res.status(404).json({ error: 'Registrazione non trovata' });
        }

        await query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Registrazione eliminata' });
    } catch (error) {
        console.error('Delete registration error:', error);
        res.status(500).json({ error: 'Errore durante l\'eliminazione della registrazione' });
    }
});

// ─── SENSORS ───────────────────────────────────────────────────────────────────

router.get('/sensors', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const offlineIntervalLiteral = getPostgresMinuteIntervalLiteral(getOfflineAfterMinutes());
        const { page, pageSize, offset } = parsePagination(req, 50);
        const { whereSql, params } = buildSensorWhereClause(req, flags);

        const [countRow] = await query(
            `SELECT COUNT(*) AS total
             FROM sensors s
             INNER JOIN devices d ON s.device_id = d.id
             LEFT JOIN users u ON d.user_id = u.id
             WHERE ${whereSql}`,
            params
        );

        const sensors = await query(
            `SELECT
                s.id AS sensor_id,
                s.type,
                s.subtype,
                s.name AS sensor_name,
                s.unit,
                s.enabled,
                d.id AS device_row_id,
                d.device_id,
                d.name AS device_name,
                d.status AS device_status,
                d.last_seen,
                u.id AS client_id,
                u.name AS client_name,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                u.location_name,
                sl.value AS latest_value,
                sl.timestamp AS last_reading,
                CASE
                    WHEN d.last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}' THEN 'online'
                    WHEN d.last_seen IS NULL THEN 'never'
                    ELSE 'offline'
                END AS online_status
             FROM sensors s
             INNER JOIN devices d ON s.device_id = d.id
             LEFT JOIN users u ON d.user_id = u.id
             LEFT JOIN sensor_latest sl ON s.id = sl.sensor_id
             WHERE ${whereSql}
             ORDER BY
                CASE
                    WHEN d.last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}' THEN 0
                    WHEN d.last_seen IS NULL THEN 2
                    ELSE 1
                END,
                d.last_seen DESC,
                s.type ASC,
                s.subtype ASC
             LIMIT ${offset}, ${pageSize}`,
            params
        );

        res.json({
            success: true,
            data: sensors,
            pagination: buildPaginationMeta(countRow.total, page, pageSize)
        });
    } catch (error) {
        console.error('Get sensors error:', error);
        res.status(500).json({ error: 'Errore nel recupero sensori' });
    }
});

// ─── DEVICES ───────────────────────────────────────────────────────────────────

router.get('/devices', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const offlineIntervalLiteral = getPostgresMinuteIntervalLiteral(getOfflineAfterMinutes());
        const { page, pageSize, offset } = parsePagination(req, 50);
        const { whereSql, params } = buildDeviceWhereClause(req, flags);
        const metricsJoin = `
            LEFT JOIN (
                SELECT
                    s.device_id,
                    COUNT(*) AS sensor_count,
                    MIN(s.type) AS primary_type,
                    GROUP_CONCAT(DISTINCT s.type ORDER BY s.type SEPARATOR ',') AS sensor_types,
                    MAX(sl.timestamp) AS last_reading
                FROM sensors s
                LEFT JOIN sensor_latest sl ON sl.sensor_id = s.id
                WHERE s.enabled = TRUE
                GROUP BY s.device_id
            ) sm ON sm.device_id = d.id
        `;

        const [countRow] = await query(
            `SELECT COUNT(*) AS total
             FROM devices d
             LEFT JOIN users u ON d.user_id = u.id
             ${metricsJoin}
             WHERE ${whereSql}`,
            params
        );

        const devices = await query(
            `SELECT
                d.id,
                d.device_id AS serial_number,
                d.name,
                d.status,
                d.last_seen,
                d.created_at,
                d.user_id AS client_id,
                u.name AS client_name,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                COALESCE(sm.primary_type, 'clima') AS type,
                sm.sensor_types,
                COALESCE(sm.sensor_count, 0) AS sensor_count,
                sm.last_reading,
                CASE
                    WHEN d.last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}' THEN 'online'
                    WHEN d.last_seen IS NULL THEN 'never'
                    ELSE 'offline'
                END AS online_status
             FROM devices d
             LEFT JOIN users u ON d.user_id = u.id
             ${metricsJoin}
             WHERE ${whereSql}
             ORDER BY d.created_at DESC, d.id DESC
             LIMIT ${offset}, ${pageSize}`,
            params
        );

        res.json({
            success: true,
            devices,
            data: devices,
            pagination: buildPaginationMeta(countRow.total, page, pageSize)
        });
    } catch (error) {
        console.error('Get devices error:', error);
        res.status(500).json({ error: 'Errore nel recupero dispositivi' });
    }
});

router.post('/devices', isAdminRole, async (req, res) => {
    try {
        const { type, serial_number, client_id } = req.body;

        if (!type || !serial_number) {
            return res.status(400).json({ error: 'Tipo e seriale obbligatori' });
        }
        if (!VALID_SENSOR_TYPES.has(type)) {
            return res.status(400).json({ error: 'Tipo sensore non valido' });
        }

        const created = await withTransaction(async (connection) =>
            createManagedDevice(
                {
                    serialNumber: serial_number,
                    type,
                    clientId: client_id || null
                },
                connection
            )
        );

        res.status(201).json({
            success: true,
            id: created.id,
            api_key: created.apiKey
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return res.status(409).json({ error: 'Seriale già esistente' });
        }
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Create device error:', error);
        res.status(500).json({ error: 'Errore durante la creazione del dispositivo' });
    }
});

router.post('/clients/:id/devices', isAdminRole, async (req, res) => {
    try {
        const { type, serial_number } = req.body;
        const clientId = req.params.id;

        if (!type || !serial_number) {
            return res.status(400).json({ error: 'Tipo e seriale obbligatori' });
        }

        const created = await withTransaction(async (connection) =>
            createManagedDevice(
                {
                    serialNumber: serial_number,
                    type,
                    clientId
                },
                connection
            )
        );

        res.status(201).json({
            success: true,
            id: created.id,
            api_key: created.apiKey
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return res.status(409).json({ error: 'Seriale già esistente' });
        }
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Create device for client error:', error);
        res.status(500).json({ error: 'Errore durante la creazione' });
    }
});

router.put('/devices/:id', isAdminRole, async (req, res) => {
    try {
        const { serial_number, type, client_id } = req.body;
        const deviceId = Number.parseInt(req.params.id, 10);

        if (!serial_number || !type) {
            return res.status(400).json({ error: 'Seriale e tipo obbligatori' });
        }
        if (!VALID_SENSOR_TYPES.has(type)) {
            return res.status(400).json({ error: 'Tipo sensore non valido' });
        }

        await withTransaction(async (connection) => {
            const executor = createExecutor(connection);
            const existing = await executor(
                'SELECT id FROM devices WHERE id = ?',
                [deviceId]
            );

            if (!existing.length) {
                throw createHttpError(404, 'Dispositivo non trovato');
            }

            await ensureClientExists(client_id || null, executor);

            await executor(
                `UPDATE devices
                 SET device_id = ?,
                     user_id = ?,
                     name = COALESCE(name, ?),
                     updated_at = NOW()
                 WHERE id = ?`,
                [serial_number.trim(), client_id || null, buildDeviceName(serial_number.trim(), type), deviceId]
            );

            await syncPrimarySensorForDevice(deviceId, type, connection);
        });

        res.json({ success: true, message: 'Sensore aggiornato' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return res.status(409).json({ error: 'Seriale già esistente' });
        }
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Update device error:', error);
        res.status(500).json({ error: 'Errore durante l\'aggiornamento' });
    }
});

router.delete('/devices/:id', isAdminRole, async (req, res) => {
    try {
        const existing = await query('SELECT id FROM devices WHERE id = ?', [req.params.id]);
        if (!existing.length) {
            return res.status(404).json({ error: 'Dispositivo non trovato' });
        }

        await query('DELETE FROM devices WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Dispositivo eliminato' });
    } catch (error) {
        console.error('Delete device error:', error);
        res.status(500).json({ error: 'Errore durante l\'eliminazione del dispositivo' });
    }
});

// ─── ADMIN USERS ────────────────────────────────────────────────────────────────

router.get('/users', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const users = await query(
            `SELECT id, name, email, role, active, created_at
             FROM users
             WHERE role IN ('super_admin', 'operator_admin', 'operator', 'admin')
             ORDER BY role, created_at DESC`
        );

        res.json({
            success: true,
            data: users.map((user) => ({
                ...user,
                role: normalizeAdminRole(user.role)
            }))
        });
    } catch (error) {
        console.error('Get admin users error:', error);
        res.status(500).json({ error: 'Errore nel recupero utenti admin' });
    }
});

router.post('/users', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Nome, email e password sono obbligatori' });
        }
        if (!['operator_admin', 'super_admin'].includes(role)) {
            return res.status(400).json({ error: 'Ruolo non valido. Usa "operator_admin" o "super_admin".' });
        }

        const existing = await query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Email già registrata' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await query(
            `INSERT INTO users (name, email, password_hash, role, is_verified, active)
             VALUES (?, ?, ?, ?, 1, 1)`,
            [name, email, passwordHash, role]
        );

        res.status(201).json({ success: true, message: 'Utente admin creato', id: result.insertId });
    } catch (error) {
        console.error('Create admin user error:', error);
        res.status(500).json({ error: 'Errore durante la creazione dell\'utente' });
    }
});

router.delete('/users/:id', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const targetId = Number.parseInt(req.params.id, 10);
        if (targetId === req.adminUser.id) {
            return res.status(400).json({ error: 'Non puoi eliminare il tuo stesso account.' });
        }

        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('super_admin', 'operator_admin', 'operator', 'admin')`,
            [targetId]
        );
        if (!existing.length) {
            return res.status(404).json({ error: 'Utente non trovato' });
        }

        await query('DELETE FROM users WHERE id = ?', [targetId]);
        res.json({ success: true, message: 'Utente eliminato' });
    } catch (error) {
        console.error('Delete admin user error:', error);
        res.status(500).json({ error: 'Errore durante l\'eliminazione dell\'utente' });
    }
});

module.exports = router;
