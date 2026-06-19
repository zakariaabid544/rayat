'use strict';

// Sprint 5.2: Italian-only, rule-based rendering. No AI or external service.
const { query } = require('../config/database');
const C = require('./intelligence-common');
const { assertWeeklyIdentity } = require('./weekly-fact-assembler');

const RULE_VERSION = 's5.2';
const SECTION_TITLES = Object.freeze([
    'Executive Summary',
    'Stato della Serra',
    'Cosa è Migliorato',
    'Cosa è Peggiorato',
    'Stress e Recupero',
    'Benchmark',
    'Focus Consigliato',
    'Note sulla Qualità dei Dati'
]);

const BAND_LABELS = Object.freeze({
    excellent: 'eccellente', good: 'buono', attention: 'da monitorare',
    risk: 'a rischio', critical: 'critico', unknown: 'non determinato'
});
const METRIC_LABELS = Object.freeze({
    intelligence_score: 'punteggio complessivo', stability: 'stabilità', stress: 'gestione dello stress',
    recovery: 'recupero', resilience: 'resilienza', maturity: 'maturità', data_quality: 'qualità dei dati'
});
const FOCUS_LABELS = Object.freeze({
    maintain_current_practices: 'Mantenere le pratiche attuali e continuare il monitoraggio.',
    inspect_sensor_reliability: 'Verificare affidabilità, deriva e calibrazione dei sensori.',
    improve_recovery_response: 'Migliorare la risposta della serra dopo gli episodi di stress.',
    reduce_relapse_frequency: 'Ridurre la frequenza delle ricadute dopo il recupero.',
    stabilize_environmental_variability: 'Ridurre la variabilità delle condizioni ambientali.',
    increase_data_coverage: 'Aumentare continuità e copertura dei dati.',
    address_high_risk_tendency: 'Intervenire sui fattori che mantengono elevata la tendenza al rischio.'
});

