'use strict';

const assert = require('node:assert/strict');
const {
    assertHealthIdentity,
    computeHealthProfile,
    healthBand,
    profileMaturity
} = require('../utils/greenhouse-health-profile');

function strongInput(overrides = {}) {
    return {
        knowledge_row: {
            confidence: 0.86,
            knowledge_maturity: 'mature',
            top_strengths: ['strong_resilience', 'fast_recovery', 'stable_baselines'],
            top_weaknesses: [],
            stress_summary: { dominant_metric: 'ec' }
        },
        baseline_rows: [
            { metric: 'temperature', mean_value: 20, stddev_value: 1, confidence: 0.9, maturity_level: 'mature' },
            { metric: 'humidity', mean_value: 60, stddev_value: 3, confidence: 0.9, maturity_level: 'mature' }
        ],
        stress_rows: [
            { metric: 'ec', stress_type: 'out_of_range', stress_count: 2, average_severity_score: 0.4, recurrence_score: 0.2, stress_load_score: 25, confidence: 0.8, maturity_level: 'stable' }
        ],
        recovery_rows: [
            { metric: 'temperature', recovery_count: 5, recovery_quality_score: 0.85, recovery_stability_score: 0.8, relapse_rate: 0.1, fast_recovery_rate: 0.8, confidence: 0.85, maturity_level: 'stable' }
        ],
        behavioral_row: {
            signature_label: 'strong_fast_recovery', stability_behavior: 'stable',
            sensor_behavior: 'reliable', dominant_stress_metric: 'ec',
            resilience_level: 'strong', risk_tendency: 'low', confidence: 0.9, maturity_level: 'mature'
        },
        ...overrides
    };
}

function run() {
    assert.deepEqual(
        assertHealthIdentity({ owner_user_id: 1, device_id: 10, context_id: 100 }),
        { owner_user_id: 1, device_id: 10, context_id: 100 }
    );
    assert.throws(
        () => assertHealthIdentity({ owner_user_id: 1, device_id: 10, context_id: null }),
        /unresolved/
    );
    assert.equal(healthBand(90, 90, 5), 'excellent');
    assert.equal(healthBand(75, 90, 5), 'good');
    assert.equal(healthBand(55, 90, 5), 'attention');
    assert.equal(healthBand(35, 90, 5), 'risk');
    assert.equal(healthBand(20, 90, 5), 'critical');
    assert.equal(healthBand(90, 40, 5), 'unknown');
    assert.equal(healthBand(90, 90, 2), 'unknown');
    assert.equal(profileMaturity(2, 1, 1), 'cold_start');
    assert.equal(profileMaturity(4, 0.8, 0.8), 'learning');
    assert.equal(profileMaturity(5, 0.7, 0.7), 'stable');
    assert.equal(profileMaturity(5, 0.9, 0.85), 'mature');

    const strong = computeHealthProfile(strongInput());
    for (const field of ['health_score', 'resilience_score', 'stress_load_score', 'recovery_score', 'stability_score', 'data_confidence_score']) {
        assert.ok(strong[field] >= 0 && strong[field] <= 100, `${field} must be a 0-100 score`);
    }
    assert.equal(strong.health_band, 'good');
    assert.ok(strong.resilience_score >= 80);
    assert.ok(strong.recovery_score >= 80);
    assert.ok(strong.stability_score >= 85);
    assert.ok(strong.stress_load_score < 40);
    assert.equal(strong.recommended_focus[0], 'maintain_current_practices');
    assert.ok(strong.top_positive_factors.some((factor) => factor.factor === 'environmental_stability'));
    assert.equal(strong.evidence.privacy.fleet_dependency, false);

    const weak = computeHealthProfile(strongInput({
        knowledge_row: {
            confidence: 0.75,
            knowledge_maturity: 'stable',
            top_strengths: [],
            top_weaknesses: ['weak_resilience', 'high_stress_load', 'sensor_drift_risk'],
            stress_summary: { dominant_metric: 'ec' }
        },
        baseline_rows: [
            { metric: 'temperature', mean_value: 20, stddev_value: 10, confidence: 0.7, maturity_level: 'learning' }
        ],
        stress_rows: [
            { metric: 'ec', stress_type: 'out_of_range', stress_count: 10, average_severity_score: 0.8, recurrence_score: 0.8, stress_load_score: 80, confidence: 0.8, maturity_level: 'stable' },
            { metric: 'temperature', stress_type: 'sensor_drift', stress_count: 4, average_severity_score: 0.7, recurrence_score: 0.7, stress_load_score: 75, confidence: 0.8, maturity_level: 'stable' }
        ],
        recovery_rows: [
            { metric: 'ec', recovery_count: 5, recovery_quality_score: 0.3, recovery_stability_score: 0.3, relapse_rate: 0.6, fast_recovery_rate: 0.1, confidence: 0.7, maturity_level: 'learning' }
        ],
        behavioral_row: {
            signature_label: 'high_risk_tendency', stability_behavior: 'unstable',
            sensor_behavior: 'drift_risk', dominant_stress_metric: 'ec',
            resilience_level: 'weak', risk_tendency: 'high', confidence: 0.75, maturity_level: 'stable'
        }
    }));
    assert.ok(['risk', 'critical'].includes(weak.health_band));
    assert.ok(weak.stress_load_score >= 70);
    assert.ok(weak.recovery_score < 50);
    assert.ok(weak.resilience_score < 50);
    assert.ok(weak.recommended_focus.includes('reduce_ec_stress'));
    assert.ok(weak.recommended_focus.includes('inspect_sensor_reliability'));
    assert.ok(weak.top_negative_factors.some((factor) => factor.factor === 'stress_pressure'));

    const partial = computeHealthProfile(strongInput({
        knowledge_row: { confidence: 0.6, knowledge_maturity: 'learning', top_strengths: [], top_weaknesses: [] },
        stress_rows: [], recovery_rows: [], behavioral_row: {}
    }));
    assert.equal(partial.health_band, 'unknown');
    assert.equal(partial.maturity_level, 'cold_start');
    assert.deepEqual(computeHealthProfile(strongInput()), strong, 'same aggregate input must be deterministic');
    assert.throws(
        () => computeHealthProfile({ knowledge_row: {}, baseline_rows: [], stress_rows: [], recovery_rows: [], behavioral_row: {} }),
        /missing consolidated knowledge/
    );

    console.log('PASS greenhouse health profile unit validation');
}

run();
