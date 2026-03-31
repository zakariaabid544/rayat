const crypto = require('crypto');

const { query } = require('../config/database');

const ALLOWED_EVENT_TYPES = new Set([
    'page_view',
    'button_click',
    'registration_start',
    'registration_completed'
]);

function normalizePagePath(pagePath = '/') {
    const value = String(pagePath || '/').trim();
    if (!value) {
        return '/';
    }

    if (value.startsWith('http://') || value.startsWith('https://')) {
        try {
            return new URL(value).pathname || '/';
        } catch (error) {
            return '/';
        }
    }

    return value.startsWith('/') ? value.slice(0, 160) : `/${value.slice(0, 159)}`;
}

function normalizeText(value, maxLength = 120) {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
}

function extractReferrerHost(referrer = '') {
    const rawValue = String(referrer || '').trim();
    if (!rawValue) {
        return null;
    }

    try {
        return normalizeText(new URL(rawValue).hostname, 120);
    } catch (error) {
        return normalizeText(rawValue, 120);
    }
}

function inferDeviceType(userAgent = '') {
    const ua = String(userAgent || '').toLowerCase();

    if (!ua) {
        return 'unknown';
    }
    if (/ipad|tablet|sm-t|tab\b|kindle|playbook/.test(ua)) {
        return 'tablet';
    }
    if (/mobi|iphone|android/.test(ua)) {
        return 'mobile';
    }

    return 'desktop';
}

function getApproximateLocation(req) {
    const headers = req.headers || {};
    const countryCode = normalizeText(
        headers['cf-ipcountry'] ||
        headers['x-vercel-ip-country'] ||
        headers['cloudfront-viewer-country'] ||
        headers['x-country-code'],
        8
    );
    const cityName = normalizeText(
        headers['x-vercel-ip-city'] ||
        headers['x-appengine-city'] ||
        headers['x-city'],
        120
    );

    return {
        countryCode: countryCode || null,
        cityName: cityName || null
    };
}

function hashAnonymousId(anonymousId = '') {
    const normalized = normalizeText(anonymousId, 160);
    if (!normalized) {
        return null;
    }

    const salt = String(process.env.JWT_SECRET || 'rayat-analytics').trim();
    return crypto
        .createHash('sha256')
        .update(`${salt}:${normalized}`)
        .digest('hex');
}

