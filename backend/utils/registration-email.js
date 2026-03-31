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

    const user = String(process.env.EMAIL_USER || '').trim();
    const pass = String(process.env.EMAIL_PASS || '').trim();

    if (!user || !pass) {
        return null;
    }

    const inferredService = inferMailService(user);
    const transportOptions = inferredService
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

// RAYAT FIX - email + analytics
async function sendNewClientRegistrationEmail(client = {}) {
    const transporter = getRegistrationMailTransporter();
    const to = String(process.env.EMAIL_TO || 'zakariaabid@hotmail.it').trim();
    const from = String(process.env.EMAIL_USER || '').trim();

    if (!transporter || !to || !from) {
        console.warn('Email nuovo cliente non inviata: configura EMAIL_USER, EMAIL_PASS e EMAIL_TO.');
        return false;
    }

    const registrationDate = client.created_at
        ? new Date(client.created_at)
        : new Date();

    await transporter.sendMail({
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

    return true;
}

module.exports = {
    sendNewClientRegistrationEmail
};
