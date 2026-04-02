const nodemailer = require('nodemailer');

let mailTransporter = null;

function trimEnvValue(value) {
    return String(value || '').trim();
}

function inferMailService(emailUser = '') {
    const domain = String(emailUser || '').split('@')[1]?.toLowerCase() || '';

    if (domain.includes('gmail') || domain.includes('googlemail')) {
        return 'gmail';
    }
    if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) {
        return 'hotmail';
    }
    if (domain.includes('yahoo')) {
        return 'yahoo';
    }

    return null;
}

function buildRequiredEnvBlock() {
    return [
        'SMTP_HOST=',
        'SMTP_PORT=',
        'SMTP_USER=',
        'SMTP_PASS=',
        'SMTP_FROM=',
        'EMAIL_TO=zakariaabid@hotmail.it',
        'EMAIL_USER=  # optional compatibility alias for SMTP_USER',
        'EMAIL_PASS=  # optional compatibility alias for SMTP_PASS',
        'EMAIL_FROM=  # optional compatibility alias for SMTP_FROM'
    ].join('\n');
}

function resolveRegistrationMailConfig() {
    const smtpUser = trimEnvValue(process.env.SMTP_USER);
    const emailUser = trimEnvValue(process.env.EMAIL_USER);
    const smtpPass = trimEnvValue(process.env.SMTP_PASS);
    const emailPass = trimEnvValue(process.env.EMAIL_PASS);
    const hasSmtpPair = Boolean(smtpUser && smtpPass);
    const hasEmailPair = Boolean(emailUser && emailPass);
    const transportUser = hasSmtpPair ? smtpUser : hasEmailPair ? emailUser : smtpUser || emailUser;
    const transportPass = hasSmtpPair ? smtpPass : hasEmailPair ? emailPass : smtpPass || emailPass;
    const smtpHost = trimEnvValue(process.env.SMTP_HOST);
    const smtpPort = Number.parseInt(trimEnvValue(process.env.SMTP_PORT), 10);
    const from = trimEnvValue(process.env.SMTP_FROM || process.env.EMAIL_FROM);
    const to = trimEnvValue(process.env.EMAIL_TO);
    const missingConfigKeys = [];

    if (!transportUser) {
        missingConfigKeys.push('SMTP_USER or EMAIL_USER');
    }
    if (!transportPass) {
        missingConfigKeys.push('SMTP_PASS or EMAIL_PASS');
    }
    if (!from) {
        missingConfigKeys.push('SMTP_FROM or EMAIL_FROM');
    }
    if (!to) {
        missingConfigKeys.push('EMAIL_TO');
    }

    return {
        smtpHost,
        smtpPort,
        transportUser,
        transportPass,
        from,
        to,
        missingConfigKeys,
        credentialSource: hasSmtpPair ? 'SMTP_*' : hasEmailPair ? 'EMAIL_* compatibility alias' : 'incomplete'
    };
}

function getRegistrationMailTransporter(config = resolveRegistrationMailConfig()) {
    if (mailTransporter) {
        return mailTransporter;
    }

    if (config.missingConfigKeys.length > 0) {
        console.warn('[registration-email] Mail transporter not created: missing configuration.', {
            missingConfigKeys: config.missingConfigKeys,
            recipient: config.to || null,
            sender: config.from || null,
            credentialSource: config.credentialSource,
            requiredEnv: buildRequiredEnvBlock()
        });
        return null;
    }

    const inferredService = inferMailService(config.transportUser);
    const hasExplicitSmtp = Boolean(config.smtpHost);
    const resolvedPort = Number.isFinite(config.smtpPort) && config.smtpPort > 0 ? config.smtpPort : 587;
    const transportOptions = hasExplicitSmtp
        ? {
            host: config.smtpHost,
            port: resolvedPort,
            secure: resolvedPort === 465,
            auth: { user: config.transportUser, pass: config.transportPass },
            tls: { rejectUnauthorized: false }
        }
        : inferredService
            ? {
                service: inferredService,
                auth: { user: config.transportUser, pass: config.transportPass }
            }
            : {
                host: 'smtp.gmail.com',
                port: 465,
                secure: true,
                auth: { user: config.transportUser, pass: config.transportPass }
            };

    try {
        mailTransporter = nodemailer.createTransport(transportOptions);
        console.info('[registration-email] Mail transporter created.', {
            mode: hasExplicitSmtp ? 'smtp-host' : inferredService ? 'service:' + inferredService : 'default-gmail',
            host: hasExplicitSmtp ? config.smtpHost : null,
            port: hasExplicitSmtp ? resolvedPort : null,
            credentialSource: config.credentialSource,
            sender: config.from
        });
        return mailTransporter;
    } catch (error) {
        console.error('[registration-email] Failed to create mail transporter.', {
            error: error.message,
            missingConfigKeys: config.missingConfigKeys,
            credentialSource: config.credentialSource,
            requiredEnv: buildRequiredEnvBlock()
        });
        return null;
    }
}

