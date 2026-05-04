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
app.use(analyticsModule.router);

// ==================== PUBLIC WALL API (No Signup Required) ====================

const { moderateWallContent } = require('./src/services/wall-moderation');

// GET /api/wall - Get posts (top-level only, no replies). Supports ?sort=hot|new|top
app.get('/api/wall', (req, res) => {
  const { sort = 'new', page = 1, limit: rawLimit } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limit = Math.min(100, Math.max(5, parseInt(rawLimit) || getSettings().wall_posts_limit));
  const offset = (pageNum - 1) * limit;

  try {
    let orderClause;
    if (sort === 'hot') {
      orderClause = `ORDER BY (upvotes - downvotes + 1.0) / (MAX((julianday('now') - julianday(timestamp)) * 24 + 2, 1)) DESC`;
    } else if (sort === 'top') {
      orderClause = 'ORDER BY (upvotes - downvotes) DESC, timestamp DESC';
    } else {
      orderClause = 'ORDER BY timestamp DESC';
    }

    const posts = db.prepare(`
      SELECT wp.*,
        COALESCE(s.username, wp.nickname) as display_name,
        COALESCE(s.initial_merit_estimate, 0) as user_merit
      FROM wall_posts wp
      LEFT JOIN signups s ON wp.user_id = s.id
      WHERE wp.is_approved = 1 AND wp.parent_id IS NULL AND wp.is_hidden = 0
      ${orderClause}
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    const count = db.prepare(`
      SELECT COUNT(*) as total FROM wall_posts WHERE is_approved = 1 AND parent_id IS NULL AND is_hidden = 0
    `).get();

    // Add vote state for authenticated user
    let userVotes = {};
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) {
          const votes = db.prepare(`SELECT post_id, vote FROM wall_votes WHERE user_id = ? AND post_id IN (${posts.map(() => '?').join(',')})`)
            .all(user.id, ...posts.map(p => p.id));
          votes.forEach(v => { userVotes[v.post_id] = v.vote; });
        }
      } catch (e) {}
    }

    res.json({
      posts: posts.map(p => ({ ...p, user_vote: userVotes[p.id] || 0 })),
      total: count.total,
      page: pageNum,
      totalPages: Math.ceil(count.total / limit),
      showMore: (offset + limit) < count.total,
      success: true
    });
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
      WHERE is_approved = 1 AND thread_id = ? AND is_hidden = 0
      ORDER BY timestamp DESC 
      LIMIT 50
    `).all(threadId);
    res.json({ posts, success: true });
  } catch (error) {
    console.error('Wall thread fetch error:', error);
    res.status(500).json({ error: 'Could not fetch thread posts', success: false });
  }
});

// GET /api/wall/post/:id — Get a single post with its replies (threaded)
app.get('/api/wall/post/:id', (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    const post = db.prepare(`
      SELECT wp.*,
        COALESCE(s.username, wp.nickname) as display_name,
        COALESCE(s.initial_merit_estimate, 0) as user_merit
      FROM wall_posts wp
      LEFT JOIN signups s ON wp.user_id = s.id
      WHERE wp.id = ? AND wp.is_hidden = 0
    `).get(postId);

    if (!post) {
      return res.status(404).json({ error: 'Post not found', success: false });
    }

    const replies = db.prepare(`
      SELECT wp.*,
        COALESCE(s.username, wp.nickname) as display_name,
        COALESCE(s.initial_merit_estimate, 0) as user_merit
      FROM wall_posts wp
      LEFT JOIN signups s ON wp.user_id = s.id
      WHERE wp.parent_id = ? AND wp.is_approved = 1 AND wp.is_hidden = 0
      ORDER BY (wp.upvotes - wp.downvotes) DESC, wp.timestamp ASC
      LIMIT 100
    `).all(postId);

    post.replies = replies;

    // Get vote state if authenticated
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) {
          const voteRow = db.prepare('SELECT vote FROM wall_votes WHERE post_id = ? AND user_id = ?').get(postId, user.id);
          post.user_vote = voteRow ? voteRow.vote : 0;
        }
      } catch (e) {}
    }

    res.json({ post, success: true });
  } catch (error) {
    console.error('Wall post detail error:', error);
    res.status(500).json({ error: 'Could not fetch post', success: false });
  }
});

// GET /api/wall/replies/:parentId — Get replies for a parent post (flat)
app.get('/api/wall/replies/:parentId', (req, res) => {
  const parentId = parseInt(req.params.parentId);
  try {
    const replies = db.prepare(`
      SELECT wp.*,
        COALESCE(s.username, wp.nickname) as display_name,
        COALESCE(s.initial_merit_estimate, 0) as user_merit
      FROM wall_posts wp
      LEFT JOIN signups s ON wp.user_id = s.id
      WHERE wp.parent_id = ? AND wp.is_approved = 1 AND wp.is_hidden = 0
      ORDER BY (wp.upvotes - wp.downvotes) DESC, wp.timestamp ASC
      LIMIT 100
    `).all(parentId);

    res.json({ replies, success: true });
  } catch (error) {
    console.error('Wall replies error:', error);
    res.status(500).json({ error: 'Could not fetch replies', success: false });
  }
});

