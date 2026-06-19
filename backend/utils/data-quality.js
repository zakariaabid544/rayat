// Rayat Intelligence — Sprint 1.2 · Quality Gate / Data Gap (additivo, sola lettura)
// Riusa le soglie di freshness/offline GIA esistenti in monitoring-config.js.
// Durante data gap / offline / dati non freschi -> ok=false: il motore NON genera eventi agronomici.
const {
    getOfflineAfterMinutes,
    getSensorDataFreshMinutes,
    getMissingDataThresholdMinutes
} = require('./monitoring-config');

function minutesToMs(minutes) {
    return Number(minutes) * 60 * 1000;
}

// Ritorna { ok, status, reason }
// status: 'ok' | 'offline' | 'data_gap' | 'stale' | 'insufficient'
function assessDataQuality({ device, latestReadingAt, readingsInWindow, now = Date.now() }) {
    const offlineAfter = getOfflineAfterMinutes();
    const freshMinutes = getSensorDataFreshMinutes();
    const missingMinutes = getMissingDataThresholdMinutes();

    // Device/gateway offline
    if (device && device.status && String(device.status).toLowerCase() !== 'active') {
        return { ok: false, status: 'offline', reason: `device status=${device.status}` };
    }
    const lastSeen = device && device.last_seen ? new Date(device.last_seen).getTime() : null;
    if (lastSeen && (now - lastSeen) > minutesToMs(offlineAfter)) {
        return { ok: false, status: 'offline', reason: 'device last_seen stale' };
    }

    // Nessun dato / troppo vecchio (data gap)
    const last = latestReadingAt ? new Date(latestReadingAt).getTime() : null;
    if (!last) {
        return { ok: false, status: 'data_gap', reason: 'no readings in window' };
    }
    if ((now - last) > minutesToMs(missingMinutes)) {
        return { ok: false, status: 'data_gap', reason: 'readings older than missing-data threshold' };
    }
    if ((now - last) > minutesToMs(freshMinutes)) {
        return { ok: false, status: 'stale', reason: 'latest reading not fresh' };
    }

    // Coverage minima
    if (!readingsInWindow || Number(readingsInWindow) < 2) {
        return { ok: false, status: 'insufficient', reason: 'insufficient samples in window' };
    }

    return { ok: true, status: 'ok', reason: null };
}

module.exports = { assessDataQuality };
