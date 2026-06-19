'use strict';

const assert = require('node:assert/strict');
const { computeStressEta } = require('../utils/stress-eta');
const { computeRiskForecast, riskBand } = require('../utils/risk-forecast');

const NOW = new Date('2026-06-20T12:00:00.000Z');

function stressInput(overrides = {}) {
    return {
        owner_user_id: 1,
        device_id: 10,
        context_id: 100,
        forecasts: [{ horizon_minutes: 180, current_value: 70, forecast_value: 71,
            confidence: 0.9, data_quality_score: 0.9 }],
        breaches: [{ horizon_minutes: 180, status: 'no_breach_expected', eta_minutes: null,
            eta_confidence: 0.85 }],
        stress_memories: [],
        baselines: [{ mean_value: 70, stddev_value: 1, confidence: 0.9 }],
        trends: [{ metric: 'intelligence_score', trend_direction: 'improving', trend_confidence: 0.9 }],
        intelligence_score: { intelligence_score: 85, confidence: 0.9 },
        ...overrides
    };
}

function riskInput(overrides = {}) {
    return {
        owner_user_id: 1,
        device_id: 10,
        context_id: 100,
        forecasts: [{ horizon_minutes: 180, confidence: 0.9, data_quality_score: 0.9 }],
        breaches: [{ horizon_minutes: 180, status: 'no_breach_expected', eta_confidence: 0.9 }],
        stress_eta: [{ status: 'no_stress_expected', eta_minutes: null,
            stress_probability: 0.1, stress_confidence: 0.9 }],
        health_profile: { health_score: 90, recovery_score: 90, confidence: 0.9 },
        intelligence_score: { intelligence_score: 90, confidence: 0.9 },
        trends: [{ metric: 'intelligence_score', trend_direction: 'improving', trend_confidence: 0.9 }],
        ...overrides
    };
}

