const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { query, getTableColumns } = require('../config/database');
const { normalizeAdminRole } = require('../utils/admin-auth');
const { attachPasswordResetRoutes } = require('../utils/password-reset');

const router = express.Router();

attachPasswordResetRoutes(router, {
    resetPath: '/reset-password'
});

function buildAuthToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
}

async function getUserColumnFlags() {
    const columns = await getTableColumns('users');
    return {
        hasLanguage: columns.has('language'),
        hasClientCode: columns.has('client_code'),
        hasLocationAddress: columns.has('location_address'),
        hasRegistrationStatus: columns.has('registration_status'),
        hasRegistrationSource: columns.has('registration_source'),
        hasApprovedAt: columns.has('approved_at')
    };
}

function normalizeCoordinate(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRegistrationLocation(payload) {
    const explicitLocation = String(
        payload.location_name ||
        payload.locationRegion ||
        payload.location_region ||
        payload.locality_region ||
        ''
    ).trim();

    if (explicitLocation) {
        return explicitLocation;
    }

    const locality = String(payload.locality || '').trim();
    const region = String(payload.region || '').trim();
    return [locality, region].filter(Boolean).join(', ');
}

function normalizeLocationAddress(payload, locationName) {
    return String(
        payload.location_address ||
        payload.address ||
        locationName ||
        ''
    ).trim();
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

    return String(Number(row?.max_code || 0) + 1).padStart(4, '0');
}

async function ensureUniqueContactInfo({ email, phone, excludeId = null }) {
    if (email) {
        const sql = excludeId
            ? 'SELECT id FROM users WHERE email = ? AND id <> ?'
            : 'SELECT id FROM users WHERE email = ?';
        const params = excludeId ? [email, excludeId] : [email];
        const existingEmail = await query(sql, params);
        if (existingEmail.length > 0) {
            const error = new Error('Email già registrata');
            error.statusCode = 409;
            throw error;
        }
    }

    if (phone) {
        const sql = excludeId
            ? 'SELECT id FROM users WHERE phone = ? AND id <> ?'
            : 'SELECT id FROM users WHERE phone = ?';
        const params = excludeId ? [phone, excludeId] : [phone];
        const existingPhone = await query(sql, params);
        if (existingPhone.length > 0) {
            const error = new Error('Numero di telefono già registrato');
            error.statusCode = 409;
            throw error;
        }
    }
}

async function createRegisteredClient(payload, options = {}) {
    const flags = await getUserColumnFlags();
    const name = String(payload.name || '').trim();
    const email = String(payload.email || '').trim().toLowerCase();
    const phone = String(payload.phone || '').trim();
    const password = String(payload.password || '').trim();
    const locationName = normalizeRegistrationLocation(payload);
    const locationAddress = normalizeLocationAddress(payload, locationName) || null;
    const latitude = normalizeCoordinate(payload.latitude);
    const longitude = normalizeCoordinate(payload.longitude);

    if (!name || !email || !phone || !password || !locationName) {
        const error = new Error('Nome, email, telefono, password e località sono obbligatori');
        error.statusCode = 400;
        throw error;
    }
    if ((latitude === null) !== (longitude === null)) {
        const error = new Error('Latitudine e longitudine devono essere entrambe valorizzate');
        error.statusCode = 400;
        throw error;
    }

    await ensureUniqueContactInfo({ email, phone });

    const passwordHash = await bcrypt.hash(password, 10);
    const clientCode = await getNextClientCode(flags);
    const columns = [
        'name',
        'email',
        'phone',
        'password_hash',
        'crop_type',
        'latitude',
        'longitude',
        'location_name',
        'is_verified',
        'active',
        'role'
    ];
    const values = [
        name,
        email,
        phone,
        passwordHash,
        payload.crop_type || null,
        latitude,
        longitude,
        locationName,
        true,
        true,
        'client'
    ];

    if (flags.hasLanguage) {
        columns.push('language');
        values.push(payload.language || 'it');
    }
    if (flags.hasLocationAddress) {
        columns.push('location_address');
        values.push(locationAddress);
    }
    if (flags.hasClientCode) {
        columns.push('client_code');
        values.push(clientCode);
    }
    if (flags.hasRegistrationStatus) {
        columns.push('registration_status');
        values.push(options.registrationStatus || 'new');
    }
    if (flags.hasRegistrationSource) {
        columns.push('registration_source');
        values.push(options.registrationSource || 'public');
    }
    if (flags.hasApprovedAt) {
        columns.push('approved_at');
        values.push((options.registrationStatus || 'new') === 'active' ? new Date() : null);
    }

    const placeholders = columns.map(() => '?').join(', ');
    const result = await query(
        `INSERT INTO users (${columns.join(', ')})
         VALUES (${placeholders})`,
        values
    );

    return {
        id: result.insertId,
        name,
        email,
        phone,
        location_name: locationName,
        location_address: locationAddress,
        latitude,
        longitude,
        client_code: clientCode,
        role: 'client',
        registration_status: options.registrationStatus || 'new'
    };
}

// POST /api/auth/login - Login utente
router.post('/login', async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '').trim();

        if (!email || !password) {
            return res.status(400).json({ error: 'Email e password richiesti' });
        }

        const users = await query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(401).json({ error: 'Credenziali non valide' });
        }

        const user = users[0];
        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Credenziali non valide' });
        }

        const normalizedRole = normalizeAdminRole(user.role);
        const token = buildAuthToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: normalizedRole
        });

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                language: user.language,
                role: normalizedRole
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// POST /api/auth/register - Registrazione base compatibile
router.post('/register', async (req, res) => {
    try {
        const createdUser = await createRegisteredClient(req.body, {
            registrationStatus: 'new',
            registrationSource: 'public'
        });

        const token = buildAuthToken(createdUser);
        res.status(201).json({
            token,
            user: createdUser
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(error.statusCode || 500).json({ error: error.message || 'Errore interno del server' });
    }
});

// POST /api/auth/send-otp - OTP disattivato
router.post('/send-otp', async (req, res) => {
    res.status(410).json({ error: 'La verifica OTP non è più attiva su Rayat.' });
});

// POST /api/auth/verify-otp - OTP disattivato
router.post('/verify-otp', async (req, res) => {
    res.status(410).json({ error: 'La verifica OTP non è più attiva su Rayat.' });
});

// POST /api/auth/register-full - Registrazione completa senza OTP
router.post('/register-full', async (req, res) => {
    try {
        const createdUser = await createRegisteredClient(req.body, {
            registrationStatus: 'new',
            registrationSource: 'public'
        });

        const token = buildAuthToken(createdUser);
        res.status(201).json({
            success: true,
            token,
            user: createdUser
        });
    } catch (error) {
        console.error('Full Register error:', error);
        res.status(error.statusCode || 500).json({ error: error.message || 'Errore registrazione' });
    }
});

module.exports = router;
