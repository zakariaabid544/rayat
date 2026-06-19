'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');
const { HORIZONS_MINUTES } = require('./metric-forecast');

const RULE_VERSION = 's6.4';
const RISK_BANDS = Object.freeze(['very_low', 'low', 'medium', 'high', 'critical']);

function finite(value, fallback = null) {
    const parsed = C.num(value);
    return parsed === null ? fallback : parsed;
}

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertIdentity(value, label = 'risk-forecast') {
    const identity = {
        owner_user_id: positiveInteger(value && value.owner_user_id),
        device_id: positiveInteger(value && value.device_id),
        context_id: positiveInteger(value && value.context_id)
    };
    if (!identity.owner_user_id || !identity.device_id || !identity.context_id) {
        throw new Error(`[${label}] unresolved owner/device/context identity`);
    }
    return identity;
}

function parseArray(value) {
    const parsed = C.parseJson(value, []);
    return Array.isArray(parsed) ? parsed : [];
}

function average(values, fallback = 0) {
    const valid = values.map((value) => finite(value)).filter((value) => value !== null);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : fallback;
}

function maxOf(values, fallback = 0) {
    const valid = values.map((value) => finite(value)).filter((value) => value !== null);
    return valid.length ? Math.max(...valid) : fallback;
}

function riskBand(score) {
    if (score >= 80) { return 'critical'; }
    if (score >= 60) { return 'high'; }
    if (score >= 40) { return 'medium'; }
    if (score >= 20) { return 'low'; }
    return 'very_low';
}

function breachRisk(status) {
    return ({ already_breached: 1, breach_likely: 0.88, breach_possible: 0.62,
        no_breach_expected: 0, insufficient_data: 0.15 })[status] ?? 0.15;
}

function trendRisk(direction) {
    return ({ degrading: 1, volatile: 0.7, stable: 0.25, improving: 0.05,
        insufficient_data: 0.35 })[direction] ?? 0.35;
}

function stressStatusRisk(status) {
    return ({ already_under_stress: 1, stress_imminent: 0.92, stress_likely: 0.78,
        stress_possible: 0.55, no_stress_expected: 0, insufficient_data: 0.2 })[status] ?? 0.2;
}

