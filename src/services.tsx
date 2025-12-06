
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
    fetchWordPressWithRetry,
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

const surgicalSanitizer = (html: string): string => {
    if (!html) return "";
    let cleanHtml = html
        .replace(/^```html\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
    cleanHtml = cleanHtml.replace(/^\s*<h1.*?>.*?<\/h1>/i, ''); 
    cleanHtml = cleanHtml.replace(/^\s*\[.*?\]\(.*?\)/, ''); 
    cleanHtml = cleanHtml.replace(/Protocol Active: v\d+\.\d+/gi, '');
    cleanHtml = cleanHtml.replace(/REF: GUTF-Protocol-[a-z0-9]+/gi, '');
    cleanHtml = cleanHtml.replace(/Lead Data Scientist[\s\S]*?Latest Data Audit.*?(<\/p>|<br>|\n)/gi, '');
    cleanHtml = cleanHtml.replace(/Verification Fact-Checked/gi, '');
    return cleanHtml.trim();
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
    let userDomain = "";
    if (wpUrl) { try { userDomain = new URL(wpUrl).hostname.replace('www.', ''); } catch(e) {} }

    try {
        const query = `${keyword} definitive guide research data statistics 2024 2025 -site:youtube.com -site:facebook.com -site:pinterest.com -site:twitter.com -site:reddit.com`;
        const response = await fetchWithProxies("https://google.serper.dev/search", {
            method: 'POST',
            headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: query, num: 20 }) 
        });
        const data = await response.json();
        const potentialLinks = data.organic || [];
        
        const filtered = potentialLinks.slice(0, 10).map((l:any) => ({ title: l.title, url: l.link, source: new URL(l.link).hostname })).filter((l:any) => !l.source.includes(userDomain));
        if (filtered.length === 0) return "";

        const listItems = filtered.slice(0, 8).map((ref:any) => 
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
        // Validate base64 data format
        if (!image.base64Data || typeof image.base64Data !== 'string') {
            console.error('[Image Upload] Invalid base64Data: not a string');
            return null;
        }

        // Extract base64 content (handle both data:image/...;base64,XXX and plain base64)
        let base64Content: string;
        if (image.base64Data.includes(',')) {
            const parts = image.base64Data.split(',');
            if (parts.length < 2 || !parts[1]) {
                console.error('[Image Upload] Invalid base64Data format: comma found but no data after it');
                return null;
            }
            base64Content = parts[1];
        } else {
            base64Content = image.base64Data;
        }

        // Validate base64 content is not empty
        if (!base64Content || base64Content.trim().length === 0) {
            console.error('[Image Upload] Base64 content is empty');
            return null;
        }

        const response = await fetchWordPressWithRetry(
            `${wpConfig.url}/wp-json/wp/v2/media`,
            {
                method: 'POST',
                headers: new Headers({
                    'Authorization': `Basic ${btoa(`${wpConfig.username}:${password}`)}`,
                    'Content-Type': 'image/jpeg',
                    'Content-Disposition': `attachment; filename="${image.title || 'image'}.jpg"`
                }),
                body: Buffer.from(base64Content, 'base64')
            }
        );

        if (response.ok) {
            const data = await response.json();
            if (!data.source_url) {
                console.error('[Image Upload] WordPress returned success but no source_url');
                return null;
            }
            console.log(`[Image Upload] Success: ${data.source_url}`);
            return { url: data.source_url, id: data.id };
        } else {
            const errorText = await response.text();
            console.error(`[Image Upload] WordPress API error (${response.status}): ${errorText}`);
            return null;
        }
    } catch (error: any) {
        console.error('[Image Upload] Exception:', error.message || String(error));
        return null;
    }
}

const processImageLayer = async (image: any, wpConfig: WpConfig, password: string): Promise<{url: string, id: number | null} | null> => {
    const directUpload = await attemptDirectWordPressUpload(image, wpConfig, password);
    if (directUpload) return directUpload;
    return null;
};

async function criticLoop(html: string, callAI: Function, context: GenerationContext): Promise<string> {
    let currentHtml = html;
    let attempts = 0;
    const MAX_ATTEMPTS = 3;

    while (attempts < MAX_ATTEMPTS) {
        try {
            const critiqueJson = await memoizedCallAI(context.apiClients, context.selectedModel, context.geoTargeting, context.openrouterModels, context.selectedGroqModel, 'content_grader', [currentHtml], 'json');
            const aiRepairer = (brokenText: string) => callAI(context.apiClients, 'gemini', { enabled: false, location: '', region: '', country: '', postalCode: '' }, [], '', 'json_repair', [brokenText], 'json');
            const critique = await parseJsonWithAiRepair(critiqueJson, aiRepairer);

            // If score is excellent (>= 90), content is ready
            if (critique.score >= 90) {
                console.log(`[Critic Loop] Content passed with score ${critique.score} on attempt ${attempts + 1}`);
                break;
            }

            console.log(`[Critic Loop] Attempt ${attempts + 1}/${MAX_ATTEMPTS}: Score ${critique.score}, repairing...`);

            const repairedHtml = await memoizedCallAI(context.apiClients, context.selectedModel, context.geoTargeting, context.openrouterModels, context.selectedGroqModel, 'content_repair_agent', [currentHtml, critique.issues], 'html');
            const sanitizedRepair = surgicalSanitizer(repairedHtml);

            // Only accept repair if it's substantial (not truncated)
            if (sanitizedRepair.length > currentHtml.length * 0.5) {
                currentHtml = sanitizedRepair;
                console.log(`[Critic Loop] Repair accepted (${sanitizedRepair.length} chars)`);
            } else {
                console.log(`[Critic Loop] Repair rejected (too short: ${sanitizedRepair.length} chars)`);
                break; // Exit if repair is insufficient
            }

            attempts++;
        } catch (e: any) {
            console.error(`[Critic Loop] Error on attempt ${attempts + 1}:`, e.message);
            break;
        }
    }

    console.log(`[Critic Loop] Final content (${currentHtml.length} chars) after ${attempts} attempts`);
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

        const headers = new Headers({ 
            'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}`,
            'Content-Type': 'application/json'
        });

        let contentToPublish = generatedContent.content;
        let featuredImageId: number | null = null;
        let existingPostId: number | null = null;
        let method = 'POST';
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
                 const searchRes = await fetcher(`${wpConfig.url}/wp-json/wp/v2/posts?slug=${generatedContent.slug}&_fields=id&status=any`, { method: 'GET', headers });
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
                const searchRes = await fetcher(`${wpConfig.url}/wp-json/wp/v2/posts?slug=${generatedContent.slug}&_fields=id&status=any`, { method: 'GET', headers });
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

        const postResponse = await fetcher(apiUrl, { method, headers, body: JSON.stringify(postData) });
        const responseData = await postResponse.json();
        
        if (!postResponse.ok) throw new Error(responseData.message || 'WP API Error');
        return { success: true, message: 'Published!', link: responseData.link };
    } catch (error: any) {
        return { success: false, message: `Error: ${error.message}` };
    }
};

