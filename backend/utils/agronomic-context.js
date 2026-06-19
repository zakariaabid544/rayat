// Rayat Intelligence — Sprint 2.7C · Agronomic Context Manager (additivo, super_admin)
// Un device/gateway puo cambiare coltura/medium/sito/uso nel tempo. Una lettura va interpretata come
// device_id + sensor_id + timestamp + CONTESTO agronomico, non solo device_id.
// Questo modulo gestisce i segmenti di contesto (CRUD + validazioni) e li risolve per timestamp.
// SCRIVE SOLO su agro_context_segments (+ colonna additiva context_id su agro_actions_detected).
'use strict';
const { query } = require('../config/database');

const CULTIVATION = new Set(['greenhouse', 'open_field', 'bag', 'pot', 'demo', 'lab', 'unknown']);
const SITE = new Set(['farm', 'residence', 'nursery', 'test_site', 'greenhouse', 'open_field', 'unknown']);
const USAGE = new Set(['production', 'demo', 'test', 'calibration', 'installation', 'maintenance', 'unknown']);
// usi NON di produzione (esclusi dal fleet benchmark e dalla production intelligence)
const NON_PRODUCTION_USAGE = new Set(['demo', 'test', 'calibration', 'maintenance']);

function isNonProductionUsage(usageType) { return NON_PRODUCTION_USAGE.has(String(usageType || '').toLowerCase()); }

async function ensureContextSchema() {
    await query(
        `CREATE TABLE IF NOT EXISTS agro_context_segments (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           sensor_id INTEGER NULL REFERENCES sensors(id) ON DELETE CASCADE,
           context_name TEXT NOT NULL,
           crop_key VARCHAR(80) NULL,
           crop_label TEXT NULL,
           medium VARCHAR(40) NULL,
           cultivation_type VARCHAR(20) NOT NULL DEFAULT 'unknown',
           site_type VARCHAR(20) NOT NULL DEFAULT 'unknown',
           usage_type VARCHAR(20) NOT NULL DEFAULT 'unknown',
           is_production BOOLEAN NOT NULL DEFAULT FALSE,
           valid_from TIMESTAMPTZ NOT NULL,
           valid_to TIMESTAMPTZ NULL,
           notes TEXT NULL,
           created_by INTEGER NULL,
           updated_by INTEGER NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT chk_ctx_validity CHECK (valid_to IS NULL OR valid_to > valid_from)
         )`
    );
    await query('CREATE INDEX IF NOT EXISTS idx_ctx_device_sensor ON agro_context_segments (device_id, sensor_id, valid_from)');
    await query('CREATE INDEX IF NOT EXISTS idx_ctx_owner ON agro_context_segments (owner_user_id)');
    // colonna additiva: ogni evento ricostruito puo essere etichettato col contesto risolto al suo timestamp
    await query('ALTER TABLE agro_actions_detected ADD COLUMN IF NOT EXISTS context_id INTEGER NULL');
    await query('CREATE INDEX IF NOT EXISTS idx_agro_actions_context ON agro_actions_detected (context_id)');
}

function toIso(v) { return (v instanceof Date ? v : new Date(v)).toISOString(); }

// Verifica che il device appartenga al canonical owner indicato (tenant safety)
async function assertDeviceOwner(deviceId, ownerUserId) {
    const rows = await query(
        `SELECT COALESCE(du.owner_user_id, du.id) AS owner_user_id
         FROM devices d LEFT JOIN users du ON du.id = d.user_id WHERE d.id = ? LIMIT 1`,
        [deviceId]
    );
    if (!rows.length) { throw new Error(`device ${deviceId} inesistente`); }
    if (Number(rows[0].owner_user_id) !== Number(ownerUserId)) {
        throw new Error(`device ${deviceId} non appartiene all'owner ${ownerUserId}`);
    }
    if (rows[0].owner_user_id == null) { throw new Error(`device ${deviceId} senza owner risolvibile`); }
}

