# Quickstart Rayat

## 1. Configura PostgreSQL

Duplica il template:

```bash
cp backend/.env.example backend/.env
```

Imposta almeno:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB_NAME
JWT_SECRET=un_valore_lungo_casuale
PORT=3000
NODE_ENV=production
```

## 2. Installa dalla root

```bash
npm install
```

## 3. Avvia

```bash
PORT=3000 npm start
```

## 4. Verifiche rapide

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api
curl http://localhost:3000/api/health
```

## 5. Come interpretare gli endpoint DB

Se PostgreSQL non e' raggiungibile o `DATABASE_URL` e' errata:

- il server parte comunque
- `/health` e `/api` continuano a rispondere
- gli endpoint DB restituiscono `503`

Esempi:

```bash
curl http://localhost:3000/api/sensors/public/latest
curl http://localhost:3000/api/sensors/public/status
```

Body atteso in caso di problema DB:

```json
{
  "error": "Dati sensori pubblici temporaneamente non disponibili",
  "code": "database_unavailable",
  "database": {
    "configured": true,
    "reason": "auth_failed",
    "retryable": false
  }
}
```

## 6. Frontend

Apri:

- `http://localhost:3000/`

Il frontend servito dal backend arriva da `web/`, che e' la sorgente canonica.

## 7. Test backend

```bash
npm test
```

## 8. Modalita' sviluppo

```bash
npm run dev
```
