'use strict';

const assert = require('node:assert/strict');
const { computeRecoveryForecast, recoveryBand } = require('../utils/recovery-forecast');
const { generateEarlyWarnings, warningLevel } = require('../utils/early-warning');

const NOW = new Date('2026-06-20T12:00:00.000Z');

function recoveryInput(overrides = {}) {
    return {
        owner_user_id: 1,
        device_id: 10,
        context_id: 100,
        recovery_memories: [{ recovery_count: 30, average_recovery_duration: 3600,
            recovery_quality_score: 0.9, recovery_stability_score: 0.9, relapse_rate: 0.05,
            fast_recovery_rate: 0.9, slow_recovery_rate: 0.05, confidence: 0.9 }],
        stress_memories: [{ recurrence_score: 0.1 }],
        stress_eta: [{ status: 'no_stress_expected', stress_probability: 0.1, stress_confidence: 0.9 }],
        risk_forecasts: [{ overall_risk_score: 10, confidence: 0.9 }],
        health_profile: { health_score: 90, resilience_score: 90, recovery_score: 90, confidence: 0.9 },
        intelligence_score: { intelligence_score: 90, confidence: 0.9 },
        metric_forecasts: [{ confidence: 0.9, data_quality_score: 0.9 }],
        trends: [{ metric: 'recovery', trend_direction: 'improving', trend_confidence: 0.9 }],
        ...overrides
    };
}

function warningInput(overrides = {}) {
    return {
        owner_user_id: 1,
        device_id: 10,
        context_id: 100,
        metric_forecasts: [{ horizon_minutes: 60, confidence: 0.9, data_quality_score: 0.9 }],
        breach_eta: [],
        stress_eta: [],
        risk_forecasts: [],
        recovery_forecast: { recovery_probability: 0.9, recovery_risk: 10,
            estimated_recovery_minutes: 60, estimated_recovery_band: 'very_fast', confidence: 0.9 },
        health_profile: { confidence: 0.9 },
        intelligence_score: { confidence: 0.9 },
        ...overrides
    };
}

