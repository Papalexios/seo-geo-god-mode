// ultra-sota-services.tsx
// SOTA support services for ULTRA SOTA + God Mode

import fetchWithProxies from './contentUtils';
import type { SitemapPage } from './types';

export interface CompetitorGap {
  type: 'missing-topic' | 'outdated-data' | 'shallow-coverage' | 'missing-examples';
  topic: string;
  opportunity: string;
  priority: 'high' | 'medium' | 'low';
}

export interface GapAnalysisResult {
  gaps: CompetitorGap[];
  competitorKeywords: string[];
  missingKeywords: string[];
}

export interface ValidatedReference {
  title: string;
  url: string;
  source?: string;
  year?: number;
  relevance?: 'high' | 'medium' | 'low';
  status?: 'valid' | 'invalid' | 'checking';
  statusCode?: number;
  description?: string;
}

export interface InternalLinkSuggestion {
  anchorText: string;
  targetSlug: string;
  context: string;
  placement: 'intro' | 'body' | 'faq' | 'conclusion';
}

/**
 * Competitor gap analysis using SERP + model.
 */
export async function performCompetitorGapAnalysis(
  keyword: string,
  serpData: any,
  aiClient: any,
  model: string
): Promise<GapAnalysisResult> {
  try {
    const topResults = Array.isArray(serpData?.organic)
      ? serpData.organic.slice(0, 5)
      : [];

    const serpSummary = topResults
      .map(
        (r: any, i: number) =>
          `${i + 1}. ${r.title}\n   URL: ${r.link}\n   Snippet: ${r.snippet || ''}`
      )
      .join('\n\n');

    const systemPrompt = `
You are a competitive intelligence analyst for SEO content.

Your job:
- Read the top competitor snippets.
- Identify what they all cover.
- Then identify what they consistently miss, gloss over, or keep vague.
`.trim();

    const userPrompt = `
PRIMARY KEYWORD: ${keyword}

COMPETITOR SERP SNIPPETS:
${serpSummary || 'No SERP data available.'}

TASKS:
1) List 5–12 specific content gaps we can exploit:
   - Missing subtopics
   - Outdated statistics or years
   - Superficial explanations we can deepen
   - Absent real-world examples or use cases

2) Extract 15–30 competitor‑aligned semantic keywords.

3) Extract 10–20 missing but highly relevant keywords we should add.

Return STRICT JSON ONLY:
{
  "gaps": [
    {
      "type": "missing-topic" | "outdated-data" | "shallow-coverage" | "missing-examples",
      "topic": "short phrase",
      "opportunity": "1–2 sentence explanation of how we can outperform them",
      "priority": "high" | "medium" | "low"
    }
  ],
  "competitorKeywords": ["..."],
  "missingKeywords": ["..."]
}
`.trim();

    const responseText = await callStructuredModel(aiClient, model, systemPrompt, userPrompt);
    const parsed = safeJsonParse<GapAnalysisResult>(responseText, {
      gaps: [],
      competitorKeywords: [],
      missingKeywords: [],
    });

    return {
      gaps: parsed.gaps || [],
      competitorKeywords: parsed.competitorKeywords || [],
      missingKeywords: parsed.missingKeywords || [],
    };
  } catch (error) {
    console.error('SOTA Gap Analysis Error', error);
    return {
      gaps: [],
      competitorKeywords: [],
      missingKeywords: [],
    };
  }
}

/**
 * Semantic keyword expansion (optionally using NeuronWriter data).
 */
export async function enhanceSemanticKeywords(
  primaryKeyword: string,
  neuronData: string | null,
  aiClient: any,
  model: string
): Promise<string[]> {
  const baseList: string[] = [];

  if (neuronData) {
    try {
      const parsed = JSON.parse(neuronData);
      if (Array.isArray(parsed?.keywords)) {
        baseList.push(...parsed.keywords.slice(0, 50));
      }
    } catch {
      // ignore neuron parsing issues, fall back to model-only
    }
  }

  const systemPrompt = `
You are an on-page SEO strategist.

Generate semantic keywords that help a long-form article about the topic
achieve topical authority and match real user intent.
`.trim();

  const userPrompt = `
PRIMARY KEYWORD: ${primaryKeyword}

OPTIONAL EXISTING KEYWORDS:
${baseList.length ? baseList.join(', ') : 'None'}

TASK:
Return 30–60 additional, distinct semantic keywords and entities related to this topic.
Mix:
- question-style phrases
- problem/solution phrases
- entities (brands, tools, frameworks, locations if relevant)

Return STRICT JSON ONLY:
{
  "keywords": ["...", "..."]
}
`.trim();

  try {
    const responseText = await callStructuredModel(aiClient, model, systemPrompt, userPrompt);
    const parsed = safeJsonParse<{ keywords: string[] }>(responseText, { keywords: [] });

    const combined = [...baseList, ...(parsed.keywords || [])]
      .map((k) => k.trim())
      .filter(Boolean);

    // De-duplicate, keep order
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const kw of combined) {
      const lower = kw.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        unique.push(kw);
      }
    }
    return unique;
  } catch (error) {
    console.error('SOTA Semantic Keyword Error', error);
    return baseList.length ? baseList : [primaryKeyword];
  }
}

