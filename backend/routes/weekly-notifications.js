'use strict';

const express = require('express');
const { query } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const {
    listNotifications,
    countUnreadNotifications,
    markNotificationRead
} = require('../utils/weekly-report-notifications');

function createWeeklyNotificationsRouter({ executor = query, authenticate = authenticateToken } = {}) {
    const router = express.Router();
    router.use(authenticate);

    function wrap(handler) {
        return async (req, res) => {
            try { await handler(req, res); }
            catch (error) {
                if (error && error.status) {
                    return res.status(error.status).json({ error: error.message, code: error.code });
                }
                console.error('[weekly-notifications-api] error:', error && error.message);
                return res.status(500).json({ error: 'Errore interno', code: 'notification_error' });
            }
        };
    }

    router.get('/admin', wrap(async (req, res) => {
        res.json(await listNotifications({ user: req.user, filters: req.query, admin: true, executor }));
    }));

    router.get('/unread-count', wrap(async (req, res) => {
        res.json(await countUnreadNotifications({ user: req.user, executor }));
    }));

    router.get('/', wrap(async (req, res) => {
        res.json(await listNotifications({ user: req.user, filters: req.query, executor }));
    }));

    router.patch('/:notificationId/read', wrap(async (req, res) => {
        res.json(await markNotificationRead({
            notificationId: req.params.notificationId,
            user: req.user,
            executor
        }));
    }));

    return router;
}

const router = createWeeklyNotificationsRouter();
router.createWeeklyNotificationsRouter = createWeeklyNotificationsRouter;

module.exports = router;
