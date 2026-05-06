const express = require('express');
const router = express.Router();

module.exports = function({ db, lawsDb, getSettings, logActivity, maybeEngageReferral, merit }) {

// ==================== VOTING TABLES ====================
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
  } catch (err) {
    console.log('⚠ Could not create law_votes table:', err.message);
  }

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
  } catch (err) {
    console.log('⚠ Could not create law_level_votes table:', err.message);
  }
}

// GET /api/mvlaws/recent-votes - Get recent votes from all sources (must be before /:id route)
router.get('/api/mvlaws/recent-votes', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available', success: false });
  }
  
  try {
    const lawVotes = lawsDb.prepare(`
      SELECT 
        v.vote,
        v.voted_at,
        v.reasoning,
        a.id as article_id,
        a.article_number,
        a.article_title,
        l.law_name,
        'law' as vote_source
      FROM votes v
      JOIN articles a ON v.article_id = a.id
      JOIN laws l ON a.law_id = l.id
      ORDER BY v.voted_at DESC
      LIMIT 25
    `).all();
    
    let proposalVotes = [];
    try {
      proposalVotes = db.prepare(`
        SELECT 
          v.choice as vote,
          v.voted_at,
          p.title as law_name,
          p.category as article_title,
          NULL as article_number,
          NULL as article_id,
          'proposal' as vote_source
        FROM votes v
        JOIN proposals p ON v.proposal_id = p.id
        ORDER BY v.voted_at DESC
        LIMIT 25
      `).all();
    } catch (e) {}
    
    let rankedVotes = [];
    try {
      rankedVotes = db.prepare(`
        SELECT 
          'ranked' as vote,
          rv.voted_at,
          rp.title as law_name,
          rp.category as article_title,
          NULL as article_number,
          NULL as article_id,
          'ranked' as vote_source
        FROM ranked_votes rv
        JOIN ranked_proposals rp ON rv.proposal_id = rp.id
        ORDER BY rv.voted_at DESC
        LIMIT 25
      `).all();
    } catch (e) {}
    
    const allVotes = [...lawVotes, ...proposalVotes, ...rankedVotes]
      .sort((a, b) => new Date(b.voted_at) - new Date(a.voted_at))
      .slice(0, 50);
    
    res.json({ votes: allVotes, success: true });
  } catch (error) {
    console.error('Recent votes error:', error);
    res.status(500).json({ error: 'Could not fetch recent votes', success: false });
  }
});

// GET /api/mvlaws/top-voted - Get most voted articles and proposals (must be before /:id route)
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
        COUNT(v.id) as total_votes,
        'law' as vote_source
      FROM votes v
      JOIN articles a ON v.article_id = a.id
      JOIN laws l ON a.law_id = l.id
      GROUP BY a.id
      ORDER BY total_votes DESC
      LIMIT 10
    `).all();
    
    let proposals = [];
    try {
      proposals = db.prepare(`
        SELECT 
          p.id as article_id,
          NULL as article_number,
          p.title as article_title,
          p.id as law_id,
          p.title as law_name,
          p.yes_votes as support,
          p.no_votes as oppose,
          COALESCE(p.abstain_votes, 0) as abstain,
          (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id) as total_votes,
          'proposal' as vote_source
        FROM proposals p
        WHERE p.status = 'active'
        ORDER BY total_votes DESC
        LIMIT 10
      `).all();
    } catch (e) {}
    
    const allItems = [...articles, ...proposals]
      .sort((a, b) => b.total_votes - a.total_votes)
      .slice(0, 20);
    
    res.json({ articles: allItems, success: true });
  } catch (error) {
    console.error('Top voted error:', error);
    res.status(500).json({ error: 'Could not fetch top voted articles', success: false });
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
        merit.awardMerit(userId, 'law_vote', s.merit_vote_pass, article_id, 'article', 'Voted on a law article');
        logActivity('law_vote', userId, article_id, { vote, type: 'article' }, req);
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
          merit.awardMerit(signupUser.id, 'law_vote', s.merit_vote_pass, law_id, 'law', 'Voted on a law');
          logActivity('law_vote', signupUser.id, law_id, { vote, type: 'law' }, req);
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

  return router;
};
