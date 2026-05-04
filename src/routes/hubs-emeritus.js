const express = require('express');
const router = express.Router();

module.exports = function({ queries, userAuth }) {

  router.get('/api/emeritus', (req, res) => {
    try {
      const members = queries.hubs.getEmeritusMembers();
      res.json({ success: true, members });
    } catch (error) {
      console.error('Get emeritus error:', error);
      res.status(500).json({ error: 'Could not fetch emeritus council', success: false });
    }
  });

  router.post('/api/hubs', userAuth, (req, res) => {
    const { name, charter, goals } = req.body;

    if (!name || !charter) {
      return res.status(400).json({ error: 'name and charter required', success: false });
    }

    try {
      const now = new Date().toISOString();
      queries.hubs.createHub({ name: name.trim(), charter: charter.trim(), goals: goals || '', created_by_user_id: req.user.id, created_at: now });
      const hubId = queries.hubs.getLastInsertId();
      queries.hubs.addHubMember(hubId, req.user.id, 'lead', now);

      res.status(201).json({ success: true, message: 'Hub created', hub_id: hubId });
    } catch (error) {
      console.error('Create hub error:', error);
      res.status(500).json({ error: 'Could not create hub', success: false });
    }
  });

  router.get('/api/hubs', (req, res) => {
    try {
      const hubs = queries.hubs.getActiveHubs();
      res.json({ success: true, hubs });
    } catch (error) {
      console.error('Get hubs error:', error);
      res.status(500).json({ error: 'Could not fetch hubs', success: false });
    }
  });

  router.post('/api/hubs/:id/join', userAuth, (req, res) => {
    const { id } = req.params;

    try {
      const hub = queries.hubs.getHub(id);
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found', success: false });
      }

      const existing = queries.hubs.getExistingMember(id, req.user.id);
      if (existing) {
        return res.status(409).json({ error: 'Already a member', success: false });
      }

      queries.hubs.addMember(id, req.user.id, new Date().toISOString());
      res.json({ success: true, message: 'Joined hub' });
    } catch (error) {
      console.error('Join hub error:', error);
      res.status(500).json({ error: 'Could not join hub', success: false });
    }
  });

  return router;
};
