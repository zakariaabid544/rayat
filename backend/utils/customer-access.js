const { query, getTableColumns } = require('../config/database');

const CUSTOMER_PLATFORM_ROLES = new Set(['client', 'farmer']);
const CUSTOMER_ROLES = new Set(['owner', 'manager', 'agronomist', 'technician', 'viewer']);

function isCustomerPlatformRole(role = '') {
    return CUSTOMER_PLATFORM_ROLES.has(String(role || '').trim());
}

function normalizeCustomerRole(role, options = {}) {
    const normalized = String(role || '').trim().toLowerCase();
    if (CUSTOMER_ROLES.has(normalized)) {
        return normalized;
    }

    return options.isPrimaryAccount ? 'owner' : 'viewer';
}

function buildCustomerPermissions(customerRole) {
    const permissionsByRole = {
        owner: {
            view_dashboard: true,
            view_history: true,
            export_csv: true,
            view_alerts: true,
            acknowledge_alerts: true,
            modify_sensors: true,
            modify_settings: true,
            manage_team: true
        },
        manager: {
            view_dashboard: true,
            view_history: true,
            export_csv: true,
            view_alerts: true,
            acknowledge_alerts: true,
            modify_sensors: false,
            modify_settings: false,
            manage_team: false
        },
        agronomist: {
            view_dashboard: true,
            view_history: true,
            export_csv: true,
            view_alerts: true,
            acknowledge_alerts: true,
            modify_sensors: false,
            modify_settings: false,
            manage_team: false
        },
        technician: {
            view_dashboard: true,
            view_history: true,
            export_csv: false,
            view_alerts: true,
            acknowledge_alerts: true,
            modify_sensors: true,
            modify_settings: true,
            manage_team: false
        },
        viewer: {
            view_dashboard: true,
            view_history: true,
            export_csv: false,
            view_alerts: true,
            acknowledge_alerts: false,
            modify_sensors: false,
            modify_settings: false,
            manage_team: false
        }
    };

    return permissionsByRole[customerRole] || permissionsByRole.viewer;
}

async function getCustomerAccessFlags() {
    const columns = await getTableColumns('users');
    return {
        hasOwnerUserId: columns.has('owner_user_id'),
        hasCustomerRole: columns.has('customer_role')
    };
}

function buildCustomerAccessContext(userRow = {}, flags = {}) {
    const isCustomerAccount = isCustomerPlatformRole(userRow.role);
    const ownerUserId = flags.hasOwnerUserId ? (userRow.owner_user_id ?? null) : null;
    const isPrimaryAccount = isCustomerAccount ? ownerUserId == null : false;
    const customerRole = isCustomerAccount
        ? normalizeCustomerRole(flags.hasCustomerRole ? userRow.customer_role : null, { isPrimaryAccount })
        : null;
    const permissions = customerRole ? buildCustomerPermissions(customerRole) : null;
    const scopeOwnerUserId = isCustomerAccount
        ? (ownerUserId || userRow.id || null)
        : (userRow.id || null);

    return {
        owner_user_id: ownerUserId,
        customer_role: customerRole,
        permissions,
        is_primary_account: isPrimaryAccount,
        scope_owner_user_id: scopeOwnerUserId
    };
}

async function resolveCustomerAccessContextByUserId(userId) {
    const flags = await getCustomerAccessFlags();
    const selectedColumns = [
        'id',
        'email',
        'name',
        'role',
        'active',
        ...(flags.hasOwnerUserId ? ['owner_user_id'] : []),
        ...(flags.hasCustomerRole ? ['customer_role'] : [])
    ];

    const rows = await query(
        `SELECT ${selectedColumns.join(', ')}
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [userId]
    );

    if (!rows.length) {
        return null;
    }

    return {
        ...rows[0],
        ...buildCustomerAccessContext(rows[0], flags)
    };
}

function resolveCustomerScope(user = {}) {
    return user.scopeOwnerUserId
        || user.scope_owner_id
        || user.scope_owner_user_id
        || user.owner_user_id
        || user.id
        || null;
}

function hasCustomerPermission(user, permissionKey) {
    return Boolean(user && user.permissions && user.permissions[permissionKey]);
}

module.exports = {
    CUSTOMER_ROLES,
    isCustomerPlatformRole,
    normalizeCustomerRole,
    buildCustomerPermissions,
    getCustomerAccessFlags,
    buildCustomerAccessContext,
    resolveCustomerAccessContextByUserId,
    resolveCustomerScope,
    hasCustomerPermission
};
