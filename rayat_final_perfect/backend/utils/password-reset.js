const bcrypt = require('bcrypt');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { query, withTransaction } = require('../config/database');

const DEFAULT_RESET_EXPIRY_MINUTES = 45;
const GENERIC_FORGOT_PASSWORD_RESPONSE = {
    success: true,
    message: 'Se l\'account esiste, riceverai un\'email con le istruzioni per reimpostare la password.'
};

let mailTransporter = null;

function createHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function normalizePassword(value) {
    return String(value || '').trim();
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function getResetExpiryMinutes() {
    const parsed = Number.parseInt(process.env.PASSWORD_RESET_EXPIRY_MINUTES, 10);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_RESET_EXPIRY_MINUTES;
    }

    return Math.min(60, Math.max(30, parsed));
}

function getResetUrl(resetPath = '/reset-password') {
    const configuredUrl = String(process.env.PASSWORD_RESET_URL || '').trim();
    if (configuredUrl) {
        return configuredUrl;
    }

    const origin = String(
        process.env.APP_BASE_URL ||
        process.env.PUBLIC_APP_URL ||
        process.env.CORS_ORIGIN ||
        'https://yourdomain'
    ).trim().replace(/\/+$/, '');

    const normalizedPath = resetPath.startsWith('/') ? resetPath : `/${resetPath}`;
    return `${origin}${normalizedPath}`;
}

function getMailTransporter() {
    if (mailTransporter) {
        return mailTransporter;
    }

    const host = String(process.env.SMTP_HOST || '').trim();
    const port = Number.parseInt(process.env.SMTP_PORT, 10);
    const user = String(process.env.SMTP_USER || '').trim();
    const pass = String(process.env.SMTP_PASS || '').trim();

    if (!host || !Number.isFinite(port) || !user || !pass) {
        return null;
    }

    const nodemailer = require('nodemailer');
    mailTransporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: {
            user,
            pass
        }
    });

    return mailTransporter;
}

async function sendResetEmail({ email, name, rawToken, resetPath }) {
    const resetLink = `${getResetUrl(resetPath)}?token=${encodeURIComponent(rawToken)}`;
    const transporter = getMailTransporter();
    const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();

    if (!transporter || !from) {
        console.warn(`SMTP non configurato: email di reset non inviata per ${email}. Configura SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS e SMTP_FROM.`);
        return;
    }

    await transporter.sendMail({
        from,
        to: email,
        subject: 'Rayat - Reinitialisation du mot de passe',
        text: [
            `Bonjour ${name || 'utilisateur'},`,
            '',
            'Nous avons recu une demande de reinitialisation de votre mot de passe Rayat.',
            `Lien de reinitialisation: ${resetLink}`,
            '',
            `Ce lien expire dans ${getResetExpiryMinutes()} minutes et ne peut etre utilise qu'une seule fois.`,
            'Si vous n\'etes pas a l\'origine de cette demande, vous pouvez ignorer cet email.'
        ].join('\n'),
        html: `
            <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a">
                <h2 style="color:#166534;margin-bottom:16px;">Rayat Smart Monitoring</h2>
                <p>Bonjour ${name || 'utilisateur'},</p>
                <p>Nous avons recu une demande de reinitialisation de votre mot de passe.</p>
                <p style="margin:24px 0;">
                    <a href="${resetLink}" style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:12px;font-weight:700;">
                        Reinitialiser mon mot de passe
                    </a>
                </p>
                <p>Ce lien expire dans <strong>${getResetExpiryMinutes()} minutes</strong> et ne peut etre utilise qu'une seule fois.</p>
                <p>Si vous n'etes pas a l'origine de cette demande, vous pouvez ignorer cet email.</p>
                <p style="margin-top:24px;font-size:12px;color:#64748b;">Lien direct: ${resetLink}</p>
            </div>
        `
    });
}

function buildScopeSql(userScopeSql = '') {
    return userScopeSql ? ` ${userScopeSql.trim()}` : '';
}

