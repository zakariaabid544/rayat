'use strict';

const express = require('express');
const { query } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const P = require('../utils/prediction-dashboard');

function createPredictionRouter({ executor = query, authenticate = authenticateToken } = {}) {
    const router = express.Router();
    router.use(authenticate);
    const wrap = (handler) => async (req, res) => {
        try { await handler(req, res); }
        catch (error) {
            if (error && error.status) {
                return res.status(error.status).json({ error: error.message, code: error.code || 'prediction_access' });
            }
            console.error('[prediction-api] error:', error && error.message);
            return res.status(500).json({ error: 'Errore interno', code: 'prediction_error' });
        }
    };
    const target = async (req) => P.resolvePredictionTarget({
        user: req.user, deviceId: req.query.device_id, contextId: req.query.context_id, executor
    });

    router.get('/contexts', wrap(async (req, res) => {
        res.json(await P.listPredictionContexts({ user: req.user, filters: req.query, executor }));
    }));
    router.get('/overview', wrap(async (req, res) => {
        res.json(await P.getPredictionOverview({ user: req.user, deviceId: req.query.device_id,
            contextId: req.query.context_id, executor }));
    }));
    router.get('/metric-forecasts', wrap(async (req, res) => {
        const t = await target(req); const rows = await P.getMetricForecasts(t, executor);
        res.json({ available: rows.length > 0, metric_forecasts: rows });
    }));
    router.get('/breach-eta', wrap(async (req, res) => {
        const t = await target(req); const rows = await P.getBreachEta(t, executor);
        res.json({ available: rows.length > 0, breach_eta: rows });
    }));
    router.get('/stress-eta', wrap(async (req, res) => {
        const t = await target(req); const rows = await P.getStressEta(t, executor);
        res.json({ available: rows.length > 0, stress_eta: rows });
    }));
    router.get('/risk-forecasts', wrap(async (req, res) => {
        const t = await target(req); const rows = await P.getRiskForecasts(t, executor);
        res.json({ available: rows.length > 0, risk_forecasts: rows });
    }));
    router.get('/recovery-forecast', wrap(async (req, res) => {
        const t = await target(req); const row = await P.getRecoveryForecast(t, executor);
        res.json({ available: Boolean(row), recovery_forecast: row });
    }));
    router.get('/early-warnings', wrap(async (req, res) => {
        const t = await target(req); const rows = await P.getEarlyWarnings(t, executor);
        res.json({ available: rows.length > 0, early_warnings: rows });
    }));
    return router;
}

const router = createPredictionRouter();
router.createPredictionRouter = createPredictionRouter;
module.exports = router;
