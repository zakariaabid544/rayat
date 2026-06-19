// Rayat Intelligence - Sprint 3.2 Stress Memory Engine (local, context-aware).
// Aggregation unit: owner_user_id + device_id + context_id + metric + stress_type.
// Reads Sprint 1 events and writes only agro_stress_memory.
'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's3.2';
const STRESS_EVENT_TYPES = Object.freeze([
    'out_of_range', 'worsening', 'anomaly', 'regime_shift', 'sensor_drift'
]);
const NON_PRODUCTION_USAGE = Object.freeze(['demo', 'test', 'calibration', 'maintenance']);
const SEVERITY_SCORES = Object.freeze({ info: 0.1, low: 0.25, medium: 0.5, high: 0.75, critical: 1 });

function positiveInteger(value, fallback) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

const SM = {
    RECURRENCE_COUNT_REF: positiveInteger(process.env.AGRO_SM_RECURRENCE_COUNT_REF, 20),
    RECURRENCE_DAILY_REF: positiveInteger(process.env.AGRO_SM_RECURRENCE_DAILY_REF, 2),
    LOAD_COUNT_REF: positiveInteger(process.env.AGRO_SM_LOAD_COUNT_REF, 20),
    LOAD_DURATION_HOURS_REF: positiveInteger(process.env.AGRO_SM_LOAD_DURATION_HOURS_REF, 72),
    CONF_COUNT_REF: positiveInteger(process.env.AGRO_SM_CONF_COUNT_REF, 30),
    RECENCY_REF_DAYS: positiveInteger(process.env.AGRO_SM_RECENCY_DAYS, 30),
    MIN_LEARNING_EVENTS: positiveInteger(process.env.AGRO_SM_MIN_LEARNING, 3),
    STABLE_EVENTS: positiveInteger(process.env.AGRO_SM_STABLE_EVENTS, 10),
    MATURE_EVENTS: positiveInteger(process.env.AGRO_SM_MATURE_EVENTS, 25),
    STABLE_DAYS: positiveInteger(process.env.AGRO_SM_STABLE_DAYS, 3),
    MATURE_DAYS: positiveInteger(process.env.AGRO_SM_MATURE_DAYS, 7)
};

function severityScore(severity) {
    const normalized = String(severity || 'info').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SEVERITY_SCORES, normalized)
        ? SEVERITY_SCORES[normalized]
        : SEVERITY_SCORES.info;
}

function assertStressIdentity(identity, label = 'stress-memory') {
    const owner = positiveInteger(identity && identity.owner_user_id, null);
    const device = positiveInteger(identity && identity.device_id, null);
    const context = positiveInteger(identity && identity.context_id, null);
    const metric = String((identity && identity.metric) || '').trim();
    const stressType = String((identity && identity.stress_type) || '').trim().toLowerCase();
    if (!owner || !device || !context || !metric || !STRESS_EVENT_TYPES.includes(stressType)) {
        throw new Error(`[${label}] unresolved or unsupported owner/device/context/metric/stress identity`);
    }
    return { owner_user_id: owner, device_id: device, context_id: context, metric, stress_type: stressType };
}

async function constraintExists(executor, constraintName) {
    const rows = await executor(
        `SELECT 1 FROM pg_constraint
         WHERE conrelid = 'agro_stress_memory'::regclass AND conname = ? LIMIT 1`,
        [constraintName]
    );
    return rows.length > 0;
}

async function addConstraint(executor, constraintName, definition) {
    if (!await constraintExists(executor, constraintName)) {
        await executor(`ALTER TABLE agro_stress_memory ADD CONSTRAINT ${constraintName} ${definition}`);
    }
}

