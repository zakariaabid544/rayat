'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { ensurePredictionBacktestSchema } = require('../utils/prediction-backtest');
const { ensurePredictionCalibrationSchema } = require('../utils/prediction-calibration');
const { runPredictionBacktestCycle, isEnabled: backtestEnabled } = require('../src/jobs/predictionBacktestJob');
const { runPredictionCalibrationCycle, isEnabled: calibrationEnabled } = require('../src/jobs/predictionCalibrationJob');

const GENERATED = new Date('2026-06-18T00:00:00.000Z');
const EVALUATED = new Date('2026-06-21T12:00:00.000Z');

function postgresExecutor(db) {
    return async (sql, params = []) => {
        if (!params.length) {
            const results = await db.exec(String(sql));
            const last = results[results.length - 1];
            return (last && last.rows) || [];
        }
        let index=0;const translated=String(sql).replace(/\?/g,()=>`$${++index}`);
        const result=await db.query(translated,params);return result.rows||[];
    };
}

async function snapshot(executor,tables){const result={};for(const table of tables){const rows=await executor(`SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb) AS rows FROM ${table} x`);result[table]=rows[0].rows;}return result;}
async function backtestRows(executor){return executor(`SELECT owner_user_id,device_id,context_id,prediction_type,prediction_id,generated_at,evaluated_at,outcome,prediction_error,confidence,calibration_score,evidence_json,rule_version FROM agro_prediction_backtests ORDER BY owner_user_id,device_id,context_id,prediction_type,prediction_id`);}
async function calibrationRows(executor){return executor(`SELECT owner_user_id,device_id,context_id,prediction_type,total_predictions,accuracy_score,calibration_score,confidence_score,maturity_level,last_evaluated_at,rule_version FROM agro_prediction_calibration ORDER BY owner_user_id,device_id,context_id,prediction_type`);}

