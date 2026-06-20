'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');
const { PREDICTION_TYPES } = require('./prediction-backtest');

const RULE_VERSION = 's6.8';
const MIN_EVALUATED = Math.max(3, Number(process.env.AGRO_PREDICTION_CALIBRATION_MIN) || 3);
const ROLLING_WINDOW = Math.max(MIN_EVALUATED, Number(process.env.AGRO_PREDICTION_CALIBRATION_WINDOW) || 100);

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertIdentity(value, label = 'prediction-calibration') {
    const identity = {
        owner_user_id: positiveInteger(value && value.owner_user_id),
        device_id: positiveInteger(value && value.device_id),
        context_id: positiveInteger(value && value.context_id),
        prediction_type: String((value && value.prediction_type) || '').trim()
    };
    if (!identity.owner_user_id || !identity.device_id || !identity.context_id
        || !PREDICTION_TYPES.includes(identity.prediction_type)) {
        throw new Error(`[${label}] unresolved owner/device/context/type identity`);
    }
    return identity;
}

function maturityLevel(count) {
    if (count < 5) { return 'cold_start'; }
    if (count < 15) { return 'learning'; }
    if (count < 50) { return 'stable'; }
    return 'mature';
}

function computeCalibration(group) {
    const valid = Math.max(0, Number(group.evaluated_predictions) || 0);
    if (valid < MIN_EVALUATED) { return null; }
    const rawAccuracy = C.clamp01(C.num(group.raw_accuracy) || 0);
    const rawCalibration = C.clamp01(C.num(group.raw_calibration) || 0);
    const rawConfidence = C.clamp01(C.num(group.raw_confidence_alignment) || 0);
    const evidenceFactor = C.clamp01(valid / 20);
    return {
        total_predictions: Math.max(valid, Number(group.total_predictions) || valid),
        accuracy_score: C.round3(rawAccuracy),
        calibration_score: C.round3(rawCalibration * (0.5 + 0.5 * evidenceFactor)),
        confidence_score: C.round3(rawConfidence * (0.4 + 0.6 * evidenceFactor)),
        maturity_level: maturityLevel(valid),
        last_evaluated_at: new Date(group.last_evaluated_at).toISOString(),
        evidence_factor: C.round3(evidenceFactor),
        evaluated_predictions: valid
    };
}