// ==================== PROPOSALS API (Demo - No Signup Required) ====================
// GET /api/proposals - Get all active proposals
app.get('/api/proposals', (req, res) => {
  try {
    const settings = getSettings();
    const proposals = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id) as vote_count,
        (SELECT COALESCE(SUM(vote_weight), 0) FROM votes WHERE proposal_id = p.id AND choice = 'yes') as weighted_yes,
        (SELECT COALESCE(SUM(vote_weight), 0) FROM votes WHERE proposal_id = p.id AND choice = 'no') as weighted_no
      FROM proposals p
      WHERE p.status = 'active'
      ORDER BY p.created_at DESC
    `).all();

    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    let userVotesMap = {};

    // Try auth token first, fallback to IP
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) {
          const userVotes = db.prepare('SELECT proposal_id, choice FROM votes WHERE user_id = ?').all(user.id);
          userVotes.forEach(v => userVotesMap[v.proposal_id] = v.choice);
        }
      } catch (e) {}
    }

    // Fallback to IP if no auth-based votes found
    if (Object.keys(userVotesMap).length === 0) {
      const userVotes = db.prepare('SELECT proposal_id, choice FROM votes WHERE voter_ip = ?').all(userIP);
      userVotes.forEach(v => userVotesMap[v.proposal_id] = v.choice);
    }

    proposals.forEach(p => {
      p.userVote = userVotesMap[p.id] || null;
      p.approval_threshold = merit.calculateApprovalThreshold(p.category);
      p.passing_threshold_display = `${Math.round(p.approval_threshold * 100)}% ${p.category === 'constitutional' ? 'constitutional' : p.category === 'policy' ? 'policy shift' : 'routine'} majority required`;
      p.is_weighted = true;
      p.window_info = {
        primary_days: settings.voting_window_primary_days || 7,
        extended_days: settings.voting_window_extended_days || 3,
        primary_weight: settings.voting_weight_primary || 1.0,
        extended_weight: settings.voting_weight_extended || 0.5
      };
    });

    res.json({ proposals, success: true });
  } catch (error) {
    console.error('Proposals fetch error:', error);
    res.status(500).json({ error: 'Could not fetch proposals', success: false });
  }
});

// POST /api/proposals - Create a new proposal (8-hour cooldown enforced)
app.post('/api/proposals', (req, res) => {
  const { title, description, category, nickname } = req.body;

  let userId = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
      if (user) userId = user.id;
    } catch (e) {}
  }

  if (userId) {
    const settings = getSettings();
    const cooldownHours = settings.proposal_cooldown_hours || 8;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const lastProposal = db.prepare(`
      SELECT created_at FROM proposals WHERE created_by_user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(userId);
    if (lastProposal) {
      const hoursSince = (Date.now() - new Date(lastProposal.created_at).getTime()) / (1000 * 60 * 60);
      if (hoursSince < cooldownHours) {
        return res.status(429).json({
          error: `Proposal cooldown active. Wait ${(cooldownHours - hoursSince).toFixed(1)} more hours.`,
          success: false,
          next_proposal_at: new Date(lastProposal.created_at.getTime() + cooldownMs).toISOString()
        });
      }
    }
  } else {
    const settings = getSettings();
    const cooldownHours = settings.proposal_cooldown_hours || 8;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const userIP = req.ip || req.connection.remoteAddress || 'unknown';
    const lastAnonProposal = db.prepare(`
      SELECT timestamp FROM activity_log 
      WHERE action_type = 'proposal_created' AND ip_address = ? AND user_id IS NULL
      ORDER BY timestamp DESC LIMIT 1
    `).get(userIP);
    if (lastAnonProposal) {
      const hoursSince = (Date.now() - new Date(lastAnonProposal.timestamp).getTime()) / (1000 * 60 * 60);
      if (hoursSince < cooldownHours) {
        return res.status(429).json({
          error: `Proposal cooldown active. Wait ${(cooldownHours - hoursSince).toFixed(1)} more hours.`,
          success: false,
          next_proposal_at: new Date(new Date(lastAnonProposal.timestamp).getTime() + cooldownMs).toISOString()
        });
      }
    }
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
      INSERT INTO proposals (title, description, category, created_by_nickname, created_at, ends_at, created_by_user_id, approval_threshold)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      sanitizeHTML(title.trim().substring(0, settings.proposal_title_max_length)),
      sanitizeHTML(description.trim()),
      category || 'general',
      sanitizeHTML(nickname ? nickname.trim().substring(0, settings.nickname_max_length) : 'Anonymous'),
      createdAt,
      endsAt,
      userId,
      merit.calculateApprovalThreshold(category || 'general')
    );

    if (userId) {
      logActivity('proposal_created', userId, result.lastInsertRowid, { title: title.trim().substring(0, 100) }, req);
      // Award merit for creating a proposal
      const createdMerit = settings.merit_proposal_created || 10;
      db.prepare(`
        INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
        VALUES (?, 'proposal_created', ?, ?, 'proposal', 'Created a new proposal', ?)
      `).run(userId, createdMerit, result.lastInsertRowid, createdAt);
      db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
        .run(createdMerit, userId);
      maybeEngageReferral(userId);
    } else {
      logActivity('proposal_created', null, result.lastInsertRowid, { title: title.trim().substring(0, 100) }, req);
    }
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

// POST /api/vote - Vote on a proposal (merit-weighted, whitepaper §II.D)
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

    let userId = null;
    let userJoinDate = null;
    let userMeritScore = 0;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const user = db.prepare('SELECT id, timestamp FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) {
          userId = user.id;
          userJoinDate = user.timestamp;
          userMeritScore = merit.calculateStaticScore(userId);
        }
      } catch (e) {}
    }

    const proposal = db.prepare('SELECT id, created_at FROM proposals WHERE id = ?').get(proposal_id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found', success: false });
    }

    const voteWeight = userJoinDate ? merit.calculateVoteWeight(userJoinDate, proposal.created_at) : 1.0;
    const lc = userJoinDate ? merit.getLoyaltyCoefficient(userJoinDate) : 1.0;
    const daysSinceCreated = userJoinDate ? Math.floor((new Date() - new Date(proposal.created_at)) / (1000 * 60 * 60 * 24)) : 0;

    const existingVote = db.prepare('SELECT id, user_id FROM votes WHERE proposal_id = ? AND voter_ip = ?').get(proposal_id, userIP);
    if (existingVote) {
      db.prepare('UPDATE votes SET choice = ?, voted_at = ?, user_id = ?, vote_weight = ?, loyalty_coefficient = ?, days_since_created = ? WHERE id = ?')
        .run(choice, votedAt, userId || existingVote.user_id, voteWeight, lc, daysSinceCreated, existingVote.id);
    } else {
      db.prepare('INSERT INTO votes (proposal_id, choice, voter_ip, voted_at, user_id, vote_weight, loyalty_coefficient, days_since_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(proposal_id, choice, userIP, votedAt, userId, voteWeight, lc, daysSinceCreated);
    }

    const weightedCounts = db.prepare(`
      SELECT choice, SUM(vote_weight) as weighted_cnt, COUNT(*) as raw_cnt
      FROM votes WHERE proposal_id = ? GROUP BY choice
    `).all(proposal_id);

    let weighted_yes = 0, weighted_no = 0, weighted_abstain = 0, raw_total = 0;
    weightedCounts.forEach(c => {
      if (c.choice === 'yes') weighted_yes = c.weighted_cnt || 0;
      if (c.choice === 'no') weighted_no = c.weighted_cnt || 0;
      if (c.choice === 'abstain') weighted_abstain = c.weighted_cnt || 0;
      raw_total += c.raw_cnt || 0;
    });

    db.prepare('UPDATE proposals SET yes_votes = ?, no_votes = ?, abstain_votes = ? WHERE id = ?')
      .run(weighted_yes, weighted_no, weighted_abstain, proposal_id);

    res.json({
      message: 'Vote recorded!',
      success: true,
      vote_weight: voteWeight,
      loyalty_coefficient: lc,
      weighted_tally: { yes: weighted_yes, no: weighted_no, abstain: weighted_abstain },
      raw_voters: raw_total
    });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ error: 'Could not record vote', success: false });
  }
});

