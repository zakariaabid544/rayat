// Rayat Intelligence - Sprint 3.6 Greenhouse Health Profile Engine.
// Final local health profile per owner_user_id + device_id + context_id.
'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's3.6';
const NON_PRODUCTION_USAGE = Object.freeze(['demo', 'test', 'calibration', 'maintenance']);

function positiveInteger(value, fallback) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

const HP = {
    MAX_POSITIVE_FACTORS: positiveInteger(process.env.AGRO_HP_MAX_POSITIVE, 5),
    MAX_NEGATIVE_FACTORS: positiveInteger(process.env.AGRO_HP_MAX_NEGATIVE, 5),
    MAX_RECOMMENDED_FOCUS: positiveInteger(process.env.AGRO_HP_MAX_FOCUS, 5)
};

function assertHealthIdentity(identity, label = 'greenhouse-health-profile') {
    const owner = positiveInteger(identity && identity.owner_user_id, null);
    const device = positiveInteger(identity && identity.device_id, null);
    const context = positiveInteger(identity && identity.context_id, null);
    if (!owner || !device || !context) {
        throw new Error(`[${label}] unresolved owner/device/context identity`);
    }
    return { owner_user_id: owner, device_id: device, context_id: context };
}

async function constraintExists(executor, constraintName) {
    const rows = await executor(
        `SELECT 1 FROM pg_constraint
         WHERE conrelid = 'agro_greenhouse_health_profile'::regclass AND conname = ? LIMIT 1`,
        [constraintName]
    );
    return rows.length > 0;
}

async function addConstraint(executor, constraintName, definition) {
    if (!await constraintExists(executor, constraintName)) {
        await executor(`ALTER TABLE agro_greenhouse_health_profile ADD CONSTRAINT ${constraintName} ${definition}`);
    }
}

async function ensureHealthProfileSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_greenhouse_health_profile (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL,
           health_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           resilience_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           stress_load_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           recovery_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           stability_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           data_confidence_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           health_band VARCHAR(12) NOT NULL DEFAULT 'unknown',
           top_positive_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
           top_negative_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
           recommended_focus JSONB NOT NULL DEFAULT '[]'::jsonb,
           confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           maturity_level VARCHAR(12) NOT NULL DEFAULT 'cold_start',
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's3.6',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_greenhouse_health_profile UNIQUE (owner_user_id, device_id, context_id),
           CONSTRAINT agro_greenhouse_health_profile_context_fk
             FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           CONSTRAINT agro_greenhouse_health_profile_values_check CHECK (
             health_score BETWEEN 0 AND 100
             AND resilience_score BETWEEN 0 AND 100
             AND stress_load_score BETWEEN 0 AND 100
             AND recovery_score BETWEEN 0 AND 100
             AND stability_score BETWEEN 0 AND 100
             AND data_confidence_score BETWEEN 0 AND 100
             AND health_band IN ('excellent','good','attention','risk','critical','unknown')
             AND confidence BETWEEN 0 AND 1
             AND maturity_level IN ('cold_start','learning','stable','mature')
             AND jsonb_typeof(top_positive_factors) = 'array'
             AND jsonb_typeof(top_negative_factors) = 'array'
             AND jsonb_typeof(recommended_focus) = 'array'
           )
         )`
    );

    const invalid = await executor(
        `SELECT COUNT(*) AS count
         FROM agro_greenhouse_health_profile hp
         LEFT JOIN devices d ON d.id = hp.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = hp.context_id
         WHERE hp.owner_user_id IS NULL OR hp.device_id IS NULL OR hp.context_id IS NULL
            OR hp.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM hp.owner_user_id
            OR c.device_id IS DISTINCT FROM hp.device_id`
    );
    if (Number(invalid[0] && invalid[0].count) > 0) {
        throw new Error('[health-profile-schema] existing rows have invalid tenant/context identity');
    }

    await addConstraint(
        executor,
        'agro_greenhouse_health_profile_context_fk',
        'FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT'
    );
    await addConstraint(
        executor,
        'agro_greenhouse_health_profile_values_check',
        `CHECK (
          health_score BETWEEN 0 AND 100
          AND resilience_score BETWEEN 0 AND 100
          AND stress_load_score BETWEEN 0 AND 100
          AND recovery_score BETWEEN 0 AND 100
          AND stability_score BETWEEN 0 AND 100
          AND data_confidence_score BETWEEN 0 AND 100
          AND health_band IN ('excellent','good','attention','risk','critical','unknown')
          AND confidence BETWEEN 0 AND 1
          AND maturity_level IN ('cold_start','learning','stable','mature')
          AND jsonb_typeof(top_positive_factors) = 'array'
          AND jsonb_typeof(top_negative_factors) = 'array'
          AND jsonb_typeof(recommended_focus) = 'array'
        )`
    );

    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_greenhouse_health_profile_identity()
         RETURNS trigger AS $$
         DECLARE
           expected_owner INTEGER;
           context_owner INTEGER;
           context_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'greenhouse health profile identity cannot be NULL';
           END IF;
           SELECT COALESCE(u.owner_user_id, u.id)
             INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id
            WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id
             INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'greenhouse health profile owner_user_id does not own device_id';
           END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'greenhouse health profile context_id does not belong to owner/device';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`
    );
    const trigger = await executor(
        `SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'agro_greenhouse_health_profile'::regclass
           AND tgname = 'agro_greenhouse_health_profile_identity_guard' AND NOT tgisinternal`
    );
    if (!trigger.length) {
        await executor(
            `CREATE TRIGGER agro_greenhouse_health_profile_identity_guard
             BEFORE INSERT OR UPDATE ON agro_greenhouse_health_profile
             FOR EACH ROW EXECUTE FUNCTION rayat_assert_greenhouse_health_profile_identity()`
        );
    }
    await executor('CREATE INDEX IF NOT EXISTS idx_health_profile_context ON agro_greenhouse_health_profile (context_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_health_profile_device ON agro_greenhouse_health_profile (device_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_health_profile_band_score ON agro_greenhouse_health_profile (health_band, health_score)');
}

