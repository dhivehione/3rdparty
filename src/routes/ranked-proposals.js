const express = require('express');
const router = express.Router();

module.exports = function({ db, getSettings, logActivity, merit, maybeEngageReferral, sanitizeHTML }) {
  // GET /api/ranked-proposals - Get all ranked choice proposals
  router.get('/api/ranked-proposals', (req, res) => {
    try {
      const proposals = db.prepare(`
        SELECT * FROM ranked_proposals
        WHERE status = 'active'
        ORDER BY created_at DESC
      `).all();

      const userIP = req.ip || req.connection.remoteAddress || 'unknown';
      let userId = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.replace(/^Bearer\s+/i, '');
          const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
          if (user) userId = user.id;
        } catch (e) {}
      }

      // Parse options and get user votes
      proposals.forEach(p => {
        p.options = JSON.parse(p.options);
        let userVote = null;
        if (userId) {
          userVote = db.prepare('SELECT ranking FROM ranked_votes WHERE proposal_id = ? AND user_id = ?').get(p.id, userId);
        }
        if (!userVote) {
          userVote = db.prepare('SELECT ranking FROM ranked_votes WHERE proposal_id = ? AND voter_ip = ?').get(p.id, userIP);
        }
        p.userRanking = userVote ? JSON.parse(userVote.ranking) : null;

        // Calculate instant runoff winner
        p.results = calculateRankedResults(p.id, p.options);
      });

      res.json({ proposals, success: true });
    } catch (error) {
      console.error('Ranked proposals error:', error);
      res.status(500).json({ error: 'Could not fetch proposals', success: false });
    }
  });

  // Helper: Calculate ranked choice winner
  function calculateRankedResults(proposalId, options) {
    const votes = db.prepare('SELECT ranking FROM ranked_votes WHERE proposal_id = ?').all(proposalId);
    
    if (votes.length === 0) return { winner: null, rounds: [], totalVotes: 0 };
    
    const rounds = [];
    let remaining = [...options];
    let voteData = votes.map(v => JSON.parse(v.ranking));
    
    while (remaining.length > 1) {
      // Count first-choice votes
      const counts = {};
      remaining.forEach(opt => counts[opt] = 0);
      voteData.forEach(ranking => {
        const firstChoice = ranking.find(r => remaining.includes(r));
        if (firstChoice) counts[firstChoice]++;
      });
      
      const roundResult = { ...counts };
      rounds.push(roundResult);
      
      // Check for majority
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const leader = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      
      if (leader[1] > total / 2) {
        return { winner: leader[0], rounds, totalVotes: votes.length };
      }
      
      // Eliminate lowest
      const loser = Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
      remaining = remaining.filter(r => r !== loser);
    }
    
    return { winner: remaining[0], rounds, totalVotes: votes.length };
  }

  // POST /api/ranked-proposals - Create ranked choice proposal
  router.post('/api/ranked-proposals', (req, res) => {
    const { title, description, category, options, nickname } = req.body;
    
    // Check if user is authenticated (for tracking who created it)
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) userId = user.id;
      } catch (e) {}
    }
    
    if (!title || title.trim().length < 5) {
      return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
    }
    
    if (!options || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ error: 'At least 2 options required', success: false });
    }
    
    try {
      const settings = getSettings();
      const createdAt = new Date().toISOString();
      const endsAt = new Date(Date.now() + settings.proposal_voting_days * 24 * 60 * 60 * 1000).toISOString();
      
      const stmt = db.prepare(`
        INSERT INTO ranked_proposals (title, description, category, options, created_by_nickname, created_at, ends_at, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        sanitizeHTML(title.trim().substring(0, settings.proposal_title_max_length)),
        sanitizeHTML(description.trim()),
        category || 'election',
        JSON.stringify(options.map(o => sanitizeHTML(o.trim())).filter(o => o)),
        sanitizeHTML(nickname ? nickname.trim().substring(0, settings.nickname_max_length) : 'Anonymous'),
        createdAt,
        endsAt,
        userId
      );

      if (userId) {
        logActivity('proposal_created', userId, result.lastInsertRowid, { title: title.trim().substring(0, 100) }, req);
        const createdMerit = settings.merit_proposal_created || 10;
        db.prepare(`
          INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
          VALUES (?, 'proposal_created', ?, ?, 'ranked_proposal', 'Created a ranked choice proposal', ?)
        `).run(userId, createdMerit, result.lastInsertRowid, createdAt);
        db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
          .run(createdMerit, userId);
        maybeEngageReferral(userId);
      }

      res.status(201).json({ message: 'Ranked choice proposal created!', success: true, id: result.lastInsertRowid });
    } catch (error) {
      console.error('Ranked proposal error:', error);
      res.status(500).json({ error: 'Could not create proposal', success: false });
    }
  });

  // POST /api/ranked-vote - Vote on ranked choice proposal
  router.post('/api/ranked-vote', (req, res) => {
    const { proposal_id, ranking } = req.body;

    if (!proposal_id) return res.status(400).json({ error: 'Proposal ID required', success: false });
    if (!ranking || !Array.isArray(ranking) || ranking.length < 2) {
      return res.status(400).json({ error: 'Must rank at least 2 options', success: false });
    }

    try {
      const userIP = req.ip || req.connection.remoteAddress || 'unknown';
      const votedAt = new Date().toISOString();

      let userId = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.replace(/^Bearer\s+/i, '');
          const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
          if (user) userId = user.id;
        } catch (e) {}
      }

      // Check if already voted (by user_id or IP)
      let existing;
      if (userId) {
        existing = db.prepare('SELECT id FROM ranked_votes WHERE proposal_id = ? AND user_id = ?').get(proposal_id, userId);
      }
      if (!existing) {
        existing = db.prepare('SELECT id FROM ranked_votes WHERE proposal_id = ? AND voter_ip = ?').get(proposal_id, userIP);
      }
      if (existing) {
        db.prepare('UPDATE ranked_votes SET ranking = ?, voted_at = ?, user_id = COALESCE(user_id, ?) WHERE id = ?')
          .run(JSON.stringify(ranking), votedAt, userId, existing.id);
      } else {
        db.prepare('INSERT INTO ranked_votes (proposal_id, ranking, voter_ip, voted_at, user_id) VALUES (?, ?, ?, ?, ?)')
          .run(proposal_id, JSON.stringify(ranking), userIP, votedAt, userId);
      }

      res.json({ message: 'Vote recorded!', success: true });
    } catch (error) {
      console.error('Ranked vote error:', error);
      res.status(500).json({ error: 'Could not record vote', success: false });
    }
  });

  return router;
};
