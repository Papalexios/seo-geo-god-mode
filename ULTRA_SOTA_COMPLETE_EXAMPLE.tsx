import { buildUltraSOTAPrompt } from './prompts-ultra-sota';
import {
    performCompetitorGapAnalysis,
    generateAndValidateReferences,
    generateReferencesHtml,
    enhanceSemanticKeywords,
    extractExistingImages,
    injectImagesIntoContent,
    generateOptimalInternalLinks,
    type CompetitorGap,
    type ValidatedReference
} from './ultra-sota-services';
import {
    validateContentQuality,
    generateQualityReport,
    validateAndFix,
    type QualityCheckResult
} from './ultra-sota-quality-validator';

export async function generateUltraSOTAContent(
    keyword: string,
    existingPages: any[],
    aiClient: any,
    model: string,
    serperApiKey: string,
    serpData: any[],
    neuronData: string | null = null,
    recentNews: string | null = null,
    onProgress?: (message: string, details?: any) => void
): Promise<{
    content: string;
    semanticKeywords: string[];
    gapAnalysis: any;
    references: ValidatedReference[];
    qualityReport: QualityCheckResult;
    metadata: any;
}> {
    try {
        onProgress?.('🚀 Starting ULTRA SOTA content generation...', { step: 1, total: 8 });

        onProgress?.('🔍 Step 1/8: Enhancing semantic keywords...', { step: 1, total: 8 });
        const semanticKeywords = await enhanceSemanticKeywords(
            keyword,
            null,
            aiClient,
            model
        );

        console.log('[ULTRA SOTA] Generated', semanticKeywords.length, 'semantic keywords');
        onProgress?.(`✅ Generated ${semanticKeywords.length} semantic keywords`, { step: 1, total: 8 });

        onProgress?.('🎯 Step 2/8: Analyzing competitors...', { step: 2, total: 8 });
        const gapAnalysis = await performCompetitorGapAnalysis(
            keyword,
            serpData,
            aiClient,
            model
        );

        console.log('[ULTRA SOTA] Found', gapAnalysis.gaps.length, 'competitor gaps');
        onProgress?.(`✅ Found ${gapAnalysis.gaps.length} exploitable gaps`, { step: 2, total: 8 });

        onProgress?.('📋 Step 3/8: Building comprehensive article plan...', { step: 3, total: 8 });
        const allSemanticKeywords = [
            ...semanticKeywords,
            ...gapAnalysis.competitorKeywords,
            ...gapAnalysis.missingKeywords
        ];

        const articlePlan = {
            title: keyword,
            primaryKeyword: keyword,
            semanticKeywords: allSemanticKeywords,
            metaDescription: `Comprehensive ${keyword} guide with ${new Date().getFullYear()} data, expert insights, and actionable strategies.`,
            outline: [
                { heading: "Introduction", wordCount: 250 },
                { heading: "Key Takeaways", wordCount: 150 },
                { heading: `Understanding ${keyword}`, wordCount: 400 },
                { heading: "Expert Strategies", wordCount: 450 },
                { heading: "Common Challenges", wordCount: 350 },
                { heading: "Advanced Techniques", wordCount: 400 },
                { heading: "Real-World Examples", wordCount: 350 },
                { heading: "Frequently Asked Questions", wordCount: 300 },
                { heading: "Conclusion", wordCount: 200 }
            ],
            keyTakeaways: [
                `${keyword} requires strategic planning and execution`,
                `Data shows ${new Date().getFullYear()} trends favor specific approaches`,
                "Expert implementation beats generic solutions every time",
                "Common mistakes can be avoided with proper guidance",
                "Results improve 3x with systematic application"
            ],
            faqSection: [
                { question: `What is ${keyword}?`, answer: "Brief expert definition" },
                { question: `How do I get started with ${keyword}?`, answer: "Step-by-step guidance" },
                { question: `What are the benefits of ${keyword}?`, answer: "Key advantages" },
                { question: `How long does ${keyword} take?`, answer: "Realistic timeline" },
                { question: `What tools do I need for ${keyword}?`, answer: "Essential resources" }
            ]
        };

        onProgress?.('✅ Article plan created', { step: 3, total: 8 });

        onProgress?.('✍️ Step 4/8: Generating Alex Hormozi style content...', { step: 4, total: 8 });
        const prompt = buildUltraSOTAPrompt(
            articlePlan,
            allSemanticKeywords,
            gapAnalysis.gaps.map((g: CompetitorGap) => g.opportunity),
            existingPages,
            neuronData,
            recentNews
        );

        let generatedContent = '';

        if (model.includes('gemini')) {
            const result = await aiClient.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt.system + '\n\n' + prompt.user }] }],
            });
            generatedContent = result.response.text();
        } else if (model.includes('gpt')) {
            const completion = await aiClient.chat.completions.create({
                model: model,
                messages: [
                    { role: 'system', content: prompt.system },
                    { role: 'user', content: prompt.user }
                ],
                max_tokens: 4096,
                temperature: 0.7,
            });
            generatedContent = completion.choices[0].message.content || '';
        } else {
            const message = await aiClient.messages.create({
                model: model,
                max_tokens: 8000,
                system: prompt.system,
                messages: [{ role: 'user', content: prompt.user }],
                temperature: 0.7,
            });
            generatedContent = message.content[0].text;
        }

        generatedContent = generatedContent.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();

        console.log('[ULTRA SOTA] Generated', generatedContent.length, 'chars of content');
        onProgress?.(`✅ Generated ${(generatedContent.length / 1000).toFixed(1)}K chars of content`, { step: 4, total: 8 });

        onProgress?.('🔧 Step 5/8: Auto-fixing common issues...', { step: 5, total: 8 });
        const { fixed, changes } = validateAndFix(
            generatedContent,
            keyword,
            allSemanticKeywords
        );
        generatedContent = fixed;

        if (changes.length > 0) {
            console.log('[ULTRA SOTA] Applied fixes:', changes);
            onProgress?.(`✅ Fixed ${changes.length} issues`, { step: 5, total: 8 });
        } else {
            onProgress?.('✅ No fixes needed', { step: 5, total: 8 });
        }

        onProgress?.('📚 Step 6/8: Generating validated references...', { step: 6, total: 8 });
        const contentSummary = generatedContent.replace(/<[^>]*>/g, ' ').substring(0, 1000);
        const references = await generateAndValidateReferences(
            keyword,
            contentSummary,
            serperApiKey,
            aiClient,
            model,
            (msg) => onProgress?.(msg, { step: 6, total: 8 })
        );

        console.log('[ULTRA SOTA] Validated', references.length, 'references');
        onProgress?.(`✅ Added ${references.length} authoritative references`, { step: 6, total: 8 });

        onProgress?.('🔗 Step 7/8: Injecting references into content...', { step: 7, total: 8 });
        const referencesHtml = generateReferencesHtml(references);
        const contentWithReferences = generatedContent + referencesHtml;

        onProgress?.('✓ References injected', { step: 7, total: 8 });

        onProgress?.('✅ Step 8/8: Validating content quality...', { step: 8, total: 8 });
        const qualityReport = validateContentQuality(
            contentWithReferences,
            keyword,
            allSemanticKeywords,
            existingPages
        );

        const reportText = generateQualityReport(qualityReport);
        console.log('\n' + reportText);

        onProgress?.(`${qualityReport.passed ? '✅' : '⚠️'} Quality Score: ${qualityReport.score}%`, { step: 8, total: 8 });

        onProgress?.('🎉 ULTRA SOTA content generation complete!');

        return {
            content: contentWithReferences,
            semanticKeywords: allSemanticKeywords,
            gapAnalysis,
            references,
            qualityReport,
            metadata: {
                wordCount: contentWithReferences.replace(/<[^>]*>/g, ' ').split(/\s+/).length,
                semanticKeywordCount: allSemanticKeywords.length,
                gapsCovered: gapAnalysis.gaps.length,
                referencesValidated: references.length,
                qualityScore: qualityReport.score,
                aiPhrasesFree: qualityReport.checks.find(c => c.name === 'AI Detection Phrases')?.passed || false
            }
        };

    } catch (error) {
        console.error('[ULTRA SOTA] Error:', error);
        throw error;
    }
}

