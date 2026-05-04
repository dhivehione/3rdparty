function logActivity(actionType, userId, targetId, details, req) {
  try {
    const stmt = this.db.prepare(
      'INSERT INTO activity_log (action_type, user_id, target_id, details, ip_address, user_agent, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(
      actionType,
      userId || null,
      targetId || null,
      details ? JSON.stringify(details) : null,
      req ? (req.ip || req.connection.remoteAddress) : null,
      req ? (req.get('User-Agent') || null) : null,
      new Date().toISOString()
    );
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
}

module.exports = function({ db }) {
  return { logActivity: logActivity.bind({ db }) };
};