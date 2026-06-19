'use strict';

const assert = require('node:assert/strict');
const {
    assertBaselineIdentity,
    computeBaseline,
    computeEwma,
    maturityLevel
} = require('../utils/baseline-evolution');

function aggregate({ samples, days, values, lastSeen = '2026-01-09T00:00:00.000Z' }) {
    return {
        sample_count: samples,
        distinct_days: days,
        mean: 20,
        min_v: 10,
        max_v: 30,
        stddev: 2,
        variance: 4,
        p10: 12,
        p50: 20,
        p90: 28,
        vals: values,
        first_seen: '2026-01-01T00:00:00.000Z',
        last_seen: lastSeen
    };
}

function run() {
    assert.deepEqual(
        assertBaselineIdentity({ owner_user_id: 1, device_id: 10, context_id: 100, metric: 'temperature' }),
        { owner_user_id: 1, device_id: 10, context_id: 100, metric: 'temperature' }
    );
    assert.throws(
        () => assertBaselineIdentity({ owner_user_id: 1, device_id: 10, context_id: null, metric: 'temperature' }),
        /unresolved/
    );

    const expectedEwma = { ewma: 22.5, ewmaVar: 68.75 };
    assert.deepEqual(computeEwma([10, 20, 30], 3), expectedEwma);
    assert.deepEqual(computeEwma([10, 20, 30], 3), expectedEwma);
    assert.throws(() => computeEwma([1, 2], 0), /positive integer/);

    assert.equal(maturityLevel(9, 7), 'cold_start');
    assert.equal(maturityLevel(10, 1), 'learning');
    assert.equal(maturityLevel(30, 3), 'stable');
    assert.equal(maturityLevel(50, 7), 'mature');

    const now = Date.parse('2026-01-10T00:00:00.000Z');
    const low = computeBaseline(aggregate({ samples: 10, days: 1, values: Array(10).fill(20) }), now);
    const high = computeBaseline(aggregate({ samples: 50, days: 7, values: Array(50).fill(20) }), now);
    assert.ok(high.confidence > low.confidence, 'confidence must grow with evidence volume and duration');
    assert.equal(low.maturity_level, 'learning');
    assert.equal(high.maturity_level, 'mature');
    assert.deepEqual(
        computeBaseline(aggregate({ samples: 50, days: 7, values: Array(50).fill(20) }), now),
        high,
        'same aggregates and clock must produce the same baseline'
    );
    assert.equal(high.evidence.normal_band_basis, 'empirical_p10_p90');
    assert.deepEqual(high.evidence.aggregation_key, ['owner_user_id', 'device_id', 'context_id', 'metric']);
    assert.throws(
        () => computeBaseline(aggregate({ samples: 0, days: 0, values: [] }), now),
        /invalid aggregate statistics/
    );

    console.log('PASS baseline evolution unit validation');
}

run();
