const express = require('express');
const router = express.Router();

const activeVisitors = new Map();

function getClientIp(req) {
  return req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
}

module.exports = function({ getSettings }) {
  function cleanupExpiredVisitors() {
    const now = Date.now();
    const timeout = getSettings().visitor_timeout_ms;
    for (const [sessionId, lastSeen] of activeVisitors.entries()) {
      if (now - lastSeen > timeout) {
        activeVisitors.delete(sessionId);
      }
    }
  }

  router.post('/api/analytics/heartbeat', (req, res) => {
    const sessionId = req.body.session_id || getClientIp(req);
    activeVisitors.set(sessionId, Date.now());
    res.json({ success: true, active_count: activeVisitors.size });
  });

  router.get('/api/analytics/active', (req, res) => {
    cleanupExpiredVisitors();
    res.json({ active: activeVisitors.size, success: true });
  });

  setInterval(cleanupExpiredVisitors, 60000);

  return { router, activeVisitors, getClientIp, cleanupExpiredVisitors };
};