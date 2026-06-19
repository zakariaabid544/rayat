// Rayat Intelligence - Sprint 3.3 Recovery Memory Engine (local, context-aware).
// Aggregation unit: owner_user_id + device_id + context_id + metric.
// Reads Sprint 1 recovery signals and writes only agro_recovery_memory.
'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's3.3';
const RECOVERY_EVENT_TYPES = Object.freeze(['recovery', 'return_to_range', 'stabilization', 'improvement']);
const STRESS_OUTCOME_TYPES = Object.freeze(['out_of_range', 'worsening', 'anomaly', 'regime_shift', 'sensor_drift']);
const NON_PRODUCTION_USAGE = Object.freeze(['demo', 'test', 'calibration', 'maintenance']);
const QUALITY_DEFAULTS = Object.freeze({
    recovery: 0.75,
    return_to_range: 0.65,
    stabilization: 0.7,
    improvement: 0.6
});

function positiveInteger(value, fallback) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function positiveNumber(value, fallback) {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

const RM = {
    RELAPSE_MINUTES: positiveInteger(
        process.env.AGRO_RM_RELAPSE_MINUTES || process.env.AGRO_RECOVERY_RELAPSE_MIN,
        60
    ),
    FAST_HOURS: positiveNumber(process.env.AGRO_RM_FAST_HOURS, 48),
    CONF_COUNT_REF: positiveInteger(process.env.AGRO_RM_CONF_COUNT_REF, 30),
    RECENCY_REF_DAYS: positiveInteger(process.env.AGRO_RM_RECENCY_DAYS, 30),
    MIN_LEARNING_EVENTS: positiveInteger(process.env.AGRO_RM_MIN_LEARNING, 3),
    STABLE_EVENTS: positiveInteger(process.env.AGRO_RM_STABLE_EVENTS, 10),
    MATURE_EVENTS: positiveInteger(process.env.AGRO_RM_MATURE_EVENTS, 25),
    STABLE_DAYS: positiveInteger(process.env.AGRO_RM_STABLE_DAYS, 3),
    MATURE_DAYS: positiveInteger(process.env.AGRO_RM_MATURE_DAYS, 7)
};

function assertRecoveryIdentity(identity, label = 'recovery-memory') {
    const owner = positiveInteger(identity && identity.owner_user_id, null);
    const device = positiveInteger(identity && identity.device_id, null);
    const context = positiveInteger(identity && identity.context_id, null);
    const metric = String((identity && identity.metric) || '').trim();
    if (!owner || !device || !context || !metric) {
        throw new Error(`[${label}] unresolved owner/device/context/metric identity`);
    }
    return { owner_user_id: owner, device_id: device, context_id: context, metric };
}

function recoveryQualityScore({ eventType, evidenceQuality, confidence }) {
    const evidence = C.num(evidenceQuality);
    if (evidence !== null) { return C.clamp01(evidence); }
    const eventConfidence = C.num(confidence);
    if (eventConfidence !== null && eventConfidence > 0) { return C.clamp01(eventConfidence); }
    return QUALITY_DEFAULTS[String(eventType || '').toLowerCase()] || 0.5;
}

async function constraintExists(executor, constraintName) {
    const rows = await executor(
        `SELECT 1 FROM pg_constraint
         WHERE conrelid = 'agro_recovery_memory'::regclass AND conname = ? LIMIT 1`,
        [constraintName]
    );
    return rows.length > 0;
}

async function addConstraint(executor, constraintName, definition) {
    if (!await constraintExists(executor, constraintName)) {
        await executor(`ALTER TABLE agro_recovery_memory ADD CONSTRAINT ${constraintName} ${definition}`);
    }
}

async function ensureRecoveryMemorySchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_recovery_memory (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL,
           metric VARCHAR(80) NOT NULL,
           recovery_count INTEGER NOT NULL DEFAULT 0,
           first_seen_at TIMESTAMPTZ NOT NULL,
           last_seen_at TIMESTAMPTZ NOT NULL,
           average_recovery_duration NUMERIC(16,3) NOT NULL DEFAULT 0,
           min_recovery_duration NUMERIC(16,3) NOT NULL DEFAULT 0,
           max_recovery_duration NUMERIC(16,3) NOT NULL DEFAULT 0,
           recovery_quality_score NUMERIC(5,4) NOT NULL DEFAULT 0,
           recovery_stability_score NUMERIC(5,4) NOT NULL DEFAULT 0,
           relapse_rate NUMERIC(5,4) NOT NULL DEFAULT 0,
           fast_recovery_rate NUMERIC(5,4) NOT NULL DEFAULT 0,
           slow_recovery_rate NUMERIC(5,4) NOT NULL DEFAULT 0,
           confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           maturity_level VARCHAR(12) NOT NULL DEFAULT 'cold_start',
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's3.3',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_recovery_memory UNIQUE (owner_user_id, device_id, context_id, metric),
           CONSTRAINT agro_recovery_memory_context_fk
             FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           CONSTRAINT agro_recovery_memory_values_check CHECK (
             recovery_count > 0
             AND average_recovery_duration >= 0
             AND min_recovery_duration >= 0
             AND max_recovery_duration >= 0
             AND min_recovery_duration <= average_recovery_duration
             AND average_recovery_duration <= max_recovery_duration
             AND recovery_quality_score BETWEEN 0 AND 1
             AND recovery_stability_score BETWEEN 0 AND 1
             AND relapse_rate BETWEEN 0 AND 1
             AND fast_recovery_rate BETWEEN 0 AND 1
             AND slow_recovery_rate BETWEEN 0 AND 1
             AND confidence BETWEEN 0 AND 1
             AND maturity_level IN ('cold_start','learning','stable','mature')
             AND btrim(metric) <> ''
           )
         )`
    );

    const invalid = await executor(
        `SELECT COUNT(*) AS count
         FROM agro_recovery_memory rm
         LEFT JOIN devices d ON d.id = rm.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = rm.context_id
         WHERE rm.owner_user_id IS NULL OR rm.device_id IS NULL OR rm.context_id IS NULL
            OR rm.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM rm.owner_user_id
            OR c.device_id IS DISTINCT FROM rm.device_id`
    );
    if (Number(invalid[0] && invalid[0].count) > 0) {
        throw new Error('[recovery-memory-schema] existing rows have invalid tenant/context identity');
    }

    await addConstraint(
        executor,
        'agro_recovery_memory_context_fk',
        'FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT'
    );
    await addConstraint(
        executor,
        'agro_recovery_memory_values_check',
        `CHECK (
          recovery_count > 0
          AND average_recovery_duration >= 0
          AND min_recovery_duration >= 0
          AND max_recovery_duration >= 0
          AND min_recovery_duration <= average_recovery_duration
          AND average_recovery_duration <= max_recovery_duration
          AND recovery_quality_score BETWEEN 0 AND 1
          AND recovery_stability_score BETWEEN 0 AND 1
          AND relapse_rate BETWEEN 0 AND 1
          AND fast_recovery_rate BETWEEN 0 AND 1
          AND slow_recovery_rate BETWEEN 0 AND 1
          AND confidence BETWEEN 0 AND 1
          AND maturity_level IN ('cold_start','learning','stable','mature')
          AND btrim(metric) <> ''
        )`
    );

    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_recovery_memory_identity()
         RETURNS trigger AS $$
         DECLARE
           expected_owner INTEGER;
           context_owner INTEGER;
           context_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'recovery memory identity cannot be NULL';
           END IF;
           SELECT COALESCE(u.owner_user_id, u.id)
             INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id
            WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id
             INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'recovery memory owner_user_id does not own device_id';
           END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'recovery memory context_id does not belong to owner/device';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`
    );
    const trigger = await executor(
        `SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'agro_recovery_memory'::regclass
           AND tgname = 'agro_recovery_memory_identity_guard' AND NOT tgisinternal`
    );
    if (!trigger.length) {
        await executor(
            `CREATE TRIGGER agro_recovery_memory_identity_guard
             BEFORE INSERT OR UPDATE ON agro_recovery_memory
             FOR EACH ROW EXECUTE FUNCTION rayat_assert_recovery_memory_identity()`
        );
    }
    await executor('CREATE INDEX IF NOT EXISTS idx_recovery_memory_context ON agro_recovery_memory (context_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_recovery_memory_device ON agro_recovery_memory (device_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_recovery_memory_last ON agro_recovery_memory (last_seen_at DESC)');
}

