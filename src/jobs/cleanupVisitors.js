module.exports = function({ activeVisitors, getSettings }) {
  return function cleanupExpiredVisitors() {
    const now = Date.now();
    const timeout = getSettings().visitor_timeout_ms;
    for (const [sessionId, lastSeen] of activeVisitors.entries()) {
      if (now - lastSeen > timeout) {
        activeVisitors.delete(sessionId);
      }
    }
  };
};
