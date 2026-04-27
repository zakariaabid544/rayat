# Rayat MQTT Bridge

Bridge in Node.js che ascolta i messaggi MQTT su `sensors/#` e li inoltra via `HTTP POST` a `https://rayat.ma/api/sensors/update`.

## Modalita consigliata senza Mac

Se vuoi tutto automatico senza lasciare acceso il Mac, la strada migliore adesso e' usare il backend Rayat in modalita MQTT diretta:

- backend online 24/7
- `MQTT_DIRECT_ENABLED=true`
- il backend si collega da solo al broker MQTT
- salva i dati
- controlla se dopo 45 minuti non arrivano piu' dati
- invia l'email di alert dal server

Il bridge di questa cartella resta utile se preferisci tenere separati backend e subscriber MQTT oppure se vuoi un processo dedicato su VPS.

## Payload inviato all'API

Per ogni messaggio ricevuto, lo script invia un body JSON di questo tipo:

```json
{
  "sensor_id": "nome_topic_o_sotto_topic",
  "value": 25.5,
  "timestamp": "2026-04-07T16:00:00.000Z"
}
```

`sensor_id` usa il topic MQTT senza il prefisso `sensors/` per default. Se vuoi mantenere il topic completo, svuota `STRIP_TOPIC_PREFIX` nel file `.env`.

## Installazione

Assumendo che tu abbia Node.js 18+ sul VPS:

```bash
mkdir -p /opt/rayat-mqtt-bridge
cd /opt/rayat-mqtt-bridge
npm install
cp .env.example .env
```

Poi modifica `.env` e inserisci eventuali credenziali:

- `API_TOKEN` se `rayat.ma` richiede un token Bearer
- `API_KEY` se l'endpoint usa una chiave API custom
- `MQTT_USERNAME` e `MQTT_PASSWORD` se il broker MQTT viene protetto in futuro

## Avvio manuale

```bash
npm start
```

## Esecuzione in background con PM2

Installa PM2:

```bash
npm install -g pm2
```

Avvia il bridge:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Comandi utili:

```bash
pm2 logs rayat-mqtt-bridge
pm2 restart rayat-mqtt-bridge
pm2 status
```

## Esecuzione in background con Systemd

Copia il progetto, poi installa il service:

```bash
cp rayat-mqtt-bridge.service /etc/systemd/system/rayat-mqtt-bridge.service
systemctl daemon-reload
systemctl enable --now rayat-mqtt-bridge
```

Controllo stato e log:

```bash
systemctl status rayat-mqtt-bridge
journalctl -u rayat-mqtt-bridge -f
```

## Come funziona il parsing del payload MQTT

- Se il payload è un numero semplice, per esempio `25.5`, viene inviato come numero.
- Se il payload è JSON e contiene `value`, viene usato `value`.
- Se il payload è JSON e contiene `reading` o `data`, viene usato quel campo.
- Se il payload è un JSON con una sola chiave, viene usato il valore di quella chiave.
- Negli altri casi, viene inoltrato l'oggetto JSON completo.

## Nota importante

Questo bridge inoltra i dati a `https://rayat.ma/api/sensors/update`, ma il backend del sito deve accettare davvero quel payload ed eventualmente autenticare la richiesta. Se l'endpoint restituisce `401`, `403` o `404`, dovrai configurare il token corretto o aggiungere la route lato backend.
