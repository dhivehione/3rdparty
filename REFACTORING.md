# Refactoring Plan: server.js Monolith Decomposition

**Current state:** 7,663 lines, 165 routes, 415 raw DB calls, 0 service modules.  
**Target state:** Modular architecture with isolated service layers, testable business logic, and no single point of cascade failure.

---

## Guiding Principles

1. **Never break the running app.** Every phase must leave `server.js` fully functional.
2. **Extract bottom-up.** Shared utilities and data access first, routes last.
3. **Copy-delegate-delete.** For each extraction: (a) create module, (b) wire server.js to delegate, (c) verify app works, (d) remove dead code from server.js.
4. **One module per commit.** Push after each verified extraction so regressions are easy to bisect.
5. **No behavior changes.** Pure structural refactoring — no new features, no bug fixes during extraction.

---

## Dependency Map (extraction order)

```
config/settings          ← depended on by everything (35 calls)
db (database handle)     ← depended on by everything (415 calls)
middleware/auth          ← depended on by 79 route handlers
utils (sanitizeHTML etc) ← depended on by 14+ routes
services/merit           ← depended on by proposals, wall, referrals, stipends
services/referral        ← depended on by proposals, wall, signup
services/activity-log    ← depended on by 38 locations
services/treasury        ← depended on by donations, admin
migrations               ← runs once at startup, must be first to own the schema
routes/proposals         ← depends on merit, referral, activity-log, auth
routes/wall              ← depends on merit, referral, activity-log, auth
routes/auth-signup       ← depends on referral, activity-log, auth, sms
routes/treasury          ← depends on treasury, auth
routes/...               ← all other routes
```

---

## Phase 0 — Safety Net (Before Any Code Changes)

**Goal:** Establish a baseline that validates the app still works after every change.

### 0.1 Create a smoke test script

```
tests/smoke.js
```
- Hit every `/api` endpoint with minimal valid payloads
- Assert expected status codes and response shapes
- This becomes the "did I break it?" check after every extraction
- Run with `node tests/smoke.js`

### 0.2 Pin the database

- Copy `data/signups.db` to `data/signups.db.baseline`
- Use this as a known-good state for testing
- Document: `cp data/signups.db.baseline data/signups.db` to reset

### 0.3 Start a git branch

```bash
git checkout -b refactor/modular-server
```

All refactoring commits go here. main stays deployable.

---

## Phase 1 — Extract Shared Modules (No route changes)

These modules export functions that `server.js` will `require()`. Routes stay in server.js but call into the new modules. **Zero behavioral change.**

### 1.1 `src/config/settings.js`

Extract lines 13-92 (DEFAULT_SETTINGS, getSettings, updateSettings).

```js
// src/config/settings.js
let _db = null;

module.exports = {
  init(db) { _db = db; },
  DEFAULT_SETTINGS: { /* ... */ },
  getSettings() { /* current logic, using _db */ },
  updateSettings(newSettings) { /* current logic */ },
};
```

**In server.js:** Replace the 35 inline calls with:
```js
const settings = require('./src/config/settings');
settings.init(db);
// Replace all getSettings() → settings.getSettings()
// Replace all updateSettings() → settings.updateSettings()
```

**Verify:** App starts, all routes respond, settings API still works.

### 1.2 `src/db/index.js`

Extract the database initialization (lines 191-219) into a module that owns the `db` and `lawsDb` handles.

```js
// src/db/index.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function initDb(dataDir) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'signups.db'));

  let lawsDb = null;
  const lawsDbPath = [process.env.LAWS_DB_PATH, '/app/data/laws.db', '/data/laws.db', path.join(dataDir, 'laws.db')]
    .find(p => p && fs.existsSync(p));
  if (lawsDbPath) {
    try { lawsDb = new Database(lawsDbPath); } catch (e) { console.log('⚠ Could not open laws database:', e.message); }
  }

  return { db, lawsDb };
}

module.exports = { initDb };
```

**In server.js:**
```js
const { initDb } = require('./src/db');
const { db, lawsDb } = initDb(path.join(__dirname, 'data'));
```

**Verify:** App starts, DB connections work.

### 1.3 `src/middleware/auth.js`

Extract lines 1454-1456 (ADMIN_PASSWORD, adminSessions), 1457-1467 (adminAuth), and 4778-4796 (userAuth).

