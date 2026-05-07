# Codebase History

This file documents all significant code changes to the project, including rationale (why) and implementation details (how).

For the current system architecture and technical specifications, see [`blueprint.md`](blueprint.md).  
For the original governance philosophy and phased rollout plan, see [`whitepaper.txt`](whitepaper.txt).

---

## 2026-05-07 — AI Draft on Proposals Page

### Add craft-a-proposal functionality to proposals page
- **What:** Added the same AI-powered "Craft a Law" functionality from `laws.html` to `proposals.html`, rebranded as "Got an Idea? Craft a Proposal." Includes the full generate → review → refine → submit flow using the existing `/api/generate-law-draft` and `/api/proposals` endpoints. After submission, the proposals list auto-refreshes. Also added a cross-link from proposals to the Laws page for discoverability.
- **Why:** Users browsing the proposals page would not discover the AI drafting tool unless they navigated to the Laws page first. Since proposals are the natural place to submit community ideas, the drafting flow should be accessible from there too. The wording was adjusted ("Got an Idea? Craft a Proposal" / "What's your idea?") to match the proposals page tone.
- **Who:** Developer

---

## 2026-05-07 — Profile Page Tabs

### Add tab navigation to profile page
- **What:** Reorganized the profile page from a single vertical scroll of all sections into a tabbed layout. Added 6 tabs (Activity, Voting, Proposals, Enroll, Leadership, Endorsements) with a tab bar between My Scores and the tab content. My Details and My Scores remain always visible above the tabs. Each tab wraps its related sections in a content div with `hidden` class; only the active tab is visible. Added `switchProfileTab()` function using the same pattern as `legislature.html` (`.forEach()` over tab names, `text-party-accent border-b-2` active styling, `text-gray-400` inactive).
- **Why:** The profile page was growing unbounded as users accumulated more log entries, merit events, votes, proposals, and endorsements. Scrolling through all sections at once was becoming unwieldy. Tabs collapse the scroll-heavy sections into digestible views while keeping identity/score cards (My Details, My Scores) always visible at the top.
- **Who:** Developer

---

## 2026-05-07 — Merit Audit Ledger Hardening

### Standardize all merit changes through awardMerit() and backfill missing events
- **What:** Refactored 9 code locations that bypassed `awardMerit()` by doing manual INSERT into `merit_events` + UPDATE of `initial_merit_estimate`. Added `signup_base` merit event logging for new signups (previously missing entirely). Fixed the non-OTP referral path which silently skipped the merit audit log. Created migration 007 to backfill missing `signup_base` and `referral_base` events for existing users.
- **Why:** Multiple code paths manipulated the merit score outside the centralized `awardMerit()` function, causing permanent audit gaps: (a) new signups had no initial-score log entry, (b) the non-OTP registration path awarded referral bonuses without recording them in `merit_events`, (c) hub stipends and knowledge checks wrote events without updating the running total. This made `SUM(merit_events.points)` diverge from `signups.initial_merit_estimate`, undermining trust in the entire merit system.
- **Who:** Developer

#### Changes made:
- **`src/routes/wall.js`:** Replaced 3 manual INSERT+UPDATE sites (wall_upvoted, wall_vote, wall_post) with `merit.awardMerit()` calls.
- **`src/routes/proposals.js`:** Replaced manual proposal_created event with `merit.awardMerit()`.
- **`src/routes/ranked-proposals.js`:** Same fix for ranked proposal creation.
- **`src/services/referral.js`:** `maybeEngageReferral` now accepts `merit` dependency and uses `awardMerit()` for engagement bonuses.
- **`src/routes/social/interactions.js`:** Quiz knowledge_check and comment_endorsement now use `merit.awardMerit()` (previously never updated `initial_merit_estimate`).
- **`src/jobs/processHubStipends.js`:** Hub stipend events now use `merit.awardMerit()` — previously used raw `insertEvent` without updating the running total.
- **`src/routes/auth/register.js`:** Non-OTP referral bonus now uses `merit.awardMerit()`. Initial signup merit now logged as `signup_base` event in the audit ledger.
- **`src/routes/referrals.js`:** Initial signup merit now logged as `signup_base` event.
- **`server.js`:** Swapped instantiation order so `merit` service is created before `services/referral`; passes `merit` to both `services/referral` and `social/interactions`.
- **`src/jobs/index.js`:** Passes `merit` to `processHubStipends`.
- **Migration 007 (`src/migrations/007_merit_backfill.js`):** Backfills missing `signup_base` events where `initial_merit_estimate` exceeds `SUM(merit_events.points)`, and missing `referral_base` events from `referrals` table with no corresponding audit entry.

