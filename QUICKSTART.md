# Rayat - Guida Rapida

## 🚀 Avvio Rapido (3 Passi)

### 1. Setup Database

```bash
# Crea database
mysql -u root -p -e "CREATE DATABASE rayat_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# Importa schema e dati demo
mysql -u root -p rayat_db < database/schema.sql
mysql -u root -p rayat_db < database/seed.sql
```

### 2. Avvia Backend

```bash
cd backend
npm install
npm start
```

Dovresti vedere:
```
🌾 ========================================
   RAYAT IoT Platform - Backend API
   🚀 Server in esecuzione su: http://localhost:3000
   Database: ✅ Connected
```

### 3. Apri Frontend

Apri `index.html` nel browser:
```bash
open index.html
```

**Login:**
- Email: `il_tuo_utente@dominio.com`
- Password: `la_tua_password`

---

## 📡 Test con Simulatore IoT

Simula un dispositivo IoT che invia dati:

```bash
# Installa requests (se non già installato)
pip3 install requests

# Avvia simulatore
python3 iot_simulator.py
```

Il simulatore invierà dati ogni 60 secondi. Vedrai i dati aggiornarsi nella dashboard!

---

## 🧪 Test API con curl

### Login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"il_tuo_utente@dominio.com","password":"la_tua_password"}'
```

Salva il token ricevuto:
```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Ottieni Dati Sensori
```bash
curl http://localhost:3000/api/sensors/latest \
  -H "Authorization: Bearer $TOKEN"
```

### Invia Dati da Dispositivo IoT
```bash
curl -X POST http://localhost:3000/api/iot/upload \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "RAYAT_DEVICE_001",
    "api_key": "demo_api_key_12345",
    "readings": [
      {"type": "energia", "subtype": "energia_consumption", "value": 2.4, "unit": "kW"},
      {"type": "acqua", "subtype": "acqua_level", "value": 14.2, "unit": "m"}
    ]
  }'
```

---

## 🔧 Risoluzione Problemi

### Backend non si connette al database

1. Verifica che MySQL sia in esecuzione:
   ```bash
   mysql -u root -p -e "SELECT 1"
   ```

2. Controlla credenziali in `backend/.env`:
   ```env
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=tua_password
   DB_NAME=rayat_db
   ```

### Frontend non carica dati

1. Verifica che il backend sia in esecuzione su `http://localhost:3000`
2. Apri Console Browser (F12) per vedere eventuali errori
3. Il frontend funziona anche senza backend (modalità demo)

### CORS Error

Se vedi errori CORS, verifica in `backend/.env`:
```env
CORS_ORIGIN=*
```

---

## 📊 Struttura Dati

### Formato Lettura Sensore
```json
{
  "type": "energia|acqua|terreno|clima",
  "subtype": "energia_consumption|acqua_level|terreno_moisture|clima_temperature|...",
  "value": 2.4,
  "unit": "kW|m|%|°C|..."
}
```

### Tipi Sensori Supportati

**Energia:**
- `energia_consumption` - Consumo istantaneo (kW)
- `energia_daily` - Consumo giornaliero (kWh)
- `energia_cost` - Costo (DH)

**Acqua:**
- `acqua_level` - Livello pozzo (m)
- `acqua_pressure` - Pressione (bar)

**Terreno (7-in-1):**
- `terreno_moisture` - Umidità (%)
- `terreno_temperature` - Temperatura (°C)
- `terreno_ec` - Conducibilità elettrica (dS/m)
- `terreno_ph` - pH
- `terreno_nitrogen` - Azoto (ppm)
- `terreno_phosphorus` - Fosforo (ppm)
- `terreno_potassium` - Potassio (ppm)

**Clima:**
- `clima_temperature` - Temperatura ambiente (°C)
- `clima_humidity` - Umidità relativa (%)
- `clima_wind` - Velocità vento (km/h)

---

## 🎯 Prossimi Passi

1. **Aggiungi Dispositivi Reali**: Modifica `iot_simulator.py` per leggere da sensori reali
2. **Deploy Produzione**: Segui la guida nel README.md principale
3. **Personalizza Soglie**: Modifica le soglie alert dalla dashboard
4. **Aggiungi Utenti**: Usa `/api/auth/register` per creare nuovi account

---

**Rayat** - Terreno Sano = Raccolto Ricco 🌾
