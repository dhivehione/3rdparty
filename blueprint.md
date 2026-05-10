# 3d Party — Technical Blueprint

> **Last updated:** 2026-05-10 (fix clause vote database reference)
> **Governance spec:** `whitepaper.txt` (3rd Party v14)
> **Implementation history:** `history.md`
> **Status key:** ✅ Implemented | ⚠️ Partial | ❌ Not Implemented | 🔮 Future Phase

---

## 1. Project Overview

**Stack:** Node.js (Express) + better-sqlite3 + vanilla JS frontend (Tailwind CSS)
**Entry point:** `server.js` (~150 lines, wiring only)
**Database:** SQLite (`data/signups.db`), external `laws.db` from mvlaws project
**Specification:** 3rd Party v14 whitepaper — a platform merging direct democracy with merit-based incentives, dynamic governance, and anti-schism safeguards.

### 1.1 Core Principles (from whitepaper §II)

- **Empowered Participation** — Every verified citizen can vote, propose policies, and participate. Access via digital + offline channels (SMS voting, Community Hubs).
- **Policy Proposals & Public Referendum** — The primary engine of governance. Citizens draft ideas that go through submission → staking → public referendum → enactment.
- **Merit-Based Influence** — Universal right to participate, variable influence earned through constructive actions.
- **Dynamic Governance** — Contextual voting mechanisms (weighted majority, ranked choice), tiered approval thresholds based on proposal impact.
- **Absolute Transparency** — Verifiable anonymity: aggregate results are public, individual votes are private.

### 1.2 Project Terminology

| Term | Meaning |
|---|---|
| DYM | 3rd Party |
| 3d Party | The third-option political brand |
| Merit Score (MS) | Dynamic, decay-weighted sum of all contribution points |
| Governing Council | Elected Shadow Ministers who lead the movement |
| Shadow Government | A ready alternative cabinet, preparing to govern |
| Parametric Governance Engine | The automated rule engine that enforces all platform rules |
| Live Treasury | Publicly verifiable ledger of all donations and expenditures |
| Living Legal Code | Persistent public audit of every national law |

---

## 2. System Architecture

### 2.1 Backend Architecture

The backend follows a modular, dependency-injected architecture. `server.js` is a thin wiring layer that initializes services, mounts route modules, and starts background jobs.

```
server.js              ← Express app setup, route mounting, graceful shutdown
src/
├── config/settings.js ← DEFAULT_SETTINGS, getSettings, updateSettings
├── db/
│   ├── index.js       ← initDb (signups.db + laws.db handles)
│   └── queries/       ← Domain-specific data access layer (18 query modules)
├── middleware/
│   ├── auth.js        ← adminAuth, userAuth
│   ├── cors.js        ← CSP and CORS headers
│   └── rate-limits.js ← enrollment rate limiting
├── migrations/        ← 5 numbered migrations + schema_version tracking
├── services/          ← Business logic (merit, referral, treasury, etc.)
├── jobs/              ← 6 background intervals (proposals, stipends, notifications, etc.)
├── routes/            ← Express Router modules (~30 route files)
└── utils/             ← sanitizeHTML, getClientIp, generateOTP
```

**Pattern:** Every module exports a factory function receiving dependencies (`{ db, getSettings, ... }`) via dependency injection. This eliminates circular requires and makes testing straightforward.

### 2.2 Frontend Architecture

- **CSS:** Tailwind CSS v3, built locally via PostCSS (`tailwind.config.js`, `styles/tailwind.css`, `tailwind.css`)
- **Shared JS:** Three global modules loaded on most pages:
  - `js/utils.js` — `Utils.escapeHtml`, `Utils.formatTime`, `Utils.formatDate`, `Utils.formatCurrency`
  - `js/auth.js` — `Auth.getToken`, `Auth.setToken`, `Auth.logout`, `Auth.isAdmin`
  - `js/api.js` — `api.get`, `api.post`, `api.put`, `api.del` with auto-auth injection
- **Navigation:** `nav.js` injects the navbar into all pages and handles footer links, notification badges, and cold-visitor banners.

---

## 3. The Merit Score System — Full Specification

> **Source:** whitepaper §II.C. These are the canonical values derived from agent-based simulations. They can only be changed by a constitutional vote of the full membership.

### 3.1 Master Formula

```
MS_current = Σ [ Point_event_i * e^(-(λ_base / Lc) * t_i) ]
```

| Variable | Definition |
|---|---|
| `Point_event_i` | Initial point value for a specific action `i` |
| `λ_base` | Base decay constant = `0.001267` (achieves 18-month half-life at Lc=1.0) |
| `Lc` | Loyalty Coefficient (see §3.3) |
| `t_i` | Time in days since action `i` occurred |
| `e` | Euler's number ~2.71828 |

### 3.2 Point Rewards Per Action

#### 3.2.1 Voting (`Point_event`)
| Action | Points |
|---|---|
| Vote on proposal that **fails** | 1.0 |
| Vote on proposal that **succeeds** | 2.5 |

#### 3.2.2 Proposal Authoring
| Action | Points |
|---|---|
| Author/co-author a proposal that **passes** | `200 / number_of_coauthors` |

#### 3.2.3 Peer Endorsements (Community Trust)
| Endorsement # | Points Each |
|---|---|
| 1–10 | 2.0 |
| 11–50 | 1.0 |
| 51–200 | 0.5 |
| 201+ | 0.1 |

**Constraint:** Maximum 20 unique endorsements allowed per 30-day period (prevents "endorsement rings").

#### 3.2.4 Resource Contribution (Donations)
```
Points = 35 * log5(Donation_Value_USD + 1)
```
| Donation (USD) | Approx. Points |
|---|---|
| $10 | 26 |
| $100 | 90 |
| $1,000 | 143 |
| $10,000 | 184 |

Steeply diminishing returns — grassroots funding is more point-efficient than large donations.

#### 3.2.5 Bounty System (Skill-Based Contributions)
| Tier | Description | Points |
|---|---|---|
| Tier 1 | Simple task (translation, basic research) | 20 |
| Tier 2 | Involved task (data analysis, graphic design) | 75 |
| Tier 3 | Expert task (legal draft, major report, Leadership Academy graduation) | 250 |

