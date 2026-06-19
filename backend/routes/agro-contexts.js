// Rayat Intelligence — Sprint 2.7C · Super Admin API · Agronomic Contexts (/api/admin/agro-contexts)
// SOLO super_admin. Additivo: nessun cliente normale puo creare/modificare/eliminare contesti.
'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { normalizeAdminRole, extractAdminSessionToken } = require('../utils/admin-auth');
const CTX = require('../utils/agronomic-context');

const router = express.Router();

function extractToken(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) { return h.slice(7).trim(); }
    return extractAdminSessionToken(req);
}

// Guard: SOLO super_admin (token coerente + utente attivo + ruolo super_admin)
async function requireSuperAdmin(req, res, next) {
    try {
        const token = extractToken(req);
        if (!token) { return res.status(401).json({ error: 'Token mancante', code: 'admin_session_missing' }); }
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (normalizeAdminRole(decoded.role) !== 'super_admin') { return res.status(403).json({ error: 'Accesso riservato al Super Admin', code: 'admin_super_required' }); }
        const rows = await query('SELECT id, role, active FROM users WHERE id = ?', [decoded.id]);
        if (!rows.length || !rows[0].active) { return res.status(401).json({ error: 'Sessione non valida', code: 'admin_session_invalid' }); }
        if (normalizeAdminRole(rows[0].role) !== 'super_admin') { return res.status(403).json({ error: 'Accesso riservato al Super Admin', code: 'admin_super_required' }); }
        req.adminUser = { id: rows[0].id, role: 'super_admin' };
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Token non valido o scaduto', code: 'admin_session_invalid' });
    }
}

let schemaReady = false;
async function ready() { if (!schemaReady) { await CTX.ensureContextSchema(); schemaReady = true; } }
function wrap(fn) {
    return async (req, res) => {
        try { await ready(); await fn(req, res); }
        catch (error) { res.status(error.statusCode || 400).json({ error: error.message || 'Errore', code: 'context_error' }); }
    };
}

router.use(requireSuperAdmin);

// 1. List
router.get('/', wrap(async (req, res) => {
    const rows = await CTX.listContexts({ deviceId: req.query.device_id ? Number(req.query.device_id) : null, ownerUserId: req.query.owner_user_id ? Number(req.query.owner_user_id) : null });
    res.json({ contexts: rows, count: rows.length });
}));

// 8. Gaps  (statico prima di /:id)
router.get('/gaps', wrap(async (req, res) => {
    if (!req.query.device_id || !req.query.from || !req.query.to) { return res.status(400).json({ error: 'device_id, from, to obbligatori' }); }
    const gaps = await CTX.detectGaps({ deviceId: Number(req.query.device_id), sensorId: req.query.sensor_id ? Number(req.query.sensor_id) : null, from: req.query.from, to: req.query.to });
    res.json({ gap_readings: gaps.length, sample: gaps.slice(0, 50) });
}));

// 9. Overlaps
router.get('/overlaps', wrap(async (req, res) => {
    if (!req.query.device_id) { return res.status(400).json({ error: 'device_id obbligatorio' }); }
    const overlaps = await CTX.detectOverlaps(Number(req.query.device_id));
    res.json({ overlaps, count: overlaps.length });
}));

// 11. Usage stats (production vs demo/test)
router.get('/usage', wrap(async (req, res) => {
    if (!req.query.device_id) { return res.status(400).json({ error: 'device_id obbligatorio' }); }
    res.json(await CTX.usageStats(Number(req.query.device_id)));
}));

// 3. Create
router.post('/', wrap(async (req, res) => {
    const created = await CTX.createContext(req.body || {}, req.adminUser.id);
    res.status(201).json({ context: created });
}));

// 2. Get by id
router.get('/:id', wrap(async (req, res) => {
    const c = await CTX.getContext(Number(req.params.id));
    if (!c) { return res.status(404).json({ error: 'contesto inesistente' }); }
    res.json({ context: c });
}));

// 4. Update
router.put('/:id', wrap(async (req, res) => {
    res.json({ context: await CTX.updateContext(Number(req.params.id), req.body || {}, req.adminUser.id) });
}));

// 5. Close current context
router.post('/:id/close', wrap(async (req, res) => {
    res.json({ context: await CTX.closeContext(Number(req.params.id), (req.body && req.body.valid_to) || null, req.adminUser.id) });
}));

// 6. Delete (solo se non usato da intelligence/replay)
router.delete('/:id', wrap(async (req, res) => {
    res.json(await CTX.deleteContext(Number(req.params.id)));
}));

// 7. Preview readings coperte dal contesto
router.get('/:id/readings/preview', wrap(async (req, res) => {
    const p = await CTX.previewReadings(Number(req.params.id), req.query.limit ? Number(req.query.limit) : 20);
    if (!p) { return res.status(404).json({ error: 'contesto inesistente' }); }
    res.json(p);
}));

// 10. Count readings per contesto
router.get('/:id/readings/count', wrap(async (req, res) => {
    res.json(await CTX.countReadingsForContext(Number(req.params.id)));
}));

module.exports = router;
