const express = require('express');
const router = express.Router();

module.exports = function({ db, adminAuth, getTreasuryBalance }) {

  // POST /api/unregister - Unregister a user (admin only)
  router.post('/api/unregister', adminAuth, (req, res) => {
    const { user_id, justification } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'User ID required', success: false });
    }
    
    if (!justification || justification.trim().length < 10) {
      return res.status(400).json({ error: 'Justification note required (min 10 characters)', success: false });
    }
    
    try {
      const user = db.prepare('SELECT id, name, phone FROM signups WHERE id = ?').get(user_id);
      if (!user) {
        return res.status(404).json({ error: 'User not found', success: false });
      }
      
      const unregisteredAt = new Date().toISOString();
      db.prepare(`
        UPDATE signups 
        SET is_verified = 0, unregistered_at = ?, unregistered_by = 'admin', unregister_justification = ?
        WHERE id = ?
      `).run(unregisteredAt, justification.trim(), user_id);
      
      res.json({ 
        message: `User ${user.name || user.phone} has been unregistered.`,
        success: true 
      });
    } catch (error) {
      console.error('Unregister error:', error);
      res.status(500).json({ error: 'Could not unregister user', success: false });
    }
  });

  // POST /api/reregister - Re-register an unregistered user (admin only)
  router.post('/api/reregister', adminAuth, (req, res) => {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'User ID required', success: false });
    }
    
    try {
      const user = db.prepare('SELECT id, name, phone FROM signups WHERE id = ?').get(user_id);
      if (!user) {
        return res.status(404).json({ error: 'User not found', success: false });
      }
      
      if (user.is_verified === 1) {
        return res.status(400).json({ error: 'User is already verified', success: false });
      }
      
      db.prepare(`
        UPDATE signups 
        SET is_verified = 1, unregistered_at = NULL, unregistered_by = NULL, unregister_justification = NULL
        WHERE id = ?
      `).run(user_id);
      
      res.json({ 
        message: `User ${user.name || user.phone || '#' + user_id} has been re-registered.`,
        success: true 
      });
    } catch (error) {
      console.error('Reregister error:', error);
      res.status(500).json({ error: 'Could not re-register user', success: false });
    }
  });

  // GET /api/signups - Get all signups (admin only, with pagination)
  router.get('/api/signups', adminAuth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;
      
      const signups = db.prepare('SELECT * FROM signups ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
      const count = db.prepare('SELECT COUNT(*) as total FROM signups').get();
      const treasury = getTreasuryBalance();
      const donorCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE donation_amount > 0').get();
      const today = new Date().toISOString().split('T')[0];
      const todayCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE timestamp >= ?').get(today);
      
      const parsedSignups = signups.map(s => ({
        ...s,
        contribution_type: s.contribution_type ? (() => {
          try { return JSON.parse(s.contribution_type); }
          catch(e) { return [s.contribution_type]; }
        })() : []
      }));
      
      res.json({ 
        signups: parsedSignups,
        total: count.total,
        total_treasury: treasury,
        donor_count: donorCount.total,
        today_count: todayCount.total,
        page: page,
        limit: limit,
        totalPages: Math.ceil(count.total / limit),
        success: true 
      });
    } catch (error) {
      console.error('Fetch error:', error);
      res.status(500).json({ 
        error: 'Database error',
        success: false 
      });
    }
  });

  // DELETE /api/signups - Clear all signups (admin only)
  router.delete('/api/signups', adminAuth, (req, res) => {
    try {
      db.prepare('DELETE FROM signups').run();
      res.json({ 
        message: 'All signups cleared. Database is now as empty as traditional party promises.',
        success: true 
      });
    } catch (error) {
      console.error('Delete error:', error);
      res.status(500).json({ 
        error: 'Could not clear database',
        success: false 
      });
    }
  });

  return router;
};
