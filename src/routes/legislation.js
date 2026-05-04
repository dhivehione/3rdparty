const express = require('express');
const router = express.Router();

module.exports = function({ db, lawsDb, getSettings, maybeEngageReferral }) {

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

// Create sub_article_votes and law_votes tables if lawsDb exists
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

// GET /api/mvlaws/recent-votes - Get recent votes (must be before /:id route)
router.get('/api/mvlaws/recent-votes', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available', success: false });
  }
  
  try {
    const votes = lawsDb.prepare(`
      SELECT 
        v.vote,
        v.voted_at,
        v.reasoning,
        a.id as article_id,
        a.article_number,
        a.article_title,
        l.law_name
      FROM votes v
      JOIN articles a ON v.article_id = a.id
      JOIN laws l ON a.law_id = l.id
      ORDER BY v.voted_at DESC
      LIMIT 50
    `).all();
    
    res.json({ votes, success: true });
  } catch (error) {
    console.error('Recent votes error:', error);
    res.status(500).json({ error: 'Could not fetch recent votes', success: false });
  }
});

// GET /api/mvlaws/top-voted - Get most voted articles (must be before /:id route)
router.get('/api/mvlaws/top-voted', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available', success: false });
  }
  
  try {
    const articles = lawsDb.prepare(`
      SELECT 
        a.id as article_id,
        a.article_number,
        a.article_title,
        l.id as law_id,
        l.law_name,
        SUM(CASE WHEN v.vote = 'support' THEN 1 ELSE 0 END) as support,
        SUM(CASE WHEN v.vote = 'oppose' THEN 1 ELSE 0 END) as oppose,
        SUM(CASE WHEN v.vote = 'abstain' THEN 1 ELSE 0 END) as abstain,
        COUNT(v.id) as total_votes
      FROM votes v
      JOIN articles a ON v.article_id = a.id
      JOIN laws l ON a.law_id = l.id
      GROUP BY a.id
      ORDER BY total_votes DESC
      LIMIT 20
    `).all();
    
    res.json({ articles, success: true });
  } catch (error) {
    console.error('Top voted error:', error);
    res.status(500).json({ error: 'Could not fetch top voted articles', success: false });
  }
});

// GET /api/mvlaws/:id - Get law with articles
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

// POST /api/mvlaws/vote-subarticle - Vote on a sub-article/clause
router.post('/api/mvlaws/vote-subarticle', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available', success: false });
  }
  
  const { sub_article_id, vote, reasoning } = req.body;
  
  if (!sub_article_id) {
    return res.status(400).json({ error: 'Sub-article ID required', success: false });
  }
  
  if (!['support', 'oppose', 'abstain'].includes(vote)) {
    return res.status(400).json({ error: 'Invalid vote. Must be: support, oppose, or abstain', success: false });
  }

  const userIP = req.ip || req.connection.remoteAddress || 'unknown';
  const cooldownAgo = new Date(Date.now() - getSettings().vote_cooldown_ms).toISOString();
  
  const recentVote = lawsDb.prepare(`
    SELECT id FROM sub_article_votes 
    WHERE sub_article_id = ? AND user_ip = ? AND voted_at > ?
    LIMIT 1
  `).get(sub_article_id, userIP, cooldownAgo);
  
  if (recentVote) {
    return res.status(429).json({ error: 'Please wait before voting again', success: false });
  }

  try {
    const votedAt = new Date().toISOString();
    
    const existing = lawsDb.prepare(`
      SELECT id FROM sub_article_votes 
      WHERE sub_article_id = ? AND user_ip = ?
    `).get(sub_article_id, userIP);
    
    if (existing) {
      lawsDb.prepare(`
        UPDATE sub_article_votes SET vote = ?, reasoning = ?, voted_at = ? 
        WHERE id = ?
      `).run(vote, reasoning || null, votedAt, existing.id);
    } else {
      lawsDb.prepare(`
        INSERT INTO sub_article_votes (sub_article_id, vote, reasoning, voted_at, user_ip)
        VALUES (?, ?, ?, ?, ?)
      `).run(sub_article_id, vote, reasoning || null, votedAt, userIP);
    }
    
    res.json({ message: 'Vote recorded!', success: true });
  } catch (error) {
    console.error('Sub-article vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
  }
});

// POST /api/mvlaws/vote - Vote on an article (requires signup)
router.post('/api/mvlaws/vote', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available', success: false });
  }
  
  const { article_id, vote, reasoning, phone } = req.body;
  
  if (!article_id) {
    return res.status(400).json({ error: 'Article ID required', success: false });
  }
  
  if (!['support', 'oppose', 'abstain'].includes(vote)) {
    return res.status(400).json({ error: 'Invalid vote. Must be: support, oppose, or abstain', success: false });
  }
  
