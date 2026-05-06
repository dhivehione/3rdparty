const express = require('express');
const crypto = require('crypto');
const router = express.Router();

module.exports = function({ db, lawsDb, getSettings, logActivity, userAuth, merit }) {

  // GET /api/user/profile - Get user profile
  router.get('/api/user/profile', userAuth, (req, res) => {
    const user = req.user;
    
    // Get clause-level votes
    let clauseVotes = [];
    if (lawsDb) {
      try {
        clauseVotes = lawsDb.prepare(`
          SELECT sv.*, sa.sub_article_label as clause_label, a.article_number, a.article_title, l.law_name
          FROM sub_article_votes sv
          JOIN sub_articles sa ON sv.sub_article_id = sa.id
          JOIN articles a ON sa.article_id = a.id
          JOIN laws l ON a.law_id = l.id
          WHERE sv.user_phone = ?
          ORDER BY sv.voted_at DESC
          LIMIT 50
        `).all(user.phone);
      } catch (e) {}
    }
    
    // Get article-level votes
    let articleVotes = [];
    try {
      articleVotes = db.prepare(`
        SELECT lv.*, a.article_number, a.article_title, l.law_name
        FROM law_votes lv
        JOIN articles a ON lv.article_id = a.id
        JOIN laws l ON a.law_id = l.id
        WHERE lv.user_phone = ?
        ORDER BY lv.voted_at DESC
        LIMIT 50
      `).all(user.phone);
    } catch (e) {}
    
    // Get law-level votes
    let lawVotes = [];
    if (lawsDb) {
      try {
        lawVotes = lawsDb.prepare(`
          SELECT llv.*, l.law_name, l.category_name
          FROM law_level_votes llv
          JOIN laws l ON llv.law_id = l.id
          WHERE llv.user_phone = ?
          ORDER BY llv.voted_at DESC
          LIMIT 50
        `).all(user.phone);
      } catch (e) {}
    }
    
    const activeThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const hasRecentActivity = db.prepare(`
      SELECT COUNT(*) as cnt FROM merit_events WHERE user_id = ? AND created_at > ?
    `).get(user.id, activeThreshold).cnt > 0;

    res.json({
      success: true,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        username: user.username,
        nid: user.nid,
        email: user.email,
        island: user.island,
        contribution_type: user.contribution_type ? (() => {
          try { return JSON.parse(user.contribution_type); }
          catch(e) { return [user.contribution_type]; }
        })() : [],
        donation_amount: user.donation_amount,
        initial_merit_estimate: user.initial_merit_estimate,
        dynamic_score: (() => { try { return merit.calculateDecayedScore(user.id, user.timestamp); } catch(e) { return user.initial_merit_estimate; } })(),
        static_score: (() => { try { return merit.calculateStaticScore(user.id); } catch(e) { return user.initial_merit_estimate; } })(),
        loyalty_coefficient: (() => { try { return merit.getLoyaltyCoefficient(user.timestamp); } catch(e) { return 1.0; } })(),
        is_active: hasRecentActivity,
        timestamp: user.timestamp,
        last_login: user.last_login,
        password_hash: !!user.password_hash
      },
      votes: {
        clauses: clauseVotes,
        articles: articleVotes,
        laws: lawVotes
      },
      stats: {
        clauseVotesCount: clauseVotes.length,
        articleVotesCount: articleVotes.length,
        lawVotesCount: lawVotes.length
      }
    });
  });

  // PUT /api/user/profile - Update user profile
  router.put('/api/user/profile', userAuth, (req, res) => {
    const user = req.user;
    const { username, name, email, island } = req.body;
    
    try {
      if (username !== undefined) {
        const trimmedUsername = username.trim();
        if (trimmedUsername === '') {
          return res.status(400).json({ error: 'Username cannot be empty', success: false });
        }
        
        const existing = db.prepare('SELECT id FROM signups WHERE username = ? AND id != ?').get(trimmedUsername, user.id);
        if (existing) {
          return res.status(409).json({ error: 'Username already taken', success: false });
        }
        
        db.prepare('UPDATE signups SET username = ? WHERE id = ?').run(trimmedUsername, user.id);
      }
      
      if (name !== undefined) {
        db.prepare('UPDATE signups SET name = ? WHERE id = ?').run(name.trim() || null, user.id);
      }
      if (email !== undefined) {
        db.prepare('UPDATE signups SET email = ? WHERE id = ?').run(email.trim() || null, user.id);
      }
      if (island !== undefined) {
        db.prepare('UPDATE signups SET island = ? WHERE id = ?').run(island.trim() || null, user.id);
      }
      
      const updatedUser = db.prepare('SELECT * FROM signups WHERE id = ?').get(user.id);
      logActivity('profile_update', user.id, null, { fields: Object.keys(req.body).filter(k => req.body[k] !== undefined) }, req);
      
      res.json({ 
        success: true, 
        user: {
          id: updatedUser.id,
          phone: updatedUser.phone,
          name: updatedUser.name,
          username: updatedUser.username,
          nid: updatedUser.nid,
          email: updatedUser.email,
          island: updatedUser.island,
          contribution_type: updatedUser.contribution_type ? (() => {
            try { return JSON.parse(updatedUser.contribution_type); }
            catch(e) { return [updatedUser.contribution_type]; }
          })() : [],
          donation_amount: updatedUser.donation_amount,
          initial_merit_estimate: updatedUser.initial_merit_estimate,
          timestamp: updatedUser.timestamp
        }
      });
    } catch (error) {
      console.error('Update profile error:', error);
      res.status(500).json({ error: 'Could not update profile', success: false });
    }
  });

  // POST /api/user/change-password
  router.post('/api/user/change-password', userAuth, (req, res) => {
    const user = req.user;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current password and new password required', success: false });
    }

    if (new_password.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters', success: false });
    }

    const currentHash = crypto.createHash('sha256').update(current_password).digest('hex');

    if (user.password_hash) {
      if (user.password_hash !== currentHash) {
        return res.status(401).json({ error: 'Current password is incorrect', success: false });
      }
    } else {
      const cleanedPhone = user.phone ? user.phone.replace(/\D/g, '') : '';
      if (current_password.replace(/\D/g, '') !== cleanedPhone) {
        return res.status(401).json({ error: 'Current password is incorrect', success: false });
      }
    }

    try {
      const newHash = crypto.createHash('sha256').update(new_password).digest('hex');
      db.prepare('UPDATE signups SET password_hash = ? WHERE id = ?').run(newHash, user.id);
      logActivity('password_change', user.id, null, null, req);
      res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({ error: 'Could not update password', success: false });
    }
  });

  // GET /api/user/activity-log
  router.get('/api/user/activity-log', userAuth, (req, res) => {
    const user = req.user;
    try {
      const logs = db.prepare(`
        SELECT * FROM activity_log 
        WHERE user_id = ? 
        ORDER BY timestamp DESC 
        LIMIT 50
      `).all(user.id);

      res.json({ success: true, logs });
    } catch (error) {
      console.error('Activity log error:', error);
      res.status(500).json({ error: 'Could not fetch activity log', success: false });
    }
  });

  // GET /api/user/proposals
  router.get('/api/user/proposals', userAuth, (req, res) => {
    const user = req.user;
    try {
      const proposals = db.prepare(`
        SELECT id, title, description, category, status, 
               yes_votes, no_votes, abstain_votes, created_at, ends_at
        FROM proposals 
        WHERE created_by_user_id = ? 
        ORDER BY created_at DESC
        LIMIT 50
      `).all(user.id);

      const rankedProposals = db.prepare(`
        SELECT id, title, description, category, status, created_at, ends_at
        FROM ranked_proposals 
        WHERE created_by_user_id = ? 
        ORDER BY created_at DESC
        LIMIT 50
      `).all(user.id);

      res.json({ success: true, proposals, ranked_proposals: rankedProposals });
    } catch (error) {
      console.error('User proposals error:', error);
      res.status(500).json({ error: 'Could not fetch proposals', success: false });
    }
  });

  // ==================== PUBLIC MEMBER DIRECTORY ====================

  // GET /api/members - List verified members (public)
  router.get('/api/members', (req, res) => {
    try {
      const search = (req.query.search || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));
      const offset = Math.max(0, parseInt(req.query.offset) || 0);

      let members;
      let count;

      if (search) {
        const pattern = `%${search}%`;
        members = db.prepare(`
          SELECT s.id, s.name, s.username, s.island, s.initial_merit_estimate, s.timestamp,
                 la.id as application_id, la.status as application_status, lp.title as position_title
          FROM signups s
          LEFT JOIN leadership_applications la ON s.id = la.user_id AND la.status IN ('pending', 'interview')
          LEFT JOIN leadership_positions lp ON la.position_id = lp.id
          WHERE s.is_verified = 1 AND s.unregistered_at IS NULL
            AND (LOWER(s.name) LIKE ? OR LOWER(s.username) LIKE ? OR LOWER(s.island) LIKE ?)
          ORDER BY s.name ASC
          LIMIT ? OFFSET ?
        `).all(pattern, pattern, pattern, limit, offset);
        count = db.prepare(`
          SELECT COUNT(*) as total FROM signups
          WHERE is_verified = 1 AND unregistered_at IS NULL
            AND (LOWER(name) LIKE ? OR LOWER(username) LIKE ? OR LOWER(island) LIKE ?)
        `).get(pattern, pattern, pattern);
      } else {
        members = db.prepare(`
          SELECT s.id, s.name, s.username, s.island, s.initial_merit_estimate, s.timestamp,
                 la.id as application_id, la.status as application_status, lp.title as position_title
          FROM signups s
          LEFT JOIN leadership_applications la ON s.id = la.user_id AND la.status IN ('pending', 'interview')
          LEFT JOIN leadership_positions lp ON la.position_id = lp.id
          WHERE s.is_verified = 1 AND s.unregistered_at IS NULL
          ORDER BY s.name ASC
          LIMIT ? OFFSET ?
        `).all(limit, offset);
        count = db.prepare(`
          SELECT COUNT(*) as total FROM signups
          WHERE is_verified = 1 AND unregistered_at IS NULL
        `).get();
      }

      // Get endorsement counts for each member
      const endorsementCounts = db.prepare(`
        SELECT endorsed_id, COUNT(*) as cnt FROM peer_endorsements
        GROUP BY endorsed_id
      `).all();
      const countMap = new Map(endorsementCounts.map(e => [e.endorsed_id, e.cnt]));

      const enriched = members.map(m => ({
        ...m,
        endorsement_count: countMap.get(m.id) || 0,
        dynamic_score: (() => { try { return merit.calculateDecayedScore(m.id, m.timestamp); } catch(e) { return m.initial_merit_estimate; } })()
      }));

      res.json({ success: true, members: enriched, total: count.total });
    } catch (error) {
      console.error('Members list error:', error);
      res.status(500).json({ error: 'Could not fetch members', success: false });
    }
  });

  // GET /api/members/:id - Public profile for a specific member
  router.get('/api/members/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const member = db.prepare(`
        SELECT s.id, s.name, s.username, s.island, s.initial_merit_estimate, s.timestamp,
               la.id as application_id, la.status as application_status, lp.title as position_title
        FROM signups s
        LEFT JOIN leadership_applications la ON s.id = la.user_id AND la.status IN ('pending', 'interview')
        LEFT JOIN leadership_positions lp ON la.position_id = lp.id
        WHERE s.id = ? AND s.is_verified = 1 AND s.unregistered_at IS NULL
      `).get(id);

      if (!member) {
        return res.status(404).json({ error: 'Member not found', success: false });
      }

      const endorsementCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM peer_endorsements WHERE endorsed_id = ?
      `).get(id);

      res.json({
        success: true,
        member: {
          ...member,
          endorsement_count: endorsementCount.cnt,
          dynamic_score: (() => { try { return merit.calculateDecayedScore(member.id, member.timestamp); } catch(e) { return member.initial_merit_estimate; } })()
        }
      });
    } catch (error) {
      console.error('Member profile error:', error);
      res.status(500).json({ error: 'Could not fetch member', success: false });
    }
  });

  return router;
};