// PATCH /api/proposals/:id - Edit a proposal
app.patch('/api/proposals/:id', (req, res) => {
  const { id } = req.params;
  const { title, description } = req.body;
  
  try {
    const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found', success: false });
    }
    
    const updates = [];
    const params = [];
    
    if (title !== undefined) {
      const trimmedTitle = sanitizeHTML(String(title).trim());
      if (trimmedTitle.length < 5) {
        return res.status(400).json({ error: 'Title must be at least 5 characters', success: false });
      }
      updates.push('title = ?');
      params.push(trimmedTitle);
    }
    
    if (description !== undefined) {
      const trimmedDesc = sanitizeHTML(String(description).trim());
      if (trimmedDesc.length < 20) {
        return res.status(400).json({ error: 'Description must be at least 20 characters', success: false });
      }
      updates.push('description = ?');
      params.push(trimmedDesc);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update', success: false });
    }
    
    params.push(id);
    db.prepare(`UPDATE proposals SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    
    res.json({ message: 'Proposal updated!', success: true });
  } catch (error) {
    console.error('Proposal update error:', error);
    res.status(500).json({ error: 'Could not update proposal', success: false });
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
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) userId = user.id;
      } catch (e) {}
    }

    // Parse options and get user votes
    proposals.forEach(p => {
      p.options = JSON.parse(p.options);
      let userVote = null;
      if (userId) {
        userVote = db.prepare('SELECT ranking FROM ranked_votes WHERE proposal_id = ? AND user_id = ?').get(p.id, userId);
      }
      if (!userVote) {
        userVote = db.prepare('SELECT ranking FROM ranked_votes WHERE proposal_id = ? AND voter_ip = ?').get(p.id, userIP);
      }
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
      sanitizeHTML(description.trim()),
      category || 'election',
      JSON.stringify(options.map(o => sanitizeHTML(o.trim())).filter(o => o)),
      sanitizeHTML(nickname ? nickname.trim().substring(0, settings.nickname_max_length) : 'Anonymous'),
      createdAt,
      endsAt,
      userId
    );

    if (userId) {
      logActivity('proposal_created', userId, result.lastInsertRowid, { title: title.trim().substring(0, 100) }, req);
      const createdMerit = settings.merit_proposal_created || 10;
      db.prepare(`
        INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
        VALUES (?, 'proposal_created', ?, ?, 'ranked_proposal', 'Created a ranked choice proposal', ?)
      `).run(userId, createdMerit, result.lastInsertRowid, createdAt);
      db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
        .run(createdMerit, userId);
      maybeEngageReferral(userId);
    }

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

    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) userId = user.id;
      } catch (e) {}
    }

    // Check if already voted (by user_id or IP)
    let existing;
    if (userId) {
      existing = db.prepare('SELECT id FROM ranked_votes WHERE proposal_id = ? AND user_id = ?').get(proposal_id, userId);
    }
    if (!existing) {
      existing = db.prepare('SELECT id FROM ranked_votes WHERE proposal_id = ? AND voter_ip = ?').get(proposal_id, userIP);
    }
    if (existing) {
      db.prepare('UPDATE ranked_votes SET ranking = ?, voted_at = ?, user_id = COALESCE(user_id, ?) WHERE id = ?')
        .run(JSON.stringify(ranking), votedAt, userId, existing.id);
    } else {
      db.prepare('INSERT INTO ranked_votes (proposal_id, ranking, voter_ip, voted_at, user_id) VALUES (?, ?, ?, ?, ?)')
        .run(proposal_id, JSON.stringify(ranking), userIP, votedAt, userId);
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

// POST /api/wall - Add a post or reply (auth optional)
app.post('/api/wall', (req, res) => {
  const { nickname, message, parent_id } = req.body;
  
  // Determine if this is a reply
  const parentId = parent_id ? parseInt(parent_id) : null;
  if (parentId && (isNaN(parentId) || parentId < 1)) {
    return res.status(400).json({ error: 'Invalid parent_id', success: false });
  }
  
  // Check if replying to a valid parent post
  if (parentId) {
    const parentPost = db.prepare('SELECT id FROM wall_posts WHERE id = ? AND is_approved = 1 AND is_hidden = 0').get(parentId);
    if (!parentPost) {
      return res.status(404).json({ error: 'Parent post not found', success: false });
    }
  }
  
  // For top-level posts, require nickname if unauthenticated
  let userId = null;
  let userName = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const user = db.prepare('SELECT id, username, name FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
      if (user) {
        userId = user.id;
        userName = user.name || user.username;
      }
    } catch (e) {}
  }
  
  if (!userId && !parentId) {
    if (!nickname || nickname.trim().length < 2) {
      return res.status(400).json({ error: 'Please enter a nickname (at least 2 characters, or log in)', success: false });
    }
  }

  if (!message || message.trim().length < 1) {
    return res.status(400).json({ error: 'Please write something', success: false });
  }
  
  const maxLen = parentId ? 1000 : getSettings().wall_post_max_length;
  if (message.length > maxLen) {
    return res.status(400).json({ error: `Message too long (max ${maxLen} characters)`, success: false });
  }
  
  // Moderation filter
  const modResult = moderateWallContent(message);
  if (!modResult.passed) {
    return res.status(400).json({
      error: `Content filtered: ${modResult.reason}. Please revise and try again.`,
      success: false,
      moderation_score: modResult.score
    });
  }
  
  try {
    const timestamp = new Date().toISOString();
    const cleanedNickname = (nickname && !userId) ? sanitizeHTML(nickname.trim().substring(0, getSettings().nickname_max_length)) : null;
    const cleanedMessage = sanitizeHTML(message.trim().substring(0, maxLen));
    const displayNickname = userId ? (userName || 'Member') : cleanedNickname;
    
    // Auto-flag borderline content for review
    const needsReview = modResult.score >= 10;
    
    const stmt = db.prepare(`
      INSERT INTO wall_posts (nickname, message, parent_id, user_id, user_name, is_approved, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(displayNickname, cleanedMessage, parentId, userId, userName, needsReview ? 1 : 1, timestamp);
    const newPostId = result.lastInsertRowid;
    
    // Update parent reply count
    if (parentId) {
      db.prepare('UPDATE wall_posts SET reply_count = reply_count + 1 WHERE id = ?').run(parentId);
    }
    
    // Merit for signed-in wall participation
    if (userId) {
      const wallMerit = parentId ? 5 : 15; // 5 pts for reply, 15 for top-level post
      db.prepare(`
        INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
        VALUES (?, 'wall_post', ?, ?, 'wall', ?, ?)
      `).run(userId, wallMerit, newPostId, (parentId ? 'Replied' : 'Posted') + ' to The Wall', timestamp);
      db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
        .run(wallMerit, userId);
      logActivity('wall_post', userId, newPostId, { parent_id: parentId, moderated: needsReview }, req);
      maybeEngageReferral(userId);
    } else {
      logActivity('wall_post', null, newPostId, { nickname: displayNickname, parent_id: parentId, moderated: needsReview }, req);
    }
    
    const responseMessage = parentId
      ? 'Reply posted!'
      : (needsReview ? 'Posted! Your message is live, but flagged for moderation review.' : 'Posted! Thanks for your support.');
    
    res.status(201).json({ 
      message: responseMessage,
      success: true,
      id: newPostId,
      moderated: needsReview
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
    const wallPosts = safeQuery('SELECT COUNT(*) as total FROM wall_posts WHERE is_approved = 1 AND is_hidden = 0');
    const treasury = getTreasuryBalance();

    res.json({ members, wallPosts, treasury, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats', success: false });
  }
});

// ==================== TREASURY API ====================
app.use(require('./src/routes/treasury')({ db, adminAuth, logActivity, addTreasuryEntry, getTreasuryBalance, getSettings }));

// POST /api/wall/:id/upvote — Upvote a wall post
app.post('/api/wall/:id/upvote', wallVoteHandler(1));

// POST /api/wall/:id/downvote — Downvote a wall post
app.post('/api/wall/:id/downvote', wallVoteHandler(-1));

// POST /api/wall/:id/flag — Flag/report a wall post
app.post('/api/wall/:id/flag', (req, res) => {
  const postId = parseInt(req.params.id);
  const { reason } = req.body;

  if (!reason || reason.trim().length < 5) {
    return res.status(400).json({ error: 'Please provide a reason (at least 5 characters)', success: false });
  }

  try {
    const post = db.prepare('SELECT id FROM wall_posts WHERE id = ? AND is_hidden = 0').get(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found', success: false });
    }

    // Track reporter — try auth first, fallback to IP
    let reporterId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
        if (user) reporterId = user.id;
      } catch (e) {}
    }
    const reporterIP = req.ip || req.connection.remoteAddress || 'unknown';

    // Check for duplicate flag from same reporter
    const existingFlag = db.prepare(
      'SELECT id FROM wall_flags WHERE post_id = ? AND (reporter_id = ? OR reporter_ip = ?)'
    ).get(postId, reporterId, reporterIP);
    if (existingFlag) {
      return res.status(409).json({ error: 'You already reported this post', success: false });
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO wall_flags (post_id, reporter_id, reporter_ip, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(postId, reporterId, reporterIP, reason.trim().substring(0, 200), now);

    // Auto-flag the post
    db.prepare('UPDATE wall_posts SET is_flagged = 1, flagged_by_ip = ?, flag_reason = ? WHERE id = ?')
      .run(reporterIP, reason.trim().substring(0, 200), postId);

    res.json({ success: true, message: 'Post reported. A moderator will review it.' });
  } catch (error) {
    console.error('Wall flag error:', error);
    res.status(500).json({ error: 'Could not report post', success: false });
  }
});

// Shared wall vote handler
function wallVoteHandler(voteValue) {
  return (req, res) => {
    const postId = parseInt(req.params.id);

    try {
      const post = db.prepare('SELECT id, upvotes, downvotes, user_id FROM wall_posts WHERE id = ? AND is_hidden = 0').get(postId);
      if (!post) {
        return res.status(404).json({ error: 'Post not found', success: false });
      }

      // Identify voter
      let voterId = null;
      let voterIP = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.split(' ')[1];
          const user = db.prepare('SELECT id FROM signups WHERE auth_token = ? AND is_verified = 1').get(token);
          if (user) voterId = user.id;
        } catch (e) {}
      }
      if (!voterId) {
        voterIP = req.ip || req.connection.remoteAddress || 'unknown';
      }

      // Cannot vote on own post
      if (voterId && post.user_id === voterId) {
        return res.status(400).json({ error: 'Cannot vote on your own post', success: false });
      }

      // Check existing vote
      const existingVote = db.prepare(
        'SELECT id, vote FROM wall_votes WHERE post_id = ? AND (user_id = ? OR ip_address = ?)'
      ).get(postId, voterId, voterIP);

      const now = new Date().toISOString();

      if (existingVote) {
        if (existingVote.vote === voteValue) {
          // Cancel vote (toggle off)
          db.prepare('DELETE FROM wall_votes WHERE id = ?').run(existingVote.id);
          if (voteValue === 1) {
            db.prepare('UPDATE wall_posts SET upvotes = MAX(upvotes - 1, 0) WHERE id = ?').run(postId);
          } else {
            db.prepare('UPDATE wall_posts SET downvotes = MAX(downvotes - 1, 0) WHERE id = ?').run(postId);
          }
          const updatedPost = db.prepare('SELECT upvotes, downvotes FROM wall_posts WHERE id = ?').get(postId);
          return res.json({ success: true, upvotes: updatedPost.upvotes, downvotes: updatedPost.downvotes, user_vote: 0, action: 'removed' });
        } else {
          // Change vote
          db.prepare('UPDATE wall_votes SET vote = ?, created_at = ? WHERE id = ?').run(voteValue, now, existingVote.id);
          if (voteValue === 1) {
            db.prepare('UPDATE wall_posts SET upvotes = upvotes + 1, downvotes = MAX(downvotes - 1, 0) WHERE id = ?').run(postId);
          } else {
            db.prepare('UPDATE wall_posts SET downvotes = downvotes + 1, upvotes = MAX(upvotes - 1, 0) WHERE id = ?').run(postId);
          }
          const updatedPost = db.prepare('SELECT upvotes, downvotes FROM wall_posts WHERE id = ?').get(postId);
          return res.json({ success: true, upvotes: updatedPost.upvotes, downvotes: updatedPost.downvotes, user_vote: voteValue, action: 'changed' });
        }
      }

      // New vote
      db.prepare('INSERT INTO wall_votes (post_id, user_id, ip_address, vote, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(postId, voterId, voterIP, voteValue, now);

      if (voteValue === 1) {
        db.prepare('UPDATE wall_posts SET upvotes = upvotes + 1 WHERE id = ?').run(postId);
        // Award merit to post author when post gets upvoted (if author is a verified user)
        if (post.user_id) {
          const newUpvotes = db.prepare('SELECT upvotes FROM wall_posts WHERE id = ?').get(postId).upvotes;
          if (newUpvotes > 0 && newUpvotes % 5 === 0) {
            const voteMerit = Math.min(newUpvotes, 25);
            db.prepare(`
              INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
              VALUES (?, 'wall_upvoted', ?, ?, 'wall', ?, ?)
            `).run(post.user_id, voteMerit, postId, `Post reached ${newUpvotes} upvotes`, now);
            db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
              .run(voteMerit, post.user_id);
          }
        }
        // Award small merit to voter for engagement
        if (voterId) {
          db.prepare(`
            INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
            VALUES (?, 'wall_vote', 1, ?, 'wall', 'Upvoted a wall post', ?)
          `).run(voterId, postId, now);
          db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + 1 WHERE id = ?').run(voterId);
          maybeEngageReferral(voterId);
        }
      } else {
        db.prepare('UPDATE wall_posts SET downvotes = downvotes + 1 WHERE id = ?').run(postId);
      }

      const updatedPost = db.prepare('SELECT upvotes, downvotes FROM wall_posts WHERE id = ?').get(postId);
      res.json({ success: true, upvotes: updatedPost.upvotes, downvotes: updatedPost.downvotes, user_vote: voteValue, action: 'added' });
    } catch (error) {
      console.error('Wall vote error:', error);
      res.status(500).json({ error: 'Could not process vote', success: false });
    }
  };
}

// ==================== API ENDPOINTS ====================
// ==================== SMS OTP FUNCTIONS ====================

async function sendSMS(phone, message, settings) {
  const provider = (settings.sms_provider || '').toLowerCase();
  
  if (!provider) {
    // No SMS provider configured — OTP will be returned in API response for dev/testing
    console.log(`[SMS] No provider configured. OTP for ${phone}: ${message}`);
    return { sent: false, error: 'No SMS provider configured', dev_message: message };
  }

  // Clean phone number for Maldives (+960)
  let cleaned = phone.replace(/[^0-9+]/g, '');
  if (!cleaned.startsWith('+')) {
    if (cleaned.startsWith('960') && cleaned.length === 10) {
      cleaned = '+' + cleaned;
    } else if (cleaned.length === 7) {
      cleaned = '+960' + cleaned;
    } else if (cleaned.length === 10 && cleaned.startsWith('0')) {
      cleaned = '+960' + cleaned.substring(1);
    }
  }

  if (provider === 'twilio') {
    const accountSid = process.env.TWILIO_ACCOUNT_SID || settings.sms_twilio_account_sid;
    const authToken = process.env.TWILIO_AUTH_TOKEN || settings.sms_twilio_auth_token;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER || settings.sms_twilio_phone_number;

    if (!accountSid || !authToken || !fromNumber) {
      console.log(`[SMS] Twilio not configured. OTP for ${phone}: ${message}`);
      return { sent: false, error: 'Twilio credentials missing', dev_message: message };
    }

    try {
      const https = await import('https');
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const body = new URLSearchParams({
        To: cleaned,
        From: fromNumber,
        Body: message
      }).toString();

      return new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.twilio.com',
          path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error_code) {
                console.error('[SMS] Twilio error:', parsed.message);
                resolve({ sent: false, error: parsed.message });
              } else {
                console.log(`[SMS] Sent to ${phone}: ${parsed.sid}`);
                resolve({ sent: true, sid: parsed.sid });
              }
            } catch (e) {
              resolve({ sent: false, error: 'Twilio parse error' });
  }
});

// POST /api/verify-otp — Verify OTP code to activate account
app.post('/api/verify-otp', (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone and OTP code required', success: false });
  }

  const cleanedPhone = phone.replace(/\D/g, '');

  try {
    const user = db.prepare(
      'SELECT id, otp_code, otp_expires_at, otp_verified FROM signups WHERE phone = ? AND is_verified = 0'
    ).get(cleanedPhone);

    if (!user) {
      return res.status(404).json({ error: 'No pending verification found for this phone', success: false });
    }

    if (user.otp_verified) {
      return res.status(400).json({ error: 'Account already verified', success: false });
    }

    if (new Date(user.otp_expires_at) < new Date()) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new code.', success: false });
    }

    if (user.otp_code !== otp.trim()) {
      return res.status(400).json({ error: 'Incorrect verification code. Please try again.', success: false });
    }

    // Verify the account
    const authToken = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE signups SET is_verified = 1, otp_verified = 1, auth_token = ?, otp_code = NULL, otp_expires_at = NULL, last_login = ? WHERE id = ?'
    ).run(authToken, now, user.id);

    // Auto-post welcome
    const verifiedUser = db.prepare('SELECT name, username FROM signups WHERE id = ?').get(user.id);
    const displayName = sanitizeHTML(verifiedUser.name || verifiedUser.username || 'A new member');
    const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups').get().total;
    const targetMembers = getSettings().target_members || 13000;
    const percentComplete = ((memberCount / targetMembers) * 100).toFixed(2);
    try {
      db.prepare('INSERT INTO wall_posts (nickname, message, timestamp, thread_id) VALUES (?, ?, ?, ?)')
        .run('admin', `🌴 ${displayName} verified and joined! We're ${memberCount.toLocaleString()} strong — ${percentComplete}% of our 13,000 member goal!`, now, 'new_members_welcome');
    } catch (e) {}

    // Handle referral completion
    const pendingReferral = db.prepare(`
      SELECT * FROM referrals WHERE status = 'pending_waiting' AND details LIKE ?
    `).get(`%${phone}%`);
    if (pendingReferral) {
      try {
        const details = JSON.parse(pendingReferral.details || '{}');
        if (details.phone === phone) {
          const inviteCount = db.prepare(`SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND status IN ('joined', 'active')`).get(pendingReferral.referrer_id).count;
          const basePoints = getReferralPoints(inviteCount + 1, false);
          db.prepare(`UPDATE referrals SET referred_id = ?, status = 'joined', base_reward_given = ?, referred_joined_at = ? WHERE id = ?`)
            .run(user.id, basePoints, now, pendingReferral.id);
          db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
            .run(basePoints, pendingReferral.referrer_id);
        }
      } catch (e) {}
    }

    logActivity('user_verified', user.id, null, {}, req);

    // Record signup donation in Live Treasury ledger if user donated at signup
    const verifiedSignup = db.prepare('SELECT donation_amount, name, username FROM signups WHERE id = ?').get(user.id);
    if (verifiedSignup && verifiedSignup.donation_amount > 0) {
      const donorNick = verifiedSignup.username || verifiedSignup.name || ('Member #' + user.id);
      addTreasuryEntry({
        type: 'donation',
        amount: verifiedSignup.donation_amount,
        description: 'Signup donation',
        category: 'donation',
        sourceRefType: 'signup',
        sourceRefId: user.id,
        donorNickname: donorNick,
        verifiedBy: 'system',
        status: 'verified'
      });
    }

    res.json({
      success: true,
      message: 'Phone verified! Welcome to the 3d Party.',
      token: authToken,
      user_id: user.id
    });
  } catch (error) {
    console.error('OTP verify error:', error);
    res.status(500).json({ error: 'Verification failed', success: false });
  }
});