/**
 * Dynamic reference discovery + validation using Serper and the model.
 */
export async function generateAndValidateReferences(
  keyword: string,
  contentSummary: string,
  serperApiKey: string,
  aiClient: any,
  model: string,
  onProgress?: (msg: string) => void
): Promise<ValidatedReference[]> {
  onProgress?.('Searching for authoritative sources…');

  let serpResults: any[] = [];
  if (serperApiKey) {
    try {
      const response = await fetchWithProxies('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': serperApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: `${keyword} ${new Date().getFullYear()} research data official`,
          num: 20,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        serpResults = Array.isArray(data.organic) ? data.organic : [];
        onProgress?.(`Found ${serpResults.length} candidate sources…`);
      }
    } catch (error) {
      console.error('Serper reference search failed', error);
    }
  }

  const searchDump = serpResults
    .slice(0, 15)
    .map(
      (r: any, i: number) =>
        `${i + 1}. ${r.title}\n   URL: ${r.link}\n   Snippet: ${r.snippet || ''}`
    )
    .join('\n\n');

  const systemPrompt = `
You are a research librarian.

Your job:
- Choose only the best, most relevant sources.
- Prefer primary or highly reputable references over generic blogs.
`.trim();

  const userPrompt = `
TOPIC: ${keyword}
CONTENT SUMMARY:
${contentSummary}

CANDIDATE SEARCH RESULTS:
${searchDump || 'None.'}

TASK:
Select the 8–12 strongest references for this article.

Rules:
- Prefer .gov, .edu, and major institutions or well-known products/vendors.
- Ensure each chosen source clearly supports some part of the topic.
- Prefer recent material (${new Date().getFullYear() - 2}–${new Date().getFullYear()}), unless a classic resource is still canonical.

Return STRICT JSON ONLY:
{
  "references": [
    {
      "title": "Exact title",
      "url": "https://...",
      "source": "Organization or site name",
      "year": 2025,
      "relevance": "high" | "medium",
      "description": "1-sentence explanation of what this source is useful for"
    }
  ]
}
`.trim();

  let selectedRefs: ValidatedReference[] = [];
  try {
    const responseText = await callStructuredModel(aiClient, model, systemPrompt, userPrompt);
    const parsed = safeJsonParse<{ references: ValidatedReference[] }>(responseText, {
      references: [],
    });
    selectedRefs = parsed.references || [];
    onProgress?.(`Selected ${selectedRefs.length} candidate references…`);
  } catch (error) {
    console.error('Reference selection error', error);
  }

  // HEAD-check / GET-validate URLs
  const validated: ValidatedReference[] = [];
  for (const ref of selectedRefs) {
    if (!ref.url) continue;

    try {
      const res = await fetchWithProxies(ref.url, { method: 'HEAD', redirect: 'follow' });

      if (res.ok || res.status === 405 || res.status === 403) {
        validated.push({
          ...ref,
          status: 'valid',
          statusCode: res.status,
        });
      }
    } catch {
      // Try a lightweight GET as a fallback
      try {
        const res = await fetchWithProxies(ref.url, {
          method: 'GET',
          redirect: 'follow',
        });
        if (res.ok) {
          validated.push({
            ...ref,
            status: 'valid',
            statusCode: res.status,
          });
        }
      } catch {
        // ignore invalid
      }
    }
  }

  onProgress?.(`Validated ${validated.length} working references.`);
  return validated.slice(0, 12);
}

/**
 * Render references into a styled HTML block at the end of the article.
 */
