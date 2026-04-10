# Rayat - Piattaforma IoT di Monitoraggio Agricolo

![Rayat Logo](🌾)

**Rayat** è una piattaforma completa di monitoraggio agricolo intelligente che permette agli agricoltori di controllare i propri campi 24/7 attraverso sensori IoT e una dashboard web intuitiva.

## 🌟 Caratteristiche

- ⚡ **Monitoraggio Energia**: Consumo pompe irrigazione, rilevamento guasti
- 💧 **Livello Acqua**: Sensori GL801 per monitoraggio pozzi
- 🌱 **Terreno 7-in-1**: Umidità, temperatura, pH, NPK (azoto, fosforo, potassio)
- 🌡️ **Clima**: Temperatura, umidità, velocità vento
- 🔔 **Sistema Alert**: Notifiche in tempo reale quando i valori superano le soglie
- 🌍 **Multi-lingua**: Italiano, Inglese, Francese, Arabo, Tifinagh (Amazigh)

## 📁 Struttura Progetto

```
rayat/
├── index.html              # Frontend (dashboard web)
├── assets/
│   ├── css/               # Stili frontend pubblici
│   └── js/                # Logica frontend pubblica
├── backend/                # Backend Node.js + Express
│   ├── server.js          # Server principale
│   ├── config/            # Configurazione database
│   ├── routes/            # API endpoints
│   ├── middleware/        # Autenticazione JWT
│   └── utils/             # Utilità (alert system)
├── database/              # Schema e seed SQL
│   ├── schema.sql         # Struttura database
│   └── seed.sql           # Dati demo
└── README.md
```

## 🚀 Setup Rapido

### 1. Prerequisiti