#### 3.2.6 Network Growth (Recruitment) — Two-Tiered
| Invite # | Base Reward | Engagement Bonus | Total Potential |
|---|---|---|---|
| 1–5 | 2 | 8 | **10** |
| 6–20 | 1 | 4 | **5** |
| 21+ | 0.5 | 0.5 | **1** |

- **Base Reward** — Awarded immediately when the invited person verifies their account (National ID + SMS).
- **Engagement Bonus** — Awarded only after the invited person completes their first merit-generating action (e.g., casts their first vote).

#### 3.2.7 Role-Based Stipends (Monthly)
| Role | Points/Month | Condition |
|---|---|---|
| Shadow Minister (Governing Council) | 150 | >80% meeting attendance, >90% vote participation |
| Standing Committee Member (Integrity, Verification) | 75 | Meet committee-specific activity quorum |
| Advisory Expert Panelist | 50 per report | Feasibility Report submitted on time, meeting quality standards |
| Policy Incubation Hub member | 50 per month | Active membership in a chartered Hub |
| Performance Bonus pool | 1,000/quarter | Discretionary, awarded by Council via public Decision Statement |
| Leadership Academy mentor | Recurring reward | For guiding new cohorts |

### 3.3 Dynamic Decay & Loyalty

| Member Type | Loyalty Coefficient (Lc) | Effective Half-Life |
|---|---|---|
| Founding Members (first 3,000) | 1.5 | 27 months |
| Early Adopters (next wave) | 1.2 | 21.6 months |
| Standard Members | 1.0 | 18 months |

- `λ_base = 0.001267` yields the 18-month half-life at Lc=1.0.
- Formula: `half_life = 18_months * Lc`
- Decay ensures inactive old members are surpassed by active newcomers.
- Loyalty Coefficient is permanent and tied to join date.

> **Implementation note:** Code currently derives Lc from days since join: `<180 days = 1.0, <365 days = 1.2, >=365 days = 1.5`. This is semantically inverted from the whitepaper (new members get lowest coefficient, not highest). The whitepaper intends Founding Members (earliest joins) to have Lc=1.5, which matches the code's logic for long-tenured members.

### 3.4 Stakes & Penalties

#### Proposal Staking
```
Stake = max(10, Current_Merit_Score * 0.005)
```
- Stake is *refunded* if the proposal achieves ≥20% support.
- Stake is *forfeited* if the proposal gets <10% support (deemed frivolous).

#### Reputation Penalty (for repeated low-quality proposals)
```
Penalty = Base_Stake * Quality_Ratio
Quality_Ratio = (1 + Total_Failed_Proposals) / (1 + Total_Successful_Proposals)
```
- Triggered when a proposal fails with <10% support.
- Escalates for members with poor track records.

#### Violation Penalties (Code of Conduct)
| Tier | Severity | Sanction |
|---|---|---|
| **Tier 1** (spam, minor incivility) | Minor | Written warning → privilege suspension + minor point penalty |
| **Tier 2** (harassment, disinfo, endorsement rings) | Serious | Significant point penalty, 30-180 day suspension, forfeiture of ill-gotten points |
| **Tier 3** (hate speech, threats, subversion) | Severe | Permanent ban, full merit score forfeiture, cooperation with law enforcement |

---

## 4. Governance Architecture (from whitepaper §II.D, §III, §VI)

### 4.1 Voting Mechanisms

| Mechanism | Use Case | Status |
|---|---|---|
| **Weighted Majority** | Binary Yes/No proposals | ✅ Implemented (`src/routes/proposals.js`) |
| **Ranked-Choice Voting (RCV)** | Leadership elections, multi-option choices | ✅ Implemented (`src/routes/ranked-proposals.js`) |

### 4.2 Tiered Approval Thresholds

| Proposal Category | Required Majority |
|---|---|
| Routine decisions | 50% + 1 weighted majority |
| Policy shifts | 60–75% |
| Constitutional amendments | 80–90% |

**Categorization process:** Proposer declares category → Council reviews → Community can challenge with "Categorization Vote."

Status: ✅ Tiered thresholds calculated in `src/services/merit.js:calculateApprovalThreshold()`. Proposal category is set on creation and threshold is stored. Categorization vote workflow not yet implemented.

### 4.3 Voting Windows (Weight Decay)

| Window | Vote Weight |
|---|---|
| Primary (Days 1–7) | 100% |
| Extended (Days 8–10) | 50% |

Status: ✅ Implemented via `src/services/merit.js:calculateVoteWeight()`. Configurable via settings.

### 4.4 Leadership Structure

#### Shadow Ministers (Governing Council)
- **Selection:** 4-stage process — Merit threshold eligibility → Public application → Live-streamed panel interview → RCV confirmation vote.
- **Term:** Maximum 2 years, mandatory annual performance review.

#### Default Leadership Roles (`src/migrations/001_initial_schema.js`)
| Role | Type | Min Merit |
|---|---|---|
| Shadow President | council | 1000 |
| Shadow Finance Minister | council | 800 |
| Shadow Foreign Minister | council | 800 |
| Shadow Education Minister | council | 800 |
| Shadow Health Minister | council | 800 |
| Integrity Committee Chair | committee | 600 |
| Verification Committee Chair | committee | 500 |
| Policy Hub Lead | hub | 700 |

### 4.5 Policy Incubation Hubs
- Long-term working groups for complex systemic issues (healthcare reform, energy plans).
- Approved by Governing Council with a public charter.
- Output: Detailed "Whitepaper" proposal voted on as a unified package.
- Members earn recurring monthly stipends for active participation.

Status: ✅ Hubs API implemented (`src/routes/hubs-emeritus.js`), including join, list, and monthly stipend cron (`src/jobs/processHubStipends.js`).

### 4.6 The Living Legal Code
- Every national law listed on the platform, subject to continuous public audit.
- Members cast persistent Approve/Disapprove votes weighted by Merit Score.
- When approval falls below threshold (e.g., 40%), automatic "Mandatory Review Agenda" triggers Governing Council action.