function computeRiskForecast(input, horizonMinutes, generatedAt = new Date()) {
    const identity = assertIdentity(input, 'risk-forecast-input');
    if (!HORIZONS_MINUTES.includes(Number(horizonMinutes))) {
        throw new Error('[risk-forecast] unsupported forecast horizon');
    }
    const clock = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
    if (Number.isNaN(clock.getTime())) { throw new Error('[risk-forecast] invalid generatedAt'); }
    const horizon = Number(horizonMinutes);
    const forecasts = parseArray(input.forecasts).filter((row) => Number(row.horizon_minutes) === horizon);
    const breaches = parseArray(input.breaches).filter((row) => Number(row.horizon_minutes) === horizon);
    const stresses = parseArray(input.stress_eta);
    const trends = parseArray(input.trends).filter((row) => ['intelligence_score', 'stress', 'stability'].includes(row.metric));
    const health = input.health_profile || null;
    const intelligence = input.intelligence_score || null;

    const forecastConfidence = C.clamp01(average(forecasts.map((row) => row.confidence)));
    const forecastQuality = C.clamp01(average(forecasts.map((row) => row.data_quality_score)));
    const breachFactor = C.clamp01(maxOf(breaches.map((row) => breachRisk(row.status))));
    const breachConfidence = C.clamp01(maxOf(breaches.map((row) => row.eta_confidence)));
    const stressFactor = C.clamp01(maxOf(stresses.map((row) => {
        const probability = C.clamp01(finite(row.stress_probability, 0));
        const eta = finite(row.eta_minutes);
        const relevance = eta === null ? 0.75 : (eta <= horizon ? 1 : C.clamp01(horizon / eta));
        return Math.max(stressStatusRisk(row.status), probability) * relevance;
    })));
    const stressConfidence = C.clamp01(average(stresses.map((row) => row.stress_confidence)));
    const healthScore = finite(health && health.health_score, 50);
    const healthConfidence = C.clamp01(finite(health && health.confidence, 0));
    const recoveryScore = finite(health && health.recovery_score, 50);
    const intelligenceScore = finite(intelligence && intelligence.intelligence_score, 50);
    const intelligenceConfidence = C.clamp01(finite(intelligence && intelligence.confidence, 0));
    const healthVulnerability = C.clamp01(1 - healthScore / 100);
    const intelligenceVulnerability = C.clamp01(1 - intelligenceScore / 100);
    const recoveryVulnerability = C.clamp01(1 - recoveryScore / 100);

    let trendFactor = 0.35;
    let trendConfidence = 0;
    if (trends.length) {
        let weighted = 0;
        let total = 0;
        for (const trend of trends) {
            const confidence = Math.max(0.1, C.clamp01(finite(trend.trend_confidence, 0)));
            weighted += trendRisk(trend.trend_direction) * confidence;
            total += confidence;
        }
        trendFactor = C.clamp01(total ? weighted / total : 0.35);
        trendConfidence = C.clamp01(average(trends.map((row) => row.trend_confidence)));
    }
    const forecastUncertainty = C.clamp01(1 - 0.6 * forecastConfidence - 0.4 * forecastQuality);
    const factors = {
        stress_eta: stressFactor,
        breach_eta: breachFactor,
        health_vulnerability: healthVulnerability,
        intelligence_vulnerability: intelligenceVulnerability,
        trend_deterioration: trendFactor,
        recovery_vulnerability: recoveryVulnerability,
        forecast_uncertainty: forecastUncertainty
    };
    const weights = {
        stress_eta: 0.27, breach_eta: 0.22, health_vulnerability: 0.16,
        intelligence_vulnerability: 0.11, trend_deterioration: 0.09,
        recovery_vulnerability: 0.10, forecast_uncertainty: 0.05
    };
    const contributions = Object.entries(weights).map(([name, weight]) => ({
        factor: name,
        value: C.round3(factors[name]),
        weight,
        contribution: C.round3(factors[name] * weight)
    })).sort((a, b) => b.contribution - a.contribution || a.factor.localeCompare(b.factor));
    const rawRisk = C.clamp01(contributions.reduce((sum, item) => sum + item.contribution, 0));
    const overallRiskScore = C.round1(rawRisk * 100);
    const availability = [forecasts.length > 0, breaches.length > 0, stresses.length > 0,
        Boolean(health), Boolean(intelligence), trends.length > 0].filter(Boolean).length / 6;
    const sourceConfidence = average([
        forecastConfidence, forecastQuality, breachConfidence, stressConfidence,
        healthConfidence, intelligenceConfidence, trendConfidence
    ]);
    const confidence = C.clamp01(sourceConfidence * (0.45 + 0.55 * availability));
    const riskProbability = C.clamp01(0.72 * rawRisk + 0.18 * stressFactor + 0.10 * breachFactor);
    const forwardPressure = 18 * stressFactor + 14 * breachFactor + 8 * trendFactor;
    const horizonScale = Math.sqrt(horizon / 1440);
    const predictedHealth = C.clamp01((healthScore - forwardPressure * horizonScale) / 100) * 100;
    const predictedIntelligence = C.clamp01((intelligenceScore - (12 * stressFactor + 10 * breachFactor + 8 * trendFactor) * horizonScale) / 100) * 100;
    const secondary = contributions.slice(1, 4).filter((item) => item.contribution >= 0.03)
        .map((item) => ({ factor: item.factor, contribution: item.contribution }));
    const positive = [];
    if (healthScore >= 70) { positive.push({ signal: 'strong_health', score: C.round1(healthScore) }); }
    if (recoveryScore >= 70) { positive.push({ signal: 'strong_recovery', score: C.round1(recoveryScore) }); }
    if (intelligenceScore >= 70) { positive.push({ signal: 'strong_intelligence', score: C.round1(intelligenceScore) }); }
    if (trendFactor <= 0.25) { positive.push({ signal: 'stable_or_improving_trend', strength: C.round3(1 - trendFactor) }); }
    if (breachFactor === 0) { positive.push({ signal: 'no_expected_breach', horizon_minutes: horizon }); }

    return {
        ...identity,
        generated_at: clock.toISOString(),
        forecast_horizon_minutes: horizon,
        overall_risk_score: overallRiskScore,
        overall_risk_band: riskBand(overallRiskScore),
        risk_probability: C.round3(riskProbability),
        confidence: C.round3(confidence),
        predicted_health_score: C.round1(predictedHealth),
        predicted_intelligence_score: C.round1(predictedIntelligence),
        primary_risk: contributions[0].factor,
        secondary_risks_json: secondary,
        positive_signals_json: positive,
        evidence_json: {
            source_availability: {
                metric_forecasts: forecasts.length, breach_eta: breaches.length, stress_eta: stresses.length,
                health_profile: Boolean(health), intelligence_score: Boolean(intelligence), trends: trends.length
            },
            current_scores: {
                health: C.round1(healthScore), recovery: C.round1(recoveryScore),
                intelligence: C.round1(intelligenceScore)
            },
            factors: Object.fromEntries(Object.entries(factors).map(([key, value]) => [key, C.round3(value)])),
            contributions,
            confidence_factors: {
                availability: C.round3(availability), source_confidence: C.round3(sourceConfidence),
                forecast: C.round3(forecastConfidence), stress: C.round3(stressConfidence),
                breach: C.round3(breachConfidence), health: C.round3(healthConfidence),
                intelligence: C.round3(intelligenceConfidence), trend: C.round3(trendConfidence)
            },
            privacy: { raw_readings: false, raw_events: false, cross_tenant_evidence: false, fleet_dependency: false }
        },
        rule_version: RULE_VERSION
    };
}

