# Local Vendor Dependencies

The current web app no longer loads Tailwind, Leaflet, or jsPDF from public CDN
URLs. Browser vendor files are kept here so the PWA shell and later Capacitor
app can load core CSS/JS locally.

## Bundled Locally

- `tailwind/tailwindcss-cdn.js` from `https://cdn.tailwindcss.com`
- `leaflet/1.9.4/leaflet.css` from `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css`
- `leaflet/1.9.4/leaflet.js` from `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js`
- `leaflet/1.9.4/images/*` marker and layer-control images from Leaflet 1.9.4
- `jspdf/2.5.1/jspdf.umd.min.js` from `https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js`

## Still External By Design

- Plausible analytics is loaded through `assets/js/analytics-loader.js`.
  Disable it for mobile builds with `enablePlausible: false` in `config.js`.
- Map tile URLs still use OpenStreetMap/Carto tile servers.
- Reverse geocoding still uses OpenStreetMap Nominatim.
- API calls still require the configured Rayat backend.

## Later Optimization

Tailwind is now local, but it is still the browser CDN build. A later production
optimization can replace it with generated static CSS after a build step is
approved.