// RAYAT FIX - email + analytics
async function recordAnalyticsEvent(req, payload = {}) {
    const eventType = normalizeText(payload.eventType, 32);
    if (!eventType || !ALLOWED_EVENT_TYPES.has(eventType)) {
        return false;
    }

    const analyticsId = req.headers['x-rayat-analytics-id'] || payload.anonymousId;
    const anonymousIdHash = hashAnonymousId(analyticsId);
    const pagePath = normalizePagePath(payload.pagePath || req.path || '/');
    const referrerHost = extractReferrerHost(payload.referrer || req.headers.referer || req.headers.referrer || '');
    const deviceType = inferDeviceType(req.headers['user-agent']);
    const { countryCode, cityName } = getApproximateLocation(req);
    const buttonName = normalizeText(payload.buttonName || payload.eventName, 120);
    const eventName = normalizeText(payload.eventName, 120);

    await query(
        `INSERT INTO analytics_events (
            anonymous_id_hash,
            event_type,
            event_name,
            page_path,
            referrer_host,
            device_type,
            country_code,
            city_name,
            button_name
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            anonymousIdHash,
            eventType,
            eventName,
            pagePath,
            referrerHost,
            deviceType,
            countryCode,
            cityName,
            buttonName
        ]
    );

    return true;
}

async function fetchCount(sql) {
    const [row] = await query(sql);
    return Number(row?.count || 0);
}

// RAYAT FIX - email + analytics
async function buildAnalyticsSummary() {
    const [
        visitsToday,
        visits7d,
        visits30d,
        topPages,
        trafficSources,
        locations,
        devices,
        buttonClicks,
        registrationStarts30d,
        registrationCompleted30d,
        uniqueVisitors30d,
        convertedVisitors30d
    ] = await Promise.all([
        fetchCount(`SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'page_view' AND occurred_at >= CURRENT_DATE`),
        fetchCount(`SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'page_view' AND occurred_at >= NOW() - INTERVAL '7 days'`),
        fetchCount(`SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'page_view' AND occurred_at >= NOW() - INTERVAL '30 days'`),
        query(
            `SELECT page_path, COUNT(*) AS visits
             FROM analytics_events
             WHERE event_type = 'page_view'
               AND occurred_at >= NOW() - INTERVAL '30 days'
             GROUP BY page_path
             ORDER BY visits DESC, page_path ASC
             LIMIT 8`
        ),
        query(
            `SELECT COALESCE(referrer_host, 'direct') AS source, COUNT(*) AS visits
             FROM analytics_events
             WHERE event_type = 'page_view'
               AND occurred_at >= NOW() - INTERVAL '30 days'
             GROUP BY source
             ORDER BY visits DESC, source ASC
             LIMIT 8`
        ),
        query(
            `SELECT
                COALESCE(country_code, 'Unknown') AS country_code,
                COALESCE(city_name, '') AS city_name,
                COUNT(*) AS visits
             FROM analytics_events
             WHERE event_type = 'page_view'
               AND occurred_at >= NOW() - INTERVAL '30 days'
             GROUP BY country_code, city_name
             ORDER BY visits DESC, country_code ASC, city_name ASC
             LIMIT 8`
        ),
        query(
            `SELECT device_type, COUNT(*) AS visits
             FROM analytics_events
             WHERE event_type = 'page_view'
               AND occurred_at >= NOW() - INTERVAL '30 days'
             GROUP BY device_type
             ORDER BY visits DESC, device_type ASC`
        ),
        query(
            `SELECT COALESCE(button_name, event_name, 'unknown') AS button_name, COUNT(*) AS clicks
             FROM analytics_events
             WHERE event_type = 'button_click'
               AND occurred_at >= NOW() - INTERVAL '30 days'
             GROUP BY button_name
             ORDER BY clicks DESC, button_name ASC
             LIMIT 12`
        ),
        fetchCount(`SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'registration_start' AND occurred_at >= NOW() - INTERVAL '30 days'`),
        fetchCount(`SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'registration_completed' AND occurred_at >= NOW() - INTERVAL '30 days'`),
        fetchCount(`SELECT COUNT(DISTINCT anonymous_id_hash) AS count FROM analytics_events WHERE event_type = 'page_view' AND occurred_at >= NOW() - INTERVAL '30 days' AND anonymous_id_hash IS NOT NULL`),
        fetchCount(`SELECT COUNT(DISTINCT anonymous_id_hash) AS count FROM analytics_events WHERE event_type = 'registration_completed' AND occurred_at >= NOW() - INTERVAL '30 days' AND anonymous_id_hash IS NOT NULL`)
    ]);

    const conversionRate = uniqueVisitors30d > 0
        ? Number(((convertedVisitors30d / uniqueVisitors30d) * 100).toFixed(1))
        : 0;

    return {
        visitsToday,
        visits7d,
        visits30d,
        topPages: topPages.map((row) => ({
            page_path: row.page_path,
            visits: Number(row.visits || 0)
        })),
        trafficSources: trafficSources.map((row) => ({
            source: row.source,
            visits: Number(row.visits || 0)
        })),
        locations: locations.map((row) => ({
            country_code: row.country_code,
            city_name: row.city_name || null,
            visits: Number(row.visits || 0)
        })),
        devices: devices.map((row) => ({
            device_type: row.device_type || 'unknown',
            visits: Number(row.visits || 0)
        })),
        buttonClicks: buttonClicks.map((row) => ({
            button_name: row.button_name,
            clicks: Number(row.clicks || 0)
        })),
        registrationStarts30d,
        registrationCompleted30d,
        uniqueVisitors30d,
        convertedVisitors30d,
        conversionRate
    };
}

module.exports = {
    recordAnalyticsEvent,
    buildAnalyticsSummary
};
