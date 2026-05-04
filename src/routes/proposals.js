const express = require('express');
const router = express.Router();
module.exports = function({ db, getSettings, logActivity, merit, maybeEngageReferral, sanitizeHTML, userAuth }) {

// ==================== PROPOSAL STAKES & REPUTATION (Whitepaper sec II.C.10) ====================
// Stake: max(10, MS * 0.005), Refund if >=20% support, Forfeit if <10% support
db.exec(`
  CREATE TABLE IF NOT EXISTS proposal_stakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    stake_amount REAL NOT NULL,
    status TEXT DEFAULT 'locked' CHECK(status IN ('locked', 'refunded', 'forfeited')),
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id),
    FOREIGN KEY (user_id) REFERENCES signups(id)
  )
`);

// ==================== PROPOSALS API ====================
// GET /api/proposals - Get all active proposals
router.get('/api/proposals', (req, res) => {
  try {
    const settings = getSettings();
    const proposals = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id) as vote_count,
        (SELECT COALESCE(SUM(vote_weight), 0) FROM votes WHERE proposal_id = p.id AND choice = 'yes') as weighted_yes,
        (SELECT COALESCE(SUM(vote_weight), 0) FROM votes WHERE proposal_id = p.id AND choice = 'no') as weighted_no
      FROM proposals p
      WHERE p.status = 'active'
      ORDER BY p.created_at DESC
    `).all();

    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    let userVotesMap = {};

    // Try auth token first, fallback to IP
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) {
          const userVotes = db.prepare('SELECT proposal_id, choice FROM votes WHERE user_id = ?').all(user.id);
          userVotes.forEach(v => userVotesMap[v.proposal_id] = v.choice);
        }
      } catch (e) {}
    }

    // Fallback to IP if no auth-based votes found
    if (Object.keys(userVotesMap).length === 0) {
      const userVotes = db.prepare('SELECT proposal_id, choice FROM votes WHERE voter_ip = ?').all(userIP);
      userVotes.forEach(v => userVotesMap[v.proposal_id] = v.choice);
    }

    proposals.forEach(p => {
      p.userVote = userVotesMap[p.id] || null;
      p.approval_threshold = merit.calculateApprovalThreshold(p.category);
      p.passing_threshold_display = `${Math.round(p.approval_threshold * 100)}% ${p.category === 'constitutional' ? 'constitutional' : p.category === 'policy' ? 'policy shift' : 'routine'} majority required`;
      p.is_weighted = true;
      p.window_info = {
        primary_days: settings.voting_window_primary_days || 7,
        extended_days: settings.voting_window_extended_days || 3,
        primary_weight: settings.voting_weight_primary || 1.0,
        extended_weight: settings.voting_weight_extended || 0.5
      };
    });

    res.json({ proposals, success: true });
  } catch (error) {
    console.error('Proposals fetch error:', error);
    res.status(500).json({ error: 'Could not fetch proposals', success: false });
  }
});

// POST /api/proposals - Create a new proposal (8-hour cooldown enforced)
router.post('/api/proposals', (req, res) => {
  const { title, description, category, nickname } = req.body;

  let userId = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
      if (user) userId = user.id;
    } catch (e) {}
  }

  if (userId) {
    const settings = getSettings();
    const cooldownHours = settings.proposal_cooldown_hours || 8;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const lastProposal = db.prepare(`
      SELECT created_at FROM proposals WHERE created_by_user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(userId);
    if (lastProposal) {
      const hoursSince = (Date.now() - new Date(lastProposal.created_at).getTime()) / (1000 * 60 * 60);
      if (hoursSince < cooldownHours) {
        return res.status(429).json({
          error: `Proposal cooldown active. Wait ${(cooldownHours - hoursSince).toFixed(1)} more hours.`,
          success: false,
          next_proposal_at: new Date(lastProposal.created_at.getTime() + cooldownMs).toISOString()
        });
      }
    }
  } else {
    const settings = getSettings();
    const cooldownHours = settings.proposal_cooldown_hours || 8;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    const lastAnonProposal = db.prepare(`
      SELECT timestamp FROM activity_log 
      WHERE action_type = 'proposal_created' AND ip_address = ? AND user_id IS NULL
      ORDER BY timestamp DESC LIMIT 1
    `).get(userIP);
    if (lastAnonProposal) {
      const hoursSince = (Date.now() - new Date(lastAnonProposal.timestamp).getTime()) / (1000 * 60 * 60);
      if (hoursSince < cooldownHours) {
        return res.status(429).json({
          error: `Proposal cooldown active. Wait ${(cooldownHours - hoursSince).toFixed(1)} more hours.`,
          success: false,
          next_proposal_at: new Date(new Date(lastAnonProposal.timestamp).getTime() + cooldownMs).toISOString()
        });
      }
    }
  }

  if (!title || title.trim().length < 5) {
    return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
  }

  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description must be at least 20 characters', success: false });
  }

  try {
    const settings = getSettings();
    const createdAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + settings.proposal_voting_days * 24 * 60 * 60 * 1000).toISOString();

    const stmt = db.prepare(`
      INSERT INTO proposals (title, description, category, created_by_nickname, created_at, ends_at, created_by_user_id, approval_threshold)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      sanitizeHTML(title.trim().substring(0, settings.proposal_title_max_length)),
      sanitizeHTML(description.trim()),
      category || 'general',
      sanitizeHTML(nickname ? nickname.trim().substring(0, settings.nickname_max_length) : 'Anonymous'),
      createdAt,
      endsAt,
      userId,
      merit.calculateApprovalThreshold(category || 'general')
    );

    if (userId) {
      logActivity('proposal_created', userId, result.lastInsertRowid, { title: title.trim().substring(0, 100) }, req);
      // Award merit for creating a proposal
      const createdMerit = settings.merit_proposal_created || 10;
      db.prepare(`
        INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
        VALUES (?, 'proposal_created', ?, ?, 'proposal', 'Created a new proposal', ?)
      `).run(userId, createdMerit, result.lastInsertRowid, createdAt);
      db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
        .run(createdMerit, userId);
      maybeEngageReferral(userId);
    } else {
      logActivity('proposal_created', null, result.lastInsertRowid, { title: title.trim().substring(0, 100) }, req);
    }
    res.status(201).json({
      message: 'Proposal created! Members can now vote.',
      success: true,
      id: result.lastInsertRowid
    });
  } catch (error) {
    console.error('Proposal create error:', error);
    res.status(500).json({ error: 'Could not create proposal', success: false });
  }
});

// POST /api/vote - Vote on a proposal (merit-weighted, whitepaper §II.D)
router.post('/api/vote', (req, res) => {
  const { proposal_id, choice } = req.body;

  if (!proposal_id) {
    return res.status(400).json({ error: 'Proposal ID required', success: false });
  }

  if (!['yes', 'no', 'abstain'].includes(choice)) {
    return res.status(400).json({ error: 'Invalid choice', success: false });
  }

  try {
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    const votedAt = new Date().toISOString();

    let userId = null;
    let userJoinDate = null;
    let userMeritScore = 0;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const user = db.prepare('SELECT id, timestamp FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) {
          userId = user.id;
          userJoinDate = user.timestamp;
          userMeritScore = merit.calculateStaticScore(userId);
        }
      } catch (e) {}
    }

    const proposal = db.prepare('SELECT id, created_at FROM proposals WHERE id = ?').get(proposal_id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found', success: false });
    }

    const voteWeight = userJoinDate ? merit.calculateVoteWeight(userJoinDate, proposal.created_at) : 1.0;
    const lc = userJoinDate ? merit.getLoyaltyCoefficient(userJoinDate) : 1.0;
    const daysSinceCreated = userJoinDate ? Math.floor((new Date() - new Date(proposal.created_at)) / (1000 * 60 * 60 * 24)) : 0;

    const existingVote = db.prepare('SELECT id, user_id FROM votes WHERE proposal_id = ? AND voter_ip = ?').get(proposal_id, userIP);
    if (existingVote) {
      db.prepare('UPDATE votes SET choice = ?, voted_at = ?, user_id = ?, vote_weight = ?, loyalty_coefficient = ?, days_since_created = ? WHERE id = ?')
        .run(choice, votedAt, userId || existingVote.user_id, voteWeight, lc, daysSinceCreated, existingVote.id);
    } else {
      db.prepare('INSERT INTO votes (proposal_id, choice, voter_ip, voted_at, user_id, vote_weight, loyalty_coefficient, days_since_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(proposal_id, choice, userIP, votedAt, userId, voteWeight, lc, daysSinceCreated);
    }

    const weightedCounts = db.prepare(`
      SELECT choice, SUM(vote_weight) as weighted_cnt, COUNT(*) as raw_cnt
      FROM votes WHERE proposal_id = ? GROUP BY choice
    `).all(proposal_id);

    let weighted_yes = 0, weighted_no = 0, weighted_abstain = 0, raw_total = 0;
    weightedCounts.forEach(c => {
      if (c.choice === 'yes') weighted_yes = c.weighted_cnt || 0;
      if (c.choice === 'no') weighted_no = c.weighted_cnt || 0;
      if (c.choice === 'abstain') weighted_abstain = c.weighted_cnt || 0;
      raw_total += c.raw_cnt || 0;
    });

    db.prepare('UPDATE proposals SET yes_votes = ?, no_votes = ?, abstain_votes = ? WHERE id = ?')
      .run(weighted_yes, weighted_no, weighted_abstain, proposal_id);

    res.json({
      message: 'Vote recorded!',
      success: true,
      vote_weight: voteWeight,
      loyalty_coefficient: lc,
      weighted_tally: { yes: weighted_yes, no: weighted_no, abstain: weighted_abstain },
      raw_voters: raw_total
    });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
  }
});

// PATCH /api/proposals/:id - Edit a proposal
router.patch('/api/proposals/:id', (req, res) => {
  const { id } = req.params;
  const { title, description } = req.body;
  
  try {
    const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found', success: false });
    }
    
    const updates = [];
    const params = [];
    
    if (title !== undefined) {
      const trimmedTitle = sanitizeHTML(String(title).trim());
      if (trimmedTitle.length < 5) {
        return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
      }
      updates.push('title = ?');
      params.push(trimmedTitle);
    }
    
    if (description !== undefined) {
      const trimmedDesc = sanitizeHTML(String(description).trim());
      if (trimmedDesc.length < 20) {
        return res.status(400).json({ error: 'Description must be at least 20 characters', success: false });
      }
      updates.push('description = ?');
      params.push(trimmedDesc);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update', success: false });
    }
    
    params.push(id);
    db.prepare(`UPDATE proposals SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    
    res.json({ message: 'Proposal updated!', success: true });
  } catch (error) {
    console.error('Proposal update error:', error);
    res.status(500).json({ error: 'Could not update proposal', success: false });
  }
});

