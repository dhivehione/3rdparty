# 3d Party — Project Blueprint

> **Last updated:** 2026-05-04  
> **Source spec:** `whitepaper.txt` (1018 lines, 3rd Party v14)  
> **Status key:** ✅ Implemented | ⚠️ Partial | ❌ Not Implemented | 🔮 Future Phase

---

## 1. Project Overview

**Stack:** Node.js (Express) + better-sqlite3 + vanilla JS frontend (Tailwind CSS)  
**Entry point:** `server.js` (6335 lines)  
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

## 2. The Merit Score System — Full Specification

> **Source:** whitepaper §II.C. These are the canonical values derived from agent-based simulations. They can only be changed by a constitutional vote of the full membership.

### 2.1 Master Formula

```
MS_current = Σ [ Point_event_i * e^(-(λ_base / Lc) * t_i) ]
```

| Variable | Definition |
|---|---|
| `Point_event_i` | Initial point value for a specific action `i` |
| `λ_base` | Base decay constant = `0.001267` (achieves 18-month half-life at Lc=1.0) |
| `Lc` | Loyalty Coefficient (see §2.3) |
| `t_i` | Time in days since action `i` occurred |
| `e` | Euler's number ~2.71828 |

### 2.2 Point Rewards Per Action

#### 2.2.1 Voting (`Point_event`)
| Action | Points |
|---|---|
| Vote on proposal that **fails** | 1.0 |
| Vote on proposal that **succeeds** | 2.5 |

#### 2.2.2 Proposal Authoring
| Action | Points |
|---|---|
| Author/co-author a proposal that **passes** | `200 / number_of_coauthors` |

#### 2.2.3 Bridge-Building (Compromise Bonus)
| Action | Points |
|---|---|
| Amend a failing proposal (<50% support) so it passes | 400 (fixed, one-time) |
| Stake required to attempt amendment | 20 points (forfeited if amendment fails) |

#### 2.2.4 Peer Endorsements (Community Trust)
| Endorsement # | Points Each |
|---|---|
| 1–10 | 2.0 |
| 11–50 | 1.0 |
| 51–200 | 0.5 |
| 201+ | 0.1 |

**Constraint:** Maximum 20 unique endorsements allowed per 30-day period (prevents "endorsement rings").

#### 2.2.5 Resource Contribution (Donations)
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

#### 2.2.6 Bounty System (Skill-Based Contributions)
| Tier | Description | Points |
|---|---|---|
| Tier 1 | Simple task (translation, basic research) | 20 |
| Tier 2 | Involved task (data analysis, graphic design) | 75 |
| Tier 3 | Expert task (legal draft, major report, Leadership Academy graduation) | 250 |

#### 2.2.7 Network Growth (Recruitment) — Two-Tiered
| Invite # | Base Reward | Engagement Bonus | Total Potential |
|---|---|---|---|
| 1–5 | 2 | 8 | **10** |
| 6–20 | 1 | 4 | **5** |
| 21+ | 0.5 | 0.5 | **1** |

- **Base Reward** — Awarded immediately when the invited person verifies their account (National ID + SMS).
- **Engagement Bonus** — Awarded only after the invited person completes their first merit-generating action (e.g., casts their first vote).

#### 2.2.8 Role-Based Stipends (Monthly)
| Role | Points/Month | Condition |
|---|---|---|
| Shadow Minister (Governing Council) | 150 | >80% meeting attendance, >90% vote participation |
| Standing Committee Member (Integrity, Verification) | 75 | Meet committee-specific activity quorum |
| Advisory Expert Panelist | 50 per report | Feasibility Report submitted on time, meeting quality standards |
| Policy Incubation Hub member | 50 per month | Active membership in a chartered Hub |
| Performance Bonus pool | 1,000/quarter | Discretionary, awarded by Council via public Decision Statement |
| Leadership Academy mentor | Recurring reward | For guiding new cohorts |

### 2.3 Dynamic Decay & Loyalty

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

### 2.4 Stakes & Penalties

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

#### Bridge-Building Stake
- To attempt an amendment to a failing proposal, a member stakes **20 points**.
- Forfeited if the amendment fails. Refunded + 400 bonus if successful.

#### Violation Penalties (Code of Conduct)
| Tier | Severity | Sanction |
|---|---|---|
| **Tier 1** (spam, minor incivility) | Minor | Written warning → privilege suspension + minor point penalty |
| **Tier 2** (harassment, disinfo, endorsement rings) | Serious | Significant point penalty, 30-180 day suspension, forfeiture of ill-gotten points |
| **Tier 3** (hate speech, threats, subversion) | Severe | Permanent ban, full merit score forfeiture, cooperation with law enforcement |

---

## 3. Governance Architecture (from whitepaper §II.D, §III, §VI)

### 3.1 Voting Mechanisms

| Mechanism | Use Case | Status |
|---|---|---|
| **Weighted Majority** | Binary Yes/No proposals | ✅ Implemented (`server.js:1460`) |
| **Ranked-Choice Voting (RCV)** | Leadership elections, multi-option choices | ✅ Implemented (`server.js:1607`) |

### 3.2 Tiered Approval Thresholds

| Proposal Category | Required Majority |
|---|---|
| Routine decisions | 50% + 1 weighted majority |
| Policy shifts | 60–75% |
| Constitutional amendments | 80–90% |

**Categorization process:** Proposer declares category → Council reviews → Community can challenge with "Categorization Vote."

Status: ✅ Tiered thresholds calculated in `calculateApprovalThreshold()` (`server.js:4432`). Proposal category is set on creation and threshold is stored. Categorization vote workflow not yet implemented.

### 3.3 Voting Windows (Weight Decay)

| Window | Vote Weight |
|---|---|
| Primary (Days 1–7) | 100% |
| Extended (Days 8–10) | 50% |

Status: ✅ Implemented via `calculateVoteWeight()` (`server.js:4410`). Configurable via settings.

### 3.4 Leadership Structure

#### Shadow Ministers (Governing Council)
- **Selection:** 4-stage process — Merit threshold eligibility → Public application → Live-streamed panel interview → RCV confirmation vote.
- **Term:** Maximum 2 years, mandatory annual performance review.

#### Default Leadership Roles (`server.js:892-901`)
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