function normalizeScope(scope) {
    if (!scope) { return null; }
    const ownerUserId = scope.ownerUserId == null ? null : positiveInteger(scope.ownerUserId, null);
    const deviceId = scope.deviceId == null ? null : positiveInteger(scope.deviceId, null);
    if ((scope.ownerUserId != null && !ownerUserId) || (scope.deviceId != null && !deviceId)) {
        throw new Error('[recovery-memory] invalid owner/device scope');
    }
    return { ownerUserId, deviceId };
}

function maturityLevel(recoveryCount, distinctDays) {
    const count = Number(recoveryCount);
    const days = Number(distinctDays);
    if (count < RM.MIN_LEARNING_EVENTS) { return 'cold_start'; }
    if (count < RM.STABLE_EVENTS || days < RM.STABLE_DAYS) { return 'learning'; }
    if (count >= RM.MATURE_EVENTS && days >= RM.MATURE_DAYS) { return 'mature'; }
    return 'stable';
}

function computeRecoveryMemory(group, nowMs) {
    const count = Number(group.recovery_count);
    const distinctDays = Number(group.distinct_days);
    const durationSamples = Number(group.duration_sample_count);
    const averageDuration = C.num(group.average_recovery_duration);
    const minDuration = C.num(group.min_recovery_duration);
    const maxDuration = C.num(group.max_recovery_duration);
    const durationStddev = C.num(group.duration_stddev);
    const quality = C.num(group.recovery_quality_score);
    const qualityStddev = C.num(group.quality_stddev);
    const relapseCount = Number(group.relapse_count);
    const fastCount = Number(group.fast_count);
    const slowCount = Number(group.slow_count);
    const firstSeenMs = new Date(group.first_seen_at).getTime();
    const lastSeenMs = new Date(group.last_seen_at).getTime();
    const clockMs = Number(nowMs);
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(distinctDays) || distinctDays <= 0
        || !Number.isInteger(durationSamples) || durationSamples < 0
        || [averageDuration, minDuration, maxDuration, durationStddev, quality, qualityStddev].some((value) => value === null)
        || !Number.isInteger(relapseCount) || relapseCount < 0
        || !Number.isInteger(fastCount) || fastCount < 0 || !Number.isInteger(slowCount) || slowCount < 0
        || !Number.isFinite(firstSeenMs) || !Number.isFinite(lastSeenMs) || !Number.isFinite(clockMs)) {
        throw new Error('[recovery-memory] invalid aggregate statistics');
    }

    const relapseRate = C.clamp01(relapseCount / count);
    const fastRate = durationSamples > 0 ? C.clamp01(fastCount / durationSamples) : 0;
    const slowRate = durationSamples > 0 ? C.clamp01(slowCount / durationSamples) : 0;
    const qualityConsistency = C.clamp01(1 - qualityStddev / Math.max(quality, 0.1));
    const durationConsistency = durationSamples > 1
        ? C.clamp01(1 - durationStddev / Math.max(averageDuration, 1))
        : (durationSamples === 1 ? 1 : 0);
    const stability = C.clamp01(
        0.5 * (1 - relapseRate) + 0.3 * qualityConsistency + 0.2 * durationConsistency
    );

    const recencyDays = Math.max(0, (clockMs - lastSeenMs) / C.DAY_MS);
    const countFactor = C.normLog(count, RM.CONF_COUNT_REF);
    const contextCoverage = C.clamp01(distinctDays / RM.MATURE_DAYS);
    const durationCoverage = C.clamp01(durationSamples / count);
    const recency = C.recencyFactor(recencyDays, RM.RECENCY_REF_DAYS);
    const confidence = C.clamp01(
        0.4 * countFactor + 0.2 * contextCoverage + 0.15 * durationCoverage
        + 0.1 * qualityConsistency + 0.15 * recency
    );
    const maturity = maturityLevel(count, distinctDays);
    const eventDistribution = typeof group.event_type_distribution_json === 'string'
        ? JSON.parse(group.event_type_distribution_json)
        : group.event_type_distribution_json;

    return {
        recovery_count: count,
        first_seen_at: group.first_seen_at,
        last_seen_at: group.last_seen_at,
        average_recovery_duration: C.round3(averageDuration),
        min_recovery_duration: C.round3(minDuration),
        max_recovery_duration: C.round3(maxDuration),
        recovery_quality_score: C.round3(quality),
        recovery_stability_score: C.round3(stability),
        relapse_rate: C.round3(relapseRate),
        fast_recovery_rate: C.round3(fastRate),
        slow_recovery_rate: C.round3(slowRate),
        confidence: C.round3(confidence),
        maturity_level: maturity,
        evidence: {
            rule_version: RULE_VERSION,
            aggregation_key: ['owner_user_id', 'device_id', 'context_id', 'metric'],
            source_event_types: RECOVERY_EVENT_TYPES,
            stress_outcome_types: STRESS_OUTCOME_TYPES,
            event_type_distribution: eventDistribution || {},
            recovery_count: count,
            distinct_days: distinctDays,
            distinct_sensor_count: Number(group.distinct_sensor_count),
            duration: {
                unit: 'seconds',
                sample_count: durationSamples,
                resolution: ['duration_seconds', 'recovery_duration_minutes_evidence', 'linked_out_of_range_duration', 'ended_at_minus_started_at'],
                fast_threshold_hours: RM.FAST_HOURS,
                standard_deviation_seconds: C.round3(durationStddev)
            },
            quality: {
                score: C.round3(quality),
                resolution: ['evidence_json.recovery_quality', 'event_confidence', 'event_type_default'],
                event_type_defaults: QUALITY_DEFAULTS,
                consistency: C.round3(qualityConsistency)
            },
            stability: {
                score: C.round3(stability),
                weights: { no_relapse: 0.5, quality_consistency: 0.3, duration_consistency: 0.2 },
                factors: {
                    no_relapse: C.round3(1 - relapseRate),
                    quality_consistency: C.round3(qualityConsistency),
                    duration_consistency: C.round3(durationConsistency)
                }
            },
            relapse: {
                count: relapseCount,
                rate: C.round3(relapseRate),
                window_minutes: RM.RELAPSE_MINUTES,
                match_key: ['owner_user_id', 'device_id', 'context_id', 'metric']
            },
            speed: {
                fast_count: fastCount,
                slow_count: slowCount,
                fast_rate: C.round3(fastRate),
                slow_rate: C.round3(slowRate)
            },
            confidence: {
                score: C.round3(confidence),
                weights: { event_count: 0.4, context_coverage: 0.2, duration_coverage: 0.15, quality_consistency: 0.1, recency: 0.15 },
                factors: {
                    event_count: C.round3(countFactor), context_coverage: C.round3(contextCoverage),
                    duration_coverage: C.round3(durationCoverage), quality_consistency: C.round3(qualityConsistency),
                    recency: C.round3(recency)
                }
            },
            maturity: {
                level: maturity,
                thresholds: {
                    learning_events: RM.MIN_LEARNING_EVENTS, stable_events: RM.STABLE_EVENTS,
                    mature_events: RM.MATURE_EVENTS, stable_days: RM.STABLE_DAYS, mature_days: RM.MATURE_DAYS
                }
            },
            privacy: { contains_raw_evidence: false, cross_tenant_evidence: false }
        }
    };
}

