'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensurePredictionCalibrationSchema, runPredictionCalibrationCycle: runEngine } = require('../../utils/prediction-calibration');

const CRON_EXPRESSION = process.env.AGRO_PREDICTION_CALIBRATION_CRON || '59 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit=String(process.env.AGRO_PREDICTION_CALIBRATION_ENABLED||'').trim().toLowerCase();
    if(explicit==='true'){return true;}if(explicit==='false'){return false;}
    try{const rows=await executor("SELECT config_value FROM runtime_config WHERE config_key='agro_prediction_calibration_enabled' LIMIT 1");
        return rows.length>0&&String(rows[0].config_value).toLowerCase()==='true';}catch(_error){return false;}
}

async function runPredictionCalibrationCycle({dryRun=false,executor=query,ensureContext=null}={}){
    if(cycleRunning){return{skipped_concurrent:true,stored:0,dry_run:dryRun};}cycleRunning=true;
    try{if(!schemaReady&&!dryRun){await ensurePredictionCalibrationSchema({executor,...(ensureContext?{ensureContext}:{})});schemaReady=true;}
        const summary=await runEngine({dryRun,executor});console.log(`[prediction-calibration] cycle done${dryRun?' (dry-run)':''}:`,`groups=${summary.groups}`,`stored=${summary.stored}`);return summary;
    }finally{cycleRunning=false;}
}

function startPredictionCalibrationJob(){ensurePredictionCalibrationSchema().then(()=>{schemaReady=true;return isEnabled();})
    .then((enabled)=>{if(!enabled){console.log('[prediction-calibration] disabled - not scheduled. Enable with AGRO_PREDICTION_CALIBRATION_ENABLED=true.');return;}
        if(scheduledTask){return;}scheduledTask=cron.schedule(CRON_EXPRESSION,()=>{runPredictionCalibrationCycle().catch((error)=>console.error('[prediction-calibration] cycle error:',error.message));});
        console.log(`[prediction-calibration] scheduled: ${CRON_EXPRESSION}`);})
    .catch((error)=>console.error('[prediction-calibration] schema/start failed:',error.message));}

function stopPredictionCalibrationJob(){if(scheduledTask){try{scheduledTask.stop();}catch(_error){/* noop */}scheduledTask=null;}}
module.exports={startPredictionCalibrationJob,stopPredictionCalibrationJob,runPredictionCalibrationCycle,isEnabled};
