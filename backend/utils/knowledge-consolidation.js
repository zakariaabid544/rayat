// Rayat Intelligence - Sprint 3.5 Knowledge Consolidation Engine.
// Consolidated local memory per owner_user_id + device_id + context_id.
'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's3.5';
const NON_PRODUCTION_USAGE = Object.freeze(['demo', 'test', 'calibration', 'maintenance']);

function positiveInteger(value, fallback) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

const KC = {
    CONF_VOLUME_REF: positiveInteger(process.env.AGRO_KC_CONF_VOLUME_REF, 75),
    MAX_STRENGTHS: positiveInteger(process.env.AGRO_KC_MAX_STRENGTHS, 5),
    MAX_WEAKNESSES: positiveInteger(process.env.AGRO_KC_MAX_WEAKNESSES, 5),
    MAX_RECURRING_RISKS: positiveInteger(process.env.AGRO_KC_MAX_RISKS, 5),
    MAX_RECURRING_RECOVERIES: positiveInteger(process.env.AGRO_KC_MAX_RECOVERIES, 5)
};

function assertKnowledgeIdentity(identity, label = 'greenhouse-knowledge') {
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
         WHERE conrelid = 'agro_greenhouse_knowledge'::regclass AND conname = ? LIMIT 1`,
        [constraintName]
    );
    return rows.length > 0;
}

async function addConstraint(executor, constraintName, definition) {
    if (!await constraintExists(executor, constraintName)) {
        await executor(`ALTER TABLE agro_greenhouse_knowledge ADD CONSTRAINT ${constraintName} ${definition}`);
    }
}

async function ensureKnowledgeSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_greenhouse_knowledge (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL,
           baseline_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
           stress_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
           recovery_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
           behavioral_signature JSONB NOT NULL DEFAULT '{}'::jsonb,
           top_strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
           top_weaknesses JSONB NOT NULL DEFAULT '[]'::jsonb,
           recurring_risks JSONB NOT NULL DEFAULT '[]'::jsonb,
           recurring_recoveries JSONB NOT NULL DEFAULT '[]'::jsonb,
           knowledge_maturity VARCHAR(12) NOT NULL DEFAULT 'cold_start',
           confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's3.5',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_greenhouse_knowledge UNIQUE (owner_user_id, device_id, context_id),
           CONSTRAINT agro_greenhouse_knowledge_context_fk
             FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           CONSTRAINT agro_greenhouse_knowledge_values_check CHECK (
             knowledge_maturity IN ('cold_start','learning','stable','mature')
             AND confidence BETWEEN 0 AND 1
             AND jsonb_typeof(baseline_summary) = 'object'
             AND jsonb_typeof(stress_summary) = 'object'
             AND jsonb_typeof(recovery_summary) = 'object'
             AND jsonb_typeof(behavioral_signature) = 'object'
             AND jsonb_typeof(top_strengths) = 'array'
             AND jsonb_typeof(top_weaknesses) = 'array'
             AND jsonb_typeof(recurring_risks) = 'array'
             AND jsonb_typeof(recurring_recoveries) = 'array'
           )
         )`
    );

    const invalid = await executor(
        `SELECT COUNT(*) AS count
         FROM agro_greenhouse_knowledge k
         LEFT JOIN devices d ON d.id = k.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = k.context_id
         WHERE k.owner_user_id IS NULL OR k.device_id IS NULL OR k.context_id IS NULL
            OR k.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM k.owner_user_id
            OR c.device_id IS DISTINCT FROM k.device_id`
    );
    if (Number(invalid[0] && invalid[0].count) > 0) {
        throw new Error('[greenhouse-knowledge-schema] existing rows have invalid tenant/context identity');
    }

    await addConstraint(
        executor,
        'agro_greenhouse_knowledge_context_fk',
        'FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT'
    );
    await addConstraint(
        executor,
        'agro_greenhouse_knowledge_values_check',
        `CHECK (
          knowledge_maturity IN ('cold_start','learning','stable','mature')
          AND confidence BETWEEN 0 AND 1
          AND jsonb_typeof(baseline_summary) = 'object'
          AND jsonb_typeof(stress_summary) = 'object'
          AND jsonb_typeof(recovery_summary) = 'object'
          AND jsonb_typeof(behavioral_signature) = 'object'
          AND jsonb_typeof(top_strengths) = 'array'
          AND jsonb_typeof(top_weaknesses) = 'array'
          AND jsonb_typeof(recurring_risks) = 'array'
          AND jsonb_typeof(recurring_recoveries) = 'array'
        )`
    );

    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_greenhouse_knowledge_identity()
         RETURNS trigger AS $$
         DECLARE
           expected_owner INTEGER;
           context_owner INTEGER;
           context_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'greenhouse knowledge identity cannot be NULL';
           END IF;
           SELECT COALESCE(u.owner_user_id, u.id)
             INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id
            WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id
             INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'greenhouse knowledge owner_user_id does not own device_id';
           END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'greenhouse knowledge context_id does not belong to owner/device';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`
    );
    const trigger = await executor(
        `SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'agro_greenhouse_knowledge'::regclass
           AND tgname = 'agro_greenhouse_knowledge_identity_guard' AND NOT tgisinternal`
    );
    if (!trigger.length) {
        await executor(
            `CREATE TRIGGER agro_greenhouse_knowledge_identity_guard
             BEFORE INSERT OR UPDATE ON agro_greenhouse_knowledge
             FOR EACH ROW EXECUTE FUNCTION rayat_assert_greenhouse_knowledge_identity()`
        );
    }
    await executor('CREATE INDEX IF NOT EXISTS idx_greenhouse_knowledge_context ON agro_greenhouse_knowledge (context_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_greenhouse_knowledge_device ON agro_greenhouse_knowledge (device_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_greenhouse_knowledge_maturity ON agro_greenhouse_knowledge (knowledge_maturity, confidence DESC)');
}

function normalizeScope(scope) {
    if (!scope) { return null; }
    const ownerUserId = scope.ownerUserId == null ? null : positiveInteger(scope.ownerUserId, null);
    const deviceId = scope.deviceId == null ? null : positiveInteger(scope.deviceId, null);
    if ((scope.ownerUserId != null && !ownerUserId) || (scope.deviceId != null && !deviceId)) {
        throw new Error('[greenhouse-knowledge] invalid owner/device scope');
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

function uniqueLimited(values, limit) {
    const result = [];
    for (const value of values) {
        if (value && !result.includes(value)) { result.push(value); }
        if (result.length >= limit) { break; }
    }
    return result;
}

function knowledgeMaturity(layerCount, score, confidence) {
    if (layerCount < 2 || score < 0.4) { return 'cold_start'; }
    if (layerCount < 4 || score < 0.65) { return 'learning'; }
    if (score >= 0.85 && confidence >= 0.8) { return 'mature'; }
    return 'stable';
}

function computeGreenhouseKnowledge(input) {
    const baselines = parseRows(input.baseline_rows);
    const stresses = parseRows(input.stress_rows);
    const recoveries = parseRows(input.recovery_rows);
    const behavior = C.parseJson(input.behavioral_row, {}) || {};
    const hasBehavior = !!String(behavior.signature_label || '').trim();
    if (!baselines.length && !stresses.length && !recoveries.length && !hasBehavior) {
        throw new Error('[greenhouse-knowledge] no source intelligence');
    }

    const baselineDetails = baselines.map((row) => {
        const mean = C.num(row.mean_value);
        const stddev = C.num(row.stddev_value) || 0;
        const volatility = mean !== null && Math.abs(mean) > 0.000001
            ? Math.abs(stddev / mean)
            : (stddev === 0 ? 0 : 1);
        return {
            metric: String(row.metric),
            sample_count: Number(row.sample_count) || 0,
            mean: mean === null ? null : C.round3(mean),
            min: C.num(row.min_value),
            max: C.num(row.max_value),
            p10: C.num(row.p10_value),
            p50: C.num(row.p50_value),
            p90: C.num(row.p90_value),
            ewma: C.num(row.ewma_value),
            volatility: C.round3(volatility),
            confidence: C.round3(C.clamp01(Number(row.confidence) || 0)),
            maturity: String(row.maturity_level || 'cold_start')
        };
    }).sort((a, b) => a.metric.localeCompare(b.metric));
    const totalSamples = baselineDetails.reduce((sum, row) => sum + row.sample_count, 0);
    const baselineConfidence = baselineDetails.length ? C.mean(baselineDetails.map((row) => row.confidence)) : 0;
    const baselineVolatility = baselineDetails.length ? C.mean(baselineDetails.map((row) => row.volatility)) : 0;
    const stableBaselineCount = baselineDetails.filter((row) => row.volatility <= 0.15).length;
    const baselineSummary = {
        metric_count: baselineDetails.length,
        total_samples: totalSamples,
        stable_metric_count: stableBaselineCount,
        average_volatility: C.round3(baselineVolatility),
        average_confidence: C.round3(baselineConfidence),
        metrics: baselineDetails
    };

    const stressDetails = stresses.map((row) => ({
        metric: String(row.metric),
        stress_type: String(row.stress_type),
        occurrences: Number(row.stress_count) || 0,
        severity: C.round3(C.clamp01(Number(row.average_severity_score) || 0)),
        recurrence: C.round3(C.clamp01(Number(row.recurrence_score) || 0)),
        load: C.round1(C.clamp01((Number(row.stress_load_score) || 0) / 100) * 100),
        trend: String(row.trend_direction || 'stable'),
        confidence: C.round3(C.clamp01(Number(row.confidence) || 0)),
        maturity: String(row.maturity_level || 'cold_start')
    })).sort((a, b) => a.metric.localeCompare(b.metric) || a.stress_type.localeCompare(b.stress_type));
    const stressCount = stressDetails.reduce((sum, row) => sum + row.occurrences, 0);
    const weightedStress = (field) => stressCount > 0
        ? stressDetails.reduce((sum, row) => sum + row[field] * row.occurrences, 0) / stressCount
        : 0;
    const stressMaturityScore = stressCount > 0
        ? stressDetails.reduce((sum, row) => sum + maturityScore(row.maturity) * row.occurrences, 0) / stressCount
        : 0;
    const stressSummary = {
        memory_count: stressDetails.length,
        total_occurrences: stressCount,
        average_severity: C.round3(weightedStress('severity')),
        average_recurrence: C.round3(weightedStress('recurrence')),
        average_load: C.round1(weightedStress('load')),
        dominant_metric: stressDetails.slice().sort((a, b) => b.occurrences - a.occurrences
            || a.metric.localeCompare(b.metric) || a.stress_type.localeCompare(b.stress_type))[0]?.metric || null,
        memories: stressDetails
    };

    const recoveryDetails = recoveries.map((row) => ({
        metric: String(row.metric),
        recovery_count: Number(row.recovery_count) || 0,
        average_duration_seconds: C.num(row.average_recovery_duration),
        quality: C.round3(C.clamp01(Number(row.recovery_quality_score) || 0)),
        stability: C.round3(C.clamp01(Number(row.recovery_stability_score) || 0)),
        relapse_rate: C.round3(C.clamp01(Number(row.relapse_rate) || 0)),
        fast_rate: C.round3(C.clamp01(Number(row.fast_recovery_rate) || 0)),
        slow_rate: C.round3(C.clamp01(Number(row.slow_recovery_rate) || 0)),
        confidence: C.round3(C.clamp01(Number(row.confidence) || 0)),
        maturity: String(row.maturity_level || 'cold_start')
    })).sort((a, b) => a.metric.localeCompare(b.metric));
    const recoveryCount = recoveryDetails.reduce((sum, row) => sum + row.recovery_count, 0);
    const weightedRecovery = (field) => recoveryCount > 0
        ? recoveryDetails.reduce((sum, row) => sum + row[field] * row.recovery_count, 0) / recoveryCount
        : 0;
    const recoveryMaturityScore = recoveryCount > 0
        ? recoveryDetails.reduce((sum, row) => sum + maturityScore(row.maturity) * row.recovery_count, 0) / recoveryCount
        : 0;
    const recoverySummary = {
        memory_count: recoveryDetails.length,
        total_recoveries: recoveryCount,
        average_quality: C.round3(weightedRecovery('quality')),
        average_stability: C.round3(weightedRecovery('stability')),
        average_relapse_rate: C.round3(weightedRecovery('relapse_rate')),
        average_fast_rate: C.round3(weightedRecovery('fast_rate')),
        average_slow_rate: C.round3(weightedRecovery('slow_rate')),
        dominant_metric: recoveryDetails.slice().sort((a, b) => b.recovery_count - a.recovery_count
            || a.metric.localeCompare(b.metric))[0]?.metric || null,
        memories: recoveryDetails
    };

    const behaviorSummary = hasBehavior ? {
        signature_label: behavior.signature_label,
        recovery_behavior: behavior.recovery_behavior,
        stress_behavior: behavior.stress_behavior,
        stability_behavior: behavior.stability_behavior,
        volatility_behavior: behavior.volatility_behavior,
        sensor_behavior: behavior.sensor_behavior,
        dominant_stress_metric: behavior.dominant_stress_metric || null,
        dominant_recovery_metric: behavior.dominant_recovery_metric || null,
        resilience_level: behavior.resilience_level,
        risk_tendency: behavior.risk_tendency,
        confidence: C.round3(C.clamp01(Number(behavior.confidence) || 0)),
        maturity: behavior.maturity_level || 'cold_start'
    } : {};

    const strengthCandidates = [];
    if (behavior.resilience_level === 'strong') { strengthCandidates.push('strong_resilience'); }
    if (recoverySummary.average_fast_rate >= 0.6) { strengthCandidates.push('fast_recovery'); }
    if (recoverySummary.average_quality >= 0.7) { strengthCandidates.push('high_recovery_quality'); }
    if (baselineDetails.length && stableBaselineCount / baselineDetails.length >= 0.6) { strengthCandidates.push('stable_baselines'); }
    if (baselineDetails.length && baselineVolatility <= 0.1) { strengthCandidates.push('low_volatility'); }
    if (stressCount > 0 && stressSummary.average_load < 35) { strengthCandidates.push('low_stress_load'); }
    if (behavior.sensor_behavior === 'reliable') { strengthCandidates.push('reliable_sensors'); }
    if (behavior.risk_tendency === 'low') { strengthCandidates.push('low_risk_tendency'); }
    const topStrengths = uniqueLimited(strengthCandidates, KC.MAX_STRENGTHS);

    const weaknessCandidates = [];
    if (behavior.resilience_level === 'weak') { weaknessCandidates.push('weak_resilience'); }
    if (behavior.recovery_behavior === 'fragile_recovery') { weaknessCandidates.push('fragile_recovery'); }
    if (recoverySummary.average_relapse_rate >= 0.4) { weaknessCandidates.push('high_relapse_rate'); }
    if (recoverySummary.average_slow_rate >= 0.6) { weaknessCandidates.push('slow_recovery'); }
    if (stressSummary.average_load >= 70) { weaknessCandidates.push('high_stress_load'); }
    if (stressSummary.average_recurrence >= 0.65) { weaknessCandidates.push('recurring_stress'); }
    if (baselineDetails.length && baselineVolatility > 0.3) { weaknessCandidates.push('high_volatility'); }
    if (behavior.sensor_behavior === 'drift_risk') { weaknessCandidates.push('sensor_drift_risk'); }
    if (behavior.risk_tendency === 'high') { weaknessCandidates.push('high_risk_tendency'); }
    const topWeaknesses = uniqueLimited(weaknessCandidates, KC.MAX_WEAKNESSES);

    const recurringRisks = stressDetails
        .filter((row) => row.recurrence >= 0.6 || row.trend === 'rising' || (row.occurrences >= 3 && row.load >= 50))
        .map((row) => ({
            metric: row.metric,
            stress_type: row.stress_type,
            occurrences: row.occurrences,
            recurrence_score: row.recurrence,
            stress_load_score: row.load,
            risk_score: C.round3(C.clamp01(
                0.4 * (row.load / 100) + 0.3 * row.recurrence + 0.2 * row.severity
                + 0.1 * C.normLog(row.occurrences, 20)
            ))
        }))
        .sort((a, b) => b.risk_score - a.risk_score || b.occurrences - a.occurrences
            || a.metric.localeCompare(b.metric) || a.stress_type.localeCompare(b.stress_type))
        .slice(0, KC.MAX_RECURRING_RISKS);

    const recurringRecoveries = recoveryDetails
        .filter((row) => row.recovery_count >= 2)
        .map((row) => ({
            metric: row.metric,
            recovery_count: row.recovery_count,
            quality_score: row.quality,
            stability_score: row.stability,
            fast_rate: row.fast_rate,
            relapse_rate: row.relapse_rate,
            recovery_score: C.round3(C.clamp01(
                0.35 * row.quality + 0.25 * row.stability + 0.2 * row.fast_rate
                + 0.1 * (1 - row.relapse_rate) + 0.1 * C.normLog(row.recovery_count, 20)
            ))
        }))
        .sort((a, b) => b.recovery_score - a.recovery_score || b.recovery_count - a.recovery_count
            || a.metric.localeCompare(b.metric))
        .slice(0, KC.MAX_RECURRING_RECOVERIES);

    const layerConfidences = [];
    const maturityScores = [];
    if (baselineDetails.length) {
        layerConfidences.push(baselineConfidence);
        maturityScores.push(C.mean(baselineDetails.map((row) => maturityScore(row.maturity))));
    }
    if (stressDetails.length) {
        layerConfidences.push(weightedStress('confidence'));
        maturityScores.push(stressMaturityScore);
    }
    if (recoveryDetails.length) {
        layerConfidences.push(weightedRecovery('confidence'));
        maturityScores.push(recoveryMaturityScore);
    }
    if (hasBehavior) {
        layerConfidences.push(Number(behaviorSummary.confidence) || 0);
        maturityScores.push(maturityScore(behaviorSummary.maturity));
    }
    const layerCount = layerConfidences.length;
    const sourceConfidence = C.mean(layerConfidences);
    const sourceMaturity = C.mean(maturityScores);
    const evidenceVolume = baselineDetails.length + stressCount + recoveryCount + (hasBehavior ? 1 : 0);
    const confidence = C.clamp01(
        0.55 * sourceConfidence + 0.25 * (layerCount / 4)
        + 0.15 * C.normLog(evidenceVolume, KC.CONF_VOLUME_REF) + 0.05
    );
    const maturity = knowledgeMaturity(layerCount, sourceMaturity, confidence);

    return {
        baseline_summary: baselineSummary,
        stress_summary: stressSummary,
        recovery_summary: recoverySummary,
        behavioral_signature: behaviorSummary,
        top_strengths: topStrengths,
        top_weaknesses: topWeaknesses,
        recurring_risks: recurringRisks,
        recurring_recoveries: recurringRecoveries,
        knowledge_maturity: maturity,
        confidence: C.round3(confidence),
        evidence: {
            rule_version: RULE_VERSION,
            aggregation_key: ['owner_user_id', 'device_id', 'context_id'],
            source_layers: {
                baseline: baselineDetails.length > 0,
                stress_memory: stressDetails.length > 0,
                recovery_memory: recoveryDetails.length > 0,
                behavioral_signature: hasBehavior,
                count: layerCount
            },
            source_counts: {
                baseline_metrics: baselineDetails.length,
                baseline_samples: totalSamples,
                stress_memories: stressDetails.length,
                stress_occurrences: stressCount,
                recovery_memories: recoveryDetails.length,
                recoveries: recoveryCount,
                behavioral_signatures: hasBehavior ? 1 : 0
            },
            confidence: {
                score: C.round3(confidence),
                source_confidence: C.round3(sourceConfidence),
                source_coverage: C.round3(layerCount / 4),
                evidence_volume: C.round3(C.normLog(evidenceVolume, KC.CONF_VOLUME_REF)),
                weights: { source_confidence: 0.55, source_coverage: 0.25, evidence_volume: 0.15, identity_integrity: 0.05 }
            },
            maturity: { level: maturity, source_maturity_score: C.round3(sourceMaturity) },
            selection_limits: {
                strengths: KC.MAX_STRENGTHS,
                weaknesses: KC.MAX_WEAKNESSES,
                recurring_risks: KC.MAX_RECURRING_RISKS,
                recurring_recoveries: KC.MAX_RECURRING_RECOVERIES
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
        throw new Error(`[greenhouse-knowledge] fail-closed: ${invalidCount} source rows have invalid tenant/context identity`);
    }
}

async function loadKnowledgeInputs({ scope = null, includeNonProduction = false, executor = query } = {}) {
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
         keys AS (
           SELECT b.owner_user_id, b.device_id, b.context_id FROM agro_greenhouse_baselines b
             JOIN eligible_contexts c USING (owner_user_id, device_id, context_id)
           UNION SELECT sm.owner_user_id, sm.device_id, sm.context_id FROM agro_stress_memory sm
             JOIN eligible_contexts c USING (owner_user_id, device_id, context_id)
           UNION SELECT rm.owner_user_id, rm.device_id, rm.context_id FROM agro_recovery_memory rm
             JOIN eligible_contexts c USING (owner_user_id, device_id, context_id)
           UNION SELECT bs.owner_user_id, bs.device_id, bs.context_id FROM agro_behavioral_signature bs
             JOIN eligible_contexts c USING (owner_user_id, device_id, context_id)
         )
         SELECT k.owner_user_id, k.device_id, k.context_id,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'metric', b.metric, 'sample_count', b.sample_count,
                    'mean_value', b.mean_value, 'min_value', b.min_value, 'max_value', b.max_value,
                    'stddev_value', b.stddev_value, 'p10_value', b.p10_value,
                    'p50_value', b.p50_value, 'p90_value', b.p90_value,
                    'ewma_value', b.ewma_value, 'confidence', b.confidence,
                    'maturity_level', b.maturity_level
                  ) ORDER BY b.metric)
                  FROM agro_greenhouse_baselines b
                  WHERE b.owner_user_id = k.owner_user_id AND b.device_id = k.device_id AND b.context_id = k.context_id
                ), '[]'::jsonb) AS baseline_rows,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'metric', sm.metric, 'stress_type', sm.stress_type,
                    'stress_count', sm.stress_count,
                    'average_severity_score', sm.average_severity_score,
                    'recurrence_score', sm.recurrence_score,
                    'stress_load_score', sm.stress_load_score,
                    'trend_direction', sm.trend_direction,
                    'confidence', sm.confidence, 'maturity_level', sm.maturity_level
                  ) ORDER BY sm.metric, sm.stress_type)
                  FROM agro_stress_memory sm
                  WHERE sm.owner_user_id = k.owner_user_id AND sm.device_id = k.device_id AND sm.context_id = k.context_id
                ), '[]'::jsonb) AS stress_rows,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'metric', rm.metric, 'recovery_count', rm.recovery_count,
                    'average_recovery_duration', rm.average_recovery_duration,
                    'recovery_quality_score', rm.recovery_quality_score,
                    'recovery_stability_score', rm.recovery_stability_score,
                    'relapse_rate', rm.relapse_rate,
                    'fast_recovery_rate', rm.fast_recovery_rate,
                    'slow_recovery_rate', rm.slow_recovery_rate,
                    'confidence', rm.confidence, 'maturity_level', rm.maturity_level
                  ) ORDER BY rm.metric)
                  FROM agro_recovery_memory rm
                  WHERE rm.owner_user_id = k.owner_user_id AND rm.device_id = k.device_id AND rm.context_id = k.context_id
                ), '[]'::jsonb) AS recovery_rows,
                COALESCE((
                  SELECT jsonb_build_object(
                    'signature_label', bs.signature_label,
                    'recovery_behavior', bs.recovery_behavior,
                    'stress_behavior', bs.stress_behavior,
                    'stability_behavior', bs.stability_behavior,
                    'volatility_behavior', bs.volatility_behavior,
                    'sensor_behavior', bs.sensor_behavior,
                    'dominant_stress_metric', bs.dominant_stress_metric,
                    'dominant_recovery_metric', bs.dominant_recovery_metric,
                    'resilience_level', bs.resilience_level,
                    'risk_tendency', bs.risk_tendency,
                    'confidence', bs.confidence, 'maturity_level', bs.maturity_level
                  ) FROM agro_behavioral_signature bs
                  WHERE bs.owner_user_id = k.owner_user_id AND bs.device_id = k.device_id AND bs.context_id = k.context_id
                  LIMIT 1
                ), '{}'::jsonb) AS behavioral_row
         FROM keys k
         ORDER BY k.owner_user_id, k.device_id, k.context_id`,
        scoped.params
    );
}

