'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { query } = require('../config/database');
const C = require('./intelligence-common');

const RULE_VERSION = 's5.3';
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../output/pdf');
const CONTENT_SOURCE_TABLES = Object.freeze(['agro_weekly_fact_packages', 'agro_weekly_reports']);
const COLORS = Object.freeze({
    forest: '#174A3A', green: '#2E7D5B', mint: '#EAF5EF', gold: '#D2A84A',
    ink: '#20312B', muted: '#66756F', line: '#D9E4DE', white: '#FFFFFF',
    warning: '#A45B24', risk: '#9B3A3A', soft: '#F6F8F7'
});

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeIdentity(input, label = 'weekly-pdf') {
    const identity = {
        owner_user_id: positiveInteger(input && (input.owner_user_id ?? input.ownerUserId)),
        device_id: positiveInteger(input && (input.device_id ?? input.deviceId)),
        context_id: positiveInteger(input && (input.context_id ?? input.contextId))
    };
    if (!identity.owner_user_id || !identity.device_id || !identity.context_id) {
        throw new Error(`[${label}] unresolved owner/device/context identity`);
    }
    return identity;
}

function normalizeDate(value, label) {
    const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) { throw new Error(`[weekly-pdf] invalid ${label}`); }
    const date = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
        throw new Error(`[weekly-pdf] invalid ${label}`);
    }
    return raw;
}