### 3.5 Policy Incubation Hubs
- Long-term working groups for complex systemic issues (healthcare reform, energy plans).
- Approved by Governing Council with a public charter.
- Output: Detailed "Whitepaper" proposal voted on as a unified package.
- Members earn recurring monthly stipends for active participation.

Status: ✅ Hubs API implemented (`server.js:4984-5047`), including join, list, and monthly stipend cron (`server.js:5049-5093`).

### 3.6 The Living Legal Code
- Every national law listed on the platform, subject to continuous public audit.
- Members cast persistent Approve/Disapprove votes weighted by Merit Score.
- When approval falls below threshold (e.g., 40%), automatic "Mandatory Review Agenda" triggers Governing Council action.

Status: ⚠️ Law browsing and voting implemented via external `laws.db`. Persistent approve/disapprove tracking and auto-flagging not implemented.

### 3.7 Git-Inspired Constitution
- Living document amendable via "Merge Proposal" system.
- Members fork → modify → submit for constitutional vote.
- Clear, trackable, stable amendment process.

Status: ❌ Not implemented.

### 3.8 Emeritus Council
- Advisory body (no governing power) for institutional memory.
- Auto-invitation for: former Council members OR members in top 1% for 3+ years.
- Function: Curate Knowledge Archive, provide non-binding Advisory Opinions.

Status: ✅ Emeritus Council eligibility checking and API implemented (`server.js:4872-4939`). Runs daily cron. Knowledge Archive not yet built.

### 3.9 Signal Horn Protocol (Crisis Response)
- Council activates with 75% supermajority for a named crisis.
- Official Crisis Statement pinned to all dashboards for 12 hours.
- Can include Merit Score bounty for members who amplify the unified response.

Status: ❌ Not implemented.

### 3.10 Limits on Leadership Authority
- All significant decisions require public "Decision Statement" + weighted majority vote.
- Minimum quorum: 10% of active members.
- "Active member" = performed ≥1 merit action in last 30 days.
- Minor expenditures (≤1% of monthly budget) require transparency but no vote.

Status: ⚠️ Leadership SOPs define these rules (seeded in DB), but automated Decision Statement workflow not built.

---

## 4. Current Implementation Status

### 4.1 Authentication & Membership

| Feature | Status | Location |
|---|---|---|
| Signup (phone + NID) | ✅ | `server.js:2203` — `POST /api/signup` |
| Login (username + phone) | ✅ | `server.js:2067` — `POST /api/login` |
| Admin auth (password) | ✅ | `server.js:958-976` |
| User auth (bearer token) | ✅ | `server.js:3601-3619` |
| Unregister (admin only) | ✅ | `server.js:2419` |
| SMS OTP verification | ❌ | Specified in whitepaper §III.A, not implemented |
| Duplicate phone/NID check | ✅ | `server.js:2266` |

### 4.2 Merit Score — Reward Implementation Status

| # | Feature | Spec Points | Status | Details |
|---|---|---|---|---|
| 1 | Voting points | 1.0 / 2.5 | ✅ | Awarded when proposals close via `closeExpiredProposals()` (`server.js:143-152`). Points from configurable settings `merit_vote_pass` / `merit_vote_fail`. |
| 2 | Proposal authoring | 200/coauthors | ✅ | Awarded when proposal passes via `closeExpiredProposals()` (`server.js:155-161`). Uses setting `merit_proposal_author`. |
| 3 | Bridge-building bonus | 400 | ✅ | Awarded when an amendment proposal (`amendment_of`) passes (`server.js:133-141`). |
| 4 | Peer endorsements | 2.0→0.1 | ✅ | FULLY implemented. `peer_endorsements` table. `POST/DELETE /api/endorsements`. Diminishing returns via `calculateEndorsementPoints()` (`server.js:3621`). 20/month cap enforced. Settings: `endorsement_tier1-4_pts`, `endorsement_tier1-3_limit`. |
| 5 | Donation formula | `35*log5(USD+1)` | ⚠️ | Configurable `donation_formula` setting ('log' or 'flat'). Both signup and enroll routes use this. `donation_log_multiplier`, `donation_divisor_mvr`, `donation_usd_mvr_rate` all configurable. |
| 6 | Bounty system | 20/75/250 | ✅ | FULLY implemented. 7 endpoints (`server.js:3752-3980`). Tables: `bounties`, `bounty_claims`. Create, list, claim, approve, reject, cancel, user bounties. Merit events logged on completion. |
| 7 | Leadership Academy | 250 (Tier 3) | ✅ | FULLY implemented. `academy_modules` (5 seeded), `academy_enrollments`, `academy_graduation`. 4 endpoints (`server.js:3982-4094`): modules, enroll, complete, progress. Graduation awards 250 pts. |
| 8 | Role stipends | 150/75/50 | ✅ | Implemented via `processMonthlyStipends()` hourly cron (`server.js:547-594`). `leadership_stipends` table. Council=150, Committee=75, Advisory=50. |
| 9 | Dynamic decay | 18mo half-life | ✅ | FULLY implemented. `calculateDecayedScore()` (`server.js:4442`), `getLoyaltyCoefficient()` (`server.js:4400`), `LAMBDA_BASE=0.001267`. `GET /api/merit/score` returns both static and dynamic scores. |
| 10 | Proposal stakes | `max(10,MS*0.005)` | ✅ | FULLY implemented (`server.js:4250-4313`). `proposal_stakes` table. `POST /api/proposals/:id/stake`. Refund/forfeit processed in `processProposalStakes()`. |
| 11 | Reputation penalty | stake * ratio | ✅ | Implemented in `processProposalStakes()` (`server.js:4218-4241`). Quality ratio: `(1+failed)/(1+successful)`. Penalty = stake * ratio. |
| 12 | Knowledge Check bounty | Article quiz | ✅ | FULLY implemented (`server.js:4537-4614`). `article_quizzes`, `quiz_attempts` tables. Create, list, answer endpoints. Correct answers awarded configurable points. |
| 13 | Informed Comment reward | Community endorsements | ✅ | FULLY implemented (`server.js:4617-4694`). `article_comments`, `comment_endorsements` tables. Post, list, endorse endpoints. Comments earn points when endorsed ≥5 times. |
| 14 | Amplification bounty | Share trackable links | ✅ | FULLY implemented (`server.js:5095-5175`). `amplification_links`, `amplification_clicks` tables. Generate track codes, redirect with click tracking, stats. |
| 15 | Violation sanctions | Tier 1-3 penalties | ✅ | FULLY implemented (`server.js:4739-4839`). `violations`, `user_suspensions` tables. Report, list, resolve endpoints. Penalties: T1=-50pts, T2=-200pts+suspension, T3=-500pts+permanent ban. |
| 16 | Emeritus Council | Advisory body | ✅ | Implemented (`server.js:4872-4939`). `emiritus_council` table. Daily cron checks eligibility. `GET /api/emeritus` lists members. Knowledge Archive not yet built. |
| 17 | Hub stipend | 50 pts/month | ✅ | Implemented via `processHubStipends()` hourly cron (`server.js:5049-5093`). `hub_stipends` table. Hubs with active members receive monthly stipends. |