let userId = null;
  if (phone) {
    const user = db.prepare('SELECT id FROM signups WHERE phone = ?').get(phone);
    if (user) userId = user.id;
  }

  const userIP = req.ip || req.connection.remoteAddress || 'unknown';
  const cooldownAgo = new Date(Date.now() - getSettings().vote_cooldown_ms).toISOString();
  
  const recentVote = lawsDb.prepare(`
    SELECT id FROM votes 
    WHERE (user_id = ? OR user_ip = ?) AND voted_at > ?
    LIMIT 1
  `).get(userId || -1, userIP, cooldownAgo);
  
  if (recentVote) {
    return res.status(429).json({ error: 'Please wait before voting again', success: false });
  }

  try {
    const votedAt = new Date().toISOString();
    
    const existing = lawsDb.prepare(`
      SELECT id FROM votes 
      WHERE article_id = ? AND (user_id = ? OR user_ip = ?)
    `).get(article_id, userId || -1, userIP);
    
    if (existing) {
      lawsDb.prepare(`
        UPDATE votes SET vote = ?, reasoning = ?, voted_at = ? 
        WHERE id = ?
      `).run(vote, reasoning || null, votedAt, existing.id);
    } else {
      lawsDb.prepare(`
        INSERT INTO votes (article_id, user_id, vote, reasoning, voted_at, user_ip)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(article_id, userId, vote, reasoning || null, votedAt, userIP);
      if (userId) {
        const s = getSettings();
        db.prepare(`
          INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
          VALUES (?, 'law_vote', ?, ?, 'article', 'Voted on a law article', ?)
        `).run(userId, s.merit_vote_pass || 2.5, article_id, votedAt);
        maybeEngageReferral(userId);
      }
    }
    
    res.json({ message: 'Vote recorded!', success: true });
  } catch (error) {
    console.error('Law vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
  }
});

// POST /api/mvlaws/vote-law - Vote on an entire law (law-level voting)
router.post('/api/mvlaws/vote-law', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available', success: false });
  }
  
  const { law_id, vote, reasoning, phone } = req.body;
  
  if (!law_id) {
    return res.status(400).json({ error: 'Law ID required', success: false });
  }
  
  if (!['support', 'oppose', 'abstain'].includes(vote)) {
    return res.status(400).json({ error: 'Invalid vote. Must be: support, oppose, or abstain', success: false });
  }
  
  const userIP = req.ip || req.connection.remoteAddress || 'unknown';
  const cooldownAgo = new Date(Date.now() - getSettings().vote_cooldown_ms).toISOString();
  
  const recentVote = lawsDb.prepare(`
    SELECT id FROM law_level_votes 
    WHERE law_id = ? AND (user_ip = ? OR user_phone = ?) AND voted_at > ?
    LIMIT 1
  `).get(law_id, userIP, phone || '', cooldownAgo);
  
  if (recentVote) {
    return res.status(429).json({ error: 'Please wait before voting on this law again', success: false });
  }
  
  try {
    const votedAt = new Date().toISOString();
    
    const existing = lawsDb.prepare(`
      SELECT id FROM law_level_votes 
      WHERE law_id = ? AND (user_ip = ? OR user_phone = ?)
    `).get(law_id, userIP, phone || '');
    
    if (existing) {
      lawsDb.prepare(`
        UPDATE law_level_votes SET vote = ?, reasoning = ?, voted_at = ?, user_phone = ? 
        WHERE id = ?
      `).run(vote, reasoning || null, votedAt, phone || null, existing.id);
    } else {
      lawsDb.prepare(`
        INSERT INTO law_level_votes (law_id, vote, reasoning, voted_at, user_ip, user_phone)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(law_id, vote, reasoning || null, votedAt, userIP, phone || null);
      if (phone) {
        const signupUser = db.prepare('SELECT id FROM signups WHERE phone = ?').get(phone);
        if (signupUser) {
          const s = getSettings();
          db.prepare(`
            INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
            VALUES (?, 'law_vote', ?, ?, 'law', 'Voted on a law', ?)
          `).run(signupUser.id, s.merit_vote_pass || 2.5, law_id, votedAt);
          maybeEngageReferral(signupUser.id);
        }
      }
    }
    
    res.json({ message: 'Law vote recorded!', success: true });
  } catch (error) {
    console.error('Law-level vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
  }
});

