const express = require('express');
const router = express.Router();

module.exports = function({ db, userAuth }) {

  // DDL: emiritus_council (will also be in migrations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS emiritus_council (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      invited_at TEXT NOT NULL,
      reason TEXT,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES signups(id)
    )
  `);

  // GET /api/emeritus
  router.get('/api/emeritus', (req, res) => {
    try {
      const members = db.prepare(`
        SELECT ec.*, s.name, s.username, s.initial_merit_estimate as merit_score
        FROM emiritus_council ec
        JOIN signups s ON ec.user_id = s.id
        WHERE ec.is_active = 1
        ORDER BY ec.invited_at DESC
      `).all();

      res.json({ success: true, members });
    } catch (error) {
      console.error('Get emiritus error:', error);
      res.status(500).json({ error: 'Could not fetch emeritus council', success: false });
    }
  });

  // DDL: policy_hubs, hub_members, hub_stipends (will also be in migrations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_hubs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      charter TEXT NOT NULL,
      goals TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'dissolved')),
      created_by_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by_user_id) REFERENCES signups(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hub_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT DEFAULT 'member' CHECK(role IN ('lead', 'member')),
      joined_at TEXT NOT NULL,
      stipend_earned REAL DEFAULT 0,
      FOREIGN KEY (hub_id) REFERENCES policy_hubs(id),
      FOREIGN KEY (user_id) REFERENCES signups(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_stipends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hub_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      period_year INTEGER NOT NULL,
      period_month INTEGER NOT NULL,
      amount_awarded REAL NOT NULL,
      awarded_at TEXT NOT NULL,
      UNIQUE(hub_id, user_id, period_year, period_month),
      FOREIGN KEY (hub_id) REFERENCES policy_hubs(id),
      FOREIGN KEY (user_id) REFERENCES signups(id)
    )
  `);

  // POST /api/hubs
  router.post('/api/hubs', userAuth, (req, res) => {
    const { name, charter, goals } = req.body;

    if (!name || !charter) {
      return res.status(400).json({ error: 'name and charter required', success: false });
    }

    try {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO policy_hubs (name, charter, goals, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(name.trim(), charter.trim(), goals || '', req.user.id, now);

      const hubId = db.prepare('SELECT last_insert_rowid() as id').get().id;
      db.prepare('INSERT INTO hub_members (hub_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
        .run(hubId, req.user.id, 'lead', now);

      res.status(201).json({ success: true, message: 'Hub created', hub_id: hubId });
    } catch (error) {
      console.error('Create hub error:', error);
      res.status(500).json({ error: 'Could not create hub', success: false });
    }
  });

  // GET /api/hubs
  router.get('/api/hubs', (req, res) => {
    try {
      const hubs = db.prepare(`
        SELECT ph.*, s.name as creator_name,
               (SELECT COUNT(*) FROM hub_members WHERE hub_id = ph.id) as member_count
        FROM policy_hubs ph
        JOIN signups s ON ph.created_by_user_id = s.id
        WHERE ph.status = 'active'
        ORDER BY ph.created_at DESC
      `).all();

      res.json({ success: true, hubs });
    } catch (error) {
      console.error('Get hubs error:', error);
      res.status(500).json({ error: 'Could not fetch hubs', success: false });
    }
  });

  // POST /api/hubs/:id/join
  router.post('/api/hubs/:id/join', userAuth, (req, res) => {
    const { id } = req.params;

    try {
      const hub = db.prepare('SELECT * FROM policy_hubs WHERE id = ? AND status = ?').get(id, 'active');
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found', success: false });
      }

      const existing = db.prepare('SELECT id FROM hub_members WHERE hub_id = ? AND user_id = ?').get(id, req.user.id);
      if (existing) {
        return res.status(409).json({ error: 'Already a member', success: false });
      }

      db.prepare('INSERT INTO hub_members (hub_id, user_id, joined_at) VALUES (?, ?, ?)')
        .run(id, req.user.id, new Date().toISOString());

      res.json({ success: true, message: 'Joined hub' });
    } catch (error) {
      console.error('Join hub error:', error);
      res.status(500).json({ error: 'Could not join hub', success: false });
    }
  });

  return router;
};
