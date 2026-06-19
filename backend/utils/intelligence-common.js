// Rayat Intelligence — Sprint 2.4/2.5 · Common helpers (additivo, puro, deterministico)
// Funzioni statistiche e di normalizzazione condivise dai motori 2.2–2.5. Nessun side-effect, nessuna AI.
'use strict';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round1(x) { return Number.isFinite(x) ? Math.round(x * 10) / 10 : null; }
function round3(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null; }
// NULL-safety: NULL / undefined / '' / NaN / Infinity NON devono diventare 0 -> restano "missing" (null).
function isFiniteNumber(x) { return typeof x === 'number' && Number.isFinite(x); }
function toFiniteNumber(x) {
    if (x === null || x === undefined) { return null; }
    if (typeof x === 'string' && x.trim() === '') { return null; }
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}
function safeNumber(x, fallback = null) { const n = toFiniteNumber(x); return n === null ? fallback : n; }
function num(x) { return toFiniteNumber(x); } // retrocompatibile, ora NULL-safe (mai NULL->0)

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stdev(a) { if (a.length < 2) { return 0; } const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function cv(a) { const m = mean(a); return m !== 0 ? stdev(a) / Math.abs(m) : 0; }

function median(a) {
    if (!a.length) { return 0; }
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(a, p) {
    if (!a.length) { return 0; }
    const s = a.slice().sort((x, y) => x - y);
    const idx = clamp01(p / 100) * (s.length - 1);
    const lo = Math.floor(idx); const hi = Math.ceil(idx);
    if (lo === hi) { return s[lo]; }
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// Normalizzazione log-saturante in [0,1] (volume/occorrenze con rendimenti decrescenti)
function normLog(x, ref) {
    if (!(ref > 1)) { return clamp01(x > 0 ? 1 : 0); }
    return clamp01(Math.log(1 + Math.max(0, x)) / Math.log(1 + ref));
}
// Fattore di recency: 1 (oggi) -> 0 (oltre refDays)
function recencyFactor(daysSince, refDays) {
    return clamp01(1 - (daysSince || 0) / (refDays || 1));
}
function daysBetween(aMs, bMs) { return Math.abs(aMs - bMs) / DAY_MS; }

// ID deterministico (chiave di upsert idempotente)
function deterministicId(...parts) {
    return parts.map((p) => (p === null || p === undefined ? 'NULL' : String(p))).join('|');
}

function parseJson(raw, fallback) {
    if (raw === null || raw === undefined) { return fallback === undefined ? null : fallback; }
    if (typeof raw === 'object') { return raw; }
    try { return JSON.parse(raw); } catch (e) { return fallback === undefined ? null : fallback; }
}

module.exports = {
    DAY_MS, HOUR_MS,
    clamp01, round1, round3, num, toFiniteNumber, isFiniteNumber, safeNumber,
    mean, stdev, cv, median, percentile,
    normLog, recencyFactor, daysBetween,
    deterministicId, parseJson
};