Status: ⚠️ Law browsing and voting implemented via external `laws.db`. Persistent approve/disapprove tracking and auto-flagging not implemented.

### 4.7 Git-Inspired Constitution
- Living document amendable via "Merge Proposal" system.
- Members fork → modify → submit for constitutional vote.
- Clear, trackable, stable amendment process.

Status: ❌ Not implemented.

### 4.8 Emeritus Council
- Advisory body (no governing power) for institutional memory.
- Auto-invitation for: former Council members OR members in top 1% for 3+ years.
- Function: Curate Knowledge Archive, provide non-binding Advisory Opinions.

Status: ✅ Emeritus Council eligibility checking and API implemented (`src/routes/hubs-emeritus.js`). Runs daily cron. Knowledge Archive not yet built.

### 4.9 Signal Horn Protocol (Crisis Response)
- Council activates with 75% supermajority for a named crisis.
- Official Crisis Statement pinned to all dashboards for 12 hours.
- Can include Merit Score bounty for members who amplify the unified response.

Status: ❌ Not implemented.

### 4.10 Limits on Leadership Authority
- All significant decisions require public "Decision Statement" + weighted majority vote.
- Minimum quorum: 10% of active members.
- "Active member" = performed ≥1 merit action in last 30 days.
- Minor expenditures (≤1% of monthly budget) require transparency but no vote.

Status: ⚠️ Leadership SOPs define these rules (seeded in DB), but automated Decision Statement workflow not built.

---

## 5. Database Schema

### 5.1 Main Database (`data/signups.db`)

| Table | Purpose | Key Columns |
|---|---|---|
| `signups` | User accounts | `phone`, `nid`, `username`, `initial_merit_estimate`, `contribution_type`, `donation_amount`, `auth_token`, `last_login`, `password_hash`, `otp_code`, `otp_verified` |
| `referrals` | Referral tracking | `referrer_id`, `referred_id`, `relation`, `status`, `base_reward_given`, `engagement_bonus_given`, `first_action_at` |
| `activity_log` | Audit trail | `action_type`, `user_id`, `target_id`, `details`, `ip_address`, `timestamp` |
| `wall_posts` | Public wall | `nickname`, `message`, `thread_id`, `is_approved` |
| `wall_votes` | Wall post votes | `post_id`, `voter_ip`, `vote_type` |
| `wall_flags` | Wall post flags | `post_id`, `reporter_ip`, `reason` |
| `proposals` | Policy proposals | `title`, `description`, `category`, `status`, `yes_votes`, `no_votes`, `abstain_votes`, `created_by_user_id`, `approval_threshold`, `is_closed`, `passed`, `amendment_of` |
| `votes` | Proposal votes (merit-weighted) | `proposal_id`, `choice`, `voter_ip`, `user_id`, `vote_weight`, `loyalty_coefficient`, `days_since_created` |
| `ranked_proposals` | RCV elections | `title`, `description`, `category`, `options` (JSON) |
| `ranked_votes` | RCV ballots | `proposal_id`, `ranking` (JSON), `voter_ip` |
| `system_settings` | Runtime config (JSON blob) | `settings_json`, `updated_at` |
| `merit_events` | Every point-earning action | `user_id`, `event_type`, `points`, `reference_id`, `reference_type`, `description`, `created_at` |
| `peer_endorsements` | Peer-to-peer endorsements | `endorser_id`, `endorsed_id`, `application_id`, `created_at`, `expires_at` |
| `bounties` | Bounty board tasks | `title`, `description`, `tier` (1/2/3), `reward_points`, `posted_by_user_id`, `assigned_to_user_id`, `status` |
| `bounty_claims` | Bounty claim submissions | `bounty_id`, `user_id`, `proof`, `status`, `reviewed_by_user_id`, `reviewed_at` |
| `academy_modules` | Leadership Academy curriculum | `title`, `description`, `order_index`, `is_active` |
| `academy_enrollments` | Academy enrollment tracking | `user_id`, `module_id`, `status` (enrolled/in_progress/completed), `enrolled_at`, `completed_at` |
| `academy_graduation` | Academy graduates | `user_id`, `graduated_at`, `merit_awarded`, `mentor_id` |
| `donations` | Donation tracking | `user_id`, `phone`, `nid`, `amount`, `slip_filename`, `remarks`, `status`, `verified_by`, `verified_at` |
| `violations` | Disciplinary cases | `reporter_user_id`, `accused_user_id`, `violation_type`, `tier` (1/2/3), `description`, `evidence`, `status`, `resolution` |
| `user_suspensions` | Suspension records | `user_id`, `violation_id`, `suspension_type` (warning/temporary/permanent), `reason`, `starts_at`, `ends_at`, `is_active` |
| `leadership_positions` | Role definitions | `title`, `description`, `position_type` (council/committee/hub/advisory/emeritus), `min_merit_required`, `is_active` |
| `leadership_applications` | User applications | `user_id`, `position_id`, `application_text`, `status`, `merit_score_at_apply`, `interview_scheduled_at`, `interview_video_url` |
| `leadership_terms` | Active assignments | `user_id`, `position_id`, `started_at`, `ended_at`, `term_number` |
| `leadership_stipends` | Monthly stipend records | `user_id`, `position_id`, `period_year`, `period_month`, `amount_awarded` |
| `leadership_settings` | Leader config | `member_threshold`, `min_merit_for_leadership`, `max_term_years`, `appraisal_frequency_days` |
| `leadership_appraisals` | Performance reviews | `term_id`, `appraisal_period`, `rating` (1-5), `strengths`, `areas_for_improvement`, `overall_feedback` |
| `leadership_sops` | Standard Operating Procedures | `title`, `content`, `category`, `version`, `is_active` |
| `advisory_reports` | Expert panel reports | `user_id`, `report_title`, `report_content`, `status`, `reviewed_by_user_id`, `reviewed_at` |
| `article_quizzes` | Knowledge check quizzes | `article_id`, `question`, `options` (JSON), `correct_answer`, `points_reward` |
| `quiz_attempts` | Quiz answer records | `user_id`, `quiz_id`, `selected_answer`, `correct`, `attempted_at` |
| `article_comments` | Article comments | `user_id`, `article_id`, `comment_text`, `endorsement_count` |
| `comment_endorsements` | Comment endorsements | `comment_id`, `endorser_id` |
| `amplification_links` | Share tracking links | `creator_user_id`, `content_type`, `track_code`, `base_url`, `click_count`, `reward_points` |
| `amplification_clicks` | Link click records | `link_id`, `clicker_ip`, `clicked_at` |
| `emiritus_council` | Emeritus Council members | `user_id`, `invited_at`, `reason`, `is_active` |
| `policy_hubs` | Policy Incubation Hubs | `name`, `charter`, `goals`, `status`, `created_by_user_id` |
| `hub_members` | Hub membership | `hub_id`, `user_id`, `role` (lead/member), `stipend_earned` |
| `hub_stipends` | Hub stipend records | `hub_id`, `user_id`, `period_year`, `period_month`, `amount_awarded` |
| `laws` | Platform laws | `title`, `description`, `category`, `source_proposal_id`, `status` |
| `proposal_stakes` | Staking records | `proposal_id`, `user_id`, `stake_amount`, `status` (locked/refunded/forfeited) |
| `events` | Movement events | `title`, `description`, `event_date`, `location` |
| `notification_queue` | Batched wall notifications | `type`, `payload` (JSON), `scheduled_at`, `processed_at` |
| `treasury_ledger` | Live Treasury entries | `type`, `amount`, `description`, `reference_id`, `created_at` |
| `schema_version` | Migration tracking | `version`, `applied_at` |

