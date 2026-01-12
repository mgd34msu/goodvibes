// ============================================================================
// RECOMMENDATION ENGINE SERVICE - Agent recommendations based on prompts
// ============================================================================
//
// This service analyzes user prompts via the UserPromptSubmit hook and
// recommends relevant agents and skills from the indexed agency library.
//
// Features:
// - Keyword extraction from user prompts
// - Intent detection (build, fix, test, deploy, etc.)
// - Project context analysis (package.json, file patterns)
// - Historical success rate boosting
// - Per-session recommendation caching
//
// ============================================================================

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from './logger.js';
import { getMainWindow } from '../window.js';
import {
  searchIndexedAgents,
  searchIndexedSkills,
  getPopularAgents,
  getPopularSkills,
} from '../database/agencyIndex.js';
import {
  createRecommendationsTables,
  recordRecommendation,
  recordRecommendationAction,
  getRecommendationStats,
  getTopPerformingItems,
  wasRecentlyRecommended,
  type RecommendationType,
  type RecommendationAction,
  type RecommendationSource,
  type RecommendationStats,
} from '../database/recommendations.js';

const logger = new Logger('RecommendationEngine');

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single recommendation with score and reasoning
 */
export interface Recommendation {
  id: number;  // The recommendation record ID
  type: RecommendationType;
  itemId: number;
  slug: string;
  name: string;
  description: string | null;
  confidenceScore: number;
  source: RecommendationSource;
  matchedKeywords: string[];
  reasoning: string;
}

/**
 * Result from analyzing a prompt
 */
export interface PromptAnalysis {
  keywords: string[];
  intents: string[];
  technologies: string[];
  frameworks: string[];
  actions: string[];
}

/**
 * Project context from analyzing project files
 */
export interface ProjectContext {
  name: string | null;
  technologies: string[];
  frameworks: string[];
  hasTests: boolean;
  hasDocker: boolean;
  hasTypeScript: boolean;
  packageDependencies: string[];
}

/**
 * Configuration for the recommendation engine
 */
export interface RecommendationEngineConfig {
  maxRecommendations: number;
  minConfidenceScore: number;
  historicalBoostWeight: number;
  projectContextWeight: number;
  cacheTimeoutMs: number;
}

// ============================================================================
// KEYWORD PATTERNS
// ============================================================================

/**
 * Intent patterns - what the user wants to do
 */
const INTENT_PATTERNS: { pattern: RegExp; intent: string }[] = [
  { pattern: /\b(build|create|implement|add|develop|make)\b/i, intent: 'build' },
  { pattern: /\b(fix|debug|resolve|repair|troubleshoot)\b/i, intent: 'fix' },
  { pattern: /\b(test|testing|spec|unit test|e2e|integration)\b/i, intent: 'test' },
  { pattern: /\b(deploy|deployment|release|publish|ship)\b/i, intent: 'deploy' },
  { pattern: /\b(refactor|clean|optimize|improve|reorganize)\b/i, intent: 'refactor' },
  { pattern: /\b(document|docs|readme|comment|api docs)\b/i, intent: 'document' },
  { pattern: /\b(security|auth|authentication|authorization|secure)\b/i, intent: 'security' },
  { pattern: /\b(performance|optimize|speed|fast|slow)\b/i, intent: 'performance' },
  { pattern: /\b(database|db|sql|query|migration)\b/i, intent: 'database' },
  { pattern: /\b(api|endpoint|rest|graphql|grpc)\b/i, intent: 'api' },
  { pattern: /\b(ui|frontend|component|page|layout)\b/i, intent: 'frontend' },
  { pattern: /\b(backend|server|service|microservice)\b/i, intent: 'backend' },
  { pattern: /\b(style|css|styling|theme|design)\b/i, intent: 'styling' },
  { pattern: /\b(hook|hooks|use[A-Z]\w+)\b/i, intent: 'hooks' },
  { pattern: /\b(state|store|redux|zustand|context)\b/i, intent: 'state-management' },
  { pattern: /\b(form|input|validation|formik|react-hook-form)\b/i, intent: 'forms' },
  { pattern: /\b(animation|animate|motion|framer)\b/i, intent: 'animation' },
  { pattern: /\b(ci|cd|pipeline|workflow|github action)\b/i, intent: 'cicd' },
  { pattern: /\b(config|configuration|setup|initialize)\b/i, intent: 'config' },
  { pattern: /\b(error|exception|handling|catch|try)\b/i, intent: 'error-handling' },
];

