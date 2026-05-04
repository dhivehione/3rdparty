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

// ==================== HUBS & EMERITUS ====================
app.use(require('./src/routes/hubs-emeritus')({ db, userAuth }));

// Hub stipend background job
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
        const existing = db.prepare(`SELECT id FROM hub_stipends WHERE hub_id = ? AND user_id = ? AND period_year = ? AND period_month = ?`).get(hub.id, member.user_id, year, month);
        if (!existing) {
          const awardedAt = now.toISOString();
          db.prepare(`INSERT INTO hub_stipends (hub_id, user_id, period_year, period_month, amount_awarded, awarded_at) VALUES (?, ?, ?, ?, ?, ?)`).run(hub.id, member.user_id, year, month, HUB_STIPEND, awardedAt);
          db.prepare(`UPDATE hub_members SET stipend_earned = stipend_earned + ? WHERE hub_id = ? AND user_id = ?`).run(HUB_STIPEND, hub.id, member.user_id);
          db.prepare(`INSERT INTO merit_events (user_id, event_type, points, reference_id, reference_type, description, created_at) VALUES (?, 'hub_stipend', ?, ?, 'hub', ?, ?)`).run(member.user_id, HUB_STIPEND, hub.id, `Policy Hub stipend: ${hub.name}`, awardedAt);
        }
      });
    });
    console.log(`Hub stipend processing complete for ${year}-${month}`);
  } catch (e) { console.error('Hub stipend error:', e); }
}
setInterval(processHubStipends, 60 * 60 * 1000);
processHubStipends();

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