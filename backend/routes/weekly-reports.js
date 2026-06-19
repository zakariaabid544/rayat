'use strict';

const express = require('express');
const { query } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const {
    listWeeklyReportHistory,
    getReportMetadata,
    getRenderedReport,
    getPdfMetadata,
    getPdfDownload
} = require('../utils/weekly-report-history');

function createWeeklyReportsRouter({
    executor = query,
    authenticate = authenticateToken,
    outputDir = process.env.AGRO_WEEKLY_PDF_DIR
} = {}) {
    const router = express.Router();
    router.use(authenticate);

    function wrap(handler) {
        return async (req, res) => {
            try { await handler(req, res); }
            catch (error) {
                if (error && error.status) {
                    return res.status(error.status).json({ error: error.message, code: error.code });
                }
                console.error('[weekly-reports-api] error:', error && error.message);
                return res.status(500).json({ error: 'Errore interno', code: 'report_history_error' });
            }
        };
    }

    router.get('/weekly', wrap(async (req, res) => {
        res.json(await listWeeklyReportHistory({ user: req.user, filters: req.query, executor }));
    }));

    router.get('/weekly/:reportId/text', wrap(async (req, res) => {
        res.json(await getRenderedReport({ reportId: req.params.reportId, user: req.user, executor }));
    }));

    router.get('/weekly/:reportId/pdf', wrap(async (req, res) => {
        res.json(await getPdfMetadata({ reportId: req.params.reportId, user: req.user, executor }));
    }));

    router.get('/weekly/:reportId/download', wrap(async (req, res) => {
        const file = await getPdfDownload({
            reportId: req.params.reportId,
            user: req.user,
            executor,
            ...(outputDir ? { outputDir } : {})
        });
        res.download(file.file_path, file.file_name, (error) => {
            if (error && !res.headersSent) {
                res.status(error.code === 'ENOENT' ? 404 : 500).json({
                    error: 'Download PDF non riuscito', code: 'report_pdf_download'
                });
            }
        });
    }));

    router.get('/weekly/:reportId', wrap(async (req, res) => {
        res.json(await getReportMetadata({ reportId: req.params.reportId, user: req.user, executor }));
    }));

    return router;
}

const router = createWeeklyReportsRouter();
router.createWeeklyReportsRouter = createWeeklyReportsRouter;

module.exports = router;
