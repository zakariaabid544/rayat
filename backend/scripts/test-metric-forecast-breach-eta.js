'use strict';

const assert = require('node:assert/strict');
const {
    computeMetricForecasts,
    linearRegression,
    ewma,
    HORIZONS_MINUTES
} = require('../utils/metric-forecast');
const { evaluateBreachEta } = require('../utils/breach-eta');

const NOW = new Date('2026-06-20T12:00:00.000Z');

function input(values, overrides = {}) {
    const start = NOW.getTime() - (values.length - 1) * 3600000;
    return {
        owner_user_id: 1,
        device_id: 10,
        context_id: 100,
        sensor_id: 1000,
        metric: 'temperature',
        reading_rows: values.map((value, index) => ({
            value,
            timestamp: new Date(start + index * 3600000).toISOString()
        })),
        baseline_available: true,
        baseline_stddev: 2,
        baseline_confidence: 0.8,
        ...overrides
    };
}

function horizon(rows, minutes) {
    return rows.find((row) => row.horizon_minutes === minutes);
}

function run() {
    const regression = linearRegression([
        { value: 10, timestamp_ms: 0 },
        { value: 12, timestamp_ms: 3600000 },
        { value: 14, timestamp_ms: 7200000 }
    ]);
    assert.equal(regression.slope_per_hour, 2);
    assert.equal(regression.r2, 1);
    assert.equal(ewma([1, 2, 3]), ewma([1, 2, 3]), 'EWMA must be deterministic');

    const rising = computeMetricForecasts(input([80, 82, 84, 86, 88, 90, 92, 94, 96, 98]), NOW);
    assert.deepEqual(rising.map((row) => row.horizon_minutes), HORIZONS_MINUTES);
    assert.equal(rising.length, 5);
    assert.ok(rising[0].slope_per_hour > 0);
    assert.ok(horizon(rising, 180).forecast_value > horizon(rising, 60).forecast_value);
    assert.ok(rising.every((row) => row.forecast_low <= row.forecast_value && row.forecast_value <= row.forecast_high));
    assert.deepEqual(computeMetricForecasts(input([80, 82, 84, 86, 88, 90, 92, 94, 96, 98]), NOW), rising);

    const falling = computeMetricForecasts(input([40, 38, 36, 34, 32, 30, 28, 26, 24, 22], { sensor_id: 1001 }), NOW);
    assert.ok(falling[0].slope_per_hour < 0);
    const stable = computeMetricForecasts(input(Array(12).fill(50), { sensor_id: 1002 }), NOW);
    assert.equal(stable[0].slope_per_hour, 0);
    assert.equal(stable[0].forecast_value, 50);

    const few = computeMetricForecasts(input([10, 11, 12, 13], { sensor_id: 1003 }), NOW);
    const many = computeMetricForecasts(input(Array.from({ length: 24 }, (_, index) => 10 + index), { sensor_id: 1003 }), NOW);
    assert.ok(many[0].confidence > few[0].confidence, 'confidence must grow with sample coverage');
    assert.ok(many[0].data_quality_score > few[0].data_quality_score);
    assert.deepEqual(computeMetricForecasts(input([1, 2, 3]), NOW), [], 'insufficient samples are skipped');

    const risingEta = evaluateBreachEta(horizon(rising, 180), {
        min: 0, max: 100, confidence: 0.9, source: 'alert_thresholds'
    }, { confidence: 0.8 });
    assert.equal(risingEta.breach_direction, 'above_max');
    assert.ok(['breach_possible', 'breach_likely'].includes(risingEta.status));
    assert.ok(risingEta.eta_minutes > 0 && risingEta.eta_minutes <= 180);
    assert.equal(risingEta.threshold_value, 100);

    const fallingEta = evaluateBreachEta(horizon(falling, 180), {
        min: 20, max: 100, confidence: 0.9, source: 'crop_profile'
    }, { confidence: 0.8 });
    assert.equal(fallingEta.breach_direction, 'below_min');
    assert.ok(fallingEta.eta_minutes > 0 && fallingEta.eta_minutes <= 180);

    const stableEta = evaluateBreachEta(horizon(stable, 1440), {
        min: 20, max: 80, confidence: 0.9, source: 'crop_profile'
    }, { confidence: 0.8 });
    assert.equal(stableEta.status, 'no_breach_expected');
    assert.equal(stableEta.breach_direction, 'none');
    assert.equal(stableEta.eta_minutes, null);

    const already = evaluateBreachEta({ ...horizon(rising, 60), current_value: 120 }, {
        min: 0, max: 100, confidence: 0.9, source: 'alert_thresholds'
    }, { confidence: 0.8 });
    assert.equal(already.status, 'already_breached');
    assert.equal(already.breach_direction, 'above_max');
    assert.equal(already.eta_minutes, 0);

    const missing = evaluateBreachEta(horizon(rising, 60), null, { confidence: 0.8 });
    assert.equal(missing.status, 'insufficient_data');
    assert.equal(missing.breach_direction, 'unknown');
    assert.equal(missing.threshold_value, null);
    assert.equal(rising[0].evidence_json.privacy.reading_ids, false);
    assert.equal(rising[0].evidence_json.privacy.raw_readings, false);

    console.log('PASS metric forecast and breach ETA unit validation');
}

run();
