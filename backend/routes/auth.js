const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { query, getTableColumns } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isPrivilegedAdminRole, normalizeAdminRole } = require('../utils/admin-auth');
const { attachPasswordResetRoutes } = require('../utils/password-reset');
const { sendNewClientRegistrationEmail } = require('../utils/registration-email');
const { recordAnalyticsEvent } = require('../utils/analytics');

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
            role: normalizeAdminRole(user.role)
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
}

async function getUserColumnFlags() {
    const columns = await getTableColumns('users');
    return {
        hasLastName: columns.has('last_name'),
        hasLanguage: columns.has('language'),
        hasClientCode: columns.has('client_code'),
        hasLocationAddress: columns.has('location_address'),
        hasPaymentStatus: columns.has('payment_status'),
        hasSubscriptionExpiry: columns.has('subscription_expiry'),
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

// RAYAT FIX - registration/admin
function normalizeRegistrationNameParts(payload = {}) {
    const rawFirstName = String(payload.name || payload.first_name || '').trim();
    const rawLastName = String(payload.last_name || payload.surname || payload.lastName || '').trim();

    if (rawFirstName && rawLastName) {
        return {
            firstName: rawFirstName,
            lastName: rawLastName
        };
    }

    const fullName = rawFirstName;
    if (!fullName) {
        return {
            firstName: '',
            lastName: ''
        };
    }

    const parts = fullName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return {
            firstName: parts.slice(0, -1).join(' '),
            lastName: parts.slice(-1).join('')
        };
    }

    return {
        firstName: fullName,
        lastName: ''
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

// RAYAT FIX - popup subscription / new customers / email
async function createRegisteredClient(payload, options = {}) {
    const flags = await getUserColumnFlags();
    const { firstName, lastName } = normalizeRegistrationNameParts(payload);
    const name = firstName;
    const email = String(payload.email || '').trim().toLowerCase();
    const phone = String(payload.phone || '').trim();
    const password = String(payload.password || '').trim();
    const locationName = normalizeRegistrationLocation(payload);
    const locationAddress = normalizeLocationAddress(payload, locationName) || null;
    const latitude = normalizeCoordinate(payload.latitude);
    const longitude = normalizeCoordinate(payload.longitude);

    if (!name || !lastName || !email || !phone || !password || !locationName) {
        const error = new Error('Nome, cognome, email, telefono, password e località sono obbligatori');
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
        ...(flags.hasLastName ? ['last_name'] : []),
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
        ...(flags.hasLastName ? [lastName] : []),
        email,
        phone,
        passwordHash,
        payload.crop_type || null,
        latitude,
        longitude,
        locationName,
        true,
        false,
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

    const createdAt = new Date().toISOString();

    return {
        id: result.insertId,
        name,
        last_name: lastName,
        email,
        phone,
        crop_type: payload.crop_type || null,
        location_name: locationName,
        location_address: locationAddress,
        latitude,
        longitude,
        client_code: clientCode,
        role: 'client',
        active: false,
        payment_status: flags.hasPaymentStatus ? 'non_pagato' : null,
        subscription_expiry: flags.hasSubscriptionExpiry ? null : null,
        registration_status: options.registrationStatus || 'new',
        registration_source: options.registrationSource || 'public',
        approved_at: null,
        created_at: createdAt
    };
}

// RAYAT FIX - email + analytics
async function finalizeClientRegistration(req, createdUser) {
    try {
        await sendNewClientRegistrationEmail(createdUser);
    } catch (error) {
        console.warn('Nuova registrazione salvata ma email non inviata:', error.message);
    }

    try {
        await recordAnalyticsEvent(req, {
            eventType: 'registration_completed',
            eventName: 'Registration Completed',
            pagePath: '/register'
        });
    } catch (error) {
        console.warn('Analytics registrazione completata non salvato:', error.message);
    }
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
            console.log('❌ User not found');
            return res.status(401).json({ error: 'Credenziali non valide' });
        }

        const user = users[0];
        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            console.log('❌ Wrong password');
            return res.status(401).json({ error: 'Credenziali non valide' });
        }

        const normalizedRole = normalizeAdminRole(user.role);
        const token = buildAuthToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: normalizedRole
        });

        console.log('✅ Login success');

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                last_name: user.last_name || null,
                language: user.language,
                role: normalizedRole,
                active: user.active,
                payment_status: user.payment_status || null,
                subscription_expiry: user.subscription_expiry || null,
                registration_status: user.registration_status || null,
                approved_at: user.approved_at || null
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

router.post('/admin-reset-password', authenticateToken, async (req, res) => {
    try {
        const normalizedRole = normalizeAdminRole(req.user && req.user.role);
        if (!isPrivilegedAdminRole(normalizedRole)) {
            return res.status(403).json({ error: 'Accesso riservato agli amministratori.' });
        }

        const newPassword = String(req.body.newPassword || '').trim();
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'La nuova password deve contenere almeno 8 caratteri' });
        }

        const users = await query(
            'SELECT id, role, active FROM users WHERE id = ?',
            [req.user.id]
        );

        if (!users.length || !users[0].active) {
            return res.status(403).json({ error: 'Account amministratore non valido o disattivato.' });
        }

        if (!isPrivilegedAdminRole(users[0].role)) {
            return res.status(403).json({ error: 'Accesso riservato agli amministratori.' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await query(
            `UPDATE users
             SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [passwordHash, req.user.id]
        );

        res.json({
            success: true,
            message: 'Password admin aggiornata correttamente'
        });
    } catch (error) {
        console.error('Admin reset password error:', error);
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
        await finalizeClientRegistration(req, createdUser);

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
        await finalizeClientRegistration(req, createdUser);

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