async function ensureStressMemorySchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_stress_memory (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL,
           metric VARCHAR(80) NOT NULL,
           stress_type VARCHAR(40) NOT NULL,
           stress_count INTEGER NOT NULL DEFAULT 0,
           first_seen_at TIMESTAMPTZ NOT NULL,
           last_seen_at TIMESTAMPTZ NOT NULL,
           total_duration_seconds NUMERIC(16,3) NOT NULL DEFAULT 0,
           average_duration_seconds NUMERIC(16,3) NOT NULL DEFAULT 0,
           max_duration_seconds NUMERIC(16,3) NOT NULL DEFAULT 0,
           severity_distribution_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           average_severity_score NUMERIC(5,4) NOT NULL DEFAULT 0,
           max_severity_score NUMERIC(5,4) NOT NULL DEFAULT 0,
           recurrence_score NUMERIC(5,4) NOT NULL DEFAULT 0,
           stress_load_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           trend_direction VARCHAR(10) NOT NULL DEFAULT 'stable',
           confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           maturity_level VARCHAR(12) NOT NULL DEFAULT 'cold_start',
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's3.2',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_stress_memory
             UNIQUE (owner_user_id, device_id, context_id, metric, stress_type),
           CONSTRAINT agro_stress_memory_context_fk
             FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           CONSTRAINT agro_stress_memory_values_check CHECK (
             stress_count > 0
             AND total_duration_seconds >= 0 AND average_duration_seconds >= 0 AND max_duration_seconds >= 0
             AND average_severity_score BETWEEN 0 AND 1 AND max_severity_score BETWEEN 0 AND 1
             AND recurrence_score BETWEEN 0 AND 1 AND stress_load_score BETWEEN 0 AND 100
             AND confidence BETWEEN 0 AND 1
             AND trend_direction IN ('rising','stable','declining')
             AND maturity_level IN ('cold_start','learning','stable','mature')
             AND stress_type IN ('out_of_range','worsening','anomaly','regime_shift','sensor_drift')
             AND btrim(metric) <> ''
           )
         )`
    );

    const invalid = await executor(
        `SELECT COUNT(*) AS count
         FROM agro_stress_memory sm
         LEFT JOIN devices d ON d.id = sm.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = sm.context_id
         WHERE sm.owner_user_id IS NULL OR sm.device_id IS NULL OR sm.context_id IS NULL
            OR sm.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM sm.owner_user_id
            OR c.device_id IS DISTINCT FROM sm.device_id`
    );
    if (Number(invalid[0] && invalid[0].count) > 0) {
        throw new Error('[stress-memory-schema] existing rows have invalid tenant/context identity');
    }

    await addConstraint(
        executor,
        'agro_stress_memory_context_fk',
        'FOREIGN KEY (context_id) REFERENCES agro_context_segments(id) ON DELETE RESTRICT'
    );
    await addConstraint(
        executor,
        'agro_stress_memory_values_check',
        `CHECK (
          stress_count > 0
          AND total_duration_seconds >= 0 AND average_duration_seconds >= 0 AND max_duration_seconds >= 0
          AND average_severity_score BETWEEN 0 AND 1 AND max_severity_score BETWEEN 0 AND 1
          AND recurrence_score BETWEEN 0 AND 1 AND stress_load_score BETWEEN 0 AND 100
          AND confidence BETWEEN 0 AND 1
          AND trend_direction IN ('rising','stable','declining')
          AND maturity_level IN ('cold_start','learning','stable','mature')
          AND stress_type IN ('out_of_range','worsening','anomaly','regime_shift','sensor_drift')
          AND btrim(metric) <> ''
        )`
    );

    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_stress_memory_identity()
         RETURNS trigger AS $$
         DECLARE
           expected_owner INTEGER;
           context_owner INTEGER;
           context_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'stress memory identity cannot be NULL';
           END IF;
           SELECT COALESCE(u.owner_user_id, u.id)
             INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id
            WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id
             INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'stress memory owner_user_id does not own device_id';
           END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'stress memory context_id does not belong to owner/device';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`
    );
    const trigger = await executor(
        `SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'agro_stress_memory'::regclass
           AND tgname = 'agro_stress_memory_identity_guard' AND NOT tgisinternal`
    );
    if (!trigger.length) {
        await executor(
            `CREATE TRIGGER agro_stress_memory_identity_guard
             BEFORE INSERT OR UPDATE ON agro_stress_memory
             FOR EACH ROW EXECUTE FUNCTION rayat_assert_stress_memory_identity()`
        );
    }
    await executor('CREATE INDEX IF NOT EXISTS idx_stress_memory_context ON agro_stress_memory (context_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_stress_memory_device ON agro_stress_memory (device_id)');
    await executor('CREATE INDEX IF NOT EXISTS idx_stress_memory_type_last ON agro_stress_memory (stress_type, last_seen_at DESC)');
}

