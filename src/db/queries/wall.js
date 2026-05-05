module.exports = function(db) {
  return {
    getPost(id) {
      return db.prepare('SELECT id, upvotes, downvotes, user_id FROM wall_posts WHERE id = ? AND is_hidden = 0').get(id);
    },
    getPostAdmin(id) {
      return db.prepare('SELECT id, upvotes, downvotes, user_id FROM wall_posts WHERE id = ?').get(id);
    },
    getPostDetail(id) {
      return db.prepare(`
        SELECT wp.*, COALESCE(s.username, wp.nickname) as display_name, COALESCE(s.initial_merit_estimate, 0) as user_merit
        FROM wall_posts wp LEFT JOIN signups s ON wp.user_id = s.id WHERE wp.id = ? AND wp.is_hidden = 0
      `).get(id);
    },
    getPostsPaginated(limit, offset) {
      return db.prepare(`
        SELECT wp.*, COALESCE(s.username, wp.nickname) as display_name, COALESCE(s.initial_merit_estimate, 0) as user_merit
        FROM wall_posts wp LEFT JOIN signups s ON wp.user_id = s.id
        WHERE wp.is_approved = 1 AND wp.parent_id IS NULL AND wp.is_hidden = 0
        ORDER BY (wp.upvotes - wp.downvotes) DESC, wp.timestamp DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
    },
    countPosts() {
      return db.prepare('SELECT COUNT(*) as total FROM wall_posts WHERE is_approved = 1 AND parent_id IS NULL AND is_hidden = 0').get().total;
    },
    getThreadPosts(threadId) {
      return db.prepare('SELECT * FROM wall_posts WHERE is_approved = 1 AND thread_id = ? AND is_hidden = 0 ORDER BY timestamp DESC LIMIT 50').all(threadId);
    },
    getReplies(parentId) {
      return db.prepare(`
        SELECT wp.*, COALESCE(s.username, wp.nickname) as display_name, COALESCE(s.initial_merit_estimate, 0) as user_merit
        FROM wall_posts wp LEFT JOIN signups s ON wp.user_id = s.id
        WHERE wp.parent_id = ? AND wp.is_approved = 1 AND wp.is_hidden = 0
        ORDER BY (wp.upvotes - wp.downvotes) DESC, wp.timestamp ASC LIMIT 100
      `).all(parentId);
    },
    getParentPost(id) {
      return db.prepare('SELECT id FROM wall_posts WHERE id = ? AND is_approved = 1 AND is_hidden = 0').get(id);
    },
    getUserWallVotes(userId, postIds) {
      if (!postIds.length) return [];
      const placeholders = postIds.map(() => '?').join(',');
      return db.prepare(`SELECT post_id, vote FROM wall_votes WHERE user_id = ? AND post_id IN (${placeholders})`).all(userId, ...postIds);
    },
    getWallVote(postId, userId) {
      return db.prepare('SELECT vote FROM wall_votes WHERE post_id = ? AND user_id = ?').get(postId, userId);
    },
    getExistingWallVote(postId, userId, ip) {
      return db.prepare('SELECT id, vote FROM wall_votes WHERE post_id = ? AND (user_id = ? OR ip_address = ?)').get(postId, userId, ip);
    },
    getPostVotes(postId) {
      return db.prepare('SELECT upvotes, downvotes FROM wall_posts WHERE id = ?').get(postId);
    },
    createPost(post) {
      return db.prepare('INSERT INTO wall_posts (nickname, message, parent_id, user_id, user_name, is_approved, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(post.nickname, post.message, post.parent_id, post.user_id, post.user_name, post.is_approved, post.timestamp);
    },
    createWelcomePost(nickname, message, timestamp, threadId) {
      return db.prepare('INSERT INTO wall_posts (nickname, message, timestamp, thread_id) VALUES (?, ?, ?, ?)')
        .run(nickname, message, timestamp, threadId);
    },
    incrementReplyCount(parentId) {
      return db.prepare('UPDATE wall_posts SET reply_count = reply_count + 1 WHERE id = ?').run(parentId);
    },
    updateWallVote(id, vote, createdAt) {
      return db.prepare('UPDATE wall_votes SET vote = ?, created_at = ? WHERE id = ?').run(vote, createdAt, id);
    },
    deleteWallVote(id) {
      return db.prepare('DELETE FROM wall_votes WHERE id = ?').run(id);
    },
    insertWallVote(vote) {
      return db.prepare('INSERT INTO wall_votes (post_id, user_id, ip_address, vote, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(vote.post_id, vote.user_id, vote.ip_address, vote.vote, vote.created_at);
    },
    incrementUpvotes(postId) {
      return db.prepare('UPDATE wall_posts SET upvotes = upvotes + 1 WHERE id = ?').run(postId);
    },
    incrementDownvotes(postId) {
      return db.prepare('UPDATE wall_posts SET downvotes = downvotes + 1 WHERE id = ?').run(postId);
    },
    decrementUpvotes(postId) {
      return db.prepare('UPDATE wall_posts SET upvotes = MAX(upvotes - 1, 0) WHERE id = ?').run(postId);
    },
    decrementDownvotes(postId) {
      return db.prepare('UPDATE wall_posts SET downvotes = MAX(downvotes - 1, 0) WHERE id = ?').run(postId);
    },
    swapVoteUp(postId) {
      return db.prepare('UPDATE wall_posts SET upvotes = upvotes + 1, downvotes = MAX(downvotes - 1, 0) WHERE id = ?').run(postId);
    },
    swapVoteDown(postId) {
      return db.prepare('UPDATE wall_posts SET downvotes = downvotes + 1, upvotes = MAX(upvotes - 1, 0) WHERE id = ?').run(postId);
    },
    getAllPostsAdmin(limit, offset) {
      return db.prepare(`
        SELECT wp.*, COALESCE(s.username, wp.nickname) as display_name,
          (SELECT COUNT(*) FROM wall_flags WHERE post_id = wp.id) as flag_count,
          (SELECT reason FROM wall_flags WHERE post_id = wp.id ORDER BY created_at DESC LIMIT 1) as latest_flag_reason
        FROM wall_posts wp LEFT JOIN signups s ON wp.user_id = s.id
        ORDER BY wp.timestamp DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
    },
    countAllPosts() {
      return db.prepare('SELECT COUNT(*) as total FROM wall_posts').get().total;
    },
    hidePost(id, resolvedAt) {
      db.prepare('UPDATE wall_posts SET is_hidden = 1, is_flagged = 0 WHERE id = ?').run(id);
      db.prepare('UPDATE wall_flags SET status = "resolved", resolved_at = ? WHERE post_id = ?').run(resolvedAt, id);
    },
    unhidePost(id) {
      db.prepare('UPDATE wall_posts SET is_hidden = 0 WHERE id = ?').run(id);
    },
    approvePost(id) {
      return db.prepare('UPDATE wall_posts SET is_flagged = 0, is_hidden = 0, flag_reason = NULL, flagged_by_ip = NULL WHERE id = ?').run(id);
    },
    dismissFlag(id, resolvedAt) {
      db.prepare('UPDATE wall_posts SET is_flagged = 0, is_hidden = 0, flag_reason = NULL, flagged_by_ip = NULL WHERE id = ?').run(id);
      db.prepare('UPDATE wall_flags SET status = "dismissed", resolved_at = ? WHERE post_id = ?').run(resolvedAt, id);
    },
    deletePost(id) {
      db.prepare('DELETE FROM wall_votes WHERE post_id = ?').run(id);
      db.prepare('DELETE FROM wall_flags WHERE post_id = ?').run(id);
      db.prepare('DELETE FROM wall_posts WHERE parent_id = ?').run(id);
      db.prepare('DELETE FROM wall_posts WHERE id = ?').run(id);
    },
    getExistingFlag(postId, reporterId, reporterIp) {
      return db.prepare('SELECT id FROM wall_flags WHERE post_id = ? AND (reporter_id = ? OR reporter_ip = ?)').get(postId, reporterId, reporterIp);
    },
    insertFlag(flag) {
      return db.prepare('INSERT INTO wall_flags (post_id, reporter_id, reporter_ip, reason, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(flag.post_id, flag.reporter_id, flag.reporter_ip, flag.reason, flag.created_at);
    },
    flagPost(postId, reporterIp, reason) {
      return db.prepare('UPDATE wall_posts SET is_flagged = 1, flagged_by_ip = ?, flag_reason = ? WHERE id = ?').run(reporterIp, reason, postId);
    },
  };
};
