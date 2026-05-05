# Codebase History

This file documents all significant code changes to the project, including rationale (why) and implementation details (how).

---

## 2026-05-06 — Consolidated Laws and Craft a Law Pages

### Merge laws.html and generate-law.html into single page
- **What:** Combined `laws.html` (browse/vote on laws) and `generate-law.html` (AI-assisted law drafting) into a single `laws.html` page. Craft a Law section appears first, followed by the existing laws browsing/voting section. Removed `generate-law.html`. Updated nav.js to remove the separate "Craft a Law" link. Updated static-pages.js to redirect `/generate-law` → `/laws`. Updated links in `index.html` and `join-success.html`.
- **Why:** Both features are closely related — crafting new laws and voting on existing ones. Consolidating into one page reduces navigation friction and keeps all law-related actions in one place.
- **Who:** Developer

---

## 2026-05-06 — Narrative Optimization: Story-First Movement Messaging

### Reframe entire site for narrative-driven growth
- **What:** Comprehensive rewrite of all user-facing information pages (Home, Intro, How, FAQ, Join, Join Success, Whitepaper, Nav) to prioritize movement narrative over conversion mechanics.
- **Why:** The movement spreads by word-of-mouth, not ads. Every page must answer "Why should I care enough to tell my friend?" Donations and signups are secondary to pushing the narrative of what we're doing, why we're doing it, and how we're different.
- **Who:** Marketing/narrative strategist

#### Key changes across pages:
- **Home (`index.html`):** Story-first hero. Removed "45 seconds" urgency. Reframed 3% milestone as "Building a nation of 13,000 leaders" instead of "That's all it takes." Replaced prominent treasury counter with member counter. Added "Leadership Is Earned, Not Inherited" narrative block.
- **Intro (`index.html`):** Added "What Makes Us Different" section with 4 direct comparison cards (no party bosses, no backroom deals, no lifetime politicians, leadership on live TV). Strengthened manifesto tone.
- **How (`how.html`):** Reframed 5 steps as a journey story, not a product manual. Step 1 renamed from "45 Seconds" to "This Is Where It Starts." Step 5 expanded to emphasize applied/verified/earned/endorsed leadership path. Added "Why This System?" narrative section.
- **FAQ (`faq.html`):** Added new narrative-driven questions: "How is this different from traditional parties?" and "What about lifetime politicians?" Reordered to start with identity/purpose. Reframed leadership answers around earned authority.
- **Join (`join.html`):** Reframed as "This is where it starts" instead of "45 seconds." Swapped form priority: Name is now required, NID moved to optional. Removed prominent treasury counter; replaced with subtle transparency link.
- **Join Success (`join-success.html`):** Reframed from "You're In!" task list to "Welcome to Something Real" invitation. Cards reordered to put voting/crafting laws first, enrollment second.
- **Whitepaper (`whitepaper.html`):** Added narrative preamble before technical content. Removed "45 seconds" from cold visitor banner.
- **Nav (`nav.js`):** Renamed "Intro" to "Our Story" in nav and footer. Added narrative tagline in footer.
- **Cold visitor banners:** Removed "Join in 45 seconds" from laws.html, policies.html, whitepaper.html. Replaced with "Join the movement."
- **Treasury de-emphasis:** Removed prominent live treasury counters from home and join pages. Treasury remains transparent and accessible via `/treasury`, but is no longer actively promoted as a fundraising goal.
- **NID de-emphasis:** Changed all copy from "Phone + NID only" to "Name + phone number." NID field is now optional on the join form, framed as "helps us verify you as a Maldivian citizen."

---

## 2026-05-05 — Develop merged into Main

### Merge develop into main
- **What:** Merged the `develop` branch into `main`, resolving conflicts with the develop version.
- **Why:** Consolidate all refactoring work from the develop branch into the stable main branch.
- **How:** Standard git merge with conflict resolution.

---

## 2026-05-05 — Rapid iteration on develop branch

### Multiple incremental updates (May 5, 07:58 – 17:52)
- **What:** 14 consecutive commits throughout the day.
- **Why:** Active development and bugfixing cycle on the develop branch.
- **How:** Timestamp-based commit messages (`Update 2026-05-05 HH:MM:SS`).

---

## 2026-05-04 — Backend Refactoring: server.js Monolith Decomposition