function run() {
    const stable = computeStressEta(stressInput(), 'out_of_range', NOW);
    assert.equal(stable.status, 'no_stress_expected');
    assert.equal(stable.eta_minutes, null);

    const active = computeStressEta(stressInput({
        breaches: [{ horizon_minutes: 60, status: 'already_breached', eta_minutes: 0, eta_confidence: 0.9 }]
    }), 'out_of_range', NOW);
    assert.equal(active.status, 'already_under_stress');
    assert.equal(active.eta_minutes, 0);
    assert.ok(active.stress_probability >= 0.88);

    const imminent = computeStressEta(stressInput({
        forecasts: [{ horizon_minutes: 180, current_value: 70, forecast_value: 95,
            confidence: 0.95, data_quality_score: 0.95 }],
        breaches: [{ horizon_minutes: 180, status: 'breach_likely', eta_minutes: 90, eta_confidence: 0.95 }],
        stress_memories: [{ stress_type: 'out_of_range', stress_count: 20, recurrence_score: 0.9,
            stress_load_score: 90, trend_direction: 'rising', confidence: 0.9 }],
        trends: [{ metric: 'intelligence_score', trend_direction: 'degrading', trend_confidence: 0.95 }],
        baselines: [{ mean_value: 50, stddev_value: 20, confidence: 0.9 }]
    }), 'out_of_range', NOW);
    assert.equal(imminent.status, 'stress_imminent');
    assert.ok(imminent.eta_minutes > 0 && imminent.eta_minutes <= 90);

    const insufficient = computeStressEta(stressInput({ forecasts: [] }), 'out_of_range', NOW);
    assert.equal(insufficient.status, 'insufficient_data');
    assert.equal(insufficient.severity, 'unknown');

    const lowRecurrence = computeStressEta(stressInput({
        stress_memories: [{ stress_type: 'worsening', stress_count: 1, recurrence_score: 0.1,
            stress_load_score: 10, trend_direction: 'stable', confidence: 0.6 }]
    }), 'worsening', NOW);
    const highRecurrence = computeStressEta(stressInput({
        stress_memories: [{ stress_type: 'worsening', stress_count: 30, recurrence_score: 0.95,
            stress_load_score: 90, trend_direction: 'rising', confidence: 0.9 }],
        trends: [{ metric: 'stress', trend_direction: 'degrading', trend_confidence: 0.9 }]
    }), 'worsening', NOW);
    assert.ok(highRecurrence.stress_probability > lowRecurrence.stress_probability,
        'recurring stress must increase stress probability');
    assert.deepEqual(computeStressEta(stressInput(), 'out_of_range', NOW), stable,
        'stress ETA must be deterministic');

    const veryLow = computeRiskForecast(riskInput(), 180, NOW);
    assert.equal(veryLow.overall_risk_band, 'very_low');

    const low = computeRiskForecast(riskInput({
        stress_eta: [{ status: 'stress_possible', eta_minutes: 160,
            stress_probability: 0.45, stress_confidence: 0.8 }],
        health_profile: { health_score: 80, recovery_score: 80, confidence: 0.9 },
        intelligence_score: { intelligence_score: 80, confidence: 0.9 },
        trends: [{ metric: 'intelligence_score', trend_direction: 'stable', trend_confidence: 0.9 }]
    }), 180, NOW);
    assert.equal(low.overall_risk_band, 'low');

    const high = computeRiskForecast(riskInput({
        breaches: [{ horizon_minutes: 180, status: 'breach_likely', eta_confidence: 0.95 }],
        stress_eta: [{ status: 'stress_imminent', eta_minutes: 60,
            stress_probability: 0.9, stress_confidence: 0.95 }],
        health_profile: { health_score: 40, recovery_score: 45, confidence: 0.9 },
        intelligence_score: { intelligence_score: 45, confidence: 0.9 },
        trends: [{ metric: 'intelligence_score', trend_direction: 'degrading', trend_confidence: 0.95 }]
    }), 180, NOW);
    assert.equal(high.overall_risk_band, 'high');

    const critical = computeRiskForecast(riskInput({
        breaches: [{ horizon_minutes: 180, status: 'already_breached', eta_confidence: 0.95 }],
        stress_eta: [{ status: 'already_under_stress', eta_minutes: 0,
            stress_probability: 0.95, stress_confidence: 0.95 }],
        health_profile: { health_score: 10, recovery_score: 10, confidence: 0.95 },
        intelligence_score: { intelligence_score: 10, confidence: 0.95 },
        trends: [{ metric: 'intelligence_score', trend_direction: 'degrading', trend_confidence: 0.95 }]
    }), 180, NOW);
    assert.equal(critical.overall_risk_band, 'critical');

    const healthy = computeRiskForecast(riskInput({
        health_profile: { health_score: 90, recovery_score: 90, confidence: 0.9 }
    }), 180, NOW);
    const unhealthy = computeRiskForecast(riskInput({
        health_profile: { health_score: 30, recovery_score: 30, confidence: 0.9 }
    }), 180, NOW);
    assert.ok(healthy.overall_risk_score < unhealthy.overall_risk_score,
        'healthy greenhouse must lower risk');

    const improving = computeRiskForecast(riskInput(), 180, NOW);
    const worsening = computeRiskForecast(riskInput({
        trends: [{ metric: 'intelligence_score', trend_direction: 'degrading', trend_confidence: 0.9 }]
    }), 180, NOW);
    assert.ok(worsening.overall_risk_score > improving.overall_risk_score,
        'worsening trend must increase risk');
    assert.deepEqual(computeRiskForecast(riskInput(), 180, NOW), veryLow,
        'risk forecast must be deterministic');
    assert.equal(riskBand(0), 'very_low');
    assert.equal(riskBand(25), 'low');
    assert.equal(riskBand(45), 'medium');
    assert.equal(riskBand(65), 'high');
    assert.equal(riskBand(85), 'critical');
    assert.equal(critical.evidence_json.privacy.cross_tenant_evidence, false);

    console.log('PASS stress ETA and risk forecast unit validation');
}

run();
