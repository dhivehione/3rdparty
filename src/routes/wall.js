const express = require('express');
const router = express.Router();

module.exports = function({ db, getSettings, logActivity, merit, maybeEngageReferral, moderateWallContent, sanitizeHTML, getTreasuryBalance }) {

  // Shared wall vote handler
  function wallVoteHandler(voteValue) {
    return (req, res) => {
      const postId = parseInt(req.params.id);

      try {
        const post = db.prepare('SELECT id, upvotes, downvotes, user_id FROM wall_posts WHERE id = ? AND is_hidden = 0').get(postId);
        if (!post) {
          return res.status(404).json({ error: 'Post not found', success: false });
        }

        let voterId = null;
        let voterIP = null;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          try {
            const token = authHeader.split(' ')[1];
            const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
            if (user) voterId = user.id;
          } catch (e) {}
        }
        if (!voterId) {
          voterIP = req.ip || req.connection.remoteAddress || 'unknown';
        }

        if (voterId && post.user_id === voterId) {
          return res.status(400).json({ error: 'Cannot vote on your own post', success: false });
        }

        const existingVote = db.prepare(
          'SELECT id, vote FROM wall_votes WHERE post_id = ? AND (user_id = ? OR ip_address = ?)'
        ).get(postId, voterId, voterIP);

        const now = new Date().toISOString();

        if (existingVote) {
          if (existingVote.vote === voteValue) {
            db.prepare('DELETE FROM wall_votes WHERE id = ?').run(existingVote.id);
            if (voteValue === 1) {
              db.prepare('UPDATE wall_posts SET upvotes = MAX(upvotes - 1, 0) WHERE id = ?').run(postId);
            } else {
              db.prepare('UPDATE wall_posts SET downvotes = MAX(downvotes - 1, 0) WHERE id = ?').run(postId);
            }
            const updatedPost = db.prepare('SELECT upvotes, downvotes FROM wall_posts WHERE id = ?').get(postId);
            return res.json({ success: true, upvotes: updatedPost.upvotes, downvotes: updatedPost.downvotes, user_vote: 0, action: 'removed' });
          } else {
            db.prepare('UPDATE wall_votes SET vote = ?, created_at = ? WHERE id = ?').run(voteValue, now, existingVote.id);
            if (voteValue === 1) {
              db.prepare('UPDATE wall_posts SET upvotes = upvotes + 1, downvotes = MAX(downvotes - 1, 0) WHERE id = ?').run(postId);
            } else {
              db.prepare('UPDATE wall_posts SET downvotes = downvotes + 1, upvotes = MAX(upvotes - 1, 0) WHERE id = ?').run(postId);
            }
            const updatedPost = db.prepare('SELECT upvotes, downvotes FROM wall_posts WHERE id = ?').get(postId);
            return res.json({ success: true, upvotes: updatedPost.upvotes, downvotes: updatedPost.downvotes, user_vote: voteValue, action: 'changed' });
          }
        }

        db.prepare('INSERT INTO wall_votes (post_id, user_id, ip_address, vote, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(postId, voterId, voterIP, voteValue, now);

        if (voteValue === 1) {
          db.prepare('UPDATE wall_posts SET upvotes = upvotes + 1 WHERE id = ?').run(postId);
          if (post.user_id) {
            const newUpvotes = db.prepare('SELECT upvotes FROM wall_posts WHERE id = ?').get(postId).upvotes;
            if (newUpvotes > 0 && newUpvotes % 5 === 0) {
              const voteMerit = Math.min(newUpvotes, getSettings().wall_upvote_milestone_cap);
              merit.awardMerit(post.user_id, 'wall_upvoted', voteMerit, postId, 'wall', `Post reached ${newUpvotes} upvotes`);
            }
          }
          if (voterId) {
            const upvoteMerit = getSettings().wall_upvote_merit;
            merit.awardMerit(voterId, 'wall_vote', upvoteMerit, postId, 'wall', 'Upvoted a wall post');
            maybeEngageReferral(voterId);
          }
        } else {
          db.prepare('UPDATE wall_posts SET downvotes = downvotes + 1 WHERE id = ?').run(postId);
        }

        const updatedPost = db.prepare('SELECT upvotes, downvotes FROM wall_posts WHERE id = ?').get(postId);
        res.json({ success: true, upvotes: updatedPost.upvotes, downvotes: updatedPost.downvotes, user_vote: voteValue, action: 'added' });
      } catch (error) {
        console.error('Wall vote error:', error);
        res.status(500).json({ error: 'Could not process vote', success: false });
      }
    };
  }

  // GET /api/wall - Get posts (top-level only)
  router.get('/api/wall', (req, res) => {
    const { sort = 'new', page = 1, limit: rawLimit } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(rawLimit) || getSettings().wall_posts_limit));
    const offset = (pageNum - 1) * limit;

    try {
      let orderClause;
      if (sort === 'hot') {
        orderClause = `ORDER BY (upvotes - downvotes + 1.0) / (MAX((julianday('now') - julianday(timestamp)) * 24 + 2, 1)) DESC`;
      } else if (sort === 'top') {
        orderClause = 'ORDER BY (upvotes - downvotes) DESC, timestamp DESC';
      } else {
        orderClause = 'ORDER BY timestamp DESC';
      }

      const posts = db.prepare(`
        SELECT wp.*,
          COALESCE(s.username, wp.nickname) as display_name,
          COALESCE(s.initial_merit_estimate, 0) as user_merit
        FROM wall_posts wp
        LEFT JOIN signups s ON wp.user_id = s.id
        WHERE wp.is_approved = 1 AND wp.parent_id IS NULL AND wp.is_hidden = 0
        ${orderClause}
        LIMIT ? OFFSET ?
      `).all(limit, offset);

      const count = db.prepare(`
        SELECT COUNT(*) as total FROM wall_posts WHERE is_approved = 1 AND parent_id IS NULL AND is_hidden = 0
      `).get();

      let userVotes = {};
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.split(' ')[1];
          const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
          if (user) {
            const votes = db.prepare(`SELECT post_id, vote FROM wall_votes WHERE user_id = ? AND post_id IN (${posts.map(() => '?').join(',')})`)
              .all(user.id, ...posts.map(p => p.id));
            votes.forEach(v => { userVotes[v.post_id] = v.vote; });
          }
        } catch (e) {}
      }

      res.json({
        posts: posts.map(p => ({ ...p, user_vote: userVotes[p.id] || 0 })),
        total: count.total,
        page: pageNum,
        totalPages: Math.ceil(count.total / limit),
        showMore: (offset + limit) < count.total,
        success: true
      });
    } catch (error) {
      console.error('Wall fetch error:', error);
      res.status(500).json({ error: 'Could not fetch posts', success: false });
    }
  });

  // GET /api/wall/thread/:threadId
  router.get('/api/wall/thread/:threadId', (req, res) => {
    const { threadId } = req.params;
    try {
      const posts = db.prepare(`
        SELECT * FROM wall_posts 
        WHERE is_approved = 1 AND thread_id = ? AND is_hidden = 0
        ORDER BY timestamp DESC 
        LIMIT 50
      `).all(threadId);
      res.json({ posts, success: true });
    } catch (error) {
      console.error('Wall thread fetch error:', error);
      res.status(500).json({ error: 'Could not fetch thread posts', success: false });
    }
  });

  // GET /api/wall/post/:id
  router.get('/api/wall/post/:id', (req, res) => {
    const postId = parseInt(req.params.id);
    try {
      const post = db.prepare(`
        SELECT wp.*,
          COALESCE(s.username, wp.nickname) as display_name,
          COALESCE(s.initial_merit_estimate, 0) as user_merit
        FROM wall_posts wp
        LEFT JOIN signups s ON wp.user_id = s.id
        WHERE wp.id = ? AND wp.is_hidden = 0
      `).get(postId);

      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }

      const replies = db.prepare(`
        SELECT wp.*,
          COALESCE(s.username, wp.nickname) as display_name,
          COALESCE(s.initial_merit_estimate, 0) as user_merit
        FROM wall_posts wp
        LEFT JOIN signups s ON wp.user_id = s.id
        WHERE wp.parent_id = ? AND wp.is_approved = 1 AND wp.is_hidden = 0
        ORDER BY (wp.upvotes - wp.downvotes) DESC, wp.timestamp ASC
        LIMIT 100
      `).all(postId);

      post.replies = replies;

      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.split(' ')[1];
          const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
          if (user) {
            const voteRow = db.prepare('SELECT vote FROM wall_votes WHERE post_id = ? AND user_id = ?').get(postId, user.id);
            post.user_vote = voteRow ? voteRow.vote : 0;
          }
        } catch (e) {}
      }

      res.json({ post, success: true });
    } catch (error) {
      console.error('Wall post detail error:', error);
      res.status(500).json({ error: 'Could not fetch post', success: false });
    }
  });

  // GET /api/wall/replies/:parentId
  router.get('/api/wall/replies/:parentId', (req, res) => {
    const parentId = parseInt(req.params.parentId);
    try {
      const replies = db.prepare(`
        SELECT wp.*,
          COALESCE(s.username, wp.nickname) as display_name,
          COALESCE(s.initial_merit_estimate, 0) as user_merit
        FROM wall_posts wp
        LEFT JOIN signups s ON wp.user_id = s.id
        WHERE wp.parent_id = ? AND wp.is_approved = 1 AND wp.is_hidden = 0
        ORDER BY (wp.upvotes - wp.downvotes) DESC, wp.timestamp ASC
        LIMIT 100
      `).all(parentId);

      res.json({ replies, success: true });
    } catch (error) {
      console.error('Wall replies error:', error);
      res.status(500).json({ error: 'Could not fetch replies', success: false });
    }
  });

  // POST /api/wall - Add a post or reply
  router.post('/api/wall', (req, res) => {
    const { nickname, message, parent_id } = req.body;

    const parentId = parent_id ? parseInt(parent_id) : null;
    if (parentId && (isNaN(parentId) || parentId < 1)) {
      return res.status(400).json({ error: 'Invalid parent_id', success: false });
    }

    if (parentId) {
      const parentPost = db.prepare('SELECT id FROM wall_posts WHERE id = ? AND is_approved = 1 AND is_hidden = 0').get(parentId);
      if (!parentPost) {
        return res.status(404).json({ error: 'Parent post not found', success: false });
      }
    }

    let userId = null;
    let userName = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const user = db.prepare('SELECT id, username, name FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) {
          userId = user.id;
          userName = user.name || user.username;
        }
      } catch (e) {}
    }

    if (!userId && !parentId) {
      if (!nickname || nickname.trim().length < 2) {
        return res.status(400).json({ error: 'Please enter a nickname (at least 2 characters, or log in)', success: false });
      }
    }

    if (!message || message.trim().length < 1) {
      return res.status(400).json({ error: 'Please write something', success: false });
    }

    const maxLen = parentId ? 1000 : getSettings().wall_post_max_length;
    if (message.length > maxLen) {
      return res.status(400).json({ error: `Message too long (max ${maxLen} characters)`, success: false });
    }

    const modResult = moderateWallContent(message);
    if (!modResult.passed) {
      return res.status(400).json({
        error: `Content filtered: ${modResult.reason}. Please revise and try again.`,
        success: false,
        moderation_score: modResult.score
      });
    }

    try {
      const timestamp = new Date().toISOString();
      const cleanedNickname = (nickname && !userId) ? sanitizeHTML(nickname.trim().substring(0, getSettings().nickname_max_length)) : null;
      const cleanedMessage = sanitizeHTML(message.trim().substring(0, maxLen));
      const displayNickname = userId ? (userName || 'Member') : cleanedNickname;

      const needsReview = modResult.score >= 10;

      const stmt = db.prepare(`
        INSERT INTO wall_posts (nickname, message, parent_id, user_id, user_name, is_approved, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(displayNickname, cleanedMessage, parentId, userId, userName, needsReview ? 1 : 1, timestamp);
      const newPostId = result.lastInsertRowid;

      if (parentId) {
        db.prepare('UPDATE wall_posts SET reply_count = reply_count + 1 WHERE id = ?').run(parentId);
      }

      if (userId) {
        const wallMerit = parentId ? 5 : 15;
        merit.awardMerit(userId, 'wall_post', wallMerit, newPostId, 'wall', (parentId ? 'Replied' : 'Posted') + ' to The Wall');
        logActivity('wall_post', userId, newPostId, { parent_id: parentId, moderated: needsReview }, req);
        maybeEngageReferral(userId);
      } else {
        logActivity('wall_post', null, newPostId, { nickname: displayNickname, parent_id: parentId, moderated: needsReview }, req);
      }

      const responseMessage = parentId
        ? 'Reply posted!'
        : (needsReview ? 'Posted! Your message is live, but flagged for moderation review.' : 'Posted! Thanks for your support.');

      res.status(201).json({ 
        message: responseMessage,
        success: true,
        id: newPostId,
        moderated: needsReview
      });
    } catch (error) {
      console.error('Wall post error:', error);
      res.status(500).json({ error: 'Could not post message', success: false });
    }
  });

  // GET /api/wall-stats
  router.get('/api/wall-stats', (req, res) => {
    function safeQuery(sql, defaultVal = 0) {
      try { const r = db.prepare(sql).get(); return r.total || defaultVal; }
      catch (e) { return defaultVal; }
    }

    try {
      const members = safeQuery('SELECT COUNT(*) as total FROM signups');
      const wallPosts = safeQuery('SELECT COUNT(*) as total FROM wall_posts WHERE is_approved = 1 AND is_hidden = 0');
      const treasury = getTreasuryBalance();

      res.json({ members, wallPosts, treasury, success: true });
    } catch (error) {
      res.status(500).json({ error: 'Could not fetch stats', success: false });
    }
  });

  // POST /api/wall/:id/upvote
  router.post('/api/wall/:id/upvote', wallVoteHandler(1));

  // POST /api/wall/:id/downvote
  router.post('/api/wall/:id/downvote', wallVoteHandler(-1));

  // POST /api/wall/:id/flag
  router.post('/api/wall/:id/flag', (req, res) => {
    const postId = parseInt(req.params.id);
    const { reason } = req.body;

    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ error: 'Please provide a reason (at least 5 characters)', success: false });
    }

    try {
      const post = db.prepare('SELECT id FROM wall_posts WHERE id = ? AND is_hidden = 0').get(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }

      let reporterId = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.split(' ')[1];
          const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
          if (user) reporterId = user.id;
        } catch (e) {}
      }
      const reporterIP = req.ip || req.connection.remoteAddress || 'unknown';

      const existingFlag = db.prepare(
        'SELECT id FROM wall_flags WHERE post_id = ? AND (reporter_id = ? OR reporter_ip = ?)'
      ).get(postId, reporterId, reporterIP);
      if (existingFlag) {
        return res.status(409).json({ error: 'You already reported this post', success: false });
      }

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO wall_flags (post_id, reporter_id, reporter_ip, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(postId, reporterId, reporterIP, reason.trim().substring(0, 200), now);

      db.prepare('UPDATE wall_posts SET is_flagged = 1, flagged_by_ip = ?, flag_reason = ? WHERE id = ?')
        .run(reporterIP, reason.trim().substring(0, 200), postId);

      res.json({ success: true, message: 'Post reported. A moderator will review it.' });
    } catch (error) {
      console.error('Wall flag error:', error);
      res.status(500).json({ error: 'Could not report post', success: false });
    }
  });

  return router;
};
