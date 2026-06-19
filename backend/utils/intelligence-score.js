// Rayat Intelligence — Sprint 4.1/4.2 · Intelligence Score Engine (additivo, LIVE/local-only)
// 4.1 Sub-Score Engine: 6 sub-score 0-100 (higher=better) per owner+device+context, dalle memorie Sprint 3.
// 4.2 Aggregation Engine: intelligence_score 0-100 + band, aggregazione pesata dei sub-score.
// Local-only, no fleet, tenant+context safe, deterministico, idempotente, fail-closed.
// Sorgenti READ-ONLY: agro_greenhouse_baselines/stress_memory/recovery_memory (+ contesti). Scrive SOLO le 2 tabelle score.
'use strict';
const { query } = require('../config/database');
const C = require('./intelligence-common');
const { assertLocalIdentity } = require('./intelligence-tenancy');

const RULE_VERSION = 's4.2';
const W = { // pesi aggregazione (somma 1.0)
    stability: Number(process.env.AGRO_IS_W_STABILITY || 0.20),
    stress: Number(process.env.AGRO_IS_W_STRESS || 0.20),
    recovery: Number(process.env.AGRO_IS_W_RECOVERY || 0.20),
    resilience: Number(process.env.AGRO_IS_W_RESILIENCE || 0.15),
    data_quality: Number(process.env.AGRO_IS_W_DQ || 0.10),
    maturity: Number(process.env.AGRO_IS_W_MATURITY || 0.15)
};
const MIN_CONF_BAND = Number(process.env.AGRO_IS_MIN_CONF_BAND || 0.2);

function maturityToScore(level) { return ({ mature: 100, stable: 75, learning: 50, cold_start: 25 })[level] || 25; }
function scoreToMaturity(s) { if (s >= 88) { return 'mature'; } if (s >= 63) { return 'stable'; } if (s >= 38) { return 'learning'; } return 'cold_start'; }
function scoreToBand(score, confidence) {
    if (confidence < MIN_CONF_BAND) { return 'unknown'; }
    if (score >= 85) { return 'excellent'; }
    if (score >= 70) { return 'good'; }
    if (score >= 50) { return 'attention'; }
    if (score >= 30) { return 'risk'; }
    return 'critical';
}

// ---- pure: 6 sub-score 0-100 (higher=better) ----
function computeSubscores(agg) {
    const b = agg.baseline; const st = agg.stress; const rc = agg.recovery;
    const stability = C.clamp01(b ? b.avg_stability : 0) * 100;
    const dataQuality = C.clamp01(b ? b.avg_dq : 0) * 100;
    const maturityScore = b ? b.avg_maturity_pts : 25;
    // stress: nessuno stress osservato = migliore (100); altrimenti 100 - carico medio (0-100, higher=worse)
    const stress = st ? C.clamp01(1 - (st.avg_load / 100)) * 100 : 100;
    // recovery: qualita+stabilita+veloci-recuperi - ricadute; assente -> neutro 50 (con bassa confidence)
    const recovery = rc
        ? C.clamp01(0.5 * rc.q + 0.25 * rc.st + 0.15 * rc.fast + 0.1 * (1 - rc.rel)) * 100
        : 50;
    // resilienza: capacita di recuperare con basso stress
    const resilience = C.clamp01(0.6 * (recovery / 100) + 0.4 * (stress / 100)) * 100;
    const confs = [b && b.avg_conf, st && st.avg_conf, rc && rc.avg_conf].filter((x) => typeof x === 'number');
    const confidence = confs.length ? C.clamp01(C.mean(confs)) : 0;
    return {
        stability_score: C.round1(stability), stress_score: C.round1(stress), recovery_score: C.round1(recovery),
        resilience_score: C.round1(resilience), data_quality_score: C.round1(dataQuality), maturity_score: C.round1(maturityScore),
        confidence: C.round3(confidence), maturity_level: scoreToMaturity(maturityScore),
        factors: { has_stress: !!st, has_recovery: !!rc, stress_load_avg: st ? C.round1(st.avg_load) : 0, recovery_quality_avg: rc ? C.round3(rc.q) : null, relapse_avg: rc ? C.round3(rc.rel) : null }
    };
}

// ---- pure: aggregazione intelligence_score 0-100 ----
function aggregateScore(sub) {
    const s = W.stability * sub.stability_score + W.stress * sub.stress_score + W.recovery * sub.recovery_score
        + W.resilience * sub.resilience_score + W.data_quality * sub.data_quality_score + W.maturity * sub.maturity_score;
    const intelligence_score = Math.round(Math.max(0, Math.min(100, s)));
    const band = scoreToBand(intelligence_score, sub.confidence);
    return {
        intelligence_score, intelligence_band: band, confidence: sub.confidence, maturity_level: sub.maturity_level,
        factors: { weights: W, subscores: { stability: sub.stability_score, stress: sub.stress_score, recovery: sub.recovery_score, resilience: sub.resilience_score, data_quality: sub.data_quality_score, maturity: sub.maturity_score } }
    };
}

