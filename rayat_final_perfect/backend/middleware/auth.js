const jwt = require('jsonwebtoken');
const { query, getTableColumns } = require('../config/database');
const { normalizeAdminRole } = require('../utils/admin-auth');

// Middleware per verificare JWT token
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: 'Token di autenticazione mancante' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token non valido o scaduto' });
        }

        req.user = {
            ...user,
            role: normalizeAdminRole(user.role)
        }; // Aggiunge user info alla request
        next();
    });
}

// Middleware opzionale per autenticazione (non blocca se manca token)
function optionalAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (!err) {
                req.user = {
                    ...user,
                    role: normalizeAdminRole(user.role)
                };
            }
        });
    }

    next();
}

// Middleware per bloccare utenti con abbonamento scaduto
async function checkSubscription(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Utente non autenticato' });

    const normalizedRole = normalizeAdminRole(req.user.role);

    // Admin and operators are never blocked
    if (['super_admin', 'operator_admin'].includes(normalizedRole)) {
        return next();
    }

    // Only customer accounts are subject to subscription checks
    if (!['client', 'farmer'].includes(normalizedRole)) {
        return next();
    }

    try {
        const userColumns = await getTableColumns('users');
        const selectedColumns = [];

        if (userColumns.has('payment_status')) {
            selectedColumns.push('payment_status');
        }
        if (userColumns.has('subscription_expiry')) {
            selectedColumns.push('subscription_expiry');
        }

        if (selectedColumns.length === 0) {
            return next();
        }

        const rows = await query(
            `SELECT ${selectedColumns.join(', ')} FROM users WHERE id = ?`,
            [req.user.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Utente non trovato' });

        const user = rows[0];

        if (user.payment_status === 'non_pagato') {
            return res.status(403).json({ error: 'subscription_expired', message: 'Abonnement expiré. Contactez Rayat.' });
        }

        if (user.subscription_expiry && new Date(user.subscription_expiry) < new Date()) {
            return res.status(403).json({ error: 'subscription_expired', message: 'Abonnement expiré. Contactez Rayat.' });
        }

        next();
    } catch (err) {
        console.error('Check subscription error:', err);
        res.status(500).json({ error: 'Errore interno del server' });
    }
}

module.exports = {
    authenticateToken,
    optionalAuth,
    checkSubscription
};
