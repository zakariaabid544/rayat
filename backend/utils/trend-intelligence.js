// Rayat Intelligence — Sprint 4.3 · Trend Intelligence Engine (additivo, LIVE/local-only)
// Calcola i trend temporali (per metrica) di intelligence_score + 5 sub-score per owner+device+context.
// Sorgenti READ-ONLY: agro_intelligence_score (4.2) + agro_intelligence_subscores (4.1).
// Per avere una serie storica (le 2 tabelle score sono single-row/upsert) il motore mantiene una PROPRIA
// tabella snapshot append-only (agro_intelligence_score_history), popolata SOLO dalle 2 sorgenti, 1 riga/giorno.
// Local-only, no fleet, tenant+context safe, deterministico, idempotente, fail-closed.
// Scrive SOLO le proprie 2 tabelle (history + trends). Non tocca Sprint 1/2/3/4.1/4.2.
'use strict';
const { query } = require('../config/database');
const C = require('./intelligence-common');
const { assertLocalIdentity } = require('./intelligence-tenancy');

const RULE_VERSION = 's4.3';
// metriche di trend: intelligence_score (da score) + 5 sub-score (da subscores). Tutte higher=better.
const METRICS = ['intelligence_score', 'stability', 'stress', 'recovery', 'resilience', 'maturity'];
const METRIC_COL = {
    intelligence_score: 'intelligence_score', stability: 'stability_score', stress: 'stress_score',
    recovery: 'recovery_score', resilience: 'resilience_score', maturity: 'maturity_score'
};
const DIRECTIONS = ['improving', 'stable', 'degrading', 'volatile', 'insufficient_data'];

const WINDOW_DAYS = Number(process.env.AGRO_TREND_WINDOW_DAYS || 30);
const MIN_SAMPLES = Number(process.env.AGRO_TREND_MIN_SAMPLES || 3);   // sotto -> insufficient_data
const TREND_T = Number(process.env.AGRO_TREND_DELTA_POINTS || 4);      // variazione modellata sulla finestra (punti)
const VOL_ABS = Number(process.env.AGRO_TREND_VOL_ABS || 8);           // stdev delta consecutivi (punti)
const VOL_DOM = Number(process.env.AGRO_TREND_VOL_DOMINANCE || 1.2);   // oscillazione domina la direzione
const GOOD_SAMPLES = Number(process.env.AGRO_TREND_GOOD_SAMPLES || 8);
const STRENGTH_REF = Number(process.env.AGRO_TREND_STRENGTH_REF || 40);

// ---- pure: classificazione trend da una serie [{x:giorni, v:0-100}] (ordinata per x) ----
function classifyTrend(series) {
    const pts = (series || []).filter((p) => C.isFiniteNumber(p.x) && C.isFiniteNumber(p.v)).sort((a, b) => a.x - b.x);
    const n = pts.length;
    const sampleFactor = C.clamp01((n - (MIN_SAMPLES - 1)) / Math.max(1, GOOD_SAMPLES - (MIN_SAMPLES - 1)));
    if (n < MIN_SAMPLES) {
        return { trend_direction: 'insufficient_data', trend_strength: 0, trend_confidence: C.round3(C.clamp01(0.2 * sampleFactor)),
            trend_window_days: n ? Math.round(pts[n - 1].x - pts[0].x) : 0, sample_count: n, slope_per_day: 0,
            factors: { reason: 'min_samples', min_samples: MIN_SAMPLES } };
    }
    const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.v);
    const xbar = C.mean(xs); const ybar = C.mean(ys);
    let sxx = 0; let sxy = 0;
    for (let i = 0; i < n; i += 1) { const dx = xs[i] - xbar; sxx += dx * dx; sxy += dx * (ys[i] - ybar); }
    const windowDays = xs[n - 1] - xs[0];
    if (sxx <= 0 || windowDays <= 0) {
        return { trend_direction: 'insufficient_data', trend_strength: 0, trend_confidence: C.round3(C.clamp01(0.2 * sampleFactor)),
            trend_window_days: 0, sample_count: n, slope_per_day: 0, factors: { reason: 'degenerate_time_axis' } };
    }
    const slope = sxy / sxx; // punti/giorno
    let ssRes = 0; let ssTot = 0;
    for (let i = 0; i < n; i += 1) { const pred = ybar + slope * (xs[i] - xbar); ssRes += (ys[i] - pred) ** 2; ssTot += (ys[i] - ybar) ** 2; }
    const r2 = ssTot > 0 ? C.clamp01(1 - ssRes / ssTot) : (ssRes === 0 ? 1 : 0);
    const modeled = slope * windowDays; // variazione modellata sull'intera finestra
    const deltas = []; for (let i = 1; i < n; i += 1) { deltas.push(ys[i] - ys[i - 1]); }
    const vol = C.stdev(deltas);
    const netChange = ys[n - 1] - ys[0];

    let direction; let strength; let fit;
    if (vol >= VOL_ABS && Math.abs(modeled) <= VOL_DOM * vol) {
        direction = 'volatile'; strength = C.clamp01(vol / 25); fit = C.clamp01(vol / 20);
    } else if (modeled >= TREND_T) {
        direction = 'improving'; strength = C.clamp01(Math.abs(modeled) / STRENGTH_REF); fit = r2;
    } else if (modeled <= -TREND_T) {
        direction = 'degrading'; strength = C.clamp01(Math.abs(modeled) / STRENGTH_REF); fit = r2;
    } else {
        direction = 'stable'; strength = C.clamp01(Math.abs(modeled) / STRENGTH_REF); fit = r2;
    }
    const confidence = C.clamp01(0.4 * sampleFactor + 0.6 * fit);
    return {
        trend_direction: direction, trend_strength: C.round3(strength), trend_confidence: C.round3(confidence),
        trend_window_days: Math.round(windowDays), sample_count: n, slope_per_day: C.round3(slope),
        factors: { r2: C.round3(r2), volatility: C.round1(vol), modeled_change: C.round1(modeled), net_change: C.round1(netChange),
            first: C.round1(ys[0]), last: C.round1(ys[n - 1]) }
    };
}

