// ============================================================================
// RECOMMENDATION ENGINE GENERATORS
// ============================================================================
//
// Prompt analysis, project context analysis, and recommendation generation.
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../logger.js';
import {
  searchIndexedAgents,
  searchIndexedSkills,
} from '../../database/agencyIndex.js';
import type {
  PromptAnalysis,
  ProjectContext,
  Recommendation,
  RecommendationEngineConfig,
} from './types.js';
import {
  INTENT_PATTERNS,
  TECHNOLOGY_PATTERNS,
  ACTION_PATTERNS,
  STOP_WORDS,
} from './types.js';
import { findMatchingKeywords } from './scorers.js';

const logger = new Logger('RecommendationGenerators');

// ============================================================================
// PROMPT ANALYSIS
// ============================================================================

/**
 * Analyze a user prompt to extract keywords, intents, and technologies
 */
export function analyzePrompt(prompt: string): PromptAnalysis {
  const keywords: Set<string> = new Set();
  const intents: Set<string> = new Set();
  const technologies: Set<string> = new Set();
  const frameworks: Set<string> = new Set();
  const actions: Set<string> = new Set();

  // Normalize prompt
  const normalizedPrompt = prompt.toLowerCase();

  // Extract intents
  for (const { pattern, intent } of INTENT_PATTERNS) {
    if (pattern.test(prompt)) {
      intents.add(intent);
      keywords.add(intent);
    }
  }

  // Extract technologies
  for (const { pattern, tech, category } of TECHNOLOGY_PATTERNS) {
    if (pattern.test(prompt)) {
      technologies.add(tech);
      keywords.add(tech);
      if (category === 'framework') {
        frameworks.add(tech);
      }
    }
  }

  // Extract actions
  for (const { pattern, action } of ACTION_PATTERNS) {
    if (pattern.test(prompt)) {
      actions.add(action);
    }
  }

  // Extract significant words (nouns and verbs, 3+ chars)
  const words = normalizedPrompt.match(/\b[a-z]{3,}\b/g) || [];
  for (const word of words) {
    if (!STOP_WORDS.has(word) && word.length >= 4) {
      keywords.add(word);
    }
  }

  return {
    keywords: Array.from(keywords),
    intents: Array.from(intents),
    technologies: Array.from(technologies),
    frameworks: Array.from(frameworks),
    actions: Array.from(actions),
  };
}

// ============================================================================
// PROJECT CONTEXT ANALYSIS
// ============================================================================

/**
 * Analyze project directory for context
 */
