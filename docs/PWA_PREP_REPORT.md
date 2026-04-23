# Rayat PWA Preparation Report

Date: 2026-04-21

## Summary

This pass prepares the safe merged Rayat copy as a cleaner production PWA/web
app that can later be wrapped with Capacitor. No Android or iOS projects were
created.

## Clean Web Output

The browser app now lives in:

```text
web/
├── index.html
├── admin/
├── assets/
├── icons/
├── config.js
├── manifest.json
├── sw.js
├── vendor/
└── _redirects
```

Server-only and operational folders remain outside `web/`, including:

- `backend/`
- `router/`
- `database/`
- `deploy/`
- `_merge_report/`
- `_review_conflicts/`

## API Configuration

Frontend API calls now resolve from `web/config.js` instead of assuming
`window.location.origin`.

Current defaults:

- Local browser development: `http://localhost:3000/api`
- Production PWA and future Capacitor runtime: `https://rayat.ma/api`
- Analytics pageview URLs: `https://rayat.ma`

Temporary override for testing:

```js
localStorage.setItem('rayat_api_base_url', 'https://example.com/api');
```

## Backend Static Serving

`backend/server.js` now serves browser files from `web/` by default. The server
can be pointed to another frontend folder with `RAYAT_WEB_ROOT`.

## Vendor Dependency Status

Replaced with local files in `web/vendor/`:

- Tailwind browser CDN script
- Leaflet 1.9.4 CSS/JS, marker images, and layer-control images
- jsPDF 2.5.1 UMD browser bundle

Made configurable:

- Plausible analytics through `assets/js/analytics-loader.js`

Still external by design:

- Plausible analytics, unless disabled in `config.js`
- OpenStreetMap/Carto map tiles
- OpenStreetMap Nominatim reverse geocoding
- Rayat backend API

Later optimization:

- Tailwind is local now, but it is still the browser CDN build. Replace it with
  generated static CSS after a build step is approved.

## Remaining Before Capacitor

- Replace the local Tailwind browser build with generated static CSS if/when a
  build step is approved.
- Confirm backend CORS for production web plus `capacitor://localhost`.
- Validate all routes in a real mobile viewport.
- Decide whether the admin panel should ship inside the mobile app.
- Add Capacitor only after the PWA folder is approved.
