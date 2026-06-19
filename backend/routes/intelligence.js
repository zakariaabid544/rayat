// Rayat Intelligence — Sprint 4.6 · Dashboard API · Intelligence Score (/api/intelligence)
// SOLA LETTURA. Rispetta: auth (JWT), tenant isolation (owner_user_id), proprietà device + context, ruoli.
// Cliente normale: vede SOLO i propri device/context. super_admin/admin: possono ispezionare qualsiasi proprietario.
// Nessuna scrittura. Spiegazione calcolata live (deterministica). Privacy: benchmark solo aggregato.
'use strict';
const express = require('express');
const { query } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isPrivilegedAdminRole } = require('../utils/admin-auth');
const { resolveCustomerScope } = require('../utils/customer-access');
const { generateExplanation } = require('../utils/explainability-engine');

const router = express.Router();

// fail-soft se una tabella intelligence non esiste ancora
async function safeRows(sql, params) {
    try { return await query(sql, params); }
    catch (e) { if (/does not exist|relation/i.test(e.message || '')) { return null; } throw e; }
}
function intParam(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

// Risolve owner scope + verifica proprietà device + context. Restituisce {owner,device,context} o lancia {status,message}.
async function resolveTarget(req) {
    const device = intParam(req.query.device_id);
    const context = intParam(req.query.context_id);
    if (!device || !context) { throw { status: 400, message: 'device_id e context_id obbligatori' }; }

    const dev = await query('SELECT COALESCE(u.owner_user_id, u.id) AS owner FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?', [device]);
    if (!dev.length) { throw { status: 404, message: 'Device inesistente' }; }
    const deviceOwner = Number(dev[0].owner);

    const privileged = isPrivilegedAdminRole(req.user.role);
    let owner;
    if (privileged) {
        owner = deviceOwner; // l'admin ispeziona i dati del proprietario reale del device
    } else {
        const scope = Number(resolveCustomerScope(req.user));
        if (!scope || deviceOwner !== scope) { throw { status: 403, message: 'Accesso negato: device non di tua proprietà' }; }
        owner = scope;
    }

    const ctx = await query('SELECT owner_user_id, device_id FROM agro_context_segments WHERE id = ?', [context]);
    if (!ctx.length) { throw { status: 404, message: 'Contesto inesistente' }; }
    if (Number(ctx[0].owner_user_id) !== owner || Number(ctx[0].device_id) !== device) {
        throw { status: 403, message: 'Accesso negato: contesto non coerente con device/proprietario' };
    }
    return { owner, device, context, privileged };
}

function wrap(fn) {
    return async (req, res) => {
        try { await fn(req, res); }
        catch (e) {
            if (e && e.status) { return res.status(e.status).json({ error: e.message, code: 'intelligence_access' }); }
            console.error('[intelligence-api] error:', e && e.message);
            return res.status(500).json({ error: 'Errore interno', code: 'intelligence_error' });
        }
    };
}

router.use(authenticateToken);

// loaders (scoped per owner+device+context)
async function loadScore(t) {
    const r = await safeRows('SELECT intelligence_score, intelligence_band, confidence, maturity_level, updated_at FROM agro_intelligence_score WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [t.owner, t.device, t.context]);
    return r && r.length ? r[0] : null;
}
async function loadSub(t) {
    const r = await safeRows('SELECT stability_score, stress_score, recovery_score, resilience_score, data_quality_score, maturity_score, confidence, maturity_level FROM agro_intelligence_subscores WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [t.owner, t.device, t.context]);
    return r && r.length ? r[0] : null;
}
async function loadTrends(t) {
    const r = await safeRows('SELECT metric, trend_direction, trend_strength, trend_confidence, trend_window_days, sample_count FROM agro_intelligence_trends WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [t.owner, t.device, t.context]);
    return r || [];
}
async function loadBenchmark(t) {
    const r = await safeRows('SELECT benchmark_status, percentile_rank, relative_position, cohort_size, distinct_owner_count, cohort_average, cohort_median, crop_key, medium, cultivation_type FROM agro_intelligence_benchmark WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [t.owner, t.device, t.context]);
    return r && r.length ? r[0] : null;
}
async function loadHealth(t) {
    const r = await safeRows('SELECT health_score, health_band, recommended_focus, stress_load_score, maturity_level, confidence FROM agro_greenhouse_health_profile WHERE owner_user_id = ? AND device_id = ? AND context_id = ?', [t.owner, t.device, t.context]);
    return r && r.length ? r[0] : null;
}
// privacy: espone il benchmark SOLO se sopra soglia (status ok); altrimenti nessun dettaglio coorte
function publicBenchmark(b) {
    if (!b) { return { available: false, benchmark_status: 'unavailable' }; }
    if (b.benchmark_status !== 'ok') { return { available: false, benchmark_status: b.benchmark_status }; }
    return {
        available: true, benchmark_status: 'ok', percentile_rank: b.percentile_rank, relative_position: b.relative_position,
        cohort_size: b.cohort_size, distinct_owner_count: b.distinct_owner_count, cohort_average: b.cohort_average,
        cohort_median: b.cohort_median, crop_key: b.crop_key, medium: b.medium, cultivation_type: b.cultivation_type
    };
}

router.get('/score', wrap(async (req, res) => {
    const t = await resolveTarget(req); const s = await loadScore(t);
    res.json(s ? { available: true, ...s } : { available: false, message: 'Punteggio non ancora disponibile per questo contesto.' });
}));

router.get('/subscores', wrap(async (req, res) => {
    const t = await resolveTarget(req); const s = await loadSub(t);
    res.json(s ? { available: true, ...s } : { available: false, message: 'Sotto-punteggi non ancora disponibili.' });
}));

router.get('/trend', wrap(async (req, res) => {
    const t = await resolveTarget(req); const tr = await loadTrends(t);
    res.json({ available: tr.length > 0, trends: tr });
}));

router.get('/benchmark', wrap(async (req, res) => {
    const t = await resolveTarget(req); res.json(publicBenchmark(await loadBenchmark(t)));
}));

router.get('/health', wrap(async (req, res) => {
    const t = await resolveTarget(req); const h = await loadHealth(t);
    res.json(h ? {
        available: true, health_score: h.health_score, health_band: h.health_band,
        recommended_focus: h.recommended_focus, maturity_level: h.maturity_level, confidence: h.confidence,
        link: `/api/intelligence/explanation?device_id=${t.device}&context_id=${t.context}`
    } : { available: false, message: 'Profilo di salute non ancora disponibile.' });
}));

router.get('/explanation', wrap(async (req, res) => {
    const t = await resolveTarget(req); const ex = await generateExplanation(t.owner, t.device, t.context);
    res.json({ available: Boolean(ex.evidence_json && ex.evidence_json.available), ...ex });
}));

// combinato per la card dashboard (1 chiamata)
router.get('/overview', wrap(async (req, res) => {
    const t = await resolveTarget(req);
    const [score, sub, trends, bench, health] = [await loadScore(t), await loadSub(t), await loadTrends(t), await loadBenchmark(t), await loadHealth(t)];
    const explanation = await generateExplanation(t.owner, t.device, t.context);
    const headTrend = trends.find((x) => x.metric === 'intelligence_score') || null;
    res.json({
        available: Boolean(score),
        device_id: t.device, context_id: t.context,
        score: score ? { value: score.intelligence_score, band: score.intelligence_band, confidence: score.confidence, maturity_level: score.maturity_level } : null,
        subscores: sub || null,
        trend: headTrend ? { direction: headTrend.trend_direction, strength: headTrend.trend_strength, sample_count: headTrend.sample_count } : { direction: 'insufficient_data' },
        benchmark: publicBenchmark(bench),
        health: health ? { health_score: health.health_score, health_band: health.health_band, recommended_focus: health.recommended_focus } : null,
        explanation
    });
}));

module.exports = router;