```js
// src/middleware/auth.js
module.exports = function({ db, getSettings }) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const adminSessions = new Map();

  function adminAuth(req, res, next) { /* current logic */ }
  function userAuth(req, res, next) { /* current logic */ }

  return { adminAuth, userAuth, adminSessions };
};
```

**In server.js:** Replace inline function definitions with destructured require, keep route handlers using them.

**Verify:** Login, signup, admin routes all work.

### 1.4 `src/utils/index.js`

Extract lines 1213-1215 (sanitizeHTML), 98-100 (getClientIp), 3437-3443 (generateOTP).

```js
// src/utils/index.js
module.exports = {
  sanitizeHTML(str) { /* current logic */ },
  getClientIp(req) { /* current logic */ },
  generateOTP(length) { /* current logic */ },
};
```

**Verify:** All routes that use these still function.

### 1.5 `src/services/activity-log.js`

Extract lines 4270-4287 (logActivity).

```js
module.exports = function({ db }) {
  function logActivity(actionType, userId, targetId, details, req) { /* current logic */ }
  return { logActivity };
};
```

**In server.js:** Replace 38 inline calls with `activityLog.logActivity(...)`.

**Verify:** Activity still logs to DB on all actions.

### 1.6 `src/services/referral.js`

Extract lines 4289-4325 (getReferralPoints, maybeEngageReferral).

```js
module.exports = function({ db, getSettings, logActivity }) {
  function getReferralPoints(inviteCount, isEngagementBonus) { /* ... */ }
  function maybeEngageReferral(userId) { /* ... */ }
  return { getReferralPoints, maybeEngageReferral };
};
```

**In server.js:** Replace 9 calls with `referral.maybeEngageReferral(...)`.

**Verify:** Referral flows in signup/voting still work.

### 1.7 `src/services/merit.js`

Extract lines 5574-5575 (LAMBDA_BASE, HALF_LIFE_DAYS), 5587-5587 (calculateVoteWeight), 5609-5636 (calculateApprovalThreshold, calculateDecayedScore, calculateStaticScore), 5375-5425 (processProposalStakes), 5427-5575 (calculateStakeAmount), 571 (processMonthlyStipends, with ROLE_STIPENDS from line 540).

```js
module.exports = function({ db, getSettings, logActivity }) {
  const ROLE_STIPENDS = { council: 150, committee: 75, advisory: 50 };
  const LAMBDA_BASE = 0.001267;
  const HALF_LIFE_DAYS = 547.5;

  function calculateApprovalThreshold(category) { /* ... */ }
  function calculateVoteWeight(joinDate, createdAt) { /* ... */ }
  function calculateDecayedScore(userId, joinDate) { /* ... */ }
  function calculateStaticScore(userId) { /* ... */ }
  function calculateStakeAmount(userId) { /* ... */ }
  function processProposalStakes(proposalId, yesVotes, noVotes, totalVotes) { /* ... */ }
  function processMonthlyStipends() { /* ... */ }

  return { calculateApprovalThreshold, calculateVoteWeight, calculateDecayedScore, calculateStaticScore, calculateStakeAmount, processProposalStakes, processMonthlyStipends };
};
```

**In server.js:** Replace all merit function calls with `merit.calculateApprovalThreshold(...)` etc.

**Verify:** Proposal voting, merit scores, thresholds all unchanged.

### 1.8 `src/services/treasury.js`

Extract lines 961-1005 (addTreasuryEntry, getTreasuryBalance, and the sync logic).

```js
module.exports = function({ db }) {
  function addTreasuryEntry(data) { /* ... */ }
  function getTreasuryBalance() { /* ... */ }
  return { addTreasuryEntry, getTreasuryBalance };
};
```

**Verify:** Treasury endpoints return same data.

### 1.9 `src/services/wall-moderation.js`

Extract lines 1473-1510 (moderateWallContent).

```js
module.exports = function() {
  function moderateWallContent(text) { /* ... */ }
  return { moderateWallContent };
};
```

**Verify:** Wall posting still filters content.

### 1.10 `src/services/sms.js`

Extract lines 3437-3512 (generateOTP, sendSMS).

```js
module.exports = function({ getSettings }) {
  function generateOTP(length) { /* ... */ }
  async function sendSMS(phone, message, settings) { /* ... */ }
  return { generateOTP, sendSMS };
};
```

**Verify:** OTP flows still work.

### 1.11 `src/services/analytics.js`

