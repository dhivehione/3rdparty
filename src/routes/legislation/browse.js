const express = require('express');
const router = express.Router();

module.exports = function({ db, lawsDb, getSettings }) {

// ==================== LEGISLATURE API ====================
// GET /api/legislation - Get all laws/proposals (passed and active)
router.get('/api/legislation', (req, res) => {
  try {
    const proposals = db.prepare(`
      SELECT 'proposal' as type, id, title, description, category, status, created_at as date, yes_votes, no_votes
      FROM proposals WHERE status = 'active'
      UNION ALL
      SELECT 'ranked' as type, id, title, description, category, status, created_at as date, NULL as yes_votes, NULL as no_votes
      FROM ranked_proposals WHERE status = 'active'
      UNION ALL
      SELECT 'law' as type, id, title, description, category, status, passed_at as date, NULL as yes_votes, NULL as no_votes
      FROM laws WHERE status = 'passed'
      ORDER BY date DESC
    `).all();
    
    res.json({ legislation: proposals, success: true });
  } catch (error) {
    console.error('Legislation error:', error);
    res.status(500).json({ error: 'Could not fetch legislation', success: false });
  }
});

// GET /api/legislation-stats - Get legislation stats
router.get('/api/legislation-stats', (req, res) => {
  try {
    const active = db.prepare('SELECT COUNT(*) as total FROM proposals WHERE status = ?').get('active');
    const ranked = db.prepare('SELECT COUNT(*) as total FROM ranked_proposals WHERE status = ?').get('active');
    const passed = db.prepare('SELECT COUNT(*) as total FROM laws WHERE status = ?').get('passed');
    const votes = db.prepare('SELECT COUNT(*) as total FROM votes').get();
    
    res.json({
      activeProposals: active.total,
      rankedProposals: ranked.total,
      passedLaws: passed.total,
      totalVotes: votes.total,
      success: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats', success: false });
  }
});

// ==================== LAWS API (Maldives Laws from mvlaws) ====================

// Create sub_article_votes, law_votes, and law_level_votes tables if lawsDb exists
if (lawsDb) {
  try {
    lawsDb.exec(`
      CREATE TABLE IF NOT EXISTS sub_article_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sub_article_id INTEGER NOT NULL,
        vote TEXT NOT NULL CHECK(vote IN ('support', 'oppose', 'abstain')),
        reasoning TEXT,
        voted_at TEXT NOT NULL,
        user_ip TEXT,
        user_phone TEXT
      )
    `);
    console.log('✓ Sub-article votes table ready');
  } catch (err) {
    console.log('⚠ Could not create sub_article_votes table:', err.message);
  }
  
  try {
    lawsDb.exec(`
      CREATE TABLE IF NOT EXISTS law_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL,
        vote TEXT NOT NULL CHECK(vote IN ('support', 'oppose', 'abstain')),
        reasoning TEXT,
        voted_at TEXT NOT NULL,
        user_ip TEXT,
        user_phone TEXT
      )
    `);
    console.log('✓ Law votes table ready');
  } catch (err) {
    console.log('⚠ Could not create law_votes table:', err.message);
  }

  // Law-level votes table
  try {
    lawsDb.exec(`
      CREATE TABLE IF NOT EXISTS law_level_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        law_id INTEGER NOT NULL,
        vote TEXT NOT NULL CHECK(vote IN ('support', 'oppose', 'abstain')),
        reasoning TEXT,
        voted_at TEXT NOT NULL,
        user_ip TEXT,
        user_phone TEXT
      )
    `);
    console.log('✓ Law-level votes table ready');
  } catch (err) {
    console.log('⚠ Could not create law_level_votes table:', err.message);
  }
}

// GET /api/mvlaws - List all laws with categories
router.get('/api/mvlaws', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available', success: false });
  }
  
  try {
    const { category } = req.query;
    let sql = 'SELECT id, law_name, category_name, created_at FROM laws';
    let params = [];
    
    if (category && category !== 'all') {
      sql += ' WHERE category_name = ?';
      params.push(category);
    }
    
    sql += ' ORDER BY law_name';
    
    const laws = lawsDb.prepare(sql).all(...params);
    
    const categories = lawsDb.prepare(
      'SELECT DISTINCT category_name FROM laws WHERE category_name IS NOT NULL ORDER BY category_name'
    ).all();
    
    res.json({ 
      laws, 
      categories: categories.map(c => c.category_name),
      total: laws.length,
      success: true 
    });
  } catch (error) {
    console.error('Fetch laws error:', error);
    res.status(500).json({ error: 'Could not fetch laws', success: false });
  }
});

// GET /api/mvlaws/search - Search laws, articles, and clauses
router.get('/api/mvlaws/search', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available. Set LAWS_DB_PATH environment variable.', success: false });
  }
  
  try {
    const { q, match = 'any', category, include_clauses = 'true' } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters', success: false });
    }
    
    const keywords = q.split(/[,\s]+/).filter(k => k.trim().length > 0).map(k => k.trim().toLowerCase());
    if (keywords.length === 0) {
      return res.status(400).json({ error: 'No valid keywords provided', success: false });
    }
    
    const buildKeywordCondition = (field, keywords, matchType) => {
      const conditions = keywords.map(() => `${field} LIKE ?`);
      return `(${conditions.join(matchType === 'all' ? ' AND ' : ' OR ')})`;
    };
    
    const keywordParams = keywords.map(k => `%${k.replace(/[%_]/g, '\\$&')}%`);
    
    let lawSql = `SELECT id, law_name, category_name, created_at, 'law' as type FROM laws WHERE 1=1`;
    const lawParams = [];
    
    if (category && category !== 'all') {
      lawSql += ' AND category_name = ?';
      lawParams.push(category);
    }
    
    lawSql += ` AND ${buildKeywordCondition('law_name', keywords, match)}`;
    lawParams.push(...keywordParams);
    lawSql += ' ORDER BY law_name';
    
    const matchedLaws = lawsDb.prepare(lawSql).all(...lawParams);
    const matchedLawIds = matchedLaws.map(l => l.id);
    
    let articleSql = `SELECT a.id, a.law_id, a.article_number, a.article_title, l.law_name, 'article' as type FROM articles a JOIN laws l ON a.law_id = l.id WHERE 1=1`;
    const articleParams = [];
    
    if (matchedLawIds.length > 0) {
      articleSql += ` AND a.law_id IN (${matchedLawIds.map(() => '?').join(',')})`;
      articleParams.push(...matchedLawIds);
    }
    
    articleSql += ` AND ${buildKeywordCondition('a.article_title', keywords, match)}`;
    articleParams.push(...keywordParams);
    articleSql += ' ORDER BY l.law_name, a.article_number';
    
    let matchedArticles = [];
    try { matchedArticles = lawsDb.prepare(articleSql).all(...articleParams); } catch (e) {}
    
    const matchedArticleIds = matchedArticles.map(a => a.id);
    let clauseResults = [];
    
    if (include_clauses === 'true' && matchedArticleIds.length > 0) {
      let clauseSql = `SELECT sa.id, sa.article_id, sa.sub_article_label, sa.text_content, a.article_number, a.article_title, l.id as law_id, l.law_name, 'clause' as type FROM sub_articles sa JOIN articles a ON sa.article_id = a.id JOIN laws l ON a.law_id = l.id WHERE sa.article_id IN (${matchedArticleIds.map(() => '?').join(',')})`;
      const clauseParams = [...matchedArticleIds];
      
      clauseSql += ` AND ${buildKeywordCondition('sa.text_content', keywords, match)}`;
      clauseParams.push(...keywordParams);
      clauseSql += ' ORDER BY l.law_name, a.article_number, sa.sub_article_label';
      
      try { clauseResults = lawsDb.prepare(clauseSql).all(...clauseParams); } catch (e) {}
    }
    
    res.json({ laws: matchedLaws, articles: matchedArticles, clauses: clauseResults, total: matchedLaws.length + matchedArticles.length + clauseResults.length, keywords: keywords, matchType: match, success: true });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed: ' + error.message, success: false });
  }
});

