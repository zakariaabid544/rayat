'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    evaluateMetricForecast, evaluateBreachEta, evaluateStressEta,
    evaluateRiskForecast, evaluateRecoveryForecast
} = require('../utils/prediction-backtest');
const { computeCalibration, maturityLevel } = require('../utils/prediction-calibration');

function run() {
    const metric = { forecast_value: 20, forecast_low: 18, forecast_high: 22, confidence: 0.8 };
    assert.equal(evaluateMetricForecast(metric, { value: 21 }).outcome, 'correct');
    assert.equal(evaluateMetricForecast(metric, { value: 30 }).outcome, 'incorrect');
    assert.equal(evaluateMetricForecast(metric, null).outcome, 'insufficient_data');

    const breach = { status:'breach_likely',eta_minutes:120,eta_confidence:0.85,horizon_minutes:180 };
    assert.equal(evaluateBreachEta(breach, {has_coverage:true,crossing_minutes:130}).outcome, 'correct');
    assert.equal(evaluateBreachEta(breach, {has_coverage:true,crossing_minutes:null}).outcome, 'incorrect');
    assert.equal(evaluateBreachEta(breach, {has_coverage:false,crossing_minutes:null}).outcome, 'insufficient_data');
    assert.equal(evaluateBreachEta({status:'no_breach_expected',eta_confidence:0.8,horizon_minutes:180},
        {has_coverage:true,crossing_minutes:null}).outcome,'correct');

    const stress={status:'stress_imminent',eta_minutes:90,stress_probability:0.85,stress_confidence:0.8};
    assert.equal(evaluateStressEta(stress,{has_coverage:true,event_minutes:100}).outcome,'correct');
    assert.equal(evaluateStressEta(stress,{has_coverage:true,event_minutes:null}).outcome,'incorrect');
    assert.equal(evaluateStressEta({status:'insufficient_data',stress_probability:0,stress_confidence:0.2},
        {has_coverage:true,event_minutes:null}).outcome,'insufficient_data');

    const risk={predicted_intelligence_score:62,risk_probability:0.3,confidence:0.8};
    assert.equal(evaluateRiskForecast(risk,{intelligence_score:66}).outcome,'correct');
    assert.equal(evaluateRiskForecast(risk,{intelligence_score:30}).outcome,'incorrect');
    assert.equal(evaluateRiskForecast(risk,null).outcome,'insufficient_data');

    const recovery={estimated_recovery_band:'fast',estimated_recovery_minutes:120,
        recovery_probability:0.8,confidence:0.8};
    assert.equal(evaluateRecoveryForecast(recovery,{has_coverage:true,recovery_minutes:140}).outcome,'correct');
    assert.equal(evaluateRecoveryForecast(recovery,{has_coverage:true,recovery_minutes:null}).outcome,'incorrect');
    assert.equal(evaluateRecoveryForecast({...recovery,estimated_recovery_band:'unknown',estimated_recovery_minutes:null},
        {has_coverage:true,recovery_minutes:null}).outcome,'insufficient_data');

    const few=computeCalibration({evaluated_predictions:3,total_predictions:3,raw_accuracy:0.8,
        raw_calibration:0.8,raw_confidence_alignment:0.8,last_evaluated_at:'2026-06-20T12:00:00Z'});
    const many=computeCalibration({evaluated_predictions:20,total_predictions:20,raw_accuracy:0.8,
        raw_calibration:0.8,raw_confidence_alignment:0.8,last_evaluated_at:'2026-06-20T12:00:00Z'});
    assert.ok(many.calibration_score>few.calibration_score,'calibration confidence must grow with evidence');
    assert.ok(many.confidence_score>few.confidence_score);
    assert.equal(computeCalibration({evaluated_predictions:2}),null,'insufficient history skipped');
    assert.equal(maturityLevel(3),'cold_start');
    assert.equal(maturityLevel(10),'learning');
    assert.equal(maturityLevel(20),'stable');
    assert.equal(maturityLevel(60),'mature');

    const uiRoot=path.join(__dirname,'../../web/dashboard');
    const html=fs.readFileSync(path.join(uiRoot,'predictions.html'),'utf8');
    const js=fs.readFileSync(path.join(uiRoot,'predictions.js'),'utf8');
    assert.match(html,/Metric Forecasts/);
    assert.match(html,/Early Warnings/);
    assert.match(js,/Forecast metrici non ancora disponibili/);
    assert.match(js,/Nessun warning attivo/);
    assert.match(js,/RayatPredictionUI/);
    assert.doesNotMatch(html,/https:\/\/.*(?:script|css)/i,'UI uses no external libraries');

    console.log('PASS prediction backtest, calibration and UI unit validation');
}

run();