async function ensureTrendSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_intelligence_score_history (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           captured_on DATE NOT NULL,
           intelligence_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           stability_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           stress_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           recovery_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           resilience_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           maturity_score NUMERIC(6,2) NOT NULL DEFAULT 0,
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_score_history UNIQUE (owner_user_id, device_id, context_id, captured_on),
           CONSTRAINT chk_score_history_ranges CHECK (
             intelligence_score BETWEEN 0 AND 100 AND stability_score BETWEEN 0 AND 100 AND stress_score BETWEEN 0 AND 100
             AND recovery_score BETWEEN 0 AND 100 AND resilience_score BETWEEN 0 AND 100 AND maturity_score BETWEEN 0 AND 100)
         )`
    );
    await query(
        `CREATE TABLE IF NOT EXISTS agro_intelligence_trends (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           metric VARCHAR(24) NOT NULL,
           trend_direction VARCHAR(20) NOT NULL DEFAULT 'insufficient_data',
           trend_strength NUMERIC(5,4) NOT NULL DEFAULT 0,
           trend_confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           trend_window_days INTEGER NOT NULL DEFAULT 0,
           sample_count INTEGER NOT NULL DEFAULT 0,
           slope_per_day NUMERIC(10,5) NOT NULL DEFAULT 0,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's4.3',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_intelligence_trends UNIQUE (owner_user_id, device_id, context_id, metric),
           CONSTRAINT chk_trends_values CHECK (
             trend_direction IN ('improving','stable','degrading','volatile','insufficient_data')
             AND trend_strength BETWEEN 0 AND 1 AND trend_confidence BETWEEN 0 AND 1
             AND trend_window_days >= 0 AND sample_count >= 0
             AND metric IN ('intelligence_score','stability','stress','recovery','resilience','maturity'))
         )`
    );
    await query(
        `CREATE OR REPLACE FUNCTION rayat_assert_trend_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; ctx_owner INTEGER; ctx_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'trend-intelligence identity cannot be NULL'; END IF;
           SELECT COALESCE(u.owner_user_id, u.id) INTO expected_owner FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id INTO ctx_owner, ctx_device FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN RAISE EXCEPTION 'trend-intelligence owner does not own device'; END IF;
           IF ctx_owner IS NULL OR ctx_owner IS DISTINCT FROM NEW.owner_user_id OR ctx_device IS DISTINCT FROM NEW.device_id THEN RAISE EXCEPTION 'trend-intelligence context mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    for (const t of ['agro_intelligence_score_history', 'agro_intelligence_trends']) {
        await query(`DROP TRIGGER IF EXISTS trg_assert_${t} ON ${t}`);
        await query(`CREATE TRIGGER trg_assert_${t} BEFORE INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION rayat_assert_trend_identity()`);
    }
    await query('CREATE INDEX IF NOT EXISTS idx_is_hist_part ON agro_intelligence_score_history (owner_user_id, device_id, context_id, captured_on)');
    await query('CREATE INDEX IF NOT EXISTS idx_is_trends_dir ON agro_intelligence_trends (trend_direction)');
}

// Snapshot append-only (1 riga/giorno) dalle sorgenti score. Default SOLO production; includeNonProduction abilita demo/test. Idempotente per (partizione, giorno).
async function snapshotScores(capturedOn = null, includeNonProduction = false) {
    const prodClause = includeNonProduction ? '' : 'AND c.is_production = TRUE';
    const res = await query(
        `INSERT INTO agro_intelligence_score_history
            (owner_user_id, device_id, context_id, captured_on, intelligence_score, stability_score, stress_score, recovery_score, resilience_score, maturity_score, created_at)
         SELECT s.owner_user_id, s.device_id, s.context_id, COALESCE(CAST(? AS DATE), CURRENT_DATE),
                s.intelligence_score, sub.stability_score, sub.stress_score, sub.recovery_score, sub.resilience_score, sub.maturity_score, NOW()
         FROM agro_intelligence_score s
         JOIN agro_intelligence_subscores sub ON sub.owner_user_id = s.owner_user_id AND sub.device_id = s.device_id AND sub.context_id = s.context_id
         JOIN agro_context_segments c ON c.id = s.context_id ${prodClause}
         ON CONFLICT (owner_user_id, device_id, context_id, captured_on) DO UPDATE SET
            intelligence_score = EXCLUDED.intelligence_score, stability_score = EXCLUDED.stability_score, stress_score = EXCLUDED.stress_score,
            recovery_score = EXCLUDED.recovery_score, resilience_score = EXCLUDED.resilience_score, maturity_score = EXCLUDED.maturity_score`,
        [capturedOn]
    );
    return res.affectedRows || 0;
}

