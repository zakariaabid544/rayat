'use strict';

const { query } = require('../config/database');

const DEFAULT_MIN_DISTINCT_CUSTOMERS = 3;
const SCOPED_TABLES = new Set([
    'agro_success_patterns',
    'agro_pattern_intelligence',
    'agro_triggers',
    'agro_trigger_intelligence',
    'agro_recovery_intelligence'
]);
const LOCAL_TABLES = new Set(['agro_local_learning', 'agro_learning_delta']);

function positiveInteger(value) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function minimumDistinctCustomers() {
    const configured = positiveInteger(process.env.AGRO_FLEET_MIN_DISTINCT_CUSTOMERS);
    return configured || DEFAULT_MIN_DISTINCT_CUSTOMERS;
}

function assertLocalIdentity({ ownerUserId, deviceId, greenhouseScope = deviceId, context = 'intelligence' }) {
    const owner = positiveInteger(ownerUserId);
    const device = positiveInteger(deviceId);
    const greenhouse = positiveInteger(greenhouseScope);
    if (!owner || !device || greenhouse !== device) {
        throw new Error(`[${context}] unresolved or inconsistent tenant identity`);
    }
    return { owner_user_id: owner, device_id: device, greenhouse_scope: greenhouse };
}

function assertScopedIdentity({ scopeType, ownerUserId, deviceId, greenhouseScope, context = 'intelligence' }) {
    if (scopeType === 'fleet') {
        if (ownerUserId != null || deviceId != null || greenhouseScope != null) {
            throw new Error(`[${context}] fleet rows must not retain tenant identifiers`);
        }
        return { owner_user_id: null, device_id: null, greenhouse_scope: null };
    }
    if (scopeType !== 'greenhouse') {
        throw new Error(`[${context}] invalid scope type`);
    }
    return assertLocalIdentity({ ownerUserId, deviceId, greenhouseScope, context });
}

function distinctPositiveIds(values) {
    return new Set((values || []).map(positiveInteger).filter(Boolean));
}

function fleetEligibility(ownerIds, deviceIds, minimum = minimumDistinctCustomers()) {
    const owners = distinctPositiveIds(ownerIds);
    const devices = distinctPositiveIds(deviceIds);
    return {
        distinct_owner_count: owners.size,
        distinct_device_count: devices.size,
        fleet_eligible: owners.size >= minimum,
        minimum_distinct_customers: minimum
    };
}

function tenantSafeLocalKey(prefix, identity, ...parts) {
    const local = assertLocalIdentity({ ...identity, context: `${prefix}-key` });
    return [prefix, local.owner_user_id, local.device_id, ...parts].join('|');
}

function fleetSafeEvidence(scopeType, evidence = {}) {
    if (scopeType !== 'fleet') {
        return evidence;
    }
    const blockedKeys = new Set([
        'supporting_event_ids', 'supporting_examples', 'antecedent_event_id',
        'consequent_event_id', 'device_id', 'owner_user_id'
    ]);
    const sanitize = (value) => {
        if (Array.isArray(value)) { return value.map(sanitize); }
        if (!value || typeof value !== 'object') { return value; }
        const sanitized = {};
        for (const [key, child] of Object.entries(value)) {
            if (!blockedKeys.has(key)) { sanitized[key] = sanitize(child); }
        }
        return sanitized;
    };
    return sanitize(evidence);
}

function fleetSafeExamples(scopeType, examples) {
    return scopeType === 'fleet' ? [] : (examples || []);
}

async function constraintExists(tableName, constraintName) {
    const rows = await query(
        `SELECT 1 FROM pg_constraint
         WHERE conrelid = ?::regclass AND conname = ?
         LIMIT 1`,
        [tableName, constraintName]
    );
    return rows.length > 0;
}