function normalizeScope(scope) {
    if (!scope) { return null; }
    const ownerUserId = scope.ownerUserId == null ? null : positiveInteger(scope.ownerUserId, null);
    const deviceId = scope.deviceId == null ? null : positiveInteger(scope.deviceId, null);
    if ((scope.ownerUserId != null && !ownerUserId) || (scope.deviceId != null && !deviceId)) {
        throw new Error('[health-profile] invalid owner/device scope');
    }
    return { ownerUserId, deviceId };
}

function maturityScore(level) {
    return { cold_start: 0.25, learning: 0.5, stable: 0.75, mature: 1 }[String(level)] || 0.25;
}

function parseRows(raw) {
    const parsed = C.parseJson(raw, []);
    return Array.isArray(parsed) ? parsed : [];
}

function healthBand(score, dataConfidence, layerCount) {
    if (layerCount < 3 || dataConfidence < 50) { return 'unknown'; }
    if (score >= 85) { return 'excellent'; }
    if (score >= 70) { return 'good'; }
    if (score >= 50) { return 'attention'; }
    if (score >= 30) { return 'risk'; }
    return 'critical';
}

function profileMaturity(layerCount, score, confidence) {
    if (layerCount < 3 || score < 0.4) { return 'cold_start'; }
    if (layerCount < 5 || score < 0.65) { return 'learning'; }
    if (score >= 0.85 && confidence >= 0.8) { return 'mature'; }
    return 'stable';
}

function sortedFactors(factors, limit) {
    const unique = new Map();
    for (const factor of factors) {
        if (!unique.has(factor.factor) || unique.get(factor.factor).score < factor.score) {
            unique.set(factor.factor, factor);
        }
    }
    return [...unique.values()]
        .sort((a, b) => b.score - a.score || a.factor.localeCompare(b.factor))
        .slice(0, limit);
}

function uniqueLimited(values, limit) {
    const result = [];
    for (const value of values) {
        if (value && !result.includes(value)) { result.push(value); }
        if (result.length >= limit) { break; }
    }
    return result;
}

