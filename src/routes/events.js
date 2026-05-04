const express = require('express');
const router = express.Router();

module.exports = function({ db, adminAuth, logActivity }) {
  router.get('/api/events', (req, res) => {
    try {
      const events = db.prepare(`
        SELECT * FROM events 
        WHERE event_date >= date('now') 
        ORDER BY event_date ASC
      `).all();
      res.json({ events, success: true });
    } catch (error) {
      res.json({ events: [], success: true });
    }
  });

  router.get('/api/admin/events', adminAuth, (req, res) => {
    try {
      const events = db.prepare(`
        SELECT * FROM events 
        ORDER BY event_date ASC
      `).all();
      res.json({ events, success: true });
    } catch (error) {
      res.json({ events: [], success: true });
    }
  });

  router.post('/api/admin/events', adminAuth, (req, res) => {
    const { title, description, event_date, location } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Event title is required', success: false });
    }

    if (!event_date) {
      return res.status(400).json({ error: 'Event date is required', success: false });
    }

    try {
      const createdAt = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT INTO events (title, description, event_date, location, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = stmt.run(title.trim(), description || null, event_date, location || null, createdAt);

      logActivity('event_created', null, result.lastInsertRowid, { title }, req);

      res.json({ success: true, message: 'Event created', id: result.lastInsertRowid });
    } catch (error) {
      console.error('Create event error:', error);
      res.status(500).json({ error: 'Could not create event', success: false });
    }
  });

  router.put('/api/admin/events/:id', adminAuth, (req, res) => {
    const eventId = parseInt(req.params.id);
    const { title, description, event_date, location } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Event title is required', success: false });
    }

    try {
      const existing = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
      if (!existing) {
        return res.status(404).json({ error: 'Event not found', success: false });
      }

      db.prepare(`
        UPDATE events SET title = ?, description = ?, event_date = ?, location = ?
        WHERE id = ?
      `).run(title.trim(), description || null, event_date, location || null, eventId);

      logActivity('event_updated', null, eventId, { title }, req);

      res.json({ success: true, message: 'Event updated' });
    } catch (error) {
      console.error('Update event error:', error);
      res.status(500).json({ error: 'Could not update event', success: false });
    }
  });

  router.delete('/api/admin/events/:id', adminAuth, (req, res) => {
    const eventId = parseInt(req.params.id);

    try {
      const existing = db.prepare('SELECT id, title FROM events WHERE id = ?').get(eventId);
      if (!existing) {
        return res.status(404).json({ error: 'Event not found', success: false });
      }

      db.prepare('DELETE FROM events WHERE id = ?').run(eventId);

      logActivity('event_deleted', null, eventId, { title: existing.title }, req);

      res.json({ success: true, message: 'Event deleted' });
    } catch (error) {
      console.error('Delete event error:', error);
      res.status(500).json({ error: 'Could not delete event', success: false });
    }
  });

  return router;
};