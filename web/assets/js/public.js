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
        const FRONTEND_ASSET_VERSION = '1.1.36'; // RAYAT-FIX
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
        let showSettings = false;
        let showNotifications = false;
        let isMobileMenuOpen = false;
        let isProfileMenuOpen = false;
        let isAdminView = false;
        let dataError = false; // Track API availability
        const CUSTOMER_ROLES = new Set(['client', 'farmer']);
        const ADMIN_ROLES = new Set(['admin', 'super_admin', 'operator', 'operator_admin']);
        const PRIVILEGED_ADMIN_ROLES = new Set(['super_admin', 'admin', 'operator_admin', 'operator']);
        const BARAKAH_PERLITE_EMAIL = 'support@barakahperlite.com';
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

        function isBarakahPerliteClientSession(userData = user, role = currentRole) {
            return isAuthenticated() && isCustomerRole(role) && isBarakahPerliteCustomer(userData);
        }

        function normalizeViewForCurrentUser(view) {
            return view === 'demo' && isBarakahPerliteClientSession() ? 'perlite-track' : view;
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

        function getPathForView(view) {
            return VIEW_PATHS[view] || '/';
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

        // RAYAT FIX - checkbox remember me + desktop scroll
        function syncBodyScrollLock() {
            const shouldLockScroll = ((isMobileMenuOpen && window.innerWidth <= 768) || isSubscriptionModalOpen);
            document.documentElement.classList.toggle('rayat-scroll-locked', shouldLockScroll);
            document.body.classList.toggle('rayat-scroll-locked', shouldLockScroll);
            document.body.classList.toggle('rayat-menu-open', shouldLockScroll);

            if (shouldLockScroll) {
                document.documentElement.style.overflow = 'hidden';
                document.documentElement.style.setProperty('overscroll-behavior', 'none');
                document.body.style.overflow = 'hidden';
                document.body.style.setProperty('overscroll-behavior', 'none');
                return;
            }

            document.documentElement.style.removeProperty('overflow');
            document.documentElement.style.removeProperty('overscroll-behavior');
            document.body.style.removeProperty('overflow');
            document.body.style.removeProperty('overscroll-behavior');
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

            syncBodyScrollLock();
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
            if (view === 'login') return 'Login Click';
            if (view === 'contatti') return 'Contact Click';
            if (view === 'demo') return 'Demo Request Click';
            return '';
        }

        function trackNavigationEvent(view) {
            trackEvent(getNavigationEventName(view));
        }

        function setViewWithTracking(view, options = {}) {
            trackNavigationEvent(view);
            setView(view, options);
        }

        function setLanguage(lang) {
            currentLang = lang;
            localStorage.setItem('rayat_lang', lang);
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
                metric.timestamp = null;
            });
            sensorData.clima.valore = null;
            sensorData.clima.percentuale = 0;
            sensorData.clima.details.forEach((metric) => {
                metric.value = null;
                metric.timestamp = null;
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

        async function fetchGatewayStatusPayload(requestScope) { // RAYAT-FIX
            const isPrivateScope = requestScope === 'private'; // RAYAT-FIX
            const endpoint = isPrivateScope ? CONFIG.PRIVATE_GATEWAY_STATUS_URL : CONFIG.PUBLIC_GATEWAY_STATUS_URL; // RAYAT-FIX
            const response = await fetch(`${endpoint}?t=${Date.now()}`, { // RAYAT-FIX
                cache: 'no-store', // RAYAT-FIX
                headers: isPrivateScope ? { 'Authorization': `Bearer ${authToken}` } : undefined // RAYAT-FIX
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
            if (!isAuthenticated() || !isCustomerRole(currentRole) || currentView !== 'demo') {
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
            period: '24h',
            customStart: null,
            customEnd: null
        };
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

            const requestKey = [
                isAuthenticated() && isCustomerRole(currentRole) ? 'private' : 'public',
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

                    if (isAuthenticated() && isCustomerRole(currentRole)) {
                        response = await fetch(`${CONFIG.API_BASE_URL}/sensors/${selectedSensor}/history?${params.toString()}`, {
                            headers: { 'Authorization': `Bearer ${authToken}` },
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
            filterState.period = period;
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
            await loadHistoryData();
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
            closeProfileMenu();
            view = normalizeViewForCurrentUser(view);

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
                setView('login', { replace: true, path: '/login' });
                return;
            }

            if (view !== 'profilo') {
                userProfileNotice = '';
            }

            const nextPath = options.path || getPathForView(view);
            isMobileMenuOpen = false;
            syncBodyScrollLock();

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

            const requestScope = !isAuthenticated()
                ? 'public'
                : (isCustomerRole(currentRole) ? 'private' : 'skip');

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
                                const data = result.data; // RAYAT-FIX
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
                        const didRender = updateSensorData(cached.data, true); // RAYAT-FIX
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
                        fetch(`${CONFIG.API_BASE_URL}/sensors/latest`, { headers: { 'Authorization': `Bearer ${authToken}` } }), // RAYAT-FIX
                        fetchGatewayStatusPayload('private') // RAYAT-FIX
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
            const normalizedApiData = normalizeSoilApiPayloadRows(apiData, { includeTimestamp: true });
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
                    if (d) {
                        d.value = val;
                        d.timestamp = r.timestamp || null;
                        updated = true;
                    }
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
            showSettings = !showSettings;
            render();
        }

        function toggleNotifications() {
            showNotifications = !showNotifications;
            render();
        }

        function saveSettings(e) {
            e.preventDefault();
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
                syncBodyScrollLock();
                
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
            syncBodyScrollLock();
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
                : { id: 'demo', view: 'demo', label: t('demo'), tracked: true };
            const primaryLinks = [
                { id: 'home', view: 'home', label: t('home') },
                { id: 'chi-siamo', view: 'chi-siamo', label: t('aboutUs') },
                { id: 'servizi', view: 'servizi', label: t('services') },
                fieldNavigationLink,
                { id: 'contatti', view: 'contatti', label: t('contactTitle'), tracked: true }
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

        function renderHomePage() {
            return `
                ${renderHeader(!!user)}
                
                <section class="rayat-hero">
                    <div class="rayat-hero-orb rayat-hero-orb--one"></div>
                    <div class="rayat-hero-orb rayat-hero-orb--two"></div>
                    <div class="container mx-auto px-4">
                        <div class="rayat-hero-shell">
                            <div class="rayat-hero-kicker">${t('heroEyebrow')}</div>
                            <!-- RAYAT FIX - forza il titolo hero su tre righe controllate -->
                            <h1 class="rayat-hero-title rayat-fade-up">
                                <span class="rayat-hero-title-line rayat-hero-title-line--primary">${t('heroTitleLine1')}</span>
                                <span class="rayat-hero-title-line rayat-hero-title-line--secondary">${t('heroTitleLine2')}</span>
                                <span class="rayat-hero-title-line rayat-hero-title-line--accent rayat-hero-accent">${t('heroTitleAccent')}</span>
                            </h1>
                            <p class="rayat-hero-subtitle rayat-fade-in">${t('heroPlatformSub')}</p>
                            <div class="rayat-mobile-actions flex gap-4 justify-center">
                                <button onclick="setViewWithTracking('demo')" class="bg-orange-500 hover:bg-orange-600 px-8 py-4 rounded-2xl text-lg font-semibold transition transform hover:scale-105 min-h-[56px] shadow-xl shadow-orange-950/20">
                                ${t('tryDemo')}
                                </button>
                                <button onclick="setView('servizi')" class="bg-white text-green-800 px-8 py-4 rounded-2xl text-lg font-semibold transition transform hover:scale-105 min-h-[56px] shadow-xl shadow-green-950/10">
                                ${t('discoverServices')}
                                </button>
                            </div>
                        </div>
                    </div>
                </section>

                ${renderHomeTechnologySection()}
                ${renderHomeLiveSensorsSection()}
                <section class="py-16 bg-gradient-to-b from-white to-green-50" id="chi-siamo-section">
                    <div class="container mx-auto px-4">
                        <h3 class="text-4xl font-bold text-center mb-4 text-green-800">${t('aboutUs')}</h3>
                        <p class="text-xl text-center text-gray-600 mb-12">${t('ourReality')}</p>
                        
                        <div class="max-w-4xl mx-auto bg-white rounded-2xl shadow-xl p-8 md:p-12 mb-12">
                            <div class="space-y-8">
                                <div class="border-l-4 border-green-600 pl-6">
                                    <h4 class="text-2xl font-bold mb-3 text-green-700"><span style="filter: sepia(100%) hue-rotate(70deg) saturate(500%) brightness(0.7);">🌾</span> ${t('ourReality')}</h4>
                                    <p class="text-lg text-gray-700 leading-relaxed">${t('ourRealityDesc')}</p>
                                </div>
                                <div class="border-l-4 border-blue-600 pl-6">
                                    <h4 class="text-2xl font-bold mb-3 text-blue-700">🎯 ${t('ourMission')}</h4>
                                    <p class="text-lg text-gray-700 leading-relaxed">${t('ourMissionDesc')}</p>
                                </div>
                                <div class="border-l-4 border-orange-600 pl-6">
                                    <h4 class="text-2xl font-bold mb-3 text-orange-700">🤝 ${t('ourDuty')}</h4>
                                    <p class="text-lg text-gray-700 leading-relaxed">${t('ourDutyDesc')}</p>
                                    <ul class="mt-4 space-y-3 text-gray-700">
                                        <li><strong>✓ ${t('support247')}</strong></li>
                                        <li><strong>✓ ${t('training')}</strong></li>
                                        <li><strong>✓ ${t('transparency')}</strong></li>
                                        <li><strong>✓ ${t('customSolutions')}</strong></li>
                                        <li><strong>✓ ${t('qualityGuaranteed')}</strong></li>
                                    </ul>
                                </div>
                                <div class="bg-gradient-to-r from-green-600 to-green-800 text-white p-6 rounded-xl text-center">
                                    <p class="text-xl font-semibold mb-2">💚 ${t('ourCommitment')}</p>
                                    <p class="text-lg">${t('ourCommitmentDesc')}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <!-- Live Map Section (Moved below Chi Siamo) -->
                <section class="py-12 bg-gray-50 border-b">
                    <div class="container mx-auto px-4">
                        <div class="flex flex-col md:flex-row justify-between items-end mb-8 gap-6">
                            <div>
                                <h3 class="text-3xl font-black text-green-800 uppercase tracking-tighter mb-2">${t('mapTitle')}</h3>
                                <p class="text-gray-600 font-medium">${t('mapSub')}</p>
                            </div>
                            <!-- Live Stats -->
                            <div class="flex gap-4">
                                <div class="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 text-center min-w-[120px]">
                                    <div class="text-2xl font-black text-green-600">34</div>
                                    <div class="text-[10px] text-gray-400 font-bold uppercase tracking-widest">${t('statOnline')}</div>
                                </div>
                                <div class="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 text-center min-w-[120px]">
                                    <div class="text-2xl font-black text-orange-600">>500</div>
                                    <div class="text-[10px] text-gray-400 font-bold uppercase tracking-widest">${t('statMa')}</div>
                                </div>
                                <div class="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 text-center min-w-[120px]">
                                    <div class="text-2xl font-black text-green-800">112</div>
                                    <div class="text-[10px] text-gray-400 font-bold uppercase tracking-widest">${t('statSouss')}</div>
                                </div>
                            </div>
                        </div>

                        <div class="bg-white p-2 rounded-[2.5rem] shadow-2xl overflow-hidden border-4 border-white rayat-map-shell rayat-home-map-card">
                            <div class="rayat-home-map-header">
                                <div class="rayat-home-map-badge">
                                    📍 ${t('mapFocusArea')}: Souss-Massa
                                </div>
                            </div>

                            <div class="rayat-home-map-layout">
                                <!-- Legend -->
                                <div class="bg-white/90 backdrop-blur-md p-6 rounded-3xl shadow-2xl border border-white/50 space-y-4 rayat-home-map-legend">
                                    <div class="flex items-center gap-4">
                                        <div class="w-4 h-4 marker-online shadow-none"></div>
                                        <span class="text-xs font-black text-gray-700 uppercase tracking-widest">${t('mapLegendOnline')}</span>
                                    </div>
                                    <div class="flex items-center gap-4">
                                        <div class="w-4 h-4 bg-gray-300 border border-white rounded-full"></div>
                                        <span class="text-xs font-black text-gray-500 uppercase tracking-widest">${t('mapLegendOffline')}</span>
                                    </div>
                                    <div class="h-[1px] bg-gray-200 my-2"></div>
                                    <div class="flex items-center gap-4">
                                        <div class="w-5 h-5 bg-green-100 border-2 border-green-300 rounded-lg"></div>
                                        <span class="text-[10px] font-black text-green-700 uppercase tracking-widest">${t('mapFocusArea')}: Souss-Massa</span>
                                    </div>
                                </div>

                                <div class="rayat-home-map-canvas">
                                    <div id="home-map" style="height: 600px; width: 100%; z-index: 10;" class="rounded-[2rem]"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                ${renderHomepageWhatsappSection()}

                ${renderFooter()}
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
                                                <strong>GW-001</strong>
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


        function renderDemoPage() {
            if (isBarakahPerliteClientSession()) {
                return renderPerliteTrackPage();
            }

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
                                    <button onclick="exportCSV()" class="bg-[#10b981] hover:bg-green-700 text-white px-6 py-3 rounded-xl font-bold uppercase tracking-tight text-[11px] shadow-xl transition-all shrink-0 flex items-center gap-2">📥 <span>${t('export')}</span></button>
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

        function renderPerliteTrackPage() {
            if (!canAccessPerliteTrack()) {
                return renderLoginPage();
            }

            selectedSensor = 'terreno';
            const statusMeta = getDemoSectionStatusMeta('terreno');
            const isPerliteOffline = statusMeta.className === 'is-offline';
            const perliteLastUpdate = statusMeta.timestamp && statusMeta.timestamp !== '--'
                ? statusMeta.timestamp
                : 'Waiting for sensor data';
            const perliteMetricDefinitions = [
                {
                    key: 'temperature',
                    label: 'Temperatura substrato',
                    icon: '🌡️',
                    range: { min: 18, max: 26, unit: '°C' },
                    rangeLabel: 'Range indicativo per pomodoro in serra'
                },
                {
                    key: 'ec',
                    label: 'EC substrato',
                    icon: '⚡',
                    range: { min: 2.0, max: 3.5, unit: 'mS/cm' },
                    rangeLabel: 'Range indicativo per substrato perlite'
                },
                {
                    key: 'moisture',
                    label: 'Umidità substrato',
                    icon: '💧',
                    range: { min: 55, max: 75, unit: '%' },
                    rangeLabel: 'Range indicativo per coltura fuori suolo'
                }
            ];
            const rawPerliteMetrics = perliteMetricDefinitions.map((definition) => {
                const metric = sensorData.terreno.details.find((item) => item.key === definition.key) || {};
                return {
                    ...metric,
                    ...definition
                };
            });
            const freshestPerliteTimestamp = Math.max(
                0,
                ...rawPerliteMetrics
                    .map((metric) => new Date(metric.timestamp || 0).getTime())
                    .filter((timestamp) => Number.isFinite(timestamp))
            );
            const perliteMetrics = rawPerliteMetrics.map((metric) => {
                const metricTimestamp = new Date(metric.timestamp || 0).getTime();
                const isCurrentFrameMetric = freshestPerliteTimestamp > 0
                    && Number.isFinite(metricTimestamp)
                    && Math.abs(freshestPerliteTimestamp - metricTimestamp) <= 120000;

                return isCurrentFrameMetric
                    ? metric
                    : { ...metric, value: null, installed: false };
            });
            const historyRows = getFilteredHistory();
            const renderPerliteMetricCard = (metric) => {
                const normalizedValue = normalizeMetricValue('soil', metric.key, metric.value);
                const hasLiveValue = metric.installed !== false && Number.isFinite(normalizedValue);
                const state = hasLiveValue
                    ? getMetricState(normalizedValue, metric.range)
                    : {
                        level: isPerliteOffline ? 'offline' : 'loading',
                        cssModifier: 'rayat-metric-card--inactive',
                        label: isPerliteOffline ? 'Offline' : 'Waiting for sensor data'
                    };
                const gauge = metric.range ? getGaugeMeta('soil', metric.key, metric.range) : null;
                const gaugeMarkerPercent = hasLiveValue && gauge
                    ? getGaugeMarkerPercent(normalizedValue, gauge.min, gauge.max)
                    : null;
                const unit = metric.range?.unit || metric.unit || '';
                const rangeUnitSuffix = metric.range?.unit ? ` ${metric.range.unit}` : '';
                const rangeText = metric.range
                    ? `${metric.rangeLabel}: ${formatMetricValue(metric.range.min)} – ${formatMetricValue(metric.range.max)}${rangeUnitSuffix}`
                    : metric.rangeLabel;
                const stateClass = hasLiveValue ? getLevelClass(state.level) : 'text-slate-500';

                return `
                    <article class="rayat-metric-card ${hasLiveValue ? state.cssModifier : 'rayat-metric-card--inactive'}" data-metric-key="${metric.key}">
                        <div class="rayat-metric-card-head mb-4">
                            <div class="rayat-metric-card-header-main">
                                <span class="rayat-metric-card-icon">${metric.icon}</span>
                                <div class="rayat-metric-card-copy">
                                    <p class="rayat-metric-card-title">${escapeHtml(metric.label)}</p>
                                    <p class="rayat-metric-card-state ${stateClass}">${escapeHtml(state.label)}</p>
                                </div>
                            </div>
                            ${hasLiveValue && state.badge ? `<span class="rayat-alert-badge ${state.level === 'alert' ? 'rayat-alert-badge--alert' : 'rayat-alert-badge--attention'}">${state.badge}</span>` : ''}
                        </div>
                        <div class="flex items-end gap-2 mb-5">
                            ${hasLiveValue ? `
                                <span class="text-5xl font-black text-slate-900 leading-none">${formatMetricValue(normalizedValue)}</span>
                                <span class="text-sm font-bold text-slate-400 uppercase">${unit}</span>
                            ` : `
                                <span class="text-4xl font-black text-slate-300 leading-none">N/A</span>
                            `}
                        </div>
                        ${gauge ? `
                            <div class="rayat-range-track-shell">
                                <div class="rayat-range-track" style="background:${gauge.gradient};">
                                    ${gaugeMarkerPercent !== null ? `<div class="rayat-range-pointer" style="left:${gaugeMarkerPercent}%;" aria-hidden="true"></div>` : ''}
                                </div>
                            </div>
                            <div class="flex justify-between text-[11px] font-semibold text-slate-400 mt-3">
                                <span>${formatMetricValue(gauge.min)}${unit ? ` ${unit}` : ''}</span>
                                <span>${formatMetricValue(gauge.max)}${unit ? ` ${unit}` : ''}</span>
                            </div>
                        ` : ''}
                        <p class="rayat-metric-card-range ${hasLiveValue && state.level !== 'normal' ? getLevelClass(state.level) : 'text-slate-600'}">${escapeHtml(rangeText || 'Waiting for sensor data')}</p>
                    </article>
                `;
            };
            const renderPerliteHistoryRows = () => {
                if (!historyRows.length) {
                    return `
                        <tr class="rayat-history-row">
                            <td colspan="5" class="py-10 text-center text-sm font-semibold text-slate-400">
                                ${historyState.loading ? 'Caricamento storico in corso...' : 'Nessun dato substrate disponibile per il periodo selezionato.'}
                            </td>
                        </tr>
                    `;
                }

                return historyRows.map((row) => {
                    const levels = [
                        getMetricLevel('soil', 'temperature', row.temperature),
                        getMetricLevel('soil', 'ec', row.ec),
                        getMetricLevel('soil', 'moisture', row.terreno)
                    ];

                    return `
                        <tr class="rayat-history-row hover:bg-gray-50 transition duration-300">
                            <td class="rayat-history-time-cell">
                                <div class="rayat-history-time-primary">${formatLocalizedDate(row.date)}</div>
                                <div class="rayat-history-time-secondary">${formatLocalizedTime(row.date)}</div>
                            </td>
                            <td class="rayat-history-value-cell ${getLevelClass(levels[0])}">${formatHistoryNumber(row.temperature, { group: 'soil', key: 'temperature' })}</td>
                            <td class="rayat-history-value-cell ${getLevelClass(levels[1])}">${formatHistoryNumber(row.ec, { group: 'soil', key: 'ec' })}</td>
                            <td class="rayat-history-value-cell ${getLevelClass(levels[2])}">${formatHistoryNumber(row.terreno, { group: 'soil', key: 'moisture' })}</td>
                            ${renderHistoryStatusCell(getOverallLevel(levels))}
                        </tr>
                    `;
                }).join('');
            };

            return `
                ${renderHeader(!!user)}
                <section class="rayat-demo-page py-24 bg-gray-50 min-h-screen">
                    <div class="rayat-demo-shell container mx-auto px-4 max-w-[1300px]">
                        ${renderSubscriptionWarningBanner()}
                        <div class="rayat-monitoring-toolbar rayat-monitoring-toolbar--demo-only">
                            <div class="rayat-monitoring-toolbar__copy">
                                <h2 class="rayat-monitoring-toolbar__title">RAYAT perlite track</h2>
                                <p class="rayat-monitoring-toolbar__subtitle">Pilot project per pomodoro in serra su substrato Barakah Perlite.</p>
                            </div>
                        </div>

                        <div class="rayat-demo-panel bg-white rounded-[4rem] shadow-[-20px_40px_100px_rgba(0,0,0,0.1)] p-12 md:p-20 border border-gray-50 relative overflow-hidden">
                            <div class="relative z-10">
                                <div class="rayat-demo-section-heading">
                                    <div class="rayat-demo-section-heading__row">
                                        <h4 class="rayat-demo-section-heading__title">Substrate Rayat</h4>
                                        <div class="rayat-demo-section-heading__meta">
                                            <span class="rayat-demo-section-heading__badge ${statusMeta.className}">
                                                <span class="rayat-demo-section-heading__status ${statusMeta.className}" aria-hidden="true"></span>
                                                <span class="rayat-demo-section-heading__badge-text">${escapeHtml(statusMeta.label)}</span>
                                                <span class="rayat-demo-section-heading__separator" aria-hidden="true">&middot;</span>
                                                <span class="rayat-demo-section-heading__timestamp">${escapeHtml(statusMeta.timestamp)}</span>
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                <div class="mb-8 rounded-[2rem] border border-green-100 bg-gradient-to-br from-green-50 via-white to-emerald-50 px-6 py-6 md:px-8 md:py-7 shadow-[0_24px_70px_rgba(22,101,52,0.08)]">
                                    <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
                                        <div>
                                            <p class="text-xs font-black uppercase tracking-[0.24em] text-green-700 mb-2">Barakah Perlite Pilot Project</p>
                                            <h5 class="text-2xl md:text-3xl font-black text-slate-900 tracking-tight">Tomatoes grown in greenhouse</h5>
                                            <p class="mt-3 text-sm font-semibold text-slate-500">Last real update: ${escapeHtml(perliteLastUpdate)}</p>
                                        </div>
                                        <span class="rayat-demo-section-heading__badge ${statusMeta.className} self-start">
                                            <span class="rayat-demo-section-heading__status ${statusMeta.className}" aria-hidden="true"></span>
                                            <span class="rayat-demo-section-heading__badge-text">${escapeHtml(isPerliteOffline ? 'Offline' : statusMeta.label)}</span>
                                        </span>
                                    </div>
                                    <dl class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-7">
                                        ${[
                                            ['Crop', 'Tomatoes grown in greenhouse'],
                                            ['Location', 'Souss-Massa, Morocco'],
                                            ['Substrate', 'Barakah Perlite'],
                                            ['Monitoring', 'Rayat Smart Monitoring']
                                        ].map(([label, value]) => `
                                            <div class="rounded-2xl bg-white/80 border border-green-100 px-4 py-4">
                                                <dt class="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">${label}</dt>
                                                <dd class="mt-1 text-sm font-black text-slate-800">${value}</dd>
                                            </div>
                                        `).join('')}
                                    </dl>
                                    <div class="mt-5 rounded-2xl bg-green-900 text-white px-5 py-4">
                                        <div class="text-[10px] font-black uppercase tracking-[0.2em] text-green-200 mb-2">Parameters</div>
                                        <div class="flex flex-wrap gap-2">
                                            ${['Moisture', 'EC', 'Temperature'].map((parameter) => `
                                                <span class="rounded-full bg-white/12 border border-white/15 px-4 py-2 text-xs font-black uppercase tracking-[0.12em]">${parameter}</span>
                                            `).join('')}
                                        </div>
                                    </div>
                                </div>
                                <div class="rayat-sensor-card-grid rayat-sensor-card-grid--soil grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                                    ${perliteMetrics.map((metric) => renderPerliteMetricCard(metric)).join('')}
                                </div>
                            </div>
                        </div>

                        <div class="mt-20 w-full mx-auto">
                            <div class="flex flex-nowrap items-center bg-white p-4 rounded-[2rem] shadow-2xl border border-gray-100 gap-4 mb-10 overflow-x-auto no-scrollbar">
                                <div class="flex bg-gray-50 p-1.5 rounded-2xl shrink-0">
                                    ${['24h', '7d', '30d'].map(period => `
                                        <button onclick="setFilterPeriod('${period}')" class="px-5 py-2.5 rounded-xl font-bold uppercase tracking-tight text-[11px] whitespace-nowrap transition-all ${filterState.period === period ? 'bg-[#1e293b] text-white shadow-lg' : 'text-gray-400 hover:text-gray-900'}">
                                            ${t('last' + period)}
                                        </button>`).join('')}
                                </div>
                                <button onclick="refreshData()" class="bg-[#10b981] hover:bg-green-700 text-white px-6 py-3 rounded-xl font-bold uppercase tracking-tight text-[11px] shadow-xl transition-all shrink-0 flex items-center gap-2">
                                    <span>${isRefreshingData ? t('refreshingDataAction') : t('refreshDataAction')}</span>
                                </button>
                            </div>

                            <div class="rayat-history-card bg-white rounded-[4rem] p-12 shadow-2xl border border-gray-50 overflow-hidden">
                                <div class="rayat-history-table-wrap overflow-x-auto">
                                    <table class="rayat-history-table w-full text-left">
                                        <thead>
                                            <tr class="border-b-8 border-gray-50">
                                                <th class="rayat-history-head-cell">${t('time')}</th>
                                                <th class="rayat-history-head-cell rayat-history-head-cell--metric">🌡️ Temperatura substrato</th>
                                                <th class="rayat-history-head-cell rayat-history-head-cell--metric">⚡ EC substrato</th>
                                                <th class="rayat-history-head-cell rayat-history-head-cell--metric">💧 Umidita substrato</th>
                                                <th class="rayat-history-head-cell">${t('status')}</th>
                                            </tr>
                                        </thead>
                                        <tbody class="divide-y divide-gray-50">
                                            ${renderPerliteHistoryRows()}
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
                'perlite-track': renderPerliteTrackPage,
                'register': renderRegisterPage,
                'contatti': renderContactPage,
                'privacy': renderPrivacyPage,
                'terms': renderTermsPage,
                'reset-password': renderResetPasswordPage
            };

            const viewFn = routes[currentView] || renderHomePage;
            app.innerHTML = `${viewFn()}${renderPublicWhatsappButton()}`;
            syncBodyScrollLock();
            syncAppShellState();
            syncStaticI18n();

            // Post-render initialization
            // Post-render initialization
            if (currentView === 'contatti') initContactMap();
            if (currentView === 'home') initHomeMap();
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
        currentView = normalizeViewForCurrentUser(currentView);
        if (currentView === 'perlite-track' && window.location.pathname !== VIEW_PATHS['perlite-track']) {
            history.replaceState({ view: 'perlite-track' }, '', VIEW_PATHS['perlite-track']);
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
                currentView = event.state.view;
                if (currentView === 'demo') {
                    syncDashboardSensorFromPath(window.location.pathname);
                }
                currentView = normalizeViewForCurrentUser(currentView);
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
                currentView = normalizeViewForCurrentUser(currentView);
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
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') {
                return;
            }

            if (isMobileMenuOpen) {
                toggleMobileMenu(false);
            }

            document.getElementById('lang-menu')?.classList.add('hidden');
            closeProfileMenu();
        });

        // RAYAT FIX - checkbox remember me + desktop scroll
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768 && isMobileMenuOpen) {
                toggleMobileMenu(false);
            } else {
                syncBodyScrollLock();
            }
            invalidateVisibleMaps();
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                syncBodyScrollLock();
                invalidateVisibleMaps();
            }
        });

        window.addEventListener('pageshow', () => {
            syncBodyScrollLock();
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
