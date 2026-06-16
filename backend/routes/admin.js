/**
 * Rayat Admin API Routes
 * /api/admin/*
 *
 * Roles:
 *   super_admin – full access
 *   admin – gestisce registrazioni/clienti/sensori, ma non gli utenti admin
 */
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const {
    query,
    getTableColumns,
    withTransaction,
    getDatabaseHealth // RAYAT-FIX
} = require('../config/database');
const { getMissingDataAlertRuntimeStatus } = require('../src/jobs/alertJob'); // RAYAT-FIX
const { getMqttConfig, getMqttRuntimeStatus } = require('../src/jobs/mqttDirectJob'); // RAYAT-FIX
const {
    getOfflineAfterMinutes,
    getPostgresMinuteIntervalLiteral
} = require('../utils/monitoring-config');
const {
    extractAdminSessionToken,
    getAdminSessionCookieOptions,
    isPrivilegedAdminRole,
    normalizeAdminRole,
    signAdminToken,
    ADMIN_SESSION_COOKIE
} = require('../utils/admin-auth');
const {
    buildCustomerAccessContext,
    CUSTOMER_ROLES
} = require('../utils/customer-access');
const { buildDatabaseUnavailableResponse } = require('../utils/database-http');
const { attachPasswordResetRoutes } = require('../utils/password-reset');
const { buildAnalyticsSummary } = require('../utils/analytics');

const router = express.Router();

attachPasswordResetRoutes(router, {
    resetPath: '/reset-password',
    userScopeSql: `AND role IN ('super_admin', 'operator_admin', 'operator', 'admin')`
});

const VALID_SENSOR_TYPES = new Set(['energia', 'acqua', 'terreno', 'clima']);
const DEFAULT_SENSOR_PROFILES = {
    energia: {
        subtype: 'energia_consumption',
        name: 'Sensore Energia',
        unit: 'kW'
    },
    acqua: {
        subtype: 'acqua_level',
        name: 'Sensore Acqua',
        unit: 'm'
    },
    terreno: {
        subtype: 'terreno_moisture',
        name: 'Sensore Terreno',
        unit: '%'
    },
    clima: {
        subtype: 'clima_temperature',
        name: 'Sensore Clima',
        unit: '°C'
    }
};
const DEVICE_ASSIGNMENT_SOURCE = 'phase2_device_manager';

function createHttpError(statusCode, message, errorCode = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (errorCode) {
        error.errorCode = errorCode;
    }
    return error;
}

function sendAdminError(res, statusCode, message, errorCode = null) {
    const payload = { error: message };
    if (errorCode) {
        payload.errorCode = errorCode;
    }
    return res.status(statusCode).json(payload);
}

function sendAdminOperationalError(res, error, options = {}) {
    const {
        fallbackMessage = 'Errore interno del server',
        databaseMessage = 'Servizio amministrazione temporaneamente non disponibile'
    } = options;
    const databaseResponse = buildDatabaseUnavailableResponse(error, {
        message: databaseMessage
    });

    if (databaseResponse) {
        return res.status(databaseResponse.statusCode).json(databaseResponse.body);
    }

    return sendAdminError(res, 500, fallbackMessage);
}

function extractBearerToken(req) {
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
        return null;
    }

    const token = authHeader.slice(7).trim();
    return token || null;
}

function clearAdminSessionCookie(res, req) {
    const cookieOptions = getAdminSessionCookieOptions(req);
    res.clearCookie(ADMIN_SESSION_COOKIE, {
        path: cookieOptions.path,
        sameSite: cookieOptions.sameSite,
        secure: cookieOptions.secure,
        httpOnly: cookieOptions.httpOnly
    });
}

function parsePositiveInt(value, fallback, max = 200) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(parsed, max);
}

function parsePagination(req, fallbackPageSize = 25) {
    const page = parsePositiveInt(req.query.page, 1, 1000000);
    const pageSize = parsePositiveInt(req.query.pageSize || req.query.limit, fallbackPageSize, 100);
    return {
        page,
        pageSize,
        offset: (page - 1) * pageSize
    };
}

function buildPaginationMeta(total, page, pageSize) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return {
        total,
        page,
        pageSize,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
    };
}

function getSensorProfile(type) {
    return DEFAULT_SENSOR_PROFILES[type] || DEFAULT_SENSOR_PROFILES.clima;
}

function buildDeviceName(serialNumber, type) {
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    return `${label} ${serialNumber}`;
}

function createExecutor(connection) {
    return async (sql, params) => {
        const [result] = await connection.execute(sql, params);
        return result;
    };
}

function isPlainCatalogObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanCatalogText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeCatalogVersion(value, fallback = '1') {
    return cleanCatalogText(value || fallback) || fallback;
}

function parseJsonColumn(value, fallback) {
    if (value === null || value === undefined) {
        return fallback;
    }
    if (typeof value === 'object') {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
}

function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    if (isPlainCatalogObject(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function parseCatalogBoolean(value, fallback = true) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value === 1;
    }
    const normalized = cleanCatalogText(value).toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no'].includes(normalized)) {
        return false;
    }
    throw createHttpError(400, 'Valore booleano non valido');
}

function parseActiveFilter(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return parseCatalogBoolean(value);
}

function isDeviceManagerPhase2Enabled() {
    return cleanCatalogText(process.env.DEVICE_MANAGER_PHASE2_ENABLED).toLowerCase() === 'true';
}

function requireDeviceManagerPhase2(_req, res, next) {
    if (!isDeviceManagerPhase2Enabled()) {
        return res.status(404).json({ error: 'feature_disabled' });
    }
    return next();
}

function assertCatalogLabels(labels, fieldName) {
    if (!isPlainCatalogObject(labels) || Object.keys(labels).length === 0) {
        throw createHttpError(400, `${fieldName} deve essere un oggetto non vuoto`);
    }
}

function validateSensorModelParameters(parameters) {
    if (!Array.isArray(parameters) || !parameters.length) {
        throw createHttpError(400, 'parameters deve essere un array non vuoto');
    }

    const seenKeys = new Set();
    parameters.forEach((parameter, index) => {
        if (!isPlainCatalogObject(parameter)) {
            throw createHttpError(400, `Parametro ${index + 1} non valido`);
        }
        const key = cleanCatalogText(parameter.key);
        const type = cleanCatalogText(parameter.type);
        const subtype = cleanCatalogText(parameter.subtype);
        const unit = cleanCatalogText(parameter.unit);

        if (!key || !type || !subtype || !unit) {
            throw createHttpError(400, `Parametro ${index + 1}: key, type, subtype e unit sono obbligatori`);
        }
        if (seenKeys.has(key)) {
            throw createHttpError(400, `Parametro duplicato: ${key}`);
        }
        seenKeys.add(key);
        if (!VALID_SENSOR_TYPES.has(type)) {
            throw createHttpError(400, `Tipo sensore non valido nel parametro ${key}`);
        }
        assertCatalogLabels(parameter.label, `Parametro ${key}.label`);
        if (!Number.isFinite(Number(parameter.scale)) || Number(parameter.scale) <= 0) {
            throw createHttpError(400, `Parametro ${key}: scale deve essere un numero positivo`);
        }
        if (typeof parameter.signed !== 'boolean') {
            throw createHttpError(400, `Parametro ${key}: signed deve essere booleano`);
        }
        if (typeof parameter.enabled !== 'boolean') {
            throw createHttpError(400, `Parametro ${key}: enabled deve essere booleano`);
        }
    });
}

function validateSensorModelPayload(body) {
    const slug = cleanCatalogText(body.slug);
    const version = normalizeCatalogVersion(body.version);
    const name = cleanCatalogText(body.name);
    const manufacturer = cleanCatalogText(body.manufacturer) || null;
    const primaryType = cleanCatalogText(body.primary_type);
    const labels = isPlainCatalogObject(body.labels) ? body.labels : {};
    const parameters = body.parameters;
    const notes = cleanCatalogText(body.notes) || null;
    const active = parseCatalogBoolean(body.active, true);

    if (!slug || !name || !primaryType) {
        throw createHttpError(400, 'slug, name e primary_type sono obbligatori');
    }
    if (!VALID_SENSOR_TYPES.has(primaryType)) {
        throw createHttpError(400, 'primary_type non valido');
    }
    validateSensorModelParameters(parameters);

    return {
        slug,
        version,
        name,
        manufacturer,
        primaryType,
        labels,
        parameters,
        notes,
        active
    };
}

function validateCropProfileRanges(ranges) {
    if (!isPlainCatalogObject(ranges)) {
        throw createHttpError(400, 'ranges deve essere un oggetto');
    }

    Object.entries(ranges).forEach(([key, range]) => {
        if (!isPlainCatalogObject(range)) {
            throw createHttpError(400, `Range ${key} non valido`);
        }
        if (!Number.isFinite(Number(range.min)) || !Number.isFinite(Number(range.max))) {
            throw createHttpError(400, `Range ${key}: min e max devono essere numerici`);
        }
        if (Number(range.min) >= Number(range.max)) {
            throw createHttpError(400, `Range ${key}: min deve essere minore di max`);
        }
        if (!cleanCatalogText(range.unit)) {
            throw createHttpError(400, `Range ${key}: unit obbligatoria`);
        }
    });
}

function validateCropProfilePayload(body) {
    const slug = cleanCatalogText(body.slug);
    const version = cleanCatalogText(body.version);
    const cropKey = cleanCatalogText(body.crop_key);
    const medium = cleanCatalogText(body.medium) || null;
    const labels = body.labels;
    const description = isPlainCatalogObject(body.description) ? body.description : {};
    const ranges = body.ranges;
    const active = parseCatalogBoolean(body.active, true);

    if (!slug || !version || !cropKey) {
        throw createHttpError(400, 'slug, version e crop_key sono obbligatori');
    }
    assertCatalogLabels(labels, 'labels');
    validateCropProfileRanges(ranges);

    return {
        slug,
        version,
        cropKey,
        medium,
        labels,
        description,
        ranges,
        active
    };
}

function serializeSensorModel(row, options = {}) {
    const parameters = parseJsonColumn(row.parameters, []);
    const result = {
        id: row.id,
        slug: row.slug,
        version: row.version,
        name: row.name,
        manufacturer: row.manufacturer || null,
        primary_type: row.primary_type,
        labels: parseJsonColumn(row.labels, {}),
        parameters_count: Number(row.parameters_count ?? parameters.length ?? 0),
        notes: row.notes || null,
        active: row.active === true || row.active === 1,
        created_by: row.created_by || null,
        created_at: row.created_at,
        updated_at: row.updated_at
    };

    if (options.includeParameters) {
        result.parameters = parameters;
    }

    return result;
}

function serializeCropProfile(row) {
    return {
        id: row.id,
        slug: row.slug,
        version: row.version,
        crop_key: row.crop_key,
        medium: row.medium || null,
        labels: parseJsonColumn(row.labels, {}),
        description: parseJsonColumn(row.description, {}),
        ranges: parseJsonColumn(row.ranges, {}),
        active: row.active === true || row.active === 1,
        created_by: row.created_by || null,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function parseRequiredPositiveInteger(value, fieldName) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw createHttpError(400, `${fieldName} non valido`);
    }
    return parsed;
}

function parseOptionalPositiveInteger(value, fieldName) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return parseRequiredPositiveInteger(value, fieldName);
}

function parseOptionalCoordinate(value, fieldName, min, max) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw createHttpError(400, `${fieldName} non valido`);
    }
    return parsed;
}

function normalizeAssignmentVisibility(value) {
    const visibility = cleanCatalogText(value || 'private').toLowerCase() || 'private';
    if (!['private', 'public'].includes(visibility)) {
        throw createHttpError(400, 'visibility non valida');
    }
    return visibility;
}

