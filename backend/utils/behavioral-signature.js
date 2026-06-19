// Rayat Intelligence - Sprint 3.4 Behavioral Signature Engine.
// Persistent local profile per owner_user_id + device_id + context_id.
'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's3.4';
const NON_PRODUCTION_USAGE = Object.freeze(['demo', 'test', 'calibration', 'maintenance']);

const LABELS = Object.freeze({
    recovery: ['fast_recovery', 'normal_recovery', 'slow_recovery', 'fragile_recovery', 'unknown'],
    stress: ['low_stress', 'moderate_stress', 'high_stress', 'recurring_stress', 'unknown'],
    stability: ['stable', 'moderately_stable', 'unstable', 'unknown'],
    volatility: ['low_volatility', 'moderate_volatility', 'high_volatility', 'unknown'],
    sensor: ['reliable', 'attention_needed', 'drift_risk', 'unknown'],
    resilience: ['strong', 'normal', 'weak', 'unknown'],
    risk: ['low', 'medium', 'high', 'unknown'],
    maturity: ['cold_start', 'learning', 'stable', 'mature']
});

function positiveInteger(value, fallback) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

const BS = {
    CONF_VOLUME_REF: positiveInteger(process.env.AGRO_BS_CONF_VOLUME_REF, 50)
};