// POST /api/resend-otp — Resend OTP code
app.post('/api/resend-otp', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number required', success: false });
  }

  const cleanedPhone = phone.replace(/\D/g, '');

  try {
    const user = db.prepare(
      'SELECT id, otp_verified FROM signups WHERE phone = ? AND is_verified = 0'
    ).get(cleanedPhone);

    if (!user) {
      return res.status(404).json({ error: 'No pending verification found for this phone', success: false });
    }

    if (user.otp_verified) {
      return res.status(400).json({ error: 'Account already verified', success: false });
    }

    const settings = getSettings();
    const newOTP = generateOTP(settings.sms_otp_length);
    const newExpiry = new Date(Date.now() + (settings.sms_otp_expiry_minutes * 60 * 1000)).toISOString();

    db.prepare('UPDATE signups SET otp_code = ?, otp_expires_at = ? WHERE id = ?')
      .run(newOTP, newExpiry, user.id);

    // Try to send SMS
    const smsResult = await sendSMS(phone, `Your 3d Party verification code: ${newOTP}. Valid for ${settings.sms_otp_expiry_minutes} minutes.`, settings);

    const response = {
      success: true,
      message: 'New verification code sent',
      otp_sent: smsResult ? smsResult.sent : false
    };

    if (!settings.sms_provider) {
      response.dev_otp = newOTP;
    }

    res.json(response);
  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({ error: 'Could not resend code', success: false });
  }
});
        });
        req.on('error', (e) => {
          console.error('[SMS] Request error:', e.message);
          resolve({ sent: false, error: e.message });
        });
        req.write(body);
        req.end();
      });
    } catch (e) {
      console.error('[SMS] Twilio setup error:', e.message);
      return { sent: false, error: e.message };
    }
  }

  if (provider === 'webhook') {
    const webhookUrl = settings.sms_webhook_url;
    if (!webhookUrl) {
      return { sent: false, error: 'Webhook URL not configured' };
    }
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleaned, message })
      });
      if (response.ok) {
        console.log(`[SMS] Webhook sent to ${phone}`);
        return { sent: true };
      }
      return { sent: false, error: `Webhook returned ${response.status}` };
    } catch (e) {
      console.error('[SMS] Webhook error:', e.message);
      return { sent: false, error: e.message };
    }
  }

  console.log(`[SMS] Unknown provider '${provider}'. OTP for ${phone}: ${message}`);
  return { sent: false, error: `Unknown provider: ${provider}`, dev_message: message };
}