async function ensurePredictionCalibrationSchema({ executor = query, ensureContext = ensureContextSchema } = {}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_prediction_calibration (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           prediction_type VARCHAR(24) NOT NULL,
           total_predictions INTEGER NOT NULL,
           accuracy_score NUMERIC(5,4) NOT NULL,
           calibration_score NUMERIC(5,4) NOT NULL,
           confidence_score NUMERIC(5,4) NOT NULL,
           maturity_level VARCHAR(12) NOT NULL,
           last_evaluated_at TIMESTAMPTZ NOT NULL,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's6.8',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_prediction_calibration UNIQUE(owner_user_id,device_id,context_id,prediction_type),
           CONSTRAINT prediction_calibration_values_check CHECK(
             prediction_type IN ('metric_forecast','breach_eta','stress_eta','risk_forecast','recovery_forecast')
             AND total_predictions>=0 AND accuracy_score BETWEEN 0 AND 1
             AND calibration_score BETWEEN 0 AND 1 AND confidence_score BETWEEN 0 AND 1
             AND maturity_level IN ('cold_start','learning','stable','mature'))
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count FROM agro_prediction_calibration p
         LEFT JOIN devices d ON d.id=p.device_id LEFT JOIN users u ON u.id=d.user_id
         LEFT JOIN agro_context_segments c ON c.id=p.context_id
         WHERE p.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id,u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM p.owner_user_id
            OR c.device_id IS DISTINCT FROM p.device_id`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[prediction-calibration-schema] existing rows have invalid tenant/context identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_prediction_calibration_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER;context_owner INTEGER;context_device INTEGER;
         BEGIN
           SELECT COALESCE(u.owner_user_id,u.id) INTO expected_owner FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=NEW.device_id;
           SELECT owner_user_id,device_id INTO context_owner,context_device FROM agro_context_segments WHERE id=NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN RAISE EXCEPTION 'prediction calibration owner/device mismatch';END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id OR context_device IS DISTINCT FROM NEW.device_id THEN RAISE EXCEPTION 'prediction calibration context mismatch';END IF;
           RETURN NEW;
         END;$$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS prediction_calibration_identity_guard ON agro_prediction_calibration');
    await executor('CREATE TRIGGER prediction_calibration_identity_guard BEFORE INSERT OR UPDATE ON agro_prediction_calibration FOR EACH ROW EXECUTE FUNCTION rayat_assert_prediction_calibration_identity()');
    await executor('CREATE INDEX IF NOT EXISTS idx_prediction_calibration_partition ON agro_prediction_calibration(owner_user_id,device_id,context_id,prediction_type)');
}

async function loadCalibrationGroups(executor = query) {
    return executor(
        `WITH ranked AS (
           SELECT b.*,ROW_NUMBER() OVER(
             PARTITION BY b.owner_user_id,b.device_id,b.context_id,b.prediction_type
             ORDER BY b.evaluated_at DESC,b.id DESC) AS rolling_rank
           FROM agro_prediction_backtests b JOIN agro_context_segments c ON c.id=b.context_id
           JOIN devices d ON d.id=b.device_id JOIN users u ON u.id=d.user_id
           WHERE c.is_production=TRUE AND LOWER(COALESCE(c.usage_type,'')) NOT IN ('demo','test','calibration','maintenance')
             AND b.owner_user_id=c.owner_user_id AND b.device_id=c.device_id
             AND b.owner_user_id=COALESCE(u.owner_user_id,u.id)
         )
         SELECT b.owner_user_id,b.device_id,b.context_id,b.prediction_type,
                COUNT(*)::integer AS total_predictions,
                COUNT(*) FILTER(WHERE b.outcome<>'insufficient_data')::integer AS evaluated_predictions,
                AVG(CASE b.outcome WHEN 'correct' THEN 1.0 WHEN 'partially_correct' THEN 0.5
                    WHEN 'incorrect' THEN 0.0 END) FILTER(WHERE b.outcome<>'insufficient_data') AS raw_accuracy,
                AVG(b.calibration_score) FILTER(WHERE b.outcome<>'insufficient_data') AS raw_calibration,
                AVG(1-ABS(b.confidence-(CASE b.outcome WHEN 'correct' THEN 1.0
                    WHEN 'partially_correct' THEN 0.5 ELSE 0.0 END)))
                    FILTER(WHERE b.outcome<>'insufficient_data') AS raw_confidence_alignment,
                MAX(b.evaluated_at) AS last_evaluated_at
         FROM ranked b WHERE b.rolling_rank<=?
         GROUP BY b.owner_user_id,b.device_id,b.context_id,b.prediction_type
         ORDER BY b.owner_user_id,b.device_id,b.context_id,b.prediction_type`,
        [ROLLING_WINDOW]
    );
}

async function upsertPredictionCalibration(group, calibration, executor = query) {
    const identity = assertIdentity(group, 'prediction-calibration-upsert');
    await executor(
        `INSERT INTO agro_prediction_calibration(owner_user_id,device_id,context_id,prediction_type,
         total_predictions,accuracy_score,calibration_score,confidence_score,maturity_level,last_evaluated_at,
         rule_version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())
         ON CONFLICT(owner_user_id,device_id,context_id,prediction_type) DO UPDATE SET
         total_predictions=EXCLUDED.total_predictions,accuracy_score=EXCLUDED.accuracy_score,
         calibration_score=EXCLUDED.calibration_score,confidence_score=EXCLUDED.confidence_score,
         maturity_level=EXCLUDED.maturity_level,last_evaluated_at=EXCLUDED.last_evaluated_at,
         rule_version=EXCLUDED.rule_version,updated_at=NOW()`,
        [identity.owner_user_id,identity.device_id,identity.context_id,identity.prediction_type,
            calibration.total_predictions,calibration.accuracy_score,calibration.calibration_score,
            calibration.confidence_score,calibration.maturity_level,calibration.last_evaluated_at,RULE_VERSION]
    );
}

async function runPredictionCalibrationCycle({ dryRun = false, executor = query } = {}) {
    const groups = await loadCalibrationGroups(executor);
    const rows=[];let skippedInsufficient=0;
    for(const group of groups){const calibration=computeCalibration(group);if(!calibration){skippedInsufficient+=1;continue;}
        const row={...assertIdentity(group),...calibration};rows.push(row);
        if(!dryRun){await upsertPredictionCalibration(group,calibration,executor);}}
    return{groups:groups.length,calibration_rows:rows.length,stored:dryRun?0:rows.length,
        skipped_insufficient:skippedInsufficient,dry_run:dryRun,rows};
}

module.exports={ensurePredictionCalibrationSchema,runPredictionCalibrationCycle,loadCalibrationGroups,
    computeCalibration,upsertPredictionCalibration,maturityLevel,MIN_EVALUATED,RULE_VERSION};
