module.exports = function({ getSettings }) {
  const activeVisitors = new Map();

  function getClientIp(req) {
    return req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  }

  function cleanupExpiredVisitors() {
    const now = Date.now();
    const timeout = getSettings().visitor_timeout_ms;
    for (const [sessionId, lastSeen] of activeVisitors.entries()) {
      if (now - lastSeen > timeout) {
        activeVisitors.delete(sessionId);
      }
    }
  }

  function recordHeartbeat(sessionId) {
    activeVisitors.set(sessionId, Date.now());
  }

  function getActiveVisitors() {
    cleanupExpiredVisitors();
    return activeVisitors.size;
  }

  return { activeVisitors, getClientIp, cleanupExpiredVisitors, recordHeartbeat, getActiveVisitors };
};