function assertBehaviorIdentity(identity, label = 'behavioral-signature') {
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
         WHERE conrelid = 'agro_behavioral_signature'::regclass AND conname = ? LIMIT 1`,
        [constraintName]
    );
    return rows.length > 0;
}

async function addConstraint(executor, constraintName, definition) {
    if (!await constraintExists(executor, constraintName)) {
        await executor(`ALTER TABLE agro_behavioral_signature ADD CONSTRAINT ${constraintName} ${definition}`);
    }
}

async function ensureBehavioralSignatureSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_behavioral_signature (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL,
           signature_label VARCHAR(120) NOT NULL,
           recovery_behavior VARCHAR(24) NOT NULL DEFAULT 'unknown',
           stress_behavior VARCHAR(24) NOT NULL DEFAULT 'unknown',
           stability_behavior VARCHAR(24) NOT NULL DEFAULT 'unknown',
           volatility_behavior VARCHAR(24) NOT NULL DEFAULT 'unknown',
           sensor_behavior VARCHAR(24) NOT NULL DEFAULT 'unknown',
           dominant_stress_metric VARCHAR(80) NULL,
           dominant_recovery_metric VARCHAR(80) NULL,
           resilience_level VARCHAR(12) NOT NULL DEFAULT 'unknown',
           risk_tendency VARCHAR(12) NOT NULL DEFAULT 'unknown',
           confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           maturity_level VARCHAR(12) NOT NULL DEFAULT 'cold_start',
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's3.4',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_behavioral_signature UNIQUE (owner_user_id, device_id, context_id),
           CONSTRAINT agro_behavioral_signature_context_fk
             FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           CONSTRAINT agro_behavioral_signature_values_check CHECK (
             btrim(signature_label) <> ''
             AND recovery_behavior IN ('fast_recovery','normal_recovery','slow_recovery','fragile_recovery','unknown')
             AND stress_behavior IN ('low_stress','moderate_stress','high_stress','recurring_stress','unknown')
             AND stability_behavior IN ('stable','moderately_stable','unstable','unknown')
             AND volatility_behavior IN ('low_volatility','moderate_volatility','high_volatility','unknown')
             AND sensor_behavior IN ('reliable','attention_needed','drift_risk','unknown')
             AND resilience_level IN ('strong','normal','weak','unknown')
             AND risk_tendency IN ('low','medium','high','unknown')
             AND confidence BETWEEN 0 AND 1
             AND maturity_level IN ('cold_start','learning','stable','mature')
           )
         )`
    );

    const invalid = await executor(
        `SELECT COUNT(*) AS count
         FROM agro_behavioral_signature bs
         LEFT JOIN devices d ON d.id = bs.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = bs.context_id
         WHERE bs.owner_user_id IS NULL OR bs.device_id IS NULL OR bs.context_id IS NULL
            OR bs.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM bs.owner_user_id
            OR c.device_id IS DISTINCT FROM bs.device_id`
    );
    if (Number(invalid[0] && invalid[0].count) > 0) {
        throw new Error('[behavioral-signature-schema] existing rows have invalid tenant/context identity');
    }

    await addConstraint(
        executor,
        'agro_behavioral_signature_context_fk',
        'FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT'
    );
    await addConstraint(
        executor,
        'agro_behavioral_signature_values_check',
        `CHECK (
          btrim(signature_label) <> ''
          AND recovery_behavior IN ('fast_recovery','normal_recovery','slow_recovery','fragile_recovery','unknown')
          AND stress_behavior IN ('low_stress','moderate_stress','high_stress','recurring_stress','unknown')
          AND stability_behavior IN ('stable','moderately_stable','unstable','unknown')
          AND volatility_behavior IN ('low_volatility','moderate_volatility','high_volatility','unknown')
          AND sensor_behavior IN ('reliable','attention_needed','drift_risk','unknown')
          AND resilience_level IN ('strong','normal','weak','unknown')
          AND risk_tendency IN ('low','medium','high','unknown')
          AND confidence BETWEEN 0 AND 1
          AND maturity_level IN ('cold_start','learning','stable','mature')
        )`
    );

    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_behavioral_signature_identity()
         RETURNS trigger AS $$
         DECLARE
           expected_owner INTEGER;
           context_owner INTEGER;
           context_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'behavioral signature identity cannot be NULL';
           END IF;
           SELECT COALESCE(u.owner_user_id, u.id)
             INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id
            WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id
             INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'behavioral signature owner_user_id does not own device_id';
           END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'behavioral signature context_id does not belong to owner/device';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`
    );
    const trigger = await executor(
        `SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'agro_behavioral_signature'::regclass
           AND tgname = 'agro_behavioral_signature_identity_guard' AND NOT tgisinternal`
    );
    if (!trigger.length) {
        await executor(
            `CREATE TRIGGER agro_behavioral_signature_identity_guard
             BEFORE INSERT OR UPDATE ON agro_behavioral_signature
             FOR EACH ROW EXECUTE FUNCTION rayat_assert_behavioral_signature_identity()`
        );
    }
    await executor('CREATE INDEX IF NOT EXISTS idx_behavior_signature_context ON agro_behavioral_signature (context_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_behavior_signature_device ON agro_behavioral_signature (device_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_behavior_signature_risk ON agro_behavioral_signature (risk_tendency, resilience_level)');
}

function normalizeScope(scope) {
    if (!scope) { return null; }
    const ownerUserId = scope.ownerUserId == null ? null : positiveInteger(scope.ownerUserId, null);
    const deviceId = scope.deviceId == null ? null : positiveInteger(scope.deviceId, null);
    if ((scope.ownerUserId != null && !ownerUserId) || (scope.deviceId != null && !deviceId)) {
        throw new Error('[behavioral-signature] invalid owner/device scope');
    }
    return { ownerUserId, deviceId };
}

function metricToken(metric) {
    const token = String(metric || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return token || 'context';
}

function maturityLevel(layerCount, maturityScore, confidence) {
    if (layerCount < 2 || maturityScore < 0.4) { return 'cold_start'; }
    if (layerCount < 3 || maturityScore < 0.65) { return 'learning'; }
    if (maturityScore >= 0.85 && confidence >= 0.75) { return 'mature'; }
    return 'stable';
}

function computeBehavioralSignature(input) {
    const baselineMetrics = Math.max(0, Number(input.baseline_metric_count) || 0);
    const baselineSamples = Math.max(0, Number(input.baseline_sample_count) || 0);
    const baselineConfidence = C.clamp01(Number(input.baseline_confidence) || 0);
    const baselineStability = C.clamp01(Number(input.baseline_stability) || 0);
    const baselineVolatility = Math.max(0, Number(input.baseline_volatility) || 0);
    const baselineMaturity = C.clamp01(Number(input.baseline_maturity_score) || 0);

    const stressMetrics = Math.max(0, Number(input.stress_metric_count) || 0);
    const stressCount = Math.max(0, Number(input.stress_count) || 0);
    const stressConfidence = C.clamp01(Number(input.stress_confidence) || 0);
    const stressSeverity = C.clamp01(Number(input.stress_severity) || 0);
    const stressRecurrence = C.clamp01(Number(input.stress_recurrence) || 0);
    const stressLoad = C.clamp01((Number(input.stress_load) || 0) / 100);
    const anomalyCount = Math.max(0, Number(input.anomaly_count) || 0);
    const sensorDriftCount = Math.max(0, Number(input.sensor_drift_count) || 0);
    const stressMaturity = C.clamp01(Number(input.stress_maturity_score) || 0);

    const recoveryMetrics = Math.max(0, Number(input.recovery_metric_count) || 0);
    const recoveryCount = Math.max(0, Number(input.recovery_count) || 0);
    const recoveryConfidence = C.clamp01(Number(input.recovery_confidence) || 0);
    const recoveryQuality = C.clamp01(Number(input.recovery_quality) || 0);
    const recoveryStability = C.clamp01(Number(input.recovery_stability) || 0);
    const relapseRate = C.clamp01(Number(input.relapse_rate) || 0);
    const fastRecoveryRate = C.clamp01(Number(input.fast_recovery_rate) || 0);
    const slowRecoveryRate = C.clamp01(Number(input.slow_recovery_rate) || 0);
    const recoveryMaturity = C.clamp01(Number(input.recovery_maturity_score) || 0);

    let stressSpanDays = 1;
    const stressFirstMs = input.stress_first_seen ? new Date(input.stress_first_seen).getTime() : NaN;
    const stressLastMs = input.stress_last_seen ? new Date(input.stress_last_seen).getTime() : NaN;
    if (Number.isFinite(stressFirstMs) && Number.isFinite(stressLastMs)) {
        stressSpanDays = Math.max(1, C.daysBetween(stressLastMs, stressFirstMs));
    }
    const stressRatePerDay = stressCount / stressSpanDays;

    let recoveryBehavior = 'unknown';
    if (recoveryCount > 0) {
        if (recoveryStability < 0.45 || relapseRate >= 0.4 || recoveryQuality < 0.4) {
            recoveryBehavior = 'fragile_recovery';
        } else if (fastRecoveryRate >= 0.6 && recoveryQuality >= 0.6) {
            recoveryBehavior = 'fast_recovery';
        } else if (slowRecoveryRate >= 0.6) {
            recoveryBehavior = 'slow_recovery';
        } else {
            recoveryBehavior = 'normal_recovery';
        }
    }

    let stressBehavior = 'unknown';
    if (stressCount > 0) {
        if (stressLoad >= 0.7 || stressSeverity >= 0.75) {
            stressBehavior = 'high_stress';
        } else if (stressRecurrence >= 0.65 || (stressCount >= 4 && stressRatePerDay >= 1)) {
            stressBehavior = 'recurring_stress';
        } else if (stressLoad >= 0.35 || stressSeverity >= 0.45 || stressCount >= 3) {
            stressBehavior = 'moderate_stress';
        } else {
            stressBehavior = 'low_stress';
        }
    }

    const combinedStability = baselineMetrics > 0
        ? C.clamp01(recoveryCount > 0 ? 0.7 * baselineStability + 0.3 * recoveryStability : baselineStability)
        : (recoveryCount > 0 ? recoveryStability : 0);
    let stabilityBehavior = 'unknown';
    if (baselineMetrics > 0 || recoveryCount > 0) {
        stabilityBehavior = combinedStability >= 0.75
            ? 'stable'
            : (combinedStability >= 0.5 ? 'moderately_stable' : 'unstable');
    }

    let volatilityBehavior = 'unknown';
    if (baselineMetrics > 0) {
        volatilityBehavior = baselineVolatility <= 0.1
            ? 'low_volatility'
            : (baselineVolatility <= 0.3 ? 'moderate_volatility' : 'high_volatility');
    }

    const anomalyShare = stressCount > 0 ? anomalyCount / stressCount : 0;
    const driftShare = stressCount > 0 ? sensorDriftCount / stressCount : 0;
    let sensorBehavior = 'unknown';
    if (stressCount > 0) {
        if (sensorDriftCount >= 3 || driftShare >= 0.15) {
            sensorBehavior = 'drift_risk';
        } else if (sensorDriftCount > 0 || anomalyShare >= 0.2) {
            sensorBehavior = 'attention_needed';
        } else {
            sensorBehavior = 'reliable';
        }
    }

    let resilienceScore = null;
    let resilienceLevel = 'unknown';
    if (recoveryCount > 0) {
        resilienceScore = C.clamp01(
            0.35 * recoveryQuality + 0.3 * recoveryStability + 0.2 * (1 - relapseRate)
            + 0.15 * fastRecoveryRate - 0.15 * stressLoad
        );
        resilienceLevel = resilienceScore >= 0.7 ? 'strong' : (resilienceScore < 0.45 ? 'weak' : 'normal');
    }

    const layerConfidences = [];
    const maturityScores = [];
    if (baselineMetrics > 0) { layerConfidences.push(baselineConfidence); maturityScores.push(baselineMaturity); }
    if (stressMetrics > 0) { layerConfidences.push(stressConfidence); maturityScores.push(stressMaturity); }
    if (recoveryMetrics > 0) { layerConfidences.push(recoveryConfidence); maturityScores.push(recoveryMaturity); }
    const layerCount = layerConfidences.length;
    if (layerCount === 0) { throw new Error('[behavioral-signature] no source intelligence layers'); }
    const sourceConfidence = C.mean(layerConfidences);
    const maturityScore = C.mean(maturityScores);
    const volume = baselineMetrics + stressCount + recoveryCount;
    const confidence = C.clamp01(
        0.5 * sourceConfidence + 0.3 * (layerCount / 3) + 0.1
        + 0.1 * C.normLog(volume, BS.CONF_VOLUME_REF)
    );
    const maturity = maturityLevel(layerCount, maturityScore, confidence);

    let riskScore = null;
    let riskTendency = 'unknown';
    if (baselineMetrics > 0 || stressCount > 0) {
        const stressRisk = stressCount > 0
            ? C.clamp01(0.5 * stressLoad + 0.3 * stressSeverity + 0.2 * stressRecurrence)
            : 0.25;
        const volatilityRisk = baselineMetrics > 0 ? C.clamp01(baselineVolatility / 0.5) : 0.5;
        const sensorRisk = { reliable: 0.1, attention_needed: 0.6, drift_risk: 1, unknown: 0.5 }[sensorBehavior];
        const resilienceRisk = { strong: 0.1, normal: 0.4, weak: 1, unknown: 0.5 }[resilienceLevel];
        riskScore = C.clamp01(
            0.35 * stressRisk + 0.2 * volatilityRisk + 0.15 * sensorRisk
            + 0.2 * resilienceRisk + 0.1 * (1 - maturityScore)
        );
        riskTendency = riskScore >= 0.65 ? 'high' : (riskScore >= 0.35 ? 'medium' : 'low');
    }

    const dominantStressMetric = input.dominant_stress_metric || null;
    const dominantRecoveryMetric = input.dominant_recovery_metric || null;
    let signatureLabel = 'developing_behavioral_profile';
    if (riskTendency === 'high') {
        signatureLabel = 'high_risk_tendency';
    } else if (sensorBehavior === 'drift_risk') {
        signatureLabel = 'sensor_reliability_risk';
    } else if (resilienceLevel === 'strong' && recoveryBehavior === 'fast_recovery') {
        signatureLabel = 'strong_fast_recovery';
    } else if (stressBehavior === 'high_stress') {
        signatureLabel = `high_${metricToken(dominantStressMetric)}_stress_tendency`;
    } else if (stressBehavior === 'recurring_stress') {
        signatureLabel = `recurring_${metricToken(dominantStressMetric)}_stress`;
    } else if (volatilityBehavior === 'high_volatility') {
        signatureLabel = `volatile_${metricToken(dominantStressMetric)}_behavior`;
    } else if (stabilityBehavior === 'stable' && riskTendency === 'low') {
        signatureLabel = 'stable_low_risk_context';
    }

    return {
        signature_label: signatureLabel,
        recovery_behavior: recoveryBehavior,
        stress_behavior: stressBehavior,
        stability_behavior: stabilityBehavior,
        volatility_behavior: volatilityBehavior,
        sensor_behavior: sensorBehavior,
        dominant_stress_metric: dominantStressMetric,
        dominant_recovery_metric: dominantRecoveryMetric,
        resilience_level: resilienceLevel,
        risk_tendency: riskTendency,
        confidence: C.round3(confidence),
        maturity_level: maturity,
        evidence: {
            rule_version: RULE_VERSION,
            aggregation_key: ['owner_user_id', 'device_id', 'context_id'],
            source_layers: {
                baseline: baselineMetrics > 0,
                stress_memory: stressMetrics > 0,
                recovery_memory: recoveryMetrics > 0,
                count: layerCount
            },
            baseline: {
                metric_count: baselineMetrics,
                sample_count: baselineSamples,
                stability_score: C.round3(baselineStability),
                volatility_score: C.round3(baselineVolatility),
                confidence: C.round3(baselineConfidence),
                maturity_score: C.round3(baselineMaturity)
            },
            stress: {
                metric_count: stressMetrics,
                event_count: stressCount,
                severity_score: C.round3(stressSeverity),
                recurrence_score: C.round3(stressRecurrence),
                load_score: C.round1(stressLoad * 100),
                events_per_day: C.round3(stressRatePerDay),
                anomaly_count: anomalyCount,
                sensor_drift_count: sensorDriftCount,
                confidence: C.round3(stressConfidence),
                maturity_score: C.round3(stressMaturity)
            },
            recovery: {
                metric_count: recoveryMetrics,
                recovery_count: recoveryCount,
                quality_score: C.round3(recoveryQuality),
                stability_score: C.round3(recoveryStability),
                relapse_rate: C.round3(relapseRate),
                fast_rate: C.round3(fastRecoveryRate),
                slow_rate: C.round3(slowRecoveryRate),
                confidence: C.round3(recoveryConfidence),
                maturity_score: C.round3(recoveryMaturity)
            },
            derived_scores: {
                combined_stability: C.round3(combinedStability),
                resilience: resilienceScore === null ? null : C.round3(resilienceScore),
                risk: riskScore === null ? null : C.round3(riskScore),
                source_confidence: C.round3(sourceConfidence),
                source_maturity: C.round3(maturityScore)
            },
            classifications: {
                recovery_behavior: recoveryBehavior,
                stress_behavior: stressBehavior,
                stability_behavior: stabilityBehavior,
                volatility_behavior: volatilityBehavior,
                sensor_behavior: sensorBehavior,
                resilience_level: resilienceLevel,
                risk_tendency: riskTendency
            },
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
           SELECT 'baseline' AS layer, owner_user_id, device_id, context_id FROM agro_greenhouse_baselines
           UNION ALL
           SELECT 'stress', owner_user_id, device_id, context_id FROM agro_stress_memory
           UNION ALL
           SELECT 'recovery', owner_user_id, device_id, context_id FROM agro_recovery_memory
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
        throw new Error(`[behavioral-signature] fail-closed: ${invalidCount} source rows have invalid tenant/context identity`);
    }
}

async function loadBehavioralInputs({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    await assertSourceIdentities({ scope: normalizedScope, executor });
    const scoped = scopeClause(normalizedScope, 'c');
    const productionClause = includeNonProduction
        ? ''
        : `AND c.is_production = TRUE
           AND lower(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')`;
    return executor(
        `WITH eligible_contexts AS (
           SELECT c.id AS context_id, c.owner_user_id, c.device_id
           FROM agro_context_segments c
           JOIN devices d ON d.id = c.device_id
           JOIN users u ON u.id = d.user_id
           WHERE c.owner_user_id = COALESCE(u.owner_user_id, u.id)
             ${productionClause}
             ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}
         ),
         baseline_source AS (
           SELECT b.* FROM agro_greenhouse_baselines b
           JOIN eligible_contexts c USING (owner_user_id, device_id, context_id)
         ),
         baseline_agg AS (
           SELECT owner_user_id, device_id, context_id,
                  COUNT(DISTINCT metric)::integer AS metric_count,
                  COALESCE(SUM(sample_count), 0)::integer AS sample_count,
                  AVG(confidence)::float8 AS confidence,
                  AVG(CASE maturity_level WHEN 'mature' THEN 1.0 WHEN 'stable' THEN 0.75
                      WHEN 'learning' THEN 0.5 ELSE 0.25 END)::float8 AS maturity_score,
                  AVG(GREATEST(0, LEAST(1, 1 - CASE
                    WHEN ABS(COALESCE(mean_value, 0)) > 0.000001
                      THEN ABS(COALESCE(stddev_value, 0) / mean_value)
                    WHEN COALESCE(stddev_value, 0) = 0 THEN 0 ELSE 1 END)))::float8 AS stability,
                  AVG(CASE
                    WHEN ABS(COALESCE(mean_value, 0)) > 0.000001
                      THEN ABS(COALESCE(stddev_value, 0) / mean_value)
                    WHEN COALESCE(stddev_value, 0) = 0 THEN 0 ELSE 1 END)::float8 AS volatility
           FROM baseline_source GROUP BY owner_user_id, device_id, context_id
         ),
         stress_source AS (
           SELECT sm.* FROM agro_stress_memory sm
           JOIN eligible_contexts c USING (owner_user_id, device_id, context_id)
         ),
         stress_metric AS (
           SELECT owner_user_id, device_id, context_id, metric, SUM(stress_count)::integer AS events
           FROM stress_source GROUP BY owner_user_id, device_id, context_id, metric
         ),
         stress_ranked AS (
           SELECT stress_metric.*,
                  ROW_NUMBER() OVER (PARTITION BY owner_user_id, device_id, context_id ORDER BY events DESC, metric) AS rank
           FROM stress_metric
         ),
         stress_agg AS (
           SELECT owner_user_id, device_id, context_id,
                  COUNT(*)::integer AS metric_count,
                  SUM(stress_count)::integer AS stress_count,
                  SUM(confidence * stress_count) / NULLIF(SUM(stress_count), 0) AS confidence,
                  SUM(average_severity_score * stress_count) / NULLIF(SUM(stress_count), 0) AS severity,
                  SUM(recurrence_score * stress_count) / NULLIF(SUM(stress_count), 0) AS recurrence,
                  SUM(stress_load_score * stress_count) / NULLIF(SUM(stress_count), 0) AS load,
                  SUM(stress_count) FILTER (WHERE stress_type = 'anomaly')::integer AS anomaly_count,
                  SUM(stress_count) FILTER (WHERE stress_type = 'sensor_drift')::integer AS sensor_drift_count,
                  SUM((CASE maturity_level WHEN 'mature' THEN 1.0 WHEN 'stable' THEN 0.75
                      WHEN 'learning' THEN 0.5 ELSE 0.25 END) * stress_count)
                      / NULLIF(SUM(stress_count), 0) AS maturity_score,
                  MIN(first_seen_at) AS first_seen, MAX(last_seen_at) AS last_seen
           FROM stress_source GROUP BY owner_user_id, device_id, context_id
         ),
         recovery_source AS (
           SELECT rm.* FROM agro_recovery_memory rm
           JOIN eligible_contexts c USING (owner_user_id, device_id, context_id)
         ),
         recovery_metric AS (
           SELECT owner_user_id, device_id, context_id, metric, SUM(recovery_count)::integer AS events
           FROM recovery_source GROUP BY owner_user_id, device_id, context_id, metric
         ),
         recovery_ranked AS (
           SELECT recovery_metric.*,
                  ROW_NUMBER() OVER (PARTITION BY owner_user_id, device_id, context_id ORDER BY events DESC, metric) AS rank
           FROM recovery_metric
         ),
         recovery_agg AS (
           SELECT owner_user_id, device_id, context_id,
                  COUNT(*)::integer AS metric_count,
                  SUM(recovery_count)::integer AS recovery_count,
                  SUM(confidence * recovery_count) / NULLIF(SUM(recovery_count), 0) AS confidence,
                  SUM(recovery_quality_score * recovery_count) / NULLIF(SUM(recovery_count), 0) AS quality,
                  SUM(recovery_stability_score * recovery_count) / NULLIF(SUM(recovery_count), 0) AS stability,
                  SUM(relapse_rate * recovery_count) / NULLIF(SUM(recovery_count), 0) AS relapse_rate,
                  SUM(fast_recovery_rate * recovery_count) / NULLIF(SUM(recovery_count), 0) AS fast_rate,
                  SUM(slow_recovery_rate * recovery_count) / NULLIF(SUM(recovery_count), 0) AS slow_rate,
                  SUM((CASE maturity_level WHEN 'mature' THEN 1.0 WHEN 'stable' THEN 0.75
                      WHEN 'learning' THEN 0.5 ELSE 0.25 END) * recovery_count)
                      / NULLIF(SUM(recovery_count), 0) AS maturity_score
           FROM recovery_source GROUP BY owner_user_id, device_id, context_id
         ),
         keys AS (
           SELECT owner_user_id, device_id, context_id FROM baseline_source
           UNION SELECT owner_user_id, device_id, context_id FROM stress_source
           UNION SELECT owner_user_id, device_id, context_id FROM recovery_source
         )
         SELECT k.owner_user_id, k.device_id, k.context_id,
                COALESCE(b.metric_count, 0) AS baseline_metric_count,
                COALESCE(b.sample_count, 0) AS baseline_sample_count,
                b.confidence AS baseline_confidence, b.stability AS baseline_stability,
                b.volatility AS baseline_volatility, b.maturity_score AS baseline_maturity_score,
                COALESCE(s.metric_count, 0) AS stress_metric_count,
                COALESCE(s.stress_count, 0) AS stress_count,
                s.confidence AS stress_confidence, s.severity AS stress_severity,
                s.recurrence AS stress_recurrence, s.load AS stress_load,
                COALESCE(s.anomaly_count, 0) AS anomaly_count,
                COALESCE(s.sensor_drift_count, 0) AS sensor_drift_count,
                s.maturity_score AS stress_maturity_score,
                s.first_seen AS stress_first_seen, s.last_seen AS stress_last_seen,
                sd.metric AS dominant_stress_metric,
                COALESCE(r.metric_count, 0) AS recovery_metric_count,
                COALESCE(r.recovery_count, 0) AS recovery_count,
                r.confidence AS recovery_confidence, r.quality AS recovery_quality,
                r.stability AS recovery_stability, r.relapse_rate,
                r.fast_rate AS fast_recovery_rate, r.slow_rate AS slow_recovery_rate,
                r.maturity_score AS recovery_maturity_score,
                rd.metric AS dominant_recovery_metric
         FROM keys k
         LEFT JOIN baseline_agg b USING (owner_user_id, device_id, context_id)
         LEFT JOIN stress_agg s USING (owner_user_id, device_id, context_id)
         LEFT JOIN recovery_agg r USING (owner_user_id, device_id, context_id)
         LEFT JOIN stress_ranked sd ON sd.owner_user_id = k.owner_user_id AND sd.device_id = k.device_id
              AND sd.context_id = k.context_id AND sd.rank = 1
         LEFT JOIN recovery_ranked rd ON rd.owner_user_id = k.owner_user_id AND rd.device_id = k.device_id
              AND rd.context_id = k.context_id AND rd.rank = 1
         ORDER BY k.owner_user_id, k.device_id, k.context_id`,
        scoped.params
    );
}

