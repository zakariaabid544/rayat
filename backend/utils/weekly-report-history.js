'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { query } = require('../config/database');
const { normalizeAdminRole } = require('./admin-auth');
const { resolveCustomerScope } = require('./customer-access');
const { DEFAULT_OUTPUT_DIR, sha256 } = require('./weekly-pdf-export');

const MAX_PAGE_SIZE = 100;

function httpError(status, message, code = 'report_history_access') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function positiveInteger(value, label, required = false) {
    if (value === undefined || value === null || value === '') {
        if (required) { throw httpError(400, `${label} obbligatorio`, 'report_history_validation'); }
        return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw httpError(400, `${label} non valido`, 'report_history_validation');
    }
    return parsed;
}

function dateValue(value, label) {
    if (value === undefined || value === null || value === '') { return null; }
    const raw = String(value).slice(0, 10);
    const date = new Date(`${raw}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(date.getTime())
        || date.toISOString().slice(0, 10) !== raw) {
        throw httpError(400, `${label} non valido`, 'report_history_validation');
    }
    return raw;
}

function isSuperAdmin(user) {
    return normalizeAdminRole(user && user.role) === 'super_admin';
}

function resolveOwnerAccess(user, requestedOwnerId = null) {
    if (!user || !positiveInteger(user.id, 'user_id', true)) {
        throw httpError(401, 'Utente non autenticato', 'report_history_auth');
    }
    const requested = positiveInteger(requestedOwnerId, 'owner_user_id');
    if (isSuperAdmin(user)) { return { owner_user_id: requested, super_admin: true }; }
    const scopedOwner = positiveInteger(resolveCustomerScope(user), 'owner scope', true);
    if (requested && requested !== scopedOwner) {
        throw httpError(403, 'Accesso negato allo storico di un altro cliente');
    }
    return { owner_user_id: scopedOwner, super_admin: false };
}

function normalizeListFilters(raw = {}) {
    const weekStart = dateValue(raw.week_start, 'week_start');
    const weekEnd = dateValue(raw.week_end, 'week_end');
    if (weekStart && weekEnd && weekStart > weekEnd) {
        throw httpError(400, 'Intervallo settimanale non valido', 'report_history_validation');
    }
    const limit = Math.min(positiveInteger(raw.limit, 'limit') || 25, MAX_PAGE_SIZE);
    const offsetRaw = raw.offset === undefined || raw.offset === '' ? 0 : Number(raw.offset);
    if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
        throw httpError(400, 'offset non valido', 'report_history_validation');
    }
    return {
        owner_user_id: positiveInteger(raw.owner_user_id, 'owner_user_id'),
        device_id: positiveInteger(raw.device_id, 'device_id'),
        context_id: positiveInteger(raw.context_id, 'context_id'),
        week_start: weekStart,
        week_end: weekEnd,
        limit,
        offset: offsetRaw
    };
}

function publicFile(row, reportId) {
    if (!row || !row.report_file_id) { return null; }
    return {
        id: Number(row.report_file_id),
        file_name: row.file_name,
        file_size: Number(row.file_size),
        checksum: row.checksum,
        generated_at: row.generated_at,
        download_url: `/api/reports/weekly/${reportId}/download`
    };
}

function listSql(filters, access) {
    const clauses = [];
    const params = [];
    if (access.owner_user_id) { clauses.push('r.owner_user_id = ?'); params.push(access.owner_user_id); }
    if (filters.device_id) { clauses.push('r.device_id = ?'); params.push(filters.device_id); }
    if (filters.context_id) { clauses.push('r.context_id = ?'); params.push(filters.context_id); }
    if (filters.week_start) { clauses.push('r.week_start >= ?'); params.push(filters.week_start); }
    if (filters.week_end) { clauses.push('r.week_end <= ?'); params.push(filters.week_end); }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

async function listWeeklyReportHistory({ user, filters = {}, executor = query } = {}) {
    const normalized = normalizeListFilters(filters);
    const access = resolveOwnerAccess(user, normalized.owner_user_id);
    const scoped = listSql(normalized, access);
    const countRows = await executor(
        `SELECT COUNT(*)::integer AS count FROM agro_weekly_reports r ${scoped.where}`,
        scoped.params
    );
    const rows = await executor(
        `SELECT r.id, r.owner_user_id, r.device_id, r.context_id, r.week_start, r.week_end,
                r.language, r.executive_summary, r.created_at, r.updated_at,
                f.health_summary, f.intelligence_score_summary, f.trend_summary, f.benchmark_summary,
                rf.id AS report_file_id, rf.file_name, rf.file_size, rf.checksum, rf.generated_at
         FROM agro_weekly_reports r
         JOIN agro_weekly_fact_packages f ON f.id = r.fact_package_id
           AND f.owner_user_id = r.owner_user_id AND f.device_id = r.device_id
           AND f.context_id = r.context_id AND f.week_start = r.week_start
         LEFT JOIN agro_weekly_report_files rf ON rf.report_id = r.id
           AND rf.owner_user_id = r.owner_user_id AND rf.device_id = r.device_id
           AND rf.context_id = r.context_id AND rf.week_start = r.week_start
         ${scoped.where}
         ORDER BY r.week_start DESC, r.id DESC LIMIT ? OFFSET ?`,
        [...scoped.params, normalized.limit, normalized.offset]
    );
    return {
        total: Number(countRows[0] && countRows[0].count) || 0,
        limit: normalized.limit,
        offset: normalized.offset,
        reports: rows.map((row) => ({
            id: Number(row.id), owner_user_id: Number(row.owner_user_id),
            device_id: Number(row.device_id), context_id: Number(row.context_id),
            week_start: row.week_start, week_end: row.week_end, language: row.language,
            executive_summary: row.executive_summary,
            health_summary: row.health_summary,
            intelligence_score_summary: row.intelligence_score_summary,
            trend_summary: row.trend_summary,
            benchmark_summary: row.benchmark_summary,
            pdf: publicFile(row, Number(row.id)),
            created_at: row.created_at, updated_at: row.updated_at
        }))
    };
}

async function loadScopedReport(reportId, user, executor = query) {
    const id = positiveInteger(reportId, 'report_id', true);
    const access = resolveOwnerAccess(user);
    const params = [id];
    const ownerClause = access.owner_user_id ? 'AND r.owner_user_id = ?' : '';
    if (access.owner_user_id) { params.push(access.owner_user_id); }
    const rows = await executor(
        `SELECT r.id, r.fact_package_id, r.owner_user_id, r.device_id, r.context_id,
                r.week_start, r.week_end, r.language, r.executive_summary,
                r.greenhouse_status, r.improvements, r.deteriorations, r.stress_recovery,
                r.benchmark, r.recommended_focus, r.data_quality_notes, r.report_text,
                r.evidence_json AS report_evidence, r.rule_version AS report_rule_version,
                r.created_at, r.updated_at,
                f.health_summary, f.intelligence_score_summary, f.subscore_summary,
                f.trend_summary, f.benchmark_summary, f.positive_factors, f.negative_factors,
                f.recommended_focus AS recommended_focus_facts,
                f.data_quality_notes AS data_quality_facts, f.limitations,
                f.evidence_json AS fact_evidence, f.rule_version AS fact_rule_version,
                rf.id AS report_file_id, rf.file_name, rf.file_path, rf.file_size,
                rf.checksum, rf.generated_at
         FROM agro_weekly_reports r
         JOIN agro_weekly_fact_packages f ON f.id = r.fact_package_id
           AND f.owner_user_id = r.owner_user_id AND f.device_id = r.device_id
           AND f.context_id = r.context_id AND f.week_start = r.week_start
         LEFT JOIN agro_weekly_report_files rf ON rf.report_id = r.id
           AND rf.owner_user_id = r.owner_user_id AND rf.device_id = r.device_id
           AND rf.context_id = r.context_id AND rf.week_start = r.week_start
         WHERE r.id = ? ${ownerClause}`,
        params
    );
    if (!rows.length) { throw httpError(404, 'Report settimanale non trovato', 'report_history_not_found'); }
    return rows[0];
}

async function getReportMetadata({ reportId, user, executor = query } = {}) {
    const row = await loadScopedReport(reportId, user, executor);
    return {
        id: Number(row.id), fact_package_id: Number(row.fact_package_id),
        owner_user_id: Number(row.owner_user_id), device_id: Number(row.device_id),
        context_id: Number(row.context_id), week_start: row.week_start, week_end: row.week_end,
        language: row.language,
        health_summary: row.health_summary,
        intelligence_score_summary: row.intelligence_score_summary,
        subscore_summary: row.subscore_summary,
        trend_summary: row.trend_summary,
        benchmark_summary: row.benchmark_summary,
        positive_factors: row.positive_factors,
        negative_factors: row.negative_factors,
        recommended_focus: row.recommended_focus_facts,
        data_quality_notes: row.data_quality_facts,
        limitations: row.limitations,
        pdf: publicFile(row, Number(row.id)),
        fact_rule_version: row.fact_rule_version,
        report_rule_version: row.report_rule_version,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

async function getRenderedReport({ reportId, user, executor = query } = {}) {
    const row = await loadScopedReport(reportId, user, executor);
    return {
        id: Number(row.id), device_id: Number(row.device_id), context_id: Number(row.context_id),
        week_start: row.week_start, week_end: row.week_end, language: row.language,
        executive_summary: row.executive_summary,
        greenhouse_status: row.greenhouse_status,
        improvements: row.improvements,
        deteriorations: row.deteriorations,
        stress_recovery: row.stress_recovery,
        benchmark: row.benchmark,
        recommended_focus: row.recommended_focus,
        data_quality_notes: row.data_quality_notes,
        report_text: row.report_text
    };
}

async function getPdfMetadata({ reportId, user, executor = query } = {}) {
    const row = await loadScopedReport(reportId, user, executor);
    const pdf = publicFile(row, Number(row.id));
    if (!pdf) { throw httpError(404, 'PDF non disponibile per questo report', 'report_pdf_not_found'); }
    return { report_id: Number(row.id), device_id: Number(row.device_id), context_id: Number(row.context_id), ...pdf };
}

async function getPdfDownload({
    reportId, user, executor = query,
    outputDir = process.env.AGRO_WEEKLY_PDF_DIR || DEFAULT_OUTPUT_DIR
} = {}) {
    const row = await loadScopedReport(reportId, user, executor);
    if (!row.report_file_id) { throw httpError(404, 'PDF non disponibile per questo report', 'report_pdf_not_found'); }
    const root = path.resolve(outputDir);
    const filePath = path.resolve(String(row.file_path || ''));
    if (!filePath.startsWith(`${root}${path.sep}`)) {
        throw httpError(409, 'Percorso PDF non valido', 'report_pdf_path');
    }
    const fileName = path.basename(String(row.file_name || 'report.pdf'));
    let stat;
    let bytes;
    try {
        stat = await fs.promises.stat(filePath);
        bytes = await fs.promises.readFile(filePath);
    }
    catch (error) {
        if (error.code === 'ENOENT') { throw httpError(404, 'File PDF non trovato', 'report_pdf_missing'); }
        throw error;
    }
    if (!stat.isFile() || stat.size !== Number(row.file_size)
        || sha256(bytes) !== String(row.checksum)) {
        throw httpError(409, 'File PDF non coerente con i metadata', 'report_pdf_integrity');
    }
    return { file_path: filePath, file_name: fileName, file_size: stat.size, checksum: row.checksum };
}

module.exports = {
    listWeeklyReportHistory,
    getReportMetadata,
    getRenderedReport,
    getPdfMetadata,
    getPdfDownload,
    loadScopedReport,
    resolveOwnerAccess,
    normalizeListFilters,
    isSuperAdmin,
    httpError,
    MAX_PAGE_SIZE
};
