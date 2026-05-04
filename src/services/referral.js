module.exports = function({ db, getSettings, logActivity }) {
  function getReferralPoints(inviteCount, isEngagementBonus = false) {
    const s = getSettings();
    if (isEngagementBonus) {
      if (inviteCount <= s.referral_tier1_limit) return s.referral_engage_t1;
      if (inviteCount <= s.referral_tier2_limit) return s.referral_engage_t2;
      return s.referral_engage_t3;
    }
    if (inviteCount <= s.referral_tier1_limit) return s.referral_base_t1;
    if (inviteCount <= s.referral_tier2_limit) return s.referral_base_t2;
    return s.referral_base_t3;
  }

  function maybeEngageReferral(userId) {
    if (!userId) return;
    try {
      const referral = db.prepare(`
        SELECT r.id, r.referrer_id, r.first_action_at
        FROM referrals r WHERE r.referred_id = ? AND r.status != 'removed'
        LIMIT 1
      `).get(userId);
      if (!referral || referral.first_action_at) return;
      const s = getSettings();
      const now = new Date().toISOString();
      db.prepare(`UPDATE referrals SET first_action_at = ? WHERE id = ?`).run(now, referral.id);
      const inviteCount = db.prepare(`
        SELECT COUNT(*) as count FROM referrals 
        WHERE referrer_id = ? AND (status = 'joined' OR status = 'active') AND base_reward_given > 0
      `).get(referral.referrer_id).count;
      const engagePoints = getReferralPoints(inviteCount, true);
      db.prepare(`
        UPDATE referrals SET engagement_bonus_given = ? WHERE id = ?
      `).run(engagePoints, referral.id);
      db.prepare(`
        INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
        VALUES (?, 'engagement_bonus', ?, ?, 'referral', 'Referred member took first action', ?)
      `).run(referral.referrer_id, engagePoints, referral.id, now);
      db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
        .run(engagePoints, referral.referrer_id);
      logActivity('engagement_bonus_awarded', referral.referrer_id, userId, { referral_id: referral.id, points: engagePoints, invite_count: inviteCount });
    } catch (e) {
      console.error('Engage referral error:', e);
    }
  }

  return { getReferralPoints, maybeEngageReferral };
};