### Add daily enrollment limits and split referral merit into upfront + login-based rewards
- **What:** Added per-user daily enrollment limits, split referral base points into upfront and login-based portions, and added configurable settings for all new parameters. Created migration 006 to add `first_login_at` and `upfront_merit_awarded` columns to the `referrals` table. Added 4 new admin settings: `enroll_max_per_user_per_day`, `referral_upfront_fraction`, `referral_login_delay_days`, `referral_delayed_reduction_fraction`.
- **Why:** The family/friend enroll feature could be used to inflate merit scores by enrolling fake accounts. Adding a daily limit prevents bulk enrollment. Splitting points (default: half upfront, half on login) ensures referrers only get full credit when the enrolled person actually authenticates. The delay window (default: 7 days) with reduced points for late logins adds urgency and prevents gaming.
- **Who:** Developer

#### Changes made:
- **Database (Migration 006):** Added `first_login_at TEXT` and `upfront_merit_awarded REAL DEFAULT 0` to `referrals` table.
- **Settings (`src/config/settings.js`):** Added `enroll_max_per_user_per_day` (5), `referral_upfront_fraction` (0.5), `referral_login_delay_days` (7), `referral_delayed_reduction_fraction` (0.5).
- **Admin (`admin.html`):** Added new settings to SETTINGS_META and Referral Points section.
- **Service (`src/services/referral.js`):** Added `awardReferralLoginMerit(userId)` — checks if user was referred and hasn't logged in yet, calculates remaining points based on days since enrollment, awards reduced points if past delay window. Added `getEnrollmentsToday(userId)` — counts enrollments by a user today.
- **Route (`src/routes/referrals.js`):** `POST /api/enroll-family-friend` now checks per-user daily limit before creating user. Awards only upfront fraction of base points immediately. Response includes `points_earned` (upfront), `total_base_points`, and `remaining_points`.
- **Route (`src/routes/auth/login.js`):** `POST /api/user/login` now calls `awardReferralLoginMerit()` after successful login. Response includes `referral_login_bonus` if points were awarded.
- **Server (`server.js`):** Wired `awardReferralLoginMerit` and `getEnrollmentsToday` into route dependencies.

---

## 2026-05-07 — Blueprint Reorganization

### Reorganize blueprint.md as dedicated technical specification
- **What:** Restructured `blueprint.md` from a mixed audit-history/spec document into a clean, authoritative technical specification. Removed all historical implementation audits, dated roadmaps, stale `server.js` line-number references, and bug trackers. Added a System Architecture section documenting the modular `src/` layout, updated the Database Schema to reflect current migrations, updated the API Reference to use module paths, and refreshed the Frontend Pages list.
- **Why:** As the codebase grew, `blueprint.md` had accumulated dated audit logs, roadmap items, and hundreds of stale line-number references to the old 7,663-line `server.js` monolith. This made it unreliable as a technical reference. Splitting history into `history.md` and keeping `blueprint.md` strictly architectural ensures both documents remain accurate and useful.
- **Who:** Developer

### Update whitepaper to reference blueprint.md
- **What:** Added a note to `whitepaper.txt` and `whitepaper.html` directing readers to `blueprint.md` for the living technical specification. Removed the deprecated "bridge-building incentives" phrase from the Executive Summary.
- **Why:** The whitepaper is the governance philosophy document; the blueprint is the technical spec. Cross-linking prevents them from diverging silently and helps new contributors find the right source of truth.
- **Who:** Developer

---

## 2026-05-06 — Remove dedicated members page

### Remove members page
- **What:** Deleted `members.html`; removed "Members" from top nav, footer, and page detection in `nav.js`; removed `/members` cross-links from `profile.html`.
- **Why:** The members page was a dedicated directory for discovering and endorsing members. Users can now endorse those they've enrolled (via profile page) and search for members via the enroll page's directory search. A standalone members page is unnecessary at this stage.
- **Who:** Developer

---

## 2026-05-06 — Fix CSP Blocking Google Analytics + Replace Tailwind CDN with Build Step

