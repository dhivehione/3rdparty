function getLoyaltyCoefficient(joinDate, settings) {
  let s = settings;
  if (!s) {
    try { if (this && this.getSettings) s = this.getSettings(); } catch (e) {}
  }
  s = s || { loyalty_threshold_days_1: 180, loyalty_threshold_days_2: 365 };
  const now = new Date();
  const join = new Date(joinDate);
  const daysSinceJoin = (now - join) / (1000 * 60 * 60 * 24);

  if (daysSinceJoin < s.loyalty_threshold_days_1) return 1.0;
  if (daysSinceJoin < s.loyalty_threshold_days_2) return 1.2;
  return 1.5;
}

function calculateVoteWeight(joinDate, createdAt) {
  const settings = this.getSettings();
  const lc = getLoyaltyCoefficient(joinDate, settings);
  const created = new Date(createdAt);
  const now = new Date();
  const daysSinceCreated = (now - created) / (1000 * 60 * 60 * 24);

  const primaryWindowDays = settings.voting_window_primary_days;
  const extendedWindowDays = settings.voting_window_extended_days;
  const primaryWeight = settings.voting_weight_primary;
  const extendedWeight = settings.voting_weight_extended;

  let windowWeight = primaryWeight;
  if (daysSinceCreated > primaryWindowDays) {
    windowWeight = extendedWeight;
  }

  const memberWeight = lc;

  return memberWeight * windowWeight;
}

function calculateApprovalThreshold(category) {
  const settings = this.getSettings();
  if (category === 'constitutional') {
    return settings.approval_threshold_constitutional;
  } else if (category === 'policy') {
    return settings.approval_threshold_policy;
  }
  return settings.approval_threshold_routine;
}

function calculateDecayedScore(userId, joinDate) {
  const settings = this.getSettings();
  const lc = getLoyaltyCoefficient(joinDate, settings);
  const events = this.db.prepare('SELECT * FROM merit_events WHERE user_id = ?').all(userId);

  let totalScore = 0;
  const now = new Date();

  events.forEach(event => {
    const eventDate = new Date(event.created_at);
    const daysSince = (now - eventDate) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.exp(-(settings.merit_lambda_base / lc) * daysSince);
    totalScore += event.points * decayFactor;
  });

  return Math.round(totalScore * 100) / 100;
}

function calculateStaticScore(userId) {
  const result = this.db.prepare('SELECT SUM(points) as total FROM merit_events WHERE user_id = ?').get(userId);
  return result.total || 0;
}

function calculateEndorsementPoints(count) {
  const s = this.getSettings();
  if (count <= 0) return 0;
  if (count <= s.endorsement_tier1_limit) return count * s.endorsement_tier1_pts;
  if (count <= s.endorsement_tier2_limit) return s.endorsement_tier1_limit * s.endorsement_tier1_pts + (count - s.endorsement_tier1_limit) * s.endorsement_tier2_pts;
  if (count <= s.endorsement_tier3_limit) return s.endorsement_tier1_limit * s.endorsement_tier1_pts + (s.endorsement_tier2_limit - s.endorsement_tier1_limit) * s.endorsement_tier2_pts + (count - s.endorsement_tier2_limit) * s.endorsement_tier3_pts;
  return s.endorsement_tier1_limit * s.endorsement_tier1_pts + (s.endorsement_tier2_limit - s.endorsement_tier1_limit) * s.endorsement_tier2_pts + (s.endorsement_tier3_limit - s.endorsement_tier2_limit) * s.endorsement_tier3_pts + (count - s.endorsement_tier3_limit) * s.endorsement_tier4_pts;
}

function calculateStakeAmount(userId) {
  const settings = this.getSettings();
  const events = this.db.prepare('SELECT SUM(points) as total FROM merit_events WHERE user_id = ?').get(userId);
  const ms = events.total || 0;
  return Math.max(settings.min_stake_amount, Math.round(ms * 0.005 * 100) / 100);
}

