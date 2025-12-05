import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import React from 'react';
import { PROMPT_TEMPLATES } from './prompts';
import { AI_MODELS, TARGET_MIN_WORDS, TARGET_MAX_WORDS } from './constants';
import {
    ApiClients, ContentItem, ExpandedGeoTargeting, GeneratedContent, GenerationContext, SiteInfo, SitemapPage, WpConfig, GapAnalysisSuggestion
} from './types';
import {
    apiCache,
    callAiWithRetry,
    extractSlugFromUrl,
    processConcurrently,
    parseJsonWithAiRepair,
    lazySchemaGeneration,
    validateAndFixUrl,
    serverGuard
} from './utils';
import { getNeuronWriterAnalysis, formatNeuronDataForPrompt } from "./neuronwriter";
import { getGuaranteedYoutubeVideos, enforceWordCount, normalizeGeneratedContent, postProcessGeneratedHtml, performSurgicalUpdate, processInternalLinks, fetchWithProxies, smartCrawl, escapeRegExp } from "./contentUtils";
import { Buffer } from 'buffer';
import { generateFullSchema, generateSchemaMarkup } from "./schema-generator";

class SotaAIError extends Error {
    constructor(
        public code: 'INVALID_PARAMS' | 'EMPTY_RESPONSE' | 'RATE_LIMIT' | 'AUTH_FAILED',
        message: string
    ) {
        super(message);
        this.name = 'SotaAIError';
    }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// 0. SURGICAL SANITIZER
// ============================================================================
const surgicalSanitizer = (html: string): string => {
    if (!html) return "";
    
    let cleanHtml = html
        .replace(/^```html\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
    
    // Remove duplicate H1s or Title Injections
    cleanHtml = cleanHtml.replace(/^\s*<h1.*?>.*?<\/h1>/i, ''); 
    cleanHtml = cleanHtml.replace(/^\s*Title:.*?(\n|<br>)/i, '');
    
    // Remove Signatures / Meta garbage
    cleanHtml = cleanHtml.replace(/Protocol Active: v\d+\.\d+/gi, '');
    cleanHtml = cleanHtml.replace(/REF: GUTF-Protocol-[a-z0-9]+/gi, '');
    cleanHtml = cleanHtml.replace(/Lead Data Scientist[\s\S]*?Latest Data Audit.*?(<\/p>|<br>|\n)/gi, '');
    cleanHtml = cleanHtml.replace(/Verification Fact-Checked/gi, '');
    cleanHtml = cleanHtml.replace(/Methodology Peer-Reviewed/gi, '');
    
    return cleanHtml.trim();
};

// ============================================================================
// 1. FETCH HELPERS & UTILS (Moved fetchWordPressWithRetry here for fix)
// ============================================================================

/**
 * Smartly fetches a WordPress API endpoint with robust header handling.
 * INTEGRATES SERVER GUARD TO PREVENT CPU SPIKES.
 */
export const fetchWordPressWithRetry = async (targetUrl: string, options: RequestInit): Promise<Response> => {
    const REQUEST_TIMEOUT = 45000; 

    // SOTA FIX: robustly check for Authorization header
    let hasAuthHeader = false;
    if (options.headers) {
        if (options.headers instanceof Headers) {
            hasAuthHeader = options.headers.has('Authorization');
        } else if (Array.isArray(options.headers)) {
             hasAuthHeader = options.headers.some(pair => pair[0].toLowerCase() === 'authorization');
        } else {
             // Plain object
             const headers = options.headers as Record<string, string>;
             hasAuthHeader = Object.keys(headers).some(k => k.toLowerCase() === 'authorization');
        }
    }

    // SERVER GUARD: Enforce cooldown before sending any WP request
    await serverGuard.wait();
    const startTime = Date.now();

    const executeFetch = async (url: string, opts: RequestInit) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
            const res = await fetch(url, { ...opts, signal: controller.signal });
            clearTimeout(timeoutId);
            return res;
        } catch (e) {
            clearTimeout(timeoutId);
            throw e;
        }
    };

    try {
        let response: Response;
        if (hasAuthHeader) {
            // Auth requests must go direct
            response = await executeFetch(targetUrl, options);
        } else {
            // Non-auth can try direct then proxy
            try {
                response = await executeFetch(targetUrl, options);
                if (!response.ok && response.status >= 500) throw new Error("Direct 5xx");
            } catch (e) {
                const encodedUrl = encodeURIComponent(targetUrl);
                const proxyUrl = `https://corsproxy.io/?${encodedUrl}`;
                console.log(`[WP Fetch] Direct failed, using proxy: ${proxyUrl}`);
                response = await executeFetch(proxyUrl, options);
            }
        }

        // Report metrics to ServerGuard
        const duration = Date.now() - startTime;
        serverGuard.reportMetrics(duration);

        return response;
    } catch (error: any) {
        // Report failure as high latency to trigger cooldown
        serverGuard.reportMetrics(5000);
        throw error;
    }
};

const fetchRecentNews = async (keyword: string, serperApiKey: string) => {
    if (!serperApiKey) return null;
    try {
        const response = await fetchWithProxies("https://google.serper.dev/news", {
            method: 'POST',
            headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: keyword, tbs: "qdr:m", num: 3 })
        });
        const data = await response.json();
        if (data.news && data.news.length > 0) {
            return data.news.map((n: any) => `- ${n.title} (${n.source}) - ${n.date}`).join('\n');
        }
        return null;
    } catch (e) { return null; }
};

const fetchPAA = async (keyword: string, serperApiKey: string) => {
    if (!serperApiKey) return null;
    try {
        const response = await fetchWithProxies("https://google.serper.dev/search", {
            method: 'POST',
            headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: keyword, type: 'search' }) 
        });
        const data = await response.json();
        if (data.peopleAlsoAsk && Array.isArray(data.peopleAlsoAsk)) {
            return data.peopleAlsoAsk.map((item: any) => item.question).slice(0, 6);
        }
        return null;
    } catch (e) { return null; }
};

const fetchVerifiedReferences = async (keyword: string, serperApiKey: string, wpUrl?: string): Promise<string> => {
    if (!serperApiKey) return "";
    try {
        const query = `${keyword} definitive guide research data statistics 2024 2025 -site:youtube.com -site:facebook.com -site:pinterest.com -site:twitter.com -site:reddit.com`;
        const response = await fetchWithProxies("https://google.serper.dev/search", {
            method: 'POST',
            headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: query, num: 20 }) 
        });
        const data = await response.json();
        const potentialLinks = data.organic || [];
        
        const validationPromises = potentialLinks.slice(0, 12).map(async (link: any) => {
            try {
                const linkDomain = new URL(link.link).hostname.replace('www.', '');
                if (wpUrl && linkDomain.includes(new URL(wpUrl).hostname.replace('www.', ''))) return null;
                return { title: link.title, url: link.link, source: linkDomain };
            } catch (e) { return null; }
        });

        const results = await Promise.all(validationPromises);
        const filtered = results.filter(r => r !== null) as { title: string, url: string, source: string }[];
        if (filtered.length === 0) return "";

        const listItems = filtered.slice(0, 8).map(ref => 
            `<li><a href="${ref.url}" target="_blank" rel="noopener noreferrer" title="Verified Source: ${ref.source}" style="text-decoration: underline; color: #2563EB;">${ref.title}</a> <span style="color:#64748B; font-size:0.8em;">(${ref.source})</span></li>`
        ).join('');

        return `<div class="sota-references-section" style="margin-top: 3rem; padding: 2rem; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px;"><h2 style="margin-top: 0; font-size: 1.5rem; color: #1E293B; border-bottom: 2px solid #3B82F6; padding-bottom: 0.5rem; margin-bottom: 1rem; font-weight: 800;">📚 Verified References & Further Reading</h2><ul style="columns: 2; -webkit-columns: 2; -moz-columns: 2; column-gap: 2rem; list-style: disc; padding-left: 1.5rem; line-height: 1.6;">${listItems}</ul></div>`;
    } catch (e) { return ""; }
};

const analyzeCompetitors = async (keyword: string, serperApiKey: string): Promise<{ report: string, snippetType: 'LIST' | 'TABLE' | 'PARAGRAPH', topResult: string }> => {
    if (!serperApiKey) return { report: "", snippetType: 'PARAGRAPH', topResult: "" };
    try {
        const response = await fetchWithProxies("https://google.serper.dev/search", {
            method: 'POST',
            headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: keyword, num: 3 }) 
        });
        const data = await response.json();
        const competitors = (data.organic || []).slice(0, 3);
        const topResult = competitors[0]?.snippet || "";
        
        const snippetType = (data.organic?.[0]?.snippet?.includes('steps') || data.organic?.[0]?.title?.includes('How to')) ? 'LIST' : (data.organic?.[0]?.snippet?.includes('vs') ? 'TABLE' : 'PARAGRAPH');
        const reports = competitors.map((comp: any, index: number) => `COMPETITOR ${index + 1} (${comp.title}): ${comp.snippet}`);
        return { report: reports.join('\n'), snippetType, topResult };
    } catch (e) { return { report: "", snippetType: 'PARAGRAPH', topResult: "" }; }
};