// ============================================================================
// 4. MAINTENANCE ENGINE (SOTA DOM-AWARE SURGEON + SMART SKIP)
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
                    await this.sleep(60000);
                    continue;
                }
                const targetPage = pages[0];
                
                // SOTA SMART SKIP: Check if Last Modified Date is older than our last optimization
                const lastOptimization = localStorage.getItem(`sota_last_proc_${targetPage.id}`);
                const sitemapDate = targetPage.lastMod ? new Date(targetPage.lastMod).getTime() : 0;
                const lastOptDate = lastOptimization ? parseInt(lastOptimization) : 0;

                if (sitemapDate > 0 && lastOptDate > sitemapDate) {
                    this.logCallback(`⏭️ Skipping "${targetPage.title}" - Content unchanged since last optimization.`);
                    localStorage.setItem(`sota_last_proc_${targetPage.id}`, Date.now().toString());
                    continue;
                }

                this.logCallback(`🎯 Target Acquired: "${targetPage.title}"`);
                await this.optimizeDOMSurgically(targetPage, this.currentContext);
                this.logCallback("💤 Cooling down for 10 seconds...");
                await this.sleep(10000);
            } catch (e: any) {
                this.logCallback(`❌ Error: ${e.message}. Restarting...`);
                await this.sleep(10000);
            }
        }
    }

    private async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async getPrioritizedPages(context: GenerationContext): Promise<SitemapPage[]> {
        let candidates = [...context.existingPages];
        
        // Filter out recently processed (within 24h) to avoid loops
        candidates = candidates.filter(p => {
            const lastProcessed = localStorage.getItem(`sota_last_proc_${p.id}`);
            if (!lastProcessed) return true;
            const hoursSince = (Date.now() - parseInt(lastProcessed)) / (1000 * 60 * 60);
            return hoursSince > 24; 
        });

        // Prioritize by age (older = better candidate for update)
        return candidates.sort((a, b) => (b.daysOld || 0) - (a.daysOld || 0)); 
    }

    private async optimizeDOMSurgically(page: SitemapPage, context: GenerationContext) {
        const { wpConfig, apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel } = context;
        this.logCallback(`📥 Fetching LIVE content for: ${page.title}...`);
        
        let rawContent = await this.fetchRawContent(page, wpConfig);
        if (!rawContent || rawContent.length < 500) {
            this.logCallback("❌ Content too short/empty. Skipping.");
            localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString()); 
            return;
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(rawContent, 'text/html');
        const body = doc.body;

        const hasSchema = rawContent.includes('application/ld+json');
        let schemaInjected = false;
        if (!hasSchema) {
            this.logCallback("🔍 No Schema detected. Injecting High-Performance Schema...");
            // We just note it here, the publish function appends it if missing from structure
            schemaInjected = true;
        }

        const textNodes = Array.from(body.querySelectorAll('p, li, h2, h3, h4'));
        const safeNodes = textNodes.filter(node => {
            if (node.closest('figure')) return false; 
            if (node.querySelector('img, iframe, video')) return false; 
            if (node.className.includes('wp-block-image')) return false;
            if (node.textContent?.trim().length === 0) return false;
            return true;
        });

        const BATCH_SIZE = 3; 
        let changesMade = 0;
        const MAX_BATCHES = 15; 

        for (let i = 0; i < Math.min(safeNodes.length, MAX_BATCHES * BATCH_SIZE); i += BATCH_SIZE) {
            const batch = safeNodes.slice(i, i + BATCH_SIZE);
            const batchText = batch.map(n => n.outerHTML).join('\n\n');

            this.logCallback(`⚡ Optimizing Text Batch ${Math.floor(i/BATCH_SIZE) + 1}...`);

            try {
                const improvedBatchHtml = await memoizedCallAI(
                    apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel,
                    'dom_content_polisher', 
                    [batchText, [page.title]], 
                    'html'
                );

                const cleanBatch = surgicalSanitizer(improvedBatchHtml);
                
                if (cleanBatch && cleanBatch.length > 10) {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = cleanBatch;
                    
                    if (tempDiv.childElementCount === batch.length) {
                        batch.forEach((node, index) => {
                            const newNode = tempDiv.children[index];
                            if (newNode && node.tagName === newNode.tagName) {
                                // Only update if significantly different to save DB writes
                                if (node.innerHTML.length !== newNode.innerHTML.length) {
                                    node.innerHTML = newNode.innerHTML;
                                    changesMade++;
                                }
                            }
                        });
                    }
                }
            } catch (e) {
                this.logCallback(`⚠️ AI Glitch on batch. Retrying...`);
            }
            await this.sleep(800);
        }

        if (changesMade > 0 || schemaInjected) {
            this.logCallback(`💾 Saving ${changesMade} surgical updates + Schema...`);
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
                this.logCallback(`❌ Update Failed: ${publishResult.message}`);
            }
        } else {
            this.logCallback("🤷 Content looks good. No safe updates found.");
            localStorage.setItem(`sota_last_proc_${page.id}`, Date.now().toString());
        }
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