export function generateReferencesHtml(references: ValidatedReference[]): string {
  if (!references.length) return '';

  const year = new Date().getFullYear();

  const items = references
    .map((ref) => {
      const safeTitle = escapeHtml(ref.title || ref.url);
      const safeUrl = escapeHtml(ref.url);
      const safeSource = escapeHtml(ref.source || '');
      const safeDesc = escapeHtml(ref.description || '');
      const yearLabel = ref.year || year;

      return `
      <li class="reference-item">
        <a href="${safeUrl}" rel="noopener noreferrer" target="_blank">
          <span class="reference-title">${safeTitle}</span>
        </a>
        ${safeSource ? `<span class="reference-source"> – ${safeSource}</span>` : ''}
        <span class="reference-meta"> (${yearLabel})</span>
        ${safeDesc ? `<div class="reference-desc">${safeDesc}</div>` : ''}
      </li>`.trim();
    })
    .join('\n');

  return `
<section class="references">
  <h2>References</h2>
  <p>These sources were selected for relevance, authority, and recency for this topic.</p>
  <ol class="reference-list">
    ${items}
  </ol>
</section>
`.trim();
}

/**
 * Extract existing <img> and YouTube <iframe> tags from a chunk of HTML.
 */
export function extractExistingImages(htmlContent: string): string[] {
  if (!htmlContent) return [];
  const images: string[] = [];

  const imgRegex = /<img[^>]*src=["']?([^"'>\s]+)[^>]*>/gi;
  const iframeRegex = /<iframe[^>]*src=["']?([^"'>\s]+)[^>]*><\/iframe>/gi;

  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    images.push(match[0]);
  }

  while ((match = iframeRegex.exec(htmlContent)) !== null) {
    const src = match[1] || '';
    if (src.includes('youtube.com') || src.includes('youtu.be')) {
      images.push(match[0]);
    }
  }

  return images;
}

/**
 * Re-inject preserved images into refreshed content at natural breakpoints.
 */
export function injectImagesIntoContent(
  content: string,
  existingImages: string[]
): string {
  if (!existingImages.length) return content;

  const paragraphs = content.split(/(<\/p>)/i);
  if (paragraphs.length < 3) {
    return `${existingImages.join('\n')}\n\n${content}`;
  }

  const injected: string[] = [];
  let imageIndex = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    injected.push(paragraphs[i]);

    const isParagraphClose = paragraphs[i].toLowerCase() === '</p>';
    const isGoodSpot = i > 2 && i % 4 === 0;

    if (isParagraphClose && isGoodSpot && imageIndex < existingImages.length) {
      injected.push(`\n${existingImages[imageIndex++]}\n`);
    }
  }

  // If we still have images left, append them at the end
  while (imageIndex < existingImages.length) {
    injected.push(`\n${existingImages[imageIndex++]}\n`);
  }

  return injected.join('');
}

/**
 * Generate internal link suggestions based on existing pages.
 */
export function generateOptimalInternalLinks(
  content: string,
  existingPages: SitemapPage[],
  targetCount: number
): InternalLinkSuggestion[] {
  if (!existingPages.length || targetCount <= 0) return [];

  const suggestions: InternalLinkSuggestion[] = [];
  const bodyText = content.replace(/<[^>]+>/g, ' ').toLowerCase();

  for (const page of existingPages) {
    if (!page.title || !page.slug) continue;

    const keywords = page.title
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 4);

    const anchor = keywords.join(' ');
    if (!anchor) continue;

    if (bodyText.includes(anchor.toLowerCase())) {
      suggestions.push({
        anchorText: anchor,
        targetSlug: `/${page.slug}`,
        context: 'Body reference to related guide',
        placement: 'body',
      });
    }

    if (suggestions.length >= targetCount) break;
  }

  return suggestions;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

async function callStructuredModel(
  aiClient: any,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  // Gemini simple mode:
  if (model.toLowerCase().includes('gemini')) {
    const result = await aiClient.generateContent({
      contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
    });
    return result.response.text();
  }

  // OpenAI-style:
  if (aiClient.chat?.completions) {
    const completion = await aiClient.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.2,
    });
    return completion.choices[0]?.message?.content ?? '';
  }

  // Anthropic-style:
  const message = await aiClient.messages.create({
    model,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.2,
  });

  const first = message.content?.[0];
  // @ts-ignore
  return typeof first === 'string' ? first : first?.text ?? '';
}

function safeJsonParse<T>(input: string, fallback: T): T {
  if (!input || typeof input !== 'string') return fallback;

  try {
    // Try plain parse first
    return JSON.parse(input) as T;
  } catch {
    // Try to extract the first {...} block
    const match = input.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return fallback;
    }
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
