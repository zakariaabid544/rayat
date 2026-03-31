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
  EMAIL_TO
  ADMIN_DEFAULT_EMAIL
  ADMIN_DEFAULT_PASSWORD

5. SMTP setup
- Use a real SMTP provider
- SMTP_PORT=587 for STARTTLS or SMTP_PORT=465 for implicit TLS
- PASSWORD_RESET_URL must point to your live reset page
- Test forgot-password before opening the platform to users
- EMAIL_USER / EMAIL_PASS / EMAIL_TO are used for the automatic "new client registered" email notification

6. Create the first super admin
- Run once after backend/.env is ready:
  npm run seed:admin
- The seeder creates the super admin only if it does not already exist

7. Start backend
- Local/dev:
  npm run dev
- Production:
  npm start

8. Hosting rules
- Serve index.html, assets/, admin/, icons/, manifest.json and sw.js as static files
- Do NOT expose backend/ as a public static directory
- Do NOT upload backend/.env to any public web root
- Do NOT commit backend/.env or any secrets
- Keep backup files and logs outside the public web root

9. Post-deploy checklist
- Confirm /privacy loads
- Confirm /terms loads
- Confirm admin login works
- Confirm forgot-password returns the generic response
- Confirm reset email is delivered
- Confirm reset password works
- Confirm mobile menu works on a real phone
