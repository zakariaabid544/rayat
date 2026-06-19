'use strict';

const assert = require('node:assert/strict');
const {
    assertStressIdentity,
    computeStressMemory,
    maturityLevel,
    severityScore,
    trendDirection
} = require('../utils/stress-memory');

function aggregate(overrides = {}) {
    return {
        stress_count: 3,
        distinct_days: 3,
        distinct_sensor_count: 1,
        total_duration_seconds: 900,
        average_duration_seconds: 300,
        max_duration_seconds: 600,
        average_severity_score: 0.5,
        max_severity_score: 0.75,
        severity_stddev: 0.1,
        severity_distribution_json: { info: 0, low: 1, medium: 1, high: 1, critical: 0, unknown: 0 },
        first_seen_at: '2026-01-01T00:00:00.000Z',
        last_seen_at: '2026-01-03T00:00:00.000Z',
        older_count: 1,
        recent_count: 2,
        ...overrides
    };
}

function run() {
    assert.deepEqual(
        assertStressIdentity({
            owner_user_id: 1, device_id: 10, context_id: 100,
            metric: 'temperature', stress_type: 'out_of_range'
        }),
        {
            owner_user_id: 1, device_id: 10, context_id: 100,
            metric: 'temperature', stress_type: 'out_of_range'
        }
    );
    assert.throws(
        () => assertStressIdentity({
            owner_user_id: 1, device_id: 10, context_id: null,
            metric: 'temperature', stress_type: 'out_of_range'
        }),
        /unresolved or unsupported/
    );
    assert.throws(
        () => assertStressIdentity({
            owner_user_id: 1, device_id: 10, context_id: 100,
            metric: 'temperature', stress_type: 'recovery'
        }),
        /unsupported/
    );

    assert.equal(severityScore('info'), 0.1);
    assert.equal(severityScore('LOW'), 0.25);
    assert.equal(severityScore('medium'), 0.5);
    assert.equal(severityScore('high'), 0.75);
    assert.equal(severityScore('critical'), 1);
    assert.equal(severityScore('unexpected'), 0.1);

    assert.equal(trendDirection(1, 4), 'rising');
    assert.equal(trendDirection(3, 3), 'stable');
    assert.equal(trendDirection(4, 1), 'declining');
    assert.equal(trendDirection(0, 1), 'stable');

    assert.equal(maturityLevel(2, 2), 'cold_start');
    assert.equal(maturityLevel(3, 3), 'learning');
    assert.equal(maturityLevel(10, 3), 'stable');
    assert.equal(maturityLevel(25, 7), 'mature');

    const now = Date.parse('2026-01-10T00:00:00.000Z');
    const low = computeStressMemory(aggregate({ stress_count: 1, distinct_days: 1 }), now);
    const high = computeStressMemory(aggregate({
        stress_count: 25,
        distinct_days: 7,
        first_seen_at: '2026-01-01T00:00:00.000Z',
        last_seen_at: '2026-01-09T00:00:00.000Z',
        older_count: 5,
        recent_count: 20
    }), now);
    assert.ok(high.confidence > low.confidence, 'confidence must grow with event evidence');
    assert.equal(high.maturity_level, 'mature');
    assert.equal(high.trend_direction, 'rising');
    assert.ok(high.recurrence_score >= 0 && high.recurrence_score <= 1);
    assert.ok(high.stress_load_score >= 0 && high.stress_load_score <= 100);
    assert.deepEqual(
        computeStressMemory(aggregate({
            stress_count: 25,
            distinct_days: 7,
            first_seen_at: '2026-01-01T00:00:00.000Z',
            last_seen_at: '2026-01-09T00:00:00.000Z',
            older_count: 5,
            recent_count: 20
        }), now),
        high,
        'same aggregates and clock must be deterministic'
    );
    assert.equal(high.evidence.privacy.contains_raw_evidence, false);
    assert.deepEqual(
        high.evidence.aggregation_key,
        ['owner_user_id', 'device_id', 'context_id', 'metric', 'stress_type']
    );
    assert.equal(
        computeStressMemory(aggregate({
            stress_count: 10,
            distinct_days: 1,
            first_seen_at: '2026-01-03T00:00:00.000Z',
            last_seen_at: '2026-01-03T00:00:00.000Z',
            older_count: 0,
            recent_count: 10
        }), now).trend_direction,
        'stable',
        'events without temporal spread cannot establish a trend'
    );

    console.log('PASS stress memory unit validation');
}

run();