/**
 * Technology patterns - what technologies are mentioned
 */
const TECHNOLOGY_PATTERNS: { pattern: RegExp; tech: string; category: string }[] = [
  // Frontend frameworks
  { pattern: /\b(react|reactjs|react\.js)\b/i, tech: 'react', category: 'frontend' },
  { pattern: /\b(vue|vuejs|vue\.js)\b/i, tech: 'vue', category: 'frontend' },
  { pattern: /\b(angular)\b/i, tech: 'angular', category: 'frontend' },
  { pattern: /\b(svelte|sveltekit)\b/i, tech: 'svelte', category: 'frontend' },
  { pattern: /\b(solid|solidjs)\b/i, tech: 'solid', category: 'frontend' },
  { pattern: /\b(qwik)\b/i, tech: 'qwik', category: 'frontend' },
  { pattern: /\b(htmx)\b/i, tech: 'htmx', category: 'frontend' },

  // Meta-frameworks
  { pattern: /\b(next|nextjs|next\.js)\b/i, tech: 'nextjs', category: 'framework' },
  { pattern: /\b(nuxt|nuxtjs|nuxt\.js)\b/i, tech: 'nuxt', category: 'framework' },
  { pattern: /\b(remix)\b/i, tech: 'remix', category: 'framework' },
  { pattern: /\b(astro)\b/i, tech: 'astro', category: 'framework' },
  { pattern: /\b(gatsby)\b/i, tech: 'gatsby', category: 'framework' },

  // Backend
  { pattern: /\b(node|nodejs|node\.js)\b/i, tech: 'nodejs', category: 'runtime' },
  { pattern: /\b(express|expressjs)\b/i, tech: 'express', category: 'backend' },
  { pattern: /\b(fastify)\b/i, tech: 'fastify', category: 'backend' },
  { pattern: /\b(nestjs|nest)\b/i, tech: 'nestjs', category: 'backend' },
  { pattern: /\b(hono)\b/i, tech: 'hono', category: 'backend' },
  { pattern: /\b(koa)\b/i, tech: 'koa', category: 'backend' },
  { pattern: /\b(deno)\b/i, tech: 'deno', category: 'runtime' },
  { pattern: /\b(bun)\b/i, tech: 'bun', category: 'runtime' },

  // Databases
  { pattern: /\b(postgres|postgresql|pg)\b/i, tech: 'postgresql', category: 'database' },
  { pattern: /\b(mysql|mariadb)\b/i, tech: 'mysql', category: 'database' },
  { pattern: /\b(mongodb|mongo)\b/i, tech: 'mongodb', category: 'database' },
  { pattern: /\b(redis)\b/i, tech: 'redis', category: 'database' },
  { pattern: /\b(sqlite)\b/i, tech: 'sqlite', category: 'database' },
  { pattern: /\b(prisma)\b/i, tech: 'prisma', category: 'orm' },
  { pattern: /\b(drizzle)\b/i, tech: 'drizzle', category: 'orm' },
  { pattern: /\b(typeorm)\b/i, tech: 'typeorm', category: 'orm' },

  // Languages
  { pattern: /\b(typescript|ts)\b/i, tech: 'typescript', category: 'language' },
  { pattern: /\b(javascript|js)\b/i, tech: 'javascript', category: 'language' },
  { pattern: /\b(python|py)\b/i, tech: 'python', category: 'language' },
  { pattern: /\b(go|golang)\b/i, tech: 'go', category: 'language' },
  { pattern: /\b(rust)\b/i, tech: 'rust', category: 'language' },

  // Testing
  { pattern: /\b(jest)\b/i, tech: 'jest', category: 'testing' },
  { pattern: /\b(vitest)\b/i, tech: 'vitest', category: 'testing' },
  { pattern: /\b(playwright)\b/i, tech: 'playwright', category: 'testing' },
  { pattern: /\b(cypress)\b/i, tech: 'cypress', category: 'testing' },
  { pattern: /\b(testing-library|testing library)\b/i, tech: 'testing-library', category: 'testing' },

  // Styling
  { pattern: /\b(tailwind|tailwindcss)\b/i, tech: 'tailwind', category: 'styling' },
  { pattern: /\b(sass|scss)\b/i, tech: 'sass', category: 'styling' },
  { pattern: /\b(styled-components)\b/i, tech: 'styled-components', category: 'styling' },
  { pattern: /\b(emotion)\b/i, tech: 'emotion', category: 'styling' },
  { pattern: /\b(css modules)\b/i, tech: 'css-modules', category: 'styling' },

  // UI Libraries
  { pattern: /\b(shadcn|shadcn\/ui)\b/i, tech: 'shadcn', category: 'ui-library' },
  { pattern: /\b(radix|radix-ui)\b/i, tech: 'radix', category: 'ui-library' },
  { pattern: /\b(chakra|chakra-ui)\b/i, tech: 'chakra', category: 'ui-library' },
  { pattern: /\b(material-ui|mui)\b/i, tech: 'material-ui', category: 'ui-library' },
  { pattern: /\b(mantine)\b/i, tech: 'mantine', category: 'ui-library' },
  { pattern: /\b(ant-design|antd)\b/i, tech: 'ant-design', category: 'ui-library' },

  // State management
  { pattern: /\b(zustand)\b/i, tech: 'zustand', category: 'state' },
  { pattern: /\b(redux|redux-toolkit|rtk)\b/i, tech: 'redux', category: 'state' },
  { pattern: /\b(jotai)\b/i, tech: 'jotai', category: 'state' },
  { pattern: /\b(recoil)\b/i, tech: 'recoil', category: 'state' },
  { pattern: /\b(mobx)\b/i, tech: 'mobx', category: 'state' },
  { pattern: /\b(tanstack-query|react-query)\b/i, tech: 'tanstack-query', category: 'state' },
  { pattern: /\b(swr)\b/i, tech: 'swr', category: 'state' },

  // Infrastructure
  { pattern: /\b(docker)\b/i, tech: 'docker', category: 'infrastructure' },
  { pattern: /\b(kubernetes|k8s)\b/i, tech: 'kubernetes', category: 'infrastructure' },
  { pattern: /\b(vercel)\b/i, tech: 'vercel', category: 'platform' },
  { pattern: /\b(netlify)\b/i, tech: 'netlify', category: 'platform' },
  { pattern: /\b(aws|amazon web services)\b/i, tech: 'aws', category: 'cloud' },
  { pattern: /\b(gcp|google cloud)\b/i, tech: 'gcp', category: 'cloud' },
  { pattern: /\b(azure)\b/i, tech: 'azure', category: 'cloud' },

  // API & Protocols
  { pattern: /\b(graphql|gql)\b/i, tech: 'graphql', category: 'api' },
  { pattern: /\b(trpc|t-rpc)\b/i, tech: 'trpc', category: 'api' },
  { pattern: /\b(grpc)\b/i, tech: 'grpc', category: 'api' },
  { pattern: /\b(websocket|ws)\b/i, tech: 'websocket', category: 'protocol' },

  // Auth
  { pattern: /\b(auth0)\b/i, tech: 'auth0', category: 'auth' },
  { pattern: /\b(clerk)\b/i, tech: 'clerk', category: 'auth' },
  { pattern: /\b(nextauth|auth\.js)\b/i, tech: 'nextauth', category: 'auth' },
  { pattern: /\b(supabase)\b/i, tech: 'supabase', category: 'baas' },
  { pattern: /\b(firebase)\b/i, tech: 'firebase', category: 'baas' },

  // AI
  { pattern: /\b(openai|gpt|chatgpt)\b/i, tech: 'openai', category: 'ai' },
  { pattern: /\b(anthropic|claude)\b/i, tech: 'anthropic', category: 'ai' },
  { pattern: /\b(langchain)\b/i, tech: 'langchain', category: 'ai' },
  { pattern: /\b(vercel ai sdk)\b/i, tech: 'vercel-ai', category: 'ai' },

  // Validation
  { pattern: /\b(zod)\b/i, tech: 'zod', category: 'validation' },
  { pattern: /\b(yup)\b/i, tech: 'yup', category: 'validation' },
  { pattern: /\b(joi)\b/i, tech: 'joi', category: 'validation' },
];