// Carica le serie storiche per partizione, entro la finestra. Default SOLO production; includeNonProduction abilita demo/test.
async function loadHistorySeries(windowDays, includeNonProduction = false) {
    const prodClause = includeNonProduction ? '' : 'AND c.is_production = TRUE';
    const rows = await query(
        `SELECT h.owner_user_id, h.device_id, h.context_id, h.captured_on,
                h.intelligence_score, h.stability_score, h.stress_score, h.recovery_score, h.resilience_score, h.maturity_score
         FROM agro_intelligence_score_history h
         JOIN agro_context_segments c ON c.id = h.context_id ${prodClause}
         WHERE h.captured_on >= (CURRENT_DATE - CAST(? AS INTEGER))
         ORDER BY h.owner_user_id, h.device_id, h.context_id, h.captured_on`,
        [windowDays]
    );
    const key = (r) => `${r.owner_user_id}|${r.device_id}|${r.context_id}`;
    const map = new Map();
    for (const r of rows) {
        const k = key(r);
        if (!map.has(k)) { map.set(k, { owner_user_id: r.owner_user_id, device_id: r.device_id, context_id: r.context_id, samples: [] }); }
        const dayX = Math.round(new Date(r.captured_on).getTime() / C.DAY_MS);
        map.get(k).samples.push({
            x: dayX,
            intelligence_score: C.num(r.intelligence_score), stability: C.num(r.stability_score), stress: C.num(r.stress_score),
            recovery: C.num(r.recovery_score), resilience: C.num(r.resilience_score), maturity: C.num(r.maturity_score)
        });
    }
    return [...map.values()];
}

async function upsertTrend(g, metric, t) {
    await query(
        `INSERT INTO agro_intelligence_trends
            (owner_user_id, device_id, context_id, metric, trend_direction, trend_strength, trend_confidence,
             trend_window_days, sample_count, slope_per_day, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, metric) DO UPDATE SET
            trend_direction = EXCLUDED.trend_direction, trend_strength = EXCLUDED.trend_strength, trend_confidence = EXCLUDED.trend_confidence,
            trend_window_days = EXCLUDED.trend_window_days, sample_count = EXCLUDED.sample_count, slope_per_day = EXCLUDED.slope_per_day,
            evidence_json = EXCLUDED.evidence_json, updated_at = NOW()
         RETURNING id`,
        [g.owner_user_id, g.device_id, g.context_id, metric, t.trend_direction, t.trend_strength, t.trend_confidence,
         t.trend_window_days, t.sample_count, t.slope_per_day,
         JSON.stringify({ metric, window_days: t.trend_window_days, sample_count: t.sample_count, slope_per_day: t.slope_per_day, factors: t.factors }),
         RULE_VERSION]
    );
}

async function runTrendIntelligence({ dryRun = false, windowDays = WINDOW_DAYS, capturedOn = null, includeNonProduction = false } = {}) {
    const summary = { contexts: 0, trends_stored: 0, snapshots: 0, by_direction: {}, dry_run: dryRun, include_non_production: includeNonProduction };
    if (!dryRun) { summary.snapshots = await snapshotScores(capturedOn, includeNonProduction); }
    const groups = await loadHistorySeries(windowDays, includeNonProduction);
    summary.contexts = groups.length;
    const rows = [];
    for (const g of groups) {
        assertLocalIdentity({ ownerUserId: g.owner_user_id, deviceId: g.device_id, context: 'trend-intelligence' }); // fail-closed
        for (const metric of METRICS) {
            const series = g.samples.map((s) => ({ x: s.x, v: s[metric] }));
            const t = classifyTrend(series);
            summary.by_direction[t.trend_direction] = (summary.by_direction[t.trend_direction] || 0) + 1;
            rows.push({ key: { owner_user_id: g.owner_user_id, device_id: g.device_id, context_id: g.context_id, metric }, trend: t });
            if (!dryRun) { await upsertTrend(g, metric, t); summary.trends_stored += 1; }
        }
    }
    return dryRun ? { ...summary, rows } : summary;
}

module.exports = {
    ensureTrendSchema, runTrendIntelligence, snapshotScores, loadHistorySeries, classifyTrend,
    METRICS, DIRECTIONS, RULE_VERSION
};
