// Rayat Intelligence — Sprint 4.4 · Benchmarking Engine (additivo, local subject / anonymous cohort)
// Posiziona ogni greenhouse (owner+device+context) rispetto a una COORTE anonima con stessa coltura+medium+tipo.
// Sorgente READ-ONLY: agro_intelligence_score (4.2) + agro_context_segments (solo production).
// Privacy: SOLO aggregati nella coorte (mai owner/device/greenhouse/event id). Anonimato: >=3 owner distinti.
// Fail-closed sotto soglia (insufficient_population). Tenant+context safe, deterministico, idempotente.
// Scrive SOLO agro_intelligence_benchmark. Non tocca Sprint 1/2/3/4.1/4.2/4.3.
'use strict';
const { query } = require('../config/database');
const C = require('./intelligence-common');
const { assertLocalIdentity, fleetSafeEvidence } = require('./intelligence-tenancy');

const RULE_VERSION = 's4.4';
const MIN_OWNERS = Number(process.env.AGRO_BENCHMARK_MIN_OWNERS || 3); // soglia anonimato/partecipazione
const STATUSES = ['ok', 'insufficient_population', 'unscoped'];
const POSITIONS = ['top_quartile', 'above_median', 'below_median', 'bottom_quartile', 'unknown'];
// chiavi vietate nell'evidence (privacy aggregate-only)
const FORBIDDEN_EVIDENCE_KEYS = ['owner_user_id', 'device_id', 'greenhouse_id', 'greenhouse_ids',
    'owner_ids', 'device_ids', 'member_ids', 'context_ids', 'event_ids', 'supporting_event_ids'];

// ---- pure ----
function percentileRank(scores, s) {
    if (!scores.length || !C.isFiniteNumber(s)) { return null; }
    let lt = 0; let eq = 0;
    for (const x of scores) { if (x < s) { lt += 1; } else if (x === s) { eq += 1; } }
    return C.clamp01((lt + 0.5 * eq) / scores.length) * 100;
}
function relativePosition(pr) {
    if (pr === null || !C.isFiniteNumber(pr)) { return 'unknown'; }
    if (pr >= 75) { return 'top_quartile'; }
    if (pr >= 50) { return 'above_median'; }
    if (pr >= 25) { return 'below_median'; }
    return 'bottom_quartile';
}

// members: [{owner_user_id, device_id, context_id, score}] della stessa coorte. cohort: {crop_key, medium, cultivation_type}
function computeCohort(members, cohort) {
    const size = members.length;
    const distinctOwners = new Set(members.map((m) => m.owner_user_id)).size;
    const baseRow = (m, extra) => ({
        key: { owner_user_id: m.owner_user_id, device_id: m.device_id, context_id: m.context_id },
        cohort_key: `${cohort.crop_key}|${cohort.medium}|${cohort.cultivation_type}`,
        crop_key: cohort.crop_key, medium: cohort.medium, cultivation_type: cohort.cultivation_type,
        subject_score: C.round1(m.score), cohort_size: size, distinct_owner_count: distinctOwners,
        ...extra
    });
    if (distinctOwners < MIN_OWNERS) {
        // Fail-closed: anonimato non garantito -> nessun benchmark prodotto.
        return {
            status: 'insufficient_population', stats: null, distinct_owner_count: distinctOwners, cohort_size: size,
            results: members.map((m) => baseRow(m, {
                benchmark_status: 'insufficient_population', percentile_rank: null,
                cohort_average: null, cohort_median: null, cohort_top_quartile: null, cohort_bottom_quartile: null,
                relative_position: 'unknown', benchmark_confidence: 0,
                evidence: fleetSafeEvidence('fleet', {
                    method: 'within_cohort_percentile', cohort: { crop_key: cohort.crop_key, medium: cohort.medium, cultivation_type: cohort.cultivation_type },
                    cohort_size: size, distinct_owner_count: distinctOwners, min_owners: MIN_OWNERS, suppressed: true, reason: 'anonymity_threshold_not_met'
                })
            }))
        };
    }
    const scores = members.map((m) => m.score).filter(C.isFiniteNumber);
    const average = C.round1(C.mean(scores));
    const med = C.round1(C.median(scores));
    const p75 = C.round1(C.percentile(scores, 75));
    const p25 = C.round1(C.percentile(scores, 25));
    const lo = C.round1(Math.min(...scores));
    const hi = C.round1(Math.max(...scores));
    const ownerFactor = C.clamp01((distinctOwners - MIN_OWNERS + 1) / 5);
    const sizeFactor = C.clamp01(size / 10);
    const confidence = C.round3(C.clamp01(0.6 * ownerFactor + 0.4 * sizeFactor));
    return {
        status: 'ok', distinct_owner_count: distinctOwners, cohort_size: size,
        stats: { average, median: med, top_quartile: p75, bottom_quartile: p25, min: lo, max: hi },
        results: members.map((m) => {
            const pr = percentileRank(scores, m.score);
            const rel = relativePosition(pr);
            return baseRow(m, {
                benchmark_status: 'ok', percentile_rank: C.round1(pr),
                cohort_average: average, cohort_median: med, cohort_top_quartile: p75, cohort_bottom_quartile: p25,
                relative_position: rel, benchmark_confidence: confidence,
                evidence: fleetSafeEvidence('fleet', {
                    method: 'within_cohort_percentile',
                    cohort: { crop_key: cohort.crop_key, medium: cohort.medium, cultivation_type: cohort.cultivation_type },
                    cohort_size: size, distinct_owner_count: distinctOwners, min_owners: MIN_OWNERS,
                    stats: { average, median: med, top_quartile: p75, bottom_quartile: p25, min: lo, max: hi },
                    subject: { score: C.round1(m.score), percentile_rank: C.round1(pr), relative_position: rel }
                })
            });
        })
    };
}