async function loadRecoveryGroups({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    const where = [
        "ev.event_type IN ('recovery','return_to_range','stabilization','improvement')",
        "ev.metric IS NOT NULL AND btrim(ev.metric) <> ''"
    ];
    const params = [];
    if (normalizedScope && normalizedScope.deviceId) { where.push('ev.device_id = ?'); params.push(normalizedScope.deviceId); }
    if (normalizedScope && normalizedScope.ownerUserId) { where.push('ev.owner_user_id = ?'); params.push(normalizedScope.ownerUserId); }

    const validIdentity = `context_match_id IS NOT NULL AND owner_user_id IS NOT NULL AND device_id IS NOT NULL
      AND canonical_owner_user_id = owner_user_id
      AND sensor_match_id IS NOT NULL AND sensor_device_id = device_id
      AND context_owner_user_id = owner_user_id AND context_device_id = device_id`;
    const productionEligible = includeNonProduction
        ? validIdentity
        : `${validIdentity} AND is_production = TRUE
           AND lower(COALESCE(usage_type, '')) NOT IN ('demo','test','calibration','maintenance')`;
    const excludedNonProduction = includeNonProduction
        ? 'FALSE'
        : `${validIdentity} AND (is_production IS DISTINCT FROM TRUE
           OR lower(COALESCE(usage_type, '')) IN ('demo','test','calibration','maintenance'))`;
    const fastSeconds = RM.FAST_HOURS * 3600;

    const rows = await executor(
        `WITH candidates AS (
           SELECT ev.id AS event_id, ev.owner_user_id, ev.device_id, ev.sensor_id, ev.context_id,
                  ev.metric, ev.event_type, ev.started_at, ev.ended_at,
                  COALESCE(du.owner_user_id, du.id) AS canonical_owner_user_id,
                  s.id AS sensor_match_id, s.device_id AS sensor_device_id,
                  c.id AS context_match_id, c.owner_user_id AS context_owner_user_id,
                  c.device_id AS context_device_id, c.is_production, c.usage_type,
                  duration.resolved_duration_seconds,
                  CASE
                    WHEN COALESCE(ev.evidence_json->>'recovery_quality', '') ~ '^[0-9]+([.][0-9]+)?$'
                      THEN LEAST(1, GREATEST(0, (ev.evidence_json->>'recovery_quality')::float8))
                    WHEN ev.confidence > 0 THEN LEAST(1, GREATEST(0, ev.confidence::float8))
                    WHEN ev.event_type = 'recovery' THEN 0.75
                    WHEN ev.event_type = 'return_to_range' THEN 0.65
                    WHEN ev.event_type = 'stabilization' THEN 0.7
                    WHEN ev.event_type = 'improvement' THEN 0.6
                    ELSE 0.5
                  END AS quality_score,
                  EXISTS (
                    SELECT 1
                    FROM agro_actions_detected stress_ev
                    JOIN sensors stress_sensor
                      ON stress_sensor.id = stress_ev.sensor_id
                     AND stress_sensor.device_id = stress_ev.device_id
                    WHERE stress_ev.owner_user_id = ev.owner_user_id
                      AND stress_ev.device_id = ev.device_id
                      AND stress_ev.context_id = ev.context_id
                      AND stress_ev.metric = ev.metric
                      AND stress_ev.event_type IN ('out_of_range','worsening','anomaly','regime_shift','sensor_drift')
                      AND stress_ev.started_at > COALESCE(ev.ended_at, ev.started_at)
                      AND stress_ev.started_at <= COALESCE(ev.ended_at, ev.started_at)
                          + INTERVAL '${RM.RELAPSE_MINUTES} minutes'
                  ) AS relapsed
           FROM agro_actions_detected ev
           LEFT JOIN devices d ON d.id = ev.device_id
           LEFT JOIN users du ON du.id = d.user_id
           LEFT JOIN sensors s ON s.id = ev.sensor_id
           LEFT JOIN agro_context_segments c ON c.id = ev.context_id
           LEFT JOIN agro_actions_detected linked ON linked.id = ev.linked_out_of_range_id
           LEFT JOIN LATERAL (
             SELECT CASE WHEN raw.raw_duration IS NULL THEN NULL ELSE GREATEST(raw.raw_duration, 0) END
                      AS resolved_duration_seconds
             FROM (
               SELECT COALESCE(
                 ev.duration_seconds::float8,
                 CASE WHEN ev.event_type = 'recovery'
                        AND COALESCE(ev.evidence_json->>'recovery_duration_minutes', '') ~ '^[0-9]+([.][0-9]+)?$'
                   THEN (ev.evidence_json->>'recovery_duration_minutes')::float8 * 60 ELSE NULL END,
                 CASE WHEN ev.event_type = 'return_to_range'
                        AND linked.event_type = 'out_of_range'
                        AND linked.owner_user_id = ev.owner_user_id
                        AND linked.device_id = ev.device_id
                        AND linked.sensor_id = ev.sensor_id
                        AND linked.context_id = ev.context_id
                        AND linked.metric = ev.metric
                   THEN linked.duration_seconds::float8 ELSE NULL END,
                 CASE WHEN ev.ended_at IS NOT NULL AND ev.ended_at >= ev.started_at
                   THEN EXTRACT(EPOCH FROM (ev.ended_at - ev.started_at))::float8 ELSE NULL END
               ) AS raw_duration
             ) raw
           ) duration ON TRUE
           WHERE ${where.join(' AND ')}
         ),
         eligible AS (
           SELECT * FROM candidates WHERE ${productionEligible}
         ),
         grouped AS (
           SELECT owner_user_id, device_id, context_id, metric,
                  COUNT(*)::integer AS recovery_count,
                  MIN(started_at) AS first_seen_at, MAX(started_at) AS last_seen_at,
                  COUNT(resolved_duration_seconds)::integer AS duration_sample_count,
                  COALESCE(AVG(resolved_duration_seconds), 0)::float8 AS average_recovery_duration,
                  COALESCE(MIN(resolved_duration_seconds), 0)::float8 AS min_recovery_duration,
                  COALESCE(MAX(resolved_duration_seconds), 0)::float8 AS max_recovery_duration,
                  COALESCE(STDDEV_POP(resolved_duration_seconds), 0)::float8 AS duration_stddev,
                  AVG(quality_score)::float8 AS recovery_quality_score,
                  COALESCE(STDDEV_POP(quality_score), 0)::float8 AS quality_stddev,
                  COUNT(*) FILTER (WHERE relapsed)::integer AS relapse_count,
                  COUNT(*) FILTER (WHERE resolved_duration_seconds <= ${fastSeconds})::integer AS fast_count,
                  COUNT(*) FILTER (WHERE resolved_duration_seconds > ${fastSeconds})::integer AS slow_count,
                  COUNT(DISTINCT date_trunc('day', started_at))::integer AS distinct_days,
                  COUNT(DISTINCT sensor_id)::integer AS distinct_sensor_count,
                  jsonb_build_object(
                    'recovery', COUNT(*) FILTER (WHERE event_type = 'recovery'),
                    'return_to_range', COUNT(*) FILTER (WHERE event_type = 'return_to_range'),
                    'stabilization', COUNT(*) FILTER (WHERE event_type = 'stabilization'),
                    'improvement', COUNT(*) FILTER (WHERE event_type = 'improvement')
                  ) AS event_type_distribution_json
           FROM eligible
           GROUP BY owner_user_id, device_id, context_id, metric
         ),
         audit AS (
           SELECT COUNT(*)::integer AS recovery_source_events,
                  COUNT(*) FILTER (WHERE context_id IS NULL OR context_match_id IS NULL)::integer AS skipped_missing_context,
                  COUNT(*) FILTER (
                    WHERE context_match_id IS NOT NULL AND (
                      owner_user_id IS NULL OR device_id IS NULL
                      OR canonical_owner_user_id IS DISTINCT FROM owner_user_id
                      OR sensor_match_id IS NULL OR sensor_device_id IS DISTINCT FROM device_id
                      OR context_owner_user_id IS DISTINCT FROM owner_user_id
                      OR context_device_id IS DISTINCT FROM device_id
                    )
                  )::integer AS skipped_invalid_identity,
                  COUNT(*) FILTER (WHERE ${excludedNonProduction})::integer AS skipped_non_production
           FROM candidates
         )
         SELECT audit.*,
                COALESCE(
                  (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.owner_user_id, g.device_id, g.context_id, g.metric)
                   FROM grouped g),
                  '[]'::jsonb
                ) AS groups
         FROM audit`,
        params
    );
    const result = rows[0] || {};
    const groups = typeof result.groups === 'string' ? JSON.parse(result.groups) : result.groups;
    return {
        groups: Array.isArray(groups) ? groups : [],
        audit: {
            recovery_source_events: Number(result.recovery_source_events || 0),
            skipped_missing_context: Number(result.skipped_missing_context || 0),
            skipped_invalid_identity: Number(result.skipped_invalid_identity || 0),
            skipped_non_production: Number(result.skipped_non_production || 0)
        }
    };
}

async function upsertRecoveryMemory(group, memory, executor = query) {
    const identity = assertRecoveryIdentity(group, 'recovery-memory-upsert');
    await executor(
        `INSERT INTO agro_recovery_memory
            (owner_user_id, device_id, context_id, metric, recovery_count,
             first_seen_at, last_seen_at, average_recovery_duration, min_recovery_duration,
             max_recovery_duration, recovery_quality_score, recovery_stability_score,
             relapse_rate, fast_recovery_rate, slow_recovery_rate, confidence,
             maturity_level, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, metric) DO UPDATE SET
             recovery_count=EXCLUDED.recovery_count, first_seen_at=EXCLUDED.first_seen_at,
             last_seen_at=EXCLUDED.last_seen_at,
             average_recovery_duration=EXCLUDED.average_recovery_duration,
             min_recovery_duration=EXCLUDED.min_recovery_duration,
             max_recovery_duration=EXCLUDED.max_recovery_duration,
             recovery_quality_score=EXCLUDED.recovery_quality_score,
             recovery_stability_score=EXCLUDED.recovery_stability_score,
             relapse_rate=EXCLUDED.relapse_rate,
             fast_recovery_rate=EXCLUDED.fast_recovery_rate,
             slow_recovery_rate=EXCLUDED.slow_recovery_rate,
             confidence=EXCLUDED.confidence, maturity_level=EXCLUDED.maturity_level,
             evidence_json=EXCLUDED.evidence_json, rule_version=EXCLUDED.rule_version,
             updated_at=NOW()
         RETURNING id`,
        [
            identity.owner_user_id, identity.device_id, identity.context_id, identity.metric,
            memory.recovery_count, memory.first_seen_at, memory.last_seen_at,
            memory.average_recovery_duration, memory.min_recovery_duration, memory.max_recovery_duration,
            memory.recovery_quality_score, memory.recovery_stability_score, memory.relapse_rate,
            memory.fast_recovery_rate, memory.slow_recovery_rate, memory.confidence,
            memory.maturity_level, JSON.stringify(memory.evidence), RULE_VERSION
        ]
    );
}

async function deleteStaleRecoveryMemory({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    const targetWhere = [];
    const params = [];
    if (normalizedScope && normalizedScope.deviceId) {
        targetWhere.push('rm.device_id = ?');
        params.push(normalizedScope.deviceId);
    }
    if (normalizedScope && normalizedScope.ownerUserId) {
        targetWhere.push('rm.owner_user_id = ?');
        params.push(normalizedScope.ownerUserId);
    }
    const productionClause = includeNonProduction
        ? ''
        : `AND c.is_production = TRUE
           AND lower(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')`;
    const rows = await executor(
        `WITH removed AS (
           DELETE FROM agro_recovery_memory rm
           WHERE ${targetWhere.length ? `${targetWhere.join(' AND ')} AND` : ''}
             NOT EXISTS (
               SELECT 1
               FROM agro_actions_detected ev
               JOIN devices d ON d.id = ev.device_id
               JOIN users du ON du.id = d.user_id
               JOIN sensors s ON s.id = ev.sensor_id AND s.device_id = ev.device_id
               JOIN agro_context_segments c ON c.id = ev.context_id
               WHERE ev.owner_user_id = rm.owner_user_id
                 AND ev.device_id = rm.device_id
                 AND ev.context_id = rm.context_id
                 AND ev.metric = rm.metric
                 AND ev.event_type IN ('recovery','return_to_range','stabilization','improvement')
                 AND COALESCE(du.owner_user_id, du.id) = ev.owner_user_id
                 AND c.owner_user_id = ev.owner_user_id AND c.device_id = ev.device_id
                 ${productionClause}
             )
           RETURNING 1
         )
         SELECT COUNT(*)::integer AS removed FROM removed`,
        params
    );
    return Number(rows[0] && rows[0].removed) || 0;
}

async function runRecoveryMemoryCycle({
    now = new Date(), scope = null, includeNonProduction = false, dryRun = false, executor = query
} = {}) {
    const clock = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(clock.getTime())) { throw new Error('[recovery-memory] invalid now timestamp'); }
    const loaded = await loadRecoveryGroups({ scope, includeNonProduction, executor });
    const summary = {
        groups: loaded.groups.length,
        stored: 0,
        by_maturity: { cold_start: 0, learning: 0, stable: 0, mature: 0 },
        ...loaded.audit,
        dry_run: dryRun
    };
    const rows = [];
    for (const group of loaded.groups) {
        const identity = assertRecoveryIdentity(group, 'recovery-memory-group');
        const memory = computeRecoveryMemory(group, clock.getTime());
        summary.by_maturity[memory.maturity_level] += 1;
        rows.push({ key: identity, ...memory });
        if (!dryRun) { await upsertRecoveryMemory(group, memory, executor); }
        summary.stored += 1;
    }
    summary.removed_stale = dryRun
        ? 0
        : await deleteStaleRecoveryMemory({ scope, includeNonProduction, executor });
    return dryRun ? { ...summary, rows } : summary;
}

module.exports = {
    ensureRecoveryMemorySchema,
    runRecoveryMemoryCycle,
    loadRecoveryGroups,
    upsertRecoveryMemory,
    deleteStaleRecoveryMemory,
    computeRecoveryMemory,
    recoveryQualityScore,
    maturityLevel,
    assertRecoveryIdentity,
    RECOVERY_EVENT_TYPES,
    STRESS_OUTCOME_TYPES,
    NON_PRODUCTION_USAGE,
    QUALITY_DEFAULTS,
    RM,
    RULE_VERSION
};
