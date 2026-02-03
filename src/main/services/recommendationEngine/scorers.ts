// ============================================================================
// RECOMMENDATION ENGINE SCORERS
// ============================================================================
//
// Scoring, matching, and reasoning generation for recommendations.
// ============================================================================

import { Logger } from '../logger.js';
import {
  searchIndexedAgents,
  searchIndexedSkills,
  getPopularAgents,
  getPopularSkills,
} from '../../database/agencyIndex.js';
import type { RecommendationSource } from '../../database/recommendations.js';
import type {
  Recommendation,
  PromptAnalysis,
  ProjectContext,
  RecommendationEngineConfig,
} from './types.js';

const logger = new Logger('RecommendationScorers');

// ============================================================================
// KEYWORD MATCHING
// ============================================================================

/**
 * Find keywords that match between text and a keyword list
 */
export function findMatchingKeywords(text: string, keywords: string[]): string[] {
  const textLower = text.toLowerCase();
  const matched: string[] = [];

  for (const keyword of keywords) {
    if (textLower.includes(keyword.toLowerCase())) {
      matched.push(keyword);
    }
  }

  return [...new Set(matched)];
}

// ============================================================================
// REASONING GENERATION
// ============================================================================

/**
 * Generate human-readable reasoning for a recommendation
 */
export function generateReasoning(
  analysis: PromptAnalysis,
  matchedKeywords: string[],
  source: RecommendationSource
): string {
  const parts: string[] = [];

  if (source === 'historical') {
    parts.push('High historical success rate');
  }
  if (source === 'context') {
    parts.push('Matches project context');
  }
  if (matchedKeywords.length > 0) {
    parts.push(`Keywords: ${matchedKeywords.slice(0, 3).join(', ')}`);
  }
  if (analysis.intents.length > 0) {
    parts.push(`Intent: ${analysis.intents[0]}`);
  }

  return parts.length > 0 ? parts.join('. ') : 'Keyword match';
}

// ============================================================================
// AGENT SCORING
// ============================================================================

/**
 * Search agents based on prompt analysis and score them
 */