### 4.3 Merit Score Storage — Current State

| Aspect | Status | Notes |
|---|---|---|
| `initial_merit_estimate` in `signups` table | ✅ | Historical baseline set at signup |
| `merit_events` table | ✅ | Exists (`server.js:638-652`). All point events logged with type, points, timestamp |
| Static score calculation | ✅ | `calculateStaticScore()` — SUM of all merit_events.points |
| Dynamic (decayed) score calculation | ✅ | `calculateDecayedScore()` — full whitepaper formula with λ_base and Lc |
| Loyalty coefficient | ✅ | `getLoyaltyCoefficient()` — based on days since join |
| Leaderboard API | ✅ | `GET /api/merit/leaderboard` (`server.js:4508`) — top N by score with dynamic score |
| Merit events API | ✅ | `GET /api/merit/events` (`server.js:4488`) — paginated event history |
| Merit score API | ✅ | `GET /api/merit/score` (`server.js:4464`) — static + dynamic + loyalty tier |

### 4.4 Referral / Enrollment Status

| Feature | Status | Location |
|---|---|---|
| `getReferralPoints()` — correct tiered formula | ✅ | `server.js:2737-2750` |
| Base reward on signup (pending referral match) | ✅ | `server.js:2328-2362` |
| Base reward on direct `enroll-family-friend` | ✅ | `server.js:2994-3011` |
| Base reward for introducing existing user | ✅ | `server.js:2752-2861` |
| `POST /api/referral/introduce` | ✅ | `server.js:2752` |
| `POST /api/enroll-family-friend` | ✅ | `server.js:2863` |
| `GET /api/referrals` (list + summary) | ✅ | `server.js:3049` |
| `POST /api/referral/remove` (reverses points) | ✅ | `server.js:3099` |
| Directory search for enrollment | ✅ | `server.js:842` |
| **Engagement Bonus** (when invitee takes 1st action) | ❌ | `first_action_at` column exists, **never populated**. No trigger logic. |

### 4.5 Voting & Proposals Status

| Feature | Status | Location |
|---|---|---|
| Create proposal (8-hour cooldown enforced) | ✅ | `server.js:1388` |
| Vote on proposal (merit-weighted) | ✅ | `server.js:1460` |
| Edit proposal | ✅ | `server.js:1540` |
| Ranked choice voting | ✅ | `server.js:1607` |
| List active proposals with voting window info | ✅ | `server.js:1010` |
| Configurable voting duration (default 7 days) | ✅ | `proposal_voting_days` setting |
| Merit-weighted voting | ✅ | `calculateVoteWeight()` integrates loyalty coefficient and voting window |
| Voting window weight decay | ✅ | Configurable primary/extended windows + weights |
| Tiered approval thresholds | ✅ | `calculateApprovalThreshold()` for routine/policy/constitutional |
| Proposal staking | ✅ | `POST /api/proposals/:id/stake` |
| 8-hour proposal cooldown | ✅ | `proposal_cooldown_hours` setting, enforced for authenticated users |
| Bridge-building amendment workflow | ✅ | `amendment_of` column on proposals, 400pt bonus on passage |
| Auto-close expired proposals (merit-weighted) | ✅ | `closeExpiredProposals()` runs every 60s |
| Reputation penalty on frivolous proposals | ✅ | `processProposalStakes()` with quality ratio |

### 4.6 Laws & Legislation Status

| Feature | Status | Location |
|---|---|---|
| List/search laws, articles, clauses | ✅ | `server.js:1452-1746` |
| Vote on clause (sub-article) | ✅ | `server.js:1793` |
| Vote on article (requires signup) | ✅ | `server.js:1849` |
| Vote on entire law | ✅ | `server.js:5408` |
| Voting stats / recent / top-voted | ✅ | `server.js:1565-1650` |
| **Merit points for any law voting** | ❌ | No points awarded by law voting endpoints |
| Living Legal Code (persistent approve/disapprove) | ❌ | Spec §3.6 |
| Mandatory Review Agenda | ❌ | Auto-flag low-approval laws |

### 4.7 Leadership Status

| Feature | Status | Location |
|---|---|---|
| `leadership_positions` (8 default roles) | ✅ | `server.js:876-904` |
| `leadership_applications` + `leadership_terms` | ✅ | `server.js:907-936` |
| `leadership_settings` with merit thresholds | ✅ | `server.js:856-873` |
| Admin API for leadership management | ✅ | `server.js:5501-5748` — 8 endpoints |
| Public leadership API | ✅ | `server.js:5796-5862` — 4 endpoints |
| Leadership application UI (profile page) | ✅ | `profile.html` |
| Role-based monthly stipends (cron) | ✅ | `processMonthlyStipends()` hourly (`server.js:547`) |
| Leadership Academy (5 modules) | ✅ | `server.js:3982-4094` |
| Shadow Minister elections (RCV) | ❌ | Application/approval by admin only, no full election workflow |
| Advisory Expert Panels | ⚠️ | `advisory_reports` table + submit/approve endpoints exist; credential verification not built |
| Performance appraisals | ✅ | `leadership_appraisals` table + API |
| Leadership SOPs | ✅ | `leadership_sops` table (5 seeded) + CRUD API |
| Recall vote mechanism | ❌ | Spec §VI.D |
| Coalition Governance Protocol | ❌ | Spec §VI.E |

