'use strict';

const { query } = require('../config/database');
const C = require('./intelligence-common');
const { ensureContextSchema } = require('./agronomic-context');

const RULE_VERSION = 's6.6';
const WARNING_TYPES = Object.freeze([
    'future_breach', 'future_stress', 'future_risk', 'weak_recovery',
    'trend_deterioration', 'confidence_drop'
]);
const WARNING_LEVELS = Object.freeze(['info', 'advisory', 'warning', 'urgent', 'critical']);
const MIN_CONFIDENCE = 0.45;
const MIN_PROBABILITY = 0.45;
const MAX_ETA_MINUTES = 1440;

function finite(value, fallback = null) {
    const parsed = C.num(value);
    return parsed === null ? fallback : parsed;
}

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertIdentity(value, label = 'early-warning') {
    const identity = {
        owner_user_id: positiveInteger(value && value.owner_user_id),
        device_id: positiveInteger(value && value.device_id),
        context_id: positiveInteger(value && value.context_id)
    };
    if (!identity.owner_user_id || !identity.device_id || !identity.context_id) {
        throw new Error(`[${label}] unresolved owner/device/context identity`);
    }
    return identity;
}

function parseArray(value) {
    const parsed = C.parseJson(value, []);
    return Array.isArray(parsed) ? parsed : [];
}

function average(values, fallback = 0) {
    const valid = values.map((value) => finite(value)).filter((value) => value !== null);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : fallback;
}

function warningLevel(score) {
    if (score >= 85) { return 'critical'; }
    if (score >= 70) { return 'urgent'; }
    if (score >= 55) { return 'warning'; }
    if (score >= 40) { return 'advisory'; }
    return 'info';
}

function warningScore(probability, confidence, etaMinutes, baseSeverity = 0.5) {
    const urgency = C.clamp01(1 - Math.min(MAX_ETA_MINUTES, Math.max(0, etaMinutes)) / MAX_ETA_MINUTES);
    return C.round1(100 * C.clamp01(
        0.45 * probability + 0.25 * confidence + 0.20 * urgency + 0.10 * baseSeverity
    ));
}

function makeWarning(identity, generatedAt, values) {
    const probability = C.clamp01(values.probability);
    const confidence = C.clamp01(values.confidence);
    const eta = Math.round(Number(values.eta_minutes));
    if (!WARNING_TYPES.includes(values.warning_type) || !Number.isFinite(eta) || eta <= 0) {
        throw new Error('[early-warning] invalid warning candidate');
    }
    const score = warningScore(probability, confidence, eta, values.base_severity);
    return {
        ...identity,
        generated_at: generatedAt.toISOString(),
        warning_type: values.warning_type,
        warning_level: warningLevel(score),
        warning_score: score,
        probability: C.round3(probability),
        confidence: C.round3(confidence),
        eta_minutes: eta,
        title: values.title,
        summary: values.summary,
        recommended_action: values.recommended_action,
        evidence_json: {
            signal: values.signal,
            thresholds: { minimum_probability: MIN_PROBABILITY, minimum_confidence: MIN_CONFIDENCE,
                maximum_eta_minutes: MAX_ETA_MINUTES },
            privacy: { raw_readings: false, raw_events: false, cross_tenant_evidence: false, fleet_dependency: false }
        },
        status: 'active',
        acknowledged_at: null,
        resolved_at: null,
        rule_version: RULE_VERSION
    };
}

function validEta(value) {
    const eta = finite(value);
    return eta !== null && eta > 0 && eta <= MAX_ETA_MINUTES ? eta : null;
}

function pickBest(rows, probabilityOf, confidenceOf, etaOf) {
    return rows.map((row) => ({ row, probability: probabilityOf(row), confidence: confidenceOf(row), eta: etaOf(row) }))
        .filter((candidate) => candidate.probability >= MIN_PROBABILITY
            && candidate.confidence >= MIN_CONFIDENCE && candidate.eta !== null)
        .sort((a, b) => a.eta - b.eta || b.probability - a.probability || b.confidence - a.confidence)[0] || null;
}