### 5.2 External Database (`laws.db` from mvlaws)

| Table | Purpose |
|---|---|
| `laws` | All Maldivian laws with categories |
| `articles` | Law articles |
| `sub_articles` | Clauses within articles |
| `sub_article_votes` | Clause-level votes (linked via `user_phone`) |
| `law_votes` (in main DB) | Article-level votes (linked via `user_phone`) |
| `law_level_votes` (in laws DB) | Law-level votes |

---

## 6. File Structure

```
3rdparty/
├── server.js                          ← ~150 lines, wiring only
├── package.json
├── tailwind.config.js
├── build.sh
├── Dockerfile
├── caprover.json
│
├── src/
│   ├── config/
│   │   └── settings.js                ← DEFAULT_SETTINGS (60+ keys), getSettings, updateSettings
│   ├── db/
│   │   ├── index.js                   ← initDb for signups.db + laws.db
│   │   └── queries/
│   │       ├── index.js               ← Aggregates all query modules
│   │       ├── signups.js             ← User CRUD, auth lookup
│   │       ├── proposals.js           ← Proposal CRUD, vote tallying
│   │       ├── wall.js                ← Post CRUD, votes, flags
│   │       ├── merit.js               ← merit_events CRUD, score queries
│   │       ├── referrals.js           ← Referral CRUD, engagement tracking
│   │       ├── donations.js           ← Donation CRUD
│   │       ├── treasury.js            ← Ledger entries, balance queries
│   │       ├── endorsements.js        ← Endorsement CRUD
│   │       ├── bounties.js            ← Bounty CRUD, claims
│   │       ├── laws.js                ← Law/vote queries (uses lawsDb)
│   │       ├── leadership.js          ← Positions, terms, applications
│   │       ├── hubs.js                ← Policy hubs, membership
│   │       ├── events.js              ← Events CRUD
│   │       └── activity-log.js        ← Audit log entries
│   ├── middleware/
│   │   ├── auth.js                    ← adminAuth, userAuth, adminSessions Map
│   │   ├── cors.js                    ← CSP + CORS headers
│   │   └── rate-limits.js             ← Enrollment rate limiting
│   ├── migrations/
│   │   ├── index.js                   ← runMigrations orchestrator
│   │   ├── 001_initial_schema.js      ← Core tables + seeds
│   │   ├── 002_final_columns.js       ← Late schema additions
│   │   ├── 003_merit_audit.js         ← Merit events + decay engine tables
│   │   ├── 004_notification_queue.js  ← Notification queue table
│   │   └── 005_endorsement_application.js ← Application-scoped endorsements
│   ├── services/
│   │   ├── activity-log.js            ← logActivity
│   │   ├── analytics.js               ← activeVisitors Map, heartbeat
│   │   ├── merit.js                   ← calculateDecayedScore, calculateVoteWeight, processStipends, etc.
│   │   ├── referral.js                ← getReferralPoints, maybeEngageReferral
│   │   ├── sms.js                     ← generateOTP, sendSMS
│   │   ├── treasury.js                ← addTreasuryEntry, getTreasuryBalance
│   │   ├── wall-moderation.js         ← moderateWallContent
│   │   └── notification-queue.js      ← queueNotification, processQueue
│   ├── jobs/
│   │   ├── index.js                   ← start/stop all intervals
│   │   ├── cleanupVisitors.js         ← Purge expired active visitors
│   │   ├── closeProposals.js          ← Award merit, resolve stakes, close expired
│   │   ├── processStipends.js         ← Monthly leadership stipends
│   │   ├── processHubStipends.js      ← Monthly hub member stipends
│   │   ├── checkEmeritus.js           ← Daily Emeritus eligibility check
│   │   └── processNotifications.js    ← Batched wall notification queue
│   ├── routes/
│   │   ├── auth/
│   │   │   ├── register.js            ← POST /api/signup
│   │   │   ├── login.js               ← POST /api/login
│   │   │   ├── admin.js               ← Admin auth endpoints
│   │   │   └── stats.js               ← Public stats (member count, etc.)
│   │   ├── legislation/
│   │   │   ├── browse.js              ← GET /api/mvlaws/*
│   │   │   ├── voting.js              ← POST /api/mvlaws/vote*
│   │   │   └── ai-draft.js            ← POST /api/generate-law-draft
│   │   ├── social/
│   │   │   ├── merit.js               ← GET /api/merit/*
│   │   │   ├── interactions.js        ← Endorsements, comments, quizzes
│   │   │   ├── violations.js          ← Report/resolve violations
│   │   │   └── amplification.js       ← Trackable share links
│   │   ├── admin-merit.js             ← Admin merit management
│   │   ├── admin-proposals-donations.js ← Admin proposal/donation controls
│   │   ├── admin-wall.js              ← Admin wall moderation
│   │   ├── analytics.js               ← GET /api/analytics/*
│   │   ├── bounty-academy.js          ← Bounties + Leadership Academy
│   │   ├── donations-public.js        ← Public donation submission
│   │   ├── enrollment.js              ← POST /api/enroll-family-friend
│   │   ├── events.js                  ← GET/POST /api/events, /api/admin/events
│   │   ├── hubs-emeritus.js           ← Hubs + Emeritus Council
│   │   ├── leadership.js              ← Leadership management + public APIs
│   │   ├── profile.js                 ← User profile, member directory
│   │   ├── proposals.js               ← Proposals + binary voting + stakes
│   │   ├── ranked-proposals.js        ← RCV elections
│   │   ├── referrals.js               ← Referral introduce/remove/list
│   │   ├── static-pages.js            ← All HTML page routes
│   │   ├── treasury.js                ← Treasury ledger APIs
│   │   └── wall.js                    ← Wall posts, votes, flags
│   └── utils/
│       └── index.js                   ← sanitizeHTML, getClientIp, generateOTP
│
├── js/
│   ├── utils.js                       ← escapeHtml, formatTime, formatDate, formatCurrency
│   ├── auth.js                        ← Token management, isAdmin
│   └── api.js                         ← Fetch wrappers with auto-auth
│
├── styles/
│   └── tailwind.css                   ← PostCSS input
│
├── data/
│   └── signups.db                     ← Main SQLite database
│
└── tests/
    └── (smoke and integration tests)
```