### 4.8 Other Features

| Feature | Status | Location |
|---|---|---|
| Public Wall (posts + threads) | ✅ | `server.js:979-1006` |
| Active visitor heartbeat/analytics | ✅ | `server.js:944-956` |
| Member count / target progress | ✅ | `server.js:2371` |
| `activity_log` (audit trail) | ✅ | `server.js:278-289` |
| Enrollment rate limiting | ✅ | `server.js:709-718` |
| File upload (multer) | ✅ | `server.js:5881-5890` |
| External directory search proxy | ✅ | `server.js:842` |
| Events management (CRUD) | ✅ | `server.js:5950-6055` |
| Donation submission with slip upload | ✅ | `server.js:5896-5947` |
| Donation verification (admin) | ✅ | `server.js:6152-6198` |
| AI law drafting (OpenRouter GPT) | ✅ | `server.js:2314-2534` — `/api/generate-law-draft` |
| Password change | ✅ | `server.js:5322` — `POST /api/user/change-password` |
| Admin proposal management | ✅ | `server.js:6059-6133` |
| Knowledge Quizzes on law articles | ✅ | `server.js:4537-4614` |
| Article comments with endorsements | ✅ | `server.js:4617-4694` |
| Amplification tracking links | ✅ | `server.js:5095-5175` |
| Live Treasury (full public ledger) | ⚠️ | Donations tracked but no public dashboard showing all transactions |
| SMS OTP verification | ❌ | Spec §III.A |
| Community Hubs (Círculos Protocol) | ❌ | Spec §V.D — Policy Hubs exist but not geographical Círculos |
| 3rd Party Media Collective | ⚠️ | Partial — quizzes, comments, amplification implemented; no dedicated media tab or Rapid Response team |
| Candidate Selection (Primary by Merit) | ❌ | Spec §VI.A Stage 2 |
| The People's Manifesto | ❌ | Spec §VI.B |
| Victories Tracker | ❌ | Spec §V.C |
| Git-Inspired Constitution | ❌ | Spec §III.A |
| Signal Horn Protocol | ❌ | Spec §IV.E |
| Unity Warning System | ❌ | Spec §IV.B |

---

## 5. Whitepaper Phased Rollout Plan

> Source: whitepaper §VIII. These are the original phases — use as reference for prioritizing development.

| Phase | Goal | Key Features | Status Today |
|---|---|---|---|
| **Phase 1** | MVP: Core democracy, first 3,000 members | NID+SMS verification, 1-person-1-vote proposals, Merit Score running in background | ⚠️ Partial (no SMS OTP, but merit engine fully active) |
| **Phase 2** | Activate weighted influence | Merit-weighted voting, RCV elections, Git-Constitution, Live Treasury | ⚠️ Most features implemented; Git-Constitution missing |
| **Phase 3** | National presence | Shadow Minister elections, Community Hubs, SMS voting | ⚠️ Leadership structure exists but elections not built; Hubs/Círculos missing |
| **Phase 4** | Full incentive design | Proposal Staking, Bridge-Building Bonus, Unity Warning System | ⚠️ Staking + Bridge-Building done; Unity Warning missing |
| **Phase 5** | Full automation | Parametric Governance Engine, AI moderation | ⚠️ Core parameter engine exists; full automation missing |
| **Phase 6** | Constitutional integration | Ratify into national law via sustained membership + policy adoption | ❌ |

---

## 6. Database Schema

### 6.1 Main Database (`data/signups.db`)

| Table | Purpose | Key Columns |
|---|---|---|
| `signups` | User accounts | `phone`, `nid`, `username`, `initial_merit_estimate`, `contribution_type`, `donation_amount`, `auth_token`, `last_login`, `password_hash` |
| `referrals` | Referral tracking | `referrer_id`, `referred_id`, `relation`, `status`, `base_reward_given`, `engagement_bonus_given`, `first_action_at` |
| `activity_log` | Audit trail | `action_type`, `user_id`, `target_id`, `details`, `ip_address`, `timestamp` |
| `wall_posts` | Public wall | `nickname`, `message`, `thread_id`, `is_approved` |
| `proposals` | Policy proposals | `title`, `description`, `category`, `status`, `yes_votes`, `no_votes`, `abstain_votes`, `created_by_user_id`, `approval_threshold`, `is_closed`, `passed`, `amendment_of` |
| `votes` | Proposal votes (merit-weighted) | `proposal_id`, `choice`, `voter_ip`, `user_id`, `vote_weight`, `loyalty_coefficient`, `days_since_created` |
| `ranked_proposals` | RCV elections | `title`, `description`, `category`, `options` (JSON) |
| `ranked_votes` | RCV ballots | `proposal_id`, `ranking` (JSON), `voter_ip` |
| `system_settings` | Runtime config (JSON blob) | `settings_json`, `updated_at` |
| `merit_events` | Every point-earning action | `user_id`, `event_type`, `points`, `reference_id`, `reference_type`, `description`, `created_at` |
| `peer_endorsements` | Peer-to-peer endorsements | `endorser_id`, `endorsed_id`, `created_at`, `expires_at` |
| `bounties` | Bounty board tasks | `title`, `description`, `tier` (1/2/3), `reward_points`, `posted_by_user_id`, `assigned_to_user_id`, `status` |
| `bounty_claims` | Bounty claim submissions | `bounty_id`, `user_id`, `proof`, `status`, `reviewed_by_user_id`, `reviewed_at` |
| `academy_modules` | Leadership Academy curriculum | `title`, `description`, `order_index`, `is_active` |
| `academy_enrollments` | Academy enrollment tracking | `user_id`, `module_id`, `status` (enrolled/in_progress/completed), `enrolled_at`, `completed_at` |
| `academy_graduation` | Academy graduates | `user_id`, `graduated_at`, `merit_awarded`, `mentor_id` |
| `donations` | Donation tracking (two tables — see below) | `user_id`, `phone`, `nid`, `amount`, `slip_filename`, `remarks`, `status`, `verified_by`, `verified_at` |
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

