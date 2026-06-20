'use strict';

const { query } = require('../config/database');
const { normalizeAdminRole } = require('./admin-auth');
const { resolveCustomerScope } = require('./customer-access');

function httpError(status, message, code = 'prediction_access') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function positiveInteger(value, label, required = false) {
    if (value === undefined || value === null || value === '') {
        if (required) { throw httpError(400, `${label} obbligatorio`, 'prediction_validation'); }
        return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw httpError(400, `${label} non valido`, 'prediction_validation');
    }
    return parsed;
}

function isSuperAdmin(user) {
    return normalizeAdminRole(user && user.role) === 'super_admin';
}

function ownerAccess(user, requestedOwnerId = null) {
    if (!user || !positiveInteger(user.id, 'user_id', true)) {
        throw httpError(401, 'Utente non autenticato', 'prediction_auth');
    }
    const requested = positiveInteger(requestedOwnerId, 'owner_user_id');
    if (isSuperAdmin(user)) { return requested; }
    const owner = positiveInteger(resolveCustomerScope(user), 'owner scope', true);
    if (requested && requested !== owner) { throw httpError(403, 'Accesso negato a un altro cliente'); }
    return owner;
}

async function safeRows(executor, sql, params = []) {
    try { return await executor(sql, params); }
    catch (error) {
        if (/does not exist|relation/i.test(error.message || '')) { return []; }
        throw error;
    }
}

async function resolvePredictionTarget({ user, deviceId, contextId, executor = query }) {
    const device = positiveInteger(deviceId, 'device_id', true);
    const context = positiveInteger(contextId, 'context_id', true);
    const devices = await executor(
        `SELECT d.id,COALESCE(u.owner_user_id,u.id) AS owner_user_id
         FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=? LIMIT 1`, [device]
    );
    if (!devices.length) { throw httpError(404, 'Device inesistente'); }
    const actualOwner = Number(devices[0].owner_user_id);
    if (!isSuperAdmin(user) && ownerAccess(user) !== actualOwner) {
        throw httpError(403, 'Accesso negato: device non autorizzato');
    }
    const contexts = await executor(
        `SELECT id,owner_user_id,device_id,context_name,is_production
         FROM agro_context_segments WHERE id=? LIMIT 1`, [context]
    );
    if (!contexts.length) { throw httpError(404, 'Contesto inesistente'); }
    const row = contexts[0];
    if (Number(row.owner_user_id) !== actualOwner || Number(row.device_id) !== device) {
        throw httpError(403, 'Accesso negato: contesto non coerente con device/proprietario');
    }
    return { owner: actualOwner, device, context, context_name: row.context_name,
        is_production: Boolean(row.is_production), super_admin: isSuperAdmin(user) };
}

async function listPredictionContexts({ user, filters = {}, executor = query }) {
    const owner = ownerAccess(user, filters.owner_user_id);
    const params = [];
    const clauses = [
        'c.is_production=TRUE',
        "LOWER(COALESCE(c.usage_type,'')) NOT IN ('demo','test','calibration','maintenance')",
        'c.owner_user_id=COALESCE(u.owner_user_id,u.id)',
        'c.device_id=d.id'
    ];
    if (owner) { clauses.push('c.owner_user_id=?'); params.push(owner); }
    const device = positiveInteger(filters.device_id, 'device_id');
    if (device) { clauses.push('c.device_id=?'); params.push(device); }
    const rows = await executor(
        `SELECT c.owner_user_id,c.device_id,c.id AS context_id,c.context_name,c.crop_label,
                c.medium,c.valid_from,c.valid_to,d.name AS device_name
         FROM agro_context_segments c JOIN devices d ON d.id=c.device_id
         JOIN users u ON u.id=d.user_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY c.owner_user_id,d.name,c.device_id,c.context_name,c.id LIMIT 200`, params
    );
    return { contexts: rows.map((row) => ({
        owner_user_id: Number(row.owner_user_id), device_id: Number(row.device_id),
        context_id: Number(row.context_id), device_name: row.device_name || `Device ${row.device_id}`,
        context_name: row.context_name || `Contesto ${row.context_id}`,
        crop_label: row.crop_label || null, medium: row.medium || null,
        valid_from: row.valid_from, valid_to: row.valid_to
    })) };
}

function paramsFor(target) { return [target.owner, target.device, target.context]; }

