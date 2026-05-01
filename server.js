const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== SIMPLE ANALYTICS - ACTIVE VISITORS ====================
// Store active visitors: { sessionId: timestamp }
// Sessions expire after 5 minutes of inactivity
const activeVisitors = new Map();
const VISITOR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function getClientIp(req) {
  return req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
}

function cleanupExpiredVisitors() {
  const now = Date.now();
  for (const [sessionId, lastSeen] of activeVisitors.entries()) {
    if (now - lastSeen > VISITOR_TIMEOUT_MS) {
      activeVisitors.delete(sessionId);
    }
  }
}

setInterval(cleanupExpiredVisitors, 60000);

// ==================== DATABASE SETUP ====================
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'signups.db'));

// Laws database (from mvlaws project) - check multiple common paths
const possiblePaths = [
  process.env.LAWS_DB_PATH,
  '/app/data/laws.db',
  '/data/laws.db',
  path.join(dataDir, 'laws.db')
].filter(p => p && fs.existsSync(p));

const lawsDbPath = possiblePaths[0] || null;

let lawsDb = null;
if (lawsDbPath) {
  try {
    lawsDb = new Database(lawsDbPath);
    console.log('✓ Laws database connected:', lawsDbPath);
  } catch (err) {
    console.log('⚠ Could not open laws database:', err.message);
  }
} else {
  console.log('⚠ Laws database not found. Checked: /app/data/laws.db, /data/laws.db, ./data/laws.db');
  console.log('⚠ Set LAWS_DB_PATH environment variable to point to laws.db');
}

// Create table with updated schema
db.exec(`
  CREATE TABLE IF NOT EXISTS signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    nid TEXT NOT NULL,
    name TEXT,
    username TEXT,
    email TEXT,
    island TEXT,
    contribution_type TEXT,
    donation_amount REAL DEFAULT 0,
    initial_merit_estimate INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 1,
    auth_token TEXT,
    unregistered_at TEXT,
    unregistered_by TEXT,
    unregister_justification TEXT,
    timestamp TEXT NOT NULL
  )
`);

// Migration: Add missing columns to existing signups table
const signupMigrations = [
  { col: 'is_verified', def: 'INTEGER DEFAULT 1' },
  { col: 'username', def: 'TEXT' },
  { col: 'auth_token', def: 'TEXT' },
  { col: 'unregistered_at', def: 'TEXT' },
  { col: 'unregistered_by', def: 'TEXT' },
  { col: 'unregister_justification', def: 'TEXT' }
];

signupMigrations.forEach(m => {
  try {
    db.exec(`ALTER TABLE signups ADD COLUMN ${m.col} ${m.def}`);
    console.log(`✓ Migration: Added ${m.col} to signups`);
  } catch (e) {
    // Column already exists or other error - ignore
  }
});

// Referrals table - track who introduced whom
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referred_id INTEGER NOT NULL,
    relation TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    base_reward_given INTEGER DEFAULT 0,
    engagement_bonus_given INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    referred_joined_at TEXT,
    first_action_at TEXT,
    FOREIGN KEY (referrer_id) REFERENCES signups(id),
    FOREIGN KEY (referred_id) REFERENCES signups(id)
  )
`);

// System-wide activity log for tracing issues and disputes
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    user_id INTEGER,
    target_id INTEGER,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    timestamp TEXT NOT NULL
  )
`);

// Public wall posts table (no signup required)
db.exec(`
  CREATE TABLE IF NOT EXISTS wall_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    message TEXT NOT NULL,
    is_approved INTEGER DEFAULT 1,
    timestamp TEXT NOT NULL
  )
`);

// Policy proposals table
db.exec(`
  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    created_by_nickname TEXT,
    status TEXT DEFAULT 'active',
    yes_votes INTEGER DEFAULT 0,
    no_votes INTEGER DEFAULT 0,
    abstain_votes INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    ends_at TEXT NOT NULL
  )
`);

// Votes table (anyone can vote, tracked by IP for demo purposes)
db.exec(`
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    choice TEXT NOT NULL CHECK(choice IN ('yes', 'no', 'abstain')),
    voter_ip TEXT,
    voted_at TEXT NOT NULL,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id)
  )
`);

// Ranked choice proposals (multiple options to rank)
db.exec(`
  CREATE TABLE IF NOT EXISTS ranked_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT DEFAULT 'election',
    options TEXT NOT NULL,
    created_by_nickname TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL,
    ends_at TEXT NOT NULL
  )
`);

// Ranked choice votes (stored as JSON ranking)
db.exec(`
  CREATE TABLE IF NOT EXISTS ranked_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    ranking TEXT NOT NULL,
    voter_ip TEXT,
    voted_at TEXT NOT NULL,
    FOREIGN KEY (proposal_id) REFERENCES ranked_proposals(id)
  )
`);

// Laws/Regulations (for the legislature page)
db.exec(`
  CREATE TABLE IF NOT EXISTS laws (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT DEFAULT 'policy',
    source_proposal_id INTEGER,
    status TEXT DEFAULT 'proposed',
    passed_at TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT
  )
`);

console.log('✓ SQLite database initialized for 3d Party');

// Law votes table for article-level voting
db.exec(`
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

// ==================== LEADERSHIP STRUCTURE TABLES ====================

// Leadership settings (threshold, term limits, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS leadership_settings (
    id INTEGER PRIMARY KEY,
    member_threshold INTEGER DEFAULT 1000,
    min_merit_for_leadership INTEGER DEFAULT 500,
    max_term_years INTEGER DEFAULT 2,
    appraisal_frequency_days INTEGER DEFAULT 365,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// Initialize default settings
const existingSettings = db.prepare('SELECT id FROM leadership_settings').get();
if (!existingSettings) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO leadership_settings (id, member_threshold, min_merit_for_leadership, max_term_years, appraisal_frequency_days, created_at, updated_at) VALUES (1, 1000, 500, 2, 365, ?, ?)').run(now, now);
}

// Leadership positions (Shadow Ministers, Committee Chairs, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS leadership_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    position_type TEXT NOT NULL CHECK(position_type IN ('council', 'committee', 'hub', 'advisory', 'emeritus')),
    min_merit_required INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  )
`);

// Initialize default positions
const existingPositions = db.prepare('SELECT COUNT(*) as cnt FROM leadership_positions').get();
if (existingPositions.cnt === 0) {
  const now = new Date().toISOString();
  const positions = [
    { title: 'Shadow President', description: 'Leader of the Governing Council', type: 'council', min_merit: 1000 },
    { title: 'Shadow Finance Minister', description: 'Oversees treasury and budgets', type: 'council', min_merit: 800 },
    { title: 'Shadow Foreign Minister', description: 'External relations and outreach', type: 'council', min_merit: 800 },
    { title: 'Shadow Education Minister', description: 'Policy and planning for education', type: 'council', min_merit: 800 },
    { title: 'Shadow Health Minister', description: 'Healthcare policy and planning', type: 'council', min_merit: 800 },
    { title: 'Integrity Committee Chair', description: 'Leads ethics and conduct investigations', type: 'committee', min_merit: 600 },
    { title: 'Verification Committee Chair', description: 'Manages member verification', type: 'committee', min_merit: 500 },
    { title: 'Policy Hub Lead', description: 'Coordinates Policy Incubation Hubs', type: 'hub', min_merit: 700 },
  ];
  const insertStmt = db.prepare('INSERT INTO leadership_positions (title, description, position_type, min_merit_required, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)');
  positions.forEach(p => insertStmt.run(p.title, p.description, p.type, p.min_merit, now));
}

// Leadership applications
db.exec(`
  CREATE TABLE IF NOT EXISTS leadership_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    position_id INTEGER NOT NULL,
    application_text TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'interview', 'approved', 'rejected')),
    merit_score_at_apply INTEGER NOT NULL,
    interview_scheduled_at TEXT,
    interview_video_url TEXT,
    interview_notes TEXT,
    applied_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES signups(id),
    FOREIGN KEY (position_id) REFERENCES leadership_positions(id)
  )
`);

// Leadership terms (elected/appointed leaders)
db.exec(`
  CREATE TABLE IF NOT EXISTS leadership_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    position_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    term_number INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES signups(id),
    FOREIGN KEY (position_id) REFERENCES leadership_positions(id)
  )
`);

// Performance appraisals
db.exec(`
  CREATE TABLE IF NOT EXISTS leadership_appraisals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term_id INTEGER NOT NULL,
    appraisal_period TEXT NOT NULL,
    rating INTEGER CHECK(rating BETWEEN 1 AND 5),
    strengths TEXT,
    areas_for_improvement TEXT,
    overall_feedback TEXT,
    appraisal_by_user_id INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (term_id) REFERENCES leadership_terms(id)
  )
`);

// Standard Operating Procedures (SOPs)
db.exec(`
  CREATE TABLE IF NOT EXISTS leadership_sops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    version INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// Initialize default SOPs
const existingSOPs = db.prepare('SELECT COUNT(*) as cnt FROM leadership_sops').get();
if (existingSOPs.cnt === 0) {
  const now = new Date().toISOString();
  const sops = [
    { title: 'Daily Management Duties', content: 'Leadership must: 1) Respond to member queries within 24 hours. 2) Review and process pending proposals. 3) Update dashboard with current status. 4) Attend scheduled council meetings. 5) Document all decisions in Decision Statements.', category: 'operations' },
    { title: 'Meeting Protocol', content: 'All leadership meetings: 1) Must have published agenda 24h in advance. 2) Quorum required (50%+1). 3) Minutes published within 48h. 4) Decisions require documented vote count.', category: 'governance' },
    { title: 'Financial Oversight', content: 'Treasury management: 1) All expenditures over 1% budget require public vote. 2) Monthly financial reports published. 3) Independent audit annually. 4) Donation sources publicly logged.', category: 'finance' },
    { title: 'Conflict Resolution', content: 'Disputes handled by: 1) Initial mediation within 7 days. 2) Committee review if unresolved. 3) Full council vote for serious issues. 4) All decisions documented and published.', category: 'governance' },
    { title: 'Recall Process', content: 'Leadership recall: 1) Requires petition of 10% members. 2) Super-majority (80%) vote to remove. 3) Immediate suspension during process. 4) Right to appeal within 14 days.', category: 'accountability' },
  ];
  const insertSOP = db.prepare('INSERT INTO leadership_sops (title, content, category, version, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)');
  sops.forEach(s => insertSOP.run(s.title, s.content, s.category, now, now));
}

console.log('✓ Leadership structure tables initialized');

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ==================== ANALYTICS API ====================
// POST /api/analytics/heartbeat - Track active visitor
app.post('/api/analytics/heartbeat', (req, res) => {
  const sessionId = req.body.session_id || getClientIp(req);
  activeVisitors.set(sessionId, Date.now());
  res.json({ success: true, active_count: activeVisitors.size });
});

// GET /api/analytics/active - Get active visitor count
app.get('/api/analytics/active', (req, res) => {
  cleanupExpiredVisitors();
  res.json({ active: activeVisitors.size, success: true });
});

// ==================== AUTH MIDDLEWARE ====================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '3dparty2024admin';

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Nice try, insurance agent. Wrong password.' });
  }
  next();
}

// ==================== PUBLIC WALL API (No Signup Required) ====================
// GET /api/wall - Get all posts
app.get('/api/wall', (req, res) => {
  try {
    const posts = db.prepare('SELECT * FROM wall_posts WHERE is_approved = 1 ORDER BY timestamp DESC LIMIT 100').all();
    const count = db.prepare('SELECT COUNT(*) as total FROM wall_posts WHERE is_approved = 1').get();
    res.json({ posts, total: count.total, success: true });
  } catch (error) {
    console.error('Wall fetch error:', error);
    res.status(500).json({ error: 'Could not fetch posts', success: false });
  }
});

// ==================== PROPOSALS API (Demo - No Signup Required) ====================
// GET /api/proposals - Get all active proposals
app.get('/api/proposals', (req, res) => {
  try {
    const proposals = db.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id) as vote_count
      FROM proposals p 
      WHERE p.status = 'active' 
      ORDER BY p.created_at DESC
    `).all();
    
    // Get user votes by IP (for demo purposes)
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    const userVotes = db.prepare('SELECT proposal_id, choice FROM votes WHERE voter_ip = ?').all(userIP);
    const userVotesMap = {};
    userVotes.forEach(v => userVotesMap[v.proposal_id] = v.choice);
    
    proposals.forEach(p => {
      p.userVote = userVotesMap[p.id] || null;
    });
    
    res.json({ proposals, success: true });
  } catch (error) {
    console.error('Proposals fetch error:', error);
    res.status(500).json({ error: 'Could not fetch proposals', success: false });
  }
});

// POST /api/proposals - Create a new proposal (demo - no signup required)
app.post('/api/proposals', (req, res) => {
  const { title, description, category, nickname } = req.body;
  
  if (!title || title.trim().length < 5) {
    return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
  }
  
  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description must be at least 20 characters', success: false });
  }
  
  try {
    const createdAt = new Date().toISOString();
    // Demo: 7 day voting period
    const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO proposals (title, description, category, created_by_nickname, created_at, ends_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      title.trim().substring(0, 200),
      description.trim().substring(0, 2000),
      category || 'general',
      nickname ? nickname.trim().substring(0, 50) : 'Anonymous',
      createdAt,
      endsAt
    );
    
    res.status(201).json({ 
      message: 'Proposal created! Members can now vote.',
      success: true,
      id: result.lastInsertRowid
    });
  } catch (error) {
    console.error('Proposal create error:', error);
    res.status(500).json({ error: 'Could not create proposal', success: false });
  }
});

// POST /api/vote - Vote on a proposal
app.post('/api/vote', (req, res) => {
  const { proposal_id, choice } = req.body;
  
  if (!proposal_id) {
    return res.status(400).json({ error: 'Proposal ID required', success: false });
  }
  
  if (!['yes', 'no', 'abstain'].includes(choice)) {
    return res.status(400).json({ error: 'Invalid choice', success: false });
  }
  
  try {
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    const votedAt = new Date().toISOString();
    
    // Check if already voted
    const existingVote = db.prepare('SELECT id FROM votes WHERE proposal_id = ? AND voter_ip = ?').get(proposal_id, userIP);
    if (existingVote) {
      // Update existing vote
      db.prepare('UPDATE votes SET choice = ?, voted_at = ? WHERE id = ?').run(choice, votedAt, existingVote.id);
    } else {
      // Insert new vote
      db.prepare('INSERT INTO votes (proposal_id, choice, voter_ip, voted_at) VALUES (?, ?, ?, ?)').run(proposal_id, choice, userIP, votedAt);
    }
    
    // Update proposal counts
    const counts = db.prepare(`
      SELECT choice, COUNT(*) as cnt FROM votes WHERE proposal_id = ? GROUP BY choice
    `).all(proposal_id);
    
    let yes = 0, no = 0, abstain = 0;
    counts.forEach(c => {
      if (c.choice === 'yes') yes = c.cnt;
      if (c.choice === 'no') no = c.cnt;
      if (c.choice === 'abstain') abstain = c.cnt;
    });
    
    db.prepare('UPDATE proposals SET yes_votes = ?, no_votes = ?, abstain_votes = ? WHERE id = ?').run(yes, no, abstain, proposal_id);
    
    res.json({ message: 'Vote recorded!', success: true });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
  }
});

// GET /api/proposal-stats - Get proposal engagement stats
app.get('/api/proposal-stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as total FROM proposals WHERE status = ?').get('active');
    const totalVotes = db.prepare('SELECT COUNT(*) as total FROM votes').get();
    const openProposals = db.prepare(`
      SELECT COUNT(*) as total FROM proposals 
      WHERE status = 'active' AND datetime(ends_at) > datetime('now')
    `).get();
    
    res.json({ 
      totalProposals: total.total,
      totalVotes: totalVotes.total,
      openProposals: openProposals.total,
      success: true 
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats', success: false });
  }
});

// ==================== RANKED CHOICE VOTING API ====================
// GET /api/ranked-proposals - Get all ranked choice proposals
app.get('/api/ranked-proposals', (req, res) => {
  try {
    const proposals = db.prepare(`
      SELECT * FROM ranked_proposals 
      WHERE status = 'active' 
      ORDER BY created_at DESC
    `).all();
    
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    
    // Parse options and get user votes
    proposals.forEach(p => {
      p.options = JSON.parse(p.options);
      const userVote = db.prepare('SELECT ranking FROM ranked_votes WHERE proposal_id = ? AND voter_ip = ?').get(p.id, userIP);
      p.userRanking = userVote ? JSON.parse(userVote.ranking) : null;
      
      // Calculate instant runoff winner
      p.results = calculateRankedResults(p.id, p.options);
    });
    
    res.json({ proposals, success: true });
  } catch (error) {
    console.error('Ranked proposals error:', error);
    res.status(500).json({ error: 'Could not fetch proposals', success: false });
  }
});

// Helper: Calculate ranked choice winner
function calculateRankedResults(proposalId, options) {
  const votes = db.prepare('SELECT ranking FROM ranked_votes WHERE proposal_id = ?').all(proposalId);
  
  if (votes.length === 0) return { winner: null, rounds: [], totalVotes: 0 };
  
  const rounds = [];
  let remaining = [...options];
  let voteData = votes.map(v => JSON.parse(v.ranking));
  
  while (remaining.length > 1) {
    // Count first-choice votes
    const counts = {};
    remaining.forEach(opt => counts[opt] = 0);
    voteData.forEach(ranking => {
      const firstChoice = ranking.find(r => remaining.includes(r));
      if (firstChoice) counts[firstChoice]++;
    });
    
    const roundResult = { ...counts };
    rounds.push(roundResult);
    
    // Check for majority
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const leader = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    
    if (leader[1] > total / 2) {
      return { winner: leader[0], rounds, totalVotes: votes.length };
    }
    
    // Eliminate lowest
    const loser = Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
    remaining = remaining.filter(r => r !== loser);
  }
  
  return { winner: remaining[0], rounds, totalVotes: votes.length };
}

// POST /api/ranked-proposals - Create ranked choice proposal
app.post('/api/ranked-proposals', (req, res) => {
  const { title, description, category, options, nickname } = req.body;
  
  if (!title || title.trim().length < 5) {
    return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
  }
  
  if (!options || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'At least 2 options required', success: false });
  }
  
  try {
    const createdAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO ranked_proposals (title, description, category, options, created_by_nickname, created_at, ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      title.trim().substring(0, 200),
      description.trim().substring(0, 2000),
      category || 'election',
      JSON.stringify(options.map(o => o.trim()).filter(o => o)),
      nickname ? nickname.trim().substring(0, 50) : 'Anonymous',
      createdAt,
      endsAt
    );
    
    res.status(201).json({ message: 'Ranked choice proposal created!', success: true, id: result.lastInsertRowid });
  } catch (error) {
    console.error('Ranked proposal error:', error);
    res.status(500).json({ error: 'Could not create proposal', success: false });
  }
});

// POST /api/ranked-vote - Vote on ranked choice proposal
app.post('/api/ranked-vote', (req, res) => {
  const { proposal_id, ranking } = req.body;
  
  if (!proposal_id) return res.status(400).json({ error: 'Proposal ID required', success: false });
  if (!ranking || !Array.isArray(ranking) || ranking.length < 2) {
    return res.status(400).json({ error: 'Must rank at least 2 options', success: false });
  }
  
  try {
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    const votedAt = new Date().toISOString();
    
    // Check if already voted
    const existing = db.prepare('SELECT id FROM ranked_votes WHERE proposal_id = ? AND voter_ip = ?').get(proposal_id, userIP);
    if (existing) {
      db.prepare('UPDATE ranked_votes SET ranking = ?, voted_at = ? WHERE id = ?').run(JSON.stringify(ranking), votedAt, existing.id);
    } else {
      db.prepare('INSERT INTO ranked_votes (proposal_id, ranking, voter_ip, voted_at) VALUES (?, ?, ?, ?)').run(proposal_id, JSON.stringify(ranking), userIP, votedAt);
    }
    
    res.json({ message: 'Vote recorded!', success: true });
  } catch (error) {
    console.error('Ranked vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
  }
});

// ==================== LEGISLATURE API ====================
// GET /api/legislation - Get all laws/proposals (passed and active)
app.get('/api/legislation', (req, res) => {
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
app.get('/api/legislation-stats', (req, res) => {
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
app.get('/api/mvlaws', (req, res) => {
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

// GET /api/mvlaws/:id - Get law with articles
app.get('/api/mvlaws/:id', (req, res) => {
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
app.get('/api/mvlaws/:id/articles/:articleId', (req, res) => {
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
app.get('/api/mvlaws/:id/articles/:articleId/subarticles/:subArticleId', (req, res) => {
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
app.post('/api/mvlaws/vote-subarticle', (req, res) => {
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
  const oneHourAgo = new Date(Date.now() - 60*60*1000).toISOString();
  
  const recentVote = lawsDb.prepare(`
    SELECT id FROM sub_article_votes 
    WHERE sub_article_id = ? AND user_ip = ? AND voted_at > ?
    LIMIT 1
  `).get(sub_article_id, userIP, oneHourAgo);
  
  if (recentVote) {
    return res.status(429).json({ error: 'Please wait an hour before voting again', success: false });
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
app.post('/api/mvlaws/vote', (req, res) => {
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
  const oneHourAgo = new Date(Date.now() - 60*60*1000).toISOString();
  
  const recentVote = lawsDb.prepare(`
    SELECT id FROM votes 
    WHERE (user_id = ? OR user_ip = ?) AND voted_at > ?
    LIMIT 1
  `).get(userId || -1, userIP, oneHourAgo);
  
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
    }
    
    res.json({ message: 'Vote recorded!', success: true });
  } catch (error) {
    console.error('Law vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
  }
});

// GET /api/mvlaws/search - Search laws, articles, and clauses
app.get('/api/mvlaws/search', (req, res) => {
  if (!lawsDb) {
    return res.status(503).json({ error: 'Laws database not available. Set LAWS_DB_PATH environment variable.', success: false });
  }
  
  try {
    const { 
      q,                    // search query (keywords)
      match = 'any',        // match type: 'any' (OR) or 'all' (AND) for multiple keywords
      category,             // filter by category
      law_id,              // filter by specific law
      include_clauses = 'true'  // whether to include clause/sub-article content in search
    } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters', success: false });
    }
    
    // Parse keywords - split by comma or space, filter empty
    const keywords = q.split(/[,\s]+/).filter(k => k.trim().length > 0).map(k => k.trim().toLowerCase());
    
    if (keywords.length === 0) {
      return res.status(400).json({ error: 'No valid keywords provided', success: false });
    }
    
    // Build search conditions for each keyword
    const buildKeywordCondition = (field, keywords, matchType) => {
      const conditions = keywords.map(() => `${field} LIKE ?`);
      return `(${conditions.join(matchType === 'all' ? ' AND ' : ' OR ')})`;
    };
    
    const keywordParams = keywords.map(k => `%${k}%`);
    
    // Search in laws
    let lawSql = `
      SELECT id, law_name, category_name, created_at, 'law' as type
      FROM laws 
      WHERE 1=1
    `;
    const lawParams = [];
    
    if (category && category !== 'all') {
      lawSql += ' AND category_name = ?';
      lawParams.push(category);
    }
    
    lawSql += ` AND ${buildKeywordCondition('law_name', keywords, match)}`;
    lawParams.push(...keywordParams);
    lawSql += ' ORDER BY law_name';
    
    const matchedLaws = lawsDb.prepare(lawSql).all(...lawParams);
    
    // Get all matching law IDs for article/sub-article filtering
    const matchedLawIds = matchedLaws.map(l => l.id);
    
    // Search in articles
    let articleSql = `
      SELECT a.id, a.law_id, a.article_number, a.article_title, l.law_name, 'article' as type
      FROM articles a
      JOIN laws l ON a.law_id = l.id
      WHERE 1=1
    `;
    const articleParams = [];
    
    if (matchedLawIds.length > 0) {
      articleSql += ` AND a.law_id IN (${matchedLawIds.map(() => '?').join(',')})`;
      articleParams.push(...matchedLawIds);
    }
    
    articleSql += ` AND ${buildKeywordCondition('a.article_title', keywords, match)}`;
    articleParams.push(...keywordParams);
    articleSql += ' ORDER BY l.law_name, a.article_number';
    
    let matchedArticles = [];
    try {
      matchedArticles = lawsDb.prepare(articleSql).all(...articleParams);
    } catch (e) {
      console.log('Article search error:', e.message);
    }
    
    // Get all matching article IDs for clause filtering
    const matchedArticleIds = matchedArticles.map(a => a.id);
    
    // Search in sub-articles/clauses
    let clauseResults = [];
    if (include_clauses === 'true' && matchedArticleIds.length > 0) {
      let clauseSql = `
        SELECT sa.id, sa.article_id, sa.sub_article_label, sa.text_content, 
               a.article_number, a.article_title, l.id as law_id, l.law_name, 'clause' as type
        FROM sub_articles sa
        JOIN articles a ON sa.article_id = a.id
        JOIN laws l ON a.law_id = l.id
        WHERE sa.article_id IN (${matchedArticleIds.map(() => '?').join(',')})
      `;
      const clauseParams = [...matchedArticleIds];
      
      clauseSql += ` AND ${buildKeywordCondition('sa.text_content', keywords, match)}`;
      clauseParams.push(...keywordParams);
      clauseSql += ' ORDER BY l.law_name, a.article_number, sa.sub_article_label';
      
      try {
        clauseResults = lawsDb.prepare(clauseSql).all(...clauseParams);
      } catch (e) {
        console.log('Clause search error:', e.message);
      }
    }
    
    // Organize results with match context
    const results = {
      laws: matchedLaws.map(l => ({
        ...l,
        matchContext: keywords.map(k => {
          if (l.law_name.toLowerCase().includes(k)) {
            const idx = l.law_name.toLowerCase().indexOf(k);
            const start = Math.max(0, idx - 30);
            const end = Math.min(l.law_name.length, idx + k.length + 30);
            return l.law_name.substring(start, end);
          }
          return null;
        }).filter(Boolean)
      })),
      articles: matchedArticles.map(a => ({
        ...a,
        matchContext: keywords.map(k => {
          if (a.article_title && a.article_title.toLowerCase().includes(k)) {
            const idx = a.article_title.toLowerCase().indexOf(k);
            const start = Math.max(0, idx - 30);
            const end = Math.min(a.article_title.length, idx + k.length + 30);
            return a.article_title.substring(start, end);
          }
          return null;
        }).filter(Boolean)
      })),
      clauses: clauseResults.map(c => ({
        ...c,
        matchContext: keywords.map(k => {
          if (c.text_content && c.text_content.toLowerCase().includes(k)) {
            const idx = c.text_content.toLowerCase().indexOf(k);
            const start = Math.max(0, idx - 40);
            const end = Math.min(c.text_content.length, idx + k.length + 40);
            return '...' + c.text_content.substring(start, end) + '...';
          }
          return null;
        }).filter(Boolean)
      })),
      total: matchedLaws.length + matchedArticles.length + clauseResults.length,
      keywords: keywords,
      matchType: match
    };
    
    res.json({ ...results, success: true });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed: ' + error.message, success: false });
  }
});

// GET /api/mvlaws/stats - Get voting stats
app.get('/api/mvlaws/stats', (req, res) => {
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
    } catch (e) {
      console.log('Votes table not available:', e.message);
    }
    
    res.json({
      totalVotes: totalVotes.total,
      articlesVoted: articlesVoted.total,
      breakdown: voteBreakdown,
      success: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats: ' + error.message, success: false });
  }
});

// GET /api/mvlaws/top-voted - Get most voted articles
app.get('/api/mvlaws/top-voted', (req, res) => {
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
    res.status(500).json({ error: 'Could not fetch top articles', success: false });
  }
});

// GET /api/mvlaws/recent-votes - Get recent votes
app.get('/api/mvlaws/recent-votes', (req, res) => {
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

// POST /api/wall - Add a post (no signup required)
app.post('/api/wall', (req, res) => {
  const { nickname, message } = req.body;
  
  if (!nickname || nickname.trim().length < 2) {
    return res.status(400).json({ error: 'Please enter a nickname (at least 2 characters)', success: false });
  }
  
  if (!message || message.trim().length < 1) {
    return res.status(400).json({ error: 'Please write something', success: false });
  }
  
  if (message.length > 500) {
    return res.status(400).json({ error: 'Message too long (max 500 characters)', success: false });
  }
  
  try {
    const timestamp = new Date().toISOString();
    const stmt = db.prepare('INSERT INTO wall_posts (nickname, message, timestamp) VALUES (?, ?, ?)');
    const result = stmt.run(nickname.trim().substring(0, 50), message.trim().substring(0, 500), timestamp);
    
    res.status(201).json({ 
      message: 'Posted! Thanks for your support.',
      success: true,
      id: result.lastInsertRowid
    });
  } catch (error) {
    console.error('Wall post error:', error);
    res.status(500).json({ error: 'Could not post message', success: false });
  }
});

// GET /api/wall-stats - Get public engagement stats (no signup required)
app.get('/api/wall-stats', (req, res) => {
  try {
    const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups').get();
    const wallCount = db.prepare('SELECT COUNT(*) as total FROM wall_posts WHERE is_approved = 1').get();
    const treasury = db.prepare('SELECT SUM(donation_amount) as total FROM signups WHERE donation_amount > 0').get();
    
    res.json({ 
      members: memberCount.total,
      wallPosts: wallCount.total,
      treasury: treasury.total || 0,
      success: true 
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats', success: false });
  }
});

// ==================== API ENDPOINTS ====================
// POST /api/signup - New signup
app.post('/api/signup', (req, res) => {
  const { phone, nid, name, username, email, island, contribution_types, donation_amount } = req.body;
  
  // Validate mandatory fields
  if (!phone || !nid) {
    return res.status(400).json({ 
      error: 'Phone and NID are mandatory — even insurance agents need these.',
      success: false 
    });
  }

  // Check for duplicate username if provided
  if (username) {
    const existingUsername = db.prepare('SELECT id FROM signups WHERE username = ?').get(username.trim());
    if (existingUsername) {
      return res.status(409).json({ 
        error: 'Username already taken. Choose a different one.',
        success: false 
      });
    }
  }
  
  // Validate contribution_types is array if provided
  let validTypes = ['skills', 'action', 'ideas', 'donation'];
  let typesArray = [];
  if (contribution_types) {
    if (!Array.isArray(contribution_types)) {
      return res.status(400).json({ 
        error: 'contribution_types must be an array.',
        success: false 
      });
    }
    typesArray = contribution_types.filter(t => validTypes.includes(t));
    if (typesArray.length !== contribution_types.length) {
      return res.status(400).json({ 
        error: 'Invalid contribution type. Choose from: skills, action, ideas, donation.',
        success: false 
      });
    }
  }
  
  // Basic phone validation (Maldivian format: 7 digits)
  const phoneRegex = /^[0-9]{7}$/;
  if (!phoneRegex.test(phone.replace(/\D/g, ''))) {
    return res.status(400).json({ 
      error: 'Please enter a valid 7-digit phone number.',
      success: false 
    });
  }
  
  // Basic NID validation
  const nidRegex = /^[A-Za-z][0-9]{6,7}$/;
  if (!nidRegex.test(nid.trim())) {
    return res.status(400).json({ 
      error: 'Please enter a valid NID (e.g., A123456).',
      success: false 
    });
  }
  
  // Check for duplicate phone or NID
  const existing = db.prepare('SELECT id FROM signups WHERE phone = ? OR nid = ?').get(phone, nid);
  if (existing) {
    return res.status(409).json({ 
      error: 'You\'re already in the party! One membership per person, please.',
      success: false 
    });
  }
  
  // Calculate initial merit estimate based on contribution types
  const meritEstimates = {
    'skills': 250,
    'action': 200,
    'ideas': 150,
    'donation': 100
  };
  let initialMerit = 50; // base merit
  typesArray.forEach(type => {
    initialMerit += meritEstimates[type] || 0;
  });
  initialMerit += Math.floor(Math.random() * 50);
  
  // Validate donation amount
  let finalDonation = 0;
  if (typesArray.includes('donation') && donation_amount) {
    finalDonation = parseFloat(donation_amount);
    if (isNaN(finalDonation) || finalDonation <= 0) {
      return res.status(400).json({ 
        error: 'Please enter a valid donation amount.',
        success: false 
      });
    }
    // Bonus merit for donations (diminishing returns: 5 points per 100 MVR)
    const donationBonus = Math.floor(finalDonation / 100) * 5;
    initialMerit += donationBonus;
  }
  
  try {
    const timestamp = new Date().toISOString();
    const contributionTypeJson = JSON.stringify(typesArray);
    const stmt = db.prepare(
      'INSERT INTO signups (phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(
      phone, 
      nid, 
      name || null,
      username ? username.trim() : null, 
      email || null, 
      island || null, 
      contributionTypeJson, 
      finalDonation,
      initialMerit,
      1,
      null,
      timestamp
    );
    
    // Auto-login after signup
    const authToken = Buffer.from(`${phone}:${nid}:${Date.now()}`).toString('base64');
    db.prepare('UPDATE signups SET auth_token = ? WHERE id = ?').run(authToken, result.lastInsertRowid);
    
    // Check for pending referrals
    const pendingReferral = db.prepare(`
      SELECT * FROM referrals 
      WHERE status = 'pending_waiting' AND details LIKE ?
    `).get(`%${phone}%`);
    
    if (pendingReferral) {
      const details = JSON.parse(pendingReferral.details || '{}');
      if (details.phone === phone) {
        // Count successful invites for this referrer
        const inviteCount = db.prepare(`
          SELECT COUNT(*) as count FROM referrals 
          WHERE referrer_id = ? AND status IN ('joined', 'active')
        `).get(pendingReferral.referrer_id).count;
        
        const basePoints = getReferralPoints(inviteCount + 1, false);
        
        // Update referral with new user
        db.prepare(`
          UPDATE referrals SET referred_id = ?, status = 'joined', 
          base_reward_given = ?, referred_joined_at = ?
          WHERE id = ?
        `).run(result.lastInsertRowid, basePoints, timestamp, pendingReferral.id);
        
        // Award points to referrer
        db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
          .run(basePoints, pendingReferral.referrer_id);
        
        // Log the activity
        logActivity('referral_completed', pendingReferral.referrer_id, result.lastInsertRowid, {
          base_points_awarded: basePoints,
          referrer_invite_count: inviteCount + 1
        }, req);
      }
    }
    
    // Log the signup activity
    logActivity('user_signup', result.lastInsertRowid, null, {
      phone: phone.substring(0, 3) + 'xxxx',
      has_username: !!username
    }, req);
    
    // Get the user data to return
    const user = db.prepare('SELECT * FROM signups WHERE id = ?').get(result.lastInsertRowid);
    
    res.status(201).json({ 
      message: `Welcome to the 3d Party! Your initial Merit Score estimate is ${initialMerit} points.`,
      success: true,
      token: authToken,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        nid: user.nid,
        email: user.email,
        island: user.island,
        contribution_type: user.contribution_type,
        donation_amount: user.donation_amount,
        initial_merit_estimate: user.initial_merit_estimate,
        timestamp: user.timestamp
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ 
      error: 'Something went wrong on our end. We\'re working on it.',
      success: false 
    });
  }
});

// POST /api/unregister - Unregister a user (admin only)
app.post('/api/unregister', adminAuth, (req, res) => {
  const { user_id, justification } = req.body;
  
  if (!user_id) {
    return res.status(400).json({ error: 'User ID required', success: false });
  }
  
  if (!justification || justification.trim().length < 10) {
    return res.status(400).json({ error: 'Justification note required (min 10 characters)', success: false });
  }
  
  try {
    const user = db.prepare('SELECT id, name, phone FROM signups WHERE id = ?').get(user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found', success: false });
    }
    
    const unregisteredAt = new Date().toISOString();
    db.prepare(`
      UPDATE signups 
      SET is_verified = 0, unregistered_at = ?, unregistered_by = 'admin', unregister_justification = ?
      WHERE id = ?
    `).run(unregisteredAt, justification.trim(), user_id);
    
    res.json({ 
      message: `User ${user.name || user.phone} has been unregistered.`,
      success: true 
    });
  } catch (error) {
    console.error('Unregister error:', error);
    res.status(500).json({ error: 'Could not unregister user', success: false });
  }
});

// GET /api/signups - Get all signups (admin only)
app.get('/api/signups', adminAuth, (req, res) => {
  try {
    const signups = db.prepare('SELECT * FROM signups ORDER BY timestamp DESC').all();
    const count = db.prepare('SELECT COUNT(*) as total FROM signups').get();
    const treasury = db.prepare('SELECT SUM(donation_amount) as total_donations FROM signups WHERE donation_amount > 0').get();
    
    const parsedSignups = signups.map(s => ({
      ...s,
      contribution_type: s.contribution_type ? JSON.parse(s.contribution_type) : []
    }));
    
    res.json({ 
      signups: parsedSignups,
      total: count.total,
      total_treasury: treasury.total_donations || 0,
      success: true 
    });
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ 
      error: 'Database error',
      success: false 
    });
  }
});

// DELETE /api/signups - Clear all signups (admin only)
app.delete('/api/signups', adminAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM signups').run();
    res.json({ 
      message: 'All signups cleared. Database is now as empty as traditional party promises.',
      success: true 
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ 
      error: 'Could not clear database',
      success: false 
    });
  }
});

// POST /api/login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ 
      success: true, 
      token: ADMIN_PASSWORD,
      message: 'Welcome back. The insurance agents are still locked out.'
    });
  } else {
    res.status(401).json({ 
      success: false, 
      error: 'Wrong password. If you\'re from an insurance company, please leave.' 
    });
  }
});

// POST /api/user/login - User login with phone + NID OR username + password
app.post('/api/user/login', (req, res) => {
  const { phone, nid, username, password } = req.body;
  
  // Determine login method
  let user;
  
  if (username && password) {
    // Username + password login
    // username can be: NID, custom username, or name
    // password is: phone number
    user = db.prepare(`
      SELECT * FROM signups 
      WHERE ((username = ?) OR (nid = ?) OR (name = ?)) 
      AND phone = ? AND is_verified = 1
    `).get(username.trim(), username.trim(), username.trim(), password);
  } else if (phone && nid) {
    // Phone + NID login (original method)
    user = db.prepare('SELECT * FROM signups WHERE phone = ? AND nid = ? AND is_verified = 1').get(phone, nid);
  } else {
    return res.status(400).json({ error: 'Login requires either (phone + nid) or (username + password)', success: false });
  }
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials or not registered', success: false });
  }
  
  try {
    // Generate auth token
    const authToken = Buffer.from(`${user.phone}:${user.nid}:${Date.now()}`).toString('base64');
    db.prepare('UPDATE signups SET auth_token = ? WHERE id = ?').run(authToken, user.id);
    
    res.json({ 
      success: true, 
      token: authToken,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        username: user.username,
        nid: user.nid,
        email: user.email,
        island: user.island,
        contribution_type: user.contribution_type ? JSON.parse(user.contribution_type) : [],
        donation_amount: user.donation_amount,
        initial_merit_estimate: user.initial_merit_estimate,
        timestamp: user.timestamp
      }
    });
  } catch (error) {
    console.error('User login error:', error);
    res.status(500).json({ error: 'Login failed', success: false });
  }
});

// POST /api/user/logout - User logout
app.post('/api/user/logout', (req, res) => {
  const { phone } = req.body;
  if (phone) {
    db.prepare('UPDATE signups SET auth_token = NULL WHERE phone = ?').run(phone);
  }
  res.json({ success: true, message: 'Logged out' });
});

// Activity logging function for tracing issues and disputes
function logActivity(actionType, userId, targetId, details, req) {
  try {
    const stmt = db.prepare(
      'INSERT INTO activity_log (action_type, user_id, target_id, details, ip_address, user_agent, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(
      actionType,
      userId || null,
      targetId || null,
      details ? JSON.stringify(details) : null,
      req ? (req.ip || req.connection.remoteAddress) : null,
      req ? (req.get('User-Agent') || null) : null,
      new Date().toISOString()
    );
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
}

// Calculate referral points based on total successful invites
function getReferralPoints(inviteCount, isEngagementBonus = false) {
  if (isEngagementBonus) {
    // Engagement bonus
    if (inviteCount <= 5) return 8;
    if (inviteCount <= 20) return 4;
    return 0.5;
  } else {
    // Base reward
    if (inviteCount <= 5) return 2;
    if (inviteCount <= 20) return 1;
    return 0.5;
  }
}

// POST /api/referral/introduce - Introduce a new member
app.post('/api/referral/introduce', userAuth, (req, res) => {
  const { phone, nid, name, username, relation } = req.body;
  
  if (!phone || !nid || !relation) {
    return res.status(400).json({ 
      error: 'Phone, NID, and relation are required',
      success: false 
    });
  }
  
  // Validate relation
  const validRelations = ['family', 'friend', 'colleague', 'neighbor', 'other'];
  if (!validRelations.includes(relation)) {
    return res.status(400).json({ 
      error: 'Invalid relation. Choose from: family, friend, colleague, neighbor, other',
      success: false 
    });
  }
  
  try {
    // Check if user already exists
    const existing = db.prepare('SELECT id, is_verified FROM signups WHERE phone = ? OR nid = ?').get(phone, nid);
    
    if (existing) {
      // Check if already referred by someone
      const existingReferral = db.prepare('SELECT id FROM referrals WHERE referred_id = ? AND status != ?').get(existing.id, 'removed');
      if (existingReferral) {
        return res.status(409).json({ 
          error: 'This person is already registered and has been introduced by another member',
          success: false 
        });
      }
      
      // Create referral for existing verified user (base reward only)
      const referrerId = req.user.id;
      
      // Count successful invites for this referrer
      const inviteCount = db.prepare(`
        SELECT COUNT(*) as count FROM referrals 
        WHERE referrer_id = ? AND (status = 'joined' OR status = 'active') AND base_reward_given = 1
      `).get(referrerId).count;
      
      const basePoints = getReferralPoints(inviteCount + 1, false);
      
      const insertReferral = db.prepare(`
        INSERT INTO referrals (referrer_id, referred_id, relation, status, base_reward_given, created_at, referred_joined_at)
        VALUES (?, ?, ?, 'joined', ?, ?, ?)
      `);
      insertReferral.run(referrerId, existing.id, relation, basePoints, new Date().toISOString(), existing.timestamp);
      
      // Update referrer's merit score
      db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
        .run(basePoints, referrerId);
      
      // Log the activity
      logActivity('referral_created_existing', referrerId, existing.id, {
        relation,
        base_points_awarded: basePoints,
        referrer_invite_count: inviteCount + 1
      }, req);
      
      return res.json({
        success: true,
        message: `Member found! You earned ${basePoints} base points. They need to complete their first action for you to get the engagement bonus.`,
        points_earned: basePoints
      });
    }
    
    // Create pending referral for new user (will be activated on signup)
    const referrerId = req.user.id;
    
    const insertReferral = db.prepare(`
      INSERT INTO referrals (referrer_id, referred_id, relation, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `);
    // We'll need to store temp data - use negative ID to indicate pending
    const result = insertReferral.run(referrerId, 0, relation, new Date().toISOString());
    
    // Store pending referral data in a temp table or we can use the name/phone
    // For now, let's just mark it as pending and when user signs up with matching phone/nid, it will be linked
    
    // Actually, we should not create a pending referral this way. Instead, 
    // the person being introduced should use a referral code or we link by phone during signup.
    // Let me rethink this - we should create a temporary referral record that gets linked on signup.
    
    // Update: Let's create a temporary pending referral record with the phone/nid
    db.prepare(`
      UPDATE referrals SET status = 'pending_waiting', referred_id = NULL,
      details = ? WHERE id = ?
    `).run(JSON.stringify({ phone, nid }), result.lastInsertRowid);
    
    // Log the activity
    logActivity('referral_intro_initiated', referrerId, null, {
      relation,
      introduced_phone: phone.substring(0, 3) + 'xxx',
      introduced_nid: nid.substring(0, 2) + 'xxxxx'
    }, req);
    
    return res.json({
      success: true,
      message: `Invitation sent! When this person joins, you'll earn base points. Complete engagement earns bonus points.`,
      pending: true
    });
    
  } catch (error) {
    console.error('Referral error:', error);
    res.status(500).json({ error: 'Failed to create referral', success: false });
  }
});

// GET /api/referrals - Get user's referrals
app.get('/api/referrals', userAuth, (req, res) => {
  try {
    const referrerId = req.user.id;
    
    const referrals = db.prepare(`
      SELECT r.*, s.name as referred_name, s.phone as referred_phone, s.island as referred_island
      FROM referrals r
      LEFT JOIN signups s ON r.referred_id = s.id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC
    `).all(referrerId);
    
    // Calculate total points earned
    const totals = db.prepare(`
      SELECT 
        COUNT(*) as total_referrals,
        SUM(base_reward_given) as total_base_points,
        SUM(engagement_bonus_given) as total_engagement_points
      FROM referrals 
      WHERE referrer_id = ? AND status != 'removed'
    `).get(referrerId);
    
    res.json({
      success: true,
      referrals: referrals.map(r => ({
        id: r.id,
        relation: r.relation,
        status: r.status,
        base_reward: r.base_reward_given,
        engagement_bonus: r.engagement_bonus_given,
        created_at: r.created_at,
        referred_joined_at: r.referred_joined_at,
        first_action_at: r.first_action_at,
        referred_name: r.referred_name,
        referred_phone: r.referred_phone ? r.referred_phone.substring(0, 3) + 'xxxx' : null
      })),
      summary: {
        total: totals.total_referrals || 0,
        base_points: totals.total_base_points || 0,
        engagement_points: totals.total_engagement_points || 0,
        total_points: (totals.total_base_points || 0) + (totals.total_engagement_points || 0)
      }
    });
  } catch (error) {
    console.error('Get referrals error:', error);
    res.status(500).json({ error: 'Failed to get referrals', success: false });
  }
});

// POST /api/referral/remove - Remove a referral (admin or user can request removal)
app.post('/api/referral/remove', userAuth, (req, res) => {
  const { referral_id, reason } = req.body;
  
  if (!referral_id) {
    return res.status(400).json({ error: 'Referral ID required', success: false });
  }
  
  try {
    const referral = db.prepare('SELECT * FROM referrals WHERE id = ?').get(referral_id);
    
    if (!referral) {
      return res.status(404).json({ error: 'Referral not found', success: false });
    }
    
    // Only referrer or admin can remove
    if (referral.referrer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized', success: false });
    }
    
    // Check if points were already given - if so, reverse them
    if (referral.base_reward_given > 0 || referral.engagement_bonus_given > 0) {
      const pointsToReverse = referral.base_reward_given + referral.engagement_bonus_given;
      db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate - ? WHERE id = ?')
        .run(pointsToReverse, referral.referrer_id);
    }
    
    // Mark as removed
    db.prepare("UPDATE referrals SET status = 'removed' WHERE id = ?").run(referral_id);
    
    // Log the activity
    logActivity('referral_removed', req.user.id, referral.referred_id, {
      reason: reason || 'User requested removal',
      points_reversed: referral.base_reward_given + referral.engagement_bonus_given
    }, req);
    
    res.json({ 
      success: true, 
      message: 'Referral removed. Any points have been reversed.',
      points_reversed: referral.base_reward_given + referral.engagement_bonus_given
    });
  } catch (error) {
    console.error('Remove referral error:', error);
    res.status(500).json({ error: 'Failed to remove referral', success: false });
  }
});

// GET /api/activity-log - Get activity log (admin only)
app.get('/api/activity-log', adminAuth, (req, res) => {
  const { action_type, user_id, limit = 100, offset = 0 } = req.query;
  
  try {
    let query = 'SELECT * FROM activity_log WHERE 1=1';
    const params = [];
    
    if (action_type) {
      query += ' AND action_type = ?';
      params.push(action_type);
    }
    
    if (user_id) {
      query += ' AND user_id = ?';
      params.push(parseInt(user_id));
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const logs = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM activity_log').get();
    
    res.json({
      success: true,
      logs: logs.map(l => ({
        id: l.id,
        action_type: l.action_type,
        user_id: l.user_id,
        target_id: l.target_id,
        details: l.details ? JSON.parse(l.details) : null,
        ip_address: l.ip_address,
        timestamp: l.timestamp
      })),
      total: total.count
    });
  } catch (error) {
    console.error('Activity log error:', error);
    res.status(500).json({ error: 'Failed to get activity log', success: false });
  }
});

// Middleware to verify user auth token
function userAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authentication required', success: false });
  }
  
  const token = authHeader.replace(/^Bearer\s+/i, '');
  
  try {
    const user = db.prepare('SELECT * FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token', success: false });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed', success: false });
  }
}

// GET /api/user/profile - Get user profile
app.get('/api/user/profile', userAuth, (req, res) => {
  const user = req.user;
  
  // Get clause-level votes
  let clauseVotes = [];
  if (lawsDb) {
    try {
      clauseVotes = lawsDb.prepare(`
        SELECT sv.*, sa.sub_article_label as clause_label, a.article_number, a.article_title, l.law_name
        FROM sub_article_votes sv
        JOIN sub_articles sa ON sv.sub_article_id = sa.id
        JOIN articles a ON sa.article_id = a.id
        JOIN laws l ON a.law_id = l.id
        WHERE sv.user_phone = ?
        ORDER BY sv.voted_at DESC
        LIMIT 50
      `).all(user.phone);
    } catch (e) {}
  }
  
  // Get article-level votes
  let articleVotes = [];
  try {
    articleVotes = db.prepare(`
      SELECT lv.*, a.article_number, a.article_title, l.law_name
      FROM law_votes lv
      JOIN articles a ON lv.article_id = a.id
      JOIN laws l ON a.law_id = l.id
      WHERE lv.user_phone = ?
      ORDER BY lv.voted_at DESC
      LIMIT 50
    `).all(user.phone);
  } catch (e) {}
  
  // Get law-level votes
  let lawVotes = [];
  if (lawsDb) {
    try {
      lawVotes = lawsDb.prepare(`
        SELECT llv.*, l.law_name, l.category_name
        FROM law_level_votes llv
        JOIN laws l ON llv.law_id = l.id
        WHERE llv.user_phone = ?
        ORDER BY llv.voted_at DESC
        LIMIT 50
      `).all(user.phone);
    } catch (e) {}
  }
  
  res.json({
    success: true,
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      island: user.island,
      contribution_type: user.contribution_type ? JSON.parse(user.contribution_type) : [],
      donation_amount: user.donation_amount,
      initial_merit_estimate: user.initial_merit_estimate,
      timestamp: user.timestamp
    },
    votes: {
      clauses: clauseVotes,
      articles: articleVotes,
      laws: lawVotes
    },
    stats: {
      clauseVotesCount: clauseVotes.length,
      articleVotesCount: articleVotes.length,
      lawVotesCount: lawVotes.length
    }
  });
});

// POST /api/mvlaws/vote-law - Vote on an entire law (law-level voting)
app.post('/api/mvlaws/vote-law', (req, res) => {
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
  const oneHourAgo = new Date(Date.now() - 60*60*1000).toISOString();
  
  const recentVote = lawsDb.prepare(`
    SELECT id FROM law_level_votes 
    WHERE law_id = ? AND (user_ip = ? OR user_phone = ?) AND voted_at > ?
    LIMIT 1
  `).get(law_id, userIP, phone || '', oneHourAgo);
  
  if (recentVote) {
    return res.status(429).json({ error: 'Please wait an hour before voting on this law again', success: false });
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
    }
    
    res.json({ message: 'Law vote recorded!', success: true });
  } catch (error) {
    console.error('Law-level vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
  }
});

// GET /api/mvlaws/:id/law-votes - Get law-level votes for a law
app.get('/api/mvlaws/:id/law-votes', (req, res) => {
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

// ==================== LEADERSHIP API ====================

// GET /api/leadership/settings - Get leadership settings
app.get('/api/leadership/settings', adminAuth, (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM leadership_settings WHERE id = 1').get();
    const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE is_verified = 1').get();
    res.json({ success: true, settings, memberCount: memberCount.total });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch settings' });
  }
});

// POST /api/leadership/settings - Update leadership settings
app.post('/api/leadership/settings', adminAuth, (req, res) => {
  const { member_threshold, min_merit_for_leadership, max_term_years, appraisal_frequency_days } = req.body;
  
  try {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE leadership_settings 
      SET member_threshold = ?, min_merit_for_leadership = ?, max_term_years = ?, appraisal_frequency_days = ?, updated_at = ?
      WHERE id = 1
    `).run(member_threshold || 1000, min_merit_for_leadership || 500, max_term_years || 2, appraisal_frequency_days || 365, now);
    
    res.json({ success: true, message: 'Settings updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not update settings' });
  }
});

// GET /api/leadership/positions - Get all leadership positions
app.get('/api/leadership/positions', adminAuth, (req, res) => {
  try {
    const positions = db.prepare(`
      SELECT lp.*, 
        (SELECT COUNT(*) FROM leadership_terms WHERE position_id = lp.id AND ended_at IS NULL) as current_holders
      FROM leadership_positions lp
      ORDER BY lp.position_type, lp.id
    `).all();
    res.json({ success: true, positions });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch positions' });
  }
});

// POST /api/leadership/positions - Create new position
app.post('/api/leadership/positions', adminAuth, (req, res) => {
  const { title, description, position_type, min_merit_required } = req.body;
  
  if (!title || !position_type) {
    return res.status(400).json({ success: false, error: 'Title and type required' });
  }
  
  try {
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO leadership_positions (title, description, position_type, min_merit_required, is_active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(title, description || '', position_type, min_merit_required || 0, now);
    
    res.json({ success: true, message: 'Position created', id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not create position' });
  }
});

// GET /api/leadership/applications - Get all applications
app.get('/api/leadership/applications', adminAuth, (req, res) => {
  try {
    const applications = db.prepare(`
      SELECT la.*, s.name, s.phone, s.initial_merit_estimate as merit_score, lp.title as position_title
      FROM leadership_applications la
      JOIN signups s ON la.user_id = s.id
      JOIN leadership_positions lp ON la.position_id = lp.id
      ORDER BY la.applied_at DESC
    `).all();
    res.json({ success: true, applications });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch applications' });
  }
});

// POST /api/leadership/applications/:id/status - Update application status
app.post('/api/leadership/applications/:id/status', adminAuth, (req, res) => {
  const { status, interview_notes, interview_video_url } = req.body;
  const appId = parseInt(req.params.id);
  
  if (!['pending', 'interview', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }
  
  try {
    const interviewScheduled = status === 'interview' ? new Date().toISOString() : null;
    db.prepare(`
      UPDATE leadership_applications 
      SET status = ?, interview_scheduled_at = COALESCE(?, interview_scheduled_at), interview_notes = ?, interview_video_url = ?
      WHERE id = ?
    `).run(status, interviewScheduled, interview_notes || null, interview_video_url || null, appId);
    
    if (status === 'approved') {
      const app = db.prepare('SELECT user_id, position_id FROM leadership_applications WHERE id = ?').get(appId);
      if (app) {
        const now = new Date().toISOString();
        const existingTerm = db.prepare('SELECT MAX(term_number) as max_term FROM leadership_terms WHERE user_id = ? AND position_id = ?').get(app.user_id, app.position_id);
        const termNum = (existingTerm.max_term || 0) + 1;
        db.prepare('INSERT INTO leadership_terms (user_id, position_id, started_at, term_number) VALUES (?, ?, ?, ?)').run(app.user_id, app.position_id, now, termNum);
      }
    }
    
    res.json({ success: true, message: `Application ${status}` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not update status' });
  }
});

// GET /api/leadership/terms - Get current leadership terms
app.get('/api/leadership/terms', adminAuth, (req, res) => {
  try {
    const terms = db.prepare(`
      SELECT lt.*, s.name, s.phone, s.initial_merit_estimate as merit_score, lp.title as position_title, lp.position_type
      FROM leadership_terms lt
      JOIN signups s ON lt.user_id = s.id
      JOIN leadership_positions lp ON lt.position_id = lp.id
      WHERE lt.ended_at IS NULL
      ORDER BY lt.started_at DESC
    `).all();
    res.json({ success: true, terms });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch terms' });
  }
});

// POST /api/leadership/terms/:id/end - End a leadership term
app.post('/api/leadership/terms/:id/end', adminAuth, (req, res) => {
  const { reason } = req.body;
  const termId = parseInt(req.params.id);
  
  try {
    const now = new Date().toISOString();
    db.prepare('UPDATE leadership_terms SET ended_at = ? WHERE id = ?').run(now, termId);
    res.json({ success: true, message: 'Term ended' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not end term' });
  }
});

// GET /api/leadership/sops - Get all SOPs
app.get('/api/leadership/sops', adminAuth, (req, res) => {
  try {
    const sops = db.prepare('SELECT * FROM leadership_sops WHERE is_active = 1 ORDER BY category, title').all();
    res.json({ success: true, sops });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch SOPs' });
  }
});

// POST /api/leadership/sops - Create/update SOP
app.post('/api/leadership/sops', adminAuth, (req, res) => {
  const { id, title, content, category } = req.body;
  const now = new Date().toISOString();
  
  try {
    if (id) {
      db.prepare('UPDATE leadership_sops SET title = ?, content = ?, category = ?, updated_at = ? WHERE id = ?').run(title, content, category || 'general', now, id);
      res.json({ success: true, message: 'SOP updated' });
    } else {
      const result = db.prepare('INSERT INTO leadership_sops (title, content, category, version, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)').run(title, content, category || 'general', now, now);
      res.json({ success: true, message: 'SOP created', id: result.lastInsertRowid });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not save SOP' });
  }
});

// POST /api/leadership/appraisals - Add appraisal
app.post('/api/leadership/appraisals', adminAuth, (req, res) => {
  const { term_id, appraisal_period, rating, strengths, areas_for_improvement, overall_feedback } = req.body;
  const now = new Date().toISOString();
  
  try {
    const result = db.prepare(`
      INSERT INTO leadership_appraisals (term_id, appraisal_period, rating, strengths, areas_for_improvement, overall_feedback, appraisal_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(term_id, appraisal_period, rating, strengths || '', areas_for_improvement || '', overall_feedback || '', now);
    
    res.json({ success: true, message: 'Appraisal recorded', id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not save appraisal' });
  }
});

// GET /api/leadership/status - Public endpoint for leadership availability
app.get('/api/leadership/status', (req, res) => {
  try {
    const settings = db.prepare('SELECT member_threshold FROM leadership_settings WHERE id = 1').get();
    const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE is_verified = 1').get();
    const activeTerms = db.prepare('SELECT COUNT(*) as total FROM leadership_terms WHERE ended_at IS NULL').get();
    const openPositions = db.prepare('SELECT COUNT(*) as total FROM leadership_positions WHERE is_active = 1').get();
    
    const thresholdMet = memberCount.total >= settings.member_threshold;
    
    res.json({
      success: true,
      threshold_met: thresholdMet,
      member_count: memberCount.total,
      threshold: settings.member_threshold,
      active_leaders: activeTerms.total,
      open_positions: openPositions.total
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch status' });
  }
});

// POST /api/leadership/apply - Member applies for leadership
app.post('/api/leadership/apply', userAuth, (req, res) => {
  const { position_id, application_text } = req.body;
  
  if (!position_id || !application_text) {
    return res.status(400).json({ success: false, error: 'Position and application text required' });
  }
  
  try {
    const settings = db.prepare('SELECT member_threshold, min_merit_for_leadership FROM leadership_settings WHERE id = 1').get();
    const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE is_verified = 1').get();
    
    if (memberCount.total < settings.member_threshold) {
      return res.status(400).json({ success: false, error: `Leadership applications open when membership reaches ${settings.member_threshold}. Currently: ${memberCount.total}` });
    }
    
    if (req.user.initial_merit_estimate < settings.min_merit_for_leadership) {
      return res.status(400).json({ success: false, error: `Minimum merit score of ${settings.min_merit_for_leadership} required. Your score: ${req.user.initial_merit_estimate}` });
    }
    
    const position = db.prepare('SELECT min_merit_required FROM leadership_positions WHERE id = ? AND is_active = 1').get(position_id);
    if (!position) {
      return res.status(400).json({ success: false, error: 'Position not found or closed' });
    }
    
    if (req.user.initial_merit_estimate < position.min_merit_required) {
      return res.status(400).json({ success: false, error: `This position requires ${position.min_merit_required} merit. Your score: ${req.user.initial_merit_estimate}` });
    }
    
    const existingApp = db.prepare('SELECT id FROM leadership_applications WHERE user_id = ? AND position_id = ? AND status != ?').get(req.user.id, position_id, 'rejected');
    if (existingApp) {
      return res.status(400).json({ success: false, error: 'You already have a pending application for this position' });
    }
    
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO leadership_applications (user_id, position_id, application_text, status, merit_score_at_apply, applied_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(req.user.id, position_id, application_text, req.user.initial_merit_estimate, now);
    
    res.json({ success: true, message: 'Application submitted. Live interview will be scheduled.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not submit application' });
  }
});

// ==================== PUBLIC LEADERSHIP API ====================

// GET /api/leadership/public - Public leadership status
app.get('/api/leadership/public', (req, res) => {
  try {
    const settings = db.prepare('SELECT member_threshold, min_merit_for_leadership FROM leadership_settings WHERE id = 1').get();
    const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE is_verified = 1').get();
    
    res.json({
      success: true,
      threshold_met: memberCount.total >= settings.member_threshold,
      member_count: memberCount.total,
      threshold: settings.member_threshold,
      min_merit: settings.min_merit_for_leadership
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch status' });
  }
});

// GET /api/leadership/positions-public - Public positions list
app.get('/api/leadership/positions-public', (req, res) => {
  try {
    const positions = db.prepare(`
      SELECT id, title, description, position_type, min_merit_required
      FROM leadership_positions 
      WHERE is_active = 1
      ORDER BY position_type, id
    `).all();
    res.json({ success: true, positions });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch positions' });
  }
});

// GET /api/leadership/terms-public - Public current leaders
app.get('/api/leadership/terms-public', (req, res) => {
  try {
    const terms = db.prepare(`
      SELECT lt.id, lt.user_id, lt.started_at, lt.term_number,
        s.name, s.initial_merit_estimate as merit_score, 
        lp.title as position_title, lp.position_type
      FROM leadership_terms lt
      JOIN signups s ON lt.user_id = s.id
      JOIN leadership_positions lp ON lt.position_id = lp.id
      WHERE lt.ended_at IS NULL
      ORDER BY lt.started_at DESC
    `).all();
    res.json({ success: true, terms });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch terms' });
  }
});

// GET /api/leadership/sops-public - Public SOPs
app.get('/api/leadership/sops-public', (req, res) => {
  try {
    const sops = db.prepare(`
      SELECT id, title, content, category, version, updated_at
      FROM leadership_sops 
      WHERE is_active = 1
      ORDER BY category, title
    `).all();
    res.json({ success: true, sops });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch SOPs' });
  }
});

// ==================== SERVE HTML FILES ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'join.html'));
});

app.get('/intro', (req, res) => {
  res.sendFile(path.join(__dirname, 'intro.html'));
});

app.get('/how', (req, res) => {
  res.sendFile(path.join(__dirname, 'how.html'));
});

app.get('/wall', (req, res) => {
  res.sendFile(path.join(__dirname, 'wall.html'));
});

app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'join.html'));
});

app.get('/whitepaper', (req, res) => {
  res.sendFile(path.join(__dirname, 'whitepaper.html'));
});

app.get('/policies', (req, res) => {
  res.sendFile(path.join(__dirname, 'policies.html'));
});

app.get('/proposals', (req, res) => {
  res.sendFile(path.join(__dirname, 'proposals.html'));
});

app.get('/legislature', (req, res) => {
  res.sendFile(path.join(__dirname, 'legislature.html'));
});

app.get('/laws', (req, res) => {
  res.sendFile(path.join(__dirname, 'laws.html'));
});

app.get('/law-stats', (req, res) => {
  res.sendFile(path.join(__dirname, 'law-stats.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'profile.html'));
});

app.get('/leadership', (req, res) => {
  res.sendFile(path.join(__dirname, 'leadership.html'));
});

app.get('/faq', (req, res) => {
  res.sendFile(path.join(__dirname, 'faq.html'));
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`\n🎉 3d Party running at http://localhost:${PORT}`);
  console.log(`📊 Admin: http://localhost:${PORT}/admin`);
  console.log(`🔑 Password: ${ADMIN_PASSWORD}`);
  console.log(`💡 "No, we are not doing 3rd party insurance."\n`);
});