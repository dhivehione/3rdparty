const express = require('express');
const router = express.Router();

module.exports = function({ db }) {

  // GET /api/signups/count - Get signup count (public)
  router.get('/api/signups/count', (req, res) => {
    try {
      const count = db.prepare('SELECT COUNT(*) as total FROM signups').get();
      res.json({ total: count.total, success: true });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch count', success: false });
    }
  });

  // GET /api/stats/new-joins - Get number of new members since last visit
  router.get('/api/stats/new-joins', (req, res) => {
    const { last_login } = req.query;
    
    if (!last_login) {
      return res.status(400).json({ error: 'last_login parameter required', success: false });
    }
    
    try {
      const sinceDate = last_login.replace(/'/g, "''");
      const newJoins = db.prepare(`
        SELECT COUNT(*) as total FROM signups 
        WHERE timestamp > ?
      `).get(sinceDate);
      
      const totalMembers = db.prepare('SELECT COUNT(*) as total FROM signups').get();
      
      res.json({
        new_joins: newJoins.total,
        total_members: totalMembers.total,
        success: true
      });
    } catch (error) {
      console.error('New joins stats error:', error);
      res.status(500).json({ error: 'Could not fetch stats', success: false });
    }
  });

  return router;
};