async function ensureScoreSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_intelligence_subscores (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           stability_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           stress_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           recovery_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           resilience_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           data_quality_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           maturity_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           maturity_level VARCHAR(12) NOT NULL DEFAULT 'cold_start',
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's4.1',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_intelligence_subscores UNIQUE (owner_user_id, device_id, context_id),
           CONSTRAINT chk_subscores_ranges CHECK (
             stability_score BETWEEN 0 AND 100 AND stress_score BETWEEN 0 AND 100 AND recovery_score BETWEEN 0 AND 100
             AND resilience_score BETWEEN 0 AND 100 AND data_quality_score BETWEEN 0 AND 100 AND maturity_score BETWEEN 0 AND 100
             AND confidence BETWEEN 0 AND 1 AND maturity_level IN ('cold_start','learning','stable','mature'))
         )`
    );
    await query(
        `CREATE TABLE IF NOT EXISTS agro_intelligence_score (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           intelligence_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           intelligence_band VARCHAR(12) NOT NULL DEFAULT 'unknown',
           confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           maturity_level VARCHAR(12) NOT NULL DEFAULT 'cold_start',
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's4.2',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_intelligence_score UNIQUE (owner_user_id, device_id, context_id),
           CONSTRAINT chk_intelligence_score_range CHECK (
             intelligence_score BETWEEN 0 AND 100 AND confidence BETWEEN 0 AND 1
             AND intelligence_band IN ('excellent','good','attention','risk','critical','unknown')
             AND maturity_level IN ('cold_start','learning','stable','mature'))
         )`
    );
    // trigger identita (owner possiede device; context appartiene a owner/device) - fail-closed a DB
    await query(
        `CREATE OR REPLACE FUNCTION rayat_assert_score_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; ctx_owner INTEGER; ctx_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'intelligence-score identity cannot be NULL'; END IF;
           SELECT COALESCE(u.owner_user_id, u.id) INTO expected_owner FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id INTO ctx_owner, ctx_device FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN RAISE EXCEPTION 'intelligence-score owner does not own device'; END IF;
           IF ctx_owner IS NULL OR ctx_owner IS DISTINCT FROM NEW.owner_user_id OR ctx_device IS DISTINCT FROM NEW.device_id THEN RAISE EXCEPTION 'intelligence-score context mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    for (const t of ['agro_intelligence_subscores', 'agro_intelligence_score']) {
        await query(`DROP TRIGGER IF EXISTS trg_assert_${t} ON ${t}`);
        await query(`CREATE TRIGGER trg_assert_${t} BEFORE INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION rayat_assert_score_identity()`);
    }
    await query('CREATE INDEX IF NOT EXISTS idx_is_sub_owner ON agro_intelligence_subscores (owner_user_id, device_id, context_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_is_score_band ON agro_intelligence_score (intelligence_band)');
}

