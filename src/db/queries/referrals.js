module.exports = function(db) {
  return {
    getExistingReferral(referredId) {
      return db.prepare("SELECT id FROM referrals WHERE referred_id = ? AND status != 'removed'").get(referredId);
    },
    getInviteCount(referrerId) {
      return db.prepare(`SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND (status = 'joined' OR status = 'active') AND base_reward_given = 1`).get(referrerId).count;
    },
    getEngageInviteCount(referrerId) {
      return db.prepare(`SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND (status = 'joined' OR status = 'active') AND base_reward_given > 0`).get(referrerId).count;
    },
    insertJoined(referral) {
      return db.prepare('INSERT INTO referrals (referrer_id, referred_id, relation, status, base_reward_given, created_at, referred_joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(referral.referrer_id, referral.referred_id, referral.relation, referral.status, referral.base_reward_given, referral.created_at, referral.referred_joined_at);
    },
    insertPending(referral) {
      return db.prepare('INSERT INTO referrals (referrer_id, referred_id, relation, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(referral.referrer_id, referral.referred_id, referral.relation, referral.status, referral.created_at);
    },
    updatePendingWaiting(id, details) {
      return db.prepare("UPDATE referrals SET status = 'pending_waiting', referred_id = NULL, details = ? WHERE id = ?").run(details, id);
    },
    updateJoined(id, referredId, baseRewardGiven, joinedAt) {
      return db.prepare("UPDATE referrals SET referred_id = ?, status = 'joined', base_reward_given = ?, referred_joined_at = ? WHERE id = ?")
        .run(referredId, baseRewardGiven, joinedAt, id);
    },
    getPendingReferral(detailsPattern) {
      return db.prepare("SELECT * FROM referrals WHERE status = 'pending_waiting' AND details LIKE ?").get(detailsPattern);
    },
    getUserReferrals(referrerId) {
      return db.prepare(`
        SELECT r.*, s.name as referred_name, s.phone as referred_phone, s.island as referred_island
        FROM referrals r LEFT JOIN signups s ON r.referred_id = s.id
        WHERE r.referrer_id = ? ORDER BY r.created_at DESC
      `).all(referrerId);
    },
    getReferralTotals(referrerId) {
      return db.prepare(`
        SELECT COUNT(*) as total_referrals, SUM(base_reward_given) as total_base_points, SUM(engagement_bonus_given) as total_engagement_points
        FROM referrals WHERE referrer_id = ? AND status != 'removed'
      `).get(referrerId);
    },
    getById(id) {
      return db.prepare('SELECT * FROM referrals WHERE id = ?').get(id);
    },
    updateRemoved(id) {
      return db.prepare("UPDATE referrals SET status = 'removed' WHERE id = ?").run(id);
    },
    getReferralForEngage(referredId) {
      return db.prepare("SELECT r.id, r.referrer_id, r.first_action_at FROM referrals r WHERE r.referred_id = ? AND r.status != 'removed' LIMIT 1").get(referredId);
    },
    updateFirstAction(id, firstActionAt) {
      return db.prepare('UPDATE referrals SET first_action_at = ? WHERE id = ?').run(firstActionAt, id);
    },
    updateEngagementBonus(id, bonusGiven) {
      return db.prepare('UPDATE referrals SET engagement_bonus_given = ? WHERE id = ?').run(bonusGiven, id);
    },
  };
};
