// Rayat Intelligence — Sprint 4.5 · Explainability Engine (additivo, DETERMINISTICO, NO LLM)
// Genera una spiegazione semplice (italiano, farmer-friendly) dell'Intelligence Score per owner+device+context.
// Sorgenti READ-ONLY: agro_intelligence_score/subscores/trends/benchmark + agro_greenhouse_health_profile/knowledge.
// Regole: deterministico, nessuna AI/LLM, nessuna agronomia inventata, privacy-safe (mai evidenze raw cross-cliente),
// contesto locale prima, benchmark solo se disponibile e sopra soglia anonimato. Fail-closed su dati mancanti.
// Scrive SOLO agro_intelligence_explanations. Non modifica Sprint 1/2/3/4.1-4.4.
'use strict';
const { query } = require('../config/database');
const C = require('./intelligence-common');
const { assertLocalIdentity } = require('./intelligence-tenancy');

const RULE_VERSION = 's4.5';

const SUB_LABELS = {
    stability: 'stabilità ambientale', stress: 'gestione dello stress', recovery: 'capacità di recupero',
    resilience: 'resilienza', data_quality: 'qualità dei dati', maturity: 'maturità dell\'apprendimento'
};
const BAND_LABELS = { excellent: 'eccellente', good: 'buono', attention: 'da monitorare', risk: 'a rischio', critical: 'critico', unknown: 'non determinato' };
const DIR_LABELS = { improving: 'in miglioramento', degrading: 'in peggioramento', stable: 'stabile', volatile: 'instabile', insufficient_data: 'non determinabile' };
const POS_LABELS = { top_quartile: 'quartile alto', above_median: 'sopra la media', below_median: 'sotto la media', bottom_quartile: 'quartile basso', unknown: 'non determinato' };
const MAT_LABELS = { cold_start: 'iniziale', learning: 'in apprendimento', stable: 'stabile', mature: 'matura' };

function joinIt(items) {
    const a = items.filter(Boolean);
    if (!a.length) { return ''; }
    if (a.length === 1) { return a[0]; }
    return `${a.slice(0, -1).join(', ')} e ${a[a.length - 1]}`;
}
function r0(x) { return C.isFiniteNumber(Number(x)) ? Math.round(Number(x)) : null; }

// Estrae i 6 sotto-punteggi come array ordinabile {key,label,score}
function subArray(sub) {
    if (!sub) { return []; }
    return [
        { key: 'stability', score: C.num(sub.stability_score) },
        { key: 'stress', score: C.num(sub.stress_score) },
        { key: 'recovery', score: C.num(sub.recovery_score) },
        { key: 'resilience', score: C.num(sub.resilience_score) },
        { key: 'data_quality', score: C.num(sub.data_quality_score) },
        { key: 'maturity', score: C.num(sub.maturity_score) }
    ].filter((x) => C.isFiniteNumber(x.score)).map((x) => ({ ...x, label: SUB_LABELS[x.key] }));
}