/**
 * Action words that indicate what user wants to do
 */
const ACTION_PATTERNS: { pattern: RegExp; action: string }[] = [
  { pattern: /\b(add|adding)\b/i, action: 'add' },
  { pattern: /\b(remove|delete|drop)\b/i, action: 'remove' },
  { pattern: /\b(update|modify|change)\b/i, action: 'update' },
  { pattern: /\b(fix|repair|resolve)\b/i, action: 'fix' },
  { pattern: /\b(create|make|build)\b/i, action: 'create' },
  { pattern: /\b(setup|configure|init)\b/i, action: 'setup' },
  { pattern: /\b(migrate|convert|transform)\b/i, action: 'migrate' },
  { pattern: /\b(upgrade|update version)\b/i, action: 'upgrade' },
  { pattern: /\b(integrate|connect|hook up)\b/i, action: 'integrate' },
  { pattern: /\b(split|separate|extract)\b/i, action: 'split' },
  { pattern: /\b(merge|combine|join)\b/i, action: 'merge' },
];

// ============================================================================
// RECOMMENDATION ENGINE CLASS
// ============================================================================

class RecommendationEngineClass extends EventEmitter {
  private initialized: boolean = false;
  private config: RecommendationEngineConfig;
  private sessionCache: Map<string, {
    recommendations: Recommendation[];
    timestamp: number;
    promptHash: string;
  }> = new Map();
  private projectContextCache: Map<string, {
    context: ProjectContext;
    timestamp: number;
  }> = new Map();

