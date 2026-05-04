const express = require('express');
const router = express.Router();

module.exports = function({ queries, adminAuth, logActivity }) {
  router.get('/api/admin/wall/flagged', adminAuth, (req, res) => {
    try {
      const posts = queries.wall.getFlaggedPosts(50);
      res.json({ posts, success: true });
    } catch (error) {
      console.error('Admin wall flagged error:', error);
      res.status(500).json({ error: 'Could not fetch flagged posts', success: false });
    }
  });

  router.post('/api/admin/wall/:id/hide', adminAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    try {
      const post = queries.wall.getPost(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }
      queries.wall.hidePost(postId, new Date().toISOString());
      logActivity('wall_post_hidden', null, postId, { hidden_by: 'admin' }, req);
      res.json({ success: true, message: 'Post hidden' });
    } catch (error) {
      console.error('Admin wall hide error:', error);
      res.status(500).json({ error: 'Could not hide post', success: false });
    }
  });

  router.post('/api/admin/wall/:id/approve', adminAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    try {
      const post = queries.wall.getPost(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }
      queries.wall.dismissFlag(postId, new Date().toISOString());
      logActivity('wall_post_approved', null, postId, {}, req);
      res.json({ success: true, message: 'Post approved and unflagged' });
    } catch (error) {
      console.error('Admin wall approve error:', error);
      res.status(500).json({ error: 'Could not approve post', success: false });
    }
  });

  router.post('/api/admin/wall/:id/delete', adminAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    try {
      const post = queries.wall.getPost(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }
      queries.wall.deletePost(postId);
      logActivity('wall_post_deleted', null, postId, {}, req);
      res.json({ success: true, message: 'Post permanently deleted' });
    } catch (error) {
      console.error('Admin wall delete error:', error);
      res.status(500).json({ error: 'Could not delete post', success: false });
    }
  });

  return router;
};
