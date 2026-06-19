'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's6.1';
const HORIZONS_MINUTES = Object.freeze([60, 180, 360, 720, 1440]);
const LOOKBACK_HOURS = Math.max(6, Number(process.env.AGRO_FORECAST_LOOKBACK_HOURS) || 36);
const MAX_READINGS = Math.max(20, Number(process.env.AGRO_FORECAST_MAX_READINGS) || 500);
const MIN_SAMPLES = Math.max(3, Number(process.env.AGRO_FORECAST_MIN_SAMPLES) || 4);

const METRIC_CASE_SQL = `CASE
  WHEN s.subtype = 'terreno_moisture' THEN 'moisture'
  WHEN s.subtype = 'terreno_temperature' THEN 'temperature'
  WHEN s.subtype = 'terreno_ec' THEN 'ec'
  WHEN s.subtype = 'terreno_ph' THEN 'pH'
  WHEN s.subtype IN ('terreno_n','terreno_nitrogen') THEN 'nitrogen'
  WHEN s.subtype IN ('terreno_p','terreno_phosphorus') THEN 'phosphorus'
  WHEN s.subtype IN ('terreno_k','terreno_potassium') THEN 'potassium'
  WHEN s.subtype = 'clima_temperature' THEN 'temperature'
  WHEN s.subtype = 'clima_humidity' THEN 'humidity'
  WHEN s.subtype = 'clima_co2' THEN 'co2'
  WHEN s.subtype = 'clima_wind_speed' THEN 'windSpeed'
  ELSE NULL END`;

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertForecastIdentity(value, label = 'metric-forecast') {
    const identity = {
        owner_user_id: positiveInteger(value && value.owner_user_id),
        device_id: positiveInteger(value && value.device_id),
        context_id: positiveInteger(value && value.context_id),
        sensor_id: positiveInteger(value && value.sensor_id),
        metric: String((value && value.metric) || '').trim()
    };
    if (!identity.owner_user_id || !identity.device_id || !identity.context_id
        || !identity.sensor_id || !identity.metric) {
        throw new Error(`[${label}] unresolved owner/device/context/sensor/metric identity`);
    }
    return identity;
}

function parseRows(value) {
    const parsed = C.parseJson(value, []);
    return Array.isArray(parsed) ? parsed : [];
}

