const express = require('express');

const { recordAnalyticsEvent } = require('../utils/analytics');

const router = express.Router();

// RAYAT FIX - email + analytics
router.post('/track', async (req, res) => {
    try {
        await recordAnalyticsEvent(req, req.body || {});
    } catch (error) {
        console.warn('Analytics track warning:', error.message);
    }

    res.status(204).end();
});

module.exports = router;
