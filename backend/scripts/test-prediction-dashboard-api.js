'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const predictionRouter = require('../routes/predictions');

function postgresExecutor(db){return async(sql,params=[])=>{if(!params.length){const results=await db.exec(String(sql));const last=results[results.length-1];return(last&&last.rows)||[];}let index=0;const translated=String(sql).replace(/\?/g,()=>`$${++index}`);const result=await db.query(translated,params);return result.rows||[];};}
function authenticate(users){return(req,res,next)=>{const user=users[req.headers['x-test-user']];if(!user){return res.status(401).json({error:'missing'});}req.user=user;next();};}
async function request(base,path,user,options={}){const response=await fetch(`${base}${path}`,{...options,headers:{'x-test-user':user||'',...(options.headers||{})}});const body=await response.json().catch(()=>({}));return{response,body};}
async function snapshot(executor,tables){const result={};for(const table of tables){const rows=await executor(`SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb) AS rows FROM ${table} x`);result[table]=rows[0].rows;}return result;}

async function main(){const db=new PGlite();await db.waitReady;const executor=postgresExecutor(db);let server;
    const tables=['agro_metric_forecasts','agro_breach_eta','agro_stress_eta','agro_risk_forecasts','agro_recovery_forecasts','agro_early_warnings'];
    try{
        await executor(`
          CREATE TABLE users(id INTEGER PRIMARY KEY,owner_user_id INTEGER NULL);
          CREATE TABLE devices(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,name TEXT);
          CREATE TABLE agro_context_segments(id BIGINT PRIMARY KEY,owner_user_id INTEGER NOT NULL,device_id INTEGER NOT NULL,
            context_name TEXT NOT NULL,crop_label TEXT,medium VARCHAR(40),usage_type VARCHAR(20),is_production BOOLEAN,
            valid_from TIMESTAMPTZ,valid_to TIMESTAMPTZ);
          CREATE TABLE agro_metric_forecasts(id BIGINT PRIMARY KEY,owner_user_id INTEGER,device_id INTEGER,context_id BIGINT,sensor_id INTEGER,metric VARCHAR(80),generated_at TIMESTAMPTZ,horizon_minutes INTEGER,current_value NUMERIC,forecast_value NUMERIC,forecast_low NUMERIC,forecast_high NUMERIC,confidence NUMERIC,data_quality_score NUMERIC);
          CREATE TABLE agro_breach_eta(id BIGINT PRIMARY KEY,owner_user_id INTEGER,device_id INTEGER,context_id BIGINT,sensor_id INTEGER,metric VARCHAR(80),generated_at TIMESTAMPTZ,breach_direction VARCHAR(20),eta_minutes INTEGER,eta_confidence NUMERIC,threshold_value NUMERIC,horizon_minutes INTEGER,status VARCHAR(24),severity VARCHAR(12));
          CREATE TABLE agro_stress_eta(id BIGINT PRIMARY KEY,owner_user_id INTEGER,device_id INTEGER,context_id BIGINT,generated_at TIMESTAMPTZ,stress_type VARCHAR(40),eta_minutes INTEGER,stress_probability NUMERIC,stress_confidence NUMERIC,current_score NUMERIC,predicted_score NUMERIC,status VARCHAR(28),severity VARCHAR(12));
          CREATE TABLE agro_risk_forecasts(id BIGINT PRIMARY KEY,owner_user_id INTEGER,device_id INTEGER,context_id BIGINT,generated_at TIMESTAMPTZ,forecast_horizon_minutes INTEGER,overall_risk_score NUMERIC,overall_risk_band VARCHAR(12),risk_probability NUMERIC,confidence NUMERIC,predicted_health_score NUMERIC,predicted_intelligence_score NUMERIC,primary_risk VARCHAR(48));
          CREATE TABLE agro_recovery_forecasts(id BIGINT PRIMARY KEY,owner_user_id INTEGER,device_id INTEGER,context_id BIGINT,generated_at TIMESTAMPTZ,recovery_probability NUMERIC,estimated_recovery_minutes INTEGER,estimated_recovery_band VARCHAR(12),confidence NUMERIC,resilience_score NUMERIC,expected_recovery_quality NUMERIC,recovery_risk NUMERIC);
          CREATE TABLE agro_early_warnings(id BIGINT PRIMARY KEY,owner_user_id INTEGER,device_id INTEGER,context_id BIGINT,generated_at TIMESTAMPTZ,warning_type VARCHAR(28),warning_level VARCHAR(12),warning_score NUMERIC,probability NUMERIC,confidence NUMERIC,eta_minutes INTEGER,title TEXT,summary TEXT,recommended_action TEXT,status VARCHAR(12),acknowledged_at TIMESTAMPTZ);
        `);
        await executor(`INSERT INTO users(id) VALUES(1),(2);INSERT INTO devices(id,user_id,name) VALUES(10,1,'Serra Nord'),(20,2,'Serra Sud');
          INSERT INTO agro_context_segments(id,owner_user_id,device_id,context_name,crop_label,medium,usage_type,is_production,valid_from)
          VALUES(100,1,10,'Pomodoro','Pomodoro','suolo','production',TRUE,'2026-01-01'),
                (101,1,10,'Vuoto',NULL,NULL,'production',TRUE,'2026-01-01'),
                (200,2,20,'Agrumi','Agrumi','suolo','production',TRUE,'2026-01-01')`);
        const generated='2026-06-20T12:00:00Z';
        await executor(`INSERT INTO agro_metric_forecasts VALUES(1,1,10,100,1000,'temperature','${generated}',60,22,24,20,28,0.8,0.9),(2,2,20,200,2000,'humidity','${generated}',60,50,55,45,60,0.7,0.8);
          INSERT INTO agro_breach_eta VALUES(10,1,10,100,1000,'temperature','${generated}','above_max',120,0.8,30,180,'breach_likely','high');
          INSERT INTO agro_stress_eta VALUES(20,1,10,100,'${generated}','out_of_range',90,0.8,0.75,60,75,'stress_imminent','high');
          INSERT INTO agro_risk_forecasts VALUES(30,1,10,100,'${generated}',180,72,'high',0.75,0.8,55,60,'stress_eta');
          INSERT INTO agro_recovery_forecasts VALUES(40,1,10,100,'${generated}',0.7,180,'fast',0.8,70,0.75,30);
          INSERT INTO agro_early_warnings VALUES(50,1,10,100,'${generated}','future_breach','urgent',76,0.8,0.8,120,'Superamento futuro','Sintesi','Verificare sensori','active',NULL),
            (51,1,10,100,'${generated}','future_stress','warning',60,0.7,0.7,180,'Risolto','Sintesi','Verificare','resolved',NULL)`);
        const before=await snapshot(executor,tables);
        const users={owner1:{id:1,role:'client',scopeOwnerUserId:1},owner2:{id:2,role:'client',scopeOwnerUserId:2},
          team:{id:3,role:'client',owner_user_id:1,scopeOwnerUserId:1},root:{id:99,role:'super_admin'},admin:{id:98,role:'admin'}};
        const app=express();app.use(express.json());app.use('/api/predictions',predictionRouter.createPredictionRouter({executor,authenticate:authenticate(users)}));
        server=await new Promise((resolve)=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});const base=`http://127.0.0.1:${server.address().port}`;

        let result=await request(base,'/api/predictions/contexts','owner1');assert.equal(result.response.status,200);assert.equal(result.body.contexts.length,2);
        result=await request(base,'/api/predictions/contexts','team');assert.equal(result.body.contexts.length,2,'team shares owner scope');
        result=await request(base,'/api/predictions/contexts?owner_user_id=2','owner1');assert.equal(result.response.status,403);
        result=await request(base,'/api/predictions/contexts?owner_user_id=2','root');assert.equal(result.body.contexts.length,1);
        result=await request(base,'/api/predictions/contexts?owner_user_id=2','admin');assert.equal(result.response.status,403);

        result=await request(base,'/api/predictions/overview?device_id=10&context_id=100','owner1');
        assert.equal(result.response.status,200);assert.equal(result.body.available,true);assert.equal(result.body.metric_forecasts.length,1);
        assert.equal(result.body.breach_eta.length,1);assert.equal(result.body.stress_eta.length,1);assert.equal(result.body.risk_forecasts.length,1);
        assert.equal(Number(result.body.recovery_forecast.estimated_recovery_minutes),180);assert.equal(result.body.early_warnings.length,1,'only active warnings exposed');
        assert.equal(JSON.stringify(result.body).includes('evidence_json'),false,'private evidence not exposed');
        result=await request(base,'/api/predictions/overview?device_id=10&context_id=100','team');assert.equal(result.response.status,200);
        result=await request(base,'/api/predictions/overview?device_id=20&context_id=200','owner1');assert.equal(result.response.status,403);
        result=await request(base,'/api/predictions/overview?device_id=20&context_id=200','root');assert.equal(result.response.status,200);
        result=await request(base,'/api/predictions/overview?device_id=10&context_id=101','owner1');
        assert.equal(result.body.available,false);assert.deepEqual(result.body.metric_forecasts,[]);assert.equal(result.body.recovery_forecast,null);
        result=await request(base,'/api/predictions/metric-forecasts?device_id=10&context_id=100','owner1');assert.equal(result.body.metric_forecasts.length,1);
        result=await request(base,'/api/predictions/early-warnings?device_id=10&context_id=100','owner1');assert.equal(result.body.early_warnings.length,1);
        result=await request(base,'/api/predictions/overview?device_id=10&context_id=100',null);assert.equal(result.response.status,401);
        result=await request(base,'/api/predictions/overview?device_id=10&context_id=100','owner1',{method:'POST'});assert.equal(result.response.status,404,'prediction API is read-only');
        assert.deepEqual(await snapshot(executor,tables),before,'prediction API does not write');
        console.log('PASS prediction dashboard route/API validation');
        console.log(JSON.stringify({authenticated:true,owner_team_scope:true,super_admin_inspection:true,cross_customer_denied:true,
          read_only:true,all_prediction_sections:true,missing_predictions_graceful:true,private_evidence_hidden:true}));
    }finally{if(server){await new Promise((resolve)=>server.close(resolve));}await db.close();}
}
main().catch((error)=>{console.error(error.stack||error);process.exit(1);});