function median(values) {
    if (!values.length) { return 0; }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function standardDeviation(values) {
    if (values.length < 2) { return 0; }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}

function ewma(values, span = 20) {
    if (!values.length) { return null; }
    const alpha = 2 / (Math.min(span, values.length) + 1);
    let result = values[0];
    for (let index = 1; index < values.length; index += 1) {
        result = alpha * values[index] + (1 - alpha) * result;
    }
    return result;
}

function linearRegression(points) {
    if (points.length < 2) { return { slope_per_hour: 0, r2: 0, rmse: 0 }; }
    const origin = points[0].timestamp_ms;
    const xs = points.map((point) => (point.timestamp_ms - origin) / 3600000);
    const ys = points.map((point) => point.value);
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const varianceX = xs.reduce((sum, value) => sum + ((value - meanX) ** 2), 0);
    const covariance = xs.reduce((sum, value, index) => sum + ((value - meanX) * (ys[index] - meanY)), 0);
    const slope = varianceX > 0 ? covariance / varianceX : 0;
    const intercept = meanY - slope * meanX;
    const residuals = ys.map((value, index) => value - (intercept + slope * xs[index]));
    const ssResidual = residuals.reduce((sum, value) => sum + value ** 2, 0);
    const ssTotal = ys.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
    const r2 = ssTotal <= 1e-12 ? 1 : Math.max(0, Math.min(1, 1 - ssResidual / ssTotal));
    return {
        slope_per_hour: slope,
        r2,
        rmse: Math.sqrt(ssResidual / points.length)
    };
}

function normalizedReadings(input) {
    return parseRows(input.reading_rows)
        .map((row) => ({
            value: Number(row.value),
            timestamp_ms: new Date(row.timestamp).getTime()
        }))
        .filter((row) => Number.isFinite(row.value) && Number.isFinite(row.timestamp_ms))
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
}

function computeMetricForecasts(input, generatedAt = new Date()) {
    const identity = assertForecastIdentity(input, 'metric-forecast-input');
    const clock = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
    if (Number.isNaN(clock.getTime())) { throw new Error('[metric-forecast] invalid generatedAt'); }
    const readings = normalizedReadings(input);
    if (readings.length < MIN_SAMPLES) { return []; }
    const values = readings.map((row) => row.value);
    const latest = readings[readings.length - 1];
    const currentValue = latest.value;
    const regression = linearRegression(readings);
    const ewmaValue = ewma(values);
    const rollingMedian = median(values.slice(-Math.min(9, values.length)));
    const anchor = 0.65 * currentValue + 0.25 * ewmaValue + 0.10 * rollingMedian;
    const spanHours = Math.max(0, (latest.timestamp_ms - readings[0].timestamp_ms) / 3600000);
    const ageHours = Math.max(0, (clock.getTime() - latest.timestamp_ms) / 3600000);
    const sampleFactor = Math.min(1, readings.length / 24);
    const freshnessFactor = Math.exp(-ageHours / 6);
    const coverageFactor = Math.min(1, spanHours / 12);
    const observedStddev = standardDeviation(values);
    const varianceFactor = 1 / (1 + observedStddev / (Math.abs(rollingMedian) + 1));
    const fitFactor = observedStddev < 1e-9 ? 1 : (0.3 + 0.7 * regression.r2);
    const baselineConfidence = Math.max(0, Math.min(1, Number(input.baseline_confidence) || 0));
    const baseConfidence = Math.max(0, Math.min(1,
        0.25 * sampleFactor + 0.20 * freshnessFactor + 0.20 * fitFactor
        + 0.15 * varianceFactor + 0.10 * coverageFactor + 0.10 * baselineConfidence
    ));
    const spacingFactor = readings.length < 2 ? 0 : Math.min(1, readings.length / Math.max(spanHours, 1));
    const dataQuality = Math.max(0, Math.min(1,
        0.35 * sampleFactor + 0.30 * freshnessFactor + 0.20 * spacingFactor + 0.15 * varianceFactor
    ));
    const baselineStddev = Math.max(0, Number(input.baseline_stddev) || 0);
    const absoluteDeviations = values.slice(-Math.min(15, values.length))
        .map((value) => Math.abs(value - rollingMedian));
    const robustSigma = 1.4826 * median(absoluteDeviations);
    const baseUncertainty = Math.max(regression.rmse, robustSigma, baselineStddev * 0.5, 0.0001);

    return HORIZONS_MINUTES.map((horizonMinutes) => {
        const horizonHours = horizonMinutes / 60;
        const forecastValue = anchor + regression.slope_per_hour * horizonHours;
        const uncertainty = 1.96 * baseUncertainty * Math.sqrt(1 + horizonHours / Math.max(spanHours, 1));
        const confidence = baseConfidence * Math.exp(-horizonHours / 48);
        return {
            ...identity,
            generated_at: clock.toISOString(),
            horizon_minutes: horizonMinutes,
            current_value: C.round3(currentValue),
            forecast_value: C.round3(forecastValue),
            forecast_low: C.round3(forecastValue - uncertainty),
            forecast_high: C.round3(forecastValue + uncertainty),
            slope_per_hour: C.round3(regression.slope_per_hour),
            method: 'slope_ewma_median',
            confidence: C.round3(confidence),
            data_quality_score: C.round3(dataQuality),
            evidence_json: {
                sample_count: readings.length,
                first_reading_at: new Date(readings[0].timestamp_ms).toISOString(),
                latest_reading_at: new Date(latest.timestamp_ms).toISOString(),
                span_hours: C.round3(spanHours),
                freshness_hours: C.round3(ageHours),
                rolling_median: C.round3(rollingMedian),
                ewma: C.round3(ewmaValue),
                fit_quality: C.round3(regression.r2),
                residual_rmse: C.round3(regression.rmse),
                observed_stddev: C.round3(observedStddev),
                baseline: {
                    available: Boolean(input.baseline_available),
                    confidence: C.round3(baselineConfidence),
                    stddev: C.round3(baselineStddev)
                },
                factors: {
                    samples: C.round3(sampleFactor), freshness: C.round3(freshnessFactor),
                    coverage: C.round3(coverageFactor), variance: C.round3(varianceFactor),
                    fit: C.round3(fitFactor), spacing: C.round3(spacingFactor)
                },
                privacy: { raw_readings: false, reading_ids: false, fleet_dependency: false }
            },
            rule_version: RULE_VERSION
        };
    });
}

async function ensureMetricForecastSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_metric_forecasts (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
           metric VARCHAR(80) NOT NULL,
           generated_at TIMESTAMPTZ NOT NULL,
           horizon_minutes INTEGER NOT NULL,
           current_value NUMERIC(16,5) NOT NULL,
           forecast_value NUMERIC(16,5) NOT NULL,
           forecast_low NUMERIC(16,5) NOT NULL,
           forecast_high NUMERIC(16,5) NOT NULL,
           slope_per_hour NUMERIC(16,6) NOT NULL,
           method VARCHAR(40) NOT NULL,
           confidence NUMERIC(5,4) NOT NULL,
           data_quality_score NUMERIC(5,4) NOT NULL,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's6.1',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_metric_forecast
             UNIQUE (owner_user_id, device_id, context_id, sensor_id, metric, horizon_minutes),
           CONSTRAINT metric_forecast_values_check CHECK (
             horizon_minutes IN (60,180,360,720,1440)
             AND forecast_low <= forecast_high
             AND confidence BETWEEN 0 AND 1 AND data_quality_score BETWEEN 0 AND 1
             AND btrim(metric) <> '' AND btrim(method) <> ''
             AND jsonb_typeof(evidence_json) = 'object')
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count
         FROM agro_metric_forecasts f
         LEFT JOIN sensors s ON s.id = f.sensor_id
         LEFT JOIN devices d ON d.id = f.device_id AND d.id = s.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = f.context_id
         WHERE f.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM f.owner_user_id
            OR c.device_id IS DISTINCT FROM f.device_id
            OR (c.sensor_id IS NOT NULL AND c.sensor_id IS DISTINCT FROM f.sensor_id)`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[metric-forecast-schema] existing rows have invalid tenant/context/sensor identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_metric_forecast_identity() RETURNS trigger AS $$
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
             RAISE EXCEPTION 'metric forecast sensor/device/owner mismatch'; END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id
              OR (context_sensor IS NOT NULL AND context_sensor IS DISTINCT FROM NEW.sensor_id) THEN
             RAISE EXCEPTION 'metric forecast context mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS metric_forecast_identity_guard ON agro_metric_forecasts');
    await executor(
        `CREATE TRIGGER metric_forecast_identity_guard BEFORE INSERT OR UPDATE ON agro_metric_forecasts
         FOR EACH ROW EXECUTE FUNCTION rayat_assert_metric_forecast_identity()`
    );
    await executor('CREATE INDEX IF NOT EXISTS idx_metric_forecast_context_metric ON agro_metric_forecasts (context_id, metric, horizon_minutes)');
    await executor('CREATE INDEX IF NOT EXISTS idx_metric_forecast_sensor_generated ON agro_metric_forecasts (sensor_id, generated_at DESC)');
}

function normalizeScope(scope) {
    if (!scope) { return {}; }
    const result = {
        owner_user_id: scope.ownerUserId == null ? null : positiveInteger(scope.ownerUserId),
        device_id: scope.deviceId == null ? null : positiveInteger(scope.deviceId),
        context_id: scope.contextId == null ? null : positiveInteger(scope.contextId),
        sensor_id: scope.sensorId == null ? null : positiveInteger(scope.sensorId)
    };
    if ((scope.ownerUserId != null && !result.owner_user_id)
        || (scope.deviceId != null && !result.device_id)
        || (scope.contextId != null && !result.context_id)
        || (scope.sensorId != null && !result.sensor_id)) {
        throw new Error('[metric-forecast] invalid scope');
    }
    return result;
}

async function loadForecastInputs({
    generatedAt = new Date(), scope = null, includeNonProduction = false, executor = query
} = {}) {
    const clock = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
    if (Number.isNaN(clock.getTime())) { throw new Error('[metric-forecast] invalid generatedAt'); }
    const normalized = normalizeScope(scope);
    const clauses = ['s.enabled = TRUE', `${METRIC_CASE_SQL} IS NOT NULL`];
    const scopedParams = [];
    if (normalized.owner_user_id) { clauses.push('COALESCE(u.owner_user_id, u.id) = ?'); scopedParams.push(normalized.owner_user_id); }
    if (normalized.device_id) { clauses.push('s.device_id = ?'); scopedParams.push(normalized.device_id); }
    if (normalized.context_id) { clauses.push('c.context_id = ?'); scopedParams.push(normalized.context_id); }
    if (normalized.sensor_id) { clauses.push('s.id = ?'); scopedParams.push(normalized.sensor_id); }
    if (!includeNonProduction) {
        clauses.push('c.is_production = TRUE');
        clauses.push("LOWER(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')");
    }
    const iso = clock.toISOString();
    return executor(
        `SELECT COALESCE(u.owner_user_id, u.id) AS owner_user_id,
                s.device_id, c.context_id, s.id AS sensor_id, s.type, s.subtype,
                ${METRIC_CASE_SQL} AS metric, c.is_production,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('value', recent.value, 'timestamp', recent.timestamp)
                                   ORDER BY recent.timestamp, recent.id)
                  FROM (
                    SELECT sr.id, sr.value, sr.timestamp FROM sensor_readings sr
                    WHERE sr.sensor_id = s.id AND sr.timestamp >= c.valid_from
                      AND sr.timestamp <= CAST(? AS TIMESTAMPTZ)
                      AND sr.timestamp >= CAST(? AS TIMESTAMPTZ) - (? * INTERVAL '1 hour')
                    ORDER BY sr.timestamp DESC, sr.id DESC LIMIT ?
                  ) recent
                ), '[]'::jsonb) AS reading_rows,
                CASE WHEN b.id IS NULL THEN FALSE ELSE TRUE END AS baseline_available,
                b.stddev_value AS baseline_stddev, b.confidence AS baseline_confidence,
                b.data_quality_score AS baseline_data_quality
         FROM sensors s
         JOIN devices d ON d.id = s.device_id
         JOIN users u ON u.id = d.user_id
         JOIN LATERAL (
           SELECT cc.id AS context_id, cc.owner_user_id, cc.device_id,
                  cc.is_production, cc.usage_type, cc.valid_from, cc.valid_to
           FROM agro_context_segments cc
           WHERE cc.device_id = s.device_id AND (cc.sensor_id = s.id OR cc.sensor_id IS NULL)
             AND cc.valid_from <= CAST(? AS TIMESTAMPTZ)
             AND (cc.valid_to IS NULL OR cc.valid_to > CAST(? AS TIMESTAMPTZ))
           ORDER BY (cc.sensor_id IS NULL) ASC, cc.valid_from DESC, cc.id DESC LIMIT 1
         ) c ON c.owner_user_id = COALESCE(u.owner_user_id, u.id) AND c.device_id = s.device_id
         LEFT JOIN agro_greenhouse_baselines b ON b.owner_user_id = c.owner_user_id
           AND b.device_id = s.device_id AND b.context_id = c.context_id
           AND b.metric = ${METRIC_CASE_SQL}
         WHERE ${clauses.join(' AND ')}
         ORDER BY owner_user_id, s.device_id, c.context_id, s.id`,
        [iso, iso, LOOKBACK_HOURS, MAX_READINGS, iso, iso, ...scopedParams]
    );
}

async function upsertMetricForecast(forecast, executor = query) {
    const identity = assertForecastIdentity(forecast, 'metric-forecast-upsert');
    await executor(
        `INSERT INTO agro_metric_forecasts
          (owner_user_id, device_id, context_id, sensor_id, metric, generated_at,
           horizon_minutes, current_value, forecast_value, forecast_low, forecast_high,
           slope_per_hour, method, confidence, data_quality_score, evidence_json,
           rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, sensor_id, metric, horizon_minutes)
         DO UPDATE SET generated_at=EXCLUDED.generated_at, current_value=EXCLUDED.current_value,
           forecast_value=EXCLUDED.forecast_value, forecast_low=EXCLUDED.forecast_low,
           forecast_high=EXCLUDED.forecast_high, slope_per_hour=EXCLUDED.slope_per_hour,
           method=EXCLUDED.method, confidence=EXCLUDED.confidence,
           data_quality_score=EXCLUDED.data_quality_score, evidence_json=EXCLUDED.evidence_json,
           rule_version=EXCLUDED.rule_version, updated_at=NOW()`,
        [identity.owner_user_id, identity.device_id, identity.context_id, identity.sensor_id,
            identity.metric, forecast.generated_at, forecast.horizon_minutes,
            forecast.current_value, forecast.forecast_value, forecast.forecast_low,
            forecast.forecast_high, forecast.slope_per_hour, forecast.method,
            forecast.confidence, forecast.data_quality_score,
            JSON.stringify(forecast.evidence_json), RULE_VERSION]
    );
}

async function deleteStaleMetricForecasts({ generatedAt, scope = null, executor = query } = {}) {
    const normalized = normalizeScope(scope);
    const clauses = ['f.generated_at IS DISTINCT FROM CAST(? AS TIMESTAMPTZ)'];
    const params = [(generatedAt instanceof Date ? generatedAt : new Date(generatedAt)).toISOString()];
    for (const [key, value] of Object.entries(normalized)) {
        if (value) { clauses.push(`f.${key} = ?`); params.push(value); }
    }
    const rows = await executor(
        `WITH removed AS (
           DELETE FROM agro_metric_forecasts f WHERE ${clauses.join(' AND ')} RETURNING 1
         ) SELECT COUNT(*)::integer AS removed FROM removed`,
        params
    );
    return Number(rows[0] && rows[0].removed) || 0;
}

async function runMetricForecastCycle({
    generatedAt = new Date(), scope = null, includeNonProduction = false,
    dryRun = false, executor = query
} = {}) {
    const inputs = await loadForecastInputs({ generatedAt, scope, includeNonProduction, executor });
    const rows = [];
    let skippedInsufficient = 0;
    for (const input of inputs) {
        const forecasts = computeMetricForecasts(input, generatedAt);
        if (!forecasts.length) { skippedInsufficient += 1; continue; }
        for (const forecast of forecasts) {
            rows.push(forecast);
            if (!dryRun) { await upsertMetricForecast(forecast, executor); }
        }
    }
    const removedStale = dryRun ? 0 : await deleteStaleMetricForecasts({ generatedAt, scope, executor });
    return {
        sensors: inputs.length,
        forecast_rows: rows.length,
        stored: dryRun ? 0 : rows.length,
        skipped_insufficient: skippedInsufficient,
        removed_stale: removedStale,
        dry_run: dryRun,
        rows
    };
}

module.exports = {
    ensureMetricForecastSchema,
    runMetricForecastCycle,
    loadForecastInputs,
    computeMetricForecasts,
    upsertMetricForecast,
    deleteStaleMetricForecasts,
    assertForecastIdentity,
    linearRegression,
    ewma,
    median,
    HORIZONS_MINUTES,
    METRIC_CASE_SQL,
    RULE_VERSION
};
