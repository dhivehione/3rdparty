const DEFAULT_SETTINGS = {
  visitor_timeout_ms: 5 * 60 * 1000,
  enroll_rate_limit_ms: 60 * 1000,
  enroll_max_per_day: 50,
  vote_cooldown_ms: 60 * 60 * 1000,
  proposal_voting_days: 7,
  wall_post_max_length: 500,
  proposal_title_max_length: 200,
  proposal_description_max_length: 8000,
  nickname_max_length: 50,
  wall_posts_limit: 100,
  recent_votes_limit: 50,
  signup_base_merit: 50,
  merit_skills: 250,
  merit_action: 200,
  merit_ideas: 150,
  merit_donation: 100,
  donation_bonus_per_100: 5,
  max_upload_bytes: 5 * 1024 * 1024,
  target_members: 13000,
  target_treasury: 13000,
  signup_random_bonus_max: 50,
  donation_divisor_mvr: 100,
  donation_log_multiplier: 35,
  donation_usd_mvr_rate: 15.4,
  donation_formula: 'log',
  referral_tier1_limit: 5,
  referral_tier2_limit: 20,
  referral_base_t1: 2,
  referral_base_t2: 1,
  referral_base_t3: 0.5,
  referral_engage_t1: 8,
  referral_engage_t2: 4,
  referral_engage_t3: 0.5,
  endorsement_tier1_limit: 10,
  endorsement_tier2_limit: 50,
  endorsement_tier3_limit: 200,
  endorsement_tier1_pts: 2.0,
  endorsement_tier2_pts: 1.0,
  endorsement_tier3_pts: 0.5,
  endorsement_tier4_pts: 0.1,
  approval_threshold_routine: 0.50,
  approval_threshold_policy: 0.60,
  approval_threshold_constitutional: 0.80,
  voting_window_primary_days: 7,
  voting_window_extended_days: 3,
  voting_weight_primary: 1.0,
  voting_weight_extended: 0.5,
  proposal_cooldown_hours: 8,
  merit_vote_pass: 2.5,
  merit_vote_fail: 1.0,
  merit_proposal_author: 200,
  merit_proposal_created: 10,
  sms_provider: '',
  sms_twilio_account_sid: '',
  sms_twilio_auth_token: '',
  sms_twilio_phone_number: '',
  sms_webhook_url: '',
  sms_otp_length: 6,
  sms_otp_expiry_minutes: 10,
  sms_otp_required: 0,
  ai_law_draft_prompt: `You are a legal drafting assistant for the Maldives. Given a seed idea, produce a well-structured draft using proper legal formatting.

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

Draft in a formal legal style. Use "shall" for obligations, "may" for permissions. Be specific and enforceable. Keep the draft proportional to the scope — a clause should be a few paragraphs, a law can be several pages. Do NOT include placeholder text or markdown formatting instructions in the output.`
};

let _db = null;

function init(db) {
  _db = db;
}

function getSettings() {
  try {
    const row = _db.prepare('SELECT settings_json FROM system_settings WHERE id = 1').get();
    if (row && row.settings_json) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(row.settings_json) };
    }
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}

function updateSettings(newSettings) {
  const current = getSettings();
  const merged = { ...current, ...newSettings };
  _db.prepare('INSERT OR REPLACE INTO system_settings (id, settings_json, updated_at) VALUES (1, ?, ?)')
    .run(JSON.stringify(merged), new Date().toISOString());
  return merged;
}

module.exports = { DEFAULT_SETTINGS, init, getSettings, updateSettings };