- **Node.js** 16+ ([Download](https://nodejs.org/))
- **MySQL** 5.7+ o **MariaDB** 10.2+ ([Download](https://www.mysql.com/))
- Browser moderno (Chrome, Firefox, Safari, Edge)

### 2. Installazione Database

```bash
# Crea database
mysql -u root -p -e "CREATE DATABASE rayat_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# Importa schema
mysql -u root -p rayat_db < database/schema.sql

# Importa dati demo (opzionale ma consigliato)
mysql -u root -p rayat_db < database/seed.sql
```

### 3. Installazione Backend

```bash
cd backend

# Installa dipendenze
npm install

# Configura variabili ambiente
cp .env.example .env

# Modifica .env con le tue credenziali MySQL
nano .env
```

Configura `.env`:
```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=tua_password_mysql
DB_NAME=rayat_db
JWT_SECRET=CHANGE_ME_TO_A_LONG_RANDOM_SECRET
PORT=3000
```

### 4. Avvia Backend

```bash
npm start
```

Dovresti vedere:
```
🌾 ========================================
   RAYAT IoT Platform - Backend API
   ========================================

   🚀 Server in esecuzione su: http://localhost:3000
   Database: ✅ Connected
```

### 5. Apri Frontend

Apri `index.html` nel browser oppure usa un server locale:

```bash
# Opzione 1: Apri direttamente
open index.html

# Opzione 2: Usa server HTTP semplice
python3 -m http.server 8080
# Poi apri http://localhost:8080
```

### 6. Login

```
Email: il_tuo_utente@dominio.com
Password: la_tua_password
```

## 📡 API Endpoints

### Autenticazione

```bash
# Login
POST /api/auth/login
{
  "email": "il_tuo_utente@dominio.com",
  "password": "la_tua_password"
}

# Registrazione
POST /api/auth/register
{
  "email": "nuovo@email.com",
  "password": "password123",
  "name": "Nome Utente"
}
```

### Sensori

```bash
# Ultimi dati tutti i sensori
GET /api/sensors/latest
Headers: Authorization: Bearer <token>

# Storico sensore (ultimi 30 giorni)
GET /api/sensors/energia/history?days=30
Headers: Authorization: Bearer <token>

# Alert attivi
GET /api/sensors/alerts
Headers: Authorization: Bearer <token>
```

### IoT (per dispositivi)

```bash
# Upload dati da dispositivo IoT
POST /api/iot/upload
{
  "device_id": "RAYAT_DEVICE_001",
  "api_key": "demo_api_key_12345",
  "readings": [
    {"type": "energia", "subtype": "energia_consumption", "value": 2.4, "unit": "kW"},
    {"type": "acqua", "subtype": "acqua_level", "value": 14.2, "unit": "m"},
    {"type": "terreno", "subtype": "terreno_moisture", "value": 62, "unit": "%"},
    {"type": "clima", "subtype": "clima_temperature", "value": 34, "unit": "°C"}
  ]
}
```

### Bridge MQTT -> sito

```bash
# Ingestione lato sito per il bridge che legge da Mosquitto
POST /api/sensors/update

# Esempio payload minimale
{
  "sensor_id": "sensors/GW-001/clima/temperature",
  "value": 29.4,
  "device_id": "GW-001",
  "api_key": "api_key_del_device"
}
```

Formati topic supportati:

- `sensors/<device_id>/<type>/<subtype>`
- `sensors/<device_id>/<alias>` come `temperature`, `humidity`, `soil`, `water`, `energy`
- `sensors/<type>/<subtype>` oppure `sensors/<alias>` se hai configurato `MQTT_DEFAULT_DEVICE_ID` o vuoi usare il gateway auto-creato

Se configuri `MQTT_INGEST_TOKEN`, il bridge VPS puo aggiornare un device per `device_id` senza includere `api_key` nel body.

## 🔌 Collegamento Dispositivi IoT

### Esempio Python (HTTP POST)

```python
import requests
import time

API_URL = "http://localhost:3000/api/iot/upload"
DEVICE_ID = "RAYAT_DEVICE_001"
API_KEY = "demo_api_key_12345"

def send_sensor_data(energia, acqua, terreno_moisture, clima_temp):
    payload = {
        "device_id": DEVICE_ID,
        "api_key": API_KEY,
        "readings": [
            {"type": "energia", "subtype": "energia_consumption", "value": energia, "unit": "kW"},
            {"type": "acqua", "subtype": "acqua_level", "value": acqua, "unit": "m"},
            {"type": "terreno", "subtype": "terreno_moisture", "value": terreno_moisture, "unit": "%"},
            {"type": "clima", "subtype": "clima_temperature", "value": clima_temp, "unit": "°C"}
        ]
    }
    
    response = requests.post(API_URL, json=payload)
    print(f"Status: {response.status_code}, Response: {response.json()}")

# Invia dati ogni 60 secondi
while True:
    send_sensor_data(2.3, 14.5, 58, 28)
    time.sleep(60)
```

### Bridge MQTT sul VPS

Nel repository trovi uno script pronto:

- `backend/scripts/mqtt-http-bridge.js`
- `backend/scripts/mqtt-http-bridge.env.example`
- `backend/scripts/rayat-mqtt-bridge.service`

Questo processo si collega a Mosquitto su `45.63.114.40:8080`, ascolta `sensors/#` e inoltra ogni messaggio a `https://rayat.ma/api/sensors/update`.

Per un monitoraggio completamente autonomo senza Mac/PC acceso:

- esegui il backend su un server sempre acceso
- abilita `MQTT_DIRECT_ENABLED=true` nel `backend/.env`
- configura Gmail SMTP con `App Password`
- imposta `ALERT_EMAILS=zakariaabid544@gmail.com`
- imposta `ALERT_MISSING_DATA_THRESHOLD_MINUTES=45`
- imposta `ALERT_JOB_CRON=* * * * *`

Il backend programma un timer preciso 45 minuti dopo l'ultimo dato ricevuto e mantiene anche una sincronizzazione ogni minuto per recuperare automaticamente dopo eventuali riavvii del processo.

### Esempio Arduino/ESP32 (HTTP POST)

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* ssid = "TUO_WIFI";
const char* password = "TUA_PASSWORD";
const char* serverUrl = "http://192.168.1.100:3000/api/iot/upload";

void sendSensorData(float energia, float acqua, float moisture, float temp) {
  HTTPClient http;
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");
  
  String payload = "{\"device_id\":\"RAYAT_DEVICE_001\",\"api_key\":\"demo_api_key_12345\",\"readings\":[";
  payload += "{\"type\":\"energia\",\"subtype\":\"energia_consumption\",\"value\":" + String(energia) + ",\"unit\":\"kW\"},";
  payload += "{\"type\":\"acqua\",\"subtype\":\"acqua_level\",\"value\":" + String(acqua) + ",\"unit\":\"m\"},";
  payload += "{\"type\":\"terreno\",\"subtype\":\"terreno_moisture\",\"value\":" + String(moisture) + ",\"unit\":\"%\"},";
  payload += "{\"type\":\"clima\",\"subtype\":\"clima_temperature\",\"value\":" + String(temp) + ",\"unit\":\"°C\"}";
  payload += "]}";
  
  int httpCode = http.POST(payload);
  Serial.println("HTTP Code: " + String(httpCode));
  http.end();
}
```

## 🛠️ Sviluppo

### Avvia in modalità sviluppo (auto-reload)

```bash
cd backend
npm run dev
```

### Test API con curl

```bash
# Test login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"il_tuo_utente@dominio.com","password":"la_tua_password"}'

# Salva il token ricevuto
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Test get sensors
curl http://localhost:3000/api/sensors/latest \
  -H "Authorization: Bearer $TOKEN"
```

## 📊 Database Schema

- **users**: Utenti della piattaforma
- **devices**: Dispositivi IoT (router + sensori)
- **sensors**: Sensori individuali per dispositivo
- **sensor_readings**: Letture sensori (storico)
- **alert_thresholds**: Soglie allarmi configurabili
- **active_alerts**: Allarmi attivi non confermati

## 🔐 Sicurezza

- ✅ Autenticazione JWT con scadenza 7 giorni
- ✅ Password hashate con bcrypt
- ✅ API key per dispositivi IoT
- ✅ CORS configurabile
- ✅ Prepared statements per prevenire SQL injection

## 🌍 Deploy Produzione

### Backend (VPS/Cloud)

1. Configura MySQL su server remoto
2. Modifica `.env` con credenziali produzione
3. Usa PM2 per gestire processo Node.js:

```bash
npm install -g pm2
pm2 start server.js --name rayat-api
pm2 save
pm2 startup
```

4. Configura Nginx come reverse proxy
5. Abilita HTTPS con Let's Encrypt

### Frontend

- Opzione 1: Servi da backend Express (aggiungi `app.use(express.static('../'))`)
- Opzione 2: Deploy su Netlify/Vercel (modifica `API_BASE_URL` in `index.html`)

## 📞 Supporto

Per domande o problemi:
- Email: support@rayat.ma
- GitHub Issues: [github.com/rayat/rayat-platform](https://github.com/rayat/rayat-platform)

## 📄 Licenza

MIT License - vedi file LICENSE

---

**Rayat** - Terreno Sano = Raccolto Ricco 🌾