---

## 7. Frontend Pages

| Page | File | Description |
|---|---|---|
| Home / Landing | `index.html` | Movement narrative, merit score demo calculator |
| Join / Signup | `join.html` | Registration with contribution type selection |
| Join Success | `join-success.html` | Post-registration invitation |
| Login | `join.html` (shared) | Username + phone login |
| Profile | `profile.html` | Tabbed layout — Details/Scores (always visible), Activity, Voting, Proposals, Enroll, Leadership, Endorsements |
| Proposals & Voting | `proposals.html` | Binary + ranked choice create/vote UI, AI-assisted proposal drafting |
| Laws & Legislation | `laws.html` | Browse/search laws, AI-assisted drafting, vote on clauses |
| Law Stats | `law-stats.html` | Voting statistics |
| Enroll | `enroll.html` | Standalone enrollment for family/friends |
| Wall | `wall.html` | Public message board |
| Events | `events.html` | Movement events listing |
| FAQ | `faq.html` | Frequently asked questions |
| How It Works | `how.html` | Movement journey narrative |
| Intro / Our Story | `index.html` | What makes us different |
| Legislature | `legislature.html` | Legislative information |
| Leadership | `leadership.html` | Leadership roster and roles |
| Policies | `policies.html` | Policy platform |
| Donate | `donate.html` | Donation page with bank details |
| Treasury | `treasury.html` | Live Treasury public ledger |
| Admin Dashboard | `admin.html` | Settings, users, leadership, donations, proposals |
| Whitepaper | `whitepaper.html` | Rendered whitepaper viewer |
| Navigation (shared) | `nav.js` | Injected navbar across all pages |

---

## 8. Key API Endpoints

