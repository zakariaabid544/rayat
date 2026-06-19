'use strict';

const assert = require('node:assert/strict');
const {
    assertBehaviorIdentity,
    computeBehavioralSignature,
    maturityLevel
} = require('../utils/behavioral-signature');

function strongInput(overrides = {}) {
    return {
        baseline_metric_count: 2,
        baseline_sample_count: 200,
        baseline_confidence: 0.9,
        baseline_stability: 0.95,
        baseline_volatility: 0.05,
        baseline_maturity_score: 1,
        stress_metric_count: 1,
        stress_count: 2,
        stress_confidence: 0.8,
        stress_severity: 0.4,
        stress_recurrence: 0.2,
        stress_load: 25,
        anomaly_count: 0,
        sensor_drift_count: 0,
        stress_maturity_score: 0.75,
        stress_first_seen: '2026-01-01T00:00:00.000Z',
        stress_last_seen: '2026-01-10T00:00:00.000Z',
        dominant_stress_metric: 'ec',
        recovery_metric_count: 1,
        recovery_count: 5,
        recovery_confidence: 0.85,
        recovery_quality: 0.85,
        recovery_stability: 0.8,
        relapse_rate: 0.1,
        fast_recovery_rate: 0.8,
        slow_recovery_rate: 0.2,
        recovery_maturity_score: 0.75,
        dominant_recovery_metric: 'temperature',
        ...overrides
    };
}

function run() {
    assert.deepEqual(
        assertBehaviorIdentity({ owner_user_id: 1, device_id: 10, context_id: 100 }),
        { owner_user_id: 1, device_id: 10, context_id: 100 }
    );
    assert.throws(
        () => assertBehaviorIdentity({ owner_user_id: 1, device_id: 10, context_id: null }),
        /unresolved/
    );
    assert.equal(maturityLevel(1, 1, 1), 'cold_start');
    assert.equal(maturityLevel(2, 0.7, 0.7), 'learning');
    assert.equal(maturityLevel(3, 0.7, 0.7), 'stable');
    assert.equal(maturityLevel(3, 0.9, 0.8), 'mature');

    const strong = computeBehavioralSignature(strongInput());
    assert.equal(strong.recovery_behavior, 'fast_recovery');
    assert.equal(strong.stress_behavior, 'low_stress');
    assert.equal(strong.stability_behavior, 'stable');
    assert.equal(strong.volatility_behavior, 'low_volatility');
    assert.equal(strong.sensor_behavior, 'reliable');
    assert.equal(strong.resilience_level, 'strong');
    assert.equal(strong.risk_tendency, 'low');
    assert.equal(strong.signature_label, 'strong_fast_recovery');
    assert.equal(strong.dominant_stress_metric, 'ec');
    assert.equal(strong.dominant_recovery_metric, 'temperature');
    assert.equal(strong.evidence.privacy.fleet_dependency, false);

    const fragile = computeBehavioralSignature(strongInput({
        baseline_stability: 0.5,
        baseline_volatility: 0.5,
        stress_count: 19,
        stress_severity: 0.8,
        stress_recurrence: 0.8,
        stress_load: 80,
        anomaly_count: 5,
        sensor_drift_count: 4,
        recovery_quality: 0.3,
        recovery_stability: 0.3,
        relapse_rate: 0.6,
        fast_recovery_rate: 0.1,
        slow_recovery_rate: 0.9
    }));
    assert.equal(fragile.recovery_behavior, 'fragile_recovery');
    assert.equal(fragile.stress_behavior, 'high_stress');
    assert.equal(fragile.stability_behavior, 'unstable');
    assert.equal(fragile.volatility_behavior, 'high_volatility');
    assert.equal(fragile.sensor_behavior, 'drift_risk');
    assert.equal(fragile.resilience_level, 'weak');
    assert.equal(fragile.risk_tendency, 'high');
    assert.equal(fragile.signature_label, 'high_risk_tendency');

    const normalRecovery = computeBehavioralSignature(strongInput({
        recovery_quality: 0.65,
        recovery_stability: 0.6,
        relapse_rate: 0.2,
        fast_recovery_rate: 0.4,
        slow_recovery_rate: 0.4
    }));
    assert.equal(normalRecovery.recovery_behavior, 'normal_recovery');
    const slowRecovery = computeBehavioralSignature(strongInput({
        recovery_quality: 0.7,
        recovery_stability: 0.7,
        relapse_rate: 0.1,
        fast_recovery_rate: 0.1,
        slow_recovery_rate: 0.8
    }));
    assert.equal(slowRecovery.recovery_behavior, 'slow_recovery');
    const recurring = computeBehavioralSignature(strongInput({
        stress_count: 10,
        stress_severity: 0.4,
        stress_recurrence: 0.8,
        stress_load: 30,
        anomaly_count: 1,
        sensor_drift_count: 1,
        baseline_stability: 0.65,
        baseline_volatility: 0.2,
        recovery_metric_count: 0,
        recovery_count: 0,
        recovery_confidence: 0,
        recovery_quality: 0,
        recovery_stability: 0,
        recovery_maturity_score: 0
    }));
    assert.equal(recurring.stress_behavior, 'recurring_stress');
    assert.equal(recurring.stability_behavior, 'moderately_stable');
    assert.equal(recurring.volatility_behavior, 'moderate_volatility');
    assert.equal(recurring.sensor_behavior, 'attention_needed');
    const moderateStress = computeBehavioralSignature(strongInput({
        stress_count: 3,
        stress_severity: 0.5,
        stress_recurrence: 0.3,
        stress_load: 40
    }));
    assert.equal(moderateStress.stress_behavior, 'moderate_stress');

    const baselineOnly = computeBehavioralSignature(strongInput({
        stress_metric_count: 0,
        stress_count: 0,
        stress_confidence: 0,
        stress_severity: 0,
        stress_recurrence: 0,
        stress_load: 0,
        stress_maturity_score: 0,
        dominant_stress_metric: null,
        recovery_metric_count: 0,
        recovery_count: 0,
        recovery_confidence: 0,
        recovery_quality: 0,
        recovery_stability: 0,
        recovery_maturity_score: 0,
        dominant_recovery_metric: null
    }));
    assert.equal(baselineOnly.recovery_behavior, 'unknown');
    assert.equal(baselineOnly.stress_behavior, 'unknown');
    assert.equal(baselineOnly.sensor_behavior, 'unknown');
    assert.equal(baselineOnly.resilience_level, 'unknown');
    assert.equal(baselineOnly.maturity_level, 'cold_start');
    assert.deepEqual(computeBehavioralSignature(strongInput()), strong, 'same aggregates must be deterministic');

    console.log('PASS behavioral signature unit validation');
}

run();
