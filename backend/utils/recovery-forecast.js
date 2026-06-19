'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's6.5';
const RECOVERY_BANDS = Object.freeze(['very_fast', 'fast', 'moderate', 'slow', 'very_slow', 'unknown']);

function finite(value, fallback = null) {
    const parsed = C.num(value);
    return parsed === null ? fallback : parsed;
}

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertIdentity(value, label = 'recovery-forecast') {
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

function weightedAverage(rows, valueKey, weightKey = 'recovery_count', fallback = 0) {
    let total = 0;
    let weight = 0;
    for (const row of rows) {
        const value = finite(row[valueKey]);
        const rowWeight = Math.max(1, finite(row[weightKey], 1));
        if (value !== null) { total += value * rowWeight; weight += rowWeight; }
    }
    return weight ? total / weight : fallback;
}

function recoveryBand(minutes, sufficient = true) {
    if (!sufficient || minutes === null || !Number.isFinite(Number(minutes))) { return 'unknown'; }
    if (minutes <= 60) { return 'very_fast'; }
    if (minutes <= 180) { return 'fast'; }
    if (minutes <= 360) { return 'moderate'; }
    if (minutes <= 720) { return 'slow'; }
    return 'very_slow';
}

function positiveTrend(direction) {
    return ({ improving: 1, stable: 0.7, volatile: 0.35, degrading: 0,
        insufficient_data: 0.4, declining: 1, rising: 0 })[direction] ?? 0.4;
}

function stressPressure(rows) {
    return C.clamp01(maxOf(parseArray(rows).map((row) => {
        const status = ({ already_under_stress: 1, stress_imminent: 0.9, stress_likely: 0.75,
            stress_possible: 0.5, no_stress_expected: 0, insufficient_data: 0.15 })[row.status] ?? 0.15;
        return Math.max(status, finite(row.stress_probability, 0));
    })));
}

function riskPressure(rows) {
    return C.clamp01(maxOf(parseArray(rows).map((row) => finite(row.overall_risk_score, 0) / 100)));
}

function computeRecoveryForecast(input, generatedAt = new Date()) {
    const identity = assertIdentity(input, 'recovery-forecast-input');
    const clock = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
    if (Number.isNaN(clock.getTime())) { throw new Error('[recovery-forecast] invalid generatedAt'); }
    const recovery = parseArray(input.recovery_memories);
    const stressMemory = parseArray(input.stress_memories);
    const stressEta = parseArray(input.stress_eta);
    const risks = parseArray(input.risk_forecasts);
    const forecasts = parseArray(input.metric_forecasts);
    const trends = parseArray(input.trends).filter((row) =>
        ['recovery', 'resilience', 'intelligence_score'].includes(row.metric));
    const health = input.health_profile || null;
    const intelligence = input.intelligence_score || null;

    const hasHistory = recovery.length > 0;
    const historyConfidence = C.clamp01(weightedAverage(recovery, 'confidence'));
    const historyQuality = C.clamp01(weightedAverage(recovery, 'recovery_quality_score'));
    const historyStability = C.clamp01(weightedAverage(recovery, 'recovery_stability_score'));
    const relapse = C.clamp01(weightedAverage(recovery, 'relapse_rate'));
    const fastRate = C.clamp01(weightedAverage(recovery, 'fast_recovery_rate'));
    const slowRate = C.clamp01(weightedAverage(recovery, 'slow_recovery_rate'));
    const historicalSeconds = hasHistory ? weightedAverage(recovery, 'average_recovery_duration') : null;
    const resilience = C.clamp01(finite(health && health.resilience_score,
        finite(health && health.recovery_score, 50)) / 100);
    const healthFactor = C.clamp01(finite(health && health.health_score, 50) / 100);
    const healthConfidence = C.clamp01(finite(health && health.confidence, 0));
    const intelligenceFactor = C.clamp01(finite(intelligence && intelligence.intelligence_score, 50) / 100);
    const intelligenceConfidence = C.clamp01(finite(intelligence && intelligence.confidence, 0));
    const trendFactor = trends.length
        ? C.clamp01(average(trends.map((row) => positiveTrend(row.trend_direction))))
        : 0.4;
    const trendConfidence = C.clamp01(average(trends.map((row) => row.trend_confidence)));
    const forecastQuality = C.clamp01(average(forecasts.map((row) =>
        0.6 * finite(row.confidence, 0) + 0.4 * finite(row.data_quality_score, 0))));
    const activeStress = stressPressure(stressEta);
    const futureRisk = riskPressure(risks);
    const recurrence = C.clamp01(maxOf(stressMemory.map((row) => row.recurrence_score)));

    const baseProbability = C.clamp01(
        0.22 * historyQuality + 0.15 * historyStability + 0.15 * resilience
        + 0.10 * healthFactor + 0.08 * intelligenceFactor + 0.10 * fastRate
        + 0.10 * (1 - relapse) + 0.05 * trendFactor + 0.05 * forecastQuality
    );
    const recoveryProbability = C.clamp01(
        baseProbability - 0.12 * activeStress - 0.08 * futureRisk
        - 0.08 * recurrence - 0.05 * slowRate
    );
    const expectedQuality = C.clamp01(
        0.45 * historyQuality + 0.20 * historyStability + 0.15 * resilience
        + 0.10 * healthFactor + 0.10 * (1 - relapse)
        - 0.10 * activeStress - 0.05 * futureRisk
    );
    let estimatedMinutes = null;
    if (historicalSeconds !== null) {
        const adjustment = Math.max(0.5,
            1 + 0.50 * relapse + 0.40 * activeStress + 0.30 * futureRisk
            + 0.20 * recurrence + 0.15 * slowRate - 0.25 * resilience - 0.15 * fastRate);
        estimatedMinutes = Math.max(1, Math.round((historicalSeconds / 60) * adjustment));
    }
    const sourceCoverage = [hasHistory, Boolean(health), Boolean(intelligence), stressEta.length > 0,
        risks.length > 0, forecasts.length > 0, trends.length > 0].filter(Boolean).length / 7;
    const stressConfidence = C.clamp01(average(stressEta.map((row) => row.stress_confidence)));
    const riskConfidence = C.clamp01(average(risks.map((row) => row.confidence)));
    const confidence = C.clamp01(
        0.42 * historyConfidence + 0.14 * healthConfidence + 0.10 * intelligenceConfidence
        + 0.10 * stressConfidence + 0.10 * riskConfidence + 0.07 * forecastQuality
        + 0.07 * trendConfidence
    ) * (0.55 + 0.45 * sourceCoverage);
    const sufficient = hasHistory && historyConfidence >= 0.25 && estimatedMinutes !== null;
    const riskScore = C.clamp01(
        0.35 * (1 - recoveryProbability) + 0.20 * relapse + 0.15 * activeStress
        + 0.12 * futureRisk + 0.10 * recurrence + 0.08 * slowRate
    );
    const positiveSignals = [];
    const negativeSignals = [];
    if (historyQuality >= 0.7) { positiveSignals.push({ signal: 'historical_recovery_quality', score: C.round3(historyQuality) }); }
    if (fastRate >= 0.6) { positiveSignals.push({ signal: 'frequent_fast_recovery', score: C.round3(fastRate) }); }
    if (resilience >= 0.7) { positiveSignals.push({ signal: 'strong_resilience', score: C.round3(resilience) }); }
    if (trendFactor >= 0.7) { positiveSignals.push({ signal: 'supportive_trend', score: C.round3(trendFactor) }); }
    if (relapse >= 0.35) { negativeSignals.push({ signal: 'relapse_history', score: C.round3(relapse) }); }
    if (recurrence >= 0.6) { negativeSignals.push({ signal: 'recurring_stress', score: C.round3(recurrence) }); }
    if (activeStress >= 0.6) { negativeSignals.push({ signal: 'active_stress_pressure', score: C.round3(activeStress) }); }
    if (futureRisk >= 0.6) { negativeSignals.push({ signal: 'future_risk_pressure', score: C.round3(futureRisk) }); }

    return {
        ...identity,
        generated_at: clock.toISOString(),
        recovery_probability: C.round3(sufficient ? recoveryProbability : Math.min(recoveryProbability, 0.35)),
        estimated_recovery_minutes: estimatedMinutes,
        estimated_recovery_band: recoveryBand(estimatedMinutes, sufficient),
        confidence: C.round3(confidence),
        resilience_score: C.round1(resilience * 100),
        expected_recovery_quality: C.round3(sufficient ? expectedQuality : Math.min(expectedQuality, 0.4)),
        recovery_risk: C.round1(riskScore * 100),
        positive_signals_json: positiveSignals,
        negative_signals_json: negativeSignals,
        evidence_json: {
            source_availability: {
                recovery_memory: recovery.length, stress_memory: stressMemory.length,
                stress_eta: stressEta.length, risk_forecasts: risks.length,
                health_profile: Boolean(health), intelligence_score: Boolean(intelligence),
                metric_forecasts: forecasts.length, trends: trends.length
            },
            historical: {
                recovery_count: recovery.reduce((sum, row) => sum + Math.max(0, Number(row.recovery_count) || 0), 0),
                duration_minutes: historicalSeconds === null ? null : C.round1(historicalSeconds / 60),
                quality: C.round3(historyQuality), stability: C.round3(historyStability),
                relapse_rate: C.round3(relapse), fast_rate: C.round3(fastRate), slow_rate: C.round3(slowRate)
            },
            factors: {
                resilience: C.round3(resilience), health: C.round3(healthFactor),
                intelligence: C.round3(intelligenceFactor), trend: C.round3(trendFactor),
                forecast_quality: C.round3(forecastQuality), active_stress: C.round3(activeStress),
                future_risk: C.round3(futureRisk), stress_recurrence: C.round3(recurrence)
            },
            sufficient_history: sufficient,
            privacy: { raw_readings: false, raw_events: false, cross_tenant_evidence: false, fleet_dependency: false }
        },
        rule_version: RULE_VERSION
    };
}

async function ensureRecoveryForecastSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_recovery_forecasts (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           generated_at TIMESTAMPTZ NOT NULL,
           recovery_probability NUMERIC(5,4) NOT NULL,
           estimated_recovery_minutes INTEGER NULL,
           estimated_recovery_band VARCHAR(12) NOT NULL,
           confidence NUMERIC(5,4) NOT NULL,
           resilience_score NUMERIC(6,2) NOT NULL,
           expected_recovery_quality NUMERIC(5,4) NOT NULL,
           recovery_risk NUMERIC(6,2) NOT NULL,
           positive_signals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
           negative_signals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's6.5',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_recovery_forecast UNIQUE (owner_user_id, device_id, context_id),
           CONSTRAINT recovery_forecast_values_check CHECK (
             recovery_probability BETWEEN 0 AND 1 AND confidence BETWEEN 0 AND 1
             AND (estimated_recovery_minutes IS NULL OR estimated_recovery_minutes >= 0)
             AND estimated_recovery_band IN ('very_fast','fast','moderate','slow','very_slow','unknown')
             AND resilience_score BETWEEN 0 AND 100 AND expected_recovery_quality BETWEEN 0 AND 1
             AND recovery_risk BETWEEN 0 AND 100
             AND jsonb_typeof(positive_signals_json)='array'
             AND jsonb_typeof(negative_signals_json)='array' AND jsonb_typeof(evidence_json)='object')
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count FROM agro_recovery_forecasts r
         LEFT JOIN devices d ON d.id=r.device_id LEFT JOIN users u ON u.id=d.user_id
         LEFT JOIN agro_context_segments c ON c.id=r.context_id
         WHERE r.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id,u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM r.owner_user_id
            OR c.device_id IS DISTINCT FROM r.device_id`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[recovery-forecast-schema] existing rows have invalid tenant/context identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_recovery_forecast_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; context_owner INTEGER; context_device INTEGER;
         BEGIN
           SELECT COALESCE(u.owner_user_id,u.id) INTO expected_owner
             FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=NEW.device_id;
           SELECT owner_user_id,device_id INTO context_owner,context_device
             FROM agro_context_segments WHERE id=NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'recovery forecast owner/device mismatch'; END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'recovery forecast context mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS recovery_forecast_identity_guard ON agro_recovery_forecasts');
    await executor(
        `CREATE TRIGGER recovery_forecast_identity_guard BEFORE INSERT OR UPDATE ON agro_recovery_forecasts
         FOR EACH ROW EXECUTE FUNCTION rayat_assert_recovery_forecast_identity()`
    );
    await executor('CREATE INDEX IF NOT EXISTS idx_recovery_forecast_band ON agro_recovery_forecasts (estimated_recovery_band, recovery_risk DESC)');
    await executor('CREATE INDEX IF NOT EXISTS idx_recovery_forecast_context ON agro_recovery_forecasts (context_id, generated_at DESC)');
}

function normalizeScope(scope) {
    if (!scope) { return {}; }
    const result = {};
    for (const [key, source] of [['owner_user_id','ownerUserId'],['device_id','deviceId'],['context_id','contextId']]) {
        if (scope[source] != null) {
            const value = positiveInteger(scope[source]);
            if (!value) { throw new Error('[recovery-forecast] invalid scope'); }
            result[key] = value;
        }
    }
    return result;
}

function scopeSql(scope, alias, params) {
    return Object.entries(scope).map(([key,value]) => { params.push(value); return `${alias}.${key}=?`; });
}

async function loadRecoveryForecastInputs({
    generatedAt = new Date(), scope = null, executor = query
} = {}) {
    const clock = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
    if (Number.isNaN(clock.getTime())) { throw new Error('[recovery-forecast] invalid generatedAt'); }
    const normalized = normalizeScope(scope);
    const params = [clock.toISOString(), clock.toISOString()];
    const clauses = [
        'c.valid_from<=CAST(? AS TIMESTAMPTZ)', '(c.valid_to IS NULL OR c.valid_to>CAST(? AS TIMESTAMPTZ))',
        'c.owner_user_id=COALESCE(u.owner_user_id,u.id)', 'c.device_id=d.id'
    ];
    clauses.push('c.is_production=TRUE');
    clauses.push("LOWER(COALESCE(c.usage_type,'')) NOT IN ('demo','test','calibration','maintenance')");
    clauses.push(...scopeSql(normalized, 'c', params));
    clauses.push(`(EXISTS (SELECT 1 FROM agro_recovery_memory rm WHERE rm.owner_user_id=c.owner_user_id AND rm.device_id=c.device_id AND rm.context_id=c.id)
      OR EXISTS (SELECT 1 FROM agro_stress_eta se WHERE se.owner_user_id=c.owner_user_id AND se.device_id=c.device_id AND se.context_id=c.id)
      OR EXISTS (SELECT 1 FROM agro_risk_forecasts rf WHERE rf.owner_user_id=c.owner_user_id AND rf.device_id=c.device_id AND rf.context_id=c.id))`);
    const contexts = await executor(
        `SELECT c.id AS context_id,c.owner_user_id,c.device_id FROM agro_context_segments c
         JOIN devices d ON d.id=c.device_id JOIN users u ON u.id=d.user_id
         WHERE ${clauses.join(' AND ')} ORDER BY c.owner_user_id,c.device_id,c.id`, params
    );
    const map = new Map(contexts.map((row) => [`${row.owner_user_id}:${row.device_id}:${row.context_id}`, {
        owner_user_id:Number(row.owner_user_id),device_id:Number(row.device_id),context_id:Number(row.context_id),
        recovery_memories:[],stress_memories:[],stress_eta:[],risk_forecasts:[],metric_forecasts:[],trends:[],
        health_profile:null,intelligence_score:null
    }]));
    if (!map.size) { return []; }
    const ids=[...new Set(contexts.map((row)=>Number(row.context_id)))];
    const selected=(table,order)=>executor(`SELECT * FROM ${table} WHERE context_id IN (${ids.map(()=>'?').join(',')}) ORDER BY ${order}`,ids);
    const attach=(rows,field)=>rows.forEach((row)=>{const target=map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);if(target){target[field].push(row);}});
    attach(await selected('agro_recovery_memory','owner_user_id,device_id,context_id,metric'),'recovery_memories');
    attach(await selected('agro_stress_memory','owner_user_id,device_id,context_id,metric,stress_type'),'stress_memories');
    attach(await selected('agro_stress_eta','owner_user_id,device_id,context_id,stress_type'),'stress_eta');
    attach(await selected('agro_risk_forecasts','owner_user_id,device_id,context_id,forecast_horizon_minutes'),'risk_forecasts');
    attach(await selected('agro_metric_forecasts','owner_user_id,device_id,context_id,sensor_id,horizon_minutes'),'metric_forecasts');
    attach(await selected('agro_intelligence_trends','owner_user_id,device_id,context_id,metric'),'trends');
    for(const row of await selected('agro_greenhouse_health_profile','owner_user_id,device_id,context_id')){const target=map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);if(target){target.health_profile=row;}}
    for(const row of await selected('agro_intelligence_score','owner_user_id,device_id,context_id')){const target=map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);if(target){target.intelligence_score=row;}}
    return [...map.values()];
}

async function upsertRecoveryForecast(row, executor=query) {
    const identity=assertIdentity(row,'recovery-forecast-upsert');
    await executor(
        `INSERT INTO agro_recovery_forecasts
          (owner_user_id,device_id,context_id,generated_at,recovery_probability,estimated_recovery_minutes,
           estimated_recovery_band,confidence,resilience_score,expected_recovery_quality,recovery_risk,
           positive_signals_json,negative_signals_json,evidence_json,rule_version,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,CAST(? AS JSONB),CAST(? AS JSONB),CAST(? AS JSONB),?,NOW(),NOW())
         ON CONFLICT (owner_user_id,device_id,context_id) DO UPDATE SET
           generated_at=EXCLUDED.generated_at,recovery_probability=EXCLUDED.recovery_probability,
           estimated_recovery_minutes=EXCLUDED.estimated_recovery_minutes,estimated_recovery_band=EXCLUDED.estimated_recovery_band,
           confidence=EXCLUDED.confidence,resilience_score=EXCLUDED.resilience_score,
           expected_recovery_quality=EXCLUDED.expected_recovery_quality,recovery_risk=EXCLUDED.recovery_risk,
           positive_signals_json=EXCLUDED.positive_signals_json,negative_signals_json=EXCLUDED.negative_signals_json,
           evidence_json=EXCLUDED.evidence_json,rule_version=EXCLUDED.rule_version,updated_at=NOW()`,
        [identity.owner_user_id,identity.device_id,identity.context_id,row.generated_at,row.recovery_probability,
            row.estimated_recovery_minutes,row.estimated_recovery_band,row.confidence,row.resilience_score,
            row.expected_recovery_quality,row.recovery_risk,JSON.stringify(row.positive_signals_json),
            JSON.stringify(row.negative_signals_json),JSON.stringify(row.evidence_json),RULE_VERSION]
    );
}

async function deleteStaleRecoveryForecasts({generatedAt,scope=null,executor=query}={}) {
    const normalized=normalizeScope(scope);const params=[(generatedAt instanceof Date?generatedAt:new Date(generatedAt)).toISOString()];
    const clauses=['generated_at IS DISTINCT FROM CAST(? AS TIMESTAMPTZ)',...scopeSql(normalized,'agro_recovery_forecasts',params)];
    const rows=await executor(`WITH removed AS (DELETE FROM agro_recovery_forecasts WHERE ${clauses.join(' AND ')} RETURNING 1) SELECT COUNT(*)::integer AS removed FROM removed`,params);
    return Number(rows[0]&&rows[0].removed)||0;
}

async function runRecoveryForecastCycle({generatedAt=new Date(),scope=null,dryRun=false,executor=query}={}) {
    const inputs=await loadRecoveryForecastInputs({generatedAt,scope,executor});const rows=[];const byBand=Object.fromEntries(RECOVERY_BANDS.map((band)=>[band,0]));
    for(const input of inputs){const row=computeRecoveryForecast(input,generatedAt);rows.push(row);byBand[row.estimated_recovery_band]+=1;if(!dryRun){await upsertRecoveryForecast(row,executor);}}
    const removedStale=dryRun?0:await deleteStaleRecoveryForecasts({generatedAt,scope,executor});
    return {contexts:inputs.length,recovery_rows:rows.length,stored:dryRun?0:rows.length,by_band:byBand,removed_stale:removedStale,dry_run:dryRun,rows};
}

module.exports={ensureRecoveryForecastSchema,runRecoveryForecastCycle,loadRecoveryForecastInputs,computeRecoveryForecast,upsertRecoveryForecast,deleteStaleRecoveryForecasts,recoveryBand,RECOVERY_BANDS,RULE_VERSION};
