RAYAT - README DEPLOY

1. Required files
- index.html
- assets/
- admin/
- icons/
- manifest.json
- sw.js
- backend/
- database/schema.sql
- backend/.env.example

2. Install
- Upload the package to your server
- From the package root run: npm run install:backend

3. Database import
- Create the production database
- Import: database/schema.sql
- If needed, run: npm run init:db

4. .env setup
- Copy backend/.env.example to backend/.env on the server
- Fill all required values:
  DATABASE_URL
  JWT_SECRET
  PORT
  NODE_ENV
  MQTT_DIRECT_ENABLED
  MQTT_BROKER
  MQTT_TOPIC
  MQTT_USERNAME
  MQTT_PASSWORD
  CORS_ORIGIN
  APP_BASE_URL
  PUBLIC_APP_URL
  PASSWORD_RESET_URL
  PASSWORD_RESET_EXPIRY_MINUTES
  PASSWORD_RESET_RATE_LIMIT_MAX
  SMTP_HOST
  SMTP_PORT
  SMTP_USER
  SMTP_PASS
  SMTP_FROM
  EMAIL_USER
  EMAIL_PASS
  EMAIL_FROM
  EMAIL_TO
  ALERT_JOB_CRON
  ALERT_EXPECTED_DATA_MINUTES
  ALERT_MISSING_DATA_THRESHOLD_MINUTES
  ALERT_NOTIFICATION_COOLDOWN_MINUTES
  ALERT_EMAILS
  ADMIN_DEFAULT_EMAIL
  ADMIN_DEFAULT_PASSWORD

5. SMTP setup
- Use a real SMTP provider
- SMTP_PORT=587 for STARTTLS or SMTP_PORT=465 for implicit TLS
- If you use Gmail, use `smtp.gmail.com` and a Gmail App Password (16 characters), not the normal Gmail password
- PASSWORD_RESET_URL must point to your live reset page
- Test forgot-password before opening the platform to users
- EMAIL_USER / EMAIL_PASS / EMAIL_FROM / EMAIL_TO are used for the automatic "new client registered" email notification
- If EMAIL_USER / EMAIL_PASS are omitted, the registration notification can fall back to SMTP_USER / SMTP_PASS
- For missing-data router alerts, configure `ALERT_EMAILS` with one or more comma-separated recipients

6. Fully automatic router monitoring without Mac
- Recommended setup: keep only the backend on an always-on server and enable direct MQTT ingestion in `backend/.env`
- Set `MQTT_DIRECT_ENABLED=true`
- Set `MQTT_BROKER` to your broker address, for example `mqtt://45.63.114.40:8080`
- Set `MQTT_TOPIC="sensors/#"` unless your router publishes on a different topic
- If the broker is protected, set `MQTT_USERNAME` and `MQTT_PASSWORD`
- Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- Configure `ALERT_EMAILS=zakariaabid544@gmail.com`
- Keep `ALERT_MISSING_DATA_THRESHOLD_MINUTES=45`
- Set `ALERT_JOB_CRON=* * * * *` so the server also runs the minute sync that protects the exact timer
- With this setup the server receives MQTT data directly and sends alert emails automatically even when the Mac is off
- The backend now schedules an exact timer at 45 minutes from the last reading and also keeps a 1-minute recovery sync in case the process restarts

7. Create the first super admin
- Run once after backend/.env is ready:
  npm run seed:admin
- The seeder creates the super admin only if it does not already exist

8. Start backend
- Local/dev:
  npm run dev
- Production:
  npm start
- Test email alert dal backend (usa lo stesso SMTP degli alert automatici):
  npm --prefix backend run test:alert-email
- Se il server live non espone ancora le variabili SMTP, puoi salvare la configurazione email direttamente nel database runtime con:
  npm --prefix backend run sync:live-mail-config

9. Hosting rules
- Serve index.html, assets/, admin/, icons/, manifest.json and sw.js as static files
- Do NOT expose backend/ as a public static directory
- Do NOT upload backend/.env to any public web root
- Do NOT commit backend/.env or any secrets
- Keep backup files and logs outside the public web root

10. Post-deploy checklist
- Confirm /privacy loads
- Confirm /terms loads
- Confirm admin login works
- Confirm forgot-password returns the generic response
- Confirm reset email is delivered
- Confirm reset password works
- Confirm mobile menu works on a real phone