> **Note:** There are two `donations` tables in code. The first (line ~410) tracks merit points from donations (`amount_usd`, `amount_mvr`, `merit_points_awarded`). The second (line ~777) tracks verified donation submissions (`amount`, `slip_filename`, `status`, `verified_by`). These serve different purposes but share a name, which is a potential source of confusion.

### 6.2 External Database (`laws.db` from mvlaws)

| Table | Purpose |
|---|---|
| `laws` | All Maldivian laws with categories |
| `articles` | Law articles |
| `sub_articles` | Clauses within articles |
| `sub_article_votes` | Clause-level votes (linked via `user_phone`) |
| `law_votes` (in main DB) | Article-level votes (linked via `user_phone`) |
| `law_level_votes` (in laws DB) | Law-level votes |

### 6.3 Needed Tables (Not Yet Created)

| Table | Purpose | Blocked by |
|---|---|---|
| *(no tables documented in 4.3 Implementation Status Audit remain uncreated — all tables listed in prior blueprint versions now exist)* |

---

## 7. Misleading Frontend Elements (Needs Fixing)

The frontend displays reward information that is not fully backed by server logic. Status updated from prior audit:

| Element | Location | What It Says | Reality | Status |
|---|---|---|---|---|
| Clause vote points | `profile.html:207` | "+2.5 pts each" | Law votes still award **zero points** | ❌ Still misleading |
| Article vote points | `profile.html:212` | "+2.5 pts each" | Law votes still award **zero points** | ❌ Still misleading |
| Voting earns points | `how.html:100` | "earn points by voting on proposals" | ✅ Now implemented | ✅ Fixed |
| Bounty board | `how.html:100`, `faq.html:113-117` | References bounty tasks | ✅ Now implemented | ✅ Fixed |
| Bridge-building bonus | `faq.html:165` | "400-point Merit Bonus" | ✅ Now implemented | ✅ Fixed |
| Reputation penalty | `faq.html:153` | Describes penalty system | ✅ Now implemented | ✅ Fixed |
| Engagement bonus | `profile.html:246`, `enroll.html:40` | "earn points when they take their first action" | `first_action_at` never set | ❌ Still misleading |

---

## 8. Development Roadmap (Updated)

### Phase 1 — Already Complete ✅

1. ✅ De-hardcoded all reward values into `DEFAULT_SETTINGS` → `system_settings` → admin UI
2. ✅ Wired up voting merit points in `closeExpiredProposals()`
3. ✅ Configurable settings for all referral, endorsement, voting, decay, staking values
4. ✅ `merit_events` table for dynamic score tracking
5. ✅ Dynamic decay score engine (`calculateDecayedScore()`)
6. ✅ Loyalty coefficient (`getLoyaltyCoefficient()`)
7. ✅ Proposal authoring points on passage
8. ✅ Leaderboard API
9. ✅ Merit events API
10. ✅ Merit score API (static + dynamic)

### Phase 1 (Remaining) — Fix What's Broken

1. ~~**Wire up law voting merit points**~~ ✅ Done (2026-05-04)
2. ~~**Remove or update misleading frontend copy**~~ ✅ Done (2026-05-04)
3. ~~**Implement engagement bonus**~~ ✅ Done (2026-05-04)

### Phase 2 — Governance Deepening

4. Implement Shadow Minister elections via RCV — **DEFERRED** (will do later)
5. Implement Decision Statement workflow for leadership actions — **DEFERRED**
6. Implement Living Legal Code — persistent approve/disapprove tracking with auto-flag threshold — **DEFERRED**
7. Implement Mandatory Review Agenda for low-approval laws — **DEFERRED** (will do later)
8. Implement Unity Warning System
9. Build full Círculos Protocol (geographical Community Hubs) — **DEFERRED** (will do later)
10. Implement Git-Inspired Constitution — **DEFERRED** (will do later)

### Phase 3 — Advanced Features

11. SMS OTP verification — **IN PROGRESS** (2026-05-04)
12. Live Treasury public dashboard — **DEFERRED** (will do later)
13. Candidate Selection (Primary by Merit)
14. The People's Manifesto — **DEFERRED** (will do later)
15. Signal Horn Protocol for crisis response — **DEFERRED** (will do later)
16. Recall Vote mechanism
17. Coalition Governance Protocol — **DEFERRED** (will do later)
18. 3rd Party Media Collective (dedicated Media tab, Rapid Response, Policy Explainers) — **DEFERRED** (will do later)

### Phase 4 — Real-World Integration

19. AI-assisted moderation and automated dispute resolution (Parametric Governance Engine v2)
20. Victories Tracker
21. Council of Mediators
22. Felony Clause integration

---

## 9. Frontend Pages

| Page | File | Description |
|---|---|---|
| Home / Landing | `index.html` | Explains movement, shows merit score demo calculator |
| Join / Signup | `join.html` | Registration form with contribution type selection |
| Join Success | `join-success.html` | Post-registration page, promotes enrollment |
| Login | `join.html` (shared) | Username + phone login |
| Profile | `profile.html` | Scores card, proposals, enrollment UI, leadership application |
| Proposals & Voting | `proposals.html` | Binary + ranked choice proposal create/vote UI |
| Laws & Legislation | `laws.html` | Browse/search Maldivian laws, vote on clauses/articles |
| Law Stats | `law-stats.html` | Voting statistics |
| Generate Law | `generate-law.html` | AI-assisted law drafting |
| Enroll | `enroll.html` | Standalone enrollment page for family/friends |
| Wall | `wall.html` | Public message board |
| Events | `events.html` | Movement events listing |
| FAQ | `faq.html` | Frequently asked questions |
| How It Works | `how.html` | Explains how the platform functions |
| Legislature | `legislature.html` | Legislative information |
| Leadership | `leadership.html` | Leadership roster and roles |
| Policies | `policies.html` | Policy platform |
| Donate | `donate.html` | Donation page with bank details |
| Admin Dashboard | `admin.html` | System settings, user management, leadership management, donations, proposals |
| Whitepaper | `whitepaper.html` | Rendered whitepaper viewer |
| Navigation (shared) | `nav.js` | Inject navbar into all pages |

---