// ---- pure: costruisce la spiegazione strutturata + testo ----
function buildExplanation(input) {
    const out = {
        language: 'it', score_summary: '', why_score_is_high_or_low: '',
        top_positive_factors: [], top_negative_factors: [],
        trend_explanation: '', benchmark_explanation: '', recommended_focus: [],
        confidence_explanation: '', data_limitations: [], evidence_json: {}
    };
    const score = input.score || null;
    const sub = input.subscores || null;
    const trends = Array.isArray(input.trends) ? input.trends : [];
    const benchmark = input.benchmark || null;
    const health = input.health || null;
    const knowledge = input.knowledge || null;
    const missing = [];
    if (!sub) { missing.push('subscores'); }
    if (!trends.length) { missing.push('trends'); }
    if (!benchmark) { missing.push('benchmark'); }
    if (!health) { missing.push('health_profile'); }
    if (!knowledge) { missing.push('knowledge'); }

    // Fail-closed: senza score non si spiega nulla (messaggio onesto)
    if (!score || !C.isFiniteNumber(C.num(score.intelligence_score))) {
        out.score_summary = 'Punteggio intelligenza non ancora disponibile per questa serra.';
        out.confidence_explanation = 'Affidabilità non valutabile: nessun punteggio calcolato.';
        out.data_limitations = ['Nessun punteggio disponibile: dati insufficienti o motore non ancora eseguito per questo contesto.'];
        out.evidence_json = { available: false, missing: ['score', ...missing] };
        return out;
    }

    const s = r0(score.intelligence_score);
    const band = String(score.intelligence_band || 'unknown');
    const conf = C.num(score.confidence) || 0;
    const mat = String(score.maturity_level || 'cold_start');
    out.score_summary = `Punteggio intelligenza: ${s}/100 (${BAND_LABELS[band] || band}).`;

    // fattori positivi/negativi (deterministico: ordina per score, tie-break per key)
    const subs = subArray(sub);
    const desc = [...subs].sort((a, b) => (b.score - a.score) || a.key.localeCompare(b.key));
    const asc = [...subs].sort((a, b) => (a.score - b.score) || a.key.localeCompare(b.key));
    out.top_positive_factors = desc.filter((x) => x.score >= 65).slice(0, 3).map((x) => ({ key: x.key, label: x.label, score: C.round1(x.score) }));
    out.top_negative_factors = asc.filter((x) => x.score < 55).slice(0, 3).map((x) => ({ key: x.key, label: x.label, score: C.round1(x.score) }));
    const posL = out.top_positive_factors.map((x) => x.label);
    const negL = out.top_negative_factors.map((x) => x.label);
    if (posL.length && negL.length) { out.why_score_is_high_or_low = `La serra è forte su ${joinIt(posL)}, ma debole su ${joinIt(negL)}.`; }
    else if (posL.length) { out.why_score_is_high_or_low = `La serra ha buoni risultati su ${joinIt(posL)}.`; }
    else if (negL.length) { out.why_score_is_high_or_low = `La serra mostra debolezze su ${joinIt(negL)}.`; }
    else if (subs.length) { out.why_score_is_high_or_low = 'La serra ha valori intermedi su tutti i fattori principali.'; }
    else { out.why_score_is_high_or_low = 'Sotto-punteggi non disponibili per il dettaglio dei fattori.'; }

    // trend (headline = intelligence_score; clausola secondaria = peggior sotto-metrica in peggioramento/instabile)
    const headTrend = trends.find((t) => t.metric === 'intelligence_score') || null;
    if (!headTrend || headTrend.trend_direction === 'insufficient_data') {
        out.trend_explanation = 'Andamento: storico troppo breve per una tendenza affidabile.';
    } else {
        out.trend_explanation = `Andamento del punteggio: ${DIR_LABELS[headTrend.trend_direction]} nelle ultime settimane.`;
        const bad = trends
            .filter((t) => t.metric !== 'intelligence_score' && (t.trend_direction === 'degrading' || t.trend_direction === 'volatile'))
            .sort((a, b) => a.metric.localeCompare(b.metric))[0];
        if (bad) { out.trend_explanation += ` Attenzione: ${SUB_LABELS[bad.metric] || bad.metric} ${DIR_LABELS[bad.trend_direction]}.`; }
    }

    // benchmark (solo se ok e sopra soglia; altrimenti messaggio onesto, nessun dettaglio)
    if (benchmark && benchmark.benchmark_status === 'ok') {
        const pr = r0(benchmark.percentile_rank);
        const rel = POS_LABELS[benchmark.relative_position] || 'non determinato';
        const crop = benchmark.crop_key ? String(benchmark.crop_key) : 'coltura simile';
        const medium = benchmark.medium ? String(benchmark.medium) : 'substrato simile';
        out.benchmark_explanation = `Rispetto ad aziende simili (${crop}, ${medium}), il tuo punteggio è nel ${rel} (percentile ${pr}, su ${benchmark.cohort_size} serre simili).`;
    } else {
        out.benchmark_explanation = 'Benchmark non disponibile: numero insufficiente di aziende simili.';
    }

    // recommended_focus: prima dal profilo di salute (locale), poi fallback sul peggior sotto-punteggio
    const hf = health && Array.isArray(health.recommended_focus) ? health.recommended_focus : [];
    const focus = [];
    for (const item of hf) {
        if (typeof item === 'string' && item.trim()) { focus.push(item.trim()); }
        else if (item && typeof item === 'object') { const v = item.label || item.focus || item.metric || item.area; if (v) { focus.push(String(v)); } }
        if (focus.length >= 3) { break; }
    }
    if (focus.length) { out.recommended_focus = focus.slice(0, 3); }
    else if (out.top_negative_factors.length) { out.recommended_focus = [`Migliorare ${out.top_negative_factors[0].label}.`]; }
    else { out.recommended_focus = ['Mantenere le buone pratiche attuali.']; }

    // confidence
    const matLabel = MAT_LABELS[mat] || mat;
    if (conf >= 0.7 && (mat === 'stable' || mat === 'mature')) { out.confidence_explanation = `Affidabilità alta: dati sufficienti (maturità ${matLabel}).`; }
    else if (conf >= 0.4) { out.confidence_explanation = `Affidabilità media: il sistema sta ancora imparando (maturità ${matLabel}).`; }
    else { out.confidence_explanation = `Affidabilità bassa: dati ancora in maturazione (maturità ${matLabel}), i risultati possono cambiare.`; }

    // data_limitations (onesto)
    const lim = [];
    if (!sub) { lim.push('Sotto-punteggi non disponibili.'); }
    if (mat === 'cold_start' || mat === 'learning') { lim.push(`Apprendimento ancora in fase ${matLabel}: servono più dati.`); }
    if (!headTrend || headTrend.trend_direction === 'insufficient_data') { lim.push('Storico troppo breve per una tendenza affidabile.'); }
    if (!benchmark || benchmark.benchmark_status !== 'ok') { lim.push('Confronto con altre aziende non disponibile (popolazione insufficiente o privacy).'); }
    if (!health) { lim.push('Profilo di salute non ancora calcolato.'); }
    if (conf < 0.4) { lim.push('Affidabilità complessiva bassa.'); }
    out.data_limitations = lim;

    // evidence_json (privacy-safe: SOLO aggregati, nessun id cross-cliente)
    out.evidence_json = {
        available: true,
        score: { value: s, band, confidence: C.round3(conf), maturity_level: mat },
        subscores: sub ? {
            stability: C.round1(C.num(sub.stability_score)), stress: C.round1(C.num(sub.stress_score)),
            recovery: C.round1(C.num(sub.recovery_score)), resilience: C.round1(C.num(sub.resilience_score)),
            data_quality: C.round1(C.num(sub.data_quality_score)), maturity: C.round1(C.num(sub.maturity_score))
        } : null,
        trend: headTrend ? { direction: headTrend.trend_direction, strength: C.round3(C.num(headTrend.trend_strength)), sample_count: Number(headTrend.sample_count) || 0 } : null,
        sub_trends: trends.filter((t) => t.metric !== 'intelligence_score').map((t) => ({ metric: t.metric, direction: t.trend_direction })).sort((a, b) => a.metric.localeCompare(b.metric)),
        benchmark: benchmark && benchmark.benchmark_status === 'ok'
            ? { status: 'ok', percentile_rank: r0(benchmark.percentile_rank), relative_position: benchmark.relative_position, cohort_size: Number(benchmark.cohort_size) || 0, distinct_owner_count: Number(benchmark.distinct_owner_count) || 0, cohort_average: C.round1(C.num(benchmark.cohort_average)), crop_key: benchmark.crop_key || null, medium: benchmark.medium || null, cultivation_type: benchmark.cultivation_type || null }
            : { status: benchmark ? benchmark.benchmark_status : 'unavailable' },
        health: health ? { health_score: C.round1(C.num(health.health_score)), health_band: health.health_band || 'unknown', maturity_level: health.maturity_level || 'cold_start' } : null,
        knowledge: knowledge ? { knowledge_maturity: knowledge.knowledge_maturity || 'cold_start', confidence: C.round3(C.num(knowledge.confidence) || 0) } : null,
        missing
    };
    return out;
}