// GET /api/mvlaws/stats - Get voting stats
router.get('/api/mvlaws/stats', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available. Set LAWS_DB_PATH environment variable.', success: false });
  }
  
  try {
    let totalVotes = { total: 0 };
    let articlesVoted = { total: 0 };
    let voteBreakdown = [];
    
    try {
      totalVotes = lawsDb.prepare('SELECT COUNT(*) as total FROM votes').get();
      articlesVoted = lawsDb.prepare('SELECT COUNT(DISTINCT article_id) as total FROM votes').get();
      voteBreakdown = lawsDb.prepare('SELECT vote, COUNT(*) as count FROM votes GROUP BY vote').all();
    } catch (e) {}
    
    res.json({ totalVotes: totalVotes.total, articlesVoted: articlesVoted.total, breakdown: voteBreakdown, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats: ' + error.message, success: false });
  }
});

// GET /api/mvlaws/:id - Get law with articles (must be after static routes)
router.get('/api/mvlaws/:id', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available', success: false });
  }
  
  try {
    const lawId = parseInt(req.params.id);
    
    const law = lawsDb.prepare('SELECT * FROM laws WHERE id = ?').get(lawId);
    if (!law) {
      return res.status(404).json({ error: 'Law not found', success: false });
    }
    
    const articles = lawsDb.prepare(`
      SELECT id, article_number, article_title
      FROM articles 
      WHERE law_id = ?
      ORDER BY article_number
    `).all(lawId);
    
    res.json({ law, articles, success: true });
  } catch (error) {
    console.error('Fetch law error:', error);
    res.status(500).json({ error: 'Could not fetch law', success: false });
  }
});

