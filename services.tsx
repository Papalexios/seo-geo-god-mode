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
        if (!response.ok) return null;
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const apiLink = doc.querySelector('link[rel="https://api.w.org/"]');
        if (apiLink) {
            const href = apiLink.getAttribute('href');
            if (href) {
                const match = href.match(/\/(\d+)$/);
                if (match) return { id: parseInt(match[1]), endpoint: href };
            }
        }
        return null;
    } catch (e) { return null; }
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

            let discovered = null;
            if (itemToPublish.originalUrl) {
                discovered = await discoverPostIdAndEndpoint(itemToPublish.originalUrl);
            }

            if (discovered) {
                existingPostId = discovered.id;
                if (discovered.endpoint) apiUrl = discovered.endpoint;
                else apiUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/posts/${existingPostId}`;
            }

            if (!existingPostId && generatedContent.slug) {
                 const searchRes = await fetcher(`${wpConfig.url}/wp-json/wp/v2/posts?slug=${generatedContent.slug}&_fields=id&status=any`, { method: 'GET', headers: { 'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}` } });
                 const searchData = await searchRes.json();
                 if (Array.isArray(searchData) && searchData.length > 0) {
                     existingPostId = searchData[0].id;
                     apiUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/posts/${existingPostId}`;
                 }
            }

            if (!existingPostId) {
                 return { success: false, message: `Could not find original post.` };
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

    // 🚀 ULTRA GOD MODE: INTELLIGENT SURGICAL OPTIMIZER
    private async optimizeDOMSurgically(page: SitemapPage, context: GenerationContext) {
        const { wpConfig, apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel, serperApiKey } = context;
        this.logCallback(`🎯 Target: ${page.title} | Age: ${page.daysOld || 'Unknown'} days`);

        let rawContent = await this.fetchRawContent(page, wpConfig);
        if (!rawContent || rawContent.length < 300) {
            this.logCallback(`❌ Content too short (${rawContent?.length || 0} chars). Skipping.`);
            localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString());
            return;
        }

        // 1. INTELLIGENT PRE-ANALYSIS - Determine if update is actually needed
        this.logCallback(`🔬 Running pre-analysis scan...`);
        const needsUpdate = this.intelligentUpdateCheck(rawContent, page);

        if (!needsUpdate.shouldUpdate) {
            this.logCallback(`✅ Content fresh. Reason: ${needsUpdate.reason}. Skipping.`);
            localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString());
            return;
        }

        this.logCallback(`⚡ Update justified: ${needsUpdate.reason}`);

        // 2. PARSE HTML
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawContent, 'text/html');
        const body = doc.body;

        // 3. SCHEMA INJECTION (SOTA Enhancement)
        const hasSchema = rawContent.includes('application/ld+json');
        let schemaInjected = false;
        if (!hasSchema) {
            this.logCallback("📊 Injecting structured data schema...");
            const schemaMarkup = generateSchemaMarkup(
                generateFullSchema(normalizeGeneratedContent({}, page.title), wpConfig, context.siteInfo)
            );
            const schemaScript = doc.createElement('script');
            schemaScript.type = 'application/ld+json';
            schemaScript.textContent = schemaMarkup.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] || '';
            body.appendChild(schemaScript);
            schemaInjected = true;
        }

        // 4. INTELLIGENT NODE SELECTION (Priority-Based)
        const textNodes = Array.from(body.querySelectorAll('p, li, h2, h3, h4'));
        const priorityNodes = textNodes.filter(node => {
            if (node.closest('figure, .wp-block-image, .wp-block-embed')) return false;
            if (node.querySelector('img, iframe, video, svg')) return false;
            if (node.textContent?.trim().length < 20) return false; // Skip tiny fragments

            const text = node.textContent?.toLowerCase() || '';
            const priority =
                text.includes('2023') || text.includes('2024') ? 10 : // Outdated dates = high priority
                node.tagName === 'H2' || node.tagName === 'H3' ? 8 : // Headers = high value
                text.length > 200 ? 6 : // Long paragraphs = good targets
                3; // Default priority

            return priority >= 5; // Only process high-priority nodes
        });

        this.logCallback(`📍 Identified ${priorityNodes.length} high-priority nodes for enhancement`);

        // 5. FETCH SEMANTIC KEYWORDS FOR CONTEXT
        let semanticKeywords: string[] = [];
        try {
            const keywordResponse = await memoizedCallAI(
                apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                'semantic_keyword_generator',
                [page.title, geoTargeting.enabled ? geoTargeting.location : null],
                'json'
            );
            const parsed = JSON.parse(keywordResponse);
            semanticKeywords = (parsed.semanticKeywords || []).map((k: any) => typeof k === 'object' ? k.keyword : k);
            this.logCallback(`🔑 Loaded ${semanticKeywords.length} semantic keywords`);
        } catch (e) {
            this.logCallback(`⚠️ Keyword fetch failed, proceeding without`);
        }

        // 6. BATCH PROCESSING WITH INTELLIGENT CACHING
        const BATCH_SIZE = 5; // Larger batches for efficiency
        let changesMade = 0;
        const MAX_NODES = 25; // Limit to avoid over-processing
        const nodesToProcess = priorityNodes.slice(0, MAX_NODES);

        for (let i = 0; i < nodesToProcess.length; i += BATCH_SIZE) {
            const batch = nodesToProcess.slice(i, i + BATCH_SIZE);
            const batchText = batch.map(n => n.outerHTML).join('\n\n');

            this.logCallback(`⚡ Batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(nodesToProcess.length/BATCH_SIZE)}`);

            try {
                const improvedBatchHtml = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'dom_content_polisher',
                    [batchText, semanticKeywords],
                    'html'
                );

                const cleanBatch = surgicalSanitizer(improvedBatchHtml);

                // VALIDATION: Only apply if structure matches
                if (cleanBatch && cleanBatch.length > 20) {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = cleanBatch;

                    if (tempDiv.childElementCount === batch.length) {
                        batch.forEach((node, index) => {
                            const newNode = tempDiv.children[index];
                            if (newNode && node.tagName === newNode.tagName) {
                                const oldText = node.textContent || '';
                                const newText = newNode.textContent || '';

                                // CHANGE DETECTION: Only update if meaningful difference
                                const changeRatio = Math.abs(newText.length - oldText.length) / Math.max(oldText.length, 1);
                                if (changeRatio > 0.05 || oldText !== newText) { // 5% difference threshold
                                    node.innerHTML = newNode.innerHTML;
                                    changesMade++;
                                }
                            }
                        });
                    }
                }
            } catch (e: any) {
                this.logCallback(`⚠️ Batch error: ${e.message}`);
            }
            await delay(600); // Rate limiting
        }

        // 7. SMART PUBLISHING DECISION
        const significantChanges = changesMade > 0 || schemaInjected;

        if (significantChanges) {
            this.logCallback(`💾 Publishing ${changesMade} enhancements + Schema...`);
            const updatedHtml = body.innerHTML;

            const publishResult = await publishItemToWordPress(
                {
                    id: page.id, title: page.title, type: 'refresh', status: 'generating', statusText: 'Updating',
                    generatedContent: {
                        ...normalizeGeneratedContent({}, page.title),
                        content: updatedHtml,
                        slug: page.slug,
                        isFullSurgicalRewrite: true,
                        surgicalSnippets: undefined
                    },
                    crawledContent: null, originalUrl: page.id
                },
                localStorage.getItem('wpPassword') || '', 'publish', fetchWordPressWithRetry, wpConfig
            );

            if (publishResult.success) {
                this.logCallback(`✅ SUCCESS|${page.title}|${publishResult.link || page.id}`);
                localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString());
            } else {
                this.logCallback(`❌ Publish failed: ${publishResult.message}`);
            }
        } else {
            this.logCallback("✓ No actionable improvements found. Content is optimized.");
            localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString());
        }
    }

    // 🧠 INTELLIGENT UPDATE CHECKER - Determines if content actually needs updating
    private intelligentUpdateCheck(content: string, page: SitemapPage): { shouldUpdate: boolean, reason: string } {
        const text = content.toLowerCase();
        const currentYear = new Date().getFullYear();

        // Check 1: Contains very recent year mentions (probably fresh)
        if (text.includes(String(currentYear)) || text.includes(String(currentYear + 1))) {
            const yearMentions = (text.match(new RegExp(String(currentYear), 'g')) || []).length;
            if (yearMentions >= 2) {
                return { shouldUpdate: false, reason: `Already ${currentYear}-fresh (${yearMentions} mentions)` };
            }
        }

        // Check 2: Has outdated year mentions (needs update)
        const outdatedYears = [currentYear - 1, currentYear - 2, currentYear - 3];
        for (const year of outdatedYears) {
            if (text.includes(String(year))) {
                return { shouldUpdate: true, reason: `Contains outdated year ${year}` };
            }
        }

        // Check 3: Content age priority
        if (page.daysOld && page.daysOld > 180) {
            return { shouldUpdate: true, reason: `Content is ${page.daysOld} days old` };
        }

        // Check 4: Missing structured data
        if (!content.includes('application/ld+json')) {
            return { shouldUpdate: true, reason: 'Missing schema markup' };
        }

        // Check 5: Short content (probably thin)
        const wordCount = content.split(/\s+/).length;
        if (wordCount < 800) {
            return { shouldUpdate: true, reason: `Thin content (${wordCount} words)` };
        }

        // Default: Skip if nothing triggers update
        return { shouldUpdate: false, reason: 'Content appears current and optimized' };
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