async function ensureRiskForecastSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_risk_forecasts (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           generated_at TIMESTAMPTZ NOT NULL,
           forecast_horizon_minutes INTEGER NOT NULL,
           overall_risk_score NUMERIC(6,2) NOT NULL,
           overall_risk_band VARCHAR(12) NOT NULL,
           risk_probability NUMERIC(5,4) NOT NULL,
           confidence NUMERIC(5,4) NOT NULL,
           predicted_health_score NUMERIC(6,2) NOT NULL,
           predicted_intelligence_score NUMERIC(6,2) NOT NULL,
           primary_risk VARCHAR(48) NOT NULL,
           secondary_risks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
           positive_signals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's6.4',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_risk_forecast UNIQUE (owner_user_id, device_id, context_id, forecast_horizon_minutes),
           CONSTRAINT risk_forecast_values_check CHECK (
             forecast_horizon_minutes IN (60,180,360,720,1440)
             AND overall_risk_score BETWEEN 0 AND 100
             AND overall_risk_band IN ('very_low','low','medium','high','critical')
             AND risk_probability BETWEEN 0 AND 1 AND confidence BETWEEN 0 AND 1
             AND predicted_health_score BETWEEN 0 AND 100 AND predicted_intelligence_score BETWEEN 0 AND 100
             AND btrim(primary_risk) <> '' AND jsonb_typeof(secondary_risks_json) = 'array'
             AND jsonb_typeof(positive_signals_json) = 'array' AND jsonb_typeof(evidence_json) = 'object')
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count FROM agro_risk_forecasts r
         LEFT JOIN devices d ON d.id = r.device_id LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = r.context_id
         WHERE r.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM r.owner_user_id
            OR c.device_id IS DISTINCT FROM r.device_id`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[risk-forecast-schema] existing rows have invalid tenant/context identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_risk_forecast_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; context_owner INTEGER; context_device INTEGER;
         BEGIN
           SELECT COALESCE(u.owner_user_id, u.id) INTO expected_owner
             FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=NEW.device_id;
           SELECT owner_user_id, device_id INTO context_owner, context_device
             FROM agro_context_segments WHERE id=NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'risk forecast owner/device mismatch'; END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'risk forecast context mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS risk_forecast_identity_guard ON agro_risk_forecasts');
    await executor(
        `CREATE TRIGGER risk_forecast_identity_guard BEFORE INSERT OR UPDATE ON agro_risk_forecasts
         FOR EACH ROW EXECUTE FUNCTION rayat_assert_risk_forecast_identity()`
    );
    await executor('CREATE INDEX IF NOT EXISTS idx_risk_forecast_context_horizon ON agro_risk_forecasts (context_id, forecast_horizon_minutes)');
    await executor('CREATE INDEX IF NOT EXISTS idx_risk_forecast_band_score ON agro_risk_forecasts (overall_risk_band, overall_risk_score DESC)');
}

function normalizeScope(scope) {
    if (!scope) { return {}; }
    const result = {};
    for (const [key, source] of [['owner_user_id', 'ownerUserId'], ['device_id', 'deviceId'], ['context_id', 'contextId']]) {
        if (scope[source] != null) {
            const value = positiveInteger(scope[source]);
            if (!value) { throw new Error('[risk-forecast] invalid scope'); }
            result[key] = value;
        }
    }
    return result;
}

function scopeSql(scope, alias, params) {
    return Object.entries(scope).map(([key, value]) => { params.push(value); return `${alias}.${key} = ?`; });
}

async function loadRiskForecastInputs({
    generatedAt = new Date(), scope = null, includeNonProduction = false, executor = query
} = {}) {
    const clock = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
    if (Number.isNaN(clock.getTime())) { throw new Error('[risk-forecast] invalid generatedAt'); }
    const normalized = normalizeScope(scope);
    const params = [clock.toISOString(), clock.toISOString()];
    const clauses = [
        'c.valid_from <= CAST(? AS TIMESTAMPTZ)', '(c.valid_to IS NULL OR c.valid_to > CAST(? AS TIMESTAMPTZ))',
        'c.owner_user_id = COALESCE(u.owner_user_id, u.id)', 'c.device_id = d.id'
    ];
    if (!includeNonProduction) {
        clauses.push('c.is_production = TRUE');
        clauses.push("LOWER(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')");
    }
    clauses.push(...scopeSql(normalized, 'c', params));
    clauses.push(`(EXISTS (SELECT 1 FROM agro_metric_forecasts f WHERE f.owner_user_id=c.owner_user_id AND f.device_id=c.device_id AND f.context_id=c.id)
      OR EXISTS (SELECT 1 FROM agro_stress_eta se WHERE se.owner_user_id=c.owner_user_id AND se.device_id=c.device_id AND se.context_id=c.id))`);
    const contexts = await executor(
        `SELECT c.id AS context_id, c.owner_user_id, c.device_id
         FROM agro_context_segments c JOIN devices d ON d.id=c.device_id JOIN users u ON u.id=d.user_id
         WHERE ${clauses.join(' AND ')} ORDER BY c.owner_user_id, c.device_id, c.id`, params
    );
    const map = new Map(contexts.map((row) => [`${row.owner_user_id}:${row.device_id}:${row.context_id}`, {
        owner_user_id: Number(row.owner_user_id), device_id: Number(row.device_id), context_id: Number(row.context_id),
        forecasts: [], breaches: [], stress_eta: [], trends: [], health_profile: null, intelligence_score: null
    }]));
    if (!map.size) { return []; }
    const attach = (rows, field) => {
        for (const row of rows) {
            const target = map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);
            if (target) { target[field].push(row); }
        }
    };
    const contextIds = [...new Set(contexts.map((row) => Number(row.context_id)))];
    const selected = (table, order) => executor(
        `SELECT * FROM ${table} WHERE context_id IN (${contextIds.map(() => '?').join(',')}) ORDER BY ${order}`,
        contextIds
    );
    attach(await selected('agro_metric_forecasts', 'owner_user_id, device_id, context_id, sensor_id, horizon_minutes'), 'forecasts');
    attach(await selected('agro_breach_eta', 'owner_user_id, device_id, context_id, sensor_id, horizon_minutes'), 'breaches');
    attach(await selected('agro_stress_eta', 'owner_user_id, device_id, context_id, stress_type'), 'stress_eta');
    attach(await selected('agro_intelligence_trends', 'owner_user_id, device_id, context_id, metric'), 'trends');
    for (const row of await selected('agro_greenhouse_health_profile', 'owner_user_id, device_id, context_id')) {
        const target = map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);
        if (target) { target.health_profile = row; }
    }
    for (const row of await selected('agro_intelligence_score', 'owner_user_id, device_id, context_id')) {
        const target = map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);
        if (target) { target.intelligence_score = row; }
    }
    return [...map.values()];
}

async function upsertRiskForecast(row, executor = query) {
    const identity = assertIdentity(row, 'risk-forecast-upsert');
    await executor(
        `INSERT INTO agro_risk_forecasts
          (owner_user_id, device_id, context_id, generated_at, forecast_horizon_minutes,
           overall_risk_score, overall_risk_band, risk_probability, confidence,
           predicted_health_score, predicted_intelligence_score, primary_risk,
           secondary_risks_json, positive_signals_json, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, forecast_horizon_minutes) DO UPDATE SET
           generated_at=EXCLUDED.generated_at, overall_risk_score=EXCLUDED.overall_risk_score,
           overall_risk_band=EXCLUDED.overall_risk_band, risk_probability=EXCLUDED.risk_probability,
           confidence=EXCLUDED.confidence, predicted_health_score=EXCLUDED.predicted_health_score,
           predicted_intelligence_score=EXCLUDED.predicted_intelligence_score,
           primary_risk=EXCLUDED.primary_risk, secondary_risks_json=EXCLUDED.secondary_risks_json,
           positive_signals_json=EXCLUDED.positive_signals_json, evidence_json=EXCLUDED.evidence_json,
           rule_version=EXCLUDED.rule_version, updated_at=NOW()`,
        [identity.owner_user_id, identity.device_id, identity.context_id, row.generated_at,
            row.forecast_horizon_minutes, row.overall_risk_score, row.overall_risk_band,
            row.risk_probability, row.confidence, row.predicted_health_score,
            row.predicted_intelligence_score, row.primary_risk,
            JSON.stringify(row.secondary_risks_json), JSON.stringify(row.positive_signals_json),
            JSON.stringify(row.evidence_json), RULE_VERSION]
    );
}

async function deleteStaleRiskForecasts({ generatedAt, scope = null, executor = query } = {}) {
    const normalized = normalizeScope(scope);
    const params = [(generatedAt instanceof Date ? generatedAt : new Date(generatedAt)).toISOString()];
    const clauses = ['generated_at IS DISTINCT FROM CAST(? AS TIMESTAMPTZ)', ...scopeSql(normalized, 'agro_risk_forecasts', params)];
    const rows = await executor(
        `WITH removed AS (DELETE FROM agro_risk_forecasts WHERE ${clauses.join(' AND ')} RETURNING 1)
         SELECT COUNT(*)::integer AS removed FROM removed`, params
    );
    return Number(rows[0] && rows[0].removed) || 0;
}

async function runRiskForecastCycle({
    generatedAt = new Date(), scope = null, includeNonProduction = false,
    dryRun = false, executor = query
} = {}) {
    const inputs = await loadRiskForecastInputs({ generatedAt, scope, includeNonProduction, executor });
    const rows = [];
    const byBand = Object.fromEntries(RISK_BANDS.map((band) => [band, 0]));
    for (const input of inputs) {
        for (const horizon of HORIZONS_MINUTES) {
            const row = computeRiskForecast(input, horizon, generatedAt);
            rows.push(row); byBand[row.overall_risk_band] += 1;
            if (!dryRun) { await upsertRiskForecast(row, executor); }
        }
    }
    const removedStale = dryRun ? 0 : await deleteStaleRiskForecasts({ generatedAt, scope, executor });
    return { contexts: inputs.length, risk_rows: rows.length, stored: dryRun ? 0 : rows.length,
        by_band: byBand, removed_stale: removedStale, dry_run: dryRun, rows };
}

module.exports = {
    ensureRiskForecastSchema, runRiskForecastCycle, loadRiskForecastInputs, computeRiskForecast,
    upsertRiskForecast, deleteStaleRiskForecasts, riskBand, RISK_BANDS, RULE_VERSION
};
