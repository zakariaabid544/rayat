const express = require('express');

const { recordAnalyticsEvent } = require('../utils/analytics');

const router = express.Router();

// RAYAT FIX - analytics followup
router.use(express.text({
    type: ['text/plain', 'application/json', 'application/*+json']
}));

// RAYAT FIX - analytics followup
router.post('/track', async (req, res) => {
    let payload = req.body || {};

    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (error) {
            console.warn('[analytics] invalid payload received');
            payload = {};
        }
    }

    try {
        const saved = await recordAnalyticsEvent(req, payload);
        if (saved && process.env.NODE_ENV !== 'test') {
            console.info('[analytics] track accepted', {
                eventType: payload.eventType || null,
                pagePath: payload.pagePath || null
            });
        }
    } catch (error) {
        console.warn('Analytics track warning:', error.message);
    }

    res.status(204).end();
});

module.exports = router;