// Aggregati per (owner,device,context) SOLO da contesti production (fail-closed: niente contesti invalidi/non-production).
async function loadSourceAggregates() {
    const baseline = await query(
        `SELECT b.owner_user_id, b.device_id, b.context_id,
                avg(b.data_quality_score) AS avg_dq, avg(b.confidence) AS avg_conf,
                avg(CASE WHEN b.mean_value IS NULL OR b.mean_value = 0 THEN 0.5
                         ELSE GREATEST(0, 1 - LEAST(1, abs(b.stddev_value) / abs(b.mean_value))) END) AS avg_stability,
                avg(CASE b.maturity_level WHEN 'mature' THEN 100 WHEN 'stable' THEN 75 WHEN 'learning' THEN 50 ELSE 25 END) AS avg_maturity_pts
         FROM agro_greenhouse_baselines b
         JOIN agro_context_segments c ON c.id = b.context_id AND c.is_production = TRUE
         GROUP BY b.owner_user_id, b.device_id, b.context_id`
    );
    const stress = await query(
        `SELECT sm.owner_user_id, sm.device_id, sm.context_id, sum(sm.stress_count) AS total_stress,
                avg(sm.stress_load_score) AS avg_load, avg(sm.confidence) AS avg_conf
         FROM agro_stress_memory sm
         JOIN agro_context_segments c ON c.id = sm.context_id AND c.is_production = TRUE
         GROUP BY sm.owner_user_id, sm.device_id, sm.context_id`
    );
    const recovery = await query(
        `SELECT rm.owner_user_id, rm.device_id, rm.context_id,
                avg(rm.recovery_quality_score) AS q, avg(rm.recovery_stability_score) AS st,
                avg(rm.fast_recovery_rate) AS fast, avg(rm.relapse_rate) AS rel, avg(rm.confidence) AS avg_conf
         FROM agro_recovery_memory rm
         JOIN agro_context_segments c ON c.id = rm.context_id AND c.is_production = TRUE
         GROUP BY rm.owner_user_id, rm.device_id, rm.context_id`
    );
    const key = (r) => `${r.owner_user_id}|${r.device_id}|${r.context_id}`;
    const map = new Map();
    for (const r of baseline) {
        map.set(key(r), { owner_user_id: r.owner_user_id, device_id: r.device_id, context_id: r.context_id,
            baseline: { avg_dq: C.num(r.avg_dq) || 0, avg_conf: C.num(r.avg_conf) || 0, avg_stability: C.num(r.avg_stability) || 0, avg_maturity_pts: C.num(r.avg_maturity_pts) || 25 } });
    }
    for (const r of stress) { const g = map.get(key(r)); if (g) { g.stress = { total: Number(r.total_stress), avg_load: C.num(r.avg_load) || 0, avg_conf: C.num(r.avg_conf) || 0 }; } }
    for (const r of recovery) { const g = map.get(key(r)); if (g) { g.recovery = { q: C.num(r.q) || 0, st: C.num(r.st) || 0, fast: C.num(r.fast) || 0, rel: C.num(r.rel) || 0, avg_conf: C.num(r.avg_conf) || 0 }; } }
    return [...map.values()];
}

async function upsertSubscores(g, sub) {
    await query(
        `INSERT INTO agro_intelligence_subscores
            (owner_user_id, device_id, context_id, stability_score, stress_score, recovery_score, resilience_score,
             data_quality_score, maturity_score, confidence, maturity_level, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), 's4.1', NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id) DO UPDATE SET
            stability_score=EXCLUDED.stability_score, stress_score=EXCLUDED.stress_score, recovery_score=EXCLUDED.recovery_score,
            resilience_score=EXCLUDED.resilience_score, data_quality_score=EXCLUDED.data_quality_score, maturity_score=EXCLUDED.maturity_score,
            confidence=EXCLUDED.confidence, maturity_level=EXCLUDED.maturity_level, evidence_json=EXCLUDED.evidence_json, updated_at=NOW()
         RETURNING id`,
        [g.owner_user_id, g.device_id, g.context_id, sub.stability_score, sub.stress_score, sub.recovery_score, sub.resilience_score,
         sub.data_quality_score, sub.maturity_score, sub.confidence, sub.maturity_level, JSON.stringify({ subscores: sub, factors: sub.factors })]
    );
}

async function upsertScore(g, sub, agg) {
    await query(
        `INSERT INTO agro_intelligence_score
            (owner_user_id, device_id, context_id, intelligence_score, intelligence_band, confidence, maturity_level, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id) DO UPDATE SET
            intelligence_score=EXCLUDED.intelligence_score, intelligence_band=EXCLUDED.intelligence_band,
            confidence=EXCLUDED.confidence, maturity_level=EXCLUDED.maturity_level, evidence_json=EXCLUDED.evidence_json, updated_at=NOW()
         RETURNING id`,
        [g.owner_user_id, g.device_id, g.context_id, agg.intelligence_score, agg.intelligence_band, agg.confidence, agg.maturity_level,
         JSON.stringify(agg.factors), RULE_VERSION]
    );
}

async function runIntelligenceScore({ dryRun = false } = {}) {
    const summary = { contexts: 0, subscores_stored: 0, scores_stored: 0, by_band: {}, dry_run: dryRun };
    const groups = await loadSourceAggregates();
    summary.contexts = groups.length;
    const rows = [];
    for (const g of groups) {
        assertLocalIdentity({ ownerUserId: g.owner_user_id, deviceId: g.device_id, context: 'intelligence-score' }); // fail-closed
        const sub = computeSubscores(g);
        const agg = aggregateScore(sub);
        summary.by_band[agg.intelligence_band] = (summary.by_band[agg.intelligence_band] || 0) + 1;
        rows.push({ key: { owner_user_id: g.owner_user_id, device_id: g.device_id, context_id: g.context_id }, sub, agg });
        if (!dryRun) { await upsertSubscores(g, sub); summary.subscores_stored += 1; await upsertScore(g, sub, agg); summary.scores_stored += 1; }
    }
    return dryRun ? { ...summary, rows } : summary;
}

module.exports = { ensureScoreSchema, runIntelligenceScore, computeSubscores, aggregateScore, scoreToBand, maturityToScore, W, RULE_VERSION };