Extract lines 94-112 (activeVisitors Map, getClientIp, cleanupExpiredVisitors, heartbeat/active route logic).

```js
module.exports = function({ getSettings }) {
  const activeVisitors = new Map();
  function getClientIp(req) { /* ... */ }
  function cleanupExpiredVisitors() { /* ... */ }
  function recordHeartbeat(sessionId, req) { /* ... */ }
  function getActiveVisitors() { /* ... */ }
  return { activeVisitors, getClientIp, cleanupExpiredVisitors, recordHeartbeat, getActiveVisitors };
};
```

**Verify:** Heartbeat and active visitors count still works.

---

## Phase 2 — Extract Migrations (Critical for Startup)

**Goal:** Move all DDL and seed data into a dedicated, ordered migration system.

### 2.1 `src/migrations/index.js`

Currently, schema creation and migrations are scattered across lines 190-1150 (inline in startup) plus lines 7618-7648 (comprehensive migrations). This is the highest-risk area — if startup order breaks, the app won't boot.

Strategy:
- Number each migration
- Run them in order
- Track which have already run in a `schema_version` table

```js
// src/migrations/001_initial_schema.js
// All CREATE TABLE IF NOT EXISTS statements (lines 222-703)

// src/migrations/002_signups_nullable.js  
// The phone/nid nullable migration (lines 314-372)

// src/migrations/003_wall_columns.js
// Wall posts column additions (lines 631-670)

// src/migrations/004_proposal_columns.js
// Proposal/amendment columns (lines 722-749+)

// src/migrations/005_leadership.js
// Leadership tables (lines 1005-1150)

// src/migrations/006_seed_data.js
// Demo data insertion (lines 1128-1200)

// src/migrations/007_final_columns.js
// Comprehensive ALTER TABLE migrations (lines 7618-7648)
```

```js
// src/migrations/index.js
function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)`);
  const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  
  const migrations = [
    require('./001_initial_schema'),
    require('./002_signups_nullable'),
    // ... ordered list
  ];

  for (let i = 0; i < migrations.length; i++) {
    if (!applied.has(i + 1)) {
      migrations[i].up(db);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString());
      console.log(`✓ Migration ${i + 1} applied`);
    }
  }
}
module.exports = { runMigrations };
```

**In server.js:** Replace all inline DDL with:
```js
const { runMigrations } = require('./src/migrations');
runMigrations(db);
```

**Verify:** App starts clean on a fresh DB. App starts on the existing DB with no data loss. Run both tests.

---

## Phase 3 — Extract Route Modules (The Big One)

**Goal:** Move route handlers into Express Routers. Each route file is self-contained and mounted in server.js.

Pattern for every route module:

```js
// src/routes/proposals.js
const express = require('express');
const router = express.Router();