// GET /api/proposal-stats - Get proposal engagement stats
router.get('/api/proposal-stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as total FROM proposals WHERE status = ?').get('active');
    const totalVotes = db.prepare('SELECT COUNT(*) as total FROM votes').get();
    const openProposals = db.prepare(`
      SELECT COUNT(*) as total FROM proposals 
      WHERE status = 'active' AND datetime(ends_at) > datetime('now')
    `).get();
    
    res.json({ 
      totalProposals: total.total,
      totalVotes: totalVotes.total,
      openProposals: openProposals.total,
      success: true 
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats', success: false });
  }
});

// POST /api/proposals/:id/stake - Stake on a proposal (requires userAuth)
router.post('/api/proposals/:id/stake', userAuth, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found', success: false });
    }
    if (proposal.is_closed) {
      return res.status(400).json({ error: 'Proposal already closed', success: false });
    }
    if (proposal.created_by_user_id !== userId) {
      return res.status(403).json({ error: 'Only the author can stake a proposal', success: false });
    }

    const existing = db.prepare('SELECT id FROM proposal_stakes WHERE proposal_id = ? AND user_id = ?').get(id, userId);
    if (existing) {
      return res.status(409).json({ error: 'Already staked this proposal', success: false });
    }

    const stakeAmount = merit.calculateStakeAmount(userId);
    const now = new Date().toISOString();

    db.prepare('INSERT INTO proposal_stakes (proposal_id, user_id, stake_amount, created_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, stakeAmount, now);

    db.prepare(`
      INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
      VALUES (?, 'stake_locked', ?, ?, 'proposal', ?, ?)
    `).run(userId, -stakeAmount, id, `Proposal stake locked: ${stakeAmount} pts`, now);

    res.json({ success: true, message: `Staked ${stakeAmount} points on this proposal` });
  } catch (error) {
    console.error('Stake proposal error:', error);
    res.status(500).json({ error: 'Could not stake proposal', success: false });
  }
});

// GET /api/proposals/:id/stake - Get stakes for proposal
router.get('/api/proposals/:id/stake', (req, res) => {
  const { id } = req.params;

  try {
    const stakes = db.prepare(`
      SELECT ps.*, s.name, s.username
      FROM proposal_stakes ps
      JOIN signups s ON ps.user_id = s.id
      WHERE ps.proposal_id = ?
    `).all(id);

    const totalStaked = stakes.reduce((sum, s) => sum + s.stake_amount, 0);

    res.json({ success: true, stakes, total_staked: totalStaked });
  } catch (error) {
    console.error('Get stakes error:', error);
    res.status(500).json({ error: 'Could not fetch stakes', success: false });
  }
});

return router;
};
