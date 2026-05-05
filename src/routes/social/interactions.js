const express = require('express');
const router = express.Router();

module.exports = function({ db, logActivity, adminAuth, userAuth }) {

  // ==================== TABLES ====================
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

  // ==================== ACTIVITY LOG (ADMIN) ====================
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

  // ==================== KNOWLEDGE CHECK BOUNTY ====================
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
      }

      res.json({ success: true, correct, points_earned: correct ? quiz.points_reward : 0 });
    } catch (error) {
      console.error('Answer quiz error:', error);
      res.status(500).json({ error: 'Could not submit answer', success: false });
    }
  });

  // ==================== INFORMED COMMENT REWARD ====================
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
      }

      res.json({ success: true, endorsements: endorsementCount });
    } catch (error) {
      console.error('Endorse comment error:', error);
      res.status(500).json({ error: 'Could not endorse comment', success: false });
    }
  });

  return router;
};
