const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== SYSTEM SETTINGS ====================
// All configurable values stored in DB, with defaults
const DEFAULT_SETTINGS = {
  visitor_timeout_ms: 5 * 60 * 1000,
  enroll_rate_limit_ms: 60 * 1000,
  enroll_max_per_day: 50,
  vote_cooldown_ms: 60 * 60 * 1000,
  proposal_voting_days: 7,
  wall_post_max_length: 500,
  proposal_title_max_length: 200,
  proposal_description_max_length: 8000,
  nickname_max_length: 50,
  wall_posts_limit: 100,
  recent_votes_limit: 50,
  signup_base_merit: 50,
  merit_skills: 250,
  merit_action: 200,
  merit_ideas: 150,
  merit_donation: 100,
  donation_bonus_per_100: 5,
  max_upload_bytes: 5 * 1024 * 1024,
  target_members: 13000,
  target_treasury: 13000
};

function getSettings() {
  try {
    const row = db.prepare('SELECT settings_json FROM system_settings WHERE id = 1').get();
    if (row && row.settings_json) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(row.settings_json) };
    }
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}

function updateSettings(newSettings) {
  const current = getSettings();
  const merged = { ...current, ...newSettings };
  db.prepare('INSERT OR REPLACE INTO system_settings (id, settings_json, updated_at) VALUES (1, ?, ?)')
    .run(JSON.stringify(merged), new Date().toISOString());
  return merged;
}

// ==================== SIMPLE ANALYTICS - ACTIVE VISITORS ====================
// Store active visitors: { sessionId: timestamp }
const activeVisitors = new Map();

function getClientIp(req) {
  return req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
}

function cleanupExpiredVisitors() {
  const now = Date.now();
  const timeout = getSettings().visitor_timeout_ms;
  for (const [sessionId, lastSeen] of activeVisitors.entries()) {
    if (now - lastSeen > timeout) {
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

// Migration: Add last_login column for tracking user visits
try {
  db.exec(`ALTER TABLE signups ADD COLUMN last_login TEXT`);
  console.log(`✓ Migration: Added last_login to signups`);
} catch (e) {
  // Column already exists or other error - ignore
}

// Fix signups table schema - remove CHECK constraint if it exists
// Only run once: if signups_new already exists we know this migration was done before
try {
  const signupsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='signups'`).get();
  const signupsNewExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='signups_new'`).get();
  if (!signupsExists || signupsNewExists) {
    console.log('✓ Signups table schema already correct');
  } else {
    db.exec(`CREATE TABLE signups_new (
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
    )`);

    db.exec(`INSERT INTO signups_new (id, phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, unregistered_at, unregistered_by, unregister_justification, timestamp)
             SELECT id, phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, unregistered_at, unregistered_by, unregister_justification, timestamp FROM signups`);

    db.exec('DROP TABLE signups');
    db.exec('ALTER TABLE signups_new RENAME TO signups');
    console.log('✓ Migration: Fixed signups table schema');
  }
} catch (e) {
  console.log('✓ Signups table schema already correct');
}

// Migration: Make phone and nid nullable for privacy-preserving enrollments
// (family/friend enrollments may omit phone/nid; self-registration still requires them)
try {
  const cols = db.prepare(`PRAGMA table_info(signups)`).all();
  const phoneCol = cols.find(c => c.name === 'phone');
  if (phoneCol && phoneCol.notnull) {
    // Phone still has NOT NULL — migration is needed
    const hasLastLogin = cols.some(c => c.name === 'last_login');

    // Clean up any stale temp table to avoid duplicate data
    db.exec('DROP TABLE IF EXISTS signups_v2');

    let createSql = `CREATE TABLE signups_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      nid TEXT,
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
      timestamp TEXT NOT NULL`;
    if (hasLastLogin) createSql += ',\n      last_login TEXT';
    createSql += '\n    )';
    db.exec(createSql);

    let insertSql = `INSERT INTO signups_v2 (id, phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, unregistered_at, unregistered_by, unregister_justification, timestamp`;
    let selectSql = `SELECT id, phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, unregistered_at, unregistered_by, unregister_justification, timestamp`;
    if (hasLastLogin) {
      insertSql += ', last_login)';
      selectSql += ', last_login';
    } else {
      insertSql += ')';
    }
    selectSql += ' FROM signups';
    db.exec(insertSql + ' ' + selectSql);

    db.exec('DROP TABLE signups');
    db.exec('ALTER TABLE signups_v2 RENAME TO signups');
    console.log('✓ Migration: Made phone and nid nullable in signups');
  } else {
    console.log('✓ Phone/NID already nullable');
  }
} catch (e) {
  console.log('⚠ Phone/NID nullable migration error:', e.message);
}

// Referrals table - track who introduced whom
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referred_id INTEGER NOT NULL,
    relation TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    details TEXT,
    base_reward_given INTEGER DEFAULT 0,
    engagement_bonus_given INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    referred_joined_at TEXT,
    first_action_at TEXT,
    FOREIGN KEY (referrer_id) REFERENCES signups(id),
    FOREIGN KEY (referred_id) REFERENCES signups(id)
  )
`);

// Migration: Add missing columns to referrals
try {
  db.exec('ALTER TABLE referrals ADD COLUMN details TEXT');
} catch (e) {}

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

// Migration: Add is_approved column to existing wall_posts table
try {
  db.exec(`ALTER TABLE wall_posts ADD COLUMN is_approved INTEGER DEFAULT 1`);
} catch (e) {
  // Column already exists, ignore error
}

// Migration: Add thread_id column for grouping related posts
try {
  db.exec(`ALTER TABLE wall_posts ADD COLUMN thread_id TEXT`);
} catch (e) {
  // Column already exists, ignore error
}

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

// Migrate database schema if needed
try {
  const tableInfo = db.prepare('PRAGMA table_info(signups)').all();
  const columns = tableInfo.map(col => col.name);
  
  const requiredColumns = {
    'auth_token': 'TEXT',
    'unregistered_at': 'TEXT',
    'unregistered_by': 'TEXT',
    'unregister_justification': 'TEXT'
  };
  
  for (const [column, type] of Object.entries(requiredColumns)) {
    if (!columns.includes(column)) {
      db.exec(`ALTER TABLE signups ADD COLUMN ${column} ${type}`);
      console.log(`✓ Added ${column} column to signups table`);
    }
  }
} catch (error) {
  console.log('⚠ Database migration error:', error.message);
}

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

// ==================== EVENTS TABLE ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    event_date TEXT NOT NULL,
    location TEXT,
    created_at TEXT NOT NULL
  )
`);

// ==================== DONATIONS TABLE (for tracking pending/verified donations) ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS donations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    phone TEXT,
    nid TEXT,
    amount REAL NOT NULL,
    slip_filename TEXT,
    remarks TEXT,
    status TEXT DEFAULT 'pending',
    verified_by TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES signups(id)
  )
