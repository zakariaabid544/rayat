        const API_ORIGIN = window.location.origin && window.location.origin !== 'null'
            ? window.location.origin
            : 'http://localhost:3000';

        const CONFIG = {
            API_BASE_URL: `${API_ORIGIN}/api`,
            REAL_API_URL: `${API_ORIGIN}/api/sensors/simple/latest`
        };

        let lastRefreshed = new Date();

        let authToken = localStorage.getItem('rayat_token');
        let currentRole = 'guest';

        let currentView = 'home';
        let selectedSensor = 'energia';
        let user = null;
        let currentLang = localStorage.getItem('rayat_lang') || 'it';
        let showSettings = false;
        let showNotifications = false;
        let isMobileMenuOpen = false;
        let isAdminView = false;
        let dataError = false; // Track API availability
        const CUSTOMER_ROLES = new Set(['client', 'farmer']);
        const ADMIN_ROLES = new Set(['admin', 'super_admin', 'operator', 'operator_admin']);
        const VIEW_PATHS = {
            home: '/',
            login: '/login',
            register: '/register',
            demo: '/demo',
            servizi: '/services',
            'chi-siamo': '/chi-siamo',
            contatti: '/contatti',
            privacy: '/privacy',
            terms: '/terms',
            'reset-password': '/reset-password'
        };

        // Professional Water Management Config
        const CROP_OPTIONS = [
            { value: 'banane', labelKey: 'cropOptionBanane' },
            { value: 'tomate', labelKey: 'cropOptionTomate' },
            { value: 'poivron', labelKey: 'cropOptionPoivron' },
            { value: 'concombre', labelKey: 'cropOptionConcombre' },
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
        const DEFAULT_CROP_VALUE = 'banane';
        const cropConsumptions = {
            banane: 50,
            tomate: 20,
            poivron: 18,
            concombre: 24,
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
        let userCropSelection = loadStoredCropSelection();
        let waterSettings = { hectares: 1, crop: userCropSelection.value };

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

        function isCustomerRole(role = currentRole) {
            return CUSTOMER_ROLES.has(role);
        }

        function isPrivilegedRole(role = currentRole) {
            return ADMIN_ROLES.has(role);
        }

        function getPathForView(view) {
            return VIEW_PATHS[view] || '/';
        }

        function getViewFromPath(pathname = window.location.pathname) {
            const normalizedPath = pathname.replace(/\/+$/, '') || '/';
            const match = Object.entries(VIEW_PATHS).find(([, path]) => path === normalizedPath);
            return match ? match[0] : 'home';
        }

        function restorePublicSession() {
            authToken = localStorage.getItem('rayat_token');

            if (!authToken) {
                user = null;
                currentRole = 'guest';
                return;
            }

            const storedUser = localStorage.getItem('rayat_user');
            if (storedUser) {
                try {
                    user = JSON.parse(storedUser);
                    currentRole = user?.role || 'guest';
                    return;
                } catch (error) {
                    localStorage.removeItem('rayat_user');
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
                localStorage.setItem('rayat_user', JSON.stringify(user));
                return;
            }

            clearPublicSession({ keepCurrentView: true, skipAdminLogout: true });
        }

        function clearPublicSession(options = {}) {
            user = null;
            authToken = null;
            currentRole = 'guest';
            isAdminView = false;
            localStorage.removeItem('rayat_token');
            localStorage.removeItem('rayat_user');
            sessionStorage.removeItem('rayat_admin_token');
            sessionStorage.removeItem('rayat_admin_user');
            hideSubscriptionExpiredModal();

            if (!options.skipAdminLogout) {
                fetch(`${API_ORIGIN}/api/admin/logout`, {
                    method: 'POST',
                    credentials: 'same-origin'
                }).catch(() => {});
            }
        }

        function updateWaterSettings(val, type) {
            if (type === 'hectares') {
                waterSettings.hectares = Number.parseFloat(val) || 0;
            } else if (type === 'crop') {
                setUserCrop(val);
                return;
            }

            render();
            // removed chart initialization
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
                home: 'Home', services: 'Servizi', aboutUs: 'Chi Siamo', demo: 'Demo', login: 'Accedi', logout: 'Logout',
                hero: 'Terreno Sano = Raccolto Ricco', heroSub: 'Monitoraggio 24/7 con sensori intelligenti Rayat',
                tryDemo: 'Prova la Demo', discoverServices: 'Scopri i Servizi', insurance: 'Assicurazione Agricola Rayat Smart Monitoring',
                ourSensors: 'Tecnologia Rayat', ourReality: 'La Nostra Realtà',
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
                lastUpdate: 'Ultimo Update', lastRefreshed: 'Ultimo Aggiornamento', export: 'Scarica CSV', search: 'Cerca', time: 'Data/Ora', status: 'Stato',
                appSubtitle: 'Rayat Smart Monitoring Professionale',
                welcome: 'Benvenuto', protected: 'Il Tuo Campo è Protetto 24/7', controlActive: 'Controllo continuo - La tua assicurazione agricola sempre attiva',
                loginTitle: 'Accedi', loginError: 'Email o password non corretti!', emailLabel: 'Email', passwordLabel: 'Password', loginBtn: 'ACCEDI', demoAccount: 'Account Demo:',
                customSolutionsTitle: 'Soluzioni Personalizzate', customSolutionsDesc: 'Non per forza devi avere tutti i nostri sensori!', contactUs: 'Contattaci per una Consulenza', features: 'Funzionalità:',
                sensorEnName: 'RAYAT ENERGIA', sensorEnDesc: 'Monitora consumo pompe e rileva guasti', sensorEnF1: 'Allarme salvavita', sensorEnF2: 'Ottimizzazione fasce', sensorEnF3: 'Rilevamento guasti',
                sensorWaF1: 'Livello Acqua', sensorWaF2: 'Allarme Scarso', sensorWaF3: 'Storico Riserve',
                sensorSoName: 'RAYAT SUOLO (7-IN-1)', sensorSoDesc: 'Analisi completa: Umidità, pH, NPK - Rayat Smart Monitoring',
                sensorSoF1: 'Umidità del terreno', sensorSoF2: 'Temperatura del terreno', sensorSoF3: 'Conducibilità elettrica', sensorSoF4: 'pH', sensorSoF5: 'Azoto', sensorSoF6: 'Fosforo', sensorSoF7: 'Potassio',
                sensorClName: 'RAYAT ARIA (CLIMA)', sensorClDesc: 'Monitoraggio Clima - Rayat Smart Monitoring', sensorClF1: 'Allerta gelo SMS', sensorClF2: 'Previsione evaporazione', sensorClF3: 'Velocità vento', sensorClF4: 'Schermo solare per letture precise', sensorClF5: 'Resistenza agli agenti atmosferici estremi', sensorClF6: 'Clima', sensorClDetails: 'Monitoraggio Temperatura Aria, Umidità Aria e CO2.',
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
                regVerifyTitle: 'Crea il tuo account Rayat', regFullName: 'Nome e Cognome', regPhone: 'Numero di telefono', regEmailOpt: 'Email',
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
                cropOptionBanane: 'Banane', cropOptionTomate: 'Pomodoro', cropOptionPoivron: 'Peperone', cropOptionConcombre: 'Cetriolo', cropOptionCourgette: 'Zucchina',
                cropOptionLaitue: 'Lattuga', cropOptionFraise: 'Fragola', cropOptionAgrumes: 'Agrumi', cropOptionOlive: 'Olivo', cropOptionArgan: 'Argan',
                cropOptionBle: 'Grano', cropOptionOrge: 'Orzo', cropOptionMais: 'Mais', cropOptionLuzerne: 'Erba medica', cropOptionAutre: 'Altro'
            },
            en: {
                home: 'Home', services: 'Services', aboutUs: 'About Us', demo: 'Demo', login: 'Login', logout: 'Logout',
                hero: 'Healthy Soil = Rich Harvest', heroSub: 'Monitor your field 24/7 with smart sensors',
                tryDemo: 'Try Demo', discoverServices: 'Discover Services', insurance: 'Your agricultural insurance - Continuous real-time monitoring',
                ourSensors: 'Our Sensors', ourReality: 'Our Reality',
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
                lastUpdate: 'Last Update', lastRefreshed: 'Last Refreshed', export: 'Download Report (CSV)', search: 'Search', time: 'Time', status: 'Status',
                appSubtitle: 'Rayat Smart Monitoring',
                welcome: 'Welcome', protected: 'Your Field is Protected 24/7', controlActive: 'Continuous monitoring - Your agricultural insurance always active',
                loginTitle: 'Login', loginError: 'Incorrect email or password!', emailLabel: 'Email', passwordLabel: 'Password', loginBtn: 'LOGIN', demoAccount: 'Demo Account:',
                customSolutionsTitle: 'Custom Solutions', customSolutionsDesc: 'You don\'t need all our sensors!', contactUs: 'Contact Us for Advice', features: 'Features:',
                sensorEnName: 'RAYAT ENERGY', sensorEnDesc: 'Monitor pump consumption and faults', sensorEnF1: 'Life-saving alarm', sensorEnF2: 'Schedule optimization', sensorEnF3: 'Fault detection',
                sensorWaF1: 'Water Level', sensorWaF2: 'Low Level Alarm', sensorWaF3: 'Reservoir History',
                sensorSoName: 'RAYAT SOIL (7-IN-1)', sensorSoDesc: 'Complete analysis: Moisture, pH, NPK - Rayat Smart Monitoring',
                sensorSoF1: 'Soil Moisture', sensorSoF2: 'Soil Temperature', sensorSoF3: 'Electrical Conductivity', sensorSoF4: 'pH', sensorSoF5: 'Nitrogen', sensorSoF6: 'Phosphorus', sensorSoF7: 'Potassium',
                sensorClName: 'RAYAT AIR (CLIMATE)', sensorClDesc: 'Climate Monitoring - Rayat Smart Monitoring', sensorClF1: 'Frost SMS alert', sensorClF2: 'Evaporation forecast', sensorClF3: 'Wind speed', sensorClF4: 'Solar shield for precise readings', sensorClF5: 'Resistance to extreme weather conditions', sensorClF6: 'Climate', sensorClDetails: 'Air Temperature, Air Humidity and CO2 Monitoring.',
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
                regVerifyTitle: 'Create your Rayat account', regFullName: 'Full Name', regPhone: 'Phone Number', regEmailOpt: 'Email',
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
                cropOptionBanane: 'Banana', cropOptionTomate: 'Tomato', cropOptionPoivron: 'Pepper', cropOptionConcombre: 'Cucumber', cropOptionCourgette: 'Zucchini',
                cropOptionLaitue: 'Lettuce', cropOptionFraise: 'Strawberry', cropOptionAgrumes: 'Citrus', cropOptionOlive: 'Olive', cropOptionArgan: 'Argan',
                cropOptionBle: 'Wheat', cropOptionOrge: 'Barley', cropOptionMais: 'Corn', cropOptionLuzerne: 'Alfalfa', cropOptionAutre: 'Other'
            },
            fr: {
                home: 'Accueil', services: 'Services', aboutUs: 'Qui Sommes-Nous', demo: 'Démo', login: 'Connexion', logout: 'Déconnexion',
                hero: 'Sol Sain = Récolte Riche', heroSub: 'Surveillance 24h/24 avec capteurs intelligents Rayat',
                tryDemo: 'Tester la Démo', discoverServices: 'Nos Services', insurance: 'Assurance Agricole Rayat Smart Monitoring',
                ourSensors: 'Technologie Rayat', ourReality: 'Notre Réalité',
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
                lastUpdate: 'Mise à jour', lastRefreshed: 'Dernière mise à jour', export: 'Exporter CSV', search: 'Chercher', time: 'Date/Heure', status: 'Statut',
                appSubtitle: 'Rayat Smart Monitoring Professionnel',
                welcome: 'Bienvenue', protected: 'Votre Champ est Protégé 24h/24', controlActive: 'Surveillance continue - Votre assurance agricole toujours active',
                loginTitle: 'Connexion', loginError: 'Email ou mot de passe incorrect!', emailLabel: 'Email', passwordLabel: 'Mot de passe', loginBtn: 'CONNEXION', demoAccount: 'Compte Démo:',
                customSolutionsTitle: 'Solutions Personnalisées', customSolutionsDesc: 'Vous n\'avez pas besoin de tous nos capteurs !', contactUs: 'Contactez-nous pour Conseil', features: 'Fonctionnalités :',
                sensorEnName: 'RAYAT ÉNERGIE', sensorEnDesc: 'Surveillance conso pompes et pannes', sensorEnF1: 'Alarme vitale', sensorEnF2: 'Optimisation horaires', sensorEnF3: 'Détection pannes',
                sensorWaF1: 'Niveau d\'eau', sensorWaF2: 'Alarme puits vide', sensorWaF3: 'Historique nappe',
                sensorSoName: 'RAYAT SOL (7-EN-1)', sensorSoDesc: 'Analyse complète : Humidité, pH, NPK',
                sensorSoF1: 'Humidité du sol', sensorSoF2: 'Température du sol', sensorSoF3: 'Conductivité électrique', sensorSoF4: 'pH', sensorSoF5: 'Azote', sensorSoF6: 'Phosphore', sensorSoF7: 'Potassium',
                sensorClName: 'RAYAT AIR (CLIMAT)', sensorClDesc: 'Surveillance du Climat - Rayat Smart Monitoring', sensorClF1: 'Alerte gel SMS', sensorClF2: 'Prévision évaporation', sensorClF3: 'Vitesse vent', sensorClF4: 'Écran solaire pour des lectures précises', sensorClF5: 'Résistance aux conditions météorologiques extrêmes', sensorClF6: 'Climat', sensorClDetails: 'Surveillance de la Température, Humidité et CO2.',
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
                regVerifyTitle: 'Créer votre compte Rayat', regFullName: 'Nom et Prénom', regPhone: 'Numéro de téléphone', regEmailOpt: 'Email',
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
                cropOptionBanane: 'Banane', cropOptionTomate: 'Tomate', cropOptionPoivron: 'Poivron', cropOptionConcombre: 'Concombre', cropOptionCourgette: 'Courgette',
                cropOptionLaitue: 'Laitue', cropOptionFraise: 'Fraise', cropOptionAgrumes: 'Agrumes', cropOptionOlive: 'Olivier', cropOptionArgan: 'Argan',
                cropOptionBle: 'Ble', cropOptionOrge: 'Orge', cropOptionMais: 'Mais', cropOptionLuzerne: 'Luzerne', cropOptionAutre: 'Autre'
            },
            ar: {
                home: 'الرئيسية', services: 'الخدمات', aboutUs: 'من نحن', demo: 'تجريبي', login: 'دخول', logout: 'خروج',
                hero: 'تربة صحية = حصاد غني', heroSub: 'مراقبة 24/7 بأجهزة استشعار رايات الذكية',
                tryDemo: 'تجريب النسخة', discoverServices: 'خدماتنا', insurance: 'تأمينك الزراعي مع رايات',
                ourSensors: 'تكنولوجيا رايات', ourReality: 'واقعنا',
                ourRealityDesc: 'ولدت رايات من شغف بالزراعة. نحن فريق من الخبراء نجلب الابتكار المتاح إلى الحقول.',
                ourMission: 'مهمتنا', ourMissionDesc: 'نؤمن بأن كل مزارع يستحق أدوات مراقبة احترافية.',
                ourDuty: 'واجبنا المهني', ourDutyDesc: 'شريكك الموثوق للإدارة الفعالة للموارد.',
                support247: 'دعم 24/7', training: 'تدريب مستمر', transparency: 'شفافية كاملة',
                customSolutions: 'حلول مخصصة', qualityGuaranteed: 'جودة مضمونة',
                ourCommitment: 'التزامنا', ourCommitmentDesc: 'نقدم لك الأمان والراحة لضمان نجاح محصولك.',
                innovation: 'ابتكار', innovationDesc: 'تقنيات متقدمة لمستقبل الزراعة.',
                sustainability: 'استدامة', sustainabilityDesc: 'إدارة مسؤولة وتوفير المياه.',
                community: 'مجتمع', communityDesc: 'دعم متبادل بين المزارعين المحترفين.',
                sensorWaName: 'رايات للمياه', sensorWaDesc: 'مستوى الحوض والاحتياجات',
                hectaresLabel: 'المساحة (هكتار)', cropLabel: 'نوع المحصول',
                need: 'الاحتياج', available: 'المتوفر', ton: 'طن', ha: 'هكتار',
                statusOk: 'احتياطي جيد', statusAlert: 'تنبيه الموارد',
                msgOk: 'ري آمن ومضمون', msgShortage: 'تنبيه: المياه غير كافية!',
                footerRights: '© 2026 Rayat Smart Monitoring. جميع الحقوق محفوظة.',
                banane: 'موز', agrumi: 'حمضيات', pomodori: 'طماطم', mais: 'ذرة', fragole: 'فراولة', olive: 'زيتون', citrus: 'حمضيات', tomatoes: 'طماطم', banana: 'موز', strawberry: 'فراولة',
                lastUpdate: 'آخر تحديث', lastRefreshed: 'تم التحديث في', export: 'تصدير CSV', search: 'بحث', time: 'الوقت', status: 'الحالة',
                appSubtitle: 'رايات للمراقبة الذكية المحترفة',
                welcome: 'مرحبا', protected: 'حقلك محمي 24/7', controlActive: 'مراقبة مستمرة - تأمينك الزراعي نشط دائمًا',
                loginTitle: 'تسجيل الدخول', loginError: 'البريد الإلكتروني أو كلمة المرور غير صحيحة!', emailLabel: 'البريد الإلكتروني', passwordLabel: 'كلمة المرور', loginBtn: 'دخول', demoAccount: 'حساب تجريبي:',
                customSolutionsTitle: 'حلول مخصصة', customSolutionsDesc: 'لا تحتاج لجميع أجهزتنا!', contactUs: 'اتصل بنا للاستشارة', features: 'الميزات:',
                sensorEnName: 'رايات للطاقة', sensorEnDesc: 'مراقبة استهلاك المضخات والأعطال', sensorEnF1: 'إنذار منقذ للحياة', sensorEnF2: 'تحسين الجداول', sensorEnF3: 'كشف الأعطال',
                sensorWaF1: 'مستوى الماء', sensorWaF2: 'إنذار بئر فارغ', sensorWaF3: 'تاريخ المياه الجوفية',
                sensorSoName: 'رايات للتربة (7-في-1)', sensorSoDesc: 'تحليل شامل: رطوبة، pH، NPK',
                sensorSoF1: 'رطوبة التربة', sensorSoF2: 'درجة حرارة التربة', sensorSoF3: 'التوصيل الكهربائي', sensorSoF4: 'pH', sensorSoF5: 'النيتروجين', sensorSoF6: 'الفوسفور', sensorSoF7: 'البوتاسيوم',
                sensorClName: 'رايات للمناخ', sensorClDesc: 'حماية من الصقيع والحرارة', sensorClF1: 'تنبيه صقيع SMS', sensorClF2: 'توقعات التبخر', sensorClF3: 'سرعة الرياح', sensorClF4: 'درع شمسي لقراءات دقيقة', sensorClF5: 'مقاومة للظروف الجوية القاسية', sensorClF6: 'المناخ', sensorClDetails: 'مستشعر احترافي لدرجة الحرارة والرطوبة مع حماية من الأشعة فوق البنفسجية وعزل كامل للماء.',
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
                regVerifyTitle: 'أنشئ حسابك في رايات', regFullName: 'الاسم الكامل', regPhone: 'رقم الهاتف', regEmailOpt: 'البريد الإلكتروني',
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
                navMenu: 'القائمة', mobileMenuClose: 'إغلاق القائمة',
                forgotPassword: 'هل نسيت كلمة المرور؟', forgotPasswordSubmit: 'إرسال رابط إعادة التعيين', forgotPasswordSuccess: 'إذا كان الحساب موجودا فستصلك رسالة تحتوي على رابط إعادة التعيين.',
                forgotPasswordEmailRequired: 'أدخل بريدك الإلكتروني للحصول على رابط إعادة التعيين.',
                resetPasswordTitle: 'إعادة تعيين كلمة المرور', resetPasswordDesc: 'اختر كلمة مرور جديدة وآمنة لحسابك في رايات.',
                newPasswordLabel: 'كلمة المرور الجديدة', confirmPasswordLabel: 'تأكيد كلمة المرور', resetPasswordSubmit: 'تحديث كلمة المرور',
                resetPasswordSuccess: 'تم تحديث كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول.', resetPasswordInvalidToken: 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية.',
                resetPasswordMismatch: 'كلمتا المرور غير متطابقتين.', backToLogin: 'العودة إلى تسجيل الدخول',
                cropSelectorTitle: 'المحصول المختار', cropSelectorHint: 'تستخدم رايات هذا المحصول لتخصيص التوصيات والتقديرات المحلية.',
                cropCustomLabel: 'حدد المحصول', cropCustomPlaceholder: 'مثال: شمام، باذنجان، بابايا',
                cropOptionBanane: 'موز', cropOptionTomate: 'طماطم', cropOptionPoivron: 'فلفل', cropOptionConcombre: 'خيار', cropOptionCourgette: 'كوسة',
                cropOptionLaitue: 'خس', cropOptionFraise: 'فراولة', cropOptionAgrumes: 'حمضيات', cropOptionOlive: 'زيتون', cropOptionArgan: 'أركان',
                cropOptionBle: 'قمح', cropOptionOrge: 'شعير', cropOptionMais: 'ذرة', cropOptionLuzerne: 'برسيم', cropOptionAutre: 'أخرى'
            },
            zgh: {
                home: 'ⵜⴰⴳⵎⵎⵉ',
                services: 'ⵉⵎⴰⵣⵣⴰⵍⵏ',
                aboutUs: 'ⴰⵡⴰⵍ ⴼⵍⵍⴰⵏⵖ',
                demo: 'ⴷⵉⵎⵓ',
                login: 'ⴰⴽⵛⵓⵎ',
                logout: 'ⴼⴼⵓⵖ',
                hero: 'ⴰⴽⴰⵍ ⵉⵖⵓⴷⴰⵏ = ⴰⵎⴳⵔ ⵉⵖⵓⴷⴰⵏ',
                heroSub: 'ⵀⴰⵏⴰ ⴽⵓⵍⵍⵓ',
                insurance: 'ⵍⴰⵙⵉⵔⵓⵏⵙ ⵏ ⵜⴼⵍⵍⴰⵃⵜ',
                tryDemo: 'ⴰⵔⴰⵎ ⴷⵉⵎⵓ',
                discoverServices: 'ⵥⵕ ⵉⵎⴰⵣⵣⴰⵍⵏ',
                ourSensors: 'ⵉⵎⴰⵙⵙⵏ ⵏⵏⵖ <span class="text-xs text-gray-500 block">Imassn</span>',
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
                sensorEnName: 'ⵜⵉⵥⴹⵉ',
                sensorEnDesc: 'Surveillance conso pompes et pannes',
                sensorEnF1: 'Alarme vitale',
                sensorEnF2: 'Optimisation horaires',
                sensorEnF3: 'Détection pannes',
                sensorWaName: 'ⴰⵎⴰⵏ',
                sensorWaDesc: 'Surveillance du Bassin et Besoin en Eau',
                sensorWaF1: 'Niveau d\'eau',
                sensorWaF2: 'Alarme puits vide',
                sensorWaF3: 'Historique nappe',
                sensorSoName: 'ⴰⵣⵣⴰⵢ (7-IN-1)',
                sensorSoDesc: 'Analyse complète : Humidité, pH, NPK',
                sensorSoF1: 'ⵜⴰⵎⵉⴷⵉ',
                sensorSoF2: 'ⵜⴰⵙⴽⵯⴼⵍⵜ',
                sensorSoF3: 'Conductivité électrique',
                sensorSoF4: 'pH',
                sensorSoF5: 'Azote',
                sensorSoF6: 'Phosphore',
                sensorSoF7: 'Potassium',
                sensorClName: 'ⴰⵏⵣⵡⵉ',
                sensorClDesc: 'Climate Monitoring - Rayat Smart Monitoring',
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
                lastRefreshed: 'ⴰⵙⵎⴰⵢⵏⵓ ⴰⵎⴳⴳⴰⵔⵓ',
                ton: 'Ton',
                ha: 'Ha',
                banane: 'ⵜⵉⴳⴰⵢⵢⴰ',
                agrumi: 'ⵉⵎⴰⵏ',
                pomodori: 'ⵜⵉⵎⴰⵜⵉⵛ',
                mais: 'ⴰⴷⵔⴰⵔ',
                fragole: 'ⵜⵉⴼⵔⴰⵙ',
                olive: 'ⴰⵣⵎⵎⵓⵔ',
                lastUpdate: 'ⴰⵎⴰⵢⵏⵓ ⴰⵎⴳⴳⴰⵔⵓ',
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
                dataUnavailable: 'ⵉⵙⴼⴽⴰ ⵓⵔ ⵍⵍⵉⵏ <span class="text-[10px] block">Data Unavailable</span>',
                privacyPolicy: 'ⵜⴰⵙⵔⵜⵉⵜ ⵏ ⵜⵉⵏⵏⵓⵜⴼⴰ',
                termsOfService: 'ⵜⵉⴼⴰⴷⵉⵡⵉⵏ ⵏ ⵓⵙⵎⵔⵙ',
                regStep: 'ⵜⴰⵙⴽⵯⴼⵍⵜ', regOf: 'ⵙⴳ', regPersonalData: 'ⵉⵙⴼⴽⴰ ⵉⵢⵉⵎⴰⵏ', regAgriType: 'ⴰⵙⵉⴳⴳⵯⵍ ⴰⴳⵔⵉⴽⵓⵍ', regFieldLoc: 'ⴰⴷⵖⴰⵔ ⵏ ⵓⴽⴰⵍ',
                regVerifyTitle: 'ⵙⴽⵔ ⴰⴽⴰⵡⵏⵜ ⵏ ⵔⴰⵢⴰⵜ', regFullName: 'ⵉⵙⵎ ⴰⵎⴳⴳⴰⵔⵓ', regPhone: 'ⵜⵉⵍⵉⴼⵓⵏ', regEmailOpt: 'ⵉⵎⵉⵍ',
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
                navMenu: 'ⵎⵉⵏⵓ', mobileMenuClose: 'ⵎⴷⵍ ⵎⵉⵏⵓ',
                forgotPassword: 'Mot de passe oublie ?', forgotPasswordSubmit: 'Azen lien n reinitialisation', forgotPasswordSuccess: 'Ma yella lcompte illa, ad tawed email s lien n reinitialisation.',
                forgotPasswordEmailRequired: 'Ari email inek iwakken ad tawsed lien n reinitialisation.',
                resetPasswordTitle: 'Reinitialiser mot de passe', resetPasswordDesc: 'Fren awal uffir amaynut i ucount Rayat.',
                newPasswordLabel: 'Awal uffir amaynut', confirmPasswordLabel: 'Ssedq awal uffir', resetPasswordSubmit: 'Sbeddel awal uffir',
                resetPasswordSuccess: 'Mot de passe ibeddel. Tzemred ad tkecmed tura.', resetPasswordInvalidToken: 'Lien n reinitialisation ma yelli ara negh ifukk.',
                resetPasswordMismatch: 'Awalen uffiren ur mgaraden ara.', backToLogin: 'Ughul ar login',
                cropSelectorTitle: 'ⵜⴰⵢⵢⵓⵣⵜ ⵉⵜⵜⵓⴼⵔⴰⵏ', cropSelectorHint: 'Rayat ittwaseqdec ttayyuzt ad yerr isemras d itqdirin.',
                cropCustomLabel: 'ⴰⵔⵉ ⵉⵙⵎ ⵏ ⵜⵎⴳⵔⵜ', cropCustomPlaceholder: 'Melon, aubergine, papaye',
                cropOptionBanane: 'ⵜⵉⴳⴰⵢⵢⴰ', cropOptionTomate: 'ⵜⵉⵎⴰⵜⵉⵛ', cropOptionPoivron: 'Poivron', cropOptionConcombre: 'Concombre', cropOptionCourgette: 'Courgette',
                cropOptionLaitue: 'Laitue', cropOptionFraise: 'ⵜⵉⴼⵔⴰⵙ', cropOptionAgrumes: 'Agrumes', cropOptionOlive: 'ⴰⵣⵎⵎⵓⵔ', cropOptionArgan: 'Argan',
                cropOptionBle: 'Ble', cropOptionOrge: 'Orge', cropOptionMais: 'ⴰⴷⵔⴰⵔ', cropOptionLuzerne: 'Luzerne', cropOptionAutre: 'ⵢⴰⴹⵏ'
            }
        };

        function t(key) {
            let val = translations[currentLang]?.[key];
            // Fallback to French for Amazigh if translation is missing
            if (!val && currentLang === 'zgh') {
                val = translations['fr'][key];
            }
            return val || key;
        }

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function syncBodyScrollLock() {
            document.body.classList.toggle('rayat-menu-open', isMobileMenuOpen);
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
            setView(view);
        }

        function setLanguage(lang) {
            currentLang = lang;
            localStorage.setItem('rayat_lang', lang);
            document.getElementById('lang-menu')?.classList.add('hidden');
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


        // --- Data Simulation for Presentation ---
        let globalHistory = [];
        function generateSimulationData() {
            globalHistory = [];
            const now = new Date();
            for (let i = 167; i >= 0; i--) {
                const date = new Date(now.getTime() - i * 3600000);
                const hour = date.getHours();

                // Suolo (7-in-1)
                const nitrogen = 38 + Math.random() * 4;
                const phosphorus = 6 + Math.random() * 2;
                const potassium = 46 + Math.random() * 6;
                const pH = 6.4 + Math.random() * 0.4;
                const ec = 190 + Math.random() * 30;
                const moisture = 34 + Math.random() * 3;
                const tempSuolo = 16 + Math.random() * 6;

                // Clima
                let tempClima;
                if (hour >= 6 && hour <= 18) {
                    tempClima = 22 + Math.sin((hour - 6) / 12 * Math.PI) * 18;
                } else {
                    tempClima = 12 + Math.random() * 6;
                }
                const humidity = 50 + Math.random() * 45;
                const co2 = 400 + Math.random() * 100;
                const wind = 5 + Math.random() * 15;

                // Acqua
                const waterLevel = 3.2 + Math.random() * 0.6;

                // Energia (Battery Voltage)
                const battery = 12.4 + Math.random() * 1.4;

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
                    status: 'statusNormal',
                    isOptimalTemp: true,
                    isOptimalMoisture: true,
                    isOptimalEC: true,
                    isOptimalN: true,
                    isOptimalP: true,
                    isOptimalK: true,
                    isOptimalPH: true
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

        generateSimulationData();

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


        // --- Gauge Bar Rendering Function ---
        function renderGaugeBar(label, value, min, max, optimalMin, optimalMax, unit, hasMaxOptimal = true) {
            const percentage = ((value - min) / (max - min)) * 100;
            const optimalStartPct = ((optimalMin - min) / (max - min)) * 100;
            const optimalEndPct = hasMaxOptimal ? ((optimalMax - min) / (max - min)) * 100 : 100;
            const isInOptimal = hasMaxOptimal ? (value >= optimalMin && value <= optimalMax) : (value >= optimalMin);

            return `
                <div class="mb-3">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-xs font-semibold text-gray-700">${isInOptimal ? '' : '⚠️'} ${label}</span>
                        <span class="text-sm font-bold ${isInOptimal ? 'text-green-600' : 'text-red-600'}">${value.toFixed(1)} ${unit}</span>
                    </div>
                    <div class="relative h-5 bg-gray-200 rounded-full overflow-hidden shadow-inner">
                        <div class="absolute h-full bg-gradient-to-r from-blue-300 to-blue-200" style="left: 0%; width: ${optimalStartPct}%"></div>
                        <div class="absolute h-full bg-gradient-to-r from-green-400 to-green-500" style="left: ${optimalStartPct}%; width: ${optimalEndPct - optimalStartPct}%"></div>
                        ${hasMaxOptimal ? `<div class="absolute h-full bg-gradient-to-r from-orange-400 to-red-400" style="left: ${optimalEndPct}%; width: ${100 - optimalEndPct}%"></div>` : ''}
                        <div class="absolute h-full w-0.5 bg-gray-800 shadow-lg transition-all duration-500" style="left: ${Math.min(Math.max(percentage, 0), 100)}%"><div class="absolute -top-0.5 -left-1.5 w-3 h-6 bg-gray-800 rounded-sm shadow-xl border border-white"></div></div>
                    </div>
                    <div class="flex justify-between text-[10px] text-gray-500 mt-0.5">
                        <span>${min}${unit}</span>
                        <span class="text-green-600 font-semibold">Opt: ${optimalMin}-${hasMaxOptimal ? optimalMax : '∞'}${unit}</span>
                        <span>${max}${unit}</span>
                    </div>
                </div>`;
        }

        // --- Historical Data (populated by generateSimulationData) ---

        // --- Filter State ---
        let filterState = {
            period: '24h', // 24h, 7d, 30d, custom
            customStart: null,
            customEnd: null
        };

        function setFilterPeriod(period) {
            filterState.period = period;

            // Visual feedback - flash the card
            const card = document.querySelector('.bg-white.rounded-2xl.shadow-xl.p-6');
            if (card) {
                card.classList.add('opacity-50');
                setTimeout(() => {
                    card.classList.remove('opacity-50');
                    render();
                }, 300);
            } else {
                render();
            }
        }

        function setCustomFilter() {
            const startInput = document.getElementById('startDate');
            const endInput = document.getElementById('endDate');
            const start = startInput.value;
            const end = endInput.value;

            if (start && end) {
                const startDate = new Date(start);
                const endDate = new Date(end);

                if (endDate < startDate) {
                    alert('La data di fine non può essere precedente alla data di inizio.');
                    return;
                }

                filterState.period = 'custom';
                filterState.customStart = startDate;
                filterState.customEnd = endDate;
                filterState.customEnd.setHours(23, 59, 59, 999);

                // Visual feedback - loading state on button
                const btn = document.querySelector('button[onclick="setCustomFilter()"]');
                const originalText = btn.innerHTML;
                btn.innerHTML = '⌛ ...';
                btn.disabled = true;

                const tableContainer = document.querySelector('.overflow-x-auto.max-h-96');
                if (tableContainer) tableContainer.style.opacity = '0.3';

                setTimeout(() => {
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                    if (tableContainer) tableContainer.style.opacity = '1';
                    render();
                }, 600);
            }
        }

        function getFilteredHistory() {
            if (globalHistory.length === 0) return [];
            if (filterState.period === '24h') return globalHistory.slice(-24);
            if (filterState.period === '7d') return globalHistory.slice(-168);
            if (filterState.period === '30d') return globalHistory.slice(-720);
            if (filterState.period === 'custom' && filterState.customStart && filterState.customEnd) {
                return globalHistory.filter(d => d.date >= filterState.customStart && d.date <= filterState.customEnd);
            }
            return globalHistory; // Return all for full view
        }

        function exportCSV() {
            const data = globalHistory; // Export all 168h as requested
            const csvRows = [];
            // Header
            csvRows.push(['Date', 'Time', 'Battery (V)', 'Water (m)', 'Temp Air (°C)', 'Hum Air (%)', 'CO2 (ppm)', 'Wind (km/h)', 'Soil Temp (°C)', 'Soil Moisture (%)', 'Soil EC (μS/cm)', 'N (mg/kg)', 'P (mg/kg)', 'K (mg/kg)', 'pH']);

            data.forEach(row => {
                csvRows.push([
                    row.date.toLocaleDateString(),
                    row.date.toLocaleTimeString(),
                    row.energia.toFixed(2),
                    row.acqua.toFixed(2),
                    row.climaTemp.toFixed(1),
                    row.humidity.toFixed(0),
                    row.co2.toFixed(0),
                    row.windSpeed.toFixed(1),
                    row.temperature.toFixed(1),
                    row.terreno.toFixed(0),
                    row.ec.toFixed(0),
                    row.nitrogen.toFixed(0),
                    row.phosphorus.toFixed(0),
                    row.potassium.toFixed(0),
                    row.pH.toFixed(1)
                ]);
            });

            const csvString = csvRows.map(e => e.join(",")).join("\n");
            const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            link.setAttribute("href", url);
            link.setAttribute("download", `rayat_full_data_168h.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        /* --- Navigation & Auth Helpers --- */

        async function login(e) {
            e.preventDefault();
            const email = document.getElementById('email').value.trim().toLowerCase();
            const password = document.getElementById('password').value.trim();

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
                    localStorage.setItem('rayat_token', authToken);
                    user = data.user;
                    currentRole = user.role || 'client';
                    localStorage.setItem('rayat_user', JSON.stringify(user));
                    hideSubscriptionExpiredModal();

                    if (window.Capacitor && window.Capacitor.Plugins.Haptics) {
                        await window.Capacitor.Plugins.Haptics.notification({ type: 'success' });
                    }

                    if (user.role === 'super_admin' || user.role === 'operator_admin' || user.role === 'operator' || user.role === 'admin') {
                        // Store token in sessionStorage under admin panel keys → no second login needed
                        sessionStorage.setItem('rayat_admin_token', data.token);
                        sessionStorage.setItem('rayat_admin_user', JSON.stringify(data.user));
                        window.location.href = `${API_ORIGIN}/admin/`;
                    } else {
                        setView('demo');
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
            clearPublicSession();
            setView('home', { replace: true });
        }

        function setView(view, options = {}) {
            const nextPath = options.path || getPathForView(view);
            isMobileMenuOpen = false;
            syncBodyScrollLock();

            // Mobile UX: Update history for back button handling
            if (currentView !== view || window.location.pathname !== nextPath) {
                const historyMethod = options.replace ? 'replaceState' : 'pushState';
                history[historyMethod]({ view: view }, '', nextPath);
            }
            currentView = view;
            if (view !== 'demo') {
                hideSubscriptionExpiredModal();
            }
            render();
            window.scrollTo({ top: 0, behavior: 'instant' });

            // Re-initialize maps for specific views
            if (view === 'home') setTimeout(initHomeMap, 100);
            if (view === 'contatti') setTimeout(initContactMap, 100);
        }

        async function setSensor(sensor) {
            selectedSensor = sensor;
            render();
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

        async function loadSensorData() {
            // Always ensure we have some data to show (Demo Mode)
            if (globalHistory.length === 0) {
                generateSimulationData();
            }

            if (!authToken) {
                hideSubscriptionExpiredModal();
                const cached = localStorage.getItem('rayat_sensor_cache');
                if (cached) {
                    try {
                        updateSensorData(JSON.parse(cached), true);
                    } catch (e) { /* ignore cache error in demo mode */ }
                }
                dataError = false; // Always false for Demo Mode
                return;
            }

            if (!isCustomerRole(currentRole)) {
                hideSubscriptionExpiredModal();
                dataError = false;
                return;
            }

            try {
                const response = await fetch(`${CONFIG.API_BASE_URL}/sensors/latest`, {
                    headers: { 'Authorization': `Bearer ${authToken}` }
                });
                
                if (response.status === 401 || response.status === 403) {
                    const errorData = await response.json().catch(() => ({}));
                    if (response.status === 403 && errorData.error === 'subscription_expired' && user && isCustomerRole(currentRole)) {
                        showSubscriptionExpiredModal();
                        return;
                    }

                    clearPublicSession({ keepCurrentView: true });
                    return;
                }
                
                if (response.ok) {
                    const result = await response.json();
                    if (result.success && result.data) {
                        localStorage.setItem('rayat_sensor_cache', JSON.stringify(result.data));
                        updateSensorData(result.data);
                        lastRefreshed = new Date();
                        dataError = false;
                        document.getElementById('offline-banner').style.display = 'none';
                    }
                }
            } catch (error) { }
            
            // In Demo Mode, we NEVER set dataError to true
            dataError = false;
            
            // If offline or error, we might still want to show the offline banner if using cache
            // but the overlay must stay hidden.
            const cached = localStorage.getItem('rayat_sensor_cache');
            if (cached) {
                try {
                    updateSensorData(JSON.parse(cached), true);
                    document.getElementById('offline-banner').style.display = 'block';
                    document.getElementById('offline-banner').innerText = t('usingCache');
                } catch (e) { }
            }
            
            render(); 
        }

        async function refreshData() {
            const btn = document.getElementById('refresh-btn-icon');
            if (btn) btn.classList.add('animate-spin-once');

            await loadSensorData();
            render();

            if (btn) {
                setTimeout(() => {
                    btn.classList.remove('animate-spin-once');
                }, 800);
            }
        }

        function updateSensorData(apiData, fromCache = false) {
            if (!apiData || !Array.isArray(apiData)) return;

            const typeMap = {
                'energia_consumption': { s: 'energia', val: true },
                'acqua_level': { s: 'acqua', val: true },
                'terreno_moisture': { s: 'terreno', val: true, key: 'moisture' },
                'terreno_temperature': { s: 'terreno', key: 'temperature' },
                'terreno_ec': { s: 'terreno', key: 'ec' },
                'terreno_ph': { s: 'terreno', key: 'pH' },
                'terreno_n': { s: 'terreno', key: 'nitrogen' },
                'clima_temperature': { s: 'clima', val: true, key: 'temperature' },
                'clima_humidity': { s: 'clima', key: 'humidity' },
                'clima_co2': { s: 'clima', key: 'co2' }
            };

            let updated = false;
            apiData.forEach(r => {
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
            if (updated) render();
        }

        /* --- Predictive Intelligence Logic --- */


        /* --- Alert System Logic --- */

        function checkAlerts() {
            activeAlerts = [];
            if (sensorData.energia.valore > alertSettings.energia.maxConsumption) {
                activeAlerts.push({ type: 'warning', msg: 'alertMsgEnergy', sensor: 'energia' });
            }
            if (sensorData.acqua.valore < alertSettings.acqua.minLevel) {
                activeAlerts.push({ type: 'critical', msg: 'alertMsgWater', sensor: 'acqua' });
            }
            if (sensorData.terreno.valore < alertSettings.terreno.minMoisture) {
                activeAlerts.push({ type: 'warning', msg: 'alertMsgSoil', sensor: 'terreno' });
            }
            if (sensorData.clima.valore > alertSettings.clima.maxTemp) {
                activeAlerts.push({ type: 'critical', msg: 'alertMsgTempHigh', sensor: 'clima' });
            } else if (sensorData.clima.valore < alertSettings.clima.minTemp) {
                activeAlerts.push({ type: 'warning', msg: 'alertMsgTempLow', sensor: 'clima' });
            }

            // Capacitor: Push Notification (FCM Bridge Placeholder)
            if (activeAlerts.length > 0 && window.Capacitor && window.Capacitor.Plugins.PushNotifications) {
                // Notification logic for background/push would go here
            }
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
            if (!authToken || !user || !isCustomerRole(currentRole)) {
                return;
            }

            const modal = document.getElementById('subscription-expired-modal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
                document.body.style.overflow = 'hidden'; // Prevent scrolling
                
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

            document.body.style.overflow = '';
            const skel = document.getElementById('view-skeleton');
            if (skel) skel.style.display = '';
        }

        function goToLogin() {
            clearPublicSession();
            setView('login', { replace: true, path: '/login' });
        }

        function continueWithoutLogin() {
            clearPublicSession();
            setView('home', { replace: true, path: '/' });
        }

        function openSupportWhatsapp() {
            window.open('https://wa.me/212628265466', '_blank', 'noopener');
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
                                    <span class="text-xl">${alert.type === 'critical' ? '🚨' : '⚠️'}</span>
                                    <div>
                                        <p class="font-bold text-sm text-gray-800">${t(alert.msg)}</p>
                                        <p class="text-xs text-gray-500 capitalize">${t('sensor' + alert.sensor.charAt(0).toUpperCase() + alert.sensor.slice(1, 2) + 'Name')}</p>
                                    </div>
                                </div>
                            `).join('')
                }
                    </div>
                </div>
            `;
        }

        function renderHeader(isLoggedIn) {
            const flagBase = "inline-block shadow-sm rounded-sm align-middle h-[16px] w-[24px] min-w-[24px] mb-0.5 object-cover";
            const italyFlag = `<svg class="${flagBase}" viewBox="0 0 3 2" width="24" height="16"><rect width="1" height="2" fill="#009246"/><rect width="1" height="2" x="1" fill="#fff"/><rect width="1" height="2" x="2" fill="#ce2b37"/></svg>`;
            const franceFlag = `<svg class="${flagBase}" viewBox="0 0 3 2" width="24" height="16"><rect width="1" height="2" fill="#002395"/><rect width="1" height="2" x="1" fill="#fff"/><rect width="1" height="2" x="2" fill="#ed2939"/></svg>`;
            const moroccoFlag = `<svg class="${flagBase}" viewBox="0 0 3 2" width="24" height="16"><rect width="3" height="2" fill="#c1272d"/><path d="M1.5 0.6L1.8 1.4L1.1 0.9H1.9L1.2 1.4z" fill="none" stroke="#006233" stroke-width="0.1" transform="scale(0.8) translate(0.4, 0.4)"/></svg>`;
            const ukFlag = `<svg class="${flagBase}" viewBox="0 0 60 40" width="24" height="16"><clipPath id="s"><path d="M0,0 v40 h60 v-40 z"/></clipPath><path d="M0,0 v40 h60 v-40 z" fill="#012169"/><path d="M0,0 L60,40 M60,0 L0,40" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,40 M60,0 L0,40" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v40 M0,20 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v40 M0,20 h60" stroke="#C8102E" stroke-width="6"/></svg>`;
            const amazighFlag = `<svg class="${flagBase}" viewBox="0 0 90 60" width="24" height="16" xmlns="http://www.w3.org/2000/svg"><rect width="90" height="20" y="0" fill="#0099CC"/><rect width="90" height="20" y="20" fill="#99CC33"/><rect width="90" height="20" y="40" fill="#FFCC00"/><text x="45" y="48" font-size="40" fill="#CC3333" text-anchor="middle" font-family="sans-serif">ⵣ</text></svg>`;
            const primaryLinks = [
                { view: 'home', label: t('home') },
                { view: 'servizi', label: t('services') },
                { view: 'chi-siamo', label: t('aboutUs') },
                { view: 'contatti', label: t('contactTitle') },
                { view: 'demo', label: t('demo') }
            ];
            const mobileLinks = [
                ...primaryLinks,
                { view: 'privacy', label: t('privacyPolicy') },
                { view: 'terms', label: t('termsOfService') }
            ];
            const authButton = isLoggedIn || user
                ? `<button onclick="logout()" class="bg-red-500 hover:bg-red-600 px-5 py-2 rounded-xl transition text-xs font-black uppercase tracking-widest shadow-lg">${t('logout')}</button>`
                : `<button onclick="setView('login')" class="bg-orange-500 hover:bg-orange-600 px-5 py-2 rounded-xl transition text-xs font-black uppercase tracking-widest shadow-lg">${t('login')}</button>`;

            return `
                <div id="offline-banner"></div>
                ${renderAlertSettings()}
                <header class="bg-green-800 text-white py-4 sticky top-0 z-50 shadow-lg safe-area-top">
                    <div class="container mx-auto px-4">
                        <div class="flex justify-between items-center gap-4">
                            <div class="flex items-center space-x-3 cursor-pointer" onclick="setView('home')">
                                <img src="icons/tree-silver.png" alt="Rayat Logo"
                                     class="h-12 w-auto"
                                     style="filter:brightness(0) invert(1);" />
                                <div>
                                    <h1 class="text-3xl font-black tracking-tighter text-white">RAYAT</h1>
                                    <p class="text-[10px] text-green-200 uppercase font-bold tracking-widest">${t('appSubtitle')}</p>
                                </div>
                            </div>
                            <div class="flex items-center gap-3 md:gap-4">
                                <nav class="rayat-desktop-nav items-center space-x-6 font-bold uppercase text-xs tracking-widest">
                                    ${primaryLinks.map((link) => `
                                        <a onclick="setView('${link.view}')" class="cursor-pointer hover:text-orange-400 transition ${link.view === 'chi-siamo' ? 'whitespace-nowrap' : ''}">
                                            ${link.label}
                                        </a>
                                    `).join('')}
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
                                <div class="rayat-desktop-auth">${authButton}</div>
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
                            ${mobileLinks.map((link) => `
                                <button onclick="navigateFromMobileMenu('${link.view}')" class="text-left w-full px-4 py-4 rounded-2xl bg-slate-50 hover:bg-green-50 font-black uppercase tracking-widest text-xs text-slate-800 transition">
                                    ${link.label}
                                </button>
                            `).join('')}
                        </nav>
                        <div class="mt-6 pt-6 border-t border-slate-200">
                            ${isLoggedIn || user
                                ? `<button onclick="toggleMobileMenu(false); logout()" class="w-full bg-red-500 hover:bg-red-600 text-white py-4 rounded-2xl font-black uppercase tracking-widest text-xs">${t('logout')}</button>`
                                : `<button onclick="navigateFromMobileMenu('login')" class="w-full bg-orange-500 hover:bg-orange-600 text-white py-4 rounded-2xl font-black uppercase tracking-widest text-xs">${t('login')}</button>`
                            }
                        </div>
                    </div>
                </div>`;
        }

        function renderHomePage() {
            return `
                ${renderHeader(!!user)}
                
                <section class="bg-gradient-to-r from-green-700 to-green-900 text-white py-20">
                    <div class="container mx-auto px-4 text-center">
                        <h2 class="text-5xl font-bold mb-6">${t('hero')}</h2>
                        <p class="text-xl mb-8">${t('heroSub')}</p>
                        <p class="text-lg mb-8 text-green-100">✅ ${t('insurance')}</p>
                        <div class="rayat-mobile-actions flex gap-4 justify-center">
                            <button onclick="setView('demo')" class="bg-orange-500 hover:bg-orange-600 px-8 py-4 rounded-lg text-lg font-semibold transition transform hover:scale-105">
                                ${t('tryDemo')}
                            </button>
                            <button onclick="setView('servizi')" class="bg-white text-green-800 px-8 py-4 rounded-lg text-lg font-semibold transition transform hover:scale-105">
                                ${t('discoverServices')}
                            </button>
                        </div>
                    </div>
                </section>

                <section class="py-16 bg-white">
                    <div class="container mx-auto px-4">
                        <h3 class="text-4xl font-bold text-center mb-12 text-green-800">${t('ourSensors')}</h3>
                        <div class="grid grid-cols-2 lg:grid-cols-4 gap-10">
                            ${Object.keys(sensorData).map(key => {
                const sensor = sensorData[key];
                return `
                                    <div class="bg-white p-12 rounded-[3rem] shadow-[0_20px_50px_rgba(0,0,0,0.1)] hover:shadow-[0_40px_80px_rgba(0,0,0,0.15)] transition-all duration-700 cursor-pointer transform hover:scale-110 hover:-translate-y-4 flex flex-col items-center justify-center group" onclick="setView('servizi'); setTimeout(() => { document.getElementById('service-${key}').scrollIntoView({behavior: 'smooth'}); }, 100);">
                                        <div class="text-8xl mb-6 transition-transform group-hover:scale-110 duration-500">${sensor.icon}</div>
                                        <h4 class="text-2xl font-black text-gray-800 text-center uppercase tracking-tighter">${t(sensor.nome)}</h4>
                                    </div>
                                `;
            }).join('')}
                        </div>
                    </div>
                </section>
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

                        <div class="relative bg-white p-2 rounded-[2.5rem] shadow-2xl overflow-hidden border-4 border-white">
                            <div id="home-map" style="height: 600px; width: 100%; z-index: 10;" class="rounded-[2rem]"></div>
                            
                            <!-- Legend -->
                            <div class="absolute bottom-12 left-12 z-[1000] bg-white/90 backdrop-blur-md p-6 rounded-3xl shadow-2xl border border-white/50 space-y-4">
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

                            <!-- Floating Badge -->
                            <div class="absolute top-8 right-8 z-[1000] bg-orange-600 text-white px-8 py-3 rounded-full font-black uppercase tracking-widest text-xs shadow-2xl animate-bounce">
                                📍 Forte presenza in Souss-Massa
                            </div>
                        </div>
                    </div>
                </section>

                ${renderFooter()}
            `;
        }

        function renderLoginPage() {
            return `
                ${renderHeader(false)}
            <div class="min-h-screen flex items-center justify-center py-12 px-4 bg-gray-50">
                <div class="max-w-md w-full bg-white rounded-xl shadow-2xl p-8">
                    <h2 class="text-3xl font-bold text-green-800 mb-6 text-center">${t('loginTitle')}</h2>

                    <div id="error" class="hidden bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4 text-center">
                        ${t('loginError')}
                    </div>

                    <form onsubmit="login(event)" class="space-y-6">
                        <div>
                            <label class="block text-sm font-medium mb-2">${t('emailLabel')}</label>
                            <input type="email" id="email" required class="w-full px-4 py-3 border rounded-lg" placeholder="nome@azienda.com">
                        </div>
                        <div>
                            <label class="block text-sm font-medium mb-2">${t('passwordLabel')}</label>
                            <input type="password" id="password" required class="w-full px-4 py-3 border rounded-lg" placeholder="••••••••">
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
                        <p class="text-gray-600 mb-2">Non hai un account?</p>
                        <button onclick="registrationStep = 1; setView('register')" class="text-green-700 font-bold hover:underline">
                            Registrati ora 🌾
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
                            <div>
                                <label class="block text-sm font-medium mb-2">${t('newPasswordLabel')}</label>
                                <input type="password" id="reset-password" required class="w-full px-4 py-3 border rounded-2xl" minlength="8">
                            </div>
                            <div>
                                <label class="block text-sm font-medium mb-2">${t('confirmPasswordLabel')}</label>
                                <input type="password" id="reset-password-confirm" required class="w-full px-4 py-3 border rounded-2xl" minlength="8">
                            </div>
                            <button type="submit" class="w-full bg-green-700 hover:bg-green-800 text-white py-3 rounded-2xl font-semibold transition">
                                ${t('resetPasswordSubmit')}
                            </button>
                        </form>

                        <div class="mt-6 text-center">
                            <button onclick="setView('login')" class="text-sm text-green-700 font-bold hover:underline">
                                ${t('backToLogin')}
                            </button>
                        </div>
                    </div>
                </div>
                ${renderFooter()}
            `;
        }

        function renderRegisterPage() {
            const selectedCrop = registrationData.crop_type || '';
            const customCropValue = Object.values(CROP_CATEGORIES).flat().includes(selectedCrop) ? '' : selectedCrop;
            const coordinatesLabel = registrationData.latitude && registrationData.longitude
                ? `${Number(registrationData.latitude).toFixed(5)}, ${Number(registrationData.longitude).toFixed(5)}`
                : '—';

            setTimeout(initRegistrationMap, 100);

            return `
                ${renderHeader(false)}
                <div class="min-h-screen py-8 px-4 bg-gray-50">
                    <div class="max-w-3xl mx-auto bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100">
                        <div class="bg-gradient-to-r from-green-900 via-green-800 to-green-700 text-white px-6 py-8">
                            <div class="text-xs font-black tracking-[0.28em] uppercase text-green-200 mb-3">${t('regPersonalData')}</div>
                            <h2 class="text-3xl font-black tracking-tight mb-3">${t('regVerifyTitle')}</h2>
                            <p class="text-sm text-green-50 max-w-2xl leading-relaxed">${t('regPrivacyNote')}</p>
                        </div>

                        <div class="p-6 md:p-8 space-y-8">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-sm font-semibold mb-2">${t('regFullName')} *</label>
                                    <input type="text" id="reg-name" value="${registrationData.name}" class="w-full px-4 py-3 border rounded-xl" placeholder="Es. Ahmed El Mansouri">
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold mb-2">${t('regPhone')} *</label>
                                    <input type="tel" id="reg-phone" value="${registrationData.phone}" class="w-full px-4 py-3 border rounded-xl" placeholder="+212 6XX XXX XXX">
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold mb-2">${t('regEmailOpt')} *</label>
                                    <input type="email" id="reg-email" value="${registrationData.email}" class="w-full px-4 py-3 border rounded-xl" placeholder="email@esempio.com">
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold mb-2">${t('regPass')} *</label>
                                    <input type="password" id="reg-password" value="${registrationData.password}" class="w-full px-4 py-3 border rounded-xl" placeholder="${t('regPassHint')}">
                                </div>
                                <div class="md:col-span-2">
                                    <label class="block text-sm font-semibold mb-2">${t('regLocationRegion')} *</label>
                                    <input
                                        type="text"
                                        id="reg-location"
                                        value="${registrationData.location_name}"
                                        oninput="registrationData.location_name = this.value"
                                        class="w-full px-4 py-3 border rounded-xl"
                                        placeholder="${t('regLocationRegionHint')}"
                                    >
                                </div>
                            </div>

                            <div class="rounded-2xl border border-green-100 bg-green-50/70 p-5">
                                <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
                                    <div>
                                        <h3 class="text-lg font-black text-green-900">${t('regCropOptional')}</h3>
                                        <p class="text-sm text-green-800/80">${t('regAgriType')}</p>
                                    </div>
                                    <span class="text-[11px] font-bold uppercase tracking-widest text-green-700">Optional</span>
                                </div>
                                <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                                    ${Object.keys(CROP_CATEGORIES).slice(0, 4).map(cat =>
                                        CROP_CATEGORIES[cat].slice(0, 3).map(crop => `
                                            <button onclick="selectCrop('${crop.replace(/'/g, "\\'")}')" class="p-3 border-2 rounded-xl text-sm text-center transition ${selectedCrop === crop ? 'border-green-600 bg-white font-bold text-green-800' : 'border-green-100 bg-white/80 hover:border-green-300'}">
                                                ${crop}
                                            </button>
                                        `).join('')
                                    ).join('')}
                                </div>
                                <div class="mt-4">
                                    <label class="block text-sm font-semibold mb-2">${t('regOtherCrop')}</label>
                                    <input
                                        type="text"
                                        id="custom-crop"
                                        value="${customCropValue}"
                                        oninput="registrationData.crop_type = this.value"
                                        class="w-full px-4 py-3 border rounded-xl"
                                        placeholder="Zafferano, Erba medica..."
                                    >
                                </div>
                            </div>

                            <div class="rounded-2xl border border-blue-100 bg-blue-50/60 p-5">
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

        function selectCrop(crop) {
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
            registrationData.name = document.getElementById('reg-name')?.value.trim() || '';
            registrationData.phone = document.getElementById('reg-phone')?.value.trim() || '';
            registrationData.email = document.getElementById('reg-email')?.value.trim() || '';
            registrationData.password = document.getElementById('reg-password')?.value || '';
            registrationData.location_name = document.getElementById('reg-location')?.value.trim() || '';
            registrationData.location_address = registrationData.location_address || registrationData.location_name;

            if (!registrationData.name || !registrationData.phone || !registrationData.email || !registrationData.password || !registrationData.location_name) {
                alert(t('regRequiredFields'));
                return;
            }
            
            try {
                const res = await fetch(`${CONFIG.API_BASE_URL}/auth/register-full`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(registrationData)
                });
                const data = await res.json();
                if (data.success) {
                    authToken = data.token;
                    user = data.user;
                    localStorage.setItem('rayat_token', authToken);
                    localStorage.setItem('rayat_user', JSON.stringify(user));
                    currentRole = data.user.role || 'client';
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
                                    <div id="service-${key}" class="bg-white rounded-2xl shadow-2xl p-8 border border-gray-100">
                                        <div class="flex flex-col md:flex-row items-center md:space-x-8 mb-6">
                                            <div class="text-8xl mb-4 md:mb-0">${sensor.icon}</div>
                                            <div class="text-center md:text-left flex-grow">
                                                <h3 class="text-4xl font-bold text-green-800 mb-2">${t(sensor.nome)}</h3>
                                                <p class="text-xl text-gray-600">${t(sensor.descrizioneEstesa || sensor.descrizione)}</p>
                                            </div>
                                            <div class="mt-4 md:mt-0">
                                                <button onclick="setSensor('${key}'); setView('demo')" class="w-full md:w-auto bg-orange-500 hover:bg-orange-600 text-white px-8 py-4 rounded-lg text-lg font-bold transition transform hover:scale-105 shadow-lg">
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
                        <button onclick="setView(user ? 'demo' : 'login')" class="bg-green-700 hover:bg-green-800 text-white px-8 py-4 rounded-lg text-lg font-semibold transition">
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
                <div class="bg-gray-50 min-h-screen">
                    <!-- Hero Section -->
                    <section class="bg-green-800 text-white py-16 px-4">
                        <div class="container mx-auto text-center max-w-3xl">
                            <h2 class="text-4xl md:text-5xl font-black mb-4 uppercase tracking-tighter">${t('contactTitle')}</h2>
                            <p class="text-xl text-green-100 font-medium">${t('contactSub')}</p>
                        </div>
                    </section>

                    <div class="container mx-auto px-4 -mt-10 pb-20">
                        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                            
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
                                                <a href="https://wa.me/${contactSettings.whatsapp.replace(/[^0-9]/g, '')}" target="_blank" class="text-sm text-green-600 font-bold hover:underline">Chatta ora ➡️</a>
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
                                    <div id="contact-map" class="h-[400px] w-full bg-gray-200"></div>
                                </div>

                                <!-- Founder Section -->
                                <div class="bg-gradient-to-r from-orange-400 to-orange-500 rounded-3xl p-8 md:p-12 text-white shadow-xl relative overflow-hidden">
                                     <div class="relative z-10">
                                        <h3 class="text-3xl font-black mb-4 uppercase tracking-tighter">${t('founderSection')}</h3>
                                        <p class="text-xl font-medium opacity-90 max-w-2xl">${t('founderText')}</p>
                                     </div>
                                     <span class="absolute -right-10 -bottom-10 text-9xl opacity-20 transform rotate-12">🤝</span>
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

        function initContactMap() {
            setTimeout(() => {
                const mapEl = document.getElementById('contact-map');
                if (!mapEl) return;
                const map = L.map('contact-map').setView([contactSettings.mapLat, contactSettings.mapLng], 15);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap'
                }).addTo(map);
                L.marker([contactSettings.mapLat, contactSettings.mapLng]).addTo(map)
                    .bindPopup(`<b class="text-green-800">${contactSettings.officeName}</b><br>${contactSettings.officeAddress}`)
                    .openPopup();
            }, 100);
        }

        let homeMapInstance = null;
        function initHomeMap() {
            setTimeout(() => {
                const mapEl = document.getElementById('home-map');
                if (!mapEl) return;

                // Dispose of previous instance if it exists to allow re-initialization
                if (homeMapInstance) {
                    homeMapInstance.remove();
                    homeMapInstance = null;
                }

                // Center on Morocco (with a focus shift towards Souss-Massa)
                const map = L.map('home-map').setView([30.5, -9.0], 6);
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
            }, 100);
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
            return `
                <footer class="bg-black text-white py-16 text-center safe-area-bottom">
                    <div class="container mx-auto px-4">
                        <div class="flex justify-center items-center space-x-3 mb-6">
                            <img src="icons/tree-silver.png" alt="Rayat Logo"
                                 class="h-14 w-auto"
                                 style="filter:brightness(0) invert(1);" />
                            <h2 class="text-4xl font-black tracking-tighter text-white">RAYAT</h2>
                        </div>
                        <nav class="flex justify-center space-x-6 mb-8 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                            <a href="#" onclick="setView('contatti')" class="hover:text-white transition uppercase">${t('contactTitle')}</a>
                            <a href="#" onclick="setView('privacy')" class="hover:text-white transition">${t('privacyPolicy') || 'Privacy Policy'}</a>
                            <a href="#" onclick="setView('terms')" class="hover:text-white transition">${t('termsOfService') || 'Terms of Service'}</a>
                        </nav>
                        <div class="max-w-md mx-auto h-px bg-white/10 mb-8"></div>
                        <p class="text-gray-500 text-[10px] font-black uppercase tracking-[0.3em]">${t('footerRights')}</p>
                    </div>
                </footer>`;
        }


        function renderDemoPage() {
            const current = sensorData[selectedSensor];



            const render7in1 = () => {
                const details = sensorData.terreno.details;
                const soilRanges = {
                    moisture: { min: 0, max: 100, zones: [{ to: 30, c: 'red' }, { to: 40, c: 'yellow' }, { to: 60, c: 'green' }, { to: 70, c: 'yellow' }, { to: 100, c: 'red' }] },
                    temperature: { min: 0, max: 45, zones: [{ to: 13, c: 'red' }, { to: 18, c: 'yellow' }, { to: 28, c: 'green' }, { to: 45, c: 'red' }] },
                    ec: { min: 0, max: 2, zones: [{ to: 0.2, c: 'red' }, { to: 0.4, c: 'yellow' }, { to: 2, c: 'green' }] },
                    pH: { min: 3, max: 10, zones: [{ to: 5.5, c: 'red' }, { to: 6.0, c: 'yellow' }, { to: 7.0, c: 'green' }, { to: 7.5, c: 'yellow' }, { to: 10, c: 'red' }] },
                    nitrogen: { min: 0, max: 100, zones: [{ to: 30, c: 'red' }, { to: 60, c: 'green' }, { to: 100, c: 'yellow' }] },
                    phosphorus: { min: 0, max: 60, zones: [{ to: 15, c: 'red' }, { to: 20, c: 'yellow' }, { to: 60, c: 'green' }] },
                    potassium: { min: 0, max: 300, zones: [{ to: 60, c: 'red' }, { to: 100, c: 'yellow' }, { to: 300, c: 'green' }] },
                };
                const colorMap = { green: '#22c55e', yellow: '#eab308', red: '#ef4444' };
                const labelMap = { green: 'Optimal ✅', yellow: 'Attention ⚠️', red: 'Alerte 🚨' };

                const rows = details.map(p => {
                    const key = p.key;
                    const rawVal = parseFloat(p.value);
                    const r = soilRanges[key];
                    const status = (() => {
                        if (!r) return 'green';
                        for (const z of r.zones) { if (rawVal <= z.to) return z.c; }
                        return r.zones[r.zones.length - 1].c;
                    })();
                    const arrowPct = r ? Math.max(0, Math.min(100, (rawVal - r.min) / (r.max - r.min) * 100)).toFixed(1) : 50;

                    const icons = { moisture: '💧', temperature: '🌡️', ec: '⚡', pH: '🧪', nitrogen: '🌿', phosphorus: '🌿', potassium: '🌿' };
                    const labels = { moisture: t('sensorSoF1'), temperature: t('sensorSoF2'), ec: t('sensorSoF3'), pH: t('sensorSoF4'), nitrogen: t('sensorSoF5'), phosphorus: t('sensorSoF6'), potassium: t('sensorSoF7') };
                    const units = { moisture: '%', temperature: '°C', ec: 'dS/m', pH: 'pH', nitrogen: 'mg/kg', phosphorus: 'mg/kg', potassium: 'mg/kg' };
                    const statusColor = colorMap[status] || '#22c55e';

                    let gradient = 'linear-gradient(to right, #22c55e, #22c55e)';
                    if (r) {
                        const span = r.max - r.min;
                        let stops = [], curr = r.min;
                        for (const z of r.zones) {
                            stops.push(`${colorMap[z.c]} ${((curr - r.min) / span * 100).toFixed(1)}%`, `${colorMap[z.c]} ${((z.to - r.min) / span * 100).toFixed(1)}%`);
                            curr = z.to;
                        }
                        gradient = `linear-gradient(to right, ${stops.join(', ')})`;
                    }

                    return `
                    <div style="background:#fff;border-radius:1.5rem;padding:1.8rem 2rem;box-shadow:0 4px 24px rgba(0,0,0,0.07);border:2px solid ${statusColor}22;transition:box-shadow .3s;" onmouseover="this.style.boxShadow='0 8px 32px rgba(0,0,0,0.13)'" onmouseout="this.style.boxShadow='0 4px 24px rgba(0,0,0,0.07)'">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.9rem;">
                            <div style="display:flex;align-items:center;gap:0.7rem;">
                                <span style="font-size:1.8rem;">${icons[key] || p.icon}</span>
                                <span style="font-size:0.75rem;font-weight:900;text-transform:uppercase;letter-spacing:0.12em;color:#64748b;">${labels[key] || t(p.label)}</span>
                            </div>
                            <span style="font-size:0.65rem;font-weight:800;padding:0.25rem 0.75rem;border-radius:999px;background:${statusColor}22;color:${statusColor};letter-spacing:0.08em;">${labelMap[status]}</span>
                        </div>
                        <div style="display:flex;align-items:baseline;gap:0.4rem;margin-bottom:1.1rem;">
                            <span style="font-size:3rem;font-weight:900;color:#0f172a;line-height:1;">${p.value}</span>
                            <span style="font-size:0.85rem;font-weight:700;color:#94a3b8;">${units[key] || p.unit || ''}</span>
                        </div>
                        <div style="position:relative;margin-bottom:0.8rem;">
                            <div style="height:14px;border-radius:999px;background:${gradient};width:100%;box-shadow:inset 0 1px 3px rgba(0,0,0,0.1);"></div>
                            <div style="position:absolute;top:-6px;left:calc(${arrowPct}% - 8px);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:16px solid #1e293b;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));transition:left 0.8s ease;"></div>
                        </div>
                        <div style="display:flex;justify-content:space-between;font-size:0.6rem;font-weight:700;color:#94a3b8;letter-spacing:0.08em;padding-top:0.3rem;">
                            <span>${r ? r.min + ' ' + (units[key] || '') : ''}</span>
                            <span>${r ? r.max + ' ' + (units[key] || '') : ''}</span>
                        </div>
                    </div>`;
                }).join('');

                return `
                <div style="margin-bottom:2.5rem;text-align:center;">
                    <div style="display:inline-flex;align-items:center;gap:15px;justify-content:center;margin-bottom:0.3rem;">
                        <h4 style="font-size:2rem;font-weight:900;color:#1e293b;text-transform:uppercase;letter-spacing:-0.03em;margin:0;">${t('sensorSoName')}</h4>
                        <div class="w-4 h-4 rounded-full ${!dataError ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,1)]' : 'bg-red-500 shadow-[0_0_15px_rgba(239,68,68,1)]'} animate-pulse"></div>
                    </div>
                    <p style="font-size:0.7rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.25em;margin-top:0;">${t('realTimeMonitoring')}</p>
                </div>
                <div class="mb-8">
                    ${renderCropSelector()}
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 mb-12">${rows}</div>`;
            };

            const renderClimate = () => {
                const colorMap = { green: '#22c55e', yellow: '#eab308', red: '#ef4444' };
                const labelMap = { green: 'Optimal ✅', yellow: 'Attention ⚠️', red: 'Alerte 🚨' };
                const climateRanges = {
                    temperature: { min: -10, max: 50, zones: [{ to: 5, c: 'red' }, { to: 18, c: 'yellow' }, { to: 32, c: 'green' }, { to: 40, c: 'yellow' }, { to: 50, c: 'red' }] },
                    humidity: { min: 0, max: 100, zones: [{ to: 20, c: 'red' }, { to: 40, c: 'yellow' }, { to: 70, c: 'green' }, { to: 85, c: 'yellow' }, { to: 100, c: 'red' }] },
                    co2: { min: 300, max: 2000, zones: [{ to: 350, c: 'yellow' }, { to: 1000, c: 'green' }, { to: 1500, c: 'yellow' }, { to: 2000, c: 'red' }] },
                    windSpeed: { min: 0, max: 100, zones: [{ to: 20, c: 'green' }, { to: 40, c: 'yellow' }, { to: 100, c: 'red' }] },
                };

                const rows = sensorData.clima.details.map(p => {
                    const key = p.key;
                    const r = climateRanges[key];
                    const rawVal = parseFloat(p.value);
                    const status = (() => {
                        if (!r) return 'green';
                        for (const z of r.zones) { if (rawVal <= z.to) return z.c; }
                        return 'red';
                    })();
                    const arrowPct = r ? Math.max(0, Math.min(100, (rawVal - r.min) / (r.max - r.min) * 100)).toFixed(1) : 50;
                    const statusColor = colorMap[status] || '#22c55e';

                    let gradient = 'linear-gradient(to right, #22c55e, #22c55e)';
                    if (r) {
                        const span = r.max - r.min;
                        let stops = [], curr = r.min;
                        for (const z of r.zones) {
                            stops.push(`${colorMap[z.c]} ${((curr - r.min) / span * 100).toFixed(1)}%`, `${colorMap[z.c]} ${((z.to - r.min) / span * 100).toFixed(1)}%`);
                            curr = z.to;
                        }
                        gradient = `linear-gradient(to right, ${stops.join(', ')})`;
                    }

                    return `
                    <div style="background:#fff;border-radius:1.5rem;padding:1.8rem 2rem;box-shadow:0 4px 24px rgba(0,0,0,0.07);border:2px solid ${statusColor}22;transition:box-shadow .3s;" onmouseover="this.style.boxShadow='0 8px 32px rgba(0,0,0,0.13)'" onmouseout="this.style.boxShadow='0 4px 24px rgba(0,0,0,0.07)'">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.9rem;">
                            <div style="display:flex;align-items:center;gap:0.7rem;">
                                <span style="font-size:1.8rem;">${p.icon}</span>
                                <span style="font-size:0.75rem;font-weight:900;text-transform:uppercase;letter-spacing:0.12em;color:#64748b;">${t(p.label)}</span>
                            </div>
                            <span style="font-size:0.65rem;font-weight:800;padding:0.25rem 0.75rem;border-radius:999px;background:${statusColor}22;color:${statusColor};letter-spacing:0.08em;">${labelMap[status]}</span>
                        </div>
                        <div style="display:flex;align-items:baseline;gap:0.4rem;margin-bottom:1.1rem;">
                            <span style="font-size:3rem;font-weight:900;color:#0f172a;line-height:1;">${p.value}</span>
                            <span style="font-size:0.85rem;font-weight:700;color:#94a3b8;">${p.unita || p.unit || ''}</span>
                        </div>
                        <div style="position:relative;margin-bottom:0.8rem;">
                            <div style="height:14px;border-radius:999px;background:${gradient};width:100%;box-shadow:inset 0 1px 3px rgba(0,0,0,0.1);"></div>
                            <div style="position:absolute;top:-6px;left:calc(${arrowPct}% - 8px);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:16px solid #1e293b;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));transition:left 0.8s ease;"></div>
                        </div>
                        <div style="display:flex;justify-content:space-between;font-size:0.6rem;font-weight:700;color:#94a3b8;letter-spacing:0.08em;padding-top:0.3rem;">
                            <span>${r ? r.min + ' ' + (p.unit || '') : ''}</span>
                            <span>${r ? r.max + ' ' + (p.unit || '') : ''}</span>
                        </div>
                    </div>`;
                }).join('');

                return `
                <div class="mb-10 text-center">
                    <div class="flex items-center justify-center gap-4 mb-2">
                        <h4 class="text-4xl font-black text-gray-800 uppercase tracking-tight m-0">${t('sensorClName')}</h4>
                        <div class="w-4 h-4 rounded-full ${!dataError ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,1)]' : 'bg-red-500 shadow-[0_0_15px_rgba(239,68,68,1)]'} animate-pulse"></div>
                    </div>
                    <p class="text-gray-400 font-bold uppercase tracking-widest text-xs mt-0">${t('realTimeMonitoring')}</p>
                </div>
                <div class="mb-8">
                    ${renderCropSelector()}
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">${rows}</div>`;
            };

            const renderWater = () => {
                let numDays = 1;
                if (filterState.period === '7d') numDays = 7;
                else if (filterState.period === '30d') numDays = 30;
                else if (filterState.period === 'custom' && filterState.customStart && filterState.customEnd) {
                    numDays = Math.ceil(Math.abs(filterState.customEnd - filterState.customStart) / (86400000)) || 1;
                }
                const req = (waterSettings.hectares || 0) * getCropConsumptionValue() * numDays;
                const avail = current.valore * 1000;
                const isShortage = avail < req;

                return `
                <div class="mb-10 text-center">
                    <div class="flex items-center justify-center gap-4 mb-2">
                        <h4 class="text-4xl font-black text-gray-800 uppercase tracking-tight m-0">${t('sensorWaName')}</h4>
                        <div class="w-4 h-4 rounded-full ${!dataError ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,1)]' : 'bg-red-500 shadow-[0_0_15px_rgba(239,68,68,1)]'} animate-pulse"></div>
                    </div>
                    <p class="text-gray-400 font-bold uppercase tracking-widest text-xs mt-0">${t('realTimeMonitoring')}</p>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
                    <div class="bg-gray-50 p-10 rounded-[2.5rem] border border-gray-100 shadow-inner">
                        <label class="block text-xs font-black text-blue-600 uppercase mb-4 tracking-tighter">${t('hectaresLabel')}</label>
                        <div class="relative">
                            <input type="number" value="${waterSettings.hectares}" oninput="updateWaterSettings(this.value, 'hectares')" class="w-full bg-white border-2 border-gray-100 rounded-3xl p-6 pr-20 font-black text-3xl text-gray-800 outline-none focus:border-blue-500 transition-all">
                            <span class="absolute right-8 top-1/2 -translate-y-1/2 font-black text-gray-300 text-xl border-l-2 border-gray-100 pl-4">${t('ha')}</span>
                        </div>
                    </div>
                    ${renderCropSelector({ label: t('cropLabel') })}
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
                </div>`;
            };

            return `
                ${renderHeader(!!user)}
            <section class="py-24 bg-gray-50 min-h-screen">
                <div class="container mx-auto px-4 max-w-[1300px]">
                    <div class="text-center mb-20">
                        <h2 class="text-7xl font-black text-green-800 tracking-tighter uppercase mb-4">${user ? t('dashboardBtn') : t('demoDashboard')}</h2>
                        <p class="text-2xl font-bold text-gray-400 uppercase tracking-widest">${t('demoDesc')}</p>
                    </div>
                    <div class="grid grid-cols-2 lg:grid-cols-4 gap-8 mb-16">
                        ${Object.keys(sensorData).map(key => {
                const isSel = selectedSensor === key;
                return `<button onclick="setSensor('${key}')" class="p-10 rounded-[3rem] transition-all duration-700 transform hover:scale-110 ${isSel ? 'bg-green-700 text-white shadow-[0_35px_60px_-15px_rgba(21,128,61,0.3)] scale-110 z-10' : 'bg-white text-gray-800 shadow-2xl hover:bg-green-50'}">
                                    <div class="text-7xl mb-6">${sensorData[key].icon}</div>
                                    <div class="text-2xl font-black uppercase tracking-tighter">${t(sensorData[key].nome)}</div>
                                </button>`;
            }).join('')}
                    </div>
                    <div class="bg-white rounded-[4rem] shadow-[-20px_40px_100px_rgba(0,0,0,0.1)] p-12 md:p-20 border border-gray-50 relative overflow-hidden">
                        <div class="absolute top-0 right-0 w-64 h-64 bg-green-50 rounded-full -mr-32 -mt-32 opacity-50"></div>
                        ${/* Demo Mode: Error overlay removed */ ''}
                        <div class="relative z-10">
                            ${selectedSensor === 'acqua' ? renderWater() : (selectedSensor === 'terreno' ? render7in1() : (selectedSensor === 'clima' ? renderClimate() : `
                                    <div class="flex flex-col md:flex-row items-center justify-between mb-16">
                                        <div class="flex items-center gap-10">
                                            <div class="text-[10rem] transform -rotate-12 transition-transform hover:rotate-0 duration-700">${current.icon}</div>
                                            <div>
                                                <div class="flex items-center gap-4">
                                                    <h3 class="text-7xl font-black text-slate-900 tracking-tighter uppercase leading-none m-0">${t(current.nome)}</h3>
                                                </div>
                                                <div class="flex items-center gap-4 mt-8">
                                                    <div class="px-6 py-2 bg-green-100 text-green-700 rounded-2xl font-black text-sm uppercase tracking-widest border border-green-200 flex items-center gap-3">
                                                        ${t('statusNormal')}
                                                        <div class="w-2.5 h-2.5 rounded-full ${!dataError ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,1)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,1)]'} animate-pulse"></div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="text-center md:text-right mt-12 md:mt-0">
                                            <div class="text-[10rem] md:text-[12rem] font-black text-slate-900 tracking-tighter leading-none">${current.valore}<span class="text-4xl text-slate-300 ml-4 uppercase font-black">${current.unita}</span></div>
                                        </div>
                                    </div>
                                    <div class="mb-10">
                                        ${renderCropSelector()}
                                    </div>
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

                                    <!-- Timestamp -->
                                    <div class="ml-auto text-right pr-4 shrink-0 whitespace-nowrap flex items-center gap-3">
                                        <div>
                                            <p class="text-[9px] font-bold text-gray-400 uppercase tracking-tight leading-none">${t('lastRefreshed')}:</p>
                                            <p class="text-[11px] font-bold text-gray-600 leading-tight">${lastRefreshed.toLocaleTimeString()}</p>
                                        </div>
                                        <button onclick="refreshData()" class="p-2 bg-gray-50 hover:bg-gray-100 rounded-lg transition border border-gray-100 group">
                                            <span class="text-sm block" id="refresh-btn-icon-small">🔄</span>
                                        </button>
                                    </div>
                            </div>

                            <!-- Dynamic History Table -->
                            <div class="bg-white rounded-[4rem] p-12 shadow-2xl border border-gray-50 overflow-hidden">
                                <div class="overflow-x-auto">
                                    <table class="w-full text-left">
                                        <thead>
                                            <tr class="border-b-8 border-gray-50">
                                                ${(() => {
                    const cols = {
                        energia: [t('time'), '⚡ ' + t('sensorEnName') + ' (kW)', t('status')],
                        acqua: [t('time'), '💧 ' + t('available') + ' (Ton)', '📉 ' + t('need') + ' (Ton)', t('status')],
                        terreno: [t('time'), '🌡️ TEMP', '💧 HUM', '⚡ EC', '🌿 N', '🌿 P', '🌿 K', '🧪 pH', t('status')],
                        clima: [t('time'), '🌡️ TEMP', '💧 HUM', '💨 CO2', '🌬️ ' + t('windSpeed'), t('status')],
                    };
                    return (cols[selectedSensor] || []).map(h => `<th class="p-8 text-[10px] font-black text-gray-300 uppercase tracking-[0.3em] ${h.includes('⚡') || h.includes('💧') || h.includes('🌡️') || h.includes('💨') || h.includes('🌬️') ? 'text-center' : ''}">${h}</th>`).join('');
                })()}
                                            </tr>
                                        </thead>
                                        <tbody class="divide-y divide-gray-50">
                                            ${getFilteredHistory().map(row => {
                    const s = selectedSensor;
                    let cells = '';
                    const timeCell = `<td class="p-8 font-black text-gray-800 text-sm whitespace-nowrap">${row.date.toLocaleDateString()} <span class="text-gray-300 ml-2 font-bold">${row.date.toLocaleTimeString()}</span></td>`;
                    const statusCell = (stat) => `<td class="p-8 text-right"><span class="px-4 py-2 ${stat === 'statusNormal' || stat === 'statusOk' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'} rounded-xl font-black text-[10px] uppercase tracking-widest">${t(stat)}</span></td>`;

                    if (s === 'energia') {
                        cells = `
                                                        ${timeCell}
                                                        <td class="p-8 text-center text-3xl font-black text-green-700">${row.energia.toFixed(2)}</td>
                                                        ${statusCell(row.status)}
                                                    `;
                    } else if (s === 'acqua') {
                        const currentHectares = parseFloat(waterSettings.hectares) || 0;
                        const consumptionPerHa = getCropConsumptionValue();
                        const req = currentHectares * consumptionPerHa;
                        const avail = row.acqua * 1000;
                        cells = `
                                                        ${timeCell}
                                                        <td class="p-8 text-center text-3xl font-black text-blue-700">${avail.toLocaleString()}</td>
                                                        <td class="p-8 text-center text-2xl font-black text-blue-900">${req.toLocaleString()}</td>
                                                        ${statusCell(avail < req ? 'statusAlert' : 'statusOk')}
                                                    `;
                    } else if (s === 'terreno') {
                        cells = `
                                                        ${timeCell}
                                                        <td class="p-6 text-center text-xl font-black ${row.isOptimalTemp ? 'text-green-600' : 'text-red-600'}">${row.temperature.toFixed(1)}</td>
                                                        <td class="p-6 text-center text-xl font-black ${row.isOptimalMoisture ? 'text-green-600' : 'text-red-600'}">${row.terreno.toFixed(0)}</td>
                                                        <td class="p-6 text-center text-xl font-black ${row.isOptimalEC ? 'text-green-600' : 'text-red-600'}">${row.ec.toFixed(0)}</td>
                                                        <td class="p-6 text-center text-xl font-black ${row.isOptimalN ? 'text-green-600' : 'text-red-600'}">${row.nitrogen.toFixed(0)}</td>
                                                        <td class="p-6 text-center text-xl font-black ${row.isOptimalP ? 'text-green-600' : 'text-red-600'}">${row.phosphorus.toFixed(0)}</td>
                                                        <td class="p-6 text-center text-xl font-black ${row.isOptimalK ? 'text-green-600' : 'text-red-600'}">${row.potassium.toFixed(0)}</td>
                                                        <td class="p-6 text-center text-xl font-black ${row.isOptimalPH ? 'text-green-600' : 'text-red-600'}">${row.pH.toFixed(1)}</td>
                                                        ${statusCell(row.status)}
                                                    `;
                    } else if (s === 'clima') {
                        cells = `
                                                        ${timeCell}
                                                        <td class="p-8 text-center text-3xl font-black text-orange-600">${row.climaTemp.toFixed(1)}</td>
                                                        <td class="p-8 text-center text-3xl font-black text-blue-600">${row.humidity.toFixed(0)}</td>
                                                        <td class="p-8 text-center text-3xl font-black text-gray-600">${row.co2.toFixed(0)}</td>
                                                        <td class="p-8 text-center text-3xl font-black text-blue-400">${row.windSpeed.toFixed(1)}</td>
                                                        ${statusCell(row.status)}
                                                    `;
                    }
                    return `<tr class="hover:bg-gray-50 transition duration-300">${cells}</tr>`;
                }).join('')}
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
            whatsapp: '+212 628 265466',
            email: 'zakariaabid@hotmail.it',
            officeName: 'Rayat Agriculture Technology',
            officeCity: 'Taroudant',
            officeRegion: 'Souss-Massa',
            officeCountry: 'Marocco',
            officeAddress: 'Business Building, Taroudant',
            lat: 30.4703,
            lng: -8.8770
        };

        let registrationStep = 1;
        let registrationData = {
            name: '', phone: '', email: '', password: '',
            crop_type: '', latitude: null, longitude: null, location_name: '', location_address: ''
        };

        const CROP_CATEGORIES = {
            "Frutta tropicale": ["Banana", "Mango", "Avocado", "Papaya"],
            "Agrumi": ["Arancia", "Limone", "Mandarino", "Pompelmo"],
            "Ortaggi": ["Pomodoro", "Peperone", "Zucchina", "Cetriolo", "Melanzana"],
            "Cereali": ["Grano", "Mais", "Orzo"],
            "Serra": ["Pomodoro serra", "Fragola", "Peperone serra"],
            "Idroponica": ["Lattuga idroponica", "Basilico idroponico"]
        };

        function render() {
            checkAlerts();
            const app = document.getElementById('app');
            const routes = {
                'home': renderHomePage,
                'chi-siamo': renderChiSiamoPage,
                'login': renderLoginPage,
                'servizi': renderServiziPage,
                'demo': renderDemoPage,
                'register': renderRegisterPage,
                'contatti': renderContactPage,
                'privacy': renderPrivacyPage,
                'terms': renderTermsPage,
                'reset-password': renderResetPasswordPage
            };

            const viewFn = routes[currentView] || renderHomePage;
            app.innerHTML = viewFn();
            syncBodyScrollLock();

            // Post-render initialization
            // Post-render initialization
            if (currentView === 'contatti') initContactMap();
            if (currentView === 'home') initHomeMap();
            if (currentView === 'register') {
                 // Map initialization for registration is handled inside renderRegisterPage
                 // but we can ensure it here too if needed.
            }
            // removed render post-init chart calls
        }

        // removed initHistoryChart function

        // Initialize
        restorePublicSession();
        currentView = getViewFromPath(window.location.pathname);
        render();

        // Auto-refresh ogni 5 minuti (ottimizzato per sensori BGT)
        if (authToken && isCustomerRole(currentRole)) {
            loadSensorData();
            setInterval(loadSensorData, 300000);
        }

        // Handle Android hardware back button and browser back
        window.onpopstate = function (event) {
            if (event.state && event.state.view) {
                currentView = event.state.view;
                render();
            } else if (window.location.pathname) {
                currentView = getViewFromPath(window.location.pathname);
                render();
            } else if (currentView !== 'home') {
                // Return to home if no specific state (simulates Android "exit to home" before closing)
                currentView = 'home';
                render();
            }
        };

        // Initialize state
        history.replaceState({ view: currentView }, '', `${window.location.pathname}${window.location.search}${window.location.hash}`);

        document.addEventListener('click', (event) => {
            if (!event.target.closest('[data-lang-menu-toggle="true"]') && !event.target.closest('#lang-menu')) {
                document.getElementById('lang-menu')?.classList.add('hidden');
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
        });

        // Capacitor: Network Connectivity Handler
        if (window.Capacitor && window.Capacitor.Plugins.Network) {
            window.Capacitor.Plugins.Network.addListener('networkStatusChange', status => {
                if (!status.connected) {
                    document.getElementById('offline-banner').style.display = 'block';
                    document.getElementById('offline-banner').innerText = t('usingCache');
                } else {
                    document.getElementById('offline-banner').style.display = 'none';
                    loadSensorData();
                }
            });
        }

        // PWA Service Worker Registration
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js?v=20260328-upgrade08', { updateViaCache: 'none' })
                    .then(reg => {
                        reg.update().catch(() => {});
                    })
                    .catch(err => console.error('SW registration failed', err));
            });
        }