function objectValue(value) {
    const parsed = C.parseJson(value, {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function arrayValue(value) {
    const parsed = C.parseJson(value, []);
    return Array.isArray(parsed) ? parsed : [];
}

function n0(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function listSentence(items, emptyText) {
    const values = items.filter(Boolean);
    return values.length ? values.map((item) => `- ${item}`).join('\n') : emptyText;
}

function factorText(factor) {
    if (typeof factor === 'string') { return factor; }
    if (!factor || typeof factor !== 'object') { return ''; }
    const label = String(factor.label || factor.factor || factor.key || '').replace(/_/g, ' ');
    const score = n0(factor.score);
    return score === null ? label : `${label} (${score}/100)`;
}

function focusText(value) {
    const raw = typeof value === 'string'
        ? value.trim()
        : String((value && (value.label || value.focus || value.metric || value.area)) || '').trim();
    if (!raw) { return ''; }
    if (FOCUS_LABELS[raw]) { return FOCUS_LABELS[raw]; }
    const stressMatch = raw.match(/^reduce_(.+)_stress$/);
    if (stressMatch) { return `Ridurre gli episodi di stress associati a ${stressMatch[1].replace(/_/g, ' ')}.`; }
    if (/^[a-z0-9_]+$/.test(raw)) {
        const text = raw.replace(/_/g, ' ');
        return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
    }
    return /[.!?]$/.test(raw) ? raw : `${raw}.`;
}

function metricList(metrics) {
    return metrics.map((metric) => METRIC_LABELS[metric] || String(metric).replace(/_/g, ' '));
}

function renderWeeklyReport(fact) {
    assertWeeklyIdentity(fact, 'weekly-report-render');
    const health = objectValue(fact.health_summary);
    const score = objectValue(fact.intelligence_score_summary);
    const subscores = objectValue(fact.subscore_summary);
    const trends = objectValue(fact.trend_summary);
    const benchmark = objectValue(fact.benchmark_summary);
    const evidence = objectValue(fact.evidence_json);
    const behavior = objectValue(evidence.behavioral_signature);
    const positive = arrayValue(fact.positive_factors).map(factorText).filter(Boolean);
    const negative = arrayValue(fact.negative_factors).map(factorText).filter(Boolean);
    const focus = arrayValue(fact.recommended_focus).map(focusText).filter(Boolean);
    const improved = metricList(arrayValue(trends.improved));
    const worsened = metricList(arrayValue(trends.worsened));

    const intelligence = n0(score.intelligence_score);
    const healthScore = n0(health.health_score);
    const scoreBand = BAND_LABELS[score.intelligence_band] || BAND_LABELS.unknown;
    const healthBand = BAND_LABELS[health.health_band] || BAND_LABELS.unknown;
    const executive = intelligence === null
        ? 'Il punteggio di intelligenza non è ancora disponibile. Il report descrive solo gli indicatori locali presenti e mantiene espliciti i limiti dei dati.'
        : `Nella settimana ${fact.week_start} - ${fact.week_end}, il punteggio di intelligenza della serra è ${intelligence}/100 (${scoreBand}). Il profilo di salute è ${healthBand}${healthScore === null ? '' : ` con ${healthScore}/100`}.`;

    const stateParts = [];
    if (subscores.available) {
        for (const key of ['stability', 'stress', 'recovery', 'resilience', 'data_quality']) {
            const value = n0(subscores[key]);
            if (value !== null) { stateParts.push(`${METRIC_LABELS[key]} ${value}/100`); }
        }
    }
    const state = stateParts.length
        ? `Indicatori locali: ${stateParts.join(', ')}. ${positive.length ? `Punti positivi principali:\n${listSentence(positive, '')}` : 'Non emergono ancora punti di forza sufficientemente affidabili.'}`
        : 'Gli indicatori di dettaglio non sono ancora disponibili per questo contesto.';

    const improvedText = improved.length
        ? `Le tendenze indicano un miglioramento in: ${improved.join(', ')}.\n${listSentence(positive, '')}`
        : 'Nessun miglioramento affidabile è rilevabile con lo storico disponibile.';
    const worsenedText = worsened.length
        ? `Le aree in peggioramento o instabili sono: ${worsened.join(', ')}.\n${listSentence(negative, '')}`
        : negative.length
            ? `Non risulta un trend settimanale in peggioramento, ma restano questi fattori da sorvegliare:\n${listSentence(negative, '')}`
            : 'Nessun peggioramento affidabile è rilevabile con lo storico disponibile.';

    const stressLoad = n0(health.stress_load_score);
    const recovery = n0(health.recovery_score);
    const stressRecovery = health.available
        ? `Carico di stress: ${stressLoad === null ? 'non disponibile' : `${stressLoad}/100`}. Capacità di recupero: ${recovery === null ? 'non disponibile' : `${recovery}/100`}. Profilo osservato: stress ${String(behavior.stress_behavior || 'non determinato').replace(/_/g, ' ')}, recupero ${String(behavior.recovery_behavior || 'non determinato').replace(/_/g, ' ')}.`
        : 'Stress e recupero non sono ancora valutabili: il profilo di salute locale non è disponibile.';

    const benchmarkText = benchmark.available
        ? `Il confronto anonimo colloca la serra al percentile ${n0(benchmark.percentile_rank)} (${String(benchmark.relative_position || 'unknown').replace(/_/g, ' ')}), su ${Number(benchmark.cohort_size) || 0} serre e ${Number(benchmark.distinct_owner_count) || 0} clienti distinti. Il benchmark è solo comparativo e non sostituisce la conoscenza locale.`
        : 'Benchmark non disponibile: la popolazione comparabile non raggiunge la soglia minima oppure il confronto è stato escluso per tutelare la privacy.';
    const focusTextSection = listSentence(focus, 'Mantenere il monitoraggio finché non sono disponibili evidenze sufficienti per una raccomandazione specifica.');

    const qualityLines = [...arrayValue(fact.data_quality_notes), ...arrayValue(fact.limitations)]
        .map((item) => String(item || '').trim()).filter(Boolean);
    const quality = listSentence([...new Set(qualityLines)], 'Nessuna nota aggiuntiva sulla qualità dei dati.');

    const sections = {
        executive_summary: executive,
        greenhouse_status: state,
        improvements: improvedText,
        deteriorations: worsenedText,
        stress_recovery: stressRecovery,
        benchmark: benchmarkText,
        recommended_focus: focusTextSection,
        data_quality_notes: quality
    };
    const orderedBodies = [
        sections.executive_summary, sections.greenhouse_status, sections.improvements,
        sections.deteriorations, sections.stress_recovery, sections.benchmark,
        sections.recommended_focus, sections.data_quality_notes
    ];
    return {
        language: 'it',
        ...sections,
        report_text: SECTION_TITLES.map((title, index) => `## ${title}\n${orderedBodies[index]}`).join('\n\n'),
        evidence_json: {
            rule_version: RULE_VERSION,
            source_fact_rule_version: fact.rule_version || 's5.1',
            sections: SECTION_TITLES,
            source_availability: objectValue(evidence.source_availability),
            privacy: { raw_evidence: false, cross_customer_evidence: false }
        },
        rule_version: RULE_VERSION
    };
}

async function ensureWeeklyReportSchema({ executor = query } = {}) {
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_weekly_reports (
           id BIGSERIAL PRIMARY KEY,
           fact_package_id BIGINT NOT NULL REFERENCES agro_weekly_fact_packages(id) ON DELETE CASCADE,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           week_start DATE NOT NULL,
           week_end DATE NOT NULL,
           language VARCHAR(8) NOT NULL DEFAULT 'it',
           executive_summary TEXT NOT NULL,
           greenhouse_status TEXT NOT NULL,
           improvements TEXT NOT NULL,
           deteriorations TEXT NOT NULL,
           stress_recovery TEXT NOT NULL,
           benchmark TEXT NOT NULL,
           recommended_focus TEXT NOT NULL,
           data_quality_notes TEXT NOT NULL,
           report_text TEXT NOT NULL,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's5.2',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_weekly_report UNIQUE (owner_user_id, device_id, context_id, week_start),
           CONSTRAINT weekly_report_window_check CHECK (week_end = week_start + 6),
           CONSTRAINT weekly_report_language_check CHECK (language = 'it')
         )`
    );
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_weekly_report_identity() RETURNS trigger AS $$
         DECLARE context_owner INTEGER; context_device INTEGER; fact_owner INTEGER;
           fact_device INTEGER; fact_context BIGINT; fact_week DATE;
         BEGIN
           SELECT owner_user_id, device_id INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           SELECT owner_user_id, device_id, context_id, week_start
             INTO fact_owner, fact_device, fact_context, fact_week
             FROM agro_weekly_fact_packages WHERE id = NEW.fact_package_id;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'weekly report context_id does not belong to owner/device'; END IF;
           IF fact_owner IS NULL OR fact_owner IS DISTINCT FROM NEW.owner_user_id
              OR fact_device IS DISTINCT FROM NEW.device_id OR fact_context IS DISTINCT FROM NEW.context_id
              OR fact_week IS DISTINCT FROM NEW.week_start THEN
             RAISE EXCEPTION 'weekly report fact package identity mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS weekly_report_identity_guard ON agro_weekly_reports');
    await executor(
        `CREATE TRIGGER weekly_report_identity_guard BEFORE INSERT OR UPDATE ON agro_weekly_reports
         FOR EACH ROW EXECUTE FUNCTION rayat_assert_weekly_report_identity()`
    );
    await executor('CREATE INDEX IF NOT EXISTS idx_weekly_report_context_week ON agro_weekly_reports (context_id, week_start DESC)');
    await executor('CREATE INDEX IF NOT EXISTS idx_weekly_report_owner_device_week ON agro_weekly_reports (owner_user_id, device_id, week_start DESC)');
}

async function upsertWeeklyReport(fact, report, factPackageId, executor = query) {
    const identity = assertWeeklyIdentity(fact, 'weekly-report-upsert');
    const factId = Number(factPackageId);
    if (!Number.isInteger(factId) || factId < 1) { throw new Error('[weekly-report-upsert] missing fact package id'); }
    await executor(
        `INSERT INTO agro_weekly_reports
          (fact_package_id, owner_user_id, device_id, context_id, week_start, week_end, language,
           executive_summary, greenhouse_status, improvements, deteriorations, stress_recovery,
           benchmark, recommended_focus, data_quality_notes, report_text, evidence_json,
           rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'it', ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, week_start) DO UPDATE SET
           fact_package_id=EXCLUDED.fact_package_id, week_end=EXCLUDED.week_end,
           language=EXCLUDED.language, executive_summary=EXCLUDED.executive_summary,
           greenhouse_status=EXCLUDED.greenhouse_status, improvements=EXCLUDED.improvements,
           deteriorations=EXCLUDED.deteriorations, stress_recovery=EXCLUDED.stress_recovery,
           benchmark=EXCLUDED.benchmark, recommended_focus=EXCLUDED.recommended_focus,
           data_quality_notes=EXCLUDED.data_quality_notes, report_text=EXCLUDED.report_text,
           evidence_json=EXCLUDED.evidence_json, rule_version=EXCLUDED.rule_version, updated_at=NOW()`,
        [factId, identity.owner_user_id, identity.device_id, identity.context_id,
            fact.week_start, fact.week_end, report.executive_summary, report.greenhouse_status,
            report.improvements, report.deteriorations, report.stress_recovery, report.benchmark,
            report.recommended_focus, report.data_quality_notes, report.report_text,
            JSON.stringify(report.evidence_json), RULE_VERSION]
    );
}

module.exports = {
    ensureWeeklyReportSchema,
    upsertWeeklyReport,
    renderWeeklyReport,
    focusText,
    SECTION_TITLES,
    RULE_VERSION
};
