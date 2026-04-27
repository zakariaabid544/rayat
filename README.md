# Rayat

Base unica del progetto Rayat per sviluppo, packaging mobile e deploy.

## Struttura canonica

- `web/` - frontend browser/PWA canonico
- `backend/` - API Node.js/Express
- `database/` - schema SQL PostgreSQL
- `android/`, `ios/` - shell Capacitor che consumano `web/`

Il backend serve il frontend direttamente da `web/`. I file statici duplicati in root non fanno piu' parte del runtime.

## Requisiti

- Node.js 20+
- PostgreSQL 14+ raggiungibile dal backend

## Installazione reale

1. Copia il file ambiente:

```bash
cp backend/.env.example backend/.env
```

2. Compila `backend/.env` con almeno:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB_NAME
JWT_SECRET=un_valore_lungo_casuale
PORT=3000
NODE_ENV=production
```

3. Installa dalla root:

```bash
npm install
```

`postinstall` esegue automaticamente anche `npm --prefix backend install`.

## Avvio reale

```bash
PORT=3000 npm start
```

Endpoint minimi:

- `GET /health`
- `GET /api/health`
- `GET /api`

Il frontend e' servito dal backend su `http://localhost:3000/`.

## Frontend canonico

- sorgente unica: `web/`
- Capacitor usa gia' `webDir: "web"`
- backend Express serve `web/`

Per questo progetto `web/` e' la sola source of truth del frontend.

## Database readiness

Gli endpoint che dipendono dal database non vanno piu' in `500` opaco quando PostgreSQL non e' disponibile o e' configurato male.

Comportamento atteso:

- endpoint non-DB (`/health`, `/api`, `/`) continuano a rispondere
- endpoint DB rispondono `503`
- il body JSON espone `code: "database_unavailable"` e `database.reason`

Reason tipici:

- `missing_url`
- `auth_failed`
- `database_not_found`
- `schema_missing`
- `host_not_found`
- `connection_refused`
- `timeout`

## Test

```bash
npm test
```

La smoke suite backend gira senza database reale e verifica le route principali.

## Sviluppo

```bash
npm run dev
```

Questo usa `node --watch` sul backend.

## Mobile

- Android e iOS sono allineati al contenuto di `web/`
- verifica stato Capacitor:

```bash
npm run cap:doctor
```

## Deploy

In produzione servono:

- `web/`
- `backend/`
- `database/schema.sql`
- `backend/.env`

Per dettagli operativi vedi `README_DEPLOY.txt`.
