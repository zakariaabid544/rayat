function classifyDatabaseFailure(error) {
    const databaseUrl = String(process.env.DATABASE_URL || '').trim();
    const message = String(error?.message || '');
    const normalizedMessage = message.toLowerCase();
    const code = String(error?.code || '').trim().toUpperCase();

    if (
        !databaseUrl
        && (
            normalizedMessage.includes('database_url is not set')
            || normalizedMessage.includes('configure the render postgresql connection string')
        )
    ) {
        return {
            configured: false,
            reason: 'missing_url',
            retryable: false
        };
    }

    if (code === '28P01' || normalizedMessage.includes('password authentication failed')) {
        return {
            configured: true,
            reason: 'auth_failed',
            retryable: false
        };
    }

    if (code === '3D000' || normalizedMessage.includes('does not exist')) {
        return {
            configured: true,
            reason: 'database_not_found',
            retryable: false
        };
    }

    if (code === '42P01') {
        return {
            configured: true,
            reason: 'schema_missing',
            retryable: false
        };
    }

    if (code === '42703') {
        return {
            configured: true,
            reason: 'schema_mismatch',
            retryable: false
        };
    }

    if (code === 'ENOTFOUND' || normalizedMessage.includes('getaddrinfo enotfound')) {
        return {
            configured: true,
            reason: 'host_not_found',
            retryable: true
        };
    }

    if (code === 'ECONNREFUSED' || normalizedMessage.includes('connect econnrefused')) {
        return {
            configured: true,
            reason: 'connection_refused',
            retryable: true
        };
    }

    if (code === 'ETIMEDOUT' || normalizedMessage.includes('timed out') || normalizedMessage.includes('timeout expired')) {
        return {
            configured: true,
            reason: 'timeout',
            retryable: true
        };
    }

    if (
        code === '57P01'
        || normalizedMessage.includes('connection terminated unexpectedly')
        || normalizedMessage.includes('server closed the connection unexpectedly')
    ) {
        return {
            configured: true,
            reason: 'connection_terminated',
            retryable: true
        };
    }

    if (
        normalizedMessage.includes('database_url is not set')
        || normalizedMessage.includes('connect')
        || normalizedMessage.includes('connection')
        || normalizedMessage.includes('postgres')
    ) {
        return {
            configured: true,
            reason: 'unavailable',
            retryable: true
        };
    }

    return null;
}

function isDatabaseUnavailableError(error) {
    return Boolean(classifyDatabaseFailure(error));
}

function buildDatabaseUnavailableResponse(error, options = {}) {
    const classification = classifyDatabaseFailure(error);
    if (!classification) {
        return null;
    }

    return {
        statusCode: 503,
        body: {
            error: options.message || 'Servizio temporaneamente non disponibile',
            code: 'database_unavailable',
            database: classification
        }
    };
}

function sendDatabaseAwareError(res, error, options = {}) {
    const {
        fallbackMessage = 'Errore interno del server',
        defaultStatus = 500,
        databaseMessage
    } = options;

    const databaseResponse = buildDatabaseUnavailableResponse(error, {
        message: databaseMessage || fallbackMessage
    });

    if (databaseResponse) {
        return res.status(databaseResponse.statusCode).json(databaseResponse.body);
    }

    return res.status(defaultStatus).json({ error: fallbackMessage });
}

module.exports = {
    buildDatabaseUnavailableResponse,
    isDatabaseUnavailableError,
    sendDatabaseAwareError
};
