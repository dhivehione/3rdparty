const express = require('express');
const crypto = require('crypto');
const router = express.Router();

module.exports = function({ db, userAuth, getSettings }) {

  // ==================== TABLES ====================
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

  // ==================== AMPLIFICATION BOUNTY ====================
  router.post('/api/amplify', userAuth, (req, res) => {
    const { content_type, content_title, base_url, reward_points, expires_in_days } = req.body;
    const settings = getSettings();
    const finalReward = reward_points !== undefined ? reward_points : settings.amplification_default_reward;
    const finalExpiry = expires_in_days !== undefined ? expires_in_days : settings.amplification_default_expiry_days;
    const userId = req.user.id;

    if (!content_type || !base_url) {
      return res.status(400).json({ error: 'content_type and base_url required', success: false });
    }

    try {
      const trackCode = crypto.randomBytes(8).toString('hex');
      const expiresAt = new Date(Date.now() + finalExpiry * 24 * 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO amplification_links (creator_user_id, content_type, content_title, track_code, base_url, reward_points, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, content_type, content_title || '', trackCode, base_url, finalReward, expiresAt, now);

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