async function issuePasswordReset({
    email,
    resetPath = '/reset-password',
    userScopeSql = '',
    userScopeParams = []
}) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
        throw createHttpError(400, 'Email richiesta');
    }

    const scopeSql = buildScopeSql(userScopeSql);
    const users = await query(
        `SELECT id, email, name
         FROM users
         WHERE email = ?${scopeSql}
         LIMIT 1`,
        [normalizedEmail, ...userScopeParams]
    );

    if (!users.length) {
        return {
            success: false,
            dispatched: false
        };
    }

    const user = users[0];
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + getResetExpiryMinutes() * 60 * 1000);

    await query(
        `UPDATE password_resets
         SET used = TRUE
         WHERE user_id = ?
           AND used = FALSE`,
        [user.id]
    );

    const result = await query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at, used)
         VALUES (?, ?, ?, FALSE)`,
        [user.id, tokenHash, expiresAt]
    );

    try {
        await sendResetEmail({
            email: user.email,
            name: user.name,
            rawToken,
            resetPath
        });
    } catch (error) {
        await query(
            `UPDATE password_resets
             SET used = TRUE
             WHERE id = ?`,
            [result.insertId]
        );
        throw error;
    }

    return {
        success: true,
        dispatched: true
    };
}

async function connectionQuery(connection, sql, params = []) {
    const [result] = await connection.execute(sql, params);
    return result;
}

async function consumePasswordReset({
    token,
    newPassword,
    userScopeSql = '',
    userScopeParams = []
}) {
    const normalizedPassword = normalizePassword(newPassword);
    if (!token || !normalizedPassword) {
        throw createHttpError(400, 'Token e nuova password sono obbligatori');
    }

    if (normalizedPassword.length < 8) {
        throw createHttpError(400, 'La nuova password deve contenere almeno 8 caratteri');
    }

    const scopeSql = buildScopeSql(userScopeSql);
    const tokenHash = hashToken(token);

    return withTransaction(async (connection) => {
        const rows = await connectionQuery(
            connection,
            `SELECT pr.id, pr.user_id, pr.expires_at, pr.used, u.email, u.name
             FROM password_resets pr
             INNER JOIN users u ON u.id = pr.user_id
             WHERE pr.token_hash = ?${scopeSql}
             LIMIT 1
             FOR UPDATE`,
            [tokenHash, ...userScopeParams]
        );

        if (!rows.length) {
            throw createHttpError(400, 'Token non valido o scaduto');
        }

        const resetRecord = rows[0];
        if (resetRecord.used || new Date(resetRecord.expires_at) < new Date()) {
            throw createHttpError(400, 'Token non valido o scaduto');
        }

        const passwordHash = await bcrypt.hash(normalizedPassword, 12);

        await connectionQuery(
            connection,
            `UPDATE users
             SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [passwordHash, resetRecord.user_id]
        );

        await connectionQuery(
            connection,
            `UPDATE password_resets
             SET used = TRUE
             WHERE user_id = ?
               AND used = FALSE`,
            [resetRecord.user_id]
        );

        return {
            success: true,
            email: resetRecord.email,
            name: resetRecord.name
        };
    });
}

function createForgotPasswordLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000,
        max: Number.parseInt(process.env.PASSWORD_RESET_RATE_LIMIT_MAX, 10) || 5,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Troppe richieste, riprova più tardi.' }
    });
}

function attachPasswordResetRoutes(router, options = {}) {
    const {
        resetPath = '/reset-password',
        userScopeSql = '',
        userScopeParams = [],
        forgotPasswordLimiter = createForgotPasswordLimiter()
    } = options;

    router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
        try {
            await issuePasswordReset({
                email: req.body.email,
                resetPath,
                userScopeSql,
                userScopeParams
            });

            res.json(GENERIC_FORGOT_PASSWORD_RESPONSE);
        } catch (error) {
            console.error('Forgot password error:', error);
            if (error.statusCode === 400) {
                return res.status(400).json({ error: error.message });
            }

            res.json(GENERIC_FORGOT_PASSWORD_RESPONSE);
        }
    });

    router.post('/reset-password', async (req, res) => {
        try {
            await consumePasswordReset({
                token: String(req.body.token || '').trim(),
                newPassword: req.body.newPassword,
                userScopeSql,
                userScopeParams
            });

            res.json({
                success: true,
                message: 'Password aggiornata correttamente'
            });
        } catch (error) {
            console.error('Reset password error:', error);
            res.status(error.statusCode || 500).json({
                error: error.statusCode ? error.message : 'Errore interno del server'
            });
        }
    });
}

module.exports = {
    GENERIC_FORGOT_PASSWORD_RESPONSE,
    attachPasswordResetRoutes,
    consumePasswordReset,
    createForgotPasswordLimiter,
    issuePasswordReset
};
