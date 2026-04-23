/*
 * Rayat browser runtime config.
 *
 * This file is intentionally plain JavaScript so the same web output can run
 * as a hosted PWA now and inside Capacitor later without rebuilding.
 */
window.RAYAT_RUNTIME_CONFIG = {
    productionApiBaseUrl: 'https://rayat.ma/api',
    developmentApiBaseUrl: 'http://localhost:3000/api',
    useDevelopmentApiOnLocalhost: true,
    publicSiteUrl: 'https://rayat.ma',
    analyticsDomain: 'rayat.ma',
    enablePlausible: true
};