### Fix CSP connect-src to allow Google Analytics
- **What:** Added `https://www.google-analytics.com` and `https://www.google.com` to `connect-src` in the CSP header (`src/middleware/cors.js`) and HTML meta tags (`members.html`, `profile.html`). Also removed stale `https://cdn.tailwindcss.com` from `script-src` since Tailwind is now built locally.
- **Why:** The CSP `connect-src 'self'` directive was blocking Google Analytics from sending pageview data to `www.google-analytics.com/g/collect` and `www.google.com/g/collect`. GA's gtag.js script loaded fine via `script-src`, but the POST to collect data was blocked.
- **Who:** Developer

### Replace Tailwind CSS CDN with local PostCSS build
- **What:** Installed `tailwindcss@3` as a devDependency. Created `tailwind.config.js` with the custom `party` color palette, `styles/tailwind.css` as input, and `tailwind.css` as the minified output. Added `build:css` npm script. Replaced `<script src="https://cdn.tailwindcss.com">` + inline `tailwind.config` blocks with `<link rel="stylesheet" href="/tailwind.css">` in all 21 HTML files.
- **Why:** The Tailwind Play CDN (`cdn.tailwindcss.com`) warns against production use. It forces the browser to download the compiler and scan the DOM at runtime, which is slow and wasteful. Pre-building the CSS at build time is the recommended production approach.
- **Who:** Developer

---

## 2026-05-06 — Tie Endorsements to Leadership Applications

### Endorsements only work for active applications; one person, one position
- **What:** Changed peer endorsements from a free social feature to application-scoped endorsements. Added `application_id` column to `peer_endorsements` table. POST `/api/endorsements` now requires `application_id` and validates that the target has an active (`pending` or `interview`) application. Updated `/api/members` to include application status and position title. Updated `/api/endorsements/received` and `/api/endorsements/given` to include position context. Updated `POST /api/leadership/apply` to enforce one active application per user. Updated `members.html` to only show endorse buttons for active applicants (with position badge). Updated `profile.html` to show position title in endorsement lists.
- **Why:** Without this, a member could enroll many friends, have them all endorse each other, and artificially inflate merit scores without contributing anything meaningful. Tying endorsements to active applications makes them meaningful — you're endorsing someone for a specific role, not giving a generic thumbs-up.
- **Who:** Developer

#### Changes made:
- **Database (Migration 005):** Added `application_id` column to `peer_endorsements` with foreign key to `leadership_applications`.
- **Backend (`src/routes/social/merit.js`):** `POST /api/endorsements` now requires `application_id`, validates application exists and is active. `GET /api/endorsements/received` and `/given` JOIN with applications and positions to return `position_title`.
- **Backend (`src/routes/profile.js`):** `GET /api/members` and `/api/members/:id` LEFT JOIN with `leadership_applications` to include `application_id`, `application_status`, `position_title`.
- **Backend (`src/routes/leadership.js`):** `POST /api/leadership/apply` now checks for ANY active application (pending/interview) for any position, not just the same position. Error: "One person, one position."
- **Frontend (`members.html`):** Endorse button only appears for members with active applications. Position badge shown (e.g., "Treasurer"). `endorseMember()` now passes `application_id`.
- **Frontend (`profile.html`):** Endorsement lists now show position title next to each endorsement.

---

## 2026-05-06 — Fix Content-Security-Policy Blocking Page Resources

### Add proper CSP headers to override restrictive hosting defaults
- **What:** Added a `Content-Security-Policy` response header in `src/middleware/cors.js` and `<meta http-equiv="Content-Security-Policy">` tags to `members.html` and `profile.html` to allow loading of external CDNs (Tailwind, Font Awesome), inline scripts/styles, images, and API calls.
- **Why:** The hosting platform (or an upstream proxy like Cloudflare) was injecting `default-src 'none'`, which blocks all scripts, styles, images, fonts, and fetch requests. This completely breaks every page, including the new endorsement UI.
- **Who:** Developer

---

## 2026-05-06 — Member Endorsement Frontend

### Make peer endorsements usable by members
- **What:** Added a public member directory (`members.html`) with search and endorse buttons, plus endorsement history sections on the profile page. Created public API endpoints `/api/members` and `/api/members/:id` to list verified members with endorsement counts. Updated `nav.js` to include a Members link.
- **Why:** The endorsement backend was fully implemented (POST/DELETE/GET endpoints, merit point awards, rate limits, activity logging) but had zero frontend UI. Members could not discover who to endorse or view their own endorsement history.
- **Who:** Developer

