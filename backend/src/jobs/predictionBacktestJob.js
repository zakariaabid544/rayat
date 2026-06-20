'use strict';

const cron = require('node-cron');
const { query } = require('../../config/database');
const { ensurePredictionBacktestSchema, runPredictionBacktestCycle: runEngine } = require('../../utils/prediction-backtest');

const CRON_EXPRESSION = process.env.AGRO_PREDICTION_BACKTEST_CRON || '58 * * * *';
let scheduledTask = null;
let schemaReady = false;
let cycleRunning = false;

async function isEnabled({ executor = query } = {}) {
    const explicit = String(process.env.AGRO_PREDICTION_BACKTEST_ENABLED || '').trim().toLowerCase();
    if (explicit === 'true') { return true; }
    if (explicit === 'false') { return false; }
    try {
        const rows = await executor("SELECT config_value FROM runtime_config WHERE config_key='agro_prediction_backtest_enabled' LIMIT 1");
        return rows.length > 0 && String(rows[0].config_value).toLowerCase() === 'true';
    } catch (_error) { return false; }
}

async function runPredictionBacktestCycle({
    dryRun = false, evaluatedAt = new Date(), batchSize = 500,
    executor = query, ensureContext = null
} = {}) {
    if (cycleRunning) { return { skipped_concurrent:true,evaluated:0,dry_run:dryRun }; }
    cycleRunning=true;
    try {
        if(!schemaReady&&!dryRun){await ensurePredictionBacktestSchema({executor,...(ensureContext?{ensureContext}:{})});schemaReady=true;}
        const summary=await runEngine({dryRun,evaluatedAt,batchSize,executor});
        console.log(`[prediction-backtest] cycle done${dryRun?' (dry-run)':''}:`,
            `captured=${summary.snapshots_captured}`,`evaluated=${summary.evaluated}`,JSON.stringify(summary.by_outcome));
        return summary;
    } finally { cycleRunning=false; }
}

function startPredictionBacktestJob(){ensurePredictionBacktestSchema().then(()=>{schemaReady=true;return isEnabled();})
    .then((enabled)=>{if(!enabled){console.log('[prediction-backtest] disabled - not scheduled. Enable with AGRO_PREDICTION_BACKTEST_ENABLED=true.');return;}
        if(scheduledTask){return;}scheduledTask=cron.schedule(CRON_EXPRESSION,()=>{runPredictionBacktestCycle().catch((error)=>console.error('[prediction-backtest] cycle error:',error.message));});
        console.log(`[prediction-backtest] scheduled: ${CRON_EXPRESSION}`);})
    .catch((error)=>console.error('[prediction-backtest] schema/start failed:',error.message));}

function stopPredictionBacktestJob(){if(scheduledTask){try{scheduledTask.stop();}catch(_error){/* noop */}scheduledTask=null;}}
module.exports={startPredictionBacktestJob,stopPredictionBacktestJob,runPredictionBacktestCycle,isEnabled};
