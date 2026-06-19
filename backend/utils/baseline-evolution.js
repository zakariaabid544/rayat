// Rayat Intelligence - Sprint 3.1 Baseline Evolution Engine (local, context-aware).
// Learning unit: owner_user_id + device_id + context_id + metric.
// Reads sensor_readings and agronomic contexts; writes only agro_greenhouse_baselines.
'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's3.1';

function positiveInteger(value, fallback) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

const BL = {
    EWMA_SPAN: positiveInteger(process.env.AGRO_BL_EWMA_SPAN, 20),
    EWMA_MAX: positiveInteger(process.env.AGRO_BL_EWMA_MAX, 2000),
    MIN_LEARNING_SAMPLES: positiveInteger(process.env.AGRO_BL_MIN_LEARNING, 10),
    STABLE_SAMPLES: positiveInteger(process.env.AGRO_BL_STABLE_SAMPLES, 30),
    MATURE_SAMPLES: positiveInteger(process.env.AGRO_BL_MATURE_SAMPLES, 50),
    STABLE_DAYS: positiveInteger(process.env.AGRO_BL_STABLE_DAYS, 3),
    MATURE_DAYS: positiveInteger(process.env.AGRO_BL_MATURE_DAYS, 7),
    CONF_OCC_REF: positiveInteger(process.env.AGRO_BL_CONF_OCC_REF, 40),
    RECENCY_REF_DAYS: positiveInteger(process.env.AGRO_BL_RECENCY_DAYS, 30)
};

