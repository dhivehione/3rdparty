const express = require('express');
const router = express.Router();

module.exports = function({ db, userAuth, merit }) {

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

      const settings = merit.getSettings();
      const periodMs = settings.endorsement_period_days * 24 * 60 * 60 * 1000;
      const periodAgo = new Date(Date.now() - periodMs).toISOString();
      const recentEndorsements = db.prepare(`
        SELECT COUNT(*) as cnt FROM peer_endorsements
        WHERE endorser_id = ? AND created_at > ?
      `).get(endorserId, periodAgo);

      if (recentEndorsements.cnt >= settings.endorsement_max_per_period) {
        return res.status(429).json({ error: `Max ${settings.endorsement_max_per_period} endorsements per ${settings.endorsement_period_days}-day period`, success: false });
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
      effective_half_life_days: Math.round(merit.getSettings().merit_half_life_days * loyaltyCoeff)
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

  return router;
};