export async function analyzeProjectContext(
  projectPath: string,
  cache: Map<string, { context: ProjectContext; timestamp: number }>,
  cacheTimeoutMs: number
): Promise<ProjectContext> {
  // Check cache
  const cached = cache.get(projectPath);
  if (cached && Date.now() - cached.timestamp < cacheTimeoutMs) {
    return cached.context;
  }

  const context: ProjectContext = {
    name: null,
    technologies: [],
    frameworks: [],
    hasTests: false,
    hasDocker: false,
    hasTypeScript: false,
    packageDependencies: [],
  };

  try {
    // Check for package.json
    const packageJsonPath = path.join(projectPath, 'package.json');
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
      context.name = packageJson.name || null;

      // Analyze dependencies
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      context.packageDependencies = Object.keys(allDeps);

      // Detect frameworks and technologies from dependencies
      for (const dep of context.packageDependencies) {
        const depLower = dep.toLowerCase();

        // Frameworks
        if (depLower === 'next' || depLower.startsWith('@next/')) {
          context.frameworks.push('nextjs');
          context.technologies.push('react');
        }
        if (depLower === 'nuxt') {
          context.frameworks.push('nuxt');
          context.technologies.push('vue');
        }
        if (depLower === '@remix-run/react') {
          context.frameworks.push('remix');
          context.technologies.push('react');
        }
        if (depLower === 'astro') {
          context.frameworks.push('astro');
        }

        // Frontend
        if (depLower === 'react') context.technologies.push('react');
        if (depLower === 'vue') context.technologies.push('vue');
        if (depLower === 'svelte') context.technologies.push('svelte');
        if (depLower === '@angular/core') context.technologies.push('angular');

        // Backend
        if (depLower === 'express') context.technologies.push('express');
        if (depLower === 'fastify') context.technologies.push('fastify');
        if (depLower === '@nestjs/core') context.technologies.push('nestjs');
        if (depLower === 'hono') context.technologies.push('hono');

        // Database
        if (depLower === 'prisma' || depLower === '@prisma/client') {
          context.technologies.push('prisma');
        }
        if (depLower === 'drizzle-orm') context.technologies.push('drizzle');
        if (depLower === 'pg') context.technologies.push('postgresql');
        if (depLower === 'mysql2') context.technologies.push('mysql');
        if (depLower === 'mongodb') context.technologies.push('mongodb');

        // Testing
        if (depLower === 'jest' || depLower === '@jest/core') {
          context.technologies.push('jest');
          context.hasTests = true;
        }
        if (depLower === 'vitest') {
          context.technologies.push('vitest');
          context.hasTests = true;
        }
        if (depLower === 'playwright' || depLower === '@playwright/test') {
          context.technologies.push('playwright');
          context.hasTests = true;
        }

        // Styling
        if (depLower === 'tailwindcss') context.technologies.push('tailwind');
        if (depLower === 'styled-components') context.technologies.push('styled-components');
        if (depLower === '@emotion/react') context.technologies.push('emotion');

        // State
        if (depLower === 'zustand') context.technologies.push('zustand');
        if (depLower === '@reduxjs/toolkit') context.technologies.push('redux');
        if (depLower === '@tanstack/react-query') context.technologies.push('tanstack-query');

        // TypeScript
        if (depLower === 'typescript') context.hasTypeScript = true;
      }
    } catch (error) {
      // package.json may not exist or may be malformed - this is expected for
      // non-Node.js projects. Log at debug level for debugging purposes.
      logger.debug('Could not read package.json', {
        projectPath,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    // Check for TypeScript config
    try {
      await fs.access(path.join(projectPath, 'tsconfig.json'));
      context.hasTypeScript = true;
      context.technologies.push('typescript');
    } catch {
      // tsconfig.json not found - project does not use TypeScript configuration.
      // This is expected for JavaScript-only projects.
    }

    // Check for Docker
    try {
      await fs.access(path.join(projectPath, 'Dockerfile'));
      context.hasDocker = true;
      context.technologies.push('docker');
    } catch {
      // Dockerfile not found, check for docker-compose.yml as fallback
      try {
        await fs.access(path.join(projectPath, 'docker-compose.yml'));
        context.hasDocker = true;
        context.technologies.push('docker');
      } catch {
        // Neither Dockerfile nor docker-compose.yml found - project does not use Docker.
        // This is expected for non-containerized projects.
      }
    }

    // Check for test directories
    if (!context.hasTests) {
      const testDirs = ['__tests__', 'tests', 'test', 'spec'];
      for (const dir of testDirs) {
        try {
          const stat = await fs.stat(path.join(projectPath, dir));
          if (stat.isDirectory()) {
            context.hasTests = true;
            break;
          }
        } catch {
          // Test directory not found at this path - continue checking other common locations.
          // This is expected as most projects only have one of these directories.
        }
      }
    }

    // Deduplicate
    context.technologies = [...new Set(context.technologies)];
    context.frameworks = [...new Set(context.frameworks)];

    // Cache result
    cache.set(projectPath, {
      context,
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.debug(`Failed to analyze project context: ${(error as Error).message}`);
  }

  return context;
}

// ============================================================================
// PROJECT-BASED RECOMMENDATIONS
// ============================================================================

/**
 * Get recommendations based on project context only
 */
export async function getRecommendationsForProject(
  projectContext: ProjectContext,
  config: RecommendationEngineConfig
): Promise<Recommendation[]> {
  if (projectContext.technologies.length === 0 && projectContext.frameworks.length === 0) {
    return [];
  }

  // Build search terms from project context
  const searchTerms = [
    ...projectContext.technologies,
    ...projectContext.frameworks,
  ].join(' ');

  // Get matching agents
  const recommendations: Recommendation[] = [];

  try {
    const agentResults = searchIndexedAgents(searchTerms, 10);
    for (const result of agentResults) {
      const matchedKeywords = findMatchingKeywords(
        result.item.name + ' ' + (result.item.description || '') + ' ' + result.item.tags.join(' '),
        [...projectContext.technologies, ...projectContext.frameworks]
      );

      if (matchedKeywords.length > 0) {
        const confidenceScore = Math.min(0.9, (matchedKeywords.length * 0.2) + 0.2);
        recommendations.push({
          id: 0,
          type: 'agent',
          itemId: result.item.id,
          slug: result.item.slug,
          name: result.item.name,
          description: result.item.description,
          confidenceScore,
          source: 'project',
          matchedKeywords,
          reasoning: `Matches project technologies: ${matchedKeywords.join(', ')}`,
        });
      }
    }
  } catch (error) {
    logger.debug(`Agent search failed: ${(error as Error).message}`);
  }

  try {
    const skillResults = searchIndexedSkills(searchTerms, 10);
    for (const result of skillResults) {
      const matchedKeywords = findMatchingKeywords(
        result.item.name + ' ' + (result.item.description || '') + ' ' + result.item.triggers.join(' '),
        [...projectContext.technologies, ...projectContext.frameworks]
      );

      if (matchedKeywords.length > 0) {
        const confidenceScore = Math.min(0.9, (matchedKeywords.length * 0.2) + 0.2);
        recommendations.push({
          id: 0,
          type: 'skill',
          itemId: result.item.id,
          slug: result.item.slug,
          name: result.item.name,
          description: result.item.description,
          confidenceScore,
          source: 'project',
          matchedKeywords,
          reasoning: `Matches project technologies: ${matchedKeywords.join(', ')}`,
        });
      }
    }
  } catch (error) {
    logger.debug(`Skill search failed: ${(error as Error).message}`);
  }

  // Sort and limit
  recommendations.sort((a, b) => b.confidenceScore - a.confidenceScore);
  return recommendations.slice(0, config.maxRecommendations);
}