function generateEarlyWarnings(input, generatedAt = new Date()) {
    const identity = assertIdentity(input, 'early-warning-input');
    const clock = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
    if (Number.isNaN(clock.getTime())) { throw new Error('[early-warning] invalid generatedAt'); }
    const metricForecasts = parseArray(input.metric_forecasts);
    const breaches = parseArray(input.breach_eta);
    const stresses = parseArray(input.stress_eta);
    const risks = parseArray(input.risk_forecasts);
    const recovery = input.recovery_forecast || null;
    const health = input.health_profile || null;
    const intelligence = input.intelligence_score || null;
    const warnings = [];

    const breach = pickBest(
        breaches.filter((row) => ['breach_possible', 'breach_likely'].includes(row.status)),
        (row) => ({ breach_possible: 0.62, breach_likely: 0.85 })[row.status]
            * (0.7 + 0.3 * C.clamp01(finite(row.eta_confidence, 0))),
        (row) => C.clamp01(finite(row.eta_confidence, 0)),
        (row) => validEta(row.eta_minutes)
    );
    if (breach) {
        warnings.push(makeWarning(identity, clock, {
            warning_type: 'future_breach', probability: breach.probability, confidence: breach.confidence,
            eta_minutes: breach.eta, base_severity: breach.row.status === 'breach_likely' ? 0.8 : 0.55,
            title: 'Possibile superamento futuro',
            summary: `Un indicatore potrebbe superare il proprio intervallo operativo entro circa ${breach.eta} minuti.`,
            recommended_action: 'Verificare le letture dei sensori e ispezionare le condizioni della serra.',
            signal: { status: breach.row.status, direction: breach.row.breach_direction || 'unknown',
                metric: breach.row.metric || null, eta_minutes: breach.eta }
        }));
    }

    const stress = pickBest(
        stresses.filter((row) => ['stress_possible', 'stress_likely', 'stress_imminent'].includes(row.status)),
        (row) => C.clamp01(finite(row.stress_probability, 0)),
        (row) => C.clamp01(finite(row.stress_confidence, 0)),
        (row) => validEta(row.eta_minutes)
    );
    if (stress) {
        warnings.push(makeWarning(identity, clock, {
            warning_type: 'future_stress', probability: stress.probability, confidence: stress.confidence,
            eta_minutes: stress.eta, base_severity: stress.row.status === 'stress_imminent' ? 0.9 : 0.65,
            title: 'Stress previsto',
            summary: `Il contesto potrebbe entrare in stress entro circa ${stress.eta} minuti.`,
            recommended_action: 'Ispezionare le condizioni della serra e rivedere le modifiche operative recenti.',
            signal: { status: stress.row.status, stress_type: stress.row.stress_type, eta_minutes: stress.eta }
        }));
    }

    const risk = pickBest(
        risks.filter((row) => ['high', 'critical'].includes(row.overall_risk_band)),
        (row) => C.clamp01(finite(row.risk_probability, 0)),
        (row) => C.clamp01(finite(row.confidence, 0)),
        (row) => validEta(row.forecast_horizon_minutes)
    );
    if (risk && risk.probability >= 0.55) {
        warnings.push(makeWarning(identity, clock, {
            warning_type: 'future_risk', probability: risk.probability, confidence: risk.confidence,
            eta_minutes: risk.eta, base_severity: risk.row.overall_risk_band === 'critical' ? 1 : 0.75,
            title: 'Rischio futuro elevato',
            summary: `La valutazione consolidata indica rischio ${risk.row.overall_risk_band} nell'orizzonte di ${risk.eta} minuti.`,
            recommended_action: 'Rivedere le modifiche recenti e ispezionare le condizioni della serra.',
            signal: { risk_band: risk.row.overall_risk_band,
                risk_score: finite(risk.row.overall_risk_score), primary_risk: risk.row.primary_risk || null }
        }));
    }

    if (recovery) {
        const recoveryProbability = C.clamp01(finite(recovery.recovery_probability, 0));
        const recoveryRisk = C.clamp01(finite(recovery.recovery_risk, 0) / 100);
        const weakProbability = Math.max(1 - recoveryProbability, recoveryRisk);
        const recoveryConfidence = C.clamp01(finite(recovery.confidence, 0));
        const eta = validEta(recovery.estimated_recovery_minutes);
        if (weakProbability >= 0.5 && recoveryConfidence >= MIN_CONFIDENCE && eta !== null) {
            warnings.push(makeWarning(identity, clock, {
                warning_type: 'weak_recovery', probability: weakProbability, confidence: recoveryConfidence,
                eta_minutes: eta, base_severity: recoveryRisk,
                title: 'Recupero previsto debole',
                summary: `Il recupero atteso appare lento o fragile, con durata stimata di circa ${eta} minuti.`,
                recommended_action: 'Monitorare le condizioni della serra e rivedere le modifiche operative recenti.',
                signal: { recovery_band: recovery.estimated_recovery_band,
                    recovery_probability: recoveryProbability, recovery_risk: finite(recovery.recovery_risk) }
            }));
        }
    }

    const trendCandidates = risks.map((row) => {
        const evidence = C.parseJson(row.evidence_json, {});
        return { ...row, trend_factor: finite(evidence && evidence.factors && evidence.factors.trend_deterioration, 0) };
    }).filter((row) => row.trend_factor >= 0.65);
    const trend = pickBest(
        trendCandidates,
        (row) => Math.max(C.clamp01(finite(row.risk_probability, 0)), C.clamp01(row.trend_factor)),
        (row) => C.clamp01(finite(row.confidence, 0)),
        (row) => validEta(row.forecast_horizon_minutes)
    );
    if (trend) {
        warnings.push(makeWarning(identity, clock, {
            warning_type: 'trend_deterioration', probability: trend.probability, confidence: trend.confidence,
            eta_minutes: trend.eta, base_severity: trend.row.trend_factor,
            title: 'Tendenza in deterioramento',
            summary: `Gli indicatori consolidati mostrano deterioramento nell'orizzonte di ${trend.eta} minuti.`,
            recommended_action: 'Rivedere le modifiche recenti e verificare la coerenza delle letture dei sensori.',
            signal: { trend_deterioration: C.round3(trend.row.trend_factor),
                risk_score: finite(trend.row.overall_risk_score) }
        }));
    }

    const confidenceValues = [];
    if (metricForecasts.length) {
        confidenceValues.push(average(metricForecasts.map((row) => average([row.confidence, row.data_quality_score]))));
    }
    if (stresses.length) { confidenceValues.push(average(stresses.map((row) => row.stress_confidence))); }
    if (risks.length) { confidenceValues.push(average(risks.map((row) => row.confidence))); }
    if (recovery && finite(recovery.confidence) !== null) { confidenceValues.push(finite(recovery.confidence)); }
    if (health && finite(health.confidence) !== null) { confidenceValues.push(finite(health.confidence)); }
    if (intelligence && finite(intelligence.confidence) !== null) { confidenceValues.push(finite(intelligence.confidence)); }
    const overallConfidence = confidenceValues.length ? C.clamp01(average(confidenceValues)) : 0;
    const confidenceDropProbability = C.clamp01(1 - overallConfidence);
    const diagnosisConfidence = C.clamp01(0.5 + 0.08 * Math.min(5, confidenceValues.length));
    const affectedHorizons = [
        ...metricForecasts.map((row) => validEta(row.horizon_minutes)),
        ...risks.map((row) => validEta(row.forecast_horizon_minutes))
    ].filter((value) => value !== null);
    const confidenceEta = affectedHorizons.length ? Math.min(...affectedHorizons) : null;
    if (confidenceValues.length >= 2 && confidenceDropProbability >= MIN_PROBABILITY
        && diagnosisConfidence >= MIN_CONFIDENCE && confidenceEta !== null) {
        warnings.push(makeWarning(identity, clock, {
            warning_type: 'confidence_drop', probability: confidenceDropProbability,
            confidence: diagnosisConfidence, eta_minutes: confidenceEta, base_severity: 0.45,
            title: 'Affidabilità dati ridotta',
            summary: `La confidenza media delle previsioni è ridotta nell'orizzonte di ${confidenceEta} minuti.`,
            recommended_action: 'Verificare le letture dei sensori e la disponibilità dei dati recenti.',
            signal: { observed_confidence: C.round3(overallConfidence), source_samples: confidenceValues.length }
        }));
    }

    return warnings.sort((a,b)=>WARNING_TYPES.indexOf(a.warning_type)-WARNING_TYPES.indexOf(b.warning_type));
}