function processProposalStakes(proposalId, yesVotes, noVotes, totalVotes) {
  try {
    const proposal = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
    if (!proposal) return;

    const supportPct = totalVotes > 0 ? (yesVotes / totalVotes) * 100 : 0;
    const stakes = this.db.prepare('SELECT * FROM proposal_stakes WHERE proposal_id = ?').all(proposalId);

    if (supportPct >= 20) {
      stakes.forEach(stake => {
        if (stake.status === 'locked') {
          this.db.prepare("UPDATE proposal_stakes SET status = 'refunded', resolved_at = ? WHERE id = ?")
            .run(new Date().toISOString(), stake.id);

          awardMerit.call(this, stake.user_id, 'stake_refund', stake.stake_amount, proposalId, 'proposal', 'Proposal stake refunded');
        }
      });
    } else if (supportPct < 10 && supportPct > 0) {
      stakes.forEach(stake => {
        if (stake.status === 'locked') {
          const authorStakes = this.db.prepare("SELECT COUNT(*) as cnt FROM proposal_stakes WHERE user_id = ? AND status = 'locked'").get(stake.user_id);
          const successfulStakes = this.db.prepare(`
            SELECT COUNT(DISTINCT ps.proposal_id) as cnt FROM proposal_stakes ps
            JOIN proposals p ON ps.proposal_id = p.id
            WHERE ps.user_id = ? AND p.passed = 1 AND ps.status = 'refunded'
          `).get(stake.user_id);

          const failedCount = authorStakes.cnt - successfulStakes.cnt;
          const successfulCount = successfulStakes.cnt;
          const qualityRatio = (1 + failedCount) / (1 + successfulCount);
          const penalty = Math.round(stake.stake_amount * qualityRatio * 100) / 100;

          this.db.prepare("UPDATE proposal_stakes SET status = 'forfeited', resolved_at = ? WHERE id = ?")
            .run(new Date().toISOString(), stake.id);

          awardMerit.call(this, stake.user_id, 'stake_penalty', -penalty, proposalId, 'proposal', `Frivolous proposal penalty (${Math.round(qualityRatio * 100)}% of stake)`);
        }
      });
    }

    console.log(`Processed stakes for proposal ${proposalId}: ${supportPct.toFixed(1)}% support`);
  } catch (e) {
    console.error('Process stakes error:', e);
  }
}

function getRoleStipend(role) {
  const settings = this.getSettings();
  const map = {
    council: settings.stipend_council,
    committee: settings.stipend_committee,
    advisory: settings.stipend_advisory
  };
  return map[role] || 0;
}

function awardMerit(userId, eventType, points, referenceId, referenceType, description) {
  if (!userId || points === undefined || points === null) return;
  const now = new Date().toISOString();
  const safeRefId = referenceId || null;
  const safeRefType = referenceType || null;
  const safeDesc = description || '';

  this.db.prepare(`
    INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, eventType, points, safeRefId, safeRefType, safeDesc, now);

  this.db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
    .run(points, userId);
}

function processMonthlyStipends() {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const activeTerms = this.db.prepare(`
      SELECT lt.*, lp.position_type, lp.title as position_title, s.id as user_id
      FROM leadership_terms lt
      JOIN leadership_positions lp ON lt.position_id = lp.id
      JOIN signups s ON lt.user_id = s.id
      WHERE lt.ended_at IS NULL AND lp.is_active = 1
    `).all();

    activeTerms.forEach(term => {
      const stipendAmount = getRoleStipend.call(this, term.position_type);
      if (!term.ended_at && stipendAmount > 0) {
        const existing = this.db.prepare(`
          SELECT id FROM leadership_stipends
          WHERE user_id = ? AND position_id = ? AND period_year = ? AND period_month = ?
        `).get(term.user_id, term.position_id, year, month);

        if (!existing) {
          const awardedAt = now.toISOString();

          this.db.prepare(`
            INSERT INTO leadership_stipends (user_id, position_id, period_year, period_month, amount_awarded, awarded_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(term.user_id, term.position_id, year, month, stipendAmount, awardedAt);

          awardMerit.call(this, term.user_id, 'leadership_stipend', stipendAmount, term.position_id, 'stipend', `${term.position_title} stipend (${month}/${year})`);

          this.logActivity('stipend_awarded', term.user_id, term.position_id, { amount: stipendAmount, period: `${month}/${year}` }, {});
        }
      }
    });

    console.log(`Stipend processing complete for ${year}-${month}`);
  } catch (e) {
    console.error('Stipend processing error:', e);
  }
}

module.exports = function({ db, getSettings, logActivity }) {
  const ctx = { db, getSettings, logActivity };

  return {
    getSettings,
    getRoleStipend: getRoleStipend.bind(ctx),
    getLoyaltyCoefficient: getLoyaltyCoefficient.bind(ctx),
    calculateVoteWeight: calculateVoteWeight.bind(ctx),
    calculateApprovalThreshold: calculateApprovalThreshold.bind(ctx),
    calculateDecayedScore: calculateDecayedScore.bind(ctx),
    calculateStaticScore: calculateStaticScore.bind(ctx),
    calculateEndorsementPoints: calculateEndorsementPoints.bind(ctx),
    calculateStakeAmount: calculateStakeAmount.bind(ctx),
    processProposalStakes: processProposalStakes.bind(ctx),
    processMonthlyStipends: processMonthlyStipends.bind(ctx),
    awardMerit: awardMerit.bind(ctx),
  };
};