async function main(){
    const db=new PGlite();await db.waitReady;const executor=postgresExecutor(db);
    const protectedTables=['sensor_readings','alarm_events','active_alerts','users','devices','sensors'];
    const sourceTables=['agro_metric_forecasts','agro_breach_eta','agro_stress_eta','agro_risk_forecasts','agro_recovery_forecasts','agro_actions_detected','agro_intelligence_score_history'];
    try{
        delete process.env.AGRO_PREDICTION_BACKTEST_ENABLED;delete process.env.AGRO_PREDICTION_CALIBRATION_ENABLED;
        assert.equal(await backtestEnabled({executor}),false);assert.equal(await calibrationEnabled({executor}),false);
        await executor(`
          CREATE TABLE users(id INTEGER PRIMARY KEY,owner_user_id INTEGER NULL REFERENCES users(id));
          CREATE TABLE devices(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id));
          CREATE TABLE sensors(id INTEGER PRIMARY KEY,device_id INTEGER NOT NULL REFERENCES devices(id));
          CREATE TABLE sensor_readings(id BIGSERIAL PRIMARY KEY,sensor_id INTEGER NOT NULL,value NUMERIC NOT NULL,timestamp TIMESTAMPTZ NOT NULL);
          CREATE TABLE alarm_events(id BIGSERIAL PRIMARY KEY,sensor_id INTEGER);
          CREATE TABLE active_alerts(id BIGSERIAL PRIMARY KEY,sensor_id INTEGER);
          CREATE TABLE agro_context_segments(id BIGINT PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_name TEXT NOT NULL,usage_type VARCHAR(20) NOT NULL,is_production BOOLEAN NOT NULL,valid_from TIMESTAMPTZ NOT NULL,valid_to TIMESTAMPTZ NULL);
          CREATE TABLE agro_metric_forecasts(id BIGINT PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,context_id BIGINT NOT NULL,sensor_id INTEGER NOT NULL,
            metric VARCHAR(80) NOT NULL,generated_at TIMESTAMPTZ NOT NULL,horizon_minutes INTEGER NOT NULL,forecast_value NUMERIC NOT NULL,forecast_low NUMERIC NOT NULL,forecast_high NUMERIC NOT NULL,confidence NUMERIC NOT NULL);
          CREATE TABLE agro_breach_eta(id BIGINT PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,context_id BIGINT NOT NULL,sensor_id INTEGER NOT NULL,
            metric VARCHAR(80),generated_at TIMESTAMPTZ NOT NULL,horizon_minutes INTEGER NOT NULL,breach_direction VARCHAR(20),threshold_value NUMERIC,eta_minutes INTEGER,eta_confidence NUMERIC,status VARCHAR(24));
          CREATE TABLE agro_stress_eta(id BIGINT PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,context_id BIGINT NOT NULL,
            generated_at TIMESTAMPTZ NOT NULL,stress_type VARCHAR(40),status VARCHAR(28),eta_minutes INTEGER,stress_probability NUMERIC,stress_confidence NUMERIC);
          CREATE TABLE agro_risk_forecasts(id BIGINT PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,context_id BIGINT NOT NULL,
            generated_at TIMESTAMPTZ NOT NULL,forecast_horizon_minutes INTEGER,overall_risk_score NUMERIC,overall_risk_band VARCHAR(12),risk_probability NUMERIC,confidence NUMERIC,predicted_intelligence_score NUMERIC);
          CREATE TABLE agro_recovery_forecasts(id BIGINT PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,context_id BIGINT NOT NULL,
            generated_at TIMESTAMPTZ NOT NULL,recovery_probability NUMERIC,estimated_recovery_minutes INTEGER,estimated_recovery_band VARCHAR(12),confidence NUMERIC);
          CREATE TABLE agro_actions_detected(id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,context_id BIGINT NOT NULL,event_type VARCHAR(40),started_at TIMESTAMPTZ);
          CREATE TABLE agro_intelligence_score_history(id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,context_id BIGINT NOT NULL,captured_on DATE NOT NULL,intelligence_score NUMERIC NOT NULL);
        `);
        await executor('INSERT INTO users(id) VALUES(1),(2)');
        await executor('INSERT INTO devices(id,user_id) VALUES(10,1),(20,2)');
        await executor('INSERT INTO sensors(id,device_id) VALUES(1000,10),(1001,10),(2000,20)');
        await executor(`INSERT INTO agro_context_segments(id,owner_user_id,device_id,context_name,usage_type,is_production,valid_from)
          VALUES(100,1,10,'Serra A','production',TRUE,'2026-01-01'),(102,1,10,'Demo','demo',FALSE,'2026-01-01'),
                (200,2,20,'Serra B','production',TRUE,'2026-01-01')`);
        await executor(`INSERT INTO agro_metric_forecasts(id,owner_user_id,device_id,context_id,sensor_id,metric,generated_at,horizon_minutes,forecast_value,forecast_low,forecast_high,confidence)
          VALUES(1,1,10,100,1000,'temperature',?,60,20,18,22,0.8),(2,1,10,100,1001,'humidity',?,60,10,9,11,0.8),
                (3,2,20,200,2000,'temperature',?,60,30,28,32,0.6),(4,1,10,102,1000,'temperature',?,60,20,18,22,0.8)`,
            [GENERATED.toISOString(),GENERATED.toISOString(),GENERATED.toISOString(),GENERATED.toISOString()]);
        await executor(`INSERT INTO agro_breach_eta(id,owner_user_id,device_id,context_id,sensor_id,metric,generated_at,horizon_minutes,breach_direction,threshold_value,eta_minutes,eta_confidence,status)
          VALUES(10,1,10,100,1000,'temperature',?,180,'above_max',25,120,0.85,'breach_likely')`,[GENERATED.toISOString()]);
        await executor(`INSERT INTO agro_stress_eta(id,owner_user_id,device_id,context_id,generated_at,stress_type,status,eta_minutes,stress_probability,stress_confidence)
          VALUES(20,1,10,100,?,'out_of_range','stress_imminent',90,0.85,0.8)`,[GENERATED.toISOString()]);
        await executor(`INSERT INTO agro_risk_forecasts(id,owner_user_id,device_id,context_id,generated_at,forecast_horizon_minutes,overall_risk_score,overall_risk_band,risk_probability,confidence,predicted_intelligence_score)
          VALUES(30,1,10,100,?,180,35,'low',0.3,0.8,62)`,[GENERATED.toISOString()]);
        await executor(`INSERT INTO agro_recovery_forecasts(id,owner_user_id,device_id,context_id,generated_at,recovery_probability,estimated_recovery_minutes,estimated_recovery_band,confidence)
          VALUES(40,1,10,100,?,0.8,120,'fast',0.8)`,[GENERATED.toISOString()]);
        await executor(`INSERT INTO sensor_readings(sensor_id,value,timestamp) VALUES
          (1000,21,'2026-06-18T01:00:00Z'),(1001,20,'2026-06-18T01:00:00Z'),
          (1000,26,'2026-06-18T01:40:00Z'),(1000,24,'2026-06-18T02:20:00Z')`);
        await executor(`INSERT INTO alarm_events(sensor_id) VALUES(1000);INSERT INTO active_alerts(sensor_id) VALUES(1000);`);
        await executor(`INSERT INTO agro_actions_detected(owner_user_id,device_id,context_id,event_type,started_at)
          VALUES(1,10,100,'out_of_range','2026-06-18T01:20:00Z'),(1,10,100,'recovery','2026-06-18T02:10:00Z')`);
        await executor(`INSERT INTO agro_intelligence_score_history(owner_user_id,device_id,context_id,captured_on,intelligence_score)
          VALUES(1,10,100,'2026-06-18',66)`);

        await ensurePredictionBacktestSchema({executor,ensureContext:async()=>{}});
        await ensurePredictionCalibrationSchema({executor,ensureContext:async()=>{}});
        const constraints=new Set((await executor(`SELECT conname FROM pg_constraint WHERE conrelid IN
          ('agro_prediction_snapshots'::regclass,'agro_prediction_backtests'::regclass,'agro_prediction_calibration'::regclass)`)).map((row)=>row.conname));
        assert.ok(constraints.has('uniq_prediction_snapshot'));assert.ok(constraints.has('uniq_prediction_backtest'));assert.ok(constraints.has('uniq_prediction_calibration'));
        const protectedBefore=await snapshot(executor,protectedTables);const sourcesBefore=await snapshot(executor,sourceTables);

        const dryCapture=await runPredictionBacktestCycle({dryRun:true,evaluatedAt:GENERATED,executor});
        assert.equal(dryCapture.would_capture,7);assert.equal((await executor('SELECT * FROM agro_prediction_snapshots')).length,0);
        const capture=await runPredictionBacktestCycle({evaluatedAt:GENERATED,executor,ensureContext:async()=>{}});
        assert.equal(capture.snapshots_captured,7);assert.equal(capture.due,0);
        await runPredictionBacktestCycle({evaluatedAt:GENERATED,executor});
        assert.equal((await executor('SELECT * FROM agro_prediction_snapshots')).length,7,'snapshot capture idempotent');

        const dryEvaluation=await runPredictionBacktestCycle({dryRun:true,evaluatedAt:EVALUATED,executor});
        assert.equal(dryEvaluation.due,7);assert.equal((await backtestRows(executor)).length,0);
        const evaluated=await runPredictionBacktestCycle({evaluatedAt:EVALUATED,executor});
        assert.equal(evaluated.evaluated,7);
        let rows=await backtestRows(executor);assert.equal(rows.length,7);
        assert.equal(rows.find((row)=>row.prediction_type==='metric_forecast'&&Number(row.prediction_id)===1).outcome,'correct');
        assert.equal(rows.find((row)=>row.prediction_type==='metric_forecast'&&Number(row.prediction_id)===2).outcome,'incorrect');
        assert.equal(rows.find((row)=>row.prediction_type==='metric_forecast'&&Number(row.prediction_id)===3).outcome,'insufficient_data');
        assert.equal(rows.find((row)=>row.prediction_type==='breach_eta').outcome,'correct');
        assert.equal(rows.find((row)=>row.prediction_type==='stress_eta').outcome,'correct');
        assert.equal(rows.find((row)=>row.prediction_type==='risk_forecast').outcome,'correct');
        assert.equal(rows.find((row)=>row.prediction_type==='recovery_forecast').outcome,'correct');
        const businessOne=JSON.stringify(rows);const rerun=await runPredictionBacktestCycle({evaluatedAt:EVALUATED,executor});
        assert.equal(rerun.due,0);rows=await backtestRows(executor);assert.equal(JSON.stringify(rows),businessOne,'backtest rerun deterministic');

        await executor(`INSERT INTO agro_prediction_backtests(owner_user_id,device_id,context_id,prediction_type,prediction_id,generated_at,evaluated_at,outcome,prediction_error,confidence,calibration_score,rule_version)
          VALUES(1,10,100,'metric_forecast',901,'2026-06-17',?,'correct',1,0.8,0.8,'s6.8')`,[EVALUATED.toISOString()]);
        const dryCalibration=await runPredictionCalibrationCycle({dryRun:true,executor});
        assert.equal(dryCalibration.calibration_rows,1);assert.equal((await calibrationRows(executor)).length,0);
        await runPredictionCalibrationCycle({executor,ensureContext:async()=>{}});
        let calibration=await calibrationRows(executor);assert.equal(calibration.length,1);
        assert.equal(calibration[0].prediction_type,'metric_forecast');assert.equal(Number(calibration[0].total_predictions),3);
        const calibrationOne=JSON.stringify(calibration);await runPredictionCalibrationCycle({executor});
        calibration=await calibrationRows(executor);assert.equal(JSON.stringify(calibration),calibrationOne,'calibration rerun deterministic');

        await assert.rejects(()=>executor(`INSERT INTO agro_prediction_backtests(owner_user_id,device_id,context_id,prediction_type,prediction_id,generated_at,evaluated_at,outcome,confidence,calibration_score)
          VALUES(2,20,100,'metric_forecast',999,?,?, 'correct',0.8,0.8)`,[GENERATED.toISOString(),EVALUATED.toISOString()]),/context mismatch/);
        await assert.rejects(()=>executor(`INSERT INTO agro_prediction_calibration(owner_user_id,device_id,context_id,prediction_type,total_predictions,accuracy_score,calibration_score,confidence_score,maturity_level,last_evaluated_at)
          VALUES(1,10,200,'metric_forecast',3,0.8,0.8,0.8,'cold_start',?)`,[EVALUATED.toISOString()]),/context mismatch/);
        assert.deepEqual(await snapshot(executor,protectedTables),protectedBefore,'protected tables unchanged');
        assert.deepEqual(await snapshot(executor,sourceTables),sourcesBefore,'prediction and observation sources unchanged');
        console.log('PASS embedded PostgreSQL prediction backtest and calibration validation');
        console.log(JSON.stringify({snapshots:7,backtests:rows.length,calibration_rows:calibration.length,owners:2,
          correct_prediction:true,incorrect_prediction:true,insufficient_data:true,production_only:true,
          tenant_isolation:true,context_isolation:true,dry_run:true,idempotent_deterministic:true,protected_tables_unchanged:true}));
    }finally{await db.close();}
}
main().catch((error)=>{console.error(error.stack||error);process.exit(1);});