module.exports = function({ db, settings, merit, referral, activityLog, userAuth, adminAuth, getSettings }) {
  // All proposal routes moved here
  router.get('/api/proposals', (req, res) => { /* ... */ });
  router.post('/api/proposals', (req, res) => { /* ... */ });
  // ...

  return router;
};
```

**In server.js:**
```js
const proposalsRoute = require('./src/routes/proposals')({ db, settings, merit, referral, activityLog, userAuth, adminAuth, getSettings });
app.use(proposalsRoute);
```

### Extraction Order (lowest risk first):

| Step | Module | Lines | Routes | Key Dependencies |
|------|--------|-------|--------|-----------------|
| 3.1 | `src/routes/static-pages.js` | 7530-7616 | 20 GET routes | None |
| 3.2 | `src/routes/analytics.js` | 1437-1448 | 2 routes | analytics service |
| 3.3 | `src/routes/laws.js` | 2235-2757 | 8 routes | db, lawsDb, userAuth |
| 3.4 | `src/routes/leadership-public.js` | 6993-7061 | 4 routes | db |
| 3.5 | `src/routes/events.js` | 7146-7254 | 5 routes | db, adminAuth |
| 3.6 | `src/routes/wall.js` | 1469-1691, 2997-3280, 3107-3125 | ~15 routes | db, settings, auth, merit, wall-moderation |
| 3.7 | `src/routes/proposals.js` | 1692-2002, 2004-2190 | ~10 routes | db, settings, merit, referral, auth |
| 3.8 | `src/routes/ranked-voting.js` | 2004-2190 | 3 routes | db, settings, merit |
| 3.9 | `src/routes/auth-signup.js` | 3435-4400 | ~10 routes | db, settings, sms, auth |
| 3.10 | `src/routes/referrals.js` | 4335-4775 | ~5 routes | db, settings, auth, referral, activityLog |
| 3.11 | `src/routes/treasury.js` | 3127-3187, 3191-3433 | ~6 routes | db, treasury, adminAuth |
| 3.12 | `src/routes/endorsements.js` | 4807-4925 | 4 routes | db, auth, merit, activityLog |
| 3.13 | `src/routes/bounties.js` | 4926-5157 | 7 routes | db, auth, settings, activityLog |
| 3.14 | `src/routes/academy.js` | 5158-5272 | 4 routes | db, auth |
| 3.15 | `src/routes/stipends-advisory.js` | 5273-5357 | 5 routes | db, auth |
| 3.16 | `src/routes/proposal-stakes.js` | 5359-5490 | 2 routes | db, auth, merit |
| 3.17 | `src/routes/merit-api.js` | 5491-5712 | 4 routes | db, auth, merit |
| 3.18 | `src/routes/quizzes-comments.js` | 5713-5872 | 4 routes | db, auth, settings |
| 3.19 | `src/routes/violations.js` | 5873-6035 | 4 routes | db, auth |
| 3.20 | `src/routes/emeritus.js` | 6036-6117 | 2 routes | db |
| 3.21 | `src/routes/policy-hubs.js` | 6118-6268 | 4 routes | db, auth |
| 3.22 | `src/routes/amplify.js` | 6269-6354 | 3 routes | db, auth |
| 3.23 | `src/routes/user-profile.js` | 6355-6694 | ~8 routes | db, auth, upload |
| 3.24 | `src/routes/leadership.js` | 6695-7145 | ~10 routes | db, adminAuth, auth |
| 3.25 | `src/routes/admin.js` | 7279-7527 | ~12 routes | db, adminAuth |
| 3.26 | `src/routes/enroll.js` | 1244-1433 | 2 routes | db, enrollment rate limits |

### 3.1 Static Pages (safest extraction — zero DB, zero auth)

```js
// src/routes/static-pages.js
const express = require('express');
const router = express.Router();
const path = require('path');

module.exports = function() {
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, '../../index.html')));
  router.get('/join', (req, res) => res.sendFile(path.join(__dirname, '../../join.html')));
  // ... all 20 static routes
  return router;
};
```

**After each extraction:** Start the server, hit every affected endpoint, verify 200 status codes. Then commit.

---

## Phase 4 — Extract Background Jobs

### 4.1 `src/jobs/index.js`

Extract the 5 `setInterval` calls and their handler functions into a jobs module:

| Job | Handler | Interval | Current Line |
|-----|---------|----------|--------------|
| Visitor cleanup | `cleanupExpiredVisitors` | 60s | 112 |
| Close expired proposals | `closeExpiredProposals` | 60s | 188 |
| Monthly stipends | `processMonthlyStipends` | 1h | 617 |
| Emeritus eligibility | `checkEmeritusEligibility` | 24h | 6098 |
| Hub stipends | `processHubStipends` | 1h | 6269 |

```js
// src/jobs/index.js
module.exports = function({ db, settings, merit, referral, activityLog }) {
  const intervals = [];

  function start() {
    intervals.push(setInterval(require('./cleanupVisitors')({ settings }), 60000));
    intervals.push(setInterval(require('./closeProposals')({ db, settings, merit, referral, activityLog }), 60000));
    intervals.push(setInterval(require('./processStipends')({ db, settings, merit, activityLog }), 3600000));
    intervals.push(setInterval(require('./checkEmeritus')({ db }), 86400000));
    intervals.push(setInterval(require('./processHubStipends')({ db, settings }), 3600000));

    // Run immediately on startup
    require('./closeProposals')({ db, settings, merit, referral, activityLog })();
    require('./processStipends')({ db, settings, merit, activityLog })();
  }

  function stop() { intervals.forEach(clearInterval); }

  return { start, stop };
};
```

**In server.js:** Replace all 5 `setInterval` calls with `jobs.start()`.

**Add graceful shutdown:**
```js
process.on('SIGTERM', () => { jobs.stop(); process.exit(0); });
process.on('SIGINT', () => { jobs.stop(); process.exit(0); });
```

**Verify:** All background jobs still fire. Check logs for "Stipend processing complete" and "Expired proposals closed" messages.

---

## Phase 5 — Introduce a Data Access Layer (Highest Long-Term Impact)

This is the most valuable but most invasive step. Do this **after** routes are extracted, because then each route module can be updated independently.

### 5.1 Create `src/db/queries/` directory

Organize all 415 raw SQL calls into domain-specific query modules:

```
src/db/queries/
  signups.js      — user CRUD, auth lookup, OTP storage
  proposals.js    — proposal CRUD, vote recording, vote tallying
  wall.js         — post CRUD, vote/flag tracking
  merit.js        — merit_events CRUD, score calculation
  referrals.js    — referral CRUD, engagement tracking
  donations.js    — donation CRUD, verification
  treasury.js     — ledger entries, balance queries
  endorsements.js — endorsement CRUD
  bounties.js     — bounty CRUD, claims
  laws.js         — law/vote queries (uses lawsDb)
  leadership.js   — positions, terms, applications
  activity-log.js — log entries, queries
