function parseMinutes(value, fallback) {
    const normalized = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function hasConfiguredValue(envName) {
    return String(process.env[envName] ?? '').trim() !== '';
}

function isCentralRouterMonitoringEnabled() {
    return hasConfiguredValue('ROUTER_INTERVAL_MINUTES')
        || hasConfiguredValue('ROUTER_OFFLINE_GRACE_MINUTES')
        || hasConfiguredValue('ROUTER_ALERT_EXTRA_MINUTES');
}

function getRouterIntervalMinutes() {
    if (isCentralRouterMonitoringEnabled()) {
        return parseMinutes(process.env.ROUTER_INTERVAL_MINUTES, 30);
    }

    return parseMinutes(process.env.ALERT_EXPECTED_DATA_MINUTES, 30);
}

function getOfflineGraceMinutes() {
    return parseMinutes(process.env.ROUTER_OFFLINE_GRACE_MINUTES, 5);
}

function getRouterAlertExtraMinutes() {
    if (isCentralRouterMonitoringEnabled()) {
        return parseMinutes(process.env.ROUTER_ALERT_EXTRA_MINUTES, 15);
    }

    const legacyThresholdMinutes = parseMinutes(process.env.ALERT_MISSING_DATA_THRESHOLD_MINUTES, 45);
    return Math.max(1, legacyThresholdMinutes - getRouterIntervalMinutes());
}

function getOfflineAfterMinutes() {
    return getRouterIntervalMinutes() + getOfflineGraceMinutes();
}

function getGatewayHeartbeatWindowMinutes() { // RAYAT-FIX
    return parseMinutes(process.env.ROUTER_HEARTBEAT_WINDOW_MINUTES, 5); // RAYAT-FIX
}

function getMissingDataThresholdMinutes() {
    if (isCentralRouterMonitoringEnabled()) {
        return getRouterIntervalMinutes() + getRouterAlertExtraMinutes();
    }

    return parseMinutes(process.env.ALERT_MISSING_DATA_THRESHOLD_MINUTES, 45);
}

function getSensorDataFreshMinutes() { // RAYAT-FIX
    return getMissingDataThresholdMinutes(); // RAYAT-FIX
}

function getMonitoringConfig() {
    const routerIntervalMinutes = getRouterIntervalMinutes();
    const offlineGraceMinutes = getOfflineGraceMinutes();
    const offlineAfterMinutes = getOfflineAfterMinutes();
    const alertExtraMinutes = getRouterAlertExtraMinutes();
    const emailAfterMinutes = getMissingDataThresholdMinutes();
    const gatewayHeartbeatWindowMinutes = getGatewayHeartbeatWindowMinutes(); // RAYAT-FIX
    const sensorDataFreshMinutes = getSensorDataFreshMinutes(); // RAYAT-FIX

    return {
        configSource: isCentralRouterMonitoringEnabled() ? 'router_interval_env' : 'legacy_alert_env',
        routerIntervalMinutes,
        expectedDataMinutes: routerIntervalMinutes,
        offlineGraceMinutes,
        offlineAfterMinutes,
        alertExtraMinutes,
        emailAfterMinutes,
        missingDataThresholdMinutes: emailAfterMinutes,
        gatewayHeartbeatWindowMinutes, // RAYAT-FIX
        sensorDataFreshMinutes // RAYAT-FIX
    };
}

function getPostgresMinuteIntervalLiteral(minutes) {
    const normalized = parseMinutes(minutes, 1);
    return `${normalized} minute${normalized === 1 ? '' : 's'}`;
}

module.exports = {
    getGatewayHeartbeatWindowMinutes, // RAYAT-FIX
    getMonitoringConfig,
    getMissingDataThresholdMinutes,
    getOfflineAfterMinutes,
    getOfflineGraceMinutes,
    getPostgresMinuteIntervalLiteral,
    getRouterAlertExtraMinutes,
    getRouterIntervalMinutes,
    getSensorDataFreshMinutes, // RAYAT-FIX
    isCentralRouterMonitoringEnabled,
    parseMinutes
};