async function addConstraint(tableName, constraintName, definition) {
    if (await constraintExists(tableName, constraintName)) {
        return;
    }
    await query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${definition}`);
}

async function ensureIdentityGuardFunction() {
    await query(
        `CREATE OR REPLACE FUNCTION rayat_assert_intelligence_identity()
         RETURNS trigger AS $$
         DECLARE
           payload JSONB := to_jsonb(NEW);
           row_scope TEXT := COALESCE(payload->>'scope_type', 'greenhouse');
           row_owner INTEGER := NULLIF(payload->>'owner_user_id', '')::INTEGER;
           row_device INTEGER := NULLIF(payload->>'device_id', '')::INTEGER;
           row_greenhouse INTEGER := NULLIF(payload->>'greenhouse_scope', '')::INTEGER;
           row_sensor INTEGER := NULLIF(payload->>'sensor_id', '')::INTEGER;
           expected_owner INTEGER;
           expected_sensor_device INTEGER;
         BEGIN
           IF row_scope = 'fleet' THEN
             IF row_owner IS NOT NULL OR row_device IS NOT NULL OR row_greenhouse IS NOT NULL THEN
               RAISE EXCEPTION 'fleet intelligence cannot retain tenant identifiers';
             END IF;
             RETURN NEW;
           END IF;

           IF row_owner IS NULL OR row_device IS NULL THEN
             RAISE EXCEPTION 'local intelligence requires owner_user_id and device_id';
           END IF;
           IF jsonb_exists(payload, 'greenhouse_scope') AND row_greenhouse IS DISTINCT FROM row_device THEN
             RAISE EXCEPTION 'greenhouse_scope must equal device_id';
           END IF;

           SELECT COALESCE(u.owner_user_id, u.id)
             INTO expected_owner
             FROM devices d
             INNER JOIN users u ON u.id = d.user_id
            WHERE d.id = row_device;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM row_owner THEN
             RAISE EXCEPTION 'owner_user_id does not own device_id';
           END IF;

           IF jsonb_exists(payload, 'sensor_id') THEN
             SELECT s.device_id INTO expected_sensor_device FROM sensors s WHERE s.id = row_sensor;
             IF expected_sensor_device IS NULL OR expected_sensor_device IS DISTINCT FROM row_device THEN
               RAISE EXCEPTION 'sensor_id does not belong to device_id';
             END IF;
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`
    );
}

async function ensureIdentityGuard(tableName) {
    await ensureIdentityGuardFunction();
    const triggerName = `${tableName}_tenant_identity_guard`;
    const rows = await query(
        `SELECT 1 FROM pg_trigger
         WHERE tgrelid = ?::regclass AND tgname = ? AND NOT tgisinternal
         LIMIT 1`,
        [tableName, triggerName]
    );
    if (!rows.length) {
        await query(
            `CREATE TRIGGER ${triggerName}
             BEFORE INSERT OR UPDATE ON ${tableName}
             FOR EACH ROW EXECUTE FUNCTION rayat_assert_intelligence_identity()`
        );
    }
}

async function sanitizeFleetEvidence(tableName) {
    const privacyColumns = {
        agro_pattern_intelligence: { evidenceColumn: 'supporting_event_ids', hasEvidenceJson: false },
        agro_triggers: { evidenceColumn: 'supporting_examples', hasEvidenceJson: true },
        agro_trigger_intelligence: { evidenceColumn: 'supporting_event_ids', hasEvidenceJson: true },
        agro_recovery_intelligence: { evidenceColumn: 'supporting_event_ids', hasEvidenceJson: true }
    };
    const privacy = privacyColumns[tableName];
    if (!privacy) { return; }
    const evidenceSanitizer = privacy.hasEvidenceJson
        ? `, evidence_json = COALESCE(evidence_json, '{}'::jsonb)
               - ARRAY['supporting_event_ids','supporting_examples','antecedent_event_id','consequent_event_id','device_id','owner_user_id']::text[]`
        : '';
    await query(
        `UPDATE ${tableName}
         SET ${privacy.evidenceColumn} = '[]'::jsonb${evidenceSanitizer}
         WHERE scope_type = 'fleet'`
    );
    const evidenceCheck = privacy.hasEvidenceJson
        ? `AND NOT jsonb_exists_any(
               COALESCE(evidence_json, '{}'::jsonb),
               ARRAY['supporting_event_ids','supporting_examples','antecedent_event_id','consequent_event_id','device_id','owner_user_id']
             )`
        : '';
    await addConstraint(
        tableName,
        `${tableName}_fleet_evidence_check`,
        `CHECK (
           scope_type <> 'fleet'
           OR (
             (${privacy.evidenceColumn} IS NULL OR ${privacy.evidenceColumn} = '[]'::jsonb)
             ${evidenceCheck}
           )
         )`
    );
}

async function backfillTenantIdentity(tableName, whereClause) {
    await query(`UPDATE ${tableName} SET device_id = greenhouse_scope WHERE ${whereClause} AND device_id IS NULL`);
    await query(
        `UPDATE ${tableName} t
         SET owner_user_id = COALESCE(u.owner_user_id, u.id)
         FROM devices d
         INNER JOIN users u ON u.id = d.user_id
         WHERE ${whereClause.replaceAll('scope_type', 't.scope_type')}
           AND t.device_id = d.id
           AND t.owner_user_id IS NULL`
    );
}

async function assertNoTenantOrphans(tableName, whereClause) {
    const rows = await query(
        `SELECT COUNT(*) AS count
         FROM ${tableName} t
         LEFT JOIN devices d ON d.id = t.device_id
         LEFT JOIN users u ON u.id = d.user_id
         WHERE ${whereClause.replaceAll('scope_type', 't.scope_type')}
           AND (
             t.owner_user_id IS NULL OR t.device_id IS NULL OR d.id IS NULL OR u.id IS NULL
             OR t.greenhouse_scope IS DISTINCT FROM t.device_id
             OR t.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
           )`
    );
    if (Number(rows[0] && rows[0].count) > 0) {
        throw new Error(`[tenant-schema] ${tableName} contains unresolved or mismatched tenant rows`);
    }
}

async function ensureScopedTenantSchema(tableName) {
    if (!SCOPED_TABLES.has(tableName)) {
        throw new Error(`[tenant-schema] unsupported scoped table ${tableName}`);
    }
    await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS owner_user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE`);
    await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS device_id INTEGER NULL REFERENCES devices(id) ON DELETE CASCADE`);
    await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS distinct_owner_count INTEGER NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS distinct_device_count INTEGER NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS fleet_eligible BOOLEAN NOT NULL DEFAULT FALSE`);
    await backfillTenantIdentity(tableName, "scope_type = 'greenhouse'");
    await query(`UPDATE ${tableName} SET owner_user_id = NULL, device_id = NULL WHERE scope_type = 'fleet'`);
    await query(`UPDATE ${tableName} SET fleet_eligible = FALSE WHERE scope_type = 'greenhouse'`);
    await sanitizeFleetEvidence(tableName);
    // Fleet knowledge is fully reproducible. Remove legacy rows until they pass the new owner-count gate.
    await query(`DELETE FROM ${tableName} WHERE scope_type = 'fleet' AND fleet_eligible = FALSE`);
    await assertNoTenantOrphans(tableName, "scope_type = 'greenhouse'");
    await addConstraint(
        tableName,
        `${tableName}_tenant_scope_check`,
        `CHECK (
           (scope_type = 'greenhouse' AND owner_user_id IS NOT NULL AND device_id IS NOT NULL AND greenhouse_scope = device_id)
           OR (scope_type = 'fleet' AND owner_user_id IS NULL AND device_id IS NULL AND greenhouse_scope IS NULL)
         )`
    );
    await addConstraint(
        tableName,
        `${tableName}_fleet_counts_check`,
        'CHECK (distinct_owner_count >= 0 AND distinct_device_count >= 0 AND (fleet_eligible = FALSE OR distinct_owner_count > 0))'
    );
    await ensureIdentityGuard(tableName);
    await query(`CREATE INDEX IF NOT EXISTS idx_${tableName}_tenant ON ${tableName} (owner_user_id, device_id) WHERE scope_type = 'greenhouse'`);
}

