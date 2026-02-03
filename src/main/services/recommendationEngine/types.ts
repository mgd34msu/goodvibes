// ============================================================================
// RECOMMENDATION ENGINE TYPES
// ============================================================================
//
// Type definitions, interfaces, and pattern constants for the recommendation engine.
// ============================================================================

import type { RecommendationType, RecommendationSource } from '../../database/recommendations.js';

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
export const INTENT_PATTERNS: { pattern: RegExp; intent: string }[] = [
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
export const TECHNOLOGY_PATTERNS: { pattern: RegExp; tech: string; category: string }[] = [
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
export const ACTION_PATTERNS: { pattern: RegExp; action: string }[] = [
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

/**
 * Stop words to filter from keyword extraction
 */
export const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they',
  'this', 'that', 'with', 'from', 'will', 'would', 'could', 'should',
  'what', 'when', 'where', 'which', 'there', 'their', 'them', 'then',
  'just', 'like', 'some', 'more', 'also', 'into', 'want', 'need', 'help',
  'please', 'thanks', 'thank', 'make', 'made', 'get', 'got', 'using',
]);