export async function searchAgentsForPrompt(
  analysis: PromptAnalysis,
  projectContext: ProjectContext | null,
  historicalBoosts: Map<string, number>,
  config: RecommendationEngineConfig
): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  // Build search query from analysis
  const searchTerms = [
    ...analysis.keywords,
    ...analysis.technologies,
    ...analysis.intents,
  ].slice(0, 10).join(' ');

  if (!searchTerms.trim()) {
    return recommendations;
  }

  try {
    const searchResults = searchIndexedAgents(searchTerms, 15);

    for (const result of searchResults) {
      const agent = result.item;
      const matchedKeywords = findMatchingKeywords(
        agent.name + ' ' + (agent.description || '') + ' ' + agent.tags.join(' '),
        analysis.keywords
      );

      if (matchedKeywords.length === 0) continue;

      // Calculate base score from search rank and keyword matches
      let confidenceScore = Math.min(0.9, (1 / (1 + Math.abs(result.score))) * 0.5 + matchedKeywords.length * 0.1);

      // Boost from project context match
      if (projectContext) {
        const projectMatches = findMatchingKeywords(
          agent.name + ' ' + (agent.description || '') + ' ' + agent.tags.join(' '),
          [...projectContext.technologies, ...projectContext.frameworks]
        );
        confidenceScore += projectMatches.length * config.projectContextWeight * 0.1;
      }

      // Boost from historical success
      const historicalRate = historicalBoosts.get(`agent:${agent.id}`) || 0;
      confidenceScore += historicalRate * config.historicalBoostWeight;

      // Clamp to 0-1
      confidenceScore = Math.min(1, Math.max(0, confidenceScore));

      // Determine source
      let source: RecommendationSource = 'prompt';
      if (historicalRate > 0.5) source = 'historical';
      else if (projectContext && findMatchingKeywords(
        agent.name + ' ' + (agent.description || ''),
        [...projectContext.technologies, ...projectContext.frameworks]
      ).length > 0) {
        source = 'context';
      }

      recommendations.push({
        id: 0,
        type: 'agent',
        itemId: agent.id,
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        confidenceScore,
        source,
        matchedKeywords,
        reasoning: generateReasoning(analysis, matchedKeywords, source),
      });
    }
  } catch (error) {
    logger.debug(`Agent search failed: ${(error as Error).message}`);
    // If FTS fails, fall back to popular agents
    try {
      const popularAgents = getPopularAgents(5);
      for (const agent of popularAgents) {
        const matchedKeywords = findMatchingKeywords(
          agent.name + ' ' + (agent.description || ''),
          analysis.keywords
        );
        if (matchedKeywords.length > 0) {
          recommendations.push({
            id: 0,
            type: 'agent',
            itemId: agent.id,
            slug: agent.slug,
            name: agent.name,
            description: agent.description,
            confidenceScore: 0.4,
            source: 'prompt',
            matchedKeywords,
            reasoning: `Popular agent matching: ${matchedKeywords.join(', ')}`,
          });
        }
      }
    } catch (fallbackError) {
      // Popular agents fallback also failed - database may be unavailable or corrupted.
      // Log at debug level since primary search already logged and caller handles empty results.
      logger.debug('Agent fallback search also failed', {
        operation: 'searchAgentsForPrompt',
        errorMessage: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
    }
  }

  return recommendations;
}

// ============================================================================
// SKILL SCORING
// ============================================================================

/**
 * Search skills based on prompt analysis and score them
 */
export async function searchSkillsForPrompt(
  analysis: PromptAnalysis,
  projectContext: ProjectContext | null,
  historicalBoosts: Map<string, number>,
  config: RecommendationEngineConfig
): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  const searchTerms = [
    ...analysis.keywords,
    ...analysis.technologies,
    ...analysis.intents,
  ].slice(0, 10).join(' ');

  if (!searchTerms.trim()) {
    return recommendations;
  }

  try {
    const searchResults = searchIndexedSkills(searchTerms, 15);

    for (const result of searchResults) {
      const skill = result.item;
      const matchedKeywords = findMatchingKeywords(
        skill.name + ' ' + (skill.description || '') + ' ' + skill.triggers.join(' ') + ' ' + skill.tags.join(' '),
        analysis.keywords
      );

      if (matchedKeywords.length === 0) continue;

      // Calculate score
      let confidenceScore = Math.min(0.9, (1 / (1 + Math.abs(result.score))) * 0.5 + matchedKeywords.length * 0.1);

      // Boost from trigger match (skills with matching triggers get higher scores)
      const triggerMatches = findMatchingKeywords(
        skill.triggers.join(' '),
        analysis.keywords
      );
      confidenceScore += triggerMatches.length * 0.15;

      // Boost from project context
      if (projectContext) {
        const projectMatches = findMatchingKeywords(
          skill.name + ' ' + (skill.description || '') + ' ' + skill.triggers.join(' '),
          [...projectContext.technologies, ...projectContext.frameworks]
        );
        confidenceScore += projectMatches.length * config.projectContextWeight * 0.1;
      }

      // Boost from historical success
      const historicalRate = historicalBoosts.get(`skill:${skill.id}`) || 0;
      confidenceScore += historicalRate * config.historicalBoostWeight;

      confidenceScore = Math.min(1, Math.max(0, confidenceScore));

      let source: RecommendationSource = 'prompt';
      if (historicalRate > 0.5) source = 'historical';
      else if (projectContext && findMatchingKeywords(
        skill.name + ' ' + (skill.description || ''),
        [...projectContext.technologies, ...projectContext.frameworks]
      ).length > 0) {
        source = 'context';
      }

      recommendations.push({
        id: 0,
        type: 'skill',
        itemId: skill.id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        confidenceScore,
        source,
        matchedKeywords: [...matchedKeywords, ...triggerMatches],
        reasoning: generateReasoning(analysis, matchedKeywords, source),
      });
    }
  } catch (error) {
    logger.debug(`Skill search failed: ${(error as Error).message}`);
    // Fallback to popular skills
    try {
      const popularSkills = getPopularSkills(5);
      for (const skill of popularSkills) {
        const matchedKeywords = findMatchingKeywords(
          skill.name + ' ' + (skill.description || '') + ' ' + skill.triggers.join(' '),
          analysis.keywords
        );
        if (matchedKeywords.length > 0) {
          recommendations.push({
            id: 0,
            type: 'skill',
            itemId: skill.id,
            slug: skill.slug,
            name: skill.name,
            description: skill.description,
            confidenceScore: 0.4,
            source: 'prompt',
            matchedKeywords,
            reasoning: `Popular skill matching: ${matchedKeywords.join(', ')}`,
          });
        }
      }
    } catch (fallbackError) {
      // Popular skills fallback also failed - database may be unavailable or corrupted.
      // Log at debug level since primary search already logged and caller handles empty results.
      logger.debug('Skill fallback search also failed', {
        operation: 'searchSkillsForPrompt',
        errorMessage: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
    }
  }

  return recommendations;
}