async function ensureLocalTenantSchema(tableName) {
    if (!LOCAL_TABLES.has(tableName)) {
        throw new Error(`[tenant-schema] unsupported local table ${tableName}`);
    }
    await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS owner_user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE`);
    await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS device_id INTEGER NULL REFERENCES devices(id) ON DELETE CASCADE`);
    await backfillTenantIdentity(tableName, 'TRUE');
    await assertNoTenantOrphans(tableName, 'TRUE');
    await addConstraint(
        tableName,
        `${tableName}_tenant_identity_check`,
        'CHECK (owner_user_id IS NOT NULL AND device_id IS NOT NULL AND greenhouse_scope = device_id)'
    );
    await ensureIdentityGuard(tableName);
    await query(`CREATE INDEX IF NOT EXISTS idx_${tableName}_tenant ON ${tableName} (owner_user_id, device_id)`);
}

async function ensureActionsTenantSchema() {
    await query('ALTER TABLE agro_actions_detected ADD COLUMN IF NOT EXISTS owner_user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE');
    await query(
        `UPDATE agro_actions_detected a
         SET owner_user_id = COALESCE(u.owner_user_id, u.id)
         FROM devices d
         INNER JOIN users u ON u.id = d.user_id
         WHERE a.device_id = d.id AND a.owner_user_id IS NULL`
    );
    const rows = await query(
        `SELECT COUNT(*) AS count
         FROM agro_actions_detected a
         LEFT JOIN devices d ON d.id = a.device_id
         LEFT JOIN users u ON u.id = d.user_id
         WHERE a.owner_user_id IS NULL OR a.device_id IS NULL OR a.sensor_id IS NULL
            OR d.id IS NULL OR u.id IS NULL
            OR a.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)`
    );
    if (Number(rows[0] && rows[0].count) > 0) {
        throw new Error('[tenant-schema] agro_actions_detected contains unresolved or mismatched tenant rows');
    }
    await addConstraint(
        'agro_actions_detected',
        'agro_actions_detected_tenant_identity_check',
        'CHECK (owner_user_id IS NOT NULL AND device_id IS NOT NULL AND sensor_id IS NOT NULL)'
    );
    await ensureIdentityGuard('agro_actions_detected');
    await query('CREATE INDEX IF NOT EXISTS idx_agro_actions_tenant_started ON agro_actions_detected (owner_user_id, device_id, started_at DESC)');
}

module.exports = {
    DEFAULT_MIN_DISTINCT_CUSTOMERS,
    assertLocalIdentity,
    assertScopedIdentity,
    distinctPositiveIds,
    ensureActionsTenantSchema,
    ensureLocalTenantSchema,
    ensureScopedTenantSchema,
    fleetEligibility,
    fleetSafeEvidence,
    fleetSafeExamples,
    minimumDistinctCustomers,
    positiveInteger,
    tenantSafeLocalKey
};
