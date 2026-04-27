const jwt = require('jsonwebtoken');

const ADMIN_SESSION_COOKIE = 'rayat_admin_session';

function normalizeAdminRole(role) {
    if (role === 'operator' || role === 'operator_admin') {
        return 'admin';
    }
    return role;
}

function isPrivilegedAdminRole(role) {
    return ['super_admin', 'admin'].includes(normalizeAdminRole(role));
}

function parseCookieHeader(cookieHeader = '') {
    return cookieHeader
        .split(';')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .reduce((cookies, pair) => {
            const separatorIndex = pair.indexOf('=');
            if (separatorIndex === -1) {
                return cookies;
            }

            const key = pair.slice(0, separatorIndex).trim();
            const value = decodeURIComponent(pair.slice(separatorIndex + 1).trim());
            if (key) {
                cookies[key] = value;
            }
            return cookies;
        }, {});
}

function extractAdminSessionToken(req) {
    const cookies = parseCookieHeader(req.headers.cookie || '');
    return cookies[ADMIN_SESSION_COOKIE] || null;
}

function getAdminSessionCookieOptions(req) {
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: Boolean(isSecure),
        maxAge: 8 * 60 * 60 * 1000,
        path: '/'
    };
}

function signAdminToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            name: user.name,
            role: normalizeAdminRole(user.role)
        },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
    );
}

module.exports = {
    ADMIN_SESSION_COOKIE,
    normalizeAdminRole,
    isPrivilegedAdminRole,
    extractAdminSessionToken,
    getAdminSessionCookieOptions,
    signAdminToken
};
