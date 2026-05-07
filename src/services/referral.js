module.exports = function({ db, getSettings, logActivity, merit }) {
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
      merit.awardMerit(referral.referrer_id, 'engagement_bonus', engagePoints, referral.id, 'referral', 'Referred member took first action');
      logActivity('engagement_bonus_awarded', referral.referrer_id, userId, { referral_id: referral.id, points: engagePoints, invite_count: inviteCount });
    } catch (e) {
      console.error('Engage referral error:', e);
    }
  }

  function awardReferralLoginMerit(userId) {
    if (!userId) return;
    try {
      const referral = db.prepare(`
        SELECT r.id, r.referrer_id, r.created_at, r.first_login_at, r.upfront_merit_awarded, r.base_reward_given
        FROM referrals r WHERE r.referred_id = ? AND r.status != 'removed'
        LIMIT 1
      `).get(userId);
      if (!referral || referral.first_login_at) return;

      const s = getSettings();
      const now = new Date();
      const enrolledAt = new Date(referral.created_at);
      const daysSinceEnrollment = (now - enrolledAt) / (1000 * 60 * 60 * 24);

      const totalBasePoints = referral.base_reward_given;
      const upfrontFraction = parseFloat(s.referral_upfront_fraction) || 0.5;
      const remainingPoints = totalBasePoints * (1 - upfrontFraction);

      let pointsToAward = remainingPoints;

      if (daysSinceEnrollment > (parseFloat(s.referral_login_delay_days) || 7)) {
        const reductionFraction = parseFloat(s.referral_delayed_reduction_fraction) || 0.5;
        pointsToAward = remainingPoints * reductionFraction;
      }

      const loginAt = now.toISOString();
      db.prepare(`UPDATE referrals SET first_login_at = ? WHERE id = ?`).run(loginAt, referral.id);

      if (pointsToAward > 0) {
        merit.awardMerit(referral.referrer_id, 'referral_login_bonus', pointsToAward, referral.id, 'referral', 'Referred member logged in');
        logActivity('referral_login_bonus_awarded', referral.referrer_id, userId, {
          referral_id: referral.id,
          points: pointsToAward,
          days_since_enrollment: Math.round(daysSinceEnrollment),
          total_base_points: totalBasePoints,
          upfront_fraction: upfrontFraction
        });
      }

      return { pointsAwarded: pointsToAward, daysSinceEnrollment: Math.round(daysSinceEnrollment) };
    } catch (e) {
      console.error('Award referral login merit error:', e);
      return null;
    }
  }

  function getEnrollmentsToday(userId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.toISOString();
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM referrals
      WHERE referrer_id = ? AND created_at >= ?
    `).get(userId, todayStart);
    return result.count;
  }

  return { getReferralPoints, maybeEngageReferral, awardReferralLoginMerit, getEnrollmentsToday };
};