// POST /api/signup - New signup
app.post('/api/signup', async (req, res) => {
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
  initialMerit += Math.floor(Math.random() * settings.signup_random_bonus_max);
  
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
    let donationMerit;
    if (settings.donation_formula === 'flat') {
      donationMerit = Math.floor(finalDonation / settings.donation_divisor_mvr) * settings.donation_bonus_per_100;
    } else {
      const amountUsd = finalDonation / settings.donation_usd_mvr_rate;
      donationMerit = Math.round(settings.donation_log_multiplier * Math.log(amountUsd + 1) / Math.log(5));
    }
    initialMerit += donationMerit;
  }
  
   try {
     const timestamp = new Date().toISOString();
     const contributionTypeJson = JSON.stringify(typesArray);

     // Generate OTP
     const otpCode = generateOTP(settings.sms_otp_length);
     const otpExpiry = new Date(Date.now() + (settings.sms_otp_expiry_minutes * 60 * 1000)).toISOString();
     const requireOTP = settings.sms_otp_required;
     const initialVerifyState = requireOTP ? 0 : 1;
     const initialAuthToken = requireOTP ? null : crypto.randomBytes(32).toString('hex');

     const stmt = db.prepare(
       'INSERT INTO signups (phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, otp_code, otp_expires_at, otp_verified, auth_token, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
       initialVerifyState,
       otpCode,
       otpExpiry,
       requireOTP ? 0 : 1,
       initialAuthToken,
       timestamp
     );
    
    // Send SMS OTP
    let smsResult = null;
    if (requireOTP) {
      smsResult = await sendSMS(phone, `Your 3d Party verification code: ${otpCode}. Valid for ${settings.sms_otp_expiry_minutes} minutes.`, settings);
    }

    // Auto-login after signup (only if OTP not required)
    let authToken = initialAuthToken;
    if (!requireOTP) {
      const userLoginToken = db.prepare('SELECT auth_token FROM signups WHERE id = ?').get(result.lastInsertRowid);
      authToken = userLoginToken ? userLoginToken.auth_token : authToken;
    } else if (requireOTP && !settings.sms_provider) {
      // Dev mode: auto-verify immediately if no SMS provider configured
      authToken = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE signups SET is_verified = 1, otp_verified = 1, auth_token = ? WHERE id = ?')
        .run(authToken, result.lastInsertRowid);
    }
    
    // Only process referrals, activity log, and welcome post if user is verified
    if (authToken) {
      // Record signup donation in Live Treasury ledger
      if (finalDonation > 0) {
        const displayNick = username ? username.trim() : (name || ('Member #' + result.lastInsertRowid));
        addTreasuryEntry({
          type: 'donation',
          amount: finalDonation,
          description: 'Signup donation',
          category: 'donation',
          sourceRefType: 'signup',
          sourceRefId: result.lastInsertRowid,
          donorNickname: displayNick,
          verifiedBy: 'system',
          status: 'verified'
        });
      }

      // Check for pending referrals
      const pendingReferral = db.prepare(`
        SELECT * FROM referrals 
        WHERE status = 'pending_waiting' AND details LIKE ?
      `).get(`%${phone}%`);
      
      if (pendingReferral) {
        const details = JSON.parse(pendingReferral.details || '{}');
        if (details.phone === phone) {
          const inviteCount = db.prepare(`
            SELECT COUNT(*) as count FROM referrals 
            WHERE referrer_id = ? AND status IN ('joined', 'active')
          `).get(pendingReferral.referrer_id).count;
          
          const basePoints = getReferralPoints(inviteCount + 1, false);
          
          db.prepare(`
            UPDATE referrals SET referred_id = ?, status = 'joined', 
            base_reward_given = ?, referred_joined_at = ?
            WHERE id = ?
          `).run(result.lastInsertRowid, basePoints, timestamp, pendingReferral.id);
          
          db.prepare('UPDATE signups SET initial_merit_estimate = initial_merit_estimate + ? WHERE id = ?')
            .run(basePoints, pendingReferral.referrer_id);
          
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
      
      // Get current member count
      const memberCount = db.prepare('SELECT COUNT(*) as total FROM signups').get().total;
      const targetMembers = getSettings().target_members || 13000;
      const percentComplete = ((memberCount / targetMembers) * 100).toFixed(2);
      
      // Auto-post to welcome thread
      const displayName = sanitizeHTML(name || username || 'A new member');
      const welcomeMsg = `🌴 ${displayName} just joined! We're ${memberCount.toLocaleString()} strong — ${percentComplete}% of our 13,000 member goal!`;
      try {
        db.prepare('INSERT INTO wall_posts (nickname, message, timestamp, thread_id) VALUES (?, ?, ?, ?)')
          .run('admin', welcomeMsg, timestamp, 'new_members_welcome');
      } catch (e) {
        console.log('Could not post welcome to wall:', e.message);
      }
    }
    
    // Get the user data to return
    const user = db.prepare('SELECT * FROM signups WHERE id = ?').get(result.lastInsertRowid);
    
    const responseBody = { 
      message: `Welcome to the 3d Party! Your initial Merit Score estimate is ${initialMerit} points.`,
      success: true,
      token: authToken,
      otp_required: requireOTP && !authToken,
      otp_sent: smsResult ? smsResult.sent : false,
      otp_expires_in_minutes: requireOTP ? settings.sms_otp_expiry_minutes : 0,
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
        timestamp: user.timestamp,
        is_verified: !!authToken
      }
    };

    // In dev mode (no SMS provider), include OTP in response for testing
    if (requireOTP && !settings.sms_provider && !authToken) {
      responseBody.dev_otp = otpCode;
    }

    res.status(201).json(responseBody);
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
    const treasury = getTreasuryBalance();
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
      total_treasury: treasury,
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
  initialMerit += Math.floor(Math.random() * enrollSettings.signup_random_bonus_max);

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
    let donationMerit;
    if (enrollSettings.donation_formula === 'flat') {
      donationMerit = Math.floor(finalDonation / enrollSettings.donation_divisor_mvr) * enrollSettings.donation_bonus_per_100;
    } else {
      const amountUsd = finalDonation / enrollSettings.donation_usd_mvr_rate;
      donationMerit = Math.round(enrollSettings.donation_log_multiplier * Math.log(amountUsd + 1) / Math.log(5));
    }
    initialMerit += donationMerit;
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

app.post('/api/endorsements', userAuth, (req, res) => {
  const { endorsed_id } = req.body;
  const endorserId = req.user.id;

  if (!endorsed_id) {
    return res.status(400).json({ error: 'endorsed_id required', success: false });
  }

  if (parseInt(endorsed_id) === endorserId) {
    return res.status(400).json({ error: 'Cannot endorse yourself', success: false });
  }

  try {
    const target = db.prepare('SELECT id FROM signups WHERE id = ? AND is_verified = 1').get(endorsed_id);
    if (!target) {
      return res.status(404).json({ error: 'User not found', success: false });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentEndorsements = db.prepare(`
      SELECT COUNT(*) as cnt FROM peer_endorsements
      WHERE endorser_id = ? AND created_at > ?
    `).get(endorserId, thirtyDaysAgo);

    if (recentEndorsements.cnt >= 20) {
      return res.status(429).json({ error: 'Max 20 endorsements per 30-day period', success: false });
    }

    const existing = db.prepare('SELECT id FROM peer_endorsements WHERE endorser_id = ? AND endorsed_id = ?').get(endorserId, endorsed_id);
    if (existing) {
      return res.status(409).json({ error: 'Already endorsed this user', success: false });
    }

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO peer_endorsements (endorser_id, endorsed_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(endorserId, endorsed_id, now, expiresAt);

    const endorsements = db.prepare('SELECT * FROM peer_endorsements WHERE endorsed_id = ?').all(endorsed_id);
    const points = merit.calculateEndorsementPoints(endorsements.length);

    db.prepare(`
      INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
      VALUES (?, 'peer_endorsement', ?, ?, 'endorsement', ?, ?)
    `).run(endorsed_id, points, endorsements.length, 'peer_endorsement', `Peer endorsement #${endorsements.length}`, now);

    res.json({ success: true, message: 'Endorsement recorded' });
  } catch (error) {
    console.error('Endorsement error:', error);
    res.status(500).json({ error: 'Could not record endorsement', success: false });
  }
});

app.delete('/api/endorsements/:id', userAuth, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const endorsement = db.prepare('SELECT * FROM peer_endorsements WHERE id = ? AND endorser_id = ?').get(id, userId);
    if (!endorsement) {
      return res.status(404).json({ error: 'Endorsement not found', success: false });
    }

    db.prepare('DELETE FROM peer_endorsements WHERE id = ?').run(id);

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM peer_endorsements WHERE endorsed_id = ?').get(endorsement.endorsed_id);
    const points = merit.calculateEndorsementPoints(remaining.cnt);

    db.prepare(`
      INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
      VALUES (?, 'peer_endorsement_removed', ?, ?, 'endorsement', ?, ?)
    `).run(endorsement.endorsed_id, points, endorsement.endorsed_id, 'peer_endorsement', `Peer endorsements updated: ${remaining.cnt} remaining`, new Date().toISOString());

    res.json({ success: true, message: 'Endorsement removed' });
  } catch (error) {
    console.error('Endorsement removal error:', error);
    res.status(500).json({ error: 'Could not remove endorsement', success: false });
  }
});

app.get('/api/endorsements/received', userAuth, (req, res) => {
  const userId = req.user.id;

  try {
    const endorsements = db.prepare(`
      SELECT pe.*, s.name as endorser_name, s.username as endorser_username
      FROM peer_endorsements pe
      JOIN signups s ON pe.endorser_id = s.id
      WHERE pe.endorsed_id = ?
      ORDER BY pe.created_at DESC
    `).all(userId);

    const totalPoints = merit.calculateEndorsementPoints(endorsements.length);

    res.json({ success: true, endorsements, total_endorsements: endorsements.length, total_points: totalPoints });
  } catch (error) {
    console.error('Get endorsements error:', error);
    res.status(500).json({ error: 'Could not fetch endorsements', success: false });
  }
});

app.get('/api/endorsements/given', userAuth, (req, res) => {
  const userId = req.user.id;

  try {
    const endorsements = db.prepare(`
      SELECT pe.*, s.name as endorsed_name, s.username as endorsed_username
      FROM peer_endorsements pe
      JOIN signups s ON pe.endorsed_id = s.id
      WHERE pe.endorser_id = ?
      ORDER BY pe.created_at DESC
    `).all(userId);

    res.json({ success: true, endorsements, total_given: endorsements.length });
  } catch (error) {
    console.error('Get endorsements error:', error);
    res.status(500).json({ error: 'Could not fetch endorsements', success: false });
  }
});

// ==================== BOUNTY & ACADEMY ====================
app.use(require('./src/routes/bounty-academy')({ db, userAuth, logActivity, ROLE_STIPENDS: merit.ROLE_STIPENDS, merit }));

// ==================== PROPOSAL STAKES & REPUTATION (Whitepaper sec II.C.10) ====================
// Stake: max(10, MS * 0.005), Refund if >=20% support, Forfeit if <10% support
db.exec(`
  CREATE TABLE IF NOT EXISTS proposal_stakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    stake_amount REAL NOT NULL,
    status TEXT DEFAULT 'locked' CHECK(status IN ('locked', 'refunded', 'forfeited')),
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id),
    FOREIGN KEY (user_id) REFERENCES signups(id)
  )
`);

app.post('/api/proposals/:id/stake', userAuth, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found', success: false });
    }
    if (proposal.is_closed) {
      return res.status(400).json({ error: 'Proposal already closed', success: false });
    }
    if (proposal.created_by_user_id !== userId) {
      return res.status(403).json({ error: 'Only the author can stake a proposal', success: false });
    }

    const existing = db.prepare('SELECT id FROM proposal_stakes WHERE proposal_id = ? AND user_id = ?').get(id, userId);
    if (existing) {
      return res.status(409).json({ error: 'Already staked this proposal', success: false });
    }

    const stakeAmount = merit.calculateStakeAmount(userId);
    const now = new Date().toISOString();

    db.prepare('INSERT INTO proposal_stakes (proposal_id, user_id, stake_amount, created_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, stakeAmount, now);

    db.prepare(`
      INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
      VALUES (?, 'stake_locked', ?, ?, 'proposal', ?, ?)
    `).run(userId, -stakeAmount, id, `Proposal stake locked: ${stakeAmount} pts`, now);

    res.json({ success: true, message: `Staked ${stakeAmount} points on this proposal` });
  } catch (error) {
    console.error('Stake proposal error:', error);
    res.status(500).json({ error: 'Could not stake proposal', success: false });
  }
});

app.get('/api/proposals/:id/stake', (req, res) => {
  const { id } = req.params;

  try {
    const stakes = db.prepare(`
      SELECT ps.*, s.name, s.username
      FROM proposal_stakes ps
      JOIN signups s ON ps.user_id = s.id
      WHERE ps.proposal_id = ?
    `).all(id);

    const totalStaked = stakes.reduce((sum, s) => sum + s.stake_amount, 0);

    res.json({ success: true, stakes, total_staked: totalStaked });
  } catch (error) {
    console.error('Get stakes error:', error);
    res.status(500).json({ error: 'Could not fetch stakes', success: false });
  }
});
// ==================== MEDIA COLLECTIVE & CONTENT REWARDS (Whitepaper sec V.E) ====================
// Knowledge Check Bounty: Points for passing quizzes on articles
db.exec(`
  CREATE TABLE IF NOT EXISTS article_quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id TEXT NOT NULL,
    article_title TEXT,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    correct_answer INTEGER NOT NULL,
    points_reward INTEGER DEFAULT 10,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    quiz_id INTEGER NOT NULL,
    selected_answer INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    attempted_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES signups(id),
    FOREIGN KEY (quiz_id) REFERENCES article_quizzes(id)
  )
`);

// Informed Comment Reward: Community-endorsed comments
db.exec(`
  CREATE TABLE IF NOT EXISTS article_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    article_id TEXT NOT NULL,
    comment_text TEXT NOT NULL,
    is_approved INTEGER DEFAULT 1,
    endorsement_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES signups(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS comment_endorsements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    endorser_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(comment_id, endorser_id),
    FOREIGN KEY (comment_id) REFERENCES article_comments(id),
    FOREIGN KEY (endorser_id) REFERENCES signups(id)
  )
`);

// Amplification Bounty: Trackable links for sharing official content
db.exec(`
  CREATE TABLE IF NOT EXISTS amplification_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_user_id INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    content_title TEXT,
    track_code TEXT NOT NULL UNIQUE,
    base_url TEXT NOT NULL,
    click_count INTEGER DEFAULT 0,
    reward_points INTEGER DEFAULT 10,
    is_active INTEGER DEFAULT 1,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (creator_user_id) REFERENCES signups(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS amplification_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    clicker_ip TEXT,
    clicked_at TEXT NOT NULL,
    FOREIGN KEY (link_id) REFERENCES amplification_links(id)
  )
`);

app.get('/api/merit/score', userAuth, (req, res) => {
  const userId = req.user.id;
  const user = db.prepare('SELECT timestamp FROM signups WHERE id = ?').get(userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found', success: false });
  }

  const staticScore = merit.calculateStaticScore(userId);
  const dynamicScore = merit.calculateDecayedScore(userId, user.timestamp);
  const loyaltyCoeff = merit.getLoyaltyCoefficient(user.timestamp);
  const lcLabel = loyaltyCoeff >= 1.5 ? 'founding' : loyaltyCoeff >= 1.2 ? 'early_adopter' : 'standard';

  res.json({
    success: true,
    user_id: userId,
    static_score: staticScore,
    dynamic_score: dynamicScore,
    loyalty_coefficient: lc,
    loyalty_tier: lcLabel,
    effective_half_life_days: Math.round(merit.HALF_LIFE_DAYS * lc)
  });
});

app.get('/api/merit/events', userAuth, (req, res) => {
  const userId = req.user.id;
  const { limit = 50, offset = 0 } = req.query;

  try {
    const events = db.prepare(`
      SELECT * FROM merit_events WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(userId, parseInt(limit), parseInt(offset));

    const total = db.prepare('SELECT COUNT(*) as cnt FROM merit_events WHERE user_id = ?').get(userId);

    res.json({ success: true, events, total: total.cnt });
  } catch (error) {
    console.error('Get merit events error:', error);
    res.status(500).json({ error: 'Could not fetch merit events', success: false });
  }
});

app.get('/api/merit/leaderboard', (req, res) => {
  const { limit = 20 } = req.query;

  try {
    const users = db.prepare(`
      SELECT s.id, s.name, s.username,
             COALESCE(SUM(me.points), 0) as static_score
      FROM signups s
      LEFT JOIN merit_events me ON s.id = me.user_id
      WHERE s.is_verified = 1 AND s.unregistered_at IS NULL
      GROUP BY s.id
      ORDER BY static_score DESC
      LIMIT ?
    `).all(parseInt(limit));

    const leaderboard = users.map((u, i) => ({
      rank: i + 1,
      ...u,
      dynamic_score: merit.calculateDecayedScore(u.id, db.prepare('SELECT timestamp FROM signups WHERE id = ?').get(u.id).timestamp)
    }));

    res.json({ success: true, leaderboard });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ error: 'Could not fetch leaderboard', success: false });
  }
});

// ==================== KNOWLEDGE CHECK BOUNTY (Whitepaper sec V.E) ====================
app.post('/api/quizzes', userAuth, (req, res) => {
  const { article_id, article_title, question, options, correct_answer, points_reward = 10 } = req.body;

  if (!article_id || !question || !options || correct_answer === undefined) {
    return res.status(400).json({ error: 'article_id, question, options, and correct_answer required', success: false });
  }

  try {
    const opts = Array.isArray(options) ? options : JSON.parse(options);
    if (opts.length < 2) {
      return res.status(400).json({ error: 'At least 2 options required', success: false });
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO article_quizzes (article_id, article_title, question, options, correct_answer, points_reward, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(article_id, article_title || '', question, JSON.stringify(opts), correct_answer, points_reward, now);

    res.status(201).json({ success: true, message: 'Quiz created' });
  } catch (error) {
    console.error('Create quiz error:', error);
    res.status(500).json({ error: 'Could not create quiz', success: false });
  }
});

app.get('/api/quizzes/:articleId', (req, res) => {
  const { articleId } = req.params;

  try {
    const quizzes = db.prepare('SELECT * FROM article_quizzes WHERE article_id = ? AND is_active = 1').all(articleId);
    quizzes.forEach(q => q.options = JSON.parse(q.options));
    res.json({ success: true, quizzes });
  } catch (error) {
    console.error('Get quizzes error:', error);
    res.status(500).json({ error: 'Could not fetch quizzes', success: false });
  }
});

app.post('/api/quizzes/:id/answer', userAuth, (req, res) => {
  const { id } = req.params;
  const { answer } = req.body;
  const userId = req.user.id;

  if (answer === undefined) {
    return res.status(400).json({ error: 'answer required', success: false });
  }

  try {
    const quiz = db.prepare('SELECT * FROM article_quizzes WHERE id = ? AND is_active = 1').get(id);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found', success: false });
    }

    const alreadyAttempted = db.prepare('SELECT id FROM quiz_attempts WHERE user_id = ? AND quiz_id = ?').get(userId, id);
    if (alreadyAttempted) {
      return res.status(409).json({ error: 'Already attempted this quiz', success: false });
    }

    const correct = answer === quiz.correct_answer;
    const now = new Date().toISOString();

    db.prepare('INSERT INTO quiz_attempts (user_id, quiz_id, selected_answer, correct, attempted_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, id, answer, correct ? 1 : 0, now);

    if (correct) {
      db.prepare(`
        INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
        VALUES (?, 'knowledge_check', ?, ?, 'quiz', ?, ?)
      `).run(userId, quiz.points_reward, id, `Knowledge check passed: ${quiz.article_title || quiz.article_id}`, now);
    }

    res.json({ success: true, correct, points_earned: correct ? quiz.points_reward : 0 });
  } catch (error) {
    console.error('Answer quiz error:', error);
    res.status(500).json({ error: 'Could not submit answer', success: false });
  }
});

// ==================== INFORMED COMMENT REWARD (Whitepaper sec V.E) ====================
app.post('/api/comments', userAuth, (req, res) => {
  const { article_id, comment_text } = req.body;
  const userId = req.user.id;

  if (!article_id || !comment_text || comment_text.trim().length < 10) {
    return res.status(400).json({ error: 'article_id and comment_text (min 10 chars) required', success: false });
  }

  try {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO article_comments (user_id, article_id, comment_text, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, article_id, comment_text.trim(), now);

    res.status(201).json({ success: true, message: 'Comment posted' });
  } catch (error) {
    console.error('Post comment error:', error);
    res.status(500).json({ error: 'Could not post comment', success: false });
  }
});

app.get('/api/comments/:articleId', (req, res) => {
  const { articleId } = req.params;

  try {
    const comments = db.prepare(`
      SELECT ac.*, s.name, s.username,
             (SELECT COUNT(*) FROM comment_endorsements WHERE comment_id = ac.id) as endorsements
      FROM article_comments ac
      JOIN signups s ON ac.user_id = s.id
      WHERE ac.article_id = ? AND ac.is_approved = 1
      ORDER BY endorsements DESC, ac.created_at DESC
    `).all(articleId);

    res.json({ success: true, comments });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Could not fetch comments', success: false });
  }
});

app.post('/api/comments/:id/endorse', userAuth, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const comment = db.prepare('SELECT * FROM article_comments WHERE id = ?').get(id);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found', success: false });
    }
    if (comment.user_id === userId) {
      return res.status(400).json({ error: 'Cannot endorse your own comment', success: false });
    }

    const existing = db.prepare('SELECT id FROM comment_endorsements WHERE comment_id = ? AND endorser_id = ?').get(id, userId);
    if (existing) {
      return res.status(409).json({ error: 'Already endorsed', success: false });
    }

    const now = new Date().toISOString();
    db.prepare('INSERT INTO comment_endorsements (comment_id, endorser_id, created_at) VALUES (?, ?, ?)').run(id, userId, now);

    const endorsementCount = db.prepare('SELECT COUNT(*) as cnt FROM comment_endorsements WHERE comment_id = ?').get(id).cnt;
    db.prepare('UPDATE article_comments SET endorsement_count = ? WHERE id = ?').run(endorsementCount, id);

    if (endorsementCount >= 5) {
      const commentPoints = Math.min(endorsementCount * 2, 50);
      db.prepare(`
        INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
        VALUES (?, 'comment_endorsement', ?, ?, 'comment', ?, ?)
      `).run(comment.user_id, commentPoints, id, `Comment endorsed (${endorsementCount} endorsements)`, now);
    }

    res.json({ success: true, endorsements: endorsementCount });
  } catch (error) {
    console.error('Endorse comment error:', error);
    res.status(500).json({ error: 'Could not endorse comment', success: false });
  }
});

// ==================== VIOLATION PENALTIES (Whitepaper sec IX) ====================
// Tier 1: Minor (spam, low-effort), Tier 2: Serious (disinfo, harassment), Tier 3: Severe (hate speech, threats)
db.exec(`
  CREATE TABLE IF NOT EXISTS violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_user_id INTEGER,
    accused_user_id INTEGER NOT NULL,
    violation_type TEXT NOT NULL,
    tier INTEGER NOT NULL CHECK(tier IN (1, 2, 3)),
    description TEXT NOT NULL,
    evidence TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'investigating', 'resolved', 'dismissed')),
    resolution TEXT,
    resolved_by_user_id INTEGER,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (reporter_user_id) REFERENCES signups(id),
    FOREIGN KEY (accused_user_id) REFERENCES signups(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_suspensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    violation_id INTEGER,
    suspension_type TEXT NOT NULL CHECK(suspension_type IN ('warning', 'temporary', 'permanent')),
    reason TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES signups(id),
    FOREIGN KEY (violation_id) REFERENCES violations(id)
  )
`);

const VIOLATION_PENALTIES = {
  1: { point_penalty: 50, action: 'warning' },
  2: { point_penalty: 200, action: 'temporary' },
  3: { point_penalty: 500, action: 'permanent' }
};

app.post('/api/violations/report', userAuth, (req, res) => {
  const { accused_user_id, violation_type, tier, description, evidence } = req.body;
  const reporterId = req.user.id;

  if (!accused_user_id || !violation_type || !tier || !description) {
    return res.status(400).json({ error: 'accused_user_id, violation_type, tier, and description required', success: false });
  }

  if (![1, 2, 3].includes(parseInt(tier))) {
    return res.status(400).json({ error: 'Tier must be 1, 2, or 3', success: false });
  }

  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO violations (reporter_user_id, accused_user_id, violation_type, tier, description, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reporterId, accused_user_id, violation_type, tier, description, evidence || '', now);

    logActivity('violation_reported', reporterId, accused_user_id, { type: violation_type, tier }, req);
    res.status(201).json({ success: true, message: 'Violation report submitted' });
  } catch (error) {
    console.error('Report violation error:', error);
    res.status(500).json({ error: 'Could not submit report', success: false });
  }
});

app.get('/api/violations', userAuth, (req, res) => {
  const { status, tier } = req.query;

  try {
    const isAdmin = req.user.is_admin;
    if (!isAdmin) {
      const myViolations = db.prepare('SELECT * FROM violations WHERE accused_user_id = ? ORDER BY created_at DESC').all(req.user.id);
      return res.json({ success: true, violations: myViolations });
    }

    let query = 'SELECT v.*, s.name as accused_name, rs.name as reporter_name FROM violations v JOIN signups s ON v.accused_user_id = s.id LEFT JOIN signups rs ON v.reporter_user_id = rs.id WHERE 1=1';
    const params = [];

    if (status) { query += ' AND v.status = ?'; params.push(status); }
    if (tier) { query += ' AND v.tier = ?'; params.push(parseInt(tier)); }

    query += ' ORDER BY v.created_at DESC';

    const violations = db.prepare(query).all(...params);
    res.json({ success: true, violations });
  } catch (error) {
    console.error('Get violations error:', error);
    res.status(500).json({ error: 'Could not fetch violations', success: false });
  }
});

app.post('/api/violations/:id/resolve', userAuth, (req, res) => {
  const { id } = req.params;
  const { status, resolution, penalty_tier } = req.body;
  const resolverId = req.user.id;

  if (!['resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be "resolved" or "dismissed"', success: false });
  }

  try {
    const violation = db.prepare('SELECT * FROM violations WHERE id = ?').get(id);
    if (!violation) {
      return res.status(404).json({ error: 'Violation not found', success: false });
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE violations SET status = ?, resolution = ?, resolved_by_user_id = ?, resolved_at = ? WHERE id = ?')
      .run(status, resolution || '', resolverId, now, id);

    if (status === 'resolved' && penalty_tier) {
      const penalty = VIOLATION_PENALTIES[penalty_tier];
      if (penalty) {
        db.prepare(`
          INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at)
          VALUES (?, 'violation_penalty', ?, ?, 'violation', ?, ?)
        `).run(violation.accused_user_id, -penalty.point_penalty, id, `Violation penalty (Tier ${penalty_tier}): ${violation.violation_type}`, now);

        if (penalty.action === 'temporary') {
          db.prepare(`
            INSERT INTO user_suspensions (user_id, violation_id, suspension_type, reason, starts_at, ends_at, created_at)
            VALUES (?, ?, 'temporary', ?, ?, datetime(?, '+7 days'), ?)
          `).run(violation.accused_user_id, id, violation.violation_type, now, now, now);
        } else if (penalty.action === 'permanent') {
          db.prepare(`
            INSERT INTO user_suspensions (user_id, violation_id, suspension_type, reason, starts_at, is_active, created_at)
            VALUES (?, ?, 'permanent', ?, ?, 1, ?)
          `).run(violation.accused_user_id, id, violation.violation_type, now, now);
        }
      }
    }

    logActivity('violation_resolved', resolverId, id, { status, penalty_tier }, req);
    res.json({ success: true, message: `Violation ${status}` });
  } catch (error) {
    console.error('Resolve violation error:', error);
    res.status(500).json({ error: 'Could not resolve violation', success: false });
  }
});

app.get('/api/suspensions/active', (req, res) => {
  try {
    const now = new Date().toISOString();
    const suspensions = db.prepare(`
      SELECT us.*, s.name as user_name
      FROM user_suspensions us
      JOIN signups s ON us.user_id = s.id
      WHERE us.is_active = 1 AND us.starts_at <= ? AND (us.ends_at IS NULL OR us.ends_at > ?)
      ORDER BY us.created_at DESC
    `).all(now, now);

    res.json({ success: true, suspensions });
  } catch (error) {
    console.error('Get suspensions error:', error);
    res.status(500).json({ error: 'Could not fetch suspensions', success: false });
  }
});

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