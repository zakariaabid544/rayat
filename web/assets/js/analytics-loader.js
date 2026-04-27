(function loadRayatAnalytics() {
    const config = window.RAYAT_RUNTIME_CONFIG || {};
    if (config.enablePlausible === false) return;

    const domain = String(config.analyticsDomain || '').trim();
    if (!domain) return;

    const script = document.createElement('script');
    script.defer = true;
    script.dataset.domain = domain;
    script.src = config.plausibleScriptUrl || 'https://plausible.io/js/script.js';
    document.head.appendChild(script);
}());
