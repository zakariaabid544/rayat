'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');
const { resolveEffectiveRange } = require('./range-resolver');
const { assertForecastIdentity, HORIZONS_MINUTES } = require('./metric-forecast');

const RULE_VERSION = 's6.2';

function finite(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function rangeValue(range, key) {
    return range && range[key] !== undefined && range[key] !== null ? finite(range[key]) : null;
}

function trendConsistency(forecast) {
    const evidence = typeof forecast.evidence_json === 'string'
        ? C.parseJson(forecast.evidence_json, {})
        : (forecast.evidence_json || {});
    const fit = finite(evidence.fit_quality);
    return fit === null ? 0.5 : Math.max(0, Math.min(1, fit));
}

function severityFor(status, etaMinutes, confidence, excursionRatio = 0) {
    if (status === 'insufficient_data') { return 'unknown'; }
    if (status === 'no_breach_expected') { return 'low'; }
    if (status === 'already_breached') {
        if (confidence >= 0.8 && excursionRatio >= 0.5) { return 'critical'; }
        return confidence >= 0.65 ? 'high' : 'medium';
    }
    if (etaMinutes !== null && etaMinutes <= 60 && confidence >= 0.75) { return 'critical'; }
    if (etaMinutes !== null && etaMinutes <= 180 && confidence >= 0.6) { return 'high'; }
    if (etaMinutes !== null && etaMinutes <= 720) { return 'medium'; }
    return 'low';
}

function evaluateBreachEta(forecast, range, baseline = null) {
    const identity = assertForecastIdentity(forecast, 'breach-eta-input');
    const current = finite(forecast.current_value);
    const predicted = finite(forecast.forecast_value);
    const horizon = Number(forecast.horizon_minutes);
    if (current === null || predicted === null || !HORIZONS_MINUTES.includes(horizon)) {
        throw new Error('[breach-eta] invalid forecast values');
    }
    const min = rangeValue(range, 'min');
    const max = rangeValue(range, 'max');
    const rangeConfidence = Math.max(0, Math.min(1, finite(range && range.confidence) ?? 0));
    const forecastConfidence = Math.max(0, Math.min(1, finite(forecast.confidence) ?? 0));
    const consistency = trendConsistency(forecast);
    const baselineConfidence = Math.max(0, Math.min(1, finite(baseline && baseline.confidence) ?? 0));
    const etaConfidence = C.round3(
        forecastConfidence * (0.65 * rangeConfidence + 0.20 * consistency + 0.15 * baselineConfidence)
    );
    const common = {
        ...identity,
        generated_at: new Date(forecast.generated_at).toISOString(),
        eta_confidence: etaConfidence,
        current_value: C.round3(current),
        predicted_breach_value: C.round3(predicted),
        horizon_minutes: horizon,
        rule_version: RULE_VERSION
    };
    if (min === null && max === null) {
        return {
            ...common,
            breach_direction: 'unknown', eta_minutes: null, threshold_value: null,
            status: 'insufficient_data', severity: 'unknown',
            evidence_json: {
                reason: 'effective_range_unavailable', forecast_confidence: forecastConfidence,
                range_source: null, privacy: { raw_events: false, fleet_dependency: false }
            }
        };
    }

    let direction = 'none';
    let threshold = null;
    if (min !== null && current < min) { direction = 'below_min'; threshold = min; }
    else if (max !== null && current > max) { direction = 'above_max'; threshold = max; }
    if (direction !== 'none') {
        const width = min !== null && max !== null ? Math.max(max - min, 1e-9) : Math.max(Math.abs(threshold), 1);
        const excursion = Math.abs(current - threshold) / width;
        const status = 'already_breached';
        return {
            ...common,
            breach_direction: direction, eta_minutes: 0, threshold_value: C.round3(threshold),
            status, severity: severityFor(status, 0, etaConfidence, excursion),
            evidence_json: {
                range: { min, max, source: range.source || 'effective_range', confidence: rangeConfidence },
                forecast_confidence: forecastConfidence, trend_consistency: C.round3(consistency),
                baseline_confidence: C.round3(baselineConfidence), excursion_ratio: C.round3(excursion),
                reason: 'current_value_outside_effective_range',
                privacy: { raw_events: false, fleet_dependency: false }
            }
        };
    }

    const candidates = [];
    const delta = predicted - current;
    if (delta > 0 && max !== null && predicted > max) {
        candidates.push({ direction: 'above_max', threshold: max, eta: horizon * (max - current) / delta });
    }
    if (delta < 0 && min !== null && predicted < min) {
        candidates.push({ direction: 'below_min', threshold: min, eta: horizon * (min - current) / delta });
    }
    const crossing = candidates
        .filter((candidate) => Number.isFinite(candidate.eta) && candidate.eta >= 0 && candidate.eta <= horizon)
        .sort((a, b) => a.eta - b.eta)[0] || null;
    if (!crossing) {
        return {
            ...common,
            breach_direction: 'none', eta_minutes: null, threshold_value: null,
            status: 'no_breach_expected', severity: 'low',
            evidence_json: {
                range: { min, max, source: range.source || 'effective_range', confidence: rangeConfidence },
                forecast_confidence: forecastConfidence, trend_consistency: C.round3(consistency),
                baseline_confidence: C.round3(baselineConfidence), reason: 'forecast_does_not_cross_range',
                privacy: { raw_events: false, fleet_dependency: false }
            }
        };
    }
    const eta = Math.max(0, Math.round(crossing.eta));
    const status = etaConfidence >= 0.65 ? 'breach_likely' : 'breach_possible';
    return {
        ...common,
        breach_direction: crossing.direction,
        eta_minutes: eta,
        threshold_value: C.round3(crossing.threshold),
        status,
        severity: severityFor(status, eta, etaConfidence),
        evidence_json: {
            range: { min, max, source: range.source || 'effective_range', confidence: rangeConfidence },
            forecast_confidence: forecastConfidence, trend_consistency: C.round3(consistency),
            baseline_confidence: C.round3(baselineConfidence),
            interpolation: { current, predicted, horizon_minutes: horizon },
            reason: 'forecast_crosses_effective_range',
            privacy: { raw_events: false, fleet_dependency: false }
        }
    };
}

async function ensureBreachEtaSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_breach_eta (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
           metric VARCHAR(80) NOT NULL,
           generated_at TIMESTAMPTZ NOT NULL,
           breach_direction VARCHAR(20) NOT NULL,
           eta_minutes INTEGER NULL,
           eta_confidence NUMERIC(5,4) NOT NULL,
           current_value NUMERIC(16,5) NOT NULL,
           predicted_breach_value NUMERIC(16,5) NOT NULL,
           threshold_value NUMERIC(16,5) NULL,
           horizon_minutes INTEGER NOT NULL,
           status VARCHAR(24) NOT NULL,
           severity VARCHAR(12) NOT NULL,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's6.2',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_breach_eta
             UNIQUE (owner_user_id, device_id, context_id, sensor_id, metric, horizon_minutes),
           CONSTRAINT breach_eta_values_check CHECK (
             breach_direction IN ('below_min','above_max','none','unknown')
             AND (eta_minutes IS NULL OR eta_minutes >= 0)
             AND eta_confidence BETWEEN 0 AND 1
             AND horizon_minutes IN (60,180,360,720,1440)
             AND status IN ('no_breach_expected','breach_possible','breach_likely','already_breached','insufficient_data')
             AND severity IN ('low','medium','high','critical','unknown')
             AND btrim(metric) <> '' AND jsonb_typeof(evidence_json) = 'object')
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count
         FROM agro_breach_eta b
         LEFT JOIN sensors s ON s.id = b.sensor_id
         LEFT JOIN devices d ON d.id = b.device_id AND d.id = s.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = b.context_id
         WHERE b.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM b.owner_user_id
            OR c.device_id IS DISTINCT FROM b.device_id
            OR (c.sensor_id IS NOT NULL AND c.sensor_id IS DISTINCT FROM b.sensor_id)`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[breach-eta-schema] existing rows have invalid tenant/context/sensor identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_breach_eta_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; sensor_device INTEGER; context_owner INTEGER;
           context_device INTEGER; context_sensor INTEGER;
         BEGIN
           SELECT s.device_id, COALESCE(u.owner_user_id, u.id) INTO sensor_device, expected_owner
             FROM sensors s JOIN devices d ON d.id = s.device_id
             JOIN users u ON u.id = d.user_id WHERE s.id = NEW.sensor_id;
           SELECT owner_user_id, device_id, sensor_id INTO context_owner, context_device, context_sensor
             FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id
              OR sensor_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'breach ETA sensor/device/owner mismatch'; END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id
              OR (context_sensor IS NOT NULL AND context_sensor IS DISTINCT FROM NEW.sensor_id) THEN
             RAISE EXCEPTION 'breach ETA context mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS breach_eta_identity_guard ON agro_breach_eta');
    await executor(
        `CREATE TRIGGER breach_eta_identity_guard BEFORE INSERT OR UPDATE ON agro_breach_eta
         FOR EACH ROW EXECUTE FUNCTION rayat_assert_breach_eta_identity()`
    );
    await executor('CREATE INDEX IF NOT EXISTS idx_breach_eta_context_status ON agro_breach_eta (context_id, status, eta_minutes)');
    await executor('CREATE INDEX IF NOT EXISTS idx_breach_eta_sensor_generated ON agro_breach_eta (sensor_id, generated_at DESC)');
}

function normalizeScope(scope) {
    if (!scope) { return {}; }
    const result = {};
    for (const [key, sourceKey] of [
        ['owner_user_id', 'ownerUserId'], ['device_id', 'deviceId'],
        ['context_id', 'contextId'], ['sensor_id', 'sensorId']
    ]) {
        if (scope[sourceKey] != null) {
            const parsed = Number(scope[sourceKey]);
            if (!Number.isInteger(parsed) || parsed < 1) { throw new Error('[breach-eta] invalid scope'); }
            result[key] = parsed;
        }
    }
    return result;
}

async function loadBreachForecasts({ scope = null, executor = query } = {}) {
    const normalized = normalizeScope(scope);
    const clauses = [];
    const params = [];
    for (const [key, value] of Object.entries(normalized)) {
        clauses.push(`f.${key} = ?`); params.push(value);
    }
    return executor(
        `SELECT f.owner_user_id, f.device_id, f.context_id, f.sensor_id, f.metric,
                f.generated_at, f.horizon_minutes, f.current_value, f.forecast_value,
                f.forecast_low, f.forecast_high, f.slope_per_hour, f.confidence,
                f.data_quality_score, f.evidence_json,
                s.type, s.subtype,
                b.confidence AS baseline_confidence, b.data_quality_score AS baseline_data_quality
         FROM agro_metric_forecasts f
         JOIN sensors s ON s.id = f.sensor_id AND s.device_id = f.device_id
         JOIN devices d ON d.id = f.device_id
         JOIN users u ON u.id = d.user_id
           AND COALESCE(u.owner_user_id, u.id) = f.owner_user_id
         JOIN agro_context_segments c ON c.id = f.context_id
           AND c.owner_user_id = f.owner_user_id AND c.device_id = f.device_id
         LEFT JOIN agro_greenhouse_baselines b ON b.owner_user_id = f.owner_user_id
           AND b.device_id = f.device_id AND b.context_id = f.context_id AND b.metric = f.metric
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY f.owner_user_id, f.device_id, f.context_id, f.sensor_id, f.horizon_minutes`,
        params
    );
}

async function upsertBreachEta(row, executor = query) {
    const identity = assertForecastIdentity(row, 'breach-eta-upsert');
    await executor(
        `INSERT INTO agro_breach_eta
          (owner_user_id, device_id, context_id, sensor_id, metric, generated_at,
           breach_direction, eta_minutes, eta_confidence, current_value,
           predicted_breach_value, threshold_value, horizon_minutes, status, severity,
           evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, sensor_id, metric, horizon_minutes)
         DO UPDATE SET generated_at=EXCLUDED.generated_at,
           breach_direction=EXCLUDED.breach_direction, eta_minutes=EXCLUDED.eta_minutes,
           eta_confidence=EXCLUDED.eta_confidence, current_value=EXCLUDED.current_value,
           predicted_breach_value=EXCLUDED.predicted_breach_value,
           threshold_value=EXCLUDED.threshold_value, status=EXCLUDED.status,
           severity=EXCLUDED.severity, evidence_json=EXCLUDED.evidence_json,
           rule_version=EXCLUDED.rule_version, updated_at=NOW()`,
        [identity.owner_user_id, identity.device_id, identity.context_id, identity.sensor_id,
            identity.metric, row.generated_at, row.breach_direction, row.eta_minutes,
            row.eta_confidence, row.current_value, row.predicted_breach_value,
            row.threshold_value, row.horizon_minutes, row.status, row.severity,
            JSON.stringify(row.evidence_json), RULE_VERSION]
    );
}

async function deleteStaleBreachEta({ scope = null, executor = query } = {}) {
    const normalized = normalizeScope(scope);
    const clauses = [];
    const params = [];
    for (const [key, value] of Object.entries(normalized)) {
        clauses.push(`b.${key} = ?`); params.push(value);
    }
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM agro_metric_forecasts f
      WHERE f.owner_user_id = b.owner_user_id AND f.device_id = b.device_id
        AND f.context_id = b.context_id AND f.sensor_id = b.sensor_id
        AND f.metric = b.metric AND f.horizon_minutes = b.horizon_minutes
        AND f.generated_at = b.generated_at
    )`);
    const rows = await executor(
        `WITH removed AS (
           DELETE FROM agro_breach_eta b WHERE ${clauses.join(' AND ')} RETURNING 1
         ) SELECT COUNT(*)::integer AS removed FROM removed`,
        params
    );
    return Number(rows[0] && rows[0].removed) || 0;
}