#### Changes made:
- **Backend (`src/routes/profile.js`):** Added `GET /api/members` (searchable, paginated list of verified members) and `GET /api/members/:id` (public profile with endorsement count). Both compute dynamic merit scores via the existing merit service.
- **Frontend (`members.html`):** New page with member search by name/username/island, endorse/remove-endorse buttons, stats bar showing your given/received/remaining counts, and pagination.
- **Frontend (`profile.html`):** Added "Endorsements Received" and "Endorsements Given" cards that load from `/api/endorsements/received` and `/api/endorsements/given`. Includes inline remove buttons for given endorsements.
- **Navigation (`nav.js`):** Added Members link to top nav and footer.

---

## 2026-05-06 — Deprecate Bridge-Building Bonus

### Remove the 400-point bridge-building bonus and associated stake mechanic
- **What:** Removed the `bridge_building_bonus` setting (400 pts) from `src/config/settings.js` and the bonus award logic from `src/jobs/closeProposals.js`. Updated `whitepaper.txt`, `blueprint.md`, `faq.html`, `intro.html`, `index.html`, and `policies.html` to remove all references to the 400-point bonus and bridge-building stake. The `amendment_of` column and amendment workflow remain intact — amendments now earn standard co-author points (200 / co-authors) instead of a separate bonus.
- **Why:** The 400-point bonus was double the reward for authoring a successful proposal from scratch (200 pts), creating a perverse incentive to submit bad proposals and then "fix" them for more points. At our current stage as a startup movement, this mechanic was easily gamed and premature. The amendment infrastructure is kept as a neutral collaboration tool.
- **Who:** Developer

---

## 2026-05-06 — Separate Admin Authentication from Normal Users

### Make admin a distinct, special user instead of any token holder
- **What:** Updated the auth token management in `js/auth.js` to track an `isAdmin` flag alongside the token. Modified `/api/login` to return `isAdmin: true`. Changed `admin.html` and `admin.js` to check `Auth.isAdmin()` before auto-showing the dashboard and to store admin tokens via `Auth.setAdminToken()`. Updated all normal user login flows (`nav.js`, `join.html`, `profile.html`) to explicitly clear the admin flag when storing a user token.
- **Why:** A normal user who was already logged in (with a user token in `localStorage`) could visit `/admin` and the page would immediately show the admin dashboard UI, even though all admin API calls would fail with 401. This created a broken experience and blurred the line between normal members and the admin user. The admin password is already supplied via CapRover env vars, but the frontend treated any valid token as an admin session.
- **Who:** Developer

---

## 2026-05-06 — Fix "New Joins Since Last Visit" Notification

### Make nav notification work consistently for all visitors
- **What:** Fixed `checkNewJoins()` in `nav.js` so it seeds `3dparty_last_login` on first visit and always bumps the timestamp after checking. Also wired `notificationQueue` into `src/routes/referrals.js` so family/friend enrollments queue welcome notifications like direct signups.
- **Why:** The notification was invisible because `3dparty_last_login` was only set on login/logout, leaving first-time and returning visitors without a baseline. Even when set, `markLogin()` overwrote it to "now" before `checkNewJoins` could run after a reload, so the count was always zero. Enrolled users via `/api/enroll-family-friend` also never triggered welcome wall posts.
- **Who:** Developer

---

## 2026-05-06 — Notification Queue System

### Space out wall notifications for continuous feedback
- **What:** Replaced instant wall post notifications with a batched notification queue. Created `notification_queue` table, `src/services/notification-queue.js` service, and `src/jobs/processNotifications.js` background job. Updated `proposals.js`, `ranked-proposals.js`, and `register.js` to queue notifications instead of posting directly to `wall_posts`. Added admin settings `notification_enabled`, `notification_batch_interval_ms`, and `notification_max_per_batch`.
- **Why:** When users enrolled many people or created many proposals, notifications flooded the wall instantly. Spacing notifications creates a steady stream of feedback over time rather than bursts, keeping the wall active and engaging continuously.
- **Who:** Developer