// GET /api/mvlaws/:id/law-votes - Get law-level votes for a law
router.get('/api/mvlaws/:id/law-votes', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available', success: false });
  }
  
  try {
    const lawId = parseInt(req.params.id);
    
    const voteCounts = lawsDb.prepare(`
      SELECT vote, COUNT(*) as count 
      FROM law_level_votes 
      WHERE law_id = ?
      GROUP BY vote
    `).all(lawId);
    
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    let userVote = null;
    try {
      userVote = lawsDb.prepare(`
        SELECT vote, reasoning FROM law_level_votes 
        WHERE law_id = ? AND (user_ip = ? OR user_phone = ?)
      `).get(lawId, userIP, req.query.phone || '');
    } catch (e) {}
    
    res.json({ 
      votes: voteCounts,
      userVote: userVote || null,
      success: true 
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch law votes', success: false });
  }
});

// ==================== AI LAW DRAFT GENERATION ====================

const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL || 'openai/gpt-4o').trim();
const OPENROUTER_FALLBACK_MODEL = (process.env.OPENROUTER_FALLBACK_MODEL || 'openai/gpt-oss-120b:free').trim();

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'dare',
  'ought', 'used', 'this', 'that', 'these', 'those', 'i', 'we', 'you',
  'he', 'she', 'it', 'they', 'me', 'him', 'her', 'us', 'them', 'my',
  'our', 'your', 'his', 'its', 'their', 'not', 'no', 'nor', 'so',
  'if', 'then', 'than', 'too', 'very', 'just', 'about', 'above',
  'after', 'again', 'all', 'also', 'any', 'because', 'before',
  'between', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'only', 'own', 'same', 'into', 'over', 'under', 'up', 'out',
  'down', 'off', 'here', 'there', 'when', 'where', 'why', 'how',
  'which', 'who', 'whom', 'what', 's', 't', 'd', 'll', 've', 're',
  'm', 'nt', 'don', 'doesn', 'isn', 'wasn', 'weren', 'hasn',
  'haven', 'hadn', 'won', 'wouldn', 'couldn', 'shouldn', 'mightn',
  'mustn', 'needn', 'oughtn'
]);

function extractKeywords(text) {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(e => e[0]);
}

function searchLawsForKeywords(keywords) {
  if (!lawsDb || keywords.length === 0) return [];
  const results = [];

  try {
    for (const kw of keywords) {
      const like = `%${kw.replace(/[%_]/g, '\\$&')}%`;
      const clauses = lawsDb.prepare(`
        SELECT sa.text_content, sa.sub_article_label, a.article_title, a.article_number, l.law_name, l.category_name
        FROM sub_articles sa
        JOIN articles a ON sa.article_id = a.id
        JOIN laws l ON a.law_id = l.id
        WHERE sa.text_content LIKE ?
        LIMIT 8
      `).all(like);
      for (const c of clauses) {
        const key = `${c.law_name}|||${c.article_number}|||${c.sub_article_label}`;
        if (!results.find(r => r.key === key)) {
          results.push({ ...c, key });
        }
      }
      if (results.length >= 20) break;
    }
  } catch (e) {
    console.error('Law keyword search error:', e);
  }

  return results.slice(0, 20);
}

async function tryOpenRouterModel(model, systemPrompt, userPrompt) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 4096,
      temperature: 0.7
    })
  });

  const rawBody = await response.text();

  if (!response.ok) {
    let errInfo = rawBody;
    try { errInfo = JSON.parse(rawBody).error?.message || rawBody; } catch (e) {}
    throw new Error(`OpenRouter returned ${response.status}: ${errInfo}`);
  }

  if (!rawBody || rawBody.trim().length === 0) {
    throw new Error('OpenRouter returned an empty response');
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    console.error(`OpenRouter parse error (model: ${model}). Raw body (first 500 chars):`, rawBody.substring(0, 500));
    throw new Error('Failed to parse OpenRouter response');
  }

  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    console.error(`OpenRouter unexpected response structure (model: ${model}):`, JSON.stringify(data).substring(0, 500));
    throw new Error('OpenRouter returned an unexpected response structure');
  }

  return data.choices[0].message.content;
}

async function callOpenRouter(systemPrompt, userPrompt) {
  try {
    console.log(`[OpenRouter] Trying primary model: ${OPENROUTER_MODEL}`);
    const content = await tryOpenRouterModel(OPENROUTER_MODEL, systemPrompt, userPrompt);
    return { content, model: OPENROUTER_MODEL, fallback_used: false };
  } catch (primaryError) {
    console.warn(`[OpenRouter] Primary model failed: ${primaryError.message}`);
    console.log(`[OpenRouter] Falling back to: ${OPENROUTER_FALLBACK_MODEL}`);
    const content = await tryOpenRouterModel(OPENROUTER_FALLBACK_MODEL, systemPrompt, userPrompt);
    return { content, model: OPENROUTER_FALLBACK_MODEL, fallback_used: true };
  }
}

