module.exports = function(db) {
  return {
    getEvents(userId) {
      return db.prepare('SELECT * FROM merit_events WHERE user_id = ?').all(userId);
    },
    getEventsPaginated(userId, limit, offset) {
      return db.prepare('SELECT * FROM merit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(userId, limit, offset);
    },
    countEvents(userId) {
      return db.prepare('SELECT COUNT(*) as cnt FROM merit_events WHERE user_id = ?').get(userId);
    },
    sumPoints(userId) {
      const result = db.prepare('SELECT SUM(points) as total FROM merit_events WHERE user_id = ?').get(userId);
      return result?.total || 0;
    },
    sumPointsType(userId, eventType) {
      const result = db.prepare('SELECT SUM(points) as total FROM merit_events WHERE user_id = ? AND event_type = ?').get(userId, eventType);
      return result?.total || 0;
    },
    hasRecentActivity(userId, sinceDate) {
      return db.prepare('SELECT COUNT(*) as cnt FROM merit_events WHERE user_id = ? AND created_at > ?').get(userId, sinceDate);
    },
    insertEvent(event) {
      return db.prepare(
        'INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(event.user_id, event.event_type, event.points, event.reference_id, event.reference_type, event.description, event.created_at);
    },
    getLeaderboard(limit) {
      return db.prepare(`
        SELECT s.id, s.name, s.username, COALESCE(SUM(me.points), 0) as static_score
        FROM signups s LEFT JOIN merit_events me ON s.id = me.user_id
        WHERE s.is_verified = 1 AND s.unregistered_at IS NULL
        GROUP BY s.id ORDER BY static_score DESC LIMIT ?
      `).all(limit);
    },
    getUserLockedStakes(userId) {
      return db.prepare("SELECT COUNT(*) as cnt FROM proposal_stakes WHERE user_id = ? AND status = 'locked'").get(userId);
    },
    getUserSuccessfulStakes(userId) {
      return db.prepare(`
        SELECT COUNT(DISTINCT ps.proposal_id) as cnt FROM proposal_stakes ps
        JOIN proposals p ON ps.proposal_id = p.id
        WHERE ps.user_id = ? AND p.passed = 1 AND ps.status = 'refunded'
      `).get(userId);
    },
    updateStakeRefunded(id, resolvedAt) {
      return db.prepare("UPDATE proposal_stakes SET status = 'refunded', resolved_at = ? WHERE id = ?").run(resolvedAt, id);
    },
    updateStakeForfeited(id, resolvedAt) {
      return db.prepare("UPDATE proposal_stakes SET status = 'forfeited', resolved_at = ? WHERE id = ?").run(resolvedAt, id);
    },
    getStakesForProposal(proposalId) {
      return db.prepare('SELECT * FROM proposal_stakes WHERE proposal_id = ?').all(proposalId);
    },
    getActiveTermsForStipends() {
      return db.prepare(`
        SELECT lt.*, lp.position_type, lp.title as position_title, s.id as user_id
        FROM leadership_terms lt
        JOIN leadership_positions lp ON lt.position_id = lp.id
        JOIN signups s ON lt.user_id = s.id
        WHERE lt.ended_at IS NULL AND lp.is_active = 1
      `).all();
    },
    getExistingStipend(userId, positionId, year, month) {
      return db.prepare('SELECT id FROM leadership_stipends WHERE user_id = ? AND position_id = ? AND period_year = ? AND period_month = ?')
        .get(userId, positionId, year, month);
    },
    insertStipend(stipend) {
      return db.prepare('INSERT INTO leadership_stipends (user_id, position_id, period_year, period_month, amount_awarded, awarded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(stipend.user_id, stipend.position_id, stipend.period_year, stipend.period_month, stipend.amount_awarded, stipend.awarded_at);
    },
  };
};
