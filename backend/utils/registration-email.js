const nodemailer = require('nodemailer');

let mailTransporter = null;

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

function getRegistrationMailTransporter() {
    if (mailTransporter) {
        return mailTransporter;
    }

    const user = String(process.env.EMAIL_USER || process.env.SMTP_USER || '').trim();
    const pass = String(process.env.EMAIL_PASS || process.env.SMTP_PASS || '').trim();
    const smtpHost = String(process.env.SMTP_HOST || '').trim();
    const smtpPort = Number.parseInt(process.env.SMTP_PORT || '', 10);

    if (!user || !pass) {
        return null;
    }

    const inferredService = inferMailService(user);
    const hasExplicitSmtp = Boolean(smtpHost);
    const resolvedPort = Number.isFinite(smtpPort) && smtpPort > 0 ? smtpPort : 587;
    const transportOptions = hasExplicitSmtp
        ? {
            host: smtpHost,
            port: resolvedPort,
            secure: resolvedPort === 465,
            auth: { user, pass },
            tls: { rejectUnauthorized: false }
        }
        : inferredService
            ? {
                service: inferredService,
                auth: { user, pass }
            }
            : {
                host: 'smtp.gmail.com',
                port: 465,
                secure: true,
                auth: { user, pass }
            };

    mailTransporter = nodemailer.createTransport(transportOptions);
    return mailTransporter;
}

// RAYAT FIX - full critical admin flow
async function sendNewClientRegistrationEmail(client = {}) {
    const transporter = getRegistrationMailTransporter();
    const to = String(process.env.EMAIL_TO || 'zakariaabid@hotmail.it').trim();
    const from = String(
        process.env.SMTP_FROM ||
        process.env.EMAIL_FROM ||
        process.env.EMAIL_USER ||
        process.env.SMTP_USER ||
        ''
    ).trim();

    if (!transporter || !to || !from) {
        console.warn('Email nuovo cliente non inviata: configura EMAIL_USER/EMAIL_PASS oppure SMTP_USER/SMTP_PASS, più EMAIL_TO.');
        return false;
    }

    const registrationDate = client.created_at
        ? new Date(client.created_at)
        : new Date();

    console.log(`📧 Invio notifica nuovo cliente verso ${to}`);

    let info;
    try {
        info = await transporter.sendMail({
            from,
            to,
            subject: 'Nuovo cliente registrato - Rayat',
            text: [
                'Nuovo cliente registrato su Rayat',
                '',
                `Nome: ${client.name || '—'}`,
                `Cognome: ${client.last_name || '—'}`,
                `Email: ${client.email || '—'}`,
                `Telefono: ${client.phone || '—'}`,
                `Coltura: ${client.crop_type || '—'}`,
                `Data registrazione: ${registrationDate.toLocaleString('it-IT')}`
            ].join('\n')
        });
    } catch (error) {
        console.error('❌ Invio email nuovo cliente fallito:', error);
        throw error;
    }

    console.log('✅ Email nuovo cliente inviata', {
        accepted: info.accepted,
        rejected: info.rejected
    });

    return true;
}

module.exports = {
    sendNewClientRegistrationEmail
};