#### Changes made:
- **Database:** Migration `004_notification_queue.js` creates `notification_queue` table with indexes.
- **Service:** `notification-queue.js` provides `queueNotification()`, `processQueue()`, and `getQueueStatus()`.
- **Background job:** `processNotifications` runs every `notification_batch_interval_ms` (default 5min), posting up to `notification_max_per_batch` (default 3) notifications per cycle.
- **Routes:** Replaced direct `wall_posts` INSERTs in proposal creation, ranked proposal creation, and signup/verification welcome messages with queued notifications.
- **Admin panel:** Added "Notification Queue" section in Settings tab with controls for enabled state, batch interval, and max per batch.

---

## 2026-05-06 — Consolidate Settings Tab into Single Textarea

### Replace individual settings fields with unified config editor
- **What:** Replaced ~50 individual input fields across 9 category cards in the Settings tab with a single large monospace textarea showing all settings as `key = value` pairs with inline comments. Added `buildSettingsText()` to render settings, `parseSettingsText()` to parse edits back into key-value objects, and a Copy button for easy backup.
- **Why:** The previous UI had too many scattered text fields across multiple cards, making it hard to scan, search, or bulk-edit settings. A single config-style textarea is faster to navigate, supports Ctrl+F, and is easier to copy/paste for backups.
- **Who:** Developer

---

## 2026-05-06 — Fix Leadership Subtabs Functionality

### Make all leadership subtabs fully functional
- **What:** Fixed all stub/placeholder functions in the Leadership tab subtabs (Settings, Positions, Applications, Current Leaders, SOPs, Appraisals). Added missing API endpoints and updated frontend to properly interact with the backend.
- **Why:** The leadership subtabs had alert() stubs instead of actual API calls, making them non-functional. Users could not create/edit positions, SOPs, or record appraisals.
- **Who:** Developer

#### Changes made:
- **Positions tab:** `togglePosition()` now calls `POST /api/leadership/positions/:id/toggle`. `showAddPositionForm()` now creates positions via `POST /api/leadership/positions`. Added `deletePosition()` with `DELETE /api/leadership/positions/:id` endpoint.
- **SOPs tab:** `showAddSOPForm()` now creates SOPs via `POST /api/leadership/sops`. `editSOP()` now updates SOPs via the same endpoint.
- **Appraisals tab:** `showAppraisalForm()` now submits full appraisal data (rating, strengths, areas for improvement, feedback) via `POST /api/leadership/appraisals`. Added `GET /api/leadership/appraisals` endpoint to list existing appraisals. Updated `renderAppraisals()` to display appraisal history.
- **Dashboard stats:** Added `pendingAppraisals` stat calculation based on appraisal frequency settings and last appraisal dates per leader.
- **State management:** Added `appraisals: []` to `leadershipData` state object. Updated `loadLeadershipData()` to fetch appraisals in parallel with other data.

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

## 2026-05-04 — Implementation Status Audit

### Comprehensive audit of features vs whitepaper spec
- **What:** Conducted a full audit of every whitepaper feature against the codebase. Documented 16 fully implemented merit mechanisms, identified true gaps (SMS OTP, engagement bonus, law vote points, elections, Git-Constitution, etc.), and catalogued misleading frontend copy. Fixed law voting merit points, misleading frontend copy, and engagement bonus population in the same pass.
- **Why:** After months of rapid feature development, there was no single source of truth for what was built vs what was spec'd. This audit created the first comprehensive implementation map and exposed several frontend bugs where copy claimed features existed that didn't.
- **Who:** Developer

#### Findings at time of audit:
- **Fully implemented:** Merit events table, dynamic decay, loyalty coefficient, leaderboard, endorsements, bounties, academy, stipends, advisory reports, proposal staking, reputation penalty, knowledge quizzes, article comments, amplification links, violation sanctions, Emeritus Council, Policy Hubs, events, donation verification, password change, admin proposal management, leadership SOPs/appraisals, notification queue.
- **True gaps:** SMS OTP, Shadow Minister elections, Git-Inspired Constitution, Living Legal Code persistent tracking, Live Treasury public dashboard, Signal Horn Protocol, Unity Warning System, Community Hubs (Círculos), Candidate Selection, People's Manifesto, Recall Vote, Coalition Governance Protocol.
- **Fixed during audit:** Law voting points, misleading "+2.5 pts" copy on law votes, engagement bonus `first_action_at` trigger.

---

## 2026-05-04 — Backend Refactoring: server.js Monolith Decomposition

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
