'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
    buildWeeklyPdfBuffer,
    outputDescriptor,
    normalizeIdentity,
    normalizeDate,
    sourceForPdf,
    sha256,
    CONTENT_SOURCE_TABLES
} = require('../utils/weekly-pdf-export');

function fixture(overrides = {}) {
    return {
        report_id: 501,
        report_fact_package_id: 401,
        fact_package_id: 401,
        owner_user_id: 1,
        device_id: 10,
        context_id: 100,
        week_start: '2026-06-15',
        week_end: '2026-06-21',
        health_summary: {
            available: true, health_score: 86, health_band: 'excellent',
            resilience_score: 88, stress_load_score: 18, recovery_score: 84,
            stability_score: 90, data_confidence_score: 91
        },
        intelligence_score_summary: {
            available: true, intelligence_score: 88, intelligence_band: 'excellent', confidence: 0.9
        },
        subscore_summary: {
            available: true, stability: 90, stress: 86, recovery: 84,
            resilience: 88, data_quality: 91, maturity: 95
        },
        trend_summary: {
            available: true,
            items: [
                { metric: 'intelligence_score', direction: 'improving', strength: 0.7 },
                { metric: 'stress', direction: 'stable', strength: 0.2 }
            ]
        },
        benchmark_summary: {
            available: true, percentile_rank: 88, relative_position: 'top_quartile',
            cohort_size: 12, distinct_owner_count: 6
        },
        positive_factors: [{ key: 'stability', label: 'stabilità ambientale', score: 90 }],
        negative_factors: [],
        recommended_focus_facts: ['maintain_current_practices'],
        data_quality_facts: ['Qualità dei dati: 91/100.'],
        limitations: [],
        executive_summary: 'La serra presenta un profilo complessivamente eccellente.',
        greenhouse_status: 'Indicatori locali stabili e affidabili.',
        improvements: 'Miglioramento del punteggio complessivo.',
        deteriorations: 'Nessun peggioramento affidabile rilevato.',
        stress_recovery: 'Carico di stress 18/100. Capacità di recupero 84/100.',
        benchmark: 'La serra si colloca nel quartile alto.',
        recommended_focus: '- Mantenere le pratiche attuali.\n- Continuare il monitoraggio.',
        data_quality_notes: '- Qualità dei dati: 91/100.\n- Affidabilità alta.',
        language: 'it',
        fact_rule_version: 's5.1',
        report_rule_version: 's5.2',
        ...overrides
    };
}

async function run() {
    assert.deepEqual(CONTENT_SOURCE_TABLES, ['agro_weekly_fact_packages', 'agro_weekly_reports']);
    assert.deepEqual(normalizeIdentity({ ownerUserId: 1, deviceId: 10, contextId: 100 }), {
        owner_user_id: 1, device_id: 10, context_id: 100
    });
    assert.equal(normalizeDate('2026-06-15', 'week_start'), '2026-06-15');
    assert.throws(() => normalizeDate('2026-02-30', 'week_start'), /invalid/);
    assert.throws(() => normalizeIdentity({ ownerUserId: 1, deviceId: 10 }), /unresolved/);
    assert.throws(
        () => sourceForPdf(fixture({ report_fact_package_id: 999 })),
        /report\/fact package mismatch/
    );

    const source = sourceForPdf(fixture());
    assert.equal(source.display_name, 'Serra - dispositivo 10');
    const descriptor = outputDescriptor(source, '/tmp/rayat-pdf-unit');
    assert.equal(descriptor.file_name, 'rayat-weekly-report-context-100-2026-06-15.pdf');
    assert.ok(descriptor.file_path.startsWith(path.resolve('/tmp/rayat-pdf-unit')));

    const first = await buildWeeklyPdfBuffer(fixture());
    const second = await buildWeeklyPdfBuffer(fixture());
    assert.equal(first.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(first.length > 5000, 'professional report should contain meaningful PDF content');
    assert.deepEqual(second, first, 'same source must produce byte-identical PDF output');
    assert.match(sha256(first), /^[0-9a-f]{64}$/);
    assert.equal(sha256(second), sha256(first));

    const changed = await buildWeeklyPdfBuffer(fixture({
        executive_summary: 'La serra richiede attenzione immediata.'
    }));
    assert.notEqual(sha256(changed), sha256(first), 'source changes must alter the PDF checksum');

    console.log('PASS weekly PDF export unit validation');
    console.log(JSON.stringify({
        deterministic_bytes: true,
        checksum: sha256(first),
        file_size: first.length,
        content_sources: CONTENT_SOURCE_TABLES
    }));
}

run().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
