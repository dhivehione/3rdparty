const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== SYSTEM SETTINGS ====================
const { DEFAULT_SETTINGS, init: initSettings, getSettings, updateSettings } = require('./src/config/settings');

// ==================== SIMPLE ANALYTICS - ACTIVE VISITORS ====================
const analyticsModule = require('./src/routes/analytics')({ getSettings });
const { activeVisitors, getClientIp, cleanupExpiredVisitors } = analyticsModule;

// Check and close expired proposals every minute (merit-weighted, tiered thresholds)
function closeExpiredProposals() {
  try {
    const settings = getSettings();
    const expiredProposals = db.prepare(`
      SELECT id, created_by_user_id, amendment_of, category, yes_votes, no_votes FROM proposals
      WHERE status = 'active' AND is_closed = 0 AND datetime(ends_at) <= datetime('now')
    `).all();

    expiredProposals.forEach(proposal => {
      const weightedCounts = db.prepare(`
        SELECT choice, SUM(vote_weight) as weighted_yes, SUM(CASE WHEN choice = 'yes' THEN 1 ELSE 0 END) as raw_yes,
               SUM(CASE WHEN choice = 'no' THEN 1 ELSE 0 END) as raw_no,
               SUM(CASE WHEN choice = 'abstain' THEN 1 ELSE 0 END) as raw_abstain
        FROM votes WHERE proposal_id = ?
      `).get(proposal.id);

      const weighted_yes = weightedCounts?.weighted_yes || 0;
      const weighted_no = weightedCounts?.weighted_no || 0;
      const raw_yes = weightedCounts?.raw_yes || 0;
      const raw_no = weightedCounts?.raw_no || 0;
      const raw_abstain = weightedCounts?.raw_abstain || 0;
      const raw_total = raw_yes + raw_no + raw_abstain;

      const threshold = merit.calculateApprovalThreshold(proposal.category);
      const total_weight = weighted_yes + weighted_no;
      const passed = total_weight > 0 && (weighted_yes / total_weight) >= threshold;

      db.prepare('UPDATE proposals SET is_closed = 1, passed = ?, yes_votes = ?, no_votes = ?, abstain_votes = ? WHERE id = ?')
        .run(weighted_yes, weighted_no, raw_abstain, proposal.id);

      if (passed && proposal.amendment_of) {
        const original = db.prepare('SELECT id, created_by_user_id FROM proposals WHERE id = ?').get(proposal.amendment_of);
        if (original && original.created_by_user_id) {
          db.prepare(`
            INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
            VALUES (?, 'bridge_building', 400, ?, 'proposal', 'Bridge-building bonus: Fixed failing proposal', ?)
          `).run(proposal.created_by_user_id, proposal.id, new Date().toISOString());
          db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + 400 WHERE id = ?')
            .run(proposal.created_by_user_id);
        }
      }

      const voters = db.prepare('SELECT user_id FROM votes WHERE proposal_id = ? AND choice != ?').all(proposal.id, 'abstain');
      voters.forEach(voter => {
        if (voter.user_id) {
          const points = passed ? (settings.merit_vote_pass || 2.5) : (settings.merit_vote_fail || 1.0);
          const desc = passed ? 'Voted on passing proposal' : 'Voted on failing proposal';
          db.prepare(`
            INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
            VALUES (?, 'voting', ?, ?, 'proposal', ?, ?)
          `).run(voter.user_id, points, proposal.id, desc, new Date().toISOString());
          db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
            .run(points, voter.user_id);
          maybeEngageReferral(voter.user_id);
        }
      });

      if (proposal.created_by_user_id && passed) {
        const authorPoints = settings.merit_proposal_author || 200;
        db.prepare(`
          INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
          VALUES (?, 'proposal_author', ?, ?, 'proposal', 'Authored passing proposal', ?)
        `).run(proposal.created_by_user_id, authorPoints, proposal.id, new Date().toISOString());
        db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
          .run(authorPoints, proposal.created_by_user_id);
      }

      merit.processProposalStakes(proposal.id, weighted_yes, weighted_no, total_weight);
    });
  } catch (e) {
    console.error('Close expired proposals error:', e);
  }
}
setInterval(closeExpiredProposals, 60000);

