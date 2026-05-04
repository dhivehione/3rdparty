const express = require('express');
const router = express.Router();

module.exports = function({ db, adminAuth, logActivity }) {
  router.get('/api/admin/wall/flagged', adminAuth, (req, res) => {
    try {
      const posts = db.prepare(`
        SELECT wp.*,
          COALESCE(s.username, wp.nickname) as display_name,
          (SELECT COUNT(*) FROM wall_flags WHERE post_id = wp.id) as flag_count,
          (SELECT reason FROM wall_flags WHERE post_id = wp.id ORDER BY created_at DESC LIMIT 1) as latest_flag_reason
        FROM wall_posts wp
        LEFT JOIN signups s ON wp.user_id = s.id
        WHERE wp.is_flagged = 1 OR wp.is_hidden = 1
        ORDER BY wp.is_hidden ASC, wp.is_flagged DESC, wp.timestamp DESC
        LIMIT 50
      `).all();

      res.json({ posts, success: true });
    } catch (error) {
      console.error('Admin wall flagged error:', error);
      res.status(500).json({ error: 'Could not fetch flagged posts', success: false });
    }
  });

  router.post('/api/admin/wall/:id/hide', adminAuth, (req, res) => {
    const postId = parseInt(req.params.id);
    try {
      const post = db.prepare('SELECT id FROM wall_posts WHERE id = ?').get(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }
      db.prepare('UPDATE wall_posts SET is_hidden = 1, is_flagged = 0 WHERE id = ?').run(postId);
      db.prepare('UPDATE wall_flags SET status = "resolved", resolved_at = ? WHERE post_id = ?')
        .run(new Date().toISOString(), postId);

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
      const post = db.prepare('SELECT id FROM wall_posts WHERE id = ?').get(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }
      db.prepare('UPDATE wall_posts SET is_flagged = 0, is_hidden = 0, flag_reason = NULL, flagged_by_ip = NULL WHERE id = ?').run(postId);
      db.prepare('UPDATE wall_flags SET status = "dismissed", resolved_at = ? WHERE post_id = ?')
        .run(new Date().toISOString(), postId);

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
      const post = db.prepare('SELECT id FROM wall_posts WHERE id = ?').get(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }
      db.prepare('DELETE FROM wall_votes WHERE post_id = ?').run(postId);
      db.prepare('DELETE FROM wall_flags WHERE post_id = ?').run(postId);
      db.prepare('DELETE FROM wall_posts WHERE parent_id = ?').run(postId);
      db.prepare('DELETE FROM wall_posts WHERE id = ?').run(postId);

      logActivity('wall_post_deleted', null, postId, {}, req);
      res.json({ success: true, message: 'Post permanently deleted' });
    } catch (error) {
      console.error('Admin wall delete error:', error);
      res.status(500).json({ error: 'Could not delete post', success: false });
    }
  });

  return router;
};