const METRIC_CASE = `CASE
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

function assertBaselineIdentity({ owner_user_id, device_id, context_id, metric }, label = 'baseline') {
    const owner = positiveInteger(owner_user_id, null);
    const device = positiveInteger(device_id, null);
    const context = positiveInteger(context_id, null);
    const normalizedMetric = String(metric || '').trim();
    if (!owner || !device || !context || !normalizedMetric) {
        throw new Error(`[${label}] unresolved owner_user_id/device_id/context_id/metric`);
    }
    return { owner_user_id: owner, device_id: device, context_id: context, metric: normalizedMetric };
}

async function constraintExists(executor, constraintName) {
    const rows = await executor(
        `SELECT 1 FROM pg_constraint
         WHERE conrelid = 'agro_greenhouse_baselines'::regclass AND conname = ? LIMIT 1`,
        [constraintName]
    );
    return rows.length > 0;
}

async function addConstraint(executor, constraintName, definition) {
    if (!await constraintExists(executor, constraintName)) {
        await executor(`ALTER TABLE agro_greenhouse_baselines ADD CONSTRAINT ${constraintName} ${definition}`);
    }
}

async function ensureBaselineSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_greenhouse_baselines (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL,
           metric VARCHAR(80) NOT NULL,
           sample_count INTEGER NOT NULL DEFAULT 0,
           first_seen_at TIMESTAMPTZ NULL,
           last_seen_at TIMESTAMPTZ NULL,
           mean_value NUMERIC(14,4) NULL,
           min_value NUMERIC(14,4) NULL,
           max_value NUMERIC(14,4) NULL,
           stddev_value NUMERIC(14,4) NULL,
           variance_value NUMERIC(16,4) NULL,
           p10_value NUMERIC(14,4) NULL,
           p50_value NUMERIC(14,4) NULL,
           p90_value NUMERIC(14,4) NULL,
           ewma_value NUMERIC(14,4) NULL,
           ewma_variance NUMERIC(16,4) NULL,
           normal_low NUMERIC(14,4) NULL,
           normal_high NUMERIC(14,4) NULL,
           confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
           maturity_level VARCHAR(12) NOT NULL DEFAULT 'cold_start',
           data_quality_score NUMERIC(4,3) NOT NULL DEFAULT 0,
           is_production BOOLEAN NOT NULL DEFAULT TRUE,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's3.1',
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_baseline UNIQUE (owner_user_id, device_id, context_id, metric),
           CONSTRAINT agro_greenhouse_baselines_context_fk
             FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           CONSTRAINT agro_greenhouse_baselines_values_check CHECK (
             sample_count >= 0 AND confidence BETWEEN 0 AND 1 AND data_quality_score BETWEEN 0 AND 1
             AND maturity_level IN ('cold_start','learning','stable','mature')
           )
         )`
    );

    const invalid = await executor(
        `SELECT COUNT(*) AS count
         FROM agro_greenhouse_baselines b
         LEFT JOIN devices d ON d.id = b.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = b.context_id
         WHERE b.owner_user_id IS NULL OR b.device_id IS NULL OR b.context_id IS NULL
            OR b.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM b.owner_user_id
            OR c.device_id IS DISTINCT FROM b.device_id`
    );
    if (Number(invalid[0] && invalid[0].count) > 0) {
        throw new Error('[baseline-schema] existing baseline rows have invalid tenant/context identity');
    }

    await addConstraint(
        executor,
        'agro_greenhouse_baselines_context_fk',
        'FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT'
    );
    await addConstraint(
        executor,
        'agro_greenhouse_baselines_values_check',
        `CHECK (
          sample_count >= 0 AND confidence BETWEEN 0 AND 1 AND data_quality_score BETWEEN 0 AND 1
          AND maturity_level IN ('cold_start','learning','stable','mature')
        )`
    );

    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_baseline_identity()
         RETURNS trigger AS $$
         DECLARE
           expected_owner INTEGER;
           context_owner INTEGER;
           context_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'baseline identity cannot be NULL';
           END IF;
           SELECT COALESCE(u.owner_user_id, u.id)
             INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id
            WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id
             INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'baseline owner_user_id does not own device_id';
           END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'baseline context_id does not belong to owner/device';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`
    );
    const trigger = await executor(
        `SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'agro_greenhouse_baselines'::regclass
           AND tgname = 'agro_greenhouse_baselines_identity_guard' AND NOT tgisinternal`
    );
    if (!trigger.length) {
        await executor(
            `CREATE TRIGGER agro_greenhouse_baselines_identity_guard
             BEFORE INSERT OR UPDATE ON agro_greenhouse_baselines
             FOR EACH ROW EXECUTE FUNCTION rayat_assert_baseline_identity()`
        );
    }
    await executor('CREATE INDEX IF NOT EXISTS idx_baseline_device_ctx ON agro_greenhouse_baselines (device_id, context_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_baseline_owner ON agro_greenhouse_baselines (owner_user_id)');
}

function computeEwma(values, span = BL.EWMA_SPAN) {
    const normalizedSpan = positiveInteger(span, null);
    if (!normalizedSpan) { throw new Error('[baseline] EWMA span must be a positive integer'); }
    const input = Array.isArray(values) ? values : [];
    const finiteValues = input.map(Number).filter(Number.isFinite);
    if (!finiteValues.length) { return { ewma: null, ewmaVar: null }; }
    const valuesToUse = finiteValues.length > BL.EWMA_MAX
        ? finiteValues.slice(finiteValues.length - BL.EWMA_MAX)
        : finiteValues;
    const alpha = 2 / (normalizedSpan + 1);
    let ewma = valuesToUse[0];
    let ewmaVar = 0;
    for (let index = 1; index < valuesToUse.length; index += 1) {
        const difference = valuesToUse[index] - ewma;
        ewmaVar = (1 - alpha) * (ewmaVar + alpha * difference * difference);
        ewma += alpha * difference;
    }
    return { ewma, ewmaVar };
}

function maturityLevel(sampleCount, distinctDays) {
    const samples = Number(sampleCount);
    const days = Number(distinctDays);
    if (samples < BL.MIN_LEARNING_SAMPLES) { return 'cold_start'; }
    if (days < BL.STABLE_DAYS || samples < BL.STABLE_SAMPLES) { return 'learning'; }
    if (samples >= BL.MATURE_SAMPLES && days >= BL.MATURE_DAYS) { return 'mature'; }
    return 'stable';
}

function computeBaseline(group, nowMs) {
    const sampleCount = Number(group.sample_count);
    const distinctDays = Number(group.distinct_days);
    const mean = C.num(group.mean);
    const min = C.num(group.min_v);
    const max = C.num(group.max_v);
    const stddev = C.num(group.stddev);
    const variance = C.num(group.variance);
    const p10 = C.num(group.p10);
    const p50 = C.num(group.p50);
    const p90 = C.num(group.p90);
    if (!Number.isInteger(sampleCount) || sampleCount <= 0 || !Number.isInteger(distinctDays) || distinctDays <= 0
        || [mean, min, max, stddev, variance, p10, p50, p90].some((value) => value === null)) {
        throw new Error('[baseline] invalid aggregate statistics');
    }
    const clockMs = Number(nowMs);
    if (!Number.isFinite(clockMs)) { throw new Error('[baseline] invalid computation clock'); }
    const lastSeenMs = new Date(group.last_seen).getTime();
    if (!Number.isFinite(lastSeenMs)) { throw new Error('[baseline] invalid last_seen timestamp'); }

    const coefficientOfVariation = mean === 0 ? 0 : Math.abs(stddev / mean);
    const { ewma, ewmaVar } = computeEwma(group.vals || [], BL.EWMA_SPAN);
    if (ewma === null || ewmaVar === null) { throw new Error('[baseline] missing EWMA source values'); }
    const recencyDays = Math.max(0, C.daysBetween(clockMs, lastSeenMs));
    const recencyFactor = C.recencyFactor(recencyDays, BL.RECENCY_REF_DAYS);
    const volumeFactor = C.normLog(sampleCount, BL.CONF_OCC_REF);
    const daysFactor = Math.min(distinctDays / BL.MATURE_DAYS, 1);
    const varianceStability = C.clamp01(1 - C.clamp01(coefficientOfVariation));
    const confidence = C.clamp01(
        0.4 * volumeFactor + 0.2 * daysFactor + 0.2 * varianceStability + 0.2 * recencyFactor
    );
    const dataQuality = C.clamp01(0.5 * volumeFactor + 0.5 * daysFactor);
    const maturity = maturityLevel(sampleCount, distinctDays);

    return {
        sample_count: sampleCount,
        mean_value: C.round3(mean),
        min_value: C.round3(min),
        max_value: C.round3(max),
        stddev_value: C.round3(stddev),
        variance_value: C.round3(variance),
        p10_value: C.round3(p10),
        p50_value: C.round3(p50),
        p90_value: C.round3(p90),
        ewma_value: C.round3(ewma),
        ewma_variance: C.round3(ewmaVar),
        normal_low: C.round3(p10),
        normal_high: C.round3(p90),
        confidence: C.round3(confidence),
        maturity_level: maturity,
        data_quality_score: C.round3(dataQuality),
        first_seen_at: group.first_seen,
        last_seen_at: group.last_seen,
        evidence: {
            rule_version: RULE_VERSION,
            aggregation_key: ['owner_user_id', 'device_id', 'context_id', 'metric'],
            sample_count: sampleCount,
            distinct_days: distinctDays,
            coefficient_of_variation: C.round3(coefficientOfVariation),
            percentile_method: 'postgres_percentile_cont',
            normal_band_basis: 'empirical_p10_p90',
            ewma: { span: BL.EWMA_SPAN, source_limit: BL.EWMA_MAX, ordered_by: ['timestamp', 'reading_id'] },
            confidence: {
                score: C.round3(confidence),
                weights: { volume: 0.4, distinct_days: 0.2, variance_stability: 0.2, recency: 0.2 },
                factors: {
                    volume: C.round3(volumeFactor), distinct_days: C.round3(daysFactor),
                    variance_stability: C.round3(varianceStability), recency: C.round3(recencyFactor)
                }
            },
            maturity: {
                level: maturity,
                thresholds: {
                    learning_samples: BL.MIN_LEARNING_SAMPLES,
                    stable_samples: BL.STABLE_SAMPLES,
                    stable_days: BL.STABLE_DAYS,
                    mature_samples: BL.MATURE_SAMPLES,
                    mature_days: BL.MATURE_DAYS
                }
            },
            recency_days: Math.round(recencyDays)
        }
    };
}

function normalizeScope(scope) {
    if (!scope) { return null; }
    const ownerUserId = scope.ownerUserId == null ? null : positiveInteger(scope.ownerUserId, null);
    const deviceId = scope.deviceId == null ? null : positiveInteger(scope.deviceId, null);
    if ((scope.ownerUserId != null && !ownerUserId) || (scope.deviceId != null && !deviceId)) {
        throw new Error('[baseline] invalid owner/device scope');
    }
    return { ownerUserId, deviceId };
}

function sourceWhere(scope) {
    const where = ['sr.value IS NOT NULL'];
    const params = [];
    if (scope && scope.deviceId) { where.push('s.device_id = ?'); params.push(scope.deviceId); }
    if (scope && scope.ownerUserId) {
        where.push('COALESCE(du.owner_user_id, du.id) = ?');
        params.push(scope.ownerUserId);
    }
    return { where, params };
}

function resolvedSourceCte(where) {
    return `WITH resolved AS (
      SELECT sr.id AS reading_id, sr.value::float8 AS value, sr.timestamp AS ts,
             s.device_id, COALESCE(du.owner_user_id, du.id) AS owner_user_id,
             ${METRIC_CASE} AS metric,
             c.context_id, c.context_owner_user_id, c.context_device_id, c.is_production
      FROM sensor_readings sr
      JOIN sensors s ON s.id = sr.sensor_id
      JOIN devices d ON d.id = s.device_id
      LEFT JOIN users du ON du.id = d.user_id
      LEFT JOIN LATERAL (
        SELECT cc.id AS context_id, cc.owner_user_id AS context_owner_user_id,
               cc.device_id AS context_device_id, cc.is_production
        FROM agro_context_segments cc
        WHERE cc.device_id = s.device_id AND (cc.sensor_id = sr.sensor_id OR cc.sensor_id IS NULL)
          AND cc.valid_from <= sr.timestamp AND (cc.valid_to IS NULL OR cc.valid_to > sr.timestamp)
        ORDER BY (cc.sensor_id IS NULL) ASC, cc.valid_from DESC, cc.id DESC
        LIMIT 1
      ) c ON TRUE
      WHERE ${where.join(' AND ')}
    )`;
}

async function loadBaselineGroups({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    const { where, params } = sourceWhere(normalizedScope);
    params.push(BL.EWMA_MAX);
    const productionClause = includeNonProduction ? '' : 'AND is_production = TRUE';
    const rows = await executor(
        `${resolvedSourceCte(where)},
         invalid AS (
           SELECT COUNT(*) AS invalid_count, MIN(reading_id) AS first_invalid_reading_id
           FROM resolved
           WHERE metric IS NOT NULL AND (
             owner_user_id IS NULL OR context_id IS NULL
             OR context_owner_user_id IS DISTINCT FROM owner_user_id
             OR context_device_id IS DISTINCT FROM device_id
           )
         ),
         eligible AS (
           SELECT * FROM resolved
           WHERE metric IS NOT NULL AND owner_user_id IS NOT NULL AND context_id IS NOT NULL
             AND context_owner_user_id = owner_user_id AND context_device_id = device_id
             ${productionClause}
         ),
         ranked AS (
           SELECT eligible.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY owner_user_id, device_id, context_id, metric, is_production
                    ORDER BY ts DESC, reading_id DESC
                  ) AS ewma_rank
           FROM eligible
         ),
         grouped AS (
           SELECT owner_user_id, device_id, context_id, metric, is_production AS is_prod,
                COUNT(*) AS sample_count, AVG(value) AS mean, MIN(value) AS min_v, MAX(value) AS max_v,
                COALESCE(STDDEV_SAMP(value), 0) AS stddev,
                COALESCE(VAR_SAMP(value), 0) AS variance,
                percentile_cont(0.1) WITHIN GROUP (ORDER BY value) AS p10,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS p50,
                percentile_cont(0.9) WITHIN GROUP (ORDER BY value) AS p90,
                MIN(ts) AS first_seen, MAX(ts) AS last_seen,
                COUNT(DISTINCT date_trunc('day', ts)) AS distinct_days,
                  array_agg(value ORDER BY ts, reading_id) FILTER (WHERE ewma_rank <= ?) AS vals
           FROM ranked
           GROUP BY owner_user_id, device_id, context_id, metric, is_production
         )
         SELECT invalid.invalid_count, invalid.first_invalid_reading_id,
                COALESCE(
                  (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.owner_user_id, g.device_id, g.context_id, g.metric)
                   FROM grouped g),
                  '[]'::jsonb
                ) AS groups
         FROM invalid`,
        params
    );
    const result = rows[0] || { invalid_count: 0, groups: [] };
    const invalidCount = Number(result.invalid_count);
    if (invalidCount > 0) {
        throw new Error(
            `[baseline] fail-closed: ${invalidCount} supported readings without valid tenant context`
            + ` (first reading id ${result.first_invalid_reading_id})`
        );
    }
    const groups = typeof result.groups === 'string' ? JSON.parse(result.groups) : result.groups;
    return Array.isArray(groups) ? groups : [];
}

async function upsertBaseline(group, baseline, executor = query) {
    const identity = assertBaselineIdentity(group, 'baseline-upsert');
    await executor(
        `INSERT INTO agro_greenhouse_baselines
            (owner_user_id, device_id, context_id, metric, sample_count, first_seen_at, last_seen_at,
             mean_value, min_value, max_value, stddev_value, variance_value, p10_value, p50_value, p90_value,
             ewma_value, ewma_variance, normal_low, normal_high, confidence, maturity_level, data_quality_score,
             is_production, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, metric) DO UPDATE SET
             sample_count=EXCLUDED.sample_count, first_seen_at=EXCLUDED.first_seen_at,
             last_seen_at=EXCLUDED.last_seen_at, mean_value=EXCLUDED.mean_value,
             min_value=EXCLUDED.min_value, max_value=EXCLUDED.max_value,
             stddev_value=EXCLUDED.stddev_value, variance_value=EXCLUDED.variance_value,
             p10_value=EXCLUDED.p10_value, p50_value=EXCLUDED.p50_value, p90_value=EXCLUDED.p90_value,
             ewma_value=EXCLUDED.ewma_value, ewma_variance=EXCLUDED.ewma_variance,
             normal_low=EXCLUDED.normal_low, normal_high=EXCLUDED.normal_high,
             confidence=EXCLUDED.confidence, maturity_level=EXCLUDED.maturity_level,
             data_quality_score=EXCLUDED.data_quality_score, is_production=EXCLUDED.is_production,
             evidence_json=EXCLUDED.evidence_json, rule_version=EXCLUDED.rule_version, updated_at=NOW()
         RETURNING id`,
        [
            identity.owner_user_id, identity.device_id, identity.context_id, identity.metric,
            baseline.sample_count, baseline.first_seen_at, baseline.last_seen_at,
            baseline.mean_value, baseline.min_value, baseline.max_value,
            baseline.stddev_value, baseline.variance_value,
            baseline.p10_value, baseline.p50_value, baseline.p90_value,
            baseline.ewma_value, baseline.ewma_variance,
            baseline.normal_low, baseline.normal_high,
            baseline.confidence, baseline.maturity_level, baseline.data_quality_score,
            group.is_prod === false ? false : true,
            JSON.stringify(baseline.evidence), RULE_VERSION
        ]
    );
}

async function runBaselineEvolution({
    now = new Date(), scope = null, includeNonProduction = false, dryRun = false, executor = query
} = {}) {
    const clock = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(clock.getTime())) { throw new Error('[baseline] invalid now timestamp'); }
    const groups = await loadBaselineGroups({ scope, includeNonProduction, executor });
    const summary = {
        groups: groups.length,
        stored: 0,
        by_maturity: { cold_start: 0, learning: 0, stable: 0, mature: 0 },
        dry_run: dryRun
    };
    const rows = [];
    for (const group of groups) {
        const identity = assertBaselineIdentity(group, 'baseline-group');
        const baseline = computeBaseline(group, clock.getTime());
        summary.by_maturity[baseline.maturity_level] += 1;
        rows.push({ key: identity, ...baseline });
        if (!dryRun) { await upsertBaseline(group, baseline, executor); }
        summary.stored += 1;
    }
    return dryRun ? { ...summary, rows } : summary;
}

module.exports = {
    ensureBaselineSchema,
    runBaselineEvolution,
    loadBaselineGroups,
    upsertBaseline,
    computeBaseline,
    computeEwma,
    maturityLevel,
    assertBaselineIdentity,
    BL,
    RULE_VERSION
};