async function upsertBehavioralSignature(input, signature, executor = query) {
    const identity = assertBehaviorIdentity(input, 'behavioral-signature-upsert');
    await executor(
        `INSERT INTO agro_behavioral_signature
            (owner_user_id, device_id, context_id, signature_label,
             recovery_behavior, stress_behavior, stability_behavior, volatility_behavior,
             sensor_behavior, dominant_stress_metric, dominant_recovery_metric,
             resilience_level, risk_tendency, confidence, maturity_level,
             evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id) DO UPDATE SET
             signature_label=EXCLUDED.signature_label,
             recovery_behavior=EXCLUDED.recovery_behavior,
             stress_behavior=EXCLUDED.stress_behavior,
             stability_behavior=EXCLUDED.stability_behavior,
             volatility_behavior=EXCLUDED.volatility_behavior,
             sensor_behavior=EXCLUDED.sensor_behavior,
             dominant_stress_metric=EXCLUDED.dominant_stress_metric,
             dominant_recovery_metric=EXCLUDED.dominant_recovery_metric,
             resilience_level=EXCLUDED.resilience_level,
             risk_tendency=EXCLUDED.risk_tendency,
             confidence=EXCLUDED.confidence, maturity_level=EXCLUDED.maturity_level,
             evidence_json=EXCLUDED.evidence_json, rule_version=EXCLUDED.rule_version,
             updated_at=NOW()
         RETURNING id`,
        [
            identity.owner_user_id, identity.device_id, identity.context_id,
            signature.signature_label, signature.recovery_behavior, signature.stress_behavior,
            signature.stability_behavior, signature.volatility_behavior, signature.sensor_behavior,
            signature.dominant_stress_metric, signature.dominant_recovery_metric,
            signature.resilience_level, signature.risk_tendency, signature.confidence,
            signature.maturity_level, JSON.stringify(signature.evidence), RULE_VERSION
        ]
    );
}