async function ensureExplanationSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_intelligence_explanations (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           score_summary TEXT NOT NULL DEFAULT '',
           why_summary TEXT NOT NULL DEFAULT '',
           trend_explanation TEXT NOT NULL DEFAULT '',
           benchmark_explanation TEXT NOT NULL DEFAULT '',
           confidence_explanation TEXT NOT NULL DEFAULT '',
           recommended_focus JSONB NOT NULL DEFAULT '[]'::jsonb,
           top_positive_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
           top_negative_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
           data_limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           language VARCHAR(8) NOT NULL DEFAULT 'it',
           rule_version VARCHAR(20) NOT NULL DEFAULT 's4.5',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_intelligence_explanations UNIQUE (owner_user_id, device_id, context_id),
           CONSTRAINT chk_explanations_arrays CHECK (
             jsonb_typeof(recommended_focus) = 'array' AND jsonb_typeof(top_positive_factors) = 'array'
             AND jsonb_typeof(top_negative_factors) = 'array' AND jsonb_typeof(data_limitations) = 'array'),
           CONSTRAINT chk_explanations_privacy CHECK (
             NOT jsonb_exists_any(evidence_json, ARRAY['owner_user_id','device_id','greenhouse_id','greenhouse_ids','owner_ids','device_ids','member_ids','event_ids','supporting_event_ids']))
         )`
    );
    await query(
        `CREATE OR REPLACE FUNCTION rayat_assert_explanation_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; ctx_owner INTEGER; ctx_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'explanation identity cannot be NULL'; END IF;
           SELECT COALESCE(u.owner_user_id, u.id) INTO expected_owner FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id INTO ctx_owner, ctx_device FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN RAISE EXCEPTION 'explanation owner does not own device'; END IF;
           IF ctx_owner IS NULL OR ctx_owner IS DISTINCT FROM NEW.owner_user_id OR ctx_device IS DISTINCT FROM NEW.device_id THEN RAISE EXCEPTION 'explanation context mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await query('DROP TRIGGER IF EXISTS trg_assert_agro_intelligence_explanations ON agro_intelligence_explanations');
    await query('CREATE TRIGGER trg_assert_agro_intelligence_explanations BEFORE INSERT OR UPDATE ON agro_intelligence_explanations FOR EACH ROW EXECUTE FUNCTION rayat_assert_explanation_identity()');
    await query('CREATE INDEX IF NOT EXISTS idx_is_expl_part ON agro_intelligence_explanations (owner_user_id, device_id, context_id)');
}

