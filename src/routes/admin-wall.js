const express = require('express');
const router = express.Router();

module.exports = function({ queries, adminAuth, logActivity }) {
  router.get('/api/admin/wall/all', adminAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const offset = parseInt(req.query.offset) || 0;
      const posts = queries.wall.getAllPostsAdmin(limit, offset);
      const total = queries.wall.countAllPosts();
      res.json({ posts, total, success: true });
    } catch (error) {
      console.error('Admin wall all posts error:', error);
      res.status(500).json({ error: 'Could not fetch posts', success: false });
    }
  });

  router.post('/api/admin/wall/:id/hide', adminAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    try {
      const post = queries.wall.getPostAdmin(postId);
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

  router.post('/api/admin/wall/:id/unhide', adminAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    try {
      const post = queries.wall.getPostAdmin(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }
      queries.wall.unhidePost(postId);
      logActivity('wall_post_unhidden', null, postId, { unhidden_by: 'admin' }, req);
      res.json({ success: true, message: 'Post published' });
    } catch (error) {
      console.error('Admin wall unhide error:', error);
      res.status(500).json({ error: 'Could not publish post', success: false });
    }
  });

  router.post('/api/admin/wall/:id/approve', adminAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    try {
      const post = queries.wall.getPostAdmin(postId);
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
      const post = queries.wall.getPostAdmin(postId);
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