// ==================== DATABASE SETUP ====================
const { initDb } = require('./src/db');
const dataDir = path.join(__dirname, 'data');
const { db, lawsDb } = initDb(dataDir);
initSettings(db);

// ==================== AUTH MIDDLEWARE ====================
const { ADMIN_PASSWORD, adminSessions, adminAuth, userAuth } = require('./src/middleware/auth')({ db });

// ==================== DATABASE MIGRATIONS ====================
const { addTreasuryEntry, getTreasuryBalance } = require('./src/services/treasury')({ db });
const { runMigrations } = require('./src/db/migrations');
runMigrations({ db, DEFAULT_SETTINGS, getSettings, addTreasuryEntry });

// ==================== SECURITY HELPERS ====================
// ==================== UTILITIES ====================
const { sanitizeHTML, generateOTP } = require('./src/utils');
const { logActivity } = require('./src/services/activity-log')({ db });
const { getReferralPoints, maybeEngageReferral } = require('./src/services/referral')({ db, getSettings, logActivity });
const merit = require('./src/services/merit')({ db, getSettings, logActivity });

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

// ==================== HIDDEN ENROLLMENT API ====================
app.use(require('./src/routes/enrollment')({ db, getSettings, getClientIp, userAuth }));

// ==================== ANALYTICS API ====================
app.use(analyticsModule.router);

// ==================== PUBLIC WALL API ====================
const { moderateWallContent } = require('./src/services/wall-moderation');
app.use(require('./src/routes/wall')({ db, getSettings, logActivity, merit, maybeEngageReferral, moderateWallContent, sanitizeHTML, getTreasuryBalance }));

// ==================== PROPOSALS API ====================
const proposalsModule = require('./src/routes/proposals')({ db, getSettings, logActivity, merit, maybeEngageReferral, sanitizeHTML, userAuth });
app.use(proposalsModule);

// ==================== RANKED CHOICE VOTING ====================
app.use(require('./src/routes/ranked-proposals')({ db, getSettings, logActivity, merit, maybeEngageReferral, sanitizeHTML }));

// ==================== LEGISLATION & LAWS API ====================
app.use(require('./src/routes/legislation')({ db, lawsDb, getSettings, maybeEngageReferral }));

// ==================== API ENDPOINTS ====================
// ==================== TREASURY API ====================
app.use(require('./src/routes/treasury')({ db, adminAuth, logActivity, addTreasuryEntry, getTreasuryBalance, getSettings }));

// ==================== AUTH API ====================
app.use(require('./src/routes/auth')({ db, getSettings, logActivity, adminAuth, adminSessions, ADMIN_PASSWORD, sanitizeHTML, generateOTP, getReferralPoints, addTreasuryEntry, getTreasuryBalance }));

// ==================== REFERRALS API ====================
app.use(require('./src/routes/referrals')({ db, getSettings, logActivity, userAuth, getReferralPoints, sanitizeHTML, addTreasuryEntry }));

// ==================== ACTIVITY LOG (ADMIN) ====================
// (activity log route stays in social module)

// ==================== ENDORSEMENTS API ====================
// (endorsements routes stay in social module)

// ==================== BOUNTY & ACADEMY ====================
app.use(require('./src/routes/bounty-academy')({ db, userAuth, logActivity, ROLE_STIPENDS: merit.ROLE_STIPENDS, merit }));

// ==================== SOCIAL (QUIZZES, COMMENTS, AMPLIFY, VIOLATIONS) ====================
app.use(require('./src/routes/social')({ db, getSettings, logActivity, adminAuth, userAuth, merit }));

// ==================== EMERITUS COUNCIL (Whitepaper sec VII.4) ====================
// Advisory body for long-term members; top 1% merit for 3+ years OR full Governing Council term
db.exec(`
  CREATE TABLE IF NOT EXISTS emiritus_council (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    invited_at TEXT NOT NULL,
    reason TEXT,
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES signups(id)
  )
`);