async function ensureBenchmarkSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_intelligence_benchmark (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           cohort_key VARCHAR(160) NOT NULL,
           crop_key VARCHAR(80) NULL,
           medium VARCHAR(40) NULL,
           cultivation_type VARCHAR(20) NULL,
           benchmark_status VARCHAR(24) NOT NULL DEFAULT 'insufficient_population',
           percentile_rank NUMERIC(5,2) NULL,
           cohort_average NUMERIC(6,2) NULL,
           cohort_median NUMERIC(6,2) NULL,
           cohort_top_quartile NUMERIC(6,2) NULL,
           cohort_bottom_quartile NUMERIC(6,2) NULL,
           relative_position VARCHAR(20) NOT NULL DEFAULT 'unknown',
           benchmark_confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
           cohort_size INTEGER NOT NULL DEFAULT 0,
           distinct_owner_count INTEGER NOT NULL DEFAULT 0,
           subject_score NUMERIC(6,2) NULL,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's4.4',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_intelligence_benchmark UNIQUE (owner_user_id, device_id, context_id),
           CONSTRAINT chk_benchmark_values CHECK (
             benchmark_status IN ('ok','insufficient_population','unscoped')
             AND relative_position IN ('top_quartile','above_median','below_median','bottom_quartile','unknown')
             AND (percentile_rank IS NULL OR percentile_rank BETWEEN 0 AND 100)
             AND benchmark_confidence BETWEEN 0 AND 1
             AND cohort_size >= 0 AND distinct_owner_count >= 0),
           CONSTRAINT chk_benchmark_privacy CHECK (
             NOT jsonb_exists_any(evidence_json, ARRAY['owner_user_id','device_id','greenhouse_id','greenhouse_ids','owner_ids','device_ids','member_ids','context_ids','event_ids','supporting_event_ids']))
         )`
    );
    await query(
        `CREATE OR REPLACE FUNCTION rayat_assert_bench_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; ctx_owner INTEGER; ctx_device INTEGER;
         BEGIN
           IF NEW.owner_user_id IS NULL OR NEW.device_id IS NULL OR NEW.context_id IS NULL THEN
             RAISE EXCEPTION 'benchmark identity cannot be NULL'; END IF;
           SELECT COALESCE(u.owner_user_id, u.id) INTO expected_owner FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id INTO ctx_owner, ctx_device FROM agro_context_segments WHERE id = NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN RAISE EXCEPTION 'benchmark owner does not own device'; END IF;
           IF ctx_owner IS NULL OR ctx_owner IS DISTINCT FROM NEW.owner_user_id OR ctx_device IS DISTINCT FROM NEW.device_id THEN RAISE EXCEPTION 'benchmark context mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await query('DROP TRIGGER IF EXISTS trg_assert_agro_intelligence_benchmark ON agro_intelligence_benchmark');
    await query('CREATE TRIGGER trg_assert_agro_intelligence_benchmark BEFORE INSERT OR UPDATE ON agro_intelligence_benchmark FOR EACH ROW EXECUTE FUNCTION rayat_assert_bench_identity()');
    await query('CREATE INDEX IF NOT EXISTS idx_is_bench_cohort ON agro_intelligence_benchmark (cohort_key)');
    await query('CREATE INDEX IF NOT EXISTS idx_is_bench_status ON agro_intelligence_benchmark (benchmark_status)');
}

