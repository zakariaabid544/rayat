'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { ensureRecoveryForecastSchema } = require('../utils/recovery-forecast');
const { ensureEarlyWarningSchema } = require('../utils/early-warning');
const { runRecoveryForecastCycle, isEnabled: recoveryEnabled } = require('../src/jobs/recoveryForecastJob');
const { runEarlyWarningCycle, isEnabled: warningEnabled } = require('../src/jobs/earlyWarningJob');

const NOW = new Date('2026-06-20T12:00:00.000Z');

function postgresExecutor(db) {
    return async (sql, params = []) => {
        if (!params.length) {
            const results = await db.exec(String(sql));
            const last = results[results.length - 1];
            return (last && last.rows) || [];
        }
        let index = 0;
        const translated = String(sql).replace(/\?/g, () => `$${++index}`);
        const result = await db.query(translated, params);
        return result.rows || [];
    };
}

async function snapshot(executor, tables) {
    const result = {};
    for (const table of tables) {
        const rows = await executor(
            `SELECT COALESCE(jsonb_agg(to_jsonb(source) ORDER BY source.id),'[]'::jsonb) AS rows FROM ${table} source`
        );
        result[table] = rows[0].rows;
    }
    return result;
}

async function recoverySnapshot(executor) {
    return executor(
        `SELECT owner_user_id,device_id,context_id,generated_at,recovery_probability,
                estimated_recovery_minutes,estimated_recovery_band,confidence,resilience_score,
                expected_recovery_quality,recovery_risk,positive_signals_json,negative_signals_json,
                evidence_json,rule_version
         FROM agro_recovery_forecasts ORDER BY owner_user_id,device_id,context_id`
    );
}

async function warningSnapshot(executor) {
    return executor(
        `SELECT owner_user_id,device_id,context_id,generated_at,warning_type,warning_level,
                warning_score,probability,confidence,eta_minutes,title,summary,recommended_action,
                evidence_json,status,acknowledged_at,resolved_at,rule_version
         FROM agro_early_warnings ORDER BY owner_user_id,device_id,context_id,warning_type`
    );
}