| Method | Path | Auth | Module | Description |
|---|---|---|---|---|
| `POST` | `/api/signup` | None | `auth/register.js` | Register new user, calc merit, match pending referrals |
| `POST` | `/api/login` | None | `auth/login.js` | Login with username + phone |
| `GET` | `/api/user/profile` | User | `profile.js` | Get profile + vote counts |
| `PUT` | `/api/user/profile` | User | `profile.js` | Update username/name/email/island |
| `POST` | `/api/user/change-password` | User | `profile.js` | Change password |
| `GET` | `/api/user/activity-log` | User | `profile.js` | User's activity audit trail |
| `GET` | `/api/user/proposals` | User | `profile.js` | User's proposals/drafts |
| `GET` | `/api/user/bounties` | User | `profile.js` | User's posted/claimed bounties |
| `POST` | `/api/referral/introduce` | User | `referrals.js` | Create pending/active referral |
| `POST` | `/api/enroll-family-friend` | User | `enrollment.js` | Directly enroll someone + award base points |
| `GET` | `/api/referrals` | User | `referrals.js` | List referrals + point summary |
| `POST` | `/api/referral/remove` | User | `referrals.js` | Remove referral, reverse awarded points |
| `POST` | `/api/enroll/lookup` | User | `enrollment.js` | Search external directory |
| `GET` | `/api/proposals` | None | `proposals.js` | List active proposals with voting window info |
| `POST` | `/api/proposals` | Optional | `proposals.js` | Create proposal (8h cooldown for auth users) |
| `POST` | `/api/proposals/:id/stake` | User | `proposals.js` | Stake points on proposal |
| `GET` | `/api/proposals/:id/stake` | None | `proposals.js` | View stakes on proposal |
| `POST` | `/api/vote` | None | `proposals.js` | Vote on proposal (merit-weighted) |
| `POST` | `/api/ranked-vote` | User | `ranked-proposals.js` | Submit ranked-choice ballot |
| `PATCH` | `/api/proposals/:id` | None | `proposals.js` | Edit proposal title/description |
| `GET` | `/api/proposal-stats` | None | `proposals.js` | Proposal engagement stats |
| `GET` | `/api/mvlaws` | None | `legislation/browse.js` | List all laws with categories |
| `GET` | `/api/mvlaws/search` | None | `legislation/browse.js` | Search laws, articles, clauses |
| `GET` | `/api/mvlaws/stats` | None | `legislation/browse.js` | Voting statistics |
| `GET` | `/api/mvlaws/:id` | None | `legislation/browse.js` | Law detail with articles |
| `GET` | `/api/mvlaws/:id/articles/:articleId` | None | `legislation/browse.js` | Article detail with sub-articles |
| `POST` | `/api/mvlaws/vote-subarticle` | Optional | `legislation/voting.js` | Vote on a clause (optional phone for merit) |
| `POST` | `/api/mvlaws/vote` | User | `legislation/voting.js` | Vote on an article |
| `POST` | `/api/mvlaws/vote-law` | User | `legislation/voting.js` | Vote on entire law |
| `GET` | `/api/wall` | None | `wall.js` | Get wall posts |
| `POST` | `/api/wall` | None | `wall.js` | Create wall post |
| `GET` | `/api/wall-stats` | None | `wall.js` | Wall statistics |
| `POST` | `/api/unregister` | Admin | `auth/admin.js` | Remove user from platform |
| `GET` | `/api/system-settings` | Admin | `leadership.js` | Get current system settings |
| `POST` | `/api/system-settings` | Admin | `leadership.js` | Update system settings |
| `GET` | `/api/public-settings` | None | `auth/stats.js` | Public settings (member count, targets) |
| `GET` | `/api/merit/score` | User | `social/merit.js` | Dynamic + static merit score + loyalty tier |
| `GET` | `/api/merit/events` | User | `social/merit.js` | Paginated merit event history |
| `GET` | `/api/merit/leaderboard` | None | `social/merit.js` | Top N members by score |
| `POST` | `/api/endorsements` | User | `social/interactions.js` | Endorse an applicant |
| `DELETE` | `/api/endorsements/:id` | User | `social/interactions.js` | Remove endorsement |
| `GET` | `/api/endorsements/received` | User | `social/interactions.js` | List endorsements received |
| `POST` | `/api/bounties` | User | `bounty-academy.js` | Create bounty (Tier 1/2/3) |
| `GET` | `/api/bounties` | None | `bounty-academy.js` | List bounties (filterable) |
| `GET` | `/api/bounties/:id` | None | `bounty-academy.js` | Bounty detail + claims |
| `POST` | `/api/bounties/:id/claim` | User | `bounty-academy.js` | Claim a bounty |
| `POST` | `/api/bounties/:id/approve` | User | `bounty-academy.js` | Approve claim (awards points) |
| `POST` | `/api/bounties/:id/reject` | User | `bounty-academy.js` | Reject claim |
| `POST` | `/api/bounties/:id/cancel` | User | `bounty-academy.js` | Cancel own bounty |
| `GET` | `/api/academy/modules` | None | `bounty-academy.js` | List academy modules |
| `POST` | `/api/academy/enroll` | User | `bounty-academy.js` | Enroll in module |
| `POST` | `/api/academy/complete` | User | `bounty-academy.js` | Complete module (graduation check) |
| `GET` | `/api/academy/progress` | User | `bounty-academy.js` | Academy progress |
| `GET` | `/api/stipends` | User | `bounty-academy.js` | List leadership stipends received |
| `POST` | `/api/advisory-reports` | User | `bounty-academy.js` | Submit advisory report |
| `GET` | `/api/advisory-reports` | User | `bounty-academy.js` | List own reports |
| `POST` | `/api/advisory-reports/:id/approve` | User | `bounty-academy.js` | Approve report (awards points) |
| `POST` | `/api/quizzes` | User | `social/interactions.js` | Create knowledge check quiz |
| `GET` | `/api/quizzes/:articleId` | None | `social/interactions.js` | Get quizzes for article |
| `POST` | `/api/quizzes/:id/answer` | User | `social/interactions.js` | Answer quiz (awards points if correct) |
| `POST` | `/api/comments` | User | `social/interactions.js` | Post article comment |
| `GET` | `/api/comments/:articleId` | None | `social/interactions.js` | Get comments for article |
| `POST` | `/api/comments/:id/endorse` | User | `social/interactions.js` | Endorse comment (awards commenter points) |
| `POST` | `/api/violations/report` | User | `social/violations.js` | Report violation |
| `GET` | `/api/violations` | User | `social/violations.js` | List violations (own or all if admin) |
| `POST` | `/api/violations/:id/resolve` | User | `social/violations.js` | Resolve violation (apply penalties) |
| `GET` | `/api/suspensions/active` | None | `social/violations.js` | List active suspensions |
| `GET` | `/api/emeritus` | None | `hubs-emeritus.js` | List Emeritus Council members |
| `POST` | `/api/hubs` | User | `hubs-emeritus.js` | Create Policy Incubation Hub |
| `GET` | `/api/hubs` | None | `hubs-emeritus.js` | List active hubs |
| `POST` | `/api/hubs/:id/join` | User | `hubs-emeritus.js` | Join a hub |
| `POST` | `/api/amplify` | User | `social/amplification.js` | Create amplifiable tracking link |
| `GET` | `/api/amplify/track/:code` | None | `social/amplification.js` | Track click + redirect |
| `GET` | `/api/amplify/stats/:code` | User | `social/amplification.js` | View link click stats |
| `GET` | `/api/donation-info` | None | `donations-public.js` | Get bank details |
| `POST` | `/api/donate` | None | `donations-public.js` | Submit donation with slip upload |
| `GET` | `/api/events` | None | `events.js` | List upcoming events |
| `GET` | `/api/admin/events` | Admin | `events.js` | List all events |
| `POST` | `/api/admin/events` | Admin | `events.js` | Create event |
| `PUT` | `/api/admin/events/:id` | Admin | `events.js` | Update event |
| `DELETE` | `/api/admin/events/:id` | Admin | `events.js` | Delete event |
| `GET` | `/api/admin/proposals` | Admin | `admin-proposals-donations.js` | List all proposals |
| `POST` | `/api/admin/proposals/:id/status` | Admin | `admin-proposals-donations.js` | Update proposal status |
| `PUT` | `/api/admin/proposals/:id` | Admin | `admin-proposals-donations.js` | Edit proposal |
| `GET` | `/api/admin/donations/pending` | Admin | `admin-proposals-donations.js` | List pending donations |
| `POST` | `/api/admin/donations/:id/verify` | Admin | `admin-proposals-donations.js` | Verify donation |
| `POST` | `/api/admin/donations/:id/reject` | Admin | `admin-proposals-donations.js` | Reject donation |
| `GET` | `/api/leadership/settings` | Admin | `leadership.js` | Get leadership settings |
| `POST` | `/api/leadership/settings` | Admin | `leadership.js` | Update leadership settings |
| `GET` | `/api/leadership/positions` | Admin | `leadership.js` | List positions |
| `POST` | `/api/leadership/positions` | Admin | `leadership.js` | Create position |
| `POST` | `/api/leadership/positions/:id/toggle` | Admin | `leadership.js` | Toggle position active state |
| `DELETE` | `/api/leadership/positions/:id` | Admin | `leadership.js` | Delete position |
| `GET` | `/api/leadership/applications` | Admin | `leadership.js` | List applications |
| `POST` | `/api/leadership/applications/:id/status` | Admin | `leadership.js` | Update application status |
| `GET` | `/api/leadership/terms` | Admin | `leadership.js` | List active terms |
| `POST` | `/api/leadership/terms/:id/end` | Admin | `leadership.js` | End term |
| `GET` | `/api/leadership/sops` | Admin | `leadership.js` | List SOPs |
| `POST` | `/api/leadership/sops` | Admin | `leadership.js` | Create/update SOP |
| `GET` | `/api/leadership/appraisals` | Admin | `leadership.js` | List appraisals |
| `POST` | `/api/leadership/appraisals` | Admin | `leadership.js` | Add appraisal |
| `POST` | `/api/leadership/apply` | User | `leadership.js` | Apply for leadership position |
| `GET` | `/api/leadership/status` | None | `leadership.js` | Public leadership availability |
| `GET` | `/api/leadership/public` | None | `leadership.js` | Public leadership status |
| `GET` | `/api/leadership/positions-public` | None | `leadership.js` | Public positions list |
| `GET` | `/api/leadership/terms-public` | None | `leadership.js` | Public current leaders |
| `GET` | `/api/leadership/sops-public` | None | `leadership.js` | Public SOPs |
| `GET` | `/api/analytics/active` | None | `analytics.js` | Active visitor count |
| `POST` | `/api/analytics/heartbeat` | None | `analytics.js` | Heartbeat to track visitor |
| `POST` | `/api/generate-law-draft` | User | `legislation/ai-draft.js` | AI-assisted law drafting |