async function deleteStaleBehavioralSignatures({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    const scoped = scopeClause(normalizedScope, 'bs');
    const productionClause = includeNonProduction
        ? ''
        : `AND c.is_production = TRUE
           AND lower(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')`;
    const rows = await executor(
        `WITH removed AS (
           DELETE FROM agro_behavioral_signature bs
           WHERE ${scoped.where.length ? `${scoped.where.join(' AND ')} AND` : ''} NOT (
             EXISTS (
               SELECT 1 FROM agro_context_segments c
               JOIN devices d ON d.id = c.device_id
               JOIN users u ON u.id = d.user_id
               WHERE c.id = bs.context_id AND c.owner_user_id = bs.owner_user_id
                 AND c.device_id = bs.device_id
                 AND c.owner_user_id = COALESCE(u.owner_user_id, u.id)
                 ${productionClause}
             )
             AND (
               EXISTS (SELECT 1 FROM agro_greenhouse_baselines b WHERE b.owner_user_id = bs.owner_user_id
                       AND b.device_id = bs.device_id AND b.context_id = bs.context_id)
               OR EXISTS (SELECT 1 FROM agro_stress_memory sm WHERE sm.owner_user_id = bs.owner_user_id
                          AND sm.device_id = bs.device_id AND sm.context_id = bs.context_id)
               OR EXISTS (SELECT 1 FROM agro_recovery_memory rm WHERE rm.owner_user_id = bs.owner_user_id
                          AND rm.device_id = bs.device_id AND rm.context_id = bs.context_id)
             )
           )
           RETURNING 1
         )
         SELECT COUNT(*)::integer AS removed FROM removed`,
        scoped.params
    );
    return Number(rows[0] && rows[0].removed) || 0;
}

async function runBehavioralSignatureCycle({
    scope = null, includeNonProduction = false, dryRun = false, executor = query
} = {}) {
    const inputs = await loadBehavioralInputs({ scope, includeNonProduction, executor });
    const summary = {
        contexts: inputs.length,
        stored: 0,
        by_risk: { low: 0, medium: 0, high: 0, unknown: 0 },
        by_resilience: { strong: 0, normal: 0, weak: 0, unknown: 0 },
        by_maturity: { cold_start: 0, learning: 0, stable: 0, mature: 0 },
        dry_run: dryRun
    };
    const rows = [];
    for (const input of inputs) {
        const identity = assertBehaviorIdentity(input, 'behavioral-signature-input');
        const signature = computeBehavioralSignature(input);
        summary.by_risk[signature.risk_tendency] += 1;
        summary.by_resilience[signature.resilience_level] += 1;
        summary.by_maturity[signature.maturity_level] += 1;
        rows.push({ key: identity, ...signature });
        if (!dryRun) { await upsertBehavioralSignature(input, signature, executor); }
        summary.stored += 1;
    }
    summary.removed_stale = dryRun
        ? 0
        : await deleteStaleBehavioralSignatures({ scope, includeNonProduction, executor });
    return dryRun ? { ...summary, rows } : summary;
}

module.exports = {
    ensureBehavioralSignatureSchema,
    runBehavioralSignatureCycle,
    loadBehavioralInputs,
    upsertBehavioralSignature,
    deleteStaleBehavioralSignatures,
    computeBehavioralSignature,
    maturityLevel,
    assertBehaviorIdentity,
    LABELS,
    NON_PRODUCTION_USAGE,
    BS,
    RULE_VERSION
};