## 10. Key API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/signup` | None | Register new user, calc merit, match pending referrals |
| `POST` | `/api/login` | None | Login with username + phone |
| `GET` | `/api/user/profile` | User | Get profile + vote counts |
| `PUT` | `/api/user/profile` | User | Update username/name/email/island |
| `POST` | `/api/user/change-password` | User | Change password |
| `GET` | `/api/user/activity-log` | User | User's activity audit trail |
| `GET` | `/api/user/proposals` | User | User's proposals/drafts |
| `GET` | `/api/user/bounties` | User | User's posted/claimed bounties |
| `POST` | `/api/referral/introduce` | User | Create pending/active referral for new or existing person |
| `POST` | `/api/enroll-family-friend` | User | Directly enroll someone + award base points |
| `GET` | `/api/referrals` | User | List referrals + base/engagement/total point summary |
| `POST` | `/api/referral/remove` | User | Remove referral, reverse awarded points |
| `POST` | `/api/enroll/lookup` | User | Search external directory for people to enroll |
| `GET` | `/api/proposals` | None | List active proposals with voting window info |
| `POST` | `/api/proposals` | Optional | Create proposal (8h cooldown for auth users) |
| `POST` | `/api/proposals/:id/stake` | User | Stake points on proposal |
| `GET` | `/api/proposals/:id/stake` | None | View stakes on proposal |
| `POST` | `/api/vote` | None | Vote on proposal (merit-weighted) |
| `POST` | `/api/ranked-vote` | User | Submit ranked-choice ballot |
| `PATCH` | `/api/proposals/:id` | None | Edit proposal title/description |
| `GET` | `/api/proposal-stats` | None | Proposal engagement stats |
| `GET` | `/api/mvlaws` | None | List all laws with categories |
| `GET` | `/api/mvlaws/search` | None | Search laws, articles, clauses |
| `GET` | `/api/mvlaws/stats` | None | Voting statistics |
| `GET` | `/api/mvlaws/:id` | None | Law detail with articles |
| `GET` | `/api/mvlaws/:id/articles/:articleId` | None | Article detail with sub-articles |
| `POST` | `/api/mvlaws/vote-subarticle` | None | Vote on a clause |
| `POST` | `/api/mvlaws/vote` | User | Vote on an article |
| `POST` | `/api/mvlaws/vote-law` | User | Vote on entire law |
| `GET` | `/api/wall` | None | Get wall posts |
| `POST` | `/api/wall` | None | Create wall post |
| `GET` | `/api/wall-stats` | None | Wall statistics |
| `POST` | `/api/unregister` | Admin | Remove user from platform |
| `GET` | `/api/system-settings` | Admin | Get current system settings |
| `POST` | `/api/system-settings` | Admin | Update system settings (merit values, limits, etc.) |
| `GET` | `/api/public-settings` | None | Public settings (member count, targets) |
| `GET` | `/api/merit/score` | User | Dynamic + static merit score + loyalty tier |
| `GET` | `/api/merit/events` | User | Paginated merit event history |
| `GET` | `/api/merit/leaderboard` | None | Top N members by score |
| `POST` | `/api/endorsements` | User | Endorse another member (diminishing returns, 20/mo cap) |
| `DELETE` | `/api/endorsements/:id` | User | Remove endorsement |
| `GET` | `/api/endorsements/received` | User | List endorsements received |
| `POST` | `/api/bounties` | User | Create bounty (Tier 1/2/3) |
| `GET` | `/api/bounties` | None | List bounties (filterable) |
| `GET` | `/api/bounties/:id` | None | Bounty detail + claims |
| `POST` | `/api/bounties/:id/claim` | User | Claim a bounty |
| `POST` | `/api/bounties/:id/approve` | User | Approve claim (awards points) |
| `POST` | `/api/bounties/:id/reject` | User | Reject claim |
| `POST` | `/api/bounties/:id/cancel` | User | Cancel own bounty |
| `GET` | `/api/academy/modules` | None | List academy modules |
| `POST` | `/api/academy/enroll` | User | Enroll in module |
| `POST` | `/api/academy/complete` | User | Complete module (graduation check) |
| `GET` | `/api/academy/progress` | User | Academy progress |
| `GET` | `/api/stipends` | User | List leadership stipends received |
| `POST` | `/api/advisory-reports` | User | Submit advisory report |
| `GET` | `/api/advisory-reports` | User | List own reports |
| `POST` | `/api/advisory-reports/:id/approve` | User | Approve report (awards points) |
| `POST` | `/api/quizzes` | User | Create knowledge check quiz |
| `GET` | `/api/quizzes/:articleId` | None | Get quizzes for article |
| `POST` | `/api/quizzes/:id/answer` | User | Answer quiz (awards points if correct) |
| `POST` | `/api/comments` | User | Post article comment |
| `GET` | `/api/comments/:articleId` | None | Get comments for article |
| `POST` | `/api/comments/:id/endorse` | User | Endorse comment (awards commenter points) |
| `POST` | `/api/violations/report` | User | Report violation |
| `GET` | `/api/violations` | User | List violations (own or all if admin) |
| `POST` | `/api/violations/:id/resolve` | User | Resolve violation (apply penalties) |
| `GET` | `/api/suspensions/active` | None | List active suspensions |
| `GET` | `/api/emeritus` | None | List Emeritus Council members |
| `POST` | `/api/hubs` | User | Create Policy Incubation Hub |
| `GET` | `/api/hubs` | None | List active hubs |
| `POST` | `/api/hubs/:id/join` | User | Join a hub |
| `POST` | `/api/amplify` | User | Create amplifiable tracking link |
| `GET` | `/api/amplify/track/:code` | None | Track click + redirect |
| `GET` | `/api/amplify/stats/:code` | User | View link click stats |
| `GET` | `/api/donation-info` | None | Get bank details |
| `POST` | `/api/donate` | None | Submit donation with slip upload |
| `GET` | `/api/events` | None | List upcoming events |
| `GET` | `/api/admin/events` | Admin | List all events |
| `POST` | `/api/admin/events` | Admin | Create event |
| `PUT` | `/api/admin/events/:id` | Admin | Update event |
| `DELETE` | `/api/admin/events/:id` | Admin | Delete event |
| `GET` | `/api/admin/proposals` | Admin | List all proposals |
| `POST` | `/api/admin/proposals/:id/status` | Admin | Update proposal status |
| `PUT` | `/api/admin/proposals/:id` | Admin | Edit proposal |
| `GET` | `/api/admin/donations/pending` | Admin | List pending donations |
| `POST` | `/api/admin/donations/:id/verify` | Admin | Verify donation |
| `POST` | `/api/admin/donations/:id/reject` | Admin | Reject donation |
| `GET` | `/api/leadership/settings` | Admin | Get leadership settings |
| `POST` | `/api/leadership/settings` | Admin | Update leadership settings |
| `GET` | `/api/leadership/positions` | Admin | List positions |
| `POST` | `/api/leadership/positions` | Admin | Create position |
| `GET` | `/api/leadership/applications` | Admin | List applications |
| `POST` | `/api/leadership/applications/:id/status` | Admin | Update application status |
| `GET` | `/api/leadership/terms` | Admin | List active terms |
| `POST` | `/api/leadership/terms/:id/end` | Admin | End term |
| `GET` | `/api/leadership/sops` | Admin | List SOPs |
| `POST` | `/api/leadership/sops` | Admin | Create/update SOP |
| `POST` | `/api/leadership/appraisals` | Admin | Add appraisal |
| `POST` | `/api/leadership/apply` | User | Apply for leadership position |
| `GET` | `/api/leadership/status` | None | Public leadership availability |
| `GET` | `/api/leadership/public` | None | Public leadership status |
| `GET` | `/api/leadership/positions-public` | None | Public positions list |
| `GET` | `/api/leadership/terms-public` | None | Public current leaders |
| `GET` | `/api/leadership/sops-public` | None | Public SOPs |
| `GET` | `/api/analytics/active` | None | Active visitor count |
| `POST` | `/api/analytics/heartbeat` | None | Heartbeat to track visitor |

