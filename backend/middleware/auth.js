const jwt = require('jsonwebtoken');
const { query, getTableColumns } = require('../config/database');
const { isPrivilegedAdminRole, normalizeAdminRole } = require('../utils/admin-auth');
const {
    hasCustomerPermission,
    isCustomerPlatformRole,
    resolveCustomerAccessContextByUserId,
    resolveCustomerScope
} = require('../utils/customer-access');
const { sendDatabaseAwareError } = require('../utils/database-http');

async function attachAuthenticatedUserContext(tokenUser) {
    const resolvedUser = await resolveCustomerAccessContextByUserId(tokenUser.id);

    if (!resolvedUser) {
        return null;
    }

    return {
        ...tokenUser,
        role: normalizeAdminRole(resolvedUser.role || tokenUser.role),
        active: resolvedUser.active,
        owner_user_id: resolvedUser.owner_user_id,
        customer_role: resolvedUser.customer_role,
        permissions: resolvedUser.permissions,
        is_primary_account: resolvedUser.is_primary_account,
        scopeOwnerUserId: resolvedUser.scope_owner_user_id
    };
}

// Middleware per verificare JWT token
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: 'Token di autenticazione mancante' });
    }

    try {
        const tokenUser = jwt.verify(token, process.env.JWT_SECRET);
        const resolvedUser = await attachAuthenticatedUserContext(tokenUser);

        if (!resolvedUser || resolvedUser.active === false) {
            return res.status(403).json({ error: 'Utente non valido o disattivato' });
        }

        req.user = resolvedUser;
        next();
    } catch (_error) {
        return res.status(403).json({ error: 'Token non valido o scaduto' });
    }
}

// Middleware opzionale per autenticazione (non blocca se manca token)
async function optionalAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        try {
            const tokenUser = jwt.verify(token, process.env.JWT_SECRET);
            const resolvedUser = await attachAuthenticatedUserContext(tokenUser);
            if (resolvedUser && resolvedUser.active !== false) {
                req.user = resolvedUser;
            }
        } catch (_error) {
            // noop: optional auth should not block the request
        }
    }

    next();
}

function requireCustomerPermission(permissionKey) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Utente non autenticato' });
        }

        if (isPrivilegedAdminRole(req.user.role)) {
            return next();
        }

        if (!isCustomerPlatformRole(req.user.role)) {
            return res.status(403).json({ error: 'Accesso negato' });
        }

        if (!hasCustomerPermission(req.user, permissionKey)) {
            return res.status(403).json({ error: 'Permessi insufficienti' });
        }

        return next();
    };
}

// Middleware per bloccare utenti con abbonamento scaduto
// RAYAT FIX - popup subscription / new customers / email
async function checkSubscription(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Utente non autenticato' });

    const normalizedRole = normalizeAdminRole(req.user.role);

    // Admin and operators are never blocked
    if (['super_admin', 'operator_admin'].includes(normalizedRole)) {
        return next();
    }

    // Only customer accounts are subject to subscription checks
    if (!isCustomerPlatformRole(normalizedRole)) {
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
        if (userColumns.has('registration_status')) {
            selectedColumns.push('registration_status');
        }
        if (userColumns.has('approved_at')) {
            selectedColumns.push('approved_at');
        }
        if (userColumns.has('active')) {
            selectedColumns.push('active');
        }

        if (selectedColumns.length === 0) {
            return next();
        }

        const rows = await query(
            `SELECT ${selectedColumns.join(', ')} FROM users WHERE id = ?`,
            [resolveCustomerScope(req.user)]
        );
        if (!rows.length) return res.status(404).json({ error: 'Utente non trovato' });

        const user = rows[0];
        const isConfirmedCustomer = user.registration_status === 'active'
            || Boolean(user.approved_at)
            || (user.registration_status == null && user.active === true);

        if (!isConfirmedCustomer) {
            return next();
        }

        const expiryDate = user.subscription_expiry ? new Date(user.subscription_expiry) : null;
        if (!expiryDate || Number.isNaN(expiryDate.getTime())) {
            return next();
        }

        if (expiryDate < new Date()) {
            return res.status(403).json({ error: 'subscription_expired', message: 'Abonnement expiré. Contactez Rayat.' });
        }

        next();
    } catch (err) {
        console.error('Check subscription error:', err);
        return sendDatabaseAwareError(res, err, {
            fallbackMessage: 'Errore interno del server',
            databaseMessage: 'Verifica abbonamento temporaneamente non disponibile'
        });
    }
}

module.exports = {
    authenticateToken,
    optionalAuth,
    checkSubscription,
    requireCustomerPermission
};