async function main() {
    const db = new PGlite();
    await db.waitReady;
    const executor = postgresExecutor(db);
    const protectedTables = ['sensor_readings','alarm_events','active_alerts','users','devices','sensors'];
    const sourceTables = ['agro_recovery_memory','agro_stress_memory','agro_stress_eta','agro_risk_forecasts',
        'agro_greenhouse_health_profile','agro_intelligence_score','agro_metric_forecasts',
        'agro_intelligence_trends','agro_breach_eta'];
    try {
        const recoveryFlag=process.env.AGRO_RECOVERY_FORECAST_ENABLED;
        const warningFlag=process.env.AGRO_EARLY_WARNING_ENABLED;
        delete process.env.AGRO_RECOVERY_FORECAST_ENABLED;
        delete process.env.AGRO_EARLY_WARNING_ENABLED;
        assert.equal(await recoveryEnabled({executor}),false);
        assert.equal(await warningEnabled({executor}),false);
        if(recoveryFlag!==undefined){process.env.AGRO_RECOVERY_FORECAST_ENABLED=recoveryFlag;}
        if(warningFlag!==undefined){process.env.AGRO_EARLY_WARNING_ENABLED=warningFlag;}

        await executor(`
          CREATE TABLE users(id INTEGER PRIMARY KEY,owner_user_id INTEGER NULL REFERENCES users(id));
          CREATE TABLE devices(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id));
          CREATE TABLE sensors(id INTEGER PRIMARY KEY,device_id INTEGER NOT NULL REFERENCES devices(id));
          CREATE TABLE sensor_readings(id BIGSERIAL PRIMARY KEY,sensor_id INTEGER,value NUMERIC,timestamp TIMESTAMPTZ);
          CREATE TABLE alarm_events(id BIGSERIAL PRIMARY KEY,sensor_id INTEGER);
          CREATE TABLE active_alerts(id BIGSERIAL PRIMARY KEY,sensor_id INTEGER);
          CREATE TABLE agro_context_segments(
            id BIGINT PRIMARY KEY,owner_user_id INTEGER NOT NULL REFERENCES users(id),
            device_id INTEGER NOT NULL REFERENCES devices(id),sensor_id INTEGER NULL,
            usage_type VARCHAR(20) NOT NULL,is_production BOOLEAN NOT NULL,
            valid_from TIMESTAMPTZ NOT NULL,valid_to TIMESTAMPTZ NULL);
          CREATE TABLE agro_recovery_memory(
            id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL,metric VARCHAR(80) NOT NULL,recovery_count INTEGER NOT NULL,
            average_recovery_duration NUMERIC NOT NULL,recovery_quality_score NUMERIC NOT NULL,
            recovery_stability_score NUMERIC NOT NULL,relapse_rate NUMERIC NOT NULL,
            fast_recovery_rate NUMERIC NOT NULL,slow_recovery_rate NUMERIC NOT NULL,confidence NUMERIC NOT NULL);
          CREATE TABLE agro_stress_memory(
            id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL,metric VARCHAR(80) NOT NULL,stress_type VARCHAR(40) NOT NULL,
            recurrence_score NUMERIC NOT NULL);
          CREATE TABLE agro_stress_eta(
            id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL,stress_type VARCHAR(40) NOT NULL,status VARCHAR(28) NOT NULL,
            eta_minutes INTEGER NULL,stress_probability NUMERIC NOT NULL,stress_confidence NUMERIC NOT NULL);
          CREATE TABLE agro_risk_forecasts(
            id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL,forecast_horizon_minutes INTEGER NOT NULL,
            overall_risk_score NUMERIC NOT NULL,overall_risk_band VARCHAR(12) NOT NULL,
            risk_probability NUMERIC NOT NULL,confidence NUMERIC NOT NULL,primary_risk VARCHAR(48),
            evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb);
          CREATE TABLE agro_greenhouse_health_profile(
            id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL,health_score NUMERIC NOT NULL,resilience_score NUMERIC NOT NULL,
            recovery_score NUMERIC NOT NULL,confidence NUMERIC NOT NULL);
          CREATE TABLE agro_intelligence_score(
            id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL,intelligence_score NUMERIC NOT NULL,confidence NUMERIC NOT NULL);
          CREATE TABLE agro_metric_forecasts(
            id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL,sensor_id INTEGER NOT NULL,horizon_minutes INTEGER NOT NULL,
            confidence NUMERIC NOT NULL,data_quality_score NUMERIC NOT NULL);
          CREATE TABLE agro_intelligence_trends(
            id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL,metric VARCHAR(24) NOT NULL,trend_direction VARCHAR(20) NOT NULL,
            trend_confidence NUMERIC NOT NULL);
          CREATE TABLE agro_breach_eta(
            id BIGSERIAL PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_id BIGINT NOT NULL,sensor_id INTEGER NOT NULL,horizon_minutes INTEGER NOT NULL,
            metric VARCHAR(80),breach_direction VARCHAR(20),status VARCHAR(24) NOT NULL,
            eta_minutes INTEGER NULL,eta_confidence NUMERIC NOT NULL);
        `);
        await executor('INSERT INTO users(id) VALUES(1),(2)');
        await executor('INSERT INTO devices(id,user_id) VALUES(10,1),(20,2)');
        await executor('INSERT INTO sensors(id,device_id) VALUES(1000,10),(1001,10),(1002,10),(2000,20)');
        await executor("INSERT INTO sensor_readings(sensor_id,value,timestamp) VALUES(1000,25,'2026-06-20')");
        await executor('INSERT INTO alarm_events(sensor_id) VALUES(1000)');
        await executor('INSERT INTO active_alerts(sensor_id) VALUES(1000)');
        await executor(
            `INSERT INTO agro_context_segments(id,owner_user_id,device_id,usage_type,is_production,valid_from)
             VALUES(100,1,10,'production',TRUE,'2026-06-01'),
                   (101,1,10,'production',TRUE,'2026-06-01'),
                   (102,1,10,'demo',FALSE,'2026-06-01'),
                   (200,2,20,'production',TRUE,'2026-06-01')`
        );
        await executor(
            `INSERT INTO agro_recovery_memory
              (owner_user_id,device_id,context_id,metric,recovery_count,average_recovery_duration,
               recovery_quality_score,recovery_stability_score,relapse_rate,fast_recovery_rate,slow_recovery_rate,confidence)
             VALUES(1,10,100,'temperature',30,3600,0.9,0.9,0.05,0.9,0.05,0.9),
                   (1,10,101,'temperature',25,36000,0.35,0.3,0.7,0.1,0.8,0.85),
                   (1,10,102,'temperature',10,7200,0.7,0.7,0.2,0.6,0.2,0.8)`
        );
        await executor(
            `INSERT INTO agro_stress_memory(owner_user_id,device_id,context_id,metric,stress_type,recurrence_score)
             VALUES(1,10,100,'temperature','out_of_range',0.1),
                   (1,10,101,'temperature','out_of_range',0.9),
                   (1,10,102,'temperature','out_of_range',0.5),
                   (2,20,200,'temperature','out_of_range',0.2)`
        );
        await executor(
            `INSERT INTO agro_stress_eta(owner_user_id,device_id,context_id,stress_type,status,eta_minutes,stress_probability,stress_confidence)
             VALUES(1,10,100,'out_of_range','no_stress_expected',NULL,0.1,0.9),
                   (1,10,101,'out_of_range','stress_imminent',90,0.88,0.85),
                   (1,10,102,'out_of_range','stress_possible',300,0.5,0.8),
                   (2,20,200,'out_of_range','insufficient_data',NULL,0,0.2)`
        );
        await executor(
            `INSERT INTO agro_risk_forecasts(owner_user_id,device_id,context_id,forecast_horizon_minutes,
               overall_risk_score,overall_risk_band,risk_probability,confidence,primary_risk,evidence_json)
             VALUES(1,10,100,180,10,'very_low',0.1,0.9,'forecast_uncertainty','{"factors":{"trend_deterioration":0.05}}'),
                   (1,10,101,180,88,'critical',0.85,0.85,'stress_eta','{"factors":{"trend_deterioration":0.8}}'),
                   (1,10,102,180,50,'medium',0.5,0.8,'stress_eta','{"factors":{"trend_deterioration":0.4}}'),
                   (2,20,200,180,40,'medium',0.4,0.2,'forecast_uncertainty','{"factors":{"trend_deterioration":0.3}}')`
        );
        await executor(
            `INSERT INTO agro_greenhouse_health_profile(owner_user_id,device_id,context_id,health_score,resilience_score,recovery_score,confidence)
             VALUES(1,10,100,90,90,90,0.9),(1,10,101,30,30,30,0.85),
                   (1,10,102,60,60,60,0.8),(2,20,200,55,55,55,0.2)`
        );
        await executor(
            `INSERT INTO agro_intelligence_score(owner_user_id,device_id,context_id,intelligence_score,confidence)
             VALUES(1,10,100,90,0.9),(1,10,101,35,0.85),(1,10,102,60,0.8),(2,20,200,55,0.2)`
        );
        await executor(
            `INSERT INTO agro_metric_forecasts(owner_user_id,device_id,context_id,sensor_id,horizon_minutes,confidence,data_quality_score)
             VALUES(1,10,100,1000,60,0.9,0.9),(1,10,101,1001,60,0.85,0.85),
                   (1,10,102,1002,60,0.8,0.8),(2,20,200,2000,60,0.15,0.2),
                   (2,20,200,2000,180,0.2,0.2)`
        );
        await executor(
            `INSERT INTO agro_intelligence_trends(owner_user_id,device_id,context_id,metric,trend_direction,trend_confidence)
             VALUES(1,10,100,'recovery','improving',0.9),(1,10,101,'recovery','degrading',0.9),
                   (1,10,102,'recovery','stable',0.8),(2,20,200,'recovery','stable',0.2)`
        );
        await executor(
            `INSERT INTO agro_breach_eta(owner_user_id,device_id,context_id,sensor_id,horizon_minutes,metric,breach_direction,status,eta_minutes,eta_confidence)
             VALUES(1,10,100,1000,180,'temperature','none','no_breach_expected',NULL,0.9),
                   (1,10,101,1001,180,'temperature','above_max','breach_likely',120,0.9),
                   (1,10,102,1002,180,'temperature','above_max','breach_possible',150,0.8),
                   (2,20,200,2000,180,'temperature','unknown','insufficient_data',NULL,0.2)`
        );

        await ensureRecoveryForecastSchema({executor,ensureContext:async()=>{}});
        await ensureEarlyWarningSchema({executor,ensureContext:async()=>{}});
        const constraints=new Set((await executor(
            `SELECT conname FROM pg_constraint WHERE conrelid IN ('agro_recovery_forecasts'::regclass,'agro_early_warnings'::regclass)`
        )).map((row)=>row.conname));
        assert.ok(constraints.has('uniq_recovery_forecast'));
        assert.ok(constraints.has('recovery_forecast_values_check'));
        assert.ok(constraints.has('uniq_early_warning'));
        assert.ok(constraints.has('early_warning_values_check'));

        const protectedBefore=await snapshot(executor,protectedTables);
        const sourcesBefore=await snapshot(executor,sourceTables);
        const dryRecovery=await runRecoveryForecastCycle({dryRun:true,generatedAt:NOW,executor});
        assert.equal(dryRecovery.contexts,3);
        assert.equal((await recoverySnapshot(executor)).length,0,'recovery dry-run writes nothing');
        await runRecoveryForecastCycle({generatedAt:NOW,executor,ensureContext:async()=>{}});
        let recoveries=await recoverySnapshot(executor);
        assert.equal(recoveries.length,3);
        assert.equal(recoveries.some((row)=>Number(row.context_id)===102),false);
        const strong=recoveries.find((row)=>Number(row.context_id)===100);
        const weak=recoveries.find((row)=>Number(row.context_id)===101);
        const insufficient=recoveries.find((row)=>Number(row.context_id)===200);
        assert.ok(Number(strong.recovery_probability)>Number(weak.recovery_probability));
        assert.ok(Number(strong.estimated_recovery_minutes)<Number(weak.estimated_recovery_minutes));
        assert.equal(insufficient.estimated_recovery_band,'unknown');
        const recoveryOne=JSON.stringify(recoveries);
        await runRecoveryForecastCycle({generatedAt:NOW,executor});
        recoveries=await recoverySnapshot(executor);
        assert.equal(JSON.stringify(recoveries),recoveryOne,'recovery rerun deterministic');
        assert.equal(recoveries.length,3,'recovery rerun idempotent');

        const dryWarning=await runEarlyWarningCycle({dryRun:true,generatedAt:NOW,executor});
        assert.equal(dryWarning.contexts,3);
        assert.equal((await warningSnapshot(executor)).length,0,'warning dry-run writes nothing');
        await runEarlyWarningCycle({generatedAt:NOW,executor,ensureContext:async()=>{}});
        let warnings=await warningSnapshot(executor);
        assert.equal(warnings.some((row)=>Number(row.context_id)===102),false);
        const weakTypes=new Set(warnings.filter((row)=>Number(row.context_id)===101).map((row)=>row.warning_type));
        for(const type of ['future_breach','future_stress','future_risk','weak_recovery','trend_deterioration']){
            assert.ok(weakTypes.has(type),`${type} warning missing`);
        }
        const lowConfidence=warnings.find((row)=>Number(row.context_id)===200&&row.warning_type==='confidence_drop');
        assert.ok(lowConfidence,'low confidence warning missing');
        assert.equal(warnings.filter((row)=>Number(row.context_id)===100).length,0,'healthy context has no warning');
        assert.ok(warnings.every((row)=>row.title&&row.summary&&row.recommended_action&&Number(row.eta_minutes)>0));
        const warningsOne=JSON.stringify(warnings);
        await runEarlyWarningCycle({generatedAt:NOW,executor});
        warnings=await warningSnapshot(executor);
        assert.equal(JSON.stringify(warnings),warningsOne,'warning rerun deterministic');
        assert.equal(new Set(warnings.map((row)=>`${row.owner_user_id}:${row.device_id}:${row.context_id}:${row.warning_type}`)).size,warnings.length);

        await executor("UPDATE agro_early_warnings SET status='acknowledged',acknowledged_at=? WHERE context_id=101 AND warning_type='future_breach'",[NOW.toISOString()]);
        await runEarlyWarningCycle({generatedAt:NOW,executor});
        const acknowledged=(await warningSnapshot(executor)).find((row)=>Number(row.context_id)===101&&row.warning_type==='future_breach');
        assert.equal(acknowledged.status,'acknowledged','acknowledgement preserved on rerun');

        await assert.rejects(()=>executor(
            `INSERT INTO agro_recovery_forecasts(owner_user_id,device_id,context_id,generated_at,recovery_probability,
             estimated_recovery_band,confidence,resilience_score,expected_recovery_quality,recovery_risk)
             VALUES(2,20,100,?,0.5,'unknown',0.2,50,0.4,50)`,[NOW.toISOString()]),/context mismatch/);
        await assert.rejects(()=>executor(
            `INSERT INTO agro_early_warnings(owner_user_id,device_id,context_id,generated_at,warning_type,warning_level,
             warning_score,probability,confidence,eta_minutes,title,summary,recommended_action)
             VALUES(1,10,200,?,'future_risk','warning',60,0.6,0.6,60,'x','x','x')`,[NOW.toISOString()]),/context mismatch/);

        assert.deepEqual(await snapshot(executor,protectedTables),protectedBefore,'protected tables unchanged');
        assert.deepEqual(await snapshot(executor,sourceTables),sourcesBefore,'source intelligence tables unchanged');
        console.log('PASS embedded PostgreSQL recovery forecast and early warning validation');
        console.log(JSON.stringify({recovery_forecasts:recoveries.length,early_warnings:warnings.length,
            owners:2,production_contexts:3,strong_recovery:true,weak_recovery:true,insufficient_data:true,
            future_breach_warning:true,future_stress_warning:true,future_risk_warning:true,
            confidence_drop_warning:true,tenant_isolation:true,context_isolation:true,
            production_only:true,idempotent_deterministic:true,protected_tables_unchanged:true}));
    } finally { await db.close(); }
}

main().catch((error)=>{console.error(error.stack||error);process.exit(1);});