async function ensureEarlyWarningSchema({executor=query,ensureContext=ensureContextSchema}={}) {
    await ensureContext();
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_early_warnings (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           generated_at TIMESTAMPTZ NOT NULL,
           warning_type VARCHAR(28) NOT NULL,
           warning_level VARCHAR(12) NOT NULL,
           warning_score NUMERIC(6,2) NOT NULL,
           probability NUMERIC(5,4) NOT NULL,
           confidence NUMERIC(5,4) NOT NULL,
           eta_minutes INTEGER NOT NULL,
           title VARCHAR(180) NOT NULL,
           summary TEXT NOT NULL,
           recommended_action TEXT NOT NULL,
           evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
           status VARCHAR(12) NOT NULL DEFAULT 'active',
           acknowledged_at TIMESTAMPTZ NULL,
           resolved_at TIMESTAMPTZ NULL,
           rule_version VARCHAR(20) NOT NULL DEFAULT 's6.6',
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_early_warning UNIQUE (owner_user_id,device_id,context_id,warning_type),
           CONSTRAINT early_warning_values_check CHECK (
             warning_type IN ('future_breach','future_stress','future_risk','weak_recovery','trend_deterioration','confidence_drop')
             AND warning_level IN ('info','advisory','warning','urgent','critical')
             AND warning_score BETWEEN 0 AND 100 AND probability BETWEEN 0 AND 1 AND confidence BETWEEN 0 AND 1
             AND eta_minutes>0 AND status IN ('active','acknowledged','resolved','expired')
             AND btrim(title)<>'' AND btrim(summary)<>'' AND btrim(recommended_action)<>''
             AND jsonb_typeof(evidence_json)='object')
         )`
    );
    const invalid=await executor(
        `SELECT COUNT(*)::integer AS invalid_count FROM agro_early_warnings w
         LEFT JOIN devices d ON d.id=w.device_id LEFT JOIN users u ON u.id=d.user_id
         LEFT JOIN agro_context_segments c ON c.id=w.context_id
         WHERE w.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id,u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM w.owner_user_id
            OR c.device_id IS DISTINCT FROM w.device_id`
    );
    if(Number(invalid[0]&&invalid[0].invalid_count)>0){throw new Error('[early-warning-schema] existing rows have invalid tenant/context identity');}
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_early_warning_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER;context_owner INTEGER;context_device INTEGER;
         BEGIN
           SELECT COALESCE(u.owner_user_id,u.id) INTO expected_owner FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=NEW.device_id;
           SELECT owner_user_id,device_id INTO context_owner,context_device FROM agro_context_segments WHERE id=NEW.context_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN RAISE EXCEPTION 'early warning owner/device mismatch';END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id OR context_device IS DISTINCT FROM NEW.device_id THEN RAISE EXCEPTION 'early warning context mismatch';END IF;
           RETURN NEW;
         END;$$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS early_warning_identity_guard ON agro_early_warnings');
    await executor('CREATE TRIGGER early_warning_identity_guard BEFORE INSERT OR UPDATE ON agro_early_warnings FOR EACH ROW EXECUTE FUNCTION rayat_assert_early_warning_identity()');
    await executor('CREATE INDEX IF NOT EXISTS idx_early_warning_context_status ON agro_early_warnings (context_id,status,warning_level)');
    await executor('CREATE INDEX IF NOT EXISTS idx_early_warning_generated ON agro_early_warnings (generated_at DESC)');
}

function normalizeScope(scope){if(!scope){return{};}const result={};for(const[key,source]of[['owner_user_id','ownerUserId'],['device_id','deviceId'],['context_id','contextId']]){if(scope[source]!=null){const value=positiveInteger(scope[source]);if(!value){throw new Error('[early-warning] invalid scope');}result[key]=value;}}return result;}
function scopeSql(scope,alias,params){return Object.entries(scope).map(([key,value])=>{params.push(value);return `${alias}.${key}=?`;});}

async function loadEarlyWarningInputs({generatedAt=new Date(),scope=null,executor=query}={}){
    const clock=generatedAt instanceof Date?generatedAt:new Date(generatedAt);if(Number.isNaN(clock.getTime())){throw new Error('[early-warning] invalid generatedAt');}
    const normalized=normalizeScope(scope);const params=[clock.toISOString(),clock.toISOString()];
    const clauses=['c.valid_from<=CAST(? AS TIMESTAMPTZ)','(c.valid_to IS NULL OR c.valid_to>CAST(? AS TIMESTAMPTZ))','c.owner_user_id=COALESCE(u.owner_user_id,u.id)','c.device_id=d.id'];
    clauses.push('c.is_production=TRUE');clauses.push("LOWER(COALESCE(c.usage_type,'')) NOT IN ('demo','test','calibration','maintenance')");
    clauses.push(...scopeSql(normalized,'c',params));
    clauses.push(`(EXISTS (SELECT 1 FROM agro_metric_forecasts f WHERE f.owner_user_id=c.owner_user_id AND f.device_id=c.device_id AND f.context_id=c.id)
      OR EXISTS (SELECT 1 FROM agro_stress_eta se WHERE se.owner_user_id=c.owner_user_id AND se.device_id=c.device_id AND se.context_id=c.id)
      OR EXISTS (SELECT 1 FROM agro_risk_forecasts rf WHERE rf.owner_user_id=c.owner_user_id AND rf.device_id=c.device_id AND rf.context_id=c.id)
      OR EXISTS (SELECT 1 FROM agro_recovery_forecasts rc WHERE rc.owner_user_id=c.owner_user_id AND rc.device_id=c.device_id AND rc.context_id=c.id))`);
    const contexts=await executor(`SELECT c.id AS context_id,c.owner_user_id,c.device_id FROM agro_context_segments c JOIN devices d ON d.id=c.device_id JOIN users u ON u.id=d.user_id WHERE ${clauses.join(' AND ')} ORDER BY c.owner_user_id,c.device_id,c.id`,params);
    const map=new Map(contexts.map((row)=>[`${row.owner_user_id}:${row.device_id}:${row.context_id}`,{owner_user_id:Number(row.owner_user_id),device_id:Number(row.device_id),context_id:Number(row.context_id),metric_forecasts:[],breach_eta:[],stress_eta:[],risk_forecasts:[],recovery_forecast:null,health_profile:null,intelligence_score:null}]));
    if(!map.size){return[];}const ids=[...new Set(contexts.map((row)=>Number(row.context_id)))];
    const selected=(table,order)=>executor(`SELECT * FROM ${table} WHERE context_id IN (${ids.map(()=>'?').join(',')}) ORDER BY ${order}`,ids);
    const attach=(rows,field)=>rows.forEach((row)=>{const target=map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);if(target){target[field].push(row);}});
    attach(await selected('agro_metric_forecasts','owner_user_id,device_id,context_id,sensor_id,horizon_minutes'),'metric_forecasts');
    attach(await selected('agro_breach_eta','owner_user_id,device_id,context_id,sensor_id,horizon_minutes'),'breach_eta');
    attach(await selected('agro_stress_eta','owner_user_id,device_id,context_id,stress_type'),'stress_eta');
    attach(await selected('agro_risk_forecasts','owner_user_id,device_id,context_id,forecast_horizon_minutes'),'risk_forecasts');
    for(const row of await selected('agro_recovery_forecasts','owner_user_id,device_id,context_id')){const target=map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);if(target){target.recovery_forecast=row;}}
    for(const row of await selected('agro_greenhouse_health_profile','owner_user_id,device_id,context_id')){const target=map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);if(target){target.health_profile=row;}}
    for(const row of await selected('agro_intelligence_score','owner_user_id,device_id,context_id')){const target=map.get(`${row.owner_user_id}:${row.device_id}:${row.context_id}`);if(target){target.intelligence_score=row;}}
    return[...map.values()];
}

async function upsertEarlyWarning(row,executor=query){const identity=assertIdentity(row,'early-warning-upsert');await executor(
    `INSERT INTO agro_early_warnings
      (owner_user_id,device_id,context_id,generated_at,warning_type,warning_level,warning_score,probability,confidence,
       eta_minutes,title,summary,recommended_action,evidence_json,status,acknowledged_at,resolved_at,rule_version,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CAST(? AS JSONB),'active',NULL,NULL,?,NOW(),NOW())
     ON CONFLICT (owner_user_id,device_id,context_id,warning_type) DO UPDATE SET
       generated_at=EXCLUDED.generated_at,warning_level=EXCLUDED.warning_level,warning_score=EXCLUDED.warning_score,
       probability=EXCLUDED.probability,confidence=EXCLUDED.confidence,eta_minutes=EXCLUDED.eta_minutes,
       title=EXCLUDED.title,summary=EXCLUDED.summary,recommended_action=EXCLUDED.recommended_action,evidence_json=EXCLUDED.evidence_json,
       status=CASE WHEN agro_early_warnings.status IN ('acknowledged','resolved') THEN agro_early_warnings.status ELSE 'active' END,
       acknowledged_at=CASE WHEN agro_early_warnings.status='acknowledged' THEN agro_early_warnings.acknowledged_at ELSE NULL END,
       resolved_at=CASE WHEN agro_early_warnings.status='resolved' THEN agro_early_warnings.resolved_at ELSE NULL END,
       rule_version=EXCLUDED.rule_version,updated_at=NOW()`,
    [identity.owner_user_id,identity.device_id,identity.context_id,row.generated_at,row.warning_type,row.warning_level,row.warning_score,row.probability,row.confidence,row.eta_minutes,row.title,row.summary,row.recommended_action,JSON.stringify(row.evidence_json),RULE_VERSION]);}

async function expireStaleWarnings({generatedAt,scope=null,executor=query}={}){const normalized=normalizeScope(scope);const params=[(generatedAt instanceof Date?generatedAt:new Date(generatedAt)).toISOString()];const clauses=["generated_at IS DISTINCT FROM CAST(? AS TIMESTAMPTZ)","status IN ('active','acknowledged')",...scopeSql(normalized,'agro_early_warnings',params)];const rows=await executor(`WITH changed AS (UPDATE agro_early_warnings SET status='expired',updated_at=NOW() WHERE ${clauses.join(' AND ')} RETURNING 1) SELECT COUNT(*)::integer AS changed FROM changed`,params);return Number(rows[0]&&rows[0].changed)||0;}

async function runEarlyWarningCycle({generatedAt=new Date(),scope=null,dryRun=false,executor=query}={}){const inputs=await loadEarlyWarningInputs({generatedAt,scope,executor});const rows=[];const byType=Object.fromEntries(WARNING_TYPES.map((type)=>[type,0]));for(const input of inputs){for(const row of generateEarlyWarnings(input,generatedAt)){rows.push(row);byType[row.warning_type]+=1;if(!dryRun){await upsertEarlyWarning(row,executor);}}}const expired=dryRun?0:await expireStaleWarnings({generatedAt,scope,executor});return{contexts:inputs.length,warning_rows:rows.length,stored:dryRun?0:rows.length,by_type:byType,expired,dry_run:dryRun,rows};}

module.exports={ensureEarlyWarningSchema,runEarlyWarningCycle,loadEarlyWarningInputs,generateEarlyWarnings,upsertEarlyWarning,expireStaleWarnings,warningLevel,warningScore,WARNING_TYPES,WARNING_LEVELS,RULE_VERSION};