function validateDeviceAssignmentPayload(body = {}) {
    const latitude = parseOptionalCoordinate(body.latitude, 'latitude', -90, 90);
    const longitude = parseOptionalCoordinate(body.longitude, 'longitude', -180, 180);
    if ((latitude === null) !== (longitude === null)) {
        throw createHttpError(400, 'latitude e longitude devono essere valorizzate insieme');
    }

    return {
        clientId: parseRequiredPositiveInteger(body.client_id, 'client_id'),
        site: cleanCatalogText(body.site) || null,
        farm: cleanCatalogText(body.farm) || null,
        zona: cleanCatalogText(body.zona) || null,
        sensorModelId: parseRequiredPositiveInteger(body.sensor_model_id, 'sensor_model_id'),
        cropProfileId: parseOptionalPositiveInteger(body.crop_profile_id, 'crop_profile_id'),
        latitude,
        longitude,
        visibility: normalizeAssignmentVisibility(body.visibility),
        internalNote: cleanCatalogText(body.internal_note) || null
    };
}

function isActiveCatalogRow(row) {
    return row?.active === true || row?.active === 1 || row?.active === '1';
}

function catalogLabel(labels = {}, fallback = '—') {
    return labels.it || labels.fr || labels.en || labels.ar || fallback;
}

function normalizeComparableId(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return String(value);
}

function isSamePhase2Assignment(device, payload) {
    const metadata = parseJsonColumn(device.metadata, {});
    const assignment = isPlainCatalogObject(metadata.assignment) ? metadata.assignment : {};
    const assignedSource = assignment.source || metadata.assignment_source;
    const assignedClientId = normalizeComparableId(device.user_id || assignment.client_id);
    const assignedSensorModelId = normalizeComparableId(metadata.sensor_model_id || assignment.sensor_model_id);
    const assignedCropProfileId = normalizeComparableId(metadata.crop_profile_id || assignment.crop_profile_id);

    return assignedSource === DEVICE_ASSIGNMENT_SOURCE
        && assignedClientId === normalizeComparableId(payload.clientId)
        && assignedSensorModelId === normalizeComparableId(payload.sensorModelId)
        && assignedCropProfileId === normalizeComparableId(payload.cropProfileId);
}

function buildDeviceAssignmentMetadataPatch(device, payload, adminUser) {
    const assignedAt = new Date().toISOString();
    const patch = {
        site: payload.site,
        farm: payload.farm,
        zona: payload.zona,
        visibility: payload.visibility,
        sensor_model_id: payload.sensorModelId,
        crop_profile_id: payload.cropProfileId,
        assignment: {
            source: DEVICE_ASSIGNMENT_SOURCE,
            assigned_at: assignedAt,
            assigned_by: adminUser.id,
            client_id: payload.clientId,
            sensor_model_id: payload.sensorModelId,
            crop_profile_id: payload.cropProfileId,
            previous_user_id: device.user_id || null,
            previous_status: device.status || null,
            internal_note: payload.internalNote
        }
    };

    if (payload.latitude !== null && payload.longitude !== null) {
        patch.location = {
            lat: payload.latitude,
            lng: payload.longitude
        };
    }

    return patch;
}

function buildSensorFromModelParameter(parameter, fallbackType) {
    const labels = isPlainCatalogObject(parameter.label) ? parameter.label : {};
    const type = cleanCatalogText(parameter.type) || fallbackType;
    const subtype = cleanCatalogText(parameter.subtype);
    const name = catalogLabel(labels, subtype || cleanCatalogText(parameter.key) || 'Sensore');
    const unit = cleanCatalogText(parameter.unit);

    if (!VALID_SENSOR_TYPES.has(type) || !subtype || !unit) {
        throw createHttpError(400, 'Parametro modello sensore non valido');
    }

    return {
        type,
        subtype,
        name,
        unit
    };
}

function serializeAssignedDevice(row) {
    return {
        id: row.id,
        device_id: row.device_id,
        serial_number: row.device_id,
        user_id: row.user_id,
        client_id: row.user_id,
        status: row.status,
        metadata: parseJsonColumn(row.metadata, {}),
        updated_at: row.updated_at || null
    };
}

async function lockDeviceSerial(executor, serialNumber) {
    await executor(
        `SELECT pg_advisory_xact_lock(hashtext(?))`,
        [String(serialNumber || '')]
    );
}

async function ensureClientExists(clientId, executor = query) {
    if (!clientId) {
        return null;
    }

    const flags = await getUserColumnFlags();
    const clauses = [
        'id = ?',
        `role IN ('client', 'farmer')`
    ];

    if (flags.hasOwnerUserId) {
        clauses.push('owner_user_id IS NULL');
    }

    const clients = await executor(
        `SELECT id
         FROM users
         WHERE ${clauses.join(' AND ')}`,
        [clientId]
    );

    if (!clients.length) {
        throw createHttpError(404, 'Cliente non trovato');
    }

    return clients[0];
}

async function getUserColumnFlags() {
    const columns = await getTableColumns('users');
    return {
        // RAYAT FIX - registration/admin
        hasLastName: columns.has('last_name'),
        hasOwnerUserId: columns.has('owner_user_id'),
        hasCustomerRole: columns.has('customer_role'),
        hasClientCode: columns.has('client_code'),
        hasLocationAddress: columns.has('location_address'),
        hasPaymentStatus: columns.has('payment_status'),
        hasPaymentDate: columns.has('payment_date'),
        hasSubscriptionExpiry: columns.has('subscription_expiry'),
        hasRegistrationStatus: columns.has('registration_status'),
        hasRegistrationSource: columns.has('registration_source'),
        hasApprovedAt: columns.has('approved_at')
    };
}

function ensureCustomerTeamFeatureAvailable(flags) {
    if (!flags.hasOwnerUserId || !flags.hasCustomerRole) {
        throw createHttpError(503, 'Supporto team cliente non disponibile');
    }
}

function optionalUserSelect(flags, fieldName) {
    const map = {
        last_name: flags.hasLastName,
        client_code: flags.hasClientCode,
        location_address: flags.hasLocationAddress,
        payment_status: flags.hasPaymentStatus,
        payment_date: flags.hasPaymentDate,
        subscription_expiry: flags.hasSubscriptionExpiry,
        registration_status: flags.hasRegistrationStatus,
        registration_source: flags.hasRegistrationSource,
        approved_at: flags.hasApprovedAt
    };

    return map[fieldName] ? `u.${fieldName} AS ${fieldName}` : `NULL AS ${fieldName}`;
}

function resolvedClientCodeExpr(flags, alias = 'u') {
    const paddedIdExpr = `LPAD(CAST(${alias}.id AS TEXT), 4, '0')`;

    if (!flags.hasClientCode) {
        return paddedIdExpr;
    }

    return `COALESCE(NULLIF(${alias}.client_code, ''), ${paddedIdExpr})`;
}

function buildPrimaryClientPredicate(flags, alias = 'u') {
    if (!flags.hasOwnerUserId) {
        return 'TRUE';
    }

    return `${alias}.owner_user_id IS NULL`;
}

function buildManagedCustomerUserSelect(flags, alias = 'u') {
    return [
        `${alias}.id`,
        `${alias}.name`,
        flags.hasLastName ? `${alias}.last_name` : 'NULL AS last_name',
        `${alias}.email`,
        `${alias}.phone`,
        `${alias}.role`,
        `${alias}.active`,
        `${alias}.created_at`,
        flags.hasOwnerUserId ? `${alias}.owner_user_id` : 'NULL AS owner_user_id',
        flags.hasCustomerRole ? `${alias}.customer_role` : 'NULL AS customer_role'
    ].join(',\n                ');
}

function normalizeCoordinate(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLocationFields(payload = {}) {
    const locationName = String(payload.location_name || '').trim() || null;
    const locationAddress = String(payload.location_address || payload.address || locationName || '').trim() || null;
    const latitude = normalizeCoordinate(payload.latitude);
    const longitude = normalizeCoordinate(payload.longitude);

    if ((latitude === null) !== (longitude === null)) {
        throw createHttpError(400, 'Latitudine e longitudine devono essere entrambe valorizzate');
    }

    return {
        locationName,
        locationAddress,
        latitude,
        longitude
    };
}

function normalizeRegistrationStatus(status) {
    return status === 'active' ? 'active' : 'new';
}

// RAYAT FIX - full critical admin flow
function normalizeManagedNameParts(payload = {}) {
    const rawFirstName = String(
        payload.name ||
        payload.first_name ||
        ''
    ).trim();
    const rawLastName = String(
        payload.last_name ||
        payload.lastName ||
        payload.surname ||
        ''
    ).trim();

    if (rawFirstName && rawLastName) {
        return {
            firstName: rawFirstName,
            lastName: rawLastName
        };
    }

    if (!rawFirstName) {
        return {
            firstName: '',
            lastName: ''
        };
    }

    const parts = rawFirstName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return {
            firstName: parts.slice(0, -1).join(' '),
            lastName: parts.slice(-1).join('')
        };
    }

    return {
        firstName: rawFirstName,
        lastName: ''
    };
}

// RAYAT FIX - full critical admin flow
function buildConfirmedClientPredicate(flags, alias = 'u') {
    const clauses = [];

    if (flags.hasRegistrationStatus) {
        clauses.push(`${alias}.registration_status = 'active'`);
    }
    if (flags.hasApprovedAt) {
        clauses.push(`${alias}.approved_at IS NOT NULL`);
    }
    if (!clauses.length) {
        clauses.push(`${alias}.active = TRUE`);
    }

    return `(${clauses.join(' OR ')})`;
}

function normalizeCustomerTeamRole(role, options = {}) {
    const normalized = String(role || '').trim().toLowerCase();
    if (CUSTOMER_ROLES.has(normalized) && normalized !== 'owner') {
        return normalized;
    }

    return options.defaultRole || 'viewer';
}

async function ensureUniqueManagedCustomerIdentity({ email, phone, excludeId = null }) {
    if (email) {
        const duplicateEmail = await query(
            excludeId
                ? 'SELECT id FROM users WHERE email = ? AND id <> ?'
                : 'SELECT id FROM users WHERE email = ?',
            excludeId ? [email, excludeId] : [email]
        );
        if (duplicateEmail.length > 0) {
            throw createHttpError(409, 'Email già registrata');
        }
    }

    if (phone) {
        const duplicatePhone = await query(
            excludeId
                ? 'SELECT id FROM users WHERE phone = ? AND id <> ?'
                : 'SELECT id FROM users WHERE phone = ?',
            excludeId ? [phone, excludeId] : [phone]
        );
        if (duplicatePhone.length > 0) {
            throw createHttpError(409, 'Numero di telefono già registrato');
        }
    }
}

function buildTeamMemberPayload(user = {}, flags) {
    const customerAccess = buildCustomerAccessContext(user, flags);

    return {
        id: user.id,
        name: user.name,
        last_name: user.last_name || null,
        email: user.email || null,
        phone: user.phone || null,
        role: user.role,
        active: user.active,
        created_at: user.created_at,
        owner_user_id: customerAccess.owner_user_id,
        customer_role: customerAccess.customer_role,
        permissions: customerAccess.permissions,
        is_primary_account: customerAccess.is_primary_account
    };
}

async function getPrimaryClientAccount(clientId, flags, executor = query) {
    const rows = await executor(
        `SELECT ${buildManagedCustomerUserSelect(flags)}
         FROM users u
         WHERE u.id = ?
           AND u.role IN ('client', 'farmer')
           AND ${buildPrimaryClientPredicate(flags)}
         LIMIT 1`,
        [clientId]
    );

    if (!rows.length) {
        throw createHttpError(404, 'Cliente non trovato');
    }

    return rows[0];
}

async function getCustomerTeamMember(clientId, userId, flags, executor = query) {
    const rows = await executor(
        `SELECT ${buildManagedCustomerUserSelect(flags)}
         FROM users u
         WHERE u.id = ?
           AND u.role IN ('client', 'farmer')
           AND u.owner_user_id = ?
         LIMIT 1`,
        [userId, clientId]
    );

    if (!rows.length) {
        throw createHttpError(404, 'Utente team non trovato');
    }

    return rows[0];
}