// POST /api/generate-law-draft - Generate a law draft from a seed idea
router.post('/api/generate-law-draft', async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'AI service not configured. Set OPENROUTER_API_KEY.', success: false });
  }

  const { seed_idea } = req.body;

  if (!seed_idea || seed_idea.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide a seed idea (at least 10 characters)', success: false });
  }

  try {
    const keywords = extractKeywords(seed_idea);
    const relevantClauses = searchLawsForKeywords(keywords);

    let clausesContext = '';
    if (relevantClauses.length > 0) {
      clausesContext = relevantClauses.map((c, i) =>
        `[${i + 1}] Law: ${c.law_name} | Article ${c.article_number}: ${c.article_title} | Clause ${c.sub_article_label}: ${c.text_content}`
      ).join('\n');
    }

    const systemPrompt = `You are a legal drafting assistant for the Maldives. Given a seed idea, produce a well-structured draft using proper legal formatting.

IMPORTANT — First, determine the appropriate scope:
- "law" - Broad, multi-section legislation that establishes a new regulatory framework
- "regulation" - Specific rules under an existing law, narrower in scope
- "clause" - A single provision or amendment to an existing law

The FIRST LINE of your response MUST be: **Draft Type:** law (or regulation, or clause)

Then structure your response with these sections (each required section MUST start with ## ):

## Executive Summary
A concise, plain-language summary of the proposal in 3-5 bullet points, written for citizens who won't read the full legal text. Summarize: (1) What problem this solves, (2) What the law proposes to do, (3) Who is affected, (4) Key obligations/rights created, (5) How it will be enforced. Use simple language — no legal jargon.

## Title
A clear, concise title for the proposal.

## Preamble
A brief statement of purpose and rationale (2-3 sentences).

## Definitions
Key terms defined precisely (if applicable).

## Provisions
Numbered sections. Each section should have:
- A clear heading
- Specific requirements, prohibitions, or permissions
- Enforcement mechanisms where appropriate

## Penalties / Enforcement
Consequences for non-compliance (if applicable).

## Commencement
When the law takes effect.

Draft in a formal legal style. Use "shall" for obligations, "may" for permissions. Be specific and enforceable. Keep the draft proportional to the scope — a clause should be a few paragraphs, a law can be several pages. Do NOT include placeholder text or markdown formatting instructions in the output.`;

    let userPrompt = `Seed idea: ${seed_idea.trim()}\n\n`;

    if (clausesContext) {
      userPrompt += `Here are relevant existing Maldivian law clauses for reference and inspiration:\n\n${clausesContext}\n\n`;
    }

    userPrompt += 'Analyze the seed idea above and generate an appropriate draft. Remember: the first line must indicate the draft type.';

    const result = await callOpenRouter(systemPrompt, userPrompt);
    const rawDraft = result.content;

    let detectedType = 'law';
    let draft = rawDraft;
    const typeMatch = rawDraft.match(/^\*\*Draft Type:\*\*\s*(law|regulation|clause)/im);
    if (typeMatch) {
      detectedType = typeMatch[1].toLowerCase();
      draft = rawDraft.replace(/^\*\*Draft Type:.*?\*\*\s*\n?/im, '').trim();
    }

    let executiveSummary = '';
    const summaryMatch = draft.match(/##\s*Executive Summary\s*\n([\s\S]*?)(?=\n##\s)/);
    if (summaryMatch) {
      executiveSummary = summaryMatch[1].trim();
      draft = draft.replace(/##\s*Executive Summary\s*\n[\s\S]*?(?=\n##\s)/, '').trim();
    }

    res.json({
      success: true,
      draft,
      executive_summary: executiveSummary,
      detected_type: detectedType,
      model_used: result.model,
      fallback_used: result.fallback_used,
      keywords_used: keywords,
      clauses_referenced: relevantClauses.length,
      relevant_clauses: relevantClauses.map(c => ({
        law_name: c.law_name,
        category_name: c.category_name,
        article_number: c.article_number,
        article_title: c.article_title,
        sub_article_label: c.sub_article_label,
        text_content: c.text_content
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Generate law draft error:', error);
    res.status(500).json({ error: 'Failed to generate draft: ' + error.message, success: false });
  }
});

  return router;
};