function normalizeScope(scope) {
    if (!scope) { return null; }
    const ownerUserId = scope.ownerUserId == null ? null : positiveInteger(scope.ownerUserId, null);
    const deviceId = scope.deviceId == null ? null : positiveInteger(scope.deviceId, null);
    if ((scope.ownerUserId != null && !ownerUserId) || (scope.deviceId != null && !deviceId)) {
        throw new Error('[stress-memory] invalid owner/device scope');
    }
    return { ownerUserId, deviceId };
}

function trendDirection(olderCount, recentCount) {
    const older = Math.max(0, Number(olderCount) || 0);
    const recent = Math.max(0, Number(recentCount) || 0);
    if (older + recent < 4 || Math.abs(recent - older) < 2) { return 'stable'; }
    if (recent >= Math.max(1, older) * 1.25) { return 'rising'; }
    if (older >= Math.max(1, recent) * 1.25) { return 'declining'; }
    return 'stable';
}

function maturityLevel(eventCount, distinctDays) {
    const count = Number(eventCount);
    const days = Number(distinctDays);
    if (count < SM.MIN_LEARNING_EVENTS) { return 'cold_start'; }
    if (count < SM.STABLE_EVENTS || days < SM.STABLE_DAYS) { return 'learning'; }
    if (count >= SM.MATURE_EVENTS && days >= SM.MATURE_DAYS) { return 'mature'; }
    return 'stable';
}

function computeStressMemory(group, nowMs) {
    const count = Number(group.stress_count);
    const distinctDays = Number(group.distinct_days);
    const totalDuration = C.num(group.total_duration_seconds);
    const averageDuration = C.num(group.average_duration_seconds);
    const maxDuration = C.num(group.max_duration_seconds);
    const averageSeverity = C.num(group.average_severity_score);
    const maxSeverity = C.num(group.max_severity_score);
    const severityStddev = C.num(group.severity_stddev);
    const firstSeenMs = new Date(group.first_seen_at).getTime();
    const lastSeenMs = new Date(group.last_seen_at).getTime();
    const clockMs = Number(nowMs);
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(distinctDays) || distinctDays <= 0
        || [totalDuration, averageDuration, maxDuration, averageSeverity, maxSeverity, severityStddev].some((value) => value === null)
        || !Number.isFinite(firstSeenMs) || !Number.isFinite(lastSeenMs) || !Number.isFinite(clockMs)) {
        throw new Error('[stress-memory] invalid aggregate statistics');
    }

    const spanDays = Math.max(1, C.daysBetween(lastSeenMs, firstSeenMs));
    const recencyDays = Math.max(0, (clockMs - lastSeenMs) / C.DAY_MS);
    const recency = C.recencyFactor(recencyDays, SM.RECENCY_REF_DAYS);
    const countFactor = C.normLog(count, SM.RECURRENCE_COUNT_REF);
    const dailyRate = count / spanDays;
    const densityFactor = C.clamp01(dailyRate / SM.RECURRENCE_DAILY_REF);
    const activeDaysFactor = C.clamp01(distinctDays / SM.MATURE_DAYS);
    const recurrence = C.clamp01(0.5 * countFactor + 0.3 * densityFactor + 0.2 * activeDaysFactor);

    const loadCount = C.normLog(count, SM.LOAD_COUNT_REF);
    const loadDuration = C.normLog(totalDuration / 3600, SM.LOAD_DURATION_HOURS_REF);
    const stressLoad = 100 * C.clamp01(
        0.25 * loadCount + 0.25 * loadDuration + 0.3 * averageSeverity + 0.2 * recency
    );

    const confidenceCount = C.normLog(count, SM.CONF_COUNT_REF);
    const contextCoverage = C.clamp01(distinctDays / SM.MATURE_DAYS);
    const severityConsistency = C.clamp01(1 - severityStddev / Math.max(averageSeverity, 0.1));
    const confidence = C.clamp01(
        0.45 * confidenceCount + 0.2 * contextCoverage + 0.2 * recency + 0.15 * severityConsistency
    );
    const trend = firstSeenMs === lastSeenMs
        ? 'stable'
        : trendDirection(group.older_count, group.recent_count);
    const maturity = maturityLevel(count, distinctDays);
    const severityDistribution = typeof group.severity_distribution_json === 'string'
        ? JSON.parse(group.severity_distribution_json)
        : group.severity_distribution_json;

    return {
        stress_count: count,
        first_seen_at: group.first_seen_at,
        last_seen_at: group.last_seen_at,
        total_duration_seconds: C.round3(totalDuration),
        average_duration_seconds: C.round3(averageDuration),
        max_duration_seconds: C.round3(maxDuration),
        severity_distribution_json: severityDistribution || {},
        average_severity_score: C.round3(averageSeverity),
        max_severity_score: C.round3(maxSeverity),
        recurrence_score: C.round3(recurrence),
        stress_load_score: C.round1(stressLoad),
        trend_direction: trend,
        confidence: C.round3(confidence),
        maturity_level: maturity,
        evidence: {
            rule_version: RULE_VERSION,
            aggregation_key: ['owner_user_id', 'device_id', 'context_id', 'metric', 'stress_type'],
            source_event_types: STRESS_EVENT_TYPES,
            event_count: count,
            distinct_days: distinctDays,
            distinct_sensor_count: Number(group.distinct_sensor_count),
            span_days: C.round3(spanDays),
            duration_resolution: ['duration_seconds', 'ended_at_minus_started_at', 'zero'],
            severity_mapping: SEVERITY_SCORES,
            recurrence: {
                score: C.round3(recurrence),
                weights: { event_count: 0.5, daily_density: 0.3, active_days: 0.2 },
                factors: {
                    event_count: C.round3(countFactor), daily_density: C.round3(densityFactor),
                    active_days: C.round3(activeDaysFactor), daily_rate: C.round3(dailyRate)
                }
            },
            stress_load: {
                score: C.round1(stressLoad),
                weights: { event_count: 0.25, duration: 0.25, average_severity: 0.3, recency: 0.2 },
                factors: {
                    event_count: C.round3(loadCount), duration: C.round3(loadDuration),
                    average_severity: C.round3(averageSeverity), recency: C.round3(recency)
                }
            },
            trend: {
                direction: trend, method: 'equal_time_halves',
                older_count: Number(group.older_count), recent_count: Number(group.recent_count)
            },
            confidence: {
                score: C.round3(confidence),
                weights: { event_count: 0.45, context_coverage: 0.2, recency: 0.2, severity_consistency: 0.15 },
                factors: {
                    event_count: C.round3(confidenceCount), context_coverage: C.round3(contextCoverage),
                    recency: C.round3(recency), severity_consistency: C.round3(severityConsistency)
                }
            },
            maturity: {
                level: maturity,
                thresholds: {
                    learning_events: SM.MIN_LEARNING_EVENTS, stable_events: SM.STABLE_EVENTS,
                    mature_events: SM.MATURE_EVENTS, stable_days: SM.STABLE_DAYS, mature_days: SM.MATURE_DAYS
                }
            },
            recency_days: Math.round(recencyDays),
            privacy: { contains_raw_evidence: false, cross_tenant_evidence: false }
        }
    };
}