function buildRegistrationWhereClause(req, flags) {
    const where = [
        `u.role IN ('client', 'farmer')`,
        buildPrimaryClientPredicate(flags)
    ];
    const params = [];
    const searchTerm = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();

    if (flags.hasRegistrationSource) {
        where.push(`u.registration_source = 'public'`);
    }

    if (flags.hasRegistrationStatus && status && ['new', 'active'].includes(status)) {
        where.push('u.registration_status = ?');
        params.push(status);
    }

    if (searchTerm) {
        const like = `%${searchTerm}%`;
        const normalizedCode = `%${searchTerm.replace(/^#/, '')}%`;
        const searchClauses = [
            'u.name LIKE ?',
            ...(flags.hasLastName ? ['u.last_name LIKE ?'] : []),
            'u.email LIKE ?',
            'u.phone LIKE ?',
            'u.location_name LIKE ?'
        ];

        params.push(like);
        if (flags.hasLastName) {
            params.push(like);
        }
        params.push(like, like, like);

        if (flags.hasLocationAddress) {
            searchClauses.push('u.location_address LIKE ?');
            params.push(like);
        }

        if (flags.hasClientCode) {
            searchClauses.push(`${resolvedClientCodeExpr(flags)} LIKE ?`);
            params.push(normalizedCode);
        }

        where.push(`(${searchClauses.join(' OR ')})`);
    }

    return {
        whereSql: where.join(' AND '),
        params
    };
}

function buildClientWhereClause(searchTerm, flags) {
    const where = [
        `u.role IN ('client', 'farmer')`,
        buildPrimaryClientPredicate(flags),
        buildConfirmedClientPredicate(flags)
    ];
    const params = [];

    if (searchTerm) {
        const like = `%${searchTerm}%`;
        const normalizedCode = `%${searchTerm.replace(/^#/, '')}%`;
        const searchClauses = [
            'u.name LIKE ?',
            ...(flags.hasLastName ? ['u.last_name LIKE ?'] : []),
            'u.email LIKE ?',
            'u.phone LIKE ?',
            'u.location_name LIKE ?'
        ];

        params.push(like);
        if (flags.hasLastName) {
            params.push(like);
        }
        params.push(like, like, like);

        if (flags.hasLocationAddress) {
            searchClauses.push('u.location_address LIKE ?');
            params.push(like);
        }

        if (flags.hasClientCode) {
            searchClauses.push(`${resolvedClientCodeExpr(flags)} LIKE ?`);
            params.push(normalizedCode);
        }

        where.push(`(${searchClauses.join(' OR ')})`);
    }

    return {
        whereSql: where.join(' AND '),
        params
    };
}

function buildSensorWhereClause(req, flags) {
    const where = [`(u.role IN ('client', 'farmer') OR u.id IS NULL)`];
    const params = [];
    const searchTerm = (req.query.q || '').trim();
    const clientId = req.query.client_id || req.query.clientId;
    const type = req.query.type;

    if (searchTerm) {
        const like = `%${searchTerm}%`;
        const normalizedCode = `%${searchTerm.replace(/^#/, '')}%`;
        const clauses = [
            'd.device_id LIKE ?',
            'd.name LIKE ?',
            's.name LIKE ?',
            's.subtype LIKE ?',
            'u.name LIKE ?'
        ];

        params.push(like, like, like, like, like);

        if (flags.hasClientCode) {
            clauses.push(`${resolvedClientCodeExpr(flags)} LIKE ?`);
            params.push(normalizedCode);
        }

        where.push(`(${clauses.join(' OR ')})`);
    }

    if (clientId) {
        where.push('u.id = ?');
        params.push(clientId);
    }

    if (type && VALID_SENSOR_TYPES.has(type)) {
        where.push('s.type = ?');
        params.push(type);
    }

    return {
        whereSql: where.join(' AND '),
        params
    };
}

function buildDeviceWhereClause(req, flags) {
    const where = [`(u.role IN ('client', 'farmer') OR u.id IS NULL)`];
    const params = [];
    const searchTerm = (req.query.q || '').trim();
    const clientId = req.query.client_id || req.query.clientId;
    const type = req.query.type;
    const status = String(req.query.status || '').trim();

    if (searchTerm) {
        const like = `%${searchTerm}%`;
        const normalizedCode = `%${searchTerm.replace(/^#/, '')}%`;
        const clauses = [
            'd.device_id LIKE ?',
            'd.name LIKE ?',
            'u.name LIKE ?'
        ];
        params.push(like, like, like);

        if (flags.hasClientCode) {
            clauses.push(`${resolvedClientCodeExpr(flags)} LIKE ?`);
            params.push(normalizedCode);
        }

        where.push(`(${clauses.join(' OR ')})`);
    }

    if (clientId) {
        where.push('d.user_id = ?');
        params.push(clientId);
    }

    if (type && VALID_SENSOR_TYPES.has(type)) {
        where.push('(sm.primary_type = ? OR FIND_IN_SET(?, sm.sensor_types))');
        params.push(type, type);
    }

    if (status === 'unassigned') {
        where.push(isDeviceManagerPhase2Enabled()
            ? 'd.user_id IS NULL'
            : `(d.user_id IS NULL OR d.status = 'unassigned')`);
    } else if (['active', 'inactive', 'error'].includes(status)) {
        where.push('d.status = ?');
        params.push(status);
    }

    return {
        whereSql: where.join(' AND '),
        params
    };
}

async function getNextClientCode(flags) {
    if (!flags.hasClientCode) {
        return null;
    }

    const [row] = await query(
        `SELECT COALESCE(MAX(
            CASE
                WHEN client_code REGEXP '^[0-9]+$' THEN CAST(client_code AS UNSIGNED)
                ELSE 0
            END
         ), 0) AS max_code
         FROM users
         WHERE role IN ('client', 'farmer')
           ${flags.hasOwnerUserId ? 'AND owner_user_id IS NULL' : ''}`
    );

    const nextCodeNum = Number(row?.max_code || 0) + 1;

    return String(nextCodeNum).padStart(4, '0');
}

async function createManagedDevice({ serialNumber, type, clientId, deviceName }, connection) {
    const executor = createExecutor(connection);
    const cleanSerial = String(serialNumber || '').trim();

    if (!cleanSerial) {
        throw createHttpError(400, 'Numero seriale obbligatorio');
    }
    if (!VALID_SENSOR_TYPES.has(type)) {
        throw createHttpError(400, 'Tipo sensore non valido');
    }

    await ensureClientExists(clientId, executor);
    await lockDeviceSerial(executor, cleanSerial);

    const existingDevices = await executor(
        `SELECT id, api_key
         FROM devices
         WHERE device_id = ?
         LIMIT 1`,
        [cleanSerial]
    );

    if (existingDevices.length) {
        const existingDevice = existingDevices[0];
        await executor(
            `UPDATE devices
             SET user_id = ?,
                 status = ?,
                 name = COALESCE(NULLIF(name, ''), ?),
                 updated_at = NOW()
             WHERE id = ?`,
            [
                clientId || null,
                clientId ? 'active' : 'unassigned',
                deviceName || buildDeviceName(cleanSerial, type),
                existingDevice.id
            ]
        );
        await syncPrimarySensorForDevice(existingDevice.id, type, connection);

        return {
            id: existingDevice.id,
            apiKey: existingDevice.api_key
        };
    }

    const apiKey = crypto.randomBytes(24).toString('hex');
    const profile = getSensorProfile(type);
    const metadata = JSON.stringify({
        created_from: 'admin_panel',
        primary_type: type
    });

    const deviceResult = await executor(
        `INSERT INTO devices (device_id, user_id, name, api_key, status, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            cleanSerial,
            clientId || null,
            deviceName || buildDeviceName(cleanSerial, type),
            apiKey,
            clientId ? 'inactive' : 'unassigned',
            metadata
        ]
    );

    await executor(
        `INSERT INTO sensors (device_id, type, subtype, name, unit, enabled)
         VALUES (?, ?, ?, ?, ?, TRUE)`,
        [deviceResult.insertId, type, profile.subtype, profile.name, profile.unit]
    );

    return {
        id: deviceResult.insertId,
        apiKey
    };
}

async function syncPrimarySensorForDevice(deviceId, type, connection) {
    const executor = createExecutor(connection);
    const profile = getSensorProfile(type);
    const sensors = await executor(
        `SELECT id, type
         FROM sensors
         WHERE device_id = ?
         ORDER BY id ASC`,
        [deviceId]
    );

    if (!sensors.length) {
        await executor(
            `INSERT INTO sensors (device_id, type, subtype, name, unit, enabled)
             VALUES (?, ?, ?, ?, ?, TRUE)`,
            [deviceId, type, profile.subtype, profile.name, profile.unit]
        );
        return;
    }

    if (sensors.some((sensor) => sensor.type === type)) {
        return;
    }

    await executor(
        `UPDATE sensors
         SET type = ?,
             subtype = ?,
             name = ?,
             unit = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [type, profile.subtype, profile.name, profile.unit, sensors[0].id]
    );
}

// ─── Role Middleware ───────────────────────────────────────────────────────────

async function resolveAdminFromToken(token) {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const tokenRole = normalizeAdminRole(decoded.role);

    if (!isPrivilegedAdminRole(tokenRole)) {
        throw createHttpError(403, 'Accesso negato. Accesso riservato agli amministratori.', 'admin_access_denied');
    }

    const rows = await query(
        'SELECT id, email, name, role, active FROM users WHERE id = ?',
        [decoded.id]
    );

    if (!rows.length || !rows[0].active) {
        throw createHttpError(401, 'Utente non trovato o disattivato', 'admin_session_invalid');
    }

    const user = rows[0];
    const normalizedRole = normalizeAdminRole(user.role);
    if (!isPrivilegedAdminRole(normalizedRole)) {
        throw createHttpError(403, 'Accesso negato. Accesso riservato agli amministratori.', 'admin_access_denied');
    }
    if (normalizedRole !== tokenRole) {
        throw createHttpError(403, 'Ruolo admin non coerente con la sessione corrente.', 'admin_session_invalid');
    }

    return { ...user, role: normalizedRole, originalRole: user.role };
}

const isAdminRole = async (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) {
        return sendAdminError(res, 401, 'Token mancante', 'admin_session_missing');
    }

    try {
        req.adminUser = await resolveAdminFromToken(token);
        next();
    } catch (error) {
        const databaseResponse = buildDatabaseUnavailableResponse(error, {
            message: 'Servizio amministrazione temporaneamente non disponibile'
        });
        if (databaseResponse) {
            return res.status(databaseResponse.statusCode).json(databaseResponse.body);
        }
        const statusCode = error.statusCode || 403;
        return sendAdminError(
            res,
            statusCode,
            error.message || 'Token non valido o scaduto',
            error.errorCode || (statusCode === 401 ? 'admin_session_missing' : 'admin_session_invalid')
        );
    }
};

const isSuperAdmin = (req, res, next) => {
    if (req.adminUser && req.adminUser.role === 'super_admin') {
        return next();
    }
    return sendAdminError(res, 403, 'Accesso riservato al Super Admin.', 'admin_super_required');
};