function checkEmeritusEligibility() {
  try {
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    const threeYearsAgoStr = threeYearsAgo.toISOString();

    const eligibleByTime = db.prepare(`
      SELECT s.id, s.timestamp FROM signups s
      WHERE s.is_verified = 1 AND s.unregistered_at IS NULL
      AND s.timestamp <= ?
      AND (
        SELECT SUM(me.points) FROM merit_events me WHERE me.user_id = s.id
      ) >= (
        SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY COALESCE((SELECT SUM(points) FROM merit_events WHERE user_id = s.id), 0))
      )
    `).all(threeYearsAgoStr);

    const eligibleByCouncil = db.prepare(`
      SELECT DISTINCT lt.user_id FROM leadership_terms lt
      JOIN leadership_positions lp ON lt.position_id = lp.id
      WHERE lp.position_type = 'council' AND lp.is_active = 1
    `).all();

    const existingEmeritus = db.prepare('SELECT user_id FROM emiritus_council WHERE is_active = 1').all();
    const existingIds = new Set(existingEmeritus.map(e => e.user_id));

    const allEligible = new Set([
      ...eligibleByTime.map(e => e.id),
      ...eligibleByCouncil.map(e => e.user_id)
    ]);

    allEligible.forEach(userId => {
      if (!existingIds.has(userId)) {
        db.prepare('INSERT INTO emiritus_council (user_id, invited_at, reason) VALUES (?, ?, ?)')
          .run(userId, new Date().toISOString(), 'Met eligibility criteria for Emeritus Council');

        db.prepare(`
          INSERT INTO merit_events (user_id, event_type, points, reference_type, description, created_at)
          VALUES (?, 'emeritus_invite', 0, 'emeritus', 'Invited to Emeritus Council', ?)
        `).run(userId, new Date().toISOString());
      }
    });

    console.log(`Emeritus Council check complete: ${allEligible.size} members eligible`);
  } catch (e) {
    console.error('Emeritus check error:', e);
  }
}

setInterval(checkEmeritusEligibility, 24 * 60 * 60 * 1000);
checkEmeritusEligibility();

app.get('/api/emeritus', (req, res) => {
  try {
    const members = db.prepare(`
      SELECT ec.*, s.name, s.username, s.initial_merit_estimate as merit_score
      FROM emiritus_council ec
      JOIN signups s ON ec.user_id = s.id
      WHERE ec.is_active = 1
      ORDER BY ec.invited_at DESC
    `).all();

    res.json({ success: true, members });
  } catch (error) {
    console.error('Get emiritus error:', error);
    res.status(500).json({ error: 'Could not fetch emeritus council', success: false });
  }
});

// ==================== POLICY INCUBATION HUBS (Whitepaper sec III.E) ====================
// Monthly stipend for active Hub members
db.exec(`
  CREATE TABLE IF NOT EXISTS policy_hubs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    charter TEXT NOT NULL,
    goals TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'dissolved')),
    created_by_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES signups(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS hub_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hub_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'member' CHECK(role IN ('lead', 'member')),
    joined_at TEXT NOT NULL,
    stipend_earned REAL DEFAULT 0,
    FOREIGN KEY (hub_id) REFERENCES policy_hubs(id),
    FOREIGN KEY (user_id) REFERENCES signups(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS hub_stipends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hub_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    period_year INTEGER NOT NULL,
    period_month INTEGER NOT NULL,
    amount_awarded REAL NOT NULL,
    awarded_at TEXT NOT NULL,
    UNIQUE(hub_id, user_id, period_year, period_month),
    FOREIGN KEY (hub_id) REFERENCES policy_hubs(id),
    FOREIGN KEY (user_id) REFERENCES signups(id)
  )
`);

