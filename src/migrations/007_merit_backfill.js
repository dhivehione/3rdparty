function up(db) {
  const now = new Date().toISOString();

  // Backfill signup_base merit_events for users who have initial_merit_estimate
  // but no corresponding signup_base entry in the audit ledger.
  const backfilled = db.prepare(`
    INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
    SELECT
      s.id,
      'signup_base',
      s.initial_merit_estimate - COALESCE(ms.total, 0),
      NULL,
      NULL,
      'Initial signup merit (backfilled)',
      s.timestamp
    FROM signups s
    LEFT JOIN (
      SELECT user_id, SUM(points) as total FROM merit_events GROUP BY user_id
    ) ms ON s.id = ms.user_id
    WHERE s.is_verified = 1
      AND s.unregistered_at IS NULL
      AND s.initial_merit_estimate > COALESCE(ms.total, 0)
      AND NOT EXISTS (
        SELECT 1 FROM merit_events me WHERE me.user_id = s.id AND me.event_type = 'signup_base'
      )
  `).run();

  const count = backfilled.changes;
  if (count > 0) {
    console.log(`✓ Migration 7: Backfilled ${count} missing signup_base merit events`);
  } else {
    console.log('✓ Migration 7: No missing signup_base events to backfill');
  }

  // Backfill missing referral_base merit_events for referrers who received
  // bonus points via the non-OTP signup path (which bypassed awardMerit).
  const referralBackfilled = db.prepare(`
    INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
    SELECT
      r.referrer_id,
      'referral_base',
      r.base_reward_given,
      r.referred_id,
      'referral',
      'Referred member joined (backfilled)',
      r.referred_joined_at
    FROM referrals r
    WHERE r.base_reward_given > 0
      AND r.status IN ('joined', 'active')
      AND r.referred_id IS NOT NULL
      AND r.referred_joined_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM merit_events me
        WHERE me.user_id = r.referrer_id
          AND me.event_type = 'referral_base'
          AND me.reference_id = r.referred_id
      )
  `).run();

  const refCount = referralBackfilled.changes;
  if (refCount > 0) {
    console.log(`✓ Migration 7: Backfilled ${refCount} missing referral_base merit events`);
  } else {
    console.log('✓ Migration 7: No missing referral_base events to backfill');
  }
}

module.exports = { up };