async function buildAdminHealthPayload() { // RAYAT-FIX
    const health = await getDatabaseHealth(); // RAYAT-FIX
    const mqttConfig = getMqttConfig(); // RAYAT-FIX
    const alertMonitoring = await getMissingDataAlertRuntimeStatus({ forceRefresh: true }); // RAYAT-FIX
    const mqttRuntime = getMqttRuntimeStatus(); // RAYAT-FIX

    return { // RAYAT-FIX
        ...health, // RAYAT-FIX
        app: 'ok', // RAYAT-FIX
        uptimeSeconds: Math.floor(process.uptime()), // RAYAT-FIX
        features: {
            deviceManagerPhase2: isDeviceManagerPhase2Enabled()
        },
        alertMonitoring, // RAYAT-FIX
        mqttDirect: { // RAYAT-FIX
            enabled: mqttConfig.enabled, // RAYAT-FIX
            brokerConfigured: Boolean(mqttConfig.brokerUrl), // RAYAT-FIX
            topic: mqttConfig.topic, // RAYAT-FIX
            runtime: mqttRuntime // RAYAT-FIX
        } // RAYAT-FIX
    }; // RAYAT-FIX
} // RAYAT-FIX

router.get('/health', isAdminRole, async (_req, res) => { // RAYAT-FIX
    try { // RAYAT-FIX
        const payload = await buildAdminHealthPayload(); // RAYAT-FIX
        res.status(payload.db === 'ok' ? 200 : 503).json(payload); // RAYAT-FIX
    } catch (error) { // RAYAT-FIX
        console.error('Admin health error:', error); // RAYAT-FIX
        return sendAdminOperationalError(res, error); // RAYAT-FIX
    } // RAYAT-FIX
}); // RAYAT-FIX

// ─── DEVICE MANAGER PHASE 2 CATALOGS ─────────────────────────────────────────

router.get('/sensor-models', requireDeviceManagerPhase2, isAdminRole, async (req, res) => {
    try {
        const { page, pageSize, offset } = parsePagination(req, 25);
        const where = ['1 = 1'];
        const params = [];
        const active = parseActiveFilter(req.query.active);
        const type = cleanCatalogText(req.query.type);
        const searchTerm = cleanCatalogText(req.query.q);

        if (active !== null) {
            where.push('active = ?');
            params.push(active);
        }
        if (type) {
            if (!VALID_SENSOR_TYPES.has(type)) {
                return sendAdminError(res, 400, 'Tipo sensore non valido');
            }
            where.push('primary_type = ?');
            params.push(type);
        }
        if (searchTerm) {
            const like = `%${searchTerm}%`;
            where.push('(slug LIKE ? OR name LIKE ? OR COALESCE(manufacturer, \'\') LIKE ? OR labels::text LIKE ?)');
            params.push(like, like, like, like);
        }

        const whereSql = where.join(' AND ');
        const [countRow] = await query(
            `SELECT COUNT(*) AS total
             FROM sensor_models
             WHERE ${whereSql}`,
            params
        );
        const rows = await query(
            `SELECT id,
                    slug,
                    version,
                    name,
                    manufacturer,
                    primary_type,
                    labels,
                    jsonb_array_length(parameters) AS parameters_count,
                    notes,
                    active,
                    created_by,
                    created_at,
                    updated_at
             FROM sensor_models
             WHERE ${whereSql}
             ORDER BY active DESC, name ASC, id ASC
             LIMIT ${offset}, ${pageSize}`,
            params
        );

        res.json({
            success: true,
            data: rows.map((row) => serializeSensorModel(row)),
            pagination: buildPaginationMeta(Number(countRow?.total || 0), page, pageSize)
        });
    } catch (error) {
        if (error.statusCode) {
            return sendAdminError(res, error.statusCode, error.message);
        }
        console.error('Get sensor models error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore nel recupero catalogo sensori'
        });
    }
});

router.get('/sensor-models/:id', requireDeviceManagerPhase2, isAdminRole, async (req, res) => {
    try {
        const modelId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(modelId) || modelId <= 0) {
            return sendAdminError(res, 400, 'ID modello non valido');
        }

        const rows = await query(
            `SELECT id,
                    slug,
                    version,
                    name,
                    manufacturer,
                    primary_type,
                    labels,
                    parameters,
                    notes,
                    active,
                    created_by,
                    created_at,
                    updated_at
             FROM sensor_models
             WHERE id = ?
             LIMIT 1`,
            [modelId]
        );

        if (!rows.length) {
            return sendAdminError(res, 404, 'Modello sensore non trovato');
        }

        res.json({
            success: true,
            data: serializeSensorModel(rows[0], { includeParameters: true })
        });
    } catch (error) {
        console.error('Get sensor model detail error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore nel recupero modello sensore'
        });
    }
});

router.post('/sensor-models', requireDeviceManagerPhase2, isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const payload = validateSensorModelPayload(req.body || {});
        const result = await query(
            `INSERT INTO sensor_models (
                 slug,
                 version,
                 name,
                 manufacturer,
                 primary_type,
                 labels,
                 parameters,
                 notes,
                 active,
                 created_by,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, NOW(), NOW())`,
            [
                payload.slug,
                payload.version,
                payload.name,
                payload.manufacturer,
                payload.primaryType,
                JSON.stringify(payload.labels),
                JSON.stringify(payload.parameters),
                payload.notes,
                payload.active,
                req.adminUser.id
            ]
        );

        res.status(201).json({
            success: true,
            id: result.insertId,
            message: 'Modello sensore creato'
        });
    } catch (error) {
        if (error.statusCode) {
            return sendAdminError(res, error.statusCode, error.message);
        }
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return sendAdminError(res, 409, 'Modello sensore già esistente');
        }
        console.error('Create sensor model error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore durante la creazione del modello sensore'
        });
    }
});

router.put('/sensor-models/:id', requireDeviceManagerPhase2, isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const modelId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(modelId) || modelId <= 0) {
            return sendAdminError(res, 400, 'ID modello non valido');
        }

        const payload = validateSensorModelPayload(req.body || {});
        const existingRows = await query(
            `SELECT id, parameters
             FROM sensor_models
             WHERE id = ?
             LIMIT 1`,
            [modelId]
        );
        if (!existingRows.length) {
            return sendAdminError(res, 404, 'Modello sensore non trovato');
        }

        const existingParameters = parseJsonColumn(existingRows[0].parameters, []);
        if (stableStringify(existingParameters) !== stableStringify(payload.parameters)) {
            const usedRows = await query(
                `SELECT id
                 FROM devices
                 WHERE metadata->>'sensor_model_id' = ?
                    OR metadata->'assignment'->>'sensor_model_id' = ?
                 LIMIT 1`,
                [String(modelId), String(modelId)]
            );
            if (usedRows.length) {
                return sendAdminError(
                    res,
                    409,
                    'Il modello è già usato da almeno un device: crea una nuova versione invece di sovrascrivere la mappa registri.'
                );
            }
        }

        await query(
            `UPDATE sensor_models
             SET slug = ?,
                 version = ?,
                 name = ?,
                 manufacturer = ?,
                 primary_type = ?,
                 labels = ?::jsonb,
                 parameters = ?::jsonb,
                 notes = ?,
                 active = ?,
                 updated_at = NOW()
             WHERE id = ?`,
            [
                payload.slug,
                payload.version,
                payload.name,
                payload.manufacturer,
                payload.primaryType,
                JSON.stringify(payload.labels),
                JSON.stringify(payload.parameters),
                payload.notes,
                payload.active,
                modelId
            ]
        );

        res.json({
            success: true,
            message: 'Modello sensore aggiornato'
        });
    } catch (error) {
        if (error.statusCode) {
            return sendAdminError(res, error.statusCode, error.message);
        }
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return sendAdminError(res, 409, 'Slug/versione già esistenti');
        }
        console.error('Update sensor model error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore durante l\'aggiornamento del modello sensore'
        });
    }
});

router.get('/crop-profiles', requireDeviceManagerPhase2, isAdminRole, async (req, res) => {
    try {
        const { page, pageSize, offset } = parsePagination(req, 25);
        const where = ['1 = 1'];
        const params = [];
        const active = parseActiveFilter(req.query.active);
        const searchTerm = cleanCatalogText(req.query.q);

        if (active !== null) {
            where.push('active = ?');
            params.push(active);
        }
        if (searchTerm) {
            const like = `%${searchTerm}%`;
            where.push('(slug LIKE ? OR crop_key LIKE ? OR COALESCE(medium, \'\') LIKE ? OR labels::text LIKE ?)');
            params.push(like, like, like, like);
        }

        const whereSql = where.join(' AND ');
        const [countRow] = await query(
            `SELECT COUNT(*) AS total
             FROM crop_profiles
             WHERE ${whereSql}`,
            params
        );
        const rows = await query(
            `SELECT id,
                    slug,
                    version,
                    crop_key,
                    medium,
                    labels,
                    description,
                    ranges,
                    active,
                    created_by,
                    created_at,
                    updated_at
             FROM crop_profiles
             WHERE ${whereSql}
             ORDER BY active DESC, crop_key ASC, id ASC
             LIMIT ${offset}, ${pageSize}`,
            params
        );

        res.json({
            success: true,
            data: rows.map((row) => serializeCropProfile(row)),
            pagination: buildPaginationMeta(Number(countRow?.total || 0), page, pageSize)
        });
    } catch (error) {
        if (error.statusCode) {
            return sendAdminError(res, error.statusCode, error.message);
        }
        console.error('Get crop profiles error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore nel recupero catalogo colture'
        });
    }
});

router.post('/crop-profiles', requireDeviceManagerPhase2, isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const payload = validateCropProfilePayload(req.body || {});
        const result = await query(
            `INSERT INTO crop_profiles (
                 slug,
                 version,
                 crop_key,
                 medium,
                 labels,
                 description,
                 ranges,
                 active,
                 created_by,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, NOW(), NOW())`,
            [
                payload.slug,
                payload.version,
                payload.cropKey,
                payload.medium,
                JSON.stringify(payload.labels),
                JSON.stringify(payload.description),
                JSON.stringify(payload.ranges),
                payload.active,
                req.adminUser.id
            ]
        );

        res.status(201).json({
            success: true,
            id: result.insertId,
            message: 'Profilo coltura creato'
        });
    } catch (error) {
        if (error.statusCode) {
            return sendAdminError(res, error.statusCode, error.message);
        }
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return sendAdminError(res, 409, 'Profilo coltura già esistente');
        }
        console.error('Create crop profile error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore durante la creazione del profilo coltura'
        });
    }
});

router.put('/crop-profiles/:id', requireDeviceManagerPhase2, isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const profileId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(profileId) || profileId <= 0) {
            return sendAdminError(res, 400, 'ID profilo non valido');
        }

        const payload = validateCropProfilePayload(req.body || {});
        const existingRows = await query(
            `SELECT id
             FROM crop_profiles
             WHERE id = ?
             LIMIT 1`,
            [profileId]
        );
        if (!existingRows.length) {
            return sendAdminError(res, 404, 'Profilo coltura non trovato');
        }

        await query(
            `UPDATE crop_profiles
             SET slug = ?,
                 version = ?,
                 crop_key = ?,
                 medium = ?,
                 labels = ?::jsonb,
                 description = ?::jsonb,
                 ranges = ?::jsonb,
                 active = ?,
                 updated_at = NOW()
             WHERE id = ?`,
            [
                payload.slug,
                payload.version,
                payload.cropKey,
                payload.medium,
                JSON.stringify(payload.labels),
                JSON.stringify(payload.description),
                JSON.stringify(payload.ranges),
                payload.active,
                profileId
            ]
        );

        res.json({
            success: true,
            message: 'Profilo coltura aggiornato'
        });
    } catch (error) {
        if (error.statusCode) {
            return sendAdminError(res, error.statusCode, error.message);
        }
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return sendAdminError(res, 409, 'Slug/versione già esistenti');
        }
        console.error('Update crop profile error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore durante l\'aggiornamento del profilo coltura'
        });
    }
});

