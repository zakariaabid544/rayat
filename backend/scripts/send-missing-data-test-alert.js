#!/usr/bin/env node

require('../config/env');

const { sendMissingDataTestEmail } = require('../src/jobs/alertJob');

async function main() {
    try {
        const result = await sendMissingDataTestEmail();
        console.log('[alert-test] Email di prova inviata con successo.');
        console.log(`[alert-test] Ultimo dato simulato: ${result.lastUpdate.toISOString()}`);
        console.log(`[alert-test] Minuti simulati senza dati: ${result.minutesSinceLastData}`);
    } catch (error) {
        console.error('[alert-test] Invio fallito:', error.message);
        process.exit(1);
    }
}

void main();