```

Pattern:

```js
// src/db/queries/proposals.js
module.exports = function(db) {
  return {
    getActive() {
      return db.prepare(`SELECT * FROM proposals WHERE status = 'active' AND is_closed = 0`).all();
    },
    getById(id) {
      return db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id);
    },
    create(proposal) {
      return db.prepare(`INSERT INTO proposals (...) VALUES (...)`).run(...);
    },
    // ... all proposal-related SQL
  };
};
```

**This is a mechanical transformation.** Each `db.prepare(...)` call in route modules gets replaced with a call to the corresponding query module method. Behavior is identical — SQL statements are the same, just consolidated.

**Approach:** Migrate one query module at a time. Update all route modules that reference it. Verify. Commit.

---

## Phase 6 — Final Cleanup

After all extractions, `server.js` should be reduced to:

```js
const express = require('express');
const path = require('path');
const { initDb } = require('./src/db');
const settings = require('./src/config/settings');
const { runMigrations } = require('./src/migrations');
const { adminAuth, userAuth } = require('./src/middleware/auth')({ db, getSettings: settings.getSettings });
const jobs = require('./src/jobs')({ db, settings, merit, referral, activityLog });

// ... require all route modules ...

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Mount routes
app.use(require('./src/routes/static-pages')());
app.use(require('./src/routes/analytics')({ analytics }));
app.use(require('./src/routes/wall')({ db, settings, merit, referral, activityLog, userAuth, adminAuth }));
// ... etc

// Global error handler (NEW — prevents cascade crashes)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', success: false });
});