// ─── AUTH ──────────────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '').trim();
        if (!email || !password) {
            return sendAdminError(res, 400, 'Email e password obbligatori', 'admin_credentials_required');
        }

        const rows = await query('SELECT * FROM users WHERE email = ?', [email]);
        if (!rows.length) {
            return sendAdminError(res, 401, 'Credenziali non valide', 'admin_invalid_credentials');
        }

        const user = rows[0];
        const normalizedRole = normalizeAdminRole(user.role);

        if (!isPrivilegedAdminRole(normalizedRole)) {
            return sendAdminError(res, 403, 'Accesso negato. Account non amministratore.', 'admin_account_required');
        }
        if (!user.active) {
            return sendAdminError(res, 403, 'Account disattivato.', 'admin_account_disabled');
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return sendAdminError(res, 401, 'Credenziali non valide', 'admin_invalid_credentials');
        }

        const token = signAdminToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: normalizedRole
        });

        res.cookie(
            ADMIN_SESSION_COOKIE,
            token,
            getAdminSessionCookieOptions(req)
        );

        res.json({
            success: true,
            token,
            features: {
                deviceManagerPhase2: isDeviceManagerPhase2Enabled()
            },
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: normalizedRole
            }
        });
    } catch (error) {
        console.error('Admin login error:', error);
        return sendAdminOperationalError(res, error);
    }
});

router.get('/session', async (req, res) => {
    try {
        const cookieToken = extractAdminSessionToken(req);
        const bearerToken = extractBearerToken(req);
        const sessionCandidates = [cookieToken];
        if (bearerToken && bearerToken !== cookieToken) {
            sessionCandidates.push(bearerToken);
        }

        const activeToken = sessionCandidates.find(Boolean);
        if (!activeToken) {
            return sendAdminError(res, 401, 'Sessione admin non trovata', 'admin_session_missing');
        }

        let adminUser = null;
        let resolvedWithToken = null;
        let lastError = null;

        for (const candidate of sessionCandidates.filter(Boolean)) {
            try {
                adminUser = await resolveAdminFromToken(candidate);
                resolvedWithToken = candidate;
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (!adminUser || !resolvedWithToken) {
            throw lastError || createHttpError(403, 'Sessione admin non valida', 'admin_session_invalid');
        }

        let nextToken = resolvedWithToken;
        if (!cookieToken || bearerToken) {
            nextToken = signAdminToken(adminUser);
            res.cookie(
                ADMIN_SESSION_COOKIE,
                nextToken,
                getAdminSessionCookieOptions(req)
            );
        }

        res.json({
            success: true,
            token: nextToken,
            features: {
                deviceManagerPhase2: isDeviceManagerPhase2Enabled()
            },
            user: {
                id: adminUser.id,
                email: adminUser.email,
                name: adminUser.name,
                role: adminUser.role
            }
        });
    } catch (error) {
        clearAdminSessionCookie(res, req);
        const databaseResponse = buildDatabaseUnavailableResponse(error, {
            message: 'Servizio amministrazione temporaneamente non disponibile'
        });
        if (databaseResponse) {
            return res.status(databaseResponse.statusCode).json(databaseResponse.body);
        }
        sendAdminError(
            res,
            error.statusCode || 403,
            error.message || 'Sessione admin non valida',
            error.errorCode || 'admin_session_invalid'
        );
    }
});

router.post('/logout', async (req, res) => {
    clearAdminSessionCookie(res, req);
    res.json({ success: true });
});

// ─── STATS ─────────────────────────────────────────────────────────────────────

router.get('/stats', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const offlineIntervalLiteral = getPostgresMinuteIntervalLiteral(getOfflineAfterMinutes());
        const [clientCount] = await query(
            `SELECT COUNT(*) AS count
             FROM users
             WHERE role IN ('client','farmer')
               AND ${buildPrimaryClientPredicate(flags, 'users')}
               AND ${buildConfirmedClientPredicate(flags, 'users')}`
        );
        const [deviceCount] = await query('SELECT COUNT(*) AS count FROM devices');
        const [onlineDevices] = await query(
            `SELECT COUNT(*) AS count
             FROM devices
             WHERE last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}'`
        );
        const [sensorCount] = await query('SELECT COUNT(*) AS count FROM sensors WHERE enabled = 1');
        const [latestReading] = await query('SELECT MAX(updated_at) AS last FROM sensor_latest');
        const [adminCount] = await query(
            `SELECT COUNT(*) AS count
             FROM users
             WHERE role IN ('super_admin','operator_admin','operator','admin')`
        );
        let newRegistrations = { count: 0 };
        const whereSource = flags.hasRegistrationSource ? "AND registration_source = 'public'" : '';
        const wherePending = flags.hasRegistrationStatus
            ? "AND registration_status = 'new'"
            : 'AND active = FALSE';
        [newRegistrations] = await query(
            `SELECT COUNT(*) AS count
             FROM users
             WHERE role IN ('client','farmer')
               AND ${buildPrimaryClientPredicate(flags, 'users')}
               ${whereSource}
               ${wherePending}`
        );

        res.json({
            success: true,
            data: {
                totalClients: clientCount.count,
                totalDevices: deviceCount.count,
                onlineDevices: onlineDevices.count,
                totalSensors: sensorCount.count,
                lastSensorUpdate: latestReading.last,
                totalAdmins: adminCount.count,
                newRegistrations: newRegistrations.count
            }
        });
    } catch (error) {
        console.error('Admin stats error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore nel recupero statistiche',
            databaseMessage: 'Statistiche amministrazione temporaneamente non disponibili'
        });
    }
});

// RAYAT FIX - analytics followup
router.get('/analytics/summary', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const data = await buildAnalyticsSummary();
        if (process.env.NODE_ENV !== 'test') {
            console.info('[analytics] summary served', {
                adminId: req.adminUser?.id || null,
                role: req.adminUser?.role || null
            });
        }
        res.json({
            success: true,
            data
        });
    } catch (error) {
        console.error('Get analytics summary error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore nel recupero analytics',
            databaseMessage: 'Analytics amministrazione temporaneamente non disponibili'
        });
    }
});

// ─── CLIENTS ───────────────────────────────────────────────────────────────────

router.get('/clients', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const searchTerm = (req.query.q || '').trim();
        const { page, pageSize, offset } = parsePagination(req, 25);
        const { whereSql, params } = buildClientWhereClause(searchTerm, flags);

        const [countRow] = await query(
            `SELECT COUNT(*) AS total
             FROM users u
             WHERE ${whereSql}`,
            params
        );

        const clients = await query(
            `SELECT
                u.id,
                u.name,
                ${optionalUserSelect(flags, 'last_name')},
                u.email,
                u.phone,
                u.crop_type,
                u.location_name,
                ${optionalUserSelect(flags, 'location_address')},
                u.latitude,
                u.longitude,
                u.active,
                u.created_at,
                u.role,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                ${optionalUserSelect(flags, 'payment_status')},
                ${optionalUserSelect(flags, 'payment_date')},
                ${optionalUserSelect(flags, 'subscription_expiry')},
                ${optionalUserSelect(flags, 'registration_status')},
                ${optionalUserSelect(flags, 'registration_source')},
                ${optionalUserSelect(flags, 'approved_at')},
                COALESCE(dc.device_count, 0) AS device_count
             FROM users u
             LEFT JOIN (
                SELECT user_id, COUNT(*) AS device_count
                FROM devices
                GROUP BY user_id
             ) dc ON dc.user_id = u.id
             WHERE ${whereSql}
             ORDER BY u.created_at DESC, u.id DESC
             LIMIT ${offset}, ${pageSize}`,
            params
        );

        res.json({
            success: true,
            data: clients,
            pagination: buildPaginationMeta(countRow.total, page, pageSize)
        });
    } catch (error) {
        console.error('Get clients error:', error);
        res.status(500).json({ error: 'Errore nel recupero clienti' });
    }
});

router.get('/clients/:id', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const [client] = await query(
            `SELECT
                u.id,
                u.name,
                ${optionalUserSelect(flags, 'last_name')},
                u.email,
                u.phone,
                u.crop_type,
                u.location_name,
                ${optionalUserSelect(flags, 'location_address')},
                u.latitude,
                u.longitude,
                u.active,
                u.created_at,
                u.role,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                ${optionalUserSelect(flags, 'payment_status')},
                ${optionalUserSelect(flags, 'payment_date')},
                ${optionalUserSelect(flags, 'subscription_expiry')},
                ${optionalUserSelect(flags, 'registration_status')},
                ${optionalUserSelect(flags, 'registration_source')},
                ${optionalUserSelect(flags, 'approved_at')},
                COALESCE(dc.device_count, 0) AS device_count
             FROM users u
             LEFT JOIN (
                SELECT user_id, COUNT(*) AS device_count
                FROM devices
                GROUP BY user_id
             ) dc ON dc.user_id = u.id
             WHERE u.id = ?
               AND u.role IN ('client','farmer')
               AND ${buildPrimaryClientPredicate(flags)}
               AND ${buildConfirmedClientPredicate(flags)}`,
            [req.params.id]
        );

        if (!client) {
            return res.status(404).json({ error: 'Cliente non trovato' });
        }

        res.json({ success: true, data: client });
    } catch (error) {
        console.error('Get client error:', error);
        res.status(500).json({ error: 'Errore nel recupero cliente' });
    }
});

router.post('/clients', isAdminRole, async (req, res) => {
    try {
        const { firstName, lastName } = normalizeManagedNameParts(req.body);
        const {
            email,
            phone,
            password,
            crop_type,
            payment_status,
            payment_date,
            subscription_expiry
        } = req.body;
        const {
            locationName,
            locationAddress,
            latitude,
            longitude
        } = normalizeLocationFields(req.body);

        if (!firstName || !phone || !password) {
            return res.status(400).json({ error: 'Nome, telefono e password sono obbligatori' });
        }

        if (email) {
            const existing = await query('SELECT id FROM users WHERE email = ?', [email]);
            if (existing.length > 0) {
                return res.status(409).json({ error: 'Email già registrata' });
            }
        }
        if (phone) {
            const existingPhone = await query('SELECT id FROM users WHERE phone = ?', [phone]);
            if (existingPhone.length > 0) {
                return res.status(409).json({ error: 'Numero di telefono già registrato' });
            }
        }

        const flags = await getUserColumnFlags();
        const clientCode = await getNextClientCode(flags);
        const passwordHash = await bcrypt.hash(password, 10);

        const columns = [
            'name',
            ...(flags.hasLastName ? ['last_name'] : []),
            'email',
            'phone',
            'password_hash',
            'crop_type',
            'location_name',
            'latitude',
            'longitude',
            'is_verified',
            'active',
            'role'
        ];
        const values = [
            firstName,
            ...(flags.hasLastName ? [lastName || null] : []),
            email || null,
            phone,
            passwordHash,
            crop_type || null,
            locationName,
            latitude,
            longitude,
            true,
            true,
            'client'
        ];

        if (flags.hasLocationAddress) {
            columns.push('location_address');
            values.push(locationAddress);
        }
        if (flags.hasOwnerUserId) {
            columns.push('owner_user_id');
            values.push(null);
        }
        if (flags.hasCustomerRole) {
            columns.push('customer_role');
            values.push('owner');
        }
        if (flags.hasClientCode) {
            columns.push('client_code');
            values.push(clientCode);
        }
        if (flags.hasPaymentStatus) {
            columns.push('payment_status');
            values.push(payment_status || 'non_pagato');
        }
        if (flags.hasPaymentDate) {
            columns.push('payment_date');
            values.push(payment_status === 'pagato' ? payment_date || null : null);
        }
        if (flags.hasSubscriptionExpiry) {
            columns.push('subscription_expiry');
            values.push(payment_status === 'pagato' ? subscription_expiry || null : null);
        }
        if (flags.hasRegistrationStatus) {
            columns.push('registration_status');
            values.push('active');
        }
        if (flags.hasRegistrationSource) {
            columns.push('registration_source');
            values.push('admin');
        }
        if (flags.hasApprovedAt) {
            columns.push('approved_at');
            values.push(new Date());
        }

        const placeholders = columns.map(() => '?').join(', ');
        const result = await query(
            `INSERT INTO users (${columns.join(', ')})
             VALUES (${placeholders})`,
            values
        );

        res.status(201).json({
            success: true,
            message: 'Cliente creato',
            id: result.insertId,
            client_code: clientCode
        });
    } catch (error) {
        console.error('Create client error:', error);
        res.status(500).json({ error: 'Errore durante la creazione del cliente' });
    }
});

