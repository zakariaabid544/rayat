# Rayat Web App

This folder is the canonical browser/PWA source for Rayat.

Capacitor already uses this folder as `webDir`, and the backend now serves this directory directly.

## Contents

- `index.html` - public Rayat app entry point
- `admin/index.html` - admin frontend entry point
- `config.js` - browser runtime API configuration
- `assets/` - CSS, JavaScript, and logo assets
- `icons/` - PWA and app icons
- `manifest.json` - PWA manifest
- `sw.js` - service worker
- `vendor/README.md` - local browser vendor dependency notes

Server-only folders such as `backend/`, `router/`, `database/`, `deploy/`,
merge reports, shell scripts, and environment files do not belong in this
folder.

## API Configuration

The frontend no longer assumes that API calls use `window.location.origin`.
It resolves the API URL from `config.js`.

Default behavior:

- Local web development over `http://localhost`, `127.0.0.1`, or `0.0.0.0`
  uses `http://localhost:3000/api`.
- Hosted production and future Capacitor runtimes use `https://rayat.ma/api`.
- A temporary browser override can be set with `localStorage.rayat_api_base_url`.
- Analytics pageview URLs use `publicSiteUrl`, not the runtime WebView origin.

Do not put secrets in `config.js`; it is public browser code.

## Capacitor Setting

Capacitor points to:

```json
{
  "webDir": "web"
}
```

Do not point Capacitor at the project root, because the root contains backend,
router, database, deployment, and review-only files.