---

## 9. Configuration Principle

> **CRITICAL: No reward, points, or merit value shall ever be hardcoded.**
> Every tunable parameter must live in `DEFAULT_SETTINGS` → `system_settings` table → admin UI.
> This ensures admins can adjust the incentive system without code changes or redeploys.

The `system_settings` table stores all config as a JSON blob (`settings_json` column).
`getSettings()` merges DB values over `DEFAULT_SETTINGS`.
`POST /api/system-settings` (admin only) accepts any key and persists it.

The admin settings panel (`admin.html`) exposes all 60+ config keys as a single unified config editor (`key = value` pairs in a textarea), replacing the previous ~50 individual input fields.

---

## 10. Current Server Settings (Admin-Configurable)

All configurable at runtime via `POST /api/system-settings` (admin). Defaults in `src/config/settings.js`:

### Core Settings
| Setting | Default | Description |
|---|---|---|
| `signup_base_merit` | 50 | Merit points every signup receives |
| `merit_skills` | 250 | Points for "Skills" contribution type |
| `merit_action` | 200 | Points for "Action" contribution type |
| `merit_ideas` | 150 | Points for "Ideas" contribution type |
| `merit_donation` | 100 | Points for "Donation" contribution type |
| `donation_bonus_per_100` | 5 | Extra points per 100 MVR donated |
| `signup_random_bonus_max` | 50 | Max random bonus (0 to value-1) |
| `donation_divisor_mvr` | 100 | MVR donation divisor |
| `donation_log_multiplier` | 35 | Log formula multiplier |
| `donation_usd_mvr_rate` | 15.4 | USD-to-MVR exchange rate |
| `donation_formula` | 'log' | Donation formula: 'log' or 'flat' |
| `target_members` | 13000 | Membership goal for progress bar |
| `target_treasury` | 13000 | Treasury goal |

### Voting & Proposal Settings
| Setting | Default | Description |
|---|---|---|
| `proposal_voting_days` | 7 | How long proposals stay open |
| `proposal_cooldown_hours` | 8 | Cooldown between proposals |
| `proposal_title_max_length` | 200 | Max chars for proposal title |
| `proposal_description_max_length` | 8000 | Max chars for proposal description |
| `vote_cooldown_ms` | 3600000 | Cooldown between votes (1 hour) |
| `voting_window_primary_days` | 7 | Primary voting window (100% weight) |
| `voting_window_extended_days` | 3 | Extended voting window (50% weight) |
| `voting_weight_primary` | 1.0 | Primary window vote weight |
| `voting_weight_extended` | 0.5 | Extended window vote weight |
| `approval_threshold_routine` | 0.50 | Routine proposal threshold |
| `approval_threshold_policy` | 0.60 | Policy proposal threshold |
| `approval_threshold_constitutional` | 0.80 | Constitutional proposal threshold |

### Merit Reward Settings
| Setting | Default | Description |
|---|---|---|
| `merit_vote_pass` | 2.5 | Points for voting on passing proposal |
| `merit_vote_fail` | 1.0 | Points for voting on failing proposal |
| `merit_vote_participation` | 0.5 | Points for law vote participation |
| `merit_proposal_author` | 200 | Points for authoring passed proposal |
| `merit_proposal_created` | 10 | Points for creating a proposal |
| `merit_stake_percent` | 0.005 | Stake as fraction of MS |
| `merit_stake_min` | 10 | Minimum proposal stake |
| `merit_quality_threshold` | 0.10 | Below this = frivolous (<10%) |
| `merit_quality_refund` | 0.20 | Above this = stake refunded (≥20%) |
| `merit_decay_lambda` | 0.001267 | Base decay constant |
| `merit_half_life_days` | 547.5 | Half-life in days |