function formatValue(value) {
    if (value === null || value === undefined) {
        return '-';
    }

    const normalizedValue = String(value).trim();
    return normalizedValue || '-';
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildFullName(client = {}) {
    const fullName = [client.name, client.last_name]
        .map(part => String(part || '').trim())
        .filter(Boolean)
        .join(' ');

    return fullName || '-';
}

function formatRegistrationTimestamp(value) {
    const parsedDate = value ? new Date(value) : new Date();

    if (Number.isNaN(parsedDate.getTime())) {
        return formatValue(value);
    }

    return parsedDate.toLocaleString('it-IT') + ' (' + parsedDate.toISOString() + ')';
}

function buildAdminNotificationRows(client = {}) {
    return [
        ['Full name', buildFullName(client)],
        ['Email', formatValue(client.email)],
        ['Phone', formatValue(client.phone)],
        ['Crop type', formatValue(client.crop_type)],
        ['Location name', formatValue(client.location_name)],
        ['Location address', formatValue(client.location_address)],
        ['Latitude', formatValue(client.latitude)],
        ['Longitude', formatValue(client.longitude)],
        ['Client code', formatValue(client.client_code)],
        ['Registration source', formatValue(client.registration_source)],
        ['Registration status', formatValue(client.registration_status)],
        ['Registration timestamp', formatRegistrationTimestamp(client.created_at)]
    ];
}

function buildAdminNotificationText(rows) {
    return [
        'A new customer completed a public registration on Rayat.',
        '',
        ...rows.map(([label, value]) => label + ': ' + value)
    ].join('\n');
}

function buildAdminNotificationHtml(rows) {
    const tableRows = rows
        .map(([label, value]) => (
            '<tr>' +
                '<td style="padding:8px 12px;border:1px solid #d9e2ec;font-weight:600;background:#f8fafc;">' + escapeHtml(label) + '</td>' +
                '<td style="padding:8px 12px;border:1px solid #d9e2ec;">' + escapeHtml(value) + '</td>' +
            '</tr>'
        ))
        .join('');

    return [
        '<div style="font-family:Arial,sans-serif;color:#102a43;line-height:1.5;">',
        '<p style="margin:0 0 16px;">A new customer completed a public registration on <strong>Rayat</strong>.</p>',
        '<table style="border-collapse:collapse;width:100%;max-width:720px;">',
        '<tbody>',
        tableRows,
        '</tbody>',
        '</table>',
        '</div>'
    ].join('');
}

async function sendNewClientRegistrationEmail(client = {}) {
    const config = resolveRegistrationMailConfig();
    const transporter = getRegistrationMailTransporter(config);
    const subject = 'New customer registration - Rayat';

    if (!transporter) {
        console.warn('[registration-email] Admin notification skipped: transporter unavailable.', {
            recipient: config.to || null,
            subject,
            missingConfigKeys: config.missingConfigKeys,
            requiredEnv: buildRequiredEnvBlock()
        });
        return false;
    }

    const rows = buildAdminNotificationRows(client);
    const mailOptions = {
        from: config.from,
        to: config.to,
        subject,
        text: buildAdminNotificationText(rows),
        html: buildAdminNotificationHtml(rows)
    };

    console.info('[registration-email] Sending admin notification.', {
        recipient: config.to,
        subject,
        registrationId: client.id || null,
        registrationEmail: client.email || null,
        registrationStatus: client.registration_status || null,
        registrationSource: client.registration_source || null
    });

    try {
        const info = await transporter.sendMail(mailOptions);

        console.info('[registration-email] Admin notification sent.', {
            recipient: config.to,
            subject,
            messageId: info.messageId || null,
            accepted: info.accepted || [],
            rejected: info.rejected || []
        });
        return true;
    } catch (error) {
        console.error('[registration-email] Admin notification send failed.', {
            recipient: config.to,
            subject,
            registrationId: client.id || null,
            registrationEmail: client.email || null,
            error: error.message,
            code: error.code || null,
            command: error.command || null
        });
        throw error;
    }
}

module.exports = {
    sendNewClientRegistrationEmail
};