async function loadStressGroups({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    const where = [
        "ev.event_type IN ('out_of_range','worsening','anomaly','regime_shift','sensor_drift')",
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

    const rows = await executor(
        `WITH candidates AS (
           SELECT ev.id AS event_id, ev.owner_user_id, ev.device_id, ev.sensor_id, ev.context_id,
                  ev.metric, ev.event_type AS stress_type, ev.started_at,
                  COALESCE(du.owner_user_id, du.id) AS canonical_owner_user_id,
                  s.id AS sensor_match_id, s.device_id AS sensor_device_id,
                  c.id AS context_match_id, c.owner_user_id AS context_owner_user_id,
                  c.device_id AS context_device_id, c.is_production, c.usage_type,
                  GREATEST(COALESCE(
                    ev.duration_seconds::float8,
                    CASE WHEN ev.ended_at IS NOT NULL AND ev.ended_at >= ev.started_at
                      THEN EXTRACT(EPOCH FROM (ev.ended_at - ev.started_at))::float8 ELSE 0 END
                  ), 0) AS resolved_duration_seconds,
                  CASE lower(COALESCE(ev.severity, 'info'))
                    WHEN 'info' THEN 0.1 WHEN 'low' THEN 0.25 WHEN 'medium' THEN 0.5
                    WHEN 'high' THEN 0.75 WHEN 'critical' THEN 1.0 ELSE 0.1 END AS severity_score,
                  CASE WHEN lower(COALESCE(ev.severity, 'info')) IN ('info','low','medium','high','critical')
                    THEN lower(COALESCE(ev.severity, 'info')) ELSE 'unknown' END AS severity_label
           FROM agro_actions_detected ev
           LEFT JOIN devices d ON d.id = ev.device_id
           LEFT JOIN users du ON du.id = d.user_id
           LEFT JOIN sensors s ON s.id = ev.sensor_id
           LEFT JOIN agro_context_segments c ON c.id = ev.context_id
           WHERE ${where.join(' AND ')}
         ),
         eligible AS (
           SELECT * FROM candidates WHERE ${productionEligible}
         ),
         bounds AS (
           SELECT owner_user_id, device_id, context_id, metric, stress_type,
                  MIN(started_at) AS first_seen_at, MAX(started_at) AS last_seen_at
           FROM eligible
           GROUP BY owner_user_id, device_id, context_id, metric, stress_type
         ),
         grouped AS (
           SELECT e.owner_user_id, e.device_id, e.context_id, e.metric, e.stress_type,
                  COUNT(*)::integer AS stress_count,
                  b.first_seen_at, b.last_seen_at,
                  SUM(e.resolved_duration_seconds)::float8 AS total_duration_seconds,
                  AVG(e.resolved_duration_seconds)::float8 AS average_duration_seconds,
                  MAX(e.resolved_duration_seconds)::float8 AS max_duration_seconds,
                  jsonb_build_object(
                    'info', COUNT(*) FILTER (WHERE e.severity_label = 'info'),
                    'low', COUNT(*) FILTER (WHERE e.severity_label = 'low'),
                    'medium', COUNT(*) FILTER (WHERE e.severity_label = 'medium'),
                    'high', COUNT(*) FILTER (WHERE e.severity_label = 'high'),
                    'critical', COUNT(*) FILTER (WHERE e.severity_label = 'critical'),
                    'unknown', COUNT(*) FILTER (WHERE e.severity_label = 'unknown')
                  ) AS severity_distribution_json,
                  AVG(e.severity_score)::float8 AS average_severity_score,
                  MAX(e.severity_score)::float8 AS max_severity_score,
                  COALESCE(STDDEV_POP(e.severity_score), 0)::float8 AS severity_stddev,
                  COUNT(DISTINCT date_trunc('day', e.started_at))::integer AS distinct_days,
                  COUNT(DISTINCT e.sensor_id)::integer AS distinct_sensor_count,
                  COUNT(*) FILTER (
                    WHERE e.started_at < b.first_seen_at + ((b.last_seen_at - b.first_seen_at) / 2)
                  )::integer AS older_count,
                  COUNT(*) FILTER (
                    WHERE e.started_at >= b.first_seen_at + ((b.last_seen_at - b.first_seen_at) / 2)
                  )::integer AS recent_count
           FROM eligible e
           JOIN bounds b USING (owner_user_id, device_id, context_id, metric, stress_type)
           GROUP BY e.owner_user_id, e.device_id, e.context_id, e.metric, e.stress_type,
                    b.first_seen_at, b.last_seen_at
         ),
         audit AS (
           SELECT COUNT(*)::integer AS stress_source_events,
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
                  (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.owner_user_id, g.device_id, g.context_id, g.metric, g.stress_type)
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
            stress_source_events: Number(result.stress_source_events || 0),
            skipped_missing_context: Number(result.skipped_missing_context || 0),
            skipped_invalid_identity: Number(result.skipped_invalid_identity || 0),
            skipped_non_production: Number(result.skipped_non_production || 0)
        }
    };
}

async function upsertStressMemory(group, memory, executor = query) {
    const identity = assertStressIdentity(group, 'stress-memory-upsert');
    await executor(
        `INSERT INTO agro_stress_memory
            (owner_user_id, device_id, context_id, metric, stress_type, stress_count,
             first_seen_at, last_seen_at, total_duration_seconds, average_duration_seconds,
             max_duration_seconds, severity_distribution_json, average_severity_score,
             max_severity_score, recurrence_score, stress_load_score, trend_direction,
             confidence, maturity_level, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, metric, stress_type) DO UPDATE SET
             stress_count=EXCLUDED.stress_count, first_seen_at=EXCLUDED.first_seen_at,
             last_seen_at=EXCLUDED.last_seen_at, total_duration_seconds=EXCLUDED.total_duration_seconds,
             average_duration_seconds=EXCLUDED.average_duration_seconds,
             max_duration_seconds=EXCLUDED.max_duration_seconds,
             severity_distribution_json=EXCLUDED.severity_distribution_json,
             average_severity_score=EXCLUDED.average_severity_score,
             max_severity_score=EXCLUDED.max_severity_score,
             recurrence_score=EXCLUDED.recurrence_score, stress_load_score=EXCLUDED.stress_load_score,
             trend_direction=EXCLUDED.trend_direction, confidence=EXCLUDED.confidence,
             maturity_level=EXCLUDED.maturity_level, evidence_json=EXCLUDED.evidence_json,
             rule_version=EXCLUDED.rule_version, updated_at=NOW()
         RETURNING id`,
        [
            identity.owner_user_id, identity.device_id, identity.context_id, identity.metric, identity.stress_type,
            memory.stress_count, memory.first_seen_at, memory.last_seen_at,
            memory.total_duration_seconds, memory.average_duration_seconds, memory.max_duration_seconds,
            JSON.stringify(memory.severity_distribution_json), memory.average_severity_score,
            memory.max_severity_score, memory.recurrence_score, memory.stress_load_score,
            memory.trend_direction, memory.confidence, memory.maturity_level,
            JSON.stringify(memory.evidence), RULE_VERSION
        ]
    );
}

async function deleteStaleStressMemory({ scope = null, includeNonProduction = false, executor = query } = {}) {
    const normalizedScope = normalizeScope(scope);
    const targetWhere = [];
    const params = [];
    if (normalizedScope && normalizedScope.deviceId) {
        targetWhere.push('sm.device_id = ?');
        params.push(normalizedScope.deviceId);
    }
    if (normalizedScope && normalizedScope.ownerUserId) {
        targetWhere.push('sm.owner_user_id = ?');
        params.push(normalizedScope.ownerUserId);
    }
    const productionClause = includeNonProduction
        ? ''
        : `AND c.is_production = TRUE
           AND lower(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')`;
    const rows = await executor(
        `WITH removed AS (
           DELETE FROM agro_stress_memory sm
           WHERE ${targetWhere.length ? `${targetWhere.join(' AND ')} AND` : ''}
             NOT EXISTS (
               SELECT 1
               FROM agro_actions_detected ev
               JOIN devices d ON d.id = ev.device_id
               JOIN users du ON du.id = d.user_id
               JOIN sensors s ON s.id = ev.sensor_id AND s.device_id = ev.device_id
               JOIN agro_context_segments c ON c.id = ev.context_id
               WHERE ev.owner_user_id = sm.owner_user_id
                 AND ev.device_id = sm.device_id
                 AND ev.context_id = sm.context_id
                 AND ev.metric = sm.metric
                 AND ev.event_type = sm.stress_type
                 AND ev.event_type IN ('out_of_range','worsening','anomaly','regime_shift','sensor_drift')
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

async function runStressMemoryCycle({
    now = new Date(), scope = null, includeNonProduction = false, dryRun = false, executor = query
} = {}) {
    const clock = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(clock.getTime())) { throw new Error('[stress-memory] invalid now timestamp'); }
    const loaded = await loadStressGroups({ scope, includeNonProduction, executor });
    const summary = {
        groups: loaded.groups.length,
        stored: 0,
        by_trend: { rising: 0, stable: 0, declining: 0 },
        by_maturity: { cold_start: 0, learning: 0, stable: 0, mature: 0 },
        ...loaded.audit,
        dry_run: dryRun
    };
    const rows = [];
    for (const group of loaded.groups) {
        const identity = assertStressIdentity(group, 'stress-memory-group');
        const memory = computeStressMemory(group, clock.getTime());
        summary.by_trend[memory.trend_direction] += 1;
        summary.by_maturity[memory.maturity_level] += 1;
        rows.push({ key: identity, ...memory });
        if (!dryRun) { await upsertStressMemory(group, memory, executor); }
        summary.stored += 1;
    }
    summary.removed_stale = dryRun
        ? 0
        : await deleteStaleStressMemory({ scope, includeNonProduction, executor });
    return dryRun ? { ...summary, rows } : summary;
}

module.exports = {
    ensureStressMemorySchema,
    runStressMemoryCycle,
    loadStressGroups,
    upsertStressMemory,
    deleteStaleStressMemory,
    computeStressMemory,
    severityScore,
    trendDirection,
    maturityLevel,
    assertStressIdentity,
    STRESS_EVENT_TYPES,
    NON_PRODUCTION_USAGE,
    SEVERITY_SCORES,
    SM,
    RULE_VERSION
};