`);

// Add remarks column if it doesn't exist (for existing databases)
try {
  db.exec(`ALTER TABLE donations ADD COLUMN remarks TEXT`);
} catch (e) {
  // Column already exists, ignore error
}

// Migration: Make phone and nid nullable in donations table
// (donations can be submitted without phone/nid by anonymous donors)
try {
  const donationCols = db.prepare(`PRAGMA table_info(donations)`).all();
  const phoneColDonations = donationCols.find(c => c.name === 'phone');
  if (phoneColDonations && phoneColDonations.notnull) {
    const existingRows = donationCols.map(c => c.name);
    const hasUserId = existingRows.includes('user_id');
    const hasNid = existingRows.includes('nid');
    const hasRemarks = existingRows.includes('remarks');
    const hasVerifiedBy = existingRows.includes('verified_by');
    const hasVerifiedAt = existingRows.includes('verified_at');

    db.exec('DROP TABLE IF EXISTS donations_v2');

    let createSql = `CREATE TABLE donations_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      phone TEXT,
      nid TEXT,
      amount REAL NOT NULL,
      slip_filename TEXT,
      remarks TEXT,
      status TEXT DEFAULT 'pending',
      verified_by TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL`;
    createSql += '\n    )';

    let insertCols = ['id', 'amount', 'slip_filename', 'status', 'created_at'];
    let selectCols = ['id', 'amount', 'slip_filename', 'status', 'created_at'];
    if (hasUserId) { insertCols.push('user_id'); selectCols.push('user_id'); }
    if (hasNid) { insertCols.push('nid'); selectCols.push('nid'); }
    if (hasRemarks) { insertCols.push('remarks'); selectCols.push('remarks'); }
    if (hasVerifiedBy) { insertCols.push('verified_by'); selectCols.push('verified_by'); }
    if (hasVerifiedAt) { insertCols.push('verified_at'); selectCols.push('verified_at'); }
    // Always include phone in the data copy
    insertCols.push('phone');
    selectCols.push('phone');

    const insertSql = `INSERT INTO donations_v2 (${insertCols.join(', ')}) SELECT ${selectCols.join(', ')} FROM donations`;
    db.exec(createSql);
    db.exec(insertSql);
    db.exec('DROP TABLE donations');
    db.exec('ALTER TABLE donations_v2 RENAME TO donations');
    console.log('✓ Migration: Made phone/nid nullable in donations table');
  } else {
    console.log('✓ Donations phone/nid already nullable');
  }
} catch (e) {
  console.log('⚠ Donations phone/nid nullable migration error:', e.message);
}

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

// System settings table (admin-configurable)
db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    id INTEGER PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const existingSystemSettings = db.prepare('SELECT id FROM system_settings WHERE id = 1').get();
if (!existingSystemSettings) {
  db.prepare('INSERT INTO system_settings (id, settings_json, updated_at) VALUES (1, ?, ?)')
    .run(JSON.stringify(DEFAULT_SETTINGS), new Date().toISOString());
}

console.log('✓ Leadership structure tables initialized');

// ==================== ADD DEMO DATA ====================
// Add demo proposals if table is empty
const demoProposals = db.prepare('SELECT COUNT(*) as cnt FROM proposals').get();
if (demoProposals.cnt === 0) {
  const now = new Date().toISOString();
  const futureDate = new Date(Date.now() + getSettings().proposal_voting_days * 24 * 60 * 60 * 1000).toISOString();
  
  const demoData = [
    { title: 'Establish Free Public Wi-Fi in All Islands', description: 'Provide free internet access to all inhabited islands in Maldives, starting with the most underserved regions. This will help bridge the digital divide and enable remote education and work opportunities.', category: 'infrastructure' },
    { title: 'Ban Single-Use Plastics by 2025', description: 'Phase out all single-use plastic bags, bottles, and packaging by December 2025. Replace with biodegradable alternatives. Exceptions for medical and essential uses.', category: 'environment' },
    { title: 'Mandatory Financial Literacy Education', description: 'Introduce financial literacy as a mandatory subject in secondary schools. Topics: budgeting, saving, investing, loans, and avoiding predatory lending.', category: 'education' },
    { title: 'Remote Work Visa for Digital Nomads', description: 'Create a special visa category for remote workers and digital nomads, allowing them to live in Maldives for 6-12 months while working for foreign employers.', category: 'economy' },
    { title: 'Protect Coral Reefs with AI Monitoring', description: 'Deploy AI-powered monitoring systems to track coral reef health in real-time. Automatic alerts for bleaching events, illegal fishing, and pollution. Immediate response teams.', category: 'environment' }
  ];
  
  const insertProp = db.prepare('INSERT INTO proposals (title, description, category, created_by_nickname, status, created_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  demoData.forEach(d => {
    insertProp.run(d.title, d.description, d.category, 'DemoBot', 'active', now, futureDate);
  });
  console.log('✓ Demo proposals added');
}

// Add demo wall posts if table is empty
const demoWallPosts = db.prepare('SELECT COUNT(*) as cnt FROM wall_posts').get();
if (demoWallPosts.cnt === 0) {
  const now = new Date().toISOString();
  
  const demoPosts = [
    { nickname: 'Aisha from Fuvahmulah', message: 'Just joined! Excited to be part of building a better Maldives. The merit system is so fair — finally a party where everyone has a voice!' },
    { nickname: 'Mohamed from Male', message: 'The live treasury idea is brilliant. Knowing exactly where every rufiyaa goes builds so much trust. Already donated 500 MVR!' },
    { nickname: 'Fathimath from Addu', message: 'Can we propose a law to fix the garbage collection in Addu? The current system really needs an upgrade.' },
    { nickname: 'Ali from Kulhudhuffushi', message: 'Love the 3% goal! Told 5 friends today. If we each bring 5 people, we hit 13,000 in no time 🚀' },
    { nickname: 'Hassan from Thinadhoo', message: 'The whitepaper is incredible. Finally a political party that explains everything transparently. No more hidden agendas!' }
  ];
  
  const insertPost = db.prepare('INSERT INTO wall_posts (nickname, message, timestamp) VALUES (?, ?, ?)');
  demoPosts.forEach(p => {
    insertPost.run(p.nickname, p.message, now);
  });
  console.log('✓ Demo wall posts added');
}

// Migration: Add password_hash to signups for password-based login
try {
  db.exec('ALTER TABLE signups ADD COLUMN password_hash TEXT');
  console.log('✓ Migration: Added password_hash to signups');
} catch (e) {}

// Migration: Add created_by_user_id to proposals for tracking who created what
try {
  db.exec('ALTER TABLE proposals ADD COLUMN created_by_user_id INTEGER REFERENCES signups(id)');
  console.log('✓ Migration: Added created_by_user_id to proposals');
} catch (e) {}

// Migration: Add created_by_user_id to ranked_proposals
try {
  db.exec('ALTER TABLE ranked_proposals ADD COLUMN created_by_user_id INTEGER REFERENCES signups(id)');
  console.log('✓ Migration: Added created_by_user_id to ranked_proposals');
} catch (e) {}

// ==================== SECURITY HELPERS ====================
function sanitizeHTML(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(__dirname));

// Favicon handler
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ==================== HIDDEN ENROLLMENT API (Undocumented) ====================
// For enrolling friends/family - rate limited hidden feature
const https = require('https');

const enrollRateLimits = new Map();

function checkEnrollRateLimit(ip) {
  const settings = getSettings();
  const ENROLL_RATE_LIMIT_MS = settings.enroll_rate_limit_ms;
  const ENROLL_MAX_PER_DAY = settings.enroll_max_per_day;
  const now = Date.now();
  const record = enrollRateLimits.get(ip);
  
  if (!record) {
    enrollRateLimits.set(ip, { lastRequest: now, dailyCount: 1, dailyReset: new Date(now + 24*60*60*1000) });
    return { allowed: true, remaining: ENROLL_MAX_PER_DAY - 1, resetIn: ENROLL_RATE_LIMIT_MS };
  }
  
  if (now > record.dailyReset.getTime()) {
    record.dailyCount = 1;
    record.dailyReset = new Date(now + 24*60*60*1000);
    enrollRateLimits.set(ip, record);
    return { allowed: true, remaining: ENROLL_MAX_PER_DAY - 1, resetIn: ENROLL_RATE_LIMIT_MS };
  }
  
  if (record.dailyCount >= ENROLL_MAX_PER_DAY) {
    return { allowed: false, remaining: 0, resetIn: record.dailyReset.getTime() - now };
  }
  
  if (now - record.lastRequest < ENROLL_RATE_LIMIT_MS) {
    return { allowed: false, remaining: ENROLL_MAX_PER_DAY - record.dailyCount, resetIn: ENROLL_RATE_LIMIT_MS - (now - record.lastRequest) };
  }
  
  record.lastRequest = now;
  record.dailyCount++;
  enrollRateLimits.set(ip, record);
  
  return { allowed: true, remaining: ENROLL_MAX_PER_DAY - record.dailyCount, resetIn: 0 };
}

// Helper: proxy a search request to the external directory API (GET /api/public/search/)
// Returns a Promise that resolves with { results, count } or rejects
function directorySearch(apiKey, apiHost, searchFields) {
  const params = new URLSearchParams();
  if (searchFields.q) params.append('q', searchFields.q);
  if (searchFields.name) params.append('name', searchFields.name);
  if (searchFields.island) params.append('island', searchFields.island);
  if (searchFields.atoll) params.append('atoll', searchFields.atoll);
  if (searchFields.profession) params.append('profession', searchFields.profession);
  params.append('limit', String(searchFields.limit || 20));
  if (searchFields.offset) params.append('offset', String(searchFields.offset));

  const path = '/api/public/search/?' + params.toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: apiHost,
      path: path,
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json'
      },
      timeout: 10000
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => { data += chunk; });
      proxyRes.on('end', () => {
        if (proxyRes.statusCode >= 400) {
          reject(new Error(`Directory service returned ${proxyRes.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve({ results: parsed.results || [], count: parsed.count || 0 });
        } catch (e) {
          reject(new Error('Invalid response from directory service'));
        }
      });
    });

    proxyReq.on('error', (e) => reject(e));
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('Directory service timeout')); });
    proxyReq.end();
  });
}

