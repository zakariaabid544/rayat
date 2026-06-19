'use strict';

const assert = require('node:assert/strict');
const {
    assertRecoveryIdentity,
    computeRecoveryMemory,
    maturityLevel,
    recoveryQualityScore
} = require('../utils/recovery-memory');

function aggregate(overrides = {}) {
    return {
        recovery_count: 4,
        distinct_days: 4,
        distinct_sensor_count: 1,
        duration_sample_count: 4,
        average_recovery_duration: 71100,
        min_recovery_duration: 3600,
        max_recovery_duration: 259200,
        duration_stddev: 108627.5,
        recovery_quality_score: 0.825,
        quality_stddev: 0.083,
        relapse_count: 1,
        fast_count: 3,
        slow_count: 1,
        first_seen_at: '2026-01-01T00:00:00.000Z',
        last_seen_at: '2026-01-04T00:00:00.000Z',
        event_type_distribution_json: {
            recovery: 1,
            return_to_range: 1,
            stabilization: 1,
            improvement: 1
        },
        ...overrides
    };
}

function run() {
    assert.deepEqual(
        assertRecoveryIdentity({ owner_user_id: 1, device_id: 10, context_id: 100, metric: 'temperature' }),
        { owner_user_id: 1, device_id: 10, context_id: 100, metric: 'temperature' }
    );
    assert.throws(
        () => assertRecoveryIdentity({ owner_user_id: 1, device_id: 10, context_id: null, metric: 'temperature' }),
        /unresolved/
    );

    assert.equal(recoveryQualityScore({ eventType: 'recovery', evidenceQuality: 0.9, confidence: 0.5 }), 0.9);
    assert.equal(recoveryQualityScore({ eventType: 'return_to_range', confidence: 0.8 }), 0.8);
    assert.equal(recoveryQualityScore({ eventType: 'stabilization', confidence: 0 }), 0.7);
    assert.equal(recoveryQualityScore({ eventType: 'improvement', confidence: null }), 0.6);
    assert.equal(recoveryQualityScore({ eventType: 'recovery', evidenceQuality: 2 }), 1);

    assert.equal(maturityLevel(2, 2), 'cold_start');
    assert.equal(maturityLevel(3, 3), 'learning');
    assert.equal(maturityLevel(10, 3), 'stable');
    assert.equal(maturityLevel(25, 7), 'mature');

    const now = Date.parse('2026-01-20T00:00:00.000Z');
    const memory = computeRecoveryMemory(aggregate(), now);
    assert.equal(memory.recovery_count, 4);
    assert.equal(memory.average_recovery_duration, 71100);
    assert.equal(memory.recovery_quality_score, 0.825);
    assert.equal(memory.relapse_rate, 0.25);
    assert.equal(memory.fast_recovery_rate, 0.75);
    assert.equal(memory.slow_recovery_rate, 0.25);
    assert.ok(memory.recovery_stability_score >= 0 && memory.recovery_stability_score <= 1);
    assert.equal(memory.maturity_level, 'learning');
    assert.equal(memory.evidence.privacy.contains_raw_evidence, false);
    assert.deepEqual(memory.evidence.aggregation_key, ['owner_user_id', 'device_id', 'context_id', 'metric']);

    const low = computeRecoveryMemory(aggregate({
        recovery_count: 1,
        distinct_days: 1,
        duration_sample_count: 1,
        relapse_count: 0,
        fast_count: 1,
        slow_count: 0,
        first_seen_at: '2026-01-01T00:00:00.000Z',
        last_seen_at: '2026-01-01T00:00:00.000Z'
    }), now);
    const mature = computeRecoveryMemory(aggregate({
        recovery_count: 25,
        distinct_days: 7,
        duration_sample_count: 25,
        relapse_count: 2,
        fast_count: 20,
        slow_count: 5,
        first_seen_at: '2026-01-01T00:00:00.000Z',
        last_seen_at: '2026-01-19T00:00:00.000Z'
    }), now);
    assert.ok(mature.confidence > low.confidence, 'confidence must grow with recovery evidence');
    assert.equal(mature.maturity_level, 'mature');
    assert.deepEqual(computeRecoveryMemory(aggregate(), now), memory, 'same input and clock must be deterministic');

    console.log('PASS recovery memory unit validation');
}

run();
