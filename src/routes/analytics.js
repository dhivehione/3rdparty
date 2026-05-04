const express = require('express');
const router = express.Router();

module.exports = function({ getSettings }) {
  const analytics = require('../services/analytics')({ getSettings });
  const { activeVisitors, getClientIp, cleanupExpiredVisitors, recordHeartbeat, getActiveVisitors } = analytics;

  router.post('/api/analytics/heartbeat', (req, res) => {
    const sessionId = req.body.session_id || getClientIp(req);
    recordHeartbeat(sessionId);
    res.json({ success: true, active_count: activeVisitors.size });
  });

  router.get('/api/analytics/active', (req, res) => {
    res.json({ active: getActiveVisitors(), success: true });
  });

  return { router, activeVisitors, getClientIp, cleanupExpiredVisitors };
};