// Graceful shutdown
const server = app.listen(PORT, () => { /* ... */ });
process.on('SIGTERM', () => { jobs.stop(); server.close(); });
process.on('SIGINT', () => { jobs.stop(); server.close(); });
```

Target: **~150 lines** down from **7,663**.

### 6.1 Add global error handler
- Prevents one route's unhandled exception from crashing the process
- Log full stack trace, return generic 500 to client

### 6.2 Add process-level error handlers
```js
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });
```

### 6.3 Delete all dead code from server.js
- After every module is extracted and verified
- Final file should be ~150 lines of wiring only

---

## Expected File Structure

```
3rdparty/
├── server.js                    ← ~150 lines, wiring only
├── src/
│   ├── config/
│   │   └── settings.js          ← DEFAULT_SETTINGS, getSettings, updateSettings
│   ├── db/
│   │   ├── index.js             ← initDb, db/lawsDb handles
│   │   └── queries/
│   │       ├── signups.js
│   │       ├── proposals.js
│   │       ├── wall.js
│   │       ├── merit.js
│   │       ├── referrals.js
│   │       ├── donations.js
│   │       ├── treasury.js
│   │       ├── endorsements.js
│   │       ├── bounties.js
│   │       ├── laws.js
│   │       ├── leadership.js
│   │       └── activity-log.js
│   ├── middleware/
│   │   ├── auth.js               ← adminAuth, userAuth
│   │   ├── rate-limits.js        ← enrollRateLimits, checkEnrollRateLimit
│   │   └── cors.js               ← CORS headers
│   ├── migrations/
│   │   ├── index.js              ← runMigrations orchestrator
│   │   ├── 001_initial_schema.js
│   │   ├── 002_signups_nullable.js
│   │   ├── 003_wall_columns.js
│   │   ├── 004_proposal_columns.js
│   │   ├── 005_leadership.js
│   │   ├── 006_seed_data.js
│   │   └── 007_final_columns.js
│   ├── services/
│   │   ├── activity-log.js
│   │   ├── analytics.js
│   │   ├── merit.js
│   │   ├── referral.js
│   │   ├── sms.js
│   │   ├── treasury.js
│   │   └── wall-moderation.js
│   ├── jobs/
│   │   ├── index.js              ← start/stop all intervals
│   │   ├── cleanupVisitors.js
│   │   ├── closeProposals.js
│   │   ├── processStipends.js
│   │   ├── checkEmeritus.js
│   │   └── processHubStipends.js
│   ├── routes/
│   │   ├── admin.js
│   │   ├── academy.js
│   │   ├── amplify.js
│   │   ├── analytics.js
│   │   ├── auth-signup.js
│   │   ├── bounties.js
│   │   ├── endorsements.js
│   │   ├── enrollment.js
│   │   ├── events.js
│   │   ├── emeritus.js
│   │   ├── laws.js
│   │   ├── leadership.js
│   │   ├── leadership-public.js
│   │   ├── merit-api.js
│   │   ├── policy-hubs.js
│   │   ├── proposals.js
│   │   ├── proposal-stakes.js
│   │   ├── quizzes-comments.js
│   │   ├── ranked-voting.js
│   │   ├── referrals.js
│   │   ├── static-pages.js
│   │   ├── stipends-advisory.js
│   │   ├── treasury.js
│   │   ├── user-profile.js
│   │   ├── violations.js
│   │   └── wall.js
│   └── utils/
│       └── index.js               ← sanitizeHTML, generateOTP, getClientIp
├── tests/
│   ├── smoke.js                   ← endpoint smoke tests
│   ├── unit/
│   │   ├── merit.test.js
│   │   ├── referral.test.js
│   │   └── settings.test.js
│   └── integration/
│       ├── proposals.test.js
│       └── auth.test.js
└── data/
    └── signups.db
```

---

## Risk Matrix & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| DB handle not passed to module | Medium | App crash on start | Init pattern: every module takes `{ db }` as param; fail fast at require time |
| Migration order breaks | Low | Data corruption | Numbered migrations + schema_version tracking; test on copy of production DB |
| Circular dependency | Medium | Require loops | Dependency injection pattern (factory functions), never circular requires |
| Global state (Maps) lost | Medium | Rate limits reset, visitor count wiped | Keep Maps in modules, pass refs via DI |
| Route path mismatch | Low | 404 on endpoints | Smoke test after every extraction; exact path copy-paste |
| Auth middleware context lost | Medium | All auth fails | Middleware returns factory; receives `db` and `getSettings` |
| Background job references stale `db` | Low | Jobs fail silently | Jobs module receives `db` same way as routes |
| `this` binding issues in extracted methods | Medium | Runtime crash | Use plain function exports, not class methods; no `this` |

---

## Execution Checklist

For **every single extraction step**:

- [ ] Copy code to new module file
- [ ] Export via factory function with dependency injection
- [ ] Wire `require()` in server.js
- [ ] Replace inline calls with module method calls
- [ ] Start server — confirm no crashes
- [ ] Run smoke tests — confirm all endpoints respond
- [ ] Git commit with message: `refactor: extract <module-name> from server.js`
- [ ] Only then proceed to next module

**Never skip the smoke test. Never extract two modules before committing.**

---

## Phase Priority Summary

| Phase | Risk | Effort | Impact | Recommended Order |
|-------|------|-------|--------|-------------------|
| Phase 0: Smoke tests | None | Low | Critical | 1st |
| Phase 1: Shared modules | Low | Medium | High | 2nd |
| Phase 2: Migrations | Medium | Medium | Critical (startup) | 3rd |
| Phase 3: Route extraction | Low | High | High | 4th |
| Phase 4: Background jobs | Low | Low | Medium | 5th |
| Phase 5: Data access layer | Medium | Very High | Very High | 6th |
| Phase 6: Final cleanup | Low | Low | Medium | Last |

**Total estimated effort:** ~40-60 hours of careful, incremental work.

**The single most impactful first step:** Phase 1.1 (extract settings) + Phase 0 (smoke tests). This gives you the testing foundation and the most-depended-on module in under 2 hours.