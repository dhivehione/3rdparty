const express = require('express');
const router = express.Router();

module.exports = function({ db, logActivity, userAuth }) {

  // ==================== TABLES ====================
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

  return router;
};
