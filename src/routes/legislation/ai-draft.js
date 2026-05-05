const express = require('express');
const router = express.Router();

module.exports = function({ db, lawsDb, getSettings }) {

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
router.post('/api/generate-law-draft', async (req, res) => {
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

    const settings = getSettings();
    const systemPrompt = settings.ai_law_draft_prompt || `You are a legal drafting assistant for the Maldives. Given a seed idea, produce a well-structured draft using proper legal formatting.

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

  return router;
};