async function runBreachEtaCycle({
    scope = null, dryRun = false, executor = query, rangeResolver = resolveEffectiveRange
} = {}) {
    const forecasts = await loadBreachForecasts({ scope, executor });
    const rangeCache = new Map();
    const rows = [];
    const byStatus = {
        no_breach_expected: 0, breach_possible: 0, breach_likely: 0,
        already_breached: 0, insufficient_data: 0
    };
    for (const forecast of forecasts) {
        const cacheKey = `${forecast.owner_user_id}:${forecast.sensor_id}`;
        if (!rangeCache.has(cacheKey)) {
            const range = await rangeResolver({
                userId: Number(forecast.owner_user_id),
                sensor: {
                    id: Number(forecast.sensor_id), device_id: Number(forecast.device_id),
                    type: forecast.type, subtype: forecast.subtype
                }
            });
            rangeCache.set(cacheKey, range || null);
        }
        const row = evaluateBreachEta(forecast, rangeCache.get(cacheKey), {
            confidence: forecast.baseline_confidence,
            data_quality_score: forecast.baseline_data_quality
        });
        rows.push(row);
        byStatus[row.status] += 1;
        if (!dryRun) { await upsertBreachEta(row, executor); }
    }
    const removedStale = dryRun ? 0 : await deleteStaleBreachEta({ scope, executor });
    return {
        forecast_rows: forecasts.length,
        breach_rows: rows.length,
        stored: dryRun ? 0 : rows.length,
        by_status: byStatus,
        removed_stale: removedStale,
        dry_run: dryRun,
        rows
    };
}

module.exports = {
    ensureBreachEtaSchema,
    runBreachEtaCycle,
    loadBreachForecasts,
    evaluateBreachEta,
    upsertBreachEta,
    deleteStaleBreachEta,
    severityFor,
    RULE_VERSION
};
