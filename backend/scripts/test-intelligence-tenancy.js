'use strict';

const assert = require('node:assert/strict');
const {
    assertLocalIdentity,
    assertScopedIdentity,
    fleetEligibility,
    fleetSafeEvidence,
    fleetSafeExamples,
    tenantSafeLocalKey
} = require('../utils/intelligence-tenancy');
const { aggregatePatterns, mineSensorTimeline } = require('../utils/pattern-discovery');
const { mineTriggers } = require('../utils/trigger-discovery');
const { groupRecoveryEpisodes } = require('../utils/recovery-intelligence');
const { aggregateEventRows } = require('../utils/learning-engine');

function mapValues(metricValues, metric) {
    return metricValues.get(metric) || [];
}

function run() {
    assert.deepEqual(
        assertLocalIdentity({ ownerUserId: 101, deviceId: 1 }),
        { owner_user_id: 101, device_id: 1, greenhouse_scope: 1 }
    );
    assert.throws(() => assertLocalIdentity({ ownerUserId: null, deviceId: 1 }), /unresolved/);
    assert.throws(
        () => assertScopedIdentity({ scopeType: 'fleet', ownerUserId: 101, deviceId: null, greenhouseScope: null }),
        /must not retain/
    );
    assert.equal(tenantSafeLocalKey('pattern', { ownerUserId: 101, deviceId: 1 }, 'abc'), 'pattern|101|1|abc');

    const oneCustomerThreeGreenhouses = fleetEligibility([101, 101, 101], [1, 2, 3]);
    assert.equal(oneCustomerThreeGreenhouses.distinct_owner_count, 1);
    assert.equal(oneCustomerThreeGreenhouses.fleet_eligible, false);
    const threeCustomers = fleetEligibility([101, 202, 303], [1, 2, 3]);
    assert.equal(threeCustomers.distinct_owner_count, 3);
    assert.equal(threeCustomers.fleet_eligible, true);

    const rawEvidence = {
        occurrences: 3,
        owner_user_id: 101,
        nested: { device_id: 1, antecedent_event_id: 9001, aggregate: 7 }
    };
    assert.deepEqual(fleetSafeEvidence('fleet', rawEvidence), { occurrences: 3, nested: { aggregate: 7 } });
    assert.deepEqual(fleetSafeExamples('fleet', [{ antecedent_event_id: 1 }]), []);

    const now = Date.UTC(2026, 0, 10);
    const instances = [
        { ownerUserId: 101, deviceId: 1, seq: ['out_of_range', 'recovery'], firstStart: now - 3000, durationMs: 1000 },
        { ownerUserId: 202, deviceId: 2, seq: ['out_of_range', 'recovery'], firstStart: now - 2000, durationMs: 1000 },
        { ownerUserId: 303, deviceId: 3, seq: ['out_of_range', 'recovery'], firstStart: now - 1000, durationMs: 1000 }
    ];
    const patterns = aggregatePatterns(instances, now);
    const localPatterns = [...patterns.values()].filter((pattern) => pattern.scope_type === 'greenhouse');
    const fleetPattern = [...patterns.values()].find((pattern) => pattern.scope_type === 'fleet');
    assert.equal(localPatterns.length, 3);
    assert.deepEqual(localPatterns.map((pattern) => pattern.occurrences), [1, 1, 1]);
    assert.equal(fleetPattern.ownerIds.size, 3);
    assert.equal(fleetPattern.deviceIds.size, 3);

    assert.throws(
        () => mineSensorTimeline([
            { ownerUserId: 101, deviceId: 1, type: 'out_of_range', startMs: 1, endMs: 2 },
            { ownerUserId: 202, deviceId: 1, type: 'recovery', startMs: 3, endMs: 4 }
        ], { maxGapMs: 100, minLen: 2, maxLen: 2 }),
        /mixed tenant identities/
    );

    const eventsByDevice = new Map();
    for (const [ownerUserId, deviceId] of [[101, 1], [202, 2], [303, 3]]) {
        eventsByDevice.set(deviceId, [
            { id: deviceId * 10, ownerUserId, metric: 'temperature', type: 'improvement', startMs: now, value: 20, toState: 'normal' },
            { id: deviceId * 10 + 1, ownerUserId, metric: 'temperature', type: 'out_of_range', startMs: now + 3600000, value: 35, toState: 'high' }
        ]);
    }
    const triggerResult = mineTriggers(eventsByDevice, { horizonMs: 7200000, now: new Date(now) });
    const localTriggers = [...triggerResult.cand.values()].filter((trigger) => trigger.scope_type === 'greenhouse');
    const fleetTriggers = [...triggerResult.cand.values()].filter((trigger) => trigger.scope_type === 'fleet');
    assert.equal(localTriggers.length, 3);
    assert.ok(localTriggers.every((trigger) => trigger.occurrences === 1 && trigger.ownerIds.size === 1));
    assert.ok(fleetTriggers.some((trigger) => trigger.ownerIds.size === 3 && trigger.greenhouses.size === 3));
    assert.throws(
        () => mineTriggers(new Map([[1, [
            { id: 1, ownerUserId: 101, metric: 'temperature', type: 'improvement', startMs: now },
            { id: 2, ownerUserId: 202, metric: 'temperature', type: 'out_of_range', startMs: now + 1 }
        ]]]), { horizonMs: 100, now: new Date(now) }),
        /mixed tenant identities/
    );

    const recoveryRows = [];
    for (const [ownerUserId, deviceId] of [[101, 1], [202, 2], [303, 3]]) {
        recoveryRows.push(
            { id: deviceId * 10, owner_user_id: ownerUserId, device_id: deviceId, metric: 'temperature', started_at: new Date(now), duration_seconds: 3600, evidence_json: { recovery_quality: 0.8 } },
            { id: deviceId * 10 + 1, owner_user_id: ownerUserId, device_id: deviceId, metric: 'temperature', started_at: new Date(now + 1), duration_seconds: 7200, evidence_json: { recovery_quality: 0.9 } }
        );
    }
    const recoveryGroups = groupRecoveryEpisodes(recoveryRows);
    const localRecovery = [...recoveryGroups.values()].filter((group) => group.scope_type === 'greenhouse');
    const fleetRecovery = [...recoveryGroups.values()].find((group) => group.scope_type === 'fleet');
    assert.equal(localRecovery.length, 3);
    assert.ok(localRecovery.every((group) => group.episodes.length === 2 && group.ownerIds.size === 1));
    assert.equal(fleetRecovery.ownerIds.size, 3);
    assert.equal(fleetRecovery.deviceIds.size, 3);
    assert.throws(
        () => groupRecoveryEpisodes([
            recoveryRows[0],
            { ...recoveryRows[1], owner_user_id: 999 }
        ]),
        /mixed tenant identities/
    );

    const learningRows = [
        { owner_user_id: 101, device_id: 1, metric: 'temperature', event_type: 'out_of_range', value_snapshot: 35 },
        { owner_user_id: 101, device_id: 1, metric: 'temperature', event_type: 'recovery', value_snapshot: 22 },
        { owner_user_id: 202, device_id: 2, metric: 'temperature', event_type: 'out_of_range', value_snapshot: 99 }
    ];
    const learning = aggregateEventRows(learningRows);
    assert.deepEqual(mapValues(learning.perGh.get(1).metricValues, 'temperature'), [35, 22]);
    assert.deepEqual(mapValues(learning.perGh.get(2).metricValues, 'temperature'), [99]);
    assert.equal(learning.perGh.get(1).owner_user_id, 101);
    assert.throws(
        () => aggregateEventRows([...learningRows, { ...learningRows[0], owner_user_id: 202 }]),
        /ownership changed/
    );

    console.log('PASS intelligence tenant isolation: 25 assertions');
}

run();