function computeHealthProfile(input) {
    const knowledge = C.parseJson(input.knowledge_row, {}) || {};
    if (!Object.keys(knowledge).length) { throw new Error('[health-profile] missing consolidated knowledge'); }
    const baselines = parseRows(input.baseline_rows);
    const stresses = parseRows(input.stress_rows);
    const recoveries = parseRows(input.recovery_rows);
    const behavior = C.parseJson(input.behavioral_row, {}) || {};

    const baselineStabilities = baselines.map((row) => {
        const mean = C.num(row.mean_value);
        const stddev = C.num(row.stddev_value) || 0;
        const volatility = mean !== null && Math.abs(mean) > 0.000001
            ? Math.abs(stddev / mean)
            : (stddev === 0 ? 0 : 1);
        return C.clamp01(1 - volatility);
    });
    const baselineStability = baselineStabilities.length ? C.mean(baselineStabilities) : 0.5;

    const stressCount = stresses.reduce((sum, row) => sum + (Number(row.stress_count) || 0), 0);
    const weightedStress = (field) => stressCount > 0
        ? stresses.reduce((sum, row) => sum + (Number(row[field]) || 0) * (Number(row.stress_count) || 0), 0) / stressCount
        : 0;
    const averageStressLoad = C.clamp01(weightedStress('stress_load_score') / 100);
    const averageSeverity = C.clamp01(weightedStress('average_severity_score'));
    const averageRecurrence = C.clamp01(weightedStress('recurrence_score'));
    const stressLoadScore = 100 * C.clamp01(
        0.55 * averageStressLoad + 0.25 * averageSeverity + 0.2 * averageRecurrence
    );

    const recoveryCount = recoveries.reduce((sum, row) => sum + (Number(row.recovery_count) || 0), 0);
    const weightedRecovery = (field) => recoveryCount > 0
        ? recoveries.reduce((sum, row) => sum + (Number(row[field]) || 0) * (Number(row.recovery_count) || 0), 0) / recoveryCount
        : 0;
    const recoveryQuality = C.clamp01(weightedRecovery('recovery_quality_score'));
    const recoveryStability = C.clamp01(weightedRecovery('recovery_stability_score'));
    const relapseRate = C.clamp01(weightedRecovery('relapse_rate'));
    const fastRate = C.clamp01(weightedRecovery('fast_recovery_rate'));
    const recoveryScore = recoveryCount > 0
        ? 100 * C.clamp01(
            0.35 * recoveryQuality + 0.25 * recoveryStability
            + 0.2 * (1 - relapseRate) + 0.2 * fastRate
        )
        : 50;

    const behaviorResilience = { strong: 0.9, normal: 0.6, weak: 0.25, unknown: 0.5 }[behavior.resilience_level] || 0.5;
    const derivedResilience = recoveryCount > 0
        ? C.clamp01(
            0.35 * recoveryQuality + 0.3 * recoveryStability + 0.2 * (1 - relapseRate)
            + 0.15 * fastRate - 0.1 * (stressLoadScore / 100)
        )
        : behaviorResilience;
    const resilienceScore = 100 * C.clamp01(0.75 * derivedResilience + 0.25 * behaviorResilience);

    const behaviorStability = {
        stable: 0.9, moderately_stable: 0.65, unstable: 0.3, unknown: 0.5
    }[behavior.stability_behavior] || 0.5;
    let stability;
    if (baselines.length && recoveryCount > 0) {
        stability = 0.65 * baselineStability + 0.2 * recoveryStability + 0.15 * behaviorStability;
    } else if (baselines.length) {
        stability = 0.8 * baselineStability + 0.2 * behaviorStability;
    } else if (recoveryCount > 0) {
        stability = 0.7 * recoveryStability + 0.3 * behaviorStability;
    } else {
        stability = behaviorStability;
    }
    const stabilityScore = 100 * C.clamp01(stability);

    const layerConfidences = [];
    const maturityScores = [];
    if (knowledge.confidence !== undefined) {
        layerConfidences.push(C.clamp01(Number(knowledge.confidence) || 0));
        maturityScores.push(maturityScore(knowledge.knowledge_maturity));
    }
    if (baselines.length) {
        layerConfidences.push(C.mean(baselines.map((row) => C.clamp01(Number(row.confidence) || 0))));
        maturityScores.push(C.mean(baselines.map((row) => maturityScore(row.maturity_level))));
    }
    if (stresses.length) {
        layerConfidences.push(C.clamp01(weightedStress('confidence')));
        maturityScores.push(stresses.reduce((sum, row) => sum + maturityScore(row.maturity_level)
            * (Number(row.stress_count) || 0), 0) / Math.max(stressCount, 1));
    }
    if (recoveries.length) {
        layerConfidences.push(C.clamp01(weightedRecovery('confidence')));
        maturityScores.push(recoveries.reduce((sum, row) => sum + maturityScore(row.maturity_level)
            * (Number(row.recovery_count) || 0), 0) / Math.max(recoveryCount, 1));
    }
    if (behavior.confidence !== undefined) {
        layerConfidences.push(C.clamp01(Number(behavior.confidence) || 0));
        maturityScores.push(maturityScore(behavior.maturity_level));
    }
    const layerCount = layerConfidences.length;
    const sourceConfidence = C.mean(layerConfidences);
    const sourceMaturity = C.mean(maturityScores);
    const dataConfidenceScore = 100 * C.clamp01(
        0.65 * sourceConfidence + 0.25 * (layerCount / 5) + 0.1 * sourceMaturity
    );

    const healthScore = C.clamp01(
        0.25 * (resilienceScore / 100)
        + 0.2 * (recoveryScore / 100)
        + 0.2 * (stabilityScore / 100)
        + 0.25 * (1 - stressLoadScore / 100)
        + 0.1 * (dataConfidenceScore / 100)
    ) * 100;
    const confidence = C.clamp01(dataConfidenceScore / 100);
    const maturity = profileMaturity(layerCount, sourceMaturity, confidence);
    const band = healthBand(healthScore, dataConfidenceScore, layerCount);

    const positive = [];
    if (resilienceScore >= 60) { positive.push({ factor: 'resilience', score: C.round1(resilienceScore), source: 'recovery_behavior' }); }
    if (recoveryScore >= 60) { positive.push({ factor: 'recovery_capacity', score: C.round1(recoveryScore), source: 'recovery_memory' }); }
    if (stabilityScore >= 60) { positive.push({ factor: 'environmental_stability', score: C.round1(stabilityScore), source: 'baselines' }); }
    if (stressLoadScore <= 40) { positive.push({ factor: 'low_stress_pressure', score: C.round1(100 - stressLoadScore), source: 'stress_memory' }); }
    if (dataConfidenceScore >= 60) { positive.push({ factor: 'data_confidence', score: C.round1(dataConfidenceScore), source: 'knowledge' }); }
    for (const strength of parseRows(knowledge.top_strengths)) {
        positive.push({ factor: `knowledge_${String(strength)}`, score: 65, source: 'knowledge' });
    }

    const negative = [];
    if (stressLoadScore >= 40) { negative.push({ factor: 'stress_pressure', score: C.round1(stressLoadScore), source: 'stress_memory' }); }
    if (resilienceScore < 60) { negative.push({ factor: 'low_resilience', score: C.round1(100 - resilienceScore), source: 'recovery_behavior' }); }
    if (recoveryScore < 60) { negative.push({ factor: 'weak_recovery_capacity', score: C.round1(100 - recoveryScore), source: 'recovery_memory' }); }
    if (stabilityScore < 60) { negative.push({ factor: 'environmental_instability', score: C.round1(100 - stabilityScore), source: 'baselines' }); }
    if (dataConfidenceScore < 60) { negative.push({ factor: 'limited_data_confidence', score: C.round1(100 - dataConfidenceScore), source: 'knowledge' }); }
    for (const weakness of parseRows(knowledge.top_weaknesses)) {
        negative.push({ factor: `knowledge_${String(weakness)}`, score: 65, source: 'knowledge' });
    }

    const dominantStressMetric = behavior.dominant_stress_metric
        || (knowledge.stress_summary && knowledge.stress_summary.dominant_metric) || null;
    const focus = [];
    if (stressLoadScore >= 70) { focus.push(`reduce_${String(dominantStressMetric || 'overall')}_stress`); }
    if (behavior.sensor_behavior === 'drift_risk') { focus.push('inspect_sensor_reliability'); }
    if (recoveryScore < 50) { focus.push('improve_recovery_response'); }
    if (relapseRate >= 0.4) { focus.push('reduce_relapse_frequency'); }
    if (stabilityScore < 50) { focus.push('stabilize_environmental_variability'); }
    if (dataConfidenceScore < 60) { focus.push('increase_data_coverage'); }
    if (behavior.risk_tendency === 'high') { focus.push('address_high_risk_tendency'); }
    if (!focus.length) { focus.push('maintain_current_practices'); }

    return {
        health_score: C.round1(healthScore),
        resilience_score: C.round1(resilienceScore),
        stress_load_score: C.round1(stressLoadScore),
        recovery_score: C.round1(recoveryScore),
        stability_score: C.round1(stabilityScore),
        data_confidence_score: C.round1(dataConfidenceScore),
        health_band: band,
        top_positive_factors: sortedFactors(positive, HP.MAX_POSITIVE_FACTORS),
        top_negative_factors: sortedFactors(negative, HP.MAX_NEGATIVE_FACTORS),
        recommended_focus: uniqueLimited(focus, HP.MAX_RECOMMENDED_FOCUS),
        confidence: C.round3(confidence),
        maturity_level: maturity,
        evidence: {
            rule_version: RULE_VERSION,
            aggregation_key: ['owner_user_id', 'device_id', 'context_id'],
            score_weights: {
                health: { resilience: 0.25, recovery: 0.2, stability: 0.2, inverse_stress_load: 0.25, data_confidence: 0.1 },
                stress_load: { load: 0.55, severity: 0.25, recurrence: 0.2 },
                recovery: { quality: 0.35, stability: 0.25, no_relapse: 0.2, fast_rate: 0.2 }
            },
            source_layers: {
                knowledge: true,
                baselines: baselines.length > 0,
                stress_memory: stresses.length > 0,
                recovery_memory: recoveries.length > 0,
                behavioral_signature: Object.keys(behavior).length > 0,
                count: layerCount
            },
            source_counts: {
                baseline_metrics: baselines.length,
                stress_memories: stresses.length,
                stress_occurrences: stressCount,
                recovery_memories: recoveries.length,
                recoveries: recoveryCount
            },
            factors: {
                average_stress_load: C.round3(averageStressLoad),
                average_stress_severity: C.round3(averageSeverity),
                average_stress_recurrence: C.round3(averageRecurrence),
                recovery_quality: C.round3(recoveryQuality),
                recovery_stability: C.round3(recoveryStability),
                relapse_rate: C.round3(relapseRate),
                fast_recovery_rate: C.round3(fastRate),
                baseline_stability: C.round3(baselineStability),
                source_confidence: C.round3(sourceConfidence),
                source_maturity: C.round3(sourceMaturity)
            },
            health_band_thresholds: { excellent: 85, good: 70, attention: 50, risk: 30, critical: 0 },
            privacy: { contains_raw_evidence: false, cross_tenant_evidence: false, fleet_dependency: false }
        }
    };
}

