'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's6.8';
const PREDICTION_TYPES = Object.freeze([
    'metric_forecast', 'breach_eta', 'stress_eta', 'risk_forecast', 'recovery_forecast'
]);
const OUTCOMES = Object.freeze(['correct', 'partially_correct', 'incorrect', 'insufficient_data']);
const STRESS_EVENTS = Object.freeze(['out_of_range','worsening','anomaly','regime_shift','sensor_drift']);
const RECOVERY_EVENTS = Object.freeze(['recovery','return_to_range','stabilization','improvement']);

function finite(value, fallback = null) {
    const parsed = C.num(value);
    return parsed === null ? fallback : parsed;
}

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertIdentity(value, label = 'prediction-backtest') {
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

function parseObject(value) {
    const parsed = C.parseJson(value, {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function addMinutes(value, minutes) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) { throw new Error('[prediction-backtest] invalid timestamp'); }
    return new Date(date.getTime() + Number(minutes) * 60000);
}

function outcomeScore(outcome) {
    return ({ correct: 1, partially_correct: 0.5, incorrect: 0 })[outcome] ?? null;
}

function calibration(predictedProbability, actualOutcome) {
    const actual = outcomeScore(actualOutcome);
    if (actual === null) { return 0; }
    return C.clamp01(1 - Math.abs(C.clamp01(finite(predictedProbability, 0)) - actual));
}

function result(prediction, outcome, error, predictedProbability, evidence) {
    const confidence = C.clamp01(finite(prediction.confidence,
        finite(prediction.eta_confidence, finite(prediction.stress_confidence, 0))));
    return {
        outcome,
        prediction_error: error === null ? null : C.round3(Math.max(0, error)),
        confidence: C.round3(confidence),
        calibration_score: C.round3(calibration(predictedProbability, outcome)),
        evidence_json: {
            ...evidence,
            confidence_alignment: outcome === 'insufficient_data' ? null
                : C.round3(1 - Math.abs(confidence - outcomeScore(outcome))),
            privacy: { raw_readings: false, raw_events: false, cross_tenant_evidence: false, fleet_dependency: false }
        }
    };
}

function evaluateMetricForecast(prediction, observation) {
    const actual = finite(observation && observation.value);
    if (actual === null) {
        return result(prediction, 'insufficient_data', null, prediction.confidence,
            { reason: 'future_reading_unavailable' });
    }
    const forecast = finite(prediction.forecast_value);
    const low = finite(prediction.forecast_low, forecast);
    const high = finite(prediction.forecast_high, forecast);
    if (forecast === null) { return result(prediction, 'insufficient_data', null, 0, { reason: 'invalid_prediction' }); }
    const error = Math.abs(actual - forecast);
    const halfWidth = Math.max(Math.abs(high - low) / 2, 0.0001);
    const outcome = actual >= low && actual <= high ? 'correct'
        : (error <= halfWidth * 2 ? 'partially_correct' : 'incorrect');
    return result(prediction, outcome, error, prediction.confidence, {
        target_value: C.round3(forecast), observed_value: C.round3(actual),
        prediction_interval: { low: C.round3(low), high: C.round3(high) },
        observed_at: observation.observed_at || null, error_kind: 'absolute_value'
    });
}

function evaluateBreachEta(prediction, observation) {
    if (prediction.status === 'insufficient_data') {
        return result(prediction, 'insufficient_data', null, prediction.eta_confidence,
            { reason: 'prediction_abstained' });
    }
    if (!observation || !observation.has_coverage) {
        return result(prediction, 'insufficient_data', null, prediction.eta_confidence,
            { reason: 'telemetry_coverage_unavailable' });
    }
    const actualEta = finite(observation.crossing_minutes);
    const predictedPositive = ['breach_possible','breach_likely','already_breached'].includes(prediction.status);
    const actualPositive = actualEta !== null;
    let outcome;
    let error = null;
    if (predictedPositive && actualPositive) {
        const predictedEta = Math.max(0, finite(prediction.eta_minutes, 0));
        error = Math.abs(actualEta - predictedEta);
        const correctLimit = Math.max(30, Math.max(predictedEta, 60) * 0.25);
        const partialLimit = Math.max(90, Math.max(predictedEta, 60) * 0.50);
        outcome = error <= correctLimit ? 'correct' : (error <= partialLimit ? 'partially_correct' : 'incorrect');
    } else if (predictedPositive !== actualPositive) {
        outcome = 'incorrect';
        error = actualEta === null ? finite(prediction.horizon_minutes, 1440) : actualEta;
    } else { outcome = 'correct'; error = 0; }
    return result(prediction, outcome, error, prediction.eta_confidence, {
        predicted_status: prediction.status, predicted_eta_minutes: finite(prediction.eta_minutes),
        observed_crossing: actualPositive, observed_eta_minutes: actualEta,
        error_kind: 'eta_minutes'
    });
}

function evaluateStressEta(prediction, observation) {
    if (prediction.status === 'insufficient_data') {
        return result(prediction, 'insufficient_data', null, prediction.stress_probability,
            { reason: 'prediction_abstained' });
    }
    if (!observation || !observation.has_coverage) {
        return result(prediction, 'insufficient_data', null, prediction.stress_probability,
            { reason: 'telemetry_coverage_unavailable' });
    }
    const actualEta = finite(observation.event_minutes);
    const predictedPositive = ['stress_possible','stress_likely','stress_imminent','already_under_stress']
        .includes(prediction.status);
    const actualPositive = actualEta !== null;
    let outcome;
    let error = null;
    if (predictedPositive && actualPositive) {
        const predictedEta = Math.max(0, finite(prediction.eta_minutes, 0));
        error = Math.abs(actualEta - predictedEta);
        const correctLimit = Math.max(60, Math.max(predictedEta, 60) * 0.30);
        const partialLimit = Math.max(180, Math.max(predictedEta, 60) * 0.60);
        outcome = error <= correctLimit ? 'correct' : (error <= partialLimit ? 'partially_correct' : 'incorrect');
    } else if (predictedPositive !== actualPositive) {
        outcome = 'incorrect'; error = actualEta === null ? 1440 : actualEta;
    } else { outcome = 'correct'; error = 0; }
    return result(prediction, outcome, error, prediction.stress_probability, {
        predicted_status: prediction.status, predicted_eta_minutes: finite(prediction.eta_minutes),
        observed_stress: actualPositive, observed_eta_minutes: actualEta, error_kind: 'eta_minutes'
    });
}

function evaluateRiskForecast(prediction, observation) {
    const actual = finite(observation && observation.intelligence_score);
    if (actual === null) {
        return result(prediction, 'insufficient_data', null, prediction.risk_probability,
            { reason: 'future_intelligence_score_unavailable' });
    }
    const predicted = finite(prediction.predicted_intelligence_score);
    if (predicted === null) { return result(prediction, 'insufficient_data', null, 0, { reason: 'invalid_prediction' }); }
    const error = Math.abs(actual - predicted);
    const outcome = error <= 10 ? 'correct' : (error <= 20 ? 'partially_correct' : 'incorrect');
    const actualRisk = actual < 50 ? 1 : 0;
    const base = result(prediction, outcome, error, prediction.risk_probability, {
        predicted_intelligence_score: C.round1(predicted), observed_intelligence_score: C.round1(actual),
        observed_risk_band: actual < 30 ? 'critical' : (actual < 50 ? 'risk' : 'non_risk'),
        observed_at: observation.observed_at || null, error_kind: 'score_points'
    });
    base.calibration_score = C.round3(1 - Math.abs(C.clamp01(finite(prediction.risk_probability, 0)) - actualRisk));
    return base;
}

function evaluateRecoveryForecast(prediction, observation) {
    if (prediction.estimated_recovery_band === 'unknown' || prediction.estimated_recovery_minutes == null) {
        return result(prediction, 'insufficient_data', null, prediction.recovery_probability,
            { reason: 'prediction_abstained' });
    }
    if (!observation || !observation.has_coverage) {
        return result(prediction, 'insufficient_data', null, prediction.recovery_probability,
            { reason: 'telemetry_coverage_unavailable' });
    }
    const actualEta = finite(observation.recovery_minutes);
    const predictedEta = finite(prediction.estimated_recovery_minutes);
    if (actualEta === null) {
        return result(prediction, 'incorrect', predictedEta, prediction.recovery_probability,
            { predicted_recovery_minutes: predictedEta, observed_recovery: false, error_kind: 'eta_minutes' });
    }
    const error = Math.abs(actualEta - predictedEta);
    const correctLimit = Math.max(60, predictedEta * 0.25);
    const partialLimit = Math.max(180, predictedEta * 0.50);
    const outcome = error <= correctLimit ? 'correct' : (error <= partialLimit ? 'partially_correct' : 'incorrect');
    return result(prediction, outcome, error, prediction.recovery_probability, {
        predicted_recovery_minutes: predictedEta, observed_recovery: true,
        observed_recovery_minutes: actualEta, error_kind: 'eta_minutes'
    });
}

async function ensurePredictionBacktestSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_prediction_snapshots (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           prediction_type VARCHAR(24) NOT NULL,
           prediction_id BIGINT NOT NULL,
           generated_at TIMESTAMPTZ NOT NULL,
           evaluate_after TIMESTAMPTZ NOT NULL,
           payload_json JSONB NOT NULL,
           evaluated_at TIMESTAMPTZ NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_prediction_snapshot UNIQUE(prediction_type,prediction_id,generated_at),
           CONSTRAINT prediction_snapshot_values_check CHECK(
             prediction_type IN ('metric_forecast','breach_eta','stress_eta','risk_forecast','recovery_forecast')
             AND evaluate_after>=generated_at AND jsonb_typeof(payload_json)='object')
         )`
    );
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_prediction_backtests (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           prediction_type VARCHAR(24) NOT NULL,
           prediction_id BIGINT NOT NULL,
           generated_at TIMESTAMPTZ NOT NULL,
           evaluated_at TIMESTAMPTZ NOT NULL,
           outcome VARCHAR(20) NOT NULL,
           prediction_error NUMERIC(18,5) NULL,
           confidence NUMERIC(5,4) NOT NULL,
           calibration_score NUMERIC(5,4) NOT NULL,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's6.8',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_prediction_backtest UNIQUE(prediction_type,prediction_id,generated_at),
           CONSTRAINT prediction_backtest_values_check CHECK(
             prediction_type IN ('metric_forecast','breach_eta','stress_eta','risk_forecast','recovery_forecast')
             AND outcome IN ('correct','partially_correct','incorrect','insufficient_data')
             AND (prediction_error IS NULL OR prediction_error>=0)
             AND confidence BETWEEN 0 AND 1 AND calibration_score BETWEEN 0 AND 1
             AND jsonb_typeof(evidence_json)='object')
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count FROM (
           SELECT owner_user_id,device_id,context_id FROM agro_prediction_snapshots
           UNION ALL SELECT owner_user_id,device_id,context_id FROM agro_prediction_backtests
         ) x LEFT JOIN devices d ON d.id=x.device_id LEFT JOIN users u ON u.id=d.user_id
         LEFT JOIN agro_context_segments c ON c.id=x.context_id
         WHERE x.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id,u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM x.owner_user_id
            OR c.device_id IS DISTINCT FROM x.device_id`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[prediction-backtest-schema] existing rows have invalid tenant/context identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_prediction_evaluation_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER;context_owner INTEGER;context_device INTEGER;
         BEGIN
           SELECT COALESCE(u.owner_user_id,u.id) INTO expected_owner FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=NEW.device_id;
           SELECT owner_user_id,device_id INTO context_owner,context_device FROM agro_context_segments WHERE id=NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN RAISE EXCEPTION 'prediction evaluation owner/device mismatch';END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id OR context_device IS DISTINCT FROM NEW.device_id THEN RAISE EXCEPTION 'prediction evaluation context mismatch';END IF;
           RETURN NEW;
         END;$$ LANGUAGE plpgsql`
    );
    for (const table of ['agro_prediction_snapshots','agro_prediction_backtests']) {
        await executor(`DROP TRIGGER IF EXISTS ${table}_identity_guard ON ${table}`);
        await executor(`CREATE TRIGGER ${table}_identity_guard BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION rayat_assert_prediction_evaluation_identity()`);
    }
    await executor('CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_due ON agro_prediction_snapshots(evaluated_at,evaluate_after)');
    await executor('CREATE INDEX IF NOT EXISTS idx_prediction_backtests_partition ON agro_prediction_backtests(owner_user_id,device_id,context_id,prediction_type,evaluated_at DESC)');
}

function snapshotPayload(type, row) {
    const common = { owner_user_id:Number(row.owner_user_id),device_id:Number(row.device_id),
        context_id:Number(row.context_id),id:Number(row.id),generated_at:new Date(row.generated_at).toISOString() };
    if (type === 'metric_forecast') return { ...common,sensor_id:Number(row.sensor_id),metric:row.metric,
        horizon_minutes:Number(row.horizon_minutes),forecast_value:finite(row.forecast_value),
        forecast_low:finite(row.forecast_low),forecast_high:finite(row.forecast_high),confidence:finite(row.confidence,0) };
    if (type === 'breach_eta') return { ...common,sensor_id:Number(row.sensor_id),metric:row.metric,
        horizon_minutes:Number(row.horizon_minutes),breach_direction:row.breach_direction,
        threshold_value:finite(row.threshold_value),eta_minutes:finite(row.eta_minutes),
        eta_confidence:finite(row.eta_confidence,0),status:row.status };
    if (type === 'stress_eta') return { ...common,stress_type:row.stress_type,status:row.status,
        eta_minutes:finite(row.eta_minutes),stress_probability:finite(row.stress_probability,0),
        stress_confidence:finite(row.stress_confidence,0) };
    if (type === 'risk_forecast') return { ...common,forecast_horizon_minutes:Number(row.forecast_horizon_minutes),
        overall_risk_score:finite(row.overall_risk_score),overall_risk_band:row.overall_risk_band,
        risk_probability:finite(row.risk_probability,0),confidence:finite(row.confidence,0),
        predicted_intelligence_score:finite(row.predicted_intelligence_score) };
    return { ...common,recovery_probability:finite(row.recovery_probability,0),
        estimated_recovery_minutes:finite(row.estimated_recovery_minutes),
        estimated_recovery_band:row.estimated_recovery_band,confidence:finite(row.confidence,0) };
}

function evaluateAfter(type, payload) {
    if (type === 'metric_forecast') return addMinutes(payload.generated_at, payload.horizon_minutes + 30);
    if (type === 'breach_eta') return addMinutes(payload.generated_at, payload.horizon_minutes);
    if (type === 'stress_eta') return addMinutes(payload.generated_at,
        payload.status === 'no_stress_expected' ? 1440 : Math.max(60, payload.eta_minutes || 1440));
    if (type === 'risk_forecast') return addMinutes(payload.generated_at, payload.forecast_horizon_minutes + 1440);
    return addMinutes(payload.generated_at,
        payload.estimated_recovery_minutes == null ? 1440 : Math.max(180, payload.estimated_recovery_minutes * 2));
}

async function loadCurrentPredictions(executor = query) {
    const specs = [
        ['metric_forecast','agro_metric_forecasts'],['breach_eta','agro_breach_eta'],
        ['stress_eta','agro_stress_eta'],['risk_forecast','agro_risk_forecasts'],
        ['recovery_forecast','agro_recovery_forecasts']
    ];
    const rows=[];
    for(const[type,table]of specs){
        const source=await executor(
            `SELECT p.* FROM ${table} p JOIN agro_context_segments c ON c.id=p.context_id
             JOIN devices d ON d.id=p.device_id JOIN users u ON u.id=d.user_id
             WHERE c.is_production=TRUE AND LOWER(COALESCE(c.usage_type,'')) NOT IN ('demo','test','calibration','maintenance')
               AND p.owner_user_id=c.owner_user_id AND p.device_id=c.device_id
               AND p.owner_user_id=COALESCE(u.owner_user_id,u.id)
             ORDER BY p.owner_user_id,p.device_id,p.context_id,p.id`
        );
        for(const row of source){rows.push({type,payload:snapshotPayload(type,row)});}
    }
    return rows;
}

async function capturePredictionSnapshots({ dryRun=false, executor=query }={}) {
    const predictions=await loadCurrentPredictions(executor);let captured=0;
    for(const item of predictions){const p=item.payload;const after=evaluateAfter(item.type,p).toISOString();
        if(!dryRun){const result=await executor(
            `INSERT INTO agro_prediction_snapshots(owner_user_id,device_id,context_id,prediction_type,prediction_id,
             generated_at,evaluate_after,payload_json,created_at)
             VALUES(?,?,?,?,?,?,?,CAST(? AS JSONB),NOW()) ON CONFLICT(prediction_type,prediction_id,generated_at) DO NOTHING
             RETURNING id`,
            [p.owner_user_id,p.device_id,p.context_id,item.type,p.id,p.generated_at,after,JSON.stringify(p)]);
            captured+=Array.isArray(result)?result.length:Number(result.affectedRows||0);
        }
    }
    return {seen:predictions.length,captured:dryRun?0:captured,would_capture:dryRun?predictions.length:0};
}

async function telemetryCoverage(payload,start,end,executor) {
    const rows=await executor(
        `SELECT COUNT(*)::integer AS count FROM sensor_readings sr JOIN sensors s ON s.id=sr.sensor_id
         WHERE s.device_id=? AND sr.timestamp>=CAST(? AS TIMESTAMPTZ) AND sr.timestamp<=CAST(? AS TIMESTAMPTZ)`,
        [payload.device_id,start.toISOString(),end.toISOString()]);
    return Number(rows[0]&&rows[0].count)>0;
}

async function loadObservation(type,payload,executor) {
    const generated=new Date(payload.generated_at);
    if(type==='metric_forecast'){
        const target=addMinutes(generated,payload.horizon_minutes);const start=addMinutes(target,-30);const end=addMinutes(target,30);
        const rows=await executor(
            `SELECT value,timestamp FROM sensor_readings WHERE sensor_id=? AND timestamp>=CAST(? AS TIMESTAMPTZ)
             AND timestamp<=CAST(? AS TIMESTAMPTZ) ORDER BY ABS(EXTRACT(EPOCH FROM(timestamp-CAST(? AS TIMESTAMPTZ)))),timestamp LIMIT 1`,
            [payload.sensor_id,start.toISOString(),end.toISOString(),target.toISOString()]);
        return rows.length?{value:rows[0].value,observed_at:rows[0].timestamp}:null;
    }
    if(type==='breach_eta'){
        const end=addMinutes(generated,payload.horizon_minutes);
        const rows=await executor(`SELECT value,timestamp FROM sensor_readings WHERE sensor_id=? AND timestamp>=CAST(? AS TIMESTAMPTZ) AND timestamp<=CAST(? AS TIMESTAMPTZ) ORDER BY timestamp`,[payload.sensor_id,generated.toISOString(),end.toISOString()]);
        const threshold=finite(payload.threshold_value);const crossing=threshold===null?null:rows.find((row)=>
            payload.breach_direction==='above_max'?finite(row.value)>threshold:
                (payload.breach_direction==='below_min'?finite(row.value)<threshold:false));
        return {has_coverage:rows.length>0,crossing_minutes:crossing?Math.max(0,(new Date(crossing.timestamp)-generated)/60000):null};
    }
    if(type==='stress_eta'){
        const windowMinutes=payload.status==='no_stress_expected'?1440:Math.max(60,payload.eta_minutes||1440);
        const end=addMinutes(generated,windowMinutes);
        const events=await executor(
            `SELECT started_at FROM agro_actions_detected WHERE owner_user_id=? AND device_id=? AND context_id=?
             AND event_type IN ('out_of_range','worsening','anomaly','regime_shift','sensor_drift')
             AND started_at>=CAST(? AS TIMESTAMPTZ) AND started_at<=CAST(? AS TIMESTAMPTZ) ORDER BY started_at LIMIT 1`,
            [payload.owner_user_id,payload.device_id,payload.context_id,generated.toISOString(),end.toISOString()]);
        return {has_coverage:await telemetryCoverage(payload,generated,end,executor),
            event_minutes:events.length?Math.max(0,(new Date(events[0].started_at)-generated)/60000):null};
    }
    if(type==='risk_forecast'){
        const target=addMinutes(generated,payload.forecast_horizon_minutes);
        const rows=await executor(
            `SELECT intelligence_score,captured_on FROM agro_intelligence_score_history
             WHERE owner_user_id=? AND device_id=? AND context_id=?
               AND CAST(captured_on AS TIMESTAMPTZ)>=CAST(? AS TIMESTAMPTZ)-INTERVAL '2 days'
               AND CAST(captured_on AS TIMESTAMPTZ)<=CAST(? AS TIMESTAMPTZ)+INTERVAL '2 days'
             ORDER BY ABS(EXTRACT(EPOCH FROM(CAST(captured_on AS TIMESTAMPTZ)-CAST(? AS TIMESTAMPTZ)))) LIMIT 1`,
            [payload.owner_user_id,payload.device_id,payload.context_id,target.toISOString(),target.toISOString(),target.toISOString()]);
        return rows.length?{intelligence_score:rows[0].intelligence_score,observed_at:rows[0].captured_on}:null;
    }
    const windowMinutes=payload.estimated_recovery_minutes==null?1440:Math.max(180,payload.estimated_recovery_minutes*2);
    const end=addMinutes(generated,windowMinutes);
    const events=await executor(
        `SELECT started_at FROM agro_actions_detected WHERE owner_user_id=? AND device_id=? AND context_id=?
         AND event_type IN ('recovery','return_to_range','stabilization','improvement')
         AND started_at>=CAST(? AS TIMESTAMPTZ) AND started_at<=CAST(? AS TIMESTAMPTZ) ORDER BY started_at LIMIT 1`,
        [payload.owner_user_id,payload.device_id,payload.context_id,generated.toISOString(),end.toISOString()]);
    return {has_coverage:await telemetryCoverage(payload,generated,end,executor),
        recovery_minutes:events.length?Math.max(0,(new Date(events[0].started_at)-generated)/60000):null};
}

function evaluator(type){return({metric_forecast:evaluateMetricForecast,breach_eta:evaluateBreachEta,
    stress_eta:evaluateStressEta,risk_forecast:evaluateRiskForecast,recovery_forecast:evaluateRecoveryForecast})[type];}

async function loadDueSnapshots({evaluatedAt=new Date(),batchSize=500,executor=query}={}){
    const limit=Math.min(1000,Math.max(1,Number(batchSize)||500));
    return executor(`SELECT * FROM agro_prediction_snapshots WHERE evaluated_at IS NULL AND evaluate_after<=CAST(? AS TIMESTAMPTZ) ORDER BY evaluate_after,id LIMIT ?`,[(evaluatedAt instanceof Date?evaluatedAt:new Date(evaluatedAt)).toISOString(),limit]);
}

async function upsertBacktest(snapshot,evaluation,evaluatedAt,executor=query){const p=parseObject(snapshot.payload_json);const rows=await executor(
    `INSERT INTO agro_prediction_backtests(owner_user_id,device_id,context_id,prediction_type,prediction_id,
     generated_at,evaluated_at,outcome,prediction_error,confidence,calibration_score,evidence_json,rule_version,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,CAST(? AS JSONB),?,NOW(),NOW())
     ON CONFLICT(prediction_type,prediction_id,generated_at) DO UPDATE SET evaluated_at=EXCLUDED.evaluated_at,
     outcome=EXCLUDED.outcome,prediction_error=EXCLUDED.prediction_error,confidence=EXCLUDED.confidence,
     calibration_score=EXCLUDED.calibration_score,evidence_json=EXCLUDED.evidence_json,rule_version=EXCLUDED.rule_version,updated_at=NOW()
     RETURNING id`,[p.owner_user_id,p.device_id,p.context_id,snapshot.prediction_type,p.id,p.generated_at,
        evaluatedAt.toISOString(),evaluation.outcome,evaluation.prediction_error,evaluation.confidence,
        evaluation.calibration_score,JSON.stringify(evaluation.evidence_json),RULE_VERSION]);
    await executor('UPDATE agro_prediction_snapshots SET evaluated_at=? WHERE id=?',[evaluatedAt.toISOString(),snapshot.id]);
    return Number(rows[0]&&rows[0].id)||null;
}

async function runPredictionBacktestCycle({evaluatedAt=new Date(),batchSize=500,dryRun=false,executor=query}={}){
    const clock=evaluatedAt instanceof Date?evaluatedAt:new Date(evaluatedAt);if(Number.isNaN(clock.getTime())){throw new Error('[prediction-backtest] invalid evaluatedAt');}
    const capture=await capturePredictionSnapshots({dryRun,executor});const due=await loadDueSnapshots({evaluatedAt:clock,batchSize,executor});
    const rows=[];const byOutcome=Object.fromEntries(OUTCOMES.map((outcome)=>[outcome,0]));
    for(const snapshot of due){const payload=parseObject(snapshot.payload_json);const observation=await loadObservation(snapshot.prediction_type,payload,executor);
        const evaluation=evaluator(snapshot.prediction_type)(payload,observation);rows.push({...evaluation,prediction_type:snapshot.prediction_type,prediction_id:payload.id});byOutcome[evaluation.outcome]+=1;
        if(!dryRun){await upsertBacktest(snapshot,evaluation,clock,executor);}}
    return{snapshots_seen:capture.seen,snapshots_captured:capture.captured,would_capture:capture.would_capture,
        due:due.length,evaluated:dryRun?0:rows.length,by_outcome:byOutcome,dry_run:dryRun,rows};
}

module.exports={ensurePredictionBacktestSchema,runPredictionBacktestCycle,capturePredictionSnapshots,
    loadDueSnapshots,evaluateMetricForecast,evaluateBreachEta,evaluateStressEta,evaluateRiskForecast,
    evaluateRecoveryForecast,outcomeScore,calibration,PREDICTION_TYPES,OUTCOMES,RULE_VERSION};