// Validazione di un payload contesto. Ritorna i campi normalizzati o lancia errore.
function validateContextPayload(p) {
    if (p.owner_user_id == null) { throw new Error('owner_user_id obbligatorio'); }
    if (p.device_id == null) { throw new Error('device_id obbligatorio'); }
    if (!p.context_name || !String(p.context_name).trim()) { throw new Error('context_name obbligatorio'); }
    if (!p.valid_from) { throw new Error('valid_from obbligatorio'); }
    const validFrom = new Date(p.valid_from);
    if (Number.isNaN(validFrom.getTime())) { throw new Error('valid_from non valido'); }
    let validTo = null;
    if (p.valid_to !== undefined && p.valid_to !== null && p.valid_to !== '') {
        validTo = new Date(p.valid_to);
        if (Number.isNaN(validTo.getTime())) { throw new Error('valid_to non valido'); }
        if (validTo.getTime() <= validFrom.getTime()) { throw new Error('valid_from deve precedere valid_to'); }
    }
    const cultivation_type = CULTIVATION.has(p.cultivation_type) ? p.cultivation_type : 'unknown';
    const site_type = SITE.has(p.site_type) ? p.site_type : 'unknown';
    const usage_type = USAGE.has(p.usage_type) ? p.usage_type : 'unknown';
    const is_production = (typeof p.is_production === 'boolean') ? p.is_production : (usage_type === 'production');
    return {
        owner_user_id: Number(p.owner_user_id),
        device_id: Number(p.device_id),
        sensor_id: (p.sensor_id === undefined || p.sensor_id === null || p.sensor_id === '') ? null : Number(p.sensor_id),
        context_name: String(p.context_name).trim(),
        crop_key: p.crop_key || null,
        crop_label: p.crop_label || null,
        medium: p.medium || null,
        cultivation_type, site_type, usage_type, is_production,
        valid_from: toIso(validFrom),
        valid_to: validTo ? toIso(validTo) : null,
        notes: p.notes || null
    };
}

// Nessuna sovrapposizione per stesso device_id + sensor_id (NULL-aware). excludeId per gli update.
async function assertNoOverlap(c, excludeId = null) {
    const clauses = [
        'device_id = ?',
        'sensor_id IS NOT DISTINCT FROM ?',
        "valid_from < COALESCE(CAST(? AS TIMESTAMPTZ), 'infinity'::timestamptz)",
        "COALESCE(valid_to, 'infinity'::timestamptz) > CAST(? AS TIMESTAMPTZ)"
    ];
    const params = [c.device_id, c.sensor_id, c.valid_to, c.valid_from];
    if (excludeId != null) { clauses.push('id <> ?'); params.push(excludeId); }
    const rows = await query(`SELECT id FROM agro_context_segments WHERE ${clauses.join(' AND ')}`, params);
    if (rows.length) { throw new Error(`contesto sovrapposto (device ${c.device_id}, sensor ${c.sensor_id == null ? 'device-level' : c.sensor_id}) con segmento id=${rows[0].id}`); }
}

async function createContext(payload, actorUserId) {
    const c = validateContextPayload(payload);
    await assertDeviceOwner(c.device_id, c.owner_user_id);
    await assertNoOverlap(c, null);
    const res = await query(
        `INSERT INTO agro_context_segments
            (owner_user_id, device_id, sensor_id, context_name, crop_key, crop_label, medium,
             cultivation_type, site_type, usage_type, is_production, valid_from, valid_to, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS TIMESTAMPTZ), CAST(? AS TIMESTAMPTZ), ?, ?, ?)`,
        [c.owner_user_id, c.device_id, c.sensor_id, c.context_name, c.crop_key, c.crop_label, c.medium,
         c.cultivation_type, c.site_type, c.usage_type, c.is_production, c.valid_from, c.valid_to, c.notes, actorUserId || null, actorUserId || null]
    );
    return getContext(res.insertId);
}

async function updateContext(id, payload, actorUserId) {
    const existing = await getContext(id);
    if (!existing) { throw new Error('contesto inesistente'); }
    const merged = { ...existing, ...payload, owner_user_id: existing.owner_user_id, device_id: existing.device_id };
    const c = validateContextPayload(merged);
    await assertDeviceOwner(c.device_id, c.owner_user_id);
    await assertNoOverlap(c, id);
    await query(
        `UPDATE agro_context_segments SET context_name=?, crop_key=?, crop_label=?, medium=?,
           cultivation_type=?, site_type=?, usage_type=?, is_production=?, sensor_id=?,
           valid_from=CAST(? AS TIMESTAMPTZ), valid_to=CAST(? AS TIMESTAMPTZ), notes=?, updated_by=?, updated_at=NOW()
         WHERE id=?`,
        [c.context_name, c.crop_key, c.crop_label, c.medium, c.cultivation_type, c.site_type, c.usage_type,
         c.is_production, c.sensor_id, c.valid_from, c.valid_to, c.notes, actorUserId || null, id]
    );
    return getContext(id);
}