async function upsertKnowledge(input, knowledge, executor = query) {
    const identity = assertKnowledgeIdentity(input, 'greenhouse-knowledge-upsert');
    await executor(
        `INSERT INTO agro_greenhouse_knowledge
            (owner_user_id, device_id, context_id, baseline_summary, stress_summary,
             recovery_summary, behavioral_signature, top_strengths, top_weaknesses,
             recurring_risks, recurring_recoveries, knowledge_maturity, confidence,
             evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB),
                 CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB),
                 ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id) DO UPDATE SET
             baseline_summary=EXCLUDED.baseline_summary,
             stress_summary=EXCLUDED.stress_summary,
             recovery_summary=EXCLUDED.recovery_summary,
             behavioral_signature=EXCLUDED.behavioral_signature,
             top_strengths=EXCLUDED.top_strengths,
             top_weaknesses=EXCLUDED.top_weaknesses,
             recurring_risks=EXCLUDED.recurring_risks,
             recurring_recoveries=EXCLUDED.recurring_recoveries,
             knowledge_maturity=EXCLUDED.knowledge_maturity,
             confidence=EXCLUDED.confidence,
             evidence_json=EXCLUDED.evidence_json,
             rule_version=EXCLUDED.rule_version,
             updated_at=NOW()
         RETURNING id`,
        [
            identity.owner_user_id, identity.device_id, identity.context_id,
            JSON.stringify(knowledge.baseline_summary), JSON.stringify(knowledge.stress_summary),
            JSON.stringify(knowledge.recovery_summary), JSON.stringify(knowledge.behavioral_signature),
            JSON.stringify(knowledge.top_strengths), JSON.stringify(knowledge.top_weaknesses),
            JSON.stringify(knowledge.recurring_risks), JSON.stringify(knowledge.recurring_recoveries),
            knowledge.knowledge_maturity, knowledge.confidence, JSON.stringify(knowledge.evidence), RULE_VERSION
        ]
    );
}

