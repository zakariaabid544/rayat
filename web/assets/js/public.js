        // Profile form field mapping:
        // - profile-name -> users.name (canonical identity, read-only via profile API)
        // - profile-email -> users.email (canonical identity, read-only via profile API)
        // - profile-phone -> users.profile_phone
        // - photo upload input handled by handleUserProfilePhotoChange() / saveUserProfile() -> users.profile_photo
        // - profile-description -> users.profile_description
        // - profile_updated_at stores the last successful profile persistence timestamp
        const RAYAT_RUNTIME_CONFIG = window.RAYAT_RUNTIME_CONFIG || {};

        function normalizeApiBaseUrl(value) {
            const trimmed = String(value || '').trim().replace(/\/+$/, '');
            if (!trimmed) return '';
            return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
        }

        function normalizePublicSiteUrl(value) {
            return String(value || 'https://rayat.ma').trim().replace(/\/+$/, '');
        }

        function readStoredApiBaseUrlOverride() {
            try {
                return localStorage.getItem('rayat_api_base_url') || sessionStorage.getItem('rayat_api_base_url') || '';
            } catch (_err) {
                return '';
            }
        }

        function isCapacitorNativeRuntime() {
            const capacitor = window.Capacitor;
            if (!capacitor) return false;
            if (typeof capacitor.isNativePlatform === 'function') return capacitor.isNativePlatform();
            if (typeof capacitor.getPlatform === 'function') return capacitor.getPlatform() !== 'web';
            return window.location?.protocol === 'capacitor:';
        }

        function resolveApiBaseUrl() {
            if (isCapacitorNativeRuntime()) {
                return normalizeApiBaseUrl(RAYAT_RUNTIME_CONFIG.productionApiBaseUrl || 'https://rayat.ma/api');
            }

            const override = readStoredApiBaseUrlOverride();
            if (override) return normalizeApiBaseUrl(override);

            const explicit = RAYAT_RUNTIME_CONFIG.apiBaseUrl || RAYAT_RUNTIME_CONFIG.API_BASE_URL;
            if (explicit) return normalizeApiBaseUrl(explicit);

            return normalizeApiBaseUrl(RAYAT_RUNTIME_CONFIG.productionApiBaseUrl || 'https://rayat.ma/api');
        }

        const API_BASE_URL = resolveApiBaseUrl();
        const ADMIN_WEB_PATH = RAYAT_RUNTIME_CONFIG.adminPath || '/admin/';
        const ADMIN_CAPACITOR_WEB_PATH = RAYAT_RUNTIME_CONFIG.capacitorAdminPath || '/admin/index.html';
        const PUBLIC_SITE_URL = normalizePublicSiteUrl(RAYAT_RUNTIME_CONFIG.publicSiteUrl);

        const CONFIG = {
            API_BASE_URL,
            PUBLIC_SITE_URL,
            ADMIN_API_BASE_URL: `${API_BASE_URL}/admin`,
            REAL_API_URL: `${API_BASE_URL}/sensors/simple/latest`,
            PUBLIC_LATEST_URL: `${API_BASE_URL}/sensors/public/latest`,
            PUBLIC_GATEWAY_STATUS_URL: `${API_BASE_URL}/sensors/public/status`, // RAYAT-FIX
            PRIVATE_GATEWAY_STATUS_URL: `${API_BASE_URL}/sensors/status`, // RAYAT-FIX
            ANALYTICS_TRACK_URL: `${API_BASE_URL}/analytics/track`
        };
        // RAYAT-FIX: keep frontend/service-worker asset versions aligned for immediate heartbeat rollout.
        const FRONTEND_ASSET_VERSION = '1.1.34'; // RAYAT-FIX
        const PUBLIC_SENSOR_POLL_INTERVAL_MS = 30000;
        const HOMEPAGE_LIVE_SENSOR_POLL_INTERVAL_MS = 60000;
        const DEFAULT_MONITORING_CONFIG = Object.freeze({
            routerIntervalMinutes: 30,
            expectedDataMinutes: 30,
            offlineGraceMinutes: 5,
            offlineAfterMinutes: 35,
            alertExtraMinutes: 15,
            emailAfterMinutes: 45,
            missingDataThresholdMinutes: 45,
            gatewayHeartbeatWindowMinutes: 5, // RAYAT-FIX
            sensorDataFreshMinutes: 45 // RAYAT-FIX
        });

        let isRefreshingData = false;
        let activeRefreshPromise = null;
        let activeSensorLoadPromise = null;
        let activeSensorLoadScope = '';
        let activeHistoryLoadPromise = null;
        let lastSensorPayloadSignature = '';

        const AUTH_TOKEN_STORAGE_KEY = 'rayat_token';
        const AUTH_USER_STORAGE_KEY = 'rayat_user';
        const AUTH_STORAGE_MODE_KEY = 'rayat_auth_storage_mode';
        const ADMIN_AUTH_TOKEN_STORAGE_KEY = 'rayat_admin_token';
        const ADMIN_AUTH_USER_STORAGE_KEY = 'rayat_admin_user';
        const PUBLIC_SENSOR_CACHE_KEY = 'rayat_public_sensor_cache';
        const PRIVATE_SENSOR_CACHE_KEY = 'rayat_sensor_cache';
        let liveMonitoringConfig = { ...DEFAULT_MONITORING_CONFIG };
        let sensorConnectionState = {
            energia: 'loading',
            acqua: 'loading',
            terreno: 'loading',
            clima: 'loading'
        };
        // RAYAT-FIX: keep track of the freshest sensor independently from the selected dashboard tab.
        let sensorLatestTimestamps = {
            energia: null,
            acqua: null,
            terreno: null,
            clima: null
        };
        let gatewayStatusState = { // RAYAT-FIX
            available: false, // RAYAT-FIX
            deviceId: null, // RAYAT-FIX
            deviceName: null, // RAYAT-FIX
            routerOnline: false, // RAYAT-FIX
            lastHeartbeatAt: null, // RAYAT-FIX
            lastBootAt: null, // RAYAT-FIX
            sensorDataLastAt: null, // RAYAT-FIX
            sensorDataFresh: false // RAYAT-FIX
        }; // RAYAT-FIX
        let gatewayStatusSignature = ''; // RAYAT-FIX

        let authToken = null;
        let currentRole = 'guest';
        let adminSessionUser = null;
        let activeAdminSessionRestorePromise = null;

        let currentView = 'home';
        let selectedSensor = null;
        let user = null;
        let currentLang = localStorage.getItem('rayat_lang') || sessionStorage.getItem('rayat_lang') || 'fr';
        let currentLuxuryDashboardTab = 'overview';
        let currentLuxuryDashboardAnalyticsPeriod = '7d';
        let currentLuxuryDashboardAnalyticsMetric = 'soil:moisture';
        let luxuryHomeLiveSamples = {};
        let luxuryDashboardNotificationsEnabled = true;
        const SENSOR_CARD_MODE_STORAGE_KEY = 'rayat_sensor_card_mode';
        const SENSOR_CARD_VIEW_MODES = new Set(['visual', 'technical']);
        const storedSensorCardMode = localStorage.getItem(SENSOR_CARD_MODE_STORAGE_KEY);
        let currentSensorCardMode = SENSOR_CARD_VIEW_MODES.has(storedSensorCardMode) ? storedSensorCardMode : 'technical';
        let showSettings = false;
        let showNotifications = false;
        let isMobileMenuOpen = false;
        let isProfileMenuOpen = false;
        let isLuxuryDashboardProfileMenuOpen = false;
        let isAdminView = false;
        let dataError = false; // Track API availability
        const CUSTOMER_ROLES = new Set(['client', 'farmer']);
        const ADMIN_ROLES = new Set(['admin', 'super_admin', 'operator', 'operator_admin']);
        const PRIVILEGED_ADMIN_ROLES = new Set(['super_admin', 'admin', 'operator_admin', 'operator']);
        const BARAKAH_PERLITE_EMAIL = 'support@barakahperlite.com';
        const BARAKAH_PERLITE_DEVICE_ID = 'GW-002';
        const PRIVATE_SENSOR_DEVICE_IDS = new Set([BARAKAH_PERLITE_DEVICE_ID]);
        const PRIVATE_SENSOR_TOPIC_PREFIXES = [`sensors/${BARAKAH_PERLITE_DEVICE_ID}/`];
        const VIEW_PATHS = {
            home: '/',
            login: '/login',
            register: '/register',
            demo: '/dashboard',
            'perlite-track': '/perlite-track',
            profilo: '/profilo',
            servizi: '/services',
            'chi-siamo': '/chi-siamo',
            contatti: '/contatti',
            privacy: '/privacy',
            terms: '/terms',
            'reset-password': '/reset-password'
        };
        const DASHBOARD_SENSOR_ROUTE_KEYS = new Set(['energia', 'acqua', 'terreno', 'clima']);
        const HOMEPAGE_REAL_SENSOR_KEYS = ['terreno', 'clima'];
        const HOMEPAGE_TECH_PRODUCTS = [
            { key: 'energia', icon: '⚡', labelKey: 'sensorEnName', featured: true },
            { key: 'acqua', icon: '💧', labelKey: 'sensorWaName', featured: false },
            { key: 'terreno', icon: '🌱', labelKey: 'sensorSoName', featured: false },
            { key: 'clima', icon: '🌡️', labelKey: 'sensorClName', featured: false }
        ];
        const GAUGE_MARKER_SAFE_OFFSET_PERCENT = 5;
        const WHATSAPP_CTA_URL = 'https://wa.me/393513203307';
        const WHATSAPP_DISPLAY_NUMBER = '+39 351 320 3307';
        const USER_PROFILE_STORAGE_PREFIX = 'rayat_user_profile_';
        const ANALYTICS_STORAGE_KEY = 'rayat_analytics_id';
        const BRAND_LOGO_WHITE = '/assets/logo/logo-white.svg';
        let latestAssignedSensors = [];
        let userProfileNotice = '';
        const PROFILE_SECTION_IDS = {
            overview: 'profile-overview-section',
            settings: 'profile-settings-section'
        };
        const PROFILE_SECTION_SCROLL_OFFSET = 112;

        // Professional Water Management Config
        const CROP_OPTIONS = [
            { value: 'banane', labelKey: 'cropOptionBanane' },
            { value: 'tomate', labelKey: 'cropOptionTomate' },
            { value: 'poivron', labelKey: 'cropOptionPoivron' },
            { value: 'concombre', labelKey: 'cropOptionConcombre' },
            { value: 'melon', labelKey: 'cropOptionMelon' },
            { value: 'courgette', labelKey: 'cropOptionCourgette' },
            { value: 'laitue', labelKey: 'cropOptionLaitue' },
            { value: 'fraise', labelKey: 'cropOptionFraise' },
            { value: 'agrumes', labelKey: 'cropOptionAgrumes' },
            { value: 'olive', labelKey: 'cropOptionOlive' },
            { value: 'argan', labelKey: 'cropOptionArgan' },
            { value: 'ble', labelKey: 'cropOptionBle' },
            { value: 'orge', labelKey: 'cropOptionOrge' },
            { value: 'mais', labelKey: 'cropOptionMais' },
            { value: 'luzerne', labelKey: 'cropOptionLuzerne' },
            { value: 'autre', labelKey: 'cropOptionAutre' }
        ];
        /* PATCH-02 — start */
        const REGISTER_CROPS = ['banana', 'mango', 'avocado', 'orange', 'lemon', 'mandarin', 'tomato', 'pepper', 'zucchini'];
        const REGISTER_CROP_TRANSLATIONS_BER = {
            'crop.banana': 'ⵜⵉⴳⴰⵢⵢⴰ',
            'crop.mango': 'ⵎⴰⵏⴳⵓ',
            'crop.avocado': 'ⴰⴼⵓⴽⴰⴷⵓ',
            'crop.orange': 'ⵜⴰⵏⴰⵔⴰⵏⵊⵜ',
            'crop.lemon': 'ⴰⵍⵉⵎⵓⵏ',
            'crop.mandarin': 'ⵎⴰⵏⴷⴰⵔⵉⵏ',
            'crop.tomato': 'ⵜⵉⵎⴰⵜⵉⵛ',
            'crop.pepper': 'ⴰⴼⵍⴼⵍ',
            'crop.zucchini': 'ⵜⴰⴽⵓⵙⴰ'
        };
        const REGISTER_CROP_TRANSLATIONS = {
            it: {
                'crop.banana': 'Banana',
                'crop.mango': 'Mango',
                'crop.avocado': 'Avocado',
                'crop.orange': 'Arancia',
                'crop.lemon': 'Limone',
                'crop.mandarin': 'Mandarino',
                'crop.tomato': 'Pomodoro',
                'crop.pepper': 'Peperone',
                'crop.zucchini': 'Zucchina'
            },
            en: {
                'crop.banana': 'Banana',
                'crop.mango': 'Mango',
                'crop.avocado': 'Avocado',
                'crop.orange': 'Orange',
                'crop.lemon': 'Lemon',
                'crop.mandarin': 'Mandarin',
                'crop.tomato': 'Tomato',
                'crop.pepper': 'Pepper',
                'crop.zucchini': 'Zucchini'
            },
            fr: {
                'crop.banana': 'Banane',
                'crop.mango': 'Mangue',
                'crop.avocado': 'Avocat',
                'crop.orange': 'Orange',
                'crop.lemon': 'Citron',
                'crop.mandarin': 'Mandarine',
                'crop.tomato': 'Tomate',
                'crop.pepper': 'Poivron',
                'crop.zucchini': 'Courgette'
            },
            ar: {
                'crop.banana': 'موز',
                'crop.mango': 'مانجو',
                'crop.avocado': 'أفوكادو',
                'crop.orange': 'برتقال',
                'crop.lemon': 'ليمون',
                'crop.mandarin': 'يوسفي',
                'crop.tomato': 'طماطم',
                'crop.pepper': 'فلفل',
                'crop.zucchini': 'كوسة'
            },
            ber: REGISTER_CROP_TRANSLATIONS_BER,
            zgh: REGISTER_CROP_TRANSLATIONS_BER
        };
        /* PATCH-02 — end */
        const DEFAULT_CROP_VALUE = 'banane';
        const cropConsumptions = {
            banane: 50,
            tomate: 20,
            poivron: 18,
            concombre: 24,
            melon: 19,
            courgette: 22,
            laitue: 12,
            fraise: 14,
            agrumes: 22,
            olive: 11,
            argan: 9,
            ble: 8,
            orge: 7,
            mais: 18,
            luzerne: 26,
            autre: 15
        };
        const cropRanges = {
            banane: {
                soilMoisture: { min: 60, max: 80, unit: '%' },
                soilTemp: { min: 20, max: 30, unit: '°C' },
                ec: { min: 1.5, max: 3.0, unit: 'mS/cm' },
                ph: { min: 5.5, max: 7.0, unit: '' },
                nitrogen: { min: 150, max: 250, unit: 'mg/kg' },
                phosphorus: { min: 30, max: 60, unit: 'mg/kg' },
                potassium: { min: 200, max: 400, unit: 'mg/kg' },
                airTemp: { min: 26, max: 30, unit: '°C' },
                airHumidity: { min: 60, max: 90, unit: '%' },
                co2: { min: 420, max: 1100, unit: 'ppm' },
                windSpeed: { min: 0, max: 18, unit: 'km/h' }
            },
            tomate: {
                soilMoisture: { min: 65, max: 85, unit: '%' },
                soilTemp: { min: 18, max: 26, unit: '°C' },
                ec: { min: 2.0, max: 3.5, unit: 'mS/cm' },
                ph: { min: 6.0, max: 7.0, unit: '' },
                nitrogen: { min: 120, max: 200, unit: 'mg/kg' },
                phosphorus: { min: 40, max: 70, unit: 'mg/kg' },
                potassium: { min: 180, max: 350, unit: 'mg/kg' },
                airTemp: { min: 18, max: 25, unit: '°C' },
                airHumidity: { min: 60, max: 80, unit: '%' },
                co2: { min: 450, max: 1200, unit: 'ppm' },
                windSpeed: { min: 0, max: 14, unit: 'km/h' }
            },
            concombre: {
                soilMoisture: { min: 70, max: 85, unit: '%' },
                soilTemp: { min: 20, max: 28, unit: '°C' },
                ec: { min: 1.8, max: 3.2, unit: 'mS/cm' },
                ph: { min: 5.8, max: 6.8, unit: '' },
                nitrogen: { min: 140, max: 220, unit: 'mg/kg' },
                phosphorus: { min: 35, max: 65, unit: 'mg/kg' },
                potassium: { min: 220, max: 380, unit: 'mg/kg' },
                airTemp: { min: 22, max: 28, unit: '°C' },
                airHumidity: { min: 65, max: 85, unit: '%' },
                co2: { min: 500, max: 1300, unit: 'ppm' },
                windSpeed: { min: 0, max: 12, unit: 'km/h' }
            },
            poivron: {
                soilMoisture: { min: 60, max: 75, unit: '%' },
                soilTemp: { min: 20, max: 27, unit: '°C' },
                ec: { min: 1.8, max: 3.0, unit: 'mS/cm' },
                ph: { min: 6.0, max: 6.8, unit: '' },
                nitrogen: { min: 110, max: 190, unit: 'mg/kg' },
                phosphorus: { min: 30, max: 60, unit: 'mg/kg' },
                potassium: { min: 200, max: 320, unit: 'mg/kg' },
                airTemp: { min: 20, max: 27, unit: '°C' },
                airHumidity: { min: 55, max: 75, unit: '%' },
                co2: { min: 450, max: 1100, unit: 'ppm' },
                windSpeed: { min: 0, max: 14, unit: 'km/h' }
            },
            melon: {
                soilMoisture: { min: 55, max: 70, unit: '%' },
                soilTemp: { min: 20, max: 28, unit: '°C' },
                ec: { min: 1.6, max: 2.8, unit: 'mS/cm' },
                ph: { min: 6.0, max: 6.8, unit: '' },
                nitrogen: { min: 100, max: 180, unit: 'mg/kg' },
                phosphorus: { min: 25, max: 55, unit: 'mg/kg' },
                potassium: { min: 180, max: 300, unit: 'mg/kg' },
                airTemp: { min: 24, max: 30, unit: '°C' },
                airHumidity: { min: 50, max: 70, unit: '%' },
                co2: { min: 400, max: 1000, unit: 'ppm' },
                windSpeed: { min: 0, max: 18, unit: 'km/h' }
            },
            courgette: {
                soilMoisture: { min: 60, max: 78, unit: '%' },
                soilTemp: { min: 19, max: 27, unit: '°C' },
                ec: { min: 1.7, max: 2.8, unit: 'mS/cm' },
                ph: { min: 5.8, max: 6.8, unit: '' },
                nitrogen: { min: 110, max: 180, unit: 'mg/kg' },
                phosphorus: { min: 30, max: 55, unit: 'mg/kg' },
                potassium: { min: 190, max: 310, unit: 'mg/kg' },
                airTemp: { min: 20, max: 28, unit: '°C' },
                airHumidity: { min: 55, max: 75, unit: '%' },
                co2: { min: 430, max: 1050, unit: 'ppm' },
                windSpeed: { min: 0, max: 14, unit: 'km/h' }
            },
            laitue: {
                soilMoisture: { min: 65, max: 82, unit: '%' },
                soilTemp: { min: 16, max: 22, unit: '°C' },
                ec: { min: 1.2, max: 2.2, unit: 'mS/cm' },
                ph: { min: 6.0, max: 7.0, unit: '' },
                nitrogen: { min: 90, max: 150, unit: 'mg/kg' },
                phosphorus: { min: 28, max: 50, unit: 'mg/kg' },
                potassium: { min: 160, max: 260, unit: 'mg/kg' },
                airTemp: { min: 16, max: 24, unit: '°C' },
                airHumidity: { min: 60, max: 80, unit: '%' },
                co2: { min: 380, max: 950, unit: 'ppm' },
                windSpeed: { min: 0, max: 10, unit: 'km/h' }
            },
            fraise: {
                soilMoisture: { min: 62, max: 78, unit: '%' },
                soilTemp: { min: 16, max: 24, unit: '°C' },
                ec: { min: 1.2, max: 2.5, unit: 'mS/cm' },
                ph: { min: 5.5, max: 6.5, unit: '' },
                nitrogen: { min: 100, max: 170, unit: 'mg/kg' },
                phosphorus: { min: 30, max: 55, unit: 'mg/kg' },
                potassium: { min: 170, max: 280, unit: 'mg/kg' },
                airTemp: { min: 18, max: 24, unit: '°C' },
                airHumidity: { min: 60, max: 80, unit: '%' },
                co2: { min: 420, max: 1000, unit: 'ppm' },
                windSpeed: { min: 0, max: 12, unit: 'km/h' }
            },
            agrumes: {
                soilMoisture: { min: 45, max: 65, unit: '%' },
                soilTemp: { min: 18, max: 28, unit: '°C' },
                ec: { min: 1.0, max: 2.2, unit: 'mS/cm' },
                ph: { min: 6.0, max: 7.5, unit: '' },
                nitrogen: { min: 90, max: 160, unit: 'mg/kg' },
                phosphorus: { min: 20, max: 45, unit: 'mg/kg' },
                potassium: { min: 180, max: 320, unit: 'mg/kg' },
                airTemp: { min: 20, max: 32, unit: '°C' },
                airHumidity: { min: 45, max: 70, unit: '%' },
                co2: { min: 380, max: 950, unit: 'ppm' },
                windSpeed: { min: 0, max: 18, unit: 'km/h' }
            },
            olive: {
                soilMoisture: { min: 35, max: 55, unit: '%' },
                soilTemp: { min: 16, max: 28, unit: '°C' },
                ec: { min: 0.8, max: 1.8, unit: 'mS/cm' },
                ph: { min: 6.0, max: 8.0, unit: '' },
                nitrogen: { min: 60, max: 120, unit: 'mg/kg' },
                phosphorus: { min: 18, max: 38, unit: 'mg/kg' },
                potassium: { min: 140, max: 260, unit: 'mg/kg' },
                airTemp: { min: 18, max: 32, unit: '°C' },
                airHumidity: { min: 35, max: 65, unit: '%' },
                co2: { min: 350, max: 900, unit: 'ppm' },
                windSpeed: { min: 0, max: 22, unit: 'km/h' }
            },
            argan: {
                soilMoisture: { min: 28, max: 45, unit: '%' },
                soilTemp: { min: 18, max: 32, unit: '°C' },
                ec: { min: 0.7, max: 1.6, unit: 'mS/cm' },
                ph: { min: 6.2, max: 8.0, unit: '' },
                nitrogen: { min: 45, max: 90, unit: 'mg/kg' },
                phosphorus: { min: 15, max: 30, unit: 'mg/kg' },
                potassium: { min: 110, max: 220, unit: 'mg/kg' },
                airTemp: { min: 20, max: 34, unit: '°C' },
                airHumidity: { min: 25, max: 55, unit: '%' },
                co2: { min: 350, max: 900, unit: 'ppm' },
                windSpeed: { min: 0, max: 24, unit: 'km/h' }
            },
            ble: {
                soilMoisture: { min: 40, max: 60, unit: '%' },
                soilTemp: { min: 14, max: 24, unit: '°C' },
                ec: { min: 0.8, max: 1.8, unit: 'mS/cm' },
                ph: { min: 6.0, max: 7.5, unit: '' },
                nitrogen: { min: 80, max: 140, unit: 'mg/kg' },
                phosphorus: { min: 22, max: 45, unit: 'mg/kg' },
                potassium: { min: 120, max: 220, unit: 'mg/kg' },
                airTemp: { min: 14, max: 24, unit: '°C' },
                airHumidity: { min: 40, max: 70, unit: '%' },
                co2: { min: 360, max: 900, unit: 'ppm' },
                windSpeed: { min: 0, max: 20, unit: 'km/h' }
            },
            orge: {
                soilMoisture: { min: 35, max: 55, unit: '%' },
                soilTemp: { min: 12, max: 22, unit: '°C' },
                ec: { min: 0.7, max: 1.7, unit: 'mS/cm' },
                ph: { min: 6.0, max: 7.8, unit: '' },
                nitrogen: { min: 70, max: 130, unit: 'mg/kg' },
                phosphorus: { min: 18, max: 40, unit: 'mg/kg' },
                potassium: { min: 110, max: 210, unit: 'mg/kg' },
                airTemp: { min: 12, max: 22, unit: '°C' },
                airHumidity: { min: 35, max: 65, unit: '%' },
                co2: { min: 360, max: 880, unit: 'ppm' },
                windSpeed: { min: 0, max: 20, unit: 'km/h' }
            },
            mais: {
                soilMoisture: { min: 50, max: 70, unit: '%' },
                soilTemp: { min: 18, max: 28, unit: '°C' },
                ec: { min: 1.0, max: 2.2, unit: 'mS/cm' },
                ph: { min: 5.8, max: 7.2, unit: '' },
                nitrogen: { min: 100, max: 170, unit: 'mg/kg' },
                phosphorus: { min: 25, max: 50, unit: 'mg/kg' },
                potassium: { min: 150, max: 280, unit: 'mg/kg' },
                airTemp: { min: 20, max: 30, unit: '°C' },
                airHumidity: { min: 45, max: 70, unit: '%' },
                co2: { min: 380, max: 950, unit: 'ppm' },
                windSpeed: { min: 0, max: 18, unit: 'km/h' }
            },
            luzerne: {
                soilMoisture: { min: 48, max: 68, unit: '%' },
                soilTemp: { min: 16, max: 28, unit: '°C' },
                ec: { min: 0.8, max: 2.0, unit: 'mS/cm' },
                ph: { min: 6.2, max: 7.5, unit: '' },
                nitrogen: { min: 70, max: 140, unit: 'mg/kg' },
                phosphorus: { min: 18, max: 42, unit: 'mg/kg' },
                potassium: { min: 130, max: 240, unit: 'mg/kg' },
                airTemp: { min: 18, max: 30, unit: '°C' },
                airHumidity: { min: 40, max: 70, unit: '%' },
                co2: { min: 360, max: 900, unit: 'ppm' },
                windSpeed: { min: 0, max: 20, unit: 'km/h' }
            },
            autre: {
                soilMoisture: { min: 55, max: 75, unit: '%' },
                soilTemp: { min: 18, max: 28, unit: '°C' },
                ec: { min: 1.4, max: 2.8, unit: 'mS/cm' },
                ph: { min: 5.8, max: 7.2, unit: '' },
                nitrogen: { min: 100, max: 180, unit: 'mg/kg' },
                phosphorus: { min: 25, max: 55, unit: 'mg/kg' },
                potassium: { min: 160, max: 300, unit: 'mg/kg' },
                airTemp: { min: 18, max: 28, unit: '°C' },
                airHumidity: { min: 45, max: 75, unit: '%' },
                co2: { min: 400, max: 1000, unit: 'ppm' },
                windSpeed: { min: 0, max: 16, unit: 'km/h' }
            }
        };
        const RANGE_KEYS = {
            soil: {
                moisture: 'soilMoisture',
                temperature: 'soilTemp',
                ec: 'ec',
                pH: 'ph',
                nitrogen: 'nitrogen',
                phosphorus: 'phosphorus',
                potassium: 'potassium'
            },
            climate: {
                temperature: 'airTemp',
                humidity: 'airHumidity',
                co2: 'co2',
                windSpeed: 'windSpeed'
            }
        };
        const SENSOR_SUBTYPE_MAP = {
            energy: { voltage: 'energia_consumption' },
            water: { availability: 'acqua_level' },
            soil: {
                moisture: 'terreno_moisture',
                temperature: 'terreno_temperature',
                ec: 'terreno_ec',
                pH: 'terreno_ph',
                nitrogen: 'terreno_n',
                phosphorus: 'terreno_p',
                potassium: 'terreno_k'
            },
            climate: {
                temperature: 'clima_temperature',
                humidity: 'clima_humidity',
                co2: 'clima_co2',
                windSpeed: 'clima_wind_speed'
            }
        };
        const RAYAT_DEMO_SENSOR_METRICS = [
            { key: 'moisture', subtype: 'terreno_moisture', labelKey: 'luxDemoHumidityLabel', unit: '%', objectKeys: ['humidity', 'soilHumidity', 'soil_humidity', 'soilMoisture', 'soil_moisture', 'moisture', 'terreno', 'terreno_moisture'] },
            { key: 'temperature', subtype: 'terreno_temperature', labelKey: 'luxDemoTemperatureLabel', unit: '°C', objectKeys: ['temperature', 'soilTemperature', 'soil_temperature', 'temp', 'soilTemp', 'terreno_temperature'] },
            { key: 'ec', subtype: 'terreno_ec', labelKey: 'luxDemoEcLabel', unit: 'mS/cm', objectKeys: ['ec', 'EC', 'electricalConductivity', 'electrical_conductivity', 'terreno_ec'] },
            { key: 'pH', subtype: 'terreno_ph', labelKey: 'luxDemoPhLabel', unit: '', objectKeys: ['ph', 'pH', 'PH', 'terreno_ph'] },
            { key: 'nitrogen', subtype: 'terreno_nitrogen', labelKey: 'luxDemoNitrogenLabel', unit: 'mg/kg', objectKeys: ['nitrogen', 'n', 'N', 'terreno_n', 'terreno_nitrogen'] },
            { key: 'phosphorus', subtype: 'terreno_phosphorus', labelKey: 'luxDemoPhosphorusLabel', unit: 'mg/kg', objectKeys: ['phosphorus', 'p', 'P', 'terreno_p', 'terreno_phosphorus'] },
            { key: 'potassium', subtype: 'terreno_potassium', labelKey: 'luxDemoPotassiumLabel', unit: 'mg/kg', objectKeys: ['potassium', 'k', 'K', 'terreno_k', 'terreno_potassium'] }
        ];
        const RAYAT_PERLITE_SENSOR_METRICS = ['moisture', 'ec', 'temperature']
            .map((key) => RAYAT_DEMO_SENSOR_METRICS.find((metric) => metric.key === key))
            .filter(Boolean)
            .map((metric) => {
                const labels = {
                    moisture: 'Umidita substrato',
                    ec: 'EC substrato',
                    temperature: 'Temperatura substrato'
                };
                return { ...metric, label: labels[metric.key] || metric.labelKey };
            });
        const ALERT_PRIORITY = { normal: 0, attention: 1, alert: 2 };
        let userCropSelection = loadStoredCropSelection();
        let waterSettings = { hectares: 1, crop: userCropSelection.value };
        let subscriptionUiState = {
            expired: false,
            expiringSoon: false,
            daysRemaining: null,
            expiryDate: null,
            dismissed: false
        };
        let isSubscriptionModalOpen = false;
        let lastAlarmSyncSignature = '';
        let lastAlarmSyncAt = 0;

        function loadStoredCropSelection() {
            const fallback = { value: DEFAULT_CROP_VALUE, custom: '' };

            try {
                const rawValue = localStorage.getItem('rayat_user_crop');
                if (!rawValue) {
                    return fallback;
                }

                const parsed = JSON.parse(rawValue);
                if (typeof parsed === 'string') {
                    return {
                        value: CROP_OPTIONS.some((option) => option.value === parsed) ? parsed : DEFAULT_CROP_VALUE,
                        custom: ''
                    };
                }

                if (!parsed || typeof parsed !== 'object') {
                    return fallback;
                }

                const selectedValue = CROP_OPTIONS.some((option) => option.value === parsed.value)
                    ? parsed.value
                    : DEFAULT_CROP_VALUE;

                return {
                    value: selectedValue,
                    custom: String(parsed.custom || '').trim()
                };
            } catch (error) {
                return fallback;
            }
        }

        function persistCropSelection() {
            localStorage.setItem('rayat_user_crop', JSON.stringify(userCropSelection));
        }

        function getSelectedCropOption() {
            return CROP_OPTIONS.find((option) => option.value === userCropSelection.value) || CROP_OPTIONS[0];
        }

        function getSelectedCropLabel() {
            if (userCropSelection.value === 'autre' && userCropSelection.custom) {
                return userCropSelection.custom;
            }

            return t(getSelectedCropOption().labelKey);
        }

        function getCropConsumptionValue() {
            return cropConsumptions[userCropSelection.value] || cropConsumptions.autre;
        }

        function isAuthenticated() {
            return Boolean(authToken && user && user.id);
        }

        function parseNumericValue(value) {
            const numeric = Number.parseFloat(value);
            return Number.isFinite(numeric) ? numeric : null;
        }

        function shouldSwapSoilPair(soilTemperature, soilMoisture) {
            const temperature = parseNumericValue(soilTemperature);
            const moisture = parseNumericValue(soilMoisture);

            if (!Number.isFinite(temperature) || !Number.isFinite(moisture)) {
                return false;
            }

            return temperature > 35 && moisture < 25;
        }

        function getSoilReadingGroupKey(reading, includeTimestamp = true) {
            return [
                String(reading?.device_id || reading?.deviceId || '').trim(),
                String(reading?.topic || '').trim(),
                includeTimestamp ? String(reading?.timestamp || '').trim() : '',
                String(reading?.type || '').trim()
            ].join('::');
        }

        function normalizeSoilApiPayloadRows(records = [], options = {}) {
            const includeTimestamp = options.includeTimestamp !== false;
            const normalized = records.map((reading) => (reading && typeof reading === 'object' ? { ...reading } : reading));
            const groups = new Map();

            normalized.forEach((reading, index) => {
                if (!reading || reading.type !== 'terreno') {
                    return;
                }

                if (reading.subtype !== 'terreno_temperature' && reading.subtype !== 'terreno_moisture') {
                    return;
                }

                const key = getSoilReadingGroupKey(reading, includeTimestamp);
                const group = groups.get(key) || { temperatureIndex: null, moistureIndex: null };

                if (reading.subtype === 'terreno_temperature') {
                    group.temperatureIndex = index;
                } else {
                    group.moistureIndex = index;
                }

                groups.set(key, group);
            });

            groups.forEach(({ temperatureIndex, moistureIndex }) => {
                if (!Number.isInteger(temperatureIndex) || !Number.isInteger(moistureIndex)) {
                    return;
                }

                const temperatureReading = normalized[temperatureIndex];
                const moistureReading = normalized[moistureIndex];

                if (!shouldSwapSoilPair(temperatureReading?.value, moistureReading?.value)) {
                    return;
                }

                const originalTemperature = temperatureReading.value;
                temperatureReading.value = moistureReading.value;
                moistureReading.value = originalTemperature;
            });

            return normalized;
        }

        function normalizeSoilHistoryRow(row) {
            if (!row || !shouldSwapSoilPair(row.temperature, row.terreno)) {
                return row;
            }

            return {
                ...row,
                temperature: row.terreno,
                terreno: row.temperature
            };
        }

        function formatMetricValue(value) {
            const numeric = parseNumericValue(value);
            if (!Number.isFinite(numeric)) {
                return '--';
            }
            if (Math.abs(numeric) >= 100) {
                return numeric.toFixed(0);
            }
            if (Math.abs(numeric) >= 10) {
                return numeric.toFixed(1).replace(/\.0$/, '');
            }
            return numeric.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
        }

        function setOfflineBannerVisibility(visible, message = '') {
            const banner = document.getElementById('offline-banner');
            if (!banner) {
                return;
            }

            banner.style.display = visible ? 'block' : 'none';
            if (visible) {
                banner.innerText = message;
            }
        }

        function getCurrentCropRanges() {
            return cropRanges[userCropSelection.value] || cropRanges.autre || cropRanges.banane;
        }

        function getRangeForMetric(group, key) {
            const rangeKey = RANGE_KEYS[group]?.[key];
            if (!rangeKey) {
                return null;
            }
            return getCurrentCropRanges()[rangeKey] || null;
        }

        function getMetricUnit(group, key, fallbackUnit = '') {
            return getRangeForMetric(group, key)?.unit || fallbackUnit || '';
        }

        function normalizeMetricValue(group, key, value) {
            const numeric = parseNumericValue(value);
            if (!Number.isFinite(numeric)) {
                return null;
            }

            if (group === 'soil' && key === 'ec' && numeric > 20) {
                return numeric / 1000;
            }

            return numeric;
        }

        function getAlertThresholds(range) {
            const minSpan = Math.max(Math.abs(range.min) * 0.3, range.unit === '' ? 0.3 : 1);
            const maxSpan = Math.max(Math.abs(range.max) * 0.3, range.unit === '' ? 0.3 : 1);
            return {
                lowerCritical: range.min - minSpan,
                upperCritical: range.max + maxSpan
            };
        }

        function getMetricState(value, range) {
            if (!range || !Number.isFinite(value)) {
                return {
                    level: 'normal',
                    badge: '',
                    label: t('statusNormal'),
                    cssModifier: '',
                    borderColor: 'rgba(148, 163, 184, 0.18)',
                    accentColor: '#22c55e'
                };
            }

            if (value >= range.min && value <= range.max) {
                return {
                    level: 'normal',
                    badge: '',
                    label: t('statusNormal'),
                    cssModifier: '',
                    borderColor: 'rgba(34, 197, 94, 0.14)',
                    accentColor: '#22c55e'
                };
            }

            const { lowerCritical, upperCritical } = getAlertThresholds(range);
            const isAlert = value < lowerCritical || value > upperCritical;

            return {
                level: isAlert ? 'alert' : 'attention',
                badge: getAlertBadgeLabel(isAlert ? 'alert' : 'attention', true),
                label: getAlertBadgeLabel(isAlert ? 'alert' : 'attention'),
                cssModifier: isAlert ? 'rayat-metric-card--alert' : 'rayat-metric-card--attention',
                borderColor: isAlert ? 'rgba(239, 68, 68, 0.28)' : 'rgba(245, 158, 11, 0.28)',
                accentColor: isAlert ? '#ef4444' : '#f59e0b'
            };
        }

        function getGaugeBounds(group, key, range) {
            if (!range) {
                return { min: 0, max: 100 };
            }

            if (group === 'soil' && key === 'pH') {
                return { min: Math.max(0, range.min - 1.5), max: range.max + 1.5 };
            }

            if (group === 'soil' && key === 'ec') {
                return { min: 0, max: Math.max(4, range.max + 1) };
            }

            if (group === 'climate' && key === 'co2') {
                return { min: 250, max: Math.max(1600, range.max + 500) };
            }

            if (group === 'climate' && key === 'windSpeed') {
                return { min: 0, max: Math.max(40, range.max + 15) };
            }

            const padding = Math.max((range.max - range.min) * 0.6, 1);
            return {
                min: Math.max(0, range.min - padding),
                max: range.max + padding
            };
        }

        function getMarkerPercent(value, min, max) {
            return getGaugeMarkerPercent(value, min, max) ?? 0;
        }

        function getGaugeMeta(group, key, range) {
            const bounds = getGaugeBounds(group, key, range);
            const { lowerCritical, upperCritical } = getAlertThresholds(range);
            const clamp = (value) => Math.max(bounds.min, Math.min(bounds.max, value));
            const toPct = (value) => ((clamp(value) - bounds.min) / (bounds.max - bounds.min)) * 100;

            return {
                min: bounds.min,
                max: bounds.max,
                pointerLeft: toPct,
                gradient: `linear-gradient(to right,
                    #ef4444 0%,
                    #ef4444 ${toPct(lowerCritical)}%,
                    #f59e0b ${toPct(lowerCritical)}%,
                    #f59e0b ${toPct(range.min)}%,
                    #22c55e ${toPct(range.min)}%,
                    #22c55e ${toPct(range.max)}%,
                    #f59e0b ${toPct(range.max)}%,
                    #f59e0b ${toPct(upperCritical)}%,
                    #ef4444 ${toPct(upperCritical)}%,
                    #ef4444 100%)`
            };
        }

        function getGaugeMarkerPercent(value, min, max) {
            const numericValue = parseNumericValue(value);
            if (!Number.isFinite(numericValue) || !Number.isFinite(min) || !Number.isFinite(max) || max === min) {
                return null;
            }

            const ratio = (numericValue - min) / (max - min);
            const clampedRatio = Math.max(0, Math.min(1, ratio));
            const usableTrackWidth = 100 - (GAUGE_MARKER_SAFE_OFFSET_PERCENT * 2);
            return GAUGE_MARKER_SAFE_OFFSET_PERCENT + (clampedRatio * usableTrackWidth);
        }

        function buildOptimalRangeLabel(range, mode = 'range') {
            if (!range) {
                return '';
            }
            const unitSuffix = range.unit ? ` ${range.unit}` : '';
            const prefix = mode === 'climate' ? t('optimalFor') : t('optimalRangeFor');
            return `${prefix} ${getSelectedCropLabel()}: ${formatMetricValue(range.min)} – ${formatMetricValue(range.max)}${unitSuffix}`;
        }

        // RAYAT FIX - popup subscription / new customers / email
        function isConfirmedCustomerAccount(userData = user) {
            if (!userData || !isCustomerRole(userData.role)) {
                return false;
            }

            if (userData.registration_status === 'active') {
                return true;
            }

            return Boolean(userData.approved_at);
        }

        // RAYAT FIX - popup subscription / new customers / email
        function getSubscriptionStateFromUser(userData = user) {
            if (!userData || !isCustomerRole(userData.role)) {
                return {
                    expired: false,
                    expiringSoon: false,
                    daysRemaining: null,
                    expiryDate: null,
                    dismissed: false
                };
            }

            if (!isConfirmedCustomerAccount(userData)) {
                return {
                    expired: false,
                    expiringSoon: false,
                    daysRemaining: null,
                    expiryDate: null,
                    dismissed: false
                };
            }

            const expiryDate = userData.subscription_expiry ? new Date(userData.subscription_expiry) : null;
            if (expiryDate && Number.isNaN(expiryDate.getTime())) {
                return {
                    expired: false,
                    expiringSoon: false,
                    daysRemaining: null,
                    expiryDate: null,
                    dismissed: false
                };
            }

            if (!expiryDate) {
                return {
                    expired: false,
                    expiringSoon: false,
                    daysRemaining: null,
                    expiryDate: null,
                    dismissed: false
                };
            }

            const diffMs = expiryDate.getTime() - Date.now();
            const daysRemaining = Math.ceil(diffMs / 86400000);

            return {
                expired: diffMs < 0,
                expiringSoon: diffMs >= 0 && daysRemaining <= 7,
                daysRemaining,
                expiryDate,
                dismissed: false
            };
        }

        function syncSubscriptionUiState() {
            subscriptionUiState = getSubscriptionStateFromUser();
        }

        function getWhatsappHref() {
            return WHATSAPP_CTA_URL;
        }

        function getWhatsappIconSvg(extraClass = '') {
            return `
                <svg viewBox="0 0 24 24" class="${extraClass}" aria-hidden="true">
                    <path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>
                </svg>
            `;
        }

        function renderPublicWhatsappButton() {
            if (currentView === 'demo' || window.location.pathname.startsWith('/admin')) {
                return '';
            }

            return `
                <a href="${getWhatsappHref()}" target="_blank" rel="noopener" onclick="trackEvent('WhatsApp Click')" class="rayat-whatsapp-float" aria-label="${t('whatsappButtonLabel')}">
                    ${getWhatsappIconSvg('w-7 h-7')}
                </a>
            `;
        }

        function renderHomepageWhatsappSection() {
            return `
                <section class="py-12 bg-white">
                    <div class="container mx-auto px-4">
                        <div class="rayat-whatsapp-panel mx-auto max-w-4xl text-center">
                            <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-white text-[#25D366] shadow-lg mb-6">
                                ${getWhatsappIconSvg('w-8 h-8')}
                            </div>
                            <h3 class="text-3xl md:text-4xl font-black text-slate-900 tracking-tight mb-4">${t('whatsappSectionTitle')}</h3>
                            <p class="text-base md:text-lg text-slate-700 leading-relaxed max-w-2xl mx-auto">${t('whatsappSectionText')}</p>
                            <a href="${getWhatsappHref()}" target="_blank" rel="noopener" onclick="trackEvent('WhatsApp Click')" class="inline-flex items-center justify-center gap-3 mt-8 bg-[#25D366] hover:bg-[#1ebd5a] text-white font-black px-8 py-4 rounded-2xl transition shadow-lg shadow-green-500/25 min-h-[56px]">
                                ${getWhatsappIconSvg('w-6 h-6')}
                                <span>${t('whatsappSectionButton')}</span>
                            </a>
                        </div>
                    </div>
                </section>
            `;
        }

        function scheduleMapInvalidate(map) {
            if (!map) {
                return;
            }

            requestAnimationFrame(() => map.invalidateSize());
            setTimeout(() => map.invalidateSize(), 180);
            setTimeout(() => map.invalidateSize(), 520);
        }

        function invalidateVisibleMaps() {
            if (currentView === 'home' && homeMapInstance) {
                scheduleMapInvalidate(homeMapInstance);
            }
            if (currentView === 'contatti' && contactMapInstance) {
                scheduleMapInvalidate(contactMapInstance);
            }
            if (currentView === 'register' && regMap) {
                scheduleMapInvalidate(regMap);
            }
        }

        function decodeJwtPayload(token) {
            if (!token) return null;

            try {
                const parts = token.split('.');
                if (parts.length < 2) return null;
                const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
                return JSON.parse(atob(padded));
            } catch (error) {
                return null;
            }
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function getStoredAuthValue(key) {
            return localStorage.getItem(key) || sessionStorage.getItem(key);
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function getActiveAuthStorage() {
            if (localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)) {
                return localStorage;
            }

            if (sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY)) {
                return sessionStorage;
            }

            return localStorage.getItem(AUTH_STORAGE_MODE_KEY) === 'remember'
                ? localStorage
                : sessionStorage;
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function shouldRememberLogin() {
            return localStorage.getItem(AUTH_STORAGE_MODE_KEY) === 'remember'
                || Boolean(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY));
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function persistPublicSession(token, userData, options = {}) {
            const remember = Boolean(options.remember);
            const targetStorage = remember ? localStorage : sessionStorage;

            localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
            localStorage.removeItem(AUTH_USER_STORAGE_KEY);
            sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
            sessionStorage.removeItem(AUTH_USER_STORAGE_KEY);

            targetStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
            targetStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(userData));

            if (remember) {
                localStorage.setItem(AUTH_STORAGE_MODE_KEY, 'remember');
            } else {
                localStorage.removeItem(AUTH_STORAGE_MODE_KEY);
            }
        }

        function isCustomerRole(role = currentRole) {
            return CUSTOMER_ROLES.has(role);
        }

        function isBarakahPerliteCustomer(userData = user) {
            return String(userData?.email || '').trim().toLowerCase() === BARAKAH_PERLITE_EMAIL;
        }

        function isPrivilegedRole(role = currentRole) {
            return ADMIN_ROLES.has(role);
        }

        function isPrivilegedAdminRole(role = '') {
            return PRIVILEGED_ADMIN_ROLES.has(role);
        }

        function readStoredAdminSessionUser() {
            const raw = sessionStorage.getItem(ADMIN_AUTH_USER_STORAGE_KEY);
            if (!raw) {
                return null;
            }

            try {
                const parsed = JSON.parse(raw);
                return isPrivilegedAdminRole(parsed?.role) ? parsed : null;
            } catch (error) {
                sessionStorage.removeItem(ADMIN_AUTH_USER_STORAGE_KEY);
                return null;
            }
        }

        function syncStoredAdminSessionIntoState() {
            adminSessionUser = readStoredAdminSessionUser();
        }

        function getPrivilegedAdminSessionUser() {
            return isPrivilegedAdminRole(adminSessionUser?.role) ? adminSessionUser : null;
        }

        function hasPrivilegedAdminShortcut() {
            return Boolean(getPrivilegedAdminSessionUser());
        }

        function canAccessPerliteTrack(userData = user, role = currentRole) {
            return (isAuthenticated() && isCustomerRole(role) && isBarakahPerliteCustomer(userData))
                || hasPrivilegedAdminShortcut();
        }

        function getPrivateSensorAuthToken() {
            if (isAuthenticated() && isCustomerRole(currentRole)) {
                return authToken;
            }

            return getPrivilegedAdminSessionUser() ? getAdminSessionTokenCandidate() : null;
        }

        function getAdminSessionTokenCandidate() {
            return sessionStorage.getItem(ADMIN_AUTH_TOKEN_STORAGE_KEY) || null;
        }

        function readStoredPublicSessionUser() {
            const raw = getStoredAuthValue(AUTH_USER_STORAGE_KEY);
            if (!raw) return null;

            try {
                const parsed = JSON.parse(raw);
                return isPrivilegedAdminRole(parsed?.role) ? parsed : null;
            } catch (_err) {
                return null;
            }
        }

        function syncPrivilegedPublicSessionToAdminSession() {
            const publicAdminUser = isPrivilegedAdminRole(user?.role)
                ? user
                : readStoredPublicSessionUser();
            const publicToken = authToken || getStoredAuthValue(AUTH_TOKEN_STORAGE_KEY);

            if (publicAdminUser && publicToken) {
                sessionStorage.setItem(ADMIN_AUTH_TOKEN_STORAGE_KEY, publicToken);
                sessionStorage.setItem(ADMIN_AUTH_USER_STORAGE_KEY, JSON.stringify(publicAdminUser));
            }

            syncStoredAdminSessionIntoState();
        }

        function resolveAdminPanelUrl() {
            const targetPath = isCapacitorNativeRuntime()
                ? ADMIN_CAPACITOR_WEB_PATH
                : ADMIN_WEB_PATH;

            if (/^[a-z][a-z0-9+.-]*:/i.test(String(targetPath))) {
                return targetPath;
            }

            try {
                return new URL(targetPath, window.location.href).href;
            } catch (_err) {
                return targetPath;
            }
        }

        function isAdminReferrer() {
            if (!document.referrer) return false;
            try {
                return new URL(document.referrer).pathname.startsWith('/admin');
            } catch (_err) {
                return false;
            }
        }

        function shouldAttemptAdminSessionRestore() {
            return Boolean(
                sessionStorage.getItem(ADMIN_AUTH_TOKEN_STORAGE_KEY)
                || sessionStorage.getItem(ADMIN_AUTH_USER_STORAGE_KEY)
                || isAdminReferrer()
            );
        }

        async function ensurePrivilegedAdminSession() {
            if (!shouldAttemptAdminSessionRestore()) {
                syncStoredAdminSessionIntoState();
                return adminSessionUser;
            }

            if (activeAdminSessionRestorePromise) {
                return activeAdminSessionRestorePromise;
            }

            const headers = {};
            const candidateToken = getAdminSessionTokenCandidate();
            if (candidateToken) {
                headers.Authorization = `Bearer ${candidateToken}`;
            }

            activeAdminSessionRestorePromise = fetch(`${CONFIG.ADMIN_API_BASE_URL}/session`, {
                method: 'GET',
                credentials: 'same-origin',
                headers
            }).then(async (response) => {
                if (!response.ok) {
                    sessionStorage.removeItem(ADMIN_AUTH_TOKEN_STORAGE_KEY);
                    sessionStorage.removeItem(ADMIN_AUTH_USER_STORAGE_KEY);
                    adminSessionUser = null;
                    return null;
                }

                const data = await response.json();
                if (data?.token) {
                    sessionStorage.setItem(ADMIN_AUTH_TOKEN_STORAGE_KEY, data.token);
                }

                if (isPrivilegedAdminRole(data?.user?.role)) {
                    sessionStorage.setItem(ADMIN_AUTH_USER_STORAGE_KEY, JSON.stringify(data.user));
                    adminSessionUser = data.user;
                    return adminSessionUser;
                }

                adminSessionUser = null;
                return null;
            }).catch(() => {
                syncStoredAdminSessionIntoState();
                return adminSessionUser;
            }).finally(() => {
                activeAdminSessionRestorePromise = null;
            });

            return activeAdminSessionRestorePromise;
        }

        function goToAdminArea() {
            closeProfileMenu();
            toggleMobileMenu(false);
            syncPrivilegedPublicSessionToAdminSession();
            window.location.assign(resolveAdminPanelUrl());
        }

        function shouldShowNativeAdminLoginEntry() {
            return isCapacitorNativeRuntime();
        }

        function openAdminLoginFromNavigation() {
            goToAdminArea();
        }

        function normalizePublicDashboardView(view) {
            return view === 'dashboard' ? 'demo' : view;
        }

        function getPathForView(view) {
            const normalizedView = normalizePublicDashboardView(view);
            return VIEW_PATHS[normalizedView] || '/';
        }

        function normalizeDashboardSensorKey(sensorKey) {
            const normalizedSensorKey = String(sensorKey || '').trim().toLowerCase();
            return DASHBOARD_SENSOR_ROUTE_KEYS.has(normalizedSensorKey) ? normalizedSensorKey : null;
        }

        function getDashboardSensorFromPath(pathname = window.location.pathname) {
            const normalizedPath = pathname.replace(/\/+$/, '') || '/';
            const match = normalizedPath.match(/^\/(?:dashboard|demo)\/([^/]+)$/);
            return normalizeDashboardSensorKey(match?.[1]);
        }

        function getDashboardPathForSensor(sensorKey = selectedSensor) {
            const normalizedSensorKey = normalizeDashboardSensorKey(sensorKey);
            return normalizedSensorKey ? `${VIEW_PATHS.demo}/${normalizedSensorKey}` : VIEW_PATHS.demo;
        }

        function syncDashboardSensorFromPath(pathname = window.location.pathname) {
            const routeSensorKey = getDashboardSensorFromPath(pathname);
            if (routeSensorKey) {
                selectedSensor = routeSensorKey;
            }
        }

        function getViewFromPath(pathname = window.location.pathname) {
            const requestedView = new URLSearchParams(window.location.search).get('view');
            if (requestedView) {
                const normalizedRequestedView = normalizePublicDashboardView(requestedView);
                if (Object.prototype.hasOwnProperty.call(VIEW_PATHS, normalizedRequestedView)) {
                    return normalizedRequestedView;
                }
            }

            const normalizedPath = pathname.replace(/\/+$/, '') || '/';
            if (
                normalizedPath === '/perlite-track'
                || normalizedPath === '/rayat-perlite-track'
                || normalizedPath === '/dashboard/perlite-track'
            ) {
                return 'perlite-track';
            }
            if (
                normalizedPath === '/demo'
                || normalizedPath === '/dashboard'
                || normalizedPath.startsWith('/demo/')
                || normalizedPath.startsWith('/dashboard/')
            ) {
                return 'demo';
            }
            const match = Object.entries(VIEW_PATHS).find(([, path]) => path === normalizedPath);
            return match ? match[0] : 'home';
        }

        function shouldLoadSensorDataForView(view = currentView) {
            return view === 'home'
                || view === 'demo'
                || (view === 'perlite-track' && canAccessPerliteTrack())
                || (view === 'profilo' && isAuthenticated() && isCustomerRole(currentRole));
        }

        function shouldLoadHistoryDataForView(view = currentView) {
            return view === 'demo' || (view === 'perlite-track' && canAccessPerliteTrack());
        }

        function getCurrentCustomerPermissions() {
            if (!user || !isCustomerRole(currentRole)) {
                return null;
            }

            return user.permissions && typeof user.permissions === 'object'
                ? user.permissions
                : null;
        }

        function hasCustomerPermission(permissionKey) {
            const permissions = getCurrentCustomerPermissions();
            if (!permissions) {
                return true;
            }

            return permissions[permissionKey] !== false;
        }

        function requestViewData(view = currentView, options = {}) {
            if (shouldLoadSensorDataForView(view)) {
                loadSensorData({ ...options, view }).catch(() => {});
            }

            if (shouldLoadHistoryDataForView(view)) {
                loadHistoryData({ ...options, view }).catch(() => {});
            }
        }

        function restorePublicSession() {
            authToken = getStoredAuthValue(AUTH_TOKEN_STORAGE_KEY);

            const hydratePersistedProfile = () => {
                if (!authToken || !user?.id) {
                    return;
                }

                fetch(`${CONFIG.API_BASE_URL}/auth/me`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${authToken}` }
                }).then(async (response) => {
                    if (!response.ok) {
                        throw new Error('profile_hydration_failed');
                    }

                    const data = await response.json().catch(() => null);
                    if (!data || data.success === false || !user || user.id !== data.id) {
                        return;
                    }

                    user = {
                        ...user,
                        owner_user_id: data.owner_user_id ?? user.owner_user_id ?? null,
                        customer_role: data.customer_role ?? user.customer_role ?? null,
                        permissions: data.permissions ?? user.permissions ?? null,
                        is_primary_account: data.is_primary_account ?? user.is_primary_account ?? true,
                        scope_owner_user_id: data.scope_owner_user_id ?? user.scope_owner_user_id ?? user.id,
                        profile_phone: data.profile_phone ?? null,
                        profile_description: data.profile_description ?? null,
                        profile_photo: data.profile_photo ?? null,
                        profile_updated_at: data.profile_updated_at ?? null
                    };

                    writeStoredUserProfile({
                        ...readStoredUserProfile(user.id),
                        name: user.name || '',
                        email: user.email || '',
                        phone: data.profile_phone || '',
                        description: data.profile_description || '',
                        photo: data.profile_photo || ''
                    }, user.id);
                    syncStoredUserProfileIntoSession();

                    if (currentView === 'profilo') {
                        render();
                    }
                }).catch(() => {});
            };

            if (!authToken) {
                user = null;
                currentRole = 'guest';
                syncStoredAdminSessionIntoState();
                syncSubscriptionUiState();
                return;
            }

            const storedUser = getStoredAuthValue(AUTH_USER_STORAGE_KEY);
            if (storedUser) {
                try {
                    user = JSON.parse(storedUser);
                    currentRole = user?.role || 'guest';
                    syncStoredUserProfileIntoSession();
                    syncStoredAdminSessionIntoState();
                    syncSubscriptionUiState();
                    hydratePersistedProfile();
                    return;
                } catch (error) {
                    localStorage.removeItem(AUTH_USER_STORAGE_KEY);
                    sessionStorage.removeItem(AUTH_USER_STORAGE_KEY);
                }
            }

            const decoded = decodeJwtPayload(authToken);
            if (decoded && decoded.role) {
                user = {
                    id: decoded.id,
                    email: decoded.email,
                    name: decoded.name,
                    role: decoded.role
                };
                currentRole = decoded.role;
                syncStoredUserProfileIntoSession();
                getActiveAuthStorage().setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user));
                syncStoredAdminSessionIntoState();
                syncSubscriptionUiState();
                hydratePersistedProfile();
                return;
            }

            clearPublicSession({ keepCurrentView: true, skipAdminLogout: true });
        }

        function clearPublicSession(options = {}) {
            user = null;
            authToken = null;
            currentRole = 'guest';
            isAdminView = false;
            latestAssignedSensors = [];
            userProfileNotice = '';
            isProfileMenuOpen = false;
            adminSessionUser = null;
            activeAdminSessionRestorePromise = null;
            localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
            localStorage.removeItem(AUTH_USER_STORAGE_KEY);
            sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
            sessionStorage.removeItem(AUTH_USER_STORAGE_KEY);
            sessionStorage.removeItem(ADMIN_AUTH_TOKEN_STORAGE_KEY);
            sessionStorage.removeItem(ADMIN_AUTH_USER_STORAGE_KEY);
            localStorage.removeItem(AUTH_STORAGE_MODE_KEY);
            syncSubscriptionUiState();
            hideSubscriptionExpiredModal();

            if (!options.skipAdminLogout) {
                fetch(`${CONFIG.ADMIN_API_BASE_URL}/logout`, {
                    method: 'POST',
                    credentials: 'same-origin'
                }).catch(() => {});
            }
        }

        function updateWaterSettings(val, type) {
            if (type === 'hectares') {
                const parsed = Number.parseFloat(val);
                waterSettings.hectares = Number.isFinite(parsed) ? Math.max(0.1, parsed) : 0.1;
            } else if (type === 'crop') {
                setUserCrop(val);
                return;
            }

            render();
            // removed chart initialization
        }

        function adjustWaterHectares(delta) {
            const currentHectares = Number.parseFloat(waterSettings.hectares) || 0;
            waterSettings.hectares = Math.max(0.1, Number((currentHectares + delta).toFixed(1)));
            render();
        }

        // Alert System State
        let activeAlerts = [];
        let alertSettings = {
            energia: { maxConsumption: 2.2 }, // kW
            acqua: { minLevel: 5 }, // m
            terreno: { minMoisture: 40 }, // %
            clima: { maxTemp: 32, minTemp: 10 } // °C
        };

        const translations = {
            it: {
                home: 'Home', services: 'Servizi', aboutUs: 'Chi Siamo', demo: 'Demo', myFieldNav: 'Il mio campo', login: 'Accedi', logout: 'Logout',
                profileNav: 'Profilo',
                profileTitle: 'Il tuo profilo Rayat',
                profileSubtitle: 'Gestisci i tuoi dati personali e consulta i sensori assegnati in sola lettura.',
                profilePersonalInfo: 'Dati account',
                profileDescription: 'Descrizione',
                profilePhoto: 'Foto profilo',
                profilePhotoHint: 'Carica una immagine chiara e professionale.',
                profilePhotoRemove: 'Rimuovi foto',
                profileSave: 'Salva profilo',
                profileSaved: 'Profilo aggiornato correttamente.',
                profileSensorsTitle: 'Sensori assegnati',
                profileSensorsHint: 'Questa sezione e in sola visualizzazione.',
                profileNoSensors: 'Nessun sensore assegnato disponibile al momento.',
                profileViewOnly: 'Solo visualizzazione',
                profileRoleLabel: 'Ruolo',
                profileDeviceLabel: 'Dispositivo',
                profileLatestReading: 'Ultima lettura',
                profileMenuInfo: 'Profilo',
                profileMenuEdit: 'Impostazioni',
                profileMenuLogout: 'Logout',
                hero: 'Terreno Sano = Raccolto Ricco', heroSub: 'Monitoraggio 24/7 con sensori intelligenti Rayat',
                heroEyebrow: 'Rayat Smart Monitoring',
                heroTitleLine1: 'Agricoltura guidata dai dati',
                heroTitleLine2: 'Decisioni migliori.',
                heroTitleAccent: 'Raccolti migliori.',
                heroPlatformSub: 'Monitoraggio IoT avanzato di suolo, clima, acqua ed energia, tutto in un\'unica piattaforma.',
                tryDemo: 'Prova la Demo', discoverServices: 'Scopri i Servizi', insurance: 'Assicurazione Agricola Rayat Smart Monitoring',
                ourSensors: 'Tecnologia Rayat', ourReality: 'La Nostra Realtà',
                homeTechnologyTitle: 'Tecnologia Rayat',
                homeLiveSensorsTitle: 'Dati reali dai sensori Rayat installati a Taroudant',
                homeLiveSensorsSubtitle: 'Dati reali da sensori installati in una serra di banane a Taroudant, monitorati insieme a Hassan Arab con oltre 20 anni di esperienza, per analizzare i dati e ottimizzare le decisioni sul campo.',
                homeLiveSensorsSystemTitle: 'Sistema completo: Suolo + Clima',
                homeLiveSensorsCtaTitle: 'Contattami su WhatsApp',
                homeLiveSensorsCtaNote: 'Un click e si apre la chat diretta',
                homeLiveSensorsCtaAria: 'Apri la chat diretta su WhatsApp',
                homeStatusOnline: 'Online',
                homeStatusOffline: 'Offline',
                liveMonitoringTitle: 'Monitoraggio in tempo reale',
                liveMonitoringSubtitle: 'Dati live dei sensori Rayat aggiornati automaticamente ogni 60 secondi.',
                sensorNotInstalled: 'Sensore non installato',
                ourRealityDesc: 'Rayat nasce dalla passione per l\'agricoltura e dalla profonda comprensione delle sfide che ogni agricoltore affronta. Siamo un team di esperti che porta tecnologia accessibile nei campi.',
                ourMission: 'La Nostra Missione', ourMissionDesc: 'Crediamo che ogni agricoltore meriti strumenti professionali. Vogliamo rendere la tecnologia agricola semplice e potente.',
                ourDuty: 'Dovere Professionale', ourDutyDesc: 'Siamo i vostri partner di fiducia nella gestione efficiente del campo.',
                support247: 'Supporto 24/7', training: 'Formazione Continua', transparency: 'Trasparenza Totale',
                customSolutions: 'Soluzioni Personalizzate', qualityGuaranteed: 'Qualità Certificata',
                ourCommitment: 'Il Nostro Impegno', ourCommitmentDesc: 'Offriamo tranquillità e sicurezza: il tuo successo è il nostro obiettivo primario.',
                innovation: 'Innovazione', innovationDesc: 'Tecnologie avanzate per il futuro dell\'agricoltura.',
                sustainability: 'Sostenibilità', sustainabilityDesc: 'Promuoviamo un risparmio idrico responsabile.',
                community: 'Comunità', communityDesc: 'Supporto reciproco tra agricoltori professionisti.',
                sensorWaName: 'RAYAT ACQUA', sensorWaDesc: 'Livello Bacino & Fabbisogno',
                hectaresLabel: 'Superficie (Ettari)', cropLabel: 'Tipo di Coltura',
                need: 'Fabbisogno', available: 'Disponibilità', ton: 'Ton', ha: 'Ha',
                statusOk: 'RISERVE OTTIMALI', statusAlert: 'ALERTA RISORSE',
                msgOk: 'Irrigazione sicura garantita', msgShortage: 'ATTENZIONE: Acqua insufficiente!',
                footerRights: '© 2026 Rayat Smart Monitoring. Tutti i diritti riservati.',
                banane: 'Banane', agrumi: 'Agrumi', pomodori: 'Pomodori', mais: 'Mais', fragole: 'Fragole', olive: 'Olive', citrus: 'Agrumi', tomatoes: 'Pomodori', banana: 'Banane', strawberry: 'Fragole',
                export: 'Scarica CSV', search: 'Cerca', time: 'Data/Ora', status: 'Stato',
                refreshDataAction: 'Aggiorna dati', refreshingDataAction: 'Aggiornamento in corso', monitoringOnline: 'Sensori online', monitoringOffline: 'Connessione instabile',
                appSubtitle: 'Rayat Smart Monitoring Professionale',
                welcome: 'Benvenuto', protected: 'Il Tuo Campo è Protetto 24/7', controlActive: 'Controllo continuo - La tua assicurazione agricola sempre attiva',
                loginTitle: 'Accedi', loginError: 'Email o password non corretti!', emailLabel: 'Email', passwordLabel: 'Password', loginBtn: 'ACCEDI', demoAccount: 'Account Demo:',
                rememberMe: 'Ricordami', showPassword: 'Mostra password', hidePassword: 'Nascondi password',
                loginNoAccount: 'Non hai un account?', loginRegisterNow: 'Registrati ora 🌾',
                customSolutionsTitle: 'Soluzioni Personalizzate', customSolutionsDesc: 'Non per forza devi avere tutti i nostri sensori!', contactUs: 'Contattaci per una Consulenza', features: 'Funzionalità:',
                sensorEnName: 'RAYAT ENERGIA', sensorEnDesc: 'Monitora consumo pompe e rileva guasti', sensorEnF1: 'Allarme salvavita', sensorEnF2: 'Ottimizzazione fasce', sensorEnF3: 'Rilevamento guasti',
                sensorWaF1: 'Livello Acqua', sensorWaF2: 'Allarme Scarso', sensorWaF3: 'Storico Riserve',
                sensorSoName: 'RAYAT SUOLO 7 IN 1', sensorSoDesc: 'Analisi completa: Umidità, pH, NPK - Rayat Smart Monitoring',
                sensorSoF1: 'Umidità del terreno', sensorSoF2: 'Temperatura del terreno', sensorSoF3: 'Conducibilità elettrica', sensorSoF4: 'pH', sensorSoF5: 'Azoto', sensorSoF6: 'Fosforo', sensorSoF7: 'Potassio',
                sensorClName: 'RAYAT CLIMA', sensorClDesc: 'Monitoraggio Clima - Rayat Smart Monitoring', sensorClF1: 'Allerta gelo SMS', sensorClF2: 'Previsione evaporazione', sensorClF3: 'Velocità vento', sensorClF4: 'Schermo solare per letture precise', sensorClF5: 'Resistenza agli agenti atmosferici estremi', sensorClF6: 'Clima', sensorClDetails: 'Monitoraggio Temperatura Aria, Umidità Aria e CO2.',
                tempAmbient: 'Temperatura Ambiente', relHumidity: 'Umidità Relativa',
                demoDashboard: 'Versione Demo Professionale', demoDesc: 'Esplora i dati dei sensori in tempo reale', history: 'Storico (Ultimi 30 Giorni)', details: 'Dettagli', weeklyAvg: 'Media Settimanale', maxPeak: 'Picco Massimo',
                generalStatus: 'Stato Generale', statusNormal: 'Normale', statusAttention: 'Attenzione', statusGood: 'Buono', statusHot: 'Caldo', statusCritical: 'Critico', statusLow: 'Basso', statusExcellent: 'Ottimo',
                alerts: 'Avvisi', notifications: 'Notifiche', noNotifications: 'Nessuna nuova notifica', settings: 'Impostazioni', thresholds: 'Soglie di Allarme', save: 'Salva Impostazioni', enableAlerts: 'Abilita Avvisi',
                alertCritical: 'CRITICO', alertWarning: 'ATTENZIONE', maxConsumption: 'Consumo Max (kW)', minLevel: 'Livello Minimo Acqua (m)', minMoisture: 'Umidità Minima Terreno (%)', maxTemp: 'Temperatura Max (°C)', minTemp: 'Temperatura Min (°C)',
                alertMsgEnergy: 'Consumo energetico elevato!', alertMsgWater: 'Livello acqua critico!', alertMsgSoil: 'Terreno troppo secco!', alertMsgTempHigh: 'Temperatura troppo alta!', alertMsgTempLow: 'Rischio gelo!',
                demoBtn: 'Versione Demo', dashboardBtn: 'Dashboard Privata', adminArea: 'Area Master Dashboard', masterDash: 'Master Dashboard Morocco',
                last24h: 'Ultime 24h', last7d: 'Ultimi 7 Giorni', last30d: 'Ultimi 30 Giorni', value: 'Valore', tableTitle: 'Dettaglio Dati', co2: 'CO2', pressure: 'Pressione', uvIndex: 'Indice UV', rain: 'Pioggia', windSpeed: 'Vento',
                ready: 'Pronto a Proteggere il Tuo Campo?', startNow: 'Inizia Ora',
                realTimeMonitoring: 'MONITORAGGIO IN TEMPO REALE', last7Days: 'ULTIMI 7 GIORNI',
                deleteAccount: 'Elimina Account', confirmDelete: 'Sei sicuro di voler eliminare definitivamente il tuo account? Questa azione è irreversibile.',
                usingCache: 'Dati offline (cache)', contactSupport: 'Contatta Supporto',
                privacyPolicy: 'Privacy Policy',
                regStep: 'Step', regOf: 'di', regPersonalData: 'Dati personali', regAgriType: 'Profilo agricolo', regFieldLoc: 'Posizione campo',
                regVerifyTitle: 'Crea il tuo account Rayat', regFullName: 'Nome e Cognome', regFirstName: 'Nome', regLastName: 'Cognome', regPhone: 'Numero di telefono', regEmailOpt: 'Email',
                regPass: 'Password', regPassHint: 'Scegli una password sicura', regOtpLabel: 'Inserisci codice OTP ricevuto su WhatsApp',
                regVerifyBtn: 'Verifica e continua', regSendOtpBtn: 'Invia codice via WhatsApp 📲', regCropTitle: 'Cosa coltivi?',
                regOtherCrop: 'Altro (scrivi qui)', regContinue: 'Continua ➡️', regLocTitle: 'Posizione del campo',
                regLocHint: 'Rileva la tua posizione o inserisci il nome del campo per trovarlo sulla mappa.',
                regDetectLoc: '📍 Rileva posizione automaticamente', regFieldName: 'Nome della località / campo',
                regFieldNameHint: 'Es: Taroudant, Souss-Massa', regCompleteBtn: 'Completa Registrazione 🚜', regBack: 'Torna indietro',
                regPrivacyNote: 'La registrazione viene salvata in modo privato e sarà visibile solo agli amministratori autorizzati.',
                regLocationRegion: 'Località / Regione', regLocationRegionHint: 'Es: Taroudant, Souss-Massa',
                regCropOptional: 'Coltura principale (opzionale)', regGpsOptional: 'Posizione GPS (opzionale)',
                regSaveBtn: 'Registrati Subito', regRequiredFields: 'Compila tutti i campi obbligatori per continuare.',
                contactTitle: 'Contatti e Sede', contactSub: 'Contattaci per informazioni, supporto tecnico, collaborazioni e appuntamenti',
                founderSection: 'Contatto diretto con il fondatore', founderText: 'Per partnership, progetti agricoli, supporto tecnico e opportunità di collaborazione, puoi contattare direttamente Zakaria Abid.',
                headquarters: 'Sede Operativa', addressLabel: 'Indirizzo', cityLabel: 'Città', regionLabel: 'Regione', countryLabel: 'Paese', openInMap: 'Apri in Mappa',
                formTitle: 'Inviaci un messaggio', formName: 'Nome e Cognome', formPhone: 'Numero di Telefono', formEmail: 'Indirizzo Email',
                formType: 'Tipo di richiesta', formMsg: 'Il tuo messaggio', formSubmit: 'Invia richiesta', formSuccess: 'La tua richiesta è stata inviata con successo',
                hoursTitle: 'Orari Assistenza', hoursWeek: 'Lunedì - Venerdì', hoursTime: '09:00 - 18:00',
                waSupport: 'Supporto WhatsApp disponibile negli orari lavorativi',
                ctaCallIt: 'Chiama Italia', ctaCallMa: 'Chiama Marocco', ctaWhatsapp: 'Chat WhatsApp', ctaEmail: 'Email Diretta',
                typeGeneral: 'Informazioni generali', typeSupport: 'Supporto tecnico', typeCollab: 'Collaborazione', typeDemo: 'Richiesta demo', typeMeeting: 'Appuntamento', typeOther: 'Altro',
                mapTitle: 'Clienti online con Rayat in Marocco', mapSub: 'Rete attiva di clienti agricoli, con focus principale su Souss-Massa',
                mapLegendOnline: 'Online con Rayat', mapLegendOffline: 'Offline', mapFocusArea: 'Area principale Rayat',
                statOnline: 'Clienti online ora', statMa: 'Clienti in Marocco', statSouss: 'Attivi in Souss-Massa',
                clientName: 'Cliente', crop: 'Coltura principale', locality: 'Località', region: 'Regione', statusOnline: 'Online con Rayat', lastActive: 'Ultima attività',
                whatsappSectionTitle: 'Contattaci direttamente su WhatsApp',
                whatsappSectionText: 'Scrivici per informazioni, supporto o per richiedere una demo di Rayat. Siamo disponibili tramite messaggi, note vocali o chiamata diretta. Rispondiamo rapidamente.',
                whatsappSectionButton: 'Scrivici su WhatsApp',
                whatsappButtonLabel: 'Apri WhatsApp Rayat',
                optimalRangeFor: 'Range ottimale per',
                optimalFor: 'Ottimale per',
                alertBadgeAttention: 'Attenzione',
                alertBadgeAlert: 'Allarme',
                activeAlertsTitle: 'Allarmi attivi',
                activeAlertsSubtitle: 'Eventi recenti legati alla coltura selezionata',
                batteryVoltageLabel: 'Tensione batteria',
                batteryTitle: 'Batteria',
                optimalRangePlain: 'Range ottimale',
                tempShort: 'Temp',
                humidityShort: 'Umidita',
                optimalShort: 'Ottimale',
                subscriptionExpiringEyebrow: 'Avviso abbonamento',
                subscriptionExpiringTitle: 'Il tuo piano sta per scadere',
                subscriptionExpiringText: 'L\'accesso resta attivo, ma l\'abbonamento termina {when}.',
                subscriptionExpiringSoonText: 'a breve',
                subscriptionExpiringInDays: 'tra {days} giorni',
                subscriptionExpiringOnDate: 'il {date}',
                subscriptionSupportCta: 'Supporto',
                subscriptionExpiredTitle: 'Abbonamento scaduto',
                subscriptionExpiredText: 'Il tuo piano di monitoraggio e giunto al termine. Per continuare ad accedere ai dati dei tuoi sensori e ricevere avvisi agronomici in tempo reale, rinnova il tuo abbonamento.',
                subscriptionRenewWhatsapp: 'Rinnova su WhatsApp',
                continueWithoutLogin: 'Continua senza login',
                termsOfService: 'Termini di Servizio',
                navMenu: 'Menu', mobileMenuClose: 'Chiudi menu',
                forgotPassword: 'Password dimenticata?', forgotPasswordSubmit: 'Invia link di reset', forgotPasswordSuccess: 'Se l\'account esiste, riceverai un\'email con il link di reset.',
                forgotPasswordEmailRequired: 'Inserisci la tua email per ricevere il link di reset.',
                resetPasswordTitle: 'Reimposta password', resetPasswordDesc: 'Scegli una nuova password sicura per il tuo account Rayat.',
                newPasswordLabel: 'Nuova password', confirmPasswordLabel: 'Conferma password', resetPasswordSubmit: 'Aggiorna password',
                resetPasswordSuccess: 'Password aggiornata con successo. Ora puoi accedere.', resetPasswordInvalidToken: 'Link di reset non valido o scaduto.',
                resetPasswordMismatch: 'Le password non coincidono.', backToLogin: 'Torna al login',
                cropSelectorTitle: 'Coltura selezionata', cropSelectorHint: 'Rayat usa questa coltura per personalizzare consigli e stime locali.',
                cropCustomLabel: 'Specifica la coltura', cropCustomPlaceholder: 'Es. Melone, melanzana, papaya',
                cropOptionBanane: 'Banane', cropOptionTomate: 'Pomodoro', cropOptionPoivron: 'Peperone', cropOptionConcombre: 'Cetriolo', cropOptionMelon: 'Melone', cropOptionCourgette: 'Zucchina',
                cropOptionLaitue: 'Lattuga', cropOptionFraise: 'Fragola', cropOptionAgrumes: 'Agrumi', cropOptionOlive: 'Olivo', cropOptionArgan: 'Argan',
                cropOptionBle: 'Grano', cropOptionOrge: 'Orzo', cropOptionMais: 'Mais', cropOptionLuzerne: 'Erba medica', cropOptionAutre: 'Altro'
            },
            en: {
                home: 'Home', services: 'Services', aboutUs: 'About Us', demo: 'Demo', myFieldNav: 'My Field', login: 'Login', logout: 'Logout',
                profileNav: 'Profile',
                profileTitle: 'Your Rayat profile',
                profileSubtitle: 'Manage your personal details and review assigned sensors in read-only mode.',
                profilePersonalInfo: 'Account details',
                profileDescription: 'Description',
                profilePhoto: 'Profile photo',
                profilePhotoHint: 'Upload a clear, professional image.',
                profilePhotoRemove: 'Remove photo',
                profileSave: 'Save profile',
                profileSaved: 'Profile updated successfully.',
                profileSensorsTitle: 'Assigned sensors',
                profileSensorsHint: 'This section is view-only.',
                profileNoSensors: 'No assigned sensors are available right now.',
                profileViewOnly: 'View only',
                profileRoleLabel: 'Role',
                profileDeviceLabel: 'Device',
                profileLatestReading: 'Latest reading',
                profileMenuInfo: 'Profile',
                profileMenuEdit: 'Settings',
                profileMenuLogout: 'Logout',
                hero: 'Healthy Soil = Rich Harvest', heroSub: 'Monitor your field 24/7 with smart sensors',
                heroEyebrow: 'Rayat Smart Monitoring',
                heroTitleLine1: 'Data-Driven Agriculture',
                heroTitleLine2: 'Better Decisions.',
                heroTitleAccent: 'Better Yields.',
                heroPlatformSub: 'Advanced IoT monitoring for soil, climate, water and energy, all in one platform.',
                tryDemo: 'Try Demo', discoverServices: 'Discover Services', insurance: 'Your agricultural insurance - Continuous real-time monitoring',
                ourSensors: 'Our Sensors', ourReality: 'Our Reality',
                homeTechnologyTitle: 'Rayat Technology',
                homeLiveSensorsTitle: 'Real data from Rayat sensors installed in Taroudant',
                homeLiveSensorsSubtitle: 'Live data from sensors installed in a banana greenhouse in Taroudant, monitored together with Hassan Arab and over 20 years of field experience to analyze readings and improve decisions on the ground.',
                homeLiveSensorsSystemTitle: 'Complete system: Soil + Climate',
                homeLiveSensorsCtaTitle: 'Contact me on WhatsApp',
                homeLiveSensorsCtaNote: 'One click opens the direct chat',
                homeLiveSensorsCtaAria: 'Open the direct WhatsApp chat',
                homeStatusOnline: 'Online',
                homeStatusOffline: 'Offline',
                liveMonitoringTitle: 'Real-time monitoring',
                liveMonitoringSubtitle: 'Live Rayat sensor data refreshed automatically every 60 seconds.',
                sensorNotInstalled: 'Sensor not installed',
                ourRealityDesc: 'Rayat was born from a passion for agriculture. We are a team of experts bringing accessible innovation to the fields.',
                ourMission: 'Our Mission', ourMissionDesc: 'Our mission is simple. We believe every farmer deserves professional tools.',
                ourDuty: 'Our Duty to Clients', ourDutyDesc: 'We are your trusted partner. We ensure:',
                support247: '24/7 Support: Always available', training: 'Complete Training: We teach you everything', transparency: 'Total Transparency: No hidden costs',
                customSolutions: 'Custom Solutions', qualityGuaranteed: 'Quality Guaranteed',
                ourCommitment: 'Our Commitment', ourCommitmentDesc: 'We offer peace of mind and security.',
                innovation: 'Innovation', innovationDesc: 'Advanced technologies for the best results',
                sustainability: 'Sustainability', sustainabilityDesc: 'Responsible agriculture',
                community: 'Community', communityDesc: 'Farmer support forum',
                sensorWaName: 'RAYAT WATER', sensorWaDesc: 'Water Basin Level & Needs Monitoring',
                hectaresLabel: 'Field Area (Hectares)', cropLabel: 'Crop Type',
                need: 'Need', available: 'Available', ton: 'Tons', ha: 'Ha',
                statusOk: 'SYSTEM SAFE', statusAlert: 'RESOURCE ALERT',
                msgOk: 'Safe Irrigation - Optimal Reserves', msgShortage: 'ATTENTION: Insufficient water for selected crop!',
                footerRights: '© 2026 Rayat Smart Monitoring. All rights reserved.',
                banane: 'Bananas', agrumi: 'Citrus (Oranges/Lemons)', pomodori: 'Tomatoes', mais: 'Corn', fragole: 'Strawberries', olive: 'Olives', citrus: 'Citrus', tomatoes: 'Tomatoes', banana: 'Bananas', strawberry: 'Strawberries',
                export: 'Download Report (CSV)', search: 'Search', time: 'Time', status: 'Status',
                refreshDataAction: 'Refresh data', refreshingDataAction: 'Refreshing data', monitoringOnline: 'Sensors online', monitoringOffline: 'Connection unstable',
                appSubtitle: 'Rayat Smart Monitoring',
                welcome: 'Welcome', protected: 'Your Field is Protected 24/7', controlActive: 'Continuous monitoring - Your agricultural insurance always active',
                loginTitle: 'Login', loginError: 'Incorrect email or password!', emailLabel: 'Email', passwordLabel: 'Password', loginBtn: 'LOGIN', demoAccount: 'Demo Account:',
                rememberMe: 'Remember me', showPassword: 'Show password', hidePassword: 'Hide password',
                loginNoAccount: 'Don\'t have an account?', loginRegisterNow: 'Register now 🌾',
                customSolutionsTitle: 'Custom Solutions', customSolutionsDesc: 'You don\'t need all our sensors!', contactUs: 'Contact Us for Advice', features: 'Features:',
                sensorEnName: 'RAYAT ENERGY', sensorEnDesc: 'Monitor pump consumption and faults', sensorEnF1: 'Life-saving alarm', sensorEnF2: 'Schedule optimization', sensorEnF3: 'Fault detection',
                sensorWaF1: 'Water Level', sensorWaF2: 'Low Level Alarm', sensorWaF3: 'Reservoir History',
                sensorSoName: 'RAYAT SOIL 7 IN 1', sensorSoDesc: 'Complete analysis: Moisture, pH, NPK - Rayat Smart Monitoring',
                sensorSoF1: 'Soil Moisture', sensorSoF2: 'Soil Temperature', sensorSoF3: 'Electrical Conductivity', sensorSoF4: 'pH', sensorSoF5: 'Nitrogen', sensorSoF6: 'Phosphorus', sensorSoF7: 'Potassium',
                sensorClName: 'RAYAT CLIMATE', sensorClDesc: 'Climate Monitoring - Rayat Smart Monitoring', sensorClF1: 'Frost SMS alert', sensorClF2: 'Evaporation forecast', sensorClF3: 'Wind speed', sensorClF4: 'Solar shield for precise readings', sensorClF5: 'Resistance to extreme weather conditions', sensorClF6: 'Climate', sensorClDetails: 'Air Temperature, Air Humidity and CO2 Monitoring.',
                tempAmbient: 'Temperature Ambient', relHumidity: 'Relative Humidity',
                demoDashboard: 'Professional Demo Version', demoDesc: 'Explore real-time sensor data', history: 'History (Last 30 Days)', details: 'Details', weeklyAvg: 'Weekly Average', maxPeak: 'Max Peak',
                generalStatus: 'General Status', statusNormal: 'Normal', statusAttention: 'Attention', statusGood: 'Good', statusHot: 'Hot', statusCritical: 'Critical', statusLow: 'Low', statusExcellent: 'Excellent',
                alerts: 'Alerts', notifications: 'Notifications', noNotifications: 'No new notifications', settings: 'Settings', thresholds: 'Alarm Thresholds', save: 'Save Settings', enableAlerts: 'Enable Alerts',
                alertCritical: 'CRITICAL', alertWarning: 'WARNING', maxConsumption: 'Max Consumption (kW)', minLevel: 'Min Water Level (m)', minMoisture: 'Min Soil Moisture (%)', maxTemp: 'Max Temp (°C)', minTemp: 'Min Temp (°C)',
                alertMsgEnergy: 'High energy consumption!', alertMsgWater: 'Critical water level!', alertMsgSoil: 'Soil too dry!', alertMsgTempHigh: 'Temperature too high!', alertMsgTempLow: 'Frost risk!',
                demoBtn: 'Demo Version', dashboardBtn: 'Private Dashboard', adminArea: 'Master Dashboard Area', masterDash: 'Master Dashboard Morocco',
                last24h: 'Last 24h', last7d: 'Last 7 Days', last30d: 'Last 30 Days', value: 'Value', tableTitle: 'Data Details', co2: 'CO2', pressure: 'Pressure', uvIndex: 'UV Index', rain: 'Rain', windSpeed: 'Wind',
                ready: 'Ready to Protect Your Field?', startNow: 'Start Now',
                realTimeMonitoring: 'REAL-TIME MONITORING', last7Days: 'LAST 7 DAYS',
                privacyPolicy: 'Privacy Policy',
                regStep: 'Step', regOf: 'of', regPersonalData: 'Personal Details', regAgriType: 'Farm Profile', regFieldLoc: 'Field Location',
                regVerifyTitle: 'Create your Rayat account', regFullName: 'Full Name', regFirstName: 'First Name', regLastName: 'Last Name', regPhone: 'Phone Number', regEmailOpt: 'Email',
                regPass: 'Password', regPassHint: 'Choose a secure password', regOtpLabel: 'Enter OTP code received on WhatsApp',
                regVerifyBtn: 'Verify and continue', regSendOtpBtn: 'Send code via WhatsApp 📲', regCropTitle: 'What do you grow?',
                regOtherCrop: 'Other (write here)', regContinue: 'Continue ➡️', regLocTitle: 'Field Location',
                regLocHint: 'Auto-detect your position or enter the field name to find it on the map.',
                regDetectLoc: '📍 Detect position automatically', regFieldName: 'Field / Location Name',
                regFieldNameHint: 'Ex: Taroudant, Souss-Massa', regCompleteBtn: 'Complete Registration 🚜', regBack: 'Go back',
                regPrivacyNote: 'Your registration is stored privately and is visible only to authorized administrators.',
                regLocationRegion: 'Locality / Region', regLocationRegionHint: 'Ex: Taroudant, Souss-Massa',
                regCropOptional: 'Main crop (optional)', regGpsOptional: 'GPS position (optional)',
                regSaveBtn: 'Register Now', regRequiredFields: 'Fill in all required fields to continue.',
                contactTitle: 'Contact & Headquarters', contactSub: 'Contact us for information, technical support, partnerships and appointments',
                founderSection: 'Direct Contact with Founder', founderText: 'For partnerships, agricultural projects, technical support and collaboration opportunities, you can contact Zakaria Abid directly.',
                headquarters: 'Headquarters', addressLabel: 'Address', cityLabel: 'City', regionLabel: 'Region', countryLabel: 'Country', openInMap: 'Open in Map',
                formTitle: 'Send us a message', formName: 'Full Name', formPhone: 'Phone Number', formEmail: 'Email Address',
                formType: 'Request Type', formMsg: 'Your message', formSubmit: 'Send Request', formSuccess: 'Your request has been sent successfully',
                hoursTitle: 'Support Hours', hoursWeek: 'Monday - Friday', hoursTime: '09:00 - 18:00',
                waSupport: 'WhatsApp support available during business hours',
                ctaCallIt: 'Call (Italy)', ctaCallMa: 'Call (Morocco)', ctaWhatsapp: 'WhatsApp Chat', ctaEmail: 'Send Email',
                typeGeneral: 'General Information', typeSupport: 'Technical Support', typeCollab: 'Collaboration', typeDemo: 'Demo Request', typeMeeting: 'Appointment', typeOther: 'Other',
                mapTitle: 'Clients online with Rayat in Morocco', mapSub: 'Active network of agricultural clients, with main focus on Souss-Massa',
                mapLegendOnline: 'Online with Rayat', mapLegendOffline: 'Offline', mapFocusArea: 'Rayat Main Area',
                statOnline: 'Clients online now', statMa: 'Clients in Morocco', statSouss: 'Active in Souss-Massa',
                clientName: 'Client', crop: 'Main Crop', locality: 'Locality', region: 'Region', statusOnline: 'Online with Rayat', lastActive: 'Last active',
                whatsappSectionTitle: 'Contact us directly on WhatsApp',
                whatsappSectionText: 'Write to us for information, support or to request a Rayat demo. We are available through messages, voice notes or direct calls. We reply quickly.',
                whatsappSectionButton: 'Message us on WhatsApp',
                whatsappButtonLabel: 'Open Rayat WhatsApp',
                optimalRangeFor: 'Optimal range for',
                optimalFor: 'Optimal for',
                alertBadgeAttention: 'Attention',
                alertBadgeAlert: 'Alert',
                activeAlertsTitle: 'Active alerts',
                activeAlertsSubtitle: 'Recent events tied to the selected crop',
                batteryVoltageLabel: 'Battery voltage',
                batteryTitle: 'Battery',
                optimalRangePlain: 'Optimal range',
                tempShort: 'Temp',
                humidityShort: 'Hum',
                optimalShort: 'Optimal',
                subscriptionExpiringEyebrow: 'Subscription notice',
                subscriptionExpiringTitle: 'Your plan expires soon',
                subscriptionExpiringText: 'Access stays active, but the subscription ends {when}.',
                subscriptionExpiringSoonText: 'soon',
                subscriptionExpiringInDays: 'in {days} day(s)',
                subscriptionExpiringOnDate: 'on {date}',
                subscriptionSupportCta: 'Support',
                subscriptionExpiredTitle: 'Subscription expired',
                subscriptionExpiredText: 'Your monitoring plan has ended. To keep accessing sensor data and real-time agronomic alerts, renew your subscription.',
                subscriptionRenewWhatsapp: 'Renew on WhatsApp',
                continueWithoutLogin: 'Continue without login',
                termsOfService: 'Terms of Service',
                navMenu: 'Menu', mobileMenuClose: 'Close menu',
                forgotPassword: 'Forgot password?', forgotPasswordSubmit: 'Send reset link', forgotPasswordSuccess: 'If the account exists, you will receive an email with the reset link.',
                forgotPasswordEmailRequired: 'Enter your email to receive the reset link.',
                resetPasswordTitle: 'Reset password', resetPasswordDesc: 'Choose a new secure password for your Rayat account.',
                newPasswordLabel: 'New password', confirmPasswordLabel: 'Confirm password', resetPasswordSubmit: 'Update password',
                resetPasswordSuccess: 'Password updated successfully. You can now sign in.', resetPasswordInvalidToken: 'Reset link is invalid or expired.',
                resetPasswordMismatch: 'Passwords do not match.', backToLogin: 'Back to login',
                cropSelectorTitle: 'Selected crop', cropSelectorHint: 'Rayat uses this crop to personalize guidance and local estimates.',
                cropCustomLabel: 'Specify the crop', cropCustomPlaceholder: 'Example: melon, eggplant, papaya',
                cropOptionBanane: 'Bananas', cropOptionTomate: 'Tomato', cropOptionPoivron: 'Pepper', cropOptionConcombre: 'Cucumber', cropOptionMelon: 'Melon', cropOptionCourgette: 'Zucchini',
                cropOptionLaitue: 'Lettuce', cropOptionFraise: 'Strawberry', cropOptionAgrumes: 'Citrus', cropOptionOlive: 'Olive', cropOptionArgan: 'Argan',
                cropOptionBle: 'Wheat', cropOptionOrge: 'Barley', cropOptionMais: 'Corn', cropOptionLuzerne: 'Alfalfa', cropOptionAutre: 'Other'
            },
            fr: {
                home: 'Accueil', services: 'Services', aboutUs: 'Qui Sommes-Nous', demo: 'Démo', myFieldNav: 'Mon exploitation', login: 'Connexion', logout: 'Déconnexion',
                profileNav: 'Profil',
                profileTitle: 'Votre profil Rayat',
                profileSubtitle: 'Gerez vos informations personnelles et consultez les capteurs attribues en lecture seule.',
                profilePersonalInfo: 'Informations du compte',
                profileDescription: 'Description',
                profilePhoto: 'Photo de profil',
                profilePhotoHint: 'Telechargez une image claire et professionnelle.',
                profilePhotoRemove: 'Supprimer la photo',
                profileSave: 'Enregistrer le profil',
                profileSaved: 'Profil mis a jour avec succes.',
                profileSensorsTitle: 'Capteurs attribues',
                profileSensorsHint: 'Cette section est en lecture seule.',
                profileNoSensors: 'Aucun capteur attribue n est disponible pour le moment.',
                profileViewOnly: 'Lecture seule',
                profileRoleLabel: 'Role',
                profileDeviceLabel: 'Appareil',
                profileLatestReading: 'Derniere mesure',
                profileMenuInfo: 'Profil',
                profileMenuEdit: 'Paramètres',
                profileMenuLogout: 'Deconnexion',
                hero: 'Sol Sain = Récolte Riche', heroSub: 'Surveillance 24h/24 avec capteurs intelligents Rayat',
                heroEyebrow: 'Rayat Smart Monitoring',
                heroTitleLine1: 'Agriculture pilotee par les donnees',
                heroTitleLine2: 'Meilleures decisions.',
                heroTitleAccent: 'Meilleurs rendements.',
                heroPlatformSub: 'Surveillance IoT avancee du sol, du climat, de l\'eau et de l\'energie, dans une seule plateforme.',
                tryDemo: 'Tester la Démo', discoverServices: 'Nos Services', insurance: 'Assurance Agricole Rayat Smart Monitoring',
                ourSensors: 'Technologie Rayat', ourReality: 'Notre Réalité',
                homeTechnologyTitle: 'Technologie Rayat',
                homeLiveSensorsTitle: 'Données réelles des capteurs Rayat installés à Taroudant',
                homeLiveSensorsSubtitle: 'Données réelles issues de capteurs installés dans une serre de bananes à Taroudant, suivies avec Hassan Arab et plus de 20 ans d\'expérience pour analyser les mesures et optimiser les décisions sur le terrain.',
                homeLiveSensorsSystemTitle: 'Système complet : Sol + Climat',
                homeLiveSensorsCtaTitle: 'Contactez-moi sur WhatsApp',
                homeLiveSensorsCtaNote: 'Un clic ouvre la discussion directe',
                homeLiveSensorsCtaAria: 'Ouvrir la discussion directe sur WhatsApp',
                homeStatusOnline: 'En ligne',
                homeStatusOffline: 'Hors ligne',
                liveMonitoringTitle: 'Surveillance en temps réel',
                liveMonitoringSubtitle: 'Données capteurs Rayat mises à jour automatiquement toutes les 60 secondes.',
                sensorNotInstalled: 'Capteur non installé',
                ourRealityDesc: 'Rayat est né d\'une passion pour l\'agriculture. Nous sommes une équipe d\'experts apportant une innovation accessible directement aux champs.',
                ourMission: 'Notre Mission', ourMissionDesc: 'Nous croyons que chaque agriculteur mérite des outils professionnels de surveillance.',
                ourDuty: 'Devoir Professionnel', ourDutyDesc: 'Votre partenaire de confiance pour une gestion efficace des ressources.',
                support247: 'Support 24/7', training: 'Formation Continue', transparency: 'Transparence Totale',
                customSolutions: 'Solutions Sur Mesure', qualityGuaranteed: 'Qualité Certifiée',
                ourCommitment: 'Notre Engagement', ourCommitmentDesc: 'Nous offrons sécurité et tranquillité d\'esprit pour votre exploitation.',
                innovation: 'Innovation', innovationDesc: 'Technologies avancées pour l\'agriculture de demain.',
                sustainability: 'Durabilité', sustainabilityDesc: 'Gestion responsable et économie d\'eau.',
                community: 'Communauté', communityDesc: 'Support entre agriculteurs professionnels.',
                sensorWaName: 'RAYAT EAU', sensorWaDesc: 'Bassin & Besoin en Eau',
                hectaresLabel: 'Surface (Hectares)', cropLabel: 'Type de Culture',
                need: 'Besoin', available: 'Disponibilité', ton: 'Tonnes', ha: 'Ha',
                statusOk: 'RÉSERVE OPTIMALE', statusAlert: 'ALERTE RESSOURCES',
                msgOk: 'Irrigation sécurisée garantie', msgShortage: 'ATTENTION : Eau insuffisante !',
                footerRights: '© 2026 Rayat Smart Monitoring. Tous droits réservés.',
                banane: 'Bananes', agrumi: 'Agrumes', pomodori: 'Tomates', mais: 'Maïs', fragole: 'Fraises', olive: 'Olives', citrus: 'Agrumes', tomatoes: 'Tomates', banana: 'Bananes', strawberry: 'Fraises',
                export: 'Exporter CSV', search: 'Chercher', time: 'Date/Heure', status: 'Statut',
                refreshDataAction: 'Actualiser les donnees', refreshingDataAction: 'Actualisation en cours', monitoringOnline: 'Capteurs en ligne', monitoringOffline: 'Connexion instable',
                appSubtitle: 'Rayat Smart Monitoring Professionnel',
                welcome: 'Bienvenue', protected: 'Votre Champ est Protégé 24h/24', controlActive: 'Surveillance continue - Votre assurance agricole toujours active',
                loginTitle: 'Connexion', loginError: 'Email ou mot de passe incorrect!', emailLabel: 'Email', passwordLabel: 'Mot de passe', loginBtn: 'CONNEXION', demoAccount: 'Compte Démo:',
                rememberMe: 'Se souvenir de moi', showPassword: 'Afficher le mot de passe', hidePassword: 'Masquer le mot de passe',
                loginNoAccount: 'Vous n\'avez pas de compte ?', loginRegisterNow: 'Inscrivez-vous maintenant 🌾',
                customSolutionsTitle: 'Solutions Personnalisées', customSolutionsDesc: 'Vous n\'avez pas besoin de tous nos capteurs !', contactUs: 'Contactez-nous pour Conseil', features: 'Fonctionnalités :',
                sensorEnName: 'RAYAT ÉNERGIE', sensorEnDesc: 'Surveillance conso pompes et pannes', sensorEnF1: 'Alarme vitale', sensorEnF2: 'Optimisation horaires', sensorEnF3: 'Détection pannes',
                sensorWaF1: 'Niveau d\'eau', sensorWaF2: 'Alarme puits vide', sensorWaF3: 'Historique nappe',
                sensorSoName: 'RAYAT SOL 7 EN 1', sensorSoDesc: 'Analyse complète : Humidité, pH, NPK',
                sensorSoF1: 'Humidité du sol', sensorSoF2: 'Température du sol', sensorSoF3: 'Conductivité électrique', sensorSoF4: 'pH', sensorSoF5: 'Azote', sensorSoF6: 'Phosphore', sensorSoF7: 'Potassium',
                sensorClName: 'RAYAT CLIMAT', sensorClDesc: 'Surveillance du Climat - Rayat Smart Monitoring', sensorClF1: 'Alerte gel SMS', sensorClF2: 'Prévision évaporation', sensorClF3: 'Vitesse vent', sensorClF4: 'Écran solaire pour des lectures précises', sensorClF5: 'Résistance aux conditions météorologiques extrêmes', sensorClF6: 'Climat', sensorClDetails: 'Surveillance de la Température, Humidité et CO2.',
                tempAmbient: 'Température Ambiante', relHumidity: 'Humidité Relative',
                demoDashboard: 'Version Démo Professionnelle', demoDesc: 'Explorez les données en temps réel', history: 'Historique (30 derniers jours)', details: 'Détails', weeklyAvg: 'Moyenne Hebdo', maxPeak: 'Pic Max',
                generalStatus: 'État Général', statusNormal: 'Normal', statusAttention: 'Attention', statusGood: 'Bon', statusHot: 'Chaud', statusCritical: 'Critique', statusLow: 'Bas', statusExcellent: 'Excellent',
                alerts: 'Alertes', notifications: 'Notifications', noNotifications: 'Aucune nouvelle notification', settings: 'Paramètres', thresholds: 'Seuils d\'alarme', save: 'Sauvegarder', enableAlerts: 'Activer les alertes',
                alertCritical: 'CRITIQUE', alertWarning: 'ATTENTION', maxConsumption: 'Conso Max (kW)', minLevel: 'Niveau Min Eau (m)', minMoisture: 'Humidité Min Sol (%)', maxTemp: 'Temp Max (°C)', minTemp: 'Temp Min (°C)',
                alertMsgEnergy: 'Consommation d\'énergie élevée !', alertMsgWater: 'Niveau d\'eau critique !', alertMsgSoil: 'Sol trop sec !', alertMsgTempHigh: 'Température trop élevée !', alertMsgTempLow: 'Risque de gel !',
                demoBtn: 'Version Démo', dashboardBtn: 'Tableau de Bord Privé', adminArea: 'Zone Master Dashboard', masterDash: 'Master Dashboard Maroc',
                last24h: 'Dernières 24h', last7d: '7 Derniers Jours', last30d: '30 Derniers Jours', value: 'Valeur', tableTitle: 'Détails des Données', co2: 'CO2', pressure: 'Pression', uvIndex: 'Indice UV', rain: 'Pluie', windSpeed: 'Vent',
                ready: 'Prêt à Protéger Votre Champ?', startNow: 'Commencer',
                realTimeMonitoring: 'SURVEILLANCE EN TEMPS RÉEL', last7Days: '7 DERNIERS JOURS',
                privacyPolicy: 'Politique de Confidentialité',
                regStep: 'Étape', regOf: 'sur', regPersonalData: 'Données personnelles', regAgriType: 'Profil agricole', regFieldLoc: 'Position du champ',
                regVerifyTitle: 'Créer votre compte Rayat', regFullName: 'Nom et Prénom', regFirstName: 'Prénom', regLastName: 'Nom', regPhone: 'Numéro de téléphone', regEmailOpt: 'Email',
                regPass: 'Mot de passe', regPassHint: 'Choisissez un mot de passe sécurisé', regOtpLabel: 'Entrez le code OTP reçu sur WhatsApp',
                regVerifyBtn: 'Vérifier et continuer', regSendOtpBtn: 'Envoyer le code via WhatsApp 📲', regCropTitle: 'Que cultivez-vous ?',
                regOtherCrop: 'Autre (écrire ici)', regContinue: 'Continuer ➡️', regLocTitle: 'Emplacement du champ',
                regLocHint: 'Détectez votre position ou entrez le nom du champ pour le trouver sur la carte.',
                regDetectLoc: '📍 Détecter la position automatiquement', regFieldName: 'Nom de la localité / du champ',
                regFieldNameHint: 'Ex : Taroudant, Souss-Massa', regCompleteBtn: 'Terminer l\'inscription 🚜', regBack: 'Retour',
                regPrivacyNote: 'L’inscription est enregistrée de manière privée et n’est visible que par les administrateurs autorisés.',
                regLocationRegion: 'Localité / Région', regLocationRegionHint: 'Ex : Taroudant, Souss-Massa',
                regCropOptional: 'Culture principale (optionnelle)', regGpsOptional: 'Position GPS (optionnelle)',
                regSaveBtn: 'S\'inscrire maintenant', regRequiredFields: 'Remplissez tous les champs obligatoires pour continuer.',
                contactTitle: 'Contacts et Siège', contactSub: 'Contactez-nous pour toute information, support technique, collaborations et rendez-vous',
                founderSection: 'Contact Direct avec le Fondateur', founderText: 'Pour les partenariats, projets agricoles, support technique et opportunités de collaboration, vous pouvez contacter directement Zakaria Abid.',
                headquarters: 'Siège Social', addressLabel: 'Adresse', cityLabel: 'Ville', regionLabel: 'Région', countryLabel: 'Pays', openInMap: 'Ouvrir sur la carte',
                formTitle: 'Envoyez-nous un message', formName: 'Nom et Prénom', formPhone: 'Numéro de Téléphone', formEmail: 'Adresse Email',
                formType: 'Type de Demande', formMsg: 'Votre message', formSubmit: 'Envoyer la Demande', formSuccess: 'Votre demande a été envoyée con succès',
                hoursTitle: 'Heures d\'Assistance', hoursWeek: 'Lundi - Vendredi', hoursTime: '09:00 - 18:00',
                waSupport: 'Support WhatsApp disponible pendant les heures de travail',
                ctaCallIt: 'Appeler (IT)', ctaCallMa: 'Appeler (MA)', ctaWhatsapp: 'Chat WhatsApp', ctaEmail: 'Email Direct',
                typeGeneral: 'Informations générales', typeSupport: 'Support technique', typeCollab: 'Collaboration', typeDemo: 'Demande de démo', typeMeeting: 'Rendez-vous', typeOther: 'Autre',
                mapTitle: 'Clients en ligne avec Rayat au Maroc', mapSub: 'Réseau actif de clients agricoles, avec focus principal sur Souss-Massa',
                mapLegendOnline: 'En ligne avec Rayat', mapLegendOffline: 'Hors ligne', mapFocusArea: 'Zone principale Rayat',
                statOnline: 'Clients en ligne', statMa: 'Clients au Maroc', statSouss: 'Actifs à Souss-Massa',
                clientName: 'Client', crop: 'Culture principale', locality: 'Localité', region: 'Région', statusOnline: 'En ligne avec Rayat', lastActive: 'Dernière activité',
                whatsappSectionTitle: 'Contactez-nous directement sur WhatsApp',
                whatsappSectionText: 'Écrivez-nous pour obtenir des informations, du support ou demander une démo Rayat. Nous sommes disponibles par message, note vocale ou appel direct. Nous répondons rapidement.',
                whatsappSectionButton: 'Écrire sur WhatsApp',
                whatsappButtonLabel: 'Ouvrir WhatsApp Rayat',
                optimalRangeFor: 'Plage ideale pour',
                optimalFor: 'Ideal pour',
                alertBadgeAttention: 'Attention',
                alertBadgeAlert: 'Alerte',
                activeAlertsTitle: 'Alertes actives',
                activeAlertsSubtitle: 'Evenements recents lies a la culture choisie',
                batteryVoltageLabel: 'Tension batterie',
                batteryTitle: 'Batterie',
                optimalRangePlain: 'Plage optimale',
                tempShort: 'Temp',
                humidityShort: 'Hum',
                optimalShort: 'Optimal',
                subscriptionExpiringEyebrow: 'Avis abonnement',
                subscriptionExpiringTitle: 'Votre forfait expire bientot',
                subscriptionExpiringText: 'L\'acces reste actif, mais l\'abonnement se termine {when}.',
                subscriptionExpiringSoonText: 'bientot',
                subscriptionExpiringInDays: 'dans {days} jour(s)',
                subscriptionExpiringOnDate: 'le {date}',
                subscriptionSupportCta: 'Support',
                subscriptionExpiredTitle: 'Abonnement expire',
                subscriptionExpiredText: 'Votre forfait de surveillance est arrive a son terme. Pour continuer a acceder aux donnees des capteurs et aux alertes agronomiques en temps reel, renouvelez votre abonnement.',
                subscriptionRenewWhatsapp: 'Renouveler sur WhatsApp',
                continueWithoutLogin: 'Continuer sans connexion',
                termsOfService: 'Conditions d\'utilisation',
                navMenu: 'Menu', mobileMenuClose: 'Fermer le menu',
                forgotPassword: 'Mot de passe oublié ?', forgotPasswordSubmit: 'Envoyer le lien de reinitialisation', forgotPasswordSuccess: 'Si le compte existe, vous recevrez un email avec le lien de reinitialisation.',
                forgotPasswordEmailRequired: 'Entrez votre email pour recevoir le lien de reinitialisation.',
                resetPasswordTitle: 'Reinitialiser le mot de passe', resetPasswordDesc: 'Choisissez un nouveau mot de passe securise pour votre compte Rayat.',
                newPasswordLabel: 'Nouveau mot de passe', confirmPasswordLabel: 'Confirmer le mot de passe', resetPasswordSubmit: 'Mettre a jour le mot de passe',
                resetPasswordSuccess: 'Mot de passe mis a jour avec succes. Vous pouvez maintenant vous connecter.', resetPasswordInvalidToken: 'Lien de reinitialisation invalide ou expire.',
                resetPasswordMismatch: 'Les mots de passe ne correspondent pas.', backToLogin: 'Retour a la connexion',
                cropSelectorTitle: 'Culture selectionnee', cropSelectorHint: 'Rayat utilise cette culture pour personnaliser les recommandations et les estimations.',
                cropCustomLabel: 'Precisez la culture', cropCustomPlaceholder: 'Ex. melon, aubergine, papaye',
                cropOptionBanane: 'Banane', cropOptionTomate: 'Tomate', cropOptionPoivron: 'Poivron', cropOptionConcombre: 'Concombre', cropOptionMelon: 'Melon', cropOptionCourgette: 'Courgette',
                cropOptionLaitue: 'Laitue', cropOptionFraise: 'Fraise', cropOptionAgrumes: 'Agrumes', cropOptionOlive: 'Olivier', cropOptionArgan: 'Argan',
                cropOptionBle: 'Ble', cropOptionOrge: 'Orge', cropOptionMais: 'Mais', cropOptionLuzerne: 'Luzerne', cropOptionAutre: 'Autre'
            },
            ar: {
                home: 'الرئيسية', services: 'الخدمات', aboutUs: 'من نحن', demo: 'تجريبي', myFieldNav: 'مزرعتي', login: 'دخول', logout: 'خروج',
                profileNav: 'الملف الشخصي',
                profileTitle: 'ملفك الشخصي في رايات',
                profileSubtitle: 'قم بإدارة بياناتك الشخصية وراجع الحساسات المخصصة لك في وضع العرض فقط.',
                profilePersonalInfo: 'بيانات الحساب',
                profileDescription: 'الوصف',
                profilePhoto: 'صورة الملف الشخصي',
                profilePhotoHint: 'حمّل صورة واضحة واحترافية.',
                profilePhotoRemove: 'إزالة الصورة',
                profileSave: 'حفظ الملف الشخصي',
                profileSaved: 'تم تحديث الملف الشخصي بنجاح.',
                profileSensorsTitle: 'الحساسات المخصصة',
                profileSensorsHint: 'هذا القسم للعرض فقط.',
                profileNoSensors: 'لا توجد حساسات مخصصة متاحة حاليا.',
                profileViewOnly: 'عرض فقط',
                profileRoleLabel: 'الدور',
                profileDeviceLabel: 'الجهاز',
                profileLatestReading: 'آخر قراءة',
                profileMenuInfo: 'الملف الشخصي',
                profileMenuEdit: 'الإعدادات',
                profileMenuLogout: 'تسجيل الخروج',
                hero: 'تربة صحية = حصاد غني', heroSub: 'مراقبة 24/7 بأجهزة استشعار رايات الذكية',
                heroEyebrow: 'Rayat Smart Monitoring',
                heroTitleLine1: 'زراعة مدفوعة بالبيانات',
                heroTitleLine2: 'قرارات أفضل.',
                heroTitleAccent: 'محاصيل أفضل.',
                heroPlatformSub: 'مراقبة IoT متقدمة للتربة والمناخ والمياه والطاقة في منصة واحدة.',
                tryDemo: 'تجريب النسخة', discoverServices: 'خدماتنا', insurance: 'تأمينك الزراعي مع رايات',
                ourSensors: 'تكنولوجيا رايات', ourReality: 'واقعنا',
                homeTechnologyTitle: 'تكنولوجيا رايات',
                homeLiveSensorsTitle: 'بيانات حقيقية من حساسات رايات المركبة في تارودانت',
                homeLiveSensorsSubtitle: 'بيانات حقيقية من حساسات مركبة داخل دفيئة موز في تارودانت، تتم متابعتها مع حسن عرب بخبرة تتجاوز 20 سنة، لتحليل القراءات وتحسين القرارات الميدانية.',
                homeLiveSensorsSystemTitle: 'نظام متكامل: التربة + المناخ',
                homeLiveSensorsCtaTitle: 'تواصل معي عبر واتساب',
                homeLiveSensorsCtaNote: 'ضغطة واحدة تفتح المحادثة المباشرة',
                homeLiveSensorsCtaAria: 'افتح المحادثة المباشرة على واتساب',
                homeStatusOnline: 'متصل',
                homeStatusOffline: 'غير متصل',
                liveMonitoringTitle: 'مراقبة في الوقت الحقيقي',
                liveMonitoringSubtitle: 'بيانات حساسات رايات الحية تُحدَّث تلقائيًا كل 60 ثانية.',
                sensorNotInstalled: 'المستشعر غير مثبت',
                ourRealityDesc: 'ولدت رايات من شغف بالزراعة. نحن فريق من الخبراء نجلب الابتكار المتاح إلى الحقول.',
                ourMission: 'مهمتنا', ourMissionDesc: 'نؤمن بأن كل مزارع يستحق أدوات مراقبة احترافية.',
                ourDuty: 'واجبنا المهني', ourDutyDesc: 'شريكك الموثوق للإدارة الفعالة للموارد.',
                support247: 'دعم 24/7', training: 'تدريب مستمر', transparency: 'شفافية كاملة',
                customSolutions: 'حلول مخصصة', qualityGuaranteed: 'جودة مضمونة',
                ourCommitment: 'التزامنا', ourCommitmentDesc: 'نقدم لك الأمان والراحة لضمان نجاح محصولك.',
                innovation: 'ابتكار', innovationDesc: 'تقنيات متقدمة لمستقبل الزراعة.',
                sustainability: 'استدامة', sustainabilityDesc: 'إدارة مسؤولة وتوفير المياه.',
                community: 'مجتمع', communityDesc: 'دعم متبادل بين المزارعين المحترفين.',
                sensorWaName: 'رايات الماء', sensorWaDesc: 'مستوى الحوض والاحتياجات',
                hectaresLabel: 'المساحة (هكتار)', cropLabel: 'نوع المحصول',
                need: 'الاحتياج', available: 'المتوفر', ton: 'طن', ha: 'هكتار',
                statusOk: 'احتياطي جيد', statusAlert: 'تنبيه الموارد',
                msgOk: 'ري آمن ومضمون', msgShortage: 'تنبيه: المياه غير كافية!',
                footerRights: '© 2026 Rayat Smart Monitoring. جميع الحقوق محفوظة.',
                banane: 'موز', agrumi: 'حمضيات', pomodori: 'طماطم', mais: 'ذرة', fragole: 'فراولة', olive: 'زيتون', citrus: 'حمضيات', tomatoes: 'طماطم', banana: 'موز', strawberry: 'فراولة',
                export: 'تصدير CSV', search: 'بحث', time: 'الوقت', status: 'الحالة',
                refreshDataAction: 'تحديث البيانات', refreshingDataAction: 'جار تحديث البيانات', monitoringOnline: 'المستشعرات متصلة', monitoringOffline: 'الاتصال غير مستقر',
                appSubtitle: 'رايات للمراقبة الذكية المحترفة',
                welcome: 'مرحبا', protected: 'حقلك محمي 24/7', controlActive: 'مراقبة مستمرة - تأمينك الزراعي نشط دائمًا',
                loginTitle: 'تسجيل الدخول', loginError: 'البريد الإلكتروني أو كلمة المرور غير صحيحة!', emailLabel: 'البريد الإلكتروني', passwordLabel: 'كلمة المرور', loginBtn: 'دخول', demoAccount: 'حساب تجريبي:',
                rememberMe: 'تذكرني', showPassword: 'إظهار كلمة المرور', hidePassword: 'إخفاء كلمة المرور',
                loginNoAccount: 'ليس لديك حساب؟', loginRegisterNow: 'سجل الآن 🌾',
                customSolutionsTitle: 'حلول مخصصة', customSolutionsDesc: 'لا تحتاج لجميع أجهزتنا!', contactUs: 'اتصل بنا للاستشارة', features: 'الميزات:',
                sensorEnName: 'رايات الطاقة', sensorEnDesc: 'مراقبة استهلاك المضخات والأعطال', sensorEnF1: 'إنذار منقذ للحياة', sensorEnF2: 'تحسين الجداول', sensorEnF3: 'كشف الأعطال',
                sensorWaF1: 'مستوى الماء', sensorWaF2: 'إنذار بئر فارغ', sensorWaF3: 'تاريخ المياه الجوفية',
                sensorSoName: 'رايات التربة 7 في 1', sensorSoDesc: 'تحليل شامل: رطوبة، pH، NPK',
                sensorSoF1: 'رطوبة التربة', sensorSoF2: 'درجة حرارة التربة', sensorSoF3: 'التوصيل الكهربائي', sensorSoF4: 'pH', sensorSoF5: 'النيتروجين', sensorSoF6: 'الفوسفور', sensorSoF7: 'البوتاسيوم',
                sensorClName: 'رايات المناخ', sensorClDesc: 'حماية من الصقيع والحرارة', sensorClF1: 'تنبيه صقيع SMS', sensorClF2: 'توقعات التبخر', sensorClF3: 'سرعة الرياح', sensorClF4: 'درع شمسي لقراءات دقيقة', sensorClF5: 'مقاومة للظروف الجوية القاسية', sensorClF6: 'المناخ', sensorClDetails: 'مستشعر احترافي لدرجة الحرارة والرطوبة مع حماية من الأشعة فوق البنفسجية وعزل كامل للماء.',
                tempAmbient: 'درجة الحرارة المحيطة', relHumidity: 'الرطوبة النسبية',
                demoDashboard: 'نسخة تجريبية احترافية', demoDesc: 'استكشف بيانات المستشعر في الوقت الفعلي', history: 'تاريخ (آخر 30 يومًا)', details: 'تفاصيل', weeklyAvg: 'متوسط أسبوعي', maxPeak: 'أقصى ذروة',
                generalStatus: 'الحالة العامة', statusNormal: 'عادي', statusAttention: 'انتباه', statusGood: 'جيد', statusHot: 'حار', statusCritical: 'حرج', statusLow: 'منخفض', statusExcellent: 'ممتاز',
                alerts: 'تنبيهات', notifications: 'إشعارات', noNotifications: 'لا توجد إشعارات جديدة', settings: 'إعدادات', thresholds: 'عتبات الإنذار', save: 'حفظ الإعدادات', enableAlerts: 'تفعيل التنبيهات',
                alertCritical: 'حرج', alertWarning: 'تحذير', maxConsumption: 'أقصى استهلاك (kW)', minLevel: 'أدنى مستوى للماء (m)', minMoisture: 'أدنى رطوبة للتربة (%)', maxTemp: 'أقصى حرارة (°C)', minTemp: 'أدنى حرارة (°C)',
                alertMsgEnergy: 'استهلاك طاقة مرتفع!', alertMsgWater: 'مستوى الماء حرج!', alertMsgSoil: 'التربة جافة جداً!', alertMsgTempHigh: 'درجة الحرارة مرتفعة جداً!', alertMsgTempLow: 'خطر الصقيع!',
                demoBtn: 'النسخة التجريبية', dashboardBtn: 'لوحة التحكم الخاصة', adminArea: 'منطقة لوحة التحكم الرئيسية', masterDash: 'لوحة التحكم الرئيسية المغرب',
                last24h: 'آخر 24 ساعة', last7d: 'آخر 7 أيام', last30d: 'آخر 30 يوم', value: 'القيمة', tableTitle: 'تفاصيل البيانات', co2: 'CO2', pressure: 'الضغط', uvIndex: 'مؤشر الأشعة فوق البنفسجية', rain: 'مطر', windSpeed: 'رياح',
                ready: 'هل أنت مستعد لحماية حقلك؟', startNow: 'ابدأ الآن',
                realTimeMonitoring: 'المراقبة في الوقت الفعلي', last7Days: 'آخر 7 أيام',
                dataUnavailable: 'البيانات غير متوفرة حاليا', privacyPolicy: 'سياسة الخصوصية', termsOfService: 'شروط الخدمة',
                regStep: 'خطوة', regOf: 'من', regPersonalData: 'البيانات الشخصية', regAgriType: 'الملف الزراعي', regFieldLoc: 'موقع الحقل',
                regVerifyTitle: 'أنشئ حسابك في رايات', regFullName: 'الاسم الكامل', regFirstName: 'الاسم', regLastName: 'النسب', regPhone: 'رقم الهاتف', regEmailOpt: 'البريد الإلكتروني',
                regPass: 'كلمة المرور', regPassHint: 'اختر كلمة مرور آمنة', regOtpLabel: 'أدخل رمز التحقق المستلم عبر واتساب',
                regVerifyBtn: 'تحقق واستمر', regSendOtpBtn: 'إرسال الرمز عبر واتساب 📲', regCropTitle: 'ماذا تزرع؟',
                regOtherCrop: 'أخرى (اكتب هنا)', regContinue: 'استمرار ➡️', regLocTitle: 'موقع الحقل',
                regLocHint: 'حدد موقعك تلقائيًا أو أدخل اسم الحقل للعثور عليه على الخريطة.',
                regDetectLoc: '📍 تحديد الموقع تلقائيًا', regFieldName: 'اسم المنطقة / الحقل',
                regFieldNameHint: 'مثال: تارودانت، سوس ماسة', regCompleteBtn: 'إكمال التسجيل 🚜', regBack: 'رجوع',
                regPrivacyNote: 'يتم حفظ التسجيل بشكل خاص ولا يظهر إلا للمشرفين المصرح لهم.',
                regLocationRegion: 'المدينة / الجهة', regLocationRegionHint: 'مثال: تارودانت، سوس ماسة',
                regCropOptional: 'المحصول الرئيسي (اختياري)', regGpsOptional: 'موقع GPS (اختياري)',
                regSaveBtn: 'سجل الآن', regRequiredFields: 'املأ جميع الحقول المطلوبة للمتابعة.',
                contactTitle: 'الاتصال والمقر', contactSub: 'اتصل بنا للحصول على معلومات، دعم فني، تعاون ومواعيد',
                founderSection: 'اتصال مباشر مع المؤسس', founderText: 'للشراكات، المشاريع الزراعية، الدعم الفني وفرص التعاون، يمكنك الاتصال بزكريا عبيد مباشرة.',
                headquarters: 'المقر الرئيسي', addressLabel: 'العنوان', cityLabel: 'المدينة', regionLabel: 'الجهة', countryLabel: 'البلد', openInMap: 'افتح في الخريطة',
                formTitle: 'أرسل لنا رسالة', formName: 'الاسم الكامل', formPhone: 'رقم الهاتف', formEmail: 'البريد الإلكتروني',
                formType: 'نوع الطلب', formMsg: 'رسالتك', formSubmit: 'إرسال الطلب', formSuccess: 'تم إرسال طلبك بنجاح',
                hoursTitle: 'ساعات الدعم', hoursWeek: 'الإثنين - الجمعة', hoursTime: '09:00 - 18:00',
                waSupport: 'دعم واتساب متاح خلال ساعات العمل',
                ctaCallIt: 'اتصل (إيطاليا)', ctaCallMa: 'اتصل (المغرب)', ctaWhatsapp: 'دردشة واتساب', ctaEmail: 'بريد مباشر',
                typeGeneral: 'معلومات عامة', typeSupport: 'دعم فني', typeCollab: 'تعاون', typeDemo: 'طلب عرض تجريبي', typeMeeting: 'موعد', typeOther: 'أخرى',
                mapTitle: 'عملاء رايات المتصلون في المغرب', mapSub: 'شبكة نشطة من العملاء الزراعيين، مع تركيز أساسي على جهة سوس ماسة',
                mapLegendOnline: 'متصل مع رايات', mapLegendOffline: 'غير متصل', mapFocusArea: 'منطقة رايات الرئيسية',
                statOnline: 'متصلون الآن', statMa: 'العملاء في المغرب', statSouss: 'نشطون في سوس ماسة',
                clientName: 'العميل', crop: 'المحصول الأساسي', locality: 'الموقع', region: 'الجهة', statusOnline: 'نشط مع رايات', lastActive: 'آخر نشاط',
                whatsappSectionTitle: 'تواصل معنا مباشرة عبر واتساب',
                whatsappSectionText: 'اكتب لنا للمعلومات أو الدعم أو لطلب عرض Rayat التجريبي. نحن متاحون عبر الرسائل أو الملاحظات الصوتية أو الاتصال المباشر. نرد بسرعة.',
                whatsappSectionButton: 'راسلنا على واتساب',
                whatsappButtonLabel: 'افتح واتساب رايات',
                optimalRangeFor: 'النطاق المثالي لـ',
                optimalFor: 'المثالي لـ',
                alertBadgeAttention: 'انتباه',
                alertBadgeAlert: 'إنذار',
                activeAlertsTitle: 'الإنذارات النشطة',
                activeAlertsSubtitle: 'أحدث الأحداث المرتبطة بالمحصول المختار',
                batteryVoltageLabel: 'جهد البطارية',
                batteryTitle: 'البطارية',
                optimalRangePlain: 'النطاق المثالي',
                tempShort: 'حرارة',
                humidityShort: 'رطوبة',
                optimalShort: 'مثالي',
                subscriptionExpiringEyebrow: 'تنبيه الاشتراك',
                subscriptionExpiringTitle: 'ستنتهي خطتك قريبًا',
                subscriptionExpiringText: 'لا يزال الوصول فعالًا، لكن الاشتراك ينتهي {when}.',
                subscriptionExpiringSoonText: 'قريبًا',
                subscriptionExpiringInDays: 'خلال {days} يوم',
                subscriptionExpiringOnDate: 'في {date}',
                subscriptionSupportCta: 'الدعم',
                subscriptionExpiredTitle: 'انتهى الاشتراك',
                subscriptionExpiredText: 'انتهت خطة المراقبة الخاصة بك. لمواصلة الوصول إلى بيانات المستشعرات والتنبيهات الزراعية الفورية، جدد اشتراكك.',
                subscriptionRenewWhatsapp: 'جدد عبر واتساب',
                continueWithoutLogin: 'المتابعة بدون تسجيل',
                navMenu: 'القائمة', mobileMenuClose: 'إغلاق القائمة',
                forgotPassword: 'هل نسيت كلمة المرور؟', forgotPasswordSubmit: 'إرسال رابط إعادة التعيين', forgotPasswordSuccess: 'إذا كان الحساب موجودا فستصلك رسالة تحتوي على رابط إعادة التعيين.',
                forgotPasswordEmailRequired: 'أدخل بريدك الإلكتروني للحصول على رابط إعادة التعيين.',
                resetPasswordTitle: 'إعادة تعيين كلمة المرور', resetPasswordDesc: 'اختر كلمة مرور جديدة وآمنة لحسابك في رايات.',
                newPasswordLabel: 'كلمة المرور الجديدة', confirmPasswordLabel: 'تأكيد كلمة المرور', resetPasswordSubmit: 'تحديث كلمة المرور',
                resetPasswordSuccess: 'تم تحديث كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول.', resetPasswordInvalidToken: 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية.',
                resetPasswordMismatch: 'كلمتا المرور غير متطابقتين.', backToLogin: 'العودة إلى تسجيل الدخول',
                cropSelectorTitle: 'المحصول المختار', cropSelectorHint: 'تستخدم رايات هذا المحصول لتخصيص التوصيات والتقديرات المحلية.',
                cropCustomLabel: 'حدد المحصول', cropCustomPlaceholder: 'مثال: شمام، باذنجان، بابايا',
                cropOptionBanane: 'موز', cropOptionTomate: 'طماطم', cropOptionPoivron: 'فلفل', cropOptionConcombre: 'خيار', cropOptionMelon: 'شمام', cropOptionCourgette: 'كوسة',
                cropOptionLaitue: 'خس', cropOptionFraise: 'فراولة', cropOptionAgrumes: 'حمضيات', cropOptionOlive: 'زيتون', cropOptionArgan: 'أركان',
                cropOptionBle: 'قمح', cropOptionOrge: 'شعير', cropOptionMais: 'ذرة', cropOptionLuzerne: 'برسيم', cropOptionAutre: 'أخرى'
            },
            zgh: {
                home: 'ⵜⴰⴳⵎⵎⵉ',
                services: 'ⵉⵎⴰⵣⵣⴰⵍⵏ',
                aboutUs: 'ⴰⵡⴰⵍ ⴼⵍⵍⴰⵏⵖ',
                demo: 'ⴷⵉⵎⵓ',
                myFieldNav: 'Mon exploitation',
                login: 'ⴰⴽⵛⵓⵎ',
                logout: 'ⴼⴼⵓⵖ',
                hero: 'ⴰⴽⴰⵍ ⵉⵖⵓⴷⴰⵏ = ⴰⵎⴳⵔ ⵉⵖⵓⴷⴰⵏ',
                heroSub: 'ⵀⴰⵏⴰ ⴽⵓⵍⵍⵓ',
                heroEyebrow: 'Rayat Smart Monitoring',
                heroTitleLine1: 'ⵜⴰⴼⵍⵍⴰⵃⵜ ⵙ ⵉⵙⴼⴽⴰ',
                heroTitleLine2: 'ⵉⵖⵣⵣⵉⵏ ⵉⴼⵓⵍⴽⵉⵏⵜ.',
                heroTitleAccent: 'ⴰⵎⴳⵔ ⵉⴼⵓⵍⴽⵉⵏ.',
                heroPlatformSub: 'ⵜⴰⴳⴳⴰ IoT i wakal, anzwi, aman d tazmert deg yiwen umkan.',
                insurance: 'ⵍⴰⵙⵉⵔⵓⵏⵙ ⵏ ⵜⴼⵍⵍⴰⵃⵜ',
                tryDemo: 'ⴰⵔⴰⵎ ⴷⵉⵎⵓ',
                discoverServices: 'ⵥⵕ ⵉⵎⴰⵣⵣⴰⵍⵏ',
                ourSensors: 'ⵉⵎⴰⵙⵙⵏ ⵏⵏⵖ <span class="text-xs text-gray-500 block">Imassn</span>',
                homeTechnologyTitle: 'ⵜⴰⴽⵏⵓⵍⵓⵊⵉⵜ Rayat',
                homeLiveSensorsTitle: 'ⵉⵙⴼⴽⴰ ⵏ Rayat ⵉⵜⵜⵓⵙⴱⴷⴷⵏ ⴳ Taroudant',
                homeLiveSensorsSubtitle: 'ⵉⵙⴼⴽⴰ ⵉⵍⵉⵏ ⵙⴳ ⵉⵎⴰⵙⵙⵏ ⵉⵜⵜⵓⵙⴱⴷⴷⵏ ⴳ ⵜⴰⵙⵔⴳⴰ ⵏ ⵜⵉⴳⴰⵢⵢⴰ ⴳ Taroudant, ⴰⴽⴷ Hassan Arab d ugar n 20 n yiseggasen n tmusni iwakken ad nsefrak isfka d tignatin n wakal.',
                homeLiveSensorsSystemTitle: 'ⴰⵏⴰⴳⵔⴰⵡ ⵉⴽⵎⵍⵏ: ⴰⴽⴰⵍ + ⴰⵏⵣⵡⵉ',
                homeLiveSensorsCtaTitle: 'ⴰⵎⵢⴰⵡⴰⴹ ⴷⵉ ⵙ WhatsApp',
                homeLiveSensorsCtaNote: 'ⵢⴰⵏ ⵓⵙⵉⵜ ⵉⵔⵣⵎ ⴰⵎⵙⴰⵡⴰⴹ ⵓⵙⵔⵉⴷ',
                homeLiveSensorsCtaAria: 'ⵕⵥⵎ ⴰⵎⵙⴰⵡⴰⴹ ⵓⵙⵔⵉⴷ ⵙ WhatsApp',
                homeStatusOnline: 'Online',
                homeStatusOffline: 'Offline',
                liveMonitoringTitle: 'ⴰⵍⵖⵓ ⵏ ⵜⵎⴰⵢⵏⵓⵜ',
                liveMonitoringSubtitle: 'ⵉⵙⴼⴽⴰ ⵏ Rayat ⵙ ⵜⵓⵙⵙⵏⴰ ⵏ 60 ⵏ ⵜⵉⵙⵉⵏ.',
                sensorNotInstalled: 'ⴰⵎⴰⵙⵙⴰⵏ ⵓⵔ ⵉⵜⵜⵓⵙⴱⴷⴷ',
                whyChoose: 'ⵎⴰⵅ ⵔⴰⵢⴰⵜ? <span class="text-xs text-gray-400 block">Maix Rayat?</span>',
                continuous: 'ⵜⴰⴳⴳⴰ ⵜⴰⵎⴰⴳⵓⵔⵜ',
                continuousDesc: 'ⵀⴰⵏⴰ ⴽⵓⵍⵍⵓ ⵜⴰⵙⵔⴰⴳⵉⵏ ⵏ ⵡⴰⵙⵙ. ⵜⴰⴳⴳⴰ ⵏ ⵓⴽⴰⵍ ⵏⵏⵓⵏ.',
                remote: 'ⵜⴰⴳⴳⴰ ⵙ ⵜⵡⴰⴳⴳⵓⵔⵜ',
                remoteDesc: 'ⵜⵥⴹⴰⵕⴷ ⴰⴷ ⵜⵥⵔⴷ ⴰⴽⴰⵍ ⵏⵏⵓⵏ ⵙⴳ ⴽⵓ ⴰⴷⵖⴰⵔ ⵙ ⵜⵉⵍⵉⴼⵓⵏ.',
                better: 'ⴰⵎⴳⵔ ⵉⵖⵓⴷⴰⵏ',
                betterDesc: 'ⴰⴽⴰⵍ ⵉⵖⵓⴷⴰⵏ ⵉⴳⴰ ⴰⵎⴳⵔ ⵉⵖⵓⴷⴰⵏ. ⵙⵙⴷⵔⵓⵙ ⴰⵎⴰⵏ ⴷ ⵜⵉⵥⴹⵉ.',
                ready: 'ⵜوجدⴷⴰ ⴰⴷ ⵜⵃⵎⵓⴷ ⴰⴽⴰⵍ ⵏⵏⵓⵏ?',
                startNow: 'ⴱⴷⵓ ⴷⵖⵉ',
                welcome: 'ⴰⵏⵙⵓⴼ',
                protected: 'ⴰⴽⴰⵍ ⵏⵏⵓⵏ ⵉⵃⵎⴰ 24/24',
                controlActive: 'ⵜⴰⴳⴳⴰ ⵜⴰⵎⴰⴳⵓⵔⵜ - ⵍⴰⵙⵉⵔⵓⵏⵙ ⵏ ⵜⴼⵍⵍⴰⵃⵜ ⵏⵏⵓⵏ',
                loginTitle: 'ⴰⴽⵛⵓⵎ',
                loginError: 'ⵉⵎⵉⵍ ⵏⵖ ⵜⴰⴳⵓⵔⵉ ⵏ ⵓⴽⵛⵓⵎ ⵓⵔ ⴳⵉⵏ ⵍⵃⴰⵇⵍ!',
                emailLabel: 'ⵉⵎⵉⵍ',
                passwordLabel: 'ⵜⴰⴳⵓⵔⵉ ⵏ ⵓⴽⵛⵓⵎ',
                loginBtn: 'ⴰⴽⵛⵓⵎ',
                rememberMe: 'ⴰⵔ ⴱⵇⵇⵉⵖ ⵉⵏⵏⵉ',
                showPassword: 'ⵙⵙⴽⵏ ⵜⴰⴳⵓⵔⵉ',
                hidePassword: 'ⴼⴼⵔ ⵜⴰⴳⵓⵔⵉ',
                loginNoAccount: 'ⵓⵔ ⵖⵓⵔⴽ ⴰⴽⴰⵡⵏⵜ?',
                loginRegisterNow: 'ⵙⴽⵔ ⴰⴽⴰⵡⵏⵜ ⵜⵓⵔⴰ 🌾',
                profileMenuInfo: 'Profil',
                profileMenuEdit: 'Paramètres',
                profileMenuLogout: 'ⴼⴼⵓⵖ',
                demoAccount: 'ⴰⴽⴰⵡⵏⵜ ⴷⵉⵎⵓ:',
                ourReality: 'ⵜⵉⵍⴰⵡⵜ ⵏⵏⵖ',
                ourRealityDesc: 'ⵔⴰⵢⴰⵜ ⵜⵍⵓⵍⴷ ⵙⴳ ⵜⵉⵔⵉⵜ ⵏ ⵜⴼⵍⵍⴰⵃⵜ. ⵏⴽⵏⵉ ⴷ ⵉⵎⴰⵣⵣⴰⵍⵏ ⵏ ⵜⵉⴽⵏⵓⵍⵓⵊⵉⵜ.',
                ourMission: 'ⵜⴰⵙⵎⵉⴳⵍⵉⵜ ⵏⵏⵖ',
                ourMissionDesc: 'ⵜⴰⵙⵎⵉⴳⵍⵉⵜ ⵏⵏⵖ ⵜⴳⴰ ⵜⴰⴼⵔⴰⵔⵜ. ⴽⵓ ⴰⴼⵍⵍⴰⵃ ⵉⵙⵜⴰⵀⵍ ⵉⵎⴰⵙⵙⵏ ⵉⵎⴰⵣⵣⴰⵍⵏ.',
                appSubtitle: 'ⵜⴰⴳⴳⴰ ⵜⴰⵎⴰⴳⵓⵔⵜ <span class="text-xs text-green-200 block">Muraqaba Dakiya</span>',
                ourDuty: 'Notre Devoir envers les Clients',
                ourDutyDesc: 'Nous sommes votre partenaire de confiance. Nous garantissons :',
                support247: 'Support 24/7 : Toujours disponible',
                training: 'Formation Complète : On vous apprend tout',
                transparency: 'Transparence Totale : Pas de coûts cachés',
                customSolutions: 'Solutions Sur Mesure',
                qualityGuaranteed: 'Qualité Garantie',
                ourCommitment: 'Notre Engagement',
                ourCommitmentDesc: 'Nous offrons tranquillité d\'esprit et sécurité.',
                innovation: 'Innovation',
                innovationDesc: 'Technologies avancées pour le meilleur',
                sustainability: 'Durabilité',
                sustainabilityDesc: 'Agriculture responsable',
                community: 'Communauté',
                communityDesc: 'Forum de soutien aux agriculteurs',
                customSolutionsTitle: 'Solutions Personnalisées',
                customSolutionsDesc: 'Vous n\'avez pas besoin de tous nos capteurs !',
                contactUs: 'Contactez-nous pour Conseil',
                features: 'ⵜⵉⵎⵙⴰⵍ:',
                sensorEnName: 'RAYAT ENERGY',
                sensorEnDesc: 'Surveillance conso pompes et pannes',
                sensorEnF1: 'Alarme vitale',
                sensorEnF2: 'Optimisation horaires',
                sensorEnF3: 'Détection pannes',
                sensorWaName: 'RAYAT WATER',
                sensorWaDesc: 'Surveillance du Bassin et Besoin en Eau',
                sensorWaF1: 'Niveau d\'eau',
                sensorWaF2: 'Alarme puits vide',
                sensorWaF3: 'Historique nappe',
                sensorSoName: 'RAYAT SOIL 7 IN 1',
                sensorSoDesc: 'Analyse complète : Humidité, pH, NPK',
                sensorSoF1: 'ⵜⴰⵎⵉⴷⵉ',
                sensorSoF2: 'ⵜⴰⵙⴽⵯⴼⵍⵜ',
                sensorSoF3: 'Conductivité électrique',
                sensorSoF4: 'pH',
                sensorSoF5: 'Azote',
                sensorSoF6: 'Phosphore',
                sensorSoF7: 'Potassium',
                sensorClName: 'RAYAT CLIMATE',
                sensorClDesc: 'ⵜⴰⴳⴳⴰ ⵏ ⴰⵏⵣⵡⵉ - Rayat Smart Monitoring',
                sensorClF1: 'Alerte gel SMS',
                sensorClF2: 'Prévision évaporation',
                sensorClF3: 'Vitesse vent',
                sensorClF4: 'Écran solaire pour des lectures précises',
                sensorClF5: 'Résistance aux conditions météorologiques extrêmes',
                sensorClF6: 'Climat',
                sensorClDetails: 'Capteur professionnel de température et d\'humidité avec protection solaire anti-UV et étanchéité totale.',
                tempAmbient: 'Température Ambiante',
                relHumidity: 'Humidité Relative',
                demoDashboard: 'ⴷⵉⵎⵓ ⵜⴰⵎⴰⴳⵓⵔⵜ',
                demoDesc: 'Explorez les données en temps réel',
                history: 'ⴰⵎⵣⵔⵓⵢ',
                details: 'ⵜⵉⴼⵔⴰⵙ',
                weeklyAvg: 'Moyenne Hebdo',
                maxPeak: 'Pic Max',
                generalStatus: 'État Général',
                statusNormal: 'ⵉⵖⵓⴷⴰ <span class="text-xs text-gray-400">Mzyan</span>',
                statusAttention: 'ⵔⴷ ⵍⴱⴰⵍ <span class="text-xs text-gray-400">Rdd lbal</span>',
                statusGood: 'ⵉⴼⵓⵍⴽⵉ <span class="text-xs text-gray-400">Mxyyer</span>',
                statusHot: 'ⴰⵙⵎⵎⵓⴷ <span class="text-xs text-gray-400">Sxuun</span>',
                statusCritical: 'ⴰⵙⵓⵖⵍ <span class="text-xs text-gray-400">Xatar</span>',
                statusLow: 'ⵉⴷⵔⵓⵙ <span class="text-xs text-gray-400">Qllil</span>',
                statusExcellent: 'ⵉⴼⵓⵍⴽⵉ ⴱⴰⵀⵔⴰ',
                alerts: 'Alertes',
                notifications: 'ⴰⵍⵖⵓ',
                noNotifications: 'Aucune nouvelle notification',
                settings: 'ⵜⵉⵙⵖⴰⵍ',
                thresholds: 'Seuils d\'alarme',
                save: 'ⵙⵊⵊⵍ',
                enableAlerts: 'Activer les alertes',
                alertCritical: 'ⴰⵙⵓⵖⵍ',
                alertWarning: 'ⵔⴷ ⵍⴱⴰⵍ',
                maxConsumption: 'Conso Max (kW)',
                minLevel: 'Niveau Min Eau (m)',
                minMoisture: 'Humidité Min Sol (%)',
                maxTemp: 'Temp Max (°C)',
                minTemp: 'Temp Min (°C)',
                alertMsgEnergy: ' الضو طالع بزاف',
                alertMsgWater: 'ⴰⵎⴰⵏ ⵇⴰⴹⴰⵏ! <span class="block text-xs">L-ma qlil bezzaf!</span>',
                alertMsgSoil: 'ⴰⴽⴰⵍ ⵉⵇⵇⵓⵔ! <span class="block text-xs">L-arḍ nachfa!</span>',
                alertMsgTempHigh: 'ⴰⵙⵎⵎⵓⴷ ⴱⵣⵣⴰⴼ! <span class="block text-xs">L-ḥrara tal3a!</span>',
                alertMsgTempLow: 'ⴰⵙⵎⵎⵉⴹ! <span class="block text-xs">Kayn l-berd!</span>',
                demoBtn: 'ⴷⵉⵎⵓ',
                dashboardBtn: 'ⵜⵉⵙⵖⴰⵍ',
                adminArea: 'Zone Master Dashboard',
                masterDash: 'Master Dashboard Maroc',
                hectaresLabel: 'ⴰⴽⴰⵍ (Ha)',
                cropLabel: 'ⴰⵏⵡⴰⵄ ⵏ ⵜⵎⴳⵔⵜ',
                need: 'ⴰⵎⴰⵢⵏⵓ',
                available: 'ⵉⵜⵜⵓⴼⵔⴰⵏ',
                statusOk: 'ⴰⵏⴰⵡ ⵉⵖⵓⴷⴰ',
                statusAlert: 'ⴰⵍⵖⵓ ⵏ ⵜⵎⴰⵢⵏⵓⵜ',
                ton: 'Ton',
                ha: 'Ha',
                banane: 'ⵜⵉⴳⴰⵢⵢⴰ',
                agrumi: 'ⵉⵎⴰⵏ',
                pomodori: 'ⵜⵉⵎⴰⵜⵉⵛ',
                mais: 'ⴰⴷⵔⴰⵔ',
                fragole: 'ⵜⵉⴼⵔⴰⵙ',
                olive: 'ⴰⵣⵎⵎⵓⵔ',
                exportCSV: 'ⵙⵙⵓⴼⵖ ⴰⵍⵖⵓ (CSV)',
                msgShortage: 'ⴰⵍⵖⵓ: ⴰⵎⴰⵏ ⵓⵔ ⵉⴳⵉⵏ ⵉⵎⴰⵏ ⵉ ⵜⵎⴳⵔⵜ ⵉⵜⵜⵓⴼⵔⴰⵏ!',
                msgOk: 'ⴰⵙⵙⴰⵢ ⵉⵖⵓⴷⴰ - ⵜⵉⵎⴰⵢⵏⵓⵜ ⵉⵖⵓⴷⴰⵏ',
                footerRights: '© 2026 Rayat Smart Monitoring. Tous droits réservés.',
                last24h: '24 ⵜ ⵉⵣⵔⵉⵏ',
                last7d: '7 ⵓⵙⵙⴰⵏ',
                last30d: '30 ⵓⵙⵙⴰⵏ',
                search: 'ⵔⵣⵓ',
                export: 'ⵙⵙⵓⴼⵖ',
                time: 'ⴰⴽⵓⴷ',
                value: 'ⴰⵜⵉⴳ',
                status: 'ⴰⴷⴷⴰⴷ',
                tableTitle: 'ⵍⵊⴷⵡⴰⵍ ⵏ ⵉⵙⴼⴽⴰ',
                co2: 'CO2',
                pressure: 'ⴰⵣⵡⵓ <span class="text-xs text-gray-500">Pression</span>',
                uvIndex: 'UV',
                rain: 'ⴰⵏⵥⴰⵕ <span class="text-xs text-gray-500">Chta</span>',
                windSpeed: 'ⴰⴹⵓ <span class="text-xs text-gray-500">Rih</span>',
                realTimeMonitoring: 'ⴰⵍⵖⵓ ⵏ ⵜⵎⴰⵢⵏⵓⵜ',
                last7Days: '7 ⵓⵙⵙⴰⵏ',
                dataUnavailable: 'ⵉⵙⴼⴽⴰ ⵓⵔ ⵍⵍⵉⵏ',
                privacyPolicy: 'ⵜⴰⵙⵔⵜⵉⵜ ⵏ ⵜⵉⵏⵏⵓⵜⴼⴰ',
                termsOfService: 'ⵜⵉⴼⴰⴷⵉⵡⵉⵏ ⵏ ⵓⵙⵎⵔⵙ',
                regStep: 'ⵜⴰⵙⴽⵯⴼⵍⵜ', regOf: 'ⵙⴳ', regPersonalData: 'ⵉⵙⴼⴽⴰ ⵉⵢⵉⵎⴰⵏ', regAgriType: 'ⴰⵙⵉⴳⴳⵯⵍ ⴰⴳⵔⵉⴽⵓⵍ', regFieldLoc: 'ⴰⴷⵖⴰⵔ ⵏ ⵓⴽⴰⵍ',
                regVerifyTitle: 'ⵙⴽⵔ ⴰⴽⴰⵡⵏⵜ ⵏ ⵔⴰⵢⴰⵜ', regFullName: 'ⵉⵙⵎ ⴰⵎⴳⴳⴰⵔⵓ', regFirstName: 'ⵉⵙⵎ', regLastName: 'ⵏⵙⴰⴱ', regPhone: 'ⵜⵉⵍⵉⴼⵓⵏ', regEmailOpt: 'ⵉⵎⵉⵍ',
                regPass: 'ⵜⴰⴳⵓⵔⵉ ⵏ ⵓⴽⵛⵓⵎ', regPassHint: 'ⴼⵔⵏ ⵜⴰⴳⵓⵔⵉ ⵏ ⵓⴽⵛⵓⵎ ⵉⵖⵓⴷⴰⵏ', regOtpLabel: 'ⴰⴽⵛⵓⵎ ⵏ ⵓⴽⵓⴷ OTP ⵙⴳ WhatsApp',
                regVerifyBtn: 'ⴰⵙⵏⵜⴰⵎ ⴷ ⵓⴼⵔⵔⵓ', regSendOtpBtn: 'ⴰⵣⵏ ⴰⴽⵓⴷ ⵙ WhatsApp 📲', regCropTitle: 'ⵎⴰ ⵜⴳⵔⴷ?',
                regOtherCrop: 'ⵢⴰⴹⵏ (ⴰⵔⴰ ⴷⴰ)', regContinue: 'ⴰⴼⵔⵔⵓ ➡️', regLocTitle: 'ⴰⴷⵖⴰⵔ ⵏ ⵓⴽⴰⵍ',
                regLocHint: 'ⵥⵔ ⴰⴷⵖⴰⵔ ⵏⵏⵓⵏ ⵏⵖ ⴰⵔⴰ ⵉⵙⵎ ⵏ ⵓⴽⴰⵍ.',
                regDetectLoc: '📍 ⵥⵔ ⴰⴷⵖⴰⵔ ⵙ ⵜⵡⴰⴳⴳⵓⵔⵜ', regFieldName: 'ⵉⵙⵎ ⵏ ⵓⴽⴰⵍ / ⴰⴷⵖⴰⵔ',
                regFieldNameHint: 'ⵎⴷⵢⴰ: ⵜⴰⵔⵓⴷⴰⵏⵜ, ⵙⵓⵙ-ⵎⴰⵙⴰ', regCompleteBtn: 'ⴼⵔⵔⵓ ⴰⵣⵎⵎⴻⵎ 🚜', regBack: 'ⵓⵖⵓⵍ',
                regPrivacyNote: 'ⴰⵣⵎⵎⴻⵎ ⵉⵜⵜⵓⵃⴹⴰ ⵙ ⵓⵙⵉⵔⴷ ⴷ ⵓⵔ ⵉⵜⵜⵡⴰⵍⴰ ⴰⵔ ⵙ ⵉⵎⵙⵓⴼⵖⵏ ⵉⵥⵍⵉⵏ.',
                regLocationRegion: 'ⵜⴰⵎⵏⴰⴹⵜ / ⵜⴰⵎⵏⴰⴹⵜ', regLocationRegionHint: 'ⵎⴷⵢⴰ: ⵜⴰⵔⵓⴷⴰⵏⵜ, ⵙⵓⵙ-ⵎⴰⵙⴰ',
                regCropOptional: 'ⵜⴰⴳⵔⴰⵡⵜ ⵜⴰⵎⵇⵇⵔⴰⵏⵜ (ⴰⵎⴹⴰⵏ)', regGpsOptional: 'GPS (ⴰⵎⴹⴰⵏ)',
                regSaveBtn: 'ⵙⴽⵔ ⴰⵣⵎⵎⴻⵎ ⵜⵉⴽⴽⵉ', regRequiredFields: 'ⴽⵎⵎⵍ ⵉⴳⵔⴰⵏ ⵉⵅⵚⵚⴰⵏ ⴰⴷ ⵜⵙⵎⵓⵜⵜⵉⴷ.',
                contactTitle: 'ⴰⵎⵢⴰⵡⴰⴹ ⴷ ⵓⴷⵖⴰⵔ', contactSub: 'ⴰⵎⵢⴰⵡⴰⴹ ⴼ ⵉⵙⴼⴽⴰ, ⴰⴼⵔⵔⵓ ⵜⵉⴽⵏⵉⴽ, ⴷ ⵜⵉⵎⵢⴰⵡⴰⵙⵉⵏ',
                founderSection: 'ⴰⵎⵢⴰⵡⴰⴹ ⴷ ⵓⵎⵙⵏⵜⴰ', founderText: 'ⴼ ⵜⵉⵎⵢⴰⵡⴰⵙⵉⵏ ⴷ ⵉⵙⵏⴼⴰⵔⵏ ⵏ ⵜⴼⵍⵍⴰⵃⵜ, ⴰⵎⵢⴰⵡⴰⴹ ⴷ Zakaria Abid.',
                headquarters: 'ⴰⴷⵖⴰⵔ ⵏ ⵜⵎⵙⵙⵓⴳⵓⵔⵜ', addressLabel: 'ⴰⴷⵖⴰⵔ', cityLabel: 'ⵜⴰⵎⴷⵉⵏⵜ', regionLabel: 'ⵜⴰⵎⵏⴰⴹⵜ', countryLabel: 'ⵜⴰⵎⴰⵣⵉⵔⵜ', openInMap: 'ⵥⵔ ⴳ ⵜⴼⵍⵡⵉⵜ',
                formTitle: 'ⴰⵣⵏ ⵜⴰⴱⵔⴰⵜ', formName: 'ⵉⵙⵎ ⴰⵎⴳⴳⴰⵔⵓ', formPhone: 'ⵓⵟⵟⵓⵏ ⵏ ⵜⵉⵍⵉⴼⵓⵏ', formEmail: 'ⵉⵎⵉⵍ',
                formType: 'ⴰⵏⴰⵡ ⵏ ⵜⵓⵜⵜⵔⴰ', formMsg: 'ⵜⴰⴱⵔⴰⵜ ⵏⵏⵓⵏ', formSubmit: 'ⴰⵣⵏ ⵜⵓⵜⵜⵔⴰ', formSuccess: 'ⵜⵓⵜⵜⵔⴰ ⵏⵏⵓⵏ ⵜⵣⵔⵉ ⵙ ⵓⴼⵔⵔⵓ',
                hoursTitle: 'ⵜⵉⵙⵔⴰⴳⵉⵏ ⵏ ⵓⵎⴰⵣⵣⴰⵍ', hoursWeek: 'ⵉⵏⴰⵢⵔ - ⵙⵉⵎⵡⴰⵙ', hoursTime: '09:00 - 18:00',
                waSupport: 'WhatsApp ⵉⵍⵍⴰ ⴳ ⵜⵉⵙⵔⴰⴳⵉⵏ ⵏ ⵜⵡⵓⵔⵉ',
                ctaCallIt: 'ⵜⵉⵍⵉⴼⵓⵏ (IT)', ctaCallMa: 'ⵜⵉⵍⵉⴼⵓⵏ (MA)', ctaWhatsapp: 'WhatsApp', ctaEmail: 'Email',
                typeGeneral: 'ⵉⵙⴼⴽⴰ ⵉⵎⴰⵜⴰⵢⵏ', typeSupport: 'ⴰⴼⵔⵔⵓ ⵜⵉⴽⵏⵉⴽ', typeCollab: 'ⵜⴰⵎⵢⴰⵡⴰⵙⵜ', typeDemo: 'ⵜⵓⵜⵜⵔⴰ ⴷⵉⵎⵓ', typeMeeting: 'ⴰⵏⵎⵓⴳⴳⴰⵔ', typeOther: 'ⵢⴰⴹⵏ',
                mapTitle: 'ⵉⵎⵙⴰⵡⴰⴹⵏ ⵏ Rayat ⴳ ⵍⵎⵖⵔⵉⴱ', mapSub: 'ⵜⴰⵥⴹⴰ ⵏ ⵉⴼⵍⵍⴰⵃⵏ, ⵙ ⵓⵙⴼⵙⵔ ⴼ ⵙⵓⵙ ⵎⴰⵙⵙⵜ',
                mapLegendOnline: 'ⵉⵍⵍⴰ ⴰⴽⴷ Rayat', mapLegendOffline: 'ⵓⵔ ⵉⵍⵍⵉ', mapFocusArea: 'ⴰⴷⵖⴰⵔ ⵏ Rayat',
                statOnline: 'ⵉⵍⵍⴰⵏ ⴷⵖⵉ', statMa: 'ⵉⵎⵙⴰⵡⴰⴹⵏ ⴳ ⵍⵎⵖⵔⵉⴱ', statSouss: 'ⵉⵍⵍⴰⵏ ⴳ ⵙⵓⵙ',
                clientName: 'ⴰⵎⵙⴰⵡⴰⴹ', crop: 'ⵜⴰⵢⵢⵓⵣⵜ', locality: 'ⴰⴷⵖⴰⵔ', region: 'ⵜⴰⵎⵏⴰⴹⵜ', statusOnline: 'ⵉⵍⵍⴰ ⴰⴽⴷ Rayat', lastActive: 'ⴰⵏⴳⴳⴰⵔⵓ',
                whatsappSectionTitle: 'ⴰⵎⵢⴰⵡⴰⴹ ⴷⴰⵔⵏⵖ ⵙ WhatsApp',
                whatsappSectionText: 'ⴰⵔⵉ ⴰⴷ ⴰⵖⵜⴰⵔⴷ ⵉ ⵉⵙⴼⴽⴰ, ⴰⴼⵔⵔⵓ ⵏⵖ ⵜⵓⵜⵜⵔⴰ ⵏ demo ⵏ Rayat. ⵏⵍⵍⴰ ⵙ ⵉⵣⵏⴰⵏ, ⵉⵡⴰⵍⵏ ⵉⵎⵙⵍⵉⵜⵏ ⴷ ⵜⵉⵍⵉⴼⵓⵏ.',
                whatsappSectionButton: 'ⴰⵔⵉ ⵙ WhatsApp',
                whatsappButtonLabel: 'ⵍⴷ WhatsApp ⵏ Rayat',
                optimalRangeFor: 'ⴰⵣⵍⴰⵢ ⵉⵖⵓⴷⴰⵏ ⵉ',
                optimalFor: 'ⵉⵖⵓⴷⴰⵏ ⵉ',
                alertBadgeAttention: 'ⵔⴷ ⵍⴱⴰⵍ',
                alertBadgeAlert: 'ⴰⵍⵖⵓ',
                activeAlertsTitle: 'ⴰⵍⵖⵓⵏ ⵉⵔⴳⴳⴰⵏ',
                activeAlertsSubtitle: 'ⵉⵎⵣⵣⵓⵔⵉⵏ ⵉⵇⵔⵉⴱⵏ ⵉ ⵜⵎⴳⵔⵜ ⵉⵜⵜⵓⴼⵔⴰⵏ',
                batteryVoltageLabel: 'ⵜⵉⵥⴹⵉ ⵏ ⵜⴱⴰⵟⵟⵔⵉ',
                batteryTitle: 'ⵜⴱⴰⵟⵟⵔⵉ',
                optimalRangePlain: 'ⴰⵣⵍⴰⵢ ⵉⵖⵓⴷⴰⵏ',
                tempShort: 'Temp',
                humidityShort: 'Hum',
                optimalShort: 'Opt',
                subscriptionExpiringEyebrow: 'ⴰⵍⵖⵓ ⵏ ⵓⴱⵓⵏⵎⴰⵏ',
                subscriptionExpiringTitle: 'ⴰⴱⵍⴰⵏ ⵏⵏⴽ ⴰⴷ ⵉⴼⴼⵓⴽ',
                subscriptionExpiringText: 'ⴰⴽⵛⵓⵎ ⵎⴰⵣⴰⵍ, ⵎⴰⵛⴰ ⴰⴱⵓⵏⵎⴰⵏ ⵉⵜⵜⴼⴽⴰ {when}.',
                subscriptionExpiringSoonText: 'ⴷⵖⵉ',
                subscriptionExpiringInDays: 'ⴳ {days} ⵓⵙⵙⴰⵏ',
                subscriptionExpiringOnDate: 'ⴳ {date}',
                subscriptionSupportCta: 'Support',
                subscriptionExpiredTitle: 'ⴰⴱⵓⵏⵎⴰⵏ ⵉⴼⴼⵓⴽ',
                subscriptionExpiredText: 'ⴰⴱⵍⴰⵏ ⵏ ⵜⴰⴳⴳⴰ ⵉⴼⴼⵓⴽ. ⵉⵡⴽⴽⵉⵍ ad tkemmed igh data n sensors d alerts agronomiques, jedded l\'abonnement inek.',
                subscriptionRenewWhatsapp: 'ⵊⴷⴷⴻⴷ ⵙ WhatsApp',
                continueWithoutLogin: 'ⴽⵎⵎⵍ ⴱⵍⴰ login',
                navMenu: 'ⵎⵉⵏⵓ', mobileMenuClose: 'ⵎⴷⵍ ⵎⵉⵏⵓ',
                forgotPassword: 'Mot de passe oublie ?', forgotPasswordSubmit: 'Azen lien n reinitialisation', forgotPasswordSuccess: 'Ma yella lcompte illa, ad tawed email s lien n reinitialisation.',
                forgotPasswordEmailRequired: 'Ari email inek iwakken ad tawsed lien n reinitialisation.',
                resetPasswordTitle: 'Reinitialiser mot de passe', resetPasswordDesc: 'Fren awal uffir amaynut i ucount Rayat.',
                newPasswordLabel: 'Awal uffir amaynut', confirmPasswordLabel: 'Ssedq awal uffir', resetPasswordSubmit: 'Sbeddel awal uffir',
                resetPasswordSuccess: 'Mot de passe ibeddel. Tzemred ad tkecmed tura.', resetPasswordInvalidToken: 'Lien n reinitialisation ma yelli ara negh ifukk.',
                resetPasswordMismatch: 'Awalen uffiren ur mgaraden ara.', backToLogin: 'Ughul ar login',
                cropSelectorTitle: 'ⵜⴰⵢⵢⵓⵣⵜ ⵉⵜⵜⵓⴼⵔⴰⵏ', cropSelectorHint: 'Rayat ittwaseqdec ttayyuzt ad yerr isemras d itqdirin.',
                cropCustomLabel: 'ⴰⵔⵉ ⵉⵙⵎ ⵏ ⵜⵎⴳⵔⵜ', cropCustomPlaceholder: 'Melon, aubergine, papaye',
                cropOptionBanane: 'ⵜⵉⴳⴰⵢⵢⴰ', cropOptionTomate: 'ⵜⵉⵎⴰⵜⵉⵛ', cropOptionPoivron: 'Poivron', cropOptionConcombre: 'Concombre', cropOptionMelon: 'Melon', cropOptionCourgette: 'Courgette',
                cropOptionLaitue: 'Laitue', cropOptionFraise: 'ⵜⵉⴼⵔⴰⵙ', cropOptionAgrumes: 'Agrumes', cropOptionOlive: 'ⴰⵣⵎⵎⵓⵔ', cropOptionArgan: 'Argan',
                cropOptionBle: 'Ble', cropOptionOrge: 'Orge', cropOptionMais: 'ⴰⴷⵔⴰⵔ', cropOptionLuzerne: 'Luzerne', cropOptionAutre: 'ⵢⴰⴹⵏ'
            }
        };

        /* PATCH-02 — start */
        Object.entries(REGISTER_CROP_TRANSLATIONS).forEach(([lang, values]) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...values
            };
        });
        /* PATCH-02 — end */

        const HOMEPAGE_2026_TRANSLATIONS = {
            it: {
                luxBrandName: 'RAYAT',
                luxBrandSubtitle: 'SMART MONITORING',
                luxLogoAlt: 'Logo Rayat',
                luxTreeAlt: 'Illustrazione albero tecnologico Rayat',
                luxLanguageLabel: 'Seleziona lingua',
                luxMobileMenuLabel: 'Apri menu',
                luxNavProduct: 'Prodotto',
                luxNavSolutions: 'Soluzioni',
                luxNavTechnology: 'Tecnologia',
                luxNavResources: 'Risorse',
                luxNavPricing: 'Prezzi',
                luxNavAbout: 'Chi siamo',
                luxCtaDemo: 'Richiedi una demo',
                luxHeroEyebrow: 'Agricoltura intelligente',
                luxHeroTitleLine1: 'L’intelligenza',
                luxHeroTitleLine2: 'al servizio delle tue',
                luxHeroTitleAccent: 'colture.',
                luxHeroBody: 'Rayat trasforma i dati delle tue parcelle in decisioni precise per ottimizzare l’acqua, anticipare i rischi e migliorare i rendimenti.',
                luxHeroPrimaryCta: 'Richiedi una demo',
                luxHeroSecondaryCta: 'Scopri la piattaforma',
                luxMetricHumidityLabel: 'Umidità del suolo',
                luxMetricHumidityValue: '62%',
                luxMetricHumidityStatus: 'Ottimale',
                luxMetricTemperatureLabel: 'Temperatura',
                luxMetricTemperatureValue: '28.5°C',
                luxMetricTemperatureStatus: 'Stabile',
                luxMetricCropHealthLabel: 'Salute delle colture',
                luxMetricCropHealthValue: '85/100',
                luxMetricCropHealthStatus: 'Buona',
                luxMetricWaterLabel: 'Consumo d’acqua',
                luxMetricWaterValue: '-30%',
                luxMetricWaterStatus: 'vs settimana scorsa',
                luxLangShortIt: 'IT',
                luxLangShortEn: 'EN',
                luxLangShortFr: 'FR',
                luxLangShortAr: 'AR',
                luxLangShortTz: 'TZ',
                luxLangIt: 'Italiano',
                luxLangEn: 'English',
                luxLangFr: 'Français',
                luxLangAr: 'العربية',
                luxLangTz: 'Amazigh'
            },
            en: {
                luxBrandName: 'RAYAT',
                luxBrandSubtitle: 'SMART MONITORING',
                luxLogoAlt: 'Rayat logo',
                luxTreeAlt: 'Rayat technology tree illustration',
                luxLanguageLabel: 'Select language',
                luxMobileMenuLabel: 'Open menu',
                luxNavProduct: 'Product',
                luxNavSolutions: 'Solutions',
                luxNavTechnology: 'Technology',
                luxNavResources: 'Resources',
                luxNavPricing: 'Pricing',
                luxNavAbout: 'About',
                luxCtaDemo: 'Request a demo',
                luxHeroEyebrow: 'Intelligent agriculture',
                luxHeroTitleLine1: 'Intelligence',
                luxHeroTitleLine2: 'serving your',
                luxHeroTitleAccent: 'crops.',
                luxHeroBody: 'Rayat turns field data into precise decisions to optimize water, anticipate risks and improve yields.',
                luxHeroPrimaryCta: 'Request a demo',
                luxHeroSecondaryCta: 'Discover the platform',
                luxMetricHumidityLabel: 'Soil humidity',
                luxMetricHumidityValue: '62%',
                luxMetricHumidityStatus: 'Optimal',
                luxMetricTemperatureLabel: 'Temperature',
                luxMetricTemperatureValue: '28.5°C',
                luxMetricTemperatureStatus: 'Stable',
                luxMetricCropHealthLabel: 'Crop health',
                luxMetricCropHealthValue: '85/100',
                luxMetricCropHealthStatus: 'Good',
                luxMetricWaterLabel: 'Water consumption',
                luxMetricWaterValue: '-30%',
                luxMetricWaterStatus: 'vs last week',
                luxLangShortIt: 'IT',
                luxLangShortEn: 'EN',
                luxLangShortFr: 'FR',
                luxLangShortAr: 'AR',
                luxLangShortTz: 'TZ',
                luxLangIt: 'Italiano',
                luxLangEn: 'English',
                luxLangFr: 'Français',
                luxLangAr: 'العربية',
                luxLangTz: 'Amazigh'
            },
            fr: {
                luxBrandName: 'RAYAT',
                luxBrandSubtitle: 'SMART MONITORING',
                luxLogoAlt: 'Logo Rayat',
                luxTreeAlt: 'Illustration arbre technologique Rayat',
                luxLanguageLabel: 'Sélectionner la langue',
                luxMobileMenuLabel: 'Ouvrir le menu',
                luxNavProduct: 'Produit',
                luxNavSolutions: 'Solutions',
                luxNavTechnology: 'Technologie',
                luxNavResources: 'Ressources',
                luxNavPricing: 'Tarifs',
                luxNavAbout: 'À propos',
                luxCtaDemo: 'Demander une démo',
                luxHeroEyebrow: 'Agriculture intelligente',
                luxHeroTitleLine1: 'L’intelligence',
                luxHeroTitleLine2: 'au service de vos',
                luxHeroTitleAccent: 'cultures.',
                luxHeroBody: 'Rayat transforme les données de vos parcelles en décisions précises pour optimiser l’eau, anticiper les risques et améliorer vos rendements.',
                luxHeroPrimaryCta: 'Demander une démo',
                luxHeroSecondaryCta: 'Découvrir la plateforme',
                luxMetricHumidityLabel: 'Humidité du sol',
                luxMetricHumidityValue: '62%',
                luxMetricHumidityStatus: 'Optimal',
                luxMetricTemperatureLabel: 'Température',
                luxMetricTemperatureValue: '28.5°C',
                luxMetricTemperatureStatus: 'Stable',
                luxMetricCropHealthLabel: 'Santé des cultures',
                luxMetricCropHealthValue: '85/100',
                luxMetricCropHealthStatus: 'Bonne',
                luxMetricWaterLabel: 'Consommation d’eau',
                luxMetricWaterValue: '-30%',
                luxMetricWaterStatus: 'vs semaine dernière',
                luxLangShortIt: 'IT',
                luxLangShortEn: 'EN',
                luxLangShortFr: 'FR',
                luxLangShortAr: 'AR',
                luxLangShortTz: 'TZ',
                luxLangIt: 'Italiano',
                luxLangEn: 'English',
                luxLangFr: 'Français',
                luxLangAr: 'العربية',
                luxLangTz: 'Amazigh'
            },
            ar: {
                luxBrandName: 'رايات',
                luxBrandSubtitle: 'المراقبة الذكية',
                luxLogoAlt: 'شعار رايات',
                luxTreeAlt: 'رسم شجرة رايات التقنية',
                luxLanguageLabel: 'اختر اللغة',
                luxMobileMenuLabel: 'افتح القائمة',
                luxNavProduct: 'المنتج',
                luxNavSolutions: 'الحلول',
                luxNavTechnology: 'التقنية',
                luxNavResources: 'الموارد',
                luxNavPricing: 'الأسعار',
                luxNavAbout: 'من نحن',
                luxCtaDemo: 'اطلب عرضا تجريبيا',
                luxHeroEyebrow: 'زراعة ذكية',
                luxHeroTitleLine1: 'الذكاء',
                luxHeroTitleLine2: 'في خدمة',
                luxHeroTitleAccent: 'محاصيلك.',
                luxHeroBody: 'تحول رايات بيانات حقولك إلى قرارات دقيقة لتحسين استهلاك الماء، توقع المخاطر ورفع المردودية.',
                luxHeroPrimaryCta: 'اطلب عرضا تجريبيا',
                luxHeroSecondaryCta: 'اكتشف المنصة',
                luxMetricHumidityLabel: 'رطوبة التربة',
                luxMetricHumidityValue: '62%',
                luxMetricHumidityStatus: 'مثالية',
                luxMetricTemperatureLabel: 'درجة الحرارة',
                luxMetricTemperatureValue: '28.5°C',
                luxMetricTemperatureStatus: 'مستقرة',
                luxMetricCropHealthLabel: 'صحة المحاصيل',
                luxMetricCropHealthValue: '85/100',
                luxMetricCropHealthStatus: 'جيدة',
                luxMetricWaterLabel: 'استهلاك الماء',
                luxMetricWaterValue: '-30%',
                luxMetricWaterStatus: 'مقارنة بالأسبوع الماضي',
                luxLangShortIt: 'IT',
                luxLangShortEn: 'EN',
                luxLangShortFr: 'FR',
                luxLangShortAr: 'AR',
                luxLangShortTz: 'TZ',
                luxLangIt: 'Italiano',
                luxLangEn: 'English',
                luxLangFr: 'Français',
                luxLangAr: 'العربية',
                luxLangTz: 'Amazigh'
            },
            tz: {
                luxBrandName: 'RAYAT',
                luxBrandSubtitle: 'SMART MONITORING',
                luxLogoAlt: 'ⵍⵓⴳⵓ ⵏ Rayat',
                luxTreeAlt: 'ⵜⵓⵙⵙⵏⴰ ⵏ ⵓⵙⴽⵍⵓ ⴰⵜⵉⴽⵏⵉ ⵏ Rayat',
                luxLanguageLabel: 'ⴼⵔⵏ ⵜⵓⵜⵍⴰⵢⵜ',
                luxMobileMenuLabel: 'ⵍⴷⵉ ⵎⵉⵏⵓ',
                luxNavProduct: 'ⴰⴼⴰⵔⵉⵙ',
                luxNavSolutions: 'ⵜⵉⴼⵔⴰⵜⵉⵏ',
                luxNavTechnology: 'ⵜⵉⴽⵏⵓⵍⵓⵊⵉⵜ',
                luxNavResources: 'ⵉⵙⵓⴳⴰⵎ',
                luxNavPricing: 'ⵜⴰⵙⵎⴽⵜ',
                luxNavAbout: 'ⴼⵍⵍⴰⵏⵖ',
                luxCtaDemo: 'ⵜⵜⵔ ⴷⵉⵎⵓ',
                luxHeroEyebrow: 'ⵜⴼⵍⵍⴰⵃⵜ ⵜⴰⵎⵓⵙⵙⵏⴰⵜ',
                luxHeroTitleLine1: 'ⵜⵉⵎⵓⵙⵙⵏⵉ',
                luxHeroTitleLine2: 'ⵉ ⵓⴼⵓⵙ ⵏ',
                luxHeroTitleAccent: 'ⵜⵎⴳⵔⵜ ⵏⵏⵓⵏ.',
                luxHeroBody: 'Rayat ⵜⵙⴱⴷⴰⴷ ⵉⵙⴼⴽⴰ ⵏ ⵓⴽⴰⵍ ⵏⵏⵓⵏ ⴷ ⵜⵉⵖⵜⴰⵙ ⵉⵣⴷⵉⴳⵏ ⵉ ⵓⵙⵙⴷⵔⵓⵙ ⵏ ⵡⴰⵎⴰⵏ ⴷ ⵓⵙⴼⵔⴽ ⵏ ⵉⵎⵉⵀⵉⵜⵏ.',
                luxHeroPrimaryCta: 'ⵜⵜⵔ ⴷⵉⵎⵓ',
                luxHeroSecondaryCta: 'ⵙⵏⴼⵍ ⵜⴰⵎⵏⴰⴹⵜ',
                luxMetricHumidityLabel: 'ⵜⴰⵎⵉⴷⵉ ⵏ ⵓⴽⴰⵍ',
                luxMetricHumidityValue: '62%',
                luxMetricHumidityStatus: 'ⵉⵖⵓⴷⴰ',
                luxMetricTemperatureLabel: 'ⵜⴰⴼⵓⴽⵍⴰ',
                luxMetricTemperatureValue: '28.5°C',
                luxMetricTemperatureStatus: 'ⵜⵙⴷⴰⵡ',
                luxMetricCropHealthLabel: 'ⵜⴰⵎⴰⵣⵉⵔⵜ ⵏ ⵜⵎⴳⵔⵜ',
                luxMetricCropHealthValue: '85/100',
                luxMetricCropHealthStatus: 'ⵜⵖⵓⴷⴰ',
                luxMetricWaterLabel: 'ⴰⵙⵎⵔⵙ ⵏ ⵡⴰⵎⴰⵏ',
                luxMetricWaterValue: '-30%',
                luxMetricWaterStatus: 'ⵎⴳⴰⵍ ⵉⵎⴰⵍⴰⵙ ⵉⵣⵔⵉⵏ',
                luxLangShortIt: 'IT',
                luxLangShortEn: 'EN',
                luxLangShortFr: 'FR',
                luxLangShortAr: 'AR',
                luxLangShortTz: 'TZ',
                luxLangIt: 'Italiano',
                luxLangEn: 'English',
                luxLangFr: 'Français',
                luxLangAr: 'العربية',
                luxLangTz: 'Amazigh'
            }
        };
        HOMEPAGE_2026_TRANSLATIONS.zgh = { ...HOMEPAGE_2026_TRANSLATIONS.tz };

        Object.entries(HOMEPAGE_2026_TRANSLATIONS).forEach(([lang, values]) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...values
            };
        });

        const HOMEPAGE_2026_STEP2_TRANSLATIONS = {
            it: {
                luxDashboardSidebarTitle: 'RAYAT',
                luxDashboardSidebarSubtitle: 'Smart Monitoring',
                luxDashboardNavOverview: 'Vista generale',
                luxDashboardNavParcels: 'Parcelle',
                luxDashboardNavSensors: 'Sensori',
                luxDashboardNavIrrigation: 'Irrigazione',
                luxDashboardNavAlerts: 'Avvisi',
                luxDashboardNavAnalytics: 'Analisi',
                luxDashboardNavReports: 'Report',
                luxDashboardNavSettings: 'Impostazioni',
                luxDashboardProfileInitials: 'MA',
                luxDashboardProfileName: 'Mohamed Amine',
                luxDashboardProfileRole: 'Agricoltore',
                luxDashboardOverviewTitle: 'Vista d’insieme',
                luxDashboardPeriod: '18 - 24 Maggio 2026',
                luxDashboardExport: 'Esporta',
                luxKpiWaterLabel: 'Consumo d’acqua',
                luxKpiWaterValue: '-30%',
                luxKpiWaterStatus: 'vs settimana scorsa',
                luxKpiHealthLabel: 'Salute delle colture',
                luxKpiHealthValue: '85/100',
                luxKpiHealthStatus: 'Buona',
                luxKpiIrrigationLabel: 'Efficienza irrigazione',
                luxKpiIrrigationValue: '92%',
                luxKpiIrrigationStatus: 'Eccellente',
                luxKpiTempLabel: 'Temperatura media',
                luxKpiTempValue: '28.5°C',
                luxKpiTempStatus: 'Stabile',
                luxMapTitle: 'Le mie parcelle',
                luxMapFilter: 'Tutte le parcelle',
                luxMapZoomInLabel: 'Aumenta zoom',
                luxMapZoomOutLabel: 'Riduci zoom',
                luxMapLegendExcellent: 'Eccellente',
                luxMapLegendGood: 'Buona',
                luxMapLegendAverage: 'Media',
                luxMapLegendAlert: 'Allerta',
                luxAiTitle: 'Raccomandazioni IA',
                luxAiBadge: '3',
                luxAiRow1Title: 'Irrigazione consigliata',
                luxAiRow1Text: 'Tra 2h · Durata stimata 45 min',
                luxAiRow2Title: 'Rischio stress idrico',
                luxAiRow2Text: 'Elevato domani · Temperatura prevista 32°',
                luxAiRow3Title: 'Fertilizzazione',
                luxAiRow3Text: 'Nutrienti OK · Nessuna azione richiesta',
                luxAiViewAll: 'Vedi tutte le raccomandazioni',
                luxMobileCardTitle: 'Rayat Mobile',
                luxMobileCardText: 'La tua azienda sempre in tasca.',
                luxMobileAppStore: 'App Store',
                luxMobileGooglePlay: 'Google Play',
                luxPhoneParcel: 'Parcella 01',
                luxPhoneHumidityLabel: 'Umidità suolo',
                luxPhoneTempLabel: 'Temp.',
                luxPhoneEcLabel: 'EC',
                luxPhonePhLabel: 'pH',
                luxPhoneAirHumidityLabel: 'Umidità aria',
                luxPhoneTempValue: '28.5°C',
                luxPhoneEcValue: '1.2 dS/m',
                luxPhonePhValue: '6.3',
                luxPhoneAirHumidityValue: '45%',
                luxPhoneHome: 'Home',
                luxPhonePlots: 'Parcelle',
                luxPhoneAlerts: 'Avvisi',
                luxPhoneProfile: 'Profilo',
                luxFeatureIotTitle: 'Monitoraggio IoT',
                luxFeatureIotText: 'Sensori ad alta precisione in tempo reale.',
                luxFeatureIrrigationTitle: 'Irrigazione smart',
                luxFeatureIrrigationText: 'Consigli precisi per risparmiare acqua.',
                luxFeatureAnalyticsTitle: 'Analisi avanzate',
                luxFeatureAnalyticsText: 'Dati affidabili per decisioni chiare.',
                luxFeatureAlertsTitle: 'Avvisi e prevenzione',
                luxFeatureAlertsText: 'Notifiche prima che i problemi impattino.',
                luxFeatureAiTitle: 'Agronomo IA',
                luxFeatureAiText: 'Assistente intelligente disponibile 24/7.'
            },
            en: {
                luxDashboardSidebarTitle: 'RAYAT',
                luxDashboardSidebarSubtitle: 'Smart Monitoring',
                luxDashboardNavOverview: 'Overview',
                luxDashboardNavParcels: 'Parcels',
                luxDashboardNavSensors: 'Sensors',
                luxDashboardNavIrrigation: 'Irrigation',
                luxDashboardNavAlerts: 'Alerts',
                luxDashboardNavAnalytics: 'Analytics',
                luxDashboardNavReports: 'Reports',
                luxDashboardNavSettings: 'Settings',
                luxDashboardProfileInitials: 'MA',
                luxDashboardProfileName: 'Mohamed Amine',
                luxDashboardProfileRole: 'Farmer',
                luxDashboardOverviewTitle: 'Overview',
                luxDashboardPeriod: '18 - 24 May 2026',
                luxDashboardExport: 'Export',
                luxKpiWaterLabel: 'Water consumption',
                luxKpiWaterValue: '-30%',
                luxKpiWaterStatus: 'vs last week',
                luxKpiHealthLabel: 'Crop health',
                luxKpiHealthValue: '85/100',
                luxKpiHealthStatus: 'Good',
                luxKpiIrrigationLabel: 'Irrigation efficiency',
                luxKpiIrrigationValue: '92%',
                luxKpiIrrigationStatus: 'Excellent',
                luxKpiTempLabel: 'Average temperature',
                luxKpiTempValue: '28.5°C',
                luxKpiTempStatus: 'Stable',
                luxMapTitle: 'My parcels',
                luxMapFilter: 'All parcels',
                luxMapZoomInLabel: 'Zoom in',
                luxMapZoomOutLabel: 'Zoom out',
                luxMapLegendExcellent: 'Excellent',
                luxMapLegendGood: 'Good',
                luxMapLegendAverage: 'Average',
                luxMapLegendAlert: 'Alert',
                luxAiTitle: 'AI recommendations',
                luxAiBadge: '3',
                luxAiRow1Title: 'Recommended irrigation',
                luxAiRow1Text: 'In 2h · Estimated duration 45 min',
                luxAiRow2Title: 'Water stress risk',
                luxAiRow2Text: 'High tomorrow · Forecast temperature 32°',
                luxAiRow3Title: 'Fertilization',
                luxAiRow3Text: 'Nutrients OK · No action required',
                luxAiViewAll: 'View all recommendations',
                luxMobileCardTitle: 'Rayat Mobile',
                luxMobileCardText: 'Your operation in your pocket.',
                luxMobileAppStore: 'App Store',
                luxMobileGooglePlay: 'Google Play',
                luxPhoneParcel: 'Parcel 01',
                luxPhoneHumidityLabel: 'Soil humidity',
                luxPhoneTempLabel: 'Temp.',
                luxPhoneEcLabel: 'EC',
                luxPhonePhLabel: 'pH',
                luxPhoneAirHumidityLabel: 'Air humidity',
                luxPhoneTempValue: '28.5°C',
                luxPhoneEcValue: '1.2 dS/m',
                luxPhonePhValue: '6.3',
                luxPhoneAirHumidityValue: '45%',
                luxPhoneHome: 'Home',
                luxPhonePlots: 'Parcels',
                luxPhoneAlerts: 'Alerts',
                luxPhoneProfile: 'Profile',
                luxFeatureIotTitle: 'IoT Monitoring',
                luxFeatureIotText: 'High-precision sensors in real time.',
                luxFeatureIrrigationTitle: 'Smart Irrigation',
                luxFeatureIrrigationText: 'Precise recommendations to save water.',
                luxFeatureAnalyticsTitle: 'Analytics',
                luxFeatureAnalyticsText: 'Reliable data for clear decisions.',
                luxFeatureAlertsTitle: 'Alerts',
                luxFeatureAlertsText: 'Notifications before problems impact crops.',
                luxFeatureAiTitle: 'AI Agronomist',
                luxFeatureAiText: 'Intelligent assistant available 24/7.'
            },
            fr: {
                luxDashboardSidebarTitle: 'RAYAT',
                luxDashboardSidebarSubtitle: 'Smart Monitoring',
                luxDashboardNavOverview: 'Vue d’ensemble',
                luxDashboardNavParcels: 'Parcelles',
                luxDashboardNavSensors: 'Capteurs',
                luxDashboardNavIrrigation: 'Irrigation',
                luxDashboardNavAlerts: 'Alertes',
                luxDashboardNavAnalytics: 'Analyses',
                luxDashboardNavReports: 'Rapports',
                luxDashboardNavSettings: 'Paramètres',
                luxDashboardProfileInitials: 'MA',
                luxDashboardProfileName: 'Mohamed Amine',
                luxDashboardProfileRole: 'Agriculteur',
                luxDashboardOverviewTitle: 'Vue d’ensemble',
                luxDashboardPeriod: '18 - 24 Mai 2026',
                luxDashboardExport: 'Exporter',
                luxKpiWaterLabel: 'Consommation d’eau',
                luxKpiWaterValue: '-30%',
                luxKpiWaterStatus: 'vs semaine dernière',
                luxKpiHealthLabel: 'Santé des cultures',
                luxKpiHealthValue: '85/100',
                luxKpiHealthStatus: 'Bonne',
                luxKpiIrrigationLabel: 'Efficacité irrigation',
                luxKpiIrrigationValue: '92%',
                luxKpiIrrigationStatus: 'Excellente',
                luxKpiTempLabel: 'Température moyenne',
                luxKpiTempValue: '28.5°C',
                luxKpiTempStatus: 'Stable',
                luxMapTitle: 'Mes parcelles',
                luxMapFilter: 'Toutes les parcelles',
                luxMapZoomInLabel: 'Zoom avant',
                luxMapZoomOutLabel: 'Zoom arrière',
                luxMapLegendExcellent: 'Excellente',
                luxMapLegendGood: 'Bonne',
                luxMapLegendAverage: 'Moyenne',
                luxMapLegendAlert: 'Alerte',
                luxAiTitle: 'Recommandations IA',
                luxAiBadge: '3',
                luxAiRow1Title: 'Irrigation recommandée',
                luxAiRow1Text: 'Dans 2h · Durée estimée 45 min',
                luxAiRow2Title: 'Risque stress hydrique',
                luxAiRow2Text: 'Élevé demain · Température prévue 32°',
                luxAiRow3Title: 'Fertilisation',
                luxAiRow3Text: 'Nutriments OK · Aucune action requise',
                luxAiViewAll: 'Voir toutes les recommandations',
                luxMobileCardTitle: 'Rayat Mobile',
                luxMobileCardText: 'Votre exploitation dans votre poche.',
                luxMobileAppStore: 'App Store',
                luxMobileGooglePlay: 'Google Play',
                luxPhoneParcel: 'Parcelle 01',
                luxPhoneHumidityLabel: 'Humidité du sol',
                luxPhoneTempLabel: 'Temp.',
                luxPhoneEcLabel: 'EC',
                luxPhonePhLabel: 'pH',
                luxPhoneAirHumidityLabel: 'Humidité air',
                luxPhoneTempValue: '28.5°C',
                luxPhoneEcValue: '1.2 dS/m',
                luxPhonePhValue: '6.3',
                luxPhoneAirHumidityValue: '45%',
                luxPhoneHome: 'Accueil',
                luxPhonePlots: 'Parcelles',
                luxPhoneAlerts: 'Alertes',
                luxPhoneProfile: 'Profil',
                luxFeatureIotTitle: 'Surveillance IoT',
                luxFeatureIotText: 'Capteurs haute précision en temps réel.',
                luxFeatureIrrigationTitle: 'Irrigation optimisée',
                luxFeatureIrrigationText: 'Recommandations précises pour économiser l’eau.',
                luxFeatureAnalyticsTitle: 'Analyses avancées',
                luxFeatureAnalyticsText: 'Données fiables pour des décisions claires.',
                luxFeatureAlertsTitle: 'Alertes & prévention',
                luxFeatureAlertsText: 'Notifications avant que les problèmes n’impactent vos cultures.',
                luxFeatureAiTitle: 'Agronome IA',
                luxFeatureAiText: 'Assistant intelligent disponible 24/7.'
            },
            ar: {
                luxDashboardSidebarTitle: 'رايات',
                luxDashboardSidebarSubtitle: 'المراقبة الذكية',
                luxDashboardNavOverview: 'نظرة عامة',
                luxDashboardNavParcels: 'القطع',
                luxDashboardNavSensors: 'الحساسات',
                luxDashboardNavIrrigation: 'السقي',
                luxDashboardNavAlerts: 'التنبيهات',
                luxDashboardNavAnalytics: 'التحليلات',
                luxDashboardNavReports: 'التقارير',
                luxDashboardNavSettings: 'الإعدادات',
                luxDashboardProfileInitials: 'MA',
                luxDashboardProfileName: 'محمد أمين',
                luxDashboardProfileRole: 'مزارع',
                luxDashboardOverviewTitle: 'نظرة عامة',
                luxDashboardPeriod: '18 - 24 مايو 2026',
                luxDashboardExport: 'تصدير',
                luxKpiWaterLabel: 'استهلاك الماء',
                luxKpiWaterValue: '-30%',
                luxKpiWaterStatus: 'مقارنة بالأسبوع الماضي',
                luxKpiHealthLabel: 'صحة المحاصيل',
                luxKpiHealthValue: '85/100',
                luxKpiHealthStatus: 'جيدة',
                luxKpiIrrigationLabel: 'كفاءة السقي',
                luxKpiIrrigationValue: '92%',
                luxKpiIrrigationStatus: 'ممتازة',
                luxKpiTempLabel: 'متوسط الحرارة',
                luxKpiTempValue: '28.5°C',
                luxKpiTempStatus: 'مستقرة',
                luxMapTitle: 'قطعي الزراعية',
                luxMapFilter: 'كل القطع',
                luxMapZoomInLabel: 'تكبير',
                luxMapZoomOutLabel: 'تصغير',
                luxMapLegendExcellent: 'ممتازة',
                luxMapLegendGood: 'جيدة',
                luxMapLegendAverage: 'متوسطة',
                luxMapLegendAlert: 'تنبيه',
                luxAiTitle: 'توصيات الذكاء الاصطناعي',
                luxAiBadge: '3',
                luxAiRow1Title: 'سقي موصى به',
                luxAiRow1Text: 'بعد ساعتين · مدة تقديرية 45 دقيقة',
                luxAiRow2Title: 'خطر الإجهاد المائي',
                luxAiRow2Text: 'مرتفع غدا · الحرارة المتوقعة 32°',
                luxAiRow3Title: 'التسميد',
                luxAiRow3Text: 'العناصر جيدة · لا إجراء مطلوب',
                luxAiViewAll: 'عرض كل التوصيات',
                luxMobileCardTitle: 'رايات موبايل',
                luxMobileCardText: 'ضيعتك دائما في جيبك.',
                luxMobileAppStore: 'App Store',
                luxMobileGooglePlay: 'Google Play',
                luxPhoneParcel: 'القطعة 01',
                luxPhoneHumidityLabel: 'رطوبة التربة',
                luxPhoneTempLabel: 'الحرارة',
                luxPhoneEcLabel: 'EC',
                luxPhonePhLabel: 'pH',
                luxPhoneAirHumidityLabel: 'رطوبة الهواء',
                luxPhoneTempValue: '28.5°C',
                luxPhoneEcValue: '1.2 dS/m',
                luxPhonePhValue: '6.3',
                luxPhoneAirHumidityValue: '45%',
                luxPhoneHome: 'الرئيسية',
                luxPhonePlots: 'القطع',
                luxPhoneAlerts: 'التنبيهات',
                luxPhoneProfile: 'الملف',
                luxFeatureIotTitle: 'مراقبة IoT',
                luxFeatureIotText: 'حساسات عالية الدقة في الوقت الحقيقي.',
                luxFeatureIrrigationTitle: 'سقي ذكي',
                luxFeatureIrrigationText: 'توصيات دقيقة لتوفير الماء.',
                luxFeatureAnalyticsTitle: 'تحليلات',
                luxFeatureAnalyticsText: 'بيانات موثوقة لقرارات واضحة.',
                luxFeatureAlertsTitle: 'تنبيهات',
                luxFeatureAlertsText: 'إشعارات قبل تأثير المشاكل على المحاصيل.',
                luxFeatureAiTitle: 'مهندس زراعي IA',
                luxFeatureAiText: 'مساعد ذكي متاح 24/7.'
            },
            tz: {
                luxDashboardSidebarTitle: 'RAYAT',
                luxDashboardSidebarSubtitle: 'Smart Monitoring',
                luxDashboardNavOverview: 'ⵜⴰⵎⵓⵖⵍⵉ',
                luxDashboardNavParcels: 'ⵉⴳⵔⴰⵏ',
                luxDashboardNavSensors: 'ⵉⵎⵙⵙⵜⴰⵏⵏ',
                luxDashboardNavIrrigation: 'ⴰⵙⵙⴰⵢ',
                luxDashboardNavAlerts: 'ⴰⵍⵖⵓⵏ',
                luxDashboardNavAnalytics: 'ⵜⴰⵙⵍⴹⵜ',
                luxDashboardNavReports: 'ⵜⵉⵇⵇⴰⴷⵉⵏ',
                luxDashboardNavSettings: 'ⵜⵉⵙⵖⴰⵍ',
                luxDashboardProfileInitials: 'MA',
                luxDashboardProfileName: 'Mohamed Amine',
                luxDashboardProfileRole: 'ⴰⴼⵍⵍⴰⵃ',
                luxDashboardOverviewTitle: 'ⵜⴰⵎⵓⵖⵍⵉ',
                luxDashboardPeriod: '18 - 24 Mayyu 2026',
                luxDashboardExport: 'ⵙⵙⵓⴼⵖ',
                luxKpiWaterLabel: 'ⴰⵙⵎⵔⵙ ⵏ ⵡⴰⵎⴰⵏ',
                luxKpiWaterValue: '-30%',
                luxKpiWaterStatus: 'ⵎⴳⴰⵍ ⵉⵎⴰⵍⴰⵙ ⵉⵣⵔⵉⵏ',
                luxKpiHealthLabel: 'ⵜⴰⴷⵓⵙⵉ ⵏ ⵜⵎⴳⵔⵜ',
                luxKpiHealthValue: '85/100',
                luxKpiHealthStatus: 'ⵜⵖⵓⴷⴰ',
                luxKpiIrrigationLabel: 'ⵜⵉⵣⵎⵎⴰⵔ ⵏ ⵓⵙⵙⴰⵢ',
                luxKpiIrrigationValue: '92%',
                luxKpiIrrigationStatus: 'ⵉⵎⵜⵉⵢⴰⵣ',
                luxKpiTempLabel: 'ⵜⴰⴼⵓⴽⵍⴰ ⵜⴰⵎⵙⵏⴰⵎⵜ',
                luxKpiTempValue: '28.5°C',
                luxKpiTempStatus: 'ⵜⵙⴷⴰⵡ',
                luxMapTitle: 'ⵉⴳⵔⴰⵏ ⵉⵏⵓ',
                luxMapFilter: 'ⴽⵓ ⵉⴳⵔⴰⵏ',
                luxMapZoomInLabel: 'ⵙⵎⵖⵔ',
                luxMapZoomOutLabel: 'ⵙⵎⵥⵥⵉ',
                luxMapLegendExcellent: 'ⵉⵎⵜⵉⵢⴰⵣ',
                luxMapLegendGood: 'ⵜⵖⵓⴷⴰ',
                luxMapLegendAverage: 'ⵜⴰⵎⵙⵏⴰⵎⵜ',
                luxMapLegendAlert: 'ⴰⵍⵖⵓ',
                luxAiTitle: 'ⵜⵉⵡⵏⵏⴹⵉⵏ IA',
                luxAiBadge: '3',
                luxAiRow1Title: 'ⴰⵙⵙⴰⵢ ⵉⵜⵜⵓⵙⵎⵔⵙⵏ',
                luxAiRow1Text: 'ⴳ 2h · 45 min',
                luxAiRow2Title: 'ⵉⵎⵉⵀⵉ ⵏ ⵓⵥⵕⵓ ⵏ ⵡⴰⵎⴰⵏ',
                luxAiRow2Text: 'ⵉⵄⵍⴰ ⴰⵙⴽⴽⴰ · 32°',
                luxAiRow3Title: 'ⴰⵙⴼⵔⴰⵔ',
                luxAiRow3Text: 'ⵉⵎⴰⵏⵏ ⵖⵓⴷⴰⵏ · ⵓⵔ ⵉⵅⵚⵚⴰ ⵡⴰⵍⵓ',
                luxAiViewAll: 'ⵥⵔ ⴽⵓ ⵜⵉⵡⵏⵏⴹⵉⵏ',
                luxMobileCardTitle: 'Rayat Mobile',
                luxMobileCardText: 'ⵜⵉⴳⵎⵎⵉ ⵏⵏⴽ ⴳ ⵜⵓⴼⴼⵓⵙⵜ.',
                luxMobileAppStore: 'App Store',
                luxMobileGooglePlay: 'Google Play',
                luxPhoneParcel: 'ⴰⴳⵔ 01',
                luxPhoneHumidityLabel: 'ⵜⴰⵎⵉⴷⵉ ⵏ ⵓⴽⴰⵍ',
                luxPhoneTempLabel: 'ⵜⴰⴼⵓⴽⵍⴰ',
                luxPhoneEcLabel: 'EC',
                luxPhonePhLabel: 'pH',
                luxPhoneAirHumidityLabel: 'ⵜⴰⵎⵉⴷⵉ ⵏ ⵡⴰⵍⵍⵓⵏ',
                luxPhoneTempValue: '28.5°C',
                luxPhoneEcValue: '1.2 dS/m',
                luxPhonePhValue: '6.3',
                luxPhoneAirHumidityValue: '45%',
                luxPhoneHome: 'ⴰⵙⵏⵓⴱⴳ',
                luxPhonePlots: 'ⵉⴳⵔⴰⵏ',
                luxPhoneAlerts: 'ⴰⵍⵖⵓⵏ',
                luxPhoneProfile: 'ⴰⴼⵔⵙ',
                luxFeatureIotTitle: 'ⵜⴰⴳⴳⴰ IoT',
                luxFeatureIotText: 'ⵉⵎⵙⵙⵜⴰⵏⵏ ⵙ ⵜⵉⵙⴷⴷⵉ ⵉⵄⵍⴰⵏ.',
                luxFeatureIrrigationTitle: 'ⴰⵙⵙⴰⵢ ⴰⵎⵓⵙⵙⵏ',
                luxFeatureIrrigationText: 'ⵜⵉⵡⵏⵏⴹⵉⵏ ⵉ ⵓⵙⵙⴷⵔⵓⵙ ⵏ ⵡⴰⵎⴰⵏ.',
                luxFeatureAnalyticsTitle: 'ⵜⴰⵙⵍⴹⵜ',
                luxFeatureAnalyticsText: 'ⵉⵙⴼⴽⴰ ⵉⵖⵓⴷⴰⵏ ⵉ ⵜⵉⵖⵜⴰⵙ ⵉⴼⴰⵡⵏ.',
                luxFeatureAlertsTitle: 'ⴰⵍⵖⵓⵏ',
                luxFeatureAlertsText: 'ⵉⵍⵖⴰ ⵇⴱⵍ ⴰⴷ ⵉⵎⵙⴰⵙⴰ ⵓⴳⵓⵔ.',
                luxFeatureAiTitle: 'ⴰⴳⵔⵓⵏⵓⵎ IA',
                luxFeatureAiText: 'ⴰⵎⴰⵣⵣⴰⵍ ⴰⵎⵓⵙⵙⵏ 24/7.'
            }
        };
        HOMEPAGE_2026_STEP2_TRANSLATIONS.zgh = { ...HOMEPAGE_2026_STEP2_TRANSLATIONS.tz };

        Object.entries(HOMEPAGE_2026_STEP2_TRANSLATIONS).forEach(([lang, values]) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...values
            };
        });

        const RAYAT_HOMEPAGE_EDITORIAL_2026_TRANSLATIONS = {
            it: {
                luxEditorialEyebrow: 'Perche Rayat?',
                luxEditorialTitle: 'Una piattaforma completa, intelligente, connessa.',
                luxEditorialText: 'Rayat unisce sensori IoT professionali, intelligenza agronomica e dati sul campo in un\'unica piattaforma, per aiutarti a prendere decisioni migliori al momento giusto.',
                luxEditorialLiveTitle: 'Dati in tempo reale',
                luxEditorialLiveText: 'Monitora le parcelle 24/7 con sensori IoT ad alta precisione.',
                luxEditorialAiTitle: 'Intelligenza agronomica',
                luxEditorialAiText: 'L\'IA analizza i dati e fornisce consigli agronomici operativi.',
                luxEditorialWaterTitle: 'Ottimizzazione dell\'acqua',
                luxEditorialWaterText: 'Riduci fino al 30% il consumo idrico con raccomandazioni mirate.',
                luxEditorialAlertsTitle: 'Prevenzione e avvisi',
                luxEditorialAlertsText: 'Anticipa i rischi con avvisi tempestivi per proteggere le colture.',
                luxEditorialPrimaryCta: 'Scopri la piattaforma',
                luxEditorialSecondaryCta: 'Guarda come funziona',
                luxEditorialPhotoAlt: 'Coltivazioni verdi monitorate da Rayat',
                luxEditorialKpiWaterValue: '+30%',
                luxEditorialKpiWaterText: 'Risparmio idrico medio',
                luxEditorialKpiYieldValue: '+25%',
                luxEditorialKpiYieldText: 'Produttivita delle colture',
                luxEditorialKpiMonitoringValue: '24/7',
                luxEditorialKpiMonitoringText: 'Monitoraggio continuo',
                luxEditorialKpiFarmersValue: '+500',
                luxEditorialKpiFarmersText: 'Agricoltori si fidano di noi'
            },
            en: {
                luxEditorialEyebrow: 'Why Rayat?',
                luxEditorialTitle: 'A complete, intelligent, connected platform.',
                luxEditorialText: 'Rayat brings professional IoT sensors, agronomic intelligence and field data together in one platform, helping you make better decisions at the right time.',
                luxEditorialLiveTitle: 'Real-time data',
                luxEditorialLiveText: 'Monitor plots 24/7 with high-precision IoT sensors.',
                luxEditorialAiTitle: 'Agronomic intelligence',
                luxEditorialAiText: 'AI analyzes your data and delivers actionable agronomic guidance.',
                luxEditorialWaterTitle: 'Water optimization',
                luxEditorialWaterText: 'Reduce water use by up to 30% with targeted recommendations.',
                luxEditorialAlertsTitle: 'Prevention and alerts',
                luxEditorialAlertsText: 'Anticipate risks with timely alerts that protect your crops.',
                luxEditorialPrimaryCta: 'Discover the platform',
                luxEditorialSecondaryCta: 'See how it works',
                luxEditorialPhotoAlt: 'Green crops monitored by Rayat',
                luxEditorialKpiWaterValue: '+30%',
                luxEditorialKpiWaterText: 'Average water savings',
                luxEditorialKpiYieldValue: '+25%',
                luxEditorialKpiYieldText: 'Crop productivity',
                luxEditorialKpiMonitoringValue: '24/7',
                luxEditorialKpiMonitoringText: 'Continuous monitoring',
                luxEditorialKpiFarmersValue: '+500',
                luxEditorialKpiFarmersText: 'Farmers trust us'
            },
            fr: {
                luxEditorialEyebrow: 'Pourquoi Rayat ?',
                luxEditorialTitle: 'Une plateforme complete, intelligente, connectee.',
                luxEditorialText: 'Rayat reunit capteurs IoT professionnels, intelligence agronomique et donnees terrain dans une seule plateforme pour vous aider a prendre les meilleures decisions, au bon moment.',
                luxEditorialLiveTitle: 'Donnees en temps reel',
                luxEditorialLiveText: 'Surveillez vos parcelles 24/7 grace a des capteurs IoT de haute precision.',
                luxEditorialAiTitle: 'Intelligence agronomique',
                luxEditorialAiText: 'L\'IA analyse vos donnees et fournit des conseils agronomiques actionnables.',
                luxEditorialWaterTitle: 'Optimisation de l\'eau',
                luxEditorialWaterText: 'Reduisez jusqu\'a 30% votre consommation d\'eau avec des recommandations ciblees.',
                luxEditorialAlertsTitle: 'Prevention et alertes',
                luxEditorialAlertsText: 'Anticipez les risques avec des alertes instantanees pour proteger vos cultures.',
                luxEditorialPrimaryCta: 'Decouvrir la plateforme',
                luxEditorialSecondaryCta: 'Voir comment ca marche',
                luxEditorialPhotoAlt: 'Cultures vertes surveillees par Rayat',
                luxEditorialKpiWaterValue: '+30%',
                luxEditorialKpiWaterText: 'Economie d\'eau en moyenne',
                luxEditorialKpiYieldValue: '+25%',
                luxEditorialKpiYieldText: 'Productivite des cultures',
                luxEditorialKpiMonitoringValue: '24/7',
                luxEditorialKpiMonitoringText: 'Surveillance continue',
                luxEditorialKpiFarmersValue: '+500',
                luxEditorialKpiFarmersText: 'Agriculteurs nous font confiance'
            },
            ar: {
                luxEditorialEyebrow: 'لماذا رايات؟',
                luxEditorialTitle: 'منصة متكاملة وذكية ومتصلة.',
                luxEditorialText: 'تجمع رايات بين مستشعرات إنترنت الأشياء الاحترافية والذكاء الزراعي وبيانات الحقل في منصة واحدة لاتخاذ قرارات أفضل في الوقت المناسب.',
                luxEditorialLiveTitle: 'بيانات في الوقت الحقيقي',
                luxEditorialLiveText: 'راقب قطعك الزراعية على مدار الساعة بمستشعرات عالية الدقة.',
                luxEditorialAiTitle: 'ذكاء زراعي',
                luxEditorialAiText: 'يحلل الذكاء الاصطناعي بياناتك ويقدم توصيات عملية.',
                luxEditorialWaterTitle: 'تحسين استخدام المياه',
                luxEditorialWaterText: 'قلل استهلاك المياه حتى 30% بتوصيات موجهة.',
                luxEditorialAlertsTitle: 'الوقاية والتنبيهات',
                luxEditorialAlertsText: 'توقع المخاطر بتنبيهات فورية تحمي محاصيلك.',
                luxEditorialPrimaryCta: 'اكتشف المنصة',
                luxEditorialSecondaryCta: 'شاهد كيف تعمل',
                luxEditorialPhotoAlt: 'محاصيل خضراء تراقبها رايات',
                luxEditorialKpiWaterValue: '+30%',
                luxEditorialKpiWaterText: 'متوسط توفير المياه',
                luxEditorialKpiYieldValue: '+25%',
                luxEditorialKpiYieldText: 'إنتاجية المحاصيل',
                luxEditorialKpiMonitoringValue: '24/7',
                luxEditorialKpiMonitoringText: 'مراقبة مستمرة',
                luxEditorialKpiFarmersValue: '+500',
                luxEditorialKpiFarmersText: 'مزارعون يثقون بنا'
            },
            tz: {
                luxEditorialEyebrow: 'ⵎⴰⵅ ⵔⴰⵢⴰⵜ?',
                luxEditorialTitle: 'ⵜⴰⵙⵏⵙⵉ ⵉⴽⵎⵍⵏ, ⵉⵎⵓⵙⵙⵏ, ⵉⵣⴷⵉⵏ.',
                luxEditorialText: 'Rayat ⴰⵔ ⵜⵙⵎⵓⵏ IoT, ⵜⵉⵎⵓⵙⵙⵏⵉ ⵏ ⵜⴼⵍⴰⵃⵜ ⴷ ⵉⵙⴼⴽⴰ ⵏ ⵓⴳⵔ ⴳ ⵢⴰⵜ ⵜⵙⵏⵙⵉ.',
                luxEditorialLiveTitle: 'ⵉⵙⴼⴽⴰ ⵙ ⵓⵣⵎⵣ',
                luxEditorialLiveText: 'ⵙⵙⵜⵉ ⵉⴳⵔⴰⵏ 24/7 ⵙ IoT ⵉⵖⵓⴷⴰⵏ.',
                luxEditorialAiTitle: 'ⵜⵉⵎⵓⵙⵙⵏⵉ ⵏ ⵜⴼⵍⴰⵃⵜ',
                luxEditorialAiText: 'IA ⵜⴻⵜⵜⴰⵡⵙⴰ ⵉⵙⴼⴽⴰ ⵏⵏⴽ ⴰⴷ ⵜⴰⴼⴷ ⵜⵉⵡⵏⵏⴹⵉⵏ.',
                luxEditorialWaterTitle: 'ⴰⵙⵙⴷⵔⵓⵙ ⵏ ⵡⴰⵎⴰⵏ',
                luxEditorialWaterText: 'ⵙⵙⴷⵔⵓⵙ ⴰⵙⴻⵇⴷⴻⵛ ⵏ ⵡⴰⵎⴰⵏ ⴰⵔ 30%.',
                luxEditorialAlertsTitle: 'ⴰⵙⴳⴷⵍ ⴷ ⵉⵍⵖⴰ',
                luxEditorialAlertsText: 'ⵙⵙⵉⵡⴹ ⵉⵍⵖⴰ ⵣⵉⴽ ⵉ ⵓⵃⵔⴰⵣ ⵏ ⵉⵎⵉⵔⴰⵏ.',
                luxEditorialPrimaryCta: 'ⵙⵙⵏ ⵜⴰⵙⵏⵙⵉ',
                luxEditorialSecondaryCta: 'ⵥⵔ ⵎⴰⵎⴽ ⵜⵙⵡⵓⵔⵉ',
                luxEditorialPhotoAlt: 'ⵉⵎⵉⵔⴰⵏ ⵉⵣⴳⵣⴰⵡⵏ ⵙ Rayat',
                luxEditorialKpiWaterValue: '+30%',
                luxEditorialKpiWaterText: 'ⴰⵙⴻⵇⴷⴻⵛ ⵏ ⵡⴰⵎⴰⵏ',
                luxEditorialKpiYieldValue: '+25%',
                luxEditorialKpiYieldText: 'ⴰⵙⴼⴰⵔⵉ ⵏ ⵉⵎⵉⵔⴰⵏ',
                luxEditorialKpiMonitoringValue: '24/7',
                luxEditorialKpiMonitoringText: 'ⵜⴰⴳⴳⴰ ⵜⴰⵎⵖⵍⴰⵍⵜ',
                luxEditorialKpiFarmersValue: '+500',
                luxEditorialKpiFarmersText: 'ⵉⴼⵍⵍⴰⵃⵏ ⵜⵜⴰⴽⴽⵯⵙⵏ ⵖⵓⵔⵏⵖ'
            }
        };
        RAYAT_HOMEPAGE_EDITORIAL_2026_TRANSLATIONS.zgh = { ...RAYAT_HOMEPAGE_EDITORIAL_2026_TRANSLATIONS.tz };

        Object.entries(RAYAT_HOMEPAGE_EDITORIAL_2026_TRANSLATIONS).forEach(([lang, values]) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...values
            };
        });

        const RAYAT_HOMEPAGE_LIVE_SUITE_2026_TRANSLATIONS = {
            it: {
                luxLiveSensorEyebrow: 'Sensori in tempo reale',
                luxLiveSensorTitle: 'Tutti i parametri, sotto controllo.',
                luxLiveSensorText: 'Dati in tempo reale dai tuoi campi.',
                luxLiveHumidityLabel: 'Umidità',
                luxLiveAllSensors: 'Vedi tutti i sensori',
                luxLiveChartCollecting: 'Raccolta dati live',
                luxLiveAiEyebrow: 'Raccomandazioni IA',
                luxLiveAiTitle: 'Decisioni intelligenti, colture più sane.',
                luxLiveAiText: 'L\'intelligenza artificiale analizza i dati e anticipa i problemi prima che accadano.',
                luxLiveAiHowWorks: 'Scopri come funziona',
                luxLivePriorityMedium: 'Priorità media',
                luxLivePriorityHigh: 'Priorità alta',
                luxLivePriorityLow: 'Priorità bassa',
                luxLiveIrrigationOutcome: 'Tra 2 ore',
                luxLiveIrrigationFactOne: 'Durata stimata: 45 min',
                luxLiveIrrigationFactTwo: 'Risparmio acqua: 18%',
                luxLiveIrrigationCta: 'Vedi dettagli e programma',
                luxLiveRiskOutcome: 'Elevato domani',
                luxLiveRiskFactOne: 'Temperatura prevista: 32 C',
                luxLiveRiskFactTwo: 'Umidità suolo in calo',
                luxLiveRiskCta: 'Vedi analisi dettagliata',
                luxLiveFertilizationOutcome: 'Azoto consigliato',
                luxLiveFertilizationFactOne: 'Dose suggerita: 25 kg/ha',
                luxLiveFertilizationFactTwo: 'Entro 48 ore',
                luxLiveFertilizationCta: 'Piano di fertilizzazione',
                luxLiveHealthTitle: 'Salute delle colture',
                luxLiveHealthOutcome: 'Buona',
                luxLiveHealthFactOne: 'Nessun rischio rilevato',
                luxLiveHealthFactTwo: 'Continua così',
                luxLiveHealthCta: 'Vedi raccomandazioni',
                luxLiveApplicationsTitle: 'Applicazioni',
                luxLiveApplicationsText: 'Dove Rayat può essere utilizzato.',
                luxLiveAppGreenhouses: 'Serre',
                luxLiveAppBananas: 'Banane',
                luxLiveAppMelons: 'Meloni',
                luxLiveAppTomatoes: 'Pomodori',
                luxLiveAppIrrigation: 'Irrigazione smart',
                luxLiveAppCooperatives: 'Cooperative',
                luxLiveAllApplications: 'Vedi tutte le applicazioni'
            },
            en: {
                luxLiveSensorEyebrow: 'Real-time sensors',
                luxLiveSensorTitle: 'Every parameter, under control.',
                luxLiveSensorText: 'Real-time data from your fields.',
                luxLiveHumidityLabel: 'Humidity',
                luxLiveAllSensors: 'View all sensors',
                luxLiveChartCollecting: 'Collecting live data',
                luxLiveAiEyebrow: 'AI recommendations',
                luxLiveAiTitle: 'Smarter decisions, healthier crops.',
                luxLiveAiText: 'Artificial intelligence analyzes data and anticipates issues before they occur.',
                luxLiveAiHowWorks: 'Discover how it works',
                luxLivePriorityMedium: 'Medium priority',
                luxLivePriorityHigh: 'High priority',
                luxLivePriorityLow: 'Low priority',
                luxLiveIrrigationOutcome: 'In 2 hours',
                luxLiveIrrigationFactOne: 'Estimated duration: 45 min',
                luxLiveIrrigationFactTwo: 'Water saving: 18%',
                luxLiveIrrigationCta: 'View details and schedule',
                luxLiveRiskOutcome: 'High tomorrow',
                luxLiveRiskFactOne: 'Forecast temperature: 32 C',
                luxLiveRiskFactTwo: 'Soil humidity decreasing',
                luxLiveRiskCta: 'View detailed analysis',
                luxLiveFertilizationOutcome: 'Recommended nitrogen',
                luxLiveFertilizationFactOne: 'Suggested dose: 25 kg/ha',
                luxLiveFertilizationFactTwo: 'Within 48 hours',
                luxLiveFertilizationCta: 'Fertilization plan',
                luxLiveHealthTitle: 'Crop health',
                luxLiveHealthOutcome: 'Good',
                luxLiveHealthFactOne: 'No risk detected',
                luxLiveHealthFactTwo: 'Keep going',
                luxLiveHealthCta: 'View recommendations',
                luxLiveApplicationsTitle: 'Applications',
                luxLiveApplicationsText: 'Where Rayat can be used.',
                luxLiveAppGreenhouses: 'Greenhouses',
                luxLiveAppBananas: 'Bananas',
                luxLiveAppMelons: 'Melons',
                luxLiveAppTomatoes: 'Tomatoes',
                luxLiveAppIrrigation: 'Smart irrigation',
                luxLiveAppCooperatives: 'Cooperatives',
                luxLiveAllApplications: 'View all applications'
            },
            fr: {
                luxLiveSensorEyebrow: 'Capteurs en temps reel',
                luxLiveSensorTitle: 'Tous les parametres sous controle.',
                luxLiveSensorText: 'Donnees en temps reel depuis vos champs.',
                luxLiveHumidityLabel: 'Humidite',
                luxLiveAllSensors: 'Voir tous les capteurs',
                luxLiveChartCollecting: 'Collecte des donnees live',
                luxLiveAiEyebrow: 'Recommandations IA',
                luxLiveAiTitle: 'Decisions intelligentes, cultures plus saines.',
                luxLiveAiText: 'L\'intelligence artificielle analyse les donnees et anticipe les problemes avant qu\'ils ne surviennent.',
                luxLiveAiHowWorks: 'Decouvrir le fonctionnement',
                luxLivePriorityMedium: 'Priorite moyenne',
                luxLivePriorityHigh: 'Priorite haute',
                luxLivePriorityLow: 'Priorite basse',
                luxLiveIrrigationOutcome: 'Dans 2 heures',
                luxLiveIrrigationFactOne: 'Duree estimee : 45 min',
                luxLiveIrrigationFactTwo: 'Economie d\'eau : 18%',
                luxLiveIrrigationCta: 'Voir details et programme',
                luxLiveRiskOutcome: 'Eleve demain',
                luxLiveRiskFactOne: 'Temperature prevue : 32 C',
                luxLiveRiskFactTwo: 'Humidite du sol en baisse',
                luxLiveRiskCta: 'Voir l\'analyse detaillee',
                luxLiveFertilizationOutcome: 'Azote conseille',
                luxLiveFertilizationFactOne: 'Dose suggeree : 25 kg/ha',
                luxLiveFertilizationFactTwo: 'Sous 48 heures',
                luxLiveFertilizationCta: 'Plan de fertilisation',
                luxLiveHealthTitle: 'Sante des cultures',
                luxLiveHealthOutcome: 'Bonne',
                luxLiveHealthFactOne: 'Aucun risque detecte',
                luxLiveHealthFactTwo: 'Continuez ainsi',
                luxLiveHealthCta: 'Voir recommandations',
                luxLiveApplicationsTitle: 'Applications',
                luxLiveApplicationsText: 'Ou Rayat peut etre utilise.',
                luxLiveAppGreenhouses: 'Serres',
                luxLiveAppBananas: 'Bananes',
                luxLiveAppMelons: 'Melons',
                luxLiveAppTomatoes: 'Tomates',
                luxLiveAppIrrigation: 'Irrigation intelligente',
                luxLiveAppCooperatives: 'Cooperatives',
                luxLiveAllApplications: 'Voir toutes les applications'
            },
            ar: {
                luxLiveSensorEyebrow: 'حساسات في الوقت الحقيقي',
                luxLiveSensorTitle: 'كل المؤشرات تحت السيطرة.',
                luxLiveSensorText: 'بيانات مباشرة من حقولك.',
                luxLiveHumidityLabel: 'الرطوبة',
                luxLiveAllSensors: 'عرض كل الحساسات',
                luxLiveChartCollecting: 'جار جمع البيانات المباشرة',
                luxLiveAiEyebrow: 'توصيات الذكاء الاصطناعي',
                luxLiveAiTitle: 'قرارات أذكى ومحاصيل أكثر صحة.',
                luxLiveAiText: 'يحلل الذكاء الاصطناعي البيانات ويتوقع المشكلات قبل وقوعها.',
                luxLiveAiHowWorks: 'اكتشف كيف يعمل',
                luxLivePriorityMedium: 'أولوية متوسطة',
                luxLivePriorityHigh: 'أولوية عالية',
                luxLivePriorityLow: 'أولوية منخفضة',
                luxLiveIrrigationOutcome: 'خلال ساعتين',
                luxLiveIrrigationFactOne: 'المدة المتوقعة: 45 دقيقة',
                luxLiveIrrigationFactTwo: 'توفير المياه: 18%',
                luxLiveIrrigationCta: 'عرض التفاصيل والبرنامج',
                luxLiveRiskOutcome: 'مرتفع غدا',
                luxLiveRiskFactOne: 'الحرارة المتوقعة: 32 C',
                luxLiveRiskFactTwo: 'انخفاض رطوبة التربة',
                luxLiveRiskCta: 'عرض التحليل المفصل',
                luxLiveFertilizationOutcome: 'آزوت موصى به',
                luxLiveFertilizationFactOne: 'الجرعة المقترحة: 25 كغ/هكتار',
                luxLiveFertilizationFactTwo: 'خلال 48 ساعة',
                luxLiveFertilizationCta: 'خطة التسميد',
                luxLiveHealthTitle: 'صحة المحاصيل',
                luxLiveHealthOutcome: 'جيدة',
                luxLiveHealthFactOne: 'لا مخاطر مكتشفة',
                luxLiveHealthFactTwo: 'استمر هكذا',
                luxLiveHealthCta: 'عرض التوصيات',
                luxLiveApplicationsTitle: 'التطبيقات',
                luxLiveApplicationsText: 'مجالات استخدام رايات.',
                luxLiveAppGreenhouses: 'البيوت المحمية',
                luxLiveAppBananas: 'الموز',
                luxLiveAppMelons: 'البطيخ',
                luxLiveAppTomatoes: 'الطماطم',
                luxLiveAppIrrigation: 'السقي الذكي',
                luxLiveAppCooperatives: 'التعاونيات',
                luxLiveAllApplications: 'عرض كل التطبيقات'
            },
            tz: {
                luxLiveSensorEyebrow: 'ⵉⵎⵙⵙⵜⴰⵏⵏ ⵙ ⵓⵣⵎⵣ',
                luxLiveSensorTitle: 'ⴽⵓ ⵉⵎⵉⵜⴰⵔⵏ ⴳ ⵓⵎⵓⵔⵙ.',
                luxLiveSensorText: 'ⵉⵙⴼⴽⴰ ⵙ ⵓⵣⵎⵣ ⵙⴳ ⵉⴳⵔⴰⵏ ⵏⵏⴽ.',
                luxLiveHumidityLabel: 'ⵜⴰⵎⵉⴷⵉ',
                luxLiveAllSensors: 'ⵥⵔ ⴽⵓ ⵉⵎⵙⵙⵜⴰⵏⵏ',
                luxLiveChartCollecting: 'ⴰⵙⵎⵎⵓⵏ ⵏ ⵉⵙⴼⴽⴰ',
                luxLiveAiEyebrow: 'ⵜⵉⵡⵏⵏⴹⵉⵏ IA',
                luxLiveAiTitle: 'ⵜⵉⵖⵜⴰⵙ ⵉⵎⵓⵙⵙⵏ, ⵉⵎⵉⵔⴰⵏ ⵉⵖⵓⴷⴰⵏ.',
                luxLiveAiText: 'IA ⴰⵔ ⵜⵙⵍⴹ ⵉⵙⴼⴽⴰ ⵜⵙⵙⵏ ⵉⵎⵓⴽⵔⵉⵙⵏ ⵣⵉⴽ.',
                luxLiveAiHowWorks: 'ⵙⵙⵏ ⵎⴰⵎⴽ ⵜⵙⵡⵓⵔⵉ',
                luxLivePriorityMedium: 'ⵜⴰⵣⵡⴰⵔⵜ ⵜⴰⵏⴰⵎⵎⴰⵙⵜ',
                luxLivePriorityHigh: 'ⵜⴰⵣⵡⴰⵔⵜ ⵜⴰⵎⵇⵇⵔⴰⵏⵜ',
                luxLivePriorityLow: 'ⵜⴰⵣⵡⴰⵔⵜ ⵉⴷⵔⵓⵙⵏ',
                luxLiveIrrigationOutcome: 'ⴳ 2h',
                luxLiveIrrigationFactOne: 'ⴰⴽⵓⴷ: 45 min',
                luxLiveIrrigationFactTwo: 'ⴰⵎⴰⵏ: 18%',
                luxLiveIrrigationCta: 'ⵥⵔ ⵜⵉⵙⴳⴳⵯⴰⵍ',
                luxLiveRiskOutcome: 'ⵉⵄⵍⴰ ⴰⵙⴽⴽⴰ',
                luxLiveRiskFactOne: 'ⵜⴰⴼⵓⴽⵍⴰ: 32 C',
                luxLiveRiskFactTwo: 'ⵜⴰⵎⵉⴷⵉ ⴰⵔ ⵜⴷⵔⵓⵙ',
                luxLiveRiskCta: 'ⵥⵔ ⵜⴰⵙⵍⴹⵜ',
                luxLiveFertilizationOutcome: 'ⴰⵣⵓⵜ ⵉⵜⵜⵓⵙⵎⵔⵙⵏ',
                luxLiveFertilizationFactOne: '25 kg/ha',
                luxLiveFertilizationFactTwo: 'ⴳ 48h',
                luxLiveFertilizationCta: 'ⴰⵙⵖⵉⵡⵙ ⵏ ⵓⵙⴼⵔⴰⵔ',
                luxLiveHealthTitle: 'ⵜⴰⵣⵎⵔⵜ ⵏ ⵉⵎⵉⵔⴰⵏ',
                luxLiveHealthOutcome: 'ⵜⵖⵓⴷⴰ',
                luxLiveHealthFactOne: 'ⵓⵔ ⵉⵍⵍⵉ ⵓⵎⵉⵀⵉ',
                luxLiveHealthFactTwo: 'ⴽⵎⵎⵍ',
                luxLiveHealthCta: 'ⵥⵔ ⵜⵉⵡⵏⵏⴹⵉⵏ',
                luxLiveApplicationsTitle: 'ⵉⵙⵎⵔⴰⵙⵏ',
                luxLiveApplicationsText: 'ⵎⴰⵏⵉ ⵉⵣⵎⵔ ⴰⴷ ⵜⵜⵓⵙⵎⵔⵙ Rayat.',
                luxLiveAppGreenhouses: 'ⵉⴼⵔⴰⴳⵏ',
                luxLiveAppBananas: 'ⴱⴰⵏⴰⵏ',
                luxLiveAppMelons: 'ⵎⵉⵍⵓⵏ',
                luxLiveAppTomatoes: 'ⵜⵉⵎⴰⵜⵉⵛⵉⵏ',
                luxLiveAppIrrigation: 'ⴰⵙⵙⴰⵢ ⴰⵎⵓⵙⵙⵏ',
                luxLiveAppCooperatives: 'ⵜⵉⵡⵉⵙⵉ',
                luxLiveAllApplications: 'ⵥⵔ ⴽⵓ ⵉⵙⵎⵔⴰⵙⵏ'
            }
        };
        RAYAT_HOMEPAGE_LIVE_SUITE_2026_TRANSLATIONS.zgh = { ...RAYAT_HOMEPAGE_LIVE_SUITE_2026_TRANSLATIONS.tz };

        Object.entries(RAYAT_HOMEPAGE_LIVE_SUITE_2026_TRANSLATIONS).forEach(([lang, values]) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...values
            };
        });

        const RAYAT_HOMEPAGE_FINAL_2026_TRANSLATIONS = {
            it: {
                luxFinalMobileStep: '8',
                luxFinalMobileEyebrow: 'I tuoi campi, sempre con te',
                luxFinalMobileTitle: 'Il tuo campo, sempre in tasca.',
                luxFinalMobileText: 'Monitora, analizza e gestisci tutto da dove vuoi. In ogni momento.',
                luxFinalDownloadOn: 'Scarica su',
                luxFinalAvailableOn: 'Disponibile su',
                luxFinalAppStore: 'App Store',
                luxFinalGooglePlay: 'Google Play',
                luxFinalMapTitle: 'Mappa dei campi',
                luxFinalFieldName: 'Campo Nord',
                luxFinalCropName: 'Pomodori',
                luxFinalSensorsTitle: 'Sensori',
                luxFinalTrendTitle: 'Andamento',
                luxFinalToday: 'Oggi',
                luxFinalActivityTitle: 'Attivita',
                luxFinalIrrigationItem: 'Irrigazione',
                luxFinalFertilizationItem: 'Fertilizzazione',
                luxFinalAlarmItem: 'Allarme',
                luxFinalSensorsItem: 'Sensori',
                luxFinalIrrigationTime: 'Oggi, 08:30',
                luxFinalFertilizationTime: 'Ieri, 11:15',
                luxFinalAlarmTime: 'Ieri, 14:00',
                luxFinalCompleted: 'Completata',
                luxFinalOperating: 'Tutti operativi',
                luxFinalNewActivity: 'Nuova attivita',
                luxFinalReportTitle: 'Report',
                luxFinalReportHealth: 'Salute delle colture',
                luxFinalReportExcellent: 'Ottima',
                luxFinalTrendPositive: 'Trend positivo',
                luxFinalTrendValue: '+12%',
                luxFinalComparedYesterday: 'rispetto a ieri',
                luxFinalResultsStep: '9',
                luxFinalResultsEyebrow: 'Risultati reali, ogni giorno',
                luxFinalResultsTitle: 'Risultati reali, ogni giorno.',
                luxFinalSatisfactionValue: '98%',
                luxFinalSatisfactionText: 'Soddisfazione clienti',
                luxFinalFooterSubtitle: 'SMART FARMING',
                luxFinalFooterText: 'La piattaforma tecnologica per un’agricoltura piu intelligente, produttiva e sostenibile.',
                luxFinalFooterProduct: 'Prodotto',
                luxFinalFooterSolutions: 'Soluzioni',
                luxFinalFooterResources: 'Risorse',
                luxFinalFooterCompany: 'Azienda',
                luxFinalFooterNewsletter: 'Newsletter',
                luxFinalFooterDashboard: 'Dashboard',
                luxFinalFooterSensors: 'Sensori IoT',
                luxFinalFooterIrrigation: 'Irrigazione',
                luxFinalFooterAnalytics: 'Analisi',
                luxFinalFooterAdvisor: 'AI Advisor',
                luxFinalFooterOpenFields: 'Colture in pieno campo',
                luxFinalFooterGreenhouses: 'Serre',
                luxFinalFooterOrchards: 'Frutteti',
                luxFinalFooterSmartIrrigation: 'Irrigazione smart',
                luxFinalFooterCooperatives: 'Cooperative',
                luxFinalFooterDocumentation: 'Documentazione',
                luxFinalFooterBlog: 'Blog',
                luxFinalFooterGuides: 'Guide',
                luxFinalFooterSupport: 'Supporto',
                luxFinalFooterApi: 'API',
                luxFinalFooterAbout: 'Chi siamo',
                luxFinalFooterCareer: 'Carriera',
                luxFinalFooterWork: 'Lavora con noi',
                luxFinalFooterDemo: 'Demo',
                luxFinalNewsletterText: 'Ricevi aggiornamenti, novita e consigli sull’agricoltura intelligente.',
                luxFinalEmailPlaceholder: 'La tua email',
                luxFinalNewsletterSubmit: 'Iscriviti alla newsletter',
                luxFinalCookiePolicy: 'Cookie Policy',
                luxFinalSocialLinkedin: 'LinkedIn',
                luxFinalSocialInstagram: 'Instagram',
                luxFinalSocialYoutube: 'YouTube'
            },
            en: {
                luxFinalMobileStep: '8',
                luxFinalMobileEyebrow: 'Your fields, always with you',
                luxFinalMobileTitle: 'Your field, always in your pocket.',
                luxFinalMobileText: 'Monitor, analyze and manage everything wherever you are. At any time.',
                luxFinalDownloadOn: 'Download on the',
                luxFinalAvailableOn: 'Available on',
                luxFinalAppStore: 'App Store',
                luxFinalGooglePlay: 'Google Play',
                luxFinalMapTitle: 'Field map',
                luxFinalFieldName: 'North Field',
                luxFinalCropName: 'Tomatoes',
                luxFinalSensorsTitle: 'Sensors',
                luxFinalTrendTitle: 'Trend',
                luxFinalToday: 'Today',
                luxFinalActivityTitle: 'Activity',
                luxFinalIrrigationItem: 'Irrigation',
                luxFinalFertilizationItem: 'Fertilization',
                luxFinalAlarmItem: 'Alert',
                luxFinalSensorsItem: 'Sensors',
                luxFinalIrrigationTime: 'Today, 08:30',
                luxFinalFertilizationTime: 'Yesterday, 11:15',
                luxFinalAlarmTime: 'Yesterday, 14:00',
                luxFinalCompleted: 'Completed',
                luxFinalOperating: 'All operating',
                luxFinalNewActivity: 'New activity',
                luxFinalReportTitle: 'Report',
                luxFinalReportHealth: 'Crop health',
                luxFinalReportExcellent: 'Excellent',
                luxFinalTrendPositive: 'Positive trend',
                luxFinalTrendValue: '+12%',
                luxFinalComparedYesterday: 'compared to yesterday',
                luxFinalResultsStep: '9',
                luxFinalResultsEyebrow: 'Real results, every day',
                luxFinalResultsTitle: 'Real results, every day.',
                luxFinalSatisfactionValue: '98%',
                luxFinalSatisfactionText: 'Customer satisfaction',
                luxFinalFooterSubtitle: 'SMART FARMING',
                luxFinalFooterText: 'The technology platform for smarter, more productive and sustainable agriculture.',
                luxFinalFooterProduct: 'Product',
                luxFinalFooterSolutions: 'Solutions',
                luxFinalFooterResources: 'Resources',
                luxFinalFooterCompany: 'Company',
                luxFinalFooterNewsletter: 'Newsletter',
                luxFinalFooterDashboard: 'Dashboard',
                luxFinalFooterSensors: 'IoT Sensors',
                luxFinalFooterIrrigation: 'Irrigation',
                luxFinalFooterAnalytics: 'Analytics',
                luxFinalFooterAdvisor: 'AI Advisor',
                luxFinalFooterOpenFields: 'Open-field crops',
                luxFinalFooterGreenhouses: 'Greenhouses',
                luxFinalFooterOrchards: 'Orchards',
                luxFinalFooterSmartIrrigation: 'Smart irrigation',
                luxFinalFooterCooperatives: 'Cooperatives',
                luxFinalFooterDocumentation: 'Documentation',
                luxFinalFooterBlog: 'Blog',
                luxFinalFooterGuides: 'Guides',
                luxFinalFooterSupport: 'Support',
                luxFinalFooterApi: 'API',
                luxFinalFooterAbout: 'About us',
                luxFinalFooterCareer: 'Careers',
                luxFinalFooterWork: 'Work with us',
                luxFinalFooterDemo: 'Demo',
                luxFinalNewsletterText: 'Receive updates, news and advice on intelligent agriculture.',
                luxFinalEmailPlaceholder: 'Your email',
                luxFinalNewsletterSubmit: 'Subscribe to the newsletter',
                luxFinalCookiePolicy: 'Cookie Policy',
                luxFinalSocialLinkedin: 'LinkedIn',
                luxFinalSocialInstagram: 'Instagram',
                luxFinalSocialYoutube: 'YouTube'
            },
            fr: {
                luxFinalMobileStep: '8',
                luxFinalMobileEyebrow: 'Vos champs, toujours avec vous',
                luxFinalMobileTitle: 'Votre champ, toujours en poche.',
                luxFinalMobileText: 'Surveillez, analysez et gerez tout, ou que vous soyez. A tout moment.',
                luxFinalDownloadOn: 'Telecharger sur',
                luxFinalAvailableOn: 'Disponible sur',
                luxFinalAppStore: 'App Store',
                luxFinalGooglePlay: 'Google Play',
                luxFinalMapTitle: 'Carte des champs',
                luxFinalFieldName: 'Champ Nord',
                luxFinalCropName: 'Tomates',
                luxFinalSensorsTitle: 'Capteurs',
                luxFinalTrendTitle: 'Evolution',
                luxFinalToday: 'Aujourd’hui',
                luxFinalActivityTitle: 'Activite',
                luxFinalIrrigationItem: 'Irrigation',
                luxFinalFertilizationItem: 'Fertilisation',
                luxFinalAlarmItem: 'Alerte',
                luxFinalSensorsItem: 'Capteurs',
                luxFinalIrrigationTime: 'Aujourd’hui, 08:30',
                luxFinalFertilizationTime: 'Hier, 11:15',
                luxFinalAlarmTime: 'Hier, 14:00',
                luxFinalCompleted: 'Terminee',
                luxFinalOperating: 'Tous operationnels',
                luxFinalNewActivity: 'Nouvelle activite',
                luxFinalReportTitle: 'Rapport',
                luxFinalReportHealth: 'Sante des cultures',
                luxFinalReportExcellent: 'Excellente',
                luxFinalTrendPositive: 'Tendance positive',
                luxFinalTrendValue: '+12%',
                luxFinalComparedYesterday: 'par rapport a hier',
                luxFinalResultsStep: '9',
                luxFinalResultsEyebrow: 'Des resultats reels, chaque jour',
                luxFinalResultsTitle: 'Des resultats reels, chaque jour.',
                luxFinalSatisfactionValue: '98%',
                luxFinalSatisfactionText: 'Satisfaction clients',
                luxFinalFooterSubtitle: 'SMART FARMING',
                luxFinalFooterText: 'La plateforme technologique pour une agriculture plus intelligente, productive et durable.',
                luxFinalFooterProduct: 'Produit',
                luxFinalFooterSolutions: 'Solutions',
                luxFinalFooterResources: 'Ressources',
                luxFinalFooterCompany: 'Entreprise',
                luxFinalFooterNewsletter: 'Newsletter',
                luxFinalFooterDashboard: 'Tableau de bord',
                luxFinalFooterSensors: 'Capteurs IoT',
                luxFinalFooterIrrigation: 'Irrigation',
                luxFinalFooterAnalytics: 'Analyses',
                luxFinalFooterAdvisor: 'Conseiller IA',
                luxFinalFooterOpenFields: 'Cultures de plein champ',
                luxFinalFooterGreenhouses: 'Serres',
                luxFinalFooterOrchards: 'Vergers',
                luxFinalFooterSmartIrrigation: 'Irrigation intelligente',
                luxFinalFooterCooperatives: 'Cooperatives',
                luxFinalFooterDocumentation: 'Documentation',
                luxFinalFooterBlog: 'Blog',
                luxFinalFooterGuides: 'Guides',
                luxFinalFooterSupport: 'Support',
                luxFinalFooterApi: 'API',
                luxFinalFooterAbout: 'Qui sommes-nous',
                luxFinalFooterCareer: 'Carriere',
                luxFinalFooterWork: 'Nous rejoindre',
                luxFinalFooterDemo: 'Demo',
                luxFinalNewsletterText: 'Recevez les nouveautes et conseils sur l’agriculture intelligente.',
                luxFinalEmailPlaceholder: 'Votre email',
                luxFinalNewsletterSubmit: 'S’inscrire a la newsletter',
                luxFinalCookiePolicy: 'Politique de cookies',
                luxFinalSocialLinkedin: 'LinkedIn',
                luxFinalSocialInstagram: 'Instagram',
                luxFinalSocialYoutube: 'YouTube'
            },
            ar: {
                luxFinalMobileStep: '8',
                luxFinalMobileEyebrow: 'حقولك معك دائما',
                luxFinalMobileTitle: 'حقلك دائما في جيبك.',
                luxFinalMobileText: 'راقب وحلل وادِر كل شيء من اي مكان وفي كل وقت.',
                luxFinalDownloadOn: 'تنزيل من',
                luxFinalAvailableOn: 'متاح على',
                luxFinalAppStore: 'App Store',
                luxFinalGooglePlay: 'Google Play',
                luxFinalMapTitle: 'خريطة الحقول',
                luxFinalFieldName: 'الحقل الشمالي',
                luxFinalCropName: 'طماطم',
                luxFinalSensorsTitle: 'الحساسات',
                luxFinalTrendTitle: 'الاتجاه',
                luxFinalToday: 'اليوم',
                luxFinalActivityTitle: 'النشاط',
                luxFinalIrrigationItem: 'الري',
                luxFinalFertilizationItem: 'التسميد',
                luxFinalAlarmItem: 'تنبيه',
                luxFinalSensorsItem: 'الحساسات',
                luxFinalIrrigationTime: 'اليوم، 08:30',
                luxFinalFertilizationTime: 'امس، 11:15',
                luxFinalAlarmTime: 'امس، 14:00',
                luxFinalCompleted: 'مكتمل',
                luxFinalOperating: 'كلها تعمل',
                luxFinalNewActivity: 'نشاط جديد',
                luxFinalReportTitle: 'تقرير',
                luxFinalReportHealth: 'صحة المحاصيل',
                luxFinalReportExcellent: 'ممتازة',
                luxFinalTrendPositive: 'اتجاه ايجابي',
                luxFinalTrendValue: '+12%',
                luxFinalComparedYesterday: 'مقارنة بالامس',
                luxFinalResultsStep: '9',
                luxFinalResultsEyebrow: 'نتائج حقيقية كل يوم',
                luxFinalResultsTitle: 'نتائج حقيقية كل يوم.',
                luxFinalSatisfactionValue: '98%',
                luxFinalSatisfactionText: 'رضا العملاء',
                luxFinalFooterSubtitle: 'SMART FARMING',
                luxFinalFooterText: 'المنصة التقنية لزراعة اذكى واكثر انتاجية واستدامة.',
                luxFinalFooterProduct: 'المنتج',
                luxFinalFooterSolutions: 'الحلول',
                luxFinalFooterResources: 'الموارد',
                luxFinalFooterCompany: 'الشركة',
                luxFinalFooterNewsletter: 'النشرة البريدية',
                luxFinalFooterDashboard: 'لوحة التحكم',
                luxFinalFooterSensors: 'حساسات IoT',
                luxFinalFooterIrrigation: 'الري',
                luxFinalFooterAnalytics: 'التحليلات',
                luxFinalFooterAdvisor: 'مستشار IA',
                luxFinalFooterOpenFields: 'محاصيل الحقول',
                luxFinalFooterGreenhouses: 'البيوت المحمية',
                luxFinalFooterOrchards: 'البساتين',
                luxFinalFooterSmartIrrigation: 'الري الذكي',
                luxFinalFooterCooperatives: 'التعاونيات',
                luxFinalFooterDocumentation: 'التوثيق',
                luxFinalFooterBlog: 'المدونة',
                luxFinalFooterGuides: 'الادلة',
                luxFinalFooterSupport: 'الدعم',
                luxFinalFooterApi: 'API',
                luxFinalFooterAbout: 'من نحن',
                luxFinalFooterCareer: 'الوظائف',
                luxFinalFooterWork: 'اعمل معنا',
                luxFinalFooterDemo: 'عرض تجريبي',
                luxFinalNewsletterText: 'احصل على الاخبار والنصائح حول الزراعة الذكية.',
                luxFinalEmailPlaceholder: 'بريدك الالكتروني',
                luxFinalNewsletterSubmit: 'اشترك في النشرة',
                luxFinalCookiePolicy: 'سياسة ملفات تعريف الارتباط',
                luxFinalSocialLinkedin: 'LinkedIn',
                luxFinalSocialInstagram: 'Instagram',
                luxFinalSocialYoutube: 'YouTube'
            },
            tz: {
                luxFinalMobileStep: '8',
                luxFinalMobileEyebrow: 'ⵉⴳⵔⴰⵏ ⵏⵏⴽ ⵍⵍⴰⵏ ⴷⵉⴷⴽ',
                luxFinalMobileTitle: 'ⴰⴳⵔ ⵏⵏⴽ ⵖⵓⵔⴽ ⴽⵓ ⵜⵉⴽⴽⵍⵜ.',
                luxFinalMobileText: 'ⵙⵙⵜⵉ, ⵙⵍⴹ ⴷ ⵙⵡⵓⴷⴷⵓ ⴽⵓ ⵎⴰⴷ ⵉⵍⵍⴰ.',
                luxFinalDownloadOn: 'ⴰⴳⵎ ⵙⴳ',
                luxFinalAvailableOn: 'ⵉⵍⵍⴰ ⴳ',
                luxFinalAppStore: 'App Store',
                luxFinalGooglePlay: 'Google Play',
                luxFinalMapTitle: 'ⵜⴰⴽⴰⵕⴹⴰ ⵏ ⵉⴳⵔⴰⵏ',
                luxFinalFieldName: 'ⴰⴳⵔ ⵏ ⵓⴳⴰⴼⴰ',
                luxFinalCropName: 'ⵜⵉⵎⴰⵜⵉⵛⵉⵏ',
                luxFinalSensorsTitle: 'ⵉⵎⵙⵙⵜⴰⵏⵏ',
                luxFinalTrendTitle: 'ⴰⵙⴰⴷⴷⵓ',
                luxFinalToday: 'ⴰⵙⵙⴰ',
                luxFinalActivityTitle: 'ⴰⵎⵓⵙⵙⵓ',
                luxFinalIrrigationItem: 'ⴰⵙⵙⴰⵢ',
                luxFinalFertilizationItem: 'ⴰⵙⴼⵔⴰⵔ',
                luxFinalAlarmItem: 'ⴰⵍⵖⵓ',
                luxFinalSensorsItem: 'ⵉⵎⵙⵙⵜⴰⵏⵏ',
                luxFinalIrrigationTime: 'ⴰⵙⵙⴰ, 08:30',
                luxFinalFertilizationTime: 'ⵉⴹⴳⴰⵎ, 11:15',
                luxFinalAlarmTime: 'ⵉⴹⴳⴰⵎ, 14:00',
                luxFinalCompleted: 'ⵉⴽⵎⵍ',
                luxFinalOperating: 'ⴽⵓ ⵙⵡⵓⵔⵉⵏ',
                luxFinalNewActivity: 'ⴰⵎⵓⵙⵙⵓ ⴰⵎⴰⵢⵏⵓ',
                luxFinalReportTitle: 'ⴰⵏⵇⵇⵉⵙ',
                luxFinalReportHealth: 'ⵜⴰⵣⵎⵔⵜ ⵏ ⵉⵎⵉⵔⴰⵏ',
                luxFinalReportExcellent: 'ⵜⵖⵓⴷⴰ',
                luxFinalTrendPositive: 'ⴰⵙⴰⴷⴷⵓ ⵉⵖⵓⴷⴰ',
                luxFinalTrendValue: '+12%',
                luxFinalComparedYesterday: 'ⵖⴼ ⵉⴹⴳⴰⵎ',
                luxFinalResultsStep: '9',
                luxFinalResultsEyebrow: 'ⵜⵉⴼⵔⴰⵙ ⵏ ⵜⵉⴷⵜ ⴽⵓ ⴰⵙⵙ',
                luxFinalResultsTitle: 'ⵜⵉⴼⵔⴰⵙ ⵏ ⵜⵉⴷⵜ, ⴽⵓ ⴰⵙⵙ.',
                luxFinalSatisfactionValue: '98%',
                luxFinalSatisfactionText: 'ⴰⵔⴹⴰ ⵏ ⵉⵎⵙⵙⵓⵜⵔⵏ',
                luxFinalFooterSubtitle: 'SMART FARMING',
                luxFinalFooterText: 'ⵜⴰⵙⵏⵙⵉ ⵜⴰⵜⵉⴽⵏⵓⵍⵓⵊⵉⵜ ⵉ ⵜⴼⵍⴰⵃⵜ ⵜⴰⵎⵓⵙⵙⵏⵜ.',
                luxFinalFooterProduct: 'ⴰⴼⴰⵔⵉⵙ',
                luxFinalFooterSolutions: 'ⵜⵉⴼⵔⴰⵜ',
                luxFinalFooterResources: 'ⵜⵉⵖⴱⵓⵍⴰ',
                luxFinalFooterCompany: 'ⵜⴰⵎⵙⵙⵓⵔⵜ',
                luxFinalFooterNewsletter: 'Newsletter',
                luxFinalFooterDashboard: 'Dashboard',
                luxFinalFooterSensors: 'IoT',
                luxFinalFooterIrrigation: 'ⴰⵙⵙⴰⵢ',
                luxFinalFooterAnalytics: 'ⵜⴰⵙⵍⴹⵜ',
                luxFinalFooterAdvisor: 'AI Advisor',
                luxFinalFooterOpenFields: 'ⵉⴳⵔⴰⵏ',
                luxFinalFooterGreenhouses: 'ⵉⴼⵔⴰⴳⵏ',
                luxFinalFooterOrchards: 'ⵓⵔⵜⴰⵏ',
                luxFinalFooterSmartIrrigation: 'ⴰⵙⵙⴰⵢ ⴰⵎⵓⵙⵙⵏ',
                luxFinalFooterCooperatives: 'ⵜⵉⵡⵉⵙⵉ',
                luxFinalFooterDocumentation: 'Documentation',
                luxFinalFooterBlog: 'Blog',
                luxFinalFooterGuides: 'Guides',
                luxFinalFooterSupport: 'Support',
                luxFinalFooterApi: 'API',
                luxFinalFooterAbout: 'ⵖⴼⵏⵖ',
                luxFinalFooterCareer: 'ⵜⴰⵡⵓⵔⵉ',
                luxFinalFooterWork: 'ⵙⵡⵓⵔⵉ ⴷⵉⴷⵏⵖ',
                luxFinalFooterDemo: 'Demo',
                luxFinalNewsletterText: 'ⴰⵡⵉ ⵉⵎⴰⵢⵏⵓⵜⵏ ⴷ ⵜⵉⵡⵏⵏⴹⵉⵏ.',
                luxFinalEmailPlaceholder: 'Email',
                luxFinalNewsletterSubmit: 'Newsletter',
                luxFinalCookiePolicy: 'Cookie Policy',
                luxFinalSocialLinkedin: 'LinkedIn',
                luxFinalSocialInstagram: 'Instagram',
                luxFinalSocialYoutube: 'YouTube'
            }
        };
        RAYAT_HOMEPAGE_FINAL_2026_TRANSLATIONS.zgh = { ...RAYAT_HOMEPAGE_FINAL_2026_TRANSLATIONS.tz };

        Object.entries(RAYAT_HOMEPAGE_FINAL_2026_TRANSLATIONS).forEach(([lang, values]) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...values
            };
        });

        const RAYAT_DASHBOARD_INTERNAL_TABS_2026_TRANSLATIONS = {
            it: {
                luxDashboardOverviewSubtitle: 'Prestazioni e raccomandazioni della parcella',
                luxDashboardParcelsTitle: 'Parcelle',
                luxDashboardParcelsSubtitle: 'Colture monitorate e sensori collegati',
                luxDashboardParcelOne: 'Parcella 01',
                luxDashboardParcelNorth: 'Parcella Nord',
                luxDashboardParcelGreenhouse: 'Serra controllo',
                luxDashboardCropType: 'Coltura',
                luxDashboardParcelStatus: 'Stato',
                luxDashboardLinkedSensors: 'Sensori collegati',
                luxDashboardLastUpdate: 'Ultimo aggiornamento',
                luxDashboardOperational: 'Operativa',
                luxDashboardSensorsTitle: 'Sensori suolo 7 in 1',
                luxDashboardSensorsSubtitle: 'Ultime letture disponibili per la coltura selezionata',
                luxDashboardLatestValue: 'Valore recente',
                luxDashboardOnline: 'Online',
                luxDashboardOffline: 'Offline',
                luxDashboardIrrigationTitle: 'Irrigazione',
                luxDashboardIrrigationSubtitle: 'Raccomandazione basata su umidita e coltura',
                luxDashboardRecommendation: 'Raccomandazione',
                luxDashboardNextIrrigation: 'Prossima irrigazione',
                luxDashboardDuration: 'Durata',
                luxDashboardWaterSaving: 'Risparmio idrico',
                luxDashboardHistory: 'Storico irrigazione',
                luxDashboardPlaceholder: 'Dati disponibili con il prossimo ciclo',
                luxDashboardAlertsTitle: 'Avvisi attivi',
                luxDashboardAlertsSubtitle: 'Eventi che richiedono attenzione',
                luxDashboardNoAlerts: 'Nessun avviso attivo',
                luxDashboardNoAlertsText: 'Le misure correnti rientrano nelle soglie previste.',
                luxDashboardSeverity: 'Severita',
                luxDashboardRecommendedAction: 'Azione consigliata',
                luxDashboardAnalyticsTitle: 'Analisi',
                luxDashboardAnalyticsSubtitle: 'Andamento degli indicatori agronomici',
                luxDashboardTrendMoisture: 'Umidità suolo',
                luxDashboardTrendTemperature: 'Temperatura',
                luxDashboardTrendEc: 'Conducibilita',
                luxDashboardAnalyticsLatest: 'Ultimo valore',
                luxDashboardAnalyticsAverage: 'Media',
                luxDashboardAnalyticsMinimum: 'Minimo',
                luxDashboardAnalyticsMaximum: 'Massimo',
                luxDashboardAnalyticsChange: 'Variazione',
                luxDashboardAnalyticsOptimalBand: 'Range ottimale',
                luxDashboardAnalyticsReadings: 'letture',
                luxDashboardAnalyticsWaiting: 'In attesa di ulteriori letture',
                luxDashboardAnalyticsSoilTemperature: 'Temperatura terreno',
                luxDashboardAnalyticsElectricalConductivity: 'Conducibilità elettrica',
                luxDashboardAnalyticsPh: 'pH',
                luxDashboardAnalyticsNitrogen: 'Azoto',
                luxDashboardAnalyticsPhosphorus: 'Fosforo',
                luxDashboardAnalyticsPotassium: 'Potassio',
                luxDashboardAnalyticsAirTemperature: 'Temperatura ambiente',
                luxDashboardAnalyticsAirHumidity: 'Umidità relativa',
                luxDashboardAnalyticsCo2: 'CO2',
                luxDashboardAnalyticsWindSpeed: 'Velocità vento',
                luxDashboardAnalyticsSoilSensor: 'Suolo 7 in 1',
                luxDashboardAnalyticsClimateSensor: 'Clima',
                luxDashboardAnalyticsPrevious: 'Parametri precedenti',
                luxDashboardAnalyticsNext: 'Altri parametri',
                luxDashboardReportsTitle: 'Rapporti',
                luxDashboardReportsSubtitle: 'Esporta e consulta le analisi recenti',
                luxDashboardCsvExport: 'Esporta CSV',
                luxDashboardPdfReport: 'Rapporto PDF',
                luxDashboardPdfPlaceholder: 'Disponibile prossimamente',
                luxDashboardRecentReports: 'Rapporti recenti',
                luxDashboardReportWeekly: 'Riepilogo suolo settimanale',
                luxDashboardReportIrrigation: 'Efficienza irrigazione',
                luxDashboardSettingsTitle: 'Parametri',
                luxDashboardSettingsSubtitle: 'Preferenze operative della parcella',
                luxDashboardCropSelection: 'Coltura selezionata',
                luxDashboardThresholds: 'Soglie ottimali',
                luxDashboardLanguage: 'Lingua',
                luxDashboardNotifications: 'Notifiche',
                luxDashboardNotificationsEnabled: 'Avvisi attivati',
                luxDashboardNotificationsDisabled: 'Avvisi disattivati',
                luxDashboardPeriod24h: '24 ore',
                luxDashboardPeriod7d: '7 giorni',
                luxDashboardPeriod30d: '30 giorni',
                luxDashboardActionAdjust: 'Verificare irrigazione e soglie',
                luxDashboardSensorsConnected: '7 attivi',
                luxDashboardNow: 'Ora',
                luxDashboardScheduled: 'Tra 2h',
                luxDashboardMinutes: '45 min'
            },
            en: {
                luxDashboardOverviewSubtitle: 'Parcel performance and recommendations',
                luxDashboardParcelsTitle: 'Parcels',
                luxDashboardParcelsSubtitle: 'Monitored crops and linked sensors',
                luxDashboardParcelOne: 'Parcel 01',
                luxDashboardParcelNorth: 'North Parcel',
                luxDashboardParcelGreenhouse: 'Control greenhouse',
                luxDashboardCropType: 'Crop',
                luxDashboardParcelStatus: 'Status',
                luxDashboardLinkedSensors: 'Linked sensors',
                luxDashboardLastUpdate: 'Last update',
                luxDashboardOperational: 'Operational',
                luxDashboardSensorsTitle: 'Soil sensors 7 in 1',
                luxDashboardSensorsSubtitle: 'Latest readings for the selected crop',
                luxDashboardLatestValue: 'Latest value',
                luxDashboardOnline: 'Online',
                luxDashboardOffline: 'Offline',
                luxDashboardIrrigationTitle: 'Irrigation',
                luxDashboardIrrigationSubtitle: 'Recommendation based on humidity and crop',
                luxDashboardRecommendation: 'Recommendation',
                luxDashboardNextIrrigation: 'Next irrigation',
                luxDashboardDuration: 'Duration',
                luxDashboardWaterSaving: 'Water saving',
                luxDashboardHistory: 'Irrigation history',
                luxDashboardPlaceholder: 'Data available with the next cycle',
                luxDashboardAlertsTitle: 'Active alerts',
                luxDashboardAlertsSubtitle: 'Events requiring attention',
                luxDashboardNoAlerts: 'No active alerts',
                luxDashboardNoAlertsText: 'Current readings are within expected thresholds.',
                luxDashboardSeverity: 'Severity',
                luxDashboardRecommendedAction: 'Recommended action',
                luxDashboardAnalyticsTitle: 'Analytics',
                luxDashboardAnalyticsSubtitle: 'Agronomic indicator trends',
                luxDashboardTrendMoisture: 'Soil humidity',
                luxDashboardTrendTemperature: 'Temperature',
                luxDashboardTrendEc: 'Conductivity',
                luxDashboardAnalyticsLatest: 'Latest value',
                luxDashboardAnalyticsAverage: 'Average',
                luxDashboardAnalyticsMinimum: 'Minimum',
                luxDashboardAnalyticsMaximum: 'Maximum',
                luxDashboardAnalyticsChange: 'Change',
                luxDashboardAnalyticsOptimalBand: 'Optimal range',
                luxDashboardAnalyticsReadings: 'readings',
                luxDashboardAnalyticsWaiting: 'Waiting for additional readings',
                luxDashboardAnalyticsSoilTemperature: 'Soil temperature',
                luxDashboardAnalyticsElectricalConductivity: 'Electrical conductivity',
                luxDashboardAnalyticsPh: 'pH',
                luxDashboardAnalyticsNitrogen: 'Nitrogen',
                luxDashboardAnalyticsPhosphorus: 'Phosphorus',
                luxDashboardAnalyticsPotassium: 'Potassium',
                luxDashboardAnalyticsAirTemperature: 'Air temperature',
                luxDashboardAnalyticsAirHumidity: 'Relative humidity',
                luxDashboardAnalyticsCo2: 'CO2',
                luxDashboardAnalyticsWindSpeed: 'Wind speed',
                luxDashboardAnalyticsSoilSensor: 'Soil 7 in 1',
                luxDashboardAnalyticsClimateSensor: 'Climate',
                luxDashboardAnalyticsPrevious: 'Previous parameters',
                luxDashboardAnalyticsNext: 'More parameters',
                luxDashboardReportsTitle: 'Reports',
                luxDashboardReportsSubtitle: 'Export and review recent analyses',
                luxDashboardCsvExport: 'Export CSV',
                luxDashboardPdfReport: 'PDF report',
                luxDashboardPdfPlaceholder: 'Available soon',
                luxDashboardRecentReports: 'Recent reports',
                luxDashboardReportWeekly: 'Weekly soil summary',
                luxDashboardReportIrrigation: 'Irrigation efficiency',
                luxDashboardSettingsTitle: 'Settings',
                luxDashboardSettingsSubtitle: 'Parcel operating preferences',
                luxDashboardCropSelection: 'Selected crop',
                luxDashboardThresholds: 'Optimal thresholds',
                luxDashboardLanguage: 'Language',
                luxDashboardNotifications: 'Notifications',
                luxDashboardNotificationsEnabled: 'Alerts enabled',
                luxDashboardNotificationsDisabled: 'Alerts disabled',
                luxDashboardPeriod24h: '24 hours',
                luxDashboardPeriod7d: '7 days',
                luxDashboardPeriod30d: '30 days',
                luxDashboardActionAdjust: 'Review irrigation and thresholds',
                luxDashboardSensorsConnected: '7 active',
                luxDashboardNow: 'Now',
                luxDashboardScheduled: 'In 2h',
                luxDashboardMinutes: '45 min'
            },
            fr: {
                luxDashboardOverviewSubtitle: 'Performance et recommandations de la parcelle',
                luxDashboardParcelsTitle: 'Parcelles',
                luxDashboardParcelsSubtitle: 'Cultures surveillées et capteurs liés',
                luxDashboardParcelOne: 'Parcelle 01',
                luxDashboardParcelNorth: 'Parcelle Nord',
                luxDashboardParcelGreenhouse: 'Serre contrôle',
                luxDashboardCropType: 'Culture',
                luxDashboardParcelStatus: 'Statut',
                luxDashboardLinkedSensors: 'Capteurs liés',
                luxDashboardLastUpdate: 'Dernière mise à jour',
                luxDashboardOperational: 'Opérationnelle',
                luxDashboardSensorsTitle: 'Capteurs sol 7 en 1',
                luxDashboardSensorsSubtitle: 'Dernières mesures pour la culture sélectionnée',
                luxDashboardLatestValue: 'Valeur récente',
                luxDashboardOnline: 'En ligne',
                luxDashboardOffline: 'Hors ligne',
                luxDashboardIrrigationTitle: 'Irrigation',
                luxDashboardIrrigationSubtitle: 'Recommandation basée sur l’humidité et la culture',
                luxDashboardRecommendation: 'Recommandation',
                luxDashboardNextIrrigation: 'Prochaine irrigation',
                luxDashboardDuration: 'Durée',
                luxDashboardWaterSaving: 'Économie d’eau',
                luxDashboardHistory: 'Historique irrigation',
                luxDashboardPlaceholder: 'Données disponibles au prochain cycle',
                luxDashboardAlertsTitle: 'Alertes actives',
                luxDashboardAlertsSubtitle: 'Événements nécessitant une attention',
                luxDashboardNoAlerts: 'Aucune alerte active',
                luxDashboardNoAlertsText: 'Les mesures actuelles respectent les seuils prévus.',
                luxDashboardSeverity: 'Sévérité',
                luxDashboardRecommendedAction: 'Action recommandée',
                luxDashboardAnalyticsTitle: 'Analyses',
                luxDashboardAnalyticsSubtitle: 'Tendances des indicateurs agronomiques',
                luxDashboardTrendMoisture: 'Humidité du sol',
                luxDashboardTrendTemperature: 'Température',
                luxDashboardTrendEc: 'Conductivité',
                luxDashboardAnalyticsLatest: 'Dernière valeur',
                luxDashboardAnalyticsAverage: 'Moyenne',
                luxDashboardAnalyticsMinimum: 'Minimum',
                luxDashboardAnalyticsMaximum: 'Maximum',
                luxDashboardAnalyticsChange: 'Variation',
                luxDashboardAnalyticsOptimalBand: 'Plage optimale',
                luxDashboardAnalyticsReadings: 'mesures',
                luxDashboardAnalyticsWaiting: 'En attente de mesures supplémentaires',
                luxDashboardAnalyticsSoilTemperature: 'Température du sol',
                luxDashboardAnalyticsElectricalConductivity: 'Conductivité électrique',
                luxDashboardAnalyticsPh: 'pH',
                luxDashboardAnalyticsNitrogen: 'Azote',
                luxDashboardAnalyticsPhosphorus: 'Phosphore',
                luxDashboardAnalyticsPotassium: 'Potassium',
                luxDashboardAnalyticsAirTemperature: 'Température ambiante',
                luxDashboardAnalyticsAirHumidity: 'Humidité relative',
                luxDashboardAnalyticsCo2: 'CO2',
                luxDashboardAnalyticsWindSpeed: 'Vitesse du vent',
                luxDashboardAnalyticsSoilSensor: 'Sol 7 en 1',
                luxDashboardAnalyticsClimateSensor: 'Climat',
                luxDashboardAnalyticsPrevious: 'Paramètres précédents',
                luxDashboardAnalyticsNext: 'Autres paramètres',
                luxDashboardReportsTitle: 'Rapports',
                luxDashboardReportsSubtitle: 'Exporter et consulter les analyses récentes',
                luxDashboardCsvExport: 'Exporter CSV',
                luxDashboardPdfReport: 'Rapport PDF',
                luxDashboardPdfPlaceholder: 'Bientôt disponible',
                luxDashboardRecentReports: 'Rapports récents',
                luxDashboardReportWeekly: 'Synthèse sol hebdomadaire',
                luxDashboardReportIrrigation: 'Efficacité irrigation',
                luxDashboardSettingsTitle: 'Paramètres',
                luxDashboardSettingsSubtitle: 'Préférences opérationnelles de la parcelle',
                luxDashboardCropSelection: 'Culture sélectionnée',
                luxDashboardThresholds: 'Seuils optimaux',
                luxDashboardLanguage: 'Langue',
                luxDashboardNotifications: 'Notifications',
                luxDashboardNotificationsEnabled: 'Alertes activées',
                luxDashboardNotificationsDisabled: 'Alertes désactivées',
                luxDashboardPeriod24h: '24 heures',
                luxDashboardPeriod7d: '7 jours',
                luxDashboardPeriod30d: '30 jours',
                luxDashboardActionAdjust: 'Vérifier irrigation et seuils',
                luxDashboardSensorsConnected: '7 actifs',
                luxDashboardNow: 'Maintenant',
                luxDashboardScheduled: 'Dans 2h',
                luxDashboardMinutes: '45 min'
            },
            ar: {
                luxDashboardOverviewSubtitle: 'أداء القطعة والتوصيات',
                luxDashboardParcelsTitle: 'القطع',
                luxDashboardParcelsSubtitle: 'المحاصيل المراقبة والحساسات المرتبطة',
                luxDashboardParcelOne: 'القطعة 01',
                luxDashboardParcelNorth: 'القطعة الشمالية',
                luxDashboardParcelGreenhouse: 'البيت المحمي',
                luxDashboardCropType: 'المحصول',
                luxDashboardParcelStatus: 'الحالة',
                luxDashboardLinkedSensors: 'الحساسات المرتبطة',
                luxDashboardLastUpdate: 'آخر تحديث',
                luxDashboardOperational: 'تعمل',
                luxDashboardSensorsTitle: 'حساسات التربة 7 في 1',
                luxDashboardSensorsSubtitle: 'آخر القراءات للمحصول المختار',
                luxDashboardLatestValue: 'آخر قيمة',
                luxDashboardOnline: 'متصل',
                luxDashboardOffline: 'غير متصل',
                luxDashboardIrrigationTitle: 'السقي',
                luxDashboardIrrigationSubtitle: 'توصية حسب الرطوبة والمحصول',
                luxDashboardRecommendation: 'التوصية',
                luxDashboardNextIrrigation: 'السقي القادم',
                luxDashboardDuration: 'المدة',
                luxDashboardWaterSaving: 'توفير الماء',
                luxDashboardHistory: 'سجل السقي',
                luxDashboardPlaceholder: 'تتوفر البيانات في الدورة القادمة',
                luxDashboardAlertsTitle: 'التنبيهات النشطة',
                luxDashboardAlertsSubtitle: 'أحداث تتطلب الانتباه',
                luxDashboardNoAlerts: 'لا توجد تنبيهات نشطة',
                luxDashboardNoAlertsText: 'القراءات الحالية ضمن الحدود المتوقعة.',
                luxDashboardSeverity: 'الخطورة',
                luxDashboardRecommendedAction: 'الإجراء الموصى به',
                luxDashboardAnalyticsTitle: 'التحليلات',
                luxDashboardAnalyticsSubtitle: 'اتجاهات المؤشرات الزراعية',
                luxDashboardTrendMoisture: 'رطوبة التربة',
                luxDashboardTrendTemperature: 'الحرارة',
                luxDashboardTrendEc: 'التوصيل',
                luxDashboardAnalyticsLatest: 'آخر قيمة',
                luxDashboardAnalyticsAverage: 'المتوسط',
                luxDashboardAnalyticsMinimum: 'الأدنى',
                luxDashboardAnalyticsMaximum: 'الأعلى',
                luxDashboardAnalyticsChange: 'التغير',
                luxDashboardAnalyticsOptimalBand: 'النطاق المثالي',
                luxDashboardAnalyticsReadings: 'قراءات',
                luxDashboardAnalyticsWaiting: 'في انتظار قراءات إضافية',
                luxDashboardAnalyticsSoilTemperature: 'حرارة التربة',
                luxDashboardAnalyticsElectricalConductivity: 'التوصيل الكهربائي',
                luxDashboardAnalyticsPh: 'pH',
                luxDashboardAnalyticsNitrogen: 'الآزوت',
                luxDashboardAnalyticsPhosphorus: 'الفوسفور',
                luxDashboardAnalyticsPotassium: 'البوتاسيوم',
                luxDashboardAnalyticsAirTemperature: 'حرارة الجو',
                luxDashboardAnalyticsAirHumidity: 'الرطوبة النسبية',
                luxDashboardAnalyticsCo2: 'CO2',
                luxDashboardAnalyticsWindSpeed: 'سرعة الرياح',
                luxDashboardAnalyticsSoilSensor: 'تربة 7 في 1',
                luxDashboardAnalyticsClimateSensor: 'المناخ',
                luxDashboardAnalyticsPrevious: 'المؤشرات السابقة',
                luxDashboardAnalyticsNext: 'مؤشرات أخرى',
                luxDashboardReportsTitle: 'التقارير',
                luxDashboardReportsSubtitle: 'تصدير ومراجعة التحليلات الحديثة',
                luxDashboardCsvExport: 'تصدير CSV',
                luxDashboardPdfReport: 'تقرير PDF',
                luxDashboardPdfPlaceholder: 'متاح قريبا',
                luxDashboardRecentReports: 'التقارير الحديثة',
                luxDashboardReportWeekly: 'ملخص التربة الأسبوعي',
                luxDashboardReportIrrigation: 'كفاءة السقي',
                luxDashboardSettingsTitle: 'الإعدادات',
                luxDashboardSettingsSubtitle: 'تفضيلات تشغيل القطعة',
                luxDashboardCropSelection: 'المحصول المختار',
                luxDashboardThresholds: 'الحدود المثلى',
                luxDashboardLanguage: 'اللغة',
                luxDashboardNotifications: 'الإشعارات',
                luxDashboardNotificationsEnabled: 'التنبيهات مفعلة',
                luxDashboardNotificationsDisabled: 'التنبيهات معطلة',
                luxDashboardPeriod24h: '24 ساعة',
                luxDashboardPeriod7d: '7 أيام',
                luxDashboardPeriod30d: '30 يوما',
                luxDashboardActionAdjust: 'راجع السقي والحدود',
                luxDashboardSensorsConnected: '7 نشطة',
                luxDashboardNow: 'الآن',
                luxDashboardScheduled: 'بعد ساعتين',
                luxDashboardMinutes: '45 دقيقة'
            },
            tz: {
                luxDashboardOverviewSubtitle: 'ⵜⵉⵣⵎⵎⴰⵔ ⴷ ⵜⵉⵡⵏⵏⴹⵉⵏ ⵏ ⵓⴳⵔ',
                luxDashboardParcelsTitle: 'ⵉⴳⵔⴰⵏ',
                luxDashboardParcelsSubtitle: 'ⵜⵉⵎⴳⵔⵉⵡⵉⵏ ⴷ ⵉⵎⵙⵙⵜⴰⵏⵏ',
                luxDashboardParcelOne: 'ⴰⴳⵔ 01',
                luxDashboardParcelNorth: 'ⴰⴳⵔ ⵏ ⵓⴳⴰⴼⴰ',
                luxDashboardParcelGreenhouse: 'ⴰⴼⵔⴰⴳ',
                luxDashboardCropType: 'ⵜⴰⵎⴳⵔⵜ',
                luxDashboardParcelStatus: 'ⴰⴷⴷⴰⴷ',
                luxDashboardLinkedSensors: 'ⵉⵎⵙⵙⵜⴰⵏⵏ',
                luxDashboardLastUpdate: 'ⴰⵙⴳⴳⵯⴷ ⴰⵎⴳⴳⴰⵔⵓ',
                luxDashboardOperational: 'ⵜⵙⵡⵓⵔⵉ',
                luxDashboardSensorsTitle: 'ⵉⵎⵙⵙⵜⴰⵏⵏ 7 ⴳ 1',
                luxDashboardSensorsSubtitle: 'ⵜⵉⵖⵓⵔⵉⵡⵉⵏ ⵜⵉⵎⴳⴳⴰⵔⵓⵜⵉⵏ',
                luxDashboardLatestValue: 'ⵜⴰⵖⵓⵔⵉ ⵜⴰⵎⴳⴳⴰⵔⵓⵜ',
                luxDashboardOnline: 'Online',
                luxDashboardOffline: 'Offline',
                luxDashboardIrrigationTitle: 'ⴰⵙⵙⴰⵢ',
                luxDashboardIrrigationSubtitle: 'ⵜⴰⵡⵏⴳⵉⵎⵜ ⵏ ⵡⴰⵎⴰⵏ',
                luxDashboardRecommendation: 'ⵜⴰⵡⵏⴳⵉⵎⵜ',
                luxDashboardNextIrrigation: 'ⴰⵙⵙⴰⵢ ⵉⴷⴷⴰⵏ',
                luxDashboardDuration: 'ⴰⴽⵓⴷ',
                luxDashboardWaterSaving: 'ⴰⵙⵙⴷⵔⵓⵙ ⵏ ⵡⴰⵎⴰⵏ',
                luxDashboardHistory: 'ⴰⵎⵣⵔⵓⵢ ⵏ ⵓⵙⵙⴰⵢ',
                luxDashboardPlaceholder: 'ⵉⵙⴼⴽⴰ ⴳ ⵓⵎⵓⵜⵜⵓ ⵉⴷⴷⴰⵏ',
                luxDashboardAlertsTitle: 'ⴰⵍⵖⵓⵏ',
                luxDashboardAlertsSubtitle: 'ⵜⵉⴷⵢⴰⵏⵉⵏ ⵉⵃⵜⴰⵊⵊⴰⵏ',
                luxDashboardNoAlerts: 'ⵓⵔ ⵉⵍⵍⵉ ⵓⵍⵖⵓ',
                luxDashboardNoAlertsText: 'ⵜⵉⵖⵓⵔⵉⵡⵉⵏ ⵖⵓⴷⴰⵏⵜ.',
                luxDashboardSeverity: 'ⴰⵙⴷⵓⵙ',
                luxDashboardRecommendedAction: 'ⵜⵉⴳⴰⵡⵜ',
                luxDashboardAnalyticsTitle: 'ⵜⴰⵙⵍⴹⵜ',
                luxDashboardAnalyticsSubtitle: 'ⵜⵉⵎⵉⵜⴰⵔ ⵏ ⵉⵙⴼⴽⴰ',
                luxDashboardTrendMoisture: 'ⵜⴰⵎⵉⴷⵉ',
                luxDashboardTrendTemperature: 'ⵜⴰⴼⵓⴽⵍⴰ',
                luxDashboardTrendEc: 'EC',
                luxDashboardAnalyticsLatest: 'ⵜⴰⵖⵓⵔⵉ ⵜⴰⵎⴳⴳⴰⵔⵓⵜ',
                luxDashboardAnalyticsAverage: 'ⴰⵙⵎⵎⵓⵏ',
                luxDashboardAnalyticsMinimum: 'Min',
                luxDashboardAnalyticsMaximum: 'Max',
                luxDashboardAnalyticsChange: 'ⴰⵙⵏⴼⵍ',
                luxDashboardAnalyticsOptimalBand: 'ⴰⵣⵍⴰⵢ ⵉⵖⵓⴷⴰⵏ',
                luxDashboardAnalyticsReadings: 'ⵜⵉⵖⵓⵔⵉⵡⵉⵏ',
                luxDashboardAnalyticsWaiting: 'ⴰⵔ ⵏⵜⵜⵔⴰⵊⵓ ⵜⵉⵖⵓⵔⵉⵡⵉⵏ',
                luxDashboardAnalyticsSoilTemperature: 'ⵜⴰⴼⵓⴽⵍⴰ ⵏ ⵓⴽⴰⵍ',
                luxDashboardAnalyticsElectricalConductivity: 'EC',
                luxDashboardAnalyticsPh: 'pH',
                luxDashboardAnalyticsNitrogen: 'N',
                luxDashboardAnalyticsPhosphorus: 'P',
                luxDashboardAnalyticsPotassium: 'K',
                luxDashboardAnalyticsAirTemperature: 'ⵜⴰⴼⵓⴽⵍⴰ ⵏ ⵡⴰⴹⵓ',
                luxDashboardAnalyticsAirHumidity: 'ⵜⴰⵎⵉⴷⵉ ⵏ ⵡⴰⴹⵓ',
                luxDashboardAnalyticsCo2: 'CO2',
                luxDashboardAnalyticsWindSpeed: 'ⴰⴹⵓ',
                luxDashboardAnalyticsSoilSensor: 'ⴰⴽⴰⵍ 7 ⴳ 1',
                luxDashboardAnalyticsClimateSensor: 'ⴰⵙⵉⴳⵏⴰ',
                luxDashboardAnalyticsPrevious: 'ⵉⵎⵉⵜⴰⵔⵏ ⵉⵣⵔⵉⵏ',
                luxDashboardAnalyticsNext: 'ⵉⵎⵉⵜⴰⵔⵏ ⵢⴰⴹⵏ',
                luxDashboardReportsTitle: 'ⵜⵉⵇⵇⴰⴷⵉⵏ',
                luxDashboardReportsSubtitle: 'ⵙⵙⵓⴼⵖ ⵉⵙⴼⴽⴰ',
                luxDashboardCsvExport: 'CSV',
                luxDashboardPdfReport: 'PDF',
                luxDashboardPdfPlaceholder: 'ⴰⴷ ⵉⵍⵉ ⵇⵔⵉⴱⴰ',
                luxDashboardRecentReports: 'ⵜⵉⵇⵇⴰⴷⵉⵏ',
                luxDashboardReportWeekly: 'ⴰⵙⵎⵎⵓⵏ ⵏ ⵓⴽⴰⵍ',
                luxDashboardReportIrrigation: 'ⵜⵉⵣⵎⵎⴰⵔ ⵏ ⵓⵙⵙⴰⵢ',
                luxDashboardSettingsTitle: 'ⵜⵉⵙⵖⴰⵍ',
                luxDashboardSettingsSubtitle: 'ⵜⵉⴼⵔⴰⵏⵉⵏ ⵏ ⵓⴳⵔ',
                luxDashboardCropSelection: 'ⵜⴰⵎⴳⵔⵜ',
                luxDashboardThresholds: 'ⵉⵙⵡⵉⵔⵏ',
                luxDashboardLanguage: 'ⵜⵓⵜⵍⴰⵢⵜ',
                luxDashboardNotifications: 'ⴰⵍⵖⵓⵏ',
                luxDashboardNotificationsEnabled: 'ⵔⵎⴷⵏ',
                luxDashboardNotificationsDisabled: 'ⵏⵙⵏ',
                luxDashboardPeriod24h: '24h',
                luxDashboardPeriod7d: '7d',
                luxDashboardPeriod30d: '30d',
                luxDashboardActionAdjust: 'ⵙⴼⵙⵉ ⴰⵙⵙⴰⵢ',
                luxDashboardSensorsConnected: '7',
                luxDashboardNow: 'ⴷⵖⵉ',
                luxDashboardScheduled: 'ⴳ 2h',
                luxDashboardMinutes: '45 min'
            }
        };
        RAYAT_DASHBOARD_INTERNAL_TABS_2026_TRANSLATIONS.zgh = { ...RAYAT_DASHBOARD_INTERNAL_TABS_2026_TRANSLATIONS.tz };

        Object.entries(RAYAT_DASHBOARD_INTERNAL_TABS_2026_TRANSLATIONS).forEach(([lang, values]) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...values
            };
        });

        const RAYAT_LUXURY_DASHBOARD_TRANSLATIONS_2026 = {
            it: {
                luxuryDashGreeting: 'Buongiorno',
                luxuryDashGreetingSubtitle: 'Ecco la panoramica aggiornata della tua serra.',
                luxuryDashUserName: 'Marco',
                luxuryDashCompany: 'Azienda Agricola Verdi',
                luxuryDashFarmLocation: 'Serra di Banane - Taroudant, Marocco',
                luxuryDashMenuDashboard: 'Dashboard',
                luxuryDashMenuGreenhouses: 'Serre',
                luxuryDashMenuSensors: 'Sensori',
                luxuryDashMenuIrrigation: 'Irrigazione',
                luxuryDashMenuAlarms: 'Allarmi',
                luxuryDashMenuAnalysis: 'Analisi',
                luxuryDashMenuReports: 'Report',
                luxuryDashMenuHistory: 'Storico',
                luxuryDashMenuSettings: 'Impostazioni',
                luxuryDashSupport: 'Supporto',
                luxuryDashPlan: 'Piano attuale',
                luxuryDashProfessional: 'Professional',
                luxuryDashExpiry: 'Scade il 12/06/2026',
                luxuryDashHealthIndex: 'Indice di salute',
                luxuryDashSensorsOnline: 'Sensori online',
                luxuryDashActiveAlarms: 'Allarmi attivi',
                luxuryDashIrrigationsToday: 'Irrigazioni oggi',
                luxuryDashWaterSaving: 'Risparmio idrico',
                luxuryDashOperating: 'Operativi',
                luxuryDashProgrammed: 'Da pianificare',
                luxuryDashNoMeasuredValue: 'Dato non disponibile',
                luxuryDashDemoFallback: 'Dati dimostrativi',
                luxuryDashUpdated: 'Ultimo aggiornamento',
                luxuryDashMapTitle: 'Mappa della serra',
                luxuryDashSatellite: 'Vista satellitare',
                luxuryDashAllSensors: 'Tutti i sensori',
                luxuryDashCropHealth: 'Salute coltura',
                luxuryDashFieldInfo: 'Serra di Banane - Taroudant, Marocco',
                luxuryDashRecommendations: 'Raccomandazioni IA',
                luxuryDashIrrigationAdvice: 'Irrigazione consigliata',
                luxuryDashIrrigationStable: 'Umidita nel range: mantieni il programma corrente.',
                luxuryDashIrrigationReview: 'L umidita richiede una verifica del prossimo ciclo.',
                luxuryDashHydricRisk: 'Rischio stress idrico',
                luxuryDashHydricStable: 'Nessun rischio immediato rilevato dai valori disponibili.',
                luxuryDashHydricWarning: 'Controlla umidita e temperatura prima del prossimo turno.',
                luxuryDashNutritionAdvice: 'Nutrizione del suolo',
                luxuryDashNutritionStable: 'Azoto nel range ottimale della coltura.',
                luxuryDashNutritionReview: 'Valuta il piano di fertilizzazione in base all azoto.',
                luxuryDashPriorityLow: 'Priorita bassa',
                luxuryDashPriorityMedium: 'Priorita media',
                luxuryDashPriorityHigh: 'Priorita alta',
                luxuryDashSeeRecommendations: 'Vedi tutte le raccomandazioni',
                luxuryDashSensorStatus: 'Stato sensori',
                luxuryDashSensorDetails: 'Vedi dettagli sensori',
                luxuryDashTrendTitle: 'Andamento ultimi 7 giorni',
                luxuryDashTrendMetric: 'Umidita',
                luxuryDashEmptyTrend: 'I dati storici appariranno qui appena disponibili.',
                luxuryDashSoilConditions: 'Condizioni attuali del suolo',
                luxuryDashOrganicMatter: 'Sostanza organica',
                luxuryDashWeather: 'Meteo locale',
                luxuryDashWeatherLive: 'Dati ambientali dalla serra',
                luxuryDashRelativeHumidity: 'Umidita aria',
                luxuryDashWind: 'Vento',
                luxuryDashRecentActivities: 'Attivita recenti',
                luxuryDashActivityEmpty: 'Nessun allarme attivo nei dati correnti.',
                luxuryDashEvent: 'Evento',
                luxuryDashDetails: 'Dettagli',
                luxuryDashQuickReports: 'Report rapidi',
                luxuryDashQuickReportsSubtitle: 'Esporta i dati reali della serra.',
                luxuryDashTodayData: 'Dati odierni',
                luxuryDashWeeklyReport: 'Report settimanale',
                luxuryDashMonthlyAnalysis: 'Analisi mensile',
                luxuryDashDownloadCsv: 'Scarica CSV',
                luxuryDashNotAvailable: 'Non disponibile',
                luxuryDashHistoricalData: 'Dati storici sensore suolo',
                luxuryDashHistoricalEmpty: 'Nessun dato storico disponibile nel periodo selezionato.',
                luxuryDashLoadingHistory: 'Caricamento dati storici...',
                luxuryDashDateFrom: 'Dal',
                luxuryDashDateTo: 'Al',
                luxuryDashApply: 'Applica',
                luxuryDashUnavailableStatus: 'Non disponibile',
                luxuryDashDemoPageTitle: 'Demo Live - Serra Taroudant',
                luxuryDashDemoPageSubtitle: 'Dati reali provenienti dalla serra di banane a Taroudant, Marocco.',
                luxuryDashMapShort: 'Mappa',
                luxuryDashMenuAlarmSingular: 'Alert',
                luxuryDashMenuRecommendations: 'Raccomandazioni',
                luxuryDashLastUpdateShort: 'Ultimo aggiornamento',
                luxuryDashViewDetails: 'Vedi dettagli',
                luxuryDashViewAll: 'Vedi tutte',
                luxuryDashExcellent: 'Eccellente',
                luxuryDashToMonitor: 'Da monitorare',
                luxuryDashAllOnline: 'Tutti online',
                luxuryDashLastUpdateCard: 'Ultimo aggiornamento',
                luxuryDashRealtimeData: 'Dati in tempo reale',
                luxuryDashNoAlert: 'Nessun alert',
                luxuryDashCurrentConditions: 'Condizioni attuali',
                luxuryDashAirTemperature: 'Temperatura aria',
                luxuryDashSolarRadiation: 'Radiazione solare',
                luxuryDashSoilTemperature: 'Temperatura suolo',
                luxuryDashSoilPh: 'pH suolo',
                luxuryDashSoilEc: 'EC suolo',
                luxuryDashLast7Days: 'Ultimi 7 giorni',
                luxuryDashAllSensorsOnline: 'Tutti i sensori funzionanti',
                luxuryDashVerifiedTitle: 'Dati 100% reali e verificati',
                luxuryDashVerifiedText: 'Sistema di monitoraggio certificato e calibrato per colture di banane.',
                luxuryDashLearnRayat: 'Scopri come funziona Rayat',
                demoLive: 'Demo Live'
            },
            en: {
                luxuryDashGreeting: 'Good morning',
                luxuryDashGreetingSubtitle: 'Here is the latest overview of your greenhouse.',
                luxuryDashUserName: 'Marco',
                luxuryDashCompany: 'Verdi Agricultural Company',
                luxuryDashFarmLocation: 'Banana Greenhouse - Taroudant, Morocco',
                luxuryDashMenuDashboard: 'Dashboard', luxuryDashMenuGreenhouses: 'Greenhouses', luxuryDashMenuSensors: 'Sensors', luxuryDashMenuIrrigation: 'Irrigation', luxuryDashMenuAlarms: 'Alerts', luxuryDashMenuAnalysis: 'Analysis', luxuryDashMenuReports: 'Reports', luxuryDashMenuHistory: 'History', luxuryDashMenuSettings: 'Settings', luxuryDashSupport: 'Support',
                luxuryDashPlan: 'Current plan', luxuryDashProfessional: 'Professional', luxuryDashExpiry: 'Expires on 12/06/2026',
                luxuryDashHealthIndex: 'Health index', luxuryDashSensorsOnline: 'Sensors online', luxuryDashActiveAlarms: 'Active alerts', luxuryDashIrrigationsToday: 'Irrigations today', luxuryDashWaterSaving: 'Water savings', luxuryDashOperating: 'Operational', luxuryDashProgrammed: 'To schedule', luxuryDashNoMeasuredValue: 'Data unavailable', luxuryDashDemoFallback: 'Demonstration data', luxuryDashUpdated: 'Last updated',
                luxuryDashMapTitle: 'Greenhouse map', luxuryDashSatellite: 'Satellite view', luxuryDashAllSensors: 'All sensors', luxuryDashCropHealth: 'Crop health', luxuryDashFieldInfo: 'Banana Greenhouse - Taroudant, Morocco',
                luxuryDashRecommendations: 'AI recommendations', luxuryDashIrrigationAdvice: 'Recommended irrigation', luxuryDashIrrigationStable: 'Moisture is in range: maintain the current schedule.', luxuryDashIrrigationReview: 'Moisture requires a review of the next cycle.', luxuryDashHydricRisk: 'Water stress risk', luxuryDashHydricStable: 'No immediate risk detected from available readings.', luxuryDashHydricWarning: 'Check moisture and temperature before the next cycle.', luxuryDashNutritionAdvice: 'Soil nutrition', luxuryDashNutritionStable: 'Nitrogen is within the crop optimal range.', luxuryDashNutritionReview: 'Review the fertilization plan based on nitrogen.', luxuryDashPriorityLow: 'Low priority', luxuryDashPriorityMedium: 'Medium priority', luxuryDashPriorityHigh: 'High priority', luxuryDashSeeRecommendations: 'View all recommendations',
                luxuryDashSensorStatus: 'Sensor status', luxuryDashSensorDetails: 'View sensor details', luxuryDashTrendTitle: 'Trend over the last 7 days', luxuryDashTrendMetric: 'Moisture', luxuryDashEmptyTrend: 'Historical data will appear here when available.', luxuryDashSoilConditions: 'Current soil conditions', luxuryDashOrganicMatter: 'Organic matter', luxuryDashWeather: 'Local weather', luxuryDashWeatherLive: 'Environmental data from the greenhouse', luxuryDashRelativeHumidity: 'Air humidity', luxuryDashWind: 'Wind',
                luxuryDashRecentActivities: 'Recent activities', luxuryDashActivityEmpty: 'No active alert in current readings.', luxuryDashEvent: 'Event', luxuryDashDetails: 'Details', luxuryDashQuickReports: 'Quick reports', luxuryDashQuickReportsSubtitle: 'Export real greenhouse data.', luxuryDashTodayData: 'Today data', luxuryDashWeeklyReport: 'Weekly report', luxuryDashMonthlyAnalysis: 'Monthly analysis', luxuryDashDownloadCsv: 'Download CSV', luxuryDashNotAvailable: 'Unavailable', luxuryDashHistoricalData: 'Soil sensor historical data', luxuryDashHistoricalEmpty: 'No historical data for the selected period.', luxuryDashLoadingHistory: 'Loading historical data...', luxuryDashDateFrom: 'From', luxuryDashDateTo: 'To', luxuryDashApply: 'Apply', luxuryDashUnavailableStatus: 'Unavailable', luxuryDashDemoPageTitle: 'Demo Live - Taroudant Greenhouse', luxuryDashDemoPageSubtitle: 'Real data from the banana greenhouse in Taroudant, Morocco.', luxuryDashMapShort: 'Map', luxuryDashMenuAlarmSingular: 'Alert', luxuryDashMenuRecommendations: 'Recommendations', luxuryDashLastUpdateShort: 'Last update', luxuryDashViewDetails: 'View details', luxuryDashViewAll: 'View all', luxuryDashExcellent: 'Excellent', luxuryDashToMonitor: 'To monitor', luxuryDashAllOnline: 'All online', luxuryDashLastUpdateCard: 'Last update', luxuryDashRealtimeData: 'Real-time data', luxuryDashNoAlert: 'No alert', luxuryDashCurrentConditions: 'Current conditions', luxuryDashAirTemperature: 'Air temperature', luxuryDashSolarRadiation: 'Solar radiation', luxuryDashSoilTemperature: 'Soil temperature', luxuryDashSoilPh: 'Soil pH', luxuryDashSoilEc: 'Soil EC', luxuryDashLast7Days: 'Last 7 days', luxuryDashAllSensorsOnline: 'All sensors operational', luxuryDashVerifiedTitle: '100% real and verified data', luxuryDashVerifiedText: 'Certified monitoring system calibrated for banana crops.', luxuryDashLearnRayat: 'Discover how Rayat works', demoLive: 'Demo Live'
            },
            fr: {
                luxuryDashGreeting: 'Bonjour',
                luxuryDashGreetingSubtitle: 'Voici la vue actualisee de votre serre.',
                luxuryDashUserName: 'Marco',
                luxuryDashCompany: 'Entreprise Agricole Verdi',
                luxuryDashFarmLocation: 'Serre de bananes - Taroudant, Maroc',
                luxuryDashMenuDashboard: 'Tableau de bord', luxuryDashMenuGreenhouses: 'Serres', luxuryDashMenuSensors: 'Capteurs', luxuryDashMenuIrrigation: 'Irrigation', luxuryDashMenuAlarms: 'Alertes', luxuryDashMenuAnalysis: 'Analyses', luxuryDashMenuReports: 'Rapports', luxuryDashMenuHistory: 'Historique', luxuryDashMenuSettings: 'Parametres', luxuryDashSupport: 'Support',
                luxuryDashPlan: 'Plan actuel', luxuryDashProfessional: 'Professionnel', luxuryDashExpiry: 'Expire le 12/06/2026',
                luxuryDashHealthIndex: 'Indice de sante', luxuryDashSensorsOnline: 'Capteurs en ligne', luxuryDashActiveAlarms: 'Alertes actives', luxuryDashIrrigationsToday: 'Irrigations du jour', luxuryDashWaterSaving: 'Economie d eau', luxuryDashOperating: 'Operationnels', luxuryDashProgrammed: 'A planifier', luxuryDashNoMeasuredValue: 'Donnee indisponible', luxuryDashDemoFallback: 'Donnees de demonstration', luxuryDashUpdated: 'Derniere mise a jour',
                luxuryDashMapTitle: 'Carte de la serre', luxuryDashSatellite: 'Vue satellite', luxuryDashAllSensors: 'Tous les capteurs', luxuryDashCropHealth: 'Sante des cultures', luxuryDashFieldInfo: 'Serre de bananes - Taroudant, Maroc',
                luxuryDashRecommendations: 'Recommandations IA', luxuryDashIrrigationAdvice: 'Irrigation conseillee', luxuryDashIrrigationStable: 'Humidite dans la plage: conservez le programme actuel.', luxuryDashIrrigationReview: 'L humidite requiert une verification du prochain cycle.', luxuryDashHydricRisk: 'Risque de stress hydrique', luxuryDashHydricStable: 'Aucun risque immediat detecte dans les valeurs disponibles.', luxuryDashHydricWarning: 'Verifiez humidite et temperature avant le prochain tour.', luxuryDashNutritionAdvice: 'Nutrition du sol', luxuryDashNutritionStable: 'L azote est dans la plage optimale.', luxuryDashNutritionReview: 'Evaluez la fertilisation selon le niveau d azote.', luxuryDashPriorityLow: 'Priorite basse', luxuryDashPriorityMedium: 'Priorite moyenne', luxuryDashPriorityHigh: 'Priorite haute', luxuryDashSeeRecommendations: 'Voir toutes les recommandations',
                luxuryDashSensorStatus: 'Etat des capteurs', luxuryDashSensorDetails: 'Voir les details capteurs', luxuryDashTrendTitle: 'Evolution des 7 derniers jours', luxuryDashTrendMetric: 'Humidite', luxuryDashEmptyTrend: 'Les donnees historiques apparaitront ici des qu elles seront disponibles.', luxuryDashSoilConditions: 'Conditions actuelles du sol', luxuryDashOrganicMatter: 'Matiere organique', luxuryDashWeather: 'Meteo locale', luxuryDashWeatherLive: 'Donnees ambiantes de la serre', luxuryDashRelativeHumidity: 'Humidite air', luxuryDashWind: 'Vent',
                luxuryDashRecentActivities: 'Activites recentes', luxuryDashActivityEmpty: 'Aucune alerte active dans les mesures actuelles.', luxuryDashEvent: 'Evenement', luxuryDashDetails: 'Details', luxuryDashQuickReports: 'Rapports rapides', luxuryDashQuickReportsSubtitle: 'Exportez les donnees reelles de la serre.', luxuryDashTodayData: 'Donnees du jour', luxuryDashWeeklyReport: 'Rapport hebdomadaire', luxuryDashMonthlyAnalysis: 'Analyse mensuelle', luxuryDashDownloadCsv: 'Telecharger CSV', luxuryDashNotAvailable: 'Indisponible', luxuryDashHistoricalData: 'Historique du capteur de sol', luxuryDashHistoricalEmpty: 'Aucune donnee historique pour cette periode.', luxuryDashLoadingHistory: 'Chargement des donnees historiques...', luxuryDashDateFrom: 'Du', luxuryDashDateTo: 'Au', luxuryDashApply: 'Appliquer', luxuryDashUnavailableStatus: 'Indisponible', luxuryDashDemoPageTitle: 'Demo Live - Serre Taroudant', luxuryDashDemoPageSubtitle: 'Donnees reelles provenant de la serre de bananes a Taroudant, Maroc.', luxuryDashMapShort: 'Carte', luxuryDashMenuAlarmSingular: 'Alerte', luxuryDashMenuRecommendations: 'Recommandations', luxuryDashLastUpdateShort: 'Derniere mise a jour', luxuryDashViewDetails: 'Voir details', luxuryDashViewAll: 'Voir tout', luxuryDashExcellent: 'Excellent', luxuryDashToMonitor: 'A surveiller', luxuryDashAllOnline: 'Tous en ligne', luxuryDashLastUpdateCard: 'Derniere mise a jour', luxuryDashRealtimeData: 'Donnees en temps reel', luxuryDashNoAlert: 'Aucune alerte', luxuryDashCurrentConditions: 'Conditions actuelles', luxuryDashAirTemperature: 'Temperature air', luxuryDashSolarRadiation: 'Rayonnement solaire', luxuryDashSoilTemperature: 'Temperature sol', luxuryDashSoilPh: 'pH sol', luxuryDashSoilEc: 'EC sol', luxuryDashLast7Days: '7 derniers jours', luxuryDashAllSensorsOnline: 'Tous les capteurs fonctionnent', luxuryDashVerifiedTitle: 'Donnees 100% reelles et verifiees', luxuryDashVerifiedText: 'Systeme de monitoring certifie et calibre pour les cultures de bananes.', luxuryDashLearnRayat: 'Decouvrir comment fonctionne Rayat', demoLive: 'Demo Live'
            },
            ar: {
                luxuryDashGreeting: 'صباح الخير',
                luxuryDashGreetingSubtitle: 'هذه نظرة محدثة على بيتك الزراعي.',
                luxuryDashUserName: 'ماركو', luxuryDashCompany: 'شركة فيردي الزراعية', luxuryDashFarmLocation: 'دفيئة الموز - تارودانت، المغرب',
                luxuryDashMenuDashboard: 'لوحة التحكم', luxuryDashMenuGreenhouses: 'الدفيئات', luxuryDashMenuSensors: 'المستشعرات', luxuryDashMenuIrrigation: 'الري', luxuryDashMenuAlarms: 'الإنذارات', luxuryDashMenuAnalysis: 'التحليلات', luxuryDashMenuReports: 'التقارير', luxuryDashMenuHistory: 'السجل', luxuryDashMenuSettings: 'الإعدادات', luxuryDashSupport: 'الدعم',
                luxuryDashPlan: 'الخطة الحالية', luxuryDashProfessional: 'احترافية', luxuryDashExpiry: 'تنتهي في 12/06/2026',
                luxuryDashHealthIndex: 'مؤشر الصحة', luxuryDashSensorsOnline: 'المستشعرات المتصلة', luxuryDashActiveAlarms: 'الإنذارات النشطة', luxuryDashIrrigationsToday: 'الريات اليوم', luxuryDashWaterSaving: 'توفير المياه', luxuryDashOperating: 'تعمل', luxuryDashProgrammed: 'تحتاج جدولة', luxuryDashNoMeasuredValue: 'البيانات غير متاحة', luxuryDashDemoFallback: 'بيانات توضيحية', luxuryDashUpdated: 'آخر تحديث',
                luxuryDashMapTitle: 'خريطة الدفيئة', luxuryDashSatellite: 'عرض القمر الصناعي', luxuryDashAllSensors: 'كل المستشعرات', luxuryDashCropHealth: 'صحة المحصول', luxuryDashFieldInfo: 'دفيئة الموز - تارودانت، المغرب',
                luxuryDashRecommendations: 'توصيات الذكاء الاصطناعي', luxuryDashIrrigationAdvice: 'الري الموصى به', luxuryDashIrrigationStable: 'الرطوبة ضمن النطاق؛ حافظ على البرنامج الحالي.', luxuryDashIrrigationReview: 'الرطوبة تتطلب مراجعة دورة الري القادمة.', luxuryDashHydricRisk: 'خطر الإجهاد المائي', luxuryDashHydricStable: 'لا يوجد خطر فوري في القراءات المتاحة.', luxuryDashHydricWarning: 'تحقق من الرطوبة والحرارة قبل الدورة القادمة.', luxuryDashNutritionAdvice: 'تغذية التربة', luxuryDashNutritionStable: 'النيتروجين ضمن النطاق الأمثل للمحصول.', luxuryDashNutritionReview: 'راجع خطة التسميد حسب مستوى النيتروجين.', luxuryDashPriorityLow: 'أولوية منخفضة', luxuryDashPriorityMedium: 'أولوية متوسطة', luxuryDashPriorityHigh: 'أولوية عالية', luxuryDashSeeRecommendations: 'عرض كل التوصيات',
                luxuryDashSensorStatus: 'حالة المستشعرات', luxuryDashSensorDetails: 'عرض تفاصيل المستشعرات', luxuryDashTrendTitle: 'اتجاه آخر 7 أيام', luxuryDashTrendMetric: 'الرطوبة', luxuryDashEmptyTrend: 'ستظهر البيانات التاريخية هنا عند توفرها.', luxuryDashSoilConditions: 'حالة التربة الحالية', luxuryDashOrganicMatter: 'المادة العضوية', luxuryDashWeather: 'الطقس المحلي', luxuryDashWeatherLive: 'بيانات بيئية من الدفيئة', luxuryDashRelativeHumidity: 'رطوبة الهواء', luxuryDashWind: 'الرياح',
                luxuryDashRecentActivities: 'الأنشطة الأخيرة', luxuryDashActivityEmpty: 'لا توجد إنذارات نشطة في القراءات الحالية.', luxuryDashEvent: 'الحدث', luxuryDashDetails: 'التفاصيل', luxuryDashQuickReports: 'تقارير سريعة', luxuryDashQuickReportsSubtitle: 'صدر بيانات الدفيئة الحقيقية.', luxuryDashTodayData: 'بيانات اليوم', luxuryDashWeeklyReport: 'تقرير أسبوعي', luxuryDashMonthlyAnalysis: 'تحليل شهري', luxuryDashDownloadCsv: 'تحميل CSV', luxuryDashNotAvailable: 'غير متاح', luxuryDashHistoricalData: 'سجل مستشعر التربة', luxuryDashHistoricalEmpty: 'لا توجد بيانات تاريخية للفترة المحددة.', luxuryDashLoadingHistory: 'جار تحميل البيانات التاريخية...', luxuryDashDateFrom: 'من', luxuryDashDateTo: 'إلى', luxuryDashApply: 'تطبيق', luxuryDashUnavailableStatus: 'غير متاح', luxuryDashDemoPageTitle: 'العرض المباشر - دفيئة تارودانت', luxuryDashDemoPageSubtitle: 'بيانات حقيقية من دفيئة الموز في تارودانت، المغرب.', luxuryDashMapShort: 'الخريطة', luxuryDashMenuAlarmSingular: 'إنذار', luxuryDashMenuRecommendations: 'التوصيات', luxuryDashLastUpdateShort: 'آخر تحديث', luxuryDashViewDetails: 'عرض التفاصيل', luxuryDashViewAll: 'عرض الكل', luxuryDashExcellent: 'ممتاز', luxuryDashToMonitor: 'للمراقبة', luxuryDashAllOnline: 'كلها متصلة', luxuryDashLastUpdateCard: 'آخر تحديث', luxuryDashRealtimeData: 'بيانات فورية', luxuryDashNoAlert: 'لا إنذار', luxuryDashCurrentConditions: 'الظروف الحالية', luxuryDashAirTemperature: 'حرارة الهواء', luxuryDashSolarRadiation: 'الإشعاع الشمسي', luxuryDashSoilTemperature: 'حرارة التربة', luxuryDashSoilPh: 'pH التربة', luxuryDashSoilEc: 'EC التربة', luxuryDashLast7Days: 'آخر 7 أيام', luxuryDashAllSensorsOnline: 'كل المستشعرات تعمل', luxuryDashVerifiedTitle: 'بيانات حقيقية وموثقة 100%', luxuryDashVerifiedText: 'نظام مراقبة معتمد ومعاير لمحاصيل الموز.', luxuryDashLearnRayat: 'اكتشف كيف يعمل Rayat', demoLive: 'Demo Live'
            },
            zgh: {
                luxuryDashGreeting: 'ⴰⵣⵓⵍ',
                luxuryDashGreetingSubtitle: 'ⵜⴰⵎⵓⵖⵍⵉ ⵜⴰⵎⴰⵢⵏⵓⵜ ⵏ ⵜⵉⵙⵉⵔⵜ ⵏⵏⴽ.',
                luxuryDashUserName: 'Marco', luxuryDashCompany: 'Azienda Agricola Verdi', luxuryDashFarmLocation: 'ⵜⴰⵙⵉⵔⵜ ⵏ ⵜⵉⴳⴰⵢⵢⴰ - ⵜⴰⵔⵓⴷⴰⵏⵜ, ⵍⵎⵖⵔⵉⴱ',
                luxuryDashMenuDashboard: 'Dashboard', luxuryDashMenuGreenhouses: 'ⵜⵉⵙⵉⵔⵉⵏ', luxuryDashMenuSensors: 'ⵉⵎⵇⵇⴰⵙⵏ', luxuryDashMenuIrrigation: 'ⴰⵙⴳⵎ', luxuryDashMenuAlarms: 'ⵉⵍⵖⴰ', luxuryDashMenuAnalysis: 'ⵜⵙⵍⴹⵉⵜ', luxuryDashMenuReports: 'ⵉⵏⵇⵇⵉⵙⵏ', luxuryDashMenuHistory: 'ⴰⵎⵣⵔⵓⵢ', luxuryDashMenuSettings: 'ⵜⵉⵙⵖⴰⵍ', luxuryDashSupport: 'Support',
                luxuryDashPlan: 'ⴰⵖⴰⵡⴰⵙ', luxuryDashProfessional: 'Professional', luxuryDashExpiry: '12/06/2026',
                luxuryDashHealthIndex: 'ⴰⵎⴰⵜⴰⵔ ⵏ ⵜⴷⵓⵙⵉ', luxuryDashSensorsOnline: 'ⵉⵎⵇⵇⴰⵙⵏ ⵉⵍⵍⴰⵏ', luxuryDashActiveAlarms: 'ⵉⵍⵖⴰ ⵉⵔⴳⴳⴰⵏ', luxuryDashIrrigationsToday: 'ⴰⵙⴳⵎ ⵏ ⵡⴰⵙⵙⴰ', luxuryDashWaterSaving: 'ⴰⵙⵏⴳⵎ ⵏ ⵡⴰⵎⴰⵏ', luxuryDashOperating: 'ⵉⵖⵓⴷⴰ', luxuryDashProgrammed: 'ⵉⵅⵚⵚⴰ ⵓⵙⵖⴰⵡⵙ', luxuryDashNoMeasuredValue: 'ⵓⵔ ⵉⵍⵍⵉ ⵓⵙⴼⴽ', luxuryDashDemoFallback: 'ⵉⵙⴼⴽⴰ ⵏ demo', luxuryDashUpdated: 'ⴰⵏⴳⴳⴰⵔⵓ ⴰⵙⴳⴳⴷ',
                luxuryDashMapTitle: 'ⵜⴰⴼⵍⵡⵉⵜ ⵏ ⵜⵉⵙⵉⵔⵜ', luxuryDashSatellite: 'ⴰⵙⴽⴰⵏ ⴰⵙⴰⵜⵉⵍⵉ', luxuryDashAllSensors: 'ⴰⴽⴽⵯ ⵉⵎⵇⵇⴰⵙⵏ', luxuryDashCropHealth: 'ⵜⴰⴷⵓⵙⵉ ⵏ ⵜⴰⵢⵢⵓⵣⵜ', luxuryDashFieldInfo: 'ⵜⴰⵙⵉⵔⵜ ⵏ ⵜⵉⴳⴰⵢⵢⴰ - ⵜⴰⵔⵓⴷⴰⵏⵜ',
                luxuryDashRecommendations: 'ⵜⵉⵡⵙⵉⵜⵉⵏ IA', luxuryDashIrrigationAdvice: 'ⴰⵙⴳⵎ ⵉⵜⵜⵓⵙⵎⴰⵏ', luxuryDashIrrigationStable: 'ⵜⴰⵎⵉⴷⵉ ⵜⵖⵓⴷⴰ.', luxuryDashIrrigationReview: 'ⵙⵙⵉⵔⵎ ⴰⵙⴳⵎ ⴷ ⵉⴹⴼⵕⵏ.', luxuryDashHydricRisk: 'ⴰⵎⵉⵀⵉ ⵏ ⵡⴰⵎⴰⵏ', luxuryDashHydricStable: 'ⵓⵔ ⵉⵍⵍⵉ ⵡⴰⵎⵉⵀⵉ.', luxuryDashHydricWarning: 'ⵙⵙⵉⵔⵎ ⵜⴰⵎⵉⴷⵉ ⴷ ⵜⴰⵙⴽⵯⴼⵍⵜ.', luxuryDashNutritionAdvice: 'ⵜⵉⵏⴳⵉ ⵏ ⵓⴽⴰⵍ', luxuryDashNutritionStable: 'ⴰⵣⵓⵜ ⵉⵖⵓⴷⴰ.', luxuryDashNutritionReview: 'ⵙⵙⵉⵔⵎ ⴰⵖⴰⵡⴰⵙ ⵏ ⵜⵉⵏⴳⵉ.', luxuryDashPriorityLow: 'ⵜⴰⵣⵡⴰⵔⵜ ⵜⴰⴼⵍⵍⴰⵢⵜ', luxuryDashPriorityMedium: 'ⵜⴰⵣⵡⴰⵔⵜ ⵜⴰⵏⴰⵎⵎⴰⵙⵜ', luxuryDashPriorityHigh: 'ⵜⴰⵣⵡⴰⵔⵜ ⵜⴰⵎⵇⵇⵔⴰⵏⵜ', luxuryDashSeeRecommendations: 'ⵥⵕ ⴰⴽⴽⵯ ⵜⵉⵡⵙⵉⵜⵉⵏ',
                luxuryDashSensorStatus: 'ⴰⴷⴷⴰⴷ ⵏ ⵉⵎⵇⵇⴰⵙⵏ', luxuryDashSensorDetails: 'ⵥⵕ ⵉⴼⵙⴰⵢⵏ', luxuryDashTrendTitle: 'ⴰⵙⴼⴰⵔⵉ ⵏ 7 ⵡⵓⵙⵙⴰⵏ', luxuryDashTrendMetric: 'ⵜⴰⵎⵉⴷⵉ', luxuryDashEmptyTrend: 'ⴰⴷ ⴷ ⴱⴰⵏⵏ ⵉⵙⴼⴽⴰ.', luxuryDashSoilConditions: 'ⴰⴷⴷⴰⴷ ⵏ ⵓⴽⴰⵍ', luxuryDashOrganicMatter: 'ⵜⴰⴳⴰⵎⴰ ⵜⴰⵏⴰⵎⵓⵔⵜ', luxuryDashWeather: 'ⴰⵏⵣⵡⵉ', luxuryDashWeatherLive: 'ⵉⵙⴼⴽⴰ ⵏ ⵜⵉⵙⵉⵔⵜ', luxuryDashRelativeHumidity: 'ⵜⴰⵎⵉⴷⵉ ⵏ ⵡⴰⴹⵓ', luxuryDashWind: 'ⴰⴹⵓ',
                luxuryDashRecentActivities: 'ⵜⵉⵡⵓⵔⵉⵡⵉⵏ ⵜⵉⵎⴰⵢⵏⵓⵜⵉⵏ', luxuryDashActivityEmpty: 'ⵓⵔ ⵉⵍⵍⵉ ⵓⵍⵖⵓ.', luxuryDashEvent: 'ⵜⴰⵎⵙⴰⵍⵜ', luxuryDashDetails: 'ⵉⴼⵙⴰⵢⵏ', luxuryDashQuickReports: 'ⵉⵏⵇⵇⵉⵙⵏ', luxuryDashQuickReportsSubtitle: 'ⵙⵙⵓⴼⵖ ⵉⵙⴼⴽⴰ.', luxuryDashTodayData: 'ⵉⵙⴼⴽⴰ ⵏ ⵡⴰⵙⵙⴰ', luxuryDashWeeklyReport: 'ⴰⵏⵇⵇⵉⵙ ⵏ ⵉⵎⴰⵍⴰⵙⵙ', luxuryDashMonthlyAnalysis: 'ⵜⴰⵙⵍⴹⵉⵜ ⵏ ⵡⴰⵢⵢⵓⵔ', luxuryDashDownloadCsv: 'CSV', luxuryDashNotAvailable: 'ⵓⵔ ⵉⵍⵍⵉ', luxuryDashHistoricalData: 'ⴰⵎⵣⵔⵓⵢ ⵏ ⵓⴽⴰⵍ', luxuryDashHistoricalEmpty: 'ⵓⵔ ⵉⵍⵍⵉⵏ ⵉⵙⴼⴽⴰ.', luxuryDashLoadingHistory: 'ⴰⵍⴷⴰⵢ ⵏ ⵉⵙⴼⴽⴰ...', luxuryDashDateFrom: 'ⵙⴳ', luxuryDashDateTo: 'ⴰⵔ', luxuryDashApply: 'ⵙⵏⴼⵍ', luxuryDashUnavailableStatus: 'ⵓⵔ ⵉⵍⵍⵉ', luxuryDashDemoPageTitle: 'Demo Live - ⵜⴰⵔⵓⴷⴰⵏⵜ', luxuryDashDemoPageSubtitle: 'ⵉⵙⴼⴽⴰ ⵉⵎⵉⵔⴰⵏⵏ ⵙⴳ ⵜⵉⵙⵉⵔⵜ ⵏ ⵜⵉⴳⴰⵢⵢⴰ ⴳ ⵜⴰⵔⵓⴷⴰⵏⵜ.', luxuryDashMapShort: 'ⵜⴰⴼⵍⵡⵉⵜ', luxuryDashMenuAlarmSingular: 'ⴰⵍⴰⵔⵎ', luxuryDashMenuRecommendations: 'ⵜⵉⵡⵙⵉⵜⵉⵏ', luxuryDashLastUpdateShort: 'ⴰⵙⴳⴳⴷ ⴰⵏⴳⴳⴰⵔⵓ', luxuryDashViewDetails: 'ⵥⵕ ⵉⴼⵙⴰⵢⵏ', luxuryDashViewAll: 'ⵥⵕ ⴰⴽⴽⵯ', luxuryDashExcellent: 'ⵉⵖⵓⴷⴰ', luxuryDashToMonitor: 'ⵉⵅⵚⵚⴰ ⵓⵙⵙⵏⵜⵉ', luxuryDashAllOnline: 'ⴰⴽⴽⵯ ⵉⵍⵍⴰ', luxuryDashLastUpdateCard: 'ⴰⵙⴳⴳⴷ ⴰⵏⴳⴳⴰⵔⵓ', luxuryDashRealtimeData: 'ⵉⵙⴼⴽⴰ ⵉⵎⵉⵔⴰⵏⵏ', luxuryDashNoAlert: 'ⵓⵔ ⵉⵍⵍⵉ ⵓⵍⵖⵓ', luxuryDashCurrentConditions: 'ⴰⴷⴷⴰⴷ ⴰⵎⵉⵔⴰⵏ', luxuryDashAirTemperature: 'ⵜⴰⵙⴽⵯⴼⵍⵜ ⵏ ⵡⴰⴹⵓ', luxuryDashSolarRadiation: 'ⴰⵣⵔⴰⵢ ⵏ ⵜⴰⴼⵓⴽⵜ', luxuryDashSoilTemperature: 'ⵜⴰⵙⴽⵯⴼⵍⵜ ⵏ ⵓⴽⴰⵍ', luxuryDashSoilPh: 'pH ⵏ ⵓⴽⴰⵍ', luxuryDashSoilEc: 'EC ⵏ ⵓⴽⴰⵍ', luxuryDashLast7Days: '7 ⵡⵓⵙⵙⴰⵏ', luxuryDashAllSensorsOnline: 'ⴰⴽⴽⵯ ⵉⵎⵇⵇⴰⵙⵏ ⵖⵓⴷⴰⵏ', luxuryDashVerifiedTitle: 'ⵉⵙⴼⴽⴰ 100% ⵉⵎⵉⵔⴰⵏⵏ', luxuryDashVerifiedText: 'ⴰⵎⵙⵙⵓⴷⵙ ⵏ monitoring ⵉⵜⵜⵓⵙⵙⴽⵔ ⵉ ⵜⵉⴳⴰⵢⵢⴰ.', luxuryDashLearnRayat: 'ⵥⵕ ⵎⴰⵎⴽ ⵉⵙⵡⵓⵔⵉ Rayat', demoLive: 'Demo Live'
            }
        };

        Object.entries(RAYAT_LUXURY_DASHBOARD_TRANSLATIONS_2026).forEach(([lang, values]) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...values
            };
        });

        const RAYAT_SENSOR_CARD_MODE_TRANSLATIONS_2026 = {
            it: {
                sensorCardModeLabel: 'Modalita visualizzazione card',
                sensorCardModeVisual: 'Assistita',
                sensorCardModeTechnical: 'Professionale',
                sensorCardsSectionTitle: 'Dashboard - Sensori',
                sensorProfessionalModeTitle: 'Modalita Professionale',
                sensorProfessionalModeSubtitle: 'Vista rapida e chiara per analisi agronomiche professionali.',
                sensorAssistedModeTitle: 'Modalita Assistita',
                sensorAssistedModeSubtitle: 'Range e riferimenti visivi per interpretare ogni parametro.',
                sensorProfessionalHistoryUnavailable: 'Storico indisponibile',
                dashboardProfileSettings: 'Impostazioni account',
                dashboardProfileLanguage: 'Lingua',
                dashboardProfileExitDemo: 'Esci demo',
                sensorVisualValue: 'Valore',
                sensorVisualAction: 'Azione',
                sensorVisualUnavailableTitle: '{metric} non disponibile',
                sensorVisualUnavailableAction: 'Verificare connessione e ultimo aggiornamento.',
                sensorVisualNormalTitle: '{metric} nella zona ideale',
                sensorVisualNormalAction: 'Continua il monitoraggio.',
                sensorVisualAttentionTitle: '{metric} da controllare',
                sensorVisualAttentionAction: 'Controllare oggi e verificare il sensore.',
                sensorVisualAlertTitle: '{metric} fuori range',
                sensorVisualAlertAction: 'Intervenire oggi secondo la raccomandazione Rayat.',
                sensorVisualLowAttentionTitle: '{metric} leggermente basso',
                sensorVisualLowAlertTitle: '{metric} troppo basso',
                sensorVisualHighAttentionTitle: '{metric} leggermente alto',
                sensorVisualHighAlertTitle: '{metric} troppo alto',
                sensorVisualMoistureLowTitle: 'Terreno troppo secco',
                sensorVisualMoistureLowAction: 'Irrigare oggi e ricontrollare il valore.',
                sensorVisualMoistureHighTitle: 'Terreno troppo umido',
                sensorVisualMoistureHighAction: 'Ridurre irrigazione e controllare drenaggio.'
            },
            en: {
                sensorCardModeLabel: 'Card display mode',
                sensorCardModeVisual: 'Assisted',
                sensorCardModeTechnical: 'Professional',
                sensorCardsSectionTitle: 'Dashboard - Sensors',
                sensorProfessionalModeTitle: 'Professional Mode',
                sensorProfessionalModeSubtitle: 'Fast, clear view for professional agronomic analysis.',
                sensorAssistedModeTitle: 'Assisted Mode',
                sensorAssistedModeSubtitle: 'Ranges and visual cues to interpret every parameter.',
                sensorProfessionalHistoryUnavailable: 'History unavailable',
                dashboardProfileSettings: 'Account settings',
                dashboardProfileLanguage: 'Language',
                dashboardProfileExitDemo: 'Exit demo',
                sensorVisualValue: 'Value',
                sensorVisualAction: 'Action',
                sensorVisualUnavailableTitle: '{metric} unavailable',
                sensorVisualUnavailableAction: 'Check connection and latest update.',
                sensorVisualNormalTitle: '{metric} in the ideal zone',
                sensorVisualNormalAction: 'Keep monitoring.',
                sensorVisualAttentionTitle: '{metric} needs checking',
                sensorVisualAttentionAction: 'Check today and verify the sensor.',
                sensorVisualAlertTitle: '{metric} out of range',
                sensorVisualAlertAction: 'Act today following the Rayat recommendation.',
                sensorVisualLowAttentionTitle: '{metric} slightly low',
                sensorVisualLowAlertTitle: '{metric} too low',
                sensorVisualHighAttentionTitle: '{metric} slightly high',
                sensorVisualHighAlertTitle: '{metric} too high',
                sensorVisualMoistureLowTitle: 'Soil is too dry',
                sensorVisualMoistureLowAction: 'Irrigate today and recheck the value.',
                sensorVisualMoistureHighTitle: 'Soil is too wet',
                sensorVisualMoistureHighAction: 'Reduce irrigation and check drainage.'
            },
            fr: {
                sensorCardModeLabel: 'Mode des cartes capteurs',
                sensorCardModeVisual: 'Assisté',
                sensorCardModeTechnical: 'Professionnel',
                sensorCardsSectionTitle: 'Tableau de bord - Capteurs',
                sensorProfessionalModeTitle: 'Mode Professionnel',
                sensorProfessionalModeSubtitle: 'Vue rapide et claire pour une analyse agronomique professionnelle.',
                sensorAssistedModeTitle: 'Mode Assisté',
                sensorAssistedModeSubtitle: 'Plages et reperes visuels pour interpreter chaque parametre.',
                sensorProfessionalHistoryUnavailable: 'Historique indisponible',
                dashboardProfileSettings: 'Parametres du compte',
                dashboardProfileLanguage: 'Langue',
                dashboardProfileExitDemo: 'Quitter la demo',
                sensorVisualValue: 'Valeur',
                sensorVisualAction: 'Action',
                sensorVisualUnavailableTitle: '{metric} indisponible',
                sensorVisualUnavailableAction: 'Verifier la connexion et la derniere mise a jour.',
                sensorVisualNormalTitle: '{metric} dans la zone ideale',
                sensorVisualNormalAction: 'Poursuivre le monitoring.',
                sensorVisualAttentionTitle: '{metric} a surveiller',
                sensorVisualAttentionAction: 'Controler aujourd hui et verifier le capteur.',
                sensorVisualAlertTitle: '{metric} hors plage',
                sensorVisualAlertAction: 'Intervenir aujourd hui selon la recommandation Rayat.',
                sensorVisualLowAttentionTitle: '{metric} legerement bas',
                sensorVisualLowAlertTitle: '{metric} trop bas',
                sensorVisualHighAttentionTitle: '{metric} legerement eleve',
                sensorVisualHighAlertTitle: '{metric} trop eleve',
                sensorVisualMoistureLowTitle: 'Sol trop sec',
                sensorVisualMoistureLowAction: 'Irriguer aujourd hui puis verifier la valeur.',
                sensorVisualMoistureHighTitle: 'Sol trop humide',
                sensorVisualMoistureHighAction: 'Reduire l irrigation et controler le drainage.'
            },
            ar: {
                sensorCardModeLabel: 'نمط عرض البطاقات',
                sensorCardModeVisual: 'مساعد',
                sensorCardModeTechnical: 'مهني',
                sensorCardsSectionTitle: 'لوحة التحكم - المستشعرات',
                sensorProfessionalModeTitle: 'النمط المهني',
                sensorProfessionalModeSubtitle: 'عرض سريع وواضح للتحليل الزراعي المهني.',
                sensorAssistedModeTitle: 'النمط المساعد',
                sensorAssistedModeSubtitle: 'نطاقات ومؤشرات بصرية لفهم كل معيار.',
                sensorProfessionalHistoryUnavailable: 'السجل غير متاح',
                dashboardProfileSettings: 'إعدادات الحساب',
                dashboardProfileLanguage: 'اللغة',
                dashboardProfileExitDemo: 'الخروج من العرض',
                sensorVisualValue: 'القيمة',
                sensorVisualAction: 'الإجراء',
                sensorVisualUnavailableTitle: '{metric} غير متاح',
                sensorVisualUnavailableAction: 'تحقق من الاتصال وآخر تحديث.',
                sensorVisualNormalTitle: '{metric} ضمن المنطقة المثالية',
                sensorVisualNormalAction: 'استمر في المراقبة.',
                sensorVisualAttentionTitle: '{metric} يحتاج إلى متابعة',
                sensorVisualAttentionAction: 'افحص اليوم وتحقق من المستشعر.',
                sensorVisualAlertTitle: '{metric} خارج النطاق',
                sensorVisualAlertAction: 'تدخل اليوم حسب توصية Rayat.',
                sensorVisualLowAttentionTitle: '{metric} منخفض قليلاً',
                sensorVisualLowAlertTitle: '{metric} منخفض جداً',
                sensorVisualHighAttentionTitle: '{metric} مرتفع قليلاً',
                sensorVisualHighAlertTitle: '{metric} مرتفع جداً',
                sensorVisualMoistureLowTitle: 'التربة جافة جداً',
                sensorVisualMoistureLowAction: 'اسق اليوم ثم تحقق من القيمة.',
                sensorVisualMoistureHighTitle: 'التربة رطبة جداً',
                sensorVisualMoistureHighAction: 'قلل الري وتحقق من التصريف.'
            },
            zgh: {
                sensorCardModeLabel: 'ⴰⵙⴽⴰⵏ ⵏ ⵉⵎⵇⵇⴰⵙⵏ',
                sensorCardModeVisual: 'ⴰⵙⵙⵉⵙⵜⵉ',
                sensorCardModeTechnical: 'ⴰⵎⵙⵙⵏⴰⵍ',
                sensorCardsSectionTitle: 'Dashboard - ⵉⵎⵇⵇⴰⵙⵏ',
                sensorProfessionalModeTitle: 'ⴰⵙⴽⴰⵏ ⴰⵎⵙⵙⵏⴰⵍ',
                sensorProfessionalModeSubtitle: 'ⴰⵙⴽⴰⵏ ⴰⴼⵙⵙⴰⵙ ⵉ ⵜⵙⵓⵔⵉ ⵜⴰⴼⵍⴰⵃⵜ.',
                sensorAssistedModeTitle: 'ⴰⵙⴽⴰⵏ ⴰⵙⵙⵉⵙⵜⵉ',
                sensorAssistedModeSubtitle: 'ⵉⵣⵍⴰⵢⵏ ⴷ ⵜⵉⵎⵍⵉⵍⵉⵏ ⵉ ⵓⵙⵙⵏⵜⵉ.',
                sensorProfessionalHistoryUnavailable: 'Historique indisponible',
                dashboardProfileSettings: 'ⵜⵉⵙⵖⴰⵍ ⵏ ⵓⵎⵉⴹⴰⵏ',
                dashboardProfileLanguage: 'ⵜⵓⵜⵍⴰⵢⵜ',
                dashboardProfileExitDemo: 'ⴼⴼⵓⵖ ⵙⴳ demo',
                sensorVisualValue: 'ⴰⵣⴰⵍ',
                sensorVisualAction: 'ⵜⵉⴳⴰⵡⵜ',
                sensorVisualUnavailableTitle: '{metric} ⵓⵔ ⵉⵍⵍⵉ',
                sensorVisualUnavailableAction: 'ⵙⵙⵉⵔⵎ ⴰⵙⵙⵓⴷⵙ ⴷ ⴰⵙⴳⴳⴷ.',
                sensorVisualNormalTitle: '{metric} ⵉⵖⵓⴷⴰ',
                sensorVisualNormalAction: 'ⵙⵙⵓⵍ ⴰⵙⵙⵏⵜⵉ.',
                sensorVisualAttentionTitle: '{metric} ⵉⵅⵚⵚⴰ ⵓⵙⵙⵏⵜⵉ',
                sensorVisualAttentionAction: 'ⵙⵙⵉⵔⵎ ⴰⵙⵙⴰ ⴷ ⴰⵎⵇⵇⴰⵙ.',
                sensorVisualAlertTitle: '{metric} ⵉⴼⴼⵖ ⴰⵣⵍⴰⵢ',
                sensorVisualAlertAction: 'ⵙⵡⵓⵔⵉ ⴰⵙⵙⴰ ⵙ ⵜⵓⵙⵙⵏⴰ Rayat.',
                sensorVisualLowAttentionTitle: '{metric} ⵉⴷⵔⵓⵙ',
                sensorVisualLowAlertTitle: '{metric} ⵉⴷⵔⵓⵙ ⴱⴰⵀⵔⴰ',
                sensorVisualHighAttentionTitle: '{metric} ⵉⵙⵎⵓⵏ',
                sensorVisualHighAlertTitle: '{metric} ⵉⵙⵎⵓⵏ ⴱⴰⵀⵔⴰ',
                sensorVisualMoistureLowTitle: 'ⴰⴽⴰⵍ ⵉⵇⵇⵓⵔ',
                sensorVisualMoistureLowAction: 'ⵙⴳⵎ ⴰⵙⵙⴰ ⴷ ⵙⵙⵉⵔⵎ ⴰⵣⴰⵍ.',
                sensorVisualMoistureHighTitle: 'ⴰⴽⴰⵍ ⵉⵎⵉⴷⵉ ⴱⴰⵀⵔⴰ',
                sensorVisualMoistureHighAction: 'ⵙⵎⵓⵏ ⴰⵙⴳⵎ ⴷ ⵙⵙⵉⵔⵎ ⴰⵙⵙⴰⵡⴰⵍ.'
            }
        };

        Object.entries(RAYAT_SENSOR_CARD_MODE_TRANSLATIONS_2026).forEach(([lang, values]) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...values
            };
        });

        function t(key) {
            let val = translations[currentLang]?.[key];
            if (!val && currentLang === 'ber') {
                val = translations.zgh?.[key];
            }
            // Fallback to French for Amazigh if translation is missing
            if (!val && (currentLang === 'zgh' || currentLang === 'ber')) {
                val = translations['fr'][key];
            }
            return val || key;
        }

        function getLocaleForCurrentLanguage() {
            const locales = {
                it: 'it-IT',
                en: 'en-US',
                fr: 'fr-FR',
                ar: 'ar-MA',
                ber: 'tzm-MA',
                zgh: 'tzm-MA'
            };

            return locales[currentLang] || 'it-IT';
        }

        function formatLocalizedDate(date) {
            return date.toLocaleDateString(getLocaleForCurrentLanguage());
        }

        function formatLocalizedTime(date) {
            return date.toLocaleTimeString(getLocaleForCurrentLanguage(), {
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        // RAYAT FIX - user profile
        function getUserProfileStorageKey(userId = user?.id) {
            return userId ? `${USER_PROFILE_STORAGE_PREFIX}${userId}` : null;
        }

        // RAYAT FIX - user profile
        function readStoredUserProfile(userId = user?.id) {
            const storageKey = getUserProfileStorageKey(userId);
            if (!storageKey) return {};

            try {
                const stored = localStorage.getItem(storageKey);
                return stored ? JSON.parse(stored) : {};
            } catch (error) {
                return {};
            }
        }

        // RAYAT FIX - user profile
        function writeStoredUserProfile(profile, userId = user?.id) {
            const storageKey = getUserProfileStorageKey(userId);
            if (!storageKey) return;
            localStorage.setItem(storageKey, JSON.stringify(profile));
        }

        // RAYAT FIX - user profile
        function getMergedUserProfile(userData = user) {
            const baseUser = userData || {};
            const storedProfile = readStoredUserProfile(baseUser.id);
            return {
                name: baseUser.name || storedProfile.name || '',
                email: baseUser.email || storedProfile.email || '',
                phone: storedProfile.phone ?? baseUser.profile_phone ?? baseUser.phone ?? '',
                description: storedProfile.description ?? baseUser.profile_description ?? baseUser.description ?? '',
                photo: storedProfile.photo ?? baseUser.profile_photo ?? baseUser.photo ?? '',
                role: baseUser.role || currentRole || 'guest'
            };
        }

        // RAYAT FIX - user profile
        function syncStoredUserProfileIntoSession() {
            if (!user || !user.id) return;
            const mergedProfile = getMergedUserProfile(user);
            user = {
                ...user,
                name: mergedProfile.name || user.name,
                email: mergedProfile.email || user.email,
                phone: mergedProfile.phone || '',
                description: mergedProfile.description || '',
                photo: mergedProfile.photo || ''
            };
            getActiveAuthStorage().setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user));
        }

        // RAYAT FIX - user profile
        function getUserInitials(name = '') {
            return String(name || '')
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((part) => part.charAt(0).toUpperCase())
                .join('') || 'R';
        }

        // RAYAT FIX - user profile
        function getAssignedSensorsForProfile() {
            return latestAssignedSensors.slice().sort((left, right) => {
                return String(left.type || '').localeCompare(String(right.type || '')) || String(left.name || '').localeCompare(String(right.name || ''));
            });
        }

        // RAYAT FIX - user profile
        function buildProfileSensorSnapshot(apiData = []) {
            if (!Array.isArray(apiData)) return [];

            const typeMeta = {
                energia: { labelKey: 'sensorEnName', icon: '⚡' },
                acqua: { labelKey: 'sensorWaName', icon: '💧' },
                terreno: { labelKey: 'sensorSoName', icon: '🌱' },
                clima: { labelKey: 'sensorClName', icon: '🌤️' }
            };

            return apiData
                .filter((reading) => reading && reading.type)
                .map((reading) => {
                    const meta = typeMeta[reading.type] || { labelKey: reading.type, icon: '📟' };
                    const numericValue = parseNumericValue(reading.value);
                    const formattedValue = Number.isFinite(numericValue)
                        ? `${formatMetricValue(numericValue)} ${reading.unit || ''}`.trim()
                        : '--';

                    return {
                        id: reading.sensor_id || `${reading.type}-${reading.subtype || reading.name || Math.random()}`,
                        type: reading.type,
                        subtype: reading.subtype || '',
                        icon: meta.icon,
                        typeLabel: t(meta.labelKey),
                        name: reading.name || t(meta.labelKey),
                        deviceName: reading.device_name || '--',
                        value: formattedValue,
                        timestamp: reading.timestamp ? formatLocalizedTime(new Date(reading.timestamp)) : '--'
                    };
                });
        }

        // RAYAT FIX - user profile
        function navigateToAccountPage() {
            closeProfileMenu();

            if (isAuthenticated() && isCustomerRole(currentRole)) {
                setView('profilo');
                return;
            }

            if (hasPrivilegedAdminShortcut()) {
                goToAdminArea();
                return;
            }

            if (!isAuthenticated()) {
                setViewWithTracking('login', { path: '/login' });
                return;
            }

            setViewWithTracking('login', { path: '/login' });
        }

        function openPrimaryFieldExperienceFromNavigation() {
            closeProfileMenu();
            toggleMobileMenu(false);

            if (isAuthenticated() && isCustomerRole(currentRole)) {
                openSensorDashboard(selectedSensor || 'terreno');
                return;
            }

            if (hasPrivilegedAdminShortcut()) {
                goToAdminArea();
                return;
            }

            setViewWithTracking('demo');
        }

        function openSensorDashboard(sensorKey = null, options = {}) {
            closeProfileMenu();
            toggleMobileMenu(false);

            const normalizedSensorKey = normalizeDashboardSensorKey(sensorKey) || selectedSensor || 'terreno';
            selectedSensor = normalizedSensorKey;

            const navigate = options.tracked === false ? setView : setViewWithTracking;
            navigate('demo', { path: getDashboardPathForSensor(normalizedSensorKey) });
        }

        function handleSensorCardKeydown(event, sensorKey) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openSensorDashboard(sensorKey);
            }
        }

        function scrollToProfileSection(sectionId, options = {}) {
            const target = document.getElementById(sectionId);
            if (!target) {
                return;
            }

            const nextUrl = VIEW_PATHS.profilo + '#' + sectionId;
            history.replaceState({ view: 'profilo' }, '', nextUrl);

            const nextTop = Math.max(target.getBoundingClientRect().top + window.scrollY - PROFILE_SECTION_SCROLL_OFFSET, 0);
            window.scrollTo({ top: nextTop, behavior: 'smooth' });

            if (options.focusId) {
                const focusTarget = document.getElementById(options.focusId);
                if (focusTarget) {
                    requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
                }
            }
        }

        function openCustomerProfileSection(event, section) {
            event?.stopPropagation();
            closeProfileMenu();
            toggleMobileMenu(false);

            if (!isAuthenticated() || !isCustomerRole(currentRole)) {
                navigateToAccountPage();
                return;
            }

            const sectionId = section === 'settings' ? PROFILE_SECTION_IDS.settings : PROFILE_SECTION_IDS.overview;
            const options = section === 'settings' ? { focusId: 'profile-name' } : {};
            const revealSection = () => requestAnimationFrame(() => requestAnimationFrame(() => scrollToProfileSection(sectionId, options)));

            if (currentView !== 'profilo') {
                setView('profilo');
                revealSection();
                return;
            }

            revealSection();
        }

        /* PATCH-01 — start */
        function openLoginFromNavigation() {
            closeProfileMenu();
            toggleMobileMenu(false);
            setViewWithTracking('login', { path: '/login' });
        }
        /* PATCH-01 — end */

        function formatTemplate(template, tokens = {}) {
            return String(template || '').replace(/\{(\w+)\}/g, (_, key) => tokens[key] ?? '');
        }

        function getAlertBadgeLabel(level, withIcon = false) {
            if (level === 'alert') {
                return `${withIcon ? '🚨 ' : ''}${t('alertBadgeAlert')}`;
            }

            if (level === 'attention') {
                return `${withIcon ? '⚠ ' : ''}${t('alertBadgeAttention')}`;
            }

            return t('statusNormal');
        }

        function syncStaticI18n() {
            document.documentElement.lang = currentLang;
            document.documentElement.dir = currentLang === 'ar' ? 'rtl' : 'ltr';

            document.querySelectorAll('[data-i18n]').forEach((element) => {
                const key = element.getAttribute('data-i18n');
                if (!key) {
                    return;
                }

                element.textContent = t(key);
            });
        }

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function getPasswordToggleIcon(isVisible = false) {
            if (isVisible) {
                return `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M3 3l18 18"></path>
                        <path d="M10.58 10.58a2 2 0 0 0 2.84 2.84"></path>
                        <path d="M9.88 5.09A10.94 10.94 0 0 1 12 4.91c5.05 0 9.27 3.11 10.5 7.5a10.96 10.96 0 0 1-4.28 5.66"></path>
                        <path d="M6.61 6.61A10.95 10.95 0 0 0 1.5 12.41a10.94 10.94 0 0 0 7.09 6.87"></path>
                    </svg>
                `;
            }

            return `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M1.5 12s4-7.5 10.5-7.5S22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12Z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                </svg>
            `;
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function renderPasswordField(options = {}) {
            const {
                inputId,
                labelKey,
                placeholder = '••••••••',
                value = '',
                required = true,
                minLength = '',
                autocomplete = 'current-password'
            } = options;
            const requirement = required ? 'required' : '';
            const minLengthAttr = minLength ? `minlength="${minLength}"` : '';

            return `
                <div class="rayat-password-field">
                    <label class="block text-sm font-medium mb-2" for="${escapeHtml(inputId)}">${t(labelKey)}</label>
                    <div class="rayat-password-control">
                        <input
                            type="password"
                            id="${escapeHtml(inputId)}"
                            ${requirement}
                            ${minLengthAttr}
                            autocomplete="${escapeHtml(autocomplete)}"
                            value="${escapeHtml(value)}"
                            class="w-full px-4 py-3 pr-14 border rounded-2xl"
                            placeholder="${escapeHtml(placeholder)}"
                        >
                        <button
                            type="button"
                            class="rayat-password-toggle"
                            aria-label="${escapeHtml(t('showPassword'))}"
                            title="${escapeHtml(t('showPassword'))}"
                            aria-pressed="false"
                            onclick="togglePasswordVisibility('${escapeHtml(inputId)}', this)"
                        >
                            ${getPasswordToggleIcon(false)}
                        </button>
                    </div>
                </div>
            `;
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function togglePasswordVisibility(inputId, trigger) {
            const input = document.getElementById(inputId);
            if (!input || !trigger) {
                return;
            }

            const isVisible = input.type === 'text';
            input.type = isVisible ? 'password' : 'text';
            trigger.innerHTML = getPasswordToggleIcon(!isVisible);
            trigger.setAttribute('aria-pressed', String(!isVisible));
            trigger.setAttribute('aria-label', isVisible ? t('showPassword') : t('hidePassword'));
            trigger.setAttribute('title', isVisible ? t('showPassword') : t('hidePassword'));
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function closeProfileMenu() {
            if (!isProfileMenuOpen) {
                return;
            }

            isProfileMenuOpen = false;
            document.getElementById('rayat-profile-menu-shell')?.classList.remove('is-open');
            document.getElementById('rayat-profile-menu')?.classList.remove('is-open');
            document.getElementById('rayat-profile-menu-trigger')?.setAttribute('aria-expanded', 'false');
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function toggleProfileMenu(event, forceState) {
            event?.stopPropagation();

            if (!isAuthenticated() || !isCustomerRole(currentRole)) {
                navigateToAccountPage();
                return;
            }

            isProfileMenuOpen = typeof forceState === 'boolean' ? forceState : !isProfileMenuOpen;
            document.getElementById('rayat-profile-menu-shell')?.classList.toggle('is-open', isProfileMenuOpen);
            document.getElementById('rayat-profile-menu')?.classList.toggle('is-open', isProfileMenuOpen);
            document.getElementById('rayat-profile-menu-trigger')?.setAttribute('aria-expanded', String(isProfileMenuOpen));
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function openCustomerProfileOverview(event) {
            openCustomerProfileSection(event, 'overview');
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function openCustomerProfileEditor(event) {
            openCustomerProfileSection(event, 'settings');
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function logoutFromProfileMenu(event) {
            event?.stopPropagation();
            closeProfileMenu();
            logout();
        }

        function isElementActuallyVisible(element) {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
                return false;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function isViewportAtMost(maxWidth) {
            return Boolean(
                window.matchMedia?.(`(max-width: ${maxWidth}px)`).matches
                || window.innerWidth <= maxWidth
            );
        }

        function getVisibleScrollLockReasons() {
            const reasons = [];
            const mobileOverlay = document.getElementById('mobile-menu-overlay');
            const dashboardSidebarBackdrop = document.querySelector('.rayat-luxury-dashboard-sidebar-backdrop');
            const subscriptionModal = document.getElementById('subscription-expired-modal');
            const alertSettingsModal = document.querySelector('.rayat-modal-card')?.closest('.fixed.inset-0');

            if (
                isViewportAtMost(768)
                && mobileOverlay
                && mobileOverlay.classList.contains('is-open')
                && !mobileOverlay.classList.contains('hidden')
                && isElementActuallyVisible(mobileOverlay)
            ) {
                reasons.push('mobile-menu');
            }

            if (
                isViewportAtMost(900)
                && dashboardSidebarBackdrop
                && dashboardSidebarBackdrop.classList.contains('is-open')
                && isElementActuallyVisible(dashboardSidebarBackdrop)
            ) {
                reasons.push('dashboard-sidebar');
            }

            if (
                subscriptionModal
                && !subscriptionModal.classList.contains('hidden')
                && isElementActuallyVisible(subscriptionModal)
            ) {
                reasons.push('subscription-modal');
            }

            if (showSettings && isElementActuallyVisible(alertSettingsModal)) {
                reasons.push('settings-modal');
            }

            return reasons;
        }

        function clearStaleScrollLockState() {
            const mobileOverlay = document.getElementById('mobile-menu-overlay');
            const mobilePanel = document.getElementById('mobile-menu-panel');
            const mobileButton = document.getElementById('mobile-menu-button');
            const dashboardSidebarBackdrop = document.querySelector('.rayat-luxury-dashboard-sidebar-backdrop');
            const dashboardSidebar = document.querySelector('.rayat-luxury-dashboard-sidebar');
            const dashboardSidebarButton = document.querySelector('.rayat-luxury-dashboard-mobile-toggle');
            const subscriptionModal = document.getElementById('subscription-expired-modal');
            const subscriptionModalIsVisible = Boolean(
                subscriptionModal
                && !subscriptionModal.classList.contains('hidden')
                && isElementActuallyVisible(subscriptionModal)
            );
            const alertSettingsModal = document.querySelector('.rayat-modal-card')?.closest('.fixed.inset-0');
            const overlayIsReallyOpen = Boolean(
                mobileOverlay
                && mobileOverlay.classList.contains('is-open')
                && !mobileOverlay.classList.contains('hidden')
                && isElementActuallyVisible(mobileOverlay)
            );
            const dashboardSidebarIsReallyOpen = Boolean(
                dashboardSidebarBackdrop
                && dashboardSidebarBackdrop.classList.contains('is-open')
                && isElementActuallyVisible(dashboardSidebarBackdrop)
            );

            if (!overlayIsReallyOpen) {
                isMobileMenuOpen = false;
                mobileOverlay?.classList.add('hidden');
                mobileOverlay?.classList.remove('is-open');
                mobilePanel?.classList.remove('is-open');
                mobileButton?.setAttribute('aria-expanded', 'false');
            }

            if (!dashboardSidebarIsReallyOpen) {
                isLuxuryDashboardSidebarOpen = false;
                dashboardSidebarBackdrop?.classList.remove('is-open');
                dashboardSidebar?.classList.remove('is-open');
                dashboardSidebarButton?.setAttribute('aria-expanded', 'false');
            }

            if (!subscriptionModalIsVisible) {
                isSubscriptionModalOpen = false;
            }

            if (showSettings && !isElementActuallyVisible(alertSettingsModal)) {
                showSettings = false;
            }

            [document.documentElement, document.body].forEach((node) => {
                node.classList.remove('rayat-scroll-locked', 'rayat-menu-open', 'menu-open', 'modal-open', 'no-scroll', 'lock-scroll');
                node.style.removeProperty('overflow');
                node.style.removeProperty('overflow-y');
                node.style.removeProperty('position');
                node.style.removeProperty('top');
                node.style.removeProperty('width');
                node.style.removeProperty('height');
                node.style.removeProperty('overscroll-behavior');
                node.style.removeProperty('touch-action');
                node.removeAttribute('data-scroll-lock-reason');
            });
        }

        function syncPageScrollLock() {
            const lockReasons = getVisibleScrollLockReasons();
            const shouldLockScroll = lockReasons.length > 0;

            if (!shouldLockScroll) {
                clearStaleScrollLockState();
                return false;
            }

            const reason = lockReasons.join(' ');
            [document.documentElement, document.body].forEach((node) => {
                node.classList.add('rayat-scroll-locked');
                node.setAttribute('data-scroll-lock-reason', reason);
                node.style.overflow = 'hidden';
                node.style.setProperty('overscroll-behavior', 'none');
                node.style.setProperty('touch-action', 'none');
            });
            document.body.classList.toggle('rayat-menu-open', lockReasons.includes('mobile-menu'));
            return true;
        }

        // Backward-compatible wrapper for existing call sites.
        function syncBodyScrollLock() {
            return syncPageScrollLock();
        }

        // RAYAT FIX - mobile app ready optimization
        function isStandaloneDisplayMode() {
            return Boolean(
                window.matchMedia?.('(display-mode: standalone)').matches
                || window.navigator.standalone
                || document.referrer.startsWith('android-app://')
            );
        }

        // RAYAT FIX - mobile app ready optimization
        function syncAppShellState() {
            document.body.dataset.view = currentView;
            document.body.classList.toggle('rayat-standalone-mode', isStandaloneDisplayMode());
            document.body.classList.toggle('rayat-authenticated', isAuthenticated());
            document.body.classList.toggle('rayat-public-admin-link', hasPrivilegedAdminShortcut());
        }

        function renderCropSelector(options = {}) {
            const {
                wrapperClass = 'bg-gray-50 p-10 rounded-[2.5rem] border border-gray-100 shadow-inner',
                label = t('cropSelectorTitle'),
                hint = t('cropSelectorHint')
            } = options;

            const selectedCrop = getSelectedCropOption();

            return `
                <div class="${wrapperClass} rayat-crop-selector">
                    <label class="block text-xs font-black text-blue-600 uppercase mb-3 tracking-tighter">${label}</label>
                    <p class="text-sm text-gray-500 leading-relaxed mb-4">${hint}</p>
                    <select onchange="setUserCrop(this.value)" class="w-full bg-white border-2 border-gray-100 rounded-3xl p-4 md:p-6 font-black text-xl md:text-2xl text-gray-800 outline-none focus:border-blue-500 transition-all appearance-none cursor-pointer">
                        ${CROP_OPTIONS.map((option) => `
                            <option value="${option.value}" ${selectedCrop.value === option.value ? 'selected' : ''}>
                                ${t(option.labelKey)}
                            </option>
                        `).join('')}
                    </select>
                    ${userCropSelection.value === 'autre' ? `
                        <div class="mt-4">
                            <label class="block text-sm font-semibold mb-2">${t('cropCustomLabel')}</label>
                            <input
                                type="text"
                                value="${escapeHtml(userCropSelection.custom)}"
                                onchange="setUserCustomCrop(this.value)"
                                class="w-full px-4 py-3 border rounded-2xl"
                                placeholder="${escapeHtml(t('cropCustomPlaceholder'))}"
                            >
                        </div>
                    ` : ''}
                </div>
            `;
        }

        function toggleLangMenu(event) {
            event?.stopPropagation();
            document.getElementById('lang-menu')?.classList.toggle('hidden');
        }

        function setUserCrop(value) {
            userCropSelection.value = CROP_OPTIONS.some((option) => option.value === value) ? value : DEFAULT_CROP_VALUE;
            if (userCropSelection.value !== 'autre') {
                userCropSelection.custom = '';
            }
            waterSettings.crop = userCropSelection.value;
            persistCropSelection();
            render();
        }

        function setUserCustomCrop(value) {
            userCropSelection.custom = String(value || '').trim();
            persistCropSelection();
            render();
        }

        function toggleMobileMenu(forceState) {
            isMobileMenuOpen = typeof forceState === 'boolean' ? forceState : !isMobileMenuOpen;
            if (isMobileMenuOpen) {
                closeProfileMenu();
            }

            const overlay = document.getElementById('mobile-menu-overlay');
            const panel = document.getElementById('mobile-menu-panel');
            const button = document.getElementById('mobile-menu-button');

            if (overlay && panel) {
                overlay.classList.toggle('hidden', !isMobileMenuOpen);
                overlay.classList.toggle('is-open', isMobileMenuOpen);
                panel.classList.toggle('is-open', isMobileMenuOpen);
            }

            if (button) {
                button.setAttribute('aria-expanded', String(isMobileMenuOpen));
            }

            syncPageScrollLock();
        }

        function navigateFromMobileMenu(view) {
            toggleMobileMenu(false);
            closeProfileMenu();
            trackNavigationEvent(view);
            setView(view);
        }

        function shouldTrackAnalytics(view = currentView) {
            return view !== 'profilo' && !window.location.pathname.startsWith('/admin');
        }

        // RAYAT FIX - analytics followup
        function getAnalyticsAnonymousId() {
            try {
                const existing = localStorage.getItem(ANALYTICS_STORAGE_KEY);
                if (existing) {
                    return existing;
                }

                let generatedId = '';
                if (window.crypto?.randomUUID) {
                    generatedId = window.crypto.randomUUID();
                } else {
                    generatedId = `rayat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                }

                localStorage.setItem(ANALYTICS_STORAGE_KEY, generatedId);
                return generatedId;
            } catch (error) {
                return `rayat-${Date.now()}`;
            }
        }

        function sendInternalAnalytics(payload = {}) {
            if (!payload.eventType || !shouldTrackAnalytics(payload.view || currentView)) {
                return;
            }

            const anonymousId = getAnalyticsAnonymousId();
            const body = JSON.stringify({
                ...payload,
                anonymousId,
                pagePath: payload.pagePath || getPathForView(payload.view || currentView),
                referrer: typeof document !== 'undefined' ? document.referrer || '' : ''
            });

            if (typeof fetch === 'function') {
                fetch(CONFIG.ANALYTICS_TRACK_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Rayat-Analytics-Id': anonymousId
                    },
                    body,
                    keepalive: true
                }).catch(() => {
                    try {
                        if (navigator.sendBeacon) {
                            const beacon = new Blob([body], { type: 'application/json' });
                            navigator.sendBeacon(CONFIG.ANALYTICS_TRACK_URL, beacon);
                        }
                    } catch (error) {
                        // noop
                    }
                });
                return;
            }

            try {
                if (navigator.sendBeacon) {
                    const beacon = new Blob([body], { type: 'application/json' });
                    navigator.sendBeacon(CONFIG.ANALYTICS_TRACK_URL, beacon);
                }
            } catch (error) {
                // noop
            }
        }

        function trackRegistrationStart(view = 'register') {
            sendInternalAnalytics({
                eventType: 'registration_start',
                eventName: 'Registration Started',
                view,
                pagePath: getPathForView(view)
            });
        }

        function trackEvent(name) {
            if (!name || !shouldTrackAnalytics()) {
                return;
            }

            if (typeof window !== 'undefined' && typeof window.plausible === 'function') {
                window.plausible(name);
            }

            sendInternalAnalytics({
                eventType: 'button_click',
                eventName: name,
                buttonName: name
            });
        }

        function trackPageView(view = currentView) {
            if (!shouldTrackAnalytics(view)) {
                return;
            }

            if (typeof window !== 'undefined' && typeof window.plausible === 'function') {
                window.plausible('pageview', { u: `${CONFIG.PUBLIC_SITE_URL}${getPathForView(view)}` });
            }

            sendInternalAnalytics({
                eventType: 'page_view',
                eventName: 'Page View',
                view,
                pagePath: getPathForView(view)
            });
        }

        function getNavigationEventName(view) {
            view = normalizePublicDashboardView(view);
            if (view === 'login') return 'Login Click';
            if (view === 'contatti') return 'Contact Click';
            if (view === 'demo') return 'Demo Request Click';
            return '';
        }

        function trackNavigationEvent(view) {
            trackEvent(getNavigationEventName(view));
        }

        function setViewWithTracking(view, options = {}) {
            const normalizedView = normalizePublicDashboardView(view);
            trackNavigationEvent(normalizedView);
            setView(normalizedView, options);
        }

        function setSensorCardMode(mode) {
            const nextMode = SENSOR_CARD_VIEW_MODES.has(mode) ? mode : 'technical';
            currentSensorCardMode = nextMode;
            isLuxuryDashboardProfileMenuOpen = false;
            localStorage.setItem(SENSOR_CARD_MODE_STORAGE_KEY, nextMode);
            render();
        }

        function navigateToRayatHomeSection(sectionId) {
            const scrollToSection = () => {
                const section = document.getElementById(sectionId);
                if (!section) return false;
                section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return true;
            };

            if (scrollToSection()) return;

            setView('home');
            requestAnimationFrame(scrollToSection);
        }

        function setLanguage(lang) {
            currentLang = lang;
            localStorage.setItem('rayat_lang', lang);
            isLuxuryDashboardProfileMenuOpen = false;
            document.getElementById('lang-menu')?.classList.add('hidden');
            closeProfileMenu();
            render();
            // Re-initialize map to update popups and localized content immediately
            if (currentView === 'home') initHomeMap();
        }

        const sensorData = {
            energia: {
                icon: '⚡', nome: 'sensorEnName', descrizione: 'sensorEnDesc',
                funzioni: ['sensorEnF1', 'sensorEnF2', 'sensorEnF3'],
                valore: 2.4, unita: 'kW', status: 'statusNormal', color: 'green', percentuale: 60,
                grafico: [2.1, 2.2, 2.3, 2.4, 2.5, 2.4, 2.3, 2.2, 2.1, 2.0, 2.2, 2.4, 2.5, 2.6, 2.5, 2.4, 2.3, 2.2, 2.1, 2.3, 2.4, 2.5, 2.4, 2.3, 2.4, 2.5, 2.4, 2.3, 2.4, 2.5]
            },
            acqua: {
                icon: '💧', nome: 'sensorWaName', descrizione: 'sensorWaDesc',
                funzioni: ['sensorWaF1', 'sensorWaF2', 'sensorWaF3'],
                valore: 4.2, unita: 'm', status: 'statusNormal', color: 'green', percentuale: 84, // 4.2/5.0 * 100
                grafico: [4.5, 4.4, 4.3, 4.2, 4.1, 4.0, 4.1, 4.2, 4.3, 4.2, 4.1, 4.0, 3.9, 3.8, 4.0, 4.2, 4.3, 4.2, 4.1, 4.2, 4.2, 4.3, 4.1, 4.2, 4.2, 4.3, 4.2, 4.1, 4.2, 4.2]
            },
            terreno: {
                icon: '🌱', nome: 'sensorSoName', descrizione: 'sensorSoDesc',
                funzioni: ['sensorSoF1', 'sensorSoF2', 'sensorSoF3', 'sensorSoF4', 'sensorSoF5', 'sensorSoF6', 'sensorSoF7'],
                valore: 62, unita: '%', status: 'statusGood', color: 'green', percentuale: 62,
                grafico: [55, 56, 57, 58, 59, 60, 61, 62, 63, 62, 61, 60, 59, 58, 59, 60, 61, 62, 61, 60, 59, 58, 60, 61, 62, 63, 62, 62, 61, 62],
                details: [
                    { key: 'moisture', label: 'sensorSoF1', value: 34, unit: '%', icon: '💧' },
                    { key: 'temperature', label: 'sensorSoF2', value: 22, unit: '°C', icon: '🌡️' },
                    { key: 'ec', label: 'sensorSoF3', value: 1.2, unit: 'dS/m', icon: '⚡' },
                    { key: 'pH', label: 'sensorSoF4', value: 7.2, unit: 'pH', icon: '🧪' },
                    { key: 'nitrogen', label: 'sensorSoF5', value: 120, unit: 'ppm', icon: '🌿' },
                    { key: 'phosphorus', label: 'sensorSoF6', value: 45, unit: 'ppm', icon: '🌿' },
                    { key: 'potassium', label: 'sensorSoF7', value: 180, unit: 'ppm', icon: '🌿' }
                ]
            },
            clima: {
                icon: '🌡️', nome: 'sensorClName', descrizione: 'sensorClDesc', descrizioneEstesa: 'sensorClDetails',
                funzioni: ['sensorClF1', 'sensorClF2', 'sensorClF3', 'sensorClF5', 'sensorClF6'],
                valore: 34, unita: '°C', status: 'statusHot', color: 'orange', percentuale: 75,
                details: [
                    { key: 'temperature', label: 'tempAmbient', value: 34, unit: '°C', icon: '🌡️' },
                    { key: 'humidity', label: 'relHumidity', value: 45, unit: '%', icon: '💧' },
                    { key: 'co2', label: 'co2', value: 420, unit: 'ppm', icon: '💨' },
                    { key: 'windSpeed', label: 'windSpeed', value: 12.5, unit: 'km/h', icon: '🌬️' }
                ]
            }
        };

        function resetLiveSensorDisplayData() {
            sensorData.energia.valore = null;
            sensorData.energia.percentuale = 0;
            sensorData.acqua.valore = null;
            sensorData.acqua.percentuale = 0;
            sensorData.terreno.valore = null;
            sensorData.terreno.percentuale = 0;
            sensorData.terreno.details.forEach((metric) => {
                metric.value = null;
            });
            sensorData.clima.valore = null;
            sensorData.clima.percentuale = 0;
            sensorData.clima.details.forEach((metric) => {
                metric.value = null;
            });
        }

        function resetSensorConnectionState() {
            sensorConnectionState = {
                energia: 'loading',
                acqua: 'loading',
                terreno: 'loading',
                clima: 'loading'
            };
        }

        function resetSensorLatestTimestamps() {
            // RAYAT-FIX: reset freshness state atomically whenever live sensor data is rebuilt.
            sensorLatestTimestamps = {
                energia: null,
                acqua: null,
                terreno: null,
                clima: null
            };
        }

        function updateSensorTimestamp(sensorKey, timestampValue) {
            const normalizedSensorKey = normalizeDashboardSensorKey(sensorKey);
            if (!normalizedSensorKey || !timestampValue) {
                return;
            }

            const timestamp = new Date(timestampValue);
            if (Number.isNaN(timestamp.getTime())) {
                return;
            }

            const currentTimestamp = sensorLatestTimestamps[normalizedSensorKey]
                ? new Date(sensorLatestTimestamps[normalizedSensorKey]).getTime()
                : 0;
            if (timestamp.getTime() >= currentTimestamp) {
                sensorLatestTimestamps[normalizedSensorKey] = timestamp.toISOString();
            }
        }

        function resolveFreshestSensorKey(fallbackSensorKey = selectedSensor) {
            let freshestSensorKey = null;
            let freshestTimestamp = 0;

            Object.entries(sensorLatestTimestamps).forEach(([sensorKey, timestampValue]) => {
                if (!timestampValue) {
                    return;
                }

                const timestamp = new Date(timestampValue).getTime();
                if (Number.isNaN(timestamp) || timestamp < freshestTimestamp) {
                    return;
                }

                freshestTimestamp = timestamp;
                freshestSensorKey = sensorKey;
            });

            return freshestSensorKey || normalizeDashboardSensorKey(fallbackSensorKey) || 'terreno';
        }

        function initializeSelectedSensorFromFreshestData() {
            // RAYAT-FIX: use the freshest sensor only for the initial automatic dashboard selection.
            const normalizedSelectedSensor = normalizeDashboardSensorKey(selectedSensor); // RAYAT-FIX
            if (normalizedSelectedSensor) {
                return normalizedSelectedSensor; // RAYAT-FIX
            }

            const freshestSensorKey = resolveFreshestSensorKey(selectedSensor); // RAYAT-FIX
            selectedSensor = freshestSensorKey; // RAYAT-FIX
            return freshestSensorKey; // RAYAT-FIX
        }

        function parsePositiveInteger(value, fallback) {
            const normalized = Number.parseInt(String(value ?? '').trim(), 10);
            return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
        }

        function normalizeMonitoringConfig(config) {
            const source = config && typeof config === 'object' ? config : {};
            const routerIntervalMinutes = parsePositiveInteger(
                source.routerIntervalMinutes ?? source.expectedDataMinutes,
                DEFAULT_MONITORING_CONFIG.routerIntervalMinutes
            );
            const offlineGraceMinutes = parsePositiveInteger(
                source.offlineGraceMinutes,
                DEFAULT_MONITORING_CONFIG.offlineGraceMinutes
            );
            const offlineAfterMinutes = parsePositiveInteger(
                source.offlineAfterMinutes,
                routerIntervalMinutes + offlineGraceMinutes
            );
            const alertExtraMinutes = parsePositiveInteger(
                source.alertExtraMinutes,
                DEFAULT_MONITORING_CONFIG.alertExtraMinutes
            );
            const emailAfterMinutes = parsePositiveInteger(
                source.emailAfterMinutes ?? source.missingDataThresholdMinutes,
                routerIntervalMinutes + alertExtraMinutes
            );
            const gatewayHeartbeatWindowMinutes = parsePositiveInteger(
                source.gatewayHeartbeatWindowMinutes,
                DEFAULT_MONITORING_CONFIG.gatewayHeartbeatWindowMinutes
            ); // RAYAT-FIX
            const sensorDataFreshMinutes = parsePositiveInteger(
                source.sensorDataFreshMinutes ?? source.emailAfterMinutes ?? source.missingDataThresholdMinutes,
                emailAfterMinutes
            ); // RAYAT-FIX

            return {
                routerIntervalMinutes,
                expectedDataMinutes: routerIntervalMinutes,
                offlineGraceMinutes,
                offlineAfterMinutes,
                alertExtraMinutes,
                emailAfterMinutes,
                missingDataThresholdMinutes: emailAfterMinutes,
                gatewayHeartbeatWindowMinutes, // RAYAT-FIX
                sensorDataFreshMinutes // RAYAT-FIX
            };
        }

        function applyMonitoringConfig(config) {
            liveMonitoringConfig = normalizeMonitoringConfig(config);
            return liveMonitoringConfig;
        }

        function getSensorOnlineWindowMs() {
            return liveMonitoringConfig.offlineAfterMinutes * 60 * 1000;
        }

        function normalizeGatewayStatusPayload(payload) { // RAYAT-FIX
            const source = payload && typeof payload === 'object' ? payload : {}; // RAYAT-FIX
            return { // RAYAT-FIX
                available: true, // RAYAT-FIX
                deviceId: source.deviceId || null, // RAYAT-FIX
                deviceName: source.deviceName || null, // RAYAT-FIX
                routerOnline: source.routerOnline === true, // RAYAT-FIX
                lastHeartbeatAt: source.lastHeartbeatAt || null, // RAYAT-FIX
                lastBootAt: source.lastBootAt || null, // RAYAT-FIX
                sensorDataLastAt: source.sensorDataLastAt || null, // RAYAT-FIX
                sensorDataFresh: source.sensorDataFresh === true // RAYAT-FIX
            }; // RAYAT-FIX
        }

        function buildGatewayStatusSignature(status = gatewayStatusState) { // RAYAT-FIX
            return [ // RAYAT-FIX
                status.available ? '1' : '0', // RAYAT-FIX
                status.deviceId || '', // RAYAT-FIX
                status.routerOnline ? '1' : '0', // RAYAT-FIX
                status.lastHeartbeatAt || '', // RAYAT-FIX
                status.lastBootAt || '', // RAYAT-FIX
                status.sensorDataLastAt || '', // RAYAT-FIX
                status.sensorDataFresh ? '1' : '0' // RAYAT-FIX
            ].join('|'); // RAYAT-FIX
        }

        function resetGatewayStatusState() { // RAYAT-FIX
            gatewayStatusState = { // RAYAT-FIX
                available: false, // RAYAT-FIX
                deviceId: null, // RAYAT-FIX
                deviceName: null, // RAYAT-FIX
                routerOnline: false, // RAYAT-FIX
                lastHeartbeatAt: null, // RAYAT-FIX
                lastBootAt: null, // RAYAT-FIX
                sensorDataLastAt: null, // RAYAT-FIX
                sensorDataFresh: false // RAYAT-FIX
            }; // RAYAT-FIX
            gatewayStatusSignature = ''; // RAYAT-FIX
        }

        function updateGatewayStatusState(payload) { // RAYAT-FIX
            const nextStatus = normalizeGatewayStatusPayload(payload); // RAYAT-FIX
            const nextSignature = buildGatewayStatusSignature(nextStatus); // RAYAT-FIX
            const changed = nextSignature !== gatewayStatusSignature; // RAYAT-FIX
            gatewayStatusState = nextStatus; // RAYAT-FIX
            gatewayStatusSignature = nextSignature; // RAYAT-FIX
            return changed; // RAYAT-FIX
        }

        async function fetchGatewayStatusPayload(requestScope, tokenOverride = null) { // RAYAT-FIX
            const isPrivateScope = requestScope === 'private'; // RAYAT-FIX
            const endpoint = isPrivateScope ? CONFIG.PRIVATE_GATEWAY_STATUS_URL : CONFIG.PUBLIC_GATEWAY_STATUS_URL; // RAYAT-FIX
            const privateToken = tokenOverride || authToken; // RAYAT-FIX
            const response = await fetch(`${endpoint}?t=${Date.now()}`, { // RAYAT-FIX
                cache: 'no-store', // RAYAT-FIX
                headers: isPrivateScope && privateToken ? { 'Authorization': `Bearer ${privateToken}` } : undefined // RAYAT-FIX
            }); // RAYAT-FIX
            if (!response.ok) { // RAYAT-FIX
                throw new Error(`HTTP ${response.status}`); // RAYAT-FIX
            } // RAYAT-FIX
            return response.json(); // RAYAT-FIX
        }

        function applyGatewayStatusResponse(result) { // RAYAT-FIX
            if (result?.success && result.data) { // RAYAT-FIX
                applyMonitoringConfig(result.monitoring); // RAYAT-FIX
                return updateGatewayStatusState(result.data); // RAYAT-FIX
            } // RAYAT-FIX

            const hadPreviousState = Boolean(gatewayStatusSignature); // RAYAT-FIX
            resetGatewayStatusState(); // RAYAT-FIX
            return hadPreviousState; // RAYAT-FIX
        }

        function readSensorCache(cacheKey) {
            const rawValue = localStorage.getItem(cacheKey);
            if (!rawValue) {
                return null;
            }

            try {
                const parsed = JSON.parse(rawValue);
                if (Array.isArray(parsed)) {
                    return {
                        data: parsed,
                        monitoring: null
                    };
                }

                if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) {
                    return null;
                }

                return {
                    data: parsed.data,
                    monitoring: parsed.monitoring || null
                };
            } catch (_error) {
                return null;
            }
        }

        function writeSensorCache(cacheKey, data, monitoring) {
            localStorage.setItem(cacheKey, JSON.stringify({
                data,
                monitoring: normalizeMonitoringConfig(monitoring)
            }));
        }

        function isPrivateSensorPayloadRow(row = {}) {
            const deviceId = String(row.device_id || row.deviceId || row.gateway_id || row.gatewayId || '').trim();
            const topic = String(row.topic || row.mqtt_topic || row.mqttTopic || '').trim();
            return (deviceId && PRIVATE_SENSOR_DEVICE_IDS.has(deviceId))
                || (topic && PRIVATE_SENSOR_TOPIC_PREFIXES.some((prefix) => topic.startsWith(prefix)));
        }

        function filterPublicSensorPayloadRows(data) {
            return Array.isArray(data)
                ? data.filter((row) => !isPrivateSensorPayloadRow(row))
                : data;
        }

        function resolveSensorOnlineStatus(reading) {
            const explicitStatus = String(reading?.online_status || '').trim().toLowerCase();
            if (explicitStatus === 'online') {
                return 'online';
            }
            if (explicitStatus === 'offline' || explicitStatus === 'never') {
                return 'offline';
            }

            const freshnessSource = reading?.last_seen || reading?.timestamp;
            if (!freshnessSource) {
                return 'loading';
            }

            const freshnessDate = new Date(freshnessSource);
            if (Number.isNaN(freshnessDate.getTime())) {
                return 'loading';
            }

            return (Date.now() - freshnessDate.getTime()) < getSensorOnlineWindowMs() ? 'online' : 'offline';
        }


        // --- Data Simulation for Presentation ---
        let globalHistory = [];
        function generateSimulationData() {
            globalHistory = [];
            const now = new Date();
            for (let i = 167; i >= 0; i--) {
                const date = new Date(now.getTime() - i * 3600000);
                const hour = date.getHours();

                // Suolo (7-in-1)
                const nitrogen = 135 + Math.random() * 55;
                const phosphorus = 35 + Math.random() * 18;
                const potassium = 210 + Math.random() * 90;
                const pH = 6.0 + Math.random() * 0.6;
                const ec = 1700 + Math.random() * 900;
                const moisture = 60 + Math.random() * 18;
                const tempSuolo = 20 + Math.random() * 7;

                // Clima
                let tempClima;
                if (hour >= 6 && hour <= 18) {
                    tempClima = 20 + Math.sin((hour - 6) / 12 * Math.PI) * 10;
                } else {
                    tempClima = 16 + Math.random() * 5;
                }
                const humidity = 58 + Math.random() * 24;
                const co2 = 460 + Math.random() * 260;
                const wind = 4 + Math.random() * 10;

                // Acqua
                const waterLevel = 3.6 + Math.random() * 0.8;

                // Energia (Battery Voltage)
                const battery = 12.2 + Math.random() * 1.1;

                globalHistory.push({
                    date,
                    energia: battery,
                    acqua: waterLevel,
                    climaTemp: tempClima,
                    humidity,
                    co2,
                    windSpeed: wind,
                    temperature: tempSuolo,
                    terreno: moisture,
                    ec,
                    pH,
                    nitrogen,
                    phosphorus,
                    potassium,
                    status: 'statusNormal'
                });
            }
            // Update current sensorData with the last point
            const last = globalHistory[globalHistory.length - 1];
            sensorData.energia.valore = last.energia.toFixed(1);
            sensorData.energia.unita = 'V'; // Per richiesta utente (Battery Voltage)
            sensorData.acqua.valore = last.acqua;
            sensorData.clima.valore = last.climaTemp.toFixed(1);
            sensorData.clima.details[0].value = last.climaTemp.toFixed(1);
            sensorData.clima.details[1].value = last.humidity.toFixed(0);
            sensorData.clima.details[2].value = last.co2.toFixed(0);
            sensorData.clima.details[3].value = last.windSpeed.toFixed(1);
            sensorData.terreno.valore = last.terreno.toFixed(0);
            sensorData.terreno.details[0].value = last.terreno.toFixed(0);
            sensorData.terreno.details[1].value = last.temperature.toFixed(1);
            sensorData.terreno.details[2].value = (last.ec / 1000).toFixed(2);
            sensorData.terreno.details[3].value = last.pH.toFixed(1);
            sensorData.terreno.details[4].value = last.nitrogen.toFixed(0);
            sensorData.terreno.details[5].value = last.phosphorus.toFixed(0);
            sensorData.terreno.details[6].value = last.potassium.toFixed(0);
        }

        // RAYAT FIX - refresh header button shared across demo/live monitoring
        function buildCurrentHistorySnapshot(date = new Date()) {
            const energy = parseNumericValue(sensorData.energia?.valore) ?? 0;
            const water = parseNumericValue(sensorData.acqua?.valore) ?? 0;
            const climateTemp = parseNumericValue(sensorData.clima?.details?.[0]?.value ?? sensorData.clima?.valore) ?? 0;
            const humidity = parseNumericValue(sensorData.clima?.details?.[1]?.value) ?? 0;
            const co2 = parseNumericValue(sensorData.clima?.details?.[2]?.value) ?? 0;
            const windSpeed = parseNumericValue(sensorData.clima?.details?.[3]?.value) ?? 0;
            const soilTemp = parseNumericValue(sensorData.terreno?.details?.[1]?.value) ?? 0;
            const soilMoisture = parseNumericValue(sensorData.terreno?.details?.[0]?.value ?? sensorData.terreno?.valore) ?? 0;
            const ec = parseNumericValue(sensorData.terreno?.details?.[2]?.value) ?? 0;
            const pH = parseNumericValue(sensorData.terreno?.details?.[3]?.value) ?? 0;
            const nitrogen = parseNumericValue(sensorData.terreno?.details?.[4]?.value) ?? 0;
            const phosphorus = parseNumericValue(sensorData.terreno?.details?.[5]?.value) ?? 0;
            const potassium = parseNumericValue(sensorData.terreno?.details?.[6]?.value) ?? 0;

            return {
                date,
                energia: energy,
                acqua: water,
                climaTemp: climateTemp,
                humidity,
                co2,
                windSpeed,
                temperature: soilTemp,
                terreno: soilMoisture,
                ec: ec * 1000,
                pH,
                nitrogen,
                phosphorus,
                potassium,
                status: 'statusNormal'
            };
        }

        // RAYAT FIX - refresh header button shared across demo/live monitoring
        function syncCurrentSensorSnapshotToHistory(date = new Date()) {
            const snapshot = buildCurrentHistorySnapshot(date);

            if (!globalHistory.length) {
                globalHistory = [snapshot];
                return;
            }

            globalHistory[globalHistory.length - 1] = snapshot;
        }

        generateSimulationData();
        resetLiveSensorDisplayData();

        // --- Soil Sensor Thresholds (7-in-1 Configuration) ---
        // These thresholds can be easily modified for different crops
        const soilThresholds = {
            temperature: { min: 25, max: 30, unit: '°C', scale: { min: 0, max: 50 } },
            moisture: { min: 60, max: 80, unit: '%', scale: { min: 0, max: 100 } },
            ec: { min: 800, max: 2000, unit: 'μS/cm', scale: { min: 0, max: 3000 } },
            nitrogen: { min: 50, max: 150, unit: 'mg/kg', scale: { min: 0, max: 200 } },
            phosphorus: { min: 30, max: 80, unit: 'mg/kg', scale: { min: 0, max: 150 } },
            potassium: { min: 150, max: 300, unit: 'mg/kg', scale: { min: 0, max: 400 } },
            pH: { min: 5.5, max: 7.0, unit: '', scale: { min: 4, max: 9 } }
        };

        // --- Climate Sensor Thresholds (7-in-1 Configuration) ---
        const climateThresholds = {
            temperature: { min: 18, max: 32, unit: '°C', scale: { min: -10, max: 50 } },
            humidity: { min: 40, max: 70, unit: '%', scale: { min: 0, max: 100 } },
            co2: { min: 350, max: 1000, unit: 'ppm', scale: { min: 300, max: 2000 } },
            pressure: { min: 980, max: 1040, unit: 'hPa', scale: { min: 900, max: 1100 } },
            uvIndex: { min: 0, max: 5, unit: '', scale: { min: 0, max: 11 } },
            rain: { min: 0, max: 10, unit: 'mm', scale: { min: 0, max: 50 } },
            windSpeed: { min: 0, max: 20, unit: 'km/h', scale: { min: 0, max: 100 } }
        };

        // Helper function to check if value is within optimal range
        function isOptimal(value, threshold) {
            if (threshold.max !== undefined) {
                return value >= threshold.min && value <= threshold.max;
            }
            return value >= threshold.min;
        }


        function getLevelClass(level) {
            if (level === 'alert') return 'text-red-600';
            if (level === 'attention') return 'text-amber-600';
            return 'text-green-600';
        }

        function getStatusBadge(level, fallback = t('statusNormal')) {
            if (level === 'alert') {
                return {
                    className: 'bg-red-100 text-red-700',
                    label: getAlertBadgeLabel('alert', true)
                };
            }

            if (level === 'attention') {
                return {
                    className: 'bg-amber-100 text-amber-700',
                    label: getAlertBadgeLabel('attention', true)
                };
            }

            return {
                className: 'bg-green-100 text-green-700',
                label: fallback
            };
        }

        function getMetricLevel(group, key, value) {
            const normalizedValue = normalizeMetricValue(group, key, value);
            const range = getRangeForMetric(group, key);
            return getMetricState(normalizedValue, range).level;
        }

        function getOverallLevel(levels = []) {
            if (levels.includes('alert')) {
                return 'alert';
            }
            if (levels.includes('attention')) {
                return 'attention';
            }
            return 'normal';
        }

        function renderHistoryStatusCell(level, fallback = t('statusNormal')) {
            const badge = getStatusBadge(level, fallback);
            return `<td class="rayat-history-status-cell"><span class="rayat-history-status-badge ${badge.className}">${badge.label}</span></td>`;
        }

        function renderMetricCard(group, metric, options = {}) {
            const normalizedValue = normalizeMetricValue(group, metric.key, metric.value);
            const range = getRangeForMetric(group, metric.key);
            const unit = getMetricUnit(group, metric.key, metric.unit || metric.unita || '');
            const state = getMetricState(normalizedValue, range);
            const gauge = range ? getGaugeMeta(group, metric.key, range) : null;
            const gaugeMarkerPercent = gauge ? getGaugeMarkerPercent(normalizedValue, gauge.min, gauge.max) : null;
            const rangeLabel = buildOptimalRangeLabel(range, group === 'climate' ? 'climate' : 'range');
            const metricInstalled = metric.installed !== false && Number.isFinite(normalizedValue);
            const mobileOrderMap = {
                temperature: 1,
                moisture: 2,
                humidity: 2,
                co2: 3,
                pH: 4,
                water: 5,
                nitrogen: 6,
                phosphorus: 7,
                potassium: 8,
                ec: 9,
                windSpeed: 10
            };
            const mobileOrderClass = mobileOrderMap[metric.key] ? `rayat-metric-card--mobile-order-${mobileOrderMap[metric.key]}` : '';
            const cardModifierClass = metricInstalled ? state.cssModifier : 'rayat-metric-card--inactive';
            const stateClass = metricInstalled ? getLevelClass(state.level) : 'text-slate-500';
            const stateLabel = metricInstalled ? state.label : t('sensorNotInstalled');

            return `
                <article class="rayat-metric-card ${cardModifierClass} ${mobileOrderClass}" data-metric-key="${metric.key}">
                    <div class="rayat-metric-card-head mb-4">
                        <div class="rayat-metric-card-header-main">
                            <span class="rayat-metric-card-icon">${metric.icon}</span>
                            <div class="rayat-metric-card-copy">
                                <p class="rayat-metric-card-title">${t(metric.label)}</p>
                                <p class="rayat-metric-card-state ${stateClass}">${stateLabel}</p>
                            </div>
                        </div>
                        ${metricInstalled && state.badge ? `<span class="rayat-alert-badge ${state.level === 'alert' ? 'rayat-alert-badge--alert' : 'rayat-alert-badge--attention'}">${state.badge}</span>` : ''}
                    </div>
                    <div class="flex items-end gap-2 mb-5">
                        ${metricInstalled ? `
                            <span class="text-5xl font-black text-slate-900 leading-none">${formatMetricValue(normalizedValue)}</span>
                            <span class="text-sm font-bold text-slate-400 uppercase">${unit}</span>
                        ` : `
                            <span class="rayat-metric-card-placeholder">${t('sensorNotInstalled')}</span>
                        `}
                    </div>
                    ${gauge ? `
                        <div class="rayat-range-track-shell">
                            <div class="rayat-range-track" style="background:${gauge.gradient};">
                                ${metricInstalled && gaugeMarkerPercent !== null ? `<div class="rayat-range-pointer" style="left:${gaugeMarkerPercent}%;" aria-hidden="true"></div>` : ''}
                            </div>
                        </div>
                        <div class="flex justify-between text-[11px] font-semibold text-slate-400 mt-3">
                            <span>${formatMetricValue(gauge.min)}${unit ? ` ${unit}` : ''}</span>
                            <span>${formatMetricValue(gauge.max)}${unit ? ` ${unit}` : ''}</span>
                        </div>
                    ` : ''}
                    <p class="rayat-metric-card-range ${state.level === 'normal' ? 'text-slate-600' : getLevelClass(state.level)}">${rangeLabel}</p>
                </article>
            `;
        }

        function getSensorConnectionMeta(sensorKey) {
            const state = sensorConnectionState[sensorKey] || 'loading';
            return {
                state,
                className: state === 'online' ? 'is-online' : (state === 'offline' ? 'is-offline' : 'is-loading'),
                label: state === 'online'
                    ? t('monitoringOnline')
                    : (state === 'offline' ? t('monitoringOffline') : t('refreshingDataAction'))
            };
        }

        function formatSectionStatusTimestamp(timestampValue) {
            if (!timestampValue) {
                return '--';
            }

            const timestamp = new Date(timestampValue);
            if (Number.isNaN(timestamp.getTime())) {
                return '--';
            }

            const now = new Date();
            const isSameDay = timestamp.getFullYear() === now.getFullYear()
                && timestamp.getMonth() === now.getMonth()
                && timestamp.getDate() === now.getDate();

            return isSameDay
                ? formatLocalizedTime(timestamp)
                : `${formatLocalizedDate(timestamp)} ${formatLocalizedTime(timestamp)}`;
        }

        function getDemoSectionStatusMeta(sensorKey) {
            const normalizedSensorKey = normalizeDashboardSensorKey(sensorKey) || resolveFreshestSensorKey(sensorKey);
            const timestampValue = sensorLatestTimestamps[normalizedSensorKey]
                || gatewayStatusState.sensorDataLastAt
                || gatewayStatusState.lastHeartbeatAt
                || null;
            const sensorState = sensorConnectionState[normalizedSensorKey] || 'loading';
            let effectiveState = sensorState;

            if (effectiveState === 'loading') {
                if (timestampValue) {
                    const timestamp = new Date(timestampValue);
                    effectiveState = !Number.isNaN(timestamp.getTime()) && (Date.now() - timestamp.getTime()) < getSensorOnlineWindowMs()
                        ? 'online'
                        : 'offline';
                } else if (gatewayStatusState.available) {
                    effectiveState = gatewayStatusState.routerOnline && gatewayStatusState.sensorDataFresh
                        ? 'online'
                        : 'offline';
                } else {
                    effectiveState = 'offline';
                }
            }

            return {
                className: effectiveState === 'online' ? 'is-online' : 'is-offline',
                label: effectiveState === 'online' ? t('homeStatusOnline') : t('homeStatusOffline'),
                timestamp: formatSectionStatusTimestamp(timestampValue)
            };
        }

        function renderSensorMetricGrid(sensorKey, group, className = '') {
            const sensor = sensorData[sensorKey];
            if (!sensor?.details?.length) {
                return '';
            }

            const rows = sensor.details.map((metric) => renderMetricCard(group, metric)).join('');
            const variantClass = sensorKey === 'terreno'
                ? 'rayat-sensor-card-grid--soil'
                : (sensorKey === 'clima' ? 'rayat-sensor-card-grid--climate' : '');

            return `<div class="rayat-sensor-card-grid ${variantClass} ${className}">${rows}</div>`;
        }

        function isHomepageMetricInstalled(sensorKey, metric) {
            if (!metric || metric.installed === false) {
                return false;
            }

            if (sensorKey === 'clima' && metric.key === 'windSpeed') {
                return false;
            }

            return true;
        }

        function getHomepageMetrics(sensorKey) {
            const sensor = sensorData[sensorKey];
            if (!sensor?.details?.length) {
                return [];
            }

            return sensor.details.filter((metric) => isHomepageMetricInstalled(sensorKey, metric));
        }

        function getHomepageSectionStatus() {
            const states = HOMEPAGE_REAL_SENSOR_KEYS.map((sensorKey) => getSensorConnectionMeta(sensorKey).state);
            const isOnline = states.length > 0 && states.every((state) => state === 'online');

            return {
                className: isOnline ? 'is-online' : 'is-offline',
                label: isOnline ? t('homeStatusOnline') : t('homeStatusOffline')
            };
        }

        function renderHomepageStatusBadge() {
            const statusMeta = getHomepageSectionStatus();

            return `
                <span class="rayat-home-status-badge ${statusMeta.className}">
                    <span class="rayat-home-status-badge__dot" aria-hidden="true"></span>
                    <span class="rayat-home-status-badge__state">${statusMeta.label}</span>
                </span>
            `;
        }

        function renderHomepageSensorGrid() {
            const cards = HOMEPAGE_REAL_SENSOR_KEYS.flatMap((sensorKey) => {
                const group = sensorKey === 'terreno' ? 'soil' : 'climate';
                return getHomepageMetrics(sensorKey).map((metric) => renderMetricCard(group, metric));
            }).join('');

            return `<div class="rayat-home-sensor-grid">${cards}</div>`;
        }

        function renderHomeTechnologySection() {
            return `
                <section class="rayat-home-technology-section">
                    <div class="container mx-auto px-4">
                        <div class="rayat-home-technology-shell">
                            <h2 class="section-title-main rayat-home-technology-title">${t('homeTechnologyTitle')}</h2>
                            <div class="rayat-home-technology-grid">
                                ${HOMEPAGE_TECH_PRODUCTS.map((product) => `
                                    <button
                                        type="button"
                                        onclick="openSensorDashboard('${product.key}')"
                                        class="rayat-home-technology-card ${product.featured ? 'is-featured' : ''}"
                                        aria-label="${escapeHtml(t(product.labelKey))}"
                                    >
                                        <div class="rayat-home-technology-card__icon" aria-hidden="true">${product.icon}</div>
                                        <p class="rayat-home-technology-card__label">${t(product.labelKey)}</p>
                                    </button>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                </section>
            `;
        }

        function renderHomeLiveSensorsSection() {
            return `
                <section class="rayat-home-sensors-section">
                    <div class="container mx-auto px-4">
                        <div class="rayat-home-sensors-intro">
                            <h2 class="section-title-main rayat-home-sensors-intro__title">${t('homeLiveSensorsTitle')}</h2>
                            <p class="section-subtitle-main rayat-home-sensors-intro__subtitle">${t('homeLiveSensorsSubtitle')}</p>
                        </div>
                        <div class="rayat-home-sensors-shell">
                            <div class="rayat-home-sensors-head">
                                <h3 class="rayat-home-sensors-title">${t('homeLiveSensorsSystemTitle')}</h3>
                            <div class="rayat-home-sensors-statuses">
                                    ${renderHomepageStatusBadge()}
                                </div>
                            </div>
                            ${renderHomepageSensorGrid()}
                            <div class="rayat-home-sensors-cta">
                                <a href="${getWhatsappHref()}" target="_blank" rel="noopener" onclick="trackEvent('WhatsApp Click')" class="rayat-home-demo-cta rayat-home-demo-cta--whatsapp" aria-label="${escapeHtml(t('homeLiveSensorsCtaAria'))}">
                                    <span class="rayat-home-demo-cta__icon-wrap" aria-hidden="true">${getWhatsappIconSvg('rayat-home-demo-cta__icon')}</span>
                                    <span class="rayat-home-demo-cta__title">${t('homeLiveSensorsCtaTitle')}</span>
                                    <span class="rayat-home-demo-cta__note">${t('homeLiveSensorsCtaNote')}</span>
                                </a>
                            </div>
                        </div>
                    </div>
                </section>
            `;
        }

        function buildDashboardAlertSnapshot() {
            const snapshot = [];
            const cropLabel = getSelectedCropLabel();

            sensorData.terreno.details.forEach((metric) => {
                const range = getRangeForMetric('soil', metric.key);
                const value = normalizeMetricValue('soil', metric.key, metric.value);
                const state = getMetricState(value, range);
                snapshot.push({
                    sensor: 'terreno',
                    sensorLabel: t(sensorData.terreno.nome),
                    sensorType: 'terreno',
                    sensorSubtype: SENSOR_SUBTYPE_MAP.soil[metric.key] || null,
                    param: metric.key,
                    label: t(metric.label),
                    value,
                    unit: getMetricUnit('soil', metric.key, metric.unit || ''),
                    level: state.level,
                    optimalMin: range?.min ?? null,
                    optimalMax: range?.max ?? null,
                    crop: cropLabel,
                    title: `${t(metric.label)} • ${cropLabel}`,
                    description: buildOptimalRangeLabel(range, 'range')
                });
            });

            sensorData.clima.details.forEach((metric) => {
                const range = getRangeForMetric('climate', metric.key);
                const value = normalizeMetricValue('climate', metric.key, metric.value);
                const state = getMetricState(value, range);
                snapshot.push({
                    sensor: 'clima',
                    sensorLabel: t(sensorData.clima.nome),
                    sensorType: 'clima',
                    sensorSubtype: SENSOR_SUBTYPE_MAP.climate[metric.key] || null,
                    param: metric.key,
                    label: t(metric.label),
                    value,
                    unit: getMetricUnit('climate', metric.key, metric.unit || ''),
                    level: state.level,
                    optimalMin: range?.min ?? null,
                    optimalMax: range?.max ?? null,
                    crop: cropLabel,
                    title: `${t(metric.label)} • ${cropLabel}`,
                    description: buildOptimalRangeLabel(range, 'climate')
                });
            });

            const energyRange = { min: 12.2, max: 13.8, unit: sensorData.energia.unita || 'V' };
            const energyValue = parseNumericValue(sensorData.energia.valore);
            const energyState = getMetricState(energyValue, energyRange);
            snapshot.push({
                sensor: 'energia',
                sensorLabel: t(sensorData.energia.nome),
                sensorType: 'energia',
                sensorSubtype: SENSOR_SUBTYPE_MAP.energy.voltage,
                param: 'voltage',
                label: t('batteryVoltageLabel'),
                value: energyValue,
                unit: energyRange.unit,
                level: energyState.level,
                optimalMin: energyRange.min,
                optimalMax: energyRange.max,
                crop: null,
                title: `${t(sensorData.energia.nome)} • ${t('batteryTitle')}`,
                description: `${t('optimalRangePlain')}: ${formatMetricValue(energyRange.min)} – ${formatMetricValue(energyRange.max)} ${energyRange.unit}`
            });

            const numDays = filterState.period === '7d' ? 7 : (filterState.period === '30d' ? 30 : 1);
            const requiredWater = (Number.parseFloat(waterSettings.hectares) || 0) * getCropConsumptionValue() * numDays;
            const availableWater = (parseNumericValue(sensorData.acqua.valore) || 0) * 1000;
            const waterLevel = availableWater < (requiredWater * 0.7) ? 'alert' : (availableWater < requiredWater ? 'attention' : 'normal');
            snapshot.push({
                sensor: 'acqua',
                sensorLabel: t(sensorData.acqua.nome),
                sensorType: 'acqua',
                sensorSubtype: SENSOR_SUBTYPE_MAP.water.availability,
                param: 'availability',
                label: `${t('available')} / ${t('need')}`,
                value: availableWater,
                unit: t('ton'),
                level: waterLevel,
                optimalMin: requiredWater,
                optimalMax: null,
                crop: cropLabel,
                title: `${t(sensorData.acqua.nome)} • ${cropLabel}`,
                description: `${t('need')}: ${Math.round(requiredWater).toLocaleString()} ${t('ton')}`
            });

            return snapshot;
        }

        async function syncDashboardAlarmEvents() {
            if (!isAuthenticated() || !isCustomerRole(currentRole) || currentView !== 'demo' || !hasCustomerPermission('acknowledge_alerts')) {
                return;
            }

            const events = buildDashboardAlertSnapshot().map((event) => ({
                sensorType: event.sensorType,
                sensorSubtype: event.sensorSubtype,
                param: event.param,
                level: event.level,
                value: event.value,
                optimalMin: event.optimalMin,
                optimalMax: event.optimalMax,
                crop: event.crop
            }));

            const signature = JSON.stringify(events);
            const now = Date.now();
            if (signature === lastAlarmSyncSignature && (now - lastAlarmSyncAt) < 60000) {
                return;
            }

            lastAlarmSyncSignature = signature;
            lastAlarmSyncAt = now;

            try {
                await fetch(`${CONFIG.API_BASE_URL}/sensors/alarm-events/sync`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                    },
                    body: JSON.stringify({ events })
                });
            } catch (error) {
                // noop: local UI alerts stay available even if sync is unavailable
            }
        }

        function renderActiveAlertFeed(sensorFilter = null) {
            const relevantAlerts = activeAlerts.filter((alert) => !sensorFilter || alert.sensor === sensorFilter);
            if (!relevantAlerts.length) {
                return '';
            }

            return `
                <section class="rayat-dashboard-alert-feed">
                    <div class="flex items-center justify-between gap-4 mb-5">
                        <div>
                            <p class="text-[11px] font-black uppercase tracking-[0.28em] text-slate-400">${t('activeAlertsTitle')}</p>
                            <h5 class="text-2xl font-black text-slate-900">${t('activeAlertsSubtitle')}</h5>
                        </div>
                        <span class="text-sm font-bold text-slate-500">${relevantAlerts.length}</span>
                    </div>
                    <div class="space-y-3">
                        ${relevantAlerts.slice(0, 4).map((alert) => `
                            <button onclick="setSensor('${alert.sensor}')" class="w-full text-left bg-white/90 border border-white rounded-2xl px-4 py-4 shadow-sm transition hover:shadow-md">
                                <div class="flex items-start justify-between gap-4">
                                    <div>
                                        <p class="font-black text-slate-900">${escapeHtml(alert.title)}</p>
                                        <p class="text-sm text-slate-500 mt-1">${escapeHtml(alert.description)}</p>
                                    </div>
                                    <span class="text-xs font-black uppercase tracking-[0.16em] ${alert.level === 'alert' ? 'text-red-600' : 'text-amber-600'}">${getAlertBadgeLabel(alert.level)}</span>
                                </div>
                            </button>
                        `).join('')}
                    </div>
                </section>
            `;
        }

        // --- Historical Data ---

        let filterState = {
            period: '7d',
            customStart: null,
            customEnd: null
        };
        let historyTablePage = 1;
        let historyState = {
            loading: false,
            error: false,
            usesLiveData: false,
            lastLoadedAt: 0,
            requestKey: ''
        };

        const HISTORY_FIELD_MAP = {
            energia_consumption: 'energia',
            acqua_level: 'acqua',
            clima_temperature: 'climaTemp',
            clima_humidity: 'humidity',
            clima_co2: 'co2',
            clima_wind: 'windSpeed',
            clima_wind_speed: 'windSpeed',
            terreno_temperature: 'temperature',
            terreno_moisture: 'terreno',
            terreno_ec: 'ec',
            terreno_ph: 'pH',
            terreno_n: 'nitrogen',
            terreno_nitrogen: 'nitrogen',
            terreno_p: 'phosphorus',
            terreno_phosphorus: 'phosphorus',
            terreno_k: 'potassium',
            terreno_potassium: 'potassium'
        };
        const DEMO_HISTORY_PLACEHOLDERS = {
            energia: [12.4, 12.6, 12.8, 13.0, 12.9, 13.2, 13.3, 13.1, 12.9, 12.8, 12.7, 12.9],
            acqua: [3.6, 3.7, 3.9, 4.0, 4.1, 4.0, 3.9, 4.1, 4.2, 4.0, 3.8, 3.9]
        };

        function createHistoryRow(date) {
            return {
                date,
                energia: null,
                acqua: null,
                climaTemp: null,
                humidity: null,
                co2: null,
                windSpeed: null,
                temperature: null,
                terreno: null,
                ec: null,
                pH: null,
                nitrogen: null,
                phosphorus: null,
                potassium: null,
                status: 'statusNormal'
            };
        }

        function applyHistoryReading(row, reading) {
            const field = HISTORY_FIELD_MAP[reading.subtype];
            if (!field) {
                return row;
            }

            row[field] = parseNumericValue(reading.value);
            return row;
        }

        function getHistoryBucketKey(date) {
            const bucket = new Date(date);
            bucket.setSeconds(0, 0);
            return bucket.toISOString();
        }

        function normalizeHistoryRows(records = []) {
            const grouped = new Map();

            records.forEach((reading) => {
                if (!reading || !reading.timestamp) {
                    return;
                }

                const date = new Date(reading.timestamp);
                if (Number.isNaN(date.getTime())) {
                    return;
                }

                const key = getHistoryBucketKey(date);
                const row = grouped.get(key) || createHistoryRow(new Date(key));
                applyHistoryReading(row, reading);
                grouped.set(key, row);
            });

            return Array.from(grouped.values()).map((row) => normalizeSoilHistoryRow(row));
        }

        function shouldUseDemoPlaceholderHistory(sensorKey = selectedSensor) {
            return !isAuthenticated() && (sensorKey === 'energia' || sensorKey === 'acqua');
        }

        function hasRenderableHistoryValue(row, sensorKey = selectedSensor) {
            if (!row) {
                return false;
            }

            if (sensorKey === 'energia') {
                return Number.isFinite(parseNumericValue(row.energia));
            }

            if (sensorKey === 'acqua') {
                return Number.isFinite(parseNumericValue(row.acqua));
            }

            return true;
        }

        function buildDemoPlaceholderHistoryRows(sensorKey = selectedSensor) {
            if (!shouldUseDemoPlaceholderHistory(sensorKey)) {
                return [];
            }

            const series = DEMO_HISTORY_PLACEHOLDERS[sensorKey];
            if (!Array.isArray(series) || !series.length) {
                return [];
            }

            const { start, end } = getFilterRange();
            const startMs = start.getTime();
            const spanMs = Math.max(end.getTime() - startMs, 0);

            return series.map((value, index) => {
                const ratio = series.length === 1 ? 1 : index / (series.length - 1);
                const row = createHistoryRow(new Date(startMs + Math.round(spanMs * ratio)));
                row[sensorKey] = value;
                return row;
            });
        }

        function resolveHistoryRows(records = [], sensorKey = selectedSensor) {
            const normalizedRows = normalizeHistoryRows(records);
            const hasRenderableRows = normalizedRows.some((row) => hasRenderableHistoryValue(row, sensorKey));
            const usePlaceholder = !hasRenderableRows && shouldUseDemoPlaceholderHistory(sensorKey);

            return {
                rows: usePlaceholder ? buildDemoPlaceholderHistoryRows(sensorKey) : normalizedRows,
                usesLiveData: hasRenderableRows
            };
        }

        function getFilterRange() {
            const now = new Date();

            if (filterState.period === 'custom' && filterState.customStart && filterState.customEnd) {
                return {
                    start: new Date(filterState.customStart),
                    end: new Date(filterState.customEnd)
                };
            }

            const end = new Date(now);
            const start = new Date(now);

            if (filterState.period === '24h') {
                start.setHours(start.getHours() - 24);
            } else if (filterState.period === '7d') {
                start.setDate(start.getDate() - 7);
            } else if (filterState.period === '90d') {
                start.setDate(start.getDate() - 90);
            } else {
                start.setDate(start.getDate() - 30);
            }

            return { start, end };
        }

        function buildHistoryQueryParams() {
            const params = new URLSearchParams();

            if (filterState.period === '24h') {
                params.set('hours', '24');
            } else if (filterState.period === '7d') {
                params.set('days', '7');
            } else if (filterState.period === '30d') {
                params.set('days', '30');
            } else if (filterState.period === '90d') {
                params.set('days', '90');
            } else if (filterState.period === 'custom' && filterState.customStart && filterState.customEnd) {
                params.set('start', filterState.customStart.toISOString());
                params.set('end', filterState.customEnd.toISOString());
            }

            return params;
        }

        async function loadHistoryData(options = {}) {
            const targetView = options.view || currentView;
            if (!shouldLoadHistoryDataForView(targetView)) {
                return false;
            }
            const privateSensorAuthToken = getPrivateSensorAuthToken();

            const requestKey = [
                privateSensorAuthToken ? 'private' : 'public',
                selectedSensor,
                buildHistoryQueryParams().toString()
            ].join(':');

            if (!options.force && activeHistoryLoadPromise && historyState.requestKey === requestKey) {
                return activeHistoryLoadPromise;
            }

            historyState.loading = true;
            historyState.error = false;
            historyState.requestKey = requestKey;

            const historyPromise = (async () => {
                const params = buildHistoryQueryParams();
                let shouldRenderHistory = false;

                try {
                    let response;

                    if (privateSensorAuthToken) {
                        response = await fetch(`${CONFIG.API_BASE_URL}/sensors/${selectedSensor}/history?${params.toString()}`, {
                            headers: { 'Authorization': `Bearer ${privateSensorAuthToken}` },
                            cache: 'no-store'
                        });
                    } else {
                        params.set('type', selectedSensor);
                        response = await fetch(`${CONFIG.API_BASE_URL}/sensors/public/history?${params.toString()}`, {
                            cache: 'no-store'
                        });
                    }

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const result = await response.json();
                    if (historyState.requestKey !== requestKey) {
                        return false;
                    }
                    const resolvedHistory = resolveHistoryRows(Array.isArray(result.data) ? result.data : [], selectedSensor);
                    globalHistory = resolvedHistory.rows;
                    historyState.usesLiveData = resolvedHistory.usesLiveData;
                    historyState.lastLoadedAt = Date.now();
                    shouldRenderHistory = true;
                } catch (error) {
                    if (historyState.requestKey !== requestKey) {
                        return false;
                    }
                    historyState.error = true;
                    if (shouldUseDemoPlaceholderHistory(selectedSensor)) {
                        globalHistory = buildDemoPlaceholderHistoryRows(selectedSensor);
                        historyState.usesLiveData = false;
                        historyState.lastLoadedAt = Date.now();
                    } else if (!historyState.usesLiveData) {
                        globalHistory = [];
                    }
                    shouldRenderHistory = true;
                } finally {
                    if (historyState.requestKey === requestKey) {
                        historyState.loading = false;
                    }
                }

                if (shouldRenderHistory) {
                    render();
                }

                return shouldRenderHistory;
            })();

            activeHistoryLoadPromise = historyPromise;

            try {
                return await historyPromise;
            } finally {
                if (activeHistoryLoadPromise === historyPromise) {
                    activeHistoryLoadPromise = null;
                }
            }
        }

        async function setFilterPeriod(period) {
            if (!['24h', '7d', '30d', '90d', 'custom'].includes(period)) {
                return;
            }

            if (period === 'custom' && !(filterState.customStart && filterState.customEnd)) {
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - 7);
                filterState.customStart = startDate;
                filterState.customEnd = endDate;
            }

            filterState.period = period;
            historyTablePage = 1;
            await loadHistoryData();
        }

        async function setCustomFilter() {
            const startInput = document.getElementById('startDate');
            const endInput = document.getElementById('endDate');
            const start = startInput?.value;
            const end = endInput?.value;

            if (!(start && end)) {
                return;
            }

            const startDate = new Date(`${start}T00:00:00`);
            const endDate = new Date(`${end}T23:59:59.999`);

            if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
                alert('Intervallo date non valido.');
                return;
            }

            if (endDate < startDate) {
                alert('La data di fine non può essere precedente alla data di inizio.');
                return;
            }

            filterState.period = 'custom';
            filterState.customStart = startDate;
            filterState.customEnd = endDate;
            historyTablePage = 1;
            await loadHistoryData();
        }

        function setHistoryTablePage(page) {
            const nextPage = Number(page);
            if (!Number.isFinite(nextPage) || nextPage < 1) {
                return;
            }

            historyTablePage = Math.floor(nextPage);
            render();
        }

        function getFilteredHistory() {
            if (!globalHistory.length) {
                return [];
            }

            const { start, end } = getFilterRange();
            return globalHistory.filter((entry) => entry.date >= start && entry.date <= end);
        }

        function formatHistoryNumber(value, { group = null, key = null } = {}) {
            if (group && key) {
                const normalized = normalizeMetricValue(group, key, value);
                return Number.isFinite(normalized) ? formatMetricValue(normalized) : '--';
            }

            const numeric = parseNumericValue(value);
            return Number.isFinite(numeric) ? formatMetricValue(numeric) : '--';
        }

        function exportCSV() {
            if (isAuthenticated() && isCustomerRole(currentRole) && !hasCustomerPermission('export_csv')) {
                return;
            }

            const data = getFilteredHistory();
            if (!data.length) {
                return;
            }

            const csvRows = [];

            if (selectedSensor === 'energia') {
                csvRows.push(['Date', 'Time', 'Energy (kW)']);
                data.forEach((row) => {
                    csvRows.push([
                        formatLocalizedDate(row.date),
                        formatLocalizedTime(row.date),
                        formatHistoryNumber(row.energia)
                    ]);
                });
            } else if (selectedSensor === 'acqua') {
                csvRows.push(['Date', 'Time', 'Water (m)']);
                data.forEach((row) => {
                    csvRows.push([
                        formatLocalizedDate(row.date),
                        formatLocalizedTime(row.date),
                        formatHistoryNumber(row.acqua)
                    ]);
                });
            } else if (selectedSensor === 'terreno') {
                csvRows.push(['Date', 'Time', 'Soil Temp', 'Soil Humidity', 'EC', 'N', 'P', 'K', 'pH']);
                data.forEach((row) => {
                    csvRows.push([
                        formatLocalizedDate(row.date),
                        formatLocalizedTime(row.date),
                        formatHistoryNumber(row.temperature, { group: 'soil', key: 'temperature' }),
                        formatHistoryNumber(row.terreno, { group: 'soil', key: 'moisture' }),
                        formatHistoryNumber(row.ec, { group: 'soil', key: 'ec' }),
                        formatHistoryNumber(row.nitrogen, { group: 'soil', key: 'nitrogen' }),
                        formatHistoryNumber(row.phosphorus, { group: 'soil', key: 'phosphorus' }),
                        formatHistoryNumber(row.potassium, { group: 'soil', key: 'potassium' }),
                        formatHistoryNumber(row.pH, { group: 'soil', key: 'pH' })
                    ]);
                });
            } else if (selectedSensor === 'clima') {
                csvRows.push(['Date', 'Time', 'Air Temp', 'Humidity', 'CO2', 'Wind']);
                data.forEach((row) => {
                    csvRows.push([
                        formatLocalizedDate(row.date),
                        formatLocalizedTime(row.date),
                        formatHistoryNumber(row.climaTemp, { group: 'climate', key: 'temperature' }),
                        formatHistoryNumber(row.humidity, { group: 'climate', key: 'humidity' }),
                        formatHistoryNumber(row.co2, { group: 'climate', key: 'co2' }),
                        formatHistoryNumber(row.windSpeed, { group: 'climate', key: 'windSpeed' })
                    ]);
                });
            }

            const csvString = csvRows.map((entry) => entry.join(',')).join('\n');
            const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', `rayat_${selectedSensor}_history.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        /* --- Navigation & Auth Helpers --- */

        // RAYAT FIX - login/profile/final UX cleanup
        async function login(e) {
            e.preventDefault();
            const email = document.getElementById('email').value.trim().toLowerCase();
            const password = document.getElementById('password').value.trim();
            const remember = Boolean(document.getElementById('remember-me')?.checked);

            document.getElementById('error').classList.add('hidden');

            // Chiamata API reale per tutti gli utenti
            try {
                const response = await fetch(`${CONFIG.API_BASE_URL}/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();

                if (response.ok && data.token) {
                    authToken = data.token;
                    user = data.user;
                    currentRole = user.role || 'client';
                    persistPublicSession(authToken, user, { remember });
                    syncStoredUserProfileIntoSession();
                    syncSubscriptionUiState();
                    hideSubscriptionExpiredModal();

                    if (window.Capacitor && window.Capacitor.Plugins.Haptics) {
                        await window.Capacitor.Plugins.Haptics.notification({ type: 'success' });
                    }

                    if (user.role === 'super_admin' || user.role === 'operator_admin' || user.role === 'operator' || user.role === 'admin') {
                        // Store token in sessionStorage under admin panel keys → no second login needed
                        sessionStorage.setItem(ADMIN_AUTH_TOKEN_STORAGE_KEY, data.token);
                        sessionStorage.setItem(ADMIN_AUTH_USER_STORAGE_KEY, JSON.stringify(data.user));
                        syncStoredAdminSessionIntoState();
                        goToAdminArea();
                    } else {
                        setView(isBarakahPerliteCustomer(user) ? 'perlite-track' : 'demo');
                    }
                } else {
                    const errorEl = document.getElementById('error');
                    errorEl.classList.remove('hidden');
                    if (data && data.error) errorEl.innerText = data.error;
                }
            } catch (err) {
                console.error("Login error:", err);
                document.getElementById('error').classList.remove('hidden');
            }
        }

        async function requestPasswordReset() {
            const email = document.getElementById('email')?.value.trim().toLowerCase();

            if (!email) {
                alert(t('forgotPasswordEmailRequired'));
                return;
            }

            try {
                const response = await fetch(`${CONFIG.API_BASE_URL}/auth/forgot-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });

                const data = await response.json();
                if (!response.ok) {
                    alert(data.error || t('forgotPasswordSuccess'));
                    return;
                }

                alert(data.message || t('forgotPasswordSuccess'));
            } catch (error) {
                console.error('Forgot password request error:', error);
                alert(t('forgotPasswordSuccess'));
            }
        }

        async function submitPasswordReset(e) {
            e.preventDefault();

            const params = new URLSearchParams(window.location.search);
            const token = params.get('token');
            const password = document.getElementById('reset-password')?.value || '';
            const confirmPassword = document.getElementById('reset-password-confirm')?.value || '';
            const errorBox = document.getElementById('reset-password-error');
            const successBox = document.getElementById('reset-password-success');

            errorBox?.classList.add('hidden');
            successBox?.classList.add('hidden');

            if (!token) {
                errorBox?.classList.remove('hidden');
                if (errorBox) {
                    errorBox.innerText = t('resetPasswordInvalidToken');
                }
                return;
            }

            if (password !== confirmPassword) {
                errorBox?.classList.remove('hidden');
                if (errorBox) {
                    errorBox.innerText = t('resetPasswordMismatch');
                }
                return;
            }

            try {
                const response = await fetch(`${CONFIG.API_BASE_URL}/auth/reset-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token,
                        newPassword: password
                    })
                });

                const data = await response.json();
                if (!response.ok) {
                    errorBox?.classList.remove('hidden');
                    if (errorBox) {
                        errorBox.innerText = data.error || t('resetPasswordInvalidToken');
                    }
                    return;
                }

                successBox?.classList.remove('hidden');
                if (successBox) {
                    successBox.innerText = data.message || t('resetPasswordSuccess');
                }

                document.getElementById('reset-password-form')?.reset();
                window.setTimeout(() => {
                    setView('login', { replace: true, path: '/login' });
                }, 1500);
            } catch (error) {
                console.error('Reset password error:', error);
                errorBox?.classList.remove('hidden');
                if (errorBox) {
                    errorBox.innerText = t('resetPasswordInvalidToken');
                }
            }
        }

        async function deleteAccount() {
            if (!confirm(t('confirmDelete'))) return;

            try {
                const response = await fetch(`${CONFIG.API_BASE_URL}/auth/delete`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${authToken}` }
                });

                // Capacitor: Call Haptics for feedback
                if (window.Capacitor && window.Capacitor.Plugins.Haptics) {
                    await window.Capacitor.Plugins.Haptics.notification({ type: 'warning' });
                }

                alert('Account eliminato correttamente.');
                logout();
            } catch (error) {
                console.error('Delete account error:', error);
                // Even on error, we log out and clear local data to satisfy review
                logout();
            }
        }

        function logout() {
            closeProfileMenu();
            toggleMobileMenu(false);
            clearPublicSession();
            setView('home', { replace: true });
        }

        function setView(view, options = {}) {
            view = normalizePublicDashboardView(view);
            closeProfileMenu();

            if (view === 'profilo') {
                if (isAuthenticated() && isCustomerRole(currentRole)) {
                    // allow through
                } else if (hasPrivilegedAdminShortcut()) {
                    goToAdminArea();
                    return;
                } else {
                    setView('login', { replace: true, path: '/login' });
                    return;
                }
            }

            if (view === 'perlite-track' && !canAccessPerliteTrack()) {
                if (hasPrivilegedAdminShortcut()) {
                    goToAdminArea();
                } else {
                    setView('login', { replace: true, path: '/login' });
                }
                return;
            }

            if (view !== 'profilo') {
                userProfileNotice = '';
            }

            const nextPath = options.path || getPathForView(view);
            isMobileMenuOpen = false;
            syncPageScrollLock();

            // Mobile UX: Update history for back button handling
            if (currentView !== view || window.location.pathname !== nextPath) {
                const historyMethod = options.replace ? 'replaceState' : 'pushState';
                history[historyMethod]({ view: view }, '', nextPath);
            }
            currentView = view;
            if (view !== 'demo' && view !== 'perlite-track') {
                hideSubscriptionExpiredModal();
            }
            render();
            trackPageView(view);
            if (view === 'register') {
                trackRegistrationStart(view);
            }
            requestViewData(view);
            window.scrollTo({ top: 0, behavior: 'instant' });

            // Re-initialize maps for specific views
            if (view === 'home') setTimeout(initHomeMap, 100);
            if (view === 'contatti') setTimeout(initContactMap, 100);
        }

        async function setSensor(sensor) {
            const normalizedSensorKey = normalizeDashboardSensorKey(sensor);
            if (!normalizedSensorKey) {
                return;
            }

            selectedSensor = normalizedSensorKey;
            if (currentView === 'demo') {
                const nextPath = getDashboardPathForSensor(normalizedSensorKey);
                if (window.location.pathname !== nextPath) {
                    history.pushState({ view: 'demo' }, '', nextPath);
                }
            }
            render();
            if (currentView === 'demo' || (isAuthenticated() && isCustomerRole(currentRole))) {
                await loadHistoryData();
            }
            // removed setSensor chart logic
        }

        // removed initWaterChart function


        // --- Data Validation & Outlier Filtering ---
        const sensorLimits = {
            'terreno_moisture': { min: 1, max: 100 },
            'terreno_ph': { min: 3, max: 10 },
            'clima_temperature': { min: -10, max: 55 },
            'clima_humidity': { min: 5, max: 100 }
        };

        function isOutlier(subtype, value) {
            const limits = sensorLimits[subtype];
            if (limits) {
                if (value < limits.min || value > limits.max) return true;
            }
            // Add custom logic for sudden spikes if needed
            return false;
        }

        /* --- API Data Loading --- */

        async function loadSensorData(options = {}) {
            const targetView = options.view || currentView;
            if (!shouldLoadSensorDataForView(targetView)) {
                return false;
            }

            const privateSensorAuthToken = getPrivateSensorAuthToken();
            const requestScope = privateSensorAuthToken ? 'private' : 'public';

            if (requestScope === 'skip') {
                hideSubscriptionExpiredModal();
                dataError = false;
                return false;
            }

            if (!options.force && activeSensorLoadPromise && activeSensorLoadScope === requestScope) {
                return activeSensorLoadPromise;
            }

            // Always ensure we have some data to show (Demo Mode)
            if (globalHistory.length === 0) {
                generateSimulationData();
                resetLiveSensorDisplayData();
            }

            const sensorPromise = (async () => {
                if (requestScope === 'public') {
                    hideSubscriptionExpiredModal();
                    try {
                        const [sensorResponse, gatewayStatusResult] = await Promise.allSettled([ // RAYAT-FIX
                            fetch(`${CONFIG.PUBLIC_LATEST_URL}?t=${Date.now()}`, { cache: 'no-store' }), // RAYAT-FIX
                            fetchGatewayStatusPayload('public') // RAYAT-FIX
                        ]); // RAYAT-FIX
                        const gatewayStatusChanged = gatewayStatusResult.status === 'fulfilled' // RAYAT-FIX
                            ? applyGatewayStatusResponse(gatewayStatusResult.value) // RAYAT-FIX
                            : applyGatewayStatusResponse(null); // RAYAT-FIX
                        if (sensorResponse.status === 'fulfilled' && sensorResponse.value.ok) { // RAYAT-FIX
                            const result = await sensorResponse.value.json(); // RAYAT-FIX
                            if (result.success && Array.isArray(result.data)) { // RAYAT-FIX
                                const data = filterPublicSensorPayloadRows(result.data); // RAYAT-FIX
                                const monitoring = applyMonitoringConfig(result.monitoring); // RAYAT-FIX
                                writeSensorCache(PUBLIC_SENSOR_CACHE_KEY, data, monitoring); // RAYAT-FIX
                                const didRender = updateSensorData(data, true); // RAYAT-FIX
                                dataError = false; // RAYAT-FIX
                                setOfflineBannerVisibility(false); // RAYAT-FIX
                                if (!didRender && gatewayStatusChanged) { // RAYAT-FIX
                                    render(); // RAYAT-FIX
                                } // RAYAT-FIX
                                return didRender || gatewayStatusChanged; // RAYAT-FIX
                            } // RAYAT-FIX
                        } // RAYAT-FIX
                    } catch (error) { }

                    const cached = readSensorCache(PUBLIC_SENSOR_CACHE_KEY);
                    if (cached?.data) {
                        const hadGatewayState = Boolean(gatewayStatusSignature); // RAYAT-FIX
                        resetGatewayStatusState(); // RAYAT-FIX
                        applyMonitoringConfig(cached.monitoring); // RAYAT-FIX
                        const didRender = updateSensorData(filterPublicSensorPayloadRows(cached.data), true); // RAYAT-FIX
                        dataError = false; // RAYAT-FIX
                        setOfflineBannerVisibility(true, t('usingCache')); // RAYAT-FIX
                        if (!didRender && hadGatewayState) { // RAYAT-FIX
                            render(); // RAYAT-FIX
                        } // RAYAT-FIX
                        return didRender || hadGatewayState; // RAYAT-FIX
                    }

                    const hadRenderedData = Boolean(lastSensorPayloadSignature);
                    const hadGatewayState = Boolean(gatewayStatusSignature); // RAYAT-FIX
                    lastSensorPayloadSignature = '';
                    resetSensorConnectionState();
                    resetLiveSensorDisplayData();
                    resetGatewayStatusState(); // RAYAT-FIX
                    dataError = false;
                    if (hadRenderedData || hadGatewayState) { // RAYAT-FIX
                        render();
                    }
                    return hadRenderedData || hadGatewayState; // RAYAT-FIX
                }

                if (subscriptionUiState.expired) {
                    if (!subscriptionUiState.dismissed) {
                        showSubscriptionExpiredModal();
                    }
                    return false;
                }

                try {
                    const [sensorResponse, gatewayStatusResult] = await Promise.allSettled([ // RAYAT-FIX
                        fetch(`${CONFIG.API_BASE_URL}/sensors/latest`, { headers: { 'Authorization': `Bearer ${privateSensorAuthToken}` } }), // RAYAT-FIX
                        fetchGatewayStatusPayload('private', privateSensorAuthToken) // RAYAT-FIX
                    ]); // RAYAT-FIX
                    const gatewayStatusChanged = gatewayStatusResult.status === 'fulfilled' // RAYAT-FIX
                        ? applyGatewayStatusResponse(gatewayStatusResult.value) // RAYAT-FIX
                        : applyGatewayStatusResponse(null); // RAYAT-FIX

                    if (sensorResponse.status !== 'fulfilled') { // RAYAT-FIX
                        throw new Error('sensor_fetch_failed'); // RAYAT-FIX
                    } // RAYAT-FIX

                    const response = sensorResponse.value; // RAYAT-FIX

                    if (response.status === 401 || response.status === 403) {
                        const errorData = await response.json().catch(() => ({}));
                        if (response.status === 403 && errorData.error === 'subscription_expired' && user && isCustomerRole(currentRole)) {
                            subscriptionUiState = {
                                ...subscriptionUiState,
                                expired: true,
                                expiringSoon: false,
                                dismissed: false
                            };
                            showSubscriptionExpiredModal();
                            return false;
                        }

                        clearPublicSession({ keepCurrentView: true });
                        return false;
                    }

                    if (response.ok) {
                        const result = await response.json();
                        if (result.success && Array.isArray(result.data)) {
                            const monitoring = applyMonitoringConfig(result.monitoring);
                            writeSensorCache(PRIVATE_SENSOR_CACHE_KEY, result.data, monitoring);
                            const didRender = updateSensorData(result.data);
                            dataError = false;
                            setOfflineBannerVisibility(false);
                            if (!didRender && gatewayStatusChanged) { // RAYAT-FIX
                                render(); // RAYAT-FIX
                            } // RAYAT-FIX
                            return didRender || gatewayStatusChanged; // RAYAT-FIX
                        }
                    }
                } catch (error) { }

                dataError = false;

                const cached = readSensorCache(PRIVATE_SENSOR_CACHE_KEY);
                if (cached?.data) {
                    const hadGatewayState = Boolean(gatewayStatusSignature); // RAYAT-FIX
                    resetGatewayStatusState(); // RAYAT-FIX
                    applyMonitoringConfig(cached.monitoring);
                    const didRender = updateSensorData(cached.data, true);
                    dataError = false;
                    setOfflineBannerVisibility(true, t('usingCache'));
                    if (!didRender && hadGatewayState) { // RAYAT-FIX
                        render(); // RAYAT-FIX
                    } // RAYAT-FIX
                    return didRender || hadGatewayState; // RAYAT-FIX
                }

                const hadRenderedData = Boolean(lastSensorPayloadSignature);
                const hadGatewayState = Boolean(gatewayStatusSignature); // RAYAT-FIX
                lastSensorPayloadSignature = '';
                resetSensorConnectionState();
                resetLiveSensorDisplayData();
                resetGatewayStatusState(); // RAYAT-FIX
                if (hadRenderedData || hadGatewayState) { // RAYAT-FIX
                    render();
                }
                return hadRenderedData || hadGatewayState; // RAYAT-FIX
            })();

            activeSensorLoadPromise = sensorPromise;
            activeSensorLoadScope = requestScope;

            try {
                return await sensorPromise;
            } finally {
                if (activeSensorLoadPromise === sensorPromise) {
                    activeSensorLoadPromise = null;
                    activeSensorLoadScope = '';
                }
            }
        }

        // RAYAT FIX - refresh header button shared across demo/live monitoring
        async function refreshData() {
            if (activeRefreshPromise) {
                return activeRefreshPromise;
            }

            isRefreshingData = true;
            render();

            activeRefreshPromise = (async () => {
                try {
                    if (!isAuthenticated() || !isCustomerRole(currentRole)) {
                        await loadSensorData();
                        await loadHistoryData();
                        await new Promise((resolve) => setTimeout(resolve, 3400));
                        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                        return;
                    }

                    await loadSensorData();
                    await loadHistoryData();
                    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                } finally {
                    isRefreshingData = false;
                    activeRefreshPromise = null;
                    render();
                }
            })();

            return activeRefreshPromise;
        }

        function buildSensorPayloadSignature(apiData = []) {
            if (!Array.isArray(apiData) || !apiData.length) {
                return '';
            }

            return apiData
                .filter(Boolean)
                .map((reading) => {
                    const numericValue = parseNumericValue(reading.value);
                    return [
                        reading.type || '',
                        reading.subtype || '',
                        Number.isFinite(numericValue) ? numericValue : '',
                        reading.unit || '',
                        resolveSensorOnlineStatus(reading),
                        reading.device_name || '',
                        reading.name || ''
                    ].join(':');
                })
                .sort()
                .join('|');
        }

        function updateSensorData(apiData, fromCache = false) {
            if (!apiData || !Array.isArray(apiData)) return;
            const scopedApiData = (isAuthenticated() || hasPrivilegedAdminShortcut())
                ? apiData
                : filterPublicSensorPayloadRows(apiData);
            const normalizedApiData = normalizeSoilApiPayloadRows(scopedApiData, { includeTimestamp: true });
            if (typeof captureLuxuryHomeLiveSamples === 'function') {
                captureLuxuryHomeLiveSamples(normalizedApiData);
            }
            latestAssignedSensors = buildProfileSensorSnapshot(normalizedApiData);
            const nextPayloadSignature = buildSensorPayloadSignature(normalizedApiData);

            const typeMap = {
                'energia_consumption': { s: 'energia', val: true },
                'acqua_level': { s: 'acqua', val: true },
                'terreno_moisture': { s: 'terreno', val: true, key: 'moisture' },
                'terreno_temperature': { s: 'terreno', key: 'temperature' },
                'terreno_ec': { s: 'terreno', key: 'ec' },
                'terreno_ph': { s: 'terreno', key: 'pH' },
                'terreno_n': { s: 'terreno', key: 'nitrogen' },
                'terreno_nitrogen': { s: 'terreno', key: 'nitrogen' },
                'terreno_p': { s: 'terreno', key: 'phosphorus' },
                'terreno_phosphorus': { s: 'terreno', key: 'phosphorus' },
                'terreno_k': { s: 'terreno', key: 'potassium' },
                'terreno_potassium': { s: 'terreno', key: 'potassium' },
                'clima_temperature': { s: 'clima', val: true, key: 'temperature' },
                'clima_humidity': { s: 'clima', key: 'humidity' },
                'clima_co2': { s: 'clima', key: 'co2' },
                'clima_wind': { s: 'clima', key: 'windSpeed' },
                'clima_wind_speed': { s: 'clima', key: 'windSpeed' }
            };
            resetLiveSensorDisplayData();
            resetSensorConnectionState();
            resetSensorLatestTimestamps();

            let updated = false;
            normalizedApiData.forEach(r => {
                if (r?.type && sensorConnectionState[r.type] !== 'online') {
                    sensorConnectionState[r.type] = resolveSensorOnlineStatus(r);
                }
                if (r?.type && r?.timestamp) {
                    updateSensorTimestamp(r.type, r.timestamp);
                }
                if (!r || r.value === undefined || r.value === null) return;

                if (isOutlier(r.subtype, r.value)) {
                    return;
                }

                const m = typeMap[r.subtype];
                if (!m) return;
                const s = sensorData[m.s];
                if (!s) return;

                const val = parseFloat(r.value);
                if (isNaN(val)) return;

                if (m.val) {
                    s.valore = val;
                    s.percentuale = Math.min(100, val);
                    updated = true;
                }
                if (m.key && s.details) {
                    const d = s.details.find(x => x.key === m.key);
                    if (d) { d.value = val; updated = true; }
                }
            });
            initializeSelectedSensorFromFreshestData(); // RAYAT-FIX
            if (updated) {
                if (!historyState.usesLiveData) {
                    syncCurrentSensorSnapshotToHistory(new Date());
                }
            }

            const shouldRender = nextPayloadSignature !== lastSensorPayloadSignature;
            lastSensorPayloadSignature = nextPayloadSignature;

            if (shouldRender) {
                render();
                return true;
            }

            return false;
        }

        /* --- Predictive Intelligence Logic --- */


        /* --- Alert System Logic --- */

        function checkAlerts() {
            activeAlerts = buildDashboardAlertSnapshot()
                .filter((event) => event.level !== 'normal')
                .sort((left, right) => ALERT_PRIORITY[right.level] - ALERT_PRIORITY[left.level]);

            syncDashboardAlarmEvents();
        }

        function toggleSettings() {
            if (!hasCustomerPermission('modify_settings')) {
                return;
            }
            showSettings = !showSettings;
            render();
        }

        function toggleNotifications() {
            showNotifications = !showNotifications;
            render();
        }

        function saveSettings(e) {
            e.preventDefault();
            if (!hasCustomerPermission('modify_settings')) {
                return;
            }
            alertSettings.energia.maxConsumption = parseFloat(document.getElementById('set-energy').value);
            alertSettings.acqua.minLevel = parseFloat(document.getElementById('set-water').value);
            alertSettings.terreno.minMoisture = parseFloat(document.getElementById('set-soil').value);
            alertSettings.clima.maxTemp = parseFloat(document.getElementById('set-temp-max').value);
            alertSettings.clima.minTemp = parseFloat(document.getElementById('set-temp-min').value);
            showSettings = false;

            // Capacitor: Impact Haptic
            if (window.Capacitor && window.Capacitor.Plugins.Haptics) {
                window.Capacitor.Plugins.Haptics.impact({ style: 'medium' });
            }

            checkAlerts();
            render();
        }

        function renderAlertSettings() {
            if (!showSettings) return '';

            return `
                <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
                    <div class="rayat-modal-card bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-pulse-fast">
                        <div class="bg-green-700 text-white px-6 py-4 flex justify-between items-center">
                            <h3 class="text-xl font-bold">⚙️ ${t('thresholds')}</h3>
                            <button onclick="toggleSettings()" class="text-white hover:text-gray-200">✕</button>
                        </div>
                        <form onsubmit="saveSettings(event)" class="p-6 space-y-4">
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-1">⚡ ${t('maxConsumption')}</label>
                                <input type="number" step="0.1" id="set-energy" value="${alertSettings.energia.maxConsumption}" class="w-full border rounded p-2">
                            </div>
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-1">💧 ${t('minLevel')}</label>
                                <input type="number" step="0.1" id="set-water" value="${alertSettings.acqua.minLevel}" class="w-full border rounded p-2">
                            </div>
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-1">🌱 ${t('minMoisture')}</label>
                                <input type="number" step="1" id="set-soil" value="${alertSettings.terreno.minMoisture}" class="w-full border rounded p-2">
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-sm font-bold text-gray-700 mb-1">🌡️ ${t('maxTemp')}</label>
                                    <input type="number" step="1" id="set-temp-max" value="${alertSettings.clima.maxTemp}" class="w-full border rounded p-2">
                                </div>
                                <div>
                                    <label class="block text-sm font-bold text-gray-700 mb-1">❄️ ${t('minTemp')}</label>
                                    <input type="number" step="1" id="set-temp-min" value="${alertSettings.clima.minTemp}" class="w-full border rounded p-2">
                                </div>
                            </div>
                            <div class="pt-4 space-y-3">
                                <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg transition shadow-lg">
                                    ${t('save')}
                                </button>
                                <hr class="my-4 border-gray-100">
                                <button type="button" onclick="deleteAccount()" class="w-full bg-red-50 text-red-600 hover:bg-red-100 font-bold py-3 rounded-lg transition border border-red-100 text-sm">
                                    🗑️ ${t('deleteAccount')} (Apple 5.1.1)
                                </button>
                            </div>
                        </form>
            `;
        }

        function showSubscriptionExpiredModal() {
            if (!isAuthenticated() || !isCustomerRole(currentRole) || currentView !== 'demo' || !subscriptionUiState.expired || subscriptionUiState.dismissed) {
                return;
            }

            const modal = document.getElementById('subscription-expired-modal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
                isSubscriptionModalOpen = true;
                syncPageScrollLock();

                // Hide main app visual noise
                const skel = document.getElementById('view-skeleton');
                if (skel) skel.style.display = 'none';
            }
        }

        function hideSubscriptionExpiredModal() {
            const modal = document.getElementById('subscription-expired-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }

            isSubscriptionModalOpen = false;
            syncPageScrollLock();
            const skel = document.getElementById('view-skeleton');
            if (skel) skel.style.display = '';
        }

        // RAYAT FIX - popup subscription / new customers / email
        function dismissSubscriptionExpiredModal() {
            subscriptionUiState = {
                ...subscriptionUiState,
                dismissed: true
            };
            hideSubscriptionExpiredModal();
        }

        function goToLogin() {
            clearPublicSession();
            setViewWithTracking('login', { replace: true, path: '/login' });
        }

        function continueWithoutLogin() {
            clearPublicSession();
            setView('home', { replace: true, path: '/' });
        }

        function openSupportWhatsapp() {
            trackEvent('WhatsApp Click');
            window.open(getWhatsappHref(), '_blank', 'noopener');
        }

        function renderNotifications() {
            if (!showNotifications) return '';

            return `
                <div class="absolute right-0 mt-3 w-80 bg-white rounded-xl shadow-2xl overflow-hidden z-[55] border border-gray-100 ring-1 ring-black ring-opacity-5">
                    <div class="bg-gray-50 px-4 py-2 border-b border-gray-200 font-bold text-gray-700 flex justify-between items-center">
                        <span>${t('notifications')}</span>
                        <span class="bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">${activeAlerts.length}</span>
                    </div>
                    <div class="max-h-64 overflow-y-auto">
                        ${activeAlerts.length === 0 ?
                    `<div class="p-4 text-center text-gray-500 text-sm">${t('noNotifications')}</div>` :
                    activeAlerts.map(alert => `
                                <div class="p-4 border-b border-gray-100 hover:bg-red-50 flex items-start space-x-3 cursor-pointer" onclick="setSensor('${alert.sensor}'); toggleNotifications();">
                                    <span class="text-xl">${alert.level === 'alert' ? '🚨' : '⚠️'}</span>
                                    <div>
                                        <p class="font-bold text-sm text-gray-800">${escapeHtml(alert.title || alert.label)}</p>
                                        <p class="text-xs text-gray-500 capitalize">${escapeHtml(alert.description || alert.sensorLabel || alert.sensor)}</p>
                                    </div>
                                </div>
                            `).join('')
                }
                    </div>
                </div>
            `;
        }

        function renderSubscriptionWarningBanner() {
            if (!isAuthenticated() || !isCustomerRole(currentRole) || currentView !== 'demo' || !subscriptionUiState.expiringSoon || subscriptionUiState.expired) {
                return '';
            }

            const whenText = subscriptionUiState.daysRemaining != null
                ? formatTemplate(t('subscriptionExpiringInDays'), { days: subscriptionUiState.daysRemaining })
                : t('subscriptionExpiringSoonText');
            const expiryText = subscriptionUiState.expiryDate
                ? ` ${formatTemplate(t('subscriptionExpiringOnDate'), { date: formatLocalizedDate(subscriptionUiState.expiryDate) })}`
                : '';

            return `
                <div class="rayat-soft-banner mb-8">
                    <div>
                        <p class="text-[11px] font-black uppercase tracking-[0.28em] text-amber-700">${t('subscriptionExpiringEyebrow')}</p>
                        <h4 class="text-xl font-black text-slate-900 mt-2">${t('subscriptionExpiringTitle')}</h4>
                        <p class="text-sm text-slate-600 mt-2">${formatTemplate(t('subscriptionExpiringText'), { when: `${whenText}${expiryText}`.trim() })}</p>
                    </div>
                    <button onclick="openSupportWhatsapp()" class="mt-4 inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white font-black px-5 py-3 rounded-2xl transition">${t('subscriptionSupportCta')}</button>
                </div>
            `;
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function renderHeader(isLoggedIn) {
            const flagBase = "inline-block shadow-sm rounded-sm align-middle h-[16px] w-[24px] min-w-[24px] mb-0.5 object-cover";
            const italyFlag = `<svg class="${flagBase}" viewBox="0 0 3 2" width="24" height="16"><rect width="1" height="2" fill="#009246"/><rect width="1" height="2" x="1" fill="#fff"/><rect width="1" height="2" x="2" fill="#ce2b37"/></svg>`;
            const franceFlag = `<svg class="${flagBase}" viewBox="0 0 3 2" width="24" height="16"><rect width="1" height="2" fill="#002395"/><rect width="1" height="2" x="1" fill="#fff"/><rect width="1" height="2" x="2" fill="#ed2939"/></svg>`;
            const moroccoFlag = `<svg class="${flagBase}" viewBox="0 0 3 2" width="24" height="16"><rect width="3" height="2" fill="#c1272d"/><path d="M1.5 0.6L1.8 1.4L1.1 0.9H1.9L1.2 1.4z" fill="none" stroke="#006233" stroke-width="0.1" transform="scale(0.8) translate(0.4, 0.4)"/></svg>`;
            const ukFlag = `<svg class="${flagBase}" viewBox="0 0 60 40" width="24" height="16"><clipPath id="s"><path d="M0,0 v40 h60 v-40 z"/></clipPath><path d="M0,0 v40 h60 v-40 z" fill="#012169"/><path d="M0,0 L60,40 M60,0 L0,40" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,40 M60,0 L0,40" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v40 M0,20 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v40 M0,20 h60" stroke="#C8102E" stroke-width="6"/></svg>`;
            const amazighFlag = `<svg class="${flagBase}" viewBox="0 0 90 60" width="24" height="16" xmlns="http://www.w3.org/2000/svg"><rect width="90" height="20" y="0" fill="#0099CC"/><rect width="90" height="20" y="20" fill="#99CC33"/><rect width="90" height="20" y="40" fill="#FFCC00"/><text x="45" y="48" font-size="40" fill="#CC3333" text-anchor="middle" font-family="sans-serif">ⵣ</text></svg>`;
            const canAccessProfile = isAuthenticated() && isCustomerRole(currentRole);
            const adminShortcutUser = getPrivilegedAdminSessionUser();
            const hasAdminAccessShortcut = Boolean(adminShortcutUser);
            const hasVisibleAccountState = canAccessProfile || hasAdminAccessShortcut;
            const fieldNavigationLink = hasVisibleAccountState
                ? { id: 'my-field', label: t('myFieldNav'), action: 'openPrimaryFieldExperienceFromNavigation()' }
                : null;
            const primaryLinks = [
                { id: 'home', view: 'home', label: t('luxDefNavHome') },
                { id: 'solutions', label: t('luxDefNavSolutions'), action: "navigateToRayatHomeSection('rayat-solutions')" },
                { id: 'demo-live', label: t('luxDefNavDemo'), action: "navigateToRayatHomeSection('rayat-demo-live')" },
                { id: 'how', label: t('luxDefNavHow'), action: "navigateToRayatHomeSection('rayat-how')" },
                { id: 'chi-siamo', view: 'chi-siamo', label: t('luxDefNavAbout') },
                ...(fieldNavigationLink ? [fieldNavigationLink] : []),
            ];
            /* PATCH-01 — start */
            const loginNavigationLink = !hasVisibleAccountState
                ? { id: 'login', label: t('login'), action: 'openLoginFromNavigation()', kind: 'login' }
                : null;
            const desktopLinks = loginNavigationLink ? [...primaryLinks, loginNavigationLink] : primaryLinks;
            const mobileLinks = loginNavigationLink ? [loginNavigationLink, ...primaryLinks] : [...primaryLinks];
            const getNavigationAction = (link) => link.action || (link.tracked ? `setViewWithTracking('${link.view}')` : `setView('${link.view}')`);
            const renderNavigationItem = (link, options = {}) => {
                const mobile = Boolean(options.mobile);
                const classes = mobile
                    ? [
                        'text-left',
                        'w-full',
                        'px-4',
                        'py-4',
                        'rounded-2xl',
                        'font-black',
                        'uppercase',
                        'tracking-widest',
                        'text-xs',
                        'transition',
                        'flex',
                        'items-center',
                        'gap-3',
                        link.kind === 'login'
                            ? 'bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100'
                            : 'bg-slate-50 hover:bg-green-50 text-slate-800'
                    ].join(' ')
                    : [
                        'rayat-nav-link',
                        link.id === 'chi-siamo' ? 'whitespace-nowrap' : '',
                        link.kind === 'login' ? 'rayat-nav-link--login' : ''
                    ].filter(Boolean).join(' ');

                return `
                    <button onclick="${getNavigationAction(link)}" class="${classes}">
                        ${mobile && link.kind === 'login' ? '<span class="rayat-mobile-nav-link__icon" aria-hidden="true">🔐</span>' : ''}
                        <span>${link.label}</span>
                    </button>
                `;
            };
            /* PATCH-01 — end */
            const mergedProfile = canAccessProfile ? getMergedUserProfile() : null;
            const profileDisplayName = mergedProfile?.name || user?.name || 'Rayat';
            const profileDisplayEmail = mergedProfile?.email || user?.email || '';
            const adminDisplayName = adminShortcutUser?.name || adminShortcutUser?.email || 'Rayat';
            const accountLabel = canAccessProfile
                ? t('profileNav')
                : hasAdminAccessShortcut
                    ? t('adminArea')
                    : t('login');
            const accountButton = canAccessProfile
                ? `
                    <div id="rayat-profile-menu-shell" class="rayat-profile-menu-shell ${isProfileMenuOpen ? 'is-open' : ''}">
                        <button id="rayat-profile-menu-trigger" onclick="toggleProfileMenu(event)" class="rayat-account-trigger rayat-account-trigger--menu ${canAccessProfile ? 'rayat-account-trigger--active' : ''}" aria-label="${escapeHtml(accountLabel)}" title="${escapeHtml(accountLabel)}" aria-expanded="${isProfileMenuOpen}" aria-haspopup="menu">
                            <span class="rayat-account-trigger__initials">${escapeHtml(getUserInitials(profileDisplayName))}</span>
                            <span class="rayat-account-trigger__chevron" aria-hidden="true">
                                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="m5 7 5 5 5-5"></path>
                                </svg>
                            </span>
                        </button>
                        <div id="rayat-profile-menu" class="rayat-profile-menu ${isProfileMenuOpen ? 'is-open' : ''}" role="menu">
                            <div class="rayat-profile-menu-summary">
                                <strong>${escapeHtml(profileDisplayName)}</strong>
                                <span>${escapeHtml(profileDisplayEmail)}</span>
                            </div>
                            <button type="button" onclick="openCustomerProfileOverview(event)" class="rayat-profile-menu-item" role="menuitem">
                                ${t('profileMenuInfo')}
                            </button>
                            <button type="button" onclick="openCustomerProfileEditor(event)" class="rayat-profile-menu-item" role="menuitem">
                                ${t('profileMenuEdit')}
                            </button>
                            <button type="button" onclick="logoutFromProfileMenu(event)" class="rayat-profile-menu-item rayat-profile-menu-item--logout" role="menuitem">
                                ${t('profileMenuLogout')}
                            </button>
                        </div>
                    </div>
                `
                : hasAdminAccessShortcut
                    ? `
                        <button onclick="goToAdminArea()" class="rayat-account-trigger rayat-account-trigger--menu rayat-account-trigger--active" aria-label="${escapeHtml(accountLabel)}" title="${escapeHtml(accountLabel)}">
                            <span class="rayat-account-trigger__initials">${escapeHtml(getUserInitials(adminDisplayName))}</span>
                        </button>
                    `
                : '';

            return `
                <div id="offline-banner"></div>
                ${renderAlertSettings()}
                <header class="bg-green-800 text-white py-4 sticky top-0 z-50 shadow-lg safe-area-top">
                    <div class="container mx-auto px-4">
                        <div class="flex justify-between items-center gap-4">
                            <div class="flex items-center space-x-3 cursor-pointer" onclick="setView('home')">
                                <img src="${BRAND_LOGO_WHITE}" alt="Rayat Logo"
                                     class="h-12 w-auto" />
                                <div>
                                    <h1 class="text-3xl font-black tracking-tighter text-white">RAYAT</h1>
                                    <p class="text-[10px] text-green-200 uppercase font-bold tracking-widest">${t('appSubtitle')}</p>
                                </div>
                            </div>
                            <div class="flex items-center gap-3 md:gap-4">
                                <nav class="rayat-desktop-nav items-center space-x-6 font-bold uppercase text-xs tracking-widest">
                                    ${desktopLinks.map((link) => renderNavigationItem(link)).join('')}
                                </nav>
                                <div class="relative group">
                                    <button data-lang-menu-toggle="true" onclick="toggleLangMenu(event)" class="flex items-center space-x-2 bg-green-700 hover:bg-green-600 px-3 py-1.5 rounded-xl transition text-xs border border-green-600 shadow-sm">
                                        <span class="text-sm">🌐</span>
                                        <span class="font-black">${{ it: 'IT', en: 'EN', fr: 'FR', ar: 'AR', zgh: 'ZGH' }[currentLang]}</span>
                                    </button>
                                    <div id="lang-menu" class="hidden absolute right-0 mt-3 bg-white rounded-2xl shadow-2xl py-2 w-48 z-50 border border-gray-100 overflow-hidden">
                                        ${['it', 'en', 'fr', 'ar', 'zgh'].map(lang => `
                                            <button onclick="setLanguage('${lang}')" class="w-full text-left px-4 py-3 hover:bg-green-50 flex items-center justify-between text-sm ${currentLang === lang ? 'bg-green-50 font-black text-green-700' : 'text-gray-700'}">
                                                <span class="flex items-center gap-3">
                                                    <span>${{ it: italyFlag, en: ukFlag, fr: franceFlag, ar: moroccoFlag, zgh: amazighFlag }[lang]}</span>
                                                    <span>${{ it: 'Italiano', en: 'English', fr: 'Français', ar: 'العربية', zgh: 'Amazigh' }[lang]}</span>
                                                </span>
                                                ${currentLang === lang ? '✓' : ''}
                                            </button>`).join('')}
                                    </div>
                                </div>
                                ${accountButton}
                                <button id="mobile-menu-button" type="button" class="rayat-mobile-toggle" aria-label="${t('navMenu')}" aria-expanded="${isMobileMenuOpen}" onclick="toggleMobileMenu()">
                                    ${isMobileMenuOpen ? '✕' : '☰'}
                                </button>
                            </div>
                        </div>
                    </div>
                </header>
                <div id="mobile-menu-overlay" class="rayat-mobile-overlay ${isMobileMenuOpen ? 'is-open' : 'hidden'}" onclick="toggleMobileMenu(false)">
                    <div id="mobile-menu-panel" class="rayat-mobile-panel ${isMobileMenuOpen ? 'is-open' : ''}" onclick="event.stopPropagation()">
                        <div class="flex items-start justify-between gap-4 mb-6">
                            <div>
                                <p class="text-[11px] font-black uppercase tracking-[0.28em] text-slate-400 mb-2">${t('navMenu')}</p>
                                <h3 class="text-2xl font-black text-slate-900 tracking-tight">RAYAT</h3>
                            </div>
                            <button type="button" class="text-sm font-bold text-slate-500 hover:text-slate-900" onclick="toggleMobileMenu(false)">
                                ${t('mobileMenuClose')}
                            </button>
                        </div>
                        <nav class="flex flex-col gap-2">
                            ${mobileLinks.map((link) => renderNavigationItem({
                                ...link,
                                action: link.action || `navigateFromMobileMenu('${link.view}')`
                            }, { mobile: true })).join('')}
                        </nav>
                        ${shouldShowNativeAdminLoginEntry() && !hasVisibleAccountState ? `
                            <div class="mt-6 pt-6 border-t border-slate-200">
                                <button onclick="openAdminLoginFromNavigation()" class="w-full bg-orange-500 hover:bg-orange-600 text-white py-4 rounded-2xl font-black uppercase tracking-widest text-xs">${t('adminArea')}</button>
                            </div>
                        ` : ''}
                        ${canAccessProfile ? `
                            <div class="rayat-mobile-account-card">
                                <div class="rayat-mobile-account-summary">
                                    <p class="rayat-mobile-account-label">${t('profileNav')}</p>
                                    <strong>${escapeHtml(profileDisplayName)}</strong>
                                    <span>${escapeHtml(profileDisplayEmail)}</span>
                                </div>
                                <div class="rayat-mobile-account-actions">
                                    <button type="button" onclick="openCustomerProfileOverview(event)" class="rayat-mobile-account-action">
                                        ${t('profileMenuInfo')}
                                    </button>
                                    <button type="button" onclick="openCustomerProfileEditor(event)" class="rayat-mobile-account-action">
                                        ${t('profileMenuEdit')}
                                    </button>
                                    <button type="button" onclick="logoutFromProfileMenu(event)" class="rayat-mobile-account-action rayat-mobile-account-action--logout">
                                        ${t('profileMenuLogout')}
                                    </button>
                                </div>
                            </div>
                        ` : ''}
                        ${hasAdminAccessShortcut && !canAccessProfile ? `
                            <div class="mt-6 pt-6 border-t border-slate-200">
                                <button onclick="goToAdminArea()" class="w-full bg-orange-500 hover:bg-orange-600 text-white py-4 rounded-2xl font-black uppercase tracking-widest text-xs">${t('adminArea')}</button>
                            </div>
                        ` : ''}
                    </div>
                </div>`;
        }

        function renderLuxuryDashboardIcon(kind) {
            const icons = {
                water: '<path d="M12 3.5s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" stroke="currentColor" stroke-width="1.5"></path><path d="M9 15.2c.6 1.4 1.7 2.1 3.2 2.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>',
                temperature: '<path d="M10 14.8V5.5a2 2 0 1 1 4 0v9.3a4 4 0 1 1-4 0Z" stroke="currentColor" stroke-width="1.5"></path><path d="M12 8v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>',
                leaf: '<path d="M19.5 4.5C11.8 4.8 6 8.7 6 14.2c0 3 2.1 5.3 5.2 5.3 5.5 0 8.3-6.4 8.3-15Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path><path d="M5 20c2.4-5.1 6.4-8.4 11-10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>',
                alert: '<path d="M12 4.5 20 19H4L12 4.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path><path d="M12 9.5v4.2M12 16.8h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>',
                sensor: '<path d="M12 4v5m0 6v5M4 12h5m6 0h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"></circle>',
                report: '<path d="M7 4h7l3 3v13H7V4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path><path d="M14 4v4h4M9.5 12h5M9.5 15.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>',
                trend: '<path d="M4 18 9 12.5l4 3.2L20 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><path d="M4 20h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>',
                settings: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"></circle><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>'
            };

            return `<svg class="rayat-luxury-home-dashboard-tab-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">${icons[kind] || icons.sensor}</svg>`;
        }

        function getLuxuryDashboardSoilReadings() {
            const fallbackValues = {
                moisture: 62,
                temperature: 28.5,
                ec: 1.2,
                pH: 6.3,
                nitrogen: 180,
                phosphorus: 45,
                potassium: 260
            };

            return RAYAT_DEMO_SENSOR_METRICS.map((definition) => {
                const metric = sensorData.terreno?.details?.find((detail) => detail.key === definition.key);
                const normalizedValue = normalizeMetricValue('soil', definition.key, metric?.value);
                const value = Number.isFinite(normalizedValue) ? normalizedValue : fallbackValues[definition.key];
                const range = getRangeForMetric('soil', definition.key);
                const state = getMetricState(value, range);

                return {
                    ...definition,
                    value,
                    displayValue: formatMetricValue(value),
                    unit: getMetricUnit('soil', definition.key, metric?.unit || definition.unit),
                    state
                };
            });
        }

        function captureLuxuryHomeLiveSamples(rows) {
            rows.forEach((row) => {
                const definition = RAYAT_DEMO_SENSOR_METRICS.find((metric) => (
                    metric.subtype === row.subtype || metric.objectKeys.includes(row.subtype)
                ));
                if (!definition) return;

                const value = normalizeMetricValue('soil', definition.key, row.value);
                const timestamp = new Date(row.timestamp || Date.now()).getTime();
                if (!Number.isFinite(value) || !Number.isFinite(timestamp)) return;

                const samples = luxuryHomeLiveSamples[definition.key] || [];
                const previous = samples[samples.length - 1];
                if (previous && previous.timestamp === timestamp && previous.value === value) return;

                luxuryHomeLiveSamples[definition.key] = samples.concat({ timestamp, value }).slice(-32);
            });
        }

        function getLuxuryHomeSensorRealSeries(key) {
            const collectedSamples = luxuryHomeLiveSamples[key] || [];
            if (collectedSamples.length >= 2 || !historyState.usesLiveData) {
                return collectedSamples.map((sample) => sample.value);
            }

            const metric = { group: 'soil', key };
            return globalHistory.slice(-32)
                .map((row) => getLuxuryDashboardAnalyticsValue(row, metric))
                .filter((value) => Number.isFinite(value));
        }

        function renderLuxuryHomeSensorEvidence(reading) {
            const range = getRangeForMetric('soil', reading.key);
            const bounds = range ? getGaugeBounds('soil', reading.key, range) : { min: 0, max: 100 };
            const values = getLuxuryHomeSensorRealSeries(reading.key);
            const width = 198;
            const height = 190;
            const chartLeft = 29;
            const chartRight = 191;
            const chartTop = 15;
            const chartBottom = 145;
            const normalizedValues = values.map((value) => (
                Math.max(0, Math.min(100, getMarkerPercent(value, bounds.min, bounds.max)))
            ));
            const currentPosition = Math.max(0, Math.min(100, getMarkerPercent(reading.value, bounds.min, bounds.max)));
            const hasSeries = normalizedValues.length >= 2;
            const activeValues = hasSeries ? normalizedValues : [currentPosition];
            const toX = (index) => chartLeft + (
                hasSeries ? (index / (activeValues.length - 1)) * (chartRight - chartLeft) : chartRight - chartLeft
            );
            const toY = (value) => chartBottom - ((value / 100) * (chartBottom - chartTop));
            const linePath = hasSeries
                ? activeValues.map((value, index) => `${index === 0 ? 'M' : 'L'}${toX(index).toFixed(1)} ${toY(value).toFixed(1)}`).join(' ')
                : '';
            const firstX = hasSeries ? toX(0) : chartLeft;
            const lastX = hasSeries ? toX(activeValues.length - 1) : chartRight;
            const lastY = toY(activeValues[activeValues.length - 1]);
            const areaPath = `${linePath} L${lastX.toFixed(1)} ${chartBottom} L${firstX.toFixed(1)} ${chartBottom} Z`;
            const gradientId = `rayat-luxury-live-fill-${reading.key.toLowerCase()}`;

            return `
                <div class="rayat-luxury-live-chart-frame">
                    <svg class="rayat-luxury-live-professional-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
                        <defs>
                            <linearGradient id="${gradientId}" x1="0" x2="0" y1="0" y2="1">
                                <stop offset="0%" stop-color="#4a7c59" stop-opacity="0.19"></stop>
                                <stop offset="100%" stop-color="#4a7c59" stop-opacity="0.015"></stop>
                            </linearGradient>
                        </defs>
                        ${[100, 75, 50, 25, 0].map((tick) => `
                            <text class="rayat-luxury-live-chart-axis" x="0" y="${(toY(tick) + 3).toFixed(1)}">${tick}</text>
                            <path class="rayat-luxury-live-chart-grid" d="M${chartLeft} ${toY(tick).toFixed(1)}H${chartRight}"></path>
                        `).join('')}
                        ${hasSeries ? `
                            <path class="rayat-luxury-live-chart-area" d="${areaPath}" fill="url(#${gradientId})"></path>
                            <path class="rayat-luxury-live-chart-line" d="${linePath}"></path>
                        ` : `
                            <path class="rayat-luxury-live-chart-awaiting" d="M${chartLeft} ${lastY.toFixed(1)}H${chartRight}"></path>
                        `}
                        <circle class="rayat-luxury-live-chart-point" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.7"></circle>
                        <text class="rayat-luxury-live-chart-time" x="${chartLeft}" y="177">00:00</text>
                        <text class="rayat-luxury-live-chart-time" x="${((chartLeft + chartRight) / 2).toFixed(1)}" y="177" text-anchor="middle">12:00</text>
                        <text class="rayat-luxury-live-chart-time" x="${chartRight}" y="177" text-anchor="end">24:00</text>
                    </svg>
                    ${hasSeries ? '' : `<span class="rayat-luxury-live-chart-pending">${t('luxLiveChartCollecting')}</span>`}
                </div>
            `;
        }

        function getLuxuryDashboardTimestamp() {
            const status = getDemoSectionStatusMeta('terreno');
            return {
                ...status,
                timestamp: status.timestamp === '--' ? t('luxDashboardNow') : status.timestamp
            };
        }

        function renderLuxuryDashboardTabHeader(titleKey, subtitleKey, controls = '') {
            return `
                <header class="rayat-luxury-home-dashboard-tab-header">
                    <div>
                        <h2>${t(titleKey)}</h2>
                        <p>${t(subtitleKey)}</p>
                    </div>
                    ${controls}
                </header>
            `;
        }

        function getLuxuryDashboardAnalyticsMetrics() {
            const soilLabels = {
                moisture: 'luxDashboardTrendMoisture',
                temperature: 'luxDashboardAnalyticsSoilTemperature',
                ec: 'luxDashboardAnalyticsElectricalConductivity',
                pH: 'luxDashboardAnalyticsPh',
                nitrogen: 'luxDashboardAnalyticsNitrogen',
                phosphorus: 'luxDashboardAnalyticsPhosphorus',
                potassium: 'luxDashboardAnalyticsPotassium'
            };
            const climateLabels = {
                temperature: 'luxDashboardAnalyticsAirTemperature',
                humidity: 'luxDashboardAnalyticsAirHumidity',
                co2: 'luxDashboardAnalyticsCo2',
                windSpeed: 'luxDashboardAnalyticsWindSpeed'
            };
            const soilMetrics = getLuxuryDashboardSoilReadings().map((reading) => ({
                id: `soil:${reading.key}`,
                group: 'soil',
                key: reading.key,
                labelKey: soilLabels[reading.key] || reading.labelKey,
                sourceKey: 'luxDashboardAnalyticsSoilSensor',
                reading
            }));
            const climateMetrics = (sensorData.clima?.details || []).map((detail) => {
                const value = normalizeMetricValue('climate', detail.key, detail.value);
                const range = getRangeForMetric('climate', detail.key);
                const unit = getMetricUnit('climate', detail.key, detail.unit || '');

                return {
                    id: `climate:${detail.key}`,
                    group: 'climate',
                    key: detail.key,
                    labelKey: climateLabels[detail.key] || detail.label,
                    sourceKey: 'luxDashboardAnalyticsClimateSensor',
                    reading: {
                        value,
                        displayValue: Number.isFinite(value) ? formatMetricValue(value) : '--',
                        unit,
                        state: getMetricState(value, range)
                    }
                };
            });

            return soilMetrics.concat(climateMetrics);
        }

        function getLuxuryDashboardAnalyticsValue(row, metric) {
            const historyFields = {
                soil: {
                    moisture: 'terreno',
                    temperature: 'temperature',
                    ec: 'ec',
                    pH: 'pH',
                    nitrogen: 'nitrogen',
                    phosphorus: 'phosphorus',
                    potassium: 'potassium'
                },
                climate: {
                    temperature: 'climaTemp',
                    humidity: 'humidity',
                    co2: 'co2',
                    windSpeed: 'windSpeed'
                }
            };
            const historyField = historyFields[metric.group]?.[metric.key];

            return historyField ? normalizeMetricValue(metric.group, metric.key, row[historyField]) : null;
        }

        function getLuxuryDashboardAnalyticsSeries(metric) {
            const periodMillis = {
                '24h': 24 * 60 * 60 * 1000,
                '7d': 7 * 24 * 60 * 60 * 1000,
                '30d': 30 * 24 * 60 * 60 * 1000
            }[currentLuxuryDashboardAnalyticsPeriod] || (7 * 24 * 60 * 60 * 1000);
            const availableRows = globalHistory.map((row) => ({
                date: row.date instanceof Date ? row.date : new Date(row.date),
                value: getLuxuryDashboardAnalyticsValue(row, metric)
            })).filter((row) => Number.isFinite(row.value) && !Number.isNaN(row.date.getTime()))
                .sort((left, right) => left.date - right.date);
            const lastTimestamp = availableRows.length ? availableRows[availableRows.length - 1].date.getTime() : Date.now();
            const filteredRows = availableRows.filter((row) => row.date.getTime() >= lastTimestamp - periodMillis);
            const sourceRows = filteredRows.length ? filteredRows : availableRows.slice(-1);

            if (!sourceRows.length && Number.isFinite(metric.reading.value)) {
                return [{ date: new Date(), value: metric.reading.value }];
            }

            if (!sourceRows.length) {
                return [];
            }

            const maximumSamples = 48;
            if (sourceRows.length <= maximumSamples) {
                return sourceRows;
            }

            return Array.from({ length: maximumSamples }, (_, index) => {
                const sourceIndex = Math.round((index / (maximumSamples - 1)) * (sourceRows.length - 1));
                return sourceRows[sourceIndex];
            });
        }

        function formatLuxuryDashboardAnalyticsValue(value, metric) {
            if (!Number.isFinite(value)) {
                return '--';
            }

            return `${formatMetricValue(value)}${metric.reading.unit ? ` ${metric.reading.unit}` : ''}`;
        }

        function formatLuxuryDashboardAnalyticsDate(date) {
            const locales = {
                it: 'it-IT',
                en: 'en-GB',
                fr: 'fr-FR',
                ar: 'ar-MA',
                tz: 'fr-MA',
                zgh: 'fr-MA',
                ber: 'fr-MA'
            };
            const options = currentLuxuryDashboardAnalyticsPeriod === '24h'
                ? { hour: '2-digit', minute: '2-digit' }
                : { day: 'numeric', month: 'short' };

            return new Intl.DateTimeFormat(locales[currentLang] || 'fr-FR', options).format(date);
        }

        function getLuxuryDashboardAnalyticsSummary(metric, series) {
            if (!series.length) {
                return {
                    latest: metric.reading.value,
                    average: metric.reading.value,
                    minimum: metric.reading.value,
                    maximum: metric.reading.value,
                    change: null,
                    status: metric.reading.state
                };
            }

            const values = series.map((row) => row.value);
            const latest = values[values.length - 1];
            const change = values.length > 1 ? latest - values[0] : null;
            return {
                latest,
                average: values.reduce((sum, value) => sum + value, 0) / values.length,
                minimum: Math.min(...values),
                maximum: Math.max(...values),
                change,
                status: getMetricState(latest, getRangeForMetric(metric.group, metric.key))
            };
        }

        function renderLuxuryDashboardAnalyticsChart(metric, series) {
            const chart = { width: 680, height: 188, left: 52, right: 662, top: 18, bottom: 150 };
            if (!series.length) {
                return '';
            }

            const optimalRange = getRangeForMetric(metric.group, metric.key);
            const chartValues = series.map((row) => row.value);
            const limitValues = optimalRange
                ? chartValues.concat([optimalRange.min, optimalRange.max])
                : chartValues;
            const lowerValue = Math.min(...limitValues);
            const upperValue = Math.max(...limitValues);
            const rawSpan = upperValue - lowerValue || Math.max(Math.abs(upperValue) * 0.1, 1);
            const minimum = Math.max(metric.key === 'moisture' ? 0 : -Infinity, lowerValue - (rawSpan * 0.16));
            const maximum = upperValue + (rawSpan * 0.16);
            const valueSpan = maximum - minimum || 1;
            const plotWidth = chart.right - chart.left;
            const plotHeight = chart.bottom - chart.top;
            const toX = (index) => chart.left + ((index / Math.max(series.length - 1, 1)) * plotWidth);
            const toY = (value) => chart.bottom - (((value - minimum) / valueSpan) * plotHeight);
            const points = series.map((row, index) => ({
                x: toX(index),
                y: toY(row.value),
                date: row.date
            }));
            const linePath = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
            const areaPath = points.length > 1
                ? `${linePath} L${points[points.length - 1].x.toFixed(1)} ${chart.bottom} L${points[0].x.toFixed(1)} ${chart.bottom} Z`
                : '';
            const ticks = Array.from({ length: 4 }, (_, index) => {
                const value = maximum - ((valueSpan / 3) * index);
                const y = toY(value);
                return `<g><path d="M${chart.left} ${y.toFixed(1)}H${chart.right}" class="rayat-luxury-home-dashboard-analytics-grid-line"></path><text x="${chart.left - 9}" y="${(y + 3).toFixed(1)}" class="rayat-luxury-home-dashboard-analytics-axis-label">${formatMetricValue(value)}</text></g>`;
            }).join('');
            const labelIndexes = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];
            const timeLabels = labelIndexes.map((index) => {
                const anchor = index === 0 ? 'start' : (index === series.length - 1 ? 'end' : 'middle');
                return `<text x="${points[index].x.toFixed(1)}" y="${chart.height - 9}" text-anchor="${anchor}" class="rayat-luxury-home-dashboard-analytics-axis-label">${formatLuxuryDashboardAnalyticsDate(points[index].date)}</text>`;
            }).join('');
            const rangeTop = optimalRange ? toY(optimalRange.max) : 0;
            const rangeHeight = optimalRange ? Math.max(2, toY(optimalRange.min) - rangeTop) : 0;
            const gradientId = `rayat-luxury-home-dashboard-chart-fill-${metric.id.replace(':', '-')}`;
            const lastPoint = points[points.length - 1];

            return `
                <svg class="rayat-luxury-home-dashboard-analytics-chart" viewBox="0 0 ${chart.width} ${chart.height}" role="img" aria-label="${t(metric.labelKey)}">
                    <defs>
                        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="#2d6a4f" stop-opacity="0.16"></stop>
                            <stop offset="100%" stop-color="#2d6a4f" stop-opacity="0"></stop>
                        </linearGradient>
                    </defs>
                    ${optimalRange ? `<rect x="${chart.left}" y="${rangeTop.toFixed(1)}" width="${plotWidth}" height="${rangeHeight.toFixed(1)}" class="rayat-luxury-home-dashboard-analytics-range"></rect>` : ''}
                    ${ticks}
                    ${areaPath ? `<path d="${areaPath}" fill="url(#${gradientId})"></path>` : ''}
                    ${points.length > 1 ? `<path d="${linePath}" class="rayat-luxury-home-dashboard-analytics-line"></path>` : ''}
                    <circle cx="${lastPoint.x.toFixed(1)}" cy="${lastPoint.y.toFixed(1)}" r="6" class="rayat-luxury-home-dashboard-analytics-point-ring"></circle>
                    <circle cx="${lastPoint.x.toFixed(1)}" cy="${lastPoint.y.toFixed(1)}" r="3.25" class="rayat-luxury-home-dashboard-analytics-point"></circle>
                    ${timeLabels}
                </svg>
            `;
        }

        function renderLuxuryOverviewTab() {
            const temperature = getLuxuryDashboardSoilReadings().find((item) => item.key === 'temperature');
            const kpis = [
                { icon: 'water', labelKey: 'luxKpiWaterLabel', value: t('luxKpiWaterValue'), status: t('luxKpiWaterStatus'), spark: 'M2 31 C7 28 12 28 17 29 C22 30 25 27 30 28 C35 29 38 25 43 27 C48 29 51 20 56 18' },
                { icon: 'leaf', labelKey: 'luxKpiHealthLabel', value: t('luxKpiHealthValue'), status: t('luxKpiHealthStatus'), spark: 'M2 28 C8 25 13 24 18 26 C23 28 27 30 32 28 C38 25 43 27 48 24 C52 22 55 17 58 16' },
                { icon: 'water', labelKey: 'luxKpiIrrigationLabel', value: t('luxKpiIrrigationValue'), status: t('luxKpiIrrigationStatus'), spark: 'M2 30 C8 26 14 25 20 27 C26 29 31 24 36 25 C43 26 47 22 52 17 C55 14 57 11 58 8' },
                { icon: 'temperature', labelKey: 'luxKpiTempLabel', value: `${temperature.displayValue}${temperature.unit}`, status: temperature.state.label, spark: 'M2 24 C7 21 13 20 19 23 C25 26 30 24 36 21 C42 18 47 26 52 22 C55 20 57 18 58 16' }
            ];
            const recommendations = [
                { icon: 'water', titleKey: 'luxAiRow1Title', textKey: 'luxAiRow1Text' },
                { icon: 'alert', titleKey: 'luxAiRow2Title', textKey: 'luxAiRow2Text' },
                { icon: 'leaf', titleKey: 'luxAiRow3Title', textKey: 'luxAiRow3Text' }
            ];
            const controls = `
                <div class="rayat-luxury-home-dashboard-tab-toolbar">
                    <span class="rayat-luxury-home-dashboard-chip">${t('luxDashboardPeriod')}</span>
                    <button type="button" onclick="exportLuxuryDashboardCsv()" class="rayat-luxury-home-dashboard-command">${t('luxDashboardExport')}</button>
                </div>
            `;

            return `
                <div class="rayat-luxury-home-dashboard-tab-view">
                    ${renderLuxuryDashboardTabHeader('luxDashboardOverviewTitle', 'luxDashboardOverviewSubtitle', controls)}
                    <div class="rayat-luxury-kpi-grid">
                        ${kpis.map((card) => `
                            <article class="rayat-luxury-kpi-card">
                                <div class="rayat-luxury-kpi-topline">
                                    <span class="rayat-luxury-kpi-icon">${renderLuxuryDashboardIcon(card.icon)}</span>
                                    <span class="rayat-luxury-kpi-label">${t(card.labelKey)}</span>
                                </div>
                                <strong class="rayat-luxury-kpi-value">${card.value}</strong>
                                <span class="rayat-luxury-kpi-status">${card.status}</span>
                                <svg class="rayat-luxury-kpi-sparkline" viewBox="0 0 60 34" fill="none" aria-hidden="true"><path d="${card.spark}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
                            </article>
                        `).join('')}
                    </div>
                    <div class="rayat-luxury-home-dashboard-lower">
                        <div class="rayat-luxury-map-panel">
                            <div class="rayat-luxury-map-header">
                                <h3>${t('luxMapTitle')}</h3>
                                <span class="rayat-luxury-home-dashboard-chip">${t('luxMapFilter')}</span>
                            </div>
                            <div id="home-dashboard-map-preview" class="rayat-luxury-map-preview">
                                <svg class="rayat-luxury-map-svg" viewBox="0 0 720 260" fill="none" aria-hidden="true">
                                    <path d="M0 32C110 18 160 62 260 40C390 12 480 28 720 6M0 116C128 88 202 142 318 108C450 70 575 105 720 84M0 204C130 168 240 212 360 178C486 142 584 182 720 152" stroke="#e5e7eb"></path>
                                    <path d="M142 28 250 44 294 104 210 160 120 82Z" fill="rgba(45,106,79,.12)" stroke="#4a7c59"></path>
                                    <path d="M332 46 462 28 540 86 458 146 346 122Z" fill="rgba(74,124,89,.13)" stroke="#4a7c59"></path>
                                    <path d="M482 158 614 112 690 178 604 238 504 222Z" fill="rgba(184,150,12,.11)" stroke="#b8960c"></path>
                                    <circle cx="202" cy="84" r="6" fill="#4a7c59"></circle><circle cx="450" cy="82" r="6" fill="#4a7c59"></circle><circle cx="594" cy="176" r="7" fill="#b8960c"></circle>
                                </svg>
                            </div>
                        </div>
                        <div class="rayat-luxury-ai-panel">
                            <div class="rayat-luxury-ai-header"><h3>${t('luxAiTitle')}</h3><span class="rayat-luxury-ai-badge">${t('luxAiBadge')}</span></div>
                            <div class="rayat-luxury-ai-list">
                                ${recommendations.map((item) => `
                                    <article class="rayat-luxury-ai-row">
                                        <span class="rayat-luxury-ai-row-icon">${renderLuxuryDashboardIcon(item.icon)}</span>
                                        <span class="rayat-luxury-ai-row-copy"><strong>${t(item.titleKey)}</strong><span>${t(item.textKey)}</span></span>
                                    </article>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        function renderLuxuryParcelsTab() {
            const status = getLuxuryDashboardTimestamp();
            const parcels = ['luxDashboardParcelOne', 'luxDashboardParcelNorth', 'luxDashboardParcelGreenhouse'];
            return `
                <div class="rayat-luxury-home-dashboard-tab-view">
                    ${renderLuxuryDashboardTabHeader('luxDashboardParcelsTitle', 'luxDashboardParcelsSubtitle')}
                    <div class="rayat-luxury-home-dashboard-parcel-grid">
                        ${parcels.map((nameKey) => `
                            <article class="rayat-luxury-home-dashboard-parcel-card">
                                <div class="rayat-luxury-home-dashboard-card-head">
                                    <h3>${t(nameKey)}</h3>
                                    <span class="rayat-luxury-home-dashboard-status ${status.className}">${t('luxDashboardOperational')}</span>
                                </div>
                                <dl class="rayat-luxury-home-dashboard-detail-list">
                                    <div><dt>${t('luxDashboardCropType')}</dt><dd>${getSelectedCropLabel()}</dd></div>
                                    <div><dt>${t('luxDashboardLinkedSensors')}</dt><dd>${t('luxDashboardSensorsConnected')}</dd></div>
                                    <div><dt>${t('luxDashboardLastUpdate')}</dt><dd>${status.timestamp}</dd></div>
                                </dl>
                            </article>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        function renderLuxurySensorsTab() {
            const readings = getLuxuryDashboardSoilReadings();
            const connection = getLuxuryDashboardTimestamp();
            return `
                <div class="rayat-luxury-home-dashboard-tab-view">
                    ${renderLuxuryDashboardTabHeader('luxDashboardSensorsTitle', 'luxDashboardSensorsSubtitle', `
                        <span class="rayat-luxury-home-dashboard-status ${connection.className}">${connection.className === 'is-online' ? t('luxDashboardOnline') : t('luxDashboardOffline')}</span>
                    `)}
                    <div class="rayat-luxury-home-dashboard-sensor-grid">
                        ${readings.map((reading) => `
                            <article class="rayat-luxury-home-dashboard-sensor-card">
                                <div class="rayat-luxury-home-dashboard-card-head">
                                    <span class="rayat-luxury-home-dashboard-sensor-icon">${renderLuxuryDashboardIcon(reading.key === 'temperature' ? 'temperature' : (reading.key === 'moisture' ? 'water' : 'sensor'))}</span>
                                    <span class="rayat-luxury-home-dashboard-pill rayat-luxury-home-dashboard-pill--${reading.state.level}">${reading.state.label}</span>
                                </div>
                                <p class="rayat-luxury-home-dashboard-overline">${t(reading.labelKey)}</p>
                                <strong class="rayat-luxury-home-dashboard-reading">${reading.displayValue}<small>${reading.unit}</small></strong>
                                <span class="rayat-luxury-home-dashboard-reading-time">${t('luxDashboardLastUpdate')}: ${connection.timestamp}</span>
                            </article>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        function renderLuxuryIrrigationTab() {
            const moisture = getLuxuryDashboardSoilReadings().find((item) => item.key === 'moisture');
            return `
                <div class="rayat-luxury-home-dashboard-tab-view">
                    ${renderLuxuryDashboardTabHeader('luxDashboardIrrigationTitle', 'luxDashboardIrrigationSubtitle')}
                    <article class="rayat-luxury-home-dashboard-recommendation">
                        <span class="rayat-luxury-home-dashboard-recommendation-icon">${renderLuxuryDashboardIcon('water')}</span>
                        <div>
                            <span>${t('luxDashboardRecommendation')}</span>
                            <h3>${t('luxAiRow1Title')}</h3>
                            <p>${t('luxDashboardTrendMoisture')}: ${moisture.displayValue} ${moisture.unit}</p>
                        </div>
                    </article>
                    <div class="rayat-luxury-home-dashboard-stat-grid">
                        <article><span>${t('luxDashboardNextIrrigation')}</span><strong>${t('luxDashboardScheduled')}</strong></article>
                        <article><span>${t('luxDashboardDuration')}</span><strong>${t('luxDashboardMinutes')}</strong></article>
                        <article><span>${t('luxDashboardWaterSaving')}</span><strong>${t('luxKpiWaterValue')}</strong></article>
                    </div>
                    <article class="rayat-luxury-home-dashboard-placeholder">
                        <h3>${t('luxDashboardHistory')}</h3>
                        <p>${t('luxDashboardPlaceholder')}</p>
                    </article>
                </div>
            `;
        }

        function renderLuxuryAlertsTab() {
            const alerts = buildDashboardAlertSnapshot().filter((item) => item.level !== 'normal').slice(0, 6);
            return `
                <div class="rayat-luxury-home-dashboard-tab-view">
                    ${renderLuxuryDashboardTabHeader('luxDashboardAlertsTitle', 'luxDashboardAlertsSubtitle')}
                    ${alerts.length ? `
                        <div class="rayat-luxury-home-dashboard-alert-list">
                            ${alerts.map((alert) => `
                                <article class="rayat-luxury-home-dashboard-alert-row">
                                    <span class="rayat-luxury-home-dashboard-pill rayat-luxury-home-dashboard-pill--${alert.level}">${getAlertBadgeLabel(alert.level)}</span>
                                    <div><strong>${alert.label}</strong><span>${alert.sensorLabel}</span></div>
                                    <div><small>${t('luxDashboardRecommendedAction')}</small><span>${alert.description || t('luxDashboardActionAdjust')}</span></div>
                                </article>
                            `).join('')}
                        </div>
                    ` : `
                        <article class="rayat-luxury-home-dashboard-empty">
                            ${renderLuxuryDashboardIcon('leaf')}
                            <h3>${t('luxDashboardNoAlerts')}</h3>
                            <p>${t('luxDashboardNoAlertsText')}</p>
                        </article>
                    `}
                </div>
            `;
        }

        function setLuxuryDashboardAnalyticsPeriod(period) {
            currentLuxuryDashboardAnalyticsPeriod = ['24h', '7d', '30d'].includes(period) ? period : '7d';
            const container = document.getElementById('rayat-luxury-home-dashboard-content');
            if (container && currentLuxuryDashboardTab === 'analytics') {
                container.innerHTML = renderLuxuryAnalyticsTab();
                setTimeout(() => initLuxuryDashboardAnalyticsMetricRail(true), 0);
            }
        }

        function setLuxuryDashboardAnalyticsMetric(metricId) {
            const metrics = getLuxuryDashboardAnalyticsMetrics();
            currentLuxuryDashboardAnalyticsMetric = metrics.some((metric) => metric.id === metricId)
                ? metricId
                : metrics[0]?.id || 'soil:moisture';
            const container = document.getElementById('rayat-luxury-home-dashboard-content');
            if (container && currentLuxuryDashboardTab === 'analytics') {
                container.innerHTML = renderLuxuryAnalyticsTab();
                setTimeout(() => initLuxuryDashboardAnalyticsMetricRail(true), 0);
            }
        }

        function updateLuxuryDashboardAnalyticsMetricRailButtons() {
            const rail = document.getElementById('rayat-luxury-home-dashboard-metric-rail');
            const previousButton = document.querySelector('[data-luxury-dashboard-metric-direction="previous"]');
            const nextButton = document.querySelector('[data-luxury-dashboard-metric-direction="next"]');

            if (!(rail && previousButton && nextButton)) {
                return;
            }

            const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
            previousButton.disabled = rail.scrollLeft <= 2;
            nextButton.disabled = rail.scrollLeft >= maxScroll - 2;
        }

        function initLuxuryDashboardAnalyticsMetricRail(alignActive = false) {
            const rail = document.getElementById('rayat-luxury-home-dashboard-metric-rail');
            const activeMetric = rail?.querySelector('.rayat-luxury-home-dashboard-metric-option.is-active');

            if (!rail) {
                return;
            }

            if (rail.dataset.scrollBound !== '1') {
                rail.dataset.scrollBound = '1';
                rail.addEventListener('scroll', updateLuxuryDashboardAnalyticsMetricRailButtons, { passive: true });
            }

            if (alignActive && activeMetric) {
                const activeCenter = activeMetric.offsetLeft + (activeMetric.offsetWidth / 2);
                const desiredScroll = activeCenter - (rail.clientWidth / 2);
                rail.scrollTo({ left: Math.max(0, desiredScroll), behavior: 'smooth' });
            }

            updateLuxuryDashboardAnalyticsMetricRailButtons();
            setTimeout(updateLuxuryDashboardAnalyticsMetricRailButtons, 260);
        }

        function scrollLuxuryDashboardAnalyticsMetrics(direction) {
            const rail = document.getElementById('rayat-luxury-home-dashboard-metric-rail');

            if (!rail) {
                return;
            }

            rail.scrollBy({
                left: direction * Math.max(rail.clientWidth * 0.82, 180),
                behavior: 'smooth'
            });
            setTimeout(updateLuxuryDashboardAnalyticsMetricRailButtons, 280);
        }

        function renderLuxuryAnalyticsTab() {
            const metrics = getLuxuryDashboardAnalyticsMetrics().map((metric) => {
                const series = getLuxuryDashboardAnalyticsSeries(metric);
                return {
                    ...metric,
                    series,
                    summary: getLuxuryDashboardAnalyticsSummary(metric, series)
                };
            });
            const selectedMetric = metrics.find((metric) => metric.id === currentLuxuryDashboardAnalyticsMetric) || metrics[0];
            const series = selectedMetric.series;
            const summary = selectedMetric.summary;
            const formattedChange = Number.isFinite(summary.change)
                ? `${summary.change > 0 ? '+' : ''}${formatLuxuryDashboardAnalyticsValue(summary.change, selectedMetric)}`
                : '--';
            const controls = `
                <div class="rayat-luxury-home-dashboard-segmented">
                    ${['24h', '7d', '30d'].map((period) => `
                        <button type="button" aria-pressed="${currentLuxuryDashboardAnalyticsPeriod === period}" class="${currentLuxuryDashboardAnalyticsPeriod === period ? 'is-active' : ''}" onclick="setLuxuryDashboardAnalyticsPeriod('${period}')">${t(`luxDashboardPeriod${period}`)}</button>
                    `).join('')}
                </div>
            `;

            return `
                <div class="rayat-luxury-home-dashboard-tab-view">
                    ${renderLuxuryDashboardTabHeader('luxDashboardAnalyticsTitle', 'luxDashboardAnalyticsSubtitle', controls)}
                    <div class="rayat-luxury-home-dashboard-analytics-workspace">
                        <div class="rayat-luxury-home-dashboard-metric-carousel">
                            <button
                                type="button"
                                data-luxury-dashboard-metric-direction="previous"
                                class="rayat-luxury-home-dashboard-metric-arrow rayat-luxury-home-dashboard-metric-arrow--previous"
                                onclick="scrollLuxuryDashboardAnalyticsMetrics(-1)"
                                aria-label="${t('luxDashboardAnalyticsPrevious')}"
                            >
                                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m12.5 4.5-5.5 5.5 5.5 5.5"></path></svg>
                            </button>
                            <div id="rayat-luxury-home-dashboard-metric-rail" class="rayat-luxury-home-dashboard-metric-switcher" aria-label="${t('luxDashboardAnalyticsTitle')}">
                                ${metrics.map((metric) => `
                                    <button
                                        type="button"
                                        data-luxury-dashboard-metric="${metric.id}"
                                        aria-pressed="${selectedMetric.id === metric.id}"
                                        class="rayat-luxury-home-dashboard-metric-option ${selectedMetric.id === metric.id ? 'is-active' : ''}"
                                        onclick="setLuxuryDashboardAnalyticsMetric('${metric.id}')"
                                    >
                                        <span class="rayat-luxury-home-dashboard-metric-source">${t(metric.sourceKey)}</span>
                                        <span class="rayat-luxury-home-dashboard-metric-title">${t(metric.labelKey)}</span>
                                        <span class="rayat-luxury-home-dashboard-metric-footer">
                                            <strong class="rayat-luxury-home-dashboard-metric-value">${formatLuxuryDashboardAnalyticsValue(metric.summary.latest, metric)}</strong>
                                            <small class="rayat-luxury-home-dashboard-metric-state rayat-luxury-home-dashboard-metric-state--${metric.summary.status.level}">${metric.summary.status.label}</small>
                                        </span>
                                    </button>
                                `).join('')}
                            </div>
                            <button
                                type="button"
                                data-luxury-dashboard-metric-direction="next"
                                class="rayat-luxury-home-dashboard-metric-arrow rayat-luxury-home-dashboard-metric-arrow--next"
                                onclick="scrollLuxuryDashboardAnalyticsMetrics(1)"
                                aria-label="${t('luxDashboardAnalyticsNext')}"
                            >
                                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7.5 4.5 5.5 5.5-5.5 5.5"></path></svg>
                            </button>
                        </div>
                        <article class="rayat-luxury-home-dashboard-analytics-panel">
                            <div class="rayat-luxury-home-dashboard-analytics-panel-head">
                                <div class="rayat-luxury-home-dashboard-analytics-current">
                                    <span>${t('luxDashboardAnalyticsLatest')}</span>
                                    <strong>${formatLuxuryDashboardAnalyticsValue(summary.latest, selectedMetric)}</strong>
                                </div>
                                <div class="rayat-luxury-home-dashboard-analytics-meta">
                                    <span class="rayat-luxury-home-dashboard-pill rayat-luxury-home-dashboard-pill--${summary.status.level}">${summary.status.label}</span>
                                    <span class="rayat-luxury-home-dashboard-analytics-samples">${series.length} ${t('luxDashboardAnalyticsReadings')}</span>
                                </div>
                            </div>
                            <div class="rayat-luxury-home-dashboard-analytics-plot">
                                <span class="rayat-luxury-home-dashboard-analytics-range-label">${t('luxDashboardAnalyticsOptimalBand')}</span>
                                ${renderLuxuryDashboardAnalyticsChart(selectedMetric, series)}
                                ${series.length < 2 ? `<p class="rayat-luxury-home-dashboard-analytics-waiting">${t('luxDashboardAnalyticsWaiting')}</p>` : ''}
                            </div>
                            <div class="rayat-luxury-home-dashboard-analytics-stat-row">
                                <div class="rayat-luxury-home-dashboard-analytics-stat"><span>${t('luxDashboardAnalyticsAverage')}</span><strong>${formatLuxuryDashboardAnalyticsValue(summary.average, selectedMetric)}</strong></div>
                                <div class="rayat-luxury-home-dashboard-analytics-stat"><span>${t('luxDashboardAnalyticsMinimum')}</span><strong>${formatLuxuryDashboardAnalyticsValue(summary.minimum, selectedMetric)}</strong></div>
                                <div class="rayat-luxury-home-dashboard-analytics-stat"><span>${t('luxDashboardAnalyticsMaximum')}</span><strong>${formatLuxuryDashboardAnalyticsValue(summary.maximum, selectedMetric)}</strong></div>
                                <div class="rayat-luxury-home-dashboard-analytics-stat"><span>${t('luxDashboardAnalyticsChange')}</span><strong class="${summary.change > 0 ? 'is-positive' : (summary.change < 0 ? 'is-negative' : '')}">${formattedChange}</strong></div>
                            </div>
                        </article>
                    </div>
                </div>
            `;
        }

        function exportLuxuryDashboardCsv() {
            const previousSensor = selectedSensor;
            selectedSensor = 'terreno';
            if (!globalHistory.length) {
                generateSimulationData();
            }
            exportCSV();
            selectedSensor = previousSensor;
        }

        function renderLuxuryReportsTab() {
            return `
                <div class="rayat-luxury-home-dashboard-tab-view">
                    ${renderLuxuryDashboardTabHeader('luxDashboardReportsTitle', 'luxDashboardReportsSubtitle')}
                    <div class="rayat-luxury-home-dashboard-report-actions">
                        <button type="button" class="rayat-luxury-home-dashboard-action-card" onclick="exportLuxuryDashboardCsv()">
                            ${renderLuxuryDashboardIcon('report')}
                            <strong>${t('luxDashboardCsvExport')}</strong>
                        </button>
                        <article class="rayat-luxury-home-dashboard-action-card is-disabled">
                            ${renderLuxuryDashboardIcon('report')}
                            <strong>${t('luxDashboardPdfReport')}</strong>
                            <span>${t('luxDashboardPdfPlaceholder')}</span>
                        </article>
                    </div>
                    <section class="rayat-luxury-home-dashboard-report-list">
                        <h3>${t('luxDashboardRecentReports')}</h3>
                        <article><strong>${t('luxDashboardReportWeekly')}</strong><span>${t('luxDashboardPeriod')}</span></article>
                        <article><strong>${t('luxDashboardReportIrrigation')}</strong><span>${t('luxDashboardPeriod')}</span></article>
                    </section>
                </div>
            `;
        }

        function setLuxuryDashboardCrop(value) {
            userCropSelection.value = CROP_OPTIONS.some((option) => option.value === value) ? value : DEFAULT_CROP_VALUE;
            if (userCropSelection.value !== 'autre') {
                userCropSelection.custom = '';
            }
            waterSettings.crop = userCropSelection.value;
            persistCropSelection();
            setLuxuryDashboardTab('settings');
        }

        function toggleLuxuryDashboardNotifications() {
            luxuryDashboardNotificationsEnabled = !luxuryDashboardNotificationsEnabled;
            const container = document.getElementById('rayat-luxury-home-dashboard-content');
            if (container && currentLuxuryDashboardTab === 'settings') {
                container.innerHTML = renderLuxurySettingsTab();
            }
        }

        function renderLuxurySettingsTab() {
            const thresholdMetrics = getLuxuryDashboardSoilReadings().slice(0, 4);
            return `
                <div class="rayat-luxury-home-dashboard-tab-view">
                    ${renderLuxuryDashboardTabHeader('luxDashboardSettingsTitle', 'luxDashboardSettingsSubtitle')}
                    <div class="rayat-luxury-home-dashboard-settings-grid">
                        <label class="rayat-luxury-home-dashboard-field">
                            <span>${t('luxDashboardCropSelection')}</span>
                            <select onchange="setLuxuryDashboardCrop(this.value)">
                                ${CROP_OPTIONS.map((option) => `<option value="${option.value}" ${userCropSelection.value === option.value ? 'selected' : ''}>${t(option.labelKey)}</option>`).join('')}
                            </select>
                        </label>
                        <section class="rayat-luxury-home-dashboard-setting-card">
                            <span>${t('luxDashboardLanguage')}</span>
                            <strong>${String(currentLang).toUpperCase()}</strong>
                        </section>
                        <button type="button" class="rayat-luxury-home-dashboard-setting-card rayat-luxury-home-dashboard-toggle ${luxuryDashboardNotificationsEnabled ? 'is-on' : ''}" onclick="toggleLuxuryDashboardNotifications()">
                            <span>${t('luxDashboardNotifications')}</span>
                            <strong>${luxuryDashboardNotificationsEnabled ? t('luxDashboardNotificationsEnabled') : t('luxDashboardNotificationsDisabled')}</strong>
                        </button>
                    </div>
                    <section class="rayat-luxury-home-dashboard-thresholds">
                        <h3>${t('luxDashboardThresholds')}</h3>
                        ${thresholdMetrics.map((metric) => `
                            <article>
                                <span>${t(metric.labelKey)}</span>
                                <strong>${buildOptimalRangeLabel(getRangeForMetric('soil', metric.key), 'range')}</strong>
                            </article>
                        `).join('')}
                    </section>
                </div>
            `;
        }

        function renderLuxuryDashboardTabContent(tab) {
            switch (tab) {
                case 'overview':
                    return renderLuxuryOverviewTab();
                case 'parcels':
                    return renderLuxuryParcelsTab();
                case 'sensors':
                    return renderLuxurySensorsTab();
                case 'irrigation':
                    return renderLuxuryIrrigationTab();
                case 'alerts':
                    return renderLuxuryAlertsTab();
                case 'analytics':
                    return renderLuxuryAnalyticsTab();
                case 'reports':
                    return renderLuxuryReportsTab();
                case 'settings':
                    return renderLuxurySettingsTab();
                default:
                    return renderLuxuryOverviewTab();
            }
        }

        function setLuxuryDashboardTab(tab) {
            const validTab = ['overview', 'parcels', 'sensors', 'irrigation', 'alerts', 'analytics', 'reports', 'settings'].includes(tab)
                ? tab
                : 'overview';
            currentLuxuryDashboardTab = validTab;
            const container = document.getElementById('rayat-luxury-home-dashboard-content');
            if (container) {
                container.innerHTML = renderLuxuryDashboardTabContent(validTab);
            }

            document.querySelectorAll('.rayat-luxury-home-dashboard-nav-item')
                .forEach((button) => button.classList.remove('is-active', 'rayat-luxury-home-dashboard-nav-item--active'));

            const activeBtn = document.querySelector(`[data-luxury-tab="${validTab}"]`);
            if (activeBtn) {
                activeBtn.classList.add('is-active', 'rayat-luxury-home-dashboard-nav-item--active');
            }

            if (validTab === 'analytics') {
                setTimeout(() => initLuxuryDashboardAnalyticsMetricRail(true), 0);
            }
        }

        const RAYAT_DEFINITIVE_HOME_TRANSLATIONS = {
            it: {
                luxDefNavHome: 'Home',
                luxDefNavPlatform: 'La piattaforma',
                luxDefNavDemo: 'Demo live',
                luxDefNavHow: 'Come funziona',
                luxDefNavSolutions: 'Soluzioni',
                luxDefNavAbout: 'Chi siamo',
                luxDefHeroEyebrow: 'Agricoltura intelligente',
                luxDefHeroTitle: 'L’intelligenza al servizio delle tue colture.',
                luxDefHeroAccent: 'colture.',
                luxDefHeroText: 'Rayat trasforma i dati della tua azienda agricola in decisioni precise per ottimizzare l’acqua, anticipare i rischi e migliorare i rendimenti.',
                luxDefHeroPrimary: 'Scopri la demo live',
                luxDefHeroSecondary: 'Richiedi una demo',
                luxDefRealtime: 'Dati in tempo reale',
                luxDefSmartDecisions: 'Decisioni intelligenti',
                luxDefWebMobile: 'Accesso web e mobile',
                luxDefSecure: 'Sicuro e affidabile',
                luxDefOnline: 'Online',
                luxDefOffline: 'Offline',
                luxDefHeroFarm: 'Serra di banane - Taroudant',
                luxDefUpdated: 'Dati aggiornati: Oggi, 11:52',
                luxDefCropStatusLabel: 'Stato coltura',
                luxDefOptimal: 'Ottimale',
                luxDefGood: 'Buona',
                luxDefDemoEyebrow: 'Demo live',
                luxDefDemoTitle: 'Serra di banane Taroudant',
                luxDefDemoText: 'Una serra reale collegata alla piattaforma Rayat, monitorata 24/7.',
                luxDefContinuous: 'Monitoraggio continuo',
                luxDefLiveData: 'Dati in tempo reale',
                luxDefHistorical: 'Storico e analisi',
                luxDefSmartAlerts: 'Avvisi intelligenti',
                luxDefViewDemo: 'Visualizza demo live',
                luxDefMapCardTitle: 'Serra di banane - Taroudant',
                luxDefMapArea: 'Superficie: 1 ha',
                luxDefViewDetails: 'Visualizza dettagli',
                luxDefHowEyebrow: 'Processo Rayat',
                luxDefHowTitle: 'Tecnologia semplice, valore reale.',
                luxDefStepSensorsTitle: 'Sensori',
                luxDefStepSensorsText: 'Monitorano parametri ambientali e del suolo.',
                luxDefStepRouterTitle: 'Router Rayat',
                luxDefStepRouterText: 'Trasmette i dati in modo sicuro e continuo.',
                luxDefStepCloudTitle: 'Cloud Rayat',
                luxDefStepCloudText: 'I dati vengono archiviati, analizzati e protetti.',
                luxDefStepDashboardTitle: 'Dashboard live',
                luxDefStepDashboardText: 'Visualizza tutto in tempo reale, ovunque tu sia.',
                luxDefStepAiTitle: 'Consigli IA',
                luxDefStepAiText: 'Ricevi suggerimenti intelligenti e pratici per le tue colture.',
                luxDefPlatformEyebrow: 'La piattaforma Rayat',
                luxDefPlatformTitle: 'Tutto sotto controllo.',
                luxDefPlatformTitleFull: 'Tutto sotto controllo, in un’unica dashboard.',
                luxDefPlatformText: 'Un’unica piattaforma per monitorare, analizzare e gestire la tua azienda agricola.',
                luxDefPlatformDashboard: 'Dashboard intuitiva',
                luxDefPlatformMap: 'Mappa parcelle',
                luxDefPlatformAnalytics: 'Analisi avanzate',
                luxDefPlatformAlerts: 'Avvisi in tempo reale',
                luxDefPlatformReports: 'Storico e report',
                luxDefPlatformMulti: 'Gestione multi-azienda',
                luxDefRealtimePanel: 'Dati in tempo reale',
                luxDefPlatformMainParams: 'Andamento principali parametri',
                luxDefPlatformMapTitle: 'Mappa parcelle',
                luxDefPlatformRecentAlerts: 'Ultimi avvisi',
                luxDefPlatformAlertMoisture: 'Umidità del suolo bassa',
                luxDefPlatformAlertIrrigation: 'Irrigazione programmata',
                luxDefPlatformAlertNormal: 'Tutti i parametri nella norma',
                luxDefPlatformViewAlerts: 'Vedi tutti gli avvisi',
                luxDefPlatformFarmLabel: 'Azienda Demo',
                luxDefPlatformLocation: 'Taroudant, Marocco',
                luxDefAllParameters: 'Vedi tutti i parametri',
                luxDefSolutionsEyebrow: 'Soluzioni per ogni coltura',
                luxDefSolutionsTitle: 'Dalla serra alla piena terra.',
                luxDefSolutionsText: 'Tecnologia adattiva per ogni coltura, in ogni ambiente.',
                luxDefGreenhouses: 'Serre',
                luxDefBananas: 'Banane',
                luxDefCitrus: 'Agrumi',
                luxDefVegetables: 'Ortaggi',
                luxDefFarms: 'Aziende agricole',
                luxDefMobileEyebrow: 'App mobile',
                luxDefMobileTitle: 'Il tuo campo, sempre in tasca.',
                luxDefMobileText: 'Monitora e gestisci la tua azienda agricola direttamente dal tuo smartphone, ovunque tu sia.',
                luxDefWaterSaving: 'Risparmio idrico',
                luxDefProductivity: 'Aumento produttività',
                luxDefMonitoring: 'Monitoraggio continuo',
                luxDefCompanies: 'Aziende che si fidano di noi',
                luxDefSatisfaction: 'Soddisfazione clienti',
                luxDefWaterSavingText: 'Meno sprechi, più sostenibilità.',
                luxDefProductivityText: 'Dati e insights per colture più performanti.',
                luxDefMonitoringText: 'I tuoi campi sotto controllo, sempre.',
                luxDefCompaniesText: 'Agricoltori e aziende che scelgono Rayat ogni giorno.',
                luxDefSatisfactionText: 'Tecnologia affidabile, risultati concreti.',
                luxDefFooterText: 'Soluzioni intelligenti per un’agricoltura più efficiente, sostenibile e produttiva.',
                luxDefFooterHomeDesc: 'Torna alla home',
                luxDefFooterSolutionsDesc: 'Le nostre soluzioni per ogni coltura',
                luxDefFooterDemoDesc: 'Dati reali dalla serra di Taroudant',
                luxDefFooterHowDesc: 'Scopri come funziona Rayat',
                luxDefFooterAboutDesc: 'La nostra storia e la nostra missione',
                luxDefFooterWhatsapp: 'WhatsApp',
                luxDefFooterWhatsappNumber: '+212 6 00 00 00 00',
                luxDefFooterEmail: 'Email',
                luxDefFooterEmailAddress: 'contact@rayat.ma',
                luxDefFooterDemoRequest: 'Richiedi una demo',
                luxDefFooterDemoRequestText: 'Prenota una dimostrazione',
                luxDefFooterPlatform: 'La piattaforma',
                luxDefFooterDemo: 'Demo live',
                luxDefFooterHow: 'Come funziona',
                luxDefFooterCopyright: '© 2026 Rayat Smart Monitoring. Tutti i diritti riservati.',
                luxDefDashMenuDashboard: 'Dashboard',
                luxDefDashMenuParcels: 'Parcelle',
                luxDefDashMenuMap: 'Mappa',
                luxDefDashMenuSensors: 'Sensori',
                luxDefDashMenuAlerts: 'Avvisi',
                luxDefDashMenuAnalytics: 'Analisi',
                luxDefDashMenuReports: 'Report',
                luxDefDashMenuSettings: 'Impostazioni',
                luxDefOverview: 'Panoramica',
                luxDefToday: 'Oggi',
                luxDefPhoneHome: 'Home',
                luxDefPhoneMap: 'Mappa',
                luxDefPhoneAlerts: 'Avvisi',
                luxDefPhoneArea: 'Area',
                luxDefFooterApp: 'App Mobile',
                luxDefFooterSensors: 'Sensori',
                luxDefFooterAnalytics: 'Analisi',
                luxDefFooterSecurity: 'Sicurezza',
                luxDefFooterGreenhouse: 'Serra Taroudant',
                luxDefFooterRealtime: 'Dati in tempo reale',
                luxDefFooterHistory: 'Storico',
                luxDefFooterAlerts: 'Avvisi',
                luxDefFooterTechnology: 'Tecnologia',
                luxDefFooterIntegration: 'Integrazione',
                luxDefFooterProcess: 'Processo',
                luxDefFooterStory: 'La nostra storia',
                luxDefFooterMission: 'Missione',
                luxDefFooterContact: 'Contatti',
                luxDefPrivacy: 'Privacy Policy',
                luxDefCookie: 'Cookie Policy'
            },
            en: {
                luxDefNavHome: 'Home',
                luxDefNavPlatform: 'Platform',
                luxDefNavDemo: 'Live demo',
                luxDefNavHow: 'How it works',
                luxDefNavSolutions: 'Solutions',
                luxDefNavAbout: 'About',
                luxDefHeroEyebrow: 'Smart agriculture',
                luxDefHeroTitle: 'Intelligence serving your crops.',
                luxDefHeroAccent: 'crops.',
                luxDefHeroText: 'Rayat turns your farm data into precise decisions to optimize water, anticipate risks, and improve yields.',
                luxDefHeroPrimary: 'Discover the live demo',
                luxDefHeroSecondary: 'Request a demo',
                luxDefRealtime: 'Real-time data',
                luxDefSmartDecisions: 'Smart decisions',
                luxDefWebMobile: 'Web and mobile access',
                luxDefSecure: 'Secure and reliable',
                luxDefOnline: 'Online',
                luxDefOffline: 'Offline',
                luxDefHeroFarm: 'Banana greenhouse - Taroudant',
                luxDefUpdated: 'Data updated: Today, 11:52',
                luxDefCropStatusLabel: 'Crop status',
                luxDefOptimal: 'Optimal',
                luxDefGood: 'Good',
                luxDefDemoEyebrow: 'Live demo',
                luxDefDemoTitle: 'Taroudant banana greenhouse',
                luxDefDemoText: 'A real greenhouse connected to the Rayat platform and monitored 24/7.',
                luxDefContinuous: 'Continuous monitoring',
                luxDefLiveData: 'Real-time data',
                luxDefHistorical: 'History and analytics',
                luxDefSmartAlerts: 'Smart alerts',
                luxDefViewDemo: 'View live demo',
                luxDefMapCardTitle: 'Banana greenhouse - Taroudant',
                luxDefMapArea: 'Area: 1 ha',
                luxDefViewDetails: 'View details',
                luxDefHowEyebrow: 'Rayat process',
                luxDefHowTitle: 'Simple technology, real value.',
                luxDefStepSensorsTitle: 'Sensors',
                luxDefStepSensorsText: 'Monitor soil and environmental parameters.',
                luxDefStepRouterTitle: 'Rayat router',
                luxDefStepRouterText: 'Transmits data securely and continuously.',
                luxDefStepCloudTitle: 'Rayat cloud',
                luxDefStepCloudText: 'Data is stored, analyzed, and protected.',
                luxDefStepDashboardTitle: 'Live dashboard',
                luxDefStepDashboardText: 'See everything in real time, wherever you are.',
                luxDefStepAiTitle: 'AI advice',
                luxDefStepAiText: 'Receive intelligent, practical suggestions for your crops.',
                luxDefPlatformEyebrow: 'The Rayat platform',
                luxDefPlatformTitle: 'Everything under control.',
                luxDefPlatformTitleFull: 'Everything under control, in one dashboard.',
                luxDefPlatformText: 'One platform to monitor, analyze, and manage your agricultural business.',
                luxDefPlatformDashboard: 'Intuitive dashboard',
                luxDefPlatformMap: 'Field map',
                luxDefPlatformAnalytics: 'Advanced analytics',
                luxDefPlatformAlerts: 'Real-time alerts',
                luxDefPlatformReports: 'History and reports',
                luxDefPlatformMulti: 'Multi-farm management',
                luxDefRealtimePanel: 'Real-time data',
                luxDefPlatformMainParams: 'Main parameter trends',
                luxDefPlatformMapTitle: 'Field map',
                luxDefPlatformRecentAlerts: 'Latest alerts',
                luxDefPlatformAlertMoisture: 'Low soil moisture',
                luxDefPlatformAlertIrrigation: 'Irrigation scheduled',
                luxDefPlatformAlertNormal: 'All parameters normal',
                luxDefPlatformViewAlerts: 'View all alerts',
                luxDefPlatformFarmLabel: 'Demo farm',
                luxDefPlatformLocation: 'Taroudant, Morocco',
                luxDefAllParameters: 'View all parameters',
                luxDefSolutionsEyebrow: 'Solutions for every crop',
                luxDefSolutionsTitle: 'From greenhouse to open field.',
                luxDefSolutionsText: 'Adaptive technology for every crop, in every environment.',
                luxDefGreenhouses: 'Greenhouses',
                luxDefBananas: 'Bananas',
                luxDefCitrus: 'Citrus',
                luxDefVegetables: 'Vegetables',
                luxDefFarms: 'Farms',
                luxDefMobileEyebrow: 'Mobile app',
                luxDefMobileTitle: 'Your field, always in your pocket.',
                luxDefMobileText: 'Monitor and manage your farm directly from your smartphone, wherever you are.',
                luxDefWaterSaving: 'Water savings',
                luxDefProductivity: 'Productivity increase',
                luxDefMonitoring: 'Continuous monitoring',
                luxDefCompanies: 'Companies trust us',
                luxDefSatisfaction: 'Customer satisfaction',
                luxDefWaterSavingText: 'Less waste, more sustainability.',
                luxDefProductivityText: 'Data and insights for higher-performing crops.',
                luxDefMonitoringText: 'Your fields under control, always.',
                luxDefCompaniesText: 'Farmers and companies choosing Rayat every day.',
                luxDefSatisfactionText: 'Reliable technology, concrete results.',
                luxDefFooterText: 'Smart solutions for more efficient, sustainable, and productive agriculture.',
                luxDefFooterHomeDesc: 'Return to home',
                luxDefFooterSolutionsDesc: 'Our solutions for every crop',
                luxDefFooterDemoDesc: 'Real data from the Taroudant greenhouse',
                luxDefFooterHowDesc: 'Discover how Rayat works',
                luxDefFooterAboutDesc: 'Our story and our mission',
                luxDefFooterWhatsapp: 'WhatsApp',
                luxDefFooterWhatsappNumber: '+212 6 00 00 00 00',
                luxDefFooterEmail: 'Email',
                luxDefFooterEmailAddress: 'contact@rayat.ma',
                luxDefFooterDemoRequest: 'Request a demo',
                luxDefFooterDemoRequestText: 'Book a demonstration',
                luxDefFooterPlatform: 'Platform',
                luxDefFooterDemo: 'Live demo',
                luxDefFooterHow: 'How it works',
                luxDefFooterCopyright: '© 2026 Rayat Smart Monitoring. All rights reserved.',
                luxDefDashMenuDashboard: 'Dashboard',
                luxDefDashMenuParcels: 'Fields',
                luxDefDashMenuMap: 'Map',
                luxDefDashMenuSensors: 'Sensors',
                luxDefDashMenuAlerts: 'Alerts',
                luxDefDashMenuAnalytics: 'Analytics',
                luxDefDashMenuReports: 'Reports',
                luxDefDashMenuSettings: 'Settings',
                luxDefOverview: 'Overview',
                luxDefToday: 'Today',
                luxDefPhoneHome: 'Home',
                luxDefPhoneMap: 'Map',
                luxDefPhoneAlerts: 'Alerts',
                luxDefPhoneArea: 'Area',
                luxDefFooterApp: 'Mobile app',
                luxDefFooterSensors: 'Sensors',
                luxDefFooterAnalytics: 'Analytics',
                luxDefFooterSecurity: 'Security',
                luxDefFooterGreenhouse: 'Taroudant greenhouse',
                luxDefFooterRealtime: 'Real-time data',
                luxDefFooterHistory: 'History',
                luxDefFooterAlerts: 'Alerts',
                luxDefFooterTechnology: 'Technology',
                luxDefFooterIntegration: 'Integration',
                luxDefFooterProcess: 'Process',
                luxDefFooterStory: 'Our story',
                luxDefFooterMission: 'Mission',
                luxDefFooterContact: 'Contact',
                luxDefPrivacy: 'Privacy Policy',
                luxDefCookie: 'Cookie Policy'
            },
            fr: {
                luxDefNavHome: 'Accueil',
                luxDefNavPlatform: 'La plateforme',
                luxDefNavDemo: 'Démo live',
                luxDefNavHow: 'Comment ça marche',
                luxDefNavSolutions: 'Solutions',
                luxDefNavAbout: 'À propos',
                luxDefHeroEyebrow: 'Agriculture intelligente',
                luxDefHeroTitle: 'L’intelligence au service de vos cultures.',
                luxDefHeroAccent: 'cultures.',
                luxDefHeroText: 'Rayat transforme les données de votre exploitation agricole en décisions précises pour optimiser l’eau, anticiper les risques et améliorer les rendements.',
                luxDefHeroPrimary: 'Découvrir la démo live',
                luxDefHeroSecondary: 'Demander une démo',
                luxDefRealtime: 'Données en temps réel',
                luxDefSmartDecisions: 'Décisions intelligentes',
                luxDefWebMobile: 'Accès web et mobile',
                luxDefSecure: 'Sûr et fiable',
                luxDefOnline: 'En ligne',
                luxDefOffline: 'Hors ligne',
                luxDefHeroFarm: 'Serre de bananes - Taroudant',
                luxDefUpdated: 'Données mises à jour : aujourd’hui, 11:52',
                luxDefCropStatusLabel: 'État de la culture',
                luxDefOptimal: 'Optimal',
                luxDefGood: 'Bon',
                luxDefDemoEyebrow: 'Démo live',
                luxDefDemoTitle: 'Serre de bananes Taroudant',
                luxDefDemoText: 'Une serre réelle connectée à la plateforme Rayat, surveillée 24/7.',
                luxDefContinuous: 'Surveillance continue',
                luxDefLiveData: 'Données en temps réel',
                luxDefHistorical: 'Historique et analyses',
                luxDefSmartAlerts: 'Alertes intelligentes',
                luxDefViewDemo: 'Voir la démo live',
                luxDefMapCardTitle: 'Serre de bananes - Taroudant',
                luxDefMapArea: 'Superficie : 1 ha',
                luxDefViewDetails: 'Voir les détails',
                luxDefHowEyebrow: 'Processus Rayat',
                luxDefHowTitle: 'Technologie simple, valeur réelle.',
                luxDefStepSensorsTitle: 'Capteurs',
                luxDefStepSensorsText: 'Surveillent les paramètres du sol et de l’environnement.',
                luxDefStepRouterTitle: 'Routeur Rayat',
                luxDefStepRouterText: 'Transmet les données de façon sûre et continue.',
                luxDefStepCloudTitle: 'Cloud Rayat',
                luxDefStepCloudText: 'Les données sont stockées, analysées et protégées.',
                luxDefStepDashboardTitle: 'Tableau de bord live',
                luxDefStepDashboardText: 'Visualisez tout en temps réel, où que vous soyez.',
                luxDefStepAiTitle: 'Conseils IA',
                luxDefStepAiText: 'Recevez des suggestions intelligentes et pratiques pour vos cultures.',
                luxDefPlatformEyebrow: 'La plateforme Rayat',
                luxDefPlatformTitle: 'Tout sous contrôle.',
                luxDefPlatformTitleFull: 'Tout sous contrôle, dans un seul tableau de bord.',
                luxDefPlatformText: 'Une plateforme unique pour surveiller, analyser et gérer votre exploitation agricole.',
                luxDefPlatformDashboard: 'Tableau de bord intuitif',
                luxDefPlatformMap: 'Carte des parcelles',
                luxDefPlatformAnalytics: 'Analyses avancées',
                luxDefPlatformAlerts: 'Alertes en temps réel',
                luxDefPlatformReports: 'Historique et rapports',
                luxDefPlatformMulti: 'Gestion multi-exploitation',
                luxDefRealtimePanel: 'Données en temps réel',
                luxDefPlatformMainParams: 'Évolution des principaux paramètres',
                luxDefPlatformMapTitle: 'Carte des parcelles',
                luxDefPlatformRecentAlerts: 'Dernières alertes',
                luxDefPlatformAlertMoisture: 'Humidité du sol basse',
                luxDefPlatformAlertIrrigation: 'Irrigation programmée',
                luxDefPlatformAlertNormal: 'Tous les paramètres sont normaux',
                luxDefPlatformViewAlerts: 'Voir toutes les alertes',
                luxDefPlatformFarmLabel: 'Ferme démo',
                luxDefPlatformLocation: 'Taroudant, Maroc',
                luxDefAllParameters: 'Voir tous les paramètres',
                luxDefSolutionsEyebrow: 'Solutions pour chaque culture',
                luxDefSolutionsTitle: 'De la serre à la pleine terre.',
                luxDefSolutionsText: 'Technologie adaptative pour chaque culture, dans chaque environnement.',
                luxDefGreenhouses: 'Serres',
                luxDefBananas: 'Bananes',
                luxDefCitrus: 'Agrumes',
                luxDefVegetables: 'Maraîchage',
                luxDefFarms: 'Exploitations agricoles',
                luxDefMobileEyebrow: 'App mobile',
                luxDefMobileTitle: 'Votre champ, toujours dans votre poche.',
                luxDefMobileText: 'Surveillez et gérez votre exploitation directement depuis votre smartphone, où que vous soyez.',
                luxDefWaterSaving: 'Économie d’eau',
                luxDefProductivity: 'Productivité accrue',
                luxDefMonitoring: 'Surveillance continue',
                luxDefCompanies: 'Entreprises nous font confiance',
                luxDefSatisfaction: 'Satisfaction client',
                luxDefWaterSavingText: 'Moins de gaspillage, plus de durabilité.',
                luxDefProductivityText: 'Données et insights pour des cultures plus performantes.',
                luxDefMonitoringText: 'Vos champs sous contrôle, toujours.',
                luxDefCompaniesText: 'Agriculteurs et entreprises choisissent Rayat chaque jour.',
                luxDefSatisfactionText: 'Technologie fiable, résultats concrets.',
                luxDefFooterText: 'Des solutions intelligentes pour une agriculture plus efficace, durable et productive.',
                luxDefFooterHomeDesc: 'Retour à l’accueil',
                luxDefFooterSolutionsDesc: 'Nos solutions pour chaque culture',
                luxDefFooterDemoDesc: 'Données réelles de la serre de Taroudant',
                luxDefFooterHowDesc: 'Découvrez comment fonctionne Rayat',
                luxDefFooterAboutDesc: 'Notre histoire et notre mission',
                luxDefFooterWhatsapp: 'WhatsApp',
                luxDefFooterWhatsappNumber: '+212 6 00 00 00 00',
                luxDefFooterEmail: 'Email',
                luxDefFooterEmailAddress: 'contact@rayat.ma',
                luxDefFooterDemoRequest: 'Demander une démo',
                luxDefFooterDemoRequestText: 'Réserver une démonstration',
                luxDefFooterPlatform: 'La plateforme',
                luxDefFooterDemo: 'Démo live',
                luxDefFooterHow: 'Comment ça marche',
                luxDefFooterCopyright: '© 2026 Rayat Smart Monitoring. Tous droits réservés.',
                luxDefDashMenuDashboard: 'Tableau de bord',
                luxDefDashMenuParcels: 'Parcelles',
                luxDefDashMenuMap: 'Carte',
                luxDefDashMenuSensors: 'Capteurs',
                luxDefDashMenuAlerts: 'Alertes',
                luxDefDashMenuAnalytics: 'Analyses',
                luxDefDashMenuReports: 'Rapports',
                luxDefDashMenuSettings: 'Paramètres',
                luxDefOverview: 'Vue d’ensemble',
                luxDefToday: 'Aujourd’hui',
                luxDefPhoneHome: 'Accueil',
                luxDefPhoneMap: 'Carte',
                luxDefPhoneAlerts: 'Alertes',
                luxDefPhoneArea: 'Zone',
                luxDefFooterApp: 'App mobile',
                luxDefFooterSensors: 'Capteurs',
                luxDefFooterAnalytics: 'Analyses',
                luxDefFooterSecurity: 'Sécurité',
                luxDefFooterGreenhouse: 'Serre Taroudant',
                luxDefFooterRealtime: 'Données en temps réel',
                luxDefFooterHistory: 'Historique',
                luxDefFooterAlerts: 'Alertes',
                luxDefFooterTechnology: 'Technologie',
                luxDefFooterIntegration: 'Intégration',
                luxDefFooterProcess: 'Processus',
                luxDefFooterStory: 'Notre histoire',
                luxDefFooterMission: 'Mission',
                luxDefFooterContact: 'Contact',
                luxDefPrivacy: 'Politique de confidentialité',
                luxDefCookie: 'Politique cookies'
            },
            ar: {
                luxDefNavHome: 'الرئيسية',
                luxDefNavPlatform: 'المنصة',
                luxDefNavDemo: 'عرض مباشر',
                luxDefNavHow: 'كيف يعمل',
                luxDefNavSolutions: 'الحلول',
                luxDefNavAbout: 'من نحن',
                luxDefHeroEyebrow: 'زراعة ذكية',
                luxDefHeroTitle: 'ذكاء في خدمة محاصيلك.',
                luxDefHeroAccent: 'محاصيلك.',
                luxDefHeroText: 'تحول Rayat بيانات مزرعتك إلى قرارات دقيقة لتحسين المياه، توقع المخاطر، وزيادة المردودية.',
                luxDefHeroPrimary: 'استكشف العرض المباشر',
                luxDefHeroSecondary: 'اطلب عرضا',
                luxDefRealtime: 'بيانات فورية',
                luxDefSmartDecisions: 'قرارات ذكية',
                luxDefWebMobile: 'وصول عبر الويب والجوال',
                luxDefSecure: 'آمن وموثوق',
                luxDefOnline: 'متصل',
                luxDefOffline: 'غير متصل',
                luxDefHeroFarm: 'دفيئة الموز - تارودانت',
                luxDefUpdated: 'تم تحديث البيانات: اليوم، 11:52',
                luxDefCropStatusLabel: 'حالة المحصول',
                luxDefOptimal: 'مثالي',
                luxDefGood: 'جيد',
                luxDefDemoEyebrow: 'عرض مباشر',
                luxDefDemoTitle: 'دفيئة موز تارودانت',
                luxDefDemoText: 'دفيئة حقيقية متصلة بمنصة Rayat وتتم مراقبتها على مدار الساعة.',
                luxDefContinuous: 'مراقبة مستمرة',
                luxDefLiveData: 'بيانات فورية',
                luxDefHistorical: 'السجل والتحليلات',
                luxDefSmartAlerts: 'تنبيهات ذكية',
                luxDefViewDemo: 'مشاهدة العرض المباشر',
                luxDefMapCardTitle: 'دفيئة الموز - تارودانت',
                luxDefMapArea: 'المساحة: 1 هكتار',
                luxDefViewDetails: 'عرض التفاصيل',
                luxDefHowEyebrow: 'عملية Rayat',
                luxDefHowTitle: 'تقنية بسيطة، قيمة حقيقية.',
                luxDefStepSensorsTitle: 'الحساسات',
                luxDefStepSensorsText: 'تراقب معايير التربة والبيئة.',
                luxDefStepRouterTitle: 'راوتر Rayat',
                luxDefStepRouterText: 'يرسل البيانات بشكل آمن ومستمر.',
                luxDefStepCloudTitle: 'سحابة Rayat',
                luxDefStepCloudText: 'يتم تخزين البيانات وتحليلها وحمايتها.',
                luxDefStepDashboardTitle: 'لوحة مباشرة',
                luxDefStepDashboardText: 'شاهد كل شيء في الوقت الحقيقي أينما كنت.',
                luxDefStepAiTitle: 'نصائح IA',
                luxDefStepAiText: 'احصل على اقتراحات ذكية وعملية لمحاصيلك.',
                luxDefPlatformEyebrow: 'منصة Rayat',
                luxDefPlatformTitle: 'كل شيء تحت السيطرة.',
                luxDefPlatformTitleFull: 'كل شيء تحت السيطرة في لوحة واحدة.',
                luxDefPlatformText: 'منصة واحدة لمراقبة وتحليل وإدارة نشاطك الزراعي.',
                luxDefPlatformDashboard: 'لوحة سهلة',
                luxDefPlatformMap: 'خريطة القطع',
                luxDefPlatformAnalytics: 'تحليلات متقدمة',
                luxDefPlatformAlerts: 'تنبيهات فورية',
                luxDefPlatformReports: 'سجل وتقارير',
                luxDefPlatformMulti: 'إدارة عدة مزارع',
                luxDefRealtimePanel: 'بيانات فورية',
                luxDefPlatformMainParams: 'تطور المؤشرات الرئيسية',
                luxDefPlatformMapTitle: 'خريطة القطع',
                luxDefPlatformRecentAlerts: 'آخر التنبيهات',
                luxDefPlatformAlertMoisture: 'رطوبة التربة منخفضة',
                luxDefPlatformAlertIrrigation: 'تمت جدولة الري',
                luxDefPlatformAlertNormal: 'كل المؤشرات طبيعية',
                luxDefPlatformViewAlerts: 'عرض كل التنبيهات',
                luxDefPlatformFarmLabel: 'مزرعة تجريبية',
                luxDefPlatformLocation: 'تارودانت، المغرب',
                luxDefAllParameters: 'عرض كل المعايير',
                luxDefSolutionsEyebrow: 'حلول لكل محصول',
                luxDefSolutionsTitle: 'من الدفيئة إلى الحقل المفتوح.',
                luxDefSolutionsText: 'تقنية متكيفة لكل محصول وفي كل بيئة.',
                luxDefGreenhouses: 'الدفيئات',
                luxDefBananas: 'الموز',
                luxDefCitrus: 'الحمضيات',
                luxDefVegetables: 'الخضروات',
                luxDefFarms: 'المزارع',
                luxDefMobileEyebrow: 'تطبيق الجوال',
                luxDefMobileTitle: 'حقلك دائما في جيبك.',
                luxDefMobileText: 'راقب وأدر مزرعتك مباشرة من هاتفك الذكي أينما كنت.',
                luxDefWaterSaving: 'توفير المياه',
                luxDefProductivity: 'زيادة الإنتاجية',
                luxDefMonitoring: 'مراقبة مستمرة',
                luxDefCompanies: 'شركات تثق بنا',
                luxDefSatisfaction: 'رضا العملاء',
                luxDefWaterSavingText: 'هدر أقل واستدامة أكبر.',
                luxDefProductivityText: 'بيانات ورؤى لمحاصيل أكثر أداء.',
                luxDefMonitoringText: 'حقولك تحت السيطرة دائما.',
                luxDefCompaniesText: 'مزارعون وشركات يختارون Rayat كل يوم.',
                luxDefSatisfactionText: 'تقنية موثوقة ونتائج ملموسة.',
                luxDefFooterText: 'حلول ذكية لزراعة أكثر كفاءة واستدامة وإنتاجية.',
                luxDefFooterHomeDesc: 'العودة إلى الرئيسية',
                luxDefFooterSolutionsDesc: 'حلولنا لكل محصول',
                luxDefFooterDemoDesc: 'بيانات حقيقية من دفيئة تارودانت',
                luxDefFooterHowDesc: 'اكتشف كيف تعمل Rayat',
                luxDefFooterAboutDesc: 'قصتنا ومهمتنا',
                luxDefFooterWhatsapp: 'واتساب',
                luxDefFooterWhatsappNumber: '+212 6 00 00 00 00',
                luxDefFooterEmail: 'البريد الإلكتروني',
                luxDefFooterEmailAddress: 'contact@rayat.ma',
                luxDefFooterDemoRequest: 'اطلب عرضا',
                luxDefFooterDemoRequestText: 'احجز عرضا توضيحيا',
                luxDefFooterPlatform: 'المنصة',
                luxDefFooterDemo: 'عرض مباشر',
                luxDefFooterHow: 'كيف يعمل',
                luxDefFooterCopyright: '© 2026 Rayat Smart Monitoring. جميع الحقوق محفوظة.',
                luxDefDashMenuDashboard: 'لوحة التحكم',
                luxDefDashMenuParcels: 'القطع',
                luxDefDashMenuMap: 'الخريطة',
                luxDefDashMenuSensors: 'الحساسات',
                luxDefDashMenuAlerts: 'التنبيهات',
                luxDefDashMenuAnalytics: 'التحليلات',
                luxDefDashMenuReports: 'التقارير',
                luxDefDashMenuSettings: 'الإعدادات',
                luxDefOverview: 'نظرة عامة',
                luxDefToday: 'اليوم',
                luxDefPhoneHome: 'الرئيسية',
                luxDefPhoneMap: 'الخريطة',
                luxDefPhoneAlerts: 'تنبيهات',
                luxDefPhoneArea: 'المنطقة',
                luxDefFooterApp: 'تطبيق الجوال',
                luxDefFooterSensors: 'الحساسات',
                luxDefFooterAnalytics: 'التحليلات',
                luxDefFooterSecurity: 'الأمان',
                luxDefFooterGreenhouse: 'دفيئة تارودانت',
                luxDefFooterRealtime: 'بيانات فورية',
                luxDefFooterHistory: 'السجل',
                luxDefFooterAlerts: 'التنبيهات',
                luxDefFooterTechnology: 'التقنية',
                luxDefFooterIntegration: 'التكامل',
                luxDefFooterProcess: 'العملية',
                luxDefFooterStory: 'قصتنا',
                luxDefFooterMission: 'المهمة',
                luxDefFooterContact: 'اتصال',
                luxDefPrivacy: 'سياسة الخصوصية',
                luxDefCookie: 'سياسة ملفات الارتباط'
            },
            zgh: {
                luxDefNavHome: 'ⴰⵙⵏⵓⴱⴳ',
                luxDefNavPlatform: 'ⵜⴰⵙⵏⴰ',
                luxDefNavDemo: 'ⴷⵉⵎⵓ ⵍⴰⵢⴼ',
                luxDefNavHow: 'ⵎⴰⵎⴽ ⵜⵙⵡⵓⵔⵉ',
                luxDefNavSolutions: 'ⵜⵉⴼⵔⴰⵜⵉⵏ',
                luxDefNavAbout: 'ⵖⴼ ⵏⵏⵖ',
                luxDefHeroEyebrow: 'ⵜⴰⴼⵍⴰⵃⵜ ⵜⴰⵎⴰⵙⵙⴰⵏⵜ',
                luxDefHeroTitle: 'ⵜⴰⵎⵓⵙⵙⵏⵉ ⴳ ⵜⵉⵙⵙⵉ ⵏ ⵉⴳⵎⴰⵎⵏ ⵏⵏⴽ.',
                luxDefHeroAccent: 'ⵏⵏⴽ.',
                luxDefHeroText: 'Rayat ⵜⵙⵙⵎⵓⵜⵜⵓⵢ ⵉⵙⴼⴽⴰ ⵏ ⵜⴼⵍⴰⵃⵜ ⵏⵏⴽ ⵙ ⵜⵉⵖⵜⴰⵙⵉⵏ ⵉⵎⵖⵓⴷⴰⵏ ⵉ ⵓⵙⴼⵙⵉ ⵏ ⵡⴰⵎⴰⵏ ⴷ ⵓⵙⵎⵓⵔⵙ ⵏ ⵉⵎⵓⴽⵔⵉⵙⵏ.',
                luxDefHeroPrimary: 'ⵥⵕ ⴷⵉⵎⵓ ⵍⴰⵢⴼ',
                luxDefHeroSecondary: 'ⵙⵙⵓⵜⵔ ⴷⵉⵎⵓ',
                luxDefRealtime: 'ⵉⵙⴼⴽⴰ ⴳ ⵡⴰⴽⵓⴷ',
                luxDefSmartDecisions: 'ⵜⵉⵖⵜⴰⵙⵉⵏ ⵜⵉⵎⴰⵙⵙⴰⵏⵉⵏ',
                luxDefWebMobile: 'ⴰⵏⴽⵛⵓⵎ ⵡⵉⴱ ⴷ ⵎⵓⴱⴰⵢⵍ',
                luxDefSecure: 'ⴰⵎⵏⴰⵢ ⴷ ⴰⵎⴰⵣⵣⴰⵍ',
                luxDefOnline: 'ⵉⵇⵇⵏ',
                luxDefOffline: 'ⵓⵔ ⵉⵇⵇⵏ',
                luxDefHeroFarm: 'ⵜⴰⵙⵔⴳⴰ ⵏ ⵜⵉⴳⴰⵢⵢⴰ - ⵜⴰⵔⵓⴷⴰⵏⵜ',
                luxDefUpdated: 'ⵉⵙⴼⴽⴰ ⵜⵜⵓⵙⵏⴼⵍⵏ: ⴰⵙⵙⴰ, 11:52',
                luxDefCropStatusLabel: 'ⴰⴷⴷⴰⴷ ⵏ ⵜⵉⵔⵣⵉ',
                luxDefOptimal: 'ⴰⵎⵓⵔⵙ',
                luxDefGood: 'ⵉⵖⵓⴷⴰ',
                luxDefDemoEyebrow: 'ⴷⵉⵎⵓ ⵍⴰⵢⴼ',
                luxDefDemoTitle: 'ⵜⴰⵙⵔⴳⴰ ⵏ ⵜⵉⴳⴰⵢⵢⴰ ⵜⴰⵔⵓⴷⴰⵏⵜ',
                luxDefDemoText: 'ⵜⴰⵙⵔⴳⴰ ⵜⴰⵎⵙⵙⵉⵍⵜ ⵜⵇⵇⵏ ⵖⵔ ⵜⴰⵙⵏⴰ Rayat, ⵜⵜⵓⴹⴼⴰⵕ 24/7.',
                luxDefContinuous: 'ⴰⴹⴼⴰⵕ ⵓⵔ ⵉⵃⴱⵉⵙ',
                luxDefLiveData: 'ⵉⵙⴼⴽⴰ ⴳ ⵡⴰⴽⵓⴷ',
                luxDefHistorical: 'ⴰⵎⵣⵔⵓⵢ ⴷ ⵜⵙⵍⴹⵜ',
                luxDefSmartAlerts: 'ⵉⵍⵖⴰ ⵉⵎⴰⵙⵙⴰⵏⵏ',
                luxDefViewDemo: 'ⵥⵕ ⴷⵉⵎⵓ ⵍⴰⵢⴼ',
                luxDefMapCardTitle: 'ⵜⴰⵙⵔⴳⴰ ⵏ ⵜⵉⴳⴰⵢⵢⴰ - ⵜⴰⵔⵓⴷⴰⵏⵜ',
                luxDefMapArea: 'ⵜⴰⵎⵏⴰⴹⵜ: 1 ha',
                luxDefViewDetails: 'ⵥⵕ ⵜⴰⵍⵇⵇⴰⵢⵜ',
                luxDefHowEyebrow: 'ⴰⴽⴰⵍⴰ Rayat',
                luxDefHowTitle: 'ⵜⵉⴽⵏⵓⵍⵓⵊⵉⵜ ⵜⴰⵙⵎⵔⴰⵔⵜ, ⴰⵣⴰⵍ ⴰⵎⵙⵙⵉⵍ.',
                luxDefStepSensorsTitle: 'ⵉⵎⴰⵙⵙⵏ',
                luxDefStepSensorsText: 'ⵜⵜⵙⵙⵏⵏ ⵉⵙⴼⴽⴰ ⵏ ⵡⴰⴽⴰⵍ ⴷ ⵜⵡⵏⵏⴰⴹⵜ.',
                luxDefStepRouterTitle: 'ⵔⵓⵜⵔ Rayat',
                luxDefStepRouterText: 'ⵉⵜⵜⴰⵣⵏ ⵉⵙⴼⴽⴰ ⵙ ⵍⴰⵎⴰⵏ.',
                luxDefStepCloudTitle: 'ⴽⵍⴰⵡⴷ Rayat',
                luxDefStepCloudText: 'ⵉⵙⴼⴽⴰ ⵜⵜⵓⵃⵟⵟⴰⵏ, ⵜⵜⵓⵙⵍⴹⵏ, ⵜⵜⵓⵃⴹⴰⵏ.',
                luxDefStepDashboardTitle: 'ⵜⴰⴱⵍⵓⵜ ⵍⴰⵢⴼ',
                luxDefStepDashboardText: 'ⵥⵕ ⴽⵓⵍⵍⵓ ⴳ ⵡⴰⴽⵓⴷ, ⵎⴰⵏⵉ ⵜⵍⵍⵉⴷ.',
                luxDefStepAiTitle: 'ⵜⵉⵡⵉⵙⵉⵡⵉⵏ IA',
                luxDefStepAiText: 'ⴰⵡⵉ ⵜⵉⵡⵉⵙⵉⵡⵉⵏ ⵜⵉⵎⴰⵙⵙⴰⵏⵉⵏ ⵉ ⵜⴽⵍⵉⵡⵉⵏ ⵏⵏⴽ.',
                luxDefPlatformEyebrow: 'ⵜⴰⵙⵏⴰ Rayat',
                luxDefPlatformTitle: 'ⴽⵓⵍⵍⵓ ⴷⴷⴰⵡ ⵓⵙⴼⵔⴽ.',
                luxDefPlatformTitleFull: 'ⴽⵓⵍⵍⵓ ⴷⴷⴰⵡ ⵓⵙⴼⵔⴽ ⴳ ⵢⴰⵜ ⵜⴰⴱⵍⵓⵜ.',
                luxDefPlatformText: 'ⵢⴰⵜ ⵜⴰⵙⵏⴰ ⵉ ⵓⴹⴼⴰⵕ, ⵜⴰⵙⵍⴹⵜ ⴷ ⵓⵙⴼⵔⴽ ⵏ ⵜⴼⵍⴰⵃⵜ ⵏⵏⴽ.',
                luxDefPlatformDashboard: 'ⵜⴰⴱⵍⵓⵜ ⵜⴰⵙⵎⵔⴰⵔⵜ',
                luxDefPlatformMap: 'ⵜⴰⴽⴰⵕⴹⴰ ⵏ ⵜⵎⵣⵉⵣⵡⴰ',
                luxDefPlatformAnalytics: 'ⵜⵉⵙⵍⴹⵉⵏ ⵜⵉⵎⵖⵓⴷⴰⵏ',
                luxDefPlatformAlerts: 'ⵉⵍⵖⴰ ⴳ ⵡⴰⴽⵓⴷ',
                luxDefPlatformReports: 'ⴰⵎⵣⵔⵓⵢ ⴷ ⵉⵎⵇⵇⵉⵎⵏ',
                luxDefPlatformMulti: 'ⴰⵙⴼⵔⴽ ⵏ ⵓⴳⴳⴰⵔ ⵏ ⵜⴼⵍⴰⵃⵜ',
                luxDefRealtimePanel: 'ⵉⵙⴼⴽⴰ ⴳ ⵡⴰⴽⵓⴷ',
                luxDefPlatformMainParams: 'ⴰⵎⵓⵙⵙⵓ ⵏ ⵉⵎⵥⵍⴰⵢⵏ',
                luxDefPlatformMapTitle: 'ⵜⴰⴽⴰⵕⴹⴰ ⵏ ⵜⵎⵣⵉⵣⵡⴰ',
                luxDefPlatformRecentAlerts: 'ⵉⵍⵖⴰ ⵉⵎⴳⴳⵓⵔⴰ',
                luxDefPlatformAlertMoisture: 'ⵜⵉⵙⵓⵙⵉ ⵏ ⵡⴰⴽⴰⵍ ⵜⵏⵇⵇⵙ',
                luxDefPlatformAlertIrrigation: 'ⴰⵙⵙⵓ ⵉⵜⵜⵓⵙⵖⵉⵡⵙ',
                luxDefPlatformAlertNormal: 'ⴽⵓⵍⵍⵓ ⵉⵎⵥⵍⴰⵢⵏ ⴳ ⵓⵎⵓⵔⵙ',
                luxDefPlatformViewAlerts: 'ⵥⵕ ⴽⵓⵍⵍⵓ ⵉⵍⵖⴰ',
                luxDefPlatformFarmLabel: 'ⵜⴰⴼⵍⴰⵃⵜ ⴷⵉⵎⵓ',
                luxDefPlatformLocation: 'ⵜⴰⵔⵓⴷⴰⵏⵜ, ⵍⵎⵖⵔⵉⴱ',
                luxDefAllParameters: 'ⵥⵕ ⴽⵓⵍⵍⵓ ⵉⵎⵥⵍⴰⵢⵏ',
                luxDefSolutionsEyebrow: 'ⵜⵉⴼⵔⴰⵜⵉⵏ ⵉ ⴽⵓⵍⵍⵓ ⵜⵉⵔⵣⵉ',
                luxDefSolutionsTitle: 'ⵙⴳ ⵜⵙⵔⴳⴰ ⴰⵔ ⵡⴰⴽⴰⵍ.',
                luxDefSolutionsText: 'ⵜⵉⴽⵏⵓⵍⵓⵊⵉⵜ ⵜⵜⵎⵙⴰⵙⴰ ⵉ ⴽⵓⵍⵍⵓ ⵜⵉⵔⵣⵉ.',
                luxDefGreenhouses: 'ⵜⵉⵙⵔⴳⵉⵡⵉⵏ',
                luxDefBananas: 'ⵜⵉⴳⴰⵢⵢⴰ',
                luxDefCitrus: 'ⵍⵃⴰⵎⴹ',
                luxDefVegetables: 'ⵉⴼⵔⴰⵙ',
                luxDefFarms: 'ⵜⵉⴼⵍⴰⵃⵉⵏ',
                luxDefMobileEyebrow: 'ⴰⵙⵏⵙ ⵎⵓⴱⴰⵢⵍ',
                luxDefMobileTitle: 'ⴰⴳⵔ ⵏⵏⴽ ⴷⴰⵢⵎⴰ ⴳ ⵜⵉⵙⵙⵉ ⵏⵏⴽ.',
                luxDefMobileText: 'ⴹⴼⴰⵕ ⴷ ⵙⴼⵔⴽ ⵜⴼⵍⴰⵃⵜ ⵏⵏⴽ ⵙⴳ ⵙⵎⴰⵔⵜⴼⵓⵏ, ⵎⴰⵏⵉ ⵜⵍⵍⵉⴷ.',
                luxDefWaterSaving: 'ⴰⵙⵏⵊⵎ ⵏ ⵡⴰⵎⴰⵏ',
                luxDefProductivity: 'ⴰⵙⵏⴼⵍ ⵏ ⵜⵎⵓⵔⴰ',
                luxDefMonitoring: 'ⴰⴹⴼⴰⵕ ⵓⵔ ⵉⵃⴱⵉⵙ',
                luxDefCompanies: 'ⵜⵉⵎⵙⵙⵓⵔⵉⵏ ⵜⵜⴰⵎⵏⵏⵜ ⴳⵏⵖ',
                luxDefSatisfaction: 'ⴰⵔⴹⴰ ⵏ ⵉⵎⵙⵙⵎⵔⴰⵙⵏ',
                luxDefWaterSavingText: 'ⴽⵔⴰ ⵏ ⵓⵙⴼⵙⴷ, ⴰⵎⵣⵓⵏ ⵉⴳⴳⵓⵜⵏ.',
                luxDefProductivityText: 'ⵉⵙⴼⴽⴰ ⴷ ⵜⵉⵙⵍⴹⵉⵏ ⵉ ⵜⵉⵔⵣⴰ ⵉⴳⴳⵓⵜⵏ.',
                luxDefMonitoringText: 'ⵉⴳⵔⴰⵏ ⵏⵏⴽ ⴷⴷⴰⵡ ⵓⴹⴼⴰⵕ, ⴷⴰⵢⵎⴰ.',
                luxDefCompaniesText: 'ⵉⴼⵍⴰⵃⵏ ⴷ ⵜⵎⵙⵙⵓⵔⵉⵏ ⵜⵜⴰⵎⵏⵏ ⴳ Rayat.',
                luxDefSatisfactionText: 'ⵜⵉⴽⵏⵓⵍⵓⵊⵉⵜ ⵜⴰⵎⵏⵜ, ⵉⴳⵎⴰⴹ ⵉⵥⴹⴰⵕⵏ.',
                luxDefFooterText: 'ⵜⵉⴼⵔⴰⵜⵉⵏ ⵜⵉⵎⴰⵙⵙⴰⵏⵉⵏ ⵉ ⵜⴼⵍⴰⵃⵜ ⵜⴰⵎⴰⵔⵉⵔⵜ.',
                luxDefFooterHomeDesc: 'ⵓⵖⴰⵍ ⵖⵔ ⴰⵙⵏⵓⴱⴳ',
                luxDefFooterSolutionsDesc: 'ⵜⵉⴼⵔⴰⵜⵉⵏ ⵏⵏⵖ ⵉ ⴽⵓⵍⵍⵓ ⵜⵉⵔⵣⵉ',
                luxDefFooterDemoDesc: 'ⵉⵙⴼⴽⴰ ⵉⵎⵙⵙⵉⵍⵏ ⵙⴳ ⵜⵙⵔⴳⴰ ⵏ ⵜⴰⵔⵓⴷⴰⵏⵜ',
                luxDefFooterHowDesc: 'ⵥⵕ ⵎⴰⵎⴽ ⵜⵙⵡⵓⵔⵉ Rayat',
                luxDefFooterAboutDesc: 'ⴰⵎⵣⵔⵓⵢ ⵏⵏⵖ ⴷ ⵜⵎⵙⵙⵉⵍⵜ ⵏⵏⵖ',
                luxDefFooterWhatsapp: 'WhatsApp',
                luxDefFooterWhatsappNumber: '+212 6 00 00 00 00',
                luxDefFooterEmail: 'Email',
                luxDefFooterEmailAddress: 'contact@rayat.ma',
                luxDefFooterDemoRequest: 'ⵙⵙⵓⵜⵔ ⴷⵉⵎⵓ',
                luxDefFooterDemoRequestText: 'ⵙⵖⵉⵡⵙ ⴰⵙⵎⵍⵍⵉ',
                luxDefFooterPlatform: 'ⵜⴰⵙⵏⴰ',
                luxDefFooterDemo: 'ⴷⵉⵎⵓ ⵍⴰⵢⴼ',
                luxDefFooterHow: 'ⵎⴰⵎⴽ ⵜⵙⵡⵓⵔⵉ',
                luxDefFooterCopyright: '© 2026 Rayat Smart Monitoring. ⴽⵓⵍⵍⵓ ⵉⵣⵔⴼⴰⵏ ⵜⵜⵓⵃⴹⴰⵏ.',
                luxDefDashMenuDashboard: 'ⵜⴰⴱⵍⵓⵜ',
                luxDefDashMenuParcels: 'ⵜⵉⵎⵣⵉⵣⵡⴰ',
                luxDefDashMenuMap: 'ⵜⴰⴽⴰⵕⴹⴰ',
                luxDefDashMenuSensors: 'ⵉⵎⴰⵙⵙⵏ',
                luxDefDashMenuAlerts: 'ⵉⵍⵖⴰ',
                luxDefDashMenuAnalytics: 'ⵜⵉⵙⵍⴹⵉⵏ',
                luxDefDashMenuReports: 'ⵉⵎⵇⵇⵉⵎⵏ',
                luxDefDashMenuSettings: 'ⵉⵙⵖⵡⴰⵏ',
                luxDefOverview: 'ⴰⵎⵓⵙⵙⵓ',
                luxDefToday: 'ⴰⵙⵙⴰ',
                luxDefPhoneHome: 'ⴰⵙⵏⵓⴱⴳ',
                luxDefPhoneMap: 'ⵜⴰⴽⴰⵕⴹⴰ',
                luxDefPhoneAlerts: 'ⵉⵍⵖⴰ',
                luxDefPhoneArea: 'ⵜⴰⵎⵏⴰⴹⵜ',
                luxDefFooterApp: 'ⴰⵙⵏⵙ ⵎⵓⴱⴰⵢⵍ',
                luxDefFooterSensors: 'ⵉⵎⴰⵙⵙⵏ',
                luxDefFooterAnalytics: 'ⵜⵉⵙⵍⴹⵉⵏ',
                luxDefFooterSecurity: 'ⵍⴰⵎⴰⵏ',
                luxDefFooterGreenhouse: 'ⵜⴰⵙⵔⴳⴰ ⵜⴰⵔⵓⴷⴰⵏⵜ',
                luxDefFooterRealtime: 'ⵉⵙⴼⴽⴰ ⴳ ⵡⴰⴽⵓⴷ',
                luxDefFooterHistory: 'ⴰⵎⵣⵔⵓⵢ',
                luxDefFooterAlerts: 'ⵉⵍⵖⴰ',
                luxDefFooterTechnology: 'ⵜⵉⴽⵏⵓⵍⵓⵊⵉⵜ',
                luxDefFooterIntegration: 'ⴰⵙⴷⵓⵙ',
                luxDefFooterProcess: 'ⴰⴽⴰⵍⴰ',
                luxDefFooterStory: 'ⵜⴰⵎⴰⵢⵏⵓⵜ ⵏⵏⵖ',
                luxDefFooterMission: 'ⵜⴰⵡⵓⵔⵉ',
                luxDefFooterContact: 'ⴰⵏⵢⴰⵍⴽⴰⵎ',
                luxDefPrivacy: 'Privacy Policy',
                luxDefCookie: 'Cookie Policy'
            }
        };

        ['it', 'en', 'fr', 'ar', 'tz', 'zgh'].forEach((lang) => {
            translations[lang] = {
                ...(translations[lang] || {}),
                ...(RAYAT_DEFINITIVE_HOME_TRANSLATIONS[lang === 'tz' ? 'zgh' : lang] || RAYAT_DEFINITIVE_HOME_TRANSLATIONS.fr)
            };
        });

        function renderRayatDefinitiveIcon(name) {
            const icons = {
                clock: '<circle cx="12" cy="12" r="8"></circle><path d="M12 7.5V12l3 2"></path>',
                brain: '<path d="M9 4.8a3.2 3.2 0 0 0-3 3.4A3.6 3.6 0 0 0 4.5 15c0 2.3 1.6 4 3.7 4 .8 1.2 2 2 3.8 2s3-.8 3.8-2c2.1 0 3.7-1.7 3.7-4A3.6 3.6 0 0 0 18 8.2a3.2 3.2 0 0 0-6-1.5A3.2 3.2 0 0 0 9 4.8Z"></path><path d="M12 6.7V21M8.2 10.4c1.8.1 3 .9 3.8 2.4M15.8 10.4c-1.8.1-3 .9-3.8 2.4"></path>',
                screen: '<rect x="4" y="6" width="16" height="11" rx="1.8"></rect><path d="M9 20h6M12 17v3"></path>',
                shield: '<path d="M12 3.8 19 6.5v5.3c0 4.2-2.8 7.4-7 8.9-4.2-1.5-7-4.7-7-8.9V6.5l7-2.7Z"></path><path d="m9.2 12 2 2 4.2-4.4"></path>',
                drop: '<path d="M12 3.8s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"></path><path d="M9.2 15.4c.6 1.3 1.6 2 3 2"></path>',
                temp: '<path d="M10 14.7V5.8a2 2 0 1 1 4 0v8.9a4 4 0 1 1-4 0Z"></path><path d="M12 8v8"></path>',
                bolt: '<path d="m13 2.8-7 11h5l-1 7.4 7.2-11h-5L13 2.8Z"></path>',
                leaf: '<path d="M19.5 4.8C11.5 5 6 8.8 6 14.2c0 3 2 5.2 5.2 5.2 5.4 0 8.3-6.3 8.3-14.6Z"></path><path d="M5 20c2.4-5.2 6.4-8.4 11-10.5"></path>',
                sensor: '<path d="M12 4v5M12 15v5M4 12h5M15 12h5"></path><circle cx="12" cy="12" r="3"></circle>',
                router: '<rect x="5" y="10" width="14" height="7" rx="2"></rect><path d="M8 14h.01M12 14h.01M16 14h.01M9 10V7M15 10V7"></path>',
                cloud: '<path d="M7.5 18H17a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.5 1.8A3.2 3.2 0 0 0 7.5 18Z"></path><path d="M12 10v5m0 0-2-2m2 2 2-2"></path>',
                chart: '<path d="M4 18h16"></path><path d="m6 15 4-4 3 2.5L18 7"></path>',
                list: '<rect x="6" y="4" width="12" height="16" rx="2"></rect><path d="M9 9h6M9 13h6M9 17h4"></path>',
                advice: '<path d="M6.2 17.8a7.2 7.2 0 1 1 3.2 2.1L5 20.8l1.2-3Z"></path><path d="M14.8 8.3c-3.7.1-6 2-6 4.5 0 1.4.9 2.4 2.4 2.4 2.5 0 3.8-3 3.6-6.9Z"></path><path d="M8.5 16.3c1.1-2.4 2.8-3.9 5-4.9"></path>',
                map: '<path d="M4 6.2 9.5 4l5 2 5.5-2.2v14l-5.5 2.2-5-2L4 20.2v-14Z"></path><path d="M9.5 4v14M14.5 6v14"></path>',
                bell: '<path d="M18 15.5H6l1.3-1.7V10a4.7 4.7 0 0 1 9.4 0v3.8L18 15.5Z"></path><path d="M10 18a2.2 2.2 0 0 0 4 0"></path>',
                greenhouse: '<path d="M4 20h16M6 20V10l6-6 6 6v10M12 4v16M7 11h10"></path>',
                rows: '<path d="M5 18c4-4 10-4 14 0M4 14c5-4 11-4 16 0M3 10c6-4 12-4 18 0"></path>',
                users: '<circle cx="9" cy="9" r="3"></circle><circle cx="16.5" cy="10" r="2.5"></circle><path d="M4 20c0-4 2.2-6.5 5-6.5s5 2.5 5 6.5M14 15c3.6-.4 6 1.6 6 5"></path>',
                whatsapp: '<path d="M20 11.8a8 8 0 0 1-11.7 7.1L4 20l1.2-4.1A8 8 0 1 1 20 11.8Z"></path><path d="M9.1 8.4c.2-.5.4-.6.8-.6h.5c.2 0 .4.1.5.4l.7 1.6c.1.3.1.5-.1.7l-.4.5c-.1.2-.2.3-.1.5.4.8 1.1 1.5 2 2 .2.1.4.1.5-.1l.6-.7c.2-.2.4-.2.7-.1l1.5.7c.3.1.4.3.4.6 0 .7-.3 1.2-.8 1.5-.5.4-1.6.5-3.3-.3-1.9-.9-3.6-2.5-4.4-4.4-.6-1.3-.3-2.1.1-2.6Z"></path>',
                mail: '<rect x="4" y="6" width="16" height="12" rx="1.8"></rect><path d="m5 7.5 7 5.4 7-5.4"></path>',
                calendar: '<rect x="5" y="5.5" width="14" height="14" rx="2"></rect><path d="M8 3.8v4M16 3.8v4M5 10h14M8.5 13.5h.01M12 13.5h.01M15.5 13.5h.01M8.5 17h.01M12 17h.01"></path>',
                lock: '<path d="M7 10V8a5 5 0 0 1 10 0v2"></path><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M12 14v2.5"></path>',
                cookie: '<path d="M19 12.8A7.2 7.2 0 1 1 11.2 5c.1 1.4 1.2 2.5 2.6 2.5.2 1.3 1.3 2.3 2.7 2.3.1 1.4 1.1 2.5 2.5 3Z"></path><path d="M8.5 11.2h.01M11.2 15.5h.01M14.5 13.7h.01"></path>'
            };
            return `<svg class="rayat-definitive-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">${icons[name] || icons.leaf}</svg>`;
        }

        function renderRayatDefinitiveHomePage() {
            const BRAND_LOGO_GREEN = '/assets/logo/logo-green.svg';
            const HERO_LOGO_IMAGE = '/assets/img/rayat-definitive-hero.svg';
            const DEMO_MAP_IMAGE = '/assets/images/image333.png';
            const PLATFORM_MAP_IMAGE = '/assets/images/image2222.png';
            const FOOTER_GOLD_LOGO_IMAGE = '/assets/images/footer/rayat-logo-gold-exact-transparent.png';
            const arrowIcon = '<svg class="rayat-definitive-arrow" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11"></path><path d="m11 5 5 5-5 5"></path></svg>';
            const heroTitle = t('luxDefHeroTitle');
            const heroAccent = t('luxDefHeroAccent');
            const heroTitleHtml = heroAccent && heroTitle.includes(heroAccent)
                ? heroTitle.replace(heroAccent, `<span>${heroAccent}</span>`)
                : heroTitle;
            const readings = getLuxuryDashboardSoilReadings();
            const readingByKey = Object.fromEntries(readings.map((reading) => [reading.key, reading]));
            const getReading = (key, fallback) => {
                const reading = readingByKey[key];
                if (!reading) return fallback;
                return `${reading.displayValue}${reading.unit && key !== 'pH' ? ` ${reading.unit}` : ''}`;
            };
            const heroStatusState = String(window.RAYAT_HERO_STATUS || window.rayatHeroStatus || 'online').toLowerCase() === 'offline' ? 'offline' : 'online';
            const heroStatusLabel = heroStatusState === 'offline' ? t('luxDefOffline') : t('luxDefOnline');
            const navItems = [
                { label: t('luxDefNavHome'), action: "setView('home')" },
                { label: t('luxDefNavSolutions'), action: "navigateToRayatHomeSection('rayat-solutions')" },
                { label: t('luxDefNavDemo'), action: "setViewWithTracking('demo')" },
                { label: t('luxDefNavHow'), action: "navigateToRayatHomeSection('rayat-how')" },
                { label: t('luxDefNavAbout'), action: "setView('chi-siamo')" }
            ];
            const languageOptions = [
                { lang: 'it', code: 'IT', label: t('luxLangIt') },
                { lang: 'fr', code: 'FR', label: t('luxLangFr') },
                { lang: 'en', code: 'EN', label: t('luxLangEn') },
                { lang: 'ar', code: 'AR', label: t('luxLangAr') },
                { lang: 'zgh', code: 'ZGH', label: t('luxLangTz') }
            ];
            const activeLanguage = languageOptions.find((option) => option.lang === currentLang || (currentLang === 'tz' && option.lang === 'zgh')) || languageOptions[1];
            const heroFeatures = [
                { icon: 'clock', label: t('luxDefRealtime') },
                { icon: 'brain', label: t('luxDefSmartDecisions') },
                { icon: 'screen', label: t('luxDefWebMobile') },
                { icon: 'shield', label: t('luxDefSecure') }
            ];
            const heroMetrics = [
                { icon: 'drop', label: t('luxMetricHumidityLabel'), value: getReading('moisture', t('luxMetricHumidityValue')), status: t('luxMetricHumidityStatus') },
                { icon: 'temp', label: t('luxMetricTemperatureLabel'), value: getReading('temperature', t('luxMetricTemperatureValue')), status: t('luxMetricTemperatureStatus') },
                { icon: 'bolt', label: 'EC', value: getReading('ec', t('luxPhoneEcValue')), status: t('luxDefGood') },
                { icon: 'leaf', label: t('luxDefCropStatusLabel'), value: t('luxDefOptimal'), status: t('luxDefGood') }
            ];
            const demoBullets = [
                { icon: 'sensor', label: t('luxDefContinuous') },
                { icon: 'sensor', label: t('luxDefLiveData') },
                { icon: 'chart', label: t('luxDefHistorical') },
                { icon: 'shield', label: t('luxDefSmartAlerts') }
            ];
            const howSteps = [
                { icon: 'leaf', title: t('luxDefStepSensorsTitle'), text: t('luxDefStepSensorsText') },
                { icon: 'router', title: t('luxDefStepRouterTitle'), text: t('luxDefStepRouterText') },
                { icon: 'cloud', title: t('luxDefStepCloudTitle'), text: t('luxDefStepCloudText') },
                { icon: 'chart', title: t('luxDefStepDashboardTitle'), text: t('luxDefStepDashboardText') },
                { icon: 'advice', title: t('luxDefStepAiTitle'), text: t('luxDefStepAiText') }
            ];
            const platformBullets = [
                { icon: 'chart', label: t('luxDefPlatformDashboard') },
                { icon: 'map', label: t('luxDefPlatformMap') },
                { icon: 'sensor', label: t('luxDefRealtime') },
                { icon: 'bell', label: t('luxDefSmartAlerts') },
                { icon: 'list', label: t('luxDefPlatformReports') }
            ];
            const solutionCards = [
                { image: '/assets/images/solutions/greenhouses.png', label: t('luxDefGreenhouses'), modifier: 'greenhouses' },
                { image: '/assets/images/solutions/bananas.png', label: t('luxDefBananas'), modifier: 'banana' },
                { image: '/assets/images/solutions/citrus.png', label: t('luxDefCitrus'), modifier: 'citrus' },
                { image: '/assets/images/solutions/vegetables.png', label: t('luxDefVegetables'), modifier: 'vegetables' },
                { image: '/assets/images/solutions/farms.png', label: t('luxDefFarms'), modifier: 'fields' }
            ];
            const statCards = [
                { icon: 'drop', value: '30%', label: t('luxDefWaterSaving'), text: t('luxDefWaterSavingText') },
                { icon: 'chart', value: '25%', label: t('luxDefProductivity'), text: t('luxDefProductivityText') },
                { icon: 'clock', value: '24/7', label: t('luxDefMonitoring'), text: t('luxDefMonitoringText') },
                { icon: 'users', value: '500+', label: t('luxDefCompanies'), text: t('luxDefCompaniesText') },
                { icon: 'shield', value: '98%', label: t('luxDefSatisfaction'), text: t('luxDefSatisfactionText') }
            ];
            const dashboardValues = [
                { label: t('luxMetricTemperatureLabel'), value: getReading('temperature', t('luxMetricTemperatureValue')), status: t('luxMetricTemperatureStatus') },
                { label: t('luxMetricHumidityLabel'), value: getReading('moisture', t('luxMetricHumidityValue')), status: t('luxMetricHumidityStatus') },
                { label: 'EC', value: getReading('ec', t('luxPhoneEcValue')), status: t('luxDefGood') },
                { label: 'pH', value: getReading('pH', t('luxPhonePhValue')), status: t('luxMetricTemperatureStatus') }
            ];
            const parameterRows = [
                { icon: 'drop', label: t('luxMetricHumidityLabel'), value: getReading('moisture', t('luxMetricHumidityValue')) },
                { icon: 'temp', label: t('luxMetricTemperatureLabel'), value: getReading('temperature', t('luxMetricTemperatureValue')) },
                { icon: 'bolt', label: 'EC', value: getReading('ec', t('luxPhoneEcValue')) },
                { icon: 'sensor', label: 'pH', value: getReading('pH', t('luxPhonePhValue')) },
                { icon: 'leaf', label: t('luxDemoNitrogenLabel'), value: getReading('nitrogen', '180 mg/kg') }
            ];
            const platformAlerts = [
                { icon: 'drop', tone: 'warning', title: t('luxDefPlatformAlertMoisture'), meta: `${t('luxDefDashMenuParcels')} 3 • ${t('luxDefToday')}, 10:15` },
                { icon: 'bell', tone: 'info', title: t('luxDefPlatformAlertIrrigation'), meta: `${t('luxDefDashMenuParcels')} 1 • ${t('luxDefToday')}, 08:30` },
                { icon: 'shield', tone: 'success', title: t('luxDefPlatformAlertNormal'), meta: `${t('luxDefDashMenuParcels')} 2 • ${t('luxDefToday')}, 07:45` }
            ];
            const footerColumns = [
                { title: t('luxDefNavHome'), text: t('luxDefFooterHomeDesc'), action: "setView('home')" },
                { title: t('luxDefNavSolutions'), text: t('luxDefFooterSolutionsDesc'), action: "navigateToRayatHomeSection('rayat-solutions')" },
                { title: t('luxDefNavDemo'), text: t('luxDefFooterDemoDesc'), action: "setViewWithTracking('demo')" },
                { title: t('luxDefNavHow'), text: t('luxDefFooterHowDesc'), action: "navigateToRayatHomeSection('rayat-how')" },
                { title: t('luxDefNavAbout'), text: t('luxDefFooterAboutDesc'), action: "setView('chi-siamo')" }
            ];

            return `
                <main class="rayat-definitive-home">
                    <header class="rayat-definitive-nav">
                        <button type="button" class="rayat-definitive-brand" onclick="setView('home')" aria-label="${t('luxBrandName')}">
                            <img src="${BRAND_LOGO_GREEN}" alt="${t('luxLogoAlt')}">
                            <span><strong>${t('luxBrandName')}</strong><small>${t('luxBrandSubtitle')}</small></span>
                        </button>
                        <nav class="rayat-definitive-navlinks" aria-label="${t('luxMobileMenuLabel')}">
                            ${navItems.map((item, index) => `
                                <button type="button" class="${index === 0 ? 'is-active' : ''}" onclick="${item.action}">${item.label}</button>
                            `).join('')}
                        </nav>
                        <div class="rayat-definitive-nav-actions">
                            <details class="rayat-definitive-language">
                                <summary aria-label="${t('luxLanguageLabel')}">
                                    <strong>${activeLanguage.code}</strong>
                                    <svg viewBox="0 0 12 8" fill="none" aria-hidden="true">
                                        <path d="M1 1.5 6 6.5l5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>
                                    </svg>
                                </summary>
                                <div class="rayat-definitive-language-menu">
                                    ${languageOptions.map((option) => `
                                        <button type="button" class="${option.lang === activeLanguage.lang ? 'is-active' : ''}" onclick="setLanguage('${option.lang}')">
                                            <span>${option.code}</span>
                                            <small>${option.label}</small>
                                        </button>
                                    `).join('')}
                                </div>
                            </details>
                            <button type="button" class="rayat-definitive-nav-cta glass-btn glass-btn--primary" onclick="setViewWithTracking('demo')">
                                <span>${t('luxDefHeroSecondary')}</span>${arrowIcon}
                            </button>
                            <details class="rayat-definitive-mobile-menu">
                                <summary aria-label="${t('luxMobileMenuLabel')}"><span></span><span></span></summary>
                                <div>
                                    ${navItems.map((item) => `<button type="button" onclick="${item.action}">${item.label}</button>`).join('')}
                                    <div class="rayat-definitive-mobile-language" aria-label="${t('luxLanguageLabel')}">
                                        ${languageOptions.map((option) => `
                                            <button type="button" class="${option.lang === activeLanguage.lang ? 'is-active' : ''}" onclick="setLanguage('${option.lang}')">${option.code}</button>
                                        `).join('')}
                                    </div>
                                    <button type="button" onclick="setViewWithTracking('demo')">${t('luxDefHeroSecondary')}</button>
                                </div>
                            </details>
                        </div>
                    </header>

                    <section class="rayat-definitive-hero">
                        <div class="rayat-definitive-hero-copy">
                            <p class="rayat-definitive-eyebrow rayat-section-eyebrow">${t('luxDefHeroEyebrow')}</p>
                            <h1 class="rayat-section-title">${heroTitleHtml}</h1>
                            <p>${t('luxDefHeroText')}</p>
                            <div class="rayat-definitive-actions">
                                <button type="button" class="rayat-definitive-primary glass-btn glass-btn--primary" onclick="setViewWithTracking('demo')">${t('luxDefHeroPrimary')}${arrowIcon}</button>
                                <button type="button" class="rayat-definitive-secondary glass-btn glass-btn--secondary" onclick="setViewWithTracking('demo')">${t('luxDefHeroSecondary')}</button>
                            </div>
                        </div>
                        <div class="rayat-definitive-hero-visual">
                            <span class="rayat-definitive-ring rayat-definitive-ring--one"></span>
                            <span class="rayat-definitive-ring rayat-definitive-ring--two"></span>
                            <img src="${HERO_LOGO_IMAGE}" alt="${t('luxTreeAlt')}" class="rayat-definitive-hero-logo">
                            <div class="rayat-definitive-hero-status status-indicator status-indicator--${heroStatusState}" data-status="${heroStatusState}">
                                <span class="status-dot" aria-hidden="true"></span>
                                <span class="status-indicator__label">${heroStatusLabel}</span>
                            </div>
                            <strong>${t('luxDefHeroFarm')}</strong>
                            <small>${t('luxDefUpdated')}</small>
                        </div>
                        <aside class="rayat-definitive-metric-panel">
                            ${heroMetrics.map((metric) => `
                                <article class="hero-metric-item">
                                    ${renderRayatDefinitiveIcon(metric.icon)}
                                    <span><small>${metric.label}</small><strong>${metric.value}</strong><em>${metric.status}</em></span>
                                </article>
                            `).join('')}
                        </aside>
                        <div class="rayat-definitive-feature-row">
                            ${heroFeatures.map((feature) => `
                                <span>${renderRayatDefinitiveIcon(feature.icon)}<small>${feature.label}</small></span>
                            `).join('')}
                        </div>
                    </section>

                    <section id="rayat-demo-live" class="rayat-definitive-map-card">
                        <div class="rayat-definitive-map-copy">
                            <p class="rayat-definitive-eyebrow rayat-section-eyebrow">${t('luxDefDemoEyebrow')}</p>
                            <h2 class="rayat-section-title rayat-section-title--medium">${t('luxDefDemoTitle')}</h2>
                            <p>${t('luxDefDemoText')}</p>
                            <ul>
                                ${demoBullets.map((item) => `<li>${renderRayatDefinitiveIcon(item.icon)}${item.label}</li>`).join('')}
                            </ul>
                            <button type="button" class="glass-btn glass-btn--secondary" onclick="setViewWithTracking('demo')">${t('luxDefViewDemo')}${arrowIcon}</button>
                        </div>
                        <div class="rayat-definitive-map-visual">
                            <img class="rayat-definitive-map-image" src="${DEMO_MAP_IMAGE}" alt="${t('luxDefMapCardTitle')}">
                            <span class="rayat-definitive-map-pin"><img src="${BRAND_LOGO_GREEN}" alt=""></span>
                            <article class="rayat-definitive-map-popup">
                                <strong>${t('luxDefMapCardTitle')}</strong>
                                <small>${t('luxDefMapArea')} <i class="status-dot online"></i> ${t('luxDefOnline')}</small>
                                <button type="button" class="glass-btn glass-btn--secondary" onclick="setViewWithTracking('demo')">${t('luxDefViewDetails')}${arrowIcon}</button>
                            </article>
                        </div>
                    </section>

                    <section id="rayat-how" class="rayat-definitive-how">
                        <p class="rayat-definitive-eyebrow rayat-section-eyebrow">${t('luxDefHowEyebrow')}</p>
                        <h2 class="rayat-section-title rayat-section-title--large">${t('luxDefHowTitle')}</h2>
                        <div class="rayat-definitive-steps">
                            ${howSteps.map((step, index) => `
                                <article>
                                    <span class="rayat-definitive-step-icon">${renderRayatDefinitiveIcon(step.icon)}</span>
                                    <small>${String(index + 1).padStart(2, '0')}</small>
                                    <strong>${step.title}</strong>
                                    <span>${step.text}</span>
                                </article>
                            `).join('')}
                        </div>
                    </section>

                    <section id="rayat-platform" class="rayat-definitive-platform">
                        <div class="rayat-definitive-platform-copy">
                            <p class="rayat-definitive-eyebrow rayat-section-eyebrow">${t('luxDefPlatformEyebrow')}</p>
                            <h2 class="rayat-section-title rayat-section-title--large">${t('luxDefPlatformTitleFull')}</h2>
                            <p>${t('luxDefPlatformText')}</p>
                            <ul>${platformBullets.map((item) => `<li class="rayat-platform-feature-card">${renderRayatDefinitiveIcon(item.icon)}<span>${item.label}</span></li>`).join('')}</ul>
                        </div>
                        <article class="rayat-definitive-dashboard-mini">
                            <aside class="rayat-platform-sidebar">
                                <div class="rayat-platform-sidebar-brand">
                                    <img src="${BRAND_LOGO_GREEN}" alt="${t('luxLogoAlt')}">
                                    <strong>${t('luxBrandName')}</strong>
                                </div>
                                <nav>
                                    ${[
                                        t('luxDefDashMenuDashboard'),
                                        t('luxDefDashMenuParcels'),
                                        t('luxDefDashMenuMap'),
                                        t('luxDefDashMenuSensors'),
                                        t('luxDefDashMenuAlerts'),
                                        t('luxDefDashMenuAnalytics'),
                                        t('luxDefDashMenuReports')
                                    ].map((item, index) => `<span class="${index === 0 ? 'is-active' : ''}">${renderRayatDefinitiveIcon(index === 2 ? 'map' : index === 4 ? 'bell' : index === 5 ? 'chart' : index === 6 ? 'list' : 'greenhouse')}${item}</span>`).join('')}
                                </nav>
                                <footer>
                                    <i>A</i>
                                    <span><strong>${t('luxDefPlatformFarmLabel')}</strong><small>${t('luxDefPlatformLocation')}</small></span>
                                </footer>
                            </aside>
                            <div class="rayat-platform-dashboard-main">
                                <header class="rayat-platform-dashboard-head">
                                    <span><strong>${t('luxDefOverview')}</strong><small>${t('luxDefUpdated')}</small></span>
                                    <em>${t('luxDefToday')}</em>
                                </header>
                                <div class="rayat-definitive-mini-kpis">
                                    ${dashboardValues.map((item, index) => `<span>${renderRayatDefinitiveIcon(['temp', 'drop', 'bolt', 'sensor'][index] || 'leaf')}<small>${item.label}</small><strong>${item.value}</strong><em>${item.status}</em></span>`).join('')}
                                </div>
                                <section class="rayat-platform-chart-card">
                                    <header><strong>${t('luxDefPlatformMainParams')}</strong><span>7G</span></header>
                                    <div class="rayat-definitive-mini-chart">
                                        <svg viewBox="0 0 620 220" preserveAspectRatio="none" aria-hidden="true">
                                            <defs>
                                                <linearGradient id="rayatPlatformChartArea" x1="0" y1="58" x2="0" y2="172" gradientUnits="userSpaceOnUse">
                                                    <stop offset="0" stop-color="#2d6a4f" stop-opacity="0.16"></stop>
                                                    <stop offset="1" stop-color="#2d6a4f" stop-opacity="0"></stop>
                                                </linearGradient>
                                            </defs>
                                            <g class="rayat-chart-grid">
                                                <path d="M58 34H594M58 72H594M58 110H594M58 148H594M58 186H594"></path>
                                                <path d="M58 34V186M166 34V186M274 34V186M382 34V186M490 34V186M594 34V186"></path>
                                            </g>
                                            <g class="rayat-chart-axis">
                                                <text x="24" y="38">90</text>
                                                <text x="24" y="76">75</text>
                                                <text x="24" y="114">60</text>
                                                <text x="24" y="152">45</text>
                                                <text x="24" y="190">30</text>
                                                <text x="58" y="211">24 mag 06:00</text>
                                                <text x="238" y="211">24 mag 12:00</text>
                                                <text x="418" y="211">24 mag 18:00</text>
                                                <text x="548" y="211">25 mag 00:00</text>
                                            </g>
                                            <path class="rayat-chart-area" d="M58 118 L88 102 L118 110 L148 88 L178 94 L208 82 L238 92 L268 76 L298 86 L328 72 L358 83 L388 68 L418 80 L448 70 L478 92 L508 76 L538 86 L568 62 L594 72 L594 186 L58 186 Z"></path>
                                            <path class="rayat-chart-line rayat-chart-line--humidity" d="M58 118 L88 102 L118 110 L148 88 L178 94 L208 82 L238 92 L268 76 L298 86 L328 72 L358 83 L388 68 L418 80 L448 70 L478 92 L508 76 L538 86 L568 62 L594 72"></path>
                                            <path class="rayat-chart-line rayat-chart-line--temperature" d="M58 138 L88 132 L118 124 L148 128 L178 116 L208 121 L238 108 L268 112 L298 102 L328 106 L358 96 L388 100 L418 88 L448 94 L478 84 L508 90 L538 82 L568 78 L594 86"></path>
                                            <path class="rayat-chart-line rayat-chart-line--ec" d="M58 158 L88 148 L118 154 L148 143 L178 150 L208 139 L238 146 L268 134 L298 142 L328 132 L358 144 L388 136 L418 146 L448 134 L478 140 L508 130 L538 138 L568 126 L594 134"></path>
                                            <g class="rayat-chart-points">
                                                <circle cx="594" cy="72" r="4"></circle>
                                                <circle cx="594" cy="86" r="4"></circle>
                                                <circle cx="594" cy="134" r="4"></circle>
                                            </g>
                                        </svg>
                                    </div>
                                </section>
                                <div class="rayat-platform-dashboard-bottom">
                                    <section class="rayat-platform-map-card">
                                        <header><strong>${t('luxDefPlatformMapTitle')}</strong></header>
                                        <div class="rayat-platform-map-thumb">
                                            <img src="${PLATFORM_MAP_IMAGE}" alt="${t('luxDefPlatformMapTitle')}">
                                        </div>
                                    </section>
                                    <section class="rayat-platform-alert-card">
                                        <header><strong>${t('luxDefPlatformRecentAlerts')}</strong></header>
                                        ${platformAlerts.map((alert) => `
                                            <div class="rayat-platform-alert-row rayat-platform-alert-row--${alert.tone}">
                                                ${renderRayatDefinitiveIcon(alert.icon)}
                                                <span><strong>${alert.title}</strong><small>${alert.meta}</small></span>
                                            </div>
                                        `).join('')}
                                        <button type="button" onclick="setViewWithTracking('demo')">${t('luxDefPlatformViewAlerts')}${arrowIcon}</button>
                                    </section>
                                </div>
                            </div>
                        </article>
                    </section>

                    <section id="rayat-solutions" class="rayat-definitive-lower-grid">
                        <div class="rayat-definitive-solutions">
                            <p class="rayat-definitive-eyebrow rayat-section-eyebrow">${t('luxDefSolutionsEyebrow')}</p>
                            <h2 class="rayat-section-title rayat-section-title--large">${t('luxDefSolutionsTitle')}</h2>
                            <p class="rayat-definitive-solutions-copy">${t('luxDefSolutionsText')}</p>
                            <div>
                                ${solutionCards.map((item) => `
                                    <button type="button" onclick="setView('servizi')" class="rayat-definitive-crop-card rayat-definitive-crop-card--${item.modifier}">
                                        <span><img src="${item.image}" alt="${item.label}"></span>
                                        <strong>${item.label}</strong>
                                        ${arrowIcon}
                                    </button>
                                `).join('')}
                            </div>
                        </div>
                        <div class="rayat-definitive-mobile-card">
                            <div>
                                <p class="rayat-definitive-eyebrow rayat-section-eyebrow">${t('luxDefMobileEyebrow')}</p>
                                <h2 class="rayat-section-title rayat-section-title--medium">${t('luxDefMobileTitle')}</h2>
                                <p>${t('luxDefMobileText')}</p>
                                <div class="rayat-definitive-store-row">
                                    <button type="button" class="rayat-definitive-store-badge" onclick="setViewWithTracking('demo')" aria-label="App Store">
                                        <img src="/assets/images/app-mobile/imagedf45.png" alt="App Store">
                                    </button>
                                    <button type="button" class="rayat-definitive-store-badge" onclick="setViewWithTracking('demo')" aria-label="Google Play">
                                        <img src="/assets/images/app-mobile/imagegoogle-play.png" alt="Google Play">
                                    </button>
                                </div>
                            </div>
                            <div class="rayat-definitive-mobile-visual">
                                <img src="/assets/images/app-mobile/mobile-transparent.png" alt="${t('luxDefMobileTitle')}">
                            </div>
                        </div>
                    </section>

                    <section class="rayat-definitive-stat-strip">
                        ${statCards.map((stat) => `
                            <article>${renderRayatDefinitiveIcon(stat.icon)}<strong>${stat.value}</strong><span>${stat.label}</span><p>${stat.text}</p></article>
                        `).join('')}
                    </section>

                    <footer id="rayat-footer" class="rayat-definitive-footer">
                        <div class="rayat-definitive-footer-main">
                            <div class="rayat-definitive-footer-brand">
                                <div class="rayat-definitive-footer-lockup">
                                    <img src="${BRAND_LOGO_GREEN}" alt="${t('luxLogoAlt')}">
                                    <span><strong>${t('luxBrandName')}</strong><small>${t('luxBrandSubtitle')}</small></span>
                                </div>
                                <p>${t('luxDefFooterText')}</p>
                            </div>
                            <nav class="rayat-definitive-footer-menu" aria-label="${t('luxMobileMenuLabel')}">
                                ${footerColumns.map((column) => `
                                    <button type="button" class="rayat-definitive-footer-col" onclick="${column.action}">
                                        <strong>${column.title}</strong>
                                        <i aria-hidden="true"></i>
                                        <span>${column.text}</span>
                                    </button>
                                `).join('')}
                            </nav>
                        </div>
                        <div class="rayat-definitive-footer-contact">
                            <a href="${getWhatsappHref()}" target="_blank" rel="noopener" onclick="trackEvent('WhatsApp Click')" class="rayat-definitive-footer-contact-item">
                                <span>${renderRayatDefinitiveIcon('whatsapp')}</span>
                                <b>${t('luxDefFooterWhatsapp')}</b>
                                <small>${t('luxDefFooterWhatsappNumber')}</small>
                            </a>
                            <a href="mailto:${t('luxDefFooterEmailAddress')}" class="rayat-definitive-footer-contact-item">
                                <span>${renderRayatDefinitiveIcon('mail')}</span>
                                <b>${t('luxDefFooterEmail')}</b>
                                <small>${t('luxDefFooterEmailAddress')}</small>
                            </a>
                            <button type="button" onclick="setViewWithTracking('demo')" class="rayat-definitive-footer-contact-item">
                                <span>${renderRayatDefinitiveIcon('calendar')}</span>
                                <b>${t('luxDefFooterDemoRequest')}</b>
                                <small>${t('luxDefFooterDemoRequestText')}</small>
                            </button>
                        </div>
                        <div class="rayat-definitive-footer-bottom">
                            <button type="button" onclick="setView('privacy')" class="rayat-definitive-footer-legal rayat-definitive-footer-legal--left">
                                ${renderRayatDefinitiveIcon('lock')}
                                <span>${t('luxDefPrivacy')}</span>
                            </button>
                            <div class="rayat-definitive-footer-signature">
                                <img src="${FOOTER_GOLD_LOGO_IMAGE}" alt="${t('luxLogoAlt')}">
                                <small>${t('luxDefFooterCopyright')}</small>
                            </div>
                            <button type="button" onclick="setView('privacy')" class="rayat-definitive-footer-legal rayat-definitive-footer-legal--right">
                                ${renderRayatDefinitiveIcon('cookie')}
                                <span>${t('luxDefCookie')}</span>
                            </button>
                        </div>
                    </footer>
                </main>
            `;
        }

        function renderHomePage() {
            return renderRayatDefinitiveHomePage();
            const BRAND_LOGO_GREEN = '/assets/logo/logo-green.svg';
            const arrowIcon = `
                <svg class="rayat-luxury-button-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M4 10h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
                    <path d="m11 5 5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
            `;
            const playIcon = `
                <svg class="rayat-luxury-button-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.3"></circle>
                    <path d="M8.4 6.9 13 10l-4.6 3.1V6.9Z" fill="currentColor"></path>
                </svg>
            `;
            const waterIcon = `
                <svg class="rayat-luxury-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 3.5s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" stroke="currentColor" stroke-width="1.5"></path>
                    <path d="M9 15.2c.6 1.4 1.7 2.1 3.2 2.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                </svg>
            `;
            const temperatureIcon = `
                <svg class="rayat-luxury-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M10 14.8V5.5a2 2 0 1 1 4 0v9.3a4 4 0 1 1-4 0Z" stroke="currentColor" stroke-width="1.5"></path>
                    <path d="M12 8v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                </svg>
            `;
            const leafIcon = `
                <svg class="rayat-luxury-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M19.5 4.5C11.8 4.8 6 8.7 6 14.2c0 3 2.1 5.3 5.2 5.3 5.5 0 8.3-6.4 8.3-15Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
                    <path d="M5 20c2.4-5.1 6.4-8.4 11-10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                </svg>
            `;
            const trendIcon = `
                <svg class="rayat-luxury-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 7.5s7 7.6 7 12c0-4.4 7-12 7-12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
                    <path d="M8 16.5c.8 1.6 2 2.5 4 2.5s3.2-.9 4-2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                </svg>
            `;
            const navLinks = [
                { labelKey: 'luxNavProduct', action: "setView('servizi')" },
                { labelKey: 'luxNavSolutions', action: "setView('servizi')" },
                { labelKey: 'luxNavTechnology', action: "setView('servizi')" },
                { labelKey: 'luxNavResources', action: "setView('contatti')" },
                { labelKey: 'luxNavPricing', action: "setView('contatti')" },
                { labelKey: 'luxNavAbout', action: "setView('chi-siamo')" }
            ];
            const languageOptions = [
                { lang: 'it', shortKey: 'luxLangShortIt', labelKey: 'luxLangIt' },
                { lang: 'en', shortKey: 'luxLangShortEn', labelKey: 'luxLangEn' },
                { lang: 'fr', shortKey: 'luxLangShortFr', labelKey: 'luxLangFr' },
                { lang: 'ar', shortKey: 'luxLangShortAr', labelKey: 'luxLangAr' },
                { lang: 'zgh', shortKey: 'luxLangShortTz', labelKey: 'luxLangTz' }
            ];
            const languageLabelKeys = {
                it: 'luxLangShortIt',
                en: 'luxLangShortEn',
                fr: 'luxLangShortFr',
                ar: 'luxLangShortAr',
                zgh: 'luxLangShortTz',
                tz: 'luxLangShortTz',
                ber: 'luxLangShortTz'
            };
            const metricCards = [
                {
                    key: 'humidity',
                    icon: waterIcon,
                    labelKey: 'luxMetricHumidityLabel',
                    valueKey: 'luxMetricHumidityValue',
                    statusKey: 'luxMetricHumidityStatus'
                },
                {
                    key: 'temperature',
                    icon: temperatureIcon,
                    labelKey: 'luxMetricTemperatureLabel',
                    valueKey: 'luxMetricTemperatureValue',
                    statusKey: 'luxMetricTemperatureStatus'
                },
                {
                    key: 'health',
                    icon: leafIcon,
                    labelKey: 'luxMetricCropHealthLabel',
                    valueKey: 'luxMetricCropHealthValue',
                    statusKey: 'luxMetricCropHealthStatus'
                },
                {
                    key: 'water',
                    icon: trendIcon,
                    labelKey: 'luxMetricWaterLabel',
                    valueKey: 'luxMetricWaterValue',
                    statusKey: 'luxMetricWaterStatus'
                }
            ];
            const dashboardIcon = `
                <svg class="rayat-luxury-mini-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 5h6v6H4V5Zm10 0h6v6h-6V5ZM4 15h6v4H4v-4Zm10 0h6v4h-6v-4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
                </svg>
            `;
            const parcelIcon = `
                <svg class="rayat-luxury-mini-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 5.5 12 3l7 2.5v13L12 21l-7-2.5v-13Z" stroke="currentColor" stroke-width="1.5"></path>
                    <path d="M12 3v18M5 5.5l7 2.6 7-2.6" stroke="currentColor" stroke-width="1.5"></path>
                </svg>
            `;
            const sensorIcon = `
                <svg class="rayat-luxury-mini-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 4v5m0 6v5M4 12h5m6 0h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                    <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"></circle>
                </svg>
            `;
            const irrigationIcon = `
                <svg class="rayat-luxury-mini-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 3.5s5.5 6 5.5 10.3a5.5 5.5 0 1 1-11 0C6.5 9.5 12 3.5 12 3.5Z" stroke="currentColor" stroke-width="1.5"></path>
                    <path d="M9.2 15.3c.6 1.2 1.6 1.8 3 1.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                </svg>
            `;
            const alertIcon = `
                <svg class="rayat-luxury-mini-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 4.5 20 19H4L12 4.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
                    <path d="M12 9.5v4.2M12 16.8h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
                </svg>
            `;
            const analyticsIcon = `
                <svg class="rayat-luxury-mini-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 18 9 12.5l4 3.2L20 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>
                    <path d="M4 20h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                </svg>
            `;
            const reportIcon = `
                <svg class="rayat-luxury-mini-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M7 4h7l3 3v13H7V4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
                    <path d="M14 4v4h4M9.5 12h5M9.5 15.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                </svg>
            `;
            const settingsIcon = `
                <svg class="rayat-luxury-mini-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"></circle>
                    <path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                </svg>
            `;
            const exportIcon = `
                <svg class="rayat-luxury-small-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M4 15.5h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
            `;
            const calendarIcon = `
                <svg class="rayat-luxury-small-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5.5 3.5v2M14.5 3.5v2M4 7h12M5 5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path>
                </svg>
            `;
            const rowArrowIcon = `
                <svg class="rayat-luxury-row-arrow" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="m7 4 6 6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
            `;
            const dashboardNavItems = [
                { tab: 'overview', labelKey: 'luxDashboardNavOverview', icon: dashboardIcon },
                { tab: 'parcels', labelKey: 'luxDashboardNavParcels', icon: parcelIcon },
                { tab: 'sensors', labelKey: 'luxDashboardNavSensors', icon: sensorIcon },
                { tab: 'irrigation', labelKey: 'luxDashboardNavIrrigation', icon: irrigationIcon },
                { tab: 'alerts', labelKey: 'luxDashboardNavAlerts', icon: alertIcon },
                { tab: 'analytics', labelKey: 'luxDashboardNavAnalytics', icon: analyticsIcon },
                { tab: 'reports', labelKey: 'luxDashboardNavReports', icon: reportIcon },
                { tab: 'settings', labelKey: 'luxDashboardNavSettings', icon: settingsIcon }
            ];
            const kpiCards = [
                { key: 'water', icon: waterIcon, labelKey: 'luxKpiWaterLabel', valueKey: 'luxKpiWaterValue', statusKey: 'luxKpiWaterStatus', spark: 'M2 31 C7 28 12 28 17 29 C22 30 25 27 30 28 C35 29 38 25 43 27 C48 29 51 20 56 18' },
                { key: 'health', icon: leafIcon, labelKey: 'luxKpiHealthLabel', valueKey: 'luxKpiHealthValue', statusKey: 'luxKpiHealthStatus', spark: 'M2 28 C8 25 13 24 18 26 C23 28 27 30 32 28 C38 25 43 27 48 24 C52 22 55 17 58 16' },
                { key: 'irrigation', icon: irrigationIcon, labelKey: 'luxKpiIrrigationLabel', valueKey: 'luxKpiIrrigationValue', statusKey: 'luxKpiIrrigationStatus', spark: 'M2 30 C8 26 14 25 20 27 C26 29 31 24 36 25 C43 26 47 22 52 17 C55 14 57 11 58 8' },
                { key: 'temperature', icon: temperatureIcon, labelKey: 'luxKpiTempLabel', valueKey: 'luxKpiTempValue', statusKey: 'luxKpiTempStatus', spark: 'M2 24 C7 21 13 20 19 23 C25 26 30 24 36 21 C42 18 47 26 52 22 C55 20 57 18 58 16' }
            ];
            const recommendations = [
                { icon: waterIcon, titleKey: 'luxAiRow1Title', textKey: 'luxAiRow1Text' },
                { icon: alertIcon, titleKey: 'luxAiRow2Title', textKey: 'luxAiRow2Text' },
                { icon: leafIcon, titleKey: 'luxAiRow3Title', textKey: 'luxAiRow3Text' }
            ];
            const editorialPhoto = 'https://images.unsplash.com/photo-1764399125007-ae859306abe7?auto=format&fit=crop&w=1350&q=82';
            const editorialBenefits = [
                { icon: sensorIcon, titleKey: 'luxEditorialLiveTitle', textKey: 'luxEditorialLiveText' },
                { icon: dashboardIcon, titleKey: 'luxEditorialAiTitle', textKey: 'luxEditorialAiText' },
                { icon: irrigationIcon, titleKey: 'luxEditorialWaterTitle', textKey: 'luxEditorialWaterText' },
                { icon: alertIcon, titleKey: 'luxEditorialAlertsTitle', textKey: 'luxEditorialAlertsText' }
            ];
            const editorialStats = [
                { icon: leafIcon, valueKey: 'luxEditorialKpiWaterValue', textKey: 'luxEditorialKpiWaterText' },
                { icon: analyticsIcon, valueKey: 'luxEditorialKpiYieldValue', textKey: 'luxEditorialKpiYieldText' },
                { icon: alertIcon, valueKey: 'luxEditorialKpiMonitoringValue', textKey: 'luxEditorialKpiMonitoringText' },
                { icon: dashboardIcon, valueKey: 'luxEditorialKpiFarmersValue', textKey: 'luxEditorialKpiFarmersText' }
            ];
            const editorialPreviewMetrics = [
                { labelKey: 'luxMetricHumidityLabel', valueKey: 'luxMetricHumidityValue', statusKey: 'luxMetricHumidityStatus' },
                { labelKey: 'luxMetricTemperatureLabel', valueKey: 'luxMetricTemperatureValue', statusKey: 'luxMetricTemperatureStatus' },
                { labelKey: 'luxPhoneEcLabel', valueKey: 'luxPhoneEcValue', statusKey: 'luxMetricCropHealthStatus' }
            ];
            const luxuryLiveSensors = getLuxuryDashboardSoilReadings();
            const luxuryLiveSensorIconKind = {
                moisture: 'water',
                temperature: 'temperature',
                ec: 'sensor',
                pH: 'leaf',
                nitrogen: 'leaf',
                phosphorus: 'leaf',
                potassium: 'leaf'
            };
            const luxuryLiveSensorLabelKey = {
                moisture: 'luxLiveHumidityLabel'
            };
            const luxuryLiveRecommendations = [
                {
                    icon: renderLuxuryDashboardIcon('water'),
                    titleKey: 'luxAiRow1Title',
                    priorityKey: 'luxLivePriorityMedium',
                    level: 'medium',
                    outcomeKey: 'luxLiveIrrigationOutcome',
                    factKeys: ['luxLiveIrrigationFactOne', 'luxLiveIrrigationFactTwo'],
                    ctaKey: 'luxLiveIrrigationCta'
                },
                {
                    icon: renderLuxuryDashboardIcon('alert'),
                    titleKey: 'luxAiRow2Title',
                    priorityKey: 'luxLivePriorityHigh',
                    level: 'high',
                    outcomeKey: 'luxLiveRiskOutcome',
                    factKeys: ['luxLiveRiskFactOne', 'luxLiveRiskFactTwo'],
                    ctaKey: 'luxLiveRiskCta'
                },
                {
                    icon: renderLuxuryDashboardIcon('leaf'),
                    titleKey: 'luxAiRow3Title',
                    priorityKey: 'luxLivePriorityMedium',
                    level: 'medium',
                    outcomeKey: 'luxLiveFertilizationOutcome',
                    factKeys: ['luxLiveFertilizationFactOne', 'luxLiveFertilizationFactTwo'],
                    ctaKey: 'luxLiveFertilizationCta'
                },
                {
                    icon: `
                        <svg class="rayat-luxury-home-dashboard-tab-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M12 3.4 19 6v5.4c0 4.3-2.8 7.7-7 9.3-4.2-1.6-7-5-7-9.3V6l7-2.6Z" stroke="currentColor" stroke-width="1.5"></path>
                            <path d="m9.1 12 2 2 4-4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
                        </svg>
                    `,
                    titleKey: 'luxLiveHealthTitle',
                    priorityKey: 'luxLivePriorityLow',
                    level: 'low',
                    outcomeKey: 'luxLiveHealthOutcome',
                    factKeys: ['luxLiveHealthFactOne', 'luxLiveHealthFactTwo'],
                    ctaKey: 'luxLiveHealthCta'
                }
            ];
            const luxuryLiveApplications = [
                {
                    labelKey: 'luxLiveAppGreenhouses',
                    icon: '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M5 42h38M8 42V22c0-9.4 7.1-17 16-17s16 7.6 16 17v20M8 22h32M24 5v37M16 42V29h16v13M13 14.5c6.8 2.1 15.2 2.1 22 0" /></svg>'
                },
                {
                    labelKey: 'luxLiveAppBananas',
                    icon: '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M34.6 10.4c1.2.2 2.5-.2 3.5-1.3" /><path d="M34.3 10.3c1 1.8 1.2 3.5.7 5" /><path d="M35 15.2c-1 10.4-8.4 18.8-18.6 20.6-3.7.7-6.8-.5-8.4-3.1-.6-1-.9-2-.9-3.2 4.1 1 8.5-.1 12.6-3.1 5.1-3.7 8.1-8.1 9.3-12.8 2.1-.1 4.2.4 6 1.6Z" /><path d="M8 29.5c5.5 3.2 12.3 1.2 18.1-4.4 3-2.9 5.2-6.3 6.2-10.2" /></svg>'
                },
                {
                    labelKey: 'luxLiveAppMelons',
                    icon: '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M25 11c0-4 2-6.6 5.7-7.5M25 10c3.8-4.1 8.1-3.9 10.5-1.5-3.4 3.3-7 3.8-10.5 1.5" /><path d="M24 11c10.3 0 17 6.4 17 15.5S34.3 43 24 43 7 35.6 7 26.5 13.7 11 24 11Z" /><path d="M20.5 11.5c-4.3 7.2-4.3 23.5 0 30.5M27.5 11.5c4.3 7.2 4.3 23.5 0 30.5M24 11.5V42" /></svg>'
                },
                {
                    labelKey: 'luxLiveAppTomatoes',
                    icon: '<svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M18 11c8.5 0 13 4.9 12 11.5C29 29 23.5 32 18 32S7 29 6 22.5C5 15.9 9.5 11 18 11Z" /><path d="m18 12-5.5-3 4.2.5L18 5l1.3 4.5 4.2-.5-5.5 3Z" /></svg>'
                },
                {
                    labelKey: 'luxLiveAppIrrigation',
                    icon: '<svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M18 5s8 9 8 15a8 8 0 1 1-16 0c0-6 8-15 8-15Z" /><path d="M7 29 4 32M29 29l3 3M18 31v4" /></svg>'
                },
                {
                    labelKey: 'luxLiveAppCooperatives',
                    icon: '<svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><circle cx="13" cy="12" r="5" /><circle cx="24" cy="13" r="4.5" /><path d="M4 31c0-6 3.5-10 9-10s9 4 9 10M21 23c5.7-.7 10 2.5 10 8" /></svg>'
                }
            ];
            const finalPhoneReadings = Object.fromEntries(luxuryLiveSensors.map((reading) => [reading.key, reading]));
            const finalResultStats = [
                {
                    icon: leafIcon,
                    valueKey: 'luxEditorialKpiWaterValue',
                    labelKey: 'luxEditorialKpiWaterText'
                },
                {
                    icon: analyticsIcon,
                    valueKey: 'luxEditorialKpiYieldValue',
                    labelKey: 'luxEditorialKpiYieldText'
                },
                {
                    icon: `
                        <svg class="rayat-luxury-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5"></circle>
                            <path d="M12 7v5l3.4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                        </svg>
                    `,
                    valueKey: 'luxEditorialKpiMonitoringValue',
                    labelKey: 'luxEditorialKpiMonitoringText'
                },
                {
                    icon: `
                        <svg class="rayat-luxury-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <circle cx="9" cy="9" r="3" stroke="currentColor" stroke-width="1.5"></circle>
                            <circle cx="16" cy="10" r="2.6" stroke="currentColor" stroke-width="1.5"></circle>
                            <path d="M3.8 19c.4-3.3 2.4-5.2 5.2-5.2s4.8 1.9 5.2 5.2M14 14.5c3-.6 5.5 1.1 6 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                        </svg>
                    `,
                    valueKey: 'luxEditorialKpiFarmersValue',
                    labelKey: 'luxEditorialKpiFarmersText'
                },
                {
                    icon: `
                        <svg class="rayat-luxury-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M12 3.4 19 6v5.4c0 4.3-2.8 7.7-7 9.3-4.2-1.6-7-5-7-9.3V6l7-2.6Z" stroke="currentColor" stroke-width="1.5"></path>
                            <path d="m9 12 2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                        </svg>
                    `,
                    valueKey: 'luxFinalSatisfactionValue',
                    labelKey: 'luxFinalSatisfactionText'
                }
            ];
            const finalFooterColumns = [
                {
                    titleKey: 'luxFinalFooterProduct',
                    links: [
                        { labelKey: 'luxFinalFooterDashboard', action: "setViewWithTracking('demo')" },
                        { labelKey: 'luxFinalFooterSensors', action: "setViewWithTracking('demo')" },
                        { labelKey: 'luxFinalFooterIrrigation', action: "setView('servizi')" },
                        { labelKey: 'luxFinalFooterAnalytics', action: "setViewWithTracking('demo')" },
                        { labelKey: 'luxFinalFooterAdvisor', action: "setView('servizi')" }
                    ]
                },
                {
                    titleKey: 'luxFinalFooterSolutions',
                    links: [
                        { labelKey: 'luxFinalFooterOpenFields', action: "setView('servizi')" },
                        { labelKey: 'luxFinalFooterGreenhouses', action: "setView('servizi')" },
                        { labelKey: 'luxFinalFooterOrchards', action: "setView('servizi')" },
                        { labelKey: 'luxFinalFooterSmartIrrigation', action: "setView('servizi')" },
                        { labelKey: 'luxFinalFooterCooperatives', action: "setView('servizi')" }
                    ]
                },
                {
                    titleKey: 'luxFinalFooterResources',
                    links: [
                        { labelKey: 'luxFinalFooterDocumentation', action: "setView('contatti')" },
                        { labelKey: 'luxFinalFooterBlog', action: "setView('contatti')" },
                        { labelKey: 'luxFinalFooterGuides', action: "setView('servizi')" },
                        { labelKey: 'luxFinalFooterSupport', action: "setView('contatti')" },
                        { labelKey: 'luxFinalFooterApi', action: "setView('contatti')" }
                    ]
                },
                {
                    titleKey: 'luxFinalFooterCompany',
                    links: [
                        { labelKey: 'luxFinalFooterAbout', action: "setView('chi-siamo')" },
                        { labelKey: 'luxFinalFooterCareer', action: "setView('contatti')" },
                        { labelKey: 'luxFinalFooterWork', action: "setView('contatti')" },
                        { labelKey: 'luxFinalFooterDemo', action: "setViewWithTracking('demo')" }
                    ]
                }
            ];

            setTimeout(() => {
                if (typeof window === 'undefined' || typeof document === 'undefined') {
                    return;
                }

                const revealItems = Array.from(document.querySelectorAll('.rayat-luxury-scroll-reveal'));
                if (!revealItems.length) {
                    return;
                }

                if (window.__rayatLuxuryRevealObserver) {
                    window.__rayatLuxuryRevealObserver.disconnect();
                }

                revealItems.forEach((item, index) => {
                    item.style.setProperty('--rayat-luxury-stagger', `${Math.min(index, 12) * 70}ms`);
                });

                if (!('IntersectionObserver' in window)) {
                    revealItems.forEach((item) => item.classList.add('rayat-luxury-scroll-reveal--visible'));
                    return;
                }

                window.__rayatLuxuryRevealObserver = new IntersectionObserver((entries, observer) => {
                    entries.forEach((entry) => {
                        if (!entry.isIntersecting) {
                            return;
                        }

                        entry.target.classList.add('rayat-luxury-scroll-reveal--visible');
                        observer.unobserve(entry.target);
                    });
                }, { rootMargin: '0px 0px -8% 0px', threshold: 0.16 });

                revealItems.forEach((item) => window.__rayatLuxuryRevealObserver.observe(item));
            }, 0);

            return `
                <main class="rayat-luxury-home">
                    <header class="rayat-luxury-navbar">
                        <div class="rayat-luxury-navbar-inner">
                            <button type="button" onclick="setView('home')" class="rayat-luxury-brand" aria-label="${t('luxBrandName')}">
                                <img src="${BRAND_LOGO_GREEN}" alt="${t('luxLogoAlt')}" class="rayat-luxury-brand-logo">
                                <span class="rayat-luxury-brand-copy">
                                    <span class="rayat-luxury-brand-name">${t('luxBrandName')}</span>
                                    <span class="rayat-luxury-brand-subtitle">${t('luxBrandSubtitle')}</span>
                                </span>
                            </button>

                            <nav class="rayat-luxury-nav" aria-label="${t('luxMobileMenuLabel')}">
                                ${navLinks.map((link) => `
                                    <button type="button" onclick="${link.action}" class="rayat-luxury-nav-link">
                                        ${t(link.labelKey)}
                                    </button>
                                `).join('')}
                            </nav>

                            <div class="rayat-luxury-navbar-actions">
                                <details class="rayat-luxury-language">
                                    <summary class="rayat-luxury-language-trigger" aria-label="${t('luxLanguageLabel')}">
                                        <span>${t(languageLabelKeys[currentLang] || 'luxLangShortFr')}</span>
                                        <svg class="rayat-luxury-language-chevron" viewBox="0 0 12 8" fill="none" aria-hidden="true">
                                            <path d="M1 1.5 6 6.5l5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>
                                        </svg>
                                    </summary>
                                    <div class="rayat-luxury-language-menu">
                                        ${languageOptions.map((option) => `
                                            <button type="button" onclick="setLanguage('${option.lang}')" class="rayat-luxury-language-option ${currentLang === option.lang ? 'rayat-luxury-language-option--active' : ''}">
                                                <span class="rayat-luxury-language-code">${t(option.shortKey)}</span>
                                                <span class="rayat-luxury-language-name">${t(option.labelKey)}</span>
                                            </button>
                                        `).join('')}
                                    </div>
                                </details>

                                <button type="button" onclick="setViewWithTracking('demo')" class="rayat-luxury-demo-button">
                                    <span>${t('luxCtaDemo')}</span>
                                    ${arrowIcon}
                                </button>

                                <details class="rayat-luxury-mobile-menu">
                                    <summary class="rayat-luxury-mobile-trigger" aria-label="${t('luxMobileMenuLabel')}">
                                        <span class="rayat-luxury-mobile-line"></span>
                                        <span class="rayat-luxury-mobile-line"></span>
                                    </summary>
                                    <div class="rayat-luxury-mobile-panel">
                                        ${navLinks.map((link) => `
                                            <button type="button" onclick="${link.action}" class="rayat-luxury-mobile-link">
                                                ${t(link.labelKey)}
                                            </button>
                                        `).join('')}
                                        <button type="button" onclick="setViewWithTracking('demo')" class="rayat-luxury-mobile-demo-button">
                                            <span>${t('luxCtaDemo')}</span>
                                            ${arrowIcon}
                                        </button>
                                    </div>
                                </details>
                            </div>
                        </div>
                    </header>

                    <section class="rayat-luxury-hero">
                        <div class="rayat-luxury-hero-inner">
                            <div class="rayat-luxury-hero-copy rayat-luxury-reveal">
                                <p class="rayat-luxury-eyebrow">${t('luxHeroEyebrow')}</p>
                                <h1 class="rayat-luxury-title">
                                    <span>${t('luxHeroTitleLine1')}</span>
                                    <span>${t('luxHeroTitleLine2')}</span>
                                    <span class="rayat-luxury-title-accent">${t('luxHeroTitleAccent')}</span>
                                </h1>
                                <p class="rayat-luxury-subtitle">${t('luxHeroBody')}</p>
                                <div class="rayat-luxury-hero-actions">
                                    <button type="button" onclick="setViewWithTracking('demo')" class="rayat-luxury-primary-button">
                                        <span>${t('luxHeroPrimaryCta')}</span>
                                        ${arrowIcon}
                                    </button>
                                    <button type="button" onclick="setView('servizi')" class="rayat-luxury-secondary-button">
                                        <span>${t('luxHeroSecondaryCta')}</span>
                                        ${playIcon}
                                    </button>
                                </div>
                            </div>

                            <div class="rayat-luxury-hero-visual rayat-luxury-reveal">
                                <div class="rayat-luxury-visual-ring rayat-luxury-visual-ring--outer"></div>
                                <div class="rayat-luxury-visual-ring rayat-luxury-visual-ring--inner"></div>
                                <span class="rayat-luxury-orbit-dot rayat-luxury-orbit-dot--one"></span>
                                <span class="rayat-luxury-orbit-dot rayat-luxury-orbit-dot--two"></span>
                                <span class="rayat-luxury-orbit-dot rayat-luxury-orbit-dot--three"></span>
                                <span class="rayat-luxury-orbit-dot rayat-luxury-orbit-dot--four"></span>
                                <img src="${BRAND_LOGO_GREEN}" alt="${t('luxTreeAlt')}" class="rayat-luxury-tree">
                                <div class="rayat-luxury-floating-cards">
                                    ${metricCards.map((card) => `
                                        <article class="rayat-luxury-floating-card rayat-luxury-floating-card--${card.key}">
                                            <div class="rayat-luxury-card-icon-shell">
                                                ${card.icon}
                                            </div>
                                            <div class="rayat-luxury-card-copy">
                                                <p class="rayat-luxury-card-label">${t(card.labelKey)}</p>
                                                <strong class="rayat-luxury-card-value">${t(card.valueKey)}</strong>
                                                <span class="rayat-luxury-card-status">${t(card.statusKey)}</span>
                                            </div>
                                        </article>
                                    `).join('')}
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="rayat-luxury-home-dashboard-section">
                        <div class="rayat-luxury-home-dashboard-shell rayat-luxury-scroll-reveal">
                            <aside class="rayat-luxury-home-dashboard-sidebar">
                                <div class="rayat-luxury-home-dashboard-sidebar-brand">
                                    <img src="${BRAND_LOGO_GREEN}" alt="${t('luxLogoAlt')}" class="rayat-luxury-home-dashboard-sidebar-logo">
                                    <div class="rayat-luxury-home-dashboard-sidebar-brand-copy">
                                        <strong>${t('luxDashboardSidebarTitle')}</strong>
                                        <span>${t('luxDashboardSidebarSubtitle')}</span>
                                    </div>
                                </div>
                                <nav class="rayat-luxury-home-dashboard-nav">
                                    ${dashboardNavItems.map((item) => `
                                        <button
                                            type="button"
                                            data-luxury-tab="${item.tab}"
                                            onclick="setLuxuryDashboardTab('${item.tab}')"
                                            class="rayat-luxury-home-dashboard-nav-item ${currentLuxuryDashboardTab === item.tab ? 'is-active rayat-luxury-home-dashboard-nav-item--active' : ''}"
                                        >
                                            ${item.icon}
                                            <span>${t(item.labelKey)}</span>
                                        </button>
                                    `).join('')}
                                </nav>
                                <div class="rayat-luxury-home-dashboard-profile">
                                    <span class="rayat-luxury-home-dashboard-profile-avatar">${t('luxDashboardProfileInitials')}</span>
                                    <span class="rayat-luxury-home-dashboard-profile-copy">
                                        <strong>${t('luxDashboardProfileName')}</strong>
                                        <span>${t('luxDashboardProfileRole')}</span>
                                    </span>
                                </div>
                            </aside>

                            <div class="rayat-luxury-home-dashboard-main">
                                <div id="rayat-luxury-home-dashboard-content" class="rayat-luxury-home-dashboard-content">
                                    ${renderLuxuryDashboardTabContent(currentLuxuryDashboardTab)}
                                </div>
                            </div>

                            <aside class="rayat-luxury-home-dashboard-side">
                                <div class="rayat-luxury-mobile-card rayat-luxury-scroll-reveal">
                                    <div class="rayat-luxury-mobile-card-copy">
                                        <h3>${t('luxMobileCardTitle')}</h3>
                                        <p>${t('luxMobileCardText')}</p>
                                        <div class="rayat-luxury-store-badges">
                                            <span>${t('luxMobileAppStore')}</span>
                                            <span>${t('luxMobileGooglePlay')}</span>
                                        </div>
                                    </div>
                                    <div class="rayat-luxury-phone">
                                        <div class="rayat-luxury-phone-speaker"></div>
                                        <div class="rayat-luxury-phone-header">
                                            <span>${t('luxPhoneParcel')}</span>
                                        </div>
                                        <div class="rayat-luxury-phone-gauge">
                                            <span>${t('luxPhoneHumidityLabel')}</span>
                                            <strong>${t('luxMetricHumidityValue')}</strong>
                                            <em>${t('luxMetricHumidityStatus')}</em>
                                        </div>
                                        <div class="rayat-luxury-phone-grid">
                                            <span><small>${t('luxPhoneTempLabel')}</small><strong>${t('luxPhoneTempValue')}</strong></span>
                                            <span><small>${t('luxPhoneEcLabel')}</small><strong>${t('luxPhoneEcValue')}</strong></span>
                                            <span><small>${t('luxPhonePhLabel')}</small><strong>${t('luxPhonePhValue')}</strong></span>
                                            <span><small>${t('luxPhoneAirHumidityLabel')}</small><strong>${t('luxPhoneAirHumidityValue')}</strong></span>
                                        </div>
                                        <div class="rayat-luxury-phone-tabs">
                                            <span>${t('luxPhoneHome')}</span>
                                            <span>${t('luxPhonePlots')}</span>
                                            <span>${t('luxPhoneAlerts')}</span>
                                            <span>${t('luxPhoneProfile')}</span>
                                        </div>
                                    </div>
                                </div>
                            </aside>
                        </div>

                        <section class="rayat-luxury-editorial-section rayat-luxury-scroll-reveal" aria-label="${t('luxEditorialEyebrow')}">
                            <div class="rayat-luxury-editorial-layout">
                                <div class="rayat-luxury-editorial-copy">
                                    <p class="rayat-luxury-editorial-eyebrow">
                                        ${t('luxEditorialEyebrow')}
                                        <span aria-hidden="true"></span>
                                    </p>
                                    <h2 class="rayat-luxury-editorial-title">${t('luxEditorialTitle')}</h2>
                                    <p class="rayat-luxury-editorial-text">${t('luxEditorialText')}</p>

                                    <div class="rayat-luxury-editorial-benefits">
                                        ${editorialBenefits.map((benefit) => `
                                            <article class="rayat-luxury-editorial-benefit">
                                                <span class="rayat-luxury-editorial-benefit-icon">${benefit.icon}</span>
                                                <span class="rayat-luxury-editorial-benefit-copy">
                                                    <strong>${t(benefit.titleKey)}</strong>
                                                    <span>${t(benefit.textKey)}</span>
                                                </span>
                                            </article>
                                        `).join('')}
                                    </div>

                                    <div class="rayat-luxury-editorial-actions">
                                        <button type="button" onclick="setView('servizi')" class="rayat-luxury-editorial-primary">
                                            <span>${t('luxEditorialPrimaryCta')}</span>
                                            ${arrowIcon}
                                        </button>
                                        <button type="button" onclick="setViewWithTracking('demo')" class="rayat-luxury-editorial-secondary">
                                            <span>${t('luxEditorialSecondaryCta')}</span>
                                            ${playIcon}
                                        </button>
                                    </div>
                                </div>

                                <div class="rayat-luxury-editorial-visual">
                                    <img class="rayat-luxury-editorial-photo" src="${editorialPhoto}" alt="${t('luxEditorialPhotoAlt')}" loading="lazy">

                                    <div class="rayat-luxury-editorial-preview">
                                        <aside class="rayat-luxury-editorial-preview-nav">
                                            <span class="rayat-luxury-editorial-preview-brand">
                                                <img src="${BRAND_LOGO_GREEN}" alt="">
                                                <span><strong>${t('luxBrandName')}</strong><small>${t('luxBrandSubtitle')}</small></span>
                                            </span>
                                            ${dashboardNavItems.slice(0, 6).map((item, index) => `
                                                <span class="rayat-luxury-editorial-preview-link ${index === 5 ? 'is-active' : ''}">
                                                    ${item.icon}
                                                    ${t(item.labelKey)}
                                                </span>
                                            `).join('')}
                                        </aside>
                                        <div class="rayat-luxury-editorial-preview-main">
                                            <header class="rayat-luxury-editorial-preview-header">
                                                <span>
                                                    <strong>${t('luxDashboardNavAnalytics')}</strong>
                                                    <small>${t('luxDashboardAnalyticsSubtitle')}</small>
                                                </span>
                                                <span class="rayat-luxury-editorial-preview-period">
                                                    <small>${t('luxDashboardPeriod24h')}</small>
                                                    <strong>${t('luxDashboardPeriod7d')}</strong>
                                                    <small>${t('luxDashboardPeriod30d')}</small>
                                                </span>
                                            </header>
                                            <div class="rayat-luxury-editorial-preview-metrics">
                                                ${editorialPreviewMetrics.map((metric) => `
                                                    <span>
                                                        <small>${t(metric.labelKey)}</small>
                                                        <strong>${t(metric.valueKey)}</strong>
                                                        <em>${t(metric.statusKey)}</em>
                                                    </span>
                                                `).join('')}
                                            </div>
                                            <article class="rayat-luxury-editorial-preview-chart">
                                                <header>
                                                    <span>${t('luxPhonePhLabel')}</span>
                                                    <strong>${t('luxPhonePhValue')}</strong>
                                                </header>
                                                <svg viewBox="0 0 420 100" preserveAspectRatio="none" aria-hidden="true">
                                                    <path class="rayat-luxury-editorial-grid" d="M0 24H420M0 55H420M0 86H420"></path>
                                                    <path class="rayat-luxury-editorial-graph" d="M0 67 L12 73 L23 58 L34 69 L46 41 L58 62 L70 48 L84 67 L97 53 L110 61 L122 44 L136 70 L148 58 L159 63 L171 48 L184 59 L195 54 L208 66 L220 42 L233 57 L245 51 L257 65 L270 46 L283 53 L295 49 L307 68 L319 52 L331 39 L343 58 L356 51 L368 62 L380 45 L392 55 L405 47 L420 52"></path>
                                                </svg>
                                            </article>
                                        </div>
                                    </div>

                                    <div class="rayat-luxury-editorial-phone">
                                        <span class="rayat-luxury-editorial-phone-speaker"></span>
                                        <strong>${t('luxPhoneParcel')}</strong>
                                        <small>${t('luxPhoneHumidityLabel')}</small>
                                        <span class="rayat-luxury-editorial-phone-gauge"><b>${t('luxMetricHumidityValue')}</b></span>
                                        <em>${t('luxMetricHumidityStatus')}</em>
                                        <div class="rayat-luxury-editorial-phone-readings">
                                            <span><small>${t('luxPhoneTempLabel')}</small><strong>${t('luxPhoneTempValue')}</strong></span>
                                            <span><small>${t('luxPhoneEcLabel')}</small><strong>${t('luxPhoneEcValue')}</strong></span>
                                            <span><small>${t('luxPhonePhLabel')}</small><strong>${t('luxPhonePhValue')}</strong></span>
                                            <span><small>${t('luxPhoneAirHumidityLabel')}</small><strong>${t('luxPhoneAirHumidityValue')}</strong></span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="rayat-luxury-editorial-stats">
                                ${editorialStats.map((stat) => `
                                    <article class="rayat-luxury-editorial-stat">
                                        <span class="rayat-luxury-editorial-stat-icon">${stat.icon}</span>
                                        <span>
                                            <strong>${t(stat.valueKey)}</strong>
                                            <small>${t(stat.textKey)}</small>
                                        </span>
                                    </article>
                                `).join('')}
                            </div>
                        </section>

                        <section class="rayat-luxury-live-suite" aria-label="${t('luxLiveSensorEyebrow')}">
                            <div class="rayat-luxury-live-sensors-panel">
                                <header class="rayat-luxury-live-header rayat-luxury-live-reveal">
                                    <div>
                                        <p class="rayat-luxury-live-eyebrow">
                                            <span aria-hidden="true"></span>
                                            ${t('luxLiveSensorEyebrow')}
                                            ${sensorIcon}
                                        </p>
                                        <h2 class="rayat-luxury-live-title">${t('luxLiveSensorTitle')}</h2>
                                        <p class="rayat-luxury-live-subtitle">${t('luxLiveSensorText')}</p>
                                    </div>
                                    <button type="button" onclick="setLuxuryDashboardTab('sensors'); document.getElementById('rayat-luxury-home-dashboard-content')?.scrollIntoView({ behavior: 'smooth', block: 'center' });" class="rayat-luxury-live-header-button">
                                        <span>${t('luxLiveAllSensors')}</span>
                                        ${arrowIcon}
                                    </button>
                                </header>

                                <div class="rayat-luxury-live-sensor-strip">
                                    ${luxuryLiveSensors.map((reading, index) => `
                                        <article
                                            class="rayat-luxury-live-sensor-card rayat-luxury-live-hover rayat-luxury-live-reveal"
                                            style="--rayat-luxury-live-order:${index + 1};"
                                            aria-label="${t(luxuryLiveSensorLabelKey[reading.key] || reading.labelKey)}"
                                        >
                                            <header class="rayat-luxury-live-sensor-head">
                                                <span class="rayat-luxury-live-sensor-icon rayat-luxury-live-sensor-icon--${reading.key}">
                                                    ${renderLuxuryDashboardIcon(luxuryLiveSensorIconKind[reading.key])}
                                                </span>
                                                <span>${t(luxuryLiveSensorLabelKey[reading.key] || reading.labelKey)}</span>
                                            </header>
                                            <strong class="rayat-luxury-live-sensor-value">
                                                ${reading.displayValue}${reading.key === 'pH' ? '' : `<small>${reading.unit}</small>`}
                                            </strong>
                                            <span class="rayat-luxury-live-sensor-status rayat-luxury-live-sensor-status--${reading.state.level}">${reading.state.label}</span>
                                            ${renderLuxuryHomeSensorEvidence(reading)}
                                        </article>
                                    `).join('')}
                                </div>
                            </div>

                            <div class="rayat-luxury-live-ai-panel">
                                <header class="rayat-luxury-live-header rayat-luxury-live-reveal">
                                    <div>
                                        <p class="rayat-luxury-live-eyebrow">${t('luxLiveAiEyebrow')}</p>
                                        <h2 class="rayat-luxury-live-title">${t('luxLiveAiTitle')}</h2>
                                        <p class="rayat-luxury-live-subtitle">${t('luxLiveAiText')}</p>
                                    </div>
                                    <button type="button" onclick="setLuxuryDashboardTab('analytics'); document.getElementById('rayat-luxury-home-dashboard-content')?.scrollIntoView({ behavior: 'smooth', block: 'center' });" class="rayat-luxury-live-header-button">
                                        <span>${t('luxLiveAiHowWorks')}</span>
                                        ${arrowIcon}
                                    </button>
                                </header>

                                <div class="rayat-luxury-live-ai-grid">
                                    ${luxuryLiveRecommendations.map((recommendation, index) => `
                                        <article class="rayat-luxury-live-ai-card rayat-luxury-live-hover rayat-luxury-live-reveal" style="--rayat-luxury-live-order:${index + 9};">
                                            <header class="rayat-luxury-live-ai-card-head">
                                                <span class="rayat-luxury-live-ai-icon rayat-luxury-live-ai-icon--${recommendation.level}">${recommendation.icon}</span>
                                                <span>
                                                    <strong>${t(recommendation.titleKey)}</strong>
                                                    <small class="rayat-luxury-live-priority rayat-luxury-live-priority--${recommendation.level}">${t(recommendation.priorityKey)}</small>
                                                </span>
                                            </header>
                                            <h3>${t(recommendation.outcomeKey)}</h3>
                                            <div class="rayat-luxury-live-ai-facts">
                                                ${recommendation.factKeys.map((factKey) => `
                                                    <span>${t(factKey)}</span>
                                                `).join('')}
                                            </div>
                                            <button type="button" onclick="setLuxuryDashboardTab('analytics'); document.getElementById('rayat-luxury-home-dashboard-content')?.scrollIntoView({ behavior: 'smooth', block: 'center' });" class="rayat-luxury-live-ai-action">
                                                <span>${t(recommendation.ctaKey)}</span>
                                                ${arrowIcon}
                                            </button>
                                        </article>
                                    `).join('')}
                                </div>

                                <footer class="rayat-luxury-live-applications rayat-luxury-live-reveal" style="--rayat-luxury-live-order:13;">
                                    <div class="rayat-luxury-live-app-intro">
                                        <strong>${t('luxLiveApplicationsTitle')}</strong>
                                        <span>${t('luxLiveApplicationsText')}</span>
                                    </div>
                                    <div class="rayat-luxury-live-app-row">
                                        ${luxuryLiveApplications.map((application) => `
                                            <span class="rayat-luxury-live-app">
                                                ${application.icon}
                                                <small>${t(application.labelKey)}</small>
                                            </span>
                                        `).join('')}
                                    </div>
                                    <button type="button" onclick="setView('servizi')" class="rayat-luxury-live-header-button rayat-luxury-live-app-button">
                                        <span>${t('luxLiveAllApplications')}</span>
                                        ${arrowIcon}
                                    </button>
                                </footer>
                            </div>
                        </section>

                        <section class="rayat-luxury-final-mobile rayat-luxury-scroll-reveal" aria-label="${t('luxFinalMobileEyebrow')}">
                            <div class="rayat-luxury-final-mobile-copy">
                                <p class="rayat-luxury-final-eyebrow">
                                    <strong>${t('luxFinalMobileStep')}</strong>
                                    <span>${t('luxFinalMobileEyebrow')}</span>
                                </p>
                                <h2>${t('luxFinalMobileTitle')}</h2>
                                <p class="rayat-luxury-final-mobile-text">${t('luxFinalMobileText')}</p>
                                <div class="rayat-luxury-final-store-row">
                                    <button type="button" onclick="setViewWithTracking('demo')" class="rayat-luxury-final-store">
                                        <svg viewBox="0 0 22 26" fill="currentColor" aria-hidden="true"><path d="M16.7 13.7c0-3.2 2.6-4.7 2.7-4.8-1.5-2.2-3.8-2.5-4.6-2.5-2-.2-3.8 1.1-4.8 1.1s-2.5-1.1-4.2-1.1C3.7 6.5 1.7 7.7.6 9.7c-2.3 4-.6 10 1.7 13.2 1.1 1.6 2.4 3.4 4.2 3.3 1.7-.1 2.3-1.1 4.3-1.1s2.6 1.1 4.4 1.1c1.8 0 3-1.6 4.1-3.2 1.3-1.9 1.8-3.7 1.8-3.8-.1 0-4.4-1.7-4.4-5.5ZM13.5 4.3c.9-1.1 1.5-2.7 1.3-4.3-1.3.1-2.9.9-3.8 2-.8 1-1.6 2.6-1.4 4.1 1.4.1 2.9-.7 3.9-1.8Z"></path></svg>
                                        <span><small>${t('luxFinalDownloadOn')}</small><b>${t('luxFinalAppStore')}</b></span>
                                    </button>
                                    <button type="button" onclick="setViewWithTracking('demo')" class="rayat-luxury-final-store">
                                        <svg viewBox="0 0 24 26" aria-hidden="true"><path fill="#35b878" d="M1 1.5 13.8 13 1 24.5V1.5Z"></path><path fill="#f5c441" d="m13.8 13 4-3.6 4.6 2.6c.8.4.8 1.6 0 2l-4.6 2.6-4-3.6Z"></path><path fill="#3c86e7" d="M1 1.5 17.8 9.4 13.8 13 1 1.5Z"></path><path fill="#e9514e" d="m1 24.5 12.8-11.5 4 3.6L1 24.5Z"></path></svg>
                                        <span><small>${t('luxFinalAvailableOn')}</small><b>${t('luxFinalGooglePlay')}</b></span>
                                    </button>
                                </div>
                            </div>

                            <div class="rayat-luxury-final-phones">
                                <article class="rayat-luxury-final-phone rayat-luxury-final-phone--map">
                                    <span class="rayat-luxury-final-phone-notch"></span>
                                    <header><span aria-hidden="true">&#8249;</span><strong>${t('luxFinalMapTitle')}</strong></header>
                                    <div class="rayat-luxury-final-phone-map"><span></span></div>
                                    <div class="rayat-luxury-final-field">
                                        <strong>${t('luxFinalFieldName')}</strong>
                                        <small>${t('luxFinalCropName')}</small>
                                        <em>${t('luxMetricHumidityStatus')}</em>
                                    </div>
                                    <nav class="rayat-luxury-final-phone-nav">${dashboardIcon}${parcelIcon}${alertIcon}${settingsIcon}</nav>
                                </article>

                                <article class="rayat-luxury-final-phone">
                                    <span class="rayat-luxury-final-phone-notch"></span>
                                    <header><span aria-hidden="true">&#8249;</span><strong>${t('luxFinalSensorsTitle')}</strong></header>
                                    <div class="rayat-luxury-final-sensor-list">
                                        ${['moisture', 'temperature', 'ec', 'pH', 'nitrogen'].map((key) => {
                                            const reading = finalPhoneReadings[key];
                                            return `
                                                <span>
                                                    ${renderLuxuryDashboardIcon(luxuryLiveSensorIconKind[key])}
                                                    <small>${t(luxuryLiveSensorLabelKey[key] || reading.labelKey)}</small>
                                                    <strong>${reading.displayValue}${reading.unit ? ` ${reading.unit}` : ''}</strong>
                                                </span>
                                            `;
                                        }).join('')}
                                    </div>
                                    <nav class="rayat-luxury-final-phone-nav">${dashboardIcon}${parcelIcon}${alertIcon}${settingsIcon}</nav>
                                </article>

                                <article class="rayat-luxury-final-phone rayat-luxury-final-phone--trend">
                                    <span class="rayat-luxury-final-phone-notch"></span>
                                    <header><span aria-hidden="true">&#8249;</span><strong>${t('luxFinalTrendTitle')}</strong></header>
                                    <div class="rayat-luxury-final-select">${t('luxMetricHumidityLabel')}<span aria-hidden="true">&#8964;</span></div>
                                    <div class="rayat-luxury-final-periods">
                                        <strong>${t('luxFinalToday')}</strong>
                                        <span>${t('luxDashboardPeriod7d')}</span>
                                        <span>${t('luxDashboardPeriod30d')}</span>
                                    </div>
                                    <svg class="rayat-luxury-final-phone-chart" viewBox="0 0 132 145" preserveAspectRatio="none" aria-hidden="true">
                                        <path class="rayat-luxury-final-phone-chart-grid" d="M12 20H128M12 54H128M12 88H128M12 122H128"></path>
                                        <path class="rayat-luxury-final-phone-chart-area" d="M12 86 26 63 37 77 50 68 65 47 78 61 91 74 107 53 120 44 128 51V122H12Z"></path>
                                        <path class="rayat-luxury-final-phone-chart-line" d="M12 86 26 63 37 77 50 68 65 47 78 61 91 74 107 53 120 44 128 51"></path>
                                    </svg>
                                </article>

                                <article class="rayat-luxury-final-phone rayat-luxury-final-phone--activity">
                                    <span class="rayat-luxury-final-phone-notch"></span>
                                    <header><span aria-hidden="true">&#8249;</span><strong>${t('luxFinalActivityTitle')}</strong></header>
                                    <div class="rayat-luxury-final-activity-list">
                                        <span>${irrigationIcon}<strong>${t('luxFinalIrrigationItem')}</strong><small>${t('luxFinalIrrigationTime')}<br>${t('luxFinalCompleted')}</small></span>
                                        <span>${leafIcon}<strong>${t('luxFinalFertilizationItem')}</strong><small>${t('luxFinalFertilizationTime')}<br>${t('luxFinalCompleted')}</small></span>
                                        <span>${alertIcon}<strong>${t('luxFinalAlarmItem')}</strong><small>${t('luxFinalAlarmTime')}</small></span>
                                        <span>${sensorIcon}<strong>${t('luxFinalSensorsItem')}</strong><small>${t('luxFinalOperating')}</small></span>
                                    </div>
                                    <button type="button" onclick="setViewWithTracking('demo')" class="rayat-luxury-final-phone-action">${t('luxFinalNewActivity')}</button>
                                </article>

                                <article class="rayat-luxury-final-phone rayat-luxury-final-phone--report">
                                    <span class="rayat-luxury-final-phone-notch"></span>
                                    <header><span aria-hidden="true">&#8249;</span><strong>${t('luxFinalReportTitle')}</strong></header>
                                    <strong class="rayat-luxury-final-report-label">${t('luxFinalReportHealth')}</strong>
                                    <span class="rayat-luxury-final-report-ring"><b>${t('luxFinalSatisfactionValue')}</b><small>${t('luxFinalReportExcellent')}</small></span>
                                    <small class="rayat-luxury-final-report-trend">${t('luxFinalTrendPositive')}</small>
                                    <strong class="rayat-luxury-final-report-value">${t('luxFinalTrendValue')}</strong>
                                    <small>${t('luxFinalComparedYesterday')}</small>
                                </article>
                            </div>
                        </section>

                        <section class="rayat-luxury-final-results rayat-luxury-scroll-reveal" aria-label="${t('luxFinalResultsEyebrow')}">
                            <header>
                                <p class="rayat-luxury-final-eyebrow">
                                    <strong>${t('luxFinalResultsStep')}</strong>
                                    <span>${t('luxFinalResultsEyebrow')}</span>
                                </p>
                                <h2>${t('luxFinalResultsTitle')}</h2>
                            </header>
                            <div class="rayat-luxury-final-results-grid">
                                ${finalResultStats.map((stat) => `
                                    <article>
                                        <span>${stat.icon}</span>
                                        <strong>${t(stat.valueKey)}</strong>
                                        <small>${t(stat.labelKey)}</small>
                                    </article>
                                `).join('')}
                            </div>
                        </section>

                        <footer class="rayat-luxury-final-footer rayat-luxury-scroll-reveal">
                            <div class="rayat-luxury-final-footer-brand">
                                <span class="rayat-luxury-final-footer-lockup">
                                    <img src="${BRAND_LOGO_WHITE}" alt="${t('luxLogoAlt')}">
                                    <span><strong>${t('luxBrandName')}</strong><small>${t('luxFinalFooterSubtitle')}</small></span>
                                </span>
                                <p>${t('luxFinalFooterText')}</p>
                                <nav class="rayat-luxury-final-socials">
                                    <button type="button" onclick="setView('contatti')" aria-label="${t('luxFinalSocialLinkedin')}">
                                        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5.3 7.3H2.7V17h2.6V7.3ZM4 3a1.7 1.7 0 1 0 0 3.4A1.7 1.7 0 0 0 4 3Zm13.1 8.5c0-2.9-1.5-4.5-3.8-4.5-1.7 0-2.5.9-2.9 1.6V7.3H7.8V17h2.6v-5.4c0-1.5.3-2.5 1.9-2.5 1.5 0 1.6 1.4 1.6 2.6V17h2.7l.5-5.5Z"></path></svg>
                                    </button>
                                    <button type="button" onclick="setView('contatti')" aria-label="${t('luxFinalSocialInstagram')}">
                                        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="4" stroke="currentColor" stroke-width="1.5"></rect><circle cx="10" cy="10" r="3.2" stroke="currentColor" stroke-width="1.5"></circle><circle cx="14" cy="6" r="1" fill="currentColor"></circle></svg>
                                    </button>
                                    <button type="button" onclick="setView('contatti')" aria-label="${t('luxFinalSocialYoutube')}">
                                        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M17 10c0 3-.4 4.3-1.1 4.8-.8.5-2.8.7-5.9.7s-5.1-.2-5.9-.7C3.4 14.3 3 13 3 10s.4-4.3 1.1-4.8c.8-.5 2.8-.7 5.9-.7s5.1.2 5.9.7c.7.5 1.1 1.8 1.1 4.8Z" stroke="currentColor" stroke-width="1.35"></path><path d="m8.3 7.5 4.3 2.5-4.3 2.5v-5Z" fill="currentColor"></path></svg>
                                    </button>
                                </nav>
                            </div>
                            ${finalFooterColumns.map((column) => `
                                <nav class="rayat-luxury-final-footer-links">
                                    <strong>${t(column.titleKey)}</strong>
                                    ${column.links.map((link) => `
                                        <button type="button" onclick="${link.action}">${t(link.labelKey)}</button>
                                    `).join('')}
                                </nav>
                            `).join('')}
                            <div class="rayat-luxury-final-newsletter">
                                <strong>${t('luxFinalFooterNewsletter')}</strong>
                                <p>${t('luxFinalNewsletterText')}</p>
                                <button type="button" onclick="setView('contatti')" class="rayat-luxury-final-email" aria-label="${t('luxFinalNewsletterSubmit')}">
                                    <span>${t('luxFinalEmailPlaceholder')}</span>
                                    ${arrowIcon}
                                </button>
                            </div>
                            <div class="rayat-luxury-final-footer-bottom">
                                <small>${t('footerRights')}</small>
                                <nav>
                                    <button type="button" onclick="setView('privacy')">${t('privacyPolicy')}</button>
                                    <button type="button" onclick="setView('terms')">${t('termsOfService')}</button>
                                    <button type="button" onclick="setView('privacy')">${t('luxFinalCookiePolicy')}</button>
                                </nav>
                            </div>
                        </footer>
                    </section>
                </main>
            `;
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function renderLoginPage() {
            return `
                ${renderHeader(false)}
            <div class="rayat-auth-screen min-h-screen flex items-center justify-center py-12 px-4 bg-gray-50">
                <div class="rayat-auth-card max-w-md w-full bg-white rounded-xl shadow-2xl p-8">
                    <h2 class="text-3xl font-bold text-green-800 mb-6 text-center">${t('loginTitle')}</h2>

                    <div id="error" class="hidden bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4 text-center">
                        ${t('loginError')}
                    </div>

                    <form onsubmit="login(event)" class="space-y-6">
                        <div>
                            <label class="block text-sm font-medium mb-2">${t('emailLabel')}</label>
                            <input type="email" id="email" required autocomplete="email" inputmode="email" class="w-full px-4 py-3 border rounded-2xl" placeholder="nome@azienda.com">
                        </div>
                        ${renderPasswordField({
                            inputId: 'password',
                            labelKey: 'passwordLabel',
                            placeholder: '••••••••',
                            autocomplete: 'current-password'
                        })}
                        <div class="rayat-remember-row">
                            <label for="remember-me" class="rayat-remember-label">
                                <input type="checkbox" id="remember-me" class="rayat-remember-checkbox" ${shouldRememberLogin() ? 'checked' : ''}>
                                <span>${t('rememberMe')}</span>
                            </label>
                        </div>
                        <button type="submit" class="w-full bg-green-700 hover:bg-green-800 text-white py-3 rounded-lg font-semibold transition">
                            ${t('loginBtn')}
                        </button>
                    </form>

                    <div class="mt-4 text-center">
                        <button type="button" onclick="requestPasswordReset()" class="text-sm text-green-700 font-bold hover:underline">
                            ${t('forgotPassword')}
                        </button>
                    </div>

                    <div class="mt-8 text-center pt-6 border-t">
                        <p class="text-gray-600 mb-2">${t('loginNoAccount')}</p>
                        <button onclick="registrationStep = 1; setView('register')" class="text-green-700 font-bold hover:underline">
                            ${t('loginRegisterNow')}
                        </button>
                    </div>
                </div>
            </div>
            ${renderFooter()}
            `;
        }

        function renderResetPasswordPage() {
            const token = new URLSearchParams(window.location.search).get('token');

            return `
                ${renderHeader(false)}
                <div class="min-h-screen flex items-center justify-center py-12 px-4 bg-gray-50">
                    <div class="max-w-md w-full bg-white rounded-3xl shadow-2xl p-8 border border-gray-100">
                        <h2 class="text-3xl font-black text-green-800 mb-3 text-center">${t('resetPasswordTitle')}</h2>
                        <p class="text-center text-gray-500 mb-6 leading-relaxed">${t('resetPasswordDesc')}</p>

                        <div id="reset-password-error" class="${token ? 'hidden' : ''} bg-red-100 border border-red-300 text-red-700 px-4 py-3 rounded-2xl mb-4 text-center">
                            ${token ? '' : t('resetPasswordInvalidToken')}
                        </div>
                        <div id="reset-password-success" class="hidden bg-green-100 border border-green-300 text-green-800 px-4 py-3 rounded-2xl mb-4 text-center"></div>

                        <form id="reset-password-form" onsubmit="submitPasswordReset(event)" class="space-y-5">
                            ${renderPasswordField({
                                inputId: 'reset-password',
                                labelKey: 'newPasswordLabel',
                                minLength: '8',
                                autocomplete: 'new-password'
                            })}
                            ${renderPasswordField({
                                inputId: 'reset-password-confirm',
                                labelKey: 'confirmPasswordLabel',
                                minLength: '8',
                                autocomplete: 'new-password'
                            })}
                            <button type="submit" class="w-full bg-green-700 hover:bg-green-800 text-white py-3 rounded-2xl font-semibold transition">
                                ${t('resetPasswordSubmit')}
                            </button>
                        </form>

                        <div class="mt-6 text-center">
                            <button onclick="setViewWithTracking('login')" class="text-sm text-green-700 font-bold hover:underline">
                                ${t('backToLogin')}
                            </button>
                        </div>
                    </div>
                </div>
                ${renderFooter()}
            `;
        }

        function initLuxuryHomeSectionAnimations() {
            const section = document.querySelector('.rayat-luxury-live-suite');
            if (!section) {
                return;
            }

            const cards = Array.from(section.querySelectorAll('.rayat-luxury-live-hover'));
            const revealItems = Array.from(section.querySelectorAll('.rayat-luxury-live-reveal'));
            const finePointer = !window.matchMedia
                || window.matchMedia('(hover: hover) and (pointer: fine)').matches;
            const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

            if (window.gsap && finePointer && !reduceMotion) {
                cards.forEach((card) => {
                    if (card.dataset.luxuryHomeHoverBound === '1') {
                        return;
                    }

                    card.dataset.luxuryHomeHoverBound = '1';
                    card.addEventListener('mouseenter', () => {
                        window.gsap.to(card, {
                            scale: 1.03,
                            y: -6,
                            duration: 0.35,
                            ease: 'power2.out',
                            overwrite: true,
                            borderColor: 'rgba(45, 106, 79, 0.27)',
                            boxShadow: '0 18px 44px rgba(26, 46, 26, 0.09)'
                        });
                    });
                    card.addEventListener('mouseleave', () => {
                        window.gsap.to(card, {
                            scale: 1,
                            y: 0,
                            duration: 0.35,
                            ease: 'power2.out',
                            overwrite: true,
                            borderColor: 'rgba(229, 231, 235, 0.92)',
                            boxShadow: '0 5px 18px rgba(26, 46, 26, 0.035)'
                        });
                    });
                });
            }

            const reveal = () => {
                if (window.__rayatLuxuryLiveSuiteRevealed) {
                    revealItems.forEach((item) => item.classList.add('rayat-luxury-live-reveal--visible'));
                    return;
                }

                window.__rayatLuxuryLiveSuiteRevealed = true;
                if (window.gsap && !reduceMotion) {
                    window.gsap.to(revealItems, {
                        autoAlpha: 1,
                        y: 0,
                        duration: 0.58,
                        stagger: 0.055,
                        ease: 'power2.out',
                        overwrite: true
                    });
                    return;
                }

                revealItems.forEach((item) => item.classList.add('rayat-luxury-live-reveal--visible'));
            };

            if (window.__rayatLuxuryLiveSuiteRevealed || reduceMotion || !('IntersectionObserver' in window)) {
                reveal();
                return;
            }

            window.__rayatLuxuryLiveSuiteObserver?.disconnect();
            window.__rayatLuxuryLiveSuiteObserver = new IntersectionObserver((entries, observer) => {
                if (!entries.some((entry) => entry.isIntersecting)) {
                    return;
                }

                reveal();
                observer.disconnect();
            }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });
            window.__rayatLuxuryLiveSuiteObserver.observe(section);
        }

        // RAYAT FIX - login/profile/final UX cleanup
        function renderLoginPage() {
            return `
                ${renderHeader(false)}
            <div class="rayat-auth-screen min-h-screen flex items-center justify-center py-12 px-4 bg-gray-50">
                <div class="rayat-auth-card max-w-md w-full bg-white rounded-xl shadow-2xl p-8">
                    <h2 class="text-3xl font-bold text-green-800 mb-6 text-center">${t('loginTitle')}</h2>

                    <div id="error" class="hidden bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4 text-center">
                        ${t('loginError')}
                    </div>

                    <form onsubmit="login(event)" class="space-y-6">
                        <div>
                            <label class="block text-sm font-medium mb-2">${t('emailLabel')}</label>
                            <input type="email" id="email" required autocomplete="email" inputmode="email" class="w-full px-4 py-3 border rounded-2xl" placeholder="nome@azienda.com">
                        </div>
                        ${renderPasswordField({
                            inputId: 'password',
                            labelKey: 'passwordLabel',
                            placeholder: '••••••••',
                            autocomplete: 'current-password'
                        })}
                        <div class="rayat-remember-row">
                            <label for="remember-me" class="rayat-remember-label">
                                <input type="checkbox" id="remember-me" class="rayat-remember-checkbox" ${shouldRememberLogin() ? 'checked' : ''}>
                                <span>${t('rememberMe')}</span>
                            </label>
                        </div>
                        <button type="submit" class="w-full bg-green-700 hover:bg-green-800 text-white py-3 rounded-lg font-semibold transition">
                            ${t('loginBtn')}
                        </button>
                    </form>

                    ${shouldShowNativeAdminLoginEntry() ? `
                        <button type="button" onclick="openAdminLoginFromNavigation()" class="mt-3 w-full bg-orange-500 hover:bg-orange-600 text-white py-3 rounded-lg font-semibold transition">
                            ${t('adminArea')}
                        </button>
                    ` : ''}

                    <div class="mt-4 text-center">
                        <button type="button" onclick="requestPasswordReset()" class="text-sm text-green-700 font-bold hover:underline">
                            ${t('forgotPassword')}
                        </button>
                    </div>

                    <div class="mt-8 text-center pt-6 border-t">
                        <p class="text-gray-600 mb-2">${t('loginNoAccount')}</p>
                        <button onclick="registrationStep = 1; setView('register')" class="text-green-700 font-bold hover:underline">
                            ${t('loginRegisterNow')}
                        </button>
                    </div>
                </div>
            </div>
            ${renderFooter()}
            `;
        }

        function renderResetPasswordPage() {
            const token = new URLSearchParams(window.location.search).get('token');

            return `
                ${renderHeader(false)}
                <div class="min-h-screen flex items-center justify-center py-12 px-4 bg-gray-50">
                    <div class="max-w-md w-full bg-white rounded-3xl shadow-2xl p-8 border border-gray-100">
                        <h2 class="text-3xl font-black text-green-800 mb-3 text-center">${t('resetPasswordTitle')}</h2>
                        <p class="text-center text-gray-500 mb-6 leading-relaxed">${t('resetPasswordDesc')}</p>

                        <div id="reset-password-error" class="${token ? 'hidden' : ''} bg-red-100 border border-red-300 text-red-700 px-4 py-3 rounded-2xl mb-4 text-center">
                            ${token ? '' : t('resetPasswordInvalidToken')}
                        </div>
                        <div id="reset-password-success" class="hidden bg-green-100 border border-green-300 text-green-800 px-4 py-3 rounded-2xl mb-4 text-center"></div>

                        <form id="reset-password-form" onsubmit="submitPasswordReset(event)" class="space-y-5">
                            ${renderPasswordField({
                                inputId: 'reset-password',
                                labelKey: 'newPasswordLabel',
                                minLength: '8',
                                autocomplete: 'new-password'
                            })}
                            ${renderPasswordField({
                                inputId: 'reset-password-confirm',
                                labelKey: 'confirmPasswordLabel',
                                minLength: '8',
                                autocomplete: 'new-password'
                            })}
                            <button type="submit" class="w-full bg-green-700 hover:bg-green-800 text-white py-3 rounded-2xl font-semibold transition">
                                ${t('resetPasswordSubmit')}
                            </button>
                        </form>

                        <div class="mt-6 text-center">
                            <button onclick="setViewWithTracking('login')" class="text-sm text-green-700 font-bold hover:underline">
                                ${t('backToLogin')}
                            </button>
                        </div>
                    </div>
                </div>
                ${renderFooter()}
            `;
        }

        function renderRegisterPage() {
            const selectedCrop = normalizeRegistrationCropValue(registrationData.crop_type);
            if (selectedCrop && registrationData.crop_type !== selectedCrop) {
                registrationData.crop_type = selectedCrop;
            }
            const customCropValue = selectedCrop ? '' : String(registrationData.crop_type || '').trim();
            const coordinatesLabel = registrationData.latitude && registrationData.longitude
                ? `${Number(registrationData.latitude).toFixed(5)}, ${Number(registrationData.longitude).toFixed(5)}`
                : '—';

            setTimeout(initRegistrationMap, 100);

            return `
                ${renderHeader(false)}
                <div class="rayat-register-screen min-h-screen py-8 px-4 bg-gray-50">
                    <div class="rayat-register-card max-w-3xl mx-auto bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100">
                        <div class="rayat-register-hero bg-gradient-to-r from-green-900 via-green-800 to-green-700 text-white px-6 py-8">
                            <div class="text-xs font-black tracking-[0.28em] uppercase text-green-200 mb-3">${t('regPersonalData')}</div>
                            <h2 class="text-3xl font-black tracking-tight mb-3">${t('regVerifyTitle')}</h2>
                            <p class="text-sm text-green-50 max-w-2xl leading-relaxed">${t('regPrivacyNote')}</p>
                        </div>

                        <div class="rayat-register-body p-6 md:p-8 space-y-8">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-sm font-semibold mb-2">${t('regFirstName')} *</label>
                                    <input type="text" id="reg-name" value="${escapeHtml(registrationData.name)}" autocomplete="given-name" autocapitalize="words" class="w-full px-4 py-3 border rounded-xl" placeholder="Ahmed">
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold mb-2">${t('regLastName')} *</label>
                                    <input type="text" id="reg-last-name" value="${escapeHtml(registrationData.last_name)}" autocomplete="family-name" autocapitalize="words" class="w-full px-4 py-3 border rounded-xl" placeholder="El Mansouri">
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold mb-2">${t('regPhone')} *</label>
                                    <input type="tel" id="reg-phone" value="${escapeHtml(registrationData.phone)}" autocomplete="tel" inputmode="tel" class="w-full px-4 py-3 border rounded-xl" placeholder="+212 6XX XXX XXX">
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold mb-2">${t('regEmailOpt')} *</label>
                                    <input type="email" id="reg-email" value="${escapeHtml(registrationData.email)}" autocomplete="email" inputmode="email" class="w-full px-4 py-3 border rounded-xl" placeholder="email@esempio.com">
                                </div>
                                <div>
                                    ${renderPasswordField({
                                        inputId: 'reg-password',
                                        labelKey: 'regPass',
                                        placeholder: t('regPassHint'),
                                        value: registrationData.password,
                                        autocomplete: 'new-password'
                                    })}
                                </div>
                                <div class="md:col-span-2">
                                    <label class="block text-sm font-semibold mb-2">${t('regLocationRegion')} *</label>
                                    <input
                                        type="text"
                                        id="reg-location"
                                        value="${escapeHtml(registrationData.location_name)}"
                                        oninput="registrationData.location_name = this.value"
                                        autocomplete="address-level2"
                                        class="w-full px-4 py-3 border rounded-xl"
                                        placeholder="${t('regLocationRegionHint')}"
                                    >
                                </div>
                            </div>

                            <div class="rayat-register-section rounded-2xl border border-green-100 bg-green-50/70 p-5">
                                <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
                                    <div>
                                        <h3 class="text-lg font-black text-green-900">${t('regCropOptional')}</h3>
                                        <p class="text-sm text-green-800/80">${t('regAgriType')}</p>
                                    </div>
                                    <span class="text-[11px] font-bold uppercase tracking-widest text-green-700">Optional</span>
                                </div>
                                <div class="rayat-register-crop-grid grid grid-cols-2 md:grid-cols-3 gap-3">
                                    ${renderCropOptions(selectedCrop)}
                                </div>
                                <div class="mt-4">
                                    <label class="block text-sm font-semibold mb-2">${t('regOtherCrop')}</label>
                                    <input
                                        type="text"
                                        id="custom-crop"
                                        value="${escapeHtml(customCropValue)}"
                                        oninput="registrationData.crop_type = this.value"
                                        class="w-full px-4 py-3 border rounded-xl"
                                        placeholder="${escapeHtml(t('cropCustomPlaceholder'))}"
                                    >
                                </div>
                            </div>

                            <div class="rayat-register-section rounded-2xl border border-blue-100 bg-blue-50/60 p-5">
                                <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
                                    <div>
                                        <h3 class="text-lg font-black text-blue-900">${t('regGpsOptional')}</h3>
                                        <p class="text-sm text-blue-900/70">${t('regLocHint')}</p>
                                    </div>
                                    <span class="badge badge-silver">${coordinatesLabel}</span>
                                </div>
                                <div class="flex flex-col gap-4">
                                    <button onclick="detectLocation()" class="w-full md:w-auto bg-blue-600 text-white py-3 px-5 rounded-xl font-bold flex items-center justify-center gap-2">
                                        ${t('regDetectLoc')}
                                    </button>
                                    <div id="map-registration" class="h-72 w-full rounded-2xl border-2 border-blue-100 shadow-inner bg-white"></div>
                                </div>
                            </div>

                            <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                                <p class="text-sm text-gray-500">${t('regRequiredFields')}</p>
                                <button onclick="completeRegistration()" class="w-full md:w-auto bg-green-700 text-white py-4 px-8 rounded-2xl font-bold text-lg shadow-xl">
                                    ${t('regSaveBtn')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                ${renderFooter()}
            `;
        }

        // RAYAT FIX - registration/admin
        function syncRegistrationFormState() {
            const nameInput = document.getElementById('reg-name');
            const lastNameInput = document.getElementById('reg-last-name');
            const phoneInput = document.getElementById('reg-phone');
            const emailInput = document.getElementById('reg-email');
            const passwordInput = document.getElementById('reg-password');
            const locationInput = document.getElementById('reg-location');
            const customCropInput = document.getElementById('custom-crop');

            if (nameInput) registrationData.name = nameInput.value.trim();
            if (lastNameInput) registrationData.last_name = lastNameInput.value.trim();
            if (phoneInput) registrationData.phone = phoneInput.value.trim();
            if (emailInput) registrationData.email = emailInput.value.trim();
            if (passwordInput) registrationData.password = passwordInput.value;
            if (locationInput) registrationData.location_name = locationInput.value.trim();

            if (customCropInput) {
                const customCrop = customCropInput.value.trim();
                if (customCrop) {
                    registrationData.crop_type = customCrop;
                } else if (!normalizeRegistrationCropValue(registrationData.crop_type)) {
                    registrationData.crop_type = '';
                }
            }
        }

        function selectCrop(crop) {
            // RAYAT FIX - registration/admin
            syncRegistrationFormState();
            registrationData.crop_type = crop;
            render();
        }

        let regMap, regMarker;
        async function updateRegistrationLocationFromCoords(lat, lng) {
            registrationData.latitude = lat;
            registrationData.longitude = lng;

            try {
                const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`);
                if (!res.ok) return;
                const data = await res.json();
                const address = data?.address || {};
                const locality = address.city || address.town || address.village || address.municipality || address.county || '';
                const region = address.state || address.region || address.state_district || '';
                const shortLocation = [locality, region].filter(Boolean).join(', ') || data?.display_name || '';
                registrationData.location_address = data?.display_name || shortLocation;
                if (shortLocation) {
                    registrationData.location_name = shortLocation;
                    const input = document.getElementById('reg-location');
                    if (input) input.value = shortLocation;
                }
            } catch (error) {
                console.warn('Registration reverse geocoding error:', error);
            }
        }

        function initRegistrationMap() {
            const mapElement = document.getElementById('map-registration');
            if (!mapElement) return;

            if (regMap) {
                regMap.remove();
                regMap = null;
                regMarker = null;
            }

            const initialPos = registrationData.latitude && registrationData.longitude
                ? [Number(registrationData.latitude), Number(registrationData.longitude)]
                : [30.4278, -9.5981];
            regMap = L.map('map-registration').setView(initialPos, 13);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(regMap);

            regMarker = L.marker(initialPos, { draggable: true }).addTo(regMap);
            regMarker.on('dragend', async function() {
                const pos = regMarker.getLatLng();
                await updateRegistrationLocationFromCoords(pos.lat, pos.lng);
            });

            regMap.on('click', async function(e) {
                regMarker.setLatLng(e.latlng);
                await updateRegistrationLocationFromCoords(e.latlng.lat, e.latlng.lng);
            });
        }

        function detectLocation() {
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(async pos => {
                    const lat = pos.coords.latitude;
                    const lng = pos.coords.longitude;
                    await updateRegistrationLocationFromCoords(lat, lng);
                    if (regMap && regMarker) {
                        regMap.setView([lat, lng], 15);
                        regMarker.setLatLng([lat, lng]);
                    }
                }, err => alert('Errore GPS: ' + err.message));
            } else {
                alert('Il tuo dispositivo non supporta il GPS');
            }
        }

        async function completeRegistration() {
            // RAYAT FIX - popup subscription / new customers / email
            // RAYAT FIX - registration/admin
            syncRegistrationFormState();
            registrationData.location_address = registrationData.location_address || registrationData.location_name;

            if (!registrationData.name || !registrationData.last_name || !registrationData.phone || !registrationData.email || !registrationData.password || !registrationData.location_name) {
                alert(t('regRequiredFields'));
                return;
            }

            try {
                const res = await fetch(`${CONFIG.API_BASE_URL}/auth/register-full`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Rayat-Analytics-Id': getAnalyticsAnonymousId()
                    },
                    body: JSON.stringify(registrationData)
                });
                const data = await res.json();
                if (data.success) {
                    authToken = data.token;
                    user = data.user;
                    localStorage.setItem('rayat_token', authToken);
                    localStorage.setItem('rayat_user', JSON.stringify(user));
                    currentRole = data.user.role || 'client';
                    syncStoredUserProfileIntoSession();
                    syncSubscriptionUiState();
                    hideSubscriptionExpiredModal();
                    setView('demo');
                    alert('Benvenuto in Rayat! ✅');
                } else {
                    throw new Error(data.error);
                }
            } catch (e) {
                console.error('Registration error:', e);
                alert(e.message || 'Errore registrazione. Controlla la connessione al server.');
            }
        }

        function renderServiziPage() {
            return `
                ${renderHeader(!!user)}
            <section class="py-16 bg-white">
                <div class="container mx-auto px-4">
                    <h2 class="text-5xl font-bold text-center mb-12 text-green-800">${t('services')}</h2>

                    <div class="space-y-12">
                        ${Object.keys(sensorData).map(key => {
                const sensor = sensorData[key];
                return `
                                    <div
                                        id="service-${key}"
                                        class="bg-white rounded-2xl shadow-2xl p-8 border border-gray-100 cursor-pointer transition hover:shadow-[0_28px_70px_rgba(15,23,42,0.12)]"
                                        role="button"
                                        tabindex="0"
                                        onclick="openSensorDashboard('${key}')"
                                        onkeydown="handleSensorCardKeydown(event, '${key}')"
                                    >
                                        <div class="flex flex-col md:flex-row items-center md:space-x-8 mb-6">
                                            <div class="text-8xl mb-4 md:mb-0">${sensor.icon}</div>
                                            <div class="text-center md:text-left flex-grow">
                                                <h3 class="text-4xl font-bold text-green-800 mb-2">${t(sensor.nome)}</h3>
                                                <p class="text-xl text-gray-600">${t(sensor.descrizioneEstesa || sensor.descrizione)}</p>
                                            </div>
                                            <div class="mt-4 md:mt-0">
                                                <button onclick="event.stopPropagation(); openSensorDashboard('${key}')" class="w-full md:w-auto bg-orange-500 hover:bg-orange-600 text-white px-8 py-4 rounded-lg text-lg font-bold transition transform hover:scale-105 shadow-lg">
                                                    ${user ? (t('dashboardBtn') || 'Dashboard Privata') : (t('demoBtn') || 'Versione Demo')} 📊
                                                </button>
                                            </div>
                                        </div>

                                        <div class="bg-green-50 rounded-xl p-6">
                                            <h4 class="text-2xl font-bold mb-4 text-green-700">${t('features')}</h4>
                                            <ul class="space-y-3">
                                                ${sensor.funzioni.map(f => `
                                                    <li class="flex items-start">
                                                        <span class="text-green-600 mr-3 text-2xl">✓</span>
                                                        <span class="text-gray-700 text-lg">${t(f)}</span>
                                                    </li>
                                                `).join('')}
                                            </ul>
                                        </div>
                                    </div>
                                `;
            }).join('')}
                    </div>
                    <div class="mt-16 bg-green-100 rounded-2xl p-8 text-center shadow-inner">
                        <h3 class="text-4xl font-bold mb-4 text-green-800">🎯 ${t('customSolutionsTitle')}</h3>
                        <p class="text-xl text-gray-700 mb-6">${t('customSolutionsDesc')}</p>
                        <button onclick="setViewWithTracking('contatti')" class="bg-green-700 hover:bg-green-800 text-white px-8 py-4 rounded-lg text-lg font-semibold transition">
                            ${t('contactUs')}
                        </button>
                    </div>
                </div>
            </section>
            ${renderFooter()}
            `;
        }

        function renderChiSiamoPage() {
            return `
                ${renderHeader(!!user)}
                <section class="py-24 bg-gradient-to-b from-green-50 to-white min-h-screen">
                    <div class="container mx-auto px-4 max-w-5xl">
                        <div class="text-center mb-16">
                            <h2 class="text-6xl font-black text-green-800 tracking-tighter uppercase mb-4">${t('aboutUs')}</h2>
                            <div class="h-2 w-24 bg-orange-500 mx-auto rounded-full"></div>
                        </div>
                        <div class="bg-white rounded-[3rem] shadow-2xl p-10 md:p-20 border border-green-100 relative overflow-hidden">
                            <div class="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-green-600 to-blue-600"></div>
                            <div class="flex flex-col gap-12 relative z-10">
                                <div class="flex items-start gap-8">
                                    <div class="text-7xl" style="filter: sepia(100%) hue-rotate(70deg) saturate(500%) brightness(0.7);">🌾</div>
                                    <div>
                                        <h3 class="text-4xl font-black text-green-900 mb-6 uppercase tracking-tight">${t('ourReality')}</h3>
                                        <p class="text-xl text-gray-700 leading-relaxed font-medium">${t('ourRealityDesc')}</p>
                                    </div>
                                </div>
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-10 mt-10">
                                    <div class="bg-blue-50 p-10 rounded-[2.5rem] border border-blue-100">
                                        <h4 class="text-2xl font-black text-blue-800 mb-4 uppercase tracking-widest">${t('ourMission')}</h4>
                                        <p class="text-lg text-blue-900/70 font-medium">${t('ourMissionDesc')}</p>
                                    </div>
                                    <div class="bg-orange-50 p-10 rounded-[2.5rem] border border-orange-100">
                                        <h4 class="text-2xl font-black text-orange-800 mb-4 uppercase tracking-widest">${t('ourDuty')}</h4>
                                        <p class="text-lg text-orange-900/70 font-medium">${t('ourDutyDesc')}</p>
                                    </div>
                                </div>
                                <div class="bg-green-800 text-white p-12 rounded-[3rem] text-center shadow-2xl transform hover:scale-105 transition duration-500">
                                    <h4 class="text-3xl font-black mb-4 uppercase tracking-tighter">${t('ourCommitment')}</h4>
                                    <p class="text-xl opacity-90 font-medium max-w-2xl mx-auto">${t('ourCommitmentDesc')}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
                ${renderFooter()}
            `;
        }

        function renderContactPage() {
            return `
                ${renderHeader(false)}
                <div class="rayat-contact-page bg-gray-50 min-h-screen">
                    <!-- Hero Section -->
                    <section class="bg-green-800 text-white py-16 px-4">
                        <div class="container mx-auto text-center max-w-3xl">
                            <h2 class="text-4xl md:text-5xl font-black mb-4 uppercase tracking-tighter">${t('contactTitle')}</h2>
                            <p class="text-xl text-green-100 font-medium">${t('contactSub')}</p>
                        </div>
                    </section>

                    <div class="container mx-auto px-4 -mt-10 pb-20">
                        <div class="rayat-contact-grid grid grid-cols-1 lg:grid-cols-3 gap-8">

                            <!-- Sidebar: Contatti Rapidi & Orari -->
                            <div class="lg:col-span-1 space-y-6">
                                <!-- Contatti Card -->
                                <div class="bg-white rounded-3xl shadow-xl p-8 border border-gray-100">
                                    <h3 class="text-2xl font-bold text-green-800 mb-6 flex items-center gap-2">
                                        <span class="text-3xl">👤</span> ${contactSettings.founderName}
                                    </h3>
                                    <div class="space-y-6">
                                        <!-- Italia -->
                                        <div class="flex items-start gap-4 group">
                                            <div class="w-12 h-12 bg-green-50 rounded-2xl flex items-center justify-center text-2xl group-hover:bg-green-100 transition">🇮🇹</div>
                                            <div>
                                                <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">${t('ctaCallIt')}</p>
                                                <p class="text-lg font-bold text-gray-800">${contactSettings.phoneItaly}</p>
                                                <a href="tel:${contactSettings.phoneItaly.replace(/ /g, '')}" class="text-sm text-green-600 font-bold hover:underline">Chiama ora ➡️</a>
                                            </div>
                                        </div>
                                        <!-- Marocco -->
                                        <div class="flex items-start gap-4 group">
                                            <div class="w-12 h-12 bg-green-50 rounded-2xl flex items-center justify-center text-2xl group-hover:bg-green-100 transition">🇲🇦</div>
                                            <div>
                                                <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">${t('ctaCallMa')}</p>
                                                <p class="text-lg font-bold text-gray-800">${contactSettings.phoneMorocco}</p>
                                                <a href="tel:${contactSettings.phoneMorocco.replace(/ /g, '')}" class="text-sm text-green-600 font-bold hover:underline">Chiama ora ➡️</a>
                                            </div>
                                        </div>
                                        <!-- WhatsApp -->
                                        <div class="flex items-start gap-4 group">
                                            <div class="w-12 h-12 bg-green-50 rounded-2xl flex items-center justify-center text-2xl group-hover:bg-green-100 transition">💬</div>
                                            <div>
                                                <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">${t('ctaWhatsapp')}</p>
                                                <p class="text-lg font-bold text-gray-800">${contactSettings.whatsapp}</p>
                                                <a href="${getWhatsappHref()}" target="_blank" rel="noopener" onclick="trackEvent('WhatsApp Click')" class="text-sm text-green-600 font-bold hover:underline">Chatta ora ➡️</a>
                                            </div>
                                        </div>
                                        <!-- Email -->
                                        <div class="flex items-start gap-4 group">
                                            <div class="w-12 h-12 bg-green-50 rounded-2xl flex items-center justify-center text-2xl group-hover:bg-green-100 transition">📧</div>
                                            <div>
                                                <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">${t('formEmail')}</p>
                                                <p class="text-lg font-bold text-gray-800">${contactSettings.email}</p>
                                                <a href="mailto:${contactSettings.email}" class="text-sm text-green-600 font-bold hover:underline">Invia email ➡️</a>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- Orari Card -->
                                <div class="bg-gradient-to-br from-green-800 to-green-900 rounded-3xl shadow-xl p-8 text-white">
                                    <h3 class="text-xl font-bold mb-4 flex items-center gap-2">
                                        <span>⏰</span> ${t('hoursTitle')}
                                    </h3>
                                    <div class="space-y-3">
                                        <div class="flex justify-between border-b border-green-700 pb-2">
                                            <span>${t('hoursWeek')}</span>
                                            <span class="font-bold">${t('hoursTime')}</span>
                                        </div>
                                        <p class="text-sm text-green-200 mt-4 leading-relaxed italic">
                                            * ${t('waSupport')}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <!-- Main Content: Form & Sede -->
                            <div class="lg:col-span-2 space-y-8">
                                <!-- Contact Form -->
                                <div class="bg-white rounded-3xl shadow-xl p-8 md:p-12 border border-gray-100">
                                    <h3 class="text-3xl font-black text-green-800 mb-8 uppercase tracking-tighter">${t('formTitle')}</h3>
                                    <div id="contact-success" class="hidden bg-green-50 border-2 border-green-200 text-green-800 p-6 rounded-2xl mb-8 flex items-center gap-4">
                                        <span class="text-3xl">✅</span>
                                        <span class="font-bold">${t('formSuccess')}</span>
                                    </div>
                                    <form id="contact-form" onsubmit="handleContactSubmit(event)" class="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div>
                                            <label class="block text-sm font-bold text-gray-400 uppercase tracking-widest mb-2">${t('formName')}</label>
                                            <input type="text" required class="w-full px-5 py-4 bg-gray-50 border-2 border-transparent focus:border-green-500 focus:bg-white rounded-2xl outline-none transition" placeholder="es. Fulane al fulani">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-bold text-gray-400 uppercase tracking-widest mb-2">${t('formPhone')}</label>
                                            <input type="tel" required class="w-full px-5 py-4 bg-gray-50 border-2 border-transparent focus:border-green-500 focus:bg-white rounded-2xl outline-none transition" placeholder="+212 ...">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-bold text-gray-400 uppercase tracking-widest mb-2">${t('formEmail')}</label>
                                            <input type="email" required class="w-full px-5 py-4 bg-gray-50 border-2 border-transparent focus:border-green-500 focus:bg-white rounded-2xl outline-none transition" placeholder="email@esempio.com">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-bold text-gray-400 uppercase tracking-widest mb-2">${t('formType')}</label>
                                            <select class="w-full px-5 py-4 bg-gray-50 border-2 border-transparent focus:border-green-500 focus:bg-white rounded-2xl outline-none transition appearance-none">
                                                <option value="general">${t('typeGeneral')}</option>
                                                <option value="support">${t('typeSupport')}</option>
                                                <option value="collab">${t('typeCollab')}</option>
                                                <option value="demo">${t('typeDemo')}</option>
                                                <option value="meeting">${t('typeMeeting')}</option>
                                                <option value="other">${t('typeOther')}</option>
                                            </select>
                                        </div>
                                        <div class="md:col-span-2">
                                            <label class="block text-sm font-bold text-gray-400 uppercase tracking-widest mb-2">${t('formMsg')}</label>
                                            <textarea required rows="4" class="w-full px-5 py-4 bg-gray-50 border-2 border-transparent focus:border-green-500 focus:bg-white rounded-2xl outline-none transition" placeholder="..."></textarea>
                                        </div>
                                        <div class="md:col-span-2 pt-4">
                                            <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-black uppercase tracking-widest py-5 rounded-2xl shadow-lg transform transition active:scale-95">
                                                ${t('formSubmit')} 🚀
                                            </button>
                                        </div>
                                    </form>
                                </div>

                                <!-- Headquarters Section -->
                                <div class="bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100">
                                    <div class="p-8 md:p-12">
                                        <h3 class="text-3xl font-black text-green-800 mb-8 uppercase tracking-tighter">${t('headquarters')}</h3>
                                        <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                                            <div>
                                                <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">${t('addressLabel')}</p>
                                                <p class="text-xl font-bold text-gray-800">${contactSettings.officeName}</p>
                                                <p class="text-gray-600">${contactSettings.officeAddress}</p>
                                            </div>
                                            <div class="grid grid-cols-2 gap-4">
                                                <div>
                                                    <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">${t('cityLabel')}</p>
                                                    <p class="font-bold text-gray-800">${contactSettings.officeCity}</p>
                                                </div>
                                                <div>
                                                    <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">${t('countryLabel')}</p>
                                                    <p class="font-bold text-gray-800">${contactSettings.officeCountry}</p>
                                                </div>
                                            </div>
                                        </div>
                                        <button onclick="window.open('https://www.google.com/maps?q=${contactSettings.lat},${contactSettings.lng}', '_blank')" class="bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-3 rounded-xl transition flex items-center gap-2 mb-8">
                                            📍 ${t('openInMap')}
                                        </button>
                                    </div>
                                    <div class="rayat-contact-map-shell">
                                        <div id="contact-map" class="w-full bg-gray-200 rounded-[1.75rem]"></div>
                                    </div>
                                </div>

                                <!-- Founder Section -->
                                <!-- RAYAT FIX - rende il visual mani completamente visibile su mobile e desktop -->
                                <div class="bg-gradient-to-r from-orange-400 to-orange-500 rounded-3xl p-8 md:p-12 text-white shadow-xl relative overflow-hidden rayat-founder-card">
                                     <div class="relative z-10 rayat-founder-copy">
                                        <h3 class="text-3xl font-black mb-4 uppercase tracking-tighter">${t('founderSection')}</h3>
                                        <p class="text-xl font-medium opacity-90 max-w-2xl">${t('founderText')}</p>
                                     </div>
                                     <div class="rayat-founder-visual" aria-hidden="true">
                                        <span class="rayat-founder-visual-emoji">🤝</span>
                                     </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- Custom Footer Message for Contacts -->
                <div class="bg-green-900 border-t border-green-800 text-green-100 py-12 px-4 text-center">
                    <div class="container mx-auto">
                         <p class="text-lg font-medium max-w-2xl mx-auto italic">
                            "Rayat supporta l’agricoltura intelligente con strumenti semplici, monitoraggio sul campo e assistenza dedicata agli agricoltori."
                         </p>
                    </div>
                </div>
                ${renderFooter()}
            `;
        }

        function handleContactSubmit(e) {
            e.preventDefault();
            document.getElementById('contact-form').classList.add('hidden');
            document.getElementById('contact-success').classList.remove('hidden');
            window.scrollTo({ top: 100, behavior: 'smooth' });
        }

        let contactMapInstance = null;
        function initContactMap() {
            setTimeout(() => {
                const mapEl = document.getElementById('contact-map');
                if (!mapEl || typeof L === 'undefined') return;

                if (contactMapInstance) {
                    contactMapInstance.remove();
                    contactMapInstance = null;
                }

                const lat = Number(contactSettings.lat) || 30.4703;
                const lng = Number(contactSettings.lng) || -8.8770;
                const map = L.map('contact-map', {
                    scrollWheelZoom: false
                }).setView([lat, lng], 15);
                contactMapInstance = map;

                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap'
                }).addTo(map);

                L.marker([lat, lng]).addTo(map)
                    .bindPopup(`<b class="text-green-800">${contactSettings.officeName}</b><br>${contactSettings.officeAddress}<br>Taroudant, Morocco`)
                    .openPopup();

                scheduleMapInvalidate(map);
            }, 100);
        }

        let homeMapInstance = null;
        function initHomeMap() {
            setTimeout(() => {
                const mapEl = document.getElementById('home-map');
                if (!mapEl || typeof L === 'undefined') return;

                // Dispose of previous instance if it exists to allow re-initialization
                if (homeMapInstance) {
                    homeMapInstance.remove();
                    homeMapInstance = null;
                }

                // Center on Morocco (with a focus shift towards Souss-Massa)
                const map = L.map('home-map', {
                    scrollWheelZoom: false
                }).setView([30.5, -9.0], 6);
                homeMapInstance = map;

                L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
                    attribution: '©OpenStreetMap ©CARTO'
                }).addTo(map);

                // Highlight Souss-Massa Region (Simplified Polygon approximation)
                const soussMassaCoords = [
                    [31.2, -9.8], [31.5, -8.5], [30.8, -7.5], [29.5, -8.5], [29.2, -10.2], [30.2, -10.0]
                ];
                L.polygon(soussMassaCoords, {
                    color: '#22c55e',
                    fillColor: '#22c55e',
                    fillOpacity: 0.1,
                    weight: 2,
                    dashArray: '5, 5'
                }).addTo(map).bindTooltip(t('mapFocusArea'), { sticky: true });

                // Add markers
                mockClients.forEach(client => {
                    // Filter to only show Souss-Massa region
                    if (client.region !== 'Souss-Massa') return;

                    const icon = L.divIcon({
                        className: 'custom-div-icon',
                        html: `<div class="marker-online" style="width: 12px; height: 12px;"></div>`,
                        iconSize: [12, 12],
                        iconAnchor: [6, 6]
                    });

                    // Translate crop name dynamically
                    let cropKey = client.crop.toLowerCase();
                    // Basic mapping for common variations
                    if (cropKey === 'tomato' || cropKey === 'tomatoes') cropKey = 'pomodori';
                    if (cropKey === 'banana') cropKey = 'banane';
                    if (cropKey === 'orange' || cropKey === 'citrus') cropKey = 'agrumi';
                    if (cropKey === 'strawberry') cropKey = 'fragole';
                    if (cropKey === 'olive') cropKey = 'olive';

                    const translatedCrop = t(cropKey);
                    const lastActiveLabel = t('lastActive') || 'Ultima attività';

                    L.marker([client.lat, client.lng], { icon: icon }).addTo(map)
                        .bindPopup(`
                            <div class="p-2">
                                <div class="flex items-center gap-2 mb-2">
                                    <div class="w-2 h-2 bg-green-500 animate-pulse rounded-full"></div>
                                    <span class="text-[10px] font-black uppercase tracking-widest text-gray-500">${t('statusOnline')}</span>
                                </div>
                                <h4 class="font-black text-gray-800 leading-tight mb-1">${client.name}</h4>
                                <div class="text-[10px] font-medium text-gray-500 space-y-1">
                                    <p>🚜 ${t('crop')}: <span class="text-green-700">${translatedCrop}</span></p>
                                    <p>📍 ${t('locality')}: ${client.locality}</p>
                                    <p>🌍 ${t('region')}: ${client.region}</p>
                                    <p class="pt-1 border-t mt-1">🕒 ${lastActiveLabel}: ${client.lastActive}</p>
                                </div>
                            </div>
                        `);
                });

                // Auto-zoom to Souss-Massa on desktop if preferred, but user requested "vista iniziale sul Marocco"
                // so we keep the zoom 6.
                scheduleMapInvalidate(map);
            }, 100);
        }

        // RAYAT FIX - user profile
        async function saveUserProfile(event) {
            event.preventDefault();

            if (!isAuthenticated() || !isCustomerRole(currentRole)) {
                navigateToAccountPage();
                return;
            }

            const currentProfile = getMergedUserProfile();
            const nextName = document.getElementById('profile-name')?.value.trim() || currentProfile.name;
            const nextEmail = document.getElementById('profile-email')?.value.trim().toLowerCase() || currentProfile.email;
            const nextPhone = document.getElementById('profile-phone')?.value.trim() || '';
            const nextDescription = document.getElementById('profile-description')?.value.trim() || '';
            const nextPhoto = currentProfile.photo || '';

            try {
                const response = await fetch(`${CONFIG.API_BASE_URL}/auth/profile`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                    },
                    body: JSON.stringify({
                        profile_phone: nextPhone,
                        profile_description: nextDescription,
                        profile_photo: nextPhoto
                    })
                });
                const data = await response.json().catch(() => null);

                if (!response.ok || data?.success === false) {
                    throw new Error(data?.error || 'Errore durante il salvataggio del profilo');
                }

                const persistedProfile = data?.profile || {};
                user = {
                    ...user,
                    profile_phone: persistedProfile.profile_phone ?? null,
                    profile_description: persistedProfile.profile_description ?? null,
                    profile_photo: persistedProfile.profile_photo ?? null,
                    profile_updated_at: persistedProfile.profile_updated_at ?? null
                };

                writeStoredUserProfile({
                    ...currentProfile,
                    name: user?.name || nextName || currentProfile.name,
                    email: user?.email || nextEmail || currentProfile.email,
                    phone: persistedProfile.profile_phone || '',
                    description: persistedProfile.profile_description || '',
                    photo: persistedProfile.profile_photo || ''
                });
                syncStoredUserProfileIntoSession();
                userProfileNotice = t('profileSaved');
                render();
            } catch (error) {
                console.error('Save profile error:', error);
                userProfileNotice = error.message || 'Errore durante il salvataggio del profilo';
                render();
            }
        }

        // RAYAT FIX - user profile
        function handleUserProfilePhotoChange(event) {
            if (!isAuthenticated() || !isCustomerRole(currentRole)) return;

            const file = event.target.files && event.target.files[0];
            if (!file || !file.type.startsWith('image/')) return;

            const reader = new FileReader();
            reader.onload = () => {
                const nextProfile = {
                    ...getMergedUserProfile(),
                    photo: String(reader.result || '')
                };
                writeStoredUserProfile(nextProfile);
                syncStoredUserProfileIntoSession();
                userProfileNotice = t('profileSaved');
                render();
            };
            reader.readAsDataURL(file);
        }

        // RAYAT FIX - user profile
        function removeUserProfilePhoto() {
            if (!isAuthenticated() || !isCustomerRole(currentRole)) return;

            const nextProfile = {
                ...getMergedUserProfile(),
                photo: ''
            };
            writeStoredUserProfile(nextProfile);
            syncStoredUserProfileIntoSession();
            userProfileNotice = t('profileSaved');
            render();
        }

        // RAYAT FIX - user profile
        function renderUserProfilePage() {
            if (!isAuthenticated()) {
                setTimeout(() => setView('login', { replace: true, path: '/login' }), 0);
                return '';
            }

            if (!isCustomerRole(currentRole)) {
                setTimeout(() => setView('home', { replace: true, path: '/' }), 0);
                return '';
            }

            const profile = getMergedUserProfile();
            const assignedSensors = getAssignedSensorsForProfile();
            const roleLabel = t('profileRoleLabel');
            const avatarMarkup = profile.photo
                ? `<img src="${escapeHtml(profile.photo)}" alt="${escapeHtml(profile.name || 'Rayat user')}" class="rayat-profile-avatar-image">`
                : `<div class="rayat-profile-avatar-fallback">${escapeHtml(getUserInitials(profile.name))}</div>`;

            return `
                ${renderHeader(true)}
                <section class="rayat-profile-page py-16 bg-gray-50 min-h-screen">
                    <div class="container mx-auto px-4 max-w-6xl">
                        <div class="mb-8 md:mb-10">
                            <p class="text-[11px] font-black uppercase tracking-[0.28em] text-green-700 mb-3">${t('profileNav')}</p>
                            <h2 class="text-5xl md:text-6xl font-black text-slate-900 tracking-tighter mb-4">${t('profileTitle')}</h2>
                            <p class="text-lg text-slate-600 max-w-3xl">${t('profileSubtitle')}</p>
                        </div>

                        ${userProfileNotice ? `
                            <div class="mb-6 rounded-3xl border border-green-200 bg-green-50 text-green-800 px-6 py-4 font-bold">
                                ${escapeHtml(userProfileNotice)}
                            </div>
                        ` : ''}

                        <div id="${PROFILE_SECTION_IDS.overview}" class="rayat-profile-layout">
                            <div class="rayat-profile-card">
                                <div class="rayat-profile-hero">
                                    <div class="rayat-profile-avatar">
                                        ${avatarMarkup}
                                    </div>
                                    <div class="min-w-0">
                                        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-50 text-green-700 text-[11px] font-black uppercase tracking-[0.18em]">
                                            <span>•</span>
                                            <span>${escapeHtml(roleLabel)}: ${escapeHtml(profile.role)}</span>
                                        </div>
                                        <h3 class="text-3xl font-black text-slate-900 tracking-tight mt-4 break-words">${escapeHtml(profile.name || user.name || 'Rayat')}</h3>
                                        <p class="text-slate-500 font-medium break-all mt-2">${escapeHtml(profile.email || user.email || '')}</p>
                                    </div>
                                </div>

                                <div id="${PROFILE_SECTION_IDS.settings}" class="mt-8 pt-8 border-t border-slate-200">
                                    <div class="mb-6">
                                        <p class="text-[11px] font-black uppercase tracking-[0.28em] text-slate-500 mb-2">${t('settings')}</p>
                                        <h4 class="text-2xl font-black text-slate-900 tracking-tight">${t('settings')}</h4>
                                    </div>
                                    <form onsubmit="saveUserProfile(event)" class="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div>
                                        <label class="block text-xs font-black text-slate-500 uppercase tracking-[0.16em] mb-2">${t('regFullName')}</label>
                                        <input id="profile-name" type="text" value="${escapeHtml(profile.name)}" class="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:border-green-500 focus:bg-white transition">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-black text-slate-500 uppercase tracking-[0.16em] mb-2">${t('formEmail')}</label>
                                        <input id="profile-email" type="email" value="${escapeHtml(profile.email)}" class="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:border-green-500 focus:bg-white transition">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-black text-slate-500 uppercase tracking-[0.16em] mb-2">${t('regPhone')}</label>
                                        <input id="profile-phone" type="tel" value="${escapeHtml(profile.phone)}" class="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:border-green-500 focus:bg-white transition" placeholder="+212 ...">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-black text-slate-500 uppercase tracking-[0.16em] mb-2">${t('profilePhoto')}</label>
                                        <div class="flex flex-wrap items-center gap-3">
                                            <label class="inline-flex items-center justify-center px-5 py-3 rounded-2xl bg-slate-900 text-white font-black text-xs uppercase tracking-[0.16em] cursor-pointer hover:bg-slate-800 transition">
                                                <span>${t('profilePhoto')}</span>
                                                <input type="file" accept="image/*" class="hidden" onchange="handleUserProfilePhotoChange(event)">
                                            </label>
                                            ${profile.photo ? `<button type="button" onclick="removeUserProfilePhoto()" class="inline-flex items-center justify-center px-4 py-3 rounded-2xl bg-white border border-slate-200 text-slate-700 font-black text-xs uppercase tracking-[0.16em] hover:border-red-200 hover:text-red-600 transition">${t('profilePhotoRemove')}</button>` : ''}
                                        </div>
                                        <p class="text-sm text-slate-500 mt-3">${t('profilePhotoHint')}</p>
                                    </div>
                                    <div class="md:col-span-2">
                                        <label class="block text-xs font-black text-slate-500 uppercase tracking-[0.16em] mb-2">${t('profileDescription')}</label>
                                        <textarea id="profile-description" rows="4" class="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:border-green-500 focus:bg-white transition resize-none" placeholder="${escapeHtml(t('profileDescription'))}">${escapeHtml(profile.description)}</textarea>
                                    </div>
                                    <div class="md:col-span-2">
                                        <button type="submit" class="inline-flex items-center justify-center min-h-[52px] px-8 py-4 rounded-2xl bg-green-700 hover:bg-green-800 text-white font-black uppercase tracking-[0.16em] shadow-xl transition">
                                            ${t('profileSave')}
                                        </button>
                                    </div>
                                    </form>
                                </div>
                            </div>

                            <aside class="rayat-profile-card rayat-profile-sidebar">
                                <div>
                                    <p class="text-xs font-black text-slate-500 uppercase tracking-[0.16em] mb-3">${t('profilePersonalInfo')}</p>
                                    <div class="space-y-4">
                                        <div class="rayat-profile-meta-row">
                                            <span>${escapeHtml(roleLabel)}</span>
                                            <strong>${escapeHtml(profile.role)}</strong>
                                        </div>
                                        <div class="rayat-profile-meta-row">
                                            <span>${escapeHtml(t('profileSensorsTitle'))}</span>
                                            <strong>${assignedSensors.length}</strong>
                                        </div>
                                        <div class="rayat-profile-meta-row">
                                            <span>${escapeHtml(t('profileViewOnly'))}</span>
                                            <strong>${escapeHtml(t('profileSensorsHint'))}</strong>
                                        </div>
                                    </div>
                                </div>
                            </aside>
                        </div>

                        <div class="rayat-profile-card mt-8">
                            <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-8">
                                <div>
                                    <h3 class="text-3xl font-black text-slate-900 tracking-tight">${t('profileSensorsTitle')}</h3>
                                    <p class="text-slate-500 mt-2">${t('profileSensorsHint')}</p>
                                </div>
                                <div class="inline-flex items-center justify-center px-4 py-2 rounded-full bg-slate-100 text-slate-600 font-black text-xs uppercase tracking-[0.16em]">
                                    ${t('profileViewOnly')}
                                </div>
                            </div>

                            ${isBarakahPerliteCustomer() ? `
                                <div class="rayat-profile-sensors-grid mb-8">
                                    <button type="button" onclick="setView('perlite-track')" class="rayat-profile-sensor-card text-left">
                                        <div class="flex items-start justify-between gap-4">
                                            <div class="min-w-0">
                                                <div class="text-3xl mb-4">🌱</div>
                                                <h4 class="text-xl font-black text-slate-900 tracking-tight break-words">RAYAT perlite track</h4>
                                                <p class="text-sm text-slate-500 mt-2">Substrate Rayat: umidita, EC e temperatura del substrato</p>
                                            </div>
                                            <span class="inline-flex items-center justify-center px-3 py-1 rounded-full bg-green-50 text-green-700 font-black text-[11px] uppercase tracking-[0.14em]">${t('profileViewOnly')}</span>
                                        </div>
                                        <div class="space-y-3 mt-6">
                                            <div class="rayat-profile-meta-row">
                                                <span>${escapeHtml(t('profileDeviceLabel'))}</span>
                                                <strong>GW-002</strong>
                                            </div>
                                            <div class="rayat-profile-meta-row">
                                                <span>${escapeHtml(t('profileLatestReading'))}</span>
                                                <strong>Substrate Rayat</strong>
                                            </div>
                                        </div>
                                    </button>
                                </div>
                            ` : ''}

                            ${assignedSensors.length ? `
                                <div class="rayat-profile-sensors-grid">
                                    ${assignedSensors.map((sensor) => `
                                        <div class="rayat-profile-sensor-card">
                                            <div class="flex items-start justify-between gap-4">
                                                <div class="min-w-0">
                                                    <div class="text-3xl mb-4">${sensor.icon}</div>
                                                    <h4 class="text-xl font-black text-slate-900 tracking-tight break-words">${escapeHtml(sensor.name)}</h4>
                                                    <p class="text-sm text-slate-500 mt-2">${escapeHtml(sensor.typeLabel)}</p>
                                                </div>
                                                <span class="inline-flex items-center justify-center px-3 py-1 rounded-full bg-green-50 text-green-700 font-black text-[11px] uppercase tracking-[0.14em]">${t('profileViewOnly')}</span>
                                            </div>
                                            <div class="space-y-3 mt-6">
                                                <div class="rayat-profile-meta-row">
                                                    <span>${escapeHtml(t('profileDeviceLabel'))}</span>
                                                    <strong>${escapeHtml(sensor.deviceName)}</strong>
                                                </div>
                                                <div class="rayat-profile-meta-row">
                                                    <span>${escapeHtml(t('profileLatestReading'))}</span>
                                                    <strong>${escapeHtml(sensor.value)}</strong>
                                                </div>
                                            </div>
                                        </div>
                                    `).join('')}
                                </div>
                            ` : `
                                <div class="rounded-[2rem] border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center text-slate-500 font-medium">
                                    ${t('profileNoSensors')}
                                </div>
                            `}
                        </div>
                    </div>
                </section>
                ${renderFooter()}
            `;
        }

        function renderPrivacyPage() {
            return `
                ${renderHeader(!!user)}
                <section class="py-24 bg-gray-50 min-h-screen">
                    <div class="container mx-auto px-4 max-w-4xl">
                        <div class="text-center mb-16">
                            <h2 class="text-5xl font-black text-slate-900 tracking-tighter uppercase mb-4">${t('privacyPolicy')}</h2>
                            <p class="text-xl font-bold text-green-700 uppercase tracking-widest">Rayat Smart Monitoring - Maroc</p>
                        </div>

                        <div class="bg-white rounded-[3rem] shadow-2xl p-10 md:p-16 border border-gray-100 text-gray-700 leading-relaxed">
                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">1. Responsable du traitement</h3>
                            <p class="mb-8 font-medium">
                                Rayat Smart Monitoring agit en qualité de responsable du traitement pour les données personnelles collectées dans le cadre de la fourniture de sa plateforme SaaS de supervision agricole et IoT. Cette politique s'applique aux comptes clients, aux interfaces administratives, aux capteurs connectés et aux formulaires de contact.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">2. Données collectées</h3>
                            <ul class="list-disc pl-8 mb-8 space-y-2 font-medium">
                                <li><strong>Données de compte :</strong> nom, email, téléphone, rôle, mot de passe chiffré, langue, informations d'abonnement.</li>
                                <li><strong>Données d'exploitation et IoT :</strong> localisation, culture principale, coordonnées GPS, identifiants d'appareils, mesures de capteurs, alertes et journaux techniques.</li>
                                <li><strong>Données d'usage :</strong> adresse IP, navigateur, actions réalisées dans l'application, dates de connexion, cookies techniques et informations de sécurité.</li>
                            </ul>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">3. Finalités du traitement</h3>
                            <ul class="list-disc pl-8 mb-8 space-y-2 font-medium">
                                <li>fournir l'accès à la plateforme, aux tableaux de bord et aux alertes temps réel ;</li>
                                <li>gérer les comptes, la facturation, l'assistance et la relation contractuelle ;</li>
                                <li>sécuriser les accès, prévenir les usages frauduleux et restaurer l'accès en cas d'oubli de mot de passe ;</li>
                                <li>produire des indicateurs agronomiques, des estimations d'usage et des améliorations produit.</li>
                            </ul>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">4. Base légale</h3>
                            <ul class="list-disc pl-8 mb-8 space-y-2 font-medium">
                                <li><strong>Exécution du contrat :</strong> création de compte, fourniture du service, support et supervision des équipements.</li>
                                <li><strong>Obligation légale :</strong> conservation des éléments liés à la facturation, à la sécurité et aux obligations réglementaires applicables.</li>
                                <li><strong>Intérêt légitime :</strong> sécurisation de la plateforme, amélioration continue, détection d'incidents et statistiques d'usage.</li>
                                <li><strong>Consentement :</strong> lorsque la réglementation l'exige pour certains cookies non essentiels ou certaines communications.</li>
                            </ul>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">5. Durée de conservation</h3>
                            <ul class="list-disc pl-8 mb-8 space-y-2 font-medium">
                                <li>les données de compte sont conservées pendant la durée de la relation contractuelle puis archivées pendant la période nécessaire aux obligations légales et à la défense des droits ;</li>
                                <li>les données techniques et IoT sont conservées aussi longtemps que le service est actif, puis selon les besoins d'historique, de support et de conformité ;</li>
                                <li>les journaux de sécurité et demandes de réinitialisation de mot de passe sont conservés pour une durée limitée, strictement proportionnée à la sécurisation du service.</li>
                            </ul>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">6. Droits des utilisateurs</h3>
                            <p class="mb-8 font-medium">
                                Vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation, d'opposition et, lorsque la réglementation le permet, d'un droit à la portabilité. Vous pouvez également retirer votre consentement lorsque celui-ci constitue la base légale du traitement. Les demandes peuvent être adressées à <strong>privacy@rayat.ma</strong>.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">7. Sécurité</h3>
                            <p class="mb-8 font-medium">
                                Rayat met en oeuvre des mesures techniques et organisationnelles raisonnables : mots de passe chiffrés, jetons de réinitialisation à usage unique, contrôle des accès, limitation des tentatives, journalisation et séparation des rôles administratifs. Aucun système n'étant infaillible, les utilisateurs doivent également protéger leurs identifiants et leurs équipements.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">8. Cookies</h3>
                            <p class="mb-8 font-medium">
                                Rayat utilise principalement des cookies et stockages locaux techniques pour la session, la langue, les préférences d'interface, certaines données temporaires et la sécurité. Les cookies non essentiels, lorsqu'ils sont utilisés, doivent faire l'objet d'une information adaptée et, si nécessaire, d'un consentement préalable.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">9. Contact</h3>
                            <p class="mb-8 font-medium">
                                Pour toute question relative à cette politique, à vos données ou à l'exercice de vos droits, vous pouvez écrire à <strong>privacy@rayat.ma</strong> ou nous contacter depuis la page de contact Rayat.
                            </p>

                            <div class="mt-12 p-8 bg-slate-900 text-white rounded-2xl text-center">
                                <p class="text-sm uppercase tracking-widest font-black opacity-60 mb-2">Dernière mise a jour</p>
                                <p class="text-xl font-bold">28 mars 2026 - Casablanca, Maroc</p>
                            </div>
                        </div>

                        <div class="mt-12 text-center">
                            <button onclick="setView('home')" class="bg-green-700 text-white px-10 py-4 rounded-2xl font-black uppercase tracking-tighter hover:bg-green-800 transition shadow-xl">
                                ← Retour à l'accueil
                            </button>
                        </div>
                    </div>
                </section>
                ${renderFooter()}
            `;
        }

        function renderTermsPage() {
            return `
                ${renderHeader(!!user)}
                <section class="py-24 bg-gray-50 min-h-screen">
                    <div class="container mx-auto px-4 max-w-4xl">
                        <div class="text-center mb-16">
                            <h2 class="text-5xl font-black text-slate-900 tracking-tighter uppercase mb-4">${t('termsOfService')}</h2>
                            <p class="text-xl font-bold text-green-700 uppercase tracking-widest">Rayat Smart Monitoring - Conditions SaaS</p>
                        </div>

                        <div class="bg-white rounded-[3rem] shadow-2xl p-10 md:p-16 border border-gray-100 text-gray-700 leading-relaxed">
                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">1. Objet du service</h3>
                            <p class="mb-8 font-medium">
                                Rayat fournit une plateforme SaaS de collecte, visualisation et aide a la decision pour les exploitations agricoles. Le service agrège des données issues de capteurs, d'équipements connectés et de saisies utilisateur afin de faciliter le pilotage des cultures, de l'irrigation, de l'énergie et du climat.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">2. Outil d'aide a la decision</h3>
                            <p class="mb-8 font-medium">
                                Rayat est un outil d'aide a la decision. Il ne remplace ni l'expertise agronomique, ni les contrôles terrain, ni les arbitrages humains. Aucune fonctionnalité, recommandation, estimation ou alerte ne constitue une garantie de rendement, d'économie, de resultat ou d'absence de perte.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">3. Responsabilité de l'utilisateur</h3>
                            <p class="mb-8 font-medium">
                                L'utilisateur demeure seul responsable des décisions prises pour son exploitation, notamment en matière d'irrigation, de fertilisation, de lutte phytosanitaire, de maintenance des équipements, de sécurité et d'investissement. Il lui appartient de vérifier la pertinence des informations avant toute action.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">4. Disponibilité du service</h3>
                            <p class="mb-8 font-medium">
                                Rayat s'efforce d'assurer une disponibilité raisonnable de la plateforme, sans garantie d'accès continu ou sans interruption. Des ralentissements, maintenances, défaillances réseau, incidents tiers, indisponibilités cloud ou contraintes locales peuvent affecter l'accès aux données et aux alertes.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">5. Matériel et connectivité</h3>
                            <p class="mb-8 font-medium">
                                Le bon fonctionnement du service dépend aussi du matériel, des capteurs, de l'alimentation électrique, de la couverture réseau, du paramétrage et de la qualité des installations. Rayat ne peut être tenu responsable des pannes, défauts de calibration, coupures ou erreurs provenant d'équipements tiers ou d'une mauvaise installation.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">6. Abonnement</h3>
                            <p class="mb-8 font-medium">
                                L'accès au service peut être soumis a un abonnement récurrent ou a une offre contractuelle spécifique. Les modalités applicables, y compris la durée, le renouvellement, les options et les éventuelles limitations, sont précisées dans l'offre commerciale ou le contrat sans qu'aucun prix ne soit figé dans les présentes conditions.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">7. Données et propriété</h3>
                            <p class="mb-8 font-medium">
                                L'utilisateur reste propriétaire des données qu'il fournit ou génère via ses équipements. Rayat dispose des droits strictement nécessaires pour héberger, traiter, sauvegarder et restituer ces données dans le cadre du service. Rayat peut utiliser des données agrégées et anonymisées a des fins d'analyse, d'amélioration produit, de recherche et de statistiques.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">8. Limitation de responsabilité</h3>
                            <p class="mb-8 font-medium">
                                Dans les limites permises par la loi applicable, Rayat ne saurait être responsable des pertes de récolte, pertes d'exploitation, pertes de revenus, dommages indirects, décisions agronomiques inadaptées, indisponibilités, ni des conséquences liées a des données incomplètes, tardives ou erronées.
                            </p>

                            <h3 class="text-2xl font-black text-slate-900 mb-6 uppercase border-b-4 border-green-500 inline-block pb-2">9. Droit applicable</h3>
                            <p class="mb-8 font-medium">
                                Les présentes conditions sont régies par le droit marocain. Sauf disposition impérative contraire, tout différend relatif a l'utilisation du service relève de la compétence des juridictions marocaines territorialement compétentes.
                            </p>

                            <div class="mt-12 p-8 bg-slate-900 text-white rounded-2xl text-center">
                                <p class="text-sm uppercase tracking-widest font-black opacity-60 mb-2">Version en vigueur</p>
                                <p class="text-xl font-bold">28 mars 2026 - Casablanca, Maroc</p>
                            </div>
                        </div>

                        <div class="mt-12 text-center">
                            <button onclick="setView('home')" class="bg-green-700 text-white px-10 py-4 rounded-2xl font-black uppercase tracking-tighter hover:bg-green-800 transition shadow-xl">
                                ← Retour a l'accueil
                            </button>
                        </div>
                    </div>
                </section>
                ${renderFooter()}
            `;
        }

        function renderFooter() {
            const primaryFooterLinks = [
                { view: 'home', label: t('home') },
                { view: 'chi-siamo', label: t('aboutUs') },
                { view: 'servizi', label: t('services') },
                { view: 'demo', label: t('demo'), tracked: true },
                { view: 'contatti', label: t('contactTitle'), tracked: true }
            ];

            return `
                <footer class="bg-black text-white py-16 text-center safe-area-bottom">
                    <div class="container mx-auto px-4">
                        <div class="flex justify-center items-center space-x-3 mb-6">
                            <img src="${BRAND_LOGO_WHITE}" alt="Rayat Logo"
                                 class="h-14 w-auto" />
                            <h2 class="text-4xl font-black tracking-tighter text-white">RAYAT</h2>
                        </div>
                        <nav class="rayat-footer-primary-nav">
                            ${primaryFooterLinks.map((link, index) => `
                                <button onclick="${link.tracked ? `setViewWithTracking('${link.view}')` : `setView('${link.view}')`}" class="rayat-footer-primary-link">
                                    ${link.label}
                                </button>
                                ${index < primaryFooterLinks.length - 1 ? '<span class="rayat-footer-divider" aria-hidden="true">|</span>' : ''}
                            `).join('')}
                        </nav>
                        <nav class="rayat-footer-legal-nav">
                            <a href="#" onclick="trackNavigationEvent('contatti'); setView('contatti')" class="hover:text-orange-500 transition uppercase">${t('contactTitle')}</a>
                            <a href="#" onclick="setView('privacy')" class="hover:text-orange-500 transition">${t('privacyPolicy') || 'Privacy Policy'}</a>
                            <a href="#" onclick="setView('terms')" class="hover:text-orange-500 transition">${t('termsOfService') || 'Terms of Service'}</a>
                        </nav>
                        <div class="max-w-md mx-auto h-px bg-white/10 mb-8"></div>
                        <p class="text-gray-500 text-[10px] font-black uppercase tracking-[0.3em]">${t('footerRights')}</p>
                    </div>
                </footer>`;
        }


        function renderLegacyDemoPage() {
            const currentSensorKey = normalizeDashboardSensorKey(selectedSensor) || resolveFreshestSensorKey(selectedSensor); // RAYAT-FIX
            const current = sensorData[currentSensorKey] || sensorData.terreno; // RAYAT-FIX

            // RAYAT FIX - demo section refresh cleanup and repositioning
            const renderMonitoringRefreshControl = (variant = 'toolbar') => `
                <button
                    type="button"
                    onclick="refreshData()"
                    class="${variant === 'section' ? 'rayat-section-refresh-button' : 'rayat-header-refresh-button'} ${isRefreshingData ? 'is-loading' : ''}"
                    aria-label="${escapeHtml(isRefreshingData ? t('refreshingDataAction') : t('refreshDataAction'))}"
                    title="${escapeHtml(isRefreshingData ? t('refreshingDataAction') : t('refreshDataAction'))}"
                    aria-busy="${isRefreshingData}"
                    ${isRefreshingData ? 'disabled' : ''}
                >
                    <span class="${variant === 'section' ? 'rayat-section-refresh-button__icon' : 'rayat-header-refresh-button__icon'}" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                            <path d="M21 3v6h-6"></path>
                        </svg>
                    </span>
                </button>
            `;

            // RAYAT FIX - demo section refresh cleanup and repositioning
            const renderMonitoringHeaderBlock = () => `
                <div class="rayat-monitoring-toolbar rayat-monitoring-toolbar--demo-only">
                    <div class="rayat-monitoring-toolbar__copy">
                        <h2 class="rayat-monitoring-toolbar__title">${user ? t('dashboardBtn') : t('demoDashboard')}</h2>
                        <p class="rayat-monitoring-toolbar__subtitle">${t('demoDesc')}</p>
                    </div>
                </div>
            `;

            // RAYAT FIX - demo section refresh cleanup and repositioning
            const renderDemoSectionHeading = (sensorKey, title) => {
                const statusMeta = getDemoSectionStatusMeta(sensorKey);
                const statusSummary = `${statusMeta.label} · ${statusMeta.timestamp}`;
                return `
                <div class="rayat-demo-section-heading">
                    <div class="rayat-demo-section-heading__row">
                        <h4 class="rayat-demo-section-heading__title">${escapeHtml(title)}</h4>
                        <div class="rayat-demo-section-heading__meta">
                            <span
                                class="rayat-demo-section-heading__badge ${statusMeta.className}"
                                aria-label="${escapeHtml(statusSummary)}"
                                title="${escapeHtml(statusSummary)}"
                            >
                                <span class="rayat-demo-section-heading__status ${statusMeta.className}" aria-hidden="true"></span>
                                <span class="rayat-demo-section-heading__badge-text">${escapeHtml(statusMeta.label)}</span>
                                <span class="rayat-demo-section-heading__separator" aria-hidden="true">&middot;</span>
                                <span class="rayat-demo-section-heading__timestamp">${escapeHtml(statusMeta.timestamp)}</span>
                            </span>
                            ${renderMonitoringRefreshControl('section')}
                        </div>
                    </div>
                </div>
            `;
            };

            const render7in1 = () => {
                return `
                ${renderDemoSectionHeading('terreno', t('sensorSoName'))}
                <div class="mb-8">
                    ${renderCropSelector()}
                </div>
                ${renderSensorMetricGrid('terreno', 'soil', 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 mb-12')}
                ${renderActiveAlertFeed('terreno')}`;
            };

            const renderClimate = () => {
                return `
                ${renderDemoSectionHeading('clima', t('sensorClName'))}
                <div class="mb-8">
                    ${renderCropSelector()}
                </div>
                ${renderSensorMetricGrid('clima', 'climate', 'grid grid-cols-1 md:grid-cols-2 gap-6 mb-12')}
                ${renderActiveAlertFeed('clima')}`;
            };

            const renderWater = () => {
                let numDays = 1;
                if (filterState.period === '7d') numDays = 7;
                else if (filterState.period === '30d') numDays = 30;
                else if (filterState.period === 'custom' && filterState.customStart && filterState.customEnd) {
                    numDays = Math.ceil(Math.abs(filterState.customEnd - filterState.customStart) / (86400000)) || 1;
                }
                const req = (waterSettings.hectares || 0) * getCropConsumptionValue() * numDays;
                const currentWaterLevel = parseNumericValue(current.valore);
                const avail = Number.isFinite(currentWaterLevel) ? currentWaterLevel * 1000 : 0;
                const isShortage = avail < req;

                return `
                ${renderDemoSectionHeading('acqua', t('sensorWaName'))}
                <div class="rayat-water-compact mb-12">
                    <div>
                        <label class="block text-xs font-black text-blue-600 uppercase mb-4 tracking-tighter">${t('hectaresLabel')}</label>
                        <div class="rayat-water-hectares">
                            <button type="button" onclick="adjustWaterHectares(-0.5)" class="rayat-water-stepper">−</button>
                            <div class="rayat-water-hectares-input">
                                <input type="number" min="0.1" step="0.1" value="${waterSettings.hectares}" oninput="updateWaterSettings(this.value, 'hectares')" class="w-full bg-transparent font-black text-3xl text-gray-800 outline-none text-center">
                                <span class="text-sm font-black text-slate-400 uppercase">${t('ha')}</span>
                            </div>
                            <button type="button" onclick="adjustWaterHectares(0.5)" class="rayat-water-stepper">+</button>
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs font-black text-blue-600 uppercase mb-4 tracking-tighter">${t('cropLabel')}</label>
                        <select onchange="updateWaterSettings(this.value, 'crop')" class="w-full bg-white border-2 border-gray-100 rounded-3xl px-5 py-4 font-black text-xl text-gray-800 outline-none focus:border-blue-500 transition-all appearance-none cursor-pointer">
                            ${CROP_OPTIONS.map((option) => `
                                <option value="${option.value}" ${userCropSelection.value === option.value ? 'selected' : ''}>
                                    ${t(option.labelKey)}
                                </option>
                            `).join('')}
                        </select>
                        ${userCropSelection.value === 'autre' ? `
                            <input
                                type="text"
                                value="${escapeHtml(userCropSelection.custom)}"
                                onchange="setUserCustomCrop(this.value)"
                                class="w-full mt-3 px-4 py-3 border border-gray-200 rounded-2xl"
                                placeholder="${escapeHtml(t('cropCustomPlaceholder'))}"
                            >
                        ` : ''}
                    </div>
                </div>
                <div class="bg-white rounded-[4rem] border-[12px] ${isShortage ? 'border-red-500' : 'border-green-500'} p-8 md:p-12 shadow-2xl transition-all overflow-hidden">
                    <div class="flex flex-col lg:flex-row items-center justify-between gap-8 w-full">
                        <div class="flex flex-col sm:flex-row gap-8 md:gap-16 flex-grow justify-start w-full">
                            <div class="text-left">
                                <div class="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] mb-2">${t('need')} (${getSelectedCropLabel()})</div>
                                <div class="text-4xl md:text-5xl font-black text-gray-800 tracking-tighter leading-none">${req.toLocaleString()} <span class="text-lg text-gray-300 uppercase font-bold">${t('ton')}</span></div>
                                <div class="text-[9px] font-bold text-blue-500 uppercase tracking-widest mt-2">${numDays} GIORNI</div>
                            </div>
                            <div class="text-left">
                                <div class="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] mb-2">${t('available')}</div>
                                <div class="text-4xl md:text-5xl font-black ${isShortage ? 'text-red-600' : 'text-green-600'} tracking-tighter leading-none">${avail.toLocaleString()} <span class="text-lg opacity-30 uppercase font-bold">${t('ton')}</span></div>
                            </div>
                        </div>
                        <div class="px-6 py-4 md:px-10 rounded-[2rem] ${isShortage ? 'bg-red-600 animate-pulse' : 'bg-green-600'} text-white text-center shadow-xl min-w-[200px] transform hover:scale-105 transition-transform">
                            <div class="text-2xl md:text-3xl font-black uppercase tracking-tighter mb-1">${isShortage ? t('statusAlert') : t('statusOk')}</div>
                            <div class="text-[8px] md:text-[10px] font-black opacity-80 uppercase tracking-widest leading-tight">${isShortage ? t('msgShortage') : t('msgOk')}</div>
                        </div>
                    </div>
                </div>
                ${renderActiveAlertFeed('acqua')}`;
            };

            return `
                ${renderHeader(!!user)}
            <section class="rayat-demo-page py-24 bg-gray-50 min-h-screen">
                <div class="rayat-demo-shell container mx-auto px-4 max-w-[1300px]">
                    ${renderSubscriptionWarningBanner()}
                    ${renderMonitoringHeaderBlock()}
                    <div class="rayat-demo-nav-grid grid grid-cols-2 lg:grid-cols-4 gap-8 mb-16">
                        ${Object.keys(sensorData).map(key => {
                const isSel = selectedSensor === key;
                return `<button onclick="openSensorDashboard('${key}', { tracked: false })" class="p-10 rounded-[3rem] transition-all duration-700 transform hover:scale-110 ${isSel ? 'bg-green-700 text-white shadow-[0_35px_60px_-15px_rgba(21,128,61,0.3)] scale-110 z-10' : 'bg-white text-gray-800 shadow-2xl hover:bg-green-50'}">
                                    <div class="text-7xl mb-6">${sensorData[key].icon}</div>
                                    <div class="text-2xl font-black uppercase tracking-tighter">${t(sensorData[key].nome)}</div>
                                </button>`;
            }).join('')}
                    </div>
                    <div class="rayat-demo-panel bg-white rounded-[4rem] shadow-[-20px_40px_100px_rgba(0,0,0,0.1)] p-12 md:p-20 border border-gray-50 relative overflow-hidden">
                        <div class="absolute top-0 right-0 w-64 h-64 bg-green-50 rounded-full -mr-32 -mt-32 opacity-50"></div>
                        ${/* Demo Mode: Error overlay removed */ ''}
                        <div class="relative z-10">
                            ${selectedSensor === 'acqua' ? renderWater() : (selectedSensor === 'terreno' ? render7in1() : (selectedSensor === 'clima' ? renderClimate() : `
                                    ${renderDemoSectionHeading(currentSensorKey, t(current.nome))}
                                    <div class="flex flex-col md:flex-row items-center justify-between mb-16">
                                    <div class="flex items-center justify-center">
                                            <div class="text-[10rem] transform -rotate-12 transition-transform hover:rotate-0 duration-700">${current.icon}</div>
                                        </div>
                                        <div class="text-center md:text-right mt-12 md:mt-0">
                                            <div class="text-[10rem] md:text-[12rem] font-black text-slate-900 tracking-tighter leading-none">${formatMetricValue(current.valore)}<span class="text-4xl text-slate-300 ml-4 uppercase font-black">${current.unita}</span></div>
                                        </div>
                                    </div>
                                    ${renderActiveAlertFeed('energia')}
                                `))}
                        </div>
                    </div>

                    <!-- Advanced History Control Bar -->
                    <div class="mt-20 w-full mx-auto">
                        <div class="flex flex-nowrap items-center bg-white p-4 rounded-[2rem] shadow-2xl border border-gray-100 gap-4 mb-10 overflow-x-auto no-scrollbar">
                            <!-- Period Filters -->
                            <div class="flex bg-gray-50 p-1.5 rounded-2xl shrink-0">
                                ${['24h', '7d', '30d'].map(period => `
                                        <button onclick="setFilterPeriod('${period}')" class="px-5 py-2.5 rounded-xl font-bold uppercase tracking-tight text-[11px] whitespace-nowrap transition-all ${filterState.period === period ? 'bg-[#1e293b] text-white shadow-lg' : 'text-gray-400 hover:text-gray-900'}">
                                            ${t('last' + period)}
                                        </button>`).join('')}
                            </div>

                            <!-- Date Range -->
                            <div class="flex items-center gap-2 bg-gray-50 p-2 rounded-2xl border border-gray-100 shrink-0">
                                <input type="date" id="startDate" class="bg-transparent font-black text-[11px] uppercase p-1.5 outline-none text-gray-700 cursor-pointer" value="${filterState.customStart ? filterState.customStart.toISOString().split('T')[0] : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}">
                                    <span class="text-gray-300 font-bold">~</span>
                                    <input type="date" id="endDate" class="bg-transparent font-black text-[11px] uppercase p-1.5 outline-none text-gray-700 cursor-pointer" value="${filterState.customEnd ? filterState.customEnd.toISOString().split('T')[0] : new Date().toISOString().split('T')[0]}">
                                    </div>

                                    <!-- Search Button -->
                                    <button onclick="setCustomFilter()" class="bg-[#3b82f6] hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-bold uppercase tracking-tight text-[11px] shadow-lg transition-all shrink-0 flex items-center gap-2">🔍 <span>${t('search')}</span></button>

                                    <!-- Export Button -->
                                    ${(!isAuthenticated() || !isCustomerRole(currentRole) || hasCustomerPermission('export_csv')) ? `<button onclick="exportCSV()" class="bg-[#10b981] hover:bg-green-700 text-white px-6 py-3 rounded-xl font-bold uppercase tracking-tight text-[11px] shadow-xl transition-all shrink-0 flex items-center gap-2">📥 <span>${t('export')}</span></button>` : ''}
                            </div>

                            <!-- Dynamic History Table -->
                            <div class="rayat-history-card bg-white rounded-[4rem] p-12 shadow-2xl border border-gray-50 overflow-hidden">
                                <div class="rayat-history-table-wrap overflow-x-auto">
                                    <table class="rayat-history-table w-full text-left">
                                        <thead>
                                            <tr class="border-b-8 border-gray-50">
                                                ${(() => {
                    const cols = {
                        energia: [t('time'), '⚡ ' + t('sensorEnName') + ' (kW)', t('status')],
                        acqua: [t('time'), '💧 ' + t('available') + ' (' + t('ton') + ')', '📉 ' + t('need') + ' (' + t('ton') + ')', t('status')],
                        terreno: [t('time'), '🌡️ ' + t('tempShort'), '💧 ' + t('humidityShort'), '⚡ EC', '🌿 N', '🌿 P', '🌿 K', '🧪 pH', t('status')],
                        clima: [t('time'), '🌡️ ' + t('tempShort'), '💧 ' + t('humidityShort'), '💨 CO2', '🌬️ ' + t('windSpeed'), t('status')],
                    };
                    return (cols[selectedSensor] || []).map(h => `<th class="rayat-history-head-cell ${h.includes('⚡') || h.includes('💧') || h.includes('🌡️') || h.includes('💨') || h.includes('🌬️') ? 'rayat-history-head-cell--metric' : ''}">${h}</th>`).join('');
                })()}
                                            </tr>
                                        </thead>
                                        <tbody class="divide-y divide-gray-50">
                                            ${(() => {
                    const historyRows = getFilteredHistory();
                    const emptyColspan = selectedSensor === 'terreno'
                        ? 9
                        : (selectedSensor === 'clima' ? 6 : (selectedSensor === 'energia' ? 3 : 4));
                    if (!historyRows.length) {
                        return `
                            <tr class="rayat-history-row">
                                <td colspan="${emptyColspan}" class="py-10 text-center text-sm font-semibold text-slate-400">
                                    ${historyState.loading ? 'Caricamento storico in corso...' : 'Nessun dato storico disponibile per il periodo selezionato.'}
                                </td>
                            </tr>
                        `;
                    }
                    return historyRows.map(row => {
                    const s = selectedSensor;
                    let cells = '';
                    const timeCell = `
                        <td class="rayat-history-time-cell">
                            <div class="rayat-history-time-primary">${formatLocalizedDate(row.date)}</div>
                            <div class="rayat-history-time-secondary">${formatLocalizedTime(row.date)}</div>
                        </td>`;

                    if (s === 'energia') {
                        const energyLevel = getMetricState(parseNumericValue(row.energia), { min: 12.2, max: 13.8, unit: 'V' }).level;
                        cells = `
                                                        ${timeCell}
                                                        <td class="rayat-history-value-cell rayat-history-value-cell--lg ${getLevelClass(energyLevel)}">${formatHistoryNumber(row.energia)}</td>
                                                        ${renderHistoryStatusCell(energyLevel)}
                                                    `;
                    } else if (s === 'acqua') {
                        const currentHectares = parseFloat(waterSettings.hectares) || 0;
                        const consumptionPerHa = getCropConsumptionValue();
                        const req = currentHectares * consumptionPerHa;
                        const waterValue = parseNumericValue(row.acqua);
                        const avail = Number.isFinite(waterValue) ? waterValue * 1000 : null;
                        const waterLevel = avail < (req * 0.7) ? 'alert' : (avail < req ? 'attention' : 'normal');
                        cells = `
                                                        ${timeCell}
                                                        <td class="rayat-history-value-cell rayat-history-value-cell--lg text-blue-700">${Number.isFinite(avail) ? avail.toLocaleString() : '--'}</td>
                                                        <td class="rayat-history-value-cell rayat-history-value-cell--md text-blue-900">${req.toLocaleString()}</td>
                                                        ${renderHistoryStatusCell(waterLevel, t('statusOk'))}
                                                    `;
                    } else if (s === 'terreno') {
                        const soilLevels = [
                            getMetricLevel('soil', 'temperature', row.temperature),
                            getMetricLevel('soil', 'moisture', row.terreno),
                            getMetricLevel('soil', 'ec', row.ec),
                            getMetricLevel('soil', 'nitrogen', row.nitrogen),
                            getMetricLevel('soil', 'phosphorus', row.phosphorus),
                            getMetricLevel('soil', 'potassium', row.potassium),
                            getMetricLevel('soil', 'pH', row.pH)
                        ];
                        cells = `
                                                        ${timeCell}
                                                        <td class="rayat-history-value-cell ${getLevelClass(soilLevels[0])}">${formatHistoryNumber(row.temperature, { group: 'soil', key: 'temperature' })}</td>
                                                        <td class="rayat-history-value-cell ${getLevelClass(soilLevels[1])}">${formatHistoryNumber(row.terreno, { group: 'soil', key: 'moisture' })}</td>
                                                        <td class="rayat-history-value-cell ${getLevelClass(soilLevels[2])}">${formatHistoryNumber(row.ec, { group: 'soil', key: 'ec' })}</td>
                                                        <td class="rayat-history-value-cell ${getLevelClass(soilLevels[3])}">${formatHistoryNumber(row.nitrogen, { group: 'soil', key: 'nitrogen' })}</td>
                                                        <td class="rayat-history-value-cell ${getLevelClass(soilLevels[4])}">${formatHistoryNumber(row.phosphorus, { group: 'soil', key: 'phosphorus' })}</td>
                                                        <td class="rayat-history-value-cell ${getLevelClass(soilLevels[5])}">${formatHistoryNumber(row.potassium, { group: 'soil', key: 'potassium' })}</td>
                                                        <td class="rayat-history-value-cell ${getLevelClass(soilLevels[6])}">${formatHistoryNumber(row.pH, { group: 'soil', key: 'pH' })}</td>
                                                        ${renderHistoryStatusCell(getOverallLevel(soilLevels))}
                                                    `;
                    } else if (s === 'clima') {
                        const climateLevels = [
                            getMetricLevel('climate', 'temperature', row.climaTemp),
                            getMetricLevel('climate', 'humidity', row.humidity),
                            getMetricLevel('climate', 'co2', row.co2),
                            getMetricLevel('climate', 'windSpeed', row.windSpeed)
                        ];
                        cells = `
                                                        ${timeCell}
                                                        <td class="rayat-history-value-cell rayat-history-value-cell--lg ${getLevelClass(climateLevels[0])}">${formatHistoryNumber(row.climaTemp, { group: 'climate', key: 'temperature' })}</td>
                                                        <td class="rayat-history-value-cell rayat-history-value-cell--lg ${getLevelClass(climateLevels[1])}">${formatHistoryNumber(row.humidity, { group: 'climate', key: 'humidity' })}</td>
                                                        <td class="rayat-history-value-cell rayat-history-value-cell--lg ${getLevelClass(climateLevels[2])}">${formatHistoryNumber(row.co2, { group: 'climate', key: 'co2' })}</td>
                                                        <td class="rayat-history-value-cell rayat-history-value-cell--lg ${getLevelClass(climateLevels[3])}">${formatHistoryNumber(row.windSpeed, { group: 'climate', key: 'windSpeed' })}</td>
                                                        ${renderHistoryStatusCell(getOverallLevel(climateLevels))}
                                                    `;
                    }
                    return `<tr class="rayat-history-row hover:bg-gray-50 transition duration-300">${cells}</tr>`;
                }).join('');
                })()}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
            </section>
                ${renderFooter()}
            `;
        }

        let luxuryDashboardMap = null;
        let isLuxuryDashboardSidebarOpen = false;

        function toggleLuxuryDashboardProfileMenu(forceState, event) {
            event?.stopPropagation?.();
            isLuxuryDashboardProfileMenuOpen = typeof forceState === 'boolean'
                ? forceState
                : !isLuxuryDashboardProfileMenuOpen;

            document.querySelector('.rayat-luxury-dashboard-profile-dropdown')?.classList.toggle('is-open', isLuxuryDashboardProfileMenuOpen);
            document.querySelector('.rayat-luxury-dashboard-profile')?.setAttribute('aria-expanded', String(isLuxuryDashboardProfileMenuOpen));
        }

        function closeLuxuryDashboardProfileMenu() {
            toggleLuxuryDashboardProfileMenu(false);
        }

        function toggleLuxuryDashboardSidebar(forceState) {
            isLuxuryDashboardSidebarOpen = typeof forceState === 'boolean'
                ? forceState
                : !isLuxuryDashboardSidebarOpen;

            document.querySelector('.rayat-luxury-dashboard-sidebar')?.classList.toggle('is-open', isLuxuryDashboardSidebarOpen);
            document.querySelector('.rayat-luxury-dashboard-sidebar-backdrop')?.classList.toggle('is-open', isLuxuryDashboardSidebarOpen);
            document.querySelector('.rayat-luxury-dashboard-mobile-toggle')?.setAttribute('aria-expanded', String(isLuxuryDashboardSidebarOpen));
            syncPageScrollLock();
        }

        function scrollLuxuryDashboardSection(sectionId) {
            const target = document.getElementById(sectionId);
            if (!target) {
                return;
            }

            document.querySelectorAll('.rayat-luxury-dashboard-nav button').forEach((button) => {
                button.classList.toggle('is-active', button.dataset.dashboardTarget === sectionId);
            });

            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (window.matchMedia?.('(max-width: 900px)').matches) {
                toggleLuxuryDashboardSidebar(false);
            }
        }

        function getLuxuryDashboardIcon(name) {
            const icons = {
                dashboard: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"></path>',
                greenhouse: '<path d="M4 20h16M6 20V9l6-5 6 5v11M12 4v16M6 10h12"></path>',
                sensors: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5"></path><circle cx="12" cy="12" r="4"></circle>',
                irrigation: '<path d="M12 3S6 10.2 6 14a6 6 0 0 0 12 0c0-3.8-6-11-6-11z"></path>',
                alert: '<path d="M12 3 2.5 20h19L12 3z"></path><path d="M12 9v5M12 17h.01"></path>',
                analytics: '<path d="M4 19h16M5 16l5-6 4 3 5-8"></path>',
                report: '<path d="M7 3h7l4 4v14H7zM14 3v5h5M10 12h5M10 16h5"></path>',
                history: '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5M12 7v6l4 2"></path>',
                settings: '<circle cx="12" cy="12" r="3"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8"></path>',
                support: '<path d="M4 13v-2a8 8 0 0 1 16 0v2M4 13h4v6H6a2 2 0 0 1-2-2zM20 13h-4v6h2a2 2 0 0 0 2-2zM16 19c0 1.1-1.8 2-4 2"></path>',
                leaf: '<path d="M20 4C11 4 5 9 5 16c0 2 1 4 3 4 8 0 12-7 12-16zM5 19c3-4 7-7 12-10"></path>',
                wifi: '<path d="M4 9a12 12 0 0 1 16 0M7 13a7.5 7.5 0 0 1 10 0M10 17a3.2 3.2 0 0 1 4 0"></path><circle cx="12" cy="20" r=".6"></circle>',
                drop: '<path d="M12 3S6 10.2 6 14a6 6 0 0 0 12 0c0-3.8-6-11-6-11z"></path>',
                thermometer: '<path d="M10 14.8V5a2 2 0 0 1 4 0v9.8a4.5 4.5 0 1 1-4 0zM12 8v9"></path>',
                bolt: '<path d="M13 2 5 13h7l-1 9 8-12h-7z"></path>',
                flask: '<path d="M9 3h6M10 3v7l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M8 15h8"></path>',
                nutrient: '<path d="M12 21V4M12 9 7 6M12 12l6-4M12 16l-6-3"></path>',
                weather: '<path d="M7 18a4 4 0 1 1 1-7.9A5.6 5.6 0 0 1 19 12a3 3 0 0 1-1 6zM13 3v3M5 7 3 5M19 7l2-2"></path>',
                download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"></path>',
                refresh: '<path d="M20 11a8 8 0 1 0-2.2 5.5"></path><path d="M20 4v7h-7"></path>',
                pin: '<path d="M12 21s7-6.2 7-12A7 7 0 1 0 5 9c0 5.8 7 12 7 12z"></path><circle cx="12" cy="9" r="2"></circle>',
                calendar: '<path d="M7 3v4M17 3v4M4 8h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1z"></path>',
                clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v6l4 2"></path>',
                bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path>',
                question: '<circle cx="12" cy="12" r="9"></circle><path d="M9.8 9a2.4 2.4 0 0 1 4.4 1.4c0 1.8-2.2 2-2.2 3.6M12 17h.01"></path>',
                expand: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6"></path>',
                shield: '<path d="M12 3 20 6v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6z"></path><path d="m9 12 2 2 4-5"></path>',
                sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>',
                wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16M3 16h10a3 3 0 1 1-3 3"></path>'
            };
            return `<svg class="rayat-luxury-dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.sensors}</svg>`;
        }

        function getLuxuryDashboardHistoryValue(key) {
            const historyFieldByKey = {
                moisture: 'terreno',
                temperature: 'temperature',
                ec: 'ec',
                pH: 'pH',
                nitrogen: 'nitrogen',
                phosphorus: 'phosphorus',
                potassium: 'potassium'
            };
            const field = historyFieldByKey[key];
            if (!field) {
                return null;
            }

            const latestRow = [...globalHistory].reverse().find((row) => Number.isFinite(parseNumericValue(row?.[field])));
            return latestRow ? latestRow[field] : null;
        }

        const RAYAT_LUXURY_DASHBOARD_DEMO_FALLBACK = {
            soil: {
                moisture: 65.4,
                temperature: 20.1,
                ec: 2.18,
                pH: 6.23,
                nitrogen: 164,
                phosphorus: 36.1,
                potassium: 283
            },
            climate: {
                temperature: 26,
                humidity: 54,
                windSpeed: 12
            }
        };

        function getLuxuryDashboardSoilMetrics() {
            return (sensorData.terreno?.details || []).map((metric) => {
                let value = normalizeMetricValue('soil', metric.key, metric.value);
                let usesFallback = false;
                if (!Number.isFinite(value)) {
                    value = normalizeMetricValue('soil', metric.key, getLuxuryDashboardHistoryValue(metric.key));
                }
                if (!Number.isFinite(value) && Object.prototype.hasOwnProperty.call(RAYAT_LUXURY_DASHBOARD_DEMO_FALLBACK.soil, metric.key)) {
                    value = RAYAT_LUXURY_DASHBOARD_DEMO_FALLBACK.soil[metric.key];
                    usesFallback = true;
                }
                const available = Number.isFinite(value);
                const range = getRangeForMetric('soil', metric.key);
                const state = available
                    ? getMetricState(value, range)
                    : { level: 'unavailable', label: t('luxuryDashUnavailableStatus') };

                return {
                    ...metric,
                    value,
                    available,
                    usesFallback,
                    range,
                    state,
                    unit: getMetricUnit('soil', metric.key, metric.unit || '')
                };
            });
        }

        function getLuxuryDashboardClimateMetrics() {
            const historyFields = {
                temperature: 'climaTemp',
                humidity: 'humidity',
                co2: 'co2',
                windSpeed: 'windSpeed'
            };

            return (sensorData.clima?.details || []).map((metric) => {
                let value = normalizeMetricValue('climate', metric.key, metric.value);
                let usesFallback = false;
                if (!Number.isFinite(value)) {
                    const field = historyFields[metric.key];
                    const row = [...globalHistory].reverse().find((item) => Number.isFinite(parseNumericValue(item?.[field])));
                    value = normalizeMetricValue('climate', metric.key, row?.[field]);
                }
                if (!Number.isFinite(value) && Object.prototype.hasOwnProperty.call(RAYAT_LUXURY_DASHBOARD_DEMO_FALLBACK.climate, metric.key)) {
                    value = RAYAT_LUXURY_DASHBOARD_DEMO_FALLBACK.climate[metric.key];
                    usesFallback = true;
                }
                return {
                    ...metric,
                    value,
                    available: Number.isFinite(value),
                    usesFallback,
                    unit: getMetricUnit('climate', metric.key, metric.unit || '')
                };
            });
        }

        function getLuxuryDashboardHealthIndex(metrics) {
            const availableMetrics = metrics.filter((metric) => metric.available);
            if (!availableMetrics.length) {
                return null;
            }

            const score = availableMetrics.reduce((total, metric) => {
                if (metric.state.level === 'alert') return total + 35;
                if (metric.state.level === 'attention') return total + 68;
                return total + 100;
            }, 0);

            return Math.round(score / availableMetrics.length);
        }

        function getLuxuryDashboardStatusClass(level) {
            return level === 'alert'
                ? 'is-alert'
                : (level === 'attention' ? 'is-attention' : (level === 'unavailable' ? 'is-unavailable' : 'is-normal'));
        }

        function getLuxuryDashboardMetric(metrics, key) {
            return metrics.find((metric) => metric.key === key) || {
                key,
                value: null,
                available: false,
                state: { level: 'unavailable', label: t('luxuryDashUnavailableStatus') },
                unit: ''
            };
        }

        function renderLuxuryDashboardTrendChart() {
            const rows = getFilteredHistory().slice(-32);
            const seriesConfig = [
                { key: 'moisture', field: 'terreno', group: 'soil', label: t('sensorSoF2'), color: '#1f8f3a', unit: '%' },
                { key: 'temperature', field: 'temperature', group: 'soil', label: t('sensorSoF1'), color: '#f97316', unit: '°C' },
                { key: 'ec', field: 'ec', group: 'soil', label: 'EC', color: '#2563eb', unit: 'mS/cm' }
            ];

            const series = seriesConfig.map((config) => {
                const range = getRangeForMetric(config.group, config.key);
                const values = rows
                    .map((row, index) => ({
                        date: row.date,
                        value: normalizeMetricValue(config.group, config.key, row[config.field]),
                        index
                    }))
                    .filter((entry) => Number.isFinite(entry.value));

                return { ...config, range, values };
            }).filter((item) => item.values.length >= 2);

            if (!rows.length || !series.length) {
                return `<div class="rayat-luxury-dashboard-chart-empty">${t('luxuryDashEmptyTrend')}</div>`;
            }

            const width = 640;
            const height = 240;
            const chartLeft = 48;
            const chartRight = 620;
            const chartTop = 26;
            const chartBottom = 184;
            const rowsSpan = Math.max(rows.length - 1, 1);
            const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
            const dateLabels = [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].filter(Boolean);

            const renderSeriesPath = (item) => {
                const values = item.values.map((entry) => entry.value);
                const minValue = Math.min(...values);
                const maxValue = Math.max(...values);
                const rangeMin = Number.isFinite(item.range?.min) ? item.range.min : minValue;
                const rangeMax = Number.isFinite(item.range?.max) ? item.range.max : maxValue;
                const span = rangeMax - rangeMin || (maxValue - minValue) || 1;
                const path = item.values.map((entry, index) => {
                    const percent = clamp(((entry.value - rangeMin) / span) * 100, 0, 100);
                    const x = chartLeft + ((chartRight - chartLeft) * entry.index / rowsSpan);
                    const y = chartBottom - ((percent / 100) * (chartBottom - chartTop));
                    return `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                }).join(' ');

                return `<path d="${path}" class="rayat-luxury-dashboard-chart-line rayat-luxury-dashboard-chart-line--multi" style="--series-color:${item.color}"></path>`;
            };

            return `
                <div class="rayat-luxury-dashboard-chart-wrap">
                    <div class="rayat-luxury-dashboard-chart-legend">
                        ${series.map((item) => `<span><i style="background:${item.color}"></i>${escapeHtml(item.label)} ${item.unit ? `(${escapeHtml(item.unit)})` : ''}</span>`).join('')}
                    </div>
                    <svg class="rayat-luxury-dashboard-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t('luxuryDashTrendTitle'))}">
                        ${[100, 75, 50, 25, 0].map((label) => {
                            const y = chartBottom - ((label / 100) * (chartBottom - chartTop));
                            return `<line x1="${chartLeft}" x2="${chartRight}" y1="${y}" y2="${y}" class="rayat-luxury-dashboard-chart-grid"></line><text x="8" y="${y + 4}" class="rayat-luxury-dashboard-chart-label">${label}</text>`;
                        }).join('')}
                        ${series.map(renderSeriesPath).join('')}
                        ${dateLabels.map((row) => {
                            const x = chartLeft + ((chartRight - chartLeft) * rows.indexOf(row) / rowsSpan);
                            return `<text x="${x}" y="222" text-anchor="middle" class="rayat-luxury-dashboard-chart-date">${escapeHtml(formatLocalizedDate(row.date))}</text>`;
                        }).join('')}
                    </svg>
                </div>
            `;
        }

        function formatHistoryDateInputValue(date) {
            const value = date instanceof Date ? date : new Date(date);
            if (Number.isNaN(value.getTime())) {
                return '';
            }

            return value.toISOString().split('T')[0];
        }

        function buildLuxuryHistoryPreviewRows() {
            const rows = [];
            const now = new Date();
            now.setSeconds(0, 0);
            const totalRows = 2384;

            for (let index = 0; index < totalRows; index += 1) {
                const date = new Date(now.getTime() - (index * 30 * 60 * 1000));
                const wave = Math.sin(index / 8);
                const softWave = Math.cos(index / 17);
                const row = createHistoryRow(date);
                row.climaTemp = 25.8 - Math.min(index, 42) * 0.035 + wave * 0.22;
                row.humidity = 62.4 + Math.min(index, 55) * 0.11 + softWave * 0.35;
                row.co2 = 612 - Math.min(index, 72) * 2.2 + wave * 7;
                row.temperature = 24.6 - Math.min(index, 80) * 0.09 + softWave * 0.18;
                row.terreno = 81.4 + Math.min(index, 70) * 0.18 + wave * 0.8;
                row.ec = 1.82 - Math.min(index, 55) * 0.008 + softWave * 0.018;
                row.nitrogen = 156 - Math.min(index, 80) * 0.9 + wave * 3;
                row.phosphorus = 28.4 - Math.min(index, 62) * 0.18 + softWave * 0.35;
                row.potassium = 312 - Math.min(index, 75) * 1.25 + wave * 8;
                row.pH = 6.43 - Math.min(index, 58) * 0.006 + softWave * 0.015;
                row.status = 'statusNormal';
                row.__preview = true;
                rows.push(row);
            }

            return rows;
        }

        function hasLuxuryHistoryMetricValue(rows, field, group, key) {
            return rows.some((row) => Number.isFinite(normalizeMetricValue(group, key, row?.[field])));
        }

        function isLuxuryHistoryMetricInstalled(metrics, key, rows, field, group) {
            const metric = metrics.find((item) => item.key === key);
            if (metric?.installed === false) {
                return false;
            }

            if (metric) {
                return true;
            }

            return hasLuxuryHistoryMetricValue(rows, field, group, key);
        }

        function getLuxuryHistoryColumns(soilMetrics, climateMetrics, rows) {
            const columns = [
                { id: 'date', label: 'DATE / HEURE', type: 'date' }
            ];

            const addMetricColumn = (enabled, column) => {
                if (enabled) {
                    columns.push(column);
                }
            };

            addMetricColumn(isLuxuryHistoryMetricInstalled(climateMetrics, 'temperature', rows, 'climaTemp', 'climate'), {
                id: 'tempAir',
                label: 'TEMP AIR',
                unit: '(°C)',
                field: 'climaTemp',
                group: 'climate',
                key: 'temperature'
            });
            addMetricColumn(isLuxuryHistoryMetricInstalled(climateMetrics, 'humidity', rows, 'humidity', 'climate'), {
                id: 'humAir',
                label: 'HUM AIR',
                unit: '(%)',
                field: 'humidity',
                group: 'climate',
                key: 'humidity'
            });
            addMetricColumn(isLuxuryHistoryMetricInstalled(climateMetrics, 'co2', rows, 'co2', 'climate'), {
                id: 'co2',
                label: 'CO₂',
                unit: '(ppm)',
                field: 'co2',
                group: 'climate',
                key: 'co2'
            });
            addMetricColumn(isLuxuryHistoryMetricInstalled(soilMetrics, 'temperature', rows, 'temperature', 'soil'), {
                id: 'tempSoil',
                label: 'TEMP SOL',
                unit: '(°C)',
                field: 'temperature',
                group: 'soil',
                key: 'temperature'
            });
            addMetricColumn(isLuxuryHistoryMetricInstalled(soilMetrics, 'moisture', rows, 'terreno', 'soil'), {
                id: 'humSoil',
                label: 'HUM SOL',
                unit: '(%)',
                field: 'terreno',
                group: 'soil',
                key: 'moisture'
            });
            addMetricColumn(isLuxuryHistoryMetricInstalled(soilMetrics, 'ec', rows, 'ec', 'soil'), {
                id: 'ec',
                label: 'EC',
                unit: '(mS/cm)',
                field: 'ec',
                group: 'soil',
                key: 'ec'
            });
            addMetricColumn(isLuxuryHistoryMetricInstalled(soilMetrics, 'nitrogen', rows, 'nitrogen', 'soil'), {
                id: 'nitrogen',
                label: 'N',
                unit: '(ppm)',
                field: 'nitrogen',
                group: 'soil',
                key: 'nitrogen'
            });
            addMetricColumn(isLuxuryHistoryMetricInstalled(soilMetrics, 'phosphorus', rows, 'phosphorus', 'soil'), {
                id: 'phosphorus',
                label: 'P',
                unit: '(ppm)',
                field: 'phosphorus',
                group: 'soil',
                key: 'phosphorus'
            });
            addMetricColumn(isLuxuryHistoryMetricInstalled(soilMetrics, 'potassium', rows, 'potassium', 'soil'), {
                id: 'potassium',
                label: 'K',
                unit: '(ppm)',
                field: 'potassium',
                group: 'soil',
                key: 'potassium'
            });
            addMetricColumn(isLuxuryHistoryMetricInstalled(soilMetrics, 'pH', rows, 'pH', 'soil'), {
                id: 'pH',
                label: 'pH',
                unit: '',
                field: 'pH',
                group: 'soil',
                key: 'pH'
            });

            columns.push({ id: 'status', label: 'STATUT', type: 'status' });
            return columns;
        }

        function getLuxuryHistoryValueLevel(row, column) {
            if (!column?.group || !column?.key) {
                return 'normal';
            }

            return getMetricLevel(column.group, column.key, row?.[column.field]);
        }

        function getLuxuryHistoryRowLevel(row, columns) {
            const levels = columns
                .filter((column) => column.group && column.key)
                .map((column) => getLuxuryHistoryValueLevel(row, column))
                .filter((level) => level !== 'unavailable');

            return getOverallLevel(levels);
        }

        function formatLuxuryHistoryCellValue(row, column) {
            if (column.type === 'date') {
                return `
                    <strong>${escapeHtml(formatLocalizedDate(row.date))}</strong>
                    <span>${escapeHtml(formatLocalizedTime(row.date))}</span>
                `;
            }

            if (column.type === 'status') {
                return '';
            }

            return escapeHtml(formatHistoryNumber(row?.[column.field], {
                group: column.group,
                key: column.key
            }));
        }

        function renderLuxuryHistoryStatus(level) {
            return `
                <span class="rayat-history-status ${getLuxuryDashboardStatusClass(level)}">
                    <i></i>${escapeHtml(getAlertBadgeLabel(level))}
                </span>
            `;
        }

        function renderLuxuryHistoryPeriodControls() {
            const periods = [
                { key: '24h', label: '24h' },
                { key: '7d', label: '7 jours' },
                { key: '30d', label: '30 jours' },
                { key: '90d', label: '90 jours' },
                { key: 'custom', label: 'Personnalisé' }
            ];
            const { start, end } = getFilterRange();

            return `
                <div class="rayat-history-actions">
                    <div class="rayat-history-periods" role="group" aria-label="Période historique">
                        ${periods.map((period) => `
                            <button type="button" class="rayat-history-period ${filterState.period === period.key ? 'is-active' : ''}" onclick="setFilterPeriod('${period.key}')">
                                ${escapeHtml(period.label)}${period.key === 'custom' ? getLuxuryDashboardIcon('calendar') : ''}
                            </button>
                        `).join('')}
                    </div>
                    <button type="button" class="rayat-history-export" onclick="exportCSV()">
                        ${getLuxuryDashboardIcon('download')}<span>Télécharger CSV</span>
                    </button>
                    ${filterState.period === 'custom' ? `
                        <div class="rayat-history-custom">
                            <label>
                                <span>${t('luxuryDashDateFrom')}</span>
                                <input type="date" id="startDate" value="${formatHistoryDateInputValue(start)}">
                            </label>
                            <label>
                                <span>${t('luxuryDashDateTo')}</span>
                                <input type="date" id="endDate" value="${formatHistoryDateInputValue(end)}">
                            </label>
                            <button type="button" onclick="setCustomFilter()">${t('luxuryDashApply')}</button>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        function renderLuxuryHistoryPagination(totalRows, pageSize) {
            const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
            historyTablePage = Math.min(Math.max(historyTablePage, 1), pageCount);
            const page = historyTablePage;
            const startIndex = totalRows ? ((page - 1) * pageSize) + 1 : 0;
            const endIndex = Math.min(page * pageSize, totalRows);
            const pages = [1, 2, 3, pageCount]
                .filter((value, index, list) => value >= 1 && value <= pageCount && list.indexOf(value) === index);
            const visiblePages = page > 3 && page < pageCount
                ? [1, page - 1, page, page + 1, pageCount].filter((value, index, list) => value >= 1 && value <= pageCount && list.indexOf(value) === index)
                : pages;

            return `
                <div class="rayat-history-pagination">
                    <p>Affichage : ${startIndex}–${endIndex} sur ${totalRows.toLocaleString('fr-FR')} mesures</p>
                    <div class="rayat-history-page-list">
                        <button type="button" ${page <= 1 ? 'disabled' : ''} onclick="setHistoryTablePage(${page - 1})">«</button>
                        ${visiblePages.map((pageNumber, index) => `
                            ${index > 0 && pageNumber - visiblePages[index - 1] > 1 ? '<span>...</span>' : ''}
                            <button type="button" class="${pageNumber === page ? 'is-active' : ''}" onclick="setHistoryTablePage(${pageNumber})">${pageNumber}</button>
                        `).join('')}
                        <button type="button" ${page >= pageCount ? 'disabled' : ''} onclick="setHistoryTablePage(${page + 1})">»</button>
                    </div>
                </div>
            `;
        }

        function renderLuxuryDashboardHistoricalMeasurements(soilMetrics, climateMetrics) {
            const realRows = getFilteredHistory()
                .filter((row) => row?.date instanceof Date && !Number.isNaN(row.date.getTime()))
                .sort((a, b) => b.date - a.date);
            const rows = realRows.length ? realRows : buildLuxuryHistoryPreviewRows();
            const columns = getLuxuryHistoryColumns(soilMetrics, climateMetrics, rows);
            const pageSize = 50;
            const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
            historyTablePage = Math.min(Math.max(historyTablePage, 1), pageCount);
            const offset = (historyTablePage - 1) * pageSize;
            const pageRows = rows.slice(offset, offset + pageSize);

            return `
                <div class="rayat-history-card">
                    <div class="rayat-history-header">
                        <div>
                            <h2>Historique des mesures</h2>
                            <p>Consultez l'évolution détaillée de tous les paramètres de votre culture.</p>
                        </div>
                        ${renderLuxuryHistoryPeriodControls()}
                    </div>
                    ${historyState.loading ? `<div class="rayat-history-empty">${t('luxuryDashLoadingHistory')}</div>` : `
                        <div class="rayat-history-table-shell">
                            <table class="rayat-history-table">
                                <thead>
                                    <tr>
                                        ${columns.map((column) => `
                                            <th class="${column.type === 'date' ? 'is-date' : ''}">
                                                <span>${escapeHtml(column.label)}</span>
                                                ${column.unit ? `<small>${escapeHtml(column.unit)}</small>` : ''}
                                            </th>
                                        `).join('')}
                                    </tr>
                                </thead>
                                <tbody>
                                    ${pageRows.map((row) => {
                                        const rowLevel = getLuxuryHistoryRowLevel(row, columns);
                                        return `
                                            <tr>
                                                ${columns.map((column) => {
                                                    if (column.type === 'status') {
                                                        return `<td>${renderLuxuryHistoryStatus(rowLevel)}</td>`;
                                                    }

                                                    const level = column.type === 'date' ? 'normal' : getLuxuryHistoryValueLevel(row, column);
                                                    return `<td class="${column.type === 'date' ? 'rayat-history-date-cell' : `rayat-history-value ${getLuxuryDashboardStatusClass(level)}`}">${formatLuxuryHistoryCellValue(row, column)}</td>`;
                                                }).join('')}
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                        ${renderLuxuryHistoryPagination(rows.length, pageSize)}
                    `}
                </div>
            `;
        }

        function renderLuxuryDashboardHistoryTable() {
            const rows = [...getFilteredHistory()].reverse();
            if (!rows.length) {
                return `<div class="rayat-luxury-dashboard-empty-row">${historyState.loading ? t('luxuryDashLoadingHistory') : t('luxuryDashHistoricalEmpty')}</div>`;
            }

            return `
                <div class="rayat-luxury-dashboard-history-scroll">
                    <table class="rayat-luxury-dashboard-history-table">
                        <thead>
                            <tr>
                                <th>${t('time')}</th>
                                <th>${t('sensorSoF1')}</th>
                                <th>${t('sensorSoF2')}</th>
                                <th>EC</th>
                                <th>pH</th>
                                <th>${t('status')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map((row) => {
                                const levels = [
                                    getMetricLevel('soil', 'moisture', row.terreno),
                                    getMetricLevel('soil', 'temperature', row.temperature),
                                    getMetricLevel('soil', 'ec', row.ec),
                                    getMetricLevel('soil', 'pH', row.pH)
                                ];
                                const level = getOverallLevel(levels);
                                return `
                                    <tr>
                                        <td><strong>${formatLocalizedDate(row.date)}</strong><span>${formatLocalizedTime(row.date)}</span></td>
                                        <td>${formatHistoryNumber(row.terreno, { group: 'soil', key: 'moisture' })}%</td>
                                        <td>${formatHistoryNumber(row.temperature, { group: 'soil', key: 'temperature' })} °C</td>
                                        <td>${formatHistoryNumber(row.ec, { group: 'soil', key: 'ec' })}</td>
                                        <td>${formatHistoryNumber(row.pH, { group: 'soil', key: 'pH' })}</td>
                                        <td><span class="rayat-luxury-dashboard-pill ${getLuxuryDashboardStatusClass(level)}">${getAlertBadgeLabel(level)}</span></td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        function renderLuxuryDashboardRecommendations(metrics) {
            const moisture = getLuxuryDashboardMetric(metrics, 'moisture');
            const nitrogen = getLuxuryDashboardMetric(metrics, 'nitrogen');
            const healthLevel = getOverallLevel(metrics.filter((metric) => metric.available).map((metric) => metric.state.level));
            const items = [
                {
                    icon: 'drop',
                    title: t('luxuryDashIrrigationAdvice'),
                    detail: moisture.available && moisture.state.level === 'normal' ? t('luxuryDashIrrigationStable') : t('luxuryDashIrrigationReview'),
                    level: moisture.available ? moisture.state.level : 'unavailable'
                },
                {
                    icon: 'alert',
                    title: t('luxuryDashHydricRisk'),
                    detail: moisture.available && moisture.state.level === 'normal' ? t('luxuryDashHydricStable') : t('luxuryDashHydricWarning'),
                    level: moisture.available ? moisture.state.level : 'unavailable'
                },
                {
                    icon: 'leaf',
                    title: t('luxuryDashNutritionAdvice'),
                    detail: nitrogen.available && nitrogen.state.level === 'normal' ? t('luxuryDashNutritionStable') : t('luxuryDashNutritionReview'),
                    level: nitrogen.available ? nitrogen.state.level : healthLevel
                }
            ];

            return items.map((item) => {
                const priority = item.level === 'alert'
                    ? t('luxuryDashPriorityHigh')
                    : (item.level === 'attention' ? t('luxuryDashPriorityMedium') : t('luxuryDashPriorityLow'));
                return `
                    <article class="rayat-luxury-dashboard-recommendation ${getLuxuryDashboardStatusClass(item.level)}">
                        <span class="rayat-luxury-dashboard-recommendation-icon">${getLuxuryDashboardIcon(item.icon)}</span>
                        <div>
                            <h4>${item.title}</h4>
                            <p>${item.detail}</p>
                            <small>${priority}</small>
                        </div>
                    </article>
                `;
            }).join('');
        }

        function renderLuxuryDashboardCropSelect() {
            const selectedCrop = getSelectedCropOption();
            return `
                <label class="rayat-luxury-dashboard-crop">
                    <span>${t('cropSelectorTitle')}</span>
                    <select onchange="setUserCrop(this.value)" aria-label="${escapeHtml(t('cropSelectorTitle'))}">
                        ${CROP_OPTIONS.map((option) => `<option value="${option.value}" ${selectedCrop.value === option.value ? 'selected' : ''}>${t(option.labelKey)}</option>`).join('')}
                    </select>
                </label>
            `;
        }

        function renderLuxuryOnlineDashboardPage() {
            if (!normalizeDashboardSensorKey(selectedSensor)) {
                selectedSensor = 'terreno';
            }

            const soilMetrics = getLuxuryDashboardSoilMetrics();
            const climateMetrics = getLuxuryDashboardClimateMetrics();
            const moisture = getLuxuryDashboardMetric(soilMetrics, 'moisture');
            const soilTemperature = getLuxuryDashboardMetric(soilMetrics, 'temperature');
            const soilEc = getLuxuryDashboardMetric(soilMetrics, 'ec');
            const soilPh = getLuxuryDashboardMetric(soilMetrics, 'pH');
            const healthIndex = getLuxuryDashboardHealthIndex(soilMetrics);
            const statusMeta = getDemoSectionStatusMeta('terreno');
            const isOnline = statusMeta.className === 'is-online';
            const usesDemoFallback = soilMetrics.some((metric) => metric.usesFallback) || climateMetrics.some((metric) => metric.usesFallback);
            const availableSensors = soilMetrics.filter((metric) => metric.available).length;
            const onlineSensors = isOnline ? availableSensors : 0;
            const alarms = soilMetrics.filter((metric) => metric.available && metric.state.level !== 'normal');
            const displayUserName = user?.first_name || user?.name || t('luxuryDashUserName');
            const climateTemperature = getLuxuryDashboardMetric(climateMetrics, 'temperature');
            const climateHumidity = getLuxuryDashboardMetric(climateMetrics, 'humidity');
            const wind = getLuxuryDashboardMetric(climateMetrics, 'windSpeed');
            const exportAllowed = !isAuthenticated() || !isCustomerRole(currentRole) || hasCustomerPermission('export_csv');
            const iconByMetric = {
                moisture: 'drop',
                temperature: 'thermometer',
                humidity: 'drop',
                ec: 'bolt',
                pH: 'flask',
                nitrogen: 'nutrient',
                phosphorus: 'nutrient',
                potassium: 'leaf',
                co2: 'weather',
                organicMatter: 'leaf'
            };
            const dashboardLanguageOptions = [
                { lang: 'it', code: 'IT' },
                { lang: 'fr', code: 'FR' },
                { lang: 'en', code: 'EN' },
                { lang: 'ar', code: 'AR' },
                { lang: 'zgh', code: 'ZGH' }
            ];

            const metricLabel = (metric) => metric.key === 'organicMatter' ? t('luxuryDashOrganicMatter') : t(metric.label);
            const metricValue = (metric) => metric.available ? `${formatMetricValue(metric.value)}${metric.unit ? ` ${metric.unit}` : ''}` : '--';
            const metricStatusLabel = (metric) => metric.available ? metric.state.label : t('luxuryDashUnavailableStatus');
            const metricStatusClass = (metric) => metric.available ? getLuxuryDashboardStatusClass(metric.state.level) : 'is-unavailable';
            const climateMetricValue = (metric) => metric.available ? `${formatMetricValue(metric.value)}${metric.unit ? ` ${metric.unit}` : ''}` : '--';
            const climateMetricStatus = (metric) => metric.available ? t('statusNormal') : t('luxuryDashUnavailableStatus');
            const nowLabel = statusMeta.timestamp || t('luxuryDashNoMeasuredValue');
            const dashboardSensorOrder = {
                soil: ['moisture', 'temperature', 'ec', 'pH', 'nitrogen', 'phosphorus', 'potassium'],
                climate: ['temperature', 'humidity', 'co2']
            };
            const climateLabelByKey = {
                temperature: t('tempAmbient'),
                humidity: t('relHumidity'),
                co2: t('co2')
            };
            const historyFieldBySensorMetric = {
                soil: {
                    moisture: 'terreno',
                    temperature: 'temperature',
                    ec: 'ec',
                    pH: 'pH',
                    nitrogen: 'nitrogen',
                    phosphorus: 'phosphorus',
                    potassium: 'potassium'
                },
                climate: {
                    temperature: 'climaTemp',
                    humidity: 'humidity',
                    co2: 'co2'
                }
            };
            const createDashboardSensorMetric = (group, metric) => {
                const value = normalizeMetricValue(group, metric.key, metric.value);
                const range = getRangeForMetric(group, metric.key);
                const available = metric.installed !== false && Number.isFinite(value);
                const state = available
                    ? getMetricState(value, range)
                    : { level: 'unavailable', label: t('luxuryDashUnavailableStatus') };

                return {
                    ...metric,
                    group,
                    value,
                    range,
                    available,
                    state,
                    unit: getMetricUnit(group, metric.key, metric.unit || metric.unita || ''),
                    displayLabel: group === 'climate' ? (climateLabelByKey[metric.key] || t(metric.label)) : metricLabel(metric),
                    iconName: iconByMetric[metric.key] || (group === 'climate' ? 'weather' : 'leaf')
                };
            };
            const sortSensorMetrics = (group, metrics) => metrics
                .filter((metric) => dashboardSensorOrder[group].includes(metric.key))
                .sort((a, b) => dashboardSensorOrder[group].indexOf(a.key) - dashboardSensorOrder[group].indexOf(b.key))
                .map((metric) => createDashboardSensorMetric(group, metric));
            const dashboardSensorMetrics = [
                ...sortSensorMetrics('soil', soilMetrics),
                ...sortSensorMetrics('climate', climateMetrics)
            ];
            const conditionItems = [
                { icon: 'drop', label: t('luxuryDashRelativeHumidity'), value: climateMetricValue(climateHumidity), status: climateMetricStatus(climateHumidity), level: climateHumidity.available ? 'normal' : 'unavailable' },
                { icon: 'thermometer', label: t('luxuryDashAirTemperature'), value: climateMetricValue(climateTemperature), status: climateMetricStatus(climateTemperature), level: climateTemperature.available ? 'normal' : 'unavailable' },
                { icon: 'thermometer', label: t('luxuryDashSoilTemperature'), value: metricValue(soilTemperature), status: metricStatusLabel(soilTemperature), level: soilTemperature.state.level },
                { icon: 'flask', label: t('luxuryDashSoilPh'), value: metricValue(soilPh), status: metricStatusLabel(soilPh), level: soilPh.state.level },
                { icon: 'bolt', label: t('luxuryDashSoilEc'), value: metricValue(soilEc), status: metricStatusLabel(soilEc), level: soilEc.state.level }
            ];
            const activityRows = alarms.length
                ? alarms.map((metric) => ({
                    icon: iconByMetric[metric.key] || 'alert',
                    title: t(metric.label),
                    detail: buildOptimalRangeLabel(metric.range, 'range'),
                    time: nowLabel,
                    level: metric.state.level,
                    status: metric.state.label
                }))
                : [{
                    icon: 'wifi',
                    title: t('luxuryDashAllSensorsOnline'),
                    detail: `${availableSensors}/${soilMetrics.length} ${t('luxuryDashOperating').toLowerCase()}`,
                    time: nowLabel,
                    level: isOnline ? 'normal' : 'unavailable',
                    status: isOnline ? t('statusNormal') : statusMeta.label
                }];

            const renderMetric = (metric) => `
                <article class="rayat-luxury-dashboard-soil-metric ${metricStatusClass(metric)}">
                    <span>${getLuxuryDashboardIcon(iconByMetric[metric.key] || 'leaf')}</span>
                    <div>
                        <small>${metricLabel(metric)}</small>
                        <strong>${metric.available ? formatMetricValue(metric.value) : '--'} <em>${metric.unit}</em></strong>
                        <i class="${metricStatusClass(metric)}">${metricStatusLabel(metric)}</i>
                    </div>
                </article>
            `;
            const getMetricDirection = (metric) => {
                const value = normalizeMetricValue('soil', metric.key, metric.value);
                if (!metric.available || !metric.range || !Number.isFinite(value)) return 'unavailable';
                if (value < metric.range.min) return 'low';
                if (value > metric.range.max) return 'high';
                return 'normal';
            };
            const getVisualMetricCopy = (metric) => {
                const level = metric.available ? metric.state.level : 'unavailable';
                const direction = getMetricDirection(metric);
                let titleKey = 'sensorVisualNormalTitle';
                let actionKey = 'sensorVisualNormalAction';

                if (level === 'unavailable') {
                    titleKey = 'sensorVisualUnavailableTitle';
                    actionKey = 'sensorVisualUnavailableAction';
                } else if (metric.key === 'moisture' && direction === 'low') {
                    titleKey = 'sensorVisualMoistureLowTitle';
                    actionKey = 'sensorVisualMoistureLowAction';
                } else if (metric.key === 'moisture' && direction === 'high') {
                    titleKey = 'sensorVisualMoistureHighTitle';
                    actionKey = 'sensorVisualMoistureHighAction';
                } else if (level === 'alert') {
                    titleKey = direction === 'low'
                        ? 'sensorVisualLowAlertTitle'
                        : (direction === 'high' ? 'sensorVisualHighAlertTitle' : 'sensorVisualAlertTitle');
                    actionKey = 'sensorVisualAlertAction';
                } else if (level === 'attention') {
                    titleKey = direction === 'low'
                        ? 'sensorVisualLowAttentionTitle'
                        : (direction === 'high' ? 'sensorVisualHighAttentionTitle' : 'sensorVisualAttentionTitle');
                    actionKey = 'sensorVisualAttentionAction';
                }

                const metricName = metricLabel(metric);
                return {
                    title: formatTemplate(t(titleKey), { metric: metricName }),
                    action: formatTemplate(t(actionKey), { metric: metricName })
                };
            };
            const renderSensorCardModeToggle = () => `
                <div class="rayat-luxury-dashboard-sensor-mode-toggle" role="group" aria-label="${escapeHtml(t('sensorCardModeLabel'))}">
                    <button type="button" class="${currentSensorCardMode === 'technical' ? 'is-active' : ''}" onclick="setSensorCardMode('technical')">${t('sensorCardModeTechnical')}</button>
                    <button type="button" class="${currentSensorCardMode === 'visual' ? 'is-active' : ''}" onclick="setSensorCardMode('visual')">${t('sensorCardModeVisual')}</button>
                </div>
            `;
            const renderDashboardProfileDropdown = () => `
                <div class="rayat-luxury-dashboard-profile-dropdown ${isLuxuryDashboardProfileMenuOpen ? 'is-open' : ''}" role="menu" aria-label="${escapeHtml(displayUserName)}">
                    <div class="rayat-luxury-dashboard-profile-dropdown-section">
                        <span class="rayat-luxury-dashboard-profile-dropdown-label">${t('sensorCardModeLabel')}</span>
                        ${renderSensorCardModeToggle()}
                    </div>
                    <div class="rayat-luxury-dashboard-profile-dropdown-section">
                        <span class="rayat-luxury-dashboard-profile-dropdown-label">${t('dashboardProfileLanguage')}</span>
                        <div class="rayat-luxury-dashboard-profile-language-grid">
                            ${dashboardLanguageOptions.map((option) => `
                                <button type="button" class="${currentLang === option.lang ? 'is-active' : ''}" onclick="setLanguage('${option.lang}')">${option.code}</button>
                            `).join('')}
                        </div>
                    </div>
                    <button type="button" class="rayat-luxury-dashboard-profile-dropdown-action" onclick="setView('profilo')" role="menuitem">
                        ${getLuxuryDashboardIcon('settings')}<span>${t('dashboardProfileSettings')}</span>
                    </button>
                    <button type="button" class="rayat-luxury-dashboard-profile-dropdown-action rayat-luxury-dashboard-profile-dropdown-action--muted" onclick="setView('home')" role="menuitem">
                        ${getLuxuryDashboardIcon('history')}<span>${t('dashboardProfileExitDemo')}</span>
                    </button>
                </div>
            `;
            const renderVisualMetric = (metric) => {
                const copy = getVisualMetricCopy(metric);
                return `
                    <article class="rayat-luxury-dashboard-visual-card ${metricStatusClass(metric)}">
                        <span class="rayat-luxury-dashboard-visual-icon">${getLuxuryDashboardIcon(iconByMetric[metric.key] || 'leaf')}</span>
                        <div class="rayat-luxury-dashboard-visual-copy">
                            <small>${metricLabel(metric)}</small>
                            <strong>${escapeHtml(copy.title)}</strong>
                            <p><b>${t('sensorVisualAction')}:</b> ${escapeHtml(copy.action)}</p>
                            ${metric.available ? `<em>${t('sensorVisualValue')}: ${metricValue(metric)}</em>` : ''}
                        </div>
                    </article>
                `;
            };
            const getProfessionalTrendValues = (metric) => {
                if (!historyState.usesLiveData) {
                    return [];
                }
                const field = historyFieldBySensorMetric[metric.group]?.[metric.key];
                if (!field) {
                    return [];
                }

                return getFilteredHistory()
                    .slice(-10)
                    .map((row, index) => ({
                        index,
                        value: normalizeMetricValue(metric.group, metric.key, row?.[field])
                    }))
                    .filter((entry) => Number.isFinite(entry.value));
            };
            const renderProfessionalMiniTrend = (metric) => {
                const values = getProfessionalTrendValues(metric);
                if (values.length < 3) {
                    return `<span class="rayat-luxury-dashboard-mini-trend rayat-luxury-dashboard-mini-trend--empty">${t('sensorProfessionalHistoryUnavailable')}</span>`;
                }

                const width = 112;
                const height = 42;
                const minValue = Math.min(...values.map((entry) => entry.value));
                const maxValue = Math.max(...values.map((entry) => entry.value));
                const span = maxValue - minValue || 1;
                const points = values.map((entry, index) => {
                    const x = 6 + ((width - 12) * index / (values.length - 1));
                    const y = height - 6 - (((entry.value - minValue) / span) * (height - 12));
                    return [x, y];
                });
                const linePoints = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
                const areaPoints = `6,${height - 5} ${linePoints} ${width - 6},${height - 5}`;
                return `
                    <svg class="rayat-luxury-dashboard-mini-trend" viewBox="0 0 ${width} ${height}" aria-hidden="true">
                        <polygon points="${areaPoints}" class="rayat-luxury-dashboard-mini-trend-area"></polygon>
                        <polyline points="${linePoints}" class="rayat-luxury-dashboard-mini-trend-line"></polyline>
                    </svg>
                `;
            };
            const renderProfessionalSensorCard = (metric) => {
                const statusClass = metricStatusClass(metric);
                const stateLabel = metricStatusLabel(metric);
                const value = metric.available ? formatMetricValue(metric.value) : '--';
                const unit = metric.available && metric.unit ? metric.unit : '';
                return `
                    <article class="rayat-luxury-dashboard-professional-card ${statusClass}" data-metric-key="${metric.group}:${metric.key}">
                        <div class="rayat-luxury-dashboard-professional-head">
                            <span class="rayat-luxury-dashboard-professional-icon">${getLuxuryDashboardIcon(metric.iconName)}</span>
                            <strong>${metric.displayLabel}</strong>
                        </div>
                        <div class="rayat-luxury-dashboard-professional-value">
                            <span>${value}</span>
                            ${unit ? `<em>${unit}</em>` : ''}
                        </div>
                        <div class="rayat-luxury-dashboard-professional-footer">
                            <span class="rayat-luxury-dashboard-professional-status">
                                <i class="rayat-luxury-dashboard-pulse-dot ${statusClass}" aria-hidden="true"></i>
                                ${stateLabel}
                            </span>
                            ${renderProfessionalMiniTrend(metric)}
                        </div>
                    </article>
                `;
            };
            const renderSensorCardModeContent = () => {
                const isProfessional = currentSensorCardMode === 'technical';
                const modeTitle = isProfessional ? t('sensorProfessionalModeTitle') : t('sensorAssistedModeTitle');
                const modeSubtitle = isProfessional ? t('sensorProfessionalModeSubtitle') : t('sensorAssistedModeSubtitle');
                const grid = isProfessional
                    ? `<div class="rayat-luxury-dashboard-professional-grid">${dashboardSensorMetrics.map(renderProfessionalSensorCard).join('')}</div>`
                    : `<div class="rayat-luxury-dashboard-assisted-grid">${dashboardSensorMetrics.map((metric) => renderMetricCard(metric.group, metric)).join('')}</div>`;

                return `
                    <div class="rayat-luxury-dashboard-sensor-mode-heading">
                        <span>${modeTitle}</span>
                        <p>${modeSubtitle}</p>
                    </div>
                    ${grid}
                `;
            };

            return `
                <main class="rayat-luxury-dashboard-page">
                    <button type="button" class="rayat-luxury-dashboard-sidebar-backdrop ${isLuxuryDashboardSidebarOpen ? 'is-open' : ''}" onclick="toggleLuxuryDashboardSidebar(false)" aria-label="${escapeHtml(t('mobileMenuClose'))}"></button>
                    <aside class="rayat-luxury-dashboard-sidebar ${isLuxuryDashboardSidebarOpen ? 'is-open' : ''}">
                        <button type="button" class="rayat-luxury-dashboard-brand" onclick="setView('home')" aria-label="${escapeHtml(t('home'))}">
                            <img src="/assets/logo/logo-green.svg" alt="Rayat">
                            <div><strong>RAYAT</strong><span>SMART MONITORING</span></div>
                        </button>
                        <nav class="rayat-luxury-dashboard-nav" aria-label="${escapeHtml(t('luxuryDashMenuDashboard'))}">
                            <button class="is-active" type="button" data-dashboard-target="rayat-luxury-dashboard-top" onclick="scrollLuxuryDashboardSection('rayat-luxury-dashboard-top')">${getLuxuryDashboardIcon('calendar')}<span>${t('demoLive')}</span></button>
                            <button type="button" data-dashboard-target="rayat-luxury-dashboard-kpis" onclick="scrollLuxuryDashboardSection('rayat-luxury-dashboard-kpis')">${getLuxuryDashboardIcon('dashboard')}<span>${t('luxuryDashMenuDashboard')}</span></button>
                            <button type="button" data-dashboard-target="rayat-luxury-dashboard-map-section" onclick="scrollLuxuryDashboardSection('rayat-luxury-dashboard-map-section')">${getLuxuryDashboardIcon('pin')}<span>${t('luxuryDashMapShort')}</span></button>
                            <button type="button" data-dashboard-target="rayat-luxury-dashboard-sensors" onclick="scrollLuxuryDashboardSection('rayat-luxury-dashboard-sensors')">${getLuxuryDashboardIcon('sensors')}<span>${t('luxuryDashMenuSensors')}</span></button>
                            <button type="button" data-dashboard-target="rayat-luxury-dashboard-activities" onclick="scrollLuxuryDashboardSection('rayat-luxury-dashboard-activities')">${getLuxuryDashboardIcon('alert')}<span>${t('luxuryDashMenuAlarmSingular')}</span></button>
                            <button type="button" data-dashboard-target="rayat-luxury-dashboard-recommendations" onclick="scrollLuxuryDashboardSection('rayat-luxury-dashboard-recommendations')">${getLuxuryDashboardIcon('bolt')}<span>${t('luxuryDashMenuRecommendations')}</span></button>
                            <button type="button" data-dashboard-target="rayat-luxury-dashboard-reports" onclick="scrollLuxuryDashboardSection('rayat-luxury-dashboard-reports')">${getLuxuryDashboardIcon('report')}<span>${t('luxuryDashMenuReports')}</span></button>
                            <button type="button" data-dashboard-target="rayat-luxury-dashboard-trend" onclick="scrollLuxuryDashboardSection('rayat-luxury-dashboard-trend')">${getLuxuryDashboardIcon('history')}<span>${t('luxuryDashMenuHistory')}</span></button>
                        </nav>
                    </aside>
                    <section id="rayat-luxury-dashboard-top" class="rayat-luxury-dashboard-main">
                        ${renderSubscriptionWarningBanner()}
                        <header class="rayat-luxury-dashboard-header">
                            <div>
                                <h1>${t('luxuryDashDemoPageTitle')}</h1>
                                <p>${t('luxuryDashDemoPageSubtitle')}</p>
                            </div>
                            <div class="rayat-luxury-dashboard-header-actions">
                                <button type="button" class="rayat-luxury-dashboard-mobile-toggle" onclick="toggleLuxuryDashboardSidebar(true)" aria-label="${escapeHtml(t('navMenu'))}" aria-expanded="${isLuxuryDashboardSidebarOpen}">
                                    ${getLuxuryDashboardIcon('dashboard')}
                                </button>
                                <button type="button" class="rayat-luxury-dashboard-top-icon">${getLuxuryDashboardIcon('bell')}</button>
                                <button type="button" class="rayat-luxury-dashboard-top-icon">${getLuxuryDashboardIcon('question')}</button>
                                <div class="rayat-luxury-dashboard-profile-menu" onclick="event.stopPropagation()">
                                    <button type="button" class="rayat-luxury-dashboard-profile" onclick="toggleLuxuryDashboardProfileMenu(null, event)" aria-expanded="${isLuxuryDashboardProfileMenuOpen}" aria-haspopup="menu">
                                        <span>${escapeHtml((displayUserName || 'MT').slice(0, 2).toUpperCase())}</span>
                                        <div><strong>${escapeHtml(displayUserName)}</strong><small>${t('demoLive')}</small></div>
                                    </button>
                                    ${renderDashboardProfileDropdown()}
                                </div>
                            </div>
                        </header>
                        <div class="rayat-luxury-dashboard-live-meta">
                            <button class="rayat-luxury-dashboard-refresh ${isRefreshingData ? 'is-loading' : ''}" type="button" onclick="refreshData()" ${isRefreshingData ? 'disabled' : ''} aria-label="${escapeHtml(t('refreshDataAction'))}">
                                ${getLuxuryDashboardIcon('refresh')}
                            </button>
                            <span class="rayat-luxury-dashboard-online ${statusMeta.className}">${statusMeta.label}</span>
                            <span>${t('luxuryDashLastUpdateShort')}: <strong>${nowLabel}</strong></span>
                            ${usesDemoFallback ? `<span class="rayat-luxury-dashboard-demo-pill">${t('luxuryDashDemoFallback')}</span>` : ''}
                        </div>
                        <section class="rayat-luxury-dashboard-kpis" id="rayat-luxury-dashboard-kpis">
                            <article>${getLuxuryDashboardIcon('leaf')}<div><span>${t('luxuryDashHealthIndex')}</span><strong>${Number.isFinite(healthIndex) ? healthIndex : '--'} <small>/100</small></strong><em class="${Number.isFinite(healthIndex) && healthIndex >= 85 ? 'is-normal' : 'is-attention'}">${Number.isFinite(healthIndex) && healthIndex >= 85 ? t('luxuryDashExcellent') : t('luxuryDashToMonitor')}</em></div></article>
                            <article>${getLuxuryDashboardIcon('wifi')}<div><span>${t('luxuryDashSensorsOnline')}</span><strong>${onlineSensors} <small>/ ${soilMetrics.length}</small></strong><em class="${isOnline ? 'is-normal' : 'is-alert'}">${isOnline ? t('luxuryDashAllOnline') : statusMeta.label}</em></div></article>
                            <article>${getLuxuryDashboardIcon('clock')}<div><span>${t('luxuryDashLastUpdateCard')}</span><strong>${nowLabel}</strong><em class="${isOnline ? 'is-normal' : 'is-alert'}">${isOnline ? t('luxuryDashRealtimeData') : statusMeta.label}</em></div></article>
                            <article>${getLuxuryDashboardIcon('alert')}<div><span>${t('luxuryDashActiveAlarms')}</span><strong>${alarms.length}</strong><em class="${alarms.length ? 'is-alert' : 'is-normal'}">${alarms.length ? t('luxuryDashToMonitor') : t('luxuryDashNoAlert')}</em></div></article>
                        </section>
                        <section class="rayat-luxury-dashboard-map-layout">
                            <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-map-card" id="rayat-luxury-dashboard-map-section">
                                <div class="rayat-luxury-dashboard-card-head">
                                    <h2>${t('luxuryDashMapTitle')}</h2>
                                    <div>
                                        <span>${t('luxuryDashSatellite')}</span>
                                        <button type="button" class="rayat-luxury-dashboard-map-action">${getLuxuryDashboardIcon('expand')}</button>
                                    </div>
                                </div>
                                <div id="rayat-luxury-dashboard-map" class="rayat-luxury-dashboard-map" aria-label="${escapeHtml(t('luxuryDashMapTitle'))}"></div>
                                <div class="rayat-luxury-dashboard-map-footer">
                                    <span>${getLuxuryDashboardIcon('pin')}${t('luxuryDashFieldInfo')}</span>
                                    <strong>${t('luxuryDashCropHealth')}: ${Number.isFinite(healthIndex) ? `${healthIndex}/100` : '--'}</strong>
                                </div>
                            </article>
                        </section>
                        <section class="rayat-luxury-dashboard-primary">
                            <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-sensor-status" id="rayat-luxury-dashboard-sensors">
                                <div class="rayat-luxury-dashboard-card-head"><h2>${t('luxuryDashSensorStatus')}</h2><button type="button">${t('luxuryDashViewDetails')}</button></div>
                                ${soilMetrics.map((metric) => `
                                    <div class="rayat-luxury-dashboard-sensor-row">
                                        <span>${getLuxuryDashboardIcon(iconByMetric[metric.key] || 'leaf')}${metricLabel(metric)}</span>
                                        <b class="${isOnline && metric.available ? 'is-normal' : 'is-unavailable'}"><i></i>${isOnline && metric.available ? statusMeta.label : t('luxuryDashUnavailableStatus')}</b>
                                    </div>
                                `).join('')}
                            </article>
                            <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-recommendations" id="rayat-luxury-dashboard-recommendations">
                                <div class="rayat-luxury-dashboard-card-head"><h2>${t('luxuryDashRecommendations')}</h2><button type="button">${t('luxuryDashViewAll')}</button></div>
                                ${renderLuxuryDashboardRecommendations(soilMetrics)}
                            </article>
                        </section>
                        <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-conditions" id="rayat-luxury-dashboard-conditions">
                            <div class="rayat-luxury-dashboard-card-head"><h2>${t('luxuryDashCurrentConditions')}</h2></div>
                            <div class="rayat-luxury-dashboard-condition-grid">
                                ${conditionItems.map((item) => `
                                    <div class="rayat-luxury-dashboard-condition ${getLuxuryDashboardStatusClass(item.level)}">
                                        <span>${getLuxuryDashboardIcon(item.icon)}</span>
                                        <small>${item.label}</small>
                                        <strong>${item.value}</strong>
                                        <em>${item.status}</em>
                                    </div>
                                `).join('')}
                            </div>
                        </article>
                        <section class="rayat-luxury-dashboard-secondary">
                            <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-trend rayat-history-measures" id="rayat-luxury-dashboard-trend">
                                ${renderLuxuryDashboardHistoricalMeasurements(soilMetrics, climateMetrics)}
                            </article>
                            <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-soil" id="rayat-luxury-dashboard-sensor-cards">
                                <div class="rayat-luxury-dashboard-card-head"><h2>${t('sensorCardsSectionTitle')}</h2></div>
                                ${renderSensorCardModeContent()}
                            </article>
                        </section>
                        <section class="rayat-luxury-dashboard-bottom">
                            <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-activities" id="rayat-luxury-dashboard-activities">
                                <div class="rayat-luxury-dashboard-card-head"><h2>${t('luxuryDashRecentActivities')}</h2></div>
                                ${activityRows.map((activity) => `
                                    <div class="rayat-luxury-dashboard-activity-row">
                                        <span>${getLuxuryDashboardIcon(activity.icon)}</span>
                                        <div><strong>${activity.title}</strong><small>${activity.detail}</small></div>
                                        <time>${activity.time}</time>
                                    </div>
                                `).join('')}
                            </article>
                            <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-reports" id="rayat-luxury-dashboard-reports">
                                <div class="rayat-luxury-dashboard-card-head"><h2>${t('luxuryDashQuickReports')}</h2></div>
                                <p>${t('luxuryDashQuickReportsSubtitle')}</p>
                                <div class="rayat-luxury-dashboard-report-actions">
                                    <div class="rayat-luxury-dashboard-report-tile">${getLuxuryDashboardIcon('calendar')}<span>${t('luxuryDashTodayData')}</span></div>
                                    <div class="rayat-luxury-dashboard-report-tile">${getLuxuryDashboardIcon('calendar')}<span>${t('luxuryDashWeeklyReport')}</span></div>
                                    <div class="rayat-luxury-dashboard-report-tile">${getLuxuryDashboardIcon('analytics')}<span>${t('luxuryDashMonthlyAnalysis')}</span></div>
                                    <button type="button" onclick="${exportAllowed ? 'exportCSV()' : ''}" ${exportAllowed ? '' : 'disabled'}>${getLuxuryDashboardIcon('download')}<span>${t('luxuryDashDownloadCsv')}</span></button>
                                </div>
                            </article>
                        </section>
                        <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-verified" id="rayat-luxury-dashboard-history">
                            <span>${getLuxuryDashboardIcon('shield')}</span>
                            <div><strong>${t('luxuryDashVerifiedTitle')}</strong><small>${t('luxuryDashVerifiedText')}</small></div>
                            <button type="button" onclick="scrollLuxuryDashboardSection('rayat-luxury-dashboard-map-section')">${t('luxuryDashLearnRayat')}<span>&rarr;</span></button>
                        </article>
                    </section>
                </main>
            `;
        }

        function initLuxuryDashboardMap() {
            const container = document.getElementById('rayat-luxury-dashboard-map');
            if (!container || typeof L === 'undefined') {
                return;
            }

            if (luxuryDashboardMap) {
                luxuryDashboardMap.remove();
                luxuryDashboardMap = null;
            }

            const bananaFarm = mockClients.find((client) => client.crop === 'Banane' && client.locality === 'Taroudant') || { lat: 30.4277, lng: -8.8755 };
            const center = [bananaFarm.lat, bananaFarm.lng];
            luxuryDashboardMap = L.map(container, {
                zoomControl: false,
                attributionControl: false,
                scrollWheelZoom: false
            }).setView(center, 16);

            L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 20
            }).addTo(luxuryDashboardMap);
            L.control.zoom({ position: 'bottomright' }).addTo(luxuryDashboardMap);

            const boundary = [
                [center[0] + 0.0022, center[1] - 0.0034],
                [center[0] + 0.0026, center[1] + 0.0011],
                [center[0] + 0.0015, center[1] + 0.0037],
                [center[0] - 0.0018, center[1] + 0.0032],
                [center[0] - 0.0026, center[1] - 0.0005],
                [center[0] - 0.0013, center[1] - 0.0039]
            ];
            const polygon = L.polygon(boundary, {
                color: '#fafaf7',
                weight: 3,
                opacity: 0.95,
                fillColor: '#2d6a4f',
                fillOpacity: 0.35
            });

            if (L.Control && typeof L.Control.Draw === 'function' && typeof L.FeatureGroup === 'function') {
                const editableLayers = new L.FeatureGroup([polygon]);
                luxuryDashboardMap.addLayer(editableLayers);
                luxuryDashboardMap.addControl(new L.Control.Draw({
                    edit: { featureGroup: editableLayers },
                    draw: { marker: false, circle: false, circlemarker: false, rectangle: false, polyline: false }
                }));
            } else {
                polygon.addTo(luxuryDashboardMap);
            }

            const healthIndex = getLuxuryDashboardHealthIndex(getLuxuryDashboardSoilMetrics());
            const label = `
                <div class="rayat-luxury-dashboard-map-marker">
                    <span>${t('luxuryDashCropHealth')}</span>
                    <strong>${Number.isFinite(healthIndex) ? `${healthIndex}/100` : '--'}</strong>
                </div>
            `;
            L.marker(center, {
                icon: L.divIcon({
                    className: 'rayat-luxury-dashboard-marker-shell',
                    html: label,
                    iconSize: [132, 58],
                    iconAnchor: [66, 29]
                })
            }).addTo(luxuryDashboardMap);
            window.setTimeout(() => luxuryDashboardMap?.invalidateSize(), 0);
        }

        function renderDemoPage() {
            return renderLuxuryOnlineDashboardPage();
        }

        function renderPerliteTrackPage() {
            if (!canAccessPerliteTrack()) {
                return renderLoginPage();
            }

            selectedSensor = 'terreno';
            const soilMetrics = getLuxuryDashboardSoilMetrics();
            const statusMeta = getDemoSectionStatusMeta('terreno');
            const isOnline = statusMeta.className === 'is-online';
            const nowLabel = statusMeta.timestamp || t('luxuryDashNoMeasuredValue');
            const iconByMetric = {
                moisture: 'drop',
                ec: 'bolt',
                temperature: 'thermometer'
            };
            const perliteRanges = {
                moisture: {
                    min: 55,
                    max: 75,
                    unit: '%',
                    label: 'Range indicativo per coltura fuori suolo'
                },
                ec: {
                    min: 2,
                    max: 3.5,
                    unit: 'mS/cm',
                    label: 'Range indicativo per substrato perlite'
                },
                temperature: {
                    min: 18,
                    max: 26,
                    unit: '°C',
                    label: 'Range indicativo per pomodoro in serra'
                }
            };
            const formatPerliteRangeLabel = (metric) => {
                const rangeMeta = perliteRanges[metric.key];
                if (!rangeMeta || !Number.isFinite(rangeMeta.min) || !Number.isFinite(rangeMeta.max)) {
                    return 'Range indicativo per substrato perlite';
                }
                return `${rangeMeta.label}: ${formatMetricValue(rangeMeta.min)} - ${formatMetricValue(rangeMeta.max)} ${rangeMeta.unit}`;
            };
            const metrics = RAYAT_PERLITE_SENSOR_METRICS.map((definition) => {
                const sourceMetric = soilMetrics.find((metric) => metric.key === definition.key) || definition;
                const value = normalizeMetricValue('soil', definition.key, sourceMetric.value);
                const range = perliteRanges[definition.key] || getRangeForMetric('soil', definition.key);
                const available = sourceMetric.installed !== false && Number.isFinite(value);
                const state = available
                    ? getMetricState(value, range)
                    : { level: 'unavailable', label: t('luxuryDashUnavailableStatus') };

                return {
                    ...definition,
                    value,
                    range,
                    available,
                    state,
                    unit: getMetricUnit('soil', definition.key, sourceMetric.unit || definition.unit),
                    iconName: iconByMetric[definition.key] || 'leaf'
                };
            });
            const alarms = metrics.filter((metric) => metric.available && metric.state.level !== 'normal');
            const rows = [...getFilteredHistory()].reverse();
            const metricStatusClass = (metric) => metric.available ? getLuxuryDashboardStatusClass(metric.state.level) : 'is-unavailable';
            const metricStatusLabel = (metric) => metric.available ? metric.state.label : t('luxuryDashUnavailableStatus');
            const renderMetric = (metric) => `
                <article class="rayat-luxury-dashboard-professional-card ${metricStatusClass(metric)}" data-metric-key="soil:${metric.key}">
                    <div class="rayat-luxury-dashboard-professional-head">
                        <span class="rayat-luxury-dashboard-professional-icon">${getLuxuryDashboardIcon(metric.iconName)}</span>
                        <strong>${escapeHtml(metric.label)}</strong>
                    </div>
                    <div class="rayat-luxury-dashboard-professional-value">
                        <span>${metric.available ? formatMetricValue(metric.value) : '--'}</span>
                        ${metric.unit ? `<em>${metric.unit}</em>` : ''}
                    </div>
                    <div class="rayat-luxury-dashboard-professional-footer">
                        <span class="rayat-luxury-dashboard-professional-status">
                            <i class="rayat-luxury-dashboard-pulse-dot ${metricStatusClass(metric)}" aria-hidden="true"></i>
                            ${metricStatusLabel(metric)}
                        </span>
                    </div>
                </article>
            `;
            const renderHistory = () => {
                if (!rows.length) {
                    return `<div class="rayat-luxury-dashboard-empty-row">${historyState.loading ? t('luxuryDashLoadingHistory') : t('luxuryDashHistoricalEmpty')}</div>`;
                }

                return `
                    <div class="rayat-luxury-dashboard-history-scroll">
                        <table class="rayat-luxury-dashboard-history-table">
                            <thead>
                                <tr>
                                    <th>${t('time')}</th>
                                    <th>Umidita substrato</th>
                                    <th>EC substrato</th>
                                    <th>Temperatura substrato</th>
                                    <th>${t('status')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows.map((row) => {
                                    const levels = [
                                        getMetricLevel('soil', 'moisture', row.terreno),
                                        getMetricLevel('soil', 'ec', row.ec),
                                        getMetricLevel('soil', 'temperature', row.temperature)
                                    ];
                                    const level = getOverallLevel(levels);
                                    return `
                                        <tr>
                                            <td><strong>${formatLocalizedDate(row.date)}</strong><span>${formatLocalizedTime(row.date)}</span></td>
                                            <td>${formatHistoryNumber(row.terreno, { group: 'soil', key: 'moisture' })}%</td>
                                            <td>${formatHistoryNumber(row.ec, { group: 'soil', key: 'ec' })}</td>
                                            <td>${formatHistoryNumber(row.temperature, { group: 'soil', key: 'temperature' })} °C</td>
                                            <td><span class="rayat-luxury-dashboard-pill ${getLuxuryDashboardStatusClass(level)}">${getAlertBadgeLabel(level)}</span></td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                `;
            };
            const activityRows = alarms.length
                ? alarms.map((metric) => ({
                    icon: metric.iconName,
                    title: metric.label,
                    detail: formatPerliteRangeLabel(metric),
                    time: nowLabel,
                    level: metric.state.level,
                    status: metric.state.label
                }))
                : [{
                    icon: 'wifi',
                    title: isOnline ? t('luxuryDashNoAlert') : 'Substrate Rayat',
                    detail: isOnline ? 'Umidita substrato, EC substrato e temperatura substrato' : t('luxuryDashNoMeasuredValue'),
                    time: nowLabel,
                    level: isOnline ? 'normal' : 'unavailable',
                    status: isOnline ? t('statusNormal') : statusMeta.label
                }];

            return `
                <main class="rayat-luxury-dashboard-page">
                    <section id="rayat-luxury-dashboard-top" class="rayat-luxury-dashboard-main">
                        ${renderSubscriptionWarningBanner()}
                        <header class="rayat-luxury-dashboard-header">
                            <div>
                                <h1>RAYAT perlite track</h1>
                                <p>Monitoraggio Substrate Rayat per Barakah Perlite: umidita, EC e temperatura del substrato.</p>
                            </div>
                            <div class="rayat-luxury-dashboard-header-actions">
                                <button type="button" class="rayat-luxury-dashboard-refresh ${isRefreshingData ? 'is-loading' : ''}" onclick="refreshData()" ${isRefreshingData ? 'disabled' : ''} aria-label="${escapeHtml(t('refreshDataAction'))}">
                                    ${getLuxuryDashboardIcon('refresh')}
                                </button>
                                <button type="button" class="rayat-luxury-dashboard-top-icon" onclick="${hasPrivilegedAdminShortcut() ? 'goToAdminArea()' : "setView('profilo')"}">${getLuxuryDashboardIcon('settings')}</button>
                            </div>
                        </header>
                        <div class="rayat-luxury-dashboard-live-meta">
                            <span class="rayat-luxury-dashboard-online ${statusMeta.className}">${statusMeta.label}</span>
                            <span>${t('luxuryDashLastUpdateShort')}: <strong>${nowLabel}</strong></span>
                        </div>
                        <section class="rayat-luxury-dashboard-kpis" id="rayat-luxury-dashboard-kpis">
                            <article>${getLuxuryDashboardIcon('leaf')}<div><span>Customer</span><strong>DUROC</strong><em class="is-normal">Barakah Perlite Pilot Project</em></div></article>
                            <article>${getLuxuryDashboardIcon('wifi')}<div><span>${t('luxuryDashSensorsOnline')}</span><strong>${isOnline ? metrics.filter((metric) => metric.available).length : 0} <small>/ ${metrics.length}</small></strong><em class="${isOnline ? 'is-normal' : 'is-alert'}">${isOnline ? t('luxuryDashAllOnline') : statusMeta.label}</em></div></article>
                            <article>${getLuxuryDashboardIcon('clock')}<div><span>${t('luxuryDashLastUpdateCard')}</span><strong>${nowLabel}</strong><em class="${isOnline ? 'is-normal' : 'is-alert'}">${isOnline ? t('luxuryDashRealtimeData') : statusMeta.label}</em></div></article>
                            <article>${getLuxuryDashboardIcon('alert')}<div><span>${t('luxuryDashActiveAlarms')}</span><strong>${alarms.length}</strong><em class="${alarms.length ? 'is-alert' : 'is-normal'}">${alarms.length ? t('luxuryDashToMonitor') : t('luxuryDashNoAlert')}</em></div></article>
                        </section>
                        <section class="rayat-perlite-sensor-section">
                            <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-soil" id="rayat-luxury-dashboard-sensor-cards">
                                <div class="rayat-luxury-dashboard-card-head"><h2>Substrate Rayat</h2></div>
                                <div class="rayat-luxury-dashboard-professional-grid">
                                    ${metrics.map(renderMetric).join('')}
                                </div>
                            </article>
                        </section>
                        <article class="rayat-luxury-dashboard-card rayat-perlite-alert-panel" id="rayat-luxury-dashboard-activities">
                            <div class="rayat-perlite-alert-heading">
                                <div>
                                    <span>${t('activeAlertsTitle')}</span>
                                    <h2>${t('activeAlertsSubtitle')}</h2>
                                </div>
                                <strong>${alarms.length}</strong>
                            </div>
                            <div class="rayat-perlite-alert-list">
                                ${activityRows.map((activity) => `
                                    <div class="rayat-perlite-alert-row ${getLuxuryDashboardStatusClass(activity.level)}">
                                        <span class="rayat-perlite-alert-icon">${getLuxuryDashboardIcon(activity.icon)}</span>
                                        <div>
                                            <strong>${escapeHtml(activity.title)}</strong>
                                            <small>${escapeHtml(activity.detail)}</small>
                                        </div>
                                        <b>${escapeHtml(activity.status)}</b>
                                    </div>
                                `).join('')}
                            </div>
                        </article>
                        <article class="rayat-luxury-dashboard-card rayat-luxury-dashboard-trend rayat-history-measures" id="rayat-luxury-dashboard-history">
                            <div class="rayat-luxury-dashboard-card-head"><h2>${t('history')}</h2></div>
                            ${renderHistory()}
                        </article>
                    </section>
                </main>
            `;
        }

        // Admin settings removed

        // Admin dashboard removed
        // Admin functions removed: initAdminMap, toggleWeatherOverlay, exportAdminReport, loadAdminClients, renderAdminClients

        const mockClients = [
            // Souss-Massa Concentration (approx 70% of data)
            { id: 1, name: 'Farmer Ahmed', crop: 'Banane', lat: 30.4277, lng: -8.8755, online: true, locality: 'Taroudant', region: 'Souss-Massa', lastActive: '2 min ago' },
            { id: 2, name: 'Agrum-Agadir', crop: 'Orange', lat: 30.35, lng: -9.5, online: true, locality: 'Agadir', region: 'Souss-Massa', lastActive: 'Just now' },
            { id: 3, name: 'Souss Green', crop: 'Tomatoes', lat: 30.1, lng: -9.5, online: true, locality: 'Chtouka', region: 'Souss-Massa', lastActive: '5 min ago' },
            { id: 4, name: 'Tiznit Olives', crop: 'Olive', lat: 29.7, lng: -9.7, online: false, locality: 'Tiznit', region: 'Souss-Massa', lastActive: '2 days ago' },
            { id: 5, name: 'Bio-Banana', crop: 'Banane', lat: 30.45, lng: -8.8, online: true, locality: 'Taroudant', region: 'Souss-Massa', lastActive: '1 min ago' },
            { id: 6, name: 'Oulad Teima Co-op', crop: 'Citrus', lat: 30.4, lng: -9.2, online: true, locality: 'Oulad Teima', region: 'Souss-Massa', lastActive: '10 min ago' },
            { id: 7, name: 'Massa Berries', crop: 'Strawberry', lat: 30.0, lng: -9.55, online: true, locality: 'Massa', region: 'Souss-Massa', lastActive: '4 min ago' },
            { id: 8, name: 'Biougra Farm', crop: 'Peppers', lat: 30.2, lng: -9.3, online: false, locality: 'Biougra', region: 'Souss-Massa', lastActive: '1 hour ago' },
            { id: 9, name: 'Ait Melloul Agri', crop: 'Flowers', lat: 30.3, lng: -9.4, online: true, locality: 'Ait Melloul', region: 'Souss-Massa', lastActive: 'Just now' },
            { id: 10, name: 'Taroudant South', crop: 'Olive', lat: 30.4, lng: -8.9, online: true, locality: 'Taroudant', region: 'Souss-Massa', lastActive: '15 min ago' },
            ...Array.from({length: 24}, (_, i) => ({
                id: 20 + i,
                name: `Client Souss ${i + 11}`,
                crop: ['Tomato', 'Citrus', 'Banana', 'Berries'][Math.floor(Math.random() * 4)],
                lat: 30.0 + (Math.random() * 0.5),
                lng: -9.55 + (Math.random() * 0.75),
                online: true,
                locality: 'Souss Area',
                region: 'Souss-Massa',
                lastActive: 'Just now'
            })),

            // Other Regions (National Presence)
            { id: 101, name: 'Casa-Horti', crop: 'Corn', lat: 33.5, lng: -7.6, online: true, locality: 'Bouskoura', region: 'Casablanca-Settat', lastActive: '20 min ago' },
            { id: 102, name: 'Rabat-Green', crop: 'Grapes', lat: 33.9, lng: -6.8, online: false, locality: 'Temara', region: 'Rabat-Sale-Kenitra', lastActive: 'Yesterday' },
            { id: 103, name: 'Marrakech Dates', crop: 'Dates', lat: 31.6, lng: -8.0, online: true, locality: 'Tahanaout', region: 'Marrakech-Safi', lastActive: '3 min ago' },
            { id: 104, name: 'Fez-Olive', crop: 'Olive', lat: 34.0, lng: -5.0, online: true, locality: 'Sefrou', region: 'Fes-Meknes', lastActive: '1 hour ago' },
            { id: 105, name: 'Tanger-Agri', crop: 'Wheat', lat: 35.7, lng: -5.8, online: false, locality: 'Asilah', region: 'Tanger-Tetouan-Al Hoceima', lastActive: '3 days ago' },
            { id: 106, name: 'Oujda-Field', crop: 'Almond', lat: 34.6, lng: -1.9, online: true, locality: 'Berkane', region: 'Oriental', lastActive: '45 min ago' },
            { id: 107, name: 'Beni Mellal Sugar', crop: 'Sugar Beet', lat: 32.3, lng: -6.3, online: true, locality: 'Fquih Ben Salah', region: 'Beni Mellal-Khenifra', lastActive: '12 min ago' },
            { id: 108, name: 'Errachidia-Palms', crop: 'Dates', lat: 31.9, lng: -4.4, online: true, locality: 'Erfoud', region: 'Draa-Tafilalet', lastActive: '8 min ago' },
            { id: 109, name: 'Dakhla-Ocean', crop: 'Melon', lat: 23.7, lng: -15.9, online: false, locality: 'Dakhla', region: 'Dakhla-Oued Ed-Dahab', lastActive: '1 week ago' },
            { id: 110, name: 'Laayoune-Dry', crop: 'Forage', lat: 27.1, lng: -13.2, online: true, locality: 'El Marsa', region: 'Laayoune-Sakia El Hamra', lastActive: '2 hours ago' }
        ];

        let contactSettings = JSON.parse(localStorage.getItem('contactSettings')) || {
            founderName: 'Zakaria Abid',
            founderRole: 'Fondatore / Responsabile progetto Rayat',
            phoneItaly: '+39 351 320 3307',
            phoneMorocco: '+212 628 265466',
            whatsapp: WHATSAPP_DISPLAY_NUMBER,
            email: 'zakariaabid544@gmail.com',
            officeName: 'Rayat Agriculture Technology',
            officeCity: 'Taroudant',
            officeRegion: 'Souss-Massa',
            officeCountry: 'Marocco',
            officeAddress: 'Business Building, Taroudant',
            lat: 30.4703,
            lng: -8.8770
        };
        if (contactSettings.email === 'zakariaabid@hotmail.it') {
            contactSettings.email = 'zakariaabid544@gmail.com';
            localStorage.setItem('contactSettings', JSON.stringify(contactSettings));
        }
        contactSettings.whatsapp = WHATSAPP_DISPLAY_NUMBER;

        let registrationStep = 1;
        let registrationData = {
            // RAYAT FIX - registration/admin
            name: '', last_name: '', phone: '', email: '', password: '',
            crop_type: '', latitude: null, longitude: null, location_name: '', location_address: ''
        };

        /* PATCH-02 — start */
        function normalizeRegistrationCropValue(value) {
            const normalized = String(value || '').trim().toLowerCase();
            return REGISTER_CROPS.includes(normalized) ? normalized : '';
        }

        function getRegistrationCropLabel(crop) {
            const translationKey = `crop.${crop}`;
            const translatedValue = t(translationKey);
            return translatedValue === translationKey ? crop : translatedValue;
        }

        function renderCropOptions(selectedCrop = '') {
            const normalizedSelectedCrop = normalizeRegistrationCropValue(selectedCrop);
            return REGISTER_CROPS
                .map((crop) => ({
                    value: crop,
                    label: getRegistrationCropLabel(crop),
                    selected: normalizedSelectedCrop === crop
                }))
                .map((crop) => `
                    <button onclick="selectCrop('${crop.value}')" class="p-3 border-2 rounded-xl text-sm text-center transition ${crop.selected ? 'border-green-600 bg-white font-bold text-green-800' : 'border-green-100 bg-white/80 hover:border-green-300'}">
                        ${escapeHtml(crop.label)}
                    </button>
                `)
                .join('');
        }
        /* PATCH-02 — end */

        function render() {
            if (currentView === 'home' || currentView === 'demo' || currentView === 'perlite-track' || currentView === 'profilo') {
                checkAlerts();
            }
            const app = document.getElementById('app');
            const routes = {
                'home': renderHomePage,
                'chi-siamo': renderChiSiamoPage,
                'login': renderLoginPage,
                'profilo': renderUserProfilePage,
                'servizi': renderServiziPage,
                'demo': renderDemoPage,
                'dashboard': renderDemoPage,
                'perlite-track': renderPerliteTrackPage,
                'register': renderRegisterPage,
                'contatti': renderContactPage,
                'privacy': renderPrivacyPage,
                'terms': renderTermsPage,
                'reset-password': renderResetPasswordPage
            };

            const viewFn = routes[currentView] || renderHomePage;
            app.innerHTML = `${viewFn()}${renderPublicWhatsappButton()}`;
            syncPageScrollLock();
            syncAppShellState();
            syncStaticI18n();

            // Post-render initialization
            // Post-render initialization
            if (currentView === 'contatti') initContactMap();
            if (currentView === 'home') initHomeMap();
            if (currentView === 'home') setTimeout(initLuxuryHomeSectionAnimations, 0);
            if (currentView === 'demo') initLuxuryDashboardMap();
            if (currentView === 'register') {
                 // Map initialization for registration is handled inside renderRegisterPage
                 // but we can ensure it here too if needed.
            }
            invalidateVisibleMaps();
            // removed render post-init chart calls
        }

        // removed initHistoryChart function

        // Initialize
        restorePublicSession();
        const hadAdminShortcutOnLoad = hasPrivilegedAdminShortcut();
        ensurePrivilegedAdminSession().then(() => {
            if (hadAdminShortcutOnLoad !== hasPrivilegedAdminShortcut() && currentView !== 'profilo') {
                render();
                requestViewData(currentView);
            }
        }).catch(() => {});
        currentView = getViewFromPath(window.location.pathname);
        if (currentView === 'demo') {
            syncDashboardSensorFromPath(window.location.pathname);
        }
        if (currentView === 'profilo' && !isAuthenticated()) {
            if (hasPrivilegedAdminShortcut()) {
                goToAdminArea();
            } else {
                currentView = 'login';
                history.replaceState({ view: 'login' }, '', '/login');
            }
        } else if (currentView === 'profilo' && !isCustomerRole(currentRole)) {
            if (hasPrivilegedAdminShortcut()) {
                goToAdminArea();
            } else {
                currentView = 'login';
                history.replaceState({ view: 'login' }, '', '/login');
            }
        }
        resetLiveSensorDisplayData();
        resetSensorConnectionState();
        render();
        trackPageView(currentView);
        if (currentView === 'register') {
            trackRegistrationStart(currentView);
        }

        // Hard sync live data.
        requestViewData(currentView);
        setInterval(() => {
            if (currentView === 'demo' || currentView === 'perlite-track') {
                loadSensorData().catch(() => {});
                if ((Date.now() - historyState.lastLoadedAt) >= 60000) {
                    loadHistoryData().catch(() => {});
                }
            }
        }, PUBLIC_SENSOR_POLL_INTERVAL_MS);
        setInterval(() => {
            if (currentView === 'home') {
                loadSensorData().catch(() => {});
            }
        }, HOMEPAGE_LIVE_SENSOR_POLL_INTERVAL_MS);

        // Handle Android hardware back button and browser back
        window.onpopstate = function (event) {
            if (event.state && event.state.view) {
                currentView = normalizePublicDashboardView(event.state.view);
                if (currentView === 'demo') {
                    syncDashboardSensorFromPath(window.location.pathname);
                }
                if (currentView === 'perlite-track' && !canAccessPerliteTrack()) {
                    currentView = 'login';
                    history.replaceState({ view: 'login' }, '', '/login');
                }
                render();
                trackPageView(currentView);
                requestViewData(currentView);
            } else if (window.location.pathname) {
                currentView = getViewFromPath(window.location.pathname);
                if (currentView === 'demo') {
                    syncDashboardSensorFromPath(window.location.pathname);
                }
                if (currentView === 'perlite-track' && !canAccessPerliteTrack()) {
                    currentView = 'login';
                    history.replaceState({ view: 'login' }, '', '/login');
                }
                render();
                trackPageView(currentView);
                requestViewData(currentView);
            } else if (currentView !== 'home') {
                // Return to home if no specific state (simulates Android "exit to home" before closing)
                currentView = 'home';
                render();
                trackPageView(currentView);
            }
        };

        // Initialize state
        history.replaceState({ view: currentView }, '', `${window.location.pathname}${window.location.search}${window.location.hash}`);

        document.addEventListener('click', (event) => {
            if (!event.target.closest('[data-lang-menu-toggle="true"]') && !event.target.closest('#lang-menu')) {
                document.getElementById('lang-menu')?.classList.add('hidden');
            }

            if (!event.target.closest('#rayat-profile-menu-shell')) {
                closeProfileMenu();
            }

            if (!event.target.closest('.rayat-luxury-dashboard-profile-menu')) {
                closeLuxuryDashboardProfileMenu();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') {
                return;
            }

            if (isMobileMenuOpen) {
                toggleMobileMenu(false);
            }

            if (isLuxuryDashboardSidebarOpen) {
                toggleLuxuryDashboardSidebar(false);
            }

            document.getElementById('lang-menu')?.classList.add('hidden');
            closeProfileMenu();
            closeLuxuryDashboardProfileMenu();
        });

        // RAYAT FIX - checkbox remember me + desktop scroll
        window.addEventListener('resize', () => {
            if (!isViewportAtMost(768) && isMobileMenuOpen) {
                toggleMobileMenu(false);
            } else if (!isViewportAtMost(900) && isLuxuryDashboardSidebarOpen) {
                toggleLuxuryDashboardSidebar(false);
            } else {
                syncPageScrollLock();
            }
            invalidateVisibleMaps();
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                syncPageScrollLock();
                invalidateVisibleMaps();
            }
        });

        window.addEventListener('pageshow', () => {
            syncPageScrollLock();
        });

        // RAYAT FIX - mobile app ready optimization
        window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', () => {
            syncAppShellState();
        });

        // Capacitor: Network Connectivity Handler
        if (window.Capacitor && window.Capacitor.Plugins.Network) {
            window.Capacitor.Plugins.Network.addListener('networkStatusChange', status => {
                if (!status.connected) {
                    setOfflineBannerVisibility(true, t('usingCache'));
                } else {
                    setOfflineBannerVisibility(false);
                    loadSensorData();
                }
            });
        }

        // PWA Service Worker Registration
        if (isCapacitorNativeRuntime() && 'serviceWorker' in navigator) {
            const registrationsPromise = typeof navigator.serviceWorker.getRegistrations === 'function'
                ? navigator.serviceWorker.getRegistrations()
                : Promise.resolve([]);
            registrationsPromise
                .then(registrations => registrations.forEach(registration => registration.unregister()))
                .catch(() => {});
        } else if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register(`/sw.js?v=${FRONTEND_ASSET_VERSION}`, { updateViaCache: 'none' })
                    .then(reg => {
                        reg.update().catch(() => {});
                    })
                    .catch(err => console.error('SW registration failed', err));
            });
        }