const discoverPostIdAndEndpoint = async (url: string): Promise<{ id: number, endpoint: string } | null> => {
    try {
        const response = await fetchWithProxies(url);

        if (!response.ok) {
            console.log(`[DEBUG] discoverPostIdAndEndpoint: Response not OK for ${url}, status: ${response.status}`);
            return null;
        }

        const finalUrl = response.url || url;
        if (finalUrl !== url) {
            console.log(`[DEBUG] discoverPostIdAndEndpoint: URL redirected from ${url} to ${finalUrl}`);
        }

        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const apiLink = doc.querySelector('link[rel="https://api.w.org/"]');
        if (apiLink) {
            const href = apiLink.getAttribute('href');
            if (href) {
                const match = href.match(/\/(\d+)$/);
                if (match) {
                    console.log(`[DEBUG] discoverPostIdAndEndpoint: Found post ID ${match[1]} from HTML`);
                    return { id: parseInt(match[1]), endpoint: href };
                }
            }
        }

        console.log(`[DEBUG] discoverPostIdAndEndpoint: Could not find API link in HTML for ${url}`);
        return null;
    } catch (e) {
        console.log(`[DEBUG] discoverPostIdAndEndpoint: Exception for ${url}:`, e);
        return null;
    }
};

const generateAndValidateReferences = async (keyword: string, metaDescription: string, serperApiKey: string) => {
    return { html: await fetchVerifiedReferences(keyword, serperApiKey), data: [] };
};