async function deleteStaleKnowledge({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    const scoped = scopeClause(normalizedScope, 'k');
    const productionClause = includeNonProduction
        ? ''
        : `AND c.is_production = TRUE
           AND lower(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')`;
    const rows = await executor(
        `WITH removed AS (
           DELETE FROM agro_greenhouse_knowledge k
           WHERE ${scoped.where.length ? `${scoped.where.join(' AND ')} AND` : ''} NOT (
             EXISTS (
               SELECT 1 FROM agro_context_segments c
               JOIN devices d ON d.id = c.device_id
               JOIN users u ON u.id = d.user_id
               WHERE c.id = k.context_id AND c.owner_user_id = k.owner_user_id
                 AND c.device_id = k.device_id
                 AND c.owner_user_id = COALESCE(u.owner_user_id, u.id)
                 ${productionClause}
             )
             AND (
               EXISTS (SELECT 1 FROM agro_greenhouse_baselines b WHERE b.owner_user_id = k.owner_user_id
                       AND b.device_id = k.device_id AND b.context_id = k.context_id)
               OR EXISTS (SELECT 1 FROM agro_stress_memory sm WHERE sm.owner_user_id = k.owner_user_id
                          AND sm.device_id = k.device_id AND sm.context_id = k.context_id)
               OR EXISTS (SELECT 1 FROM agro_recovery_memory rm WHERE rm.owner_user_id = k.owner_user_id
                          AND rm.device_id = k.device_id AND rm.context_id = k.context_id)
               OR EXISTS (SELECT 1 FROM agro_behavioral_signature bs WHERE bs.owner_user_id = k.owner_user_id
                          AND bs.device_id = k.device_id AND bs.context_id = k.context_id)
             )
           )
           RETURNING 1
         )
         SELECT COUNT(*)::integer AS removed FROM removed`,
        scoped.params
    );
    return Number(rows[0] && rows[0].removed) || 0;
}

async function runKnowledgeConsolidationCycle({
    scope = null, includeNonProduction = false, dryRun = false, executor = query
} = {}) {
    const inputs = await loadKnowledgeInputs({ scope, includeNonProduction, executor });
    const summary = {
        contexts: inputs.length,
        stored: 0,
        by_maturity: { cold_start: 0, learning: 0, stable: 0, mature: 0 },
        dry_run: dryRun
    };
    const rows = [];
    for (const input of inputs) {
        const identity = assertKnowledgeIdentity(input, 'greenhouse-knowledge-input');
        const knowledge = computeGreenhouseKnowledge(input);
        summary.by_maturity[knowledge.knowledge_maturity] += 1;
        rows.push({ key: identity, ...knowledge });
        if (!dryRun) { await upsertKnowledge(input, knowledge, executor); }
        summary.stored += 1;
    }
    summary.removed_stale = dryRun
        ? 0
        : await deleteStaleKnowledge({ scope, includeNonProduction, executor });
    return dryRun ? { ...summary, rows } : summary;
}

module.exports = {
    ensureKnowledgeSchema,
    runKnowledgeConsolidationCycle,
    loadKnowledgeInputs,
    upsertKnowledge,
    deleteStaleKnowledge,
    computeGreenhouseKnowledge,
    knowledgeMaturity,
    assertKnowledgeIdentity,
    NON_PRODUCTION_USAGE,
    KC,
    RULE_VERSION
};
