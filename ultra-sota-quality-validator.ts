export interface QualityCheckResult {
    passed: boolean;
    score: number;
    checks: QualityCheck[];
    summary: string;
    recommendations: string[];
}

export interface QualityCheck {
    name: string;
    passed: boolean;
    value: string | number;
    expected: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
    category: 'structure' | 'seo' | 'readability' | 'content' | 'links';
}

const CURRENT_YEAR = new Date().getFullYear();

export function validateContentQuality(
    htmlContent: string,
    primaryKeyword: string,
    semanticKeywords: string[],
    existingPages: any[]
): QualityCheckResult {
    const checks: QualityCheck[] = [];

    const textOnly = htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const words = textOnly.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    checks.push({
        name: 'Word Count',
        passed: wordCount >= 2500 && wordCount <= 3500,
        value: wordCount,
        expected: '2500-3500 words',
        priority: 'high',
        category: 'content'
    });

    const keywordCount = (textOnly.toLowerCase().match(new RegExp(`\\b${primaryKeyword.toLowerCase()}\\b`, 'gi')) || []).length;
    const keywordDensity = (keywordCount / wordCount) * 100;

    checks.push({
        name: 'Primary Keyword Usage',
        passed: keywordCount >= 5 && keywordCount <= 12,
        value: keywordCount,
        expected: '5-12 occurrences',
        priority: 'critical',
        category: 'seo'
    });

    checks.push({
        name: 'Keyword Density',
        passed: keywordDensity >= 0.5 && keywordDensity <= 2.5,
        value: `${keywordDensity.toFixed(2)}%`,
        expected: '0.5%-2.5%',
        priority: 'medium',
        category: 'seo'
    });

    const keyTakeawaysCount = (htmlContent.match(/key-takeaways-box/gi) || []).length;
    checks.push({
        name: 'Key Takeaways Box',
        passed: keyTakeawaysCount === 1,
        value: keyTakeawaysCount,
        expected: 'Exactly 1',
        priority: 'critical',
        category: 'structure'
    });

    const faqCount = (htmlContent.match(/faq-section|frequently asked questions/gi) || []).length;
    checks.push({
        name: 'FAQ Section',
        passed: faqCount === 1,
        value: faqCount,
        expected: 'Exactly 1',
        priority: 'high',
        category: 'structure'
    });

    const conclusionCount = (htmlContent.match(/<h2[^>]*>conclusion<\/h2>/gi) || []).length;
    checks.push({
        name: 'Conclusion Section',
        passed: conclusionCount === 1,
        value: conclusionCount,
        expected: 'Exactly 1',
        priority: 'high',
        category: 'structure'
    });

    const h2Count = (htmlContent.match(/<h2[^>]*>/gi) || []).length;
    checks.push({
        name: 'H2 Headings',
        passed: h2Count >= 4 && h2Count <= 10,
        value: h2Count,
        expected: '4-10 headings',
        priority: 'medium',
        category: 'structure'
    });

    const tableCount = (htmlContent.match(/<table[^>]*>/gi) || []).length;
    checks.push({
        name: 'Data Tables',
        passed: tableCount >= 1,
        value: tableCount,
        expected: 'At least 1',
        priority: 'medium',
        category: 'content'
    });

    const internalLinkCount = (htmlContent.match(/LINK_CANDIDATE|<a href/gi) || []).length;
    checks.push({
        name: 'Internal Links',
        passed: internalLinkCount >= 8 && internalLinkCount <= 20,
        value: internalLinkCount,
        expected: '8-20 links',
        priority: 'high',
        category: 'links'
    });

    const currentYearMentions = (textOnly.match(new RegExp(`\\b${CURRENT_YEAR}\\b`, 'g')) || []).length;
    checks.push({
        name: 'Freshness Signals',
        passed: currentYearMentions >= 2,
        value: currentYearMentions,
        expected: 'At least 2 mentions',
        priority: 'medium',
        category: 'seo'
    });

    const semanticKeywordsFound = semanticKeywords.filter(kw =>
        textOnly.toLowerCase().includes(kw.toLowerCase())
    ).length;
    const semanticCoverage = (semanticKeywordsFound / semanticKeywords.length) * 100;

    checks.push({
        name: 'Semantic Keyword Coverage',
        passed: semanticCoverage >= 70,
        value: `${semanticCoverage.toFixed(0)}% (${semanticKeywordsFound}/${semanticKeywords.length})`,
        expected: 'At least 70%',
        priority: 'high',
        category: 'seo'
    });

    const aiPhrases = [
        'delve into', 'tapestry', 'landscape', 'realm',
        'it\'s worth noting', 'in conclusion',
        'unlock', 'leverage', 'robust', 'holistic', 'paradigm',
        'game-changer', 'revolutionize', 'cutting-edge'
    ];

    const aiPhrasesFound = aiPhrases.filter(phrase =>
        textOnly.toLowerCase().includes(phrase.toLowerCase())
    );

    checks.push({
        name: 'AI Detection Phrases',
        passed: aiPhrasesFound.length === 0,
        value: aiPhrasesFound.length,
        expected: '0 AI phrases',
        priority: 'critical',
        category: 'readability'
    });

    const sentences = textOnly.match(/[^.!?]+[.!?]+/g) || [];
    const avgWordsPerSentence = wordCount / (sentences.length || 1);

    checks.push({
        name: 'Average Sentence Length',
        passed: avgWordsPerSentence >= 12 && avgWordsPerSentence <= 20,
        value: avgWordsPerSentence.toFixed(1),
        expected: '12-20 words',
        priority: 'medium',
        category: 'readability'
    });

    const paragraphs = htmlContent.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
    const avgSentencesPerParagraph = sentences.length / (paragraphs.length || 1);

    checks.push({
        name: 'Paragraph Length',
        passed: avgSentencesPerParagraph >= 2 && avgSentencesPerParagraph <= 5,
        value: avgSentencesPerParagraph.toFixed(1),
        expected: '2-5 sentences per paragraph',
        priority: 'low',
        category: 'readability'
    });

    const referencesSection = htmlContent.includes('references-section') ||
                             htmlContent.includes('References & Sources');
    checks.push({
        name: 'References Section',
        passed: referencesSection,
        value: referencesSection ? 'Present' : 'Missing',
        expected: 'Present',
        priority: 'high',
        category: 'content'
    });

    const listItems = (htmlContent.match(/<li[^>]*>/gi) || []).length;
    checks.push({
        name: 'List Usage',
        passed: listItems >= 10,
        value: listItems,
        expected: 'At least 10 items',
        priority: 'low',
        category: 'structure'
    });

    const passedChecks = checks.filter(c => c.passed).length;
    const score = Math.round((passedChecks / checks.length) * 100);

    const criticalFailures = checks.filter(c => !c.passed && c.priority === 'critical');
    const highPriorityFailures = checks.filter(c => !c.passed && c.priority === 'high');

    const passed = criticalFailures.length === 0 && score >= 75;

    const recommendations: string[] = [];

    if (!passed) {
        if (criticalFailures.length > 0) {
            recommendations.push('🚨 CRITICAL: Fix critical issues immediately');
            criticalFailures.forEach(failure => {
                recommendations.push(`   • ${failure.name}: ${failure.value} (expected: ${failure.expected})`);
            });
        }

        if (highPriorityFailures.length > 0) {
            recommendations.push('⚠️ HIGH PRIORITY: Address these issues');
            highPriorityFailures.forEach(failure => {
                recommendations.push(`   • ${failure.name}: ${failure.value} (expected: ${failure.expected})`);
            });
        }

        if (score < 75) {
            recommendations.push('📊 QUALITY SCORE: Improve overall content quality to reach 75%+');
        }
    }

    if (passed && score < 90) {
        recommendations.push('✅ GOOD: Content meets minimum standards');
        recommendations.push('💡 TIP: Aim for 90%+ score for exceptional quality');
    }

    if (score >= 90) {
        recommendations.push('🏆 EXCELLENT: Content exceeds quality standards!');
    }

    const summary = passed
        ? `✅ Content PASSED quality validation (${score}% - ${passedChecks}/${checks.length} checks)`
        : `❌ Content FAILED quality validation (${score}% - ${passedChecks}/${checks.length} checks)`;

    return {
        passed,
        score,
        checks,
        summary,
        recommendations
    };
}

