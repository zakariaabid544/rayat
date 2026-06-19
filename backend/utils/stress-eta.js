'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's6.3';
const STRESS_TYPES = Object.freeze([
    'out_of_range', 'worsening', 'anomaly', 'regime_shift', 'sensor_drift'
]);
const STATUSES = Object.freeze([
    'no_stress_expected', 'stress_possible', 'stress_likely', 'stress_imminent',
    'already_under_stress', 'insufficient_data'
]);

function finite(value, fallback = null) {
    const parsed = C.num(value);
    return parsed === null ? fallback : parsed;
}

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertIdentity(value, label = 'stress-eta') {
    const identity = {
        owner_user_id: positiveInteger(value && value.owner_user_id),
        device_id: positiveInteger(value && value.device_id),
        context_id: positiveInteger(value && value.context_id),
        stress_type: String((value && value.stress_type) || '').trim().toLowerCase()
    };
    if (!identity.owner_user_id || !identity.device_id || !identity.context_id
        || !STRESS_TYPES.includes(identity.stress_type)) {
        throw new Error(`[${label}] unresolved owner/device/context/stress identity`);
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

function breachWeight(status) {
    return ({
        already_breached: 1,
        breach_likely: 0.85,
        breach_possible: 0.62,
        no_breach_expected: 0,
        insufficient_data: 0
    })[status] ?? 0;
}

function trendWeight(direction) {
    return ({ degrading: 1, volatile: 0.7, stable: 0.3, improving: 0.05,
        insufficient_data: 0.35, rising: 1, declining: 0.05 })[direction] ?? 0.3;
}

function severityFor(status, probability, etaMinutes) {
    if (status === 'insufficient_data') { return 'unknown'; }
    if (status === 'no_stress_expected') { return 'low'; }
    if (status === 'already_under_stress') { return probability >= 0.85 ? 'critical' : 'high'; }
    if (status === 'stress_imminent') { return probability >= 0.8 || etaMinutes <= 60 ? 'critical' : 'high'; }
    if (status === 'stress_likely') { return probability >= 0.8 ? 'high' : 'medium'; }
    return probability >= 0.55 ? 'medium' : 'low';
}

function aggregateForecasts(rows) {
    const forecasts = parseArray(rows);
    if (!forecasts.length) {
        return { available: false, confidence: 0, quality: 0, trajectory: 0, max_horizon: 1440 };
    }
    const trajectory = maxOf(forecasts.map((row) => {
        const current = finite(row.current_value);
        const predicted = finite(row.forecast_value);
        const confidence = C.clamp01(finite(row.confidence, 0));
        if (current === null || predicted === null) { return 0; }
        return C.clamp01(Math.abs(predicted - current) / Math.max(Math.abs(current), 1)) * confidence;
    }));
    return {
        available: true,
        confidence: C.clamp01(average(forecasts.map((row) => row.confidence))),
        quality: C.clamp01(average(forecasts.map((row) => row.data_quality_score))),
        trajectory: C.clamp01(trajectory),
        max_horizon: Math.max(...forecasts.map((row) => Number(row.horizon_minutes) || 0), 1440)
    };
}

function aggregateMemory(rows, stressType) {
    const memories = parseArray(rows).filter((row) => row.stress_type === stressType);
    if (!memories.length) {
        return { available: false, recurrence: 0, load: 0, trend: 0.3, confidence: 0, count: 0 };
    }
    return {
        available: true,
        recurrence: C.clamp01(maxOf(memories.map((row) => row.recurrence_score))),
        load: C.clamp01(maxOf(memories.map((row) => finite(row.stress_load_score, 0) / 100))),
        trend: maxOf(memories.map((row) => trendWeight(row.trend_direction)), 0.3),
        confidence: C.clamp01(average(memories.map((row) => row.confidence))),
        count: memories.reduce((sum, row) => sum + Math.max(0, Number(row.stress_count) || 0), 0)
    };
}

function aggregateTrends(rows) {
    const trends = parseArray(rows).filter((row) => ['intelligence_score', 'stress'].includes(row.metric));
    if (!trends.length) { return { available: false, deterioration: 0.35, confidence: 0 }; }
    let weighted = 0;
    let weights = 0;
    for (const trend of trends) {
        const confidence = C.clamp01(finite(trend.trend_confidence, 0));
        weighted += trendWeight(trend.trend_direction) * Math.max(confidence, 0.1);
        weights += Math.max(confidence, 0.1);
    }
    return {
        available: true,
        deterioration: C.clamp01(weights ? weighted / weights : 0.35),
        confidence: C.clamp01(average(trends.map((row) => row.trend_confidence)))
    };
}

function aggregateBaselines(rows) {
    const baselines = parseArray(rows);
    if (!baselines.length) { return { available: false, instability: 0.5, confidence: 0 }; }
    const instability = average(baselines.map((row) => {
        const mean = finite(row.mean_value);
        const stddev = Math.abs(finite(row.stddev_value, 0));
        return C.clamp01(stddev / Math.max(Math.abs(mean || 0), 1));
    }));
    return {
        available: true,
        instability: C.clamp01(instability),
        confidence: C.clamp01(average(baselines.map((row) => row.confidence)))
    };
}

function computeStressEta(input, stressType, generatedAt = new Date()) {
    const identity = assertIdentity({ ...input, stress_type: stressType }, 'stress-eta-input');
    const clock = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
    if (Number.isNaN(clock.getTime())) { throw new Error('[stress-eta] invalid generatedAt'); }

    const forecasts = aggregateForecasts(input.forecasts);
    const allBreaches = parseArray(input.breaches);
    const relevantBreaches = stressType === 'out_of_range'
        ? allBreaches
        : allBreaches.filter((row) => row.status !== 'already_breached');
    const memory = aggregateMemory(input.stress_memories, stressType);
    const trends = aggregateTrends(input.trends);
    const baselines = aggregateBaselines(input.baselines);
    const intelligenceScore = finite(input.intelligence_score && input.intelligence_score.intelligence_score);
    const intelligenceConfidence = C.clamp01(finite(input.intelligence_score && input.intelligence_score.confidence, 0));
    const intelligenceRisk = intelligenceScore === null ? 0.5 : C.clamp01(1 - intelligenceScore / 100);
    const directBreach = maxOf(relevantBreaches.map((row) => breachWeight(row.status)));
    const breachFactor = stressType === 'out_of_range' ? directBreach : directBreach * 0.55;
    const active = stressType === 'out_of_range'
        && relevantBreaches.some((row) => row.status === 'already_breached');
    const validEtas = relevantBreaches
        .filter((row) => ['breach_possible', 'breach_likely'].includes(row.status))
        .map((row) => finite(row.eta_minutes))
        .filter((value) => value !== null && value >= 0);
    const breachConfidence = C.clamp01(maxOf(relevantBreaches.map((row) => row.eta_confidence)));
    const currentScore = C.clamp01(
        0.32 * memory.load + 0.26 * memory.recurrence + 0.13 * memory.trend
        + 0.09 * trends.deterioration + 0.07 * baselines.instability + 0.13 * intelligenceRisk
    );
    const predictedScore = C.clamp01(
        0.20 * memory.load + 0.16 * memory.recurrence + 0.30 * breachFactor
        + 0.09 * forecasts.trajectory + 0.10 * trends.deterioration
        + 0.05 * baselines.instability + 0.10 * intelligenceRisk
    );
    let probability = C.clamp01(0.58 * predictedScore + 0.24 * breachFactor + 0.18 * currentScore);
    if (active) { probability = Math.max(probability, 0.88); }
    const confidenceFactors = [
        forecasts.confidence * 0.22, forecasts.quality * 0.13, breachConfidence * 0.20,
        memory.confidence * 0.16, baselines.confidence * 0.09, trends.confidence * 0.09,
        intelligenceConfidence * 0.11
    ];
    const confidence = C.clamp01(confidenceFactors.reduce((sum, value) => sum + value, 0));

    let etaMinutes = null;
    let status;
    if (!forecasts.available) {
        status = 'insufficient_data';
        probability = 0;
    } else if (active) {
        status = 'already_under_stress';
        etaMinutes = 0;
    } else {
        if (validEtas.length) {
            etaMinutes = Math.max(1, Math.round(Math.min(...validEtas) * (1 - 0.15 * memory.recurrence)));
        } else if (probability >= 0.4 && (memory.available || trends.available)) {
            etaMinutes = Math.max(60, Math.round(forecasts.max_horizon * (1 - probability)));
        }
        if (probability >= 0.7 && etaMinutes !== null && etaMinutes <= 180) { status = 'stress_imminent'; }
        else if (probability >= 0.65) { status = 'stress_likely'; }
        else if (probability >= 0.4) { status = 'stress_possible'; }
        else { status = 'no_stress_expected'; etaMinutes = null; }
    }

    const row = {
        ...identity,
        generated_at: clock.toISOString(),
        eta_minutes: etaMinutes,
        stress_probability: C.round3(probability),
        stress_confidence: C.round3(confidence),
        current_score: C.round1(active ? Math.max(currentScore * 100, 80) : currentScore * 100),
        predicted_score: C.round1(active ? Math.max(predictedScore * 100, 85) : predictedScore * 100),
        risk_factors_json: {
            breach_pressure: C.round3(breachFactor), recurrence: C.round3(memory.recurrence),
            stress_load: C.round3(memory.load), trend_deterioration: C.round3(trends.deterioration),
            baseline_instability: C.round3(baselines.instability), trajectory: C.round3(forecasts.trajectory),
            intelligence_risk: C.round3(intelligenceRisk)
        },
        status,
        severity: severityFor(status, probability, etaMinutes),
        evidence_json: {
            source_availability: {
                forecasts: forecasts.available, breach_eta: relevantBreaches.length > 0,
                stress_memory: memory.available, baselines: baselines.available,
                intelligence_score: Boolean(input.intelligence_score), trends: trends.available
            },
            aggregates: {
                forecast_confidence: C.round3(forecasts.confidence), forecast_quality: C.round3(forecasts.quality),
                breach_confidence: C.round3(breachConfidence), stress_events: memory.count,
                intelligence_score: intelligenceScore,
                intelligence_confidence: C.round3(intelligenceConfidence)
            },
            weights: {
                predicted: { load: 0.20, recurrence: 0.16, breach: 0.30, trajectory: 0.09,
                    trend: 0.10, instability: 0.05, intelligence_risk: 0.10 },
                probability: { predicted_score: 0.58, breach: 0.24, current_score: 0.18 }
            },
            reason: status,
            privacy: { raw_readings: false, raw_events: false, cross_tenant_evidence: false, fleet_dependency: false }
        },
        rule_version: RULE_VERSION
    };
    if (!STATUSES.includes(row.status)) { throw new Error('[stress-eta] unsupported status'); }
    return row;
}

async function ensureStressEtaSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_stress_eta (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           generated_at TIMESTAMPTZ NOT NULL,
           stress_type VARCHAR(40) NOT NULL,
           eta_minutes INTEGER NULL,
           stress_probability NUMERIC(5,4) NOT NULL,
           stress_confidence NUMERIC(5,4) NOT NULL,
           current_score NUMERIC(6,2) NOT NULL,
           predicted_score NUMERIC(6,2) NOT NULL,
           risk_factors_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           status VARCHAR(28) NOT NULL,
           severity VARCHAR(12) NOT NULL,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's6.3',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_stress_eta UNIQUE (owner_user_id, device_id, context_id, stress_type),
           CONSTRAINT stress_eta_values_check CHECK (
             stress_type IN ('out_of_range','worsening','anomaly','regime_shift','sensor_drift')
             AND (eta_minutes IS NULL OR eta_minutes >= 0)
             AND stress_probability BETWEEN 0 AND 1 AND stress_confidence BETWEEN 0 AND 1
             AND current_score BETWEEN 0 AND 100 AND predicted_score BETWEEN 0 AND 100
             AND status IN ('no_stress_expected','stress_possible','stress_likely','stress_imminent','already_under_stress','insufficient_data')
             AND severity IN ('low','medium','high','critical','unknown')
             AND jsonb_typeof(risk_factors_json) = 'object' AND jsonb_typeof(evidence_json) = 'object')
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count FROM agro_stress_eta e
         LEFT JOIN devices d ON d.id = e.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = e.context_id
         WHERE e.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM e.owner_user_id
            OR c.device_id IS DISTINCT FROM e.device_id`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[stress-eta-schema] existing rows have invalid tenant/context identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_stress_eta_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; context_owner INTEGER; context_device INTEGER;
         BEGIN
           SELECT COALESCE(u.owner_user_id, u.id) INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'stress ETA owner/device mismatch'; END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'stress ETA context mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS stress_eta_identity_guard ON agro_stress_eta');
    await executor(
        `CREATE TRIGGER stress_eta_identity_guard BEFORE INSERT OR UPDATE ON agro_stress_eta
         FOR EACH ROW EXECUTE FUNCTION rayat_assert_stress_eta_identity()`
    );
    await executor('CREATE INDEX IF NOT EXISTS idx_stress_eta_context_status ON agro_stress_eta (context_id, status, eta_minutes)');
    await executor('CREATE INDEX IF NOT EXISTS idx_stress_eta_generated ON agro_stress_eta (generated_at DESC)');
}

function normalizeScope(scope) {
    if (!scope) { return {}; }
    const result = {};
    for (const [key, source] of [['owner_user_id', 'ownerUserId'], ['device_id', 'deviceId'], ['context_id', 'contextId']]) {
        if (scope[source] != null) {
            const value = positiveInteger(scope[source]);
            if (!value) { throw new Error('[stress-eta] invalid scope'); }
            result[key] = value;
        }
    }
    return result;
}

function scopeSql(scope, alias, params) {
    return Object.entries(scope).map(([key, value]) => { params.push(value); return `${alias}.${key} = ?`; });
}

async function loadStressEtaInputs({
    generatedAt = new Date(), scope = null, includeNonProduction = false, executor = query
} = {}) {
    const clock = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
    if (Number.isNaN(clock.getTime())) { throw new Error('[stress-eta] invalid generatedAt'); }
    const normalized = normalizeScope(scope);
    const contextParams = [clock.toISOString(), clock.toISOString()];
    const clauses = [
        'c.valid_from <= CAST(? AS TIMESTAMPTZ)',
        '(c.valid_to IS NULL OR c.valid_to > CAST(? AS TIMESTAMPTZ))',
        'c.owner_user_id = COALESCE(u.owner_user_id, u.id)',
        'c.device_id = d.id'
    ];
    if (!includeNonProduction) {
        clauses.push('c.is_production = TRUE');
        clauses.push("LOWER(COALESCE(c.usage_type, '')) NOT IN ('demo','test','calibration','maintenance')");
    }
    clauses.push(...scopeSql(normalized, 'c', contextParams));
    clauses.push(`(EXISTS (SELECT 1 FROM agro_metric_forecasts f WHERE f.owner_user_id=c.owner_user_id AND f.device_id=c.device_id AND f.context_id=c.id)
      OR EXISTS (SELECT 1 FROM agro_stress_memory sm WHERE sm.owner_user_id=c.owner_user_id AND sm.device_id=c.device_id AND sm.context_id=c.id)
      OR EXISTS (SELECT 1 FROM agro_intelligence_score sc WHERE sc.owner_user_id=c.owner_user_id AND sc.device_id=c.device_id AND sc.context_id=c.id))`);
    const contexts = await executor(
        `SELECT c.id AS context_id, c.owner_user_id, c.device_id
         FROM agro_context_segments c JOIN devices d ON d.id=c.device_id JOIN users u ON u.id=d.user_id
         WHERE ${clauses.join(' AND ')} ORDER BY c.owner_user_id, c.device_id, c.id`,
        contextParams
    );
    const map = new Map(contexts.map((row) => [`${row.owner_user_id}:${row.device_id}:${row.context_id}`, {
        owner_user_id: Number(row.owner_user_id), device_id: Number(row.device_id), context_id: Number(row.context_id),
        forecasts: [], breaches: [], stress_memories: [], baselines: [], trends: [], intelligence_score: null
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
    attach(await selected('agro_stress_memory', 'owner_user_id, device_id, context_id, metric, stress_type'), 'stress_memories');
    attach(await selected('agro_greenhouse_baselines', 'owner_user_id, device_id, context_id, metric'), 'baselines');
    attach(await selected('agro_intelligence_trends', 'owner_user_id, device_id, context_id, metric'), 'trends');
    for (const row of await selected('agro_intelligence_score', 'owner_user_id, device_id, context_id')) {
        const target = map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);
        if (target) { target.intelligence_score = row; }
    }
    return [...map.values()];
}

function stressTypesForInput(input) {
    const types = new Set(['out_of_range']);
    for (const row of parseArray(input.stress_memories)) {
        if (STRESS_TYPES.includes(row.stress_type)) { types.add(row.stress_type); }
    }
    return STRESS_TYPES.filter((type) => types.has(type));
}

async function upsertStressEta(row, executor = query) {
    const identity = assertIdentity(row, 'stress-eta-upsert');
    await executor(
        `INSERT INTO agro_stress_eta
          (owner_user_id, device_id, context_id, generated_at, stress_type, eta_minutes,
           stress_probability, stress_confidence, current_score, predicted_score,
           risk_factors_json, evidence_json, status, severity, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), ?, ?, ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, stress_type) DO UPDATE SET
           generated_at=EXCLUDED.generated_at, eta_minutes=EXCLUDED.eta_minutes,
           stress_probability=EXCLUDED.stress_probability, stress_confidence=EXCLUDED.stress_confidence,
           current_score=EXCLUDED.current_score, predicted_score=EXCLUDED.predicted_score,
           risk_factors_json=EXCLUDED.risk_factors_json, evidence_json=EXCLUDED.evidence_json,
           status=EXCLUDED.status, severity=EXCLUDED.severity, rule_version=EXCLUDED.rule_version, updated_at=NOW()`,
        [identity.owner_user_id, identity.device_id, identity.context_id, row.generated_at,
            identity.stress_type, row.eta_minutes, row.stress_probability, row.stress_confidence,
            row.current_score, row.predicted_score, JSON.stringify(row.risk_factors_json),
            JSON.stringify(row.evidence_json), row.status, row.severity, RULE_VERSION]
    );
}

async function deleteStaleStressEta({ generatedAt, scope = null, executor = query } = {}) {
    const normalized = normalizeScope(scope);
    const params = [(generatedAt instanceof Date ? generatedAt : new Date(generatedAt)).toISOString()];
    const clauses = ['generated_at IS DISTINCT FROM CAST(? AS TIMESTAMPTZ)', ...scopeSql(normalized, 'agro_stress_eta', params)];
    const rows = await executor(
        `WITH removed AS (DELETE FROM agro_stress_eta WHERE ${clauses.join(' AND ')} RETURNING 1)
         SELECT COUNT(*)::integer AS removed FROM removed`, params
    );
    return Number(rows[0] && rows[0].removed) || 0;
}

async function runStressEtaCycle({
    generatedAt = new Date(), scope = null, includeNonProduction = false,
    dryRun = false, executor = query
} = {}) {
    const inputs = await loadStressEtaInputs({ generatedAt, scope, includeNonProduction, executor });
    const rows = [];
    const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const input of inputs) {
        for (const stressType of stressTypesForInput(input)) {
            const row = computeStressEta(input, stressType, generatedAt);
            rows.push(row); byStatus[row.status] += 1;
            if (!dryRun) { await upsertStressEta(row, executor); }
        }
    }
    const removedStale = dryRun ? 0 : await deleteStaleStressEta({ generatedAt, scope, executor });
    return { contexts: inputs.length, stress_rows: rows.length, stored: dryRun ? 0 : rows.length,
        by_status: byStatus, removed_stale: removedStale, dry_run: dryRun, rows };
}

module.exports = {
    ensureStressEtaSchema, runStressEtaCycle, loadStressEtaInputs, computeStressEta,
    upsertStressEta, deleteStaleStressEta, severityFor, STRESS_TYPES, STATUSES, RULE_VERSION
};
