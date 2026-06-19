'use strict';

const assert = require('node:assert/strict');
const {
    assertKnowledgeIdentity,
    computeGreenhouseKnowledge,
    knowledgeMaturity
} = require('../utils/knowledge-consolidation');

function strongInput(overrides = {}) {
    return {
        baseline_rows: [
            { metric: 'humidity', sample_count: 100, mean_value: 60, min_value: 50, max_value: 70, stddev_value: 3, p10_value: 54, p50_value: 60, p90_value: 66, ewma_value: 61, confidence: 0.9, maturity_level: 'mature' },
            { metric: 'temperature', sample_count: 100, mean_value: 20, min_value: 15, max_value: 25, stddev_value: 1, p10_value: 17, p50_value: 20, p90_value: 23, ewma_value: 20.5, confidence: 0.9, maturity_level: 'mature' }
        ],
        stress_rows: [
            { metric: 'ec', stress_type: 'out_of_range', stress_count: 2, average_severity_score: 0.4, recurrence_score: 0.2, stress_load_score: 25, trend_direction: 'stable', confidence: 0.8, maturity_level: 'stable' }
        ],
        recovery_rows: [
            { metric: 'temperature', recovery_count: 5, average_recovery_duration: 3600, recovery_quality_score: 0.85, recovery_stability_score: 0.8, relapse_rate: 0.1, fast_recovery_rate: 0.8, slow_recovery_rate: 0.2, confidence: 0.85, maturity_level: 'stable' }
        ],
        behavioral_row: {
            signature_label: 'strong_fast_recovery',
            recovery_behavior: 'fast_recovery',
            stress_behavior: 'low_stress',
            stability_behavior: 'stable',
            volatility_behavior: 'low_volatility',
            sensor_behavior: 'reliable',
            dominant_stress_metric: 'ec',
            dominant_recovery_metric: 'temperature',
            resilience_level: 'strong',
            risk_tendency: 'low',
            confidence: 0.9,
            maturity_level: 'mature'
        },
        ...overrides
    };
}

function run() {
    assert.deepEqual(
        assertKnowledgeIdentity({ owner_user_id: 1, device_id: 10, context_id: 100 }),
        { owner_user_id: 1, device_id: 10, context_id: 100 }
    );
    assert.throws(
        () => assertKnowledgeIdentity({ owner_user_id: 1, device_id: 10, context_id: null }),
        /unresolved/
    );
    assert.equal(knowledgeMaturity(1, 1, 1), 'cold_start');
    assert.equal(knowledgeMaturity(3, 0.8, 0.8), 'learning');
    assert.equal(knowledgeMaturity(4, 0.7, 0.75), 'stable');
    assert.equal(knowledgeMaturity(4, 0.9, 0.85), 'mature');

    const strong = computeGreenhouseKnowledge(strongInput());
    assert.equal(strong.baseline_summary.metric_count, 2);
    assert.equal(strong.baseline_summary.total_samples, 200);
    assert.equal(strong.stress_summary.total_occurrences, 2);
    assert.equal(strong.recovery_summary.total_recoveries, 5);
    assert.equal(strong.behavioral_signature.signature_label, 'strong_fast_recovery');
    assert.ok(strong.top_strengths.includes('strong_resilience'));
    assert.ok(strong.top_strengths.includes('fast_recovery'));
    assert.ok(strong.top_strengths.includes('stable_baselines'));
    assert.equal(strong.top_weaknesses.length, 0);
    assert.equal(strong.recurring_risks.length, 0);
    assert.equal(strong.recurring_recoveries[0].metric, 'temperature');
    assert.equal(strong.knowledge_maturity, 'mature');
    assert.equal(strong.evidence.privacy.fleet_dependency, false);

    const weak = computeGreenhouseKnowledge(strongInput({
        baseline_rows: [
            { metric: 'temperature', sample_count: 20, mean_value: 20, stddev_value: 10, confidence: 0.6, maturity_level: 'learning' }
        ],
        stress_rows: [
            { metric: 'ec', stress_type: 'out_of_range', stress_count: 10, average_severity_score: 0.8, recurrence_score: 0.8, stress_load_score: 80, trend_direction: 'rising', confidence: 0.8, maturity_level: 'stable' },
            { metric: 'temperature', stress_type: 'sensor_drift', stress_count: 4, average_severity_score: 0.7, recurrence_score: 0.7, stress_load_score: 75, trend_direction: 'rising', confidence: 0.8, maturity_level: 'stable' }
        ],
        recovery_rows: [
            { metric: 'ec', recovery_count: 5, average_recovery_duration: 259200, recovery_quality_score: 0.3, recovery_stability_score: 0.3, relapse_rate: 0.6, fast_recovery_rate: 0.1, slow_recovery_rate: 0.9, confidence: 0.7, maturity_level: 'learning' }
        ],
        behavioral_row: {
            signature_label: 'high_risk_tendency', recovery_behavior: 'fragile_recovery',
            stress_behavior: 'high_stress', stability_behavior: 'unstable',
            volatility_behavior: 'high_volatility', sensor_behavior: 'drift_risk',
            dominant_stress_metric: 'ec', dominant_recovery_metric: 'ec',
            resilience_level: 'weak', risk_tendency: 'high', confidence: 0.8, maturity_level: 'stable'
        }
    }));
    assert.ok(weak.top_weaknesses.includes('weak_resilience'));
    assert.ok(weak.top_weaknesses.includes('high_stress_load'));
    assert.equal(weak.top_weaknesses.length, 5);
    assert.equal(weak.recurring_risks[0].metric, 'ec');
    assert.ok(weak.recurring_risks.some((risk) => risk.stress_type === 'sensor_drift'));
    assert.equal(weak.recurring_recoveries[0].metric, 'ec');

    const partial = computeGreenhouseKnowledge(strongInput({
        stress_rows: [], recovery_rows: [], behavioral_row: {}
    }));
    assert.equal(partial.knowledge_maturity, 'cold_start');
    assert.equal(partial.evidence.source_layers.count, 1);
    assert.deepEqual(computeGreenhouseKnowledge(strongInput()), strong, 'same source aggregates must be deterministic');
    assert.throws(
        () => computeGreenhouseKnowledge({ baseline_rows: [], stress_rows: [], recovery_rows: [], behavioral_row: {} }),
        /no source intelligence/
    );

    console.log('PASS knowledge consolidation unit validation');
}

run();