### Referral Settings
| Setting | Default | Description |
|---|---|---|
| `referral_tier1_limit` | 5 | Tier 1 max invite count |
| `referral_tier2_limit` | 20 | Tier 2 max invite count |
| `referral_base_t1` | 2 | Base reward per invite (tier 1) |
| `referral_base_t2` | 1 | Base reward per invite (tier 2) |
| `referral_base_t3` | 0.5 | Base reward per invite (tier 3) |
| `referral_engage_t1` | 8 | Engagement bonus per invite (tier 1) |
| `referral_engage_t2` | 4 | Engagement bonus per invite (tier 2) |
| `referral_engage_t3` | 0.5 | Engagement bonus per invite (tier 3) |

### Endorsement Settings
| Setting | Default | Description |
|---|---|---|
| `endorsement_tier1_limit` | 10 | Endorsements at tier 1 rate |
| `endorsement_tier2_limit` | 50 | Endorsements at tier 2 rate |
| `endorsement_tier3_limit` | 200 | Endorsements at tier 3 rate |
| `endorsement_tier1_pts` | 2.0 | Points per endorsement (1-10) |
| `endorsement_tier2_pts` | 1.0 | Points per endorsement (11-50) |
| `endorsement_tier3_pts` | 0.5 | Points per endorsement (51-200) |
| `endorsement_tier4_pts` | 0.1 | Points per endorsement (201+) |
| `endorsement_max_per_period` | 20 | Max endorsements per 30-day period |
| `endorsement_period_days` | 30 | Endorsement rate-limit window |

### Operational Settings
| Setting | Default | Description |
|---|---|---|
| `visitor_timeout_ms` | 300000 | Active visitor timeout (5 min) |
| `wall_post_max_length` | 500 | Max chars for wall posts |
| `wall_posts_limit` | 100 | Max wall posts returned |
| `recent_votes_limit` | 50 | Max recent votes returned |
| `nickname_max_length` | 50 | Max chars for nickname |
| `enroll_rate_limit_ms` | 60000 | Enrollment rate limit window |
| `enroll_max_per_day` | 50 | Max enrollments per IP per day |
| `max_upload_bytes` | 5242880 | Max file upload size (5 MB) |
| `notification_enabled` | 1 | Notification queue enabled |
| `notification_batch_interval_ms` | 300000 | Notification batch interval (5 min) |
| `notification_max_per_batch` | 3 | Max notifications per batch |
| `sms_otp_required` | 0 | Require SMS OTP for signup |
| `sms_otp_length` | 6 | OTP length |
| `sms_otp_expiry_minutes` | 10 | OTP expiry time |

---

## 11. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default 3000) | Server port |
| `ADMIN_PASSWORD` | **Yes** | Admin authentication password |
| `DIRECTORY_API_KEY` | No | External directory search API key |
| `DIRECTORY_API_HOST` | No | External directory search API host |
| `LAWS_DB_PATH` | No | Path to laws.db (auto-detected otherwise) |
| `NODE_ENV` | No | Environment (`production` enables security headers) |
| `OPENROUTER_API_KEY` | No | OpenRouter AI API key for law drafting |
| `DONATION_BANK_NAME` | No | Bank name for donations |
| `DONATION_ACCOUNT_NAME` | No | Account name for donations |
| `DONATION_ACCOUNT_NUMBER` | No | Account number for donations |

---

## 12. Key Architectural Notes

1. **server.js is a thin wiring layer.** After refactoring, `server.js` (~150 lines) only sets up Express, initializes services, mounts routes, and handles graceful shutdown. All business logic lives in `src/`.

2. **Dependency injection eliminates circular requires.** Every module under `src/` exports a factory function that receives its dependencies as an object. This pattern is used consistently for routes, services, jobs, and queries.

3. **Merit score is fully dynamic.** The `merit_events` table logs every point event. `calculateDecayedScore()` (`src/services/merit.js`) computes the full decay-weighted formula `Σ [ points * e^(-(λ_base / Lc) * days_since) ]`. `initial_merit_estimate` still serves as a historical baseline.

4. **Configuration discipline is well-established.** Nearly all reward-related numeric values are in `DEFAULT_SETTINGS` → `system_settings` → admin UI. The admin panel uses a unified textarea editor for all 60+ keys.

5. **Voting merit is awarded on proposal CLOSE, not at vote time.** `closeExpiredProposals()` runs every 60s and handles: vote point awards, proposal authoring points, and stake resolution. This is a batch processing approach rather than real-time.

6. **Three separate vote systems exist:**
   - Proposal votes (`votes` table) — merit-weighted, full reward pipeline ✅
   - Law article votes (`votes` in laws DB) — merit points for signed-in users ✅
   - Law clause votes (`sub_article_votes` in laws DB) — merit points for signed-in users ✅
   - Law-level votes (`law_level_votes` in laws DB) — merit points for signed-in users ✅

7. **The referral system's engagement bonus is now live.** The DB schema has `first_action_at` and `engagement_bonus_given` columns. `maybeEngageReferral()` triggers on merit-generating actions and awards the engagement bonus tier defined in settings.

8. **Notification queue replaces instant wall posts.** Rather than flooding the public wall, significant events (new signups, new proposals) are queued in `notification_queue` and processed in batches by `src/jobs/processNotifications.js`.

9. **Proposal cooldown only enforced for authenticated users.** Anonymous proposals bypass the 8-hour cooldown check. This is a known gap: spam proposals from unauthenticated users have no rate limit beyond the general vote cooldown.

10. **All core incentive mechanisms are coded and active.** Bounties, endorsements, staking, reputation penalties, violation sanctions, academy, stipends, quizzes, comments, amplification — all operational. The remaining work is primarily in: elections, UI polish, and advanced governance protocols (Signal Horn, Unity Warning, Círculos, Manifesto, Constitution).

---

## 13. Cross-Reference Map

| Document | Purpose |
|---|---|
| `whitepaper.txt` | Governance philosophy, phased rollout strategy, and constitutional design. The "why." |
| `blueprint.md` | Technical architecture, API reference, database schema, and system configuration. The "how." |
| `history.md` | Dated implementation log with rationale for every major change. The "when and who." |
| `REFACTORING.md` | Backend modularization plan and risk matrix. |
| `FRONTEND_REFACTOR_PLAN.md` | Frontend JS extraction plan. |
| `AGENTS.md` | Conventions for AI coding assistants working on this repo. |