// GET /api/mvlaws/:id/articles/:articleId - Get article with sub-articles
router.get('/api/mvlaws/:id/articles/:articleId', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available. Set LAWS_DB_PATH environment variable.', success: false });
  }
  
  try {
    const lawId = parseInt(req.params.id);
    const articleId = parseInt(req.params.articleId);
    
    const law = lawsDb.prepare('SELECT * FROM laws WHERE id = ?').get(lawId);
    if (!law) {
      return res.status(404).json({ error: 'Law not found', success: false });
    }
    
    const article = lawsDb.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
    if (!article) {
      return res.status(404).json({ error: 'Article not found', success: false });
    }
    
    let subArticles = [];
    try {
      subArticles = lawsDb.prepare(`
        SELECT id, sub_article_label, text_content
        FROM sub_articles
        WHERE article_id = ?
        ORDER BY sub_article_label
      `).all(articleId);
    } catch (e) {
      console.log('No sub_articles table or error:', e.message);
    }
    
    let voteCounts = [];
    try {
      voteCounts = lawsDb.prepare(`
        SELECT vote, COUNT(*) as count 
        FROM votes 
        WHERE article_id = ?
        GROUP BY vote
      `).all(articleId);
    } catch (e) {
      console.log('No votes table or error:', e.message);
    }
    
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    let userVote = null;
    try {
      userVote = db.prepare(`
        SELECT vote, reasoning FROM law_votes 
        WHERE article_id = ? AND user_ip = ?
      `).get(articleId, userIP);
    } catch (e) {}
    
    res.json({ 
      law,
      article, 
      subArticles,
      votes: voteCounts,
      userVote: userVote || null,
      success: true 
    });
  } catch (error) {
    console.error('Fetch article error:', error);
    res.status(500).json({ error: 'Could not fetch article: ' + error.message, success: false });
  }
});

// GET /api/mvlaws/:id/articles/:articleId/subarticles/:subArticleId - Get sub-article with votes
router.get('/api/mvlaws/:id/articles/:articleId/subarticles/:subArticleId', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available. Set LAWS_DB_PATH environment variable.', success: false });
  }
  
  try {
    const subArticleId = parseInt(req.params.subArticleId);
    
    const subArticle = lawsDb.prepare('SELECT * FROM sub_articles WHERE id = ?').get(subArticleId);
    if (!subArticle) {
      return res.status(404).json({ error: 'Sub-article not found', success: false });
    }
    
    let voteCounts = [];
    try {
      voteCounts = lawsDb.prepare(`
        SELECT vote, COUNT(*) as count 
        FROM sub_article_votes 
        WHERE sub_article_id = ?
        GROUP BY vote
      `).all(subArticleId);
    } catch (e) {
      console.log('No sub_article_votes table yet');
    }
    
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    let userVote = null;
    try {
      userVote = lawsDb.prepare(`
        SELECT vote, reasoning FROM sub_article_votes 
        WHERE sub_article_id = ? AND user_ip = ?
      `).get(subArticleId, userIP);
    } catch (e) {}
    
    res.json({ 
      subArticle, 
      votes: voteCounts,
      userVote: userVote || null,
      success: true 
    });
  } catch (error) {
    console.error('Fetch sub-article error:', error);
    res.status(500).json({ error: 'Could not fetch sub-article: ' + error.message, success: false });
  }
});

  return router;
};
