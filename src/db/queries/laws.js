module.exports = function(lawsDb) {
  return {
    getLaws(category) {
      let query = 'SELECT id, law_name, category_name, created_at FROM laws';
      const params = [];
      if (category) { query += ' WHERE category_name = ?'; params.push(category); }
      query += ' ORDER BY law_name';
      return lawsDb.prepare(query).all(...params);
    },
    getCategories() {
      return lawsDb.prepare('SELECT DISTINCT category_name FROM laws WHERE category_name IS NOT NULL ORDER BY category_name').all();
    },
    searchLaws(keywordCondition, keywordParams, category) {
      let query = `SELECT id, law_name, category_name, created_at, 'law' as type FROM laws WHERE 1=1`;
      const params = [...keywordParams];
      if (category) { query += ' AND category_name = ?'; params.push(category); }
      query += ` AND ${keywordCondition} ORDER BY law_name`;
      return lawsDb.prepare(query).all(...params);
    },
    searchArticles(keywordCondition, keywordParams, lawIds) {
      let query = `SELECT a.id, a.law_id, a.article_number, a.article_title, l.law_name, 'article' as type FROM articles a JOIN laws l ON a.law_id = l.id WHERE 1=1`;
      const params = [...keywordParams];
      if (lawIds && lawIds.length) {
        const placeholders = lawIds.map(() => '?').join(',');
        query += ` AND a.law_id IN (${placeholders})`;
        params.push(...lawIds);
      }
      query += ` AND ${keywordCondition} ORDER BY l.law_name, a.article_number`;
      return lawsDb.prepare(query).all(...params);
    },
    searchClauses(keywordCondition, keywordParams, articleIds) {
      const placeholders = articleIds.map(() => '?').join(',');
      return lawsDb.prepare(`
        SELECT sa.id, sa.article_id, sa.sub_article_label, sa.text_content, a.article_title, a.article_number, l.law_name, l.category_name
        FROM sub_articles sa JOIN articles a ON sa.article_id = a.id JOIN laws l ON a.law_id = l.id
        WHERE sa.article_id IN (${placeholders}) AND ${keywordCondition}
        ORDER BY l.law_name, a.article_number, sa.sub_article_label
      `).all(...keywordParams, ...articleIds);
    },
    getVoteStats() {
      const total = lawsDb.prepare('SELECT COUNT(*) as total FROM votes').get().total;
      const articlesVoted = lawsDb.prepare('SELECT COUNT(DISTINCT article_id) as total FROM votes').get().total;
      const breakdown = lawsDb.prepare('SELECT vote, COUNT(*) as count FROM votes GROUP BY vote').all();
      return { total, articlesVoted, breakdown };
    },
    getRecentVotes(limit) {
      return lawsDb.prepare(`
        SELECT v.vote, v.voted_at, v.reasoning, a.id as article_id, a.article_number, a.article_title, l.law_name
        FROM votes v JOIN articles a ON v.article_id = a.id JOIN laws l ON a.law_id = l.id
        ORDER BY v.voted_at DESC LIMIT ?
      `).all(limit);
    },
    getTopVoted(limit) {
      return lawsDb.prepare(`
        SELECT a.id as article_id, a.article_number, a.article_title, l.id as law_id, l.law_name,
          SUM(CASE WHEN v.vote = 'support' THEN 1 ELSE 0 END) as support,
          SUM(CASE WHEN v.vote = 'oppose' THEN 1 ELSE 0 END) as oppose,
          SUM(CASE WHEN v.vote = 'abstain' THEN 1 ELSE 0 END) as abstain,
          COUNT(*) as total_votes
        FROM votes v JOIN articles a ON v.article_id = a.id JOIN laws l ON a.law_id = l.id
        GROUP BY a.id ORDER BY total_votes DESC LIMIT ?
      `).all(limit);
    },
    getLaw(id) {
      return lawsDb.prepare('SELECT * FROM laws WHERE id = ?').get(id);
    },
    getArticlesForLaw(lawId) {
      return lawsDb.prepare('SELECT id, article_number, article_title FROM articles WHERE law_id = ? ORDER BY article_number').all(lawId);
    },
    getArticle(id) {
      return lawsDb.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    },
    getSubArticles(articleId) {
      return lawsDb.prepare('SELECT id, sub_article_label, text_content FROM sub_articles WHERE article_id = ? ORDER BY sub_article_label').all(articleId);
    },
    getArticleVotes(articleId) {
      return lawsDb.prepare('SELECT vote, COUNT(*) as count FROM votes WHERE article_id = ? GROUP BY vote').all(articleId);
    },
    getSubArticleVotes(subArticleId) {
      return lawsDb.prepare('SELECT vote, COUNT(*) as count FROM sub_article_votes WHERE sub_article_id = ? GROUP BY vote').all(subArticleId);
    },
    getSubArticle(id) {
      return lawsDb.prepare('SELECT * FROM sub_articles WHERE id = ?').get(id);
    },
    getRecentSubArticleVote(subArticleId, ip, cooldownMs) {
      return lawsDb.prepare('SELECT id FROM sub_article_votes WHERE sub_article_id = ? AND user_ip = ? AND voted_at > ? LIMIT 1')
        .get(subArticleId, ip, new Date(Date.now() - cooldownMs).toISOString());
    },
    getExistingSubArticleVote(subArticleId, ip) {
      return lawsDb.prepare('SELECT id FROM sub_article_votes WHERE sub_article_id = ? AND user_ip = ?').get(subArticleId, ip);
    },
    updateSubArticleVote(id, vote, reasoning, votedAt) {
      return lawsDb.prepare('UPDATE sub_article_votes SET vote = ?, reasoning = ?, voted_at = ? WHERE id = ?').run(vote, reasoning, votedAt, id);
    },
    insertSubArticleVote(vote) {
      return lawsDb.prepare('INSERT INTO sub_article_votes (sub_article_id, vote, reasoning, voted_at, user_ip) VALUES (?, ?, ?, ?, ?)')
        .run(vote.sub_article_id, vote.vote, vote.reasoning, vote.voted_at, vote.user_ip);
    },
    getRecentArticleVote(articleId, userIdOrIp, cooldownMs) {
      return lawsDb.prepare('SELECT id FROM votes WHERE (user_id = ? OR user_ip = ?) AND voted_at > ? LIMIT 1')
        .get(articleId, userIdOrIp, new Date(Date.now() - cooldownMs).toISOString());
    },
    getExistingArticleVote(articleId, userIdOrIp) {
      return lawsDb.prepare('SELECT id FROM votes WHERE article_id = ? AND (user_id = ? OR user_ip = ?)').get(articleId, userIdOrIp, userIdOrIp);
    },
    updateArticleVote(id, vote, reasoning, votedAt) {
      return lawsDb.prepare('UPDATE votes SET vote = ?, reasoning = ?, voted_at = ? WHERE id = ?').run(vote, reasoning, votedAt, id);
    },
    insertArticleVote(vote) {
      return lawsDb.prepare('INSERT INTO votes (article_id, user_id, vote, reasoning, voted_at, user_ip) VALUES (?, ?, ?, ?, ?, ?)')
        .run(vote.article_id, vote.user_id, vote.vote, vote.reasoning, vote.voted_at, vote.user_ip);
    },
    getRecentLawLevelVote(lawId, ipOrPhone, cooldownMs) {
      return lawsDb.prepare('SELECT id FROM law_level_votes WHERE law_id = ? AND (user_ip = ? OR user_phone = ?) AND voted_at > ? LIMIT 1')
        .get(lawId, ipOrPhone, ipOrPhone, new Date(Date.now() - cooldownMs).toISOString());
    },
    getExistingLawLevelVote(lawId, ipOrPhone) {
      return lawsDb.prepare('SELECT id FROM law_level_votes WHERE law_id = ? AND (user_ip = ? OR user_phone = ?)').get(lawId, ipOrPhone, ipOrPhone);
    },
    updateLawLevelVote(id, vote, reasoning, votedAt, userPhone) {
      return lawsDb.prepare('UPDATE law_level_votes SET vote = ?, reasoning = ?, voted_at = ?, user_phone = ? WHERE id = ?').run(vote, reasoning, votedAt, userPhone, id);
    },
    insertLawLevelVote(vote) {
      return lawsDb.prepare('INSERT INTO law_level_votes (law_id, vote, reasoning, voted_at, user_ip, user_phone) VALUES (?, ?, ?, ?, ?, ?)')
        .run(vote.law_id, vote.vote, vote.reasoning, vote.voted_at, vote.user_ip, vote.user_phone);
    },
    getLawLevelVotes(lawId) {
      return lawsDb.prepare('SELECT vote, COUNT(*) as count FROM law_level_votes WHERE law_id = ? GROUP BY vote').all(lawId);
    },
    getUserLawLevelVote(lawId, ipOrPhone) {
      return lawsDb.prepare('SELECT vote, reasoning FROM law_level_votes WHERE law_id = ? AND (user_ip = ? OR user_phone = ?)').get(lawId, ipOrPhone, ipOrPhone);
    },
    searchClausesByText(keyword, limit) {
      return lawsDb.prepare(`
        SELECT sa.text_content, sa.sub_article_label, a.article_title, a.article_number, l.law_name, l.category_name
        FROM sub_articles sa JOIN articles a ON sa.article_id = a.id JOIN laws l ON a.law_id = l.id
        WHERE sa.text_content LIKE ? LIMIT ?
      `).all(`%${keyword}%`, limit);
    },
    getUserClauseVotes(userPhone) {
      return lawsDb.prepare(`
        SELECT sv.*, sa.sub_article_label as clause_label, a.article_number, a.article_title, l.law_name
        FROM sub_article_votes sv JOIN sub_articles sa ON sv.sub_article_id = sa.id
        JOIN articles a ON sa.article_id = a.id JOIN laws l ON a.law_id = l.id
        WHERE sv.user_phone = ? ORDER BY sv.voted_at DESC LIMIT 50
      `).all(userPhone);
    },
    getUserLawVotes(userPhone) {
      return lawsDb.prepare(`
        SELECT llv.*, l.law_name, l.category_name FROM law_level_votes llv JOIN laws l ON llv.law_id = l.id
        WHERE llv.user_phone = ? ORDER BY llv.voted_at DESC LIMIT 50
      `).all(userPhone);
    },
  };
};