---

## 11. Configuration Principle

> **CRITICAL: No reward, points, or merit value shall ever be hardcoded.**
> Every tunable parameter must live in `DEFAULT_SETTINGS` → `system_settings` table → admin UI.
> This ensures admins can adjust the incentive system without code changes or redeploys.

The `system_settings` table stores all config as a JSON blob (`settings_json` column).
`getSettings()` merges DB values over `DEFAULT_SETTINGS`.
`POST /api/system-settings` (admin only) accepts any key and persists it.

---

## 12. Current Server Settings (Admin-Configurable)

All configurable at runtime via `POST /api/system-settings` (admin). Defaults in `server.js:13-62`:

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
| `merit_proposal_author` | 200 | Points for authoring passed proposal |
| `merit_bridge_building` | 400 | Points for bridge-building amendment |
| `merit_stake_percent` | 0.005 | Stake as fraction of MS |
| `merit_stake_min` | 10 | Minimum proposal stake |
| `merit_quality_threshold` | 0.10 | Below this = frivolous (<10%) |
| `merit_quality_refund` | 0.20 | Above this = stake refunded (≥20%) |
| `merit_bridge_stake` | 20 | Stake to attempt bridge-building amendment |
| `merit_decay_lambda` | 0.001267 | Base decay constant |

These merit values are defined in `DEFAULT_SETTINGS` but are NOT in admin UI. They were added preemptively for use by the merit engine but the admin UI (`admin.html`) has not been updated to expose them.

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

---

## 13. Admin UI Gaps

The admin settings panel (`admin.html`) currently exposes ~19 fields. The `DEFAULT_SETTINGS` object in server.js defines 60+ keys. The following are defined in `DEFAULT_SETTINGS` but NOT yet exposed in the admin UI:

**Voting & Proposal Merit:** `merit_vote_pass`, `merit_vote_fail`, `merit_proposal_author`, `merit_bridge_building`, `merit_stake_percent`, `merit_stake_min`, `merit_quality_threshold`, `merit_quality_refund`, `merit_bridge_stake`, `merit_decay_lambda`, `approval_threshold_routine`, `approval_threshold_policy`, `approval_threshold_constitutional`, `voting_window_primary_days`, `voting_window_extended_days`, `voting_weight_primary`, `voting_weight_extended`, `proposal_cooldown_hours`

**Referral:** `referral_tier1_limit`, `referral_tier2_limit`, `referral_base_t1`, `referral_base_t2`, `referral_base_t3`, `referral_engage_t1`, `referral_engage_t2`, `referral_engage_t3`

**Signup/Donation:** `signup_random_bonus_max`, `donation_divisor_mvr`, `donation_log_multiplier`, `donation_usd_mvr_rate`, `donation_formula`

**Endorsement:** `endorsement_tier1_limit`, `endorsement_tier2_limit`, `endorsement_tier3_limit`, `endorsement_tier1_pts`, `endorsement_tier2_pts`, `endorsement_tier3_pts`, `endorsement_tier4_pts`

**Meta:** `wall_posts_limit`, `recent_votes_limit`

---

## 14. Environment Variables

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

## 15. Key Architectural Notes

1. **Merit score is fully dynamic.** The `merit_events` table logs every point event. `calculateDecayedScore()` (`server.js:4442`) computes the full decay-weighted formula `Σ [ points * e^(-(λ_base / Lc) * days_since) ]`. `initial_merit_estimate` still serves as a historical baseline.

2. **Configuration discipline is well-established.** Nearly all reward-related numeric values are in `DEFAULT_SETTINGS` → `system_settings` → admin UI. However, ~35 config keys exist in `DEFAULT_SETTINGS` that are NOT yet exposed in the admin UI (see §13).

3. **Voting merit is awarded on proposal CLOSE, not at vote time.** `closeExpiredProposals()` (`server.js:102-169`) runs every 60s and handles: vote point awards, proposal authoring points, bridge-building bonus, and stake resolution. This is a batch processing approach rather than real-time.

4. **Three separate vote systems exist, two without merit rewards:**
   - Proposal votes (`votes` table) — merit-weighted, full reward pipeline ✅
   - Law article votes (`law_votes` in main DB, `sub_article_votes` in laws DB) — no merit ❌
   - Law-level votes (`law_level_votes` in laws DB) — no merit ❌

5. **The referral system's engagement bonus is "almost there."** The DB schema has `first_action_at` and `engagement_bonus_given` columns. The `getReferralPoints()` function handles engagement bonus tiers. The only missing piece: no code sets `first_action_at` when a referred user performs any action.