async function getMetricForecasts(target, executor = query) {
    return safeRows(executor,
        `SELECT id,sensor_id,metric,generated_at,horizon_minutes,current_value,forecast_value,
                forecast_low,forecast_high,confidence,data_quality_score
         FROM agro_metric_forecasts WHERE owner_user_id=? AND device_id=? AND context_id=?
         ORDER BY metric,sensor_id,horizon_minutes`, paramsFor(target));
}

async function getBreachEta(target, executor = query) {
    return safeRows(executor,
        `SELECT id,sensor_id,metric,generated_at,breach_direction,eta_minutes,eta_confidence,
                threshold_value,horizon_minutes,status,severity
         FROM agro_breach_eta WHERE owner_user_id=? AND device_id=? AND context_id=?
         ORDER BY COALESCE(eta_minutes,2147483647),metric,sensor_id,horizon_minutes`, paramsFor(target));
}

async function getStressEta(target, executor = query) {
    return safeRows(executor,
        `SELECT id,generated_at,stress_type,eta_minutes,stress_probability,stress_confidence,
                current_score,predicted_score,status,severity
         FROM agro_stress_eta WHERE owner_user_id=? AND device_id=? AND context_id=?
         ORDER BY COALESCE(eta_minutes,2147483647),stress_type`, paramsFor(target));
}

async function getRiskForecasts(target, executor = query) {
    return safeRows(executor,
        `SELECT id,generated_at,forecast_horizon_minutes,overall_risk_score,overall_risk_band,
                risk_probability,confidence,predicted_health_score,predicted_intelligence_score,primary_risk
         FROM agro_risk_forecasts WHERE owner_user_id=? AND device_id=? AND context_id=?
         ORDER BY forecast_horizon_minutes`, paramsFor(target));
}

async function getRecoveryForecast(target, executor = query) {
    const rows = await safeRows(executor,
        `SELECT id,generated_at,recovery_probability,estimated_recovery_minutes,
                estimated_recovery_band,confidence,resilience_score,expected_recovery_quality,recovery_risk
         FROM agro_recovery_forecasts WHERE owner_user_id=? AND device_id=? AND context_id=? LIMIT 1`,
        paramsFor(target));
    return rows[0] || null;
}

async function getEarlyWarnings(target, executor = query) {
    return safeRows(executor,
        `SELECT id,generated_at,warning_type,warning_level,warning_score,probability,confidence,
                eta_minutes,title,summary,recommended_action,status,acknowledged_at
         FROM agro_early_warnings WHERE owner_user_id=? AND device_id=? AND context_id=? AND status='active'
         ORDER BY CASE warning_level WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 WHEN 'warning' THEN 3
                  WHEN 'advisory' THEN 4 ELSE 5 END,eta_minutes,warning_type`, paramsFor(target));
}

async function getPredictionOverview({ user, deviceId, contextId, executor = query }) {
    const target = await resolvePredictionTarget({ user, deviceId, contextId, executor });
    const [metric_forecasts, breach_eta, stress_eta, risk_forecasts, recovery_forecast, early_warnings] =
        await Promise.all([
            getMetricForecasts(target, executor), getBreachEta(target, executor),
            getStressEta(target, executor), getRiskForecasts(target, executor),
            getRecoveryForecast(target, executor), getEarlyWarnings(target, executor)
        ]);
    const timestamps = [
        ...metric_forecasts, ...breach_eta, ...stress_eta, ...risk_forecasts,
        ...(recovery_forecast ? [recovery_forecast] : []), ...early_warnings
    ].map((row) => row.generated_at).filter(Boolean).sort();
    return {
        available: Boolean(metric_forecasts.length || breach_eta.length || stress_eta.length
            || risk_forecasts.length || recovery_forecast || early_warnings.length),
        owner_user_id: target.super_admin ? target.owner : undefined,
        device_id: target.device, context_id: target.context, context_name: target.context_name,
        is_production: target.is_production,
        latest_prediction_at: timestamps.length ? timestamps[timestamps.length - 1] : null,
        metric_forecasts, breach_eta, stress_eta, risk_forecasts, recovery_forecast, early_warnings
    };
}

module.exports = {
    listPredictionContexts, resolvePredictionTarget, getPredictionOverview,
    getMetricForecasts, getBreachEta, getStressEta, getRiskForecasts,
    getRecoveryForecast, getEarlyWarnings, ownerAccess, httpError
};