// POST /api/enroll/lookup - Search external directory for members
// Proxies to external directory API: GET /api/public/search/
// Used for enrolling friends and family - requires auth, rate limited
// When only a generic 'query' is provided, searches by name AND island in
// parallel and merges results so that name-only or island-only searches work.
app.post('/api/enroll/lookup', userAuth, async (req, res) => {
  const ip = getClientIp(req);
  const rateCheck = checkEnrollRateLimit(ip);

  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded. Try again later.',
      retry_after_seconds: Math.ceil(rateCheck.resetIn / 1000),
      remaining_daily: 0,
      success: false
    });
  }

  const { query, name, island, atoll, profession, address } = req.body;

  if (!query && !name && !island && !atoll && !profession && !address) {
    return res.status(400).json({
      error: 'At least one search parameter required: query, name, island, atoll, profession, or address',
      success: false
    });
  }

  const apiKey = (process.env.DIRECTORY_API_KEY || '').replace(/[\r\n\t\x00-\x1f]/g, '').trim();
  const apiHost = (process.env.DIRECTORY_API_HOST || '').replace(/[\r\n\t\x00-\x1f]/g, '').trim();
  if (!apiKey || !apiHost) {
    return res.status(503).json({ error: 'Directory service not configured', success: false });
  }

  try {
    let mergedResults = [];

    // When specific fields are provided, do a single targeted search
    if (name || island || atoll || profession || address) {
      // Map legacy 'address' field to generic 'q' since the new API uses q for full-text search
      const searchFields = {
        q: query || address || '',
        name: name || '',
        island: island || '',
        atoll: atoll || '',
        profession: profession || ''
      };
      const result = await directorySearch(apiKey, apiHost, searchFields);
      mergedResults = result.results;
    } else {
      // Generic query only — search by name, island, and via q in parallel,
      // then merge & deduplicate by pid so all lookups return relevant results.
      const searches = [
        directorySearch(apiKey, apiHost, { q: query }),
        directorySearch(apiKey, apiHost, { name: query }),
        directorySearch(apiKey, apiHost, { island: query })
      ];

      const [byQ, byName, byIsland] = await Promise.allSettled(searches);

      const seenPids = new Set();
      const addUnique = (results) => {
        for (const r of results) {
          if (!seenPids.has(r.pid)) {
            seenPids.add(r.pid);
            mergedResults.push(r);
          }
        }
      };

      if (byQ.status === 'fulfilled') addUnique(byQ.value.results);
      if (byName.status === 'fulfilled') addUnique(byName.value.results);
      if (byIsland.status === 'fulfilled') addUnique(byIsland.value.results);
    }

    if (mergedResults.length > 0) {
      const first = mergedResults[0];
      console.log('[Directory Search] sample result keys:', Object.keys(first));
      console.log('[Directory Search] sample result:', JSON.stringify(first).substring(0, 800));
    }
    console.log(`[Directory Search] merged ${mergedResults.length} results`);

    res.json({
      success: true,
      results: mergedResults,
      total_count: mergedResults.length,
      rate_limit: {
        remaining_daily: rateCheck.remaining,
        reset_in_seconds: rateCheck.resetIn > 0 ? Math.ceil(rateCheck.resetIn / 1000) : null
      }
    });
  } catch (e) {
    console.error(`[Directory Search] error: ${e.message}`);
    if (e.message.includes('returned')) {
      return res.status(502).json({ error: e.message, success: false });
    }
    if (e.message.includes('timeout')) {
      return res.status(504).json({ error: e.message, success: false });
    }
    res.status(502).json({ error: 'Directory service unavailable: ' + e.message, success: false });
  }
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
if (!process.env.ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD environment variable must be set');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminSessions = new Map();

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Nice try, insurance agent. Wrong password.' });
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!adminSessions.has(token)) {
    return res.status(401).json({ error: 'Nice try, insurance agent. Wrong password.' });
  }
  next();
}

// ==================== PUBLIC WALL API (No Signup Required) ====================
// GET /api/wall - Get all posts
app.get('/api/wall', (req, res) => {
  try {
    const posts = db.prepare(`SELECT * FROM wall_posts WHERE is_approved = 1 ORDER BY timestamp DESC LIMIT ?`).all(getSettings().wall_posts_limit);
    const count = db.prepare('SELECT COUNT(*) as total FROM wall_posts WHERE is_approved = 1').get();
    res.json({ posts, total: count.total, success: true });
  } catch (error) {
    console.error('Wall fetch error:', error);
    res.status(500).json({ error: 'Could not fetch posts', success: false });
  }
});