app.post('/api/hubs', userAuth, (req, res) => {
  const { name, charter, goals } = req.body;

  if (!name || !charter) {
    return res.status(400).json({ error: 'name and charter required', success: false });
  }

  try {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO policy_hubs (name, charter, goals, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), charter.trim(), goals || '', req.user.id, now);

    const hubId = db.prepare('SELECT last_insert_rowid() as id').get().id;
    db.prepare('INSERT INTO hub_members (hub_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(hubId, req.user.id, 'lead', now);

    res.status(201).json({ success: true, message: 'Hub created', hub_id: hubId });
  } catch (error) {
    console.error('Create hub error:', error);
    res.status(500).json({ error: 'Could not create hub', success: false });
  }
});

app.get('/api/hubs', (req, res) => {
  try {
    const hubs = db.prepare(`
      SELECT ph.*, s.name as creator_name,
             (SELECT COUNT(*) FROM hub_members WHERE hub_id = ph.id) as member_count
      FROM policy_hubs ph
      JOIN signups s ON ph.created_by_user_id = s.id
      WHERE ph.status = 'active'
      ORDER BY ph.created_at DESC
    `).all();

    res.json({ success: true, hubs });
  } catch (error) {
    console.error('Get hubs error:', error);
    res.status(500).json({ error: 'Could not fetch hubs', success: false });
  }
});