// Solo contesti production con score e attributi coorte completi (crop+medium+cultivation noto).
async function loadScoredProductionContexts() {
    return query(
        `SELECT s.owner_user_id, s.device_id, s.context_id, s.intelligence_score AS score,
                c.crop_key, c.medium, c.cultivation_type
         FROM agro_intelligence_score s
         JOIN agro_context_segments c ON c.id = s.context_id AND c.is_production = TRUE AND c.usage_type = 'production'
         WHERE c.crop_key IS NOT NULL AND btrim(c.crop_key) <> ''
           AND c.medium IS NOT NULL AND btrim(c.medium) <> ''
           AND c.cultivation_type IS NOT NULL AND c.cultivation_type <> 'unknown'`
    );
}

async function upsertBenchmark(r) {
    await query(
        `INSERT INTO agro_intelligence_benchmark
            (owner_user_id, device_id, context_id, cohort_key, crop_key, medium, cultivation_type, benchmark_status,
             percentile_rank, cohort_average, cohort_median, cohort_top_quartile, cohort_bottom_quartile, relative_position,
             benchmark_confidence, cohort_size, distinct_owner_count, subject_score, evidence_json, rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSONB), ?, NOW(), NOW())
         ON CONFLICT (owner_user_id, device_id, context_id) DO UPDATE SET
            cohort_key = EXCLUDED.cohort_key, crop_key = EXCLUDED.crop_key, medium = EXCLUDED.medium, cultivation_type = EXCLUDED.cultivation_type,
            benchmark_status = EXCLUDED.benchmark_status, percentile_rank = EXCLUDED.percentile_rank,
            cohort_average = EXCLUDED.cohort_average, cohort_median = EXCLUDED.cohort_median,
            cohort_top_quartile = EXCLUDED.cohort_top_quartile, cohort_bottom_quartile = EXCLUDED.cohort_bottom_quartile,
            relative_position = EXCLUDED.relative_position, benchmark_confidence = EXCLUDED.benchmark_confidence,
            cohort_size = EXCLUDED.cohort_size, distinct_owner_count = EXCLUDED.distinct_owner_count,
            subject_score = EXCLUDED.subject_score, evidence_json = EXCLUDED.evidence_json, updated_at = NOW()
         RETURNING id`,
        [r.key.owner_user_id, r.key.device_id, r.key.context_id, r.cohort_key, r.crop_key, r.medium, r.cultivation_type, r.benchmark_status,
         r.percentile_rank, r.cohort_average, r.cohort_median, r.cohort_top_quartile, r.cohort_bottom_quartile, r.relative_position,
         r.benchmark_confidence, r.cohort_size, r.distinct_owner_count, r.subject_score, JSON.stringify(r.evidence || {}), RULE_VERSION]
    );
}

async function runBenchmarking({ dryRun = false } = {}) {
    const summary = { cohorts: 0, members: 0, benchmarked: 0, suppressed: 0, by_status: {}, dry_run: dryRun };
    const rows = await loadScoredProductionContexts();
    const cohorts = new Map();
    for (const r of rows) {
        const ck = `${r.crop_key}|${r.medium}|${r.cultivation_type}`;
        if (!cohorts.has(ck)) { cohorts.set(ck, { cohort: { crop_key: r.crop_key, medium: r.medium, cultivation_type: r.cultivation_type }, members: [] }); }
        cohorts.get(ck).members.push({ owner_user_id: r.owner_user_id, device_id: r.device_id, context_id: r.context_id, score: C.num(r.score) });
    }
    const out = [];
    for (const { cohort, members } of cohorts.values()) {
        summary.cohorts += 1;
        const computed = computeCohort(members, cohort);
        for (const res of computed.results) {
            assertLocalIdentity({ ownerUserId: res.key.owner_user_id, deviceId: res.key.device_id, context: 'benchmark' }); // fail-closed
            summary.members += 1;
            summary.by_status[res.benchmark_status] = (summary.by_status[res.benchmark_status] || 0) + 1;
            if (res.benchmark_status === 'ok') { summary.benchmarked += 1; } else { summary.suppressed += 1; }
            out.push(res);
            if (!dryRun) { await upsertBenchmark(res); }
        }
    }
    return dryRun ? { ...summary, rows: out } : summary;
}

module.exports = {
    ensureBenchmarkSchema, runBenchmarking, computeCohort, percentileRank, relativePosition,
    MIN_OWNERS, STATUSES, POSITIONS, FORBIDDEN_EVIDENCE_KEYS, RULE_VERSION
};