### Extract bounty-academy routes
- **Commit:** `e2c2e08`
- **What:** Extracted bounty, academy, stipends, and advisory routes from `server.js` into separate route modules under `src/routes/`.
- **Why:** Reduce the 7,663-line `server.js` monolith by isolating domain-specific route handlers. First step in the backend refactoring plan (REFACTORING.md Phase 3).
- **How:** Created Express Router modules that receive dependencies via factory function (dependency injection pattern). Mounted in `server.js` with `app.use()`.

### Extract wall routes
- **Commit:** `ed751b4`
- **What:** Extracted public wall, voting, and flagging routes.
- **Why:** Wall routes (~15 endpoints) are heavily used and depend on merit, referral, activity-log, and auth services. Isolating them makes testing and maintenance easier.
- **How:** Followed the copy-delegate-delete pattern: created module, wired server.js to delegate, verified app works, removed dead code.

### Extract proposals and ranked-proposals routes
- **Commit:** `667f5d4`
- **What:** Extracted proposal creation, voting, ranked voting, and stake processing routes.
- **Why:** Proposal logic is core to the app's governance model. Separating it from the monolith allows independent testing of proposal lifecycle (create → vote → close → stake redistribution).
- **How:** Dependencies (merit service, referral service, activity-log, auth middleware) passed as constructor arguments to the route factory.

### Extract auth, referral, enrollment, social route modules
- **Commit:** `b229920`
- **What:** Extracted authentication, referral tracking, enrollment, and social routes.
- **Why:** These are user-facing flows that interact with SMS, rate limiting, and referral engagement bonuses. Grouping them by domain reduces coupling.
- **How:** Each module exports a factory function receiving `{ db, settings, sms, auth, referral, activityLog }` as needed.

### Extract profile, donations-public, hubs-emeritus; remove duplicates
- **Commit:** `620d327`
- **What:** Extracted user profile routes, public donation endpoints, policy hubs, and emeritus status routes. Removed duplicate code.
- **Why:** Profile routes (~8 endpoints) handle uploads, user data, and endorsements. Donations and hubs are public-facing with different auth requirements. Deduplication reduces maintenance burden.
- **How:** Created separate route files, consolidated shared logic into services, removed redundant implementations from `server.js`.

---

## 2026-05-04 — Frontend Refactoring: JS Extraction

### Create shared JS utilities (js/utils.js, js/auth.js, js/api.js)
- **What:** Created three shared JavaScript modules:
  - `js/utils.js` — `escapeHtml`, `formatTime`, `formatDate`, `formatCurrency`
  - `js/auth.js` — Unified authentication token management (`Auth.getToken`, `Auth.setToken`, `Auth.logout`, etc.)
  - `js/api.js` — Fetch wrappers with auto-auth injection (`api.get`, `api.post`, `api.put`, `api.del`)
- **Why:** 11 HTML files contained duplicated inline JavaScript for HTML escaping, time formatting, auth token management, and fetch calls. This made bugfixes and feature changes require edits across many files.
- **How:** 
  - Extracted common functions into namespaced globals (`Utils`, `Auth`, `api`)
  - Auth module uses a single localStorage key `_3p_auth` with backward compatibility for old keys (`authToken`, `token`, `3dparty_admin_token`)
  - API module auto-injects `Authorization: Bearer <token>` headers
  - See FRONTEND_REFACTOR_PLAN.md for full details

### Update HTML pages to use shared modules
- **What:** Updated HTML pages (admin, profile, proposals, wall, join, treasury, laws, legislature, generate-law, index, enroll) to load shared JS files and replace inline duplicated code.
- **Why:** Eliminate code duplication across 11 HTML files (~6,000+ lines of repeated inline JS).
- **How:** Added `<script src>` tags for the three shared modules, replaced inline function definitions with calls to shared utilities, replaced raw `fetch()` calls with `api.*` wrappers.

---

## Project Baseline

### Initial state (pre-refactoring)
- **server.js:** 7,663 lines, 165 routes, 415 raw database calls, 0 service modules
- **Frontend:** 11 HTML files with ~6,000 lines of duplicated inline JavaScript
- **Architecture:** Single-file monolith with no separation of concerns
- **Testing:** No automated tests

### Target state (post-refactoring)
- **server.js:** ~150 lines (wiring only)
- **src/:** Modular architecture with isolated service layers, route modules, background jobs, migrations, and data access layer
- **Frontend:** 3 shared JS modules, minimal inline script per page
- **Testing:** Smoke tests, unit tests, integration tests

See `REFACTORING.md` and `FRONTEND_REFACTOR_PLAN.md` for the complete refactoring plans.
