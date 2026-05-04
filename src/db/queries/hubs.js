module.exports = function(db) {
  return {
    getEmeritusMembers() {
      return db.prepare(`
        SELECT ec.*, s.name, s.username, s.initial_merit_estimate as merit_score
        FROM emiritus_council ec JOIN signups s ON ec.user_id = s.id
        WHERE ec.is_active = 1 ORDER BY ec.invited_at DESC
      `).all();
    },
    getHubMembers(hubId) {
      return db.prepare(`
        SELECT hm.*, s.name, s.username, s.initial_merit_estimate as merit_score
        FROM hub_members hm JOIN signups s ON hm.user_id = s.id WHERE hm.hub_id = ?
      `).all(hubId);
    },
    createHub(hub) {
      return db.prepare('INSERT INTO policy_hubs (name, charter, goals, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(hub.name, hub.charter, hub.goals, hub.created_by_user_id, hub.created_at);
    },
    getLastInsertId() {
      return db.prepare('SELECT last_insert_rowid() as id').get().id;
    },
    addHubMember(hubId, userId, role, joinedAt) {
      return db.prepare('INSERT INTO hub_members (hub_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(hubId, userId, role, joinedAt);
    },
    getActiveHubs() {
      return db.prepare(`
        SELECT ph.*, (SELECT COUNT(*) FROM hub_members WHERE hub_id = ph.id) as member_count
        FROM policy_hubs ph WHERE ph.status = 'active' ORDER BY ph.created_at DESC
      `).all();
    },
    getHub(id) {
      return db.prepare('SELECT * FROM policy_hubs WHERE id = ? AND status = ?').get(id, 'active');
    },
    getExistingMember(hubId, userId) {
      return db.prepare('SELECT id FROM hub_members WHERE hub_id = ? AND user_id = ?').get(hubId, userId);
    },
    addMember(hubId, userId, joinedAt) {
      return db.prepare('INSERT INTO hub_members (hub_id, user_id, joined_at) VALUES (?, ?, ?)').run(hubId, userId, joinedAt);
    },
    getActiveHubsForStipends() {
      return db.prepare("SELECT * FROM policy_hubs WHERE status = 'active'").all();
    },
    getHubMembersForStipends(hubId) {
      return db.prepare('SELECT user_id FROM hub_members WHERE hub_id = ?').all(hubId);
    },
    getExistingHubStipend(hubId, userId, year, month) {
      return db.prepare('SELECT id FROM hub_stipends WHERE hub_id = ? AND user_id = ? AND period_year = ? AND period_month = ?').get(hubId, userId, year, month);
    },
    insertHubStipend(hubId, userId, year, month, amount, awardedAt) {
      return db.prepare('INSERT INTO hub_stipends (hub_id, user_id, period_year, period_month, amount_awarded, awarded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(hubId, userId, year, month, amount, awardedAt);
    },
    updateHubMemberStipend(hubId, userId, amount) {
      return db.prepare('UPDATE hub_members SET stipend_earned = stipend_earned + ? WHERE hub_id = ? AND user_id = ?').run(amount, hubId, userId);
    },
  };
};