router.put('/clients/:id', isAdminRole, async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const { firstName, lastName } = normalizeManagedNameParts(req.body);
        const hasManagedName = Object.prototype.hasOwnProperty.call(req.body, 'name')
            || Object.prototype.hasOwnProperty.call(req.body, 'first_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'last_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'lastName')
            || Object.prototype.hasOwnProperty.call(req.body, 'surname');
        const {
            email,
            phone,
            crop_type,
            active,
            payment_status,
            payment_date,
            subscription_expiry
        } = req.body;
        const {
            locationName,
            locationAddress,
            latitude,
            longitude
        } = normalizeLocationFields(req.body);
        const flags = await getUserColumnFlags();

        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('client','farmer')
               AND ${buildPrimaryClientPredicate(flags)}
               AND ${buildConfirmedClientPredicate(flags)}`,
            [id]
        );
        if (!existing.length) {
            return res.status(404).json({ error: 'Cliente non trovato' });
        }

        if (email) {
            const duplicate = await query(
                'SELECT id FROM users WHERE email = ? AND id <> ?',
                [email, id]
            );
            if (duplicate.length > 0) {
                return res.status(409).json({ error: 'Email già registrata' });
            }
        }
        if (phone) {
            const duplicatePhone = await query(
                'SELECT id FROM users WHERE phone = ? AND id <> ?',
                [phone, id]
            );
            if (duplicatePhone.length > 0) {
                return res.status(409).json({ error: 'Numero di telefono già registrato' });
            }
        }

        const assignments = [
            'email = ?',
            'phone = COALESCE(?, phone)',
            'crop_type = ?',
            'location_name = ?',
            'latitude = ?',
            'longitude = ?',
            'active = COALESCE(?, active)',
            'updated_at = NOW()'
        ];
        const params = [
            email || null,
            phone || null,
            crop_type || null,
            locationName,
            latitude,
            longitude,
            active === undefined ? null : (active ? 1 : 0)
        ];

        if (hasManagedName) {
            assignments.unshift('name = COALESCE(?, name)');
            params.unshift(firstName || null);
        }

        if (flags.hasLocationAddress) {
            const locationInsertIndex = hasManagedName ? 4 : 3;
            assignments.splice(locationInsertIndex, 0, 'location_address = ?');
            params.splice(locationInsertIndex, 0, locationAddress);
        }
        if (flags.hasLastName && hasManagedName) {
            assignments.splice(1, 0, 'last_name = ?');
            params.splice(1, 0, lastName || null);
        }
        if (flags.hasPaymentStatus) {
            assignments.push('payment_status = COALESCE(?, payment_status)');
            params.push(payment_status || null);
        }
        if (flags.hasPaymentDate) {
            assignments.push('payment_date = ?');
            params.push(payment_status === 'pagato' ? payment_date || null : null);
        }
        if (flags.hasSubscriptionExpiry) {
            assignments.push('subscription_expiry = ?');
            params.push(payment_status === 'pagato' ? subscription_expiry || null : null);
        }
        if (flags.hasRegistrationStatus && req.body.registration_status) {
            assignments.push('registration_status = ?');
            params.push(normalizeRegistrationStatus(req.body.registration_status));
        }
        if (flags.hasApprovedAt && req.body.registration_status) {
            assignments.push('approved_at = ?');
            params.push(
                normalizeRegistrationStatus(req.body.registration_status) === 'active'
                    ? (req.body.approved_at || new Date())
                    : null
            );
        }

        params.push(id);

        await query(
            `UPDATE users
             SET ${assignments.join(', ')}
             WHERE id = ?`,
            params
        );

        res.json({ success: true, message: 'Cliente aggiornato' });
    } catch (error) {
        console.error('Update client error:', error);
        res.status(500).json({ error: 'Errore durante l\'aggiornamento del cliente' });
    }
});

router.delete('/clients/:id', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('client','farmer')
               AND ${buildPrimaryClientPredicate(flags)}
               AND ${buildConfirmedClientPredicate(flags)}`,
            [req.params.id]
        );

        if (!existing.length) {
            return res.status(404).json({ error: 'Cliente non trovato' });
        }

        await query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Cliente eliminato' });
    } catch (error) {
        console.error('Delete client error:', error);
        res.status(500).json({ error: 'Errore durante l\'eliminazione del cliente' });
    }
});

