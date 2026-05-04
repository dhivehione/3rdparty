module.exports = function(db) {
  return {
    getTargetUser(endorsedId) {
      return db.prepare('SELECT id FROM signups WHERE id = ? AND is_verified = 1').get(endorsedId);
    },
    getRecentEndorsements(endorserId, sinceDate) {
      return db.prepare('SELECT COUNT(*) as cnt FROM peer_endorsements WHERE endorser_id = ? AND created_at > ?').get(endorserId, sinceDate);
    },
    getExistingEndorsement(endorserId, endorsedId) {
      return db.prepare('SELECT id FROM peer_endorsements WHERE endorser_id = ? AND endorsed_id = ?').get(endorserId, endorsedId);
    },
    insertEndorsement(endorsement) {
      return db.prepare('INSERT INTO peer_endorsements (endorser_id, endorsed_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(endorsement.endorser_id, endorsement.endorsed_id, endorsement.created_at, endorsement.expires_at);
    },
    getCountForUser(endorsedId) {
      return db.prepare('SELECT * FROM peer_endorsements WHERE endorsed_id = ?').all(endorsedId);
    },
    getByIdAndEndorser(id, endorserId) {
      return db.prepare('SELECT * FROM peer_endorsements WHERE id = ? AND endorser_id = ?').get(id, endorserId);
    },
    deleteById(id) {
      return db.prepare('DELETE FROM peer_endorsements WHERE id = ?').run(id);
    },
    getRemainingCount(endorsedId) {
      return db.prepare('SELECT COUNT(*) as cnt FROM peer_endorsements WHERE endorsed_id = ?').get(endorsedId);
    },
    getReceived(endorsedId) {
      return db.prepare(`
        SELECT pe.*, s.name as endorser_name, s.username as endorser_username
        FROM peer_endorsements pe JOIN signups s ON pe.endorser_id = s.id
        WHERE pe.endorsed_id = ? ORDER BY pe.created_at DESC
      `).all(endorsedId);
    },
    getGiven(endorserId) {
      return db.prepare(`
        SELECT pe.*, s.name as endorsed_name, s.username as endorsed_username
        FROM peer_endorsements pe JOIN signups s ON pe.endorsed_id = s.id
        WHERE pe.endorser_id = ? ORDER BY pe.created_at DESC
      `).all(endorserId);
    },
    insertComment(comment) {
      return db.prepare('INSERT INTO article_comments (user_id, article_id, comment_text, created_at) VALUES (?, ?, ?, ?)')
        .run(comment.user_id, comment.article_id, comment.comment_text, comment.created_at);
    },
    getComments(articleId) {
      return db.prepare(`
        SELECT ac.*, s.name, s.username, (SELECT COUNT(*) FROM comment_endorsements WHERE comment_id = ac.id) as endorsements
        FROM article_comments ac JOIN signups s ON ac.user_id = s.id
        WHERE ac.article_id = ? AND ac.is_approved = 1
        ORDER BY endorsements DESC, ac.created_at DESC
      `).all(articleId);
    },
    getComment(id) {
      return db.prepare('SELECT * FROM article_comments WHERE id = ?').get(id);
    },
    getExistingCommentEndorsement(commentId, endorserId) {
      return db.prepare('SELECT id FROM comment_endorsements WHERE comment_id = ? AND endorser_id = ?').get(commentId, endorserId);
    },
    insertCommentEndorsement(commentId, endorserId, createdAt) {
      return db.prepare('INSERT INTO comment_endorsements (comment_id, endorser_id, created_at) VALUES (?, ?, ?)')
        .run(commentId, endorserId, createdAt);
    },
    countCommentEndorsements(commentId) {
      return db.prepare('SELECT COUNT(*) as cnt FROM comment_endorsements WHERE comment_id = ?').get(commentId);
    },
    updateCommentEndorsementCount(id, count) {
      return db.prepare('UPDATE article_comments SET endorsement_count = ? WHERE id = ?').run(count, id);
    },
  };
};
