/**
 * Rayat – Avvio Automatico
 * Questo script esegue la migrazione del database, crea l'admin e avvia il server.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 Avvio configurazione Rayat...');

try {
    // 1. Esegui il seeder (che gestisce anche la creazione utente)
    console.log(' cercando di creare l\'utente admin...');
    execSync('node seed-admin.js', { stdio: 'inherit' });

    console.log('✅ Configurazione completata!');
    console.log('🌍 Il server si sta avviando su http://localhost:3000/admin');
    console.log('---');

    // 2. Avvia il server
    require('./server.js');

} catch (error) {
    console.error('❌ Errore durante l\'avvio:', error.message);
}