// fail-soft su tabella sorgente assente (motore a monte non ancora eseguito): ritorna fallback
async function safeOne(sql, params, fallback = null) {
    try { const r = await query(sql, params); return r.length ? r[0] : fallback; }
    catch (e) { if (/does not exist|relation/i.test(e.message || '')) { return fallback; } throw e; }
}
async function safeMany(sql, params) {
    try { return await query(sql, params); } catch (e) { if (/does not exist|relation/i.test(e.message || '')) { return []; } throw e; }
}

async function loadExplanationInputs(owner, device, context) {
    const score = await safeOne('SELECT intelligence_score, intelligence_band, confidence, maturity_level FROM agro_intelligence_score WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [owner, device, context]);
    const subscores = await safeOne('SELECT stability_score, stress_score, recovery_score, resilience_score, data_quality_score, maturity_score, confidence, maturity_level FROM agro_intelligence_subscores WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [owner, device, context]);
    const trends = await safeMany('SELECT metric, trend_direction, trend_strength, trend_confidence, sample_count FROM agro_intelligence_trends WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [owner, device, context]);
    const benchmark = await safeOne('SELECT benchmark_status, percentile_rank, relative_position, cohort_size, distinct_owner_count, cohort_average, crop_key, medium, cultivation_type FROM agro_intelligence_benchmark WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [owner, device, context]);
    const health = await safeOne('SELECT health_score, health_band, recommended_focus, stress_load_score, maturity_level, confidence FROM agro_greenhouse_health_profile WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [owner, device, context]);
    const knowledge = await safeOne('SELECT knowledge_maturity, confidence FROM agro_greenhouse_knowledge WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [owner, device, context]);
    return { score, subscores, trends, benchmark, health, knowledge };
}

// Servizio chiamabile (LIVE) usato dall'API: spiegazione fresca e deterministica, nessuna scrittura.
async function generateExplanation(owner, device, context) {
    const inputs = await loadExplanationInputs(owner, device, context);
    return buildExplanation(inputs);
}

async function upsertExplanation(owner, device, context, ex) {
    await query(
        `INSERT INTO agro_intelligence_explanations
            (owner_user_id, device_id, context_id, score_summary, why_summary, trend_explanation, benchmark_explanation,
             confidence_explanation, recommended_focus, top_positive_factors, top_negative_factors, data_limitations,
             evidence_json, language, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), CAST(? AS JSONB), ?, ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id) DO UPDATE SET
            score_summary = EXCLUDED.score_summary, why_summary = EXCLUDED.why_summary, trend_explanation = EXCLUDED.trend_explanation,
            benchmark_explanation = EXCLUDED.benchmark_explanation, confidence_explanation = EXCLUDED.confidence_explanation,
            recommended_focus = EXCLUDED.recommended_focus, top_positive_factors = EXCLUDED.top_positive_factors,
            top_negative_factors = EXCLUDED.top_negative_factors, data_limitations = EXCLUDED.data_limitations,
            evidence_json = EXCLUDED.evidence_json, language = EXCLUDED.language, updated_at = NOW()
         RETURNING id`,
        [owner, device, context, ex.score_summary, ex.why_score_is_high_or_low, ex.trend_explanation, ex.benchmark_explanation,
         ex.confidence_explanation, JSON.stringify(ex.recommended_focus), JSON.stringify(ex.top_positive_factors),
         JSON.stringify(ex.top_negative_factors), JSON.stringify(ex.data_limitations), JSON.stringify(ex.evidence_json), 'it', RULE_VERSION]
    );
}

// Batch (job): genera/persiste spiegazioni per tutti i contesti production con uno score.
async function runExplainability({ dryRun = false } = {}) {
    const summary = { contexts: 0, stored: 0, dry_run: dryRun };
    const groups = await query(
        `SELECT s.owner_user_id, s.device_id, s.context_id
         FROM agro_intelligence_score s
         JOIN agro_context_segments c ON c.id = s.context_id AND c.is_production = TRUE`
    );
    summary.contexts = groups.length;
    const rows = [];
    for (const g of groups) {
        assertLocalIdentity({ ownerUserId: g.owner_user_id, deviceId: g.device_id, context: 'explainability' }); // fail-closed
        const ex = await generateExplanation(g.owner_user_id, g.device_id, g.context_id);
        rows.push({ key: { owner_user_id: g.owner_user_id, device_id: g.device_id, context_id: g.context_id }, explanation: ex });
        if (!dryRun) { await upsertExplanation(g.owner_user_id, g.device_id, g.context_id, ex); summary.stored += 1; }
    }
    return dryRun ? { ...summary, rows } : summary;
}

module.exports = {
    ensureExplanationSchema, buildExplanation, generateExplanation, loadExplanationInputs, runExplainability,
    SUB_LABELS, BAND_LABELS, DIR_LABELS, POS_LABELS, RULE_VERSION
};
