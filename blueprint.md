# 3d Party — Project Blueprint

> **Last updated:** 2026-05-04  
> **Source spec:** `whitepaper.txt` (1018 lines, Dhivehi Youth Movement v14)  
> **Status key:** ✅ Implemented | ⚠️ Partial | ❌ Not Implemented | 🔮 Future Phase

---

## 1. Project Overview

**Stack:** Node.js (Express) + better-sqlite3 + vanilla JS frontend (Tailwind CSS)  
**Entry point:** `server.js` (4368 lines)  
**Database:** SQLite (`data/3rdparty.db`), external `laws.db` from mvlaws project  
**Specification:** Dhivehi Youth Movement v14 whitepaper — a platform merging direct democracy with merit-based incentives, dynamic governance, and anti-schism safeguards.

### 1.1 Core Principles (from whitepaper §II)

- **Empowered Participation** — Every verified citizen can vote, propose policies, and participate. Access via digital + offline channels (SMS voting, Community Hubs).
- **Policy Proposals & Public Referendum** — The primary engine of governance. Citizens draft ideas that go through submission → staking → public referendum → enactment.
- **Merit-Based Influence** — Universal right to participate, variable influence earned through constructive actions.
- **Dynamic Governance** — Contextual voting mechanisms (weighted majority, ranked choice), tiered approval thresholds based on proposal impact.
- **Absolute Transparency** — Verifiable anonymity: aggregate results are public, individual votes are private.

### 1.2 Project Terminology

| Term | Meaning |
|---|---|
| DYM | Dhivehi Youth Movement |
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
| Policy Incubation Hub member | Monthly stipend | Conditional on meeting charter-based activity targets |
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
| **Weighted Majority** | Binary Yes/No proposals | ❌ Currently one-person-one-vote |
| **Ranked-Choice Voting (RCV)** | Leadership elections, multi-option choices | ✅ `POST /api/ranked-vote` (line 1324) |

### 3.2 Tiered Approval Thresholds

| Proposal Category | Required Majority |
|---|---|
| Routine decisions | 50% + 1 weighted majority |
| Policy shifts | 60–75% |
| Constitutional amendments | 80–90% |

**Categorization process:** Proposer declares category → Council reviews → Community can challenge with "Categorization Vote."

### 3.3 Voting Windows (Weight Decay)

| Window | Vote Weight |
|---|---|
| Primary (Days 1–7) | 100% |
| Extended (Days 8–10) | 50% |

### 3.4 Leadership Structure

#### Shadow Ministers (Governing Council)
- **Selection:** 4-stage process — Merit threshold eligibility → Public application → Live-streamed panel interview → RCV confirmation vote.
- **Term:** Maximum 2 years, mandatory annual performance review.

#### Default Leadership Roles (`server.js:553-562`)
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

### 3.6 The Living Legal Code
- Every national law listed on the platform, subject to continuous public audit.
- Members cast persistent Approve/Disapprove votes weighted by Merit Score.
- When approval falls below threshold (e.g., 40%), automatic "Mandatory Review Agenda" triggers Governing Council action.

### 3.7 Git-Inspired Constitution
- Living document amendable via "Merge Proposal" system.
- Members fork → modify → submit for constitutional vote.
- Clear, trackable, stable amendment process.

### 3.8 Emeritus Council
- Advisory body (no governing power) for institutional memory.
- Auto-invitation for: former Council members OR members in top 1% for 3+ years.
- Function: Curate Knowledge Archive, provide non-binding Advisory Opinions.

### 3.9 Signal Horn Protocol (Crisis Response)
- Council activates with 75% supermajority for a named crisis.
- Official Crisis Statement pinned to all dashboards for 12 hours.
- Can include Merit Score bounty for members who amplify the unified response.

### 3.10 Limits on Leadership Authority
- All significant decisions require public "Decision Statement" + weighted majority vote.
- Minimum quorum: 10% of active members.
- "Active member" = performed ≥1 merit action in last 30 days.
- Minor expenditures (≤1% of monthly budget) require transparency but no vote.

---

## 4. Current Implementation Status

### 4.1 Authentication & Membership

| Feature | Status | Location |
|---|---|---|
| Signup (phone + NID) | ✅ | `server.js:2203` — `POST /api/signup` |
| Login (username + phone) | ✅ | `server.js:2067` — `POST /api/login` |
| Admin auth (password) | ✅ | `server.js:958-976` |
| User auth (bearer token) | ✅ | `server.js:3181-3208` |
| Unregister (admin only) | ✅ | `server.js:2419` |
| SMS OTP verification | ❌ | Specified, not implemented |
| Duplicate phone/NID check | ✅ | `server.js:2266` |

### 4.2 Merit Score — Reward Implementation Status

| # | Feature | Spec Points | Status | Details |
|---|---|---|---|---|
| 1 | Voting points | 1.0 / 2.5 | ❌ | `POST /api/vote` (line 1092) records votes, awards nothing |
| 2 | Proposal authoring | 200/coauthors | ❌ | `POST /api/proposals` (line 1038) creates, no merit |
| 3 | Bridge-building bonus | 400 | ❌ | No amendment workflow exists |
| 4 | Peer endorsements | 2.0→0.1 | ❌ | No endorsement table/API |
| 5 | Donation formula | `35*log5(USD+1)` | ❌ | Flat `donation_bonus_per_100=5` per 100 MVR (line 2299) |
| 6 | Bounty system | 20/75/250 | ❌ | No bounty DB/API/UI |
| 7 | Leadership Academy | Tier 3 bounty | ❌ | No academy module |
| 8 | Role stipends | 150/75/50 | ❌ | `leadership_positions` table exists; no stipend logic |
| 9 | Dynamic decay | 18mo half-life | ❌ | Only static `initial_merit_estimate` stored |
| 10 | Proposal stakes | `max(10,MS*0.005)` | ❌ | No staking logic |
| 11 | Reputation penalty | stake * ratio | ❌ | No penalty logic |
| 12 | Knowledge Check bounty | Article quiz | ❌ | No media module |
| 13 | Informed Comment reward | Community endorsements | ❌ | No comment system |
| 14 | Amplification bounty | Share trackable links | ❌ | Not implemented |
| 15 | Violation sanctions | Tier 1-3 penalties | ❌ | Disciplinary framework not coded |
| 16 | Emeritus Council | Advisory body | ❌ | Not implemented |
| 17 | Hub stipend | Monthly points | ❌ | Not implemented |

### 4.3 Merit Score Storage — Current State

| Aspect | Status |
|---|---|
| `initial_merit_estimate` in `signups` table | ✅ |
| Static — never recalculated after signup | ⚠️ |
| Updated only by: referral base rewards (+), referral removals (-) | ⚠️ |
| No `merit_events` table (needed for dynamic decay calc) | ❌ |
| No leaderboard/ranking API | ❌ |

**Current merit score calculation (on signup):**
```
base(50) + skills(250) + action(200) + ideas(150) + donation(100) + random(0-49) + floor(donation_amount/100)*5
```
All component values are admin-configurable at runtime via `POST /api/system-settings`.

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
| **Engagement Bonus** (when invitee takes 1st action) | ❌ | `first_action_at` column exists (line 266), **never populated**. No trigger logic anywhere. |

### 4.5 Voting & Proposals Status

| Feature | Status | Location |
|---|---|---|
| Create proposal (demo — no signup required) | ✅ | `server.js:1038` |
| Vote on proposal (demo — no signup required) | ✅ | `server.js:1092` |
| Edit proposal | ✅ | `server.js:1139` |
| Ranked choice voting | ✅ | `server.js:1324` |
| List active proposals | ✅ | `server.js:1010` |
| Configurable voting duration (default 7 days) | ✅ | `proposal_voting_days` setting |
| Merit-weighted voting | ❌ | One-person-one-vote only |
| Voting window weight decay | ❌ | Spec §3.3 |
| Tiered approval thresholds | ❌ | Spec §3.2 |
| Proposal staking | ❌ | Spec §2.4 |
| 8-hour proposal cooldown | ❌ | Spec §II.B |
| Bridge-building amendment workflow | ❌ | Spec §2.2.3 |

### 4.6 Laws & Legislation Status

| Feature | Status | Location |
|---|---|---|
| List/search laws, articles, clauses | ✅ | `server.js:1452-1746` |
| Vote on clause (sub-article) | ✅ | `server.js:1793` |
| Vote on article (requires signup) | ✅ | `server.js:1849` |
| Vote on entire law | ✅ | `server.js:3441` |
| Voting stats / recent / top-voted | ✅ | `server.js:1565-1650` |
| **Merit points for any law voting** | ❌ | Zero points awarded by any law voting endpoint |
| Living Legal Code (persistent approve/disapprove) | ❌ | Spec §3.6 |
| Mandatory Review Agenda | ❌ | Auto-flag low-approval laws |

### 4.7 Leadership Status

| Feature | Status | Location |
|---|---|---|
| `leadership_positions` (8 default roles) | ✅ | `server.js:537-565` |
| `leadership_applications` + `leadership_terms` | ✅ | `server.js:568-590` |
| `leadership_settings` with merit thresholds | ✅ | `server.js:517-534` |
| Admin API for leadership management | ✅ | `server.js:3599-3870` |
| Leadership application UI (profile page) | ✅ | `profile.html:398-935` |
| Role-based monthly stipends | ❌ | No cron/stipend logic |
| Leadership Academy | ❌ | No academy module |
| Shadow Minister elections (RCV) | ❌ | Position definitions exist, no election workflow |
| Advisory Expert Panels | ❌ | No credential verification |
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
| File upload (multer) | ✅ | `server.js` config |
| External directory search proxy | ✅ | `server.js:842` |
| Live Treasury | ❌ | No donation verification or public ledger |
| SMS OTP verification | ❌ | Spec §III.A |
| Community Hubs (Círculos Protocol) | ❌ | Spec §V.D |
| DYM Media Collective | ❌ | Spec §V.E |
| Candidate Selection (Primary by Merit) | ❌ | Spec §VI.A |
| The People's Manifesto | ❌ | Spec §VI.B |
| Victories Tracker | ❌ | Spec §V.C |

---

## 5. Whitepaper Phased Rollout Plan

> Source: whitepaper §VIII. These are the original phases — use as reference for prioritizing development.

| Phase | Goal | Key Features | Status Today |
|---|---|---|---|
| **Phase 1** | MVP: Core democracy, first 3,000 members | NID+SMS verification, 1-person-1-vote proposals, Merit Score running in background | ⚠️ Partial (no SMS OTP) |
| **Phase 2** | Activate weighted influence | Merit-weighted voting, RCV elections, Git-Constitution, Live Treasury | ❌ |
| **Phase 3** | National presence | Shadow Minister elections, Community Hubs, SMS voting | ❌ |
| **Phase 4** | Full incentive design | Proposal Staking, Bridge-Building Bonus, Unity Warning System | ❌ |
| **Phase 5** | Full automation | Parametric Governance Engine, AI moderation | ❌ |
| **Phase 6** | Constitutional integration | Ratify into national law via sustained membership + policy adoption | ❌ |

---

## 6. Database Schema

### 6.1 Main Database (`data/3rdparty.db`)

| Table | Purpose | Key Columns |
|---|---|---|
| `signups` | User accounts | `phone`, `nid`, `username`, `initial_merit_estimate`, `contribution_type`, `donation_amount`, `auth_token`, `last_login` |
| `referrals` | Referral tracking | `referrer_id`, `referred_id`, `relation`, `status`, `base_reward_given`, `engagement_bonus_given`, `first_action_at` |
| `activity_log` | Audit trail | `action_type`, `user_id`, `target_id`, `details`, `ip_address`, `timestamp` |
| `wall_posts` | Public wall | `nickname`, `message`, `thread_id`, `is_approved` |
| `proposals` | Policy proposals | `title`, `description`, `category`, `status`, `yes_votes`, `no_votes`, `abstain_votes`, `created_by_user_id` |
| `votes` | Proposal votes | `proposal_id`, `choice`, `voter_ip` |
| `ranked_votes` | RCV ballots | `election_id`, `voter_ip`, `rankings` |
| `system_settings` | Runtime config | All merit values, limits, thresholds |
| `leadership_positions` | Role definitions | `title`, `position_type`, `min_merit_required` |
| `leadership_applications` | User applications | `user_id`, `position_id`, `status`, `merit_score_at_apply` |
| `leadership_terms` | Active assignments | `user_id`, `position_id`, `started_at`, `ended_at` |
| `leadership_settings` | Leader config | `member_threshold`, `min_merit_for_leadership`, `max_term_years` |

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
| `merit_events` | Every point-earning action with timestamp, type, amount | Required for dynamic decay |
| `endorsements` | Peer-to-peer endorsements with constraints | Required for §2.2.4 |
| `bounties` | Bounty board tasks with tier, status, assignee, reward | Required for §2.2.6 |
| `donations` | Verified donation records with proof | Required for Live Treasury |
| `violations` | Disciplinary cases with tier, sanction, appeals | Required for §2.4 |
| `academy_modules` | Leadership Academy curriculum and progress | Required for §VI.A |

---

## 7. Misleading Frontend Elements (Needs Fixing)

The frontend displays reward information that is not backed by server logic. These should either be wired up or the copy should be changed.

| Element | Location | What It Says | Reality |
|---|---|---|---|
| Clause vote points | `profile.html:207` | "+2.5 pts each" | Never awarded |
| Article vote points | `profile.html:212` | "+2.5 pts each" | Never awarded |
| Voting earns points | `how.html:100` | "earn points by voting on proposals" | Never awarded |
| Bounty board | `how.html:100`, `faq.html:113-117` | References bounty tasks | Doesn't exist |
| Bridge-building bonus | `faq.html:165` | "400-point Merit Bonus" | Doesn't exist |
| Reputation penalty | `faq.html:153` | Describes penalty system | Doesn't exist |
| Engagement bonus | `profile.html:246`, `enroll.html:40` | "earn points when they take their first action" | Never triggers |

---

## 8. Development Roadmap (Recommended Order)

### Phase 1 — Fix What's Broken (Critical)
1. **De-hardcode all reward values** (see §13) — move all hardcoded numeric constants into `DEFAULT_SETTINGS` → `system_settings` → admin UI. No reward value shall remain as a magic number in code.
2. **Wire up voting merit points** in `POST /api/vote`, `POST /api/mvlaws/vote`, `POST /api/mvlaws/vote-subarticle`, `POST /api/mvlaws/vote-law` — use settings for point values, not hardcoded numbers.
3. **Remove or update misleading frontend copy** (see §7) so users aren't told they earn points for actions that award none
4. **Implement engagement bonus** — set `first_action_at` when referred user performs any merit action, award bonus points to referrer using configurable settings from §13.1

### Phase 2 — Core Merit Engine
4. Create `merit_events` table: `(id, user_id, event_type, points, target_id, created_at)`
5. Implement `GET /api/merit/score` — dynamic calculation using `MS = Σ [ points * e^(-(λ_base / Lc) * days_since) ]`
6. Implement loyalty coefficient based on join date (Founding: 1.5, Early: 1.2, Standard: 1.0)
7. Replace `initial_merit_estimate` reads with dynamic score; keep `initial_merit_estimate` as historical baseline

### Phase 3 — Core Rewards
8. Proposal authoring points (200 / coauthors) on proposal passage
9. Log all point events to `merit_events` and `activity_log`
10. Proper donation formula `35 * log5(USD + 1)` replacing flat bonus
11. Peer endorsements with diminishing returns and 20/month cap

### Phase 4 — Advanced Incentives
12. Bounty board with Tier 1/2/3 tasks
13. Bridge-building bonus (400 pts) with amendment workflow
14. Proposal staking (`max(10, MS*0.005)`) with refund/forfeit logic
15. Reputation penalty engine for low-quality proposals
16. Role-based monthly stipends (cron job checking activity conditions)

### Phase 5 — Governance Deepening
17. Merit-weighted voting
18. Tiered approval thresholds (Routine/Policy/Constitutional)
19. Voting window weight decay (7-day primary, 3-day extended)
20. Leadership Academy curriculum and graduation tracking
21. Living Legal Code with persistent approve/disapprove + Mandatory Review Agenda
22. Violation reporting, Integrity Committee workflow, sanctions engine

### Phase 6 — Real-World Integration
23. SMS OTP verification
24. Live Treasury with verified donations
25. Community Hubs (Círculos Protocol)
26. Shadow Minister elections via RCV
27. Candidate Selection (Primary by Merit)
28. Coalition Governance Protocol
29. Media Collective with Knowledge Checks and Amplification Bounties
30. Signal Horn Protocol for crisis response

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
| Donate | `donate.html` | Donation page |
| Admin Dashboard | `admin.html` | System settings, user management, leadership management |
| Navigation (shared) | `nav.js` | Inject navbar into all pages |

---

## 10. Key API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/signup` | None | Register new user, calc merit, match pending referrals |
| `POST` | `/api/login` | None | Login with username + phone |
| `GET` | `/api/user/profile` | User | Get profile + vote counts (no dynamic merit) |
| `PUT` | `/api/user/profile` | User | Update username/name/email/island |
| `POST` | `/api/referral/introduce` | User | Create pending/active referral for new or existing person |
| `POST` | `/api/enroll-family-friend` | User | Directly enroll someone + award base points |
| `GET` | `/api/referrals` | User | List referrals + base/engagement/total point summary |
| `POST` | `/api/referral/remove` | User | Remove referral, reverse awarded points |
| `POST` | `/api/enroll/lookup` | User | Search external directory for people to enroll |
| `GET` | `/api/proposals` | None | List active proposals with vote counts |
| `POST` | `/api/proposals` | Optional | Create proposal |
| `POST` | `/api/vote` | None | Vote on proposal (yes/no/abstain) |
| `POST` | `/api/ranked-vote` | User | Submit ranked-choice ballot |
| `PATCH` | `/api/proposals/:id` | None | Edit proposal title/description |
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
| `POST` | `/api/unregister` | Admin | Remove user from platform |
| `GET` | `/api/system-settings` | Admin | Get current system settings |
| `POST` | `/api/system-settings` | Admin | Update system settings (merit values, limits, etc.) |
| `GET` | `/api/settings/public` | None | Public settings (member count, targets) |
| `GET` | `/api/leadership/positions` | Admin | List all leadership roles |
| `POST` | `/api/leadership/applications` | User | Apply for leadership position |
| `GET` | `/api/activity-log` | Admin | Query activity audit trail |
| `GET` | `/api/analytics/active` | None | Active visitor count |
| `POST` | `/api/analytics/heartbeat` | None | Heartbeat to track visitor |

---

## 11. Configuration Principle

> **CRITICAL: No reward, points, or merit value shall ever be hardcoded.**
> Every tunable parameter must live in `DEFAULT_SETTINGS` → `system_settings` table → admin UI.
> This ensures admins can adjust the incentive system without code changes or redeploys.

The `system_settings` table stores all config as a JSON blob (`settings_json` column).
`getSettings()` (line 36) merges DB values over `DEFAULT_SETTINGS`.
`POST /api/system-settings` (line 3588, admin only) accepts any key and persists it.

---

## 12. Current Server Settings (Admin-Configurable)

All configurable at runtime via `POST /api/system-settings` (admin). Defaults in `server.js:13-34`:

| Setting | Default | Description | In Admin UI? |
|---|---|---|---|
| `signup_base_merit` | 50 | Merit points every signup receives | ✅ |
| `merit_skills` | 250 | Points for "Skills" contribution type | ✅ |
| `merit_action` | 200 | Points for "Action" contribution type | ✅ |
| `merit_ideas` | 150 | Points for "Ideas" contribution type | ✅ |
| `merit_donation` | 100 | Points for "Donation" contribution type | ✅ |
| `donation_bonus_per_100` | 5 | Extra points per 100 MVR donated | ✅ |
| `proposal_voting_days` | 7 | How long proposals stay open | ✅ |
| `visitor_timeout_ms` | 300000 | Active visitor timeout (5 min) | ✅ |
| `vote_cooldown_ms` | 3600000 | Cooldown between votes (1 hour) | ✅ |
| `wall_post_max_length` | 500 | Max chars for wall posts | ✅ |
| `proposal_title_max_length` | 200 | Max chars for proposal title | ✅ |
| `proposal_description_max_length` | 8000 | Max chars for proposal description | ✅ |
| `nickname_max_length` | 50 | Max chars for nickname | ✅ |
| `target_members` | 13000 | Membership goal for progress bar | ✅ |
| `target_treasury` | 13000 | Treasury goal | ✅ |
| `enroll_rate_limit_ms` | 60000 | Enrollment rate limit window | ✅ |
| `enroll_max_per_day` | 50 | Max enrollments per IP per day | ✅ |
| `max_upload_bytes` | 5242880 | Max file upload size (5 MB) | ✅ |

---

## 13. Hardcoded Values — Audit & Required Settings Migration

The following values are **currently hardcoded** in `server.js` and must be moved to `DEFAULT_SETTINGS` → `system_settings` → admin UI.

### 13.1 Referral Points (server.js:2737-2750 — `getReferralPoints()`)

| Hardcoded Value | Lines | What It Is | Suggested Setting Key | Suggested Default |
|---|---|---|---|---|
| `5` | 2915, 2920 | Tier 1 max invite count | `referral_tier1_limit` | 5 |
| `20` | 2916, 2921 | Tier 2 max invite count | `referral_tier2_limit` | 20 |
| `2` | 2920 | Base reward per invite (tier 1) | `referral_base_t1` | 2 |
| `1` | 2921 | Base reward per invite (tier 2) | `referral_base_t2` | 1 |
| `0.5` | 2922 | Base reward per invite (tier 3) | `referral_base_t3` | 0.5 |
| `8` | 2915 | Engagement bonus per invite (tier 1) | `referral_engage_t1` | 8 |
| `4` | 2916 | Engagement bonus per invite (tier 2) | `referral_engage_t2` | 4 |
| `0.5` | 2917 | Engagement bonus per invite (tier 3) | `referral_engage_t3` | 0.5 |

**Fix:** Add all 8 keys to `DEFAULT_SETTINGS`, read them via `getSettings()` inside `getReferralPoints()`, expose in admin UI.

### 13.2 Merit Calculation on Signup/Enroll

| Hardcoded Value | Lines | What It Is | Suggested Setting Key | Suggested Default |
|---|---|---|---|---|
| `50` | 2286, 2955 | Max random bonus (0 to value-1) | `signup_random_bonus_max` | 50 |
| `100` | 2299, 2967 | Donation divisor (MVR per "unit") | `donation_divisor_mvr` | 100 |
| `5` (from `donation_bonus_per_100`) | 2299 | Already configurable | — | — |
| `35` | line 2473 (signup only) | Donation log formula multiplier | `donation_log_multiplier` | 35 |
| `15.4` | line 2472 (signup only) | USD-to-MVR exchange rate | `donation_usd_mvr_rate` | 15.4 |

**Note:** Signup route (lines 2472-2473) uses logarithmic formula `35*log5(USD+1)` while enroll route (line 2967) uses flat `floor(MVR/100)*donation_bonus_per_100`. These must be unified to one approach.

**Fix:** Add all keys to `DEFAULT_SETTINGS`, use `getSettings()` in both signup and enroll routes, expose in admin UI.

### 13.3 Voting & Proposal Merit (Not Yet Implemented)

When voting merit and proposal authoring merit are implemented (see roadmap §8 Phase 1,3), these values must NOT be hardcoded:

| Suggested Setting Key | Suggested Default | Whitepaper Source |
|---|---|---|
| `merit_vote_pass` | 2.5 | Whitepaper §II.C.1.b |
| `merit_vote_fail` | 1.0 | Whitepaper §II.C.1.a |
| `merit_proposal_author` | 200 | Whitepaper §II.C.2 |
| `merit_bridge_building` | 400 | Whitepaper §II.C.3 |
| `merit_endorsement_t1` | 2.0 | Whitepaper §II.C.4 (endorsements 1-10) |
| `merit_endorsement_t2` | 1.0 | Whitepaper §II.C.4 (endorsements 11-50) |
| `merit_endorsement_t3` | 0.5 | Whitepaper §II.C.4 (endorsements 51-200) |
| `merit_endorsement_t4` | 0.1 | Whitepaper §II.C.4 (endorsements 201+) |
| `merit_endorsement_cap` | 20 | Per-30-day cap |
| `merit_bounty_t1` | 20 | Tier 1 bounty |
| `merit_bounty_t2` | 75 | Tier 2 bounty |
| `merit_bounty_t3` | 250 | Tier 3 bounty |
| `merit_stipend_minister` | 150 | Monthly Shadow Minister stipend |
| `merit_stipend_committee` | 75 | Monthly Committee stipend |
| `merit_stipend_advisory` | 50 | Per report Advisory stipend |
| `merit_decay_lambda` | 0.001267 | Base decay constant |
| `merit_loyalty_founder` | 1.5 | Founder Loyalty Coefficient |
| `merit_loyalty_early` | 1.2 | Early Adopter Loyalty Coefficient |
| `merit_loyalty_standard` | 1.0 | Standard Loyalty Coefficient |
| `merit_stake_percent` | 0.005 | Proposal stake as fraction of MS |
| `merit_stake_min` | 10 | Minimum proposal stake |
| `merit_quality_threshold` | 0.10 | Below this support = frivolous (<10%) |
| `merit_quality_refund` | 0.20 | Above this support = stake refunded (≥20%) |
| `merit_bridge_stake` | 20 | Stake to attempt bridge-building amendment |

**Fix:** Add all of these to `DEFAULT_SETTINGS` when implementing the corresponding feature. Never hardcode numeric reward values.

### 13.4 Leadership Position Defaults

The seed data in `server.js:553-562` has hardcoded `min_merit_required` values. These are stored in DB (editable via leadership API) but the seed defaults should reference settings:

| Hardcoded Value | Line | Position | Suggested Setting Key | Suggested Default |
|---|---|---|---|---|
| `1000` | 554 | Shadow President | `min_merit_president` | 1000 |
| `800` | 555-558 | Council Ministers | `min_merit_minister` | 800 |
| `600` | 559 | Integrity Committee Chair | `min_merit_integrity` | 600 |
| `500` | 560 | Verification Committee Chair | `min_merit_verification` | 500 |
| `700` | 561 | Policy Hub Lead | `min_merit_hub_lead` | 700 |

### 13.5 Leadership Settings (Already DB-Backed, Configurable in Admin UI)

These are stored in `leadership_settings` table, not `system_settings`. Values at `server.js:681-694`:

| Setting | Default | Admin UI? |
|---|---|---|
| `member_threshold` | 1000 | ✅ |
| `min_merit_for_leadership` | 500 | ✅ |
| `max_term_years` | 2 | ✅ |
| `appraisal_frequency_days` | 365 | ✅ |

---

## 14. Admin UI — What Needs Adding

The admin settings panel (`admin.html:1575-1741`) currently exposes 19 fields. To match §13, add these inputs:

**Referral Section:**
- `referral_tier1_limit`, `referral_tier2_limit`
- `referral_base_t1`, `referral_base_t2`, `referral_base_t3`
- `referral_engage_t1`, `referral_engage_t2`, `referral_engage_t3`

**Signup/Enroll Merit Section:**
- `signup_random_bonus_max`
- `donation_divisor_mvr`
- `donation_log_multiplier`
- `donation_usd_mvr_rate`

**Voting & Proposal Merit Section (future — add with implementation):**
- `merit_vote_pass`, `merit_vote_fail`
- `merit_proposal_author`, `merit_bridge_building`
- `merit_endorsement_t1..t4`, `merit_endorsement_cap`
- `merit_bounty_t1..t3`
- `merit_stipend_minister`, `merit_stipend_committee`, `merit_stipend_advisory`
- `merit_decay_lambda`, `merit_loyalty_founder`, `merit_loyalty_early`, `merit_loyalty_standard`
- `merit_stake_percent`, `merit_stake_min`, `merit_quality_threshold`, `merit_quality_refund`, `merit_bridge_stake`

---

## 15. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default 3000) | Server port |
| `ADMIN_PASSWORD` | **Yes** | Admin authentication password |
| `DIRECTORY_API_KEY` | No | External directory search API key |
| `DIRECTORY_API_HOST` | No | External directory search API host |
| `LAWS_DB_PATH` | No | Path to laws.db (auto-detected otherwise) |
| `NODE_ENV` | No | Environment (`production` enables security headers) |

---

## 16. Key Architectural Notes

1. **Merit score is currently a write-only estimate.** `initial_merit_estimate` is set at signup, modified only by referral rewards/reversals. No read-time calculation exists. The entire decay formula (§2.1) needs a `merit_events` table and a dynamic calculator.

2. **Configuration discipline is essential.** ~25 reward-related numeric values are hardcoded (see §13). Every one must move into `DEFAULT_SETTINGS` → `system_settings` → admin UI. The `getSettings()` + `POST /api/system-settings` pattern already exists and supports arbitrary keys — use it for all new settings. Never introduce a magic number into reward logic.

3. **Two separate vote systems exist, both without merit rewards:**
   - Proposal votes (`votes` table in main DB) — demo, no signup required
   - Law votes (`sub_article_votes` in laws DB, `law_votes` in main DB) — some require signup

4. **The referral system's engagement bonus is "almost there."** The DB schema has `first_action_at` and `engagement_bonus_given` columns. The `getReferralPoints()` function handles engagement bonus calculation. The only missing piece: no code sets `first_action_at` when a referred user performs any action. Add this to `POST /api/vote`, `POST /api/mvlaws/vote`, etc.

5. **Signup and enroll use different donation formulas.** Signup route (line ~2472) uses logarithmic `35*log5(USD+1)`, enroll route (line ~2967) uses flat `floor(MVR/100)*bonus`. Unify to one approach controlled by settings.

6. **Frontend references whitepaper features liberally.** `profile.html`, `how.html`, and `faq.html` describe features (voting points, bounty board, bridge-building, reputation penalty) that have zero backend implementation. Either implement them or update the copy.

7. **Leadership system has data tables but no operational logic.** Positions exist, applications can be submitted, but there are no elections, no stipend cron, no Academy curriculum, no Advisory Panel credential verification.

8. **All governance mechanisms beyond basic voting are Phase 4+.** Weighted voting, tiered thresholds, staking, reputation penalties, bridge-building, the Living Legal Code — these are all specified in detail but nothing is built.