// GET /api/wall/thread/:threadId - Get posts for a specific thread
app.get('/api/wall/thread/:threadId', (req, res) => {
  const { threadId } = req.params;
  try {
    const posts = db.prepare(`
      SELECT * FROM wall_posts 
      WHERE is_approved = 1 AND thread_id = ?
      ORDER BY timestamp DESC 
      LIMIT 50
    `).all(threadId);
    res.json({ posts, success: true });
  } catch (error) {
    console.error('Wall thread fetch error:', error);
    res.status(500).json({ error: 'Could not fetch thread posts', success: false });
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
  
  // Check if user is authenticated (for tracking who created it)
  let userId = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
      if (user) userId = user.id;
    } catch (e) {}
  }
  
  if (!title || title.trim().length < 5) {
    return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
  }
  
  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description must be at least 20 characters', success: false });
  }
  
  try {
    const settings = getSettings();
    const createdAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + settings.proposal_voting_days * 24 * 60 * 60 * 1000).toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO proposals (title, description, category, created_by_nickname, created_at, ends_at, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      sanitizeHTML(title.trim().substring(0, settings.proposal_title_max_length)),
      sanitizeHTML(description.trim().substring(0, settings.proposal_description_max_length)),
      category || 'general',
      sanitizeHTML(nickname ? nickname.trim().substring(0, settings.nickname_max_length) : 'Anonymous'),
      createdAt,
      endsAt,
      userId
    );
    
    if (userId) logActivity('proposal_created', userId, result.lastInsertRowid, { title: title.trim().substring(0, 100) }, req);
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
  
  // Check if user is authenticated (for tracking who created it)
  let userId = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
      if (user) userId = user.id;
    } catch (e) {}
  }
  
  if (!title || title.trim().length < 5) {
    return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
  }
  
  if (!options || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'At least 2 options required', success: false });
  }
  
  try {
    const settings = getSettings();
    const createdAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + settings.proposal_voting_days * 24 * 60 * 60 * 1000).toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO ranked_proposals (title, description, category, options, created_by_nickname, created_at, ends_at, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      sanitizeHTML(title.trim().substring(0, settings.proposal_title_max_length)),
      sanitizeHTML(description.trim().substring(0, settings.proposal_description_max_length)),
      category || 'election',
      JSON.stringify(options.map(o => sanitizeHTML(o.trim())).filter(o => o)),
      sanitizeHTML(nickname ? nickname.trim().substring(0, settings.nickname_max_length) : 'Anonymous'),
      createdAt,
      endsAt,
      userId
    );

    if (userId) logActivity('proposal_created', userId, result.lastInsertRowid, { title: title.trim().substring(0, 100) }, req);
    
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

// GET /api/mvlaws/search - Search laws, articles, and clauses
app.get('/api/mvlaws/search', (req, res) => {
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
    } catch (e) {}
    
    res.json({ totalVotes: totalVotes.total, articlesVoted: articlesVoted.total, breakdown: voteBreakdown, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats: ' + error.message, success: false });
  }
});

// GET /api/mvlaws/recent-votes - Get recent votes (must be before /:id route)
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