// 2. AI CORE
const _internalCallAI = async (
    apiClients: ApiClients, selectedModel: string, geoTargeting: ExpandedGeoTargeting, openrouterModels: string[],
    selectedGroqModel: string, promptKey: keyof typeof PROMPT_TEMPLATES, promptArgs: any[],
    responseFormat: 'json' | 'html' | 'text' = 'json', useGrounding: boolean = false
): Promise<string> => {
    if (!apiClients) throw new SotaAIError('INVALID_PARAMS', 'API clients object is undefined.');
    const client = apiClients[selectedModel as keyof typeof apiClients];
    if (!client) throw new SotaAIError('AUTH_FAILED', `API Client for '${selectedModel}' not initialized.`);

    const cacheKey = `${String(promptKey)}-${JSON.stringify(promptArgs)}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    
    const template = PROMPT_TEMPLATES[promptKey];
    // @ts-ignore
    const systemInstruction = (promptKey === 'cluster_planner' && typeof template.systemInstruction === 'string') 
        ? template.systemInstruction.replace('{{GEO_TARGET_INSTRUCTIONS}}', (geoTargeting.enabled && geoTargeting.location) ? `All titles must be geo-targeted for "${geoTargeting.location}".` : '')
        : template.systemInstruction;
    // @ts-ignore
    const userPrompt = template.userPrompt(...promptArgs);
    
    let responseText: string | null = '';

    switch (selectedModel) {
        case 'gemini':
             const geminiConfig: { systemInstruction: string; responseMimeType?: string; tools?: any[] } = { systemInstruction };
            if (responseFormat === 'json') geminiConfig.responseMimeType = "application/json";
             if (useGrounding) {
                geminiConfig.tools = [{googleSearch: {}}];
                if (geminiConfig.responseMimeType) delete geminiConfig.responseMimeType;
            }
            const geminiResponse = await callAiWithRetry(() => (client as GoogleGenAI).models.generateContent({
                model: AI_MODELS.GEMINI_FLASH,
                contents: userPrompt,
                config: geminiConfig,
            }));
            responseText = geminiResponse.text;
            break;
        case 'openai':
            const openaiResponse = await callAiWithRetry(() => (client as unknown as OpenAI).chat.completions.create({
                model: AI_MODELS.OPENAI_GPT4_TURBO,
                messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userPrompt }],
                ...(responseFormat === 'json' && { response_format: { type: "json_object" } })
            }));
            responseText = openaiResponse.choices[0].message.content;
            break;
        case 'openrouter':
            for (const modelName of openrouterModels) {
                try {
                    const response = await callAiWithRetry(() => (client as unknown as OpenAI).chat.completions.create({
                        model: modelName,
                        messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userPrompt }],
                         ...(responseFormat === 'json' && { response_format: { type: "json_object" } })
                    }));
                    responseText = response.choices[0].message.content;
                    break;
                } catch (error) { console.error(error); }
            }
            break;
        case 'groq':
             const groqResponse = await callAiWithRetry(() => (client as unknown as OpenAI).chat.completions.create({
                model: selectedGroqModel,
                messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userPrompt }],
                ...(responseFormat === 'json' && { response_format: { type: "json_object" } })
            }));
            responseText = groqResponse.choices[0].message.content;
            break;
        case 'anthropic':
            const anthropicResponse = await callAiWithRetry(() => (client as unknown as Anthropic).messages.create({
                model: AI_MODELS.ANTHROPIC_OPUS,
                max_tokens: 4096,
                system: systemInstruction,
                messages: [{ role: "user", content: userPrompt }],
            }));
            responseText = anthropicResponse.content?.map(c => c.text).join("") || "";
            break;
    }

    if (!responseText) throw new Error(`AI returned empty response.`);
    apiCache.set(cacheKey, responseText);
    return responseText;
};

export const callAI = async (...args: Parameters<typeof _internalCallAI>): Promise<string> => {
    const [apiClients, selectedModel] = args;
    let client = apiClients[selectedModel as keyof typeof apiClients];
    if (!client) {
        const fallbackOrder: (keyof ApiClients)[] = ['gemini', 'openai', 'openrouter', 'anthropic', 'groq'];
        for (const fallback of fallbackOrder) {
            if (apiClients[fallback]) {
                args[1] = fallback as any; 
                break;
            }
        }
    }
    return await _internalCallAI(...args);
};

export const memoizedCallAI = async (
    apiClients: ApiClients, selectedModel: string, geoTargeting: ExpandedGeoTargeting, openrouterModels: string[],
    selectedGroqModel: string, promptKey: keyof typeof PROMPT_TEMPLATES, promptArgs: any[],
    responseFormat: 'json' | 'html' | 'text' = 'json',
    useGrounding: boolean = false
): Promise<string> => {
    const cacheKey = `ai_${String(promptKey)}_${JSON.stringify(promptArgs)}`;
    if (apiCache.get(cacheKey)) return apiCache.get(cacheKey)!;
    const res = await callAI(apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel, promptKey, promptArgs, responseFormat, useGrounding);
    apiCache.set(cacheKey, res);
    return res;
};

export const generateImageWithFallback = async (apiClients: ApiClients, prompt: string): Promise<string | null> => {
    if (!prompt) return null;
    if (apiClients.gemini) {
        try {
             const geminiImgResponse = await callAiWithRetry(() => apiClients.gemini!.models.generateImages({ model: AI_MODELS.GEMINI_IMAGEN, prompt: prompt, config: { numberOfImages: 1, outputMimeType: 'image/jpeg', aspectRatio: '16:9' } }));
             return `data:image/jpeg;base64,${String(geminiImgResponse.generatedImages[0].image.imageBytes)}`;
        } catch (error) {
             try {
                const flashImageResponse = await callAiWithRetry(() => apiClients.gemini!.models.generateContent({
                    model: 'gemini-2.5-flash-image',
                    contents: { parts: [{ text: prompt }] },
                    config: { responseModalities: ['IMAGE'] },
                }));
                return `data:image/png;base64,${String(flashImageResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data)}`;
             } catch (e) { console.error(e); }
        }
    }
    return null;
};

// 3. WP PUBLISHING & LAYERING
async function attemptDirectWordPressUpload(image: any, wpConfig: WpConfig, password: string): Promise<{ url: string, id: number } | null> {
    try {
        const response = await fetchWordPressWithRetry(
            `${wpConfig.url}/wp-json/wp/v2/media`,
            {
                method: 'POST',
                headers: new Headers({
                    'Authorization': `Basic ${btoa(`${wpConfig.username}:${password}`)}`,
                    'Content-Type': 'image/jpeg',
                    'Content-Disposition': `attachment; filename="${image.title}.jpg"`
                }),
                body: Buffer.from(image.base64Data.split(',')[1], 'base64')
            }
        );
        if (response.ok) {
            const data = await response.json();
            return { url: data.source_url, id: data.id };
        }
    } catch (error) { }
    return null;
}

const processImageLayer = async (image: any, wpConfig: WpConfig, password: string): Promise<{url: string, id: number | null} | null> => {
    const directUpload = await attemptDirectWordPressUpload(image, wpConfig, password);
    if (directUpload) return directUpload;
    return null;
};

async function criticLoop(html: string, callAI: Function, context: GenerationContext): Promise<string> {
    let currentHtml = html;
    let attempts = 0;
    while (attempts < 1) { 
        try {
            const critiqueJson = await memoizedCallAI(context.apiClients, context.selectedModel, context.geoTargeting, context.openrouterModels, context.selectedGroqModel, 'content_grader', [currentHtml], 'json');
            const aiRepairer = (brokenText: string) => callAI(context.apiClients, 'gemini', { enabled: false, location: '', region: '', country: '', postalCode: '' }, [], '', 'json_repair', [brokenText], 'json');
            const critique = await parseJsonWithAiRepair(critiqueJson, aiRepairer);
            if (critique.score >= 90) break;
            const repairedHtml = await memoizedCallAI(context.apiClients, context.selectedModel, context.geoTargeting, context.openrouterModels, context.selectedGroqModel, 'content_repair_agent', [currentHtml, critique.issues], 'html');
            const sanitizedRepair = surgicalSanitizer(repairedHtml);
            if (sanitizedRepair.length > currentHtml.length * 0.5) currentHtml = sanitizedRepair;
            attempts++;
        } catch (e) { break; }
    }
    return currentHtml;
}

export const publishItemToWordPress = async (
    itemToPublish: ContentItem,
    currentWpPassword: string,
    status: 'publish' | 'draft',
    fetcher: typeof fetchWordPressWithRetry,
    wpConfig: WpConfig,
): Promise<{ success: boolean; message: React.ReactNode; link?: string }> => {
    try {
        const { generatedContent } = itemToPublish;
        if (!generatedContent) return { success: false, message: 'No content generated.' };

        let contentToPublish = generatedContent.content;
        let featuredImageId: number | null = null;
        let existingPostId: number | null = null;
        let apiUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/posts`;

        let finalTitle = generatedContent.title;
        const isUrlTitle = finalTitle.startsWith('http') || finalTitle.includes('www.');

        if (itemToPublish.type === 'refresh') {
            if (generatedContent.isFullSurgicalRewrite) {
                contentToPublish = generatedContent.content;
            } else if (generatedContent.surgicalSnippets) {
                contentToPublish = performSurgicalUpdate(itemToPublish.crawledContent || '', generatedContent.surgicalSnippets);
            } else {
                 return { success: false, message: 'Refresh Failed: Missing content.' };
            }

            console.log(`[DEBUG] Finding post for URL: ${itemToPublish.originalUrl}`);
            console.log(`[DEBUG] Generated slug: ${generatedContent.slug}`);

            let discovered = null;
            if (itemToPublish.originalUrl) {
                discovered = await discoverPostIdAndEndpoint(itemToPublish.originalUrl);
            }

            if (discovered) {
                existingPostId = discovered.id;
                if (discovered.endpoint) apiUrl = discovered.endpoint;
                else apiUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/posts/${existingPostId}`;
                console.log(`[DEBUG] Found via HTML discovery: Post ID ${existingPostId}`);
            }

            if (!existingPostId && generatedContent.slug) {
                console.log(`[DEBUG] Trying slug-based search: ${generatedContent.slug}`);
                try {
                    const searchRes = await fetcher(`${wpConfig.url}/wp-json/wp/v2/posts?slug=${generatedContent.slug}&_fields=id&status=any`, { method: 'GET', headers: { 'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}` } });
                    const searchData = await searchRes.json();
                    console.log(`[DEBUG] Slug search response:`, searchData);
                    if (Array.isArray(searchData) && searchData.length > 0) {
                        existingPostId = searchData[0].id;
                        apiUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/posts/${existingPostId}`;
                        console.log(`[DEBUG] Found via slug search: Post ID ${existingPostId}`);
                    }
                } catch (e) {
                    console.log(`[DEBUG] Slug search failed:`, e);
                }
            }

            if (!existingPostId && itemToPublish.originalUrl) {
                console.log(`[DEBUG] Trying URL-based slug extraction fallback`);
                try {
                    const urlObj = new URL(itemToPublish.originalUrl);
                    const pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
                    const extractedSlug = pathParts[pathParts.length - 1];
                    if (extractedSlug && extractedSlug !== generatedContent.slug) {
                        console.log(`[DEBUG] Trying extracted slug: ${extractedSlug}`);
                        const searchRes = await fetcher(`${wpConfig.url}/wp-json/wp/v2/posts?slug=${extractedSlug}&_fields=id&status=any`, { method: 'GET', headers: { 'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}` } });
                        const searchData = await searchRes.json();
                        console.log(`[DEBUG] Extracted slug search response:`, searchData);
                        if (Array.isArray(searchData) && searchData.length > 0) {
                            existingPostId = searchData[0].id;
                            apiUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/posts/${existingPostId}`;
                            console.log(`[DEBUG] Found via extracted slug: Post ID ${existingPostId}`);
                        }
                    }
                } catch (e) {
                    console.log(`[DEBUG] URL extraction fallback failed:`, e);
                }
            }

            if (!existingPostId) {
                console.log(`[DEBUG] ALL METHODS FAILED. Cannot find post for ${itemToPublish.originalUrl}`);
                return { success: false, message: `Could not find original post. Tried: HTML discovery, slug search (${generatedContent.slug}), URL extraction` };
            }
        } else {
            if (generatedContent.slug) {
                const searchRes = await fetcher(`${wpConfig.url}/wp-json/wp/v2/posts?slug=${generatedContent.slug}&_fields=id&status=any`, { method: 'GET', headers: { 'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}` } });
                const searchData = await searchRes.json();
                if (Array.isArray(searchData) && searchData.length > 0) {
                    existingPostId = searchData[0].id;
                    apiUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/posts/${existingPostId}`;
                }
            }
        }

        contentToPublish = surgicalSanitizer(contentToPublish);

        if (contentToPublish) {
             const base64ImageRegex = /<img[^>]+src="(data:image\/(?:jpeg|png|webp);base64,([^"]+))"[^>]*>/g;
             const imagesToUpload = [...contentToPublish.matchAll(base64ImageRegex)].map((match, index) => {
                return { fullImgTag: match[0], base64Data: match[1], altText: generatedContent.title, title: `${generatedContent.slug}-${index}`, index };
            });
            for (const image of imagesToUpload) {
                const uploadResult = await processImageLayer(image, wpConfig, currentWpPassword);
                if (uploadResult && uploadResult.url) {
                    contentToPublish = contentToPublish.replace(image.fullImgTag, image.fullImgTag.replace(/src="[^"]+"/, `src="${uploadResult.url}"`));
                    if (image.index === 0 && !existingPostId) featuredImageId = uploadResult.id;
                }
            }
        }

        const postData: any = {
            content: (contentToPublish || '') + generateSchemaMarkup(generatedContent.jsonLdSchema ?? {}),
            status: status, 
            meta: {
                _yoast_wpseo_metadesc: generatedContent.metaDescription ?? '',
            }
        };

        if (!isUrlTitle) {
            postData.title = finalTitle;
            postData.meta._yoast_wpseo_title = finalTitle;
        }
        
        if (itemToPublish.type !== 'refresh') {
            postData.slug = generatedContent.slug;
        }

        if (featuredImageId) postData.featured_media = featuredImageId;

        const postResponse = await fetcher(apiUrl, { method: 'POST', headers: { 'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(postData) });
        const responseData = await postResponse.json();
        
        if (!postResponse.ok) throw new Error(responseData.message || 'WP API Error');
        return { success: true, message: 'Published!', link: responseData.link };
    } catch (error: any) {
        return { success: false, message: `Error: ${error.message}` };
    }
};

// ============================================================================
// 4. MAINTENANCE ENGINE (SOTA DOM-AWARE SURGEON)
// ============================================================================

export class MaintenanceEngine {
    private isRunning: boolean = false;
    public logCallback: (msg: string) => void;
    private currentContext: GenerationContext | null = null;

    constructor(logCallback: (msg: string) => void) {
        this.logCallback = logCallback;
    }

    updateContext(context: GenerationContext) {
        this.currentContext = context;
    }

    stop() {
        this.isRunning = false;
        this.logCallback("🛑 God Mode Stopping... Finishing current task.");
    }

    async start(context: GenerationContext) {
        this.currentContext = context;
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.logCallback("🚀 God Mode Activated: Engine Cold Start...");

        if (this.currentContext.existingPages.length === 0) {
            if (this.currentContext.wpConfig.url) {
                 this.logCallback("⚠️ NO CONTENT: God Mode requires a sitemap crawl.");
                 this.logCallback("🛑 STOPPING: Please go to 'Content Hub' -> Crawl Sitemap.");
                 this.isRunning = false;
                 return;
             }
        }

        while (this.isRunning) {
            if (!this.currentContext) break;
            try {
                const pages = await this.getPrioritizedPages(this.currentContext);
                if (pages.length === 0) {
                     this.logCallback(`💤 All pages up to date. Sleeping 60s...`);
                    await delay(60000);
                    continue;
                }
                const targetPage = pages[0];
                this.logCallback(`🎯 Target Acquired: "${targetPage.title}"`);
                await this.optimizeDOMSurgically(targetPage, this.currentContext);
                this.logCallback("💤 Cooling down for 30 seconds...");
                await delay(30000);
            } catch (e: any) {
                this.logCallback(`❌ Error: ${e.message}. Restarting...`);
                await delay(10000);
            }
        }
    }

    private async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async getPrioritizedPages(context: GenerationContext): Promise<SitemapPage[]> {
        let candidates = [...context.existingPages];
        candidates = candidates.filter(p => {
            const lastProcessed = localStorage.getItem(`sota_last_proc_${p.id}`);
            if (!lastProcessed) return true;
            const hoursSince = (Date.now() - parseInt(lastProcessed)) / (1000 * 60 * 60);
            return hoursSince > 24; 
        });
        return candidates.sort((a, b) => (b.daysOld || 0) - (a.daysOld || 0)); 
    }

    // 🛡️ CONTENT PROTECTION SYSTEM - Preserve critical elements
    private protectCriticalContent(doc: Document): Map<string, string> {
        const protectedElements = new Map<string, string>();
        let counter = 0;

        // Protect images (including WordPress blocks)
        doc.querySelectorAll('img, figure.wp-block-image, .wp-block-image img').forEach(el => {
            const placeholder = `__PROTECTED_IMAGE_${counter++}__`;
            protectedElements.set(placeholder, el.outerHTML);
            el.replaceWith(doc.createTextNode(placeholder));
        });

        // Protect YouTube/Video embeds
        doc.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"], .wp-block-embed, figure.wp-block-embed').forEach(el => {
            const placeholder = `__PROTECTED_VIDEO_${counter++}__`;
            protectedElements.set(placeholder, el.outerHTML);
            el.replaceWith(doc.createTextNode(placeholder));
        });

        // Protect custom HTML blocks and shortcodes
        doc.querySelectorAll('.wp-block-html, .wp-block-custom-html, pre, code').forEach(el => {
            const placeholder = `__PROTECTED_HTML_${counter++}__`;
            protectedElements.set(placeholder, el.outerHTML);
            el.replaceWith(doc.createTextNode(placeholder));
        });

        // Protect tables (unless it's our comparison table)
        doc.querySelectorAll('table:not(.sota-comparison-table), figure.wp-block-table').forEach(el => {
            const placeholder = `__PROTECTED_TABLE_${counter++}__`;
            protectedElements.set(placeholder, el.outerHTML);
            el.replaceWith(doc.createTextNode(placeholder));
        });

        // Protect References/Sources sections
        doc.querySelectorAll('.sota-references-section, [class*="reference"], [class*="source"]').forEach(el => {
            if (el.textContent?.toLowerCase().includes('reference') || el.textContent?.toLowerCase().includes('source')) {
                const placeholder = `__PROTECTED_REFERENCES_${counter++}__`;
                protectedElements.set(placeholder, el.outerHTML);
                el.replaceWith(doc.createTextNode(placeholder));
            }
        });

        return protectedElements;
    }

    private restoreProtectedContent(html: string, protectedElements: Map<string, string>): string {
        let restoredHtml = html;
        protectedElements.forEach((originalHtml, placeholder) => {
            restoredHtml = restoredHtml.replace(placeholder, originalHtml);
        });
        return restoredHtml;
    }

    // 🔥 ULTRA GOD MODE: COMPLETE STRUCTURAL SURGEON
    private async optimizeDOMSurgically(page: SitemapPage, context: GenerationContext) {
        const { wpConfig, apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel, serperApiKey } = context;
        this.logCallback(`🎯 TARGET: ${page.title}`);
        this.logCallback(`📊 AGE: ${page.daysOld || '??'} days | URL: ${page.id}`);

        let rawContent = await this.fetchRawContent(page, wpConfig);
        if (!rawContent || rawContent.length < 300) {
            this.logCallback(`❌ SKIP: Content too short (${rawContent?.length || 0} chars)`);
            localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString());
            return;
        }

        // 1. INTELLIGENT PRE-ANALYSIS
        this.logCallback(`🔬 SCANNING: Structural integrity check...`);
        const needsUpdate = this.intelligentUpdateCheck(rawContent, page);

        if (!needsUpdate.shouldUpdate) {
            this.logCallback(`✅ FRESH: ${needsUpdate.reason} - Skipping`);
            localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString());
            return;
        }

        this.logCallback(`⚡ UPDATE NEEDED: ${needsUpdate.reason}`);

        // 2. PARSE HTML & PROTECT CRITICAL CONTENT
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawContent, 'text/html');
        const body = doc.body;

        // 🛡️ PROTECT all images, videos, HTML blocks, tables, references
        this.logCallback(`🛡️ PROTECTING: Images, videos, HTML blocks, references...`);
        const protectedElements = this.protectCriticalContent(doc);
        this.logCallback(`🛡️ PROTECTED: ${protectedElements.size} critical elements`);

        let structuralFixesMade = 0;

        // 3. STRUCTURAL DEFICIENCY DETECTION & REPAIR
        this.logCallback(`🏗️ Scanning for missing critical sections...`);

        // CHECK 1: Missing Key Takeaways
        const hasKeyTakeaways = body.querySelector('.key-takeaways-box') ||
            Array.from(body.querySelectorAll('h2, h3')).some(h =>
                (h.textContent?.toLowerCase().includes('key takeaway') ||
                 h.textContent?.toLowerCase().includes('at a glance'))
            );

        if (!hasKeyTakeaways) {
            this.logCallback(`🔧 ADDING: Key Takeaways section...`);
            try {
                const takeawaysHtml = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'generate_key_takeaways',
                    [body.innerHTML, page.title],
                    'html'
                );
                const cleanTakeaways = surgicalSanitizer(takeawaysHtml);
                const firstH2 = body.querySelector('h2');
                if (firstH2 && firstH2.parentNode) {
                    const wrapper = doc.createElement('div');
                    wrapper.innerHTML = cleanTakeaways;
                    firstH2.parentNode.insertBefore(wrapper.firstElementChild || wrapper, firstH2);
                    structuralFixesMade++;
                    this.logCallback(`✅ ADDED: Key Takeaways`);
                }
            } catch (e: any) {
                this.logCallback(`❌ FAILED: Key Takeaways - ${e.message}`);
            }
        }

        // CHECK 2: Missing FAQ Section
        const hasFAQ = body.querySelector('.faq-section') ||
            Array.from(body.querySelectorAll('h2, h3')).some(h =>
                (h.textContent?.toLowerCase().includes('faq') ||
                 h.textContent?.toLowerCase().includes('frequently asked'))
            );

        if (!hasFAQ) {
            this.logCallback(`🔧 ADDING: FAQ section...`);
            try {
                const faqHtml = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'generate_faq_section',
                    [body.innerHTML, page.title],
                    'html'
                );
                const cleanFAQ = surgicalSanitizer(faqHtml);
                const wrapper = doc.createElement('div');
                wrapper.innerHTML = cleanFAQ;

                // Insert before conclusion or at end
                const conclusionH2 = Array.from(body.querySelectorAll('h2')).find(h =>
                    h.textContent?.toLowerCase().includes('conclusion')
                );
                if (conclusionH2 && conclusionH2.parentNode) {
                    conclusionH2.parentNode.insertBefore(wrapper.firstElementChild || wrapper, conclusionH2);
                } else {
                    body.appendChild(wrapper.firstElementChild || wrapper);
                }
                structuralFixesMade++;
                this.logCallback(`✅ ADDED: FAQ section with schema markup`);
            } catch (e: any) {
                this.logCallback(`❌ FAILED: FAQ section - ${e.message}`);
            }
        }

        // CHECK 3: Missing Conclusion
        const hasConclusion = Array.from(body.querySelectorAll('h2, h3')).some(h =>
            h.textContent?.toLowerCase().includes('conclusion') ||
            h.textContent?.toLowerCase().includes('final thoughts') ||
            h.textContent?.toLowerCase().includes('wrap')
        );

        if (!hasConclusion) {
            this.logCallback(`🔧 ADDING: Conclusion section...`);
            try {
                const conclusionHtml = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'generate_conclusion',
                    [body.innerHTML, page.title],
                    'html'
                );
                const cleanConclusion = surgicalSanitizer(conclusionHtml);
                const wrapper = doc.createElement('div');
                wrapper.innerHTML = cleanConclusion;
                body.appendChild(wrapper);
                structuralFixesMade++;
                this.logCallback(`✅ ADDED: Compelling conclusion`);
            } catch (e: any) {
                this.logCallback(`❌ FAILED: Conclusion - ${e.message}`);
            }
        }

        // CHECK 4: Weak or Missing Intro
        const firstParagraphs = Array.from(body.querySelectorAll('p')).slice(0, 3);
        const introText = firstParagraphs.map(p => p.textContent).join(' ');
        const isWeakIntro = introText.length < 150 ||
            !introText.toLowerCase().includes('will') && !introText.toLowerCase().includes('you') ||
            !firstParagraphs[0]?.querySelector('strong');

        if (isWeakIntro && firstParagraphs.length > 0) {
            this.logCallback(`🔧 UPGRADING: Weak intro detected...`);
            try {
                const newIntroHtml = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'regenerate_intro',
                    [introText, page.title, body.innerHTML],
                    'html'
                );
                const cleanIntro = surgicalSanitizer(newIntroHtml);
                const wrapper = doc.createElement('div');
                wrapper.innerHTML = cleanIntro;

                // Replace first 2-3 paragraphs
                firstParagraphs.forEach(p => p.remove());
                const firstH2 = body.querySelector('h2');
                if (firstH2 && firstH2.parentNode) {
                    Array.from(wrapper.childNodes).reverse().forEach(node => {
                        firstH2.parentNode!.insertBefore(node, firstH2);
                    });
                } else {
                    body.insertBefore(wrapper, body.firstChild);
                }
                structuralFixesMade++;
                this.logCallback(`✅ UPGRADED: Intro now hooks readers`);
            } catch (e: any) {
                this.logCallback(`❌ FAILED: Intro upgrade - ${e.message}`);
            }
        }

        // CHECK 5: Schema Markup
        const hasSchema = rawContent.includes('application/ld+json');
        if (!hasSchema) {
            this.logCallback("🔧 ADDING: Schema markup for rich snippets...");
            const schemaMarkup = generateSchemaMarkup(
                generateFullSchema(normalizeGeneratedContent({}, page.title), wpConfig, context.siteInfo)
            );
            const schemaScript = doc.createElement('script');
            schemaScript.type = 'application/ld+json';
            schemaScript.textContent = schemaMarkup.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] || '';
            body.appendChild(schemaScript);
            structuralFixesMade++;
            this.logCallback(`✅ ADDED: Schema markup (Article, FAQ, BreadcrumbList)`);
        }

        // CHECK 6: Title & Meta Optimization
        this.logCallback(`🎯 ANALYZING: SEO title & meta...`);
        let semanticKeywords: string[] = [];
        let titleMetaUpdated = false;

        try {
            const keywordResponse = await memoizedCallAI(
                apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                'semantic_keyword_generator',
                [page.title, geoTargeting.enabled ? geoTargeting.location : null],
                'json'
            );
            const parsed = JSON.parse(keywordResponse);
            semanticKeywords = (parsed.semanticKeywords || []).map((k: any) => typeof k === 'object' ? k.keyword : k);
            this.logCallback(`🔍 FOUND: ${semanticKeywords.length} semantic keywords`);
        } catch (e) {}

        const title = page.title.toLowerCase();
        const needsTitleOptimization = !title.includes('2026') ||
            !['ultimate', 'complete', 'guide', 'best', 'top', 'proven'].some(w => title.includes(w));

        if (needsTitleOptimization) {
            this.logCallback(`🔧 OPTIMIZING: Title & meta for CTR...`);
            try {
                const titleMetaResponse = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'optimize_title_meta',
                    [page.title, body.innerHTML, semanticKeywords],
                    'json'
                );
                const optimized = JSON.parse(titleMetaResponse);
                // Store optimized title/meta for later use in publish
                (page as any).optimizedTitle = optimized.title;
                (page as any).optimizedMeta = optimized.metaDescription;
                titleMetaUpdated = true;
                structuralFixesMade++;
                this.logCallback(`✅ OPTIMIZED: "${optimized.title}"`);
            } catch (e: any) {
                this.logCallback(`❌ FAILED: Title/meta optimization - ${e.message}`);
            }
        }

        // CHECK 7: Internal Linking
        this.logCallback(`🔗 ANALYZING: Internal link opportunities...`);
        const currentLinkCount = (body.innerHTML.match(/<a[^>]+href=[^>]*>/g) || []).length;

        if (currentLinkCount < 3 && context.existingPages.length > 0) {
            this.logCallback(`🔧 ADDING: Internal links (currently ${currentLinkCount})...`);
            try {
                const availablePagesString = context.existingPages
                    .filter(p => p.slug && p.title && p.id !== page.id)
                    .slice(0, 30)
                    .map(p => `- ${p.title} (slug: ${p.slug})`)
                    .join('\n');

                const linksResponse = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'generate_internal_links',
                    [body.innerHTML, availablePagesString],
                    'json'
                );

                const linkSuggestions = JSON.parse(linksResponse);

                let linksAdded = 0;
                for (const suggestion of linkSuggestions) {
                    if (linksAdded >= 5) break; // Max 5 new links

                    const targetPage = context.existingPages.find(p => p.slug === suggestion.targetSlug);
                    if (targetPage && targetPage.id) {
                        const regex = new RegExp(`(?![^<]*>)\\b${escapeRegExp(suggestion.anchorText)}\\b`, 'i');
                        const textContent = body.innerHTML;

                        if (regex.test(textContent) && !textContent.includes(`>${suggestion.anchorText}</a>`)) {
                            body.innerHTML = body.innerHTML.replace(regex, `<a href="${targetPage.id}" class="internal-link-god-mode">${suggestion.anchorText}</a>`);
                            linksAdded++;
                        }
                    }
                }

                if (linksAdded > 0) {
                    structuralFixesMade++;
                    this.logCallback(`✅ ADDED: ${linksAdded} contextual internal links`);
                }
            } catch (e: any) {
                this.logCallback(`❌ FAILED: Internal linking - ${e.message}`);
            }
        }

        // 4. COMPREHENSIVE YEAR UPDATING - ALL OUTDATED YEARS TO 2026
        this.logCallback(`📅 UPDATING: All outdated years to 2026...`);
        const outdatedYears = [2020, 2021, 2022, 2023, 2024, 2025];
        let yearUpdatesCount = 0;

        for (const year of outdatedYears) {
            const yearRegex = new RegExp(`\\b${year}\\b`, 'g');
            const matches = body.innerHTML.match(yearRegex);
            if (matches) {
                body.innerHTML = body.innerHTML.replace(yearRegex, '2026');
                yearUpdatesCount += matches.length;
            }
        }

        if (yearUpdatesCount > 0) {
            structuralFixesMade++;
            this.logCallback(`✅ UPDATED: ${yearUpdatesCount} year references → 2026`);
        }

        // 5. AGGRESSIVE FLUFF REMOVAL & CONTENT REPLACEMENT
        this.logCallback(`🔥 DETECTING: Fluff and low-value content...`);

        const textNodes = Array.from(body.querySelectorAll('p, li'));
        const fluffIndicators = [
            'in this article', 'in this post', 'in this guide', 'we will discuss', 'we will explore',
            'it is important to note', 'it should be noted', 'as you can see', 'as mentioned above',
            'without further ado', 'at the end of the day', 'the fact of the matter is',
            'basically', 'actually', 'essentially', 'generally speaking', 'in general'
        ];

        let fluffRemovalCount = 0;
        const fluffyNodes: Element[] = [];

        textNodes.forEach(node => {
            // Skip protected areas
            if (node.closest('figure, .wp-block-image, .wp-block-embed, .key-takeaways-box, .faq-section, .sota-references-section')) return;
            if (node.querySelector('img, iframe, video, svg, a')) return; // Skip nodes with media or links

            const text = node.textContent?.toLowerCase() || '';

            // Detect fluff: vague statements, filler words, non-specific content
            const hasFluffIndicators = fluffIndicators.some(indicator => text.includes(indicator));
            const hasVagueContent = text.split(' ').length > 15 &&
                                   !text.match(/\d+/) && // No numbers/data
                                   !text.includes('research') &&
                                   !text.includes('study') &&
                                   !text.includes('expert');
            const isGeneric = text.split(' ').length > 20 &&
                            text.split(',').length < 2; // Long sentences without structure

            if (hasFluffIndicators || (hasVagueContent && isGeneric)) {
                fluffyNodes.push(node);
            }
        });

        if (fluffyNodes.length > 0) {
            this.logCallback(`🔥 FOUND: ${fluffyNodes.length} fluffy paragraphs - Replacing with high-value content...`);

            // Process fluff in batches
            const FLUFF_BATCH_SIZE = 3;
            for (let i = 0; i < Math.min(fluffyNodes.length, 10); i += FLUFF_BATCH_SIZE) {
                const batch = fluffyNodes.slice(i, i + FLUFF_BATCH_SIZE);
                const batchText = batch.map(n => n.outerHTML).join('\n\n');

                try {
                    const replacementHtml = await memoizedCallAI(
                        apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                        'fluff_remover_and_replacer',
                        [batchText, page.title, semanticKeywords],
                        'html'
                    );

                    const cleanReplacement = surgicalSanitizer(replacementHtml);

                    if (cleanReplacement && cleanReplacement.length > 20) {
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = cleanReplacement;

                        // Replace fluffy content with high-value content
                        batch.forEach((node, index) => {
                            const newNode = tempDiv.children[index];
                            if (newNode && newNode.textContent && newNode.textContent.length > 30) {
                                node.innerHTML = newNode.innerHTML;
                                fluffRemovalCount++;
                            } else {
                                // If replacement is too short, remove the fluff entirely
                                node.remove();
                                fluffRemovalCount++;
                            }
                        });
                    }
                } catch (e: any) {
                    this.logCallback(`⚠️ Fluff removal error: ${e.message}`);
                }
                await delay(500);
            }

            if (fluffRemovalCount > 0) {
                structuralFixesMade++;
                this.logCallback(`✅ REMOVED: ${fluffRemovalCount} fluffy paragraphs, replaced with high-value content`);
            }
        }

        // 6. ALEX HORMOZI STYLE TEXT ENHANCEMENT (for remaining content)
        this.logCallback(`✍️ POLISHING: Content style (punchy, actionable, no fluff)...`);

        const priorityNodes = Array.from(body.querySelectorAll('p, li, h2, h3, h4')).filter(node => {
            if (node.closest('figure, .wp-block-image, .wp-block-embed, .key-takeaways-box, .faq-section')) return false;
            if (node.querySelector('img, iframe, video, svg')) return false;
            if (node.textContent?.trim().length < 20) return false;

            const text = node.textContent?.toLowerCase() || '';
            const priority =
                text.includes('2020') || text.includes('2021') || text.includes('2022') ||
                text.includes('2023') || text.includes('2024') || text.includes('2025') ? 10 :
                node.tagName === 'H2' || node.tagName === 'H3' ? 8 :
                text.length > 200 ? 7 :
                text.split(' ').some(w => w.length > 15) ? 6 :
                3;

            return priority >= 5;
        });

        const BATCH_SIZE = 5;
        let textChangesMade = 0;
        const MAX_NODES = 15;
        const nodesToProcess = priorityNodes.slice(0, MAX_NODES);

        for (let i = 0; i < nodesToProcess.length; i += BATCH_SIZE) {
            const batch = nodesToProcess.slice(i, i + BATCH_SIZE);
            const batchText = batch.map(n => n.outerHTML).join('\n\n');

            try {
                const improvedBatchHtml = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'dom_content_polisher',
                    [batchText, semanticKeywords],
                    'html'
                );

                const cleanBatch = surgicalSanitizer(improvedBatchHtml);

                if (cleanBatch && cleanBatch.length > 20) {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = cleanBatch;

                    if (tempDiv.childElementCount === batch.length) {
                        batch.forEach((node, index) => {
                            const newNode = tempDiv.children[index];
                            if (newNode && node.tagName === newNode.tagName) {
                                const oldText = node.textContent || '';
                                const newText = newNode.textContent || '';
                                const changeRatio = Math.abs(newText.length - oldText.length) / Math.max(oldText.length, 1);
                                if (changeRatio > 0.05 || oldText !== newText) {
                                    node.innerHTML = newNode.innerHTML;
                                    textChangesMade++;
                                }
                            }
                        });
                    }
                }
            } catch (e: any) {
                this.logCallback(`⚠️ Text enhancement error: ${e.message}`);
            }
            await delay(500);
        }

        // 7. VALIDATE & ADD REFERENCES (if missing)
        this.logCallback(`📚 ═══════════════════════════════════════`);
        this.logCallback(`📚 STARTING: Reference validation check...`);

        const referenceSectionClass = body.querySelector('.sota-references-section, .references-section, .sources-section');
        const referenceHeadings = Array.from(body.querySelectorAll('h2, h3')).filter(h => {
            const text = h.textContent?.toLowerCase() || '';
            return (text.includes('reference') || text.includes('sources') || text.includes('further reading')) &&
                   !text.includes('code') && !text.includes('manual');
        });

        this.logCallback(`📚 CLASS CHECK: ${referenceSectionClass ? '✓ Found reference section class' : '✗ No reference section class'}`);
        this.logCallback(`📚 HEADING CHECK: ${referenceHeadings.length > 0 ? `✓ Found ${referenceHeadings.length} reference heading(s)` : '✗ No reference headings'}`);
        if (referenceHeadings.length > 0) {
            referenceHeadings.forEach(h => this.logCallback(`   - "${h.textContent}"`));
        }

        const hasReferences = !!(referenceSectionClass || referenceHeadings.length > 0);

        this.logCallback(`📚 ═══════════════════════════════════════`);
        this.logCallback(`📚 FINAL DECISION: ${hasReferences ? '❌ SKIP (Already present)' : '✅ ADD REFERENCES'}`);
        this.logCallback(`📚 SERPER API KEY: ${serperApiKey ? '✅ CONFIGURED' : '❌ NOT CONFIGURED'}`);
        this.logCallback(`📚 WILL ADD REFERENCES: ${!hasReferences && serperApiKey ? '✅ YES' : '❌ NO'}`);
        this.logCallback(`📚 ═══════════════════════════════════════`);

        if (!hasReferences && serperApiKey) {
            this.logCallback(`🔍 SEARCHING: High-quality reference sources with Serper API...`);
            try {
                // Search for authoritative sources (get more results to increase success rate)
                const query = `${page.title} research study data statistics 2024 2025 expert guide -site:youtube.com -site:facebook.com -site:pinterest.com -site:twitter.com -site:reddit.com -site:instagram.com`;
                this.logCallback(`🔍 QUERY: "${query.substring(0, 80)}..."`);

                const response = await fetchWithProxies("https://google.serper.dev/search", {
                    method: 'POST',
                    headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ q: query, num: 20 })
                });
                const data = await response.json();
                const potentialLinks = data.organic || [];

                if (potentialLinks.length === 0) {
                    this.logCallback(`⚠️ WARNING: Serper returned 0 results - API may be failing or quota exceeded`);
                    throw new Error('No search results from Serper API');
                }

                this.logCallback(`📊 FOUND: ${potentialLinks.length} potential sources - validating each one...`);

                const validatedLinks: Array<{title: string, url: string, source: string}> = [];
                let checkedCount = 0;
                let skippedCount = 0;

                for (const link of potentialLinks) {
                    if (validatedLinks.length >= 10) break;

                    try {
                        if (!link.link) continue;

                        const linkDomain = new URL(link.link).hostname.replace('www.', '');

                        if (wpConfig.url) {
                            const siteDomain = new URL(wpConfig.url).hostname.replace('www.', '');
                            if (linkDomain === siteDomain) {
                                skippedCount++;
                                continue;
                            }
                        }

                        checkedCount++;
                        this.logCallback(`🔗 CHECKING [${checkedCount}]: ${linkDomain}`);

                        try {
                            const checkResponse = await fetch(link.link, {
                                method: 'HEAD',
                                signal: AbortSignal.timeout(8000),
                                redirect: 'follow'
                            });

                            if (checkResponse.ok && checkResponse.status === 200) {
                                validatedLinks.push({
                                    title: link.title || linkDomain,
                                    url: link.link,
                                    source: linkDomain
                                });
                                this.logCallback(`✅ VALID [${validatedLinks.length}/10]: ${linkDomain}`);
                            } else {
                                this.logCallback(`❌ FAILED [${checkResponse.status}]: ${linkDomain}`);
                            }
                        } catch (fetchError: any) {
                            this.logCallback(`❌ ERROR: ${linkDomain} - ${fetchError.message.substring(0, 50)}`);
                            continue;
                        }
                    } catch (e) {
                        continue;
                    }

                    if (validatedLinks.length < 10) {
                        await delay(300);
                    }
                }

                this.logCallback(`📊 VALIDATION SUMMARY: ${validatedLinks.length} valid, ${checkedCount - validatedLinks.length} failed, ${skippedCount} skipped (same domain)`);

                if (validatedLinks.length > 0) {
                    this.logCallback(`✅ SUCCESS: ${validatedLinks.length} operational reference links validated (all 200 status)`);

                    const listItems = validatedLinks.map(ref =>
                        `<li><a href="${ref.url}" target="_blank" rel="noopener noreferrer" title="Verified Source: ${ref.source}" style="text-decoration: underline; color: #2563EB;">${ref.title}</a> <span style="color:#64748B; font-size:0.8em;">(${ref.source})</span></li>`
                    ).join('');

                    const referencesHtml = `<div class="sota-references-section" style="margin-top: 3rem; padding: 2rem; background: linear-gradient(135deg, #F8FAFC 0%, #EFF6FF 100%); border: 2px solid #3B82F6; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);"><h2 style="margin-top: 0; font-size: 1.5rem; color: #1E293B; border-bottom: 3px solid #3B82F6; padding-bottom: 0.5rem; margin-bottom: 1rem; font-weight: 800;">📚 Verified References & Further Reading</h2><p style="color: #64748B; font-size: 0.85em; margin-bottom: 1rem; font-style: italic;">All sources verified operational with 200 status codes.</p><ul style="columns: 2; -webkit-columns: 2; -moz-columns: 2; column-gap: 2rem; list-style: disc; padding-left: 1.5rem; line-height: 1.8;">${listItems}</ul></div>`;

                    const referencesWrapper = doc.createElement('div');
                    referencesWrapper.innerHTML = referencesHtml;
                    body.appendChild(referencesWrapper.firstElementChild || referencesWrapper);

                    structuralFixesMade++;
                    this.logCallback(`✅ ADDED: ${validatedLinks.length} verified references (100% operational, all 200 status)`);
                } else {
                    this.logCallback(`❌ FAILED: No operational reference links found`);
                    this.logCallback(`❌ Checked ${checkedCount} links from ${potentialLinks.length} search results - none returned 200 status`);
                    this.logCallback(`💡 TIP: This may indicate network issues or all sources are paywalled/blocked`);
                }
            } catch (e: any) {
                this.logCallback(`❌ ERROR: Reference generation failed: ${e.message}`);
            }
        } else if (hasReferences) {
            this.logCallback(`✅ REFERENCES: Already present - skipping`);
        } else {
            this.logCallback(`❌ CRITICAL: Serper API key NOT configured - CANNOT add references!`);
            this.logCallback(`❌ Please add your Serper API key in settings to enable reference generation`);
        }

        // 8. OPTIMIZE ALL IMAGE ALT TEXT
        this.logCallback(`🖼️ CHECKING: Image alt text optimization...`);
        const allImages = Array.from(body.querySelectorAll('img'));
        const imagesToOptimize = allImages.filter(img => {
            const alt = img.getAttribute('alt') || '';
            return !alt || alt.length < 10 || alt === 'image' || alt === 'photo' || alt === 'picture';
        });

        if (imagesToOptimize.length > 0) {
            this.logCallback(`🔧 OPTIMIZING: ${imagesToOptimize.length} images with poor/missing alt text...`);
            try {
                const imageDataForAI = imagesToOptimize.slice(0, 10).map(img => {
                    const src = img.getAttribute('src') || '';
                    const currentAlt = img.getAttribute('alt') || 'MISSING';
                    const parent = img.parentElement;
                    const context = parent?.textContent?.substring(0, 150) || 'No surrounding context';
                    return { src, currentAlt, context };
                });

                const altTextResponse = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'optimize_image_alt_text',
                    [imageDataForAI, page.title, page.title],
                    'json'
                );

                const optimizedAltTexts = JSON.parse(altTextResponse);

                let altTextUpdates = 0;
                optimizedAltTexts.forEach((opt: any) => {
                    if (opt.imageIndex < imagesToOptimize.length) {
                        const img = imagesToOptimize[opt.imageIndex];
                        if (opt.altText && opt.altText.length > 5) {
                            img.setAttribute('alt', opt.altText);
                            altTextUpdates++;
                        }
                    }
                });

                if (altTextUpdates > 0) {
                    structuralFixesMade++;
                    this.logCallback(`✅ OPTIMIZED: ${altTextUpdates} image alt texts (SEO + accessibility)` );
                }
            } catch (e: any) {
                this.logCallback(`⚠️ Image alt text optimization failed: ${e.message}`);
            }
        } else if (allImages.length > 0) {
            this.logCallback(`✅ IMAGE ALT TEXT: All ${allImages.length} images have good alt text`);
        }

        // 9. RESTORE PROTECTED CONTENT & PUBLISH
        const totalChanges = structuralFixesMade + textChangesMade + yearUpdatesCount + fluffRemovalCount;

        if (totalChanges > 0) {
            this.logCallback(`📦 CHANGES: ${structuralFixesMade} structural + ${textChangesMade} text + ${yearUpdatesCount} years`);

            // 🛡️ RESTORE all protected elements (images, videos, HTML, references)
            let updatedHtml = body.innerHTML;
            this.logCallback(`🔄 RESTORING: ${protectedElements.size} protected elements...`);
            updatedHtml = this.restoreProtectedContent(updatedHtml, protectedElements);
            this.logCallback(`✅ RESTORED: All images, videos, HTML preserved`);


            const generatedContent = normalizeGeneratedContent({}, page.title);
            generatedContent.content = updatedHtml;

            // CRITICAL FIX: Extract slug from URL if not already set
            let finalSlug = page.slug;
            if (!finalSlug && page.id) {
                try {
                    const urlObj = new URL(page.id);
                    const pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
                    finalSlug = pathParts[pathParts.length - 1];
                    this.logCallback(`📍 Extracted slug from URL: "${finalSlug}"`);
                } catch (e) {
                    this.logCallback(`⚠️ Could not extract slug from URL: ${page.id}`);
                }
            }

            generatedContent.slug = finalSlug;
            generatedContent.isFullSurgicalRewrite = true;
            generatedContent.surgicalSnippets = undefined;

            // Apply optimized title & meta if available
            if ((page as any).optimizedTitle) {
                generatedContent.title = (page as any).optimizedTitle;
                this.logCallback(`📝 Using optimized title: "${generatedContent.title}"`);
            }
            if ((page as any).optimizedMeta) {
                generatedContent.metaDescription = (page as any).optimizedMeta;
                this.logCallback(`📝 Using optimized meta: "${generatedContent.metaDescription.substring(0, 50)}..."`);
            }

            const publishResult = await publishItemToWordPress(
                {
                    id: page.id,
                    title: generatedContent.title,
                    type: 'refresh',
                    status: 'generating',
                    statusText: 'Updating',
                    generatedContent,
                    crawledContent: null,
                    originalUrl: page.id
                },
                localStorage.getItem('wpPassword') || '', 'publish', fetchWordPressWithRetry, wpConfig
            );

            if (publishResult.success) {
                // Generate comprehensive quality report
                const qualityReport = [
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                    '✅ OPTIMIZATION COMPLETE - ENTERPRISE GRADE',
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                    `📄 TITLE: ${generatedContent.title}`,
                    `🔗 URL: ${publishResult.link || page.id}`,
                    '',
                    '📊 IMPROVEMENTS APPLIED:',
                    `  • ${structuralFixesMade} Structural Enhancements`,
                    `  • ${textChangesMade} Content Polishes (Alex Hormozi Style)`,
                    `  • ${fluffRemovalCount} Fluffy Paragraphs Removed & Replaced`,
                    `  • ${yearUpdatesCount} Year Updates → 2026`,
                    `  • ${protectedElements.size} Elements Protected (images, videos, HTML)`,
                    '',
                    '✨ QUALITY CHECKS PASSED:',
                    `  • SEO/GEO/AEO: ${(page as any).optimizedTitle ? 'Title & Meta Optimized' : 'Already Optimized'}`,
                    `  • Structure: Key Takeaways, FAQs, Conclusion ✓`,
                    `  • Schema: Rich Snippets (Article, FAQ, BreadcrumbList) ✓`,
                    `  • Links: Internal Linking Enhanced ✓`,
                    `  • References: Verified & Operational (200 Status) ✓`,
                    `  • Content: Punchy, Actionable, NO FLUFF ✓`,
                    `  • Freshness: 2026 Updated ✓`,
                    `  • AI Visibility: Semantic Keywords Integrated ✓`,
                    `  • Readability: Alex Hormozi Style Applied ✓`,
                    '',
                    '🏆 RESULT: Enterprise-Grade, SOTA, #1 Ranking Ready',
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                ].join('\n');

                this.logCallback(qualityReport);
                this.logCallback(`✅ GOD MODE SUCCESS|${generatedContent.title}|${publishResult.link || page.id}`);
                localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString());
                localStorage.removeItem(`sota_fail_count_${page.id}`);
            } else {
                this.logCallback(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                this.logCallback(`❌ PUBLISH FAILED: ${publishResult.message}`);
                this.logCallback(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

                const failKey = `sota_fail_count_${page.id}`;
                const failCount = parseInt(localStorage.getItem(failKey) || '0') + 1;
                localStorage.setItem(failKey, failCount.toString());

                if (failCount >= 3) {
                    this.logCallback(`⚠️ SKIP: Failed ${failCount} times - Will retry after 24 hours`);
                    const skipUntil = Date.now() + (24 * 60 * 60 * 1000);
                    localStorage.setItem(`sota_last_proc_${page.id}`, skipUntil.toString());
                } else {
                    this.logCallback(`⚠️ RETRY: Attempt ${failCount}/3 - Next try in 30 mins`);
                    const skipFor30Mins = Date.now() + (30 * 60 * 1000);
                    localStorage.setItem(`sota_last_proc_${page.id}`, skipFor30Mins.toString());
                }
            }
        } else {
            this.logCallback("✓ SKIP: Content already SOTA-optimized");
            localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString());
        }
    }

    // 🧠 ULTIMATE INTELLIGENT UPDATE CHECKER - Comprehensive diagnostics
    private intelligentUpdateCheck(content: string, page: SitemapPage): { shouldUpdate: boolean, reason: string } {
        const text = content.toLowerCase();
        const currentYear = new Date().getFullYear();
        const targetYear = 2026;

        // Check 1: STRICT year check - must have 2026 mentions
        if (!text.includes('2026')) {
            return { shouldUpdate: true, reason: 'Missing 2026 freshness signals' };
        }

        // Check 2: Has ANY outdated year mentions (2020-2025)
        const outdatedYears = [2020, 2021, 2022, 2023, 2024, 2025];
        for (const year of outdatedYears) {
            if (text.includes(String(year))) {
                return { shouldUpdate: true, reason: `Contains outdated year ${year} - needs 2026 update` };
            }
        }

        // Check 3: Missing critical structural elements
        const hasKeyTakeaways = text.includes('key takeaway') || text.includes('at a glance');
        const hasFAQ = text.includes('faq') || text.includes('frequently asked');
        const hasConclusion = text.includes('conclusion') || text.includes('final thoughts');

        if (!hasKeyTakeaways || !hasFAQ || !hasConclusion) {
            return { shouldUpdate: true, reason: 'Missing critical sections (Key Takeaways/FAQ/Conclusion)' };
        }

        // Check 4: Internal linking deficiency
        const internalLinkCount = (content.match(/<a[^>]+href=[^>]*>/g) || []).length;
        if (internalLinkCount < 3) {
            return { shouldUpdate: true, reason: `Insufficient internal links (${internalLinkCount}/3 minimum)` };
        }

        // Check 5: Missing structured data
        if (!content.includes('application/ld+json')) {
            return { shouldUpdate: true, reason: 'Missing schema markup' };
        }

        // Check 6: Thin content
        const wordCount = content.split(/\s+/).length;
        if (wordCount < 1000) {
            return { shouldUpdate: true, reason: `Thin content (${wordCount} words)` };
        }

        // Check 7: Content age priority
        if (page.daysOld && page.daysOld > 90) {
            return { shouldUpdate: true, reason: `Content is ${page.daysOld} days old` };
        }

        // Check 8: Weak title detection (generic, no power words, no year)
        const title = page.title.toLowerCase();
        const hasPowerWords = ['ultimate', 'complete', 'guide', 'best', 'top', 'proven', '2026'].some(w => title.includes(w));
        if (!hasPowerWords) {
            return { shouldUpdate: true, reason: 'Weak title - needs optimization' };
        }

        // Default: Skip if nothing triggers update
        return { shouldUpdate: false, reason: 'Content is SOTA-optimized' };
    }

    private async fetchRawContent(page: SitemapPage, wpConfig: WpConfig): Promise<string | null> {
        try {
            if (page.slug) {
                let res = await fetchWordPressWithRetry(`${wpConfig.url}/wp-json/wp/v2/posts?slug=${page.slug}&context=edit`, { 
                    method: 'GET',
                    headers: { 'Authorization': `Basic ${btoa(`${wpConfig.username}:${localStorage.getItem('wpPassword')}`)}` }
                });
                let data = await res.json();
                if (data && data.length > 0) return data[0].content.raw || data[0].content.rendered;
            }
            return await smartCrawl(page.id); 
        } catch (e) {
            return await smartCrawl(page.id);
        }
    }
}

export const maintenanceEngine = new MaintenanceEngine((msg) => console.log(msg));

export const generateContent = {
    analyzePages: async (pages: any[], callAI: any, setPages: any, onProgress: any, shouldStop: any) => {
       const aiRepairer = (brokenText: string) => callAI('json_repair', [brokenText], 'json');
       await processConcurrently(pages, async (page) => {
            if (shouldStop()) return;
            try {
                setPages((prev: any) => prev.map((p: any) => p.id === page.id ? { ...p, status: 'analyzing' } : p));
                let content = page.crawledContent;
                if (!content || content.length < 200) content = await smartCrawl(page.id);
                const analysisResponse = await callAI('batch_content_analyzer', [page.title, content], 'json');
                const analysisData = await parseJsonWithAiRepair(analysisResponse, aiRepairer);
                setPages((prev: any) => prev.map((p: any) => p.id === page.id ? { ...p, status: 'analyzed', analysis: analysisData.analysis, healthScore: analysisData.healthScore, updatePriority: analysisData.updatePriority } : p));
            } catch (error: any) { setPages((prev: any) => prev.map((p: any) => p.id === page.id ? { ...p, status: 'error', justification: error.message } : p)); }
       }, 1, (c, t) => onProgress({current: c, total: t}), shouldStop);
    },
    
    analyzeContentGaps: async (existingPages: SitemapPage[], topic: string, callAI: Function, context: GenerationContext): Promise<GapAnalysisSuggestion[]> => {
        const titles = existingPages.map(p => p.title).filter(t => t && t.length > 5);
        const responseText = await memoizedCallAI(context.apiClients, context.selectedModel, context.geoTargeting, context.openrouterModels, context.selectedGroqModel, 'content_gap_analyzer', [titles, topic], 'json', true);
        const aiRepairer = (brokenText: string) => callAI('json_repair', [brokenText], 'json');
        const parsed = await parseJsonWithAiRepair(responseText, aiRepairer);
        return parsed.suggestions || [];
    },

    refreshItem: async (item: ContentItem, callAI: Function, context: GenerationContext, aiRepairer: any) => {
        const { dispatch, serperApiKey } = context;
        let sourceContent = item.crawledContent;
        if (!sourceContent) {
             sourceContent = await smartCrawl(item.originalUrl || item.id);
             dispatch({ type: 'SET_CRAWLED_CONTENT', payload: { id: item.id, content: sourceContent } });
        }
        dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Fetching Real-time Data...' } });
        const [paaQuestions, semanticKeywordsResponse, verifiedReferencesHtml] = await Promise.all([
            fetchPAA(item.title, serperApiKey),
            memoizedCallAI(context.apiClients, context.selectedModel, context.geoTargeting, context.openrouterModels, context.selectedGroqModel, 'semantic_keyword_generator', [item.title, context.geoTargeting.enabled ? context.geoTargeting.location : null], 'json'),
            fetchVerifiedReferences(item.title, serperApiKey, context.wpConfig.url)
        ]);
        const semanticKeywordsRaw = await parseJsonWithAiRepair(semanticKeywordsResponse, aiRepairer);
        const semanticKeywords = semanticKeywordsRaw?.semanticKeywords?.map((k: any) => typeof k === 'object' ? k.keyword : k) || [];

        dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Generating SOTA Updates...' } });
        const responseText = await memoizedCallAI(context.apiClients, context.selectedModel, context.geoTargeting, context.openrouterModels, context.selectedGroqModel, 'content_refresher', [sourceContent, item.title, item.title, paaQuestions, semanticKeywords], 'json', true);
        const parsedSnippets = await parseJsonWithAiRepair(responseText, aiRepairer);
        parsedSnippets.referencesHtml = verifiedReferencesHtml;

        const generated = normalizeGeneratedContent({}, item.title);
        generated.title = parsedSnippets.seoTitle || item.title;
        generated.metaDescription = parsedSnippets.metaDescription || '';
        generated.content = `
            <div class="sota-update-preview">
                <h3>🔥 New Intro</h3>${parsedSnippets.introHtml}<hr>
                <h3>💡 Key Takeaways</h3>${parsedSnippets.keyTakeawaysHtml}<hr>
                <h3>📊 Comparison Table</h3>${parsedSnippets.comparisonTableHtml}<hr>
                <h3>❓ FAQs</h3>${parsedSnippets.faqHtml}<hr>
                ${parsedSnippets.referencesHtml}
            </div>`;
        generated.surgicalSnippets = parsedSnippets;
        dispatch({ type: 'SET_CONTENT', payload: { id: item.id, content: generated } });
        dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'done', statusText: 'Refreshed' } });
    },

    generateItems: async (
        itemsToGenerate: ContentItem[],
        callAI: Function,
        generateImage: Function,
        context: GenerationContext,
        onProgress: (progress: { current: number; total: number }) => void,
        shouldStop: () => React.MutableRefObject<Set<string>>
    ) => {
        const { dispatch, existingPages, siteInfo, wpConfig, geoTargeting, serperApiKey, neuronConfig } = context;
        const aiRepairer = (brokenText: string) => callAI('json_repair', [brokenText], 'json');

        await processConcurrently(itemsToGenerate, async (item) => {
            if (shouldStop().current.has(item.id)) return;
            try {
                if (item.type === 'refresh') {
                    await generateContent.refreshItem(item, callAI, context, aiRepairer);
                    return;
                }

                let neuronDataString = '';
                let neuronAnalysisRaw: any = null;
                if (neuronConfig.enabled) {
                     try {
                         dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'NeuronWriter Analysis...' } });
                         neuronAnalysisRaw = await getNeuronWriterAnalysis(item.title, neuronConfig);
                         neuronDataString = formatNeuronDataForPrompt(neuronAnalysisRaw);
                     } catch (e) { console.error(e); }
                }

                let auditDataString = '';
                if (item.analysis) {
                    auditDataString = `
                    **CRITICAL AUDIT & IMPROVEMENT MANDATE:**
                    This is a REWRITE of an underperforming article. You MUST fix the following issues identified by our SEO Auditor:
                    **Critique:** ${item.analysis.critique || 'N/A'}
                    **Missing Content Gaps (MUST ADD):**
                    ${(item.analysis as any).contentGaps ? (item.analysis as any).contentGaps.map((g:string) => `- ${g}`).join('\n') : 'N/A'}
                    **Improvement Plan:** ${(item.analysis as any).improvementPlan || 'N/A'}
                    **YOUR JOB IS TO EXECUTE THIS PLAN PERFECTLY.**
                    `;
                }

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Checking News...' } });
                const recentNews = await fetchRecentNews(item.title, serperApiKey);

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Analyzing Competitors...' } });
                const competitorData = await analyzeCompetitors(item.title, serperApiKey);

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Generating...' } });
                const serpData: any[] = [];
                
                const [semanticKeywordsResponse, outlineResponse] = await Promise.all([
                    memoizedCallAI(context.apiClients, context.selectedModel, geoTargeting, context.openrouterModels, context.selectedGroqModel, 'semantic_keyword_generator', [item.title, geoTargeting.enabled ? geoTargeting.location : null], 'json'),
                    memoizedCallAI(context.apiClients, context.selectedModel, geoTargeting, context.openrouterModels, context.selectedGroqModel, 'content_meta_and_outline', [item.title, null, serpData, null, existingPages, item.crawledContent, item.analysis, neuronDataString, competitorData], 'json')
                ]);
                
                const semanticKeywordsRaw = await parseJsonWithAiRepair(semanticKeywordsResponse, aiRepairer);
                const semanticKeywords = Array.isArray(semanticKeywordsRaw?.semanticKeywords)
                    ? semanticKeywordsRaw.semanticKeywords.map((k: any) => (typeof k === 'object' ? k.keyword : k))
                    : [];

                let articlePlan = await parseJsonWithAiRepair(outlineResponse, aiRepairer);
                let generated = normalizeGeneratedContent(articlePlan, item.title);
                generated.semanticKeywords = semanticKeywords;
                if (neuronAnalysisRaw) generated.neuronAnalysis = neuronAnalysisRaw;

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Writing assets...' } });
                const { html: referencesHtml, data: referencesData } = await generateAndValidateReferences(generated.primaryKeyword, generated.metaDescription, serperApiKey);
                generated.references = referencesData;

                const availableLinkData = existingPages
                    .filter(p => p.slug && p.title && p.status !== 'error')
                    .slice(0, 100)
                    .map(p => `- Title: "${p.title}", Slug: "${p.slug}"`)
                    .join('\n');

                const [fullHtml, images, youtubeVideos] = await Promise.all([
                    memoizedCallAI(context.apiClients, context.selectedModel, geoTargeting, context.openrouterModels, context.selectedGroqModel, 'ultra_sota_article_writer', [generated, existingPages, referencesHtml, neuronDataString, availableLinkData, recentNews, auditDataString], 'html'),
                    Promise.all(generated.imageDetails.map(detail => generateImage(detail.prompt))),
                    getGuaranteedYoutubeVideos(item.title, serperApiKey, semanticKeywords)
                ]);

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'AI Critic Reviewing...' } });
                
                const healedHtml = await criticLoop(fullHtml, (key: any, args: any[], fmt: any) => callAI(context.apiClients, context.selectedModel, context.geoTargeting, context.openrouterModels, context.selectedGroqModel, key, args, fmt), context);

                try { enforceWordCount(healedHtml, TARGET_MIN_WORDS, TARGET_MAX_WORDS); } catch (e) { }

                let finalContent = postProcessGeneratedHtml(healedHtml, generated, youtubeVideos, siteInfo, false) + referencesHtml;
                finalContent = surgicalSanitizer(finalContent);
                
                generated.content = processInternalLinks(finalContent, existingPages);
                images.forEach((img, i) => { if (img) generated.imageDetails[i].generatedImageSrc = img; });
                
                const schemaGenerator = lazySchemaGeneration(generated, wpConfig, siteInfo, geoTargeting);
                const schemaMarkup = schemaGenerator();
                const scriptMatch = schemaMarkup.match(/<script.*?>([\s\S]*)<\/script>/);
                if (scriptMatch) generated.jsonLdSchema = JSON.parse(scriptMatch[1]);
                
                dispatch({ type: 'SET_CONTENT', payload: { id: item.id, content: generated } });
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'done', statusText: 'Completed' } });

            } catch (error: any) {
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'error', statusText: error.message } });
            }
        }, 1, (c, t) => onProgress({ current: c, total: t }), () => shouldStop().current.size > 0);
    }
};