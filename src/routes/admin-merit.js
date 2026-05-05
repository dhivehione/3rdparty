const express = require('express');
const router = express.Router();

module.exports = function({ db, adminAuth, merit }) {

  // GET /api/admin/merit/export - Export all merit data
  router.get('/api/admin/merit/export', adminAuth, (req, res) => {
    try {
      const events = db.prepare(`
        SELECT me.*, s.name as user_name, s.username as user_username
        FROM merit_events me
        LEFT JOIN signups s ON me.user_id = s.id
        ORDER BY me.created_at DESC
      `).all();

      const users = db.prepare(`
        SELECT id, name, username, phone, nid, initial_merit_estimate, donation_amount, timestamp
        FROM signups
        WHERE is_verified = 1 AND unregistered_at IS NULL
        ORDER BY id
      `).all();

      const summary = db.prepare(`
        SELECT event_type, COUNT(*) as count, SUM(points) as total_points
        FROM merit_events
        GROUP BY event_type
        ORDER BY total_points DESC
      `).all();

      res.json({
        success: true,
        exported_at: new Date().toISOString(),
        event_count: events.length,
        user_count: users.length,
        events,
        users,
        summary
      });
    } catch (error) {
      console.error('Merit export error:', error);
      res.status(500).json({ error: 'Could not export merit data', success: false });
    }
  });

  // POST /api/admin/merit/import - Import merit events (idempotent by reference)
  router.post('/api/admin/merit/import', adminAuth, (req, res) => {
    const { events } = req.body;
    if (!events || !Array.isArray(events)) {
      return res.status(400).json({ error: 'events array required', success: false });
    }

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    try {
      events.forEach(ev => {
        try {
          if (!ev.user_id || !ev.event_type || ev.points === undefined) {
            failed++;
            return;
          }

          // Check for existing exact match by all key fields to avoid duplicates
          const existing = db.prepare(`
            SELECT id FROM merit_events
            WHERE user_id = ? AND event_type = ? AND points = ? AND reference_id = ? AND reference_type = ? AND created_at = ?
          `).get(
            ev.user_id,
            ev.event_type,
            ev.points,
            ev.reference_id || null,
            ev.reference_type || null,
            ev.created_at
          );

          if (existing) {
            skipped++;
            return;
          }

          db.prepare(`
            INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            ev.user_id,
            ev.event_type,
            ev.points,
            ev.reference_id || null,
            ev.reference_type || null,
            ev.description || '',
            ev.created_at || new Date().toISOString()
          );

          imported++;
        } catch (e) {
          console.error('Import event error:', e);
          failed++;
        }
      });

      res.json({ success: true, imported, skipped, failed });
    } catch (error) {
      console.error('Merit import error:', error);
      res.status(500).json({ error: 'Could not import merit data', success: false });
    }
  });

  // POST /api/admin/merit/reconcile - Recalculate all initial_merit_estimate from merit_events
  router.post('/api/admin/merit/reconcile', adminAuth, (req, res) => {
    try {
      const dryRun = req.body.dry_run === true;
      const users = db.prepare(`
        SELECT id, initial_merit_estimate FROM signups WHERE is_verified = 1 AND unregistered_at IS NULL
      `).all();

      let reconciled = 0;
      const discrepancies = [];

      users.forEach(u => {
        const sumResult = db.prepare('SELECT SUM(points) as total FROM merit_events WHERE user_id = ?').get(u.id);
        const calculated = sumResult.total || 0;
        const current = u.initial_merit_estimate || 0;

        if (calculated !== current) {
          discrepancies.push({
            user_id: u.id,
            current,
            calculated,
            diff: calculated - current
          });

          if (!dryRun) {
            db.prepare('UPDATE signups SET initial_merit_estimate = ? WHERE id = ?').run(calculated, u.id);
          }
          reconciled++;
        }
      });

      res.json({
        success: true,
        dry_run: dryRun,
        reconciled,
        total_checked: users.length,
        discrepancies: discrepancies.slice(0, 100) // Limit response size
      });
    } catch (error) {
      console.error('Merit reconcile error:', error);
      res.status(500).json({ error: 'Could not reconcile merit data', success: false });
    }
  });

  // GET /api/admin/merit/leaderboard - Full leaderboard with audit counts
  router.get('/api/admin/merit/leaderboard', adminAuth, (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
      const users = db.prepare(`
        SELECT s.id, s.name, s.username, s.phone, s.initial_merit_estimate,
               COUNT(me.id) as event_count,
               COALESCE(SUM(me.points), 0) as calculated_score
        FROM signups s
        LEFT JOIN merit_events me ON s.id = me.user_id
        WHERE s.is_verified = 1 AND s.unregistered_at IS NULL
        GROUP BY s.id
        ORDER BY calculated_score DESC
        LIMIT ?
      `).all(limit);

      res.json({ success: true, users });
    } catch (error) {
      console.error('Merit leaderboard error:', error);
      res.status(500).json({ error: 'Could not fetch leaderboard', success: false });
    }
  });

  return router;
};