function objectValue(value) {
    const parsed = C.parseJson(value, {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function arrayValue(value) {
    const parsed = C.parseJson(value, []);
    return Array.isArray(parsed) ? parsed : [];
}

function round(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function cleanText(value) {
    return String(value || '')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/\u00a0/g, ' ')
        .replace(/^##\s+/gm, '')
        .trim();
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function deterministicPdfDate(weekEnd) {
    return new Date(`${normalizeDate(weekEnd, 'week_end')}T12:00:00.000Z`);
}

function sourceForPdf(row) {
    const identity = normalizeIdentity(row, 'weekly-pdf-source');
    const weekStart = normalizeDate(row.week_start, 'week_start');
    const weekEnd = normalizeDate(row.week_end, 'week_end');
    const reportId = positiveInteger(row.report_id);
    const factPackageId = positiveInteger(row.fact_package_id);
    if (!reportId || !factPackageId) { throw new Error('[weekly-pdf-source] missing report/fact package identity'); }
    if (row.report_fact_package_id != null && Number(row.report_fact_package_id) !== factPackageId) {
        throw new Error('[weekly-pdf-source] report/fact package mismatch');
    }
    return {
        ...identity,
        report_id: reportId,
        fact_package_id: factPackageId,
        week_start: weekStart,
        week_end: weekEnd,
        display_name: `Serra - dispositivo ${identity.device_id}`,
        health_summary: objectValue(row.health_summary),
        intelligence_score_summary: objectValue(row.intelligence_score_summary),
        subscore_summary: objectValue(row.subscore_summary),
        trend_summary: objectValue(row.trend_summary),
        benchmark_summary: objectValue(row.benchmark_summary),
        positive_factors: arrayValue(row.positive_factors),
        negative_factors: arrayValue(row.negative_factors),
        recommended_focus_facts: arrayValue(row.recommended_focus_facts),
        data_quality_facts: arrayValue(row.data_quality_facts),
        limitations: arrayValue(row.limitations),
        executive_summary: cleanText(row.executive_summary),
        greenhouse_status: cleanText(row.greenhouse_status),
        improvements: cleanText(row.improvements),
        deteriorations: cleanText(row.deteriorations),
        stress_recovery: cleanText(row.stress_recovery),
        benchmark: cleanText(row.benchmark),
        recommended_focus: cleanText(row.recommended_focus),
        data_quality_notes: cleanText(row.data_quality_notes),
        language: String(row.language || 'it'),
        fact_rule_version: String(row.fact_rule_version || 's5.1'),
        report_rule_version: String(row.report_rule_version || 's5.2')
    };
}

function scoreLine(label, value) {
    const score = round(value);
    return `${label}: ${score === null ? 'non disponibile' : `${score}/100`}`;
}

function factorLabel(value) {
    if (typeof value === 'string') { return value.replace(/_/g, ' '); }
    if (!value || typeof value !== 'object') { return ''; }
    return String(value.label || value.factor || value.key || '').replace(/_/g, ' ');
}

function trendText(summary) {
    const items = arrayValue(summary.items);
    if (!items.length) { return 'Storico insufficiente per una tendenza affidabile.'; }
    return items.map((item) => {
        const metric = String(item.metric || 'indicatore').replace(/_/g, ' ');
        const direction = String(item.direction || 'insufficient_data').replace(/_/g, ' ');
        const strength = Number(item.strength);
        return `${metric}: ${direction}${Number.isFinite(strength) ? ` (forza ${Math.round(strength * 100)}%)` : ''}`;
    }).join('\n');
}

function intelligenceText(source) {
    const score = source.intelligence_score_summary;
    const subscores = source.subscore_summary;
    const lines = [
        scoreLine('Punteggio complessivo', score.intelligence_score),
        `Fascia: ${String(score.intelligence_band || 'unknown').replace(/_/g, ' ')}`,
        scoreLine('Stabilità', subscores.stability),
        scoreLine('Gestione dello stress', subscores.stress),
        scoreLine('Recupero', subscores.recovery),
        scoreLine('Resilienza', subscores.resilience),
        scoreLine('Qualità dei dati', subscores.data_quality)
    ];
    return lines.join('\n');
}

function healthText(source) {
    const health = source.health_summary;
    const factors = source.positive_factors.map(factorLabel).filter(Boolean).slice(0, 3);
    const lines = [
        scoreLine('Salute', health.health_score),
        `Fascia: ${String(health.health_band || 'unknown').replace(/_/g, ' ')}`,
        scoreLine('Resilienza', health.resilience_score),
        scoreLine('Stabilità', health.stability_score),
        source.greenhouse_status
    ];
    if (factors.length) { lines.push(`Fattori positivi: ${factors.join(', ')}.`); }
    return lines.filter(Boolean).join('\n');
}

function benchmarkText(source) {
    const benchmark = source.benchmark_summary;
    if (!benchmark.available) { return source.benchmark || 'Benchmark non disponibile.'; }
    return [
        source.benchmark,
        `Percentile: ${round(benchmark.percentile_rank) ?? 'non disponibile'}`,
        `Posizione: ${String(benchmark.relative_position || 'unknown').replace(/_/g, ' ')}`,
        `Coorte anonima: ${Number(benchmark.cohort_size) || 0} serre, ${Number(benchmark.distinct_owner_count) || 0} clienti distinti.`
    ].filter(Boolean).join('\n');
}

function buildWeeklyPdfBuffer(rawSource) {
    const source = sourceForPdf(rawSource);
    const fixedDate = deterministicPdfDate(source.week_end);
    const doc = new PDFDocument({
        autoFirstPage: false,
        bufferPages: true,
        compress: false,
        size: 'A4',
        margins: { top: 60, right: 54, bottom: 68, left: 54 },
        info: {
            Title: `Rayat Intelligence Weekly Report - ${source.week_start}`,
            Author: 'Rayat Intelligence',
            Subject: `Weekly greenhouse intelligence report ${source.week_start} - ${source.week_end}`,
            Keywords: 'Rayat, greenhouse, intelligence, weekly report',
            CreationDate: fixedDate,
            ModDate: fixedDate
        }
    });
    const chunks = [];
    const complete = new Promise((resolve, reject) => {
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const left = 54;
    const contentWidth = pageWidth - 108;

    function addCover() {
        doc.addPage({ size: 'A4', margin: 0 });
        doc.rect(0, 0, pageWidth, pageHeight).fill(COLORS.forest);
        doc.rect(0, 0, 16, pageHeight).fill(COLORS.gold);
        doc.circle(500, 80, 130).fillOpacity(0.08).fill(COLORS.white).fillOpacity(1);
        doc.circle(520, 760, 190).fillOpacity(0.05).fill(COLORS.white).fillOpacity(1);
        doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.gold)
            .text('RAYAT INTELLIGENCE', 62, 72, { characterSpacing: 1.8 });
        doc.font('Helvetica-Bold').fontSize(34).fillColor(COLORS.white)
            .text('Weekly Report', 62, 160, { width: 430, lineGap: 4 });
        doc.font('Helvetica').fontSize(15).fillColor('#DDEBE5')
            .text('Analisi settimanale deterministica della serra', 64, 250, { width: 400 });
        doc.roundedRect(62, 360, 450, 170, 12).fillOpacity(0.1).fill(COLORS.white).fillOpacity(1);
        doc.font('Helvetica-Bold').fontSize(21).fillColor(COLORS.white)
            .text(source.display_name, 88, 393, { width: 395 });
        doc.font('Helvetica').fontSize(12).fillColor('#DDEBE5')
            .text(`Contesto ${source.context_id}`, 88, 435, { width: 395 });
        doc.font('Helvetica-Bold').fontSize(14).fillColor(COLORS.gold)
            .text(`${source.week_start} - ${source.week_end}`, 88, 480, { width: 395 });
        doc.font('Helvetica').fontSize(9).fillColor('#BDD2C9')
            .text('Generato esclusivamente da fact package e report settimanale Rayat.', 62, 738, { width: 450 });
    }

    function addContentPage() {
        doc.addPage({ size: 'A4', margins: { top: 60, right: 54, bottom: 68, left: 54 } });
        doc.rect(0, 0, pageWidth, 34).fill(COLORS.forest);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.white)
            .text('RAYAT INTELLIGENCE', left, 12, { characterSpacing: 1.2 });
        doc.y = 58;
    }

    function ensureSpace(height) {
        if (doc.y + height > pageHeight - 76) { addContentPage(); }
    }

    function addSection(title, body, options = {}) {
        const text = cleanText(body) || 'Informazione non disponibile.';
        doc.font('Helvetica').fontSize(10.2);
        const bodyHeight = doc.heightOfString(text, { width: contentWidth - 26, lineGap: 3 });
        const estimated = 48 + bodyHeight;
        ensureSpace(Math.min(estimated, 300));
        doc.roundedRect(left, doc.y, contentWidth, 28, 5).fill(options.accent || COLORS.mint);
        doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.forest)
            .text(title, left + 13, doc.y + 8, { width: contentWidth - 26 });
        doc.y += 39;
        doc.font('Helvetica').fontSize(10.2).fillColor(COLORS.ink)
            .text(text, left + 13, doc.y, { width: contentWidth - 26, lineGap: 3 });
        doc.y += 17;
    }

    function addScoreCards() {
        ensureSpace(104);
        const y = doc.y;
        const gap = 12;
        const width = (contentWidth - gap) / 2;
        const cards = [
            { label: 'HEALTH SCORE', value: round(source.health_summary.health_score), band: source.health_summary.health_band },
            { label: 'INTELLIGENCE SCORE', value: round(source.intelligence_score_summary.intelligence_score), band: source.intelligence_score_summary.intelligence_band }
        ];
        cards.forEach((card, index) => {
            const x = left + index * (width + gap);
            doc.roundedRect(x, y, width, 88, 8).fill(index ? '#F2F5F3' : COLORS.mint);
            doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted)
                .text(card.label, x + 16, y + 15, { width: width - 32, characterSpacing: 0.8 });
            doc.font('Helvetica-Bold').fontSize(26).fillColor(COLORS.forest)
                .text(card.value === null ? '--' : `${card.value}`, x + 16, y + 33, { width: 72 });
            doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
                .text('/100', x + 72, y + 48, { width: 45 });
            doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.green)
                .text(String(card.band || 'unknown').replace(/_/g, ' '), x + 120, y + 49, { width: width - 136, align: 'right' });
        });
        doc.y = y + 106;
    }

    addCover();
    addContentPage();
    addScoreCards();
    addSection('1. Executive Summary', source.executive_summary);
    addSection('2. Profilo di salute', healthText(source));
    addSection('3. Punteggio di intelligenza', intelligenceText(source));
    addSection('4. Trend intelligence', trendText(source.trend_summary));
    addSection('5. Posizione benchmark', benchmarkText(source));
    addSection('6. Cosa è migliorato', source.improvements);
    addSection('7. Cosa è peggiorato', source.deteriorations, { accent: '#F8F0E9' });
    addSection('8. Stress e recupero', source.stress_recovery);
    addSection('9. Azioni consigliate', source.recommended_focus, { accent: '#EEF3E2' });
    addSection('10. Note sulla qualità dei dati', source.data_quality_notes);

    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
        doc.switchToPage(range.start + index);
        doc.save();
        doc.moveTo(54, pageHeight - 48).lineTo(pageWidth - 54, pageHeight - 48)
            .lineWidth(0.6).strokeColor(index === 0 ? '#6B8A7E' : COLORS.line).stroke();
        const footerLeft = `Rayat Intelligence | ${source.week_start} - ${source.week_end}`;
        const footerRight = `Pagina ${index + 1} di ${range.count}`;
        doc.font('Helvetica').fontSize(8).fillColor(index === 0 ? '#BDD2C9' : COLORS.muted)
            .text(footerLeft, 54, pageHeight - 38, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(8).fillColor(index === 0 ? COLORS.gold : COLORS.green);
        doc.text(footerRight, pageWidth - 54 - doc.widthOfString(footerRight), pageHeight - 38, { lineBreak: false });
        doc.restore();
    }
    doc.end();
    return complete;
}

async function ensureWeeklyPdfSchema({ executor = query } = {}) {
    await executor(
        `CREATE TABLE IF NOT EXISTS agro_weekly_report_files (
           id BIGSERIAL PRIMARY KEY,
           owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
           context_id BIGINT NOT NULL REFERENCES agro_context_segments(id) ON DELETE RESTRICT,
           week_start DATE NOT NULL,
           report_id BIGINT NOT NULL REFERENCES agro_weekly_reports(id) ON DELETE CASCADE,
           file_name VARCHAR(255) NOT NULL,
           file_path TEXT NOT NULL,
           file_size BIGINT NOT NULL,
           checksum CHAR(64) NOT NULL,
           generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
           CONSTRAINT uniq_weekly_report_file UNIQUE (owner_user_id, device_id, context_id, week_start),
           CONSTRAINT uniq_weekly_report_file_report UNIQUE (report_id),
           CONSTRAINT weekly_report_file_values_check CHECK (
             btrim(file_name) <> '' AND btrim(file_path) <> '' AND file_size > 0
             AND checksum ~ '^[0-9a-f]{64}$')
         )`
    );
    const invalid = await executor(
        `SELECT COUNT(*)::integer AS invalid_count
         FROM agro_weekly_report_files f
         LEFT JOIN devices d ON d.id = f.device_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN agro_context_segments c ON c.id = f.context_id
         LEFT JOIN agro_weekly_reports r ON r.id = f.report_id
         WHERE f.owner_user_id IS DISTINCT FROM COALESCE(u.owner_user_id, u.id)
            OR c.id IS NULL OR c.owner_user_id IS DISTINCT FROM f.owner_user_id
            OR c.device_id IS DISTINCT FROM f.device_id
            OR r.id IS NULL OR r.owner_user_id IS DISTINCT FROM f.owner_user_id
            OR r.device_id IS DISTINCT FROM f.device_id OR r.context_id IS DISTINCT FROM f.context_id
            OR r.week_start IS DISTINCT FROM f.week_start`
    );
    if (Number(invalid[0] && invalid[0].invalid_count) > 0) {
        throw new Error('[weekly-pdf-schema] existing rows have invalid tenant/context/report identity');
    }
    await executor(
        `CREATE OR REPLACE FUNCTION rayat_assert_weekly_pdf_identity() RETURNS trigger AS $$
         DECLARE expected_owner INTEGER; context_owner INTEGER; context_device INTEGER;
           report_owner INTEGER; report_device INTEGER; report_context BIGINT; report_week DATE;
         BEGIN
           SELECT COALESCE(u.owner_user_id, u.id) INTO expected_owner
             FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = NEW.device_id;
           SELECT owner_user_id, device_id INTO context_owner, context_device
             FROM agro_context_segments WHERE id = NEW.context_id;
           SELECT owner_user_id, device_id, context_id, week_start
             INTO report_owner, report_device, report_context, report_week
             FROM agro_weekly_reports WHERE id = NEW.report_id;
           IF expected_owner IS NULL OR expected_owner IS DISTINCT FROM NEW.owner_user_id THEN
             RAISE EXCEPTION 'weekly PDF owner_user_id does not own device_id'; END IF;
           IF context_owner IS NULL OR context_owner IS DISTINCT FROM NEW.owner_user_id
              OR context_device IS DISTINCT FROM NEW.device_id THEN
             RAISE EXCEPTION 'weekly PDF context_id does not belong to owner/device'; END IF;
           IF report_owner IS NULL OR report_owner IS DISTINCT FROM NEW.owner_user_id
              OR report_device IS DISTINCT FROM NEW.device_id OR report_context IS DISTINCT FROM NEW.context_id
              OR report_week IS DISTINCT FROM NEW.week_start THEN
             RAISE EXCEPTION 'weekly PDF report identity mismatch'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`
    );
    await executor('DROP TRIGGER IF EXISTS weekly_pdf_identity_guard ON agro_weekly_report_files');
    await executor(
        `CREATE TRIGGER weekly_pdf_identity_guard BEFORE INSERT OR UPDATE ON agro_weekly_report_files
         FOR EACH ROW EXECUTE FUNCTION rayat_assert_weekly_pdf_identity()`
    );
    await executor('CREATE INDEX IF NOT EXISTS idx_weekly_pdf_context_week ON agro_weekly_report_files (context_id, week_start DESC)');
    await executor('CREATE INDEX IF NOT EXISTS idx_weekly_pdf_owner_device_week ON agro_weekly_report_files (owner_user_id, device_id, week_start DESC)');
}

async function loadWeeklyPdfSource(input, executor = query) {
    const identity = normalizeIdentity(input, 'weekly-pdf-load');
    const weekStart = normalizeDate(input.week_start ?? input.weekStart, 'week_start');
    const rows = await executor(
        `SELECT r.id AS report_id, r.fact_package_id AS report_fact_package_id,
                f.id AS fact_package_id, f.owner_user_id, f.device_id, f.context_id,
                f.week_start, f.week_end, f.health_summary, f.intelligence_score_summary,
                f.subscore_summary, f.trend_summary, f.benchmark_summary,
                f.positive_factors, f.negative_factors, f.recommended_focus AS recommended_focus_facts,
                f.data_quality_notes AS data_quality_facts, f.limitations,
                f.rule_version AS fact_rule_version, r.language, r.executive_summary,
                r.greenhouse_status, r.improvements, r.deteriorations, r.stress_recovery,
                r.benchmark, r.recommended_focus, r.data_quality_notes,
                r.rule_version AS report_rule_version
         FROM agro_weekly_reports r
         JOIN agro_weekly_fact_packages f ON f.id = r.fact_package_id
           AND f.owner_user_id = r.owner_user_id AND f.device_id = r.device_id
           AND f.context_id = r.context_id AND f.week_start = r.week_start
         WHERE r.owner_user_id = ? AND r.device_id = ? AND r.context_id = ? AND r.week_start = ?`,
        [identity.owner_user_id, identity.device_id, identity.context_id, weekStart]
    );
    if (!rows.length) { throw new Error('[weekly-pdf] weekly fact package/report not found for identity and week'); }
    if (rows.length !== 1) { throw new Error('[weekly-pdf] ambiguous weekly report source'); }
    return sourceForPdf(rows[0]);
}

function outputDescriptor(source, outputDir = DEFAULT_OUTPUT_DIR) {
    const root = path.resolve(outputDir);
    const fileName = `rayat-weekly-report-context-${source.context_id}-${source.week_start}.pdf`;
    const directory = path.join(
        root,
        `owner-${source.owner_user_id}`,
        `device-${source.device_id}`,
        `context-${source.context_id}`
    );
    const filePath = path.resolve(directory, fileName);
    if (filePath !== path.join(directory, fileName) || !filePath.startsWith(`${root}${path.sep}`)) {
        throw new Error('[weekly-pdf] unsafe output path');
    }
    return { output_root: root, directory, file_name: fileName, file_path: filePath };
}

async function existingMetadata(source, expectedPath, executor) {
    const rows = await executor(
        `SELECT report_id, file_name, file_path, file_size, checksum, generated_at
         FROM agro_weekly_report_files
         WHERE owner_user_id = ? AND device_id = ? AND context_id = ? AND week_start = ?`,
        [source.owner_user_id, source.device_id, source.context_id, source.week_start]
    );
    if (!rows.length || path.resolve(rows[0].file_path) !== expectedPath) { return null; }
    try {
        const bytes = await fs.promises.readFile(expectedPath);
        if (bytes.length !== Number(rows[0].file_size) || sha256(bytes) !== String(rows[0].checksum)) { return null; }
        if (Number(rows[0].report_id) !== source.report_id) { return null; }
        return { ...rows[0], file_size: bytes.length, checksum: sha256(bytes) };
    } catch (error) {
        if (error.code === 'ENOENT') { return null; }
        throw error;
    }
}

async function writeAtomic(filePath, buffer) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.promises.rm(temporary, { force: true });
    try {
        await fs.promises.writeFile(temporary, buffer, { flag: 'wx', mode: 0o640 });
        await fs.promises.rename(temporary, filePath);
    } finally {
        await fs.promises.rm(temporary, { force: true });
    }
}

async function upsertFileMetadata(source, descriptor, buffer, checksum, executor) {
    await executor(
        `INSERT INTO agro_weekly_report_files
          (owner_user_id, device_id, context_id, week_start, report_id,
           file_name, file_path, file_size, checksum, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON CONFLICT (owner_user_id, device_id, context_id, week_start) DO UPDATE SET
           report_id=EXCLUDED.report_id, file_name=EXCLUDED.file_name,
           file_path=EXCLUDED.file_path, file_size=EXCLUDED.file_size,
           checksum=EXCLUDED.checksum, generated_at=NOW()`,
        [source.owner_user_id, source.device_id, source.context_id, source.week_start,
            source.report_id, descriptor.file_name, descriptor.file_path, buffer.length, checksum]
    );
}

async function exportWeeklyPdf({
    ownerUserId, deviceId, contextId, weekStart,
    dryRun = false, regenerate = false,
    outputDir = DEFAULT_OUTPUT_DIR, executor = query
} = {}) {
    const source = await loadWeeklyPdfSource({ ownerUserId, deviceId, contextId, weekStart }, executor);
    const descriptor = outputDescriptor(source, outputDir);
    if (!dryRun && !regenerate) {
        const existing = await existingMetadata(source, descriptor.file_path, executor);
        if (existing) {
            return {
                ...descriptor, report_id: source.report_id, week_start: source.week_start,
                file_size: existing.file_size, checksum: existing.checksum,
                dry_run: false, regenerated: false, reused: true
            };
        }
    }
    const buffer = await buildWeeklyPdfBuffer(source);
    const checksum = sha256(buffer);
    const result = {
        ...descriptor,
        report_id: source.report_id,
        week_start: source.week_start,
        file_size: buffer.length,
        checksum,
        dry_run: dryRun,
        regenerated: Boolean(regenerate),
        reused: false
    };
    if (dryRun) { return result; }
    await writeAtomic(descriptor.file_path, buffer);
    await upsertFileMetadata(source, descriptor, buffer, checksum, executor);
    return result;
}

module.exports = {
    ensureWeeklyPdfSchema,
    loadWeeklyPdfSource,
    buildWeeklyPdfBuffer,
    exportWeeklyPdf,
    outputDescriptor,
    normalizeIdentity,
    normalizeDate,
    sourceForPdf,
    sha256,
    DEFAULT_OUTPUT_DIR,
    CONTENT_SOURCE_TABLES,
    RULE_VERSION
};
