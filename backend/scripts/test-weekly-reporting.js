'use strict';

const assert = require('node:assert/strict');
const {
    assembleWeeklyFact,
    resolveWeekWindow,
    assertWeeklyIdentity
} = require('../utils/weekly-fact-assembler');
const {
    renderWeeklyReport,
    SECTION_TITLES
} = require('../utils/weekly-template-renderer');

function input(strong, benchmarkAvailable = true) {
    return {
        owner_user_id: 1,
        device_id: 10,
        context_id: strong ? 100 : 101,
        health_row: {
            health_score: strong ? 86 : 34,
            health_band: strong ? 'excellent' : 'risk',
            resilience_score: strong ? 88 : 35,
            stress_load_score: strong ? 18 : 82,
            recovery_score: strong ? 84 : 32,
            stability_score: strong ? 90 : 38,
            data_confidence_score: strong ? 91 : 56,
            confidence: strong ? 0.91 : 0.56,
            maturity_level: strong ? 'mature' : 'learning',
            top_positive_factors: strong ? [{ factor: 'environmental_stability', score: 90 }] : [],
            top_negative_factors: strong ? [] : [{ factor: 'stress_pressure', score: 82 }],
            recommended_focus: strong ? ['maintain_current_practices'] : ['reduce_ec_stress']
        },
        knowledge_row: {
            knowledge_maturity: strong ? 'mature' : 'learning',
            confidence: strong ? 0.9 : 0.55,
            top_strengths: strong ? ['fast_recovery'] : [],
            top_weaknesses: strong ? [] : ['high_stress_load'],
            recurring_risks: strong ? [] : ['ec_stress'],
            recurring_recoveries: strong ? ['temperature_recovery'] : []
        },
        behavior_row: {
            signature_label: strong ? 'strong_fast_recovery' : 'high_risk_tendency',
            recovery_behavior: strong ? 'fast_recovery' : 'fragile_recovery',
            stress_behavior: strong ? 'low_stress' : 'recurring_stress',
            stability_behavior: strong ? 'stable' : 'unstable',
            volatility_behavior: strong ? 'low_volatility' : 'high_volatility',
            sensor_behavior: strong ? 'reliable' : 'attention_needed',
            resilience_level: strong ? 'strong' : 'weak',
            risk_tendency: strong ? 'low' : 'high'
        },
        score_row: {
            intelligence_score: strong ? 88 : 36,
            intelligence_band: strong ? 'excellent' : 'risk',
            confidence: strong ? 0.9 : 0.55,
            maturity_level: strong ? 'mature' : 'learning'
        },
        subscore_row: {
            stability_score: strong ? 90 : 38,
            stress_score: strong ? 86 : 22,
            recovery_score: strong ? 84 : 32,
            resilience_score: strong ? 88 : 35,
            data_quality_score: strong ? 91 : 56,
            maturity_score: strong ? 95 : 50,
            confidence: strong ? 0.9 : 0.55,
            maturity_level: strong ? 'mature' : 'learning'
        },
        trend_rows: strong
            ? [{ metric: 'intelligence_score', trend_direction: 'improving', trend_strength: 0.7, trend_confidence: 0.8, sample_count: 6, slope_per_day: 0.3 }]
            : [{ metric: 'stress', trend_direction: 'degrading', trend_strength: 0.8, trend_confidence: 0.75, sample_count: 6, slope_per_day: -0.4 }],
        benchmark_row: benchmarkAvailable ? {
            benchmark_status: 'ok', percentile_rank: strong ? 88 : 22,
            relative_position: strong ? 'top_quartile' : 'bottom_quartile',
            cohort_average: 64, cohort_median: 65, cohort_top_quartile: 78,
            cohort_bottom_quartile: 48, benchmark_confidence: 0.8,
            cohort_size: 12, distinct_owner_count: 6, crop_key: 'tomato', medium: 'perlite'
        } : {},
        explanation_row: {
            recommended_focus: strong ? ['maintain_current_practices'] : ['reduce_ec_stress'],
            top_positive_factors: strong ? [{ key: 'stability', label: 'stabilità ambientale', score: 90 }] : [],
            top_negative_factors: strong ? [] : [{ key: 'stress', label: 'gestione dello stress', score: 22 }],
            data_limitations: strong ? [] : ['Apprendimento ancora in corso.'],
            confidence_explanation: strong ? 'Affidabilità alta.' : 'Affidabilità media.'
        }
    };
}

function run() {
    assert.deepEqual(resolveWeekWindow({ weekStart: '2026-06-18' }), {
        week_start: '2026-06-15', week_end: '2026-06-21'
    });
    assert.deepEqual(assertWeeklyIdentity(input(true)), {
        owner_user_id: 1, device_id: 10, context_id: 100
    });
    assert.throws(() => assertWeeklyIdentity({ owner_user_id: 1, device_id: 10 }), /unresolved/);

    const window = resolveWeekWindow({ weekStart: '2026-06-15' });
    const strong = assembleWeeklyFact(input(true), window);
    const weak = assembleWeeklyFact(input(false, false), window);
    assert.equal(strong.intelligence_score_summary.intelligence_score, 88);
    assert.equal(strong.benchmark_summary.available, true);
    assert.equal(weak.benchmark_summary.available, false);
    assert.deepEqual(strong.trend_summary.improved, ['intelligence_score']);
    assert.deepEqual(weak.trend_summary.worsened, ['stress']);
    assert.equal(JSON.stringify(strong.evidence_json).includes('owner_user_id'), false);
    assert.deepEqual(assembleWeeklyFact(input(true), window), strong, 'facts must be deterministic');

    const strongReport = renderWeeklyReport(strong);
    const weakReport = renderWeeklyReport(weak);
    assert.equal(strongReport.language, 'it');
    for (const title of SECTION_TITLES) {
        assert.ok(strongReport.report_text.includes(`## ${title}`), `missing section ${title}`);
    }
    assert.ok(strongReport.executive_summary.includes('88/100'));
    assert.ok(strongReport.improvements.includes('punteggio complessivo'));
    assert.ok(weakReport.deteriorations.includes('gestione dello stress'));
    assert.ok(weakReport.benchmark.toLowerCase().includes('benchmark non disponibile'));
    assert.notEqual(strongReport.report_text, weakReport.report_text, 'strong and weak reports must differ');
    assert.deepEqual(renderWeeklyReport(strong), strongReport, 'rendering must be deterministic');
    assert.equal(JSON.stringify(strongReport.evidence_json).includes('device_id'), false);

    console.log('PASS weekly fact assembler and Italian template renderer unit validation');
}

run();