export async function refreshContentUltraSOTA(
    existingContent: string,
    keyword: string,
    existingPages: any[],
    aiClient: any,
    model: string,
    serperApiKey: string,
    serpData: any[],
    onProgress?: (message: string, details?: any) => void
): Promise<{
    content: string;
    preservedImages: number;
    references: ValidatedReference[];
    qualityReport: QualityCheckResult;
}> {
    try {
        onProgress?.('🔄 Starting ULTRA SOTA content refresh...', { step: 1, total: 6 });

        onProgress?.('📸 Step 1/6: Extracting existing images...', { step: 1, total: 6 });
        const existingImages = extractExistingImages(existingContent);
        console.log('[ULTRA SOTA Refresh] Preserving', existingImages.length, 'images');
        onProgress?.(`✅ Preserved ${existingImages.length} images`, { step: 1, total: 6 });

        onProgress?.('🔍 Step 2/6: Enhancing semantic keywords...', { step: 2, total: 6 });
        const semanticKeywords = await enhanceSemanticKeywords(
            keyword,
            null,
            aiClient,
            model
        );
        onProgress?.(`✅ Enhanced with ${semanticKeywords.length} keywords`, { step: 2, total: 6 });

        onProgress?.('🎯 Step 3/6: Analyzing competitors for updates...', { step: 3, total: 6 });
        const gapAnalysis = await performCompetitorGapAnalysis(
            keyword,
            serpData,
            aiClient,
            model
        );
        onProgress?.(`✅ Found ${gapAnalysis.gaps.length} opportunities`, { step: 3, total: 6 });

        onProgress?.('✍️ Step 4/6: Refreshing content with Alex Hormozi style...', { step: 4, total: 6 });

        const refreshedContent = await generateUltraSOTAContent(
            keyword,
            existingPages,
            aiClient,
            model,
            serperApiKey,
            serpData,
            null,
            null,
            (msg, details) => onProgress?.(msg, { ...details, step: 4, total: 6 })
        );

        onProgress?.('🖼️ Step 5/6: Reinjecting preserved images...', { step: 5, total: 6 });
        const contentWithImages = injectImagesIntoContent(
            refreshedContent.content,
            existingImages
        );
        onProgress?.(`✅ Reinjected ${existingImages.length} images`, { step: 5, total: 6 });

        onProgress?.('✅ Step 6/6: Final quality validation...', { step: 6, total: 6 });
        const qualityReport = validateContentQuality(
            contentWithImages,
            keyword,
            semanticKeywords,
            existingPages
        );

        onProgress?.(`${qualityReport.passed ? '✅' : '⚠️'} Quality Score: ${qualityReport.score}%`, { step: 6, total: 6 });

        onProgress?.('🎉 ULTRA SOTA refresh complete!');

        return {
            content: contentWithImages,
            preservedImages: existingImages.length,
            references: refreshedContent.references,
            qualityReport
        };

    } catch (error) {
        console.error('[ULTRA SOTA Refresh] Error:', error);
        throw error;
    }
}

export interface UltraSOTAConfig {
    keyword: string;
    existingPages: any[];
    aiClient: any;
    model: string;
    serperApiKey: string;
    serpData: any[];
    neuronData?: string | null;
    recentNews?: string | null;
    mode: 'generate' | 'refresh';
    existingContent?: string;
    onProgress?: (message: string, details?: any) => void;
}

export async function executeUltraSOTA(config: UltraSOTAConfig) {
    if (config.mode === 'refresh' && config.existingContent) {
        return refreshContentUltraSOTA(
            config.existingContent,
            config.keyword,
            config.existingPages,
            config.aiClient,
            config.model,
            config.serperApiKey,
            config.serpData,
            config.onProgress
        );
    } else {
        return generateUltraSOTAContent(
            config.keyword,
            config.existingPages,
            config.aiClient,
            config.model,
            config.serperApiKey,
            config.serpData,
            config.neuronData,
            config.recentNews,
            config.onProgress
        );
    }
}

export default executeUltraSOTA;