function scopeClause(scope, alias) {
    const where = [];
    const params = [];
    if (scope && scope.deviceId) { where.push(`${alias}.device_id = ?`); params.push(scope.deviceId); }
    if (scope && scope.ownerUserId) { where.push(`${alias}.owner_user_id = ?`); params.push(scope.ownerUserId); }
    return { where, params };
}

async function assertSourceIdentities({ scope = null, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    const scoped = scopeClause(normalizedScope, 'source');
    const rows = await executor(
        `WITH source AS (
           SELECT 'knowledge' AS layer, owner_user_id, device_id, context_id FROM agro_greenhouse_knowledge
           UNION ALL SELECT 'baseline', owner_user_id, device_id, context_id FROM agro_greenhouse_baselines
           UNION ALL SELECT 'stress', owner_user_id, device_id, context_id FROM agro_stress_memory
           UNION ALL SELECT 'recovery', owner_user_id, device_id, context_id FROM agro_recovery_memory
           UNION ALL SELECT 'behavior', owner_user_id, device_id, context_id FROM agro_behavioral_signature
         )
         SELECT COUNT(*)::integer AS invalid_count
         FROM source
         LEFT JOIN devices d ON d.id = source.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = source.context_id
         WHERE ${scoped.where.length ? `${scoped.where.join(' AND ')} AND` : ''} (
           source.owner_user_id IS NULL OR source.device_id IS NULL OR source.context_id IS NULL
           OR source.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
           OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM source.owner_user_id
           OR c.device_id IS DISTINCT FROM source.device_id
         )`,
        scoped.params
    );
    const invalidCount = Number(rows[0] && rows[0].invalid_count) || 0;
    if (invalidCount > 0) {
        throw new Error(`[health-profile] fail-closed: ${invalidCount} source rows have invalid tenant/context identity`);
    }
}

async function loadHealthInputs({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    await assertSourceIdentities({ scope: normalizedScope, executor });
    const scoped = scopeClause(normalizedScope, 'c');
    const productionClause = includeNonProduction
        ? ''
        : `AND c.is_production = TRUE
           AND lower(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')`;
    return executor(
        `WITH eligible_knowledge AS (
           SELECT k.* FROM agro_greenhouse_knowledge k
           JOIN agro_context_segments c ON c.id = k.context_id
             AND c.owner_user_id = k.owner_user_id AND c.device_id = k.device_id
           JOIN devices d ON d.id = c.device_id
           JOIN users u ON u.id = d.user_id
           WHERE c.owner_user_id = COALESCE(u.owner_user_id, u.id)
             ${productionClause}
             ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}
         )
         SELECT k.owner_user_id, k.device_id, k.context_id,
                jsonb_build_object(
                  'baseline_summary', k.baseline_summary, 'stress_summary', k.stress_summary,
                  'recovery_summary', k.recovery_summary, 'behavioral_signature', k.behavioral_signature,
                  'top_strengths', k.top_strengths, 'top_weaknesses', k.top_weaknesses,
                  'recurring_risks', k.recurring_risks, 'recurring_recoveries', k.recurring_recoveries,
                  'knowledge_maturity', k.knowledge_maturity, 'confidence', k.confidence
                ) AS knowledge_row,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'metric', b.metric, 'mean_value', b.mean_value, 'stddev_value', b.stddev_value,
                    'confidence', b.confidence, 'maturity_level', b.maturity_level
                  ) ORDER BY b.metric)
                  FROM agro_greenhouse_baselines b
                  WHERE b.owner_user_id = k.owner_user_id AND b.device_id = k.device_id AND b.context_id = k.context_id
                ), '[]'::jsonb) AS baseline_rows,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'metric', sm.metric, 'stress_type', sm.stress_type, 'stress_count', sm.stress_count,
                    'average_severity_score', sm.average_severity_score,
                    'recurrence_score', sm.recurrence_score, 'stress_load_score', sm.stress_load_score,
                    'confidence', sm.confidence, 'maturity_level', sm.maturity_level
                  ) ORDER BY sm.metric, sm.stress_type)
                  FROM agro_stress_memory sm
                  WHERE sm.owner_user_id = k.owner_user_id AND sm.device_id = k.device_id AND sm.context_id = k.context_id
                ), '[]'::jsonb) AS stress_rows,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'metric', rm.metric, 'recovery_count', rm.recovery_count,
                    'recovery_quality_score', rm.recovery_quality_score,
                    'recovery_stability_score', rm.recovery_stability_score,
                    'relapse_rate', rm.relapse_rate, 'fast_recovery_rate', rm.fast_recovery_rate,
                    'confidence', rm.confidence, 'maturity_level', rm.maturity_level
                  ) ORDER BY rm.metric)
                  FROM agro_recovery_memory rm
                  WHERE rm.owner_user_id = k.owner_user_id AND rm.device_id = k.device_id AND rm.context_id = k.context_id
                ), '[]'::jsonb) AS recovery_rows,
                COALESCE((
                  SELECT jsonb_build_object(
                    'signature_label', bs.signature_label, 'stability_behavior', bs.stability_behavior,
                    'sensor_behavior', bs.sensor_behavior, 'dominant_stress_metric', bs.dominant_stress_metric,
                    'resilience_level', bs.resilience_level, 'risk_tendency', bs.risk_tendency,
                    'confidence', bs.confidence, 'maturity_level', bs.maturity_level
                  ) FROM agro_behavioral_signature bs
                  WHERE bs.owner_user_id = k.owner_user_id AND bs.device_id = k.device_id AND bs.context_id = k.context_id
                  LIMIT 1
                ), '{}'::jsonb) AS behavioral_row
         FROM eligible_knowledge k
         ORDER BY k.owner_user_id, k.device_id, k.context_id`,
        scoped.params
    );
}

async function upsertHealthProfile(input, profile, executor = query) {
    const identity = assertHealthIdentity(input, 'health-profile-upsert');
    await executor(
        `INSERT INTO agro_greenhouse_health_profile
            (owner_user_id, device_id, context_id, health_score, resilience_score,
             stress_load_score, recovery_score, stability_score, data_confidence_score,
             health_band, top_positive_factors, top_negative_factors, recommended_focus,
             confidence, maturity_level, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB),
                 CAST(? AS JSONB), ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id) DO UPDATE SET
             health_score=EXCLUDED.health_score, resilience_score=EXCLUDED.resilience_score,
             stress_load_score=EXCLUDED.stress_load_score, recovery_score=EXCLUDED.recovery_score,
             stability_score=EXCLUDED.stability_score,
             data_confidence_score=EXCLUDED.data_confidence_score,
             health_band=EXCLUDED.health_band,
             top_positive_factors=EXCLUDED.top_positive_factors,
             top_negative_factors=EXCLUDED.top_negative_factors,
             recommended_focus=EXCLUDED.recommended_focus,
             confidence=EXCLUDED.confidence, maturity_level=EXCLUDED.maturity_level,
             evidence_json=EXCLUDED.evidence_json, rule_version=EXCLUDED.rule_version,
             updated_at=NOW()
         RETURNING id`,
        [
            identity.owner_user_id, identity.device_id, identity.context_id,
            profile.health_score, profile.resilience_score, profile.stress_load_score,
            profile.recovery_score, profile.stability_score, profile.data_confidence_score,
            profile.health_band, JSON.stringify(profile.top_positive_factors),
            JSON.stringify(profile.top_negative_factors), JSON.stringify(profile.recommended_focus),
            profile.confidence, profile.maturity_level, JSON.stringify(profile.evidence), RULE_VERSION
        ]
    );
}

async function deleteStaleHealthProfiles({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    const scoped = scopeClause(normalizedScope, 'hp');
    const productionClause = includeNonProduction
        ? ''
        : `AND c.is_production = TRUE
           AND lower(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')`;
    const rows = await executor(
        `WITH removed AS (
           DELETE FROM agro_greenhouse_health_profile hp
           WHERE ${scoped.where.length ? `${scoped.where.join(' AND ')} AND` : ''} NOT EXISTS (
             SELECT 1 FROM agro_greenhouse_knowledge k
             JOIN agro_context_segments c ON c.id = k.context_id
             JOIN devices d ON d.id = c.device_id
             JOIN users u ON u.id = d.user_id
             WHERE k.owner_user_id = hp.owner_user_id AND k.device_id = hp.device_id
               AND k.context_id = hp.context_id
               AND c.owner_user_id = k.owner_user_id AND c.device_id = k.device_id
               AND c.owner_user_id = COALESCE(u.owner_user_id, u.id)
               ${productionClause}
           )
           RETURNING 1
         )
         SELECT COUNT(*)::integer AS removed FROM removed`,
        scoped.params
    );
    return Number(rows[0] && rows[0].removed) || 0;
}

async function runHealthProfileCycle({
    scope = null, includeNonProduction = false, dryRun = false, executor = query
} = {}) {
    const inputs = await loadHealthInputs({ scope, includeNonProduction, executor });
    const summary = {
        contexts: inputs.length,
        stored: 0,
        by_band: { excellent: 0, good: 0, attention: 0, risk: 0, critical: 0, unknown: 0 },
        by_maturity: { cold_start: 0, learning: 0, stable: 0, mature: 0 },
        dry_run: dryRun
    };
    const rows = [];
    for (const input of inputs) {
        const identity = assertHealthIdentity(input, 'health-profile-input');
        const profile = computeHealthProfile(input);
        summary.by_band[profile.health_band] += 1;
        summary.by_maturity[profile.maturity_level] += 1;
        rows.push({ key: identity, ...profile });
        if (!dryRun) { await upsertHealthProfile(input, profile, executor); }
        summary.stored += 1;
    }
    summary.removed_stale = dryRun
        ? 0
        : await deleteStaleHealthProfiles({ scope, includeNonProduction, executor });
    return dryRun ? { ...summary, rows } : summary;
}

module.exports = {
    ensureHealthProfileSchema,
    runHealthProfileCycle,
    loadHealthInputs,
    upsertHealthProfile,
    deleteStaleHealthProfiles,
    computeHealthProfile,
    healthBand,
    profileMaturity,
    assertHealthIdentity,
    NON_PRODUCTION_USAGE,
    HP,
    RULE_VERSION
};