6. **Two `donations` tables exist in code.** The first (line ~410) is for merit-point tracking (`amount_usd`, `merit_points_awarded`). The second (line ~777) is for donation submission verification (`amount`, `slip_filename`, `status`, `verified_by`). These share a table name and could cause confusion.

7. **Loyalty coefficient derivation is inverted from spec but functionally equivalent.** Whitepaper says Founding=1.5, Early=1.2, Standard=1.0. Code implements: `<180 days = 1.0 (standard), <365 days = 1.2 (early), >=365 days = 1.5 (founding)`. Since "founding members" joined earliest, the code correctly assigns higher Lc to longer-tenured members. However, this means all members eventually graduate to Lc=1.5 after 1 year, not just the first 3,000.

8. **Proposal cooldown only enforced for authenticated users.** Anonymous proposals bypass the 8-hour cooldown check. This is a gap: spam proposals from unauthenticated users have no rate limit beyond the general vote cooldown.

9. **Frontend references whitepaper features liberally.** `profile.html` and `enroll.html` still describe engagement bonuses as active when they're not (first_action_at never set). Law voting point claims in `profile.html` are still unfounded.

10. **All core incentive mechanisms coded and active.** Bounties, endorsements, staking, bridge-building, reputation penalties, violation sanctions, academy, stipends, quizzes, comments, amplification — all operational. The remaining work is primarily in: law vote points, engagement bonuses, elections, UI polish, and advanced governance protocols (Signal Horn, Unity Warning, Círculos, Manifesto, Constitution).

---

## 16. What Was Planned But Not Implemented (True Gaps)

| Whitepaper Feature | § | Priority |
|---|---|---|
| SMS OTP verification | III.A | High |
| Law voting merit points (all 3 levels) | II.C.1 | High |
| Engagement bonus for referrals | II.C.7.b | High |
| Shadow Minister elections via RCV | III.C | Medium |
| Git-Inspired Constitution | III.A | Medium |
| Living Legal Code (persistent approve/disapprove + Mandatory Review) | III.D | Medium |
| Live Treasury public dashboard | V.B | Medium |
| Signal Horn Protocol | IV.E | Medium |
| Unity Warning System (flag divisive proposals) | IV.B | Medium |
| Community Hubs (Círculos Protocol) | V.D | Medium |
| Candidate Selection (Primary by Merit) | VI.A Stage 2 | Low |
| The People's Manifesto | VI.B | Low |
| Recall Vote mechanism | VI.D | Low |
| Coalition Governance Protocol | VI.E | Low |
| Council of Mediators | IX.G | Low |
| Felony Clause | IX.E | Low |
| Victories Tracker | V.C | Low |
| 3rd Party Media Collective (full) | V.E | Low |
| Full Parametric Governance Engine (AI moderation) | III.F / Phase 5 | Low |

---

## 17. What Is Implemented But Not Documented In Prior Blueprint

These features were built since the last blueprint audit and are now fully operational:

| Feature | Location | Notes |
|---|---|---|
| merit_events table + full event logging | `server.js:638-652` | Every point action logged with type, points, timestamp |
| Dynamic decay score engine | `server.js:4442-4457` | `calculateDecayedScore()` — full whitepaper formula |
| Loyalty coefficient | `server.js:4400-4408` | `getLoyaltyCoefficient()` — join-date-based tiers |
| Merit score API (static + dynamic) | `server.js:4464-4486` | `GET /api/merit/score` |
| Merit leaderboard | `server.js:4508-4534` | `GET /api/merit/leaderboard` — top N with dynamic scores |
| Merit events API | `server.js:4488-4506` | `GET /api/merit/events` — paginated event history |
| Peer endorsements (full CRUD) | `server.js:3630-3760` | Diminishing returns, 20/month cap, settings-driven |
| Bounty system (7 endpoints) | `server.js:3752-3980` | Create, list, claim, approve, reject, cancel, user list |
| Leadership Academy (5 modules) | `server.js:3982-4094` | Enroll, complete, progress, graduation = 250 pts |
| Role-based monthly stipends | `server.js:547-594` | `processMonthlyStipends()` hourly cron |
| Advisory reports (submit + approve) | `server.js:4115-4180` | Expert panel reports with point awards |
| Proposal staking | `server.js:4256-4313` | `max(10, MS*0.005)`, refund/forfeit logic |
| Reputation penalty engine | `server.js:4198-4248` | Quality ratio = `(1+failed)/(1+successful)` |
| Bridge-building bonus | `server.js:133-141` | 400 pts when amendment proposal passes |
| Voting merit (on close) | `server.js:143-161` | Configurable pass/fail points, author points |
| Knowledge Check quizzes | `server.js:4537-4614` | Create, list, answer — award points for correct answers |
| Article comments + endorsements | `server.js:4617-4694` | Comment, list, endorse — earn points when endorsed |
| Amplification tracking links | `server.js:5095-5175` | Generate track codes, click tracking, stats |
| Violation reporting + sanctions | `server.js:4739-4839` | Report, list, resolve with tiered penalties + suspensions |
| Emeritus Council eligibility | `server.js:4872-4939` | Daily cron, auto-invite, API |
| Policy Incubation Hubs | `server.js:4984-5047` | Create, join, list hubs |
| Hub stipends (monthly cron) | `server.js:5049-5093` | 50 pts/month per hub member |
| Events management (CRUD) | `server.js:5950-6055` | Create, update, delete events (admin) |
| Donation submission + verification | `server.js:5896-6198` | Slip upload, admin verify/reject |
| Password change | `server.js:5322-5359` | `POST /api/user/change-password` |
| Admin proposal management | `server.js:6059-6133` | Status changes, full edit |
| Leadership SOPs (5 seeded) | `server.js:954-981` | Daily Management, Meeting Protocol, Financial Oversight, etc. |
| Leadership appraisals | `server.js:939-952` | 1-5 rating, strengths, improvements, feedback |
| activity_log audit trail | `server.js:374-386` | All significant actions logged with IP, user agent |
| Configurable donation formula | `server.js:38` | `donation_formula: 'log'` — switchable log vs flat |
| 8-hour proposal cooldown | `server.js:1401-1418` | `proposal_cooldown_hours` setting |