// GET /api/mvlaws/top-voted - Get most voted articles (must be before /:id route)
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
    res.status(500).json({ error: 'Could not fetch top voted articles', success: false });
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
    }
    
    res.json({ message: 'Vote recorded!', success: true });
  } catch (error) {
    console.error('Law vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
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
app.post('/api/generate-law-draft', async (req, res) => {
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

// POST /api/wall - Add a post (no signup required)
app.post('/api/wall', (req, res) => {
  const { nickname, message } = req.body;
  
  if (!nickname || nickname.trim().length < 2) {
    return res.status(400).json({ error: 'Please enter a nickname (at least 2 characters)', success: false });
  }
  
  if (!message || message.trim().length < 1) {
    return res.status(400).json({ error: 'Please write something', success: false });
  }
  
  if (message.length > getSettings().wall_post_max_length) {
    return res.status(400).json({ error: `Message too long (max ${getSettings().wall_post_max_length} characters)`, success: false });
  }
  
  try {
    const timestamp = new Date().toISOString();
    const cleanedNickname = sanitizeHTML(nickname.trim().substring(0, getSettings().nickname_max_length));
    const cleanedMessage = sanitizeHTML(message.trim().substring(0, getSettings().wall_post_max_length));
    const stmt = db.prepare('INSERT INTO wall_posts (nickname, message, timestamp) VALUES (?, ?, ?)');
    const result = stmt.run(cleanedNickname, cleanedMessage, timestamp);
    
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
  function safeQuery(sql, defaultVal = 0) {
    try { const r = db.prepare(sql).get(); return r.total || defaultVal; }
    catch (e) { return defaultVal; }
  }

  try {
    const members = safeQuery('SELECT COUNT(*) as total FROM signups');
    const wallPosts = safeQuery('SELECT COUNT(*) as total FROM wall_posts WHERE is_approved = 1');
    const signupTreasury = safeQuery('SELECT SUM(donation_amount) as total FROM signups WHERE donation_amount > 0');
    const donationTreasury = safeQuery('SELECT SUM(amount) as total FROM donations WHERE status = "verified"');
    const treasury = signupTreasury + donationTreasury;

    res.json({ members, wallPosts, treasury, success: true });
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
   // Clean phone number to store only digits (consistent with validation and login)
   const cleanedPhone = phone.replace(/\D/g, '');
  
  // Basic NID validation
  const nidRegex = /^[A-Za-z][0-9]{6,7}$/;
  if (!nidRegex.test(nid.trim())) {
    return res.status(400).json({ 
      error: 'Please enter a valid NID (e.g., A123456).',
      success: false 
    });
  }
  
   // Check for duplicate phone or NID
   const existing = db.prepare('SELECT id FROM signups WHERE phone = ? OR nid = ?').get(cleanedPhone, nid);
  if (existing) {
    return res.status(409).json({ 
      error: 'You\'re already in the party! One membership per person, please.',
      success: false 
    });
  }
  
  // Calculate initial merit estimate based on contribution types
  const settings = getSettings();
  const meritEstimates = {
    'skills': settings.merit_skills,
    'action': settings.merit_action,
    'ideas': settings.merit_ideas,
    'donation': settings.merit_donation
  };
  let initialMerit = settings.signup_base_merit;
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
    // Bonus merit for donations (diminishing returns)
    const donationBonus = Math.floor(finalDonation / 100) * settings.donation_bonus_per_100;
    initialMerit += donationBonus;
  }
  
   try {
     const timestamp = new Date().toISOString();
     const contributionTypeJson = JSON.stringify(typesArray);
     const stmt = db.prepare(
       'INSERT INTO signups (phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
     );
     const result = stmt.run(
       cleanedPhone, 
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
      const authToken = crypto.randomBytes(32).toString('hex');
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
    
    // Get current member count for progress percentage
    const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups').get().total;
    const settings = getSettings();
    const targetMembers = settings.target_members || 13000;
    const percentComplete = ((memberCount / targetMembers) * 100).toFixed(2);
    const progressMsg = `[size=${memberCount}] [progress=${percentComplete}%]`;
    
    // Auto-post to welcome thread
    const displayName = sanitizeHTML(name || username || 'A new member');
    const welcomeMsg = `🌴 ${displayName} just joined! We're ${memberCount.toLocaleString()} strong — ${percentComplete}% of our 13,000 member goal!`;
    try {
      db.prepare('INSERT INTO wall_posts (nickname, message, timestamp, thread_id) VALUES (?, ?, ?, ?)')
        .run('admin', welcomeMsg, timestamp, 'new_members_welcome');
    } catch (e) {
      console.log('Could not post welcome to wall:', e.message);
    }
    
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
        contribution_type: user.contribution_type ? (() => {
          try { return JSON.parse(user.contribution_type); }
          catch(e) { return [user.contribution_type]; }
        })() : [],
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

// POST /api/reregister - Re-register an unregistered user (admin only)
app.post('/api/reregister', adminAuth, (req, res) => {
  const { user_id } = req.body;
  
  if (!user_id) {
    return res.status(400).json({ error: 'User ID required', success: false });
  }
  
  try {
    const user = db.prepare('SELECT id, name, phone FROM signups WHERE id = ?').get(user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found', success: false });
    }
    
    if (user.is_verified === 1) {
      return res.status(400).json({ error: 'User is already verified', success: false });
    }
    
    db.prepare(`
      UPDATE signups 
      SET is_verified = 1, unregistered_at = NULL, unregistered_by = NULL, unregister_justification = NULL
      WHERE id = ?
    `).run(user_id);
    
    res.json({ 
      message: `User ${user.name || user.phone || '#' + user_id} has been re-registered.`,
      success: true 
    });
  } catch (error) {
    console.error('Reregister error:', error);
    res.status(500).json({ error: 'Could not re-register user', success: false });
  }
});

// GET /api/signups/count - Get signup count (public)
app.get('/api/signups/count', (req, res) => {
  try {
    const count = db.prepare('SELECT COUNT(*) as total FROM signups').get();
    res.json({ total: count.total, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch count', success: false });
  }
});

// GET /api/stats/new-joins - Get number of new members since last visit
// Query param: last_login (ISO timestamp)
app.get('/api/stats/new-joins', (req, res) => {
  const { last_login } = req.query;
  
  if (!last_login) {
    return res.status(400).json({ error: 'last_login parameter required', success: false });
  }
  
  try {
    const sinceDate = last_login.replace(/'/g, "''");
    const newJoins = db.prepare(`
      SELECT COUNT(*) as total FROM signups 
      WHERE timestamp > ?
    `).get(sinceDate);
    
    const totalMembers = db.prepare('SELECT COUNT(*) as total FROM signups').get();
    
    res.json({
      new_joins: newJoins.total,
      total_members: totalMembers.total,
      success: true
    });
  } catch (error) {
    console.error('New joins stats error:', error);
    res.status(500).json({ error: 'Could not fetch stats', success: false });
  }
});

// GET /api/signups - Get all signups (admin only, with pagination)
app.get('/api/signups', adminAuth, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    
    const signups = db.prepare('SELECT * FROM signups ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
    const count = db.prepare('SELECT COUNT(*) as total FROM signups').get();
    const treasury = db.prepare('SELECT SUM(donation_amount) as total_donations FROM signups WHERE donation_amount > 0').get();
    const donorCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE donation_amount > 0').get();
    const today = new Date().toISOString().split('T')[0];
    const todayCount = db.prepare('SELECT COUNT(*) as total FROM signups WHERE timestamp >= ?').get(today);
    
    const parsedSignups = signups.map(s => ({
      ...s,
      contribution_type: s.contribution_type ? (() => {
        try { return JSON.parse(s.contribution_type); }
        catch(e) { return [s.contribution_type]; }
      })() : []
    }));
    
    res.json({ 
      signups: parsedSignups,
      total: count.total,
      total_treasury: treasury.total_donations || 0,
      donor_count: donorCount.total,
      today_count: todayCount.total,
      page: page,
      limit: limit,
      totalPages: Math.ceil(count.total / limit),
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
    const sessionToken = crypto.randomBytes(32).toString('hex');
    adminSessions.set(sessionToken, { createdAt: Date.now() });
    res.json({ 
      success: true, 
      token: sessionToken,
      message: 'Welcome back. The insurance agents are still locked out.'
    });
  } else {
    res.status(401).json({ 
      success: false, 
      error: 'Wrong password. If you\'re from an insurance company, please leave.' 
    });
  }
});

// POST /api/check-registration - Check if NID is registered
app.post('/api/check-registration', (req, res) => {
  const { nid } = req.body;
  
  if (!nid) {
    return res.status(400).json({ error: 'NID is required', success: false });
  }
  
  try {
    const user = db.prepare('SELECT id, phone, name, username, is_verified FROM signups WHERE nid = ?').get(nid.trim());
    
    if (!user) {
      return res.json({ registered: false, success: true });
    }
    
    res.json({ 
      registered: true, 
      hasUsername: !!user.username,
      success: true 
    });
  } catch (error) {
    console.error('Check registration error:', error);
    res.status(500).json({ error: 'Could not check registration', success: false });
  }
});

// POST /api/user/login - User login with phone + NID OR username + password
app.post('/api/user/login', (req, res) => {
  const { phone, nid, username, password } = req.body;
  
  // Determine login method
  let user;
  let loginMethod = '';

  if (username && password) {
    // Username + password login
    // username can be: NID or custom username
    // First try password_hash-based login
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    user = db.prepare(`
      SELECT * FROM signups 
      WHERE (username = ? OR nid = ?) 
      AND password_hash = ? AND is_verified = 1
    `).get(username.trim(), username.trim(), passwordHash);
    loginMethod = 'password_hash';

    // Fallback: if no password_hash set, try phone-as-password (legacy)
    if (!user) {
      const cleanedPassword = password.replace(/\D/g, '');
      user = db.prepare(`
        SELECT * FROM signups 
        WHERE (username = ? OR nid = ?) 
        AND phone = ? AND is_verified = 1
      `).get(username.trim(), username.trim(), cleanedPassword);
      loginMethod = 'legacy_phone';
    }
  } else if (phone && nid) {
     // Phone + NID login (original method)
     // Clean phone input for consistency with validation/storage
     const cleanedPhone = phone.replace(/\D/g, '');
     user = db.prepare('SELECT * FROM signups WHERE phone = ? AND nid = ? AND is_verified = 1').get(cleanedPhone, nid);
   }
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials or not registered', success: false });
  }
  
  try {
    // Generate auth token
    const authToken = crypto.randomBytes(32).toString('hex');
    const lastLogin = new Date().toISOString();
    db.prepare('UPDATE signups SET auth_token = ?, last_login = ? WHERE id = ?').run(authToken, lastLogin, user.id);

    logActivity('user_login', user.id, null, { method: loginMethod || 'phone_nid' }, req);
    
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
        contribution_type: user.contribution_type ? (() => {
          try { return JSON.parse(user.contribution_type); }
          catch(e) { return [user.contribution_type]; }
        })() : [],
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
    const user = db.prepare('SELECT id FROM signups WHERE phone = ?').get(phone);
    if (user) logActivity('user_logout', user.id, null, null, req);
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

// POST /api/enroll-family-friend - Enroll a family member or friend directly (optimized for logged-in users)
app.post('/api/enroll-family-friend', userAuth, (req, res) => {
  const { name, username, email, island, contribution_types, donation_amount, relation } = req.body;
  // Normalize phone and nid: treat empty strings as null
  const phone = req.body.phone ? req.body.phone.trim() : null;
  const nid = req.body.nid ? req.body.nid.trim() : null;
  const referrerId = req.user.id;

  // Validate mandatory fields
  if (!relation) {
    return res.status(400).json({
      error: 'Relation is required',
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
  }

  let cleanedPhone = null;
  if (phone) {
    // Basic phone validation (Maldivian format: 7 digits)
    const phoneRegex = /^[0-9]{7}$/;
    cleanedPhone = phone.replace(/\D/g, '');
    if (!phoneRegex.test(cleanedPhone)) {
      return res.status(400).json({
        error: 'Please enter a valid 7-digit phone number.',
        success: false
      });
    }
  }

  if (nid) {
    // Basic NID validation
    const nidRegex = /^[A-Za-z][0-9]{6,7}$/;
    if (!nidRegex.test(nid)) {
      return res.status(400).json({
        error: 'Please enter a valid NID (e.g., A123456).',
        success: false
      });
    }
  }

  // Check for duplicate phone or NID only when provided
  if (cleanedPhone || nid) {
    let existing = null;
    if (cleanedPhone && nid) {
      existing = db.prepare('SELECT id, is_verified FROM signups WHERE phone = ? OR nid = ?').get(cleanedPhone, nid);
    } else if (cleanedPhone) {
      existing = db.prepare('SELECT id, is_verified FROM signups WHERE phone = ?').get(cleanedPhone);
    } else if (nid) {
      existing = db.prepare('SELECT id, is_verified FROM signups WHERE nid = ?').get(nid);
    }
    if (existing) {
      return res.status(409).json({
        error: 'This person is already registered with us.',
        success: false
      });
    }
  }

  // Calculate initial merit estimate
  const enrollSettings = getSettings();
  const meritEstimates = {
    'skills': enrollSettings.merit_skills,
    'action': enrollSettings.merit_action,
    'ideas': enrollSettings.merit_ideas,
    'donation': enrollSettings.merit_donation
  };
  let initialMerit = enrollSettings.signup_base_merit;
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
    const donationBonus = Math.floor(finalDonation / 100) * enrollSettings.donation_bonus_per_100;
    initialMerit += donationBonus;
  }

  try {
    const timestamp = new Date().toISOString();
    const contributionTypeJson = JSON.stringify(typesArray);

     // Create the new user
     const stmt = db.prepare(
       'INSERT INTO signups (phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
     );
     const result = stmt.run(
       cleanedPhone,
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

    // Count successful invites for this referrer
    const inviteCount = db.prepare(`
      SELECT COUNT(*) as count FROM referrals
      WHERE referrer_id = ? AND (status = 'joined' OR status = 'active') AND base_reward_given = 1
    `).get(referrerId).count;

    const basePoints = getReferralPoints(inviteCount + 1, false);

    // Create referral record (already joined since we just created the user)
    const insertReferral = db.prepare(`
      INSERT INTO referrals (referrer_id, referred_id, relation, status, base_reward_given, created_at, referred_joined_at)
      VALUES (?, ?, ?, 'joined', ?, ?, ?)
    `);
    insertReferral.run(referrerId, result.lastInsertRowid, relation, basePoints, timestamp, timestamp);

    // Award points to referrer
    db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
      .run(basePoints, referrerId);

    // Log the activity
    logActivity('family_friend_enrolled', referrerId, result.lastInsertRowid, {
      relation,
      base_points_awarded: basePoints,
      referrer_invite_count: inviteCount + 1,
      enrolled_name: name || 'N/A'
    }, req);

     res.status(201).json({
       success: true,
       message: `Successfully enrolled ${name || 'family member'}! You earned ${basePoints} base points. They need to complete their first action for you to get the engagement bonus.`,
       points_earned: basePoints,
       enrolled_user: {
         id: result.lastInsertRowid,
         phone: cleanedPhone,
         name: name || null,
         nid,
         email: email || null,
         username: username ? username.trim() : null,
         island: island || null,
         contribution_type: contributionTypeJson,
         donation_amount: finalDonation,
         initial_merit_estimate: initialMerit,
         timestamp
       }
     });

  } catch (error) {
    console.error('Enroll family/friend error:', error);
    res.status(500).json({
      error: 'Failed to enroll. Please try again.',
      success: false
    });
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
      username: user.username,
      nid: user.nid,
      email: user.email,
      island: user.island,
      contribution_type: user.contribution_type ? (() => {
        try { return JSON.parse(user.contribution_type); }
        catch(e) { return [user.contribution_type]; }
      })() : [],
      donation_amount: user.donation_amount,
      initial_merit_estimate: user.initial_merit_estimate,
      timestamp: user.timestamp,
      last_login: user.last_login,
      password_hash: !!user.password_hash
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

// PUT /api/user/profile - Update user profile (username)
app.put('/api/user/profile', userAuth, (req, res) => {
  const user = req.user;
  const { username, name, email, island } = req.body;
  
  try {
    // Check if username is being updated and if it's taken
    if (username !== undefined) {
      const trimmedUsername = username.trim();
      if (trimmedUsername === '') {
        return res.status(400).json({ error: 'Username cannot be empty', success: false });
      }
      
      const existing = db.prepare('SELECT id FROM signups WHERE username = ? AND id != ?').get(trimmedUsername, user.id);
      if (existing) {
        return res.status(409).json({ error: 'Username already taken', success: false });
      }
      
      db.prepare('UPDATE signups SET username = ? WHERE id = ?').run(trimmedUsername, user.id);
    }
    
    // Update other fields
    if (name !== undefined) {
      db.prepare('UPDATE signups SET name = ? WHERE id = ?').run(name.trim() || null, user.id);
    }
    if (email !== undefined) {
      db.prepare('UPDATE signups SET email = ? WHERE id = ?').run(email.trim() || null, user.id);
    }
    if (island !== undefined) {
      db.prepare('UPDATE signups SET island = ? WHERE id = ?').run(island.trim() || null, user.id);
    }
    
    // Fetch updated user
    const updatedUser = db.prepare('SELECT * FROM signups WHERE id = ?').get(user.id);

    logActivity('profile_update', user.id, null, { fields: Object.keys(req.body).filter(k => req.body[k] !== undefined) }, req);
    
    res.json({ 
      success: true, 
      user: {
        id: updatedUser.id,
        phone: updatedUser.phone,
        name: updatedUser.name,
        username: updatedUser.username,
        nid: updatedUser.nid,
        email: updatedUser.email,
        island: updatedUser.island,
        contribution_type: updatedUser.contribution_type ? (() => {
          try { return JSON.parse(updatedUser.contribution_type); }
          catch(e) { return [updatedUser.contribution_type]; }
        })() : [],
        donation_amount: updatedUser.donation_amount,
        initial_merit_estimate: updatedUser.initial_merit_estimate,
        timestamp: updatedUser.timestamp
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Could not update profile', success: false });
  }
});

// POST /api/user/change-password - Change user password
app.post('/api/user/change-password', userAuth, (req, res) => {
  const user = req.user;
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current password and new password required', success: false });
  }

  if (new_password.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters', success: false });
  }

  // Verify current password
  const currentHash = crypto.createHash('sha256').update(current_password).digest('hex');

  // Check against password_hash if set, or phone number (legacy)
  if (user.password_hash) {
    if (user.password_hash !== currentHash) {
      return res.status(401).json({ error: 'Current password is incorrect', success: false });
    }
  } else {
    const cleanedPhone = user.phone ? user.phone.replace(/\D/g, '') : '';
    if (current_password.replace(/\D/g, '') !== cleanedPhone) {
      return res.status(401).json({ error: 'Current password is incorrect', success: false });
    }
  }

  try {
    const newHash = crypto.createHash('sha256').update(new_password).digest('hex');
    db.prepare('UPDATE signups SET password_hash = ? WHERE id = ?').run(newHash, user.id);
    logActivity('password_change', user.id, null, null, req);
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Could not update password', success: false });
  }
});

// GET /api/user/activity-log - Get user's activity log
app.get('/api/user/activity-log', userAuth, (req, res) => {
  const user = req.user;
  try {
    const logs = db.prepare(`
      SELECT * FROM activity_log 
      WHERE user_id = ? 
      ORDER BY timestamp DESC 
      LIMIT 50
    `).all(user.id);

    res.json({ success: true, logs });
  } catch (error) {
    console.error('Activity log error:', error);
    res.status(500).json({ error: 'Could not fetch activity log', success: false });
  }
});

// GET /api/user/proposals - Get user's proposals/drafts
app.get('/api/user/proposals', userAuth, (req, res) => {
  const user = req.user;
  try {
    const proposals = db.prepare(`
      SELECT id, title, description, category, status, 
             yes_votes, no_votes, abstain_votes, created_at, ends_at
      FROM proposals 
      WHERE created_by_user_id = ? 
      ORDER BY created_at DESC
      LIMIT 50
    `).all(user.id);

    const rankedProposals = db.prepare(`
      SELECT id, title, description, category, status, created_at, ends_at
      FROM ranked_proposals 
      WHERE created_by_user_id = ? 
      ORDER BY created_at DESC
      LIMIT 50
    `).all(user.id);

    res.json({ success: true, proposals, ranked_proposals: rankedProposals });
  } catch (error) {
    console.error('User proposals error:', error);
    res.status(500).json({ error: 'Could not fetch proposals', success: false });
  }
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

// ==================== SYSTEM SETTINGS API ====================
// GET /api/system-settings - Get all system settings (admin only)
app.get('/api/system-settings', adminAuth, (req, res) => {
  try {
    const settings = getSettings();
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch system settings' });
  }
});

// GET /api/public-settings - Get public settings (non-admin)
app.get('/api/public-settings', (req, res) => {
  try {
    const settings = getSettings();
    res.json({ 
      success: true, 
      target_members: settings.target_members,
      target_treasury: settings.target_treasury,
      signup_base_merit: settings.signup_base_merit
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not fetch public settings' });
  }
});

// POST /api/system-settings - Update system settings (admin only)
app.post('/api/system-settings', adminAuth, (req, res) => {
  try {
    const updated = updateSettings(req.body);
    res.json({ success: true, settings: updated });
  } catch (error) {
    console.error('System settings update error:', error);
    res.status(500).json({ success: false, error: 'Could not update system settings' });
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

// ==================== DONATION API ====================
// GET /api/donation-info - Get bank details (public)
app.get('/api/donation-info', (req, res) => {
  try {
    res.json({
      success: true,
      bank_name: process.env.DONATION_BANK_NAME || 'Bank of Maldives',
      account_name: process.env.DONATION_ACCOUNT_NAME || '3d Party',
      account_number: process.env.DONATION_ACCOUNT_NUMBER || '—'
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch donation info', success: false });
  }
});

// POST /api/donate - Submit donation with slip
const upload = multer({
  dest: path.join(dataDir, 'uploads'),
  limits: { fileSize: getSettings().max_upload_bytes },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only images allowed'));
    }
    cb(null, true);
  }
});

// Create uploads dir if not exists
const uploadDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

app.post('/api/donate', upload.single('slip'), (req, res) => {
  const phone = req.body.phone || null;
  const nid = req.body.nid || null;
  const amount = req.body.amount;
  const remarks = req.body.remarks || null;

  if (!amount) {
    return res.status(400).json({ error: 'Donation amount is required', success: false });
  }

  const donationAmount = parseFloat(amount);
  if (isNaN(donationAmount) || donationAmount <= 0) {
    return res.status(400).json({ error: 'Invalid donation amount', success: false });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Deposit slip is required', success: false });
  }

  try {
    const createdAt = new Date().toISOString();

    // Check which columns exist in donations table
    const donationCols = db.prepare(`PRAGMA table_info(donations)`).all();
    const colNames = donationCols.map(c => c.name);
    
    let insertCols = ['amount', 'slip_filename', 'status', 'created_at'];
    let insertVals = [donationAmount, req.file.filename, 'pending', createdAt];
    
    if (colNames.includes('phone')) { insertCols.push('phone'); insertVals.push(phone); }
    if (colNames.includes('nid')) { insertCols.push('nid'); insertVals.push(nid); }
    if (colNames.includes('remarks')) { insertCols.push('remarks'); insertVals.push(remarks); }
    if (colNames.includes('user_id')) { insertCols.push('user_id'); insertVals.push(null); }

    const placeholders = insertVals.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT INTO donations (${insertCols.join(', ')}) VALUES (${placeholders})`);
    const result = stmt.run(...insertVals);
    
    // Log the pending donation for admin review
    logActivity('donation_pending', null, null, {
      phone: phone ? phone.substring(0, 3) + 'xxxx' : null,
      nid: nid ? nid.substring(0, 2) + 'xxxxx' : null,
      amount: donationAmount,
      slip: req.file.filename
    }, req);
    
    res.json({ success: true, message: 'Donation submitted for verification' });
  } catch (error) {
    console.error('Donation error:', error);
    res.status(500).json({ error: 'Could not process donation', success: false });
  }
});

// ==================== EVENTS API ====================
// GET /api/events - Get upcoming events (public)
app.get('/api/events', (req, res) => {
  try {
    const events = db.prepare(`
      SELECT * FROM events 
      WHERE event_date >= date('now') 
      ORDER BY event_date ASC
    `).all();
    res.json({ events, success: true });
  } catch (error) {
    // Events table may not exist yet
    res.json({ events: [], success: true });
  }
});

// ==================== EVENTS MANAGEMENT API (Admin) ====================
// GET /api/admin/events - Get all events (admin only)
app.get('/api/admin/events', adminAuth, (req, res) => {
  try {
    const events = db.prepare(`
      SELECT * FROM events 
      ORDER BY event_date ASC
    `).all();
    res.json({ events, success: true });
  } catch (error) {
    res.json({ events: [], success: true });
  }
});

// POST /api/admin/events - Create a new event (admin only)
app.post('/api/admin/events', adminAuth, (req, res) => {
  const { title, description, event_date, location } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Event title is required', success: false });
  }

  if (!event_date) {
    return res.status(400).json({ error: 'Event date is required', success: false });
  }

  try {
    const createdAt = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO events (title, description, event_date, location, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(title.trim(), description || null, event_date, location || null, createdAt);

    logActivity('event_created', null, result.lastInsertRowid, { title }, req);

    res.json({ success: true, message: 'Event created', id: result.lastInsertRowid });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Could not create event', success: false });
  }
});

// PUT /api/admin/events/:id - Update an event (admin only)
app.put('/api/admin/events/:id', adminAuth, (req, res) => {
  const eventId = parseInt(req.params.id);
  const { title, description, event_date, location } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Event title is required', success: false });
  }

  try {
    const existing = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!existing) {
      return res.status(404).json({ error: 'Event not found', success: false });
    }

    db.prepare(`
      UPDATE events SET title = ?, description = ?, event_date = ?, location = ?
      WHERE id = ?
    `).run(title.trim(), description || null, event_date, location || null, eventId);

    logActivity('event_updated', null, eventId, { title }, req);

    res.json({ success: true, message: 'Event updated' });
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Could not update event', success: false });
  }
});

// DELETE /api/admin/events/:id - Delete an event (admin only)
app.delete('/api/admin/events/:id', adminAuth, (req, res) => {
  const eventId = parseInt(req.params.id);

  try {
    const existing = db.prepare('SELECT id, title FROM events WHERE id = ?').get(eventId);
    if (!existing) {
      return res.status(404).json({ error: 'Event not found', success: false });
    }

    db.prepare('DELETE FROM events WHERE id = ?').run(eventId);

    logActivity('event_deleted', null, eventId, { title: existing.title }, req);

    res.json({ success: true, message: 'Event deleted' });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ error: 'Could not delete event', success: false });
  }
});

// ==================== PROPOSAL MANAGEMENT API (Admin) ====================
// POST /api/admin/proposals/:id/status - Update proposal status (admin only)
app.post('/api/admin/proposals/:id/status', adminAuth, (req, res) => {
  const { status, feedback } = req.body;
  const proposalId = parseInt(req.params.id);
  
  if (!['approved', 'rejected', 'postponed', 'active'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status', success: false });
  }
  
  try {
    const stmt = db.prepare('UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?');
    stmt.run(status, new Date().toISOString(), proposalId);
    
    // Log the action
    logActivity('proposal_status_change', null, proposalId, { status, feedback }, req);
    
    res.json({ success: true, message: `Proposal ${status}` });
  } catch (error) {
    console.error('Proposal status update error:', error);
    res.status(500).json({ error: 'Could not update proposal', success: false });
  }
});

// ==================== ADMIN API ENDPOINTS ====================
// GET /api/admin/proposals - Get all proposals (admin only)
app.get('/api/admin/proposals', adminAuth, (req, res) => {
  try {
    const proposals = db.prepare(`
      SELECT p.*,
             (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id) as vote_count
      FROM proposals p
      ORDER BY p.created_at DESC
    `).all();
    res.json({ proposals, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch proposals', success: false });
  }
});

// PUT /api/admin/proposals/:id - Edit a proposal (admin only)
app.put('/api/admin/proposals/:id', adminAuth, (req, res) => {
  const proposalId = parseInt(req.params.id);
  const { title, description, category } = req.body;

  if (!title || title.trim().length < 5) {
    return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
  }

  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description must be at least 20 characters', success: false });
  }

  try {
    const existing = db.prepare('SELECT id FROM proposals WHERE id = ?').get(proposalId);
    if (!existing) {
      return res.status(404).json({ error: 'Proposal not found', success: false });
    }

    const now = new Date().toISOString();
    const settings = getSettings();
    db.prepare(`
      UPDATE proposals
      SET title = ?, description = ?, category = ?, updated_at = ?
      WHERE id = ?
    `).run(title.trim().substring(0, settings.proposal_title_max_length), description.trim().substring(0, settings.proposal_description_max_length), category || 'general', now, proposalId);

    // Log the action
    logActivity('proposal_edited', null, proposalId, { title: title.trim() }, req);

    res.json({ success: true, message: 'Proposal updated' });
  } catch (error) {
    console.error('Proposal edit error:', error);
    res.status(500).json({ error: 'Could not update proposal', success: false });
  }
});

// GET /api/admin/donations/pending - Get pending donations (admin only)
app.get('/api/admin/donations/pending', adminAuth, (req, res) => {
  try {
    const donations = db.prepare(`
      SELECT d.*, s.name, s.phone as user_phone
      FROM donations d
      LEFT JOIN signups s ON d.user_id = s.id
      WHERE d.status = 'pending'
      ORDER BY d.created_at DESC
    `).all();
    res.json({ donations, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch donations', success: false });
  }
});

// POST /api/admin/donations/:id/verify - Verify a donation (admin only)
app.post('/api/admin/donations/:id/verify', adminAuth, (req, res) => {
  const donationId = parseInt(req.params.id);

  try {
    const donation = db.prepare('SELECT * FROM donations WHERE id = ?').get(donationId);
    if (!donation) {
      return res.status(404).json({ error: 'Donation not found', success: false });
    }

    // Update donation status
    db.prepare(`UPDATE donations SET status = 'verified', verified_at = ?, verified_by = ? WHERE id = ?`)
      .run(new Date().toISOString(), 'admin', donationId);

    // Update user's donation amount if linked to a user
    if (donation.user_id) {
      db.prepare(`UPDATE signups SET donation_amount = donation_amount + ? WHERE id = ?`)
        .run(donation.amount, donation.user_id);
    } else if (donation.phone && donation.nid) {
      // Try to find user by phone/nid
      const user = db.prepare('SELECT id FROM signups WHERE phone = ? AND nid = ?').get(donation.phone, donation.nid);
      if (user) {
        db.prepare(`UPDATE signups SET donation_amount = donation_amount + ? WHERE id = ?`)
          .run(donation.amount, user.id);
      }
    }

    res.json({ success: true, message: 'Donation verified and added to treasury' });
  } catch (error) {
    console.error('Donation verify error:', error);
    res.status(500).json({ error: 'Could not verify donation', success: false });
  }
});

// POST /api/admin/donations/:id/reject - Reject a donation (admin only)
app.post('/api/admin/donations/:id/reject', adminAuth, (req, res) => {
  const donationId = parseInt(req.params.id);
  const { reason } = req.body;
  
  try {
    db.prepare(`UPDATE donations SET status = 'rejected', verified_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), donationId);
    
    res.json({ success: true, message: 'Donation rejected' });
  } catch (error) {
    res.status(500).json({ error: 'Could not reject donation', success: false });
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
  res.redirect('/how-it-works');
});

app.get('/how-it-works', (req, res) => {
  res.sendFile(path.join(__dirname, 'how.html'));
});

app.get('/wall', (req, res) => {
  res.sendFile(path.join(__dirname, 'wall.html'));
});

app.get('/donate', (req, res) => {
  res.sendFile(path.join(__dirname, 'donate.html'));
});

app.get('/events', (req, res) => {
  res.sendFile(path.join(__dirname, 'events.html'));
});

app.get('/join-success', (req, res) => {
  res.sendFile(path.join(__dirname, 'join-success.html'));
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

app.get('/generate-law', (req, res) => {
  res.sendFile(path.join(__dirname, 'generate-law.html'));
});

app.get('/leadership', (req, res) => {
  res.sendFile(path.join(__dirname, 'leadership.html'));
});

app.get('/faq', (req, res) => {
  res.sendFile(path.join(__dirname, 'faq.html'));
});

// ==================== COMPREHENSIVE MIGRATIONS ====================
const migrations = [
  // signups table - already handled above
  
  // referrals table
  { table: 'referrals', col: 'details', def: 'TEXT' },
  
  // activity_log table - should already have details, but ensure it
  { table: 'activity_log', col: 'details', def: 'TEXT' },
  
  // leadership tables
  { table: 'leadership_positions', col: 'details', def: 'TEXT' },
  { table: 'leadership_applications', col: 'details', def: 'TEXT' },
];

migrations.forEach(m => {
  try {
    db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.col} ${m.def}`);
    console.log(`✓ Migration: Added ${m.col} to ${m.table}`);
  } catch (e) {
    // Column exists or other error - ignore
  }
});

// Add updated_at to proposals if missing
try {
  db.exec(`ALTER TABLE proposals ADD COLUMN updated_at TEXT`);
  console.log(`✓ Migration: Added updated_at to proposals`);
} catch (e) {
  // Column exists or other error - ignore
}

// ==================== START SERVER ====================
let version = 'unknown';
try {
  const versionData = fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf8');
  versionData.split('\n').forEach(line => {
    if (line.startsWith('VERSION=')) version = line.replace('VERSION=', '');
  });
} catch (e) {}

app.listen(PORT, () => {
  console.log(`\n🏷️  Version: ${version}`);
  console.log(`🎉 3d Party running at http://localhost:${PORT}`);
  console.log(`📊 Admin: http://localhost:${PORT}/admin`);
  console.log(`💡 "No, we are not doing 3rd party insurance."\n`);
});