app.post('/api/hubs/:id/join', userAuth, (req, res) => {
  const { id } = req.params;

  try {
    const hub = db.prepare('SELECT * FROM policy_hubs WHERE id = ? AND status = ?').get(id, 'active');
    if (!hub) {
      return res.status(404).json({ error: 'Hub not found', success: false });
    }

    const existing = db.prepare('SELECT id FROM hub_members WHERE hub_id = ? AND user_id = ?').get(id, req.user.id);
    if (existing) {
      return res.status(409).json({ error: 'Already a member', success: false });
    }

    db.prepare('INSERT INTO hub_members (hub_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(id, req.user.id, new Date().toISOString());

    res.json({ success: true, message: 'Joined hub' });
  } catch (error) {
    console.error('Join hub error:', error);
    res.status(500).json({ error: 'Could not join hub', success: false });
  }
});

function processHubStipends() {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const HUB_STIPEND = 50;

    const activeHubs = db.prepare("SELECT * FROM policy_hubs WHERE status = 'active'").all();

    activeHubs.forEach(hub => {
      const members = db.prepare('SELECT user_id FROM hub_members WHERE hub_id = ?').all(hub.id);

      members.forEach(member => {
        const existing = db.prepare(`
          SELECT id FROM hub_stipends
          WHERE hub_id = ? AND user_id = ? AND period_year = ? AND period_month = ?
        `).get(hub.id, member.user_id, year, month);

        if (!existing) {
          const awardedAt = now.toISOString();
          db.prepare(`
            INSERT INTO hub_stipends (hub_id, user_id, period_year, period_month, amount_awarded, awarded_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(hub.id, member.user_id, year, month, HUB_STIPEND, awardedAt);

          db.prepare(`
            UPDATE hub_members SET stipend_earned = stipend_earned + ? WHERE hub_id = ? AND user_id = ?
          `).run(HUB_STIPEND, hub.id, member.user_id);

          db.prepare(`
            INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
            VALUES (?, 'hub_stipend', ?, ?, 'hub', ?, ?)
          `).run(member.user_id, HUB_STIPEND, hub.id, `Policy Hub stipend: ${hub.name}`, awardedAt);
        }
      });
    });

    console.log(`Hub stipend processing complete for ${year}-${month}`);
  } catch (e) {
    console.error('Hub stipend error:', e);
  }
}

setInterval(processHubStipends, 60 * 60 * 1000);
processHubStipends();

setInterval(merit.processMonthlyStipends, 60 * 60 * 1000);
merit.processMonthlyStipends();

app.post('/api/amplify', userAuth, (req, res) => {
  const { content_type, content_title, base_url, reward_points = 10, expires_in_days = 7 } = req.body;
  const userId = req.user.id;

  if (!content_type || !base_url) {
    return res.status(400).json({ error: 'content_type and base_url required', success: false });
  }

  try {
    const trackCode = crypto.randomBytes(8).toString('hex');
    const expiresAt = new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO amplification_links (creator_user_id, content_type, content_title, track_code, base_url, reward_points, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, content_type, content_title || '', trackCode, base_url, reward_points, expiresAt, now);

    const trackingUrl = `${req.protocol}://${req.get('host')}/api/amplify/track/${trackCode}`;

    res.status(201).json({ success: true, track_code: trackCode, tracking_url: trackingUrl });
  } catch (error) {
    console.error('Create amplification error:', error);
    res.status(500).json({ error: 'Could not create tracking link', success: false });
  }
});

app.get('/api/amplify/track/:code', (req, res) => {
  const { code } = req.params;
  const clickerIP = req.ip || req.connection.remoteAddress || 'unknown';

  try {
    const link = db.prepare('SELECT * FROM amplification_links WHERE track_code = ? AND is_active = 1').get(code);
    if (!link) {
      return res.status(404).json({ error: 'Link not found', success: false });
    }

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Link expired', success: false });
    }

    const existingClick = db.prepare('SELECT id FROM amplification_clicks WHERE link_id = ? AND clicker_ip = ?').get(link.id, clickerIP);
    if (!existingClick) {
      db.prepare('INSERT INTO amplification_clicks (link_id, clicker_ip, clicked_at) VALUES (?, ?, ?)')
        .run(link.id, clickerIP, new Date().toISOString());

      db.prepare('UPDATE amplification_links SET click_count = click_count + 1 WHERE id = ?').run(link.id);

      if (link.creator_user_id) {
        db.prepare(`
          INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
          VALUES (?, 'amplification', ?, ?, 'amplify', ?, ?)
        `).run(link.creator_user_id, link.reward_points, link.id, `Amplification click: ${link.content_title || link.content_type}`, new Date().toISOString());
      }
    }

    res.redirect(link.base_url);
  } catch (error) {
    console.error('Track amplification error:', error);
    res.status(500).json({ error: 'Could not track click', success: false });
  }
});

app.get('/api/amplify/stats/:code', userAuth, (req, res) => {
  const { code } = req.params;

  try {
    const link = db.prepare('SELECT * FROM amplification_links WHERE track_code = ?').get(code);
    if (!link) {
      return res.status(404).json({ error: 'Link not found', success: false });
    }
    if (link.creator_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your link', success: false });
    }

    res.json({ success: true, link });
  } catch (error) {
    console.error('Amplify stats error:', error);
    res.status(500).json({ error: 'Could not fetch stats', success: false });
  }
});

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
  
  const activeThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const hasRecentActivity = db.prepare(`
    SELECT COUNT(*) as cnt FROM merit_events WHERE user_id = ? AND created_at > ?
  `).get(user.id, activeThreshold).cnt > 0;

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
      dynamic_score: (() => { try { return merit.calculateDecayedScore(user.id, user.timestamp); } catch(e) { return user.initial_merit_estimate; } })(),
      static_score: (() => { try { return merit.calculateStaticScore(user.id); } catch(e) { return user.initial_merit_estimate; } })(),
      loyalty_coefficient: (() => { try { return merit.getLoyaltyCoefficient(user.timestamp); } catch(e) { return 1.0; } })(),
      is_active: hasRecentActivity,
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

// ==================== LEADERSHIP & SETTINGS API ====================
app.use(require('./src/routes/leadership')({ db, adminAuth, userAuth, getSettings, updateSettings }));

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
// ==================== EVENTS API ====================
app.use(require('./src/routes/events')({ db, adminAuth, logActivity }));

// ==================== ADMIN PROPOSALS & DONATIONS ====================
app.use(require('./src/routes/admin-proposals-donations')({ db, adminAuth, logActivity, getSettings, maybeEngageReferral, addTreasuryEntry }));

// ==================== ADMIN WALL MODERATION ====================
app.use(require('./src/routes/admin-wall')({ db, adminAuth, logActivity }));

// ==================== SERVE HTML FILES ====================
app.use(require('./src/routes/static-pages'));

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