// prompts-ultra-sota.ts
// High-signal prompt templates for ULTRA SOTA + God Mode

const now = new Date();
const CURRENT_YEAR = now.getFullYear();
const TARGET_YEAR = now.getMonth() === 11 ? CURRENT_YEAR + 1 : CURRENT_YEAR;

export interface UltraSOTAArticlePlan {
  title: string;
  primaryKeyword: string;
  semanticKeywords: string[];
  metaDescription: string;
  outline: { heading: string; wordCount: number }[];
  keyTakeaways: string[];
  faqSection: { question: string; answer: string }[];
}

export interface PromptBundle {
  system: string;
  user: string;
}

/**
 * Neutral, publisher-grade ULTRA SOTA prompt.
 */
export default function buildUltraSOTAPrompt(
  plan: UltraSOTAArticlePlan,
  semanticKeywords: string[],
  gapOpportunities: string[],
  existingPages: { title: string; slug: string }[],
  neuronData: string | null,
  recentNews: string | null
): PromptBundle {
  const internalSlugs = existingPages
    .map((p) => `- "${p.title}" → /${p.slug}`)
    .join('\n');

  const outlineText = plan.outline
    .map((o) => `- ${o.heading} (${o.wordCount} words)`)
    .join('\n');

  const gapsText =
    gapOpportunities.length > 0
      ? gapOpportunities.map((g, i) => `${i + 1}. ${g}`).join('\n')
      : 'No explicit gaps provided; rely on best-practice coverage.';

  const faqText = plan.faqSection
    .map((f, i) => `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`)
    .join('\n\n');

  const system = `
You are an elite editor and subject-matter expert ghostwriting for a top-tier, fact-checked publication.

Write long-form HTML content that:
- Feels 100% human-written.
- Obeys E‑E‑A‑T and Helpful Content principles.
- Is optimized for organic search, AI overviews, and featured snippets.
- Prioritizes clarity, specificity, and practical usefulness over hype.

Absolute rules:
1. Output pure HTML only (NO markdown fences, NO commentary).
2. Start with a single <h1> at the very top.
3. Use <h2>, <h3>, lists, tables, and callouts for readability.
4. No intro or outro meta-text like "Here is the article" or "Conclusion:" labels outside headings.
5. Avoid generic filler language and vague claims. Be concrete, data-aware, and time-anchored to ${TARGET_YEAR}.
`.trim();

  const user = `
PRIMARY TOPIC: ${plan.primaryKeyword}
TARGET YEAR: ${TARGET_YEAR}

ROLE:
You are writing for an informed but busy reader who wants fast clarity, strong opinions backed by evidence, and examples that feel real.

GOALS:
- Help the reader accomplish something specific with "${plan.primaryKeyword}".
- Earn top rankings for high-intent queries around this topic.
- Win AI overview / featured snippet positions with tight, definition-style passages and well-structured lists/tables.

OUTLINE (GUIDELINE, NOT PRISON):
${outlineText}

SEMANTIC KEYWORDS (must be woven in naturally):
${semanticKeywords.join(', ')}

INFORMATION GAPS TO EXPLOIT VS COMPETITORS:
${gapsText}

INTERNAL CONTENT YOU CAN LINK TO (by slug placeholders):
${internalSlugs || 'None provided; you may still create generic internal-link placeholders like /guide or /tools when natural.'}

NEURON / EXPERT ANALYSIS (optional context, if present):
${neuronData || 'No external analysis provided.'}

RECENT NEWS OR DATA POINTS (optional context, if present):
${recentNews || 'No recent news provided; rely on evergreen and ${TARGET_YEAR - 1}–${TARGET_YEAR} data where relevant.'}

STRUCTURE & FORMATTING REQUIREMENTS:

1) H1 + INTRO
- One <h1> that includes the primary keyword in a natural way.
- Followed by 2–3 short paragraphs that answer “What is this and why should I care?” in plain language.

2) KEY TAKEAWAYS
- Insert a visually distinct box near the top using simple HTML (no Tailwind):
  <section class="key-takeaways"> with a short list of 4–8 bullet points.
- Each bullet = 1 concrete, non-obvious insight.

3) BODY SECTIONS
- Follow the outline headings as <h2>/<h3>. Make sections skimmable.
- After each <h2>, the first paragraph (40–60 words) should act like a featured snippet answer for that subtopic.
- Use examples, small numbers, benchmarks, or short case fragments wherever realistic.

4) TABLES & LISTS
- Use <ul>/<ol> generously for steps, pros/cons, and checklists.
- Include at least one <table> when comparison or feature breakdown is natural.
- Keep tables narrow enough to be mobile-friendly (short labels, no huge paragraphs inside cells).

5) FAQ
- Add a dedicated <h2>FAQ</h2> section near the end.
- For each FAQ, use semantic markup structure:
  <h3>Question</h3>
  <p>Clear, conversational answer.</p>

6) TONE & STYLE
- Direct, confident, and useful. Fewer buzzwords, more “do this, not that”.
- No over-the-top hype language. Sound like a senior operator, not a copywriter.
- Avoid AI-sounding clichés such as “delve”, “tapestry”, “realm”, “landscape”, “holistic approach”, “paradigm”.

7) OUTPUT RULES
- Return COMPLETE HTML for the article body only.
- Do NOT include <html>, <head>, or <body> tags.
- Do NOT add any references section; that will be injected later.
`.trim();

  return { system, user };
}

/**
 * God Mode prompt: more aggressive entity density, burstiness, and design,
 * but still outputs clean HTML with no meta-messaging.
 */
export function buildGodModePrompt(
  keyword: string,
  semanticKeywords: string[],
  opportunities: string[],
  existingPages: { title: string; slug: string }[],
  existingImages: string[],
  neuronData: string | null
): PromptBundle {
  const internalSlugs = existingPages
    .map((p) => `- "${p.title}" → /${p.slug}`)
    .join('\n');

  const system = `
You are a senior editor and growth strategist writing a flagship, category-defining article.

Objectives:
- Outperform the best three competitors on depth, clarity, and usefulness.
- Drive organic traffic, AI overview visibility, and long-click engagement.
- Produce HTML that a human editor would be happy to publish as-is.

Non‑negotiables:
- 100% pure HTML output (no markdown, no commentary).
- One <h1> at the top, then semantic headings.
- Human, conversational, high-signal writing with varied sentence length.
- Avoid “AI voice” and overused buzzwords.
`.trim();

  const user = `
PRIMARY TOPIC (GOD MODE): ${keyword}
TARGET YEAR: ${TARGET_YEAR}

YOUR EDGE:
- You know what non-experts miss and what practitioners actually do.
- You are allowed to be opinionated, as long as you justify it with logic, data, or clear examples.

SEMANTIC KEYWORDS (must be worked in naturally, no stuffing):
${semanticKeywords.join(', ')}

COMPETITOR OPPORTUNITIES TO EXPLOIT:
${opportunities.length ? opportunities.join('\n') : 'No explicit gaps listed; create depth and specificity they are missing.'}

INTERNAL CONTENT MAP:
${internalSlugs || 'No explicit internal pages; you may introduce generic /tools, /resources, /case-studies slugs where helpful.'}

EXISTING MEDIA TO PRESERVE (if any):
${existingImages.length ? existingImages.join('\n') : 'No existing images detected in source content.'}

NEURON / EXPERT ANALYSIS:
${neuronData || 'None provided.'}

WRITE THE ARTICLE WITH THESE RULES:

1) OPEN STRONG
- H1 with the main keyword, but not clickbait.
- First 2–3 paragraphs: hard-hitting explanation of what matters and who this is for.
- Call out common but wrong default beliefs if relevant.

2) HIGH INFORMATION GAIN
- Replace vague statements with concrete ones: numbers, ranges, timeframes, or specific tools.
- When giving advice, show quick mini-examples (1–2 sentences) of how it looks in practice.

3) ENTITY‑RICH WRITING
- Use specific brands, tools, model names, and version numbers where they naturally fit.
- If you mention “CMS”, think “WordPress 6.x”, “Webflow”, etc.
- If you mention “running shoes”, think concrete models and release years.

4) STRUCTURE
- Use <h2> and <h3> aggressively to chunk the article.
- After each <h2>, first paragraph (40–60 words) should read like a definition or direct answer.
- Use lists and short paragraphs to keep mobile readability high.

5) VISUAL HINTS (HTML‑only)
- Use simple class names only (no Tailwind). Example:
  <section class="highlight">, <div class="note">, <section class="comparison-table">
- Do NOT include any marketing slogans like "mission complete" or "visual supernova".

6) HUMAN VOICE
- Mix short punchy sentences with a few longer, flowing ones.
- It’s fine to say things like “Here’s the part most people miss:” or “In plain English:”.
- No meta talk about being an AI, writer, or model.

7) OUTPUT CONTRACT
- Output must be a fully-formed article body in HTML.
- Start with <h1> and end with the last closing tag of the article.
- Do NOT include any references section; that will be added downstream.
`.trim();

  return { system, user };
}
