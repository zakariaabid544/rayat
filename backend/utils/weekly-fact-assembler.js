'use strict';

// Sprint 5.1: deterministic, tenant-safe weekly snapshots of existing intelligence.
const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's5.1';
const NON_PRODUCTION_USAGE = Object.freeze(['demo', 'test', 'calibration', 'maintenance']);
const SOURCE_TABLES = Object.freeze([
    'agro_greenhouse_health_profile',
    'agro_greenhouse_knowledge',
    'agro_behavioral_signature',
    'agro_intelligence_score',
    'agro_intelligence_subscores',
    'agro_intelligence_trends',
    'agro_intelligence_benchmark',
    'agro_intelligence_explanations'
]);

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertWeeklyIdentity(value, label = 'weekly-facts') {
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

function isoDate(date) {
    return date.toISOString().slice(0, 10);
}

function parseDate(value, label) {
    const raw = value instanceof Date ? new Date(value.getTime()) : new Date(`${String(value)}T00:00:00.000Z`);
    if (Number.isNaN(raw.getTime())) { throw new Error(`[weekly-facts] invalid ${label}`); }
    return new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
}

function resolveWeekWindow({ weekStart = null, referenceDate = new Date() } = {}) {
    const date = parseDate(weekStart || referenceDate, weekStart ? 'weekStart' : 'referenceDate');
    const offset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
    const end = new Date(date.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
    return { week_start: isoDate(date), week_end: isoDate(end) };
}

function objectValue(value) {
    const parsed = C.parseJson(value, {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function arrayValue(value) {
    const parsed = C.parseJson(value, []);
    return Array.isArray(parsed) ? parsed : [];
}

function numberOrNull(value, digits = 1) {
    const parsed = C.num(value);
    if (parsed === null) { return null; }
    const scale = 10 ** digits;
    return Math.round(parsed * scale) / scale;
}

function normalizeFactor(value) {
    if (typeof value === 'string' && value.trim()) {
        return { key: value.trim(), label: value.trim(), score: null };
    }
    if (!value || typeof value !== 'object') { return null; }
    const key = value.key || value.factor || value.label || value.area || value.metric;
    if (!key) { return null; }
    return {
        key: String(key),
        label: String(value.label || value.factor || value.key || value.area || value.metric),
        score: numberOrNull(value.score, 1)
    };
}

function uniqueFactors(groups, limit = 5) {
    const result = [];
    const seen = new Set();
    for (const group of groups) {
        for (const value of arrayValue(group)) {
            const factor = normalizeFactor(value);
            if (!factor || seen.has(factor.key)) { continue; }
            seen.add(factor.key);
            result.push(factor);
            if (result.length >= limit) { return result; }
        }
    }
    return result;
}

function uniqueStrings(groups, limit = 8) {
    const result = [];
    const seen = new Set();
    for (const group of groups) {
        for (const value of arrayValue(group)) {
            const text = typeof value === 'string'
                ? value.trim()
                : String((value && (value.label || value.focus || value.metric || value.area)) || '').trim();
            if (!text || seen.has(text)) { continue; }
            seen.add(text);
            result.push(text);
            if (result.length >= limit) { return result; }
        }
    }
    return result;
}

function assembleWeeklyFact(input, window) {
    const identity = assertWeeklyIdentity(input, 'weekly-fact-input');
    const health = objectValue(input.health_row);
    const knowledge = objectValue(input.knowledge_row);
    const behavior = objectValue(input.behavior_row);
    const score = objectValue(input.score_row);
    const subscores = objectValue(input.subscore_row);
    const trends = arrayValue(input.trend_rows)
        .map((row) => ({
            metric: String(row.metric || ''),
            direction: String(row.trend_direction || 'insufficient_data'),
            strength: numberOrNull(row.trend_strength, 3),
            confidence: numberOrNull(row.trend_confidence, 3),
            sample_count: Number(row.sample_count) || 0,
            slope_per_day: numberOrNull(row.slope_per_day, 4)
        }))
        .filter((row) => row.metric)
        .sort((a, b) => a.metric.localeCompare(b.metric));
    const benchmark = objectValue(input.benchmark_row);
    const explanation = objectValue(input.explanation_row);

    const healthSummary = Object.keys(health).length ? {
        available: true,
        health_score: numberOrNull(health.health_score),
        health_band: String(health.health_band || 'unknown'),
        resilience_score: numberOrNull(health.resilience_score),
        stress_load_score: numberOrNull(health.stress_load_score),
        recovery_score: numberOrNull(health.recovery_score),
        stability_score: numberOrNull(health.stability_score),
        data_confidence_score: numberOrNull(health.data_confidence_score),
        confidence: numberOrNull(health.confidence, 3),
        maturity_level: String(health.maturity_level || 'cold_start')
    } : { available: false, health_band: 'unknown' };
    const scoreSummary = Object.keys(score).length ? {
        available: true,
        intelligence_score: numberOrNull(score.intelligence_score),
        intelligence_band: String(score.intelligence_band || 'unknown'),
        confidence: numberOrNull(score.confidence, 3),
        maturity_level: String(score.maturity_level || 'cold_start')
    } : { available: false, intelligence_band: 'unknown' };
    const subscoreSummary = Object.keys(subscores).length ? {
        available: true,
        stability: numberOrNull(subscores.stability_score),
        stress: numberOrNull(subscores.stress_score),
        recovery: numberOrNull(subscores.recovery_score),
        resilience: numberOrNull(subscores.resilience_score),
        data_quality: numberOrNull(subscores.data_quality_score),
        maturity: numberOrNull(subscores.maturity_score),
        confidence: numberOrNull(subscores.confidence, 3),
        maturity_level: String(subscores.maturity_level || 'cold_start')
    } : { available: false };
    const trendSummary = {
        available: trends.length > 0,
        items: trends,
        improved: trends.filter((row) => row.direction === 'improving').map((row) => row.metric),
        worsened: trends.filter((row) => ['degrading', 'volatile'].includes(row.direction)).map((row) => row.metric)
    };
    const benchmarkAvailable = benchmark.benchmark_status === 'ok';
    const benchmarkSummary = benchmarkAvailable ? {
        available: true,
        status: 'ok',
        percentile_rank: numberOrNull(benchmark.percentile_rank),
        relative_position: String(benchmark.relative_position || 'unknown'),
        cohort_average: numberOrNull(benchmark.cohort_average),
        cohort_median: numberOrNull(benchmark.cohort_median),
        cohort_top_quartile: numberOrNull(benchmark.cohort_top_quartile),
        cohort_bottom_quartile: numberOrNull(benchmark.cohort_bottom_quartile),
        cohort_size: Number(benchmark.cohort_size) || 0,
        distinct_owner_count: Number(benchmark.distinct_owner_count) || 0,
        confidence: numberOrNull(benchmark.benchmark_confidence, 3),
        crop_key: benchmark.crop_key || null,
        medium: benchmark.medium || null,
        cultivation_type: benchmark.cultivation_type || null
    } : { available: false, status: String(benchmark.benchmark_status || 'unavailable') };

    const positiveFactors = uniqueFactors([
        explanation.top_positive_factors, health.top_positive_factors, knowledge.top_strengths
    ]);
    const negativeFactors = uniqueFactors([
        explanation.top_negative_factors, health.top_negative_factors, knowledge.top_weaknesses
    ]);
    const recommendedFocus = uniqueStrings([
        explanation.recommended_focus, health.recommended_focus
    ], 5);
    if (!recommendedFocus.length) { recommendedFocus.push('maintain_current_practices'); }

    const limitations = uniqueStrings([explanation.data_limitations], 8);
    if (!healthSummary.available) { limitations.push('Profilo di salute non disponibile.'); }
    if (!scoreSummary.available) { limitations.push('Punteggio di intelligenza non disponibile.'); }
    if (!subscoreSummary.available) { limitations.push('Sotto-punteggi non disponibili.'); }
    if (!trendSummary.available) { limitations.push('Storico insufficiente per valutare le tendenze.'); }
    if (!benchmarkAvailable) { limitations.push('Benchmark non disponibile per popolazione insufficiente o vincoli di privacy.'); }

    const dataQualityNotes = [];
    if (subscoreSummary.available && subscoreSummary.data_quality !== null) {
        dataQualityNotes.push(`Qualità dei dati: ${Math.round(subscoreSummary.data_quality)}/100.`);
    } else if (healthSummary.available && healthSummary.data_confidence_score !== null) {
        dataQualityNotes.push(`Confidenza dei dati: ${Math.round(healthSummary.data_confidence_score)}/100.`);
    } else {
        dataQualityNotes.push('Qualità dei dati non ancora quantificabile.');
    }
    if (explanation.confidence_explanation) { dataQualityNotes.push(String(explanation.confidence_explanation)); }

    const sourceAvailability = {
        health_profile: healthSummary.available,
        knowledge: Object.keys(knowledge).length > 0,
        behavioral_signature: Object.keys(behavior).length > 0,
        intelligence_score: scoreSummary.available,
        subscores: subscoreSummary.available,
        trends: trendSummary.available,
        benchmark: benchmarkAvailable,
        explanation: Object.keys(explanation).length > 0
    };
    return {
        ...identity,
        ...window,
        health_summary: healthSummary,
        intelligence_score_summary: scoreSummary,
        subscore_summary: subscoreSummary,
        trend_summary: trendSummary,
        benchmark_summary: benchmarkSummary,
        positive_factors: positiveFactors,
        negative_factors: negativeFactors,
        recommended_focus: recommendedFocus,
        data_quality_notes: dataQualityNotes,
        limitations: [...new Set(limitations)],
        confidence: numberOrNull(score.confidence ?? health.confidence ?? 0, 3) || 0,
        evidence_json: {
            rule_version: RULE_VERSION,
            source_availability: sourceAvailability,
            behavioral_signature: Object.keys(behavior).length ? {
                signature_label: behavior.signature_label || 'unknown',
                recovery_behavior: behavior.recovery_behavior || 'unknown',
                stress_behavior: behavior.stress_behavior || 'unknown',
                stability_behavior: behavior.stability_behavior || 'unknown',
                volatility_behavior: behavior.volatility_behavior || 'unknown',
                sensor_behavior: behavior.sensor_behavior || 'unknown',
                resilience_level: behavior.resilience_level || 'unknown',
                risk_tendency: behavior.risk_tendency || 'unknown'
            } : null,
            knowledge: Object.keys(knowledge).length ? {
                knowledge_maturity: knowledge.knowledge_maturity || 'cold_start',
                confidence: numberOrNull(knowledge.confidence, 3),
                recurring_risks: uniqueStrings([knowledge.recurring_risks], 5),
                recurring_recoveries: uniqueStrings([knowledge.recurring_recoveries], 5)
            } : null,
            privacy: { raw_evidence: false, cross_customer_evidence: false, local_first: true }
        },
        rule_version: RULE_VERSION
    };
}

async function ensureWeeklyFactSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_weekly_fact_packages (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           week_start DATE NOT NULL,
           week_end DATE NOT NULL,
           health_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
           intelligence_score_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
           subscore_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
           trend_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
           benchmark_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
           positive_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
           negative_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
           recommended_focus JSONB NOT NULL DEFAULT '[]'::jsonb,
           data_quality_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
           limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
           confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's5.1',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_weekly_fact_package UNIQUE (owner_user_id, device_id, context_id, week_start),
           CONSTRAINT weekly_fact_window_check CHECK (week_end = week_start + 6),
           CONSTRAINT weekly_fact_json_check CHECK (
             jsonb_typeof(health_summary) = 'object'
             AND jsonb_typeof(intelligence_score_summary) = 'object'
             AND jsonb_typeof(subscore_summary) = 'object'
             AND jsonb_typeof(trend_summary) = 'object'
             AND jsonb_typeof(benchmark_summary) = 'object'
             AND jsonb_typeof(positive_factors) = 'array'
             AND jsonb_typeof(negative_factors) = 'array'
             AND jsonb_typeof(recommended_focus) = 'array'
             AND jsonb_typeof(data_quality_notes) = 'array'
             AND jsonb_typeof(limitations) = 'array'
             AND confidence BETWEEN 0 AND 1)
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count
         FROM agro_weekly_fact_packages f
         LEFT JOIN devices d ON d.id = f.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = f.context_id
         WHERE f.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM f.owner_user_id
            OR c.device_id IS DISTINCT FROM f.device_id`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[weekly-fact-schema] existing rows have invalid tenant/context identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_weekly_fact_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; context_owner INTEGER; context_device INTEGER;
         BEGIN
           SELECT COALESCE(u.owner_user_id, u.id) INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'weekly fact owner_user_id does not own device_id'; END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'weekly fact context_id does not belong to owner/device'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS weekly_fact_identity_guard ON agro_weekly_fact_packages');
    await executor(
        `CREATE TRIGGER weekly_fact_identity_guard BEFORE INSERT OR UPDATE ON agro_weekly_fact_packages
         FOR EACH ROW EXECUTE FUNCTION rayat_assert_weekly_fact_identity()`
    );
    await executor('CREATE INDEX IF NOT EXISTS idx_weekly_fact_context_week ON agro_weekly_fact_packages (context_id, week_start DESC)');
    await executor('CREATE INDEX IF NOT EXISTS idx_weekly_fact_owner_device_week ON agro_weekly_fact_packages (owner_user_id, device_id, week_start DESC)');
}

function normalizeScope(scope) {
    if (!scope) { return null; }
    const ownerUserId = scope.ownerUserId == null ? null : positiveInteger(scope.ownerUserId);
    const deviceId = scope.deviceId == null ? null : positiveInteger(scope.deviceId);
    if ((scope.ownerUserId != null && !ownerUserId) || (scope.deviceId != null && !deviceId)) {
        throw new Error('[weekly-facts] invalid owner/device scope');
    }
    return { ownerUserId, deviceId };
}

function scopeSql(scope, alias) {
    const clauses = [];
    const params = [];
    if (scope && scope.ownerUserId) { clauses.push(`${alias}.owner_user_id = ?`); params.push(scope.ownerUserId); }
    if (scope && scope.deviceId) { clauses.push(`${alias}.device_id = ?`); params.push(scope.deviceId); }
    return { clauses, params };
}

async function assertWeeklySourceIdentities({ scope = null, executor = query } = {}) {
    const scoped = scopeSql(normalizeScope(scope), 'source');
    const rows = await executor(
        `WITH source AS (
           SELECT owner_user_id, device_id, context_id FROM agro_greenhouse_health_profile
           UNION ALL SELECT owner_user_id, device_id, context_id FROM agro_greenhouse_knowledge
           UNION ALL SELECT owner_user_id, device_id, context_id FROM agro_behavioral_signature
           UNION ALL SELECT owner_user_id, device_id, context_id FROM agro_intelligence_score
           UNION ALL SELECT owner_user_id, device_id, context_id FROM agro_intelligence_subscores
           UNION ALL SELECT owner_user_id, device_id, context_id FROM agro_intelligence_trends
           UNION ALL SELECT owner_user_id, device_id, context_id FROM agro_intelligence_benchmark
           UNION ALL SELECT owner_user_id, device_id, context_id FROM agro_intelligence_explanations
         )
         SELECT COUNT(*)::integer AS invalid_count FROM source
         LEFT JOIN devices d ON d.id = source.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = source.context_id
         WHERE ${scoped.clauses.length ? `${scoped.clauses.join(' AND ')} AND` : ''} (
           source.owner_user_id IS NULL OR source.device_id IS NULL OR source.context_id IS NULL
           OR source.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
           OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM source.owner_user_id
           OR c.device_id IS DISTINCT FROM source.device_id)
        `,
        scoped.params
    );
    const count = Number(rows[0] && rows[0].invalid_count) || 0;
    if (count > 0) { throw new Error(`[weekly-facts] fail-closed: ${count} source rows have invalid tenant/context identity`); }
}

async function loadWeeklyInputs({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    await assertWeeklySourceIdentities({ scope: normalizedScope, executor });
    const scoped = scopeSql(normalizedScope, 'c');
    const production = includeNonProduction ? '' :
        `AND c.is_production = TRUE
         AND lower(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')`;
    return executor(
        `WITH source_keys AS (
           SELECT owner_user_id, device_id, context_id FROM agro_greenhouse_health_profile
           UNION SELECT owner_user_id, device_id, context_id FROM agro_greenhouse_knowledge
           UNION SELECT owner_user_id, device_id, context_id FROM agro_behavioral_signature
           UNION SELECT owner_user_id, device_id, context_id FROM agro_intelligence_score
           UNION SELECT owner_user_id, device_id, context_id FROM agro_intelligence_subscores
           UNION SELECT owner_user_id, device_id, context_id FROM agro_intelligence_trends
           UNION SELECT owner_user_id, device_id, context_id FROM agro_intelligence_benchmark
           UNION SELECT owner_user_id, device_id, context_id FROM agro_intelligence_explanations
         ), eligible AS (
           SELECT k.owner_user_id, k.device_id, k.context_id FROM source_keys k
           JOIN agro_context_segments c ON c.id = k.context_id
             AND c.owner_user_id = k.owner_user_id AND c.device_id = k.device_id
           JOIN devices d ON d.id = c.device_id JOIN users u ON u.id = d.user_id
           WHERE c.owner_user_id = COALESCE(u.owner_user_id, u.id) ${production}
             ${scoped.clauses.length ? `AND ${scoped.clauses.join(' AND ')}` : ''}
         )
         SELECT e.owner_user_id, e.device_id, e.context_id,
           COALESCE((SELECT jsonb_build_object(
             'health_score', h.health_score, 'health_band', h.health_band,
             'resilience_score', h.resilience_score, 'stress_load_score', h.stress_load_score,
             'recovery_score', h.recovery_score, 'stability_score', h.stability_score,
             'data_confidence_score', h.data_confidence_score, 'top_positive_factors', h.top_positive_factors,
             'top_negative_factors', h.top_negative_factors, 'recommended_focus', h.recommended_focus,
             'confidence', h.confidence, 'maturity_level', h.maturity_level)
             FROM agro_greenhouse_health_profile h WHERE h.owner_user_id=e.owner_user_id AND h.device_id=e.device_id AND h.context_id=e.context_id), '{}'::jsonb) health_row,
           COALESCE((SELECT jsonb_build_object(
             'knowledge_maturity', k.knowledge_maturity, 'confidence', k.confidence,
             'top_strengths', k.top_strengths, 'top_weaknesses', k.top_weaknesses,
             'recurring_risks', k.recurring_risks, 'recurring_recoveries', k.recurring_recoveries)
             FROM agro_greenhouse_knowledge k WHERE k.owner_user_id=e.owner_user_id AND k.device_id=e.device_id AND k.context_id=e.context_id), '{}'::jsonb) knowledge_row,
           COALESCE((SELECT jsonb_build_object(
             'signature_label', b.signature_label, 'recovery_behavior', b.recovery_behavior,
             'stress_behavior', b.stress_behavior, 'stability_behavior', b.stability_behavior,
             'volatility_behavior', b.volatility_behavior, 'sensor_behavior', b.sensor_behavior,
             'resilience_level', b.resilience_level, 'risk_tendency', b.risk_tendency)
             FROM agro_behavioral_signature b WHERE b.owner_user_id=e.owner_user_id AND b.device_id=e.device_id AND b.context_id=e.context_id), '{}'::jsonb) behavior_row,
           COALESCE((SELECT jsonb_build_object('intelligence_score', s.intelligence_score,
             'intelligence_band', s.intelligence_band, 'confidence', s.confidence, 'maturity_level', s.maturity_level)
             FROM agro_intelligence_score s WHERE s.owner_user_id=e.owner_user_id AND s.device_id=e.device_id AND s.context_id=e.context_id), '{}'::jsonb) score_row,
           COALESCE((SELECT jsonb_build_object(
             'stability_score', s.stability_score, 'stress_score', s.stress_score,
             'recovery_score', s.recovery_score, 'resilience_score', s.resilience_score,
             'data_quality_score', s.data_quality_score, 'maturity_score', s.maturity_score,
             'confidence', s.confidence, 'maturity_level', s.maturity_level)
             FROM agro_intelligence_subscores s WHERE s.owner_user_id=e.owner_user_id AND s.device_id=e.device_id AND s.context_id=e.context_id), '{}'::jsonb) subscore_row,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'metric', t.metric, 'trend_direction', t.trend_direction, 'trend_strength', t.trend_strength,
             'trend_confidence', t.trend_confidence, 'sample_count', t.sample_count,
             'slope_per_day', t.slope_per_day) ORDER BY t.metric)
             FROM agro_intelligence_trends t WHERE t.owner_user_id=e.owner_user_id AND t.device_id=e.device_id AND t.context_id=e.context_id), '[]'::jsonb) trend_rows,
           COALESCE((SELECT jsonb_build_object(
             'benchmark_status', b.benchmark_status, 'percentile_rank', b.percentile_rank,
             'relative_position', b.relative_position, 'cohort_average', b.cohort_average,
             'cohort_median', b.cohort_median, 'cohort_top_quartile', b.cohort_top_quartile,
             'cohort_bottom_quartile', b.cohort_bottom_quartile, 'benchmark_confidence', b.benchmark_confidence,
             'cohort_size', b.cohort_size, 'distinct_owner_count', b.distinct_owner_count,
             'crop_key', b.crop_key, 'medium', b.medium, 'cultivation_type', b.cultivation_type)
             FROM agro_intelligence_benchmark b WHERE b.owner_user_id=e.owner_user_id AND b.device_id=e.device_id AND b.context_id=e.context_id), '{}'::jsonb) benchmark_row,
           COALESCE((SELECT jsonb_build_object(
             'recommended_focus', x.recommended_focus, 'top_positive_factors', x.top_positive_factors,
             'top_negative_factors', x.top_negative_factors, 'data_limitations', x.data_limitations,
             'confidence_explanation', x.confidence_explanation)
             FROM agro_intelligence_explanations x WHERE x.owner_user_id=e.owner_user_id AND x.device_id=e.device_id AND x.context_id=e.context_id), '{}'::jsonb) explanation_row
         FROM eligible e ORDER BY e.owner_user_id, e.device_id, e.context_id`,
        scoped.params
    );
}

async function upsertWeeklyFactPackage(fact, executor = query) {
    const identity = assertWeeklyIdentity(fact, 'weekly-fact-upsert');
    await executor(
        `INSERT INTO agro_weekly_fact_packages
          (owner_user_id, device_id, context_id, week_start, week_end,
           health_summary, intelligence_score_summary, subscore_summary, trend_summary,
           benchmark_summary, positive_factors, negative_factors, recommended_focus,
           data_quality_notes, limitations, confidence, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB),
           CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB),
           CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, week_start) DO UPDATE SET
           week_end=EXCLUDED.week_end, health_summary=EXCLUDED.health_summary,
           intelligence_score_summary=EXCLUDED.intelligence_score_summary,
           subscore_summary=EXCLUDED.subscore_summary, trend_summary=EXCLUDED.trend_summary,
           benchmark_summary=EXCLUDED.benchmark_summary, positive_factors=EXCLUDED.positive_factors,
           negative_factors=EXCLUDED.negative_factors, recommended_focus=EXCLUDED.recommended_focus,
           data_quality_notes=EXCLUDED.data_quality_notes, limitations=EXCLUDED.limitations,
           confidence=EXCLUDED.confidence, evidence_json=EXCLUDED.evidence_json,
           rule_version=EXCLUDED.rule_version, updated_at=NOW()`,
        [identity.owner_user_id, identity.device_id, identity.context_id, fact.week_start, fact.week_end,
            JSON.stringify(fact.health_summary), JSON.stringify(fact.intelligence_score_summary),
            JSON.stringify(fact.subscore_summary), JSON.stringify(fact.trend_summary),
            JSON.stringify(fact.benchmark_summary), JSON.stringify(fact.positive_factors),
            JSON.stringify(fact.negative_factors), JSON.stringify(fact.recommended_focus),
            JSON.stringify(fact.data_quality_notes), JSON.stringify(fact.limitations), fact.confidence,
            JSON.stringify(fact.evidence_json), RULE_VERSION]
    );
}

async function runWeeklyFactAssembler({
    weekStart = null, referenceDate = new Date(), scope = null,
    includeNonProduction = false, dryRun = false, executor = query
} = {}) {
    const window = resolveWeekWindow({ weekStart, referenceDate });
    const inputs = await loadWeeklyInputs({ scope, includeNonProduction, executor });
    const rows = inputs.map((input) => assembleWeeklyFact(input, window));
    if (!dryRun) {
        for (const row of rows) { await upsertWeeklyFactPackage(row, executor); }
    }
    return { contexts: rows.length, stored: dryRun ? 0 : rows.length, dry_run: dryRun, ...window, rows };
}

module.exports = {
    ensureWeeklyFactSchema,
    runWeeklyFactAssembler,
    loadWeeklyInputs,
    assertWeeklySourceIdentities,
    upsertWeeklyFactPackage,
    assembleWeeklyFact,
    resolveWeekWindow,
    assertWeeklyIdentity,
    NON_PRODUCTION_USAGE,
    SOURCE_TABLES,
    RULE_VERSION
};