  constructor() {
    super();
    this.setMaxListeners(50);
    this.config = {
      maxRecommendations: 5,
      minConfidenceScore: 0.3,
      historicalBoostWeight: 0.2,
      projectContextWeight: 0.3,
      cacheTimeoutMs: 5 * 60 * 1000, // 5 minutes
    };
  }

  /**
   * Initialize the recommendation engine
   */
  initialize(): void {
    if (this.initialized) return;

    createRecommendationsTables();
    this.initialized = true;

    logger.info('Recommendation engine initialized');
  }

  /**
   * Configure the recommendation engine
   */
  configure(config: Partial<RecommendationEngineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============================================================================
  // PROMPT ANALYSIS
  // ============================================================================

  /**
   * Analyze a user prompt to extract keywords, intents, and technologies
   */
  analyzePrompt(prompt: string): PromptAnalysis {
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
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
      'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they',
      'this', 'that', 'with', 'from', 'will', 'would', 'could', 'should',
      'what', 'when', 'where', 'which', 'there', 'their', 'them', 'then',
      'just', 'like', 'some', 'more', 'also', 'into', 'want', 'need', 'help',
      'please', 'thanks', 'thank', 'make', 'made', 'get', 'got', 'using',
    ]);
    for (const word of words) {
      if (!stopWords.has(word) && word.length >= 4) {
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
  async analyzeProjectContext(projectPath: string): Promise<ProjectContext> {
    // Check cache
    const cached = this.projectContextCache.get(projectPath);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTimeoutMs) {
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
      } catch {
        // No package.json or parse error
      }

      // Check for TypeScript config
      try {
        await fs.access(path.join(projectPath, 'tsconfig.json'));
        context.hasTypeScript = true;
        context.technologies.push('typescript');
      } catch {
        // No tsconfig
      }

      // Check for Docker
      try {
        await fs.access(path.join(projectPath, 'Dockerfile'));
        context.hasDocker = true;
        context.technologies.push('docker');
      } catch {
        try {
          await fs.access(path.join(projectPath, 'docker-compose.yml'));
          context.hasDocker = true;
          context.technologies.push('docker');
        } catch {
          // No Docker
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
            // Dir doesn't exist
          }
        }
      }

      // Deduplicate
      context.technologies = [...new Set(context.technologies)];
      context.frameworks = [...new Set(context.frameworks)];

      // Cache result
      this.projectContextCache.set(projectPath, {
        context,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.debug(`Failed to analyze project context: ${(error as Error).message}`);
    }

    return context;
  }

  // ============================================================================
  // RECOMMENDATION GENERATION
  // ============================================================================

  /**
   * Get recommendations for a prompt
   */
  async getRecommendationsForPrompt(
    prompt: string,
    sessionId: string | null,
    projectPath: string | null
  ): Promise<Recommendation[]> {
    this.initialize();

    // Analyze prompt
    const analysis = this.analyzePrompt(prompt);

    if (analysis.keywords.length === 0) {
      return [];
    }

    // Get project context if available
    let projectContext: ProjectContext | null = null;
    if (projectPath) {
      projectContext = await this.analyzeProjectContext(projectPath);
    }

    // Get historical success data
    const topAgents = getTopPerformingItems('agent', 2, 20);
    const topSkills = getTopPerformingItems('skill', 2, 20);
    const historicalBoosts = new Map<string, number>();
    for (const item of [...topAgents, ...topSkills]) {
      historicalBoosts.set(`${item.type}:${item.itemId}`, item.successRate);
    }

    // Generate recommendations
    const recommendations: Recommendation[] = [];

    // Search agents
    const agentResults = await this.searchAgentsForPrompt(analysis, projectContext, historicalBoosts);
    recommendations.push(...agentResults);

    // Search skills
    const skillResults = await this.searchSkillsForPrompt(analysis, projectContext, historicalBoosts);
    recommendations.push(...skillResults);

    // Sort by confidence score
    recommendations.sort((a, b) => b.confidenceScore - a.confidenceScore);

    // Filter by minimum score and take top N
    const filtered = recommendations
      .filter(r => r.confidenceScore >= this.config.minConfidenceScore)
      .slice(0, this.config.maxRecommendations);

    // Record recommendations in database
    const recorded: Recommendation[] = [];
    for (const rec of filtered) {
      // Skip if recently recommended
      if (wasRecentlyRecommended(rec.itemId, rec.type, sessionId, 10)) {
        continue;
      }

      const record = recordRecommendation({
        sessionId,
        projectPath,
        recommendationType: rec.type,
        itemId: rec.itemId,
        itemSlug: rec.slug,
        itemName: rec.name,
        confidenceScore: rec.confidenceScore,
        source: rec.source,
        matchedKeywords: JSON.stringify(rec.matchedKeywords),
        promptSnippet: prompt.slice(0, 200),
      });

      recorded.push({
        ...rec,
        id: record.id,
      });
    }

    // Emit event
    this.emit('recommendations:generated', {
      sessionId,
      projectPath,
      count: recorded.length,
      recommendations: recorded,
    });

    // Notify renderer
    this.notifyRenderer('recommendations:new', {
      sessionId,
      recommendations: recorded,
    });

    return recorded;
  }

  /**
   * Get recommendations based on project context only
   */
  async getRecommendationsForProject(
    projectPath: string
  ): Promise<Recommendation[]> {
    this.initialize();

    const projectContext = await this.analyzeProjectContext(projectPath);

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
        const matchedKeywords = this.findMatchingKeywords(
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
        const matchedKeywords = this.findMatchingKeywords(
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
    return recommendations.slice(0, this.config.maxRecommendations);
  }

  /**
   * Search agents based on prompt analysis
   */
  private async searchAgentsForPrompt(
    analysis: PromptAnalysis,
    projectContext: ProjectContext | null,
    historicalBoosts: Map<string, number>
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
        const matchedKeywords = this.findMatchingKeywords(
          agent.name + ' ' + (agent.description || '') + ' ' + agent.tags.join(' '),
          analysis.keywords
        );

        if (matchedKeywords.length === 0) continue;

        // Calculate base score from search rank and keyword matches
        let confidenceScore = Math.min(0.9, (1 / (1 + Math.abs(result.score))) * 0.5 + matchedKeywords.length * 0.1);

        // Boost from project context match
        if (projectContext) {
          const projectMatches = this.findMatchingKeywords(
            agent.name + ' ' + (agent.description || '') + ' ' + agent.tags.join(' '),
            [...projectContext.technologies, ...projectContext.frameworks]
          );
          confidenceScore += projectMatches.length * this.config.projectContextWeight * 0.1;
        }

        // Boost from historical success
        const historicalRate = historicalBoosts.get(`agent:${agent.id}`) || 0;
        confidenceScore += historicalRate * this.config.historicalBoostWeight;

        // Clamp to 0-1
        confidenceScore = Math.min(1, Math.max(0, confidenceScore));

        // Determine source
        let source: RecommendationSource = 'prompt';
        if (historicalRate > 0.5) source = 'historical';
        else if (projectContext && this.findMatchingKeywords(
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
          reasoning: this.generateReasoning(analysis, matchedKeywords, source),
        });
      }
    } catch (error) {
      logger.debug(`Agent search failed: ${(error as Error).message}`);
      // If FTS fails, fall back to popular agents
      try {
        const popularAgents = getPopularAgents(5);
        for (const agent of popularAgents) {
          const matchedKeywords = this.findMatchingKeywords(
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
      } catch {
        // Ignore fallback errors
      }
    }

    return recommendations;
  }

  /**
   * Search skills based on prompt analysis
   */
  private async searchSkillsForPrompt(
    analysis: PromptAnalysis,
    projectContext: ProjectContext | null,
    historicalBoosts: Map<string, number>
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
        const matchedKeywords = this.findMatchingKeywords(
          skill.name + ' ' + (skill.description || '') + ' ' + skill.triggers.join(' ') + ' ' + skill.tags.join(' '),
          analysis.keywords
        );

        if (matchedKeywords.length === 0) continue;

        // Calculate score
        let confidenceScore = Math.min(0.9, (1 / (1 + Math.abs(result.score))) * 0.5 + matchedKeywords.length * 0.1);

        // Boost from trigger match (skills with matching triggers get higher scores)
        const triggerMatches = this.findMatchingKeywords(
          skill.triggers.join(' '),
          analysis.keywords
        );
        confidenceScore += triggerMatches.length * 0.15;

        // Boost from project context
        if (projectContext) {
          const projectMatches = this.findMatchingKeywords(
            skill.name + ' ' + (skill.description || '') + ' ' + skill.triggers.join(' '),
            [...projectContext.technologies, ...projectContext.frameworks]
          );
          confidenceScore += projectMatches.length * this.config.projectContextWeight * 0.1;
        }

        // Boost from historical success
        const historicalRate = historicalBoosts.get(`skill:${skill.id}`) || 0;
        confidenceScore += historicalRate * this.config.historicalBoostWeight;

        confidenceScore = Math.min(1, Math.max(0, confidenceScore));

        let source: RecommendationSource = 'prompt';
        if (historicalRate > 0.5) source = 'historical';
        else if (projectContext && this.findMatchingKeywords(
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
          reasoning: this.generateReasoning(analysis, matchedKeywords, source),
        });
      }
    } catch (error) {
      logger.debug(`Skill search failed: ${(error as Error).message}`);
      // Fallback to popular skills
      try {
        const popularSkills = getPopularSkills(5);
        for (const skill of popularSkills) {
          const matchedKeywords = this.findMatchingKeywords(
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
      } catch {
        // Ignore fallback errors
      }
    }

    return recommendations;
  }

  /**
   * Find keywords that match between text and a keyword list
   */
  private findMatchingKeywords(text: string, keywords: string[]): string[] {
    const textLower = text.toLowerCase();
    const matched: string[] = [];

    for (const keyword of keywords) {
      if (textLower.includes(keyword.toLowerCase())) {
        matched.push(keyword);
      }
    }

    return [...new Set(matched)];
  }

  /**
   * Generate human-readable reasoning for a recommendation
   */
  private generateReasoning(
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
  // FEEDBACK HANDLING
  // ============================================================================

  /**
   * Record user feedback on a recommendation
   */
  recordFeedback(recommendationId: number, action: RecommendationAction): void {
    this.initialize();
    recordRecommendationAction(recommendationId, action);

    this.emit('recommendations:feedback', { recommendationId, action });
    logger.debug(`Recommendation ${recommendationId} ${action}`);
  }

  /**
   * Get recommendation statistics
   */
  getStats(): RecommendationStats {
    this.initialize();
    return getRecommendationStats();
  }

  // ============================================================================
  // CACHE MANAGEMENT
  // ============================================================================

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.sessionCache.clear();
    this.projectContextCache.clear();
    logger.debug('Recommendation caches cleared');
  }

  /**
   * Clear cache for a specific session
   */
  clearSessionCache(sessionId: string): void {
    this.sessionCache.delete(sessionId);
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  /**
   * Notify the renderer process
   */
  private notifyRenderer(channel: string, data: unknown): void {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let recommendationEngine: RecommendationEngineClass | null = null;

export function getRecommendationEngine(): RecommendationEngineClass {
  if (!recommendationEngine) {
    recommendationEngine = new RecommendationEngineClass();
  }
  return recommendationEngine;
}

export function initializeRecommendationEngine(): RecommendationEngineClass {
  recommendationEngine = new RecommendationEngineClass();
  recommendationEngine.initialize();
  return recommendationEngine;
}

export { RecommendationEngineClass };
