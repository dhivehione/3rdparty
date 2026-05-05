const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== SYSTEM SETTINGS ====================
const { DEFAULT_SETTINGS, init: initSettings, getSettings, updateSettings } = require('./src/config/settings');

// ==================== DATABASE SETUP ====================
const { initDb } = require('./src/db');
const dataDir = path.join(__dirname, 'data');
const { db, lawsDb } = initDb(dataDir);
initSettings(db);

// ==================== AUTH MIDDLEWARE ====================
const { ADMIN_PASSWORD, adminSessions, adminAuth, userAuth } = require('./src/middleware/auth')({ db });

// ==================== DATABASE MIGRATIONS ====================
const { addTreasuryEntry, getTreasuryBalance } = require('./src/services/treasury')({ db });
const { runMigrations } = require('./src/migrations');
runMigrations({ db, DEFAULT_SETTINGS, getSettings, addTreasuryEntry });

// ==================== UTILITIES ====================
const { sanitizeHTML, generateOTP } = require('./src/utils');
const { logActivity } = require('./src/services/activity-log')({ db });
const { getReferralPoints, maybeEngageReferral } = require('./src/services/referral')({ db, getSettings, logActivity });
const merit = require('./src/services/merit')({ db, getSettings, logActivity });

// ==================== DATA ACCESS LAYER ====================
const queries = require('./src/db/queries')({ db, lawsDb });

// ==================== ANALYTICS ====================
const analyticsModule = require('./src/routes/analytics')({ getSettings });
const { activeVisitors, getClientIp } = analyticsModule;

// ==================== BACKGROUND JOBS ====================
const jobs = require('./src/jobs')({ queries, db, getSettings, merit, maybeEngageReferral, activeVisitors });
jobs.start();

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(__dirname));

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.use(require('./src/middleware/cors'));

// ==================== ROUTE MOUNTS ====================
app.use(require('./src/routes/enrollment')({ db, queries, getSettings, getClientIp, userAuth }));
app.use(analyticsModule.router);

const { moderateWallContent } = require('./src/services/wall-moderation');
app.use(require('./src/routes/wall')({ db, queries, getSettings, logActivity, merit, maybeEngageReferral, moderateWallContent, sanitizeHTML, getTreasuryBalance }));

app.use(require('./src/routes/proposals')({ db, queries, getSettings, logActivity, merit, maybeEngageReferral, sanitizeHTML, userAuth }));
app.use(require('./src/routes/ranked-proposals')({ db, queries, getSettings, logActivity, merit, maybeEngageReferral, sanitizeHTML }));
app.use(require('./src/routes/legislation/browse')({ db, lawsDb, getSettings }));
app.use(require('./src/routes/legislation/voting')({ db, lawsDb, getSettings, maybeEngageReferral }));
app.use(require('./src/routes/legislation/ai-draft')({ db, lawsDb, getSettings }));
app.use(require('./src/routes/treasury')({ db, queries, adminAuth, logActivity, addTreasuryEntry, getTreasuryBalance, getSettings }));
app.use(require('./src/routes/auth/register')({ db, getSettings, logActivity, sanitizeHTML, generateOTP, getReferralPoints, addTreasuryEntry, getTreasuryBalance }));
app.use(require('./src/routes/auth/login')({ db, logActivity, adminSessions, ADMIN_PASSWORD }));
app.use(require('./src/routes/auth/admin')({ db, adminAuth, getTreasuryBalance }));
app.use(require('./src/routes/auth/stats')({ db }));
app.use(require('./src/routes/referrals')({ db, queries, getSettings, logActivity, userAuth, getReferralPoints, sanitizeHTML, addTreasuryEntry }));
app.use(require('./src/routes/bounty-academy')({ db, queries, getSettings, userAuth, logActivity, merit }));
app.use(require('./src/routes/social/merit')({ db, userAuth, merit }));
app.use(require('./src/routes/social/interactions')({ db, logActivity, adminAuth, userAuth, getSettings }));
app.use(require('./src/routes/social/violations')({ db, logActivity, userAuth, getSettings }));
app.use(require('./src/routes/social/amplification')({ db, userAuth, getSettings }));
app.use(require('./src/routes/hubs-emeritus')({ db, queries, userAuth }));
app.use(require('./src/routes/events')({ db, queries, adminAuth, logActivity }));
app.use(require('./src/routes/admin-proposals-donations')({ db, queries, adminAuth, logActivity, getSettings, maybeEngageReferral, addTreasuryEntry }));
app.use(require('./src/routes/admin-wall')({ db, queries, adminAuth, logActivity }));
app.use(require('./src/routes/leadership')({ db, adminAuth, userAuth, getSettings, updateSettings }));
app.use(require('./src/routes/profile')({ db, lawsDb, getSettings, logActivity, userAuth, merit }));
app.use(require('./src/routes/donations-public')({ db, dataDir, getSettings, logActivity }));
app.use(require('./src/routes/static-pages'));

// ==================== GLOBAL ERROR HANDLER ====================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', success: false });
});

// ==================== PROCESS-LEVEL ERROR HANDLERS ====================
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ==================== START SERVER ====================
let version = 'unknown';
try {
  const versionData = fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf8');
  versionData.split('\n').forEach(line => {
    if (line.startsWith('VERSION=')) version = line.replace('VERSION=', '');
  });
} catch (e) {}

const server = app.listen(PORT, () => {
  console.log(`\n  Version: ${version}`);
  console.log(`  3d Party running at http://localhost:${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/admin`);
  console.log(`  "No, we are not doing 3rd party insurance."\n`);
});

// ==================== GRACEFUL SHUTDOWN ====================
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  jobs.stop();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  jobs.stop();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