router.get('/clients/:id/team', isAdminRole, async (req, res) => {
    try {
        const clientId = Number.parseInt(req.params.id, 10);
        const flags = await getUserColumnFlags();
        ensureCustomerTeamFeatureAvailable(flags);
        await getPrimaryClientAccount(clientId, flags);

        const members = await query(
            `SELECT ${buildManagedCustomerUserSelect(flags)}
             FROM users u
             WHERE u.role IN ('client', 'farmer')
               AND u.owner_user_id = ?
             ORDER BY u.created_at DESC, u.id DESC`,
            [clientId]
        );

        res.json({
            success: true,
            data: members.map((member) => buildTeamMemberPayload(member, flags))
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Get client team error:', error);
        res.status(500).json({ error: 'Errore nel recupero del team cliente' });
    }
});

router.post('/clients/:id/team', isAdminRole, async (req, res) => {
    try {
        const clientId = Number.parseInt(req.params.id, 10);
        const flags = await getUserColumnFlags();
        ensureCustomerTeamFeatureAvailable(flags);
        const owner = await getPrimaryClientAccount(clientId, flags);
        const { firstName, lastName } = normalizeManagedNameParts(req.body);
        const email = String(req.body.email || '').trim().toLowerCase();
        const phone = String(req.body.phone || '').trim() || null;
        const password = String(req.body.password || '').trim();
        const active = req.body.active === undefined ? true : Boolean(req.body.active);
        const customerRole = normalizeCustomerTeamRole(req.body.customer_role);

        if (!firstName || !email || !password) {
            return res.status(400).json({ error: 'Nome, email e password sono obbligatori' });
        }

        await ensureUniqueManagedCustomerIdentity({ email, phone });

        const passwordHash = await bcrypt.hash(password, 10);
        const columns = [
            'name',
            ...(flags.hasLastName ? ['last_name'] : []),
            'email',
            'phone',
            'password_hash',
            'role',
            'is_verified',
            'active',
            'owner_user_id',
            'customer_role'
        ];
        const values = [
            firstName,
            ...(flags.hasLastName ? [lastName || null] : []),
            email,
            phone,
            passwordHash,
            owner.role,
            true,
            active,
            owner.id,
            customerRole
        ];

        if (flags.hasRegistrationStatus) {
            columns.push('registration_status');
            values.push('active');
        }
        if (flags.hasRegistrationSource) {
            columns.push('registration_source');
            values.push('admin');
        }
        if (flags.hasApprovedAt) {
            columns.push('approved_at');
            values.push(new Date());
        }

        const result = await query(
            `INSERT INTO users (${columns.join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`,
            values
        );

        const member = await getCustomerTeamMember(clientId, result.insertId, flags);

        res.status(201).json({
            success: true,
            message: 'Utente team creato',
            data: buildTeamMemberPayload(member, flags)
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Create client team member error:', error);
        res.status(500).json({ error: 'Errore durante la creazione dell\'utente team' });
    }
});

router.put('/clients/:id/team/:userId', isAdminRole, async (req, res) => {
    try {
        const clientId = Number.parseInt(req.params.id, 10);
        const userId = Number.parseInt(req.params.userId, 10);
        const flags = await getUserColumnFlags();
        ensureCustomerTeamFeatureAvailable(flags);
        await getPrimaryClientAccount(clientId, flags);
        await getCustomerTeamMember(clientId, userId, flags);

        const assignments = ['updated_at = NOW()'];
        const params = [];
        const { firstName, lastName } = normalizeManagedNameParts(req.body);
        const hasManagedName = Object.prototype.hasOwnProperty.call(req.body, 'name')
            || Object.prototype.hasOwnProperty.call(req.body, 'first_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'last_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'lastName')
            || Object.prototype.hasOwnProperty.call(req.body, 'surname');
        const hasEmail = Object.prototype.hasOwnProperty.call(req.body, 'email');
        const hasPhone = Object.prototype.hasOwnProperty.call(req.body, 'phone');
        const hasRole = Object.prototype.hasOwnProperty.call(req.body, 'customer_role');
        const hasActive = Object.prototype.hasOwnProperty.call(req.body, 'active');
        const password = String(req.body.password || '').trim();

        if (hasManagedName) {
            if (!firstName) {
                return res.status(400).json({ error: 'Nome obbligatorio' });
            }
            assignments.unshift('name = ?');
            params.unshift(firstName);
            if (flags.hasLastName) {
                assignments.splice(1, 0, 'last_name = ?');
                params.splice(1, 0, lastName || null);
            }
        }

        if (hasEmail) {
            const email = String(req.body.email || '').trim().toLowerCase();
            if (!email) {
                return res.status(400).json({ error: 'Email obbligatoria' });
            }
            await ensureUniqueManagedCustomerIdentity({ email, excludeId: userId });
            assignments.push('email = ?');
            params.push(email);
        }

        if (hasPhone) {
            const phone = String(req.body.phone || '').trim() || null;
            await ensureUniqueManagedCustomerIdentity({ phone, excludeId: userId });
            assignments.push('phone = ?');
            params.push(phone);
        }

        if (hasRole) {
            assignments.push('customer_role = ?');
            params.push(normalizeCustomerTeamRole(req.body.customer_role));
        }

        if (hasActive) {
            assignments.push('active = ?');
            params.push(Boolean(req.body.active));
        }

        if (password) {
            assignments.push('password_hash = ?');
            params.push(await bcrypt.hash(password, 10));
        }

        params.push(userId, clientId);

        await query(
            `UPDATE users
             SET ${assignments.join(', ')}
             WHERE id = ?
               AND owner_user_id = ?`,
            params
        );

        const member = await getCustomerTeamMember(clientId, userId, flags);

        res.json({
            success: true,
            message: 'Utente team aggiornato',
            data: buildTeamMemberPayload(member, flags)
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Update client team member error:', error);
        res.status(500).json({ error: 'Errore durante l\'aggiornamento dell\'utente team' });
    }
});

router.delete('/clients/:id/team/:userId', isAdminRole, async (req, res) => {
    try {
        const clientId = Number.parseInt(req.params.id, 10);
        const userId = Number.parseInt(req.params.userId, 10);
        const flags = await getUserColumnFlags();
        ensureCustomerTeamFeatureAvailable(flags);
        await getPrimaryClientAccount(clientId, flags);
        await getCustomerTeamMember(clientId, userId, flags);

        await query(
            `DELETE FROM users
             WHERE id = ?
               AND owner_user_id = ?`,
            [userId, clientId]
        );

        res.json({ success: true, message: 'Utente team eliminato' });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Delete client team member error:', error);
        res.status(500).json({ error: 'Errore durante l\'eliminazione dell\'utente team' });
    }
});

// ─── RECENT REGISTRATIONS ─────────────────────────────────────────────────────

router.get('/registrations', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const { page, pageSize, offset } = parsePagination(req, 20);
        const { whereSql, params } = buildRegistrationWhereClause(req, flags);
        const countSql = `SELECT COUNT(*) AS total
             FROM users u
             WHERE ${whereSql}`;
        const registrationsSql = `SELECT
                u.id,
                u.name,
                ${optionalUserSelect(flags, 'last_name')},
                u.email,
                u.phone,
                u.location_name,
                ${optionalUserSelect(flags, 'location_address')},
                u.crop_type,
                u.latitude,
                u.longitude,
                u.active,
                u.created_at,
                u.updated_at,
                u.role,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                ${optionalUserSelect(flags, 'registration_status')},
                ${optionalUserSelect(flags, 'registration_source')},
                ${optionalUserSelect(flags, 'approved_at')},
                COALESCE(dc.device_count, 0) AS device_count
             FROM users u
             LEFT JOIN (
                SELECT user_id, COUNT(*) AS device_count
                FROM devices
                GROUP BY user_id
             ) dc ON dc.user_id = u.id
             WHERE ${whereSql}
             ORDER BY u.created_at DESC, u.id DESC
             LIMIT ${offset}, ${pageSize}`;

        console.info('[admin] registrations request', {
            adminId: req.adminUser?.id || null,
            adminRole: req.adminUser?.role || null,
            query: req.query,
            columns: {
                registration_status: flags.hasRegistrationStatus,
                registration_source: flags.hasRegistrationSource,
                approved_at: flags.hasApprovedAt,
                client_code: flags.hasClientCode
            }
        });
        console.info('[admin] registrations count query', {
            sqlBeforeNormalization: countSql.replace(/\s+/g, ' ').trim(),
            params
        });

        const [countRow] = await query(countSql, params);

        console.info('[admin] registrations data query', {
            sqlBeforeNormalization: registrationsSql.replace(/\s+/g, ' ').trim(),
            params
        });

        const registrations = await query(registrationsSql, params);

        console.info('[admin] registrations result', {
            total: Number(countRow?.total || 0),
            rowCount: registrations.length,
            page,
            pageSize
        });

        res.json({
            success: true,
            data: registrations,
            pagination: buildPaginationMeta(countRow.total, page, pageSize)
        });
    } catch (error) {
        console.error('[admin] Get registrations error', {
            message: error.message,
            stack: error.stack,
            adminId: req.adminUser?.id || null,
            adminRole: req.adminUser?.role || null,
            query: req.query
        });
        res.status(500).json({ error: 'Errore nel recupero delle registrazioni recenti' });
    }
});

router.get('/registrations/:id', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const sourceFilter = flags.hasRegistrationSource ? `AND u.registration_source = 'public'` : '';
        const [registration] = await query(
            `SELECT
                u.id,
                u.name,
                ${optionalUserSelect(flags, 'last_name')},
                u.email,
                u.phone,
                u.location_name,
                ${optionalUserSelect(flags, 'location_address')},
                u.crop_type,
                u.latitude,
                u.longitude,
                u.active,
                u.created_at,
                u.updated_at,
                u.role,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                ${optionalUserSelect(flags, 'registration_status')},
                ${optionalUserSelect(flags, 'registration_source')},
                ${optionalUserSelect(flags, 'approved_at')},
                COALESCE(dc.device_count, 0) AS device_count
             FROM users u
             LEFT JOIN (
                SELECT user_id, COUNT(*) AS device_count
                FROM devices
                GROUP BY user_id
             ) dc ON dc.user_id = u.id
             WHERE u.id = ?
               AND u.role IN ('client','farmer')
               AND ${buildPrimaryClientPredicate(flags)}
               ${sourceFilter}`,
            [req.params.id]
        );

        if (!registration) {
            return res.status(404).json({ error: 'Registrazione non trovata' });
        }

        res.json({ success: true, data: registration });
    } catch (error) {
        console.error('Get registration detail error:', error);
        res.status(500).json({ error: 'Errore nel recupero della registrazione' });
    }
});

router.put('/registrations/:id', isAdminRole, async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const { firstName, lastName } = normalizeManagedNameParts(req.body);
        const hasManagedName = Object.prototype.hasOwnProperty.call(req.body, 'name')
            || Object.prototype.hasOwnProperty.call(req.body, 'first_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'last_name')
            || Object.prototype.hasOwnProperty.call(req.body, 'lastName')
            || Object.prototype.hasOwnProperty.call(req.body, 'surname');
        const {
            email,
            phone,
            crop_type,
            active,
            registration_status
        } = req.body;
        const {
            locationName,
            locationAddress,
            latitude,
            longitude
        } = normalizeLocationFields(req.body);

        const flags = await getUserColumnFlags();
        const sourceFilter = flags.hasRegistrationSource ? `AND registration_source = 'public'` : '';
        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('client','farmer')
               AND ${buildPrimaryClientPredicate(flags)}
               ${sourceFilter}`,
            [id]
        );
        if (!existing.length) {
            return res.status(404).json({ error: 'Registrazione non trovata' });
        }

        if (email) {
            const duplicateEmail = await query(
                'SELECT id FROM users WHERE email = ? AND id <> ?',
                [email, id]
            );
            if (duplicateEmail.length > 0) {
                return res.status(409).json({ error: 'Email già registrata' });
            }
        }
        if (phone) {
            const duplicatePhone = await query(
                'SELECT id FROM users WHERE phone = ? AND id <> ?',
                [phone, id]
            );
            if (duplicatePhone.length > 0) {
                return res.status(409).json({ error: 'Numero di telefono già registrato' });
            }
        }

        const assignments = [
            'email = COALESCE(?, email)',
            'phone = COALESCE(?, phone)',
            'location_name = COALESCE(?, location_name)',
            'crop_type = ?',
            'latitude = ?',
            'longitude = ?',
            'updated_at = NOW()'
        ];
        const params = [
            email || null,
            phone || null,
            locationName,
            crop_type || null,
            latitude,
            longitude
        ];

        if (hasManagedName) {
            assignments.unshift('name = COALESCE(?, name)');
            params.unshift(firstName || null);
        }

        if (flags.hasLocationAddress) {
            const locationInsertIndex = hasManagedName ? 4 : 3;
            assignments.splice(locationInsertIndex, 0, 'location_address = ?');
            params.splice(locationInsertIndex, 0, locationAddress);
        }
        if (flags.hasLastName && hasManagedName) {
            assignments.splice(1, 0, 'last_name = ?');
            params.splice(1, 0, lastName || null);
        }
        if (flags.hasRegistrationStatus && registration_status) {
            const normalizedStatus = normalizeRegistrationStatus(registration_status);
            assignments.push('registration_status = ?');
            params.push(normalizedStatus);
            assignments.push('active = ?');
            params.push(normalizedStatus === 'active');
        } else {
            assignments.push('active = COALESCE(?, active)');
            params.push(active === undefined ? null : (active ? 1 : 0));
        }
        if (flags.hasApprovedAt && registration_status) {
            const normalizedStatus = normalizeRegistrationStatus(registration_status);
            assignments.push('approved_at = ?');
            params.push(normalizedStatus === 'active' ? new Date() : null);
        }

        params.push(id);

        await query(
            `UPDATE users
             SET ${assignments.join(', ')}
             WHERE id = ?`,
            params
        );

        res.json({ success: true, message: 'Registrazione aggiornata' });
    } catch (error) {
        console.error('Update registration error:', error);
        res.status(500).json({ error: 'Errore durante l\'aggiornamento della registrazione' });
    }
});

router.post('/registrations/:id/approve', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const assignments = ['active = 1', 'updated_at = NOW()'];
        if (flags.hasRegistrationStatus) {
            assignments.push(`registration_status = 'active'`);
        }
        if (flags.hasApprovedAt) {
            assignments.push('approved_at = NOW()');
        }

        const sourceFilter = flags.hasRegistrationSource ? `AND registration_source = 'public'` : '';
        const result = await query(
            `UPDATE users
             SET ${assignments.join(', ')}
             WHERE id = ?
               AND role IN ('client','farmer')
               AND ${buildPrimaryClientPredicate(flags)}
               ${sourceFilter}`,
            [req.params.id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Registrazione non trovata' });
        }

        if (process.env.NODE_ENV !== 'test') {
            console.info('[admin] registration approved', {
                registrationId: Number(req.params.id),
                adminId: req.adminUser?.id || null
            });
        }

        res.json({ success: true, message: 'Registrazione approvata' });
    } catch (error) {
        console.error('Approve registration error:', error);
        res.status(500).json({ error: 'Errore durante l\'approvazione della registrazione' });
    }
});

router.delete('/registrations/:id', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const sourceFilter = flags.hasRegistrationSource ? `AND registration_source = 'public'` : '';
        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('client','farmer')
               AND ${buildPrimaryClientPredicate(flags)}
               ${sourceFilter}`,
            [req.params.id]
        );

        if (!existing.length) {
            return res.status(404).json({ error: 'Registrazione non trovata' });
        }

        await query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Registrazione eliminata' });
    } catch (error) {
        console.error('Delete registration error:', error);
        res.status(500).json({ error: 'Errore durante l\'eliminazione della registrazione' });
    }
});

// ─── SENSORS ───────────────────────────────────────────────────────────────────

router.get('/sensors', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const offlineIntervalLiteral = getPostgresMinuteIntervalLiteral(getOfflineAfterMinutes());
        const { page, pageSize, offset } = parsePagination(req, 50);
        const { whereSql, params } = buildSensorWhereClause(req, flags);

        const [countRow] = await query(
            `SELECT COUNT(*) AS total
             FROM sensors s
             INNER JOIN devices d ON s.device_id = d.id
             LEFT JOIN users u ON d.user_id = u.id
             WHERE ${whereSql}`,
            params
        );

        const sensors = await query(
            `SELECT
                s.id AS sensor_id,
                s.type,
                s.subtype,
                s.name AS sensor_name,
                s.unit,
                s.enabled,
                d.id AS device_row_id,
                d.device_id,
                d.name AS device_name,
                CASE WHEN d.user_id IS NULL THEN 'unassigned' ELSE d.status END AS device_status,
                d.last_seen,
                u.id AS client_id,
                u.name AS client_name,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                u.location_name,
                sl.value AS latest_value,
                sl.timestamp AS last_reading,
                CASE
                    WHEN d.last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}' THEN 'online'
                    WHEN d.last_seen IS NULL THEN 'never'
                    ELSE 'offline'
                END AS online_status
             FROM sensors s
             INNER JOIN devices d ON s.device_id = d.id
             LEFT JOIN users u ON d.user_id = u.id
             LEFT JOIN sensor_latest sl ON s.id = sl.sensor_id
             WHERE ${whereSql}
             ORDER BY
                CASE
                    WHEN d.last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}' THEN 0
                    WHEN d.last_seen IS NULL THEN 2
                    ELSE 1
                END,
                d.last_seen DESC,
                s.type ASC,
                s.subtype ASC
             LIMIT ${offset}, ${pageSize}`,
            params
        );

        res.json({
            success: true,
            data: sensors,
            pagination: buildPaginationMeta(countRow.total, page, pageSize)
        });
    } catch (error) {
        console.error('Get sensors error:', error);
        res.status(500).json({ error: 'Errore nel recupero sensori' });
    }
});

// ─── DEVICES ───────────────────────────────────────────────────────────────────

router.get('/devices', isAdminRole, async (req, res) => {
    try {
        const flags = await getUserColumnFlags();
        const offlineIntervalLiteral = getPostgresMinuteIntervalLiteral(getOfflineAfterMinutes());
        const { page, pageSize, offset } = parsePagination(req, 50);
        const { whereSql, params } = buildDeviceWhereClause(req, flags);
        const metricsJoin = `
            LEFT JOIN (
                SELECT
                    s.device_id,
                    COUNT(*) AS sensor_count,
                    MIN(s.type) AS primary_type,
                    GROUP_CONCAT(DISTINCT s.type ORDER BY s.type SEPARATOR ',') AS sensor_types,
                    MAX(sl.timestamp) AS last_reading
                FROM sensors s
                LEFT JOIN sensor_latest sl ON sl.sensor_id = s.id
                WHERE s.enabled = TRUE
                GROUP BY s.device_id
            ) sm ON sm.device_id = d.id
        `;

        const [countRow] = await query(
            `SELECT COUNT(*) AS total
             FROM devices d
             LEFT JOIN users u ON d.user_id = u.id
             ${metricsJoin}
             WHERE ${whereSql}`,
            params
        );

        const devices = await query(
            `SELECT
                d.id,
                d.device_id AS serial_number,
                d.device_id,
                d.name,
                CASE WHEN d.user_id IS NULL THEN 'unassigned' ELSE d.status END AS status,
                d.last_seen,
                d.last_seen AS last_seen_at,
                COALESCE(d.metadata->>'last_seen_ip', d.metadata->>'first_seen_ip') AS last_seen_ip,
                d.created_at,
                d.updated_at,
                d.metadata,
                d.user_id AS client_id,
                u.name AS client_name,
                ${resolvedClientCodeExpr(flags)} AS client_code,
                COALESCE(sm.primary_type, 'clima') AS type,
                sm.sensor_types,
                COALESCE(sm.sensor_count, 0) AS sensor_count,
                sm.last_reading,
                CASE
                    WHEN d.last_seen >= NOW() - INTERVAL '${offlineIntervalLiteral}' THEN 'online'
                    WHEN d.last_seen IS NULL THEN 'never'
                    ELSE 'offline'
                END AS online_status
             FROM devices d
             LEFT JOIN users u ON d.user_id = u.id
             ${metricsJoin}
             WHERE ${whereSql}
             ORDER BY d.created_at DESC, d.id DESC
             LIMIT ${offset}, ${pageSize}`,
            params
        );

        res.json({
            success: true,
            devices,
            data: devices,
            pagination: buildPaginationMeta(countRow.total, page, pageSize)
        });
    } catch (error) {
        console.error('Get devices error:', error);
        res.status(500).json({ error: 'Errore nel recupero dispositivi' });
    }
});

router.post('/devices', isAdminRole, async (req, res) => {
    try {
        const { type, serial_number, client_id } = req.body;

        if (!type || !serial_number) {
            return res.status(400).json({ error: 'Tipo e seriale obbligatori' });
        }
        if (!VALID_SENSOR_TYPES.has(type)) {
            return res.status(400).json({ error: 'Tipo sensore non valido' });
        }

        const created = await withTransaction(async (connection) =>
            createManagedDevice(
                {
                    serialNumber: serial_number,
                    type,
                    clientId: client_id || null
                },
                connection
            )
        );

        res.status(201).json({
            success: true,
            id: created.id,
            api_key: created.apiKey
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return res.status(409).json({ error: 'Seriale già esistente' });
        }
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Create device error:', error);
        res.status(500).json({ error: 'Errore durante la creazione del dispositivo' });
    }
});

router.post('/clients/:id/devices', isAdminRole, async (req, res) => {
    try {
        const { type, serial_number } = req.body;
        const clientId = req.params.id;

        if (!type || !serial_number) {
            return res.status(400).json({ error: 'Tipo e seriale obbligatori' });
        }

        const created = await withTransaction(async (connection) =>
            createManagedDevice(
                {
                    serialNumber: serial_number,
                    type,
                    clientId
                },
                connection
            )
        );

        res.status(201).json({
            success: true,
            id: created.id,
            api_key: created.apiKey
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return res.status(409).json({ error: 'Seriale già esistente' });
        }
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Create device for client error:', error);
        res.status(500).json({ error: 'Errore durante la creazione' });
    }
});

router.post('/devices/:id/assign', requireDeviceManagerPhase2, isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const deviceId = parseRequiredPositiveInteger(req.params.id, 'device_id');
        const payload = validateDeviceAssignmentPayload(req.body || {});

        const result = await withTransaction(async (connection) => {
            const executor = createExecutor(connection);
            const deviceRows = await executor(
                `SELECT id,
                        device_id,
                        user_id,
                        status,
                        metadata,
                        updated_at
                 FROM devices
                 WHERE id = ?
                 FOR UPDATE`,
                [deviceId]
            );

            if (!deviceRows.length) {
                throw createHttpError(404, 'Dispositivo non trovato');
            }

            const device = deviceRows[0];
            if (device.user_id !== null && device.user_id !== undefined) {
                if (isSamePhase2Assignment(device, payload)) {
                    return {
                        success: true,
                        device: serializeAssignedDevice(device),
                        created_sensors: [],
                        already_assigned: true
                    };
                }
                throw createHttpError(409, 'Dispositivo già assegnato');
            }

            await ensureClientExists(payload.clientId, executor);

            const modelRows = await executor(
                `SELECT id,
                        slug,
                        version,
                        name,
                        primary_type,
                        labels,
                        parameters,
                        active
                 FROM sensor_models
                 WHERE id = ?
                 LIMIT 1`,
                [payload.sensorModelId]
            );
            if (!modelRows.length || !isActiveCatalogRow(modelRows[0])) {
                throw createHttpError(404, 'Modello sensore attivo non trovato');
            }

            if (payload.cropProfileId) {
                const cropRows = await executor(
                    `SELECT id, active
                     FROM crop_profiles
                     WHERE id = ?
                     LIMIT 1`,
                    [payload.cropProfileId]
                );
                if (!cropRows.length || !isActiveCatalogRow(cropRows[0])) {
                    throw createHttpError(404, 'Profilo coltura attivo non trovato');
                }
            }

            const model = modelRows[0];
            const parameters = parseJsonColumn(model.parameters, []);
            if (!Array.isArray(parameters) || !parameters.length) {
                throw createHttpError(409, 'Il modello sensore non contiene parametri');
            }

            const metadataPatch = buildDeviceAssignmentMetadataPatch(device, payload, req.adminUser);
            await executor(
                `UPDATE devices
                 SET user_id = ?,
                     status = 'active',
                     metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb,
                     updated_at = NOW()
                 WHERE id = ?`,
                [
                    payload.clientId,
                    JSON.stringify(metadataPatch),
                    deviceId
                ]
            );

            const createdSensors = [];
            const orderedParameters = parameters
                .slice()
                .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

            for (const parameter of orderedParameters) {
                const sensor = buildSensorFromModelParameter(parameter, model.primary_type);
                const existingSensors = await executor(
                    `SELECT id
                     FROM sensors
                     WHERE device_id = ?
                       AND type = ?
                       AND subtype = ?
                     LIMIT 1`,
                    [deviceId, sensor.type, sensor.subtype]
                );
                if (existingSensors.length) {
                    continue;
                }

                const sensorResult = await executor(
                    `INSERT INTO sensors (device_id, type, subtype, name, unit, enabled)
                     VALUES (?, ?, ?, ?, ?, TRUE)`,
                    [deviceId, sensor.type, sensor.subtype, sensor.name, sensor.unit]
                );
                createdSensors.push({
                    id: sensorResult.insertId || null,
                    device_id: deviceId,
                    type: sensor.type,
                    subtype: sensor.subtype,
                    name: sensor.name,
                    unit: sensor.unit
                });
            }

            const updatedRows = await executor(
                `SELECT id,
                        device_id,
                        user_id,
                        status,
                        metadata,
                        updated_at
                 FROM devices
                 WHERE id = ?
                 LIMIT 1`,
                [deviceId]
            );

            return {
                success: true,
                device: serializeAssignedDevice(updatedRows[0] || {
                    ...device,
                    user_id: payload.clientId,
                    status: 'active',
                    metadata: metadataPatch
                }),
                created_sensors: createdSensors,
                already_assigned: false
            };
        });

        return res.json(result);
    } catch (error) {
        if (error.statusCode) {
            return sendAdminError(res, error.statusCode, error.message);
        }
        console.error('Assign device error:', error);
        return sendAdminOperationalError(res, error, {
            fallbackMessage: 'Errore durante l\'assegnazione del dispositivo'
        });
    }
});

router.put('/devices/:id', isAdminRole, async (req, res) => {
    try {
        const { serial_number, type, client_id } = req.body;
        const deviceId = Number.parseInt(req.params.id, 10);

        if (!serial_number || !type) {
            return res.status(400).json({ error: 'Seriale e tipo obbligatori' });
        }
        if (!VALID_SENSOR_TYPES.has(type)) {
            return res.status(400).json({ error: 'Tipo sensore non valido' });
        }

        await withTransaction(async (connection) => {
            const executor = createExecutor(connection);
            const existing = await executor(
                'SELECT id FROM devices WHERE id = ?',
                [deviceId]
            );

            if (!existing.length) {
                throw createHttpError(404, 'Dispositivo non trovato');
            }

            await ensureClientExists(client_id || null, executor);
            await lockDeviceSerial(executor, serial_number.trim());

            await executor(
                `UPDATE devices
                 SET device_id = ?,
                     user_id = ?,
                     status = ?,
                     name = COALESCE(NULLIF(name, ''), ?),
                     updated_at = NOW()
                 WHERE id = ?`,
                [
                    serial_number.trim(),
                    client_id || null,
                    client_id ? 'active' : 'unassigned',
                    buildDeviceName(serial_number.trim(), type),
                    deviceId
                ]
            );

            await syncPrimarySensorForDevice(deviceId, type, connection);
        });

        res.json({ success: true, message: 'Sensore aggiornato' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' || error.code === '23505') {
            return res.status(409).json({ error: 'Seriale già esistente' });
        }
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Update device error:', error);
        res.status(500).json({ error: 'Errore durante l\'aggiornamento' });
    }
});

router.delete('/devices/:id', isAdminRole, async (req, res) => {
    try {
        const existing = await query('SELECT id FROM devices WHERE id = ?', [req.params.id]);
        if (!existing.length) {
            return res.status(404).json({ error: 'Dispositivo non trovato' });
        }

        await query('DELETE FROM devices WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Dispositivo eliminato' });
    } catch (error) {
        console.error('Delete device error:', error);
        res.status(500).json({ error: 'Errore durante l\'eliminazione del dispositivo' });
    }
});

// ─── ADMIN USERS ────────────────────────────────────────────────────────────────

router.get('/users', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const users = await query(
            `SELECT id, name, email, role, active, created_at
             FROM users
             WHERE role IN ('super_admin', 'operator_admin', 'operator', 'admin')
             ORDER BY role, created_at DESC`
        );

        res.json({
            success: true,
            data: users.map((user) => ({
                ...user,
                role: normalizeAdminRole(user.role)
            }))
        });
    } catch (error) {
        console.error('Get admin users error:', error);
        res.status(500).json({ error: 'Errore nel recupero utenti admin' });
    }
});

router.post('/users', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Nome, email e password sono obbligatori' });
        }
        if (!['admin', 'super_admin'].includes(role)) {
            return res.status(400).json({ error: 'Ruolo non valido. Usa "admin" o "super_admin".' });
        }

        const existing = await query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Email già registrata' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await query(
            `INSERT INTO users (name, email, password_hash, role, is_verified, active)
             VALUES (?, ?, ?, ?, 1, 1)`,
            [name, email, passwordHash, role]
        );

        res.status(201).json({ success: true, message: 'Utente admin creato', id: result.insertId });
    } catch (error) {
        console.error('Create admin user error:', error);
        res.status(500).json({ error: 'Errore durante la creazione dell\'utente' });
    }
});

router.delete('/users/:id', isAdminRole, isSuperAdmin, async (req, res) => {
    try {
        const targetId = Number.parseInt(req.params.id, 10);
        if (targetId === req.adminUser.id) {
            return res.status(400).json({ error: 'Non puoi eliminare il tuo stesso account.' });
        }

        const existing = await query(
            `SELECT id
             FROM users
             WHERE id = ?
               AND role IN ('super_admin', 'operator_admin', 'operator', 'admin')`,
            [targetId]
        );
        if (!existing.length) {
            return res.status(404).json({ error: 'Utente non trovato' });
        }

        await query('DELETE FROM users WHERE id = ?', [targetId]);
        res.json({ success: true, message: 'Utente eliminato' });
    } catch (error) {
        console.error('Delete admin user error:', error);
        res.status(500).json({ error: 'Errore durante l\'eliminazione dell\'utente' });
    }
});

module.exports = router;
