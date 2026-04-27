RAYAT - README DEPLOY

1. Runtime package
- web/
- backend/
- database/schema.sql
- backend/.env.example
- package.json

2. Canonical frontend
- The only public frontend source is web/
- Backend Express serves web/ directly
- Capacitor Android/iOS also consume web/

3. Install
- Copy the package to the target server
- Copy backend/.env.example to backend/.env
- Fill the required PostgreSQL and app values
- From the package root run:
  npm install

4. Required backend environment
- DATABASE_URL
- JWT_SECRET
- PORT
- NODE_ENV
- CORS_ORIGIN
- APP_BASE_URL
- PUBLIC_APP_URL
- PASSWORD_RESET_URL

5. Optional but recommended environment
- SMTP_HOST
- SMTP_PORT
- SMTP_USER
- SMTP_PASS
- SMTP_FROM
- EMAIL_TO
- MQTT_DIRECT_ENABLED
- MQTT_BROKER
- MQTT_TOPIC
- MQTT_USERNAME
- MQTT_PASSWORD
- ALERT_JOB_CRON
- ROUTER_INTERVAL_MINUTES
- ROUTER_HEARTBEAT_INTERVAL_MINUTES
- ROUTER_HEARTBEAT_WINDOW_MINUTES
- ROUTER_OFFLINE_GRACE_MINUTES
- ROUTER_ALERT_EXTRA_MINUTES
- ALERT_NOTIFICATION_COOLDOWN_MINUTES
- ALERT_EMAILS
- ADMIN_DEFAULT_EMAIL
- ADMIN_DEFAULT_PASSWORD

6. Database
- Provision PostgreSQL
- Import database/schema.sql
- Use a valid DATABASE_URL in backend/.env
- If DATABASE_URL is missing or invalid, the backend starts but DB-backed endpoints answer 503

7. Start
- Production:
  PORT=3000 npm start
- Development:
  npm run dev

8. Health checks
- /health
- /api/health
- /api

9. Hosting rules
- Do not expose backend/ as a public static folder
- Do not expose backend/.env
- Serve only through the backend process or a reverse proxy in front of it
- Keep secrets outside version control

10. Mobile packaging
- Capacitor config already points to web/
- Before packaging, verify:
  npm run cap:doctor