export function generateQualityReport(result: QualityCheckResult): string {
    const categoryGroups: Record<string, QualityCheck[]> = {};

    result.checks.forEach(check => {
        if (!categoryGroups[check.category]) {
            categoryGroups[check.category] = [];
        }
        categoryGroups[check.category].push(check);
    });

    const categoryNames: Record<string, string> = {
        structure: '📐 Structure',
        seo: '🎯 SEO',
        readability: '📖 Readability',
        content: '✍️ Content',
        links: '🔗 Links'
    };

    let report = `
╔════════════════════════════════════════════════════════╗
║          ULTRA SOTA QUALITY VALIDATION REPORT         ║
╚════════════════════════════════════════════════════════╝

${result.summary}

SCORE: ${result.score}% (${result.checks.filter(c => c.passed).length}/${result.checks.length} checks passed)
STATUS: ${result.passed ? '✅ APPROVED FOR PUBLISHING' : '❌ NEEDS REVISION'}

`;

    Object.entries(categoryGroups).forEach(([category, checks]) => {
        report += `\n${categoryNames[category] || category}\n`;
        report += '─'.repeat(60) + '\n';

        checks.forEach(check => {
            const icon = check.passed ? '✓' : '✗';
            const priority = check.priority === 'critical' ? '🚨' :
                           check.priority === 'high' ? '⚠️' :
                           check.priority === 'medium' ? '📌' : 'ℹ️';

            report += `${icon} ${priority} ${check.name}\n`;
            report += `   Value: ${check.value} | Expected: ${check.expected}\n`;

            if (!check.passed) {
                report += `   ⚠️ ACTION REQUIRED\n`;
            }
            report += '\n';
        });
    });

    if (result.recommendations.length > 0) {
        report += '\n' + '═'.repeat(60) + '\n';
        report += 'RECOMMENDATIONS\n';
        report += '═'.repeat(60) + '\n';
        result.recommendations.forEach(rec => {
            report += `${rec}\n`;
        });
    }

    report += '\n' + '═'.repeat(60) + '\n';
    report += `Generated: ${new Date().toLocaleString()}\n`;
    report += '═'.repeat(60) + '\n';

    return report;
}

export function validateAndFix(
    htmlContent: string,
    primaryKeyword: string,
    semanticKeywords: string[]
): { fixed: string; changes: string[] } {
    let fixed = htmlContent;
    const changes: string[] = [];

    const keyTakeawaysCount = (fixed.match(/key-takeaways-box/gi) || []).length;
    if (keyTakeawaysCount > 1) {
        const regex = /<div[^>]*class="[^"]*key-takeaways-box[^"]*"[^>]*>[\s\S]*?<\/div>/gi;
        const matches = fixed.match(regex);
        if (matches && matches.length > 1) {
            fixed = fixed.replace(matches[matches.length - 1], '');
            changes.push('Removed duplicate Key Takeaways box');
        }
    }

    const faqMatches = fixed.match(/<div[^>]*class="[^"]*faq-section[^"]*"[^>]*>[\s\S]*?<\/div>/gi) || [];
    if (faqMatches.length > 1) {
        fixed = fixed.replace(faqMatches[faqMatches.length - 1], '');
        changes.push('Removed duplicate FAQ section');
    }

    const conclusionMatches = fixed.match(/<h2[^>]*>conclusion<\/h2>[\s\S]*?(?=<h2|$)/gi) || [];
    if (conclusionMatches.length > 1) {
        fixed = fixed.replace(conclusionMatches[conclusionMatches.length - 1], '');
        changes.push('Removed duplicate Conclusion section');
    }

    const aiPhrases = [
        { phrase: 'delve into', replacement: 'explore' },
        { phrase: 'tapestry', replacement: 'collection' },
        { phrase: 'landscape', replacement: 'environment' },
        { phrase: 'realm', replacement: 'area' },
        { phrase: 'it\'s worth noting', replacement: 'Note that' },
        { phrase: 'in conclusion', replacement: 'To sum up' },
        { phrase: 'leverage', replacement: 'use' },
        { phrase: 'robust', replacement: 'strong' },
        { phrase: 'holistic', replacement: 'comprehensive' },
        { phrase: 'paradigm', replacement: 'model' }
    ];

    aiPhrases.forEach(({ phrase, replacement }) => {
        const regex = new RegExp(`\\b${phrase}\\b`, 'gi');
        if (regex.test(fixed)) {
            fixed = fixed.replace(regex, replacement);
            changes.push(`Replaced AI phrase "${phrase}" with "${replacement}"`);
        }
    });

    return { fixed, changes };
}
