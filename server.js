const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// ==================== DATABASE SETUP ====================
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'signups.db'));

// Create table with updated schema
db.exec(`
  CREATE TABLE IF NOT EXISTS signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    nid TEXT NOT NULL,
    name TEXT,
    email TEXT,
    island TEXT,
    contribution_type TEXT NOT NULL CHECK(contribution_type IN ('skills', 'action', 'ideas', 'donation')),
    donation_amount REAL DEFAULT 0,
    initial_merit_estimate INTEGER DEFAULT 0,
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
  const { phone, nid, name, email, island, contribution_type, donation_amount } = req.body;
  
  // Validate mandatory fields
  if (!phone || !nid) {
    return res.status(400).json({ 
      error: 'Phone and NID are mandatory — even insurance agents need these.',
      success: false 
    });
  }
  
  if (!contribution_type || !['skills', 'action', 'ideas', 'donation'].includes(contribution_type)) {
    return res.status(400).json({ 
      error: 'Please select how you want to contribute. It takes 5 seconds.',
      success: false 
    });
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
  
  // Calculate initial merit estimate based on contribution type
  const meritEstimates = {
    'skills': 250,
    'action': 200,
    'ideas': 150,
    'donation': 100
  };
  let initialMerit = meritEstimates[contribution_type] + Math.floor(Math.random() * 50);
  
  // Validate donation amount
  let finalDonation = 0;
  if (contribution_type === 'donation' && donation_amount) {
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
    const stmt = db.prepare(
      'INSERT INTO signups (phone, nid, name, email, island, contribution_type, donation_amount, initial_merit_estimate, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(
      phone, 
      nid, 
      name || null, 
      email || null, 
      island || null, 
      contribution_type, 
      finalDonation,
      initialMerit,
      timestamp
    );
    
    res.status(201).json({ 
      message: `Welcome to the 3d Party! Your initial Merit Score estimate is ${initialMerit} points.`,
      success: true,
      id: result.lastInsertRowid,
      initial_merit: initialMerit
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ 
      error: 'Something went wrong on our end. We\'re working on it.',
      success: false 
    });
  }
});

// GET /api/signups - Get all signups (admin only)
app.get('/api/signups', adminAuth, (req, res) => {
  try {
    const signups = db.prepare('SELECT * FROM signups ORDER BY timestamp DESC').all();
    const count = db.prepare('SELECT COUNT(*) as total FROM signups').get();
    const treasury = db.prepare('SELECT SUM(donation_amount) as total_donations FROM signups WHERE donation_amount > 0').get();
    
    res.json({ 
      signups,
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

// ==================== SERVE HTML FILES ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'join.html'));
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

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`\n🎉 3d Party running at http://localhost:${PORT}`);
  console.log(`📊 Admin: http://localhost:${PORT}/admin`);
  console.log(`🔑 Password: ${ADMIN_PASSWORD}`);
  console.log(`💡 "No, we are not doing 3rd party insurance."\n`);
});