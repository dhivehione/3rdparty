const express = require('express');
const crypto = require('crypto');
const router = express.Router();

module.exports = function({ db, getSettings, logActivity, adminAuth, userAuth, merit }) {

  // ==================== MEDIA COLLECTIVE & CONTENT REWARDS (Whitepaper sec V.E) ====================
  // Knowledge Check Bounty: Points for passing quizzes on articles
  db.exec(`
    CREATE TABLE IF NOT EXISTS article_quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id TEXT NOT NULL,
      article_title TEXT,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      correct_answer INTEGER NOT NULL,
      points_reward INTEGER DEFAULT 10,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      quiz_id INTEGER NOT NULL,
      selected_answer INTEGER NOT NULL,
      correct INTEGER NOT NULL,
      attempted_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES signups(id),
      FOREIGN KEY (quiz_id) REFERENCES article_quizzes(id)
    )
  `);

  // Informed Comment Reward: Community-endorsed comments
  db.exec(`
    CREATE TABLE IF NOT EXISTS article_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      article_id TEXT NOT NULL,
      comment_text TEXT NOT NULL,
      is_approved INTEGER DEFAULT 1,
      endorsement_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES signups(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_endorsements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      endorser_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(comment_id, endorser_id),
      FOREIGN KEY (comment_id) REFERENCES article_comments(id),
      FOREIGN KEY (endorser_id) REFERENCES signups(id)
    )
  `);

  // Amplification Bounty: Trackable links for sharing official content
  db.exec(`
    CREATE TABLE IF NOT EXISTS amplification_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_user_id INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      content_title TEXT,
      track_code TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL,
      click_count INTEGER DEFAULT 0,
      reward_points INTEGER DEFAULT 10,
      is_active INTEGER DEFAULT 1,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (creator_user_id) REFERENCES signups(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS amplification_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL,
      clicker_ip TEXT,
      clicked_at TEXT NOT NULL,
      FOREIGN KEY (link_id) REFERENCES amplification_links(id)
    )
  `);

  // ==================== VIOLATION PENALTIES (Whitepaper sec IX) ====================
  // Tier 1: Minor (spam, low-effort), Tier 2: Serious (disinfo, harassment), Tier 3: Severe (hate speech, threats)
  db.exec(`
    CREATE TABLE IF NOT EXISTS violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_user_id INTEGER,
      accused_user_id INTEGER NOT NULL,
      violation_type TEXT NOT NULL,
      tier INTEGER NOT NULL CHECK(tier IN (1, 2, 3)),
      description TEXT NOT NULL,
      evidence TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'investigating', 'resolved', 'dismissed')),
      resolution TEXT,
      resolved_by_user_id INTEGER,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (reporter_user_id) REFERENCES signups(id),
      FOREIGN KEY (accused_user_id) REFERENCES signups(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_suspensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      violation_id INTEGER,
      suspension_type TEXT NOT NULL CHECK(suspension_type IN ('warning', 'temporary', 'permanent')),
      reason TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES signups(id),
      FOREIGN KEY (violation_id) REFERENCES violations(id)
    )
  `);

  const VIOLATION_PENALTIES = {
    1: { point_penalty: 50, action: 'warning' },
    2: { point_penalty: 200, action: 'temporary' },
    3: { point_penalty: 500, action: 'permanent' }
  };

  // ==================== ACTIVITY LOG (ADMIN) ====================
  // GET /api/activity-log - Get activity log (admin only)
  router.get('/api/activity-log', adminAuth, (req, res) => {
    const { action_type, user_id, limit = 100, offset = 0 } = req.query;

    try {
      let query = 'SELECT * FROM activity_log WHERE 1=1';
      const params = [];

      if (action_type) {
        query += ' AND action_type = ?';
        params.push(action_type);
      }

      if (user_id) {
        query += ' AND user_id = ?';
        params.push(parseInt(user_id));
      }

      query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      const logs = db.prepare(query).all(...params);
      const total = db.prepare('SELECT COUNT(*) as count FROM activity_log').get();

      res.json({
        success: true,
        logs: logs.map(l => ({
          id: l.id,
          action_type: l.action_type,
          user_id: l.user_id,
          target_id: l.target_id,
          details: l.details ? JSON.parse(l.details) : null,
          ip_address: l.ip_address,
          timestamp: l.timestamp
        })),
        total: total.count
      });
    } catch (error) {
      console.error('Activity log error:', error);
      res.status(500).json({ error: 'Failed to get activity log', success: false });
    }
  });

  // ==================== ENDORSEMENTS ====================
  router.post('/api/endorsements', userAuth, (req, res) => {
    const { endorsed_id } = req.body;
    const endorserId = req.user.id;

    if (!endorsed_id) {
      return res.status(400).json({ error: 'endorsed_id required', success: false });
    }

    if (parseInt(endorsed_id) === endorserId) {
      return res.status(400).json({ error: 'Cannot endorse yourself', success: false });
    }

    try {
      const target = db.prepare('SELECT id FROM signups WHERE id = ? AND is_verified = 1').get(endorsed_id);
      if (!target) {
        return res.status(404).json({ error: 'User not found', success: false });
      }

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recentEndorsements = db.prepare(`
        SELECT COUNT(*) as cnt FROM peer_endorsements
        WHERE endorser_id = ? AND created_at > ?
      `).get(endorserId, thirtyDaysAgo);

      if (recentEndorsements.cnt >= 20) {
        return res.status(429).json({ error: 'Max 20 endorsements per 30-day period', success: false });
      }

      const existing = db.prepare('SELECT id FROM peer_endorsements WHERE endorser_id = ? AND endorsed_id = ?').get(endorserId, endorsed_id);
      if (existing) {
        return res.status(409).json({ error: 'Already endorsed this user', success: false });
      }

      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO peer_endorsements (endorser_id, endorsed_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(endorserId, endorsed_id, now, expiresAt);

      const endorsements = db.prepare('SELECT * FROM peer_endorsements WHERE endorsed_id = ?').all(endorsed_id);
      const points = merit.calculateEndorsementPoints(endorsements.length);

      db.prepare(`
        INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
        VALUES (?, 'peer_endorsement', ?, ?, 'endorsement', ?, ?)
      `).run(endorsed_id, points, endorsements.length, 'peer_endorsement', `Peer endorsement #${endorsements.length}`, now);
      db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
        .run(points, endorsed_id);

      res.json({ success: true, message: 'Endorsement recorded' });
    } catch (error) {
      console.error('Endorsement error:', error);
      res.status(500).json({ error: 'Could not record endorsement', success: false });
    }
  });

  router.delete('/api/endorsements/:id', userAuth, (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
      const endorsement = db.prepare('SELECT * FROM peer_endorsements WHERE id = ? AND endorser_id = ?').get(id, userId);
      if (!endorsement) {
        return res.status(404).json({ error: 'Endorsement not found', success: false });
      }

      db.prepare('DELETE FROM peer_endorsements WHERE id = ?').run(id);

      const remaining = db.prepare('SELECT COUNT(*) as cnt FROM peer_endorsements WHERE endorsed_id = ?').get(endorsement.endorsed_id);
      const points = merit.calculateEndorsementPoints(remaining.cnt);

      db.prepare(`
        INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
        VALUES (?, 'peer_endorsement_removed', ?, ?, 'endorsement', ?, ?)
      `).run(endorsement.endorsed_id, points, endorsement.endorsed_id, 'peer_endorsement', `Peer endorsements updated: ${remaining.cnt} remaining`, new Date().toISOString());

      res.json({ success: true, message: 'Endorsement removed' });
    } catch (error) {
      console.error('Endorsement removal error:', error);
      res.status(500).json({ error: 'Could not remove endorsement', success: false });
    }
  });

  router.get('/api/endorsements/received', userAuth, (req, res) => {
    const userId = req.user.id;

    try {
      const endorsements = db.prepare(`
        SELECT pe.*, s.name as endorser_name, s.username as endorser_username
        FROM peer_endorsements pe
        JOIN signups s ON pe.endorser_id = s.id
        WHERE pe.endorsed_id = ?
        ORDER BY pe.created_at DESC
      `).all(userId);

      const totalPoints = merit.calculateEndorsementPoints(endorsements.length);

      res.json({ success: true, endorsements, total_endorsements: endorsements.length, total_points: totalPoints });
    } catch (error) {
      console.error('Get endorsements error:', error);
      res.status(500).json({ error: 'Could not fetch endorsements', success: false });
    }
  });

  router.get('/api/endorsements/given', userAuth, (req, res) => {
    const userId = req.user.id;

    try {
      const endorsements = db.prepare(`
        SELECT pe.*, s.name as endorsed_name, s.username as endorsed_username
        FROM peer_endorsements pe
        JOIN signups s ON pe.endorsed_id = s.id
        WHERE pe.endorser_id = ?
        ORDER BY pe.created_at DESC
      `).all(userId);

      res.json({ success: true, endorsements, total_given: endorsements.length });
    } catch (error) {
      console.error('Get endorsements error:', error);
      res.status(500).json({ error: 'Could not fetch endorsements', success: false });
    }
  });

  // ==================== MERIT ====================
  router.get('/api/merit/score', userAuth, (req, res) => {
    const userId = req.user.id;
    const user = db.prepare('SELECT timestamp FROM signups WHERE id = ?').get(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found', success: false });
    }

    const staticScore = merit.calculateStaticScore(userId);
    const dynamicScore = merit.calculateDecayedScore(userId, user.timestamp);
    const loyaltyCoeff = merit.getLoyaltyCoefficient(user.timestamp);
    const lcLabel = loyaltyCoeff >= 1.5 ? 'founding' : loyaltyCoeff >= 1.2 ? 'early_adopter' : 'standard';

    res.json({
      success: true,
      user_id: userId,
      static_score: staticScore,
      dynamic_score: dynamicScore,
      loyalty_coefficient: loyaltyCoeff,
      loyalty_tier: lcLabel,
      effective_half_life_days: Math.round(merit.HALF_LIFE_DAYS * loyaltyCoeff)
    });
  });

  router.get('/api/merit/events', userAuth, (req, res) => {
    const userId = req.user.id;
    const { limit = 50, offset = 0 } = req.query;

    try {
      const events = db.prepare(`
        SELECT * FROM merit_events WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(userId, parseInt(limit), parseInt(offset));

      const total = db.prepare('SELECT COUNT(*) as cnt FROM merit_events WHERE user_id = ?').get(userId);

      res.json({ success: true, events, total: total.cnt });
    } catch (error) {
      console.error('Get merit events error:', error);
      res.status(500).json({ error: 'Could not fetch merit events', success: false });
    }
  });

  router.get('/api/merit/leaderboard', (req, res) => {
    const { limit = 20 } = req.query;

    try {
      const users = db.prepare(`
        SELECT s.id, s.name, s.username,
               COALESCE(SUM(me.points), 0) as static_score
        FROM signups s
        LEFT JOIN merit_events me ON s.id = me.user_id
        WHERE s.is_verified = 1 AND s.unregistered_at IS NULL
        GROUP BY s.id
        ORDER BY static_score DESC
        LIMIT ?
      `).all(parseInt(limit));

      const leaderboard = users.map((u, i) => ({
        rank: i + 1,
        ...u,
        dynamic_score: merit.calculateDecayedScore(u.id, db.prepare('SELECT timestamp FROM signups WHERE id = ?').get(u.id).timestamp)
      }));

      res.json({ success: true, leaderboard });
    } catch (error) {
      console.error('Get leaderboard error:', error);
      res.status(500).json({ error: 'Could not fetch leaderboard', success: false });
    }
  });

  // ==================== KNOWLEDGE CHECK BOUNTY (Whitepaper sec V.E) ====================
  router.post('/api/quizzes', userAuth, (req, res) => {
    const { article_id, article_title, question, options, correct_answer, points_reward = 10 } = req.body;

    if (!article_id || !question || !options || correct_answer === undefined) {
      return res.status(400).json({ error: 'article_id, question, options, and correct_answer required', success: false });
    }

    try {
      const opts = Array.isArray(options) ? options : JSON.parse(options);
      if (opts.length < 2) {
        return res.status(400).json({ error: 'At least 2 options required', success: false });
      }

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO article_quizzes (article_id, article_title, question, options, correct_answer, points_reward, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(article_id, article_title || '', question, JSON.stringify(opts), correct_answer, points_reward, now);

      res.status(201).json({ success: true, message: 'Quiz created' });
    } catch (error) {
      console.error('Create quiz error:', error);
      res.status(500).json({ error: 'Could not create quiz', success: false });
    }
  });

  router.get('/api/quizzes/:articleId', (req, res) => {
    const { articleId } = req.params;

    try {
      const quizzes = db.prepare('SELECT * FROM article_quizzes WHERE article_id = ? AND is_active = 1').all(articleId);
      quizzes.forEach(q => q.options = JSON.parse(q.options));
      res.json({ success: true, quizzes });
    } catch (error) {
      console.error('Get quizzes error:', error);
      res.status(500).json({ error: 'Could not fetch quizzes', success: false });
    }
  });

  router.post('/api/quizzes/:id/answer', userAuth, (req, res) => {
    const { id } = req.params;
    const { answer } = req.body;
    const userId = req.user.id;

    if (answer === undefined) {
      return res.status(400).json({ error: 'answer required', success: false });
    }

    try {
      const quiz = db.prepare('SELECT * FROM article_quizzes WHERE id = ? AND is_active = 1').get(id);
      if (!quiz) {
        return res.status(404).json({ error: 'Quiz not found', success: false });
      }

      const alreadyAttempted = db.prepare('SELECT id FROM quiz_attempts WHERE user_id = ? AND quiz_id = ?').get(userId, id);
      if (alreadyAttempted) {
        return res.status(409).json({ error: 'Already attempted this quiz', success: false });
      }

      const correct = answer === quiz.correct_answer;
      const now = new Date().toISOString();

      db.prepare('INSERT INTO quiz_attempts (user_id, quiz_id, selected_answer, correct, attempted_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, id, answer, correct ? 1 : 0, now);

      if (correct) {
        db.prepare(`
          INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
          VALUES (?, 'knowledge_check', ?, ?, 'quiz', ?, ?)
        `).run(userId, quiz.points_reward, id, `Knowledge check passed: ${quiz.article_title || quiz.article_id}`, now);
        db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
          .run(quiz.points_reward, userId);
      }

      res.json({ success: true, correct, points_earned: correct ? quiz.points_reward : 0 });
    } catch (error) {
      console.error('Answer quiz error:', error);
      res.status(500).json({ error: 'Could not submit answer', success: false });
    }
  });

  // ==================== INFORMED COMMENT REWARD (Whitepaper sec V.E) ====================
  router.post('/api/comments', userAuth, (req, res) => {
    const { article_id, comment_text } = req.body;
    const userId = req.user.id;

    if (!article_id || !comment_text || comment_text.trim().length < 10) {
      return res.status(400).json({ error: 'article_id and comment_text (min 10 chars) required', success: false });
    }

    try {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO article_comments (user_id, article_id, comment_text, created_at) VALUES (?, ?, ?, ?)')
        .run(userId, article_id, comment_text.trim(), now);

      res.status(201).json({ success: true, message: 'Comment posted' });
    } catch (error) {
      console.error('Post comment error:', error);
      res.status(500).json({ error: 'Could not post comment', success: false });
    }
  });

  router.get('/api/comments/:articleId', (req, res) => {
    const { articleId } = req.params;

    try {
      const comments = db.prepare(`
        SELECT ac.*, s.name, s.username,
               (SELECT COUNT(*) FROM comment_endorsements WHERE comment_id = ac.id) as endorsements
        FROM article_comments ac
        JOIN signups s ON ac.user_id = s.id
        WHERE ac.article_id = ? AND ac.is_approved = 1
        ORDER BY endorsements DESC, ac.created_at DESC
      `).all(articleId);

      res.json({ success: true, comments });
    } catch (error) {
      console.error('Get comments error:', error);
      res.status(500).json({ error: 'Could not fetch comments', success: false });
    }
  });

  router.post('/api/comments/:id/endorse', userAuth, (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
      const comment = db.prepare('SELECT * FROM article_comments WHERE id = ?').get(id);
      if (!comment) {
        return res.status(404).json({ error: 'Comment not found', success: false });
      }
      if (comment.user_id === userId) {
        return res.status(400).json({ error: 'Cannot endorse your own comment', success: false });
      }

      const existing = db.prepare('SELECT id FROM comment_endorsements WHERE comment_id = ? AND endorser_id = ?').get(id, userId);
      if (existing) {
        return res.status(409).json({ error: 'Already endorsed', success: false });
      }

      const now = new Date().toISOString();
      db.prepare('INSERT INTO comment_endorsements (comment_id, endorser_id, created_at) VALUES (?, ?, ?)').run(id, userId, now);

      const endorsementCount = db.prepare('SELECT COUNT(*) as cnt FROM comment_endorsements WHERE comment_id = ?').get(id).cnt;
      db.prepare('UPDATE article_comments SET endorsement_count = ? WHERE id = ?').run(endorsementCount, id);

      if (endorsementCount >= 5) {
        const commentPoints = Math.min(endorsementCount * 2, 50);
        db.prepare(`
          INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
          VALUES (?, 'comment_endorsement', ?, ?, 'comment', ?, ?)
        `).run(comment.user_id, commentPoints, id, `Comment endorsed (${endorsementCount} endorsements)`, now);
        db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
          .run(commentPoints, comment.user_id);
      }

      res.json({ success: true, endorsements: endorsementCount });
    } catch (error) {
      console.error('Endorse comment error:', error);
      res.status(500).json({ error: 'Could not endorse comment', success: false });
    }
  });

  // ==================== VIOLATIONS & SUSPENSIONS ====================
  router.post('/api/violations/report', userAuth, (req, res) => {
    const { accused_user_id, violation_type, tier, description, evidence } = req.body;
    const reporterId = req.user.id;

    if (!accused_user_id || !violation_type || !tier || !description) {
      return res.status(400).json({ error: 'accused_user_id, violation_type, tier, and description required', success: false });
    }

    if (![1, 2, 3].includes(parseInt(tier))) {
      return res.status(400).json({ error: 'Tier must be 1, 2, or 3', success: false });
    }

    try {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO violations (reporter_user_id, accused_user_id, violation_type, tier, description, evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(reporterId, accused_user_id, violation_type, tier, description, evidence || '', now);

      logActivity('violation_reported', reporterId, accused_user_id, { type: violation_type, tier }, req);
      res.status(201).json({ success: true, message: 'Violation report submitted' });
    } catch (error) {
      console.error('Report violation error:', error);
      res.status(500).json({ error: 'Could not submit report', success: false });
    }
  });

  router.get('/api/violations', userAuth, (req, res) => {
    const { status, tier } = req.query;

    try {
      const isAdmin = req.user.is_admin;
      if (!isAdmin) {
        const myViolations = db.prepare('SELECT * FROM violations WHERE accused_user_id = ? ORDER BY created_at DESC').all(req.user.id);
        return res.json({ success: true, violations: myViolations });
      }

      let query = 'SELECT v.*, s.name as accused_name, rs.name as reporter_name FROM violations v JOIN signups s ON v.accused_user_id = s.id LEFT JOIN signups rs ON v.reporter_user_id = rs.id WHERE 1=1';
      const params = [];

      if (status) { query += ' AND v.status = ?'; params.push(status); }
      if (tier) { query += ' AND v.tier = ?'; params.push(parseInt(tier)); }

      query += ' ORDER BY v.created_at DESC';

      const violations = db.prepare(query).all(...params);
      res.json({ success: true, violations });
    } catch (error) {
      console.error('Get violations error:', error);
      res.status(500).json({ error: 'Could not fetch violations', success: false });
    }
  });

  router.post('/api/violations/:id/resolve', userAuth, (req, res) => {
    const { id } = req.params;
    const { status, resolution, penalty_tier } = req.body;
    const resolverId = req.user.id;

    if (!['resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'status must be "resolved" or "dismissed"', success: false });
    }

    try {
      const violation = db.prepare('SELECT * FROM violations WHERE id = ?').get(id);
      if (!violation) {
        return res.status(404).json({ error: 'Violation not found', success: false });
      }

      const now = new Date().toISOString();
      db.prepare('UPDATE violations SET status = ?, resolution = ?, resolved_by_user_id = ?, resolved_at = ? WHERE id = ?')
        .run(status, resolution || '', resolverId, now, id);

      if (status === 'resolved' && penalty_tier) {
        const penalty = VIOLATION_PENALTIES[penalty_tier];
        if (penalty) {
          db.prepare(`
            INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
            VALUES (?, 'violation_penalty', ?, ?, 'violation', ?, ?)
          `).run(violation.accused_user_id, -penalty.point_penalty, id, `Violation penalty (Tier ${penalty_tier}): ${violation.violation_type}`, now);
          db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
            .run(-penalty.point_penalty, violation.accused_user_id);

          if (penalty.action === 'temporary') {
            db.prepare(`
              INSERT INTO user_suspensions (user_id, violation_id, suspension_type, reason, starts_at, ends_at, created_at)
              VALUES (?, ?, 'temporary', ?, ?, datetime(?, '+7 days'), ?)
            `).run(violation.accused_user_id, id, violation.violation_type, now, now, now);
          } else if (penalty.action === 'permanent') {
            db.prepare(`
              INSERT INTO user_suspensions (user_id, violation_id, suspension_type, reason, starts_at, is_active, created_at)
              VALUES (?, ?, 'permanent', ?, ?, 1, ?)
            `).run(violation.accused_user_id, id, violation.violation_type, now, now);
          }
        }
      }

      logActivity('violation_resolved', resolverId, id, { status, penalty_tier }, req);
      res.json({ success: true, message: `Violation ${status}` });
    } catch (error) {
      console.error('Resolve violation error:', error);
      res.status(500).json({ error: 'Could not resolve violation', success: false });
    }
  });

  router.get('/api/suspensions/active', (req, res) => {
    try {
      const now = new Date().toISOString();
      const suspensions = db.prepare(`
        SELECT us.*, s.name as user_name
        FROM user_suspensions us
        JOIN signups s ON us.user_id = s.id
        WHERE us.is_active = 1 AND us.starts_at <= ? AND (us.ends_at IS NULL OR us.ends_at > ?)
        ORDER BY us.created_at DESC
      `).all(now, now);

      res.json({ success: true, suspensions });
    } catch (error) {
      console.error('Get suspensions error:', error);
      res.status(500).json({ error: 'Could not fetch suspensions', success: false });
    }
  });

  // ==================== AMPLIFICATION BOUNTY ====================
  router.post('/api/amplify', userAuth, (req, res) => {
    const { content_type, content_title, base_url, reward_points = 10, expires_in_days = 7 } = req.body;
    const userId = req.user.id;

    if (!content_type || !base_url) {
      return res.status(400).json({ error: 'content_type and base_url required', success: false });
    }

    try {
      const trackCode = crypto.randomBytes(8).toString('hex');
      const expiresAt = new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO amplification_links (creator_user_id, content_type, content_title, track_code, base_url, reward_points, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, content_type, content_title || '', trackCode, base_url, reward_points, expiresAt, now);

      const trackingUrl = `${req.protocol}://${req.get('host')}/api/amplify/track/${trackCode}`;

      res.status(201).json({ success: true, track_code: trackCode, tracking_url: trackingUrl });
    } catch (error) {
      console.error('Create amplification error:', error);
      res.status(500).json({ error: 'Could not create tracking link', success: false });
    }
  });

  router.get('/api/amplify/track/:code', (req, res) => {
    const { code } = req.params;
    const clickerIP = req.ip || req.connection.remoteAddress || 'unknown';

    try {
      const link = db.prepare('SELECT * FROM amplification_links WHERE track_code = ? AND is_active = 1').get(code);
      if (!link) {
        return res.status(404).json({ error: 'Link not found', success: false });
      }

      if (link.expires_at && new Date(link.expires_at) < new Date()) {
        return res.status(410).json({ error: 'Link expired', success: false });
      }

      const existingClick = db.prepare('SELECT id FROM amplification_clicks WHERE link_id = ? AND clicker_ip = ?').get(link.id, clickerIP);
      if (!existingClick) {
        db.prepare('INSERT INTO amplification_clicks (link_id, clicker_ip, clicked_at) VALUES (?, ?, ?)')
          .run(link.id, clickerIP, new Date().toISOString());

        db.prepare('UPDATE amplification_links SET click_count = click_count + 1 WHERE id = ?').run(link.id);

        if (link.creator_user_id) {
          db.prepare(`
            INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
            VALUES (?, 'amplification', ?, ?, 'amplify', ?, ?)
          `).run(link.creator_user_id, link.reward_points, link.id, `Amplification click: ${link.content_title || link.content_type}`, new Date().toISOString());
          db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
            .run(link.reward_points, link.creator_user_id);
        }
      }

      res.redirect(link.base_url);
    } catch (error) {
      console.error('Track amplification error:', error);
      res.status(500).json({ error: 'Could not track click', success: false });
    }
  });

  router.get('/api/amplify/stats/:code', userAuth, (req, res) => {
    const { code } = req.params;

    try {
      const link = db.prepare('SELECT * FROM amplification_links WHERE track_code = ?').get(code);
      if (!link) {
        return res.status(404).json({ error: 'Link not found', success: false });
      }
      if (link.creator_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Not your link', success: false });
      }

      res.json({ success: true, link });
    } catch (error) {
      console.error('Amplify stats error:', error);
      res.status(500).json({ error: 'Could not fetch stats', success: false });
    }
  });

  return router;
};