async function closeContext(id, validTo, actorUserId) {
    const existing = await getContext(id);
    if (!existing) { throw new Error('contesto inesistente'); }
    const vt = validTo ? new Date(validTo) : new Date();
    if (vt.getTime() <= new Date(existing.valid_from).getTime()) { throw new Error('valid_to deve seguire valid_from'); }
    await query('UPDATE agro_context_segments SET valid_to = CAST(? AS TIMESTAMPTZ), updated_by=?, updated_at=NOW() WHERE id=?', [toIso(vt), actorUserId || null, id]);
    return getContext(id);
}

async function contextUsageCount(id) {
    const r = await query("SELECT count(*) c FROM agro_actions_detected WHERE context_id = ?", [id]);
    return Number(r[0].c);
}

async function deleteContext(id) {
    const used = await contextUsageCount(id);
    if (used > 0) { throw new Error(`contesto id=${id} gia usato da ${used} eventi: eliminazione bloccata`); }
    const res = await query('DELETE FROM agro_context_segments WHERE id = ?', [id]);
    return { deleted: res.affectedRows || 0 };
}

async function getContext(id) {
    const rows = await query('SELECT * FROM agro_context_segments WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
}

async function listContexts({ deviceId = null, ownerUserId = null } = {}) {
    const where = []; const params = [];
    if (deviceId != null) { where.push('device_id = ?'); params.push(deviceId); }
    if (ownerUserId != null) { where.push('owner_user_id = ?'); params.push(ownerUserId); }
    return query(
        `SELECT * FROM agro_context_segments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY device_id, COALESCE(sensor_id, 0), valid_from`,
        params
    );
}

// Risoluzione del contesto per una lettura. sensor-level batte device-level. Ritorna il segmento o null.
async function resolveAgronomicContext({ owner_user_id, device_id, sensor_id = null, timestamp }) {
    if (device_id == null || !timestamp) { return null; }
    const ts = toIso(timestamp);
    const rows = await query(
        `SELECT * FROM agro_context_segments
         WHERE device_id = ? AND (sensor_id = ? OR sensor_id IS NULL)
           AND valid_from <= CAST(? AS TIMESTAMPTZ)
           AND (valid_to IS NULL OR valid_to > CAST(? AS TIMESTAMPTZ))
           ${owner_user_id != null ? 'AND owner_user_id = ?' : ''}
         ORDER BY (sensor_id IS NULL) ASC, valid_from DESC
         LIMIT 1`,
        owner_user_id != null ? [device_id, sensor_id, ts, ts, owner_user_id] : [device_id, sensor_id, ts, ts]
    );
    return rows[0] || null;
}

// Sovrapposizioni esistenti per un device (coppie di segmenti che si intersecano)
async function detectOverlaps(deviceId) {
    return query(
        `SELECT a.id AS id_a, b.id AS id_b, a.sensor_id, a.valid_from AS a_from, a.valid_to AS a_to, b.valid_from AS b_from, b.valid_to AS b_to
         FROM agro_context_segments a
         JOIN agro_context_segments b
           ON a.device_id = b.device_id AND a.sensor_id IS NOT DISTINCT FROM b.sensor_id AND a.id < b.id
          AND a.valid_from < COALESCE(b.valid_to, 'infinity'::timestamptz)
          AND b.valid_from < COALESCE(a.valid_to, 'infinity'::timestamptz)
         WHERE a.device_id = ?`,
        [deviceId]
    );
}

// Letture in [from,to] su un device prive di contesto risolvibile (gap di copertura)
async function detectGaps({ deviceId, sensorId = null, from, to }) {
    const rows = await query(
        `SELECT sr.id, sr.sensor_id, sr.timestamp
         FROM sensor_readings sr
         INNER JOIN sensors s ON s.id = sr.sensor_id
         WHERE s.device_id = ? ${sensorId != null ? 'AND sr.sensor_id = ?' : ''}
           AND sr.timestamp >= CAST(? AS TIMESTAMPTZ) AND sr.timestamp <= CAST(? AS TIMESTAMPTZ)
           AND NOT EXISTS (
             SELECT 1 FROM agro_context_segments c
             WHERE c.device_id = ? AND (c.sensor_id = sr.sensor_id OR c.sensor_id IS NULL)
               AND c.valid_from <= sr.timestamp AND (c.valid_to IS NULL OR c.valid_to > sr.timestamp))
         ORDER BY sr.timestamp ASC`,
        sensorId != null ? [deviceId, sensorId, toIso(from), toIso(to), deviceId] : [deviceId, toIso(from), toIso(to), deviceId]
    );
    return rows;
}

// Conteggio letture coperte da uno specifico contesto (entro la sua finestra, sul suo device/sensor)
async function countReadingsForContext(id) {
    const c = await getContext(id);
    if (!c) { return { context_id: id, readings: 0 }; }
    const r = await query(
        `SELECT count(*) cnt FROM sensor_readings sr INNER JOIN sensors s ON s.id = sr.sensor_id
         WHERE s.device_id = ? ${c.sensor_id != null ? 'AND sr.sensor_id = ?' : ''}
           AND sr.timestamp >= CAST(? AS TIMESTAMPTZ) AND (CAST(? AS TIMESTAMPTZ) IS NULL OR sr.timestamp < CAST(? AS TIMESTAMPTZ))`,
        c.sensor_id != null ? [c.device_id, c.sensor_id, c.valid_from, c.valid_to, c.valid_to] : [c.device_id, c.valid_from, c.valid_to, c.valid_to]
    );
    return { context_id: id, readings: Number(r[0].cnt), is_production: c.is_production, usage_type: c.usage_type };
}

// Letture production vs demo/test per un device (in base ai contesti)
async function usageStats(deviceId) {
    const rows = await query(
        `SELECT c.usage_type, c.is_production, count(sr.id) AS readings
         FROM sensor_readings sr INNER JOIN sensors s ON s.id = sr.sensor_id
         LEFT JOIN agro_context_segments c
           ON c.device_id = s.device_id AND (c.sensor_id = sr.sensor_id OR c.sensor_id IS NULL)
          AND c.valid_from <= sr.timestamp AND (c.valid_to IS NULL OR c.valid_to > sr.timestamp)
         WHERE s.device_id = ?
         GROUP BY c.usage_type, c.is_production
         ORDER BY readings DESC`,
        [deviceId]
    );
    let production = 0, nonProduction = 0, uncovered = 0;
    for (const r of rows) {
        const n = Number(r.readings);
        if (r.usage_type == null) { uncovered += n; }
        else if (r.is_production) { production += n; }
        else { nonProduction += n; }
    }
    return { device_id: deviceId, production, non_production: nonProduction, uncovered, breakdown: rows };
}

async function previewReadings(id, limit = 20) {
    const c = await getContext(id);
    if (!c) { return null; }
    const sample = await query(
        `SELECT sr.id, sr.sensor_id, sr.value, sr.timestamp FROM sensor_readings sr INNER JOIN sensors s ON s.id = sr.sensor_id
         WHERE s.device_id = ? ${c.sensor_id != null ? 'AND sr.sensor_id = ?' : ''}
           AND sr.timestamp >= CAST(? AS TIMESTAMPTZ) AND (CAST(? AS TIMESTAMPTZ) IS NULL OR sr.timestamp < CAST(? AS TIMESTAMPTZ))
         ORDER BY sr.timestamp ASC LIMIT ?`,
        c.sensor_id != null ? [c.device_id, c.sensor_id, c.valid_from, c.valid_to, c.valid_to, limit] : [c.device_id, c.valid_from, c.valid_to, c.valid_to, limit]
    );
    const count = await countReadingsForContext(id);
    return { context: c, total_readings: count.readings, sample };
}

module.exports = {
    ensureContextSchema, resolveAgronomicContext, validateContextPayload,
    createContext, updateContext, closeContext, deleteContext, getContext, listContexts,
    contextUsageCount, detectOverlaps, detectGaps, countReadingsForContext, usageStats, previewReadings,
    isNonProductionUsage, CULTIVATION, SITE, USAGE, NON_PRODUCTION_USAGE
};