function run() {
    const strong = computeRecoveryForecast(recoveryInput(), NOW);
    assert.ok(strong.recovery_probability >= 0.8);
    assert.ok(['very_fast', 'fast'].includes(strong.estimated_recovery_band));
    assert.ok(strong.recovery_risk < 30);

    const weak = computeRecoveryForecast(recoveryInput({
        recovery_memories: [{ recovery_count: 25, average_recovery_duration: 36000,
            recovery_quality_score: 0.35, recovery_stability_score: 0.3, relapse_rate: 0.7,
            fast_recovery_rate: 0.1, slow_recovery_rate: 0.8, confidence: 0.85 }],
        stress_memories: [{ recurrence_score: 0.9 }],
        stress_eta: [{ status: 'stress_imminent', stress_probability: 0.9, stress_confidence: 0.9 }],
        risk_forecasts: [{ overall_risk_score: 85, confidence: 0.9 }],
        health_profile: { health_score: 30, resilience_score: 30, recovery_score: 30, confidence: 0.85 },
        intelligence_score: { intelligence_score: 35, confidence: 0.85 },
        metric_forecasts: [{ confidence: 0.6, data_quality_score: 0.6 }],
        trends: [{ metric: 'recovery', trend_direction: 'degrading', trend_confidence: 0.9 }]
    }), NOW);
    assert.ok(weak.recovery_probability < strong.recovery_probability);
    assert.equal(weak.estimated_recovery_band, 'very_slow');
    assert.ok(weak.recovery_risk > strong.recovery_risk);

    const insufficient = computeRecoveryForecast(recoveryInput({ recovery_memories: [] }), NOW);
    assert.equal(insufficient.estimated_recovery_band, 'unknown');
    assert.equal(insufficient.estimated_recovery_minutes, null);
    assert.ok(insufficient.confidence < strong.confidence);

    const lowRecurrence = computeRecoveryForecast(recoveryInput({
        stress_memories: [{ recurrence_score: 0.1 }]
    }), NOW);
    const highRecurrence = computeRecoveryForecast(recoveryInput({
        stress_memories: [{ recurrence_score: 0.95 }]
    }), NOW);
    assert.ok(highRecurrence.recovery_probability < lowRecurrence.recovery_probability,
        'recurring stress must worsen recovery');
    assert.ok(highRecurrence.estimated_recovery_minutes > lowRecurrence.estimated_recovery_minutes);
    const healthy = computeRecoveryForecast(recoveryInput(), NOW);
    const unhealthy = computeRecoveryForecast(recoveryInput({
        health_profile: { health_score: 25, resilience_score: 25, recovery_score: 25, confidence: 0.9 },
        intelligence_score: { intelligence_score: 40, confidence: 0.9 }
    }), NOW);
    assert.ok(healthy.recovery_probability > unhealthy.recovery_probability,
        'healthy greenhouse must improve expected recovery');
    assert.ok(healthy.estimated_recovery_minutes < unhealthy.estimated_recovery_minutes);
    assert.deepEqual(computeRecoveryForecast(recoveryInput(), NOW), strong,
        'recovery forecast must be deterministic');

    const allWarnings = generateEarlyWarnings(warningInput({
        breach_eta: [{ status: 'breach_likely', eta_minutes: 120, eta_confidence: 0.9,
            breach_direction: 'above_max', metric: 'temperature' }],
        stress_eta: [{ status: 'stress_imminent', eta_minutes: 90, stress_probability: 0.88,
            stress_confidence: 0.85, stress_type: 'out_of_range' }],
        risk_forecasts: [{ overall_risk_band: 'critical', overall_risk_score: 88,
            risk_probability: 0.85, confidence: 0.85, forecast_horizon_minutes: 180,
            primary_risk: 'stress_eta', evidence_json: { factors: { trend_deterioration: 0.8 } } }],
        recovery_forecast: { recovery_probability: 0.3, recovery_risk: 75,
            estimated_recovery_minutes: 500, estimated_recovery_band: 'slow', confidence: 0.8 }
    }), NOW);
    const types = new Set(allWarnings.map((row) => row.warning_type));
    for (const type of ['future_breach', 'future_stress', 'future_risk', 'weak_recovery', 'trend_deterioration']) {
        assert.ok(types.has(type), `${type} warning must be generated`);
    }
    assert.equal(types.has('confidence_drop'), false);
    assert.ok(allWarnings.every((row) => row.title && row.summary && row.recommended_action));
    assert.ok(allWarnings.every((row) => row.eta_minutes > 0));

    const confidenceWarnings = generateEarlyWarnings(warningInput({
        metric_forecasts: [
            { horizon_minutes: 60, confidence: 0.15, data_quality_score: 0.2 },
            { horizon_minutes: 180, confidence: 0.2, data_quality_score: 0.2 }
        ],
        stress_eta: [{ status: 'stress_likely', eta_minutes: 90, stress_probability: 0.8,
            stress_confidence: 0.2, stress_type: 'out_of_range' }],
        risk_forecasts: [{ overall_risk_band: 'high', overall_risk_score: 70,
            risk_probability: 0.8, confidence: 0.2, forecast_horizon_minutes: 180,
            evidence_json: { factors: { trend_deterioration: 0.8 } } }],
        recovery_forecast: { recovery_probability: 0.3, recovery_risk: 70,
            estimated_recovery_minutes: 500, estimated_recovery_band: 'slow', confidence: 0.2 },
        health_profile: { confidence: 0.2 }, intelligence_score: { confidence: 0.2 }
    }), NOW);
    assert.deepEqual(confidenceWarnings.map((row) => row.warning_type), ['confidence_drop']);

    const none = generateEarlyWarnings(warningInput(), NOW);
    assert.deepEqual(none, []);
    assert.deepEqual(generateEarlyWarnings(warningInput(), NOW), none,
        'early warnings must be deterministic');
    assert.equal(recoveryBand(null), 'unknown');
    assert.equal(recoveryBand(45), 'very_fast');
    assert.equal(recoveryBand(120), 'fast');
    assert.equal(recoveryBand(300), 'moderate');
    assert.equal(recoveryBand(600), 'slow');
    assert.equal(recoveryBand(900), 'very_slow');
    assert.equal(warningLevel(90), 'critical');
    assert.equal(strong.evidence_json.privacy.cross_tenant_evidence, false);

    console.log('PASS recovery forecast and early warning unit validation');
}

run();
