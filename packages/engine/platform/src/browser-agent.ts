import {
  createBrowserKnowledgePlatformFromRoutes,
  createKnowledgeBrowserRoutes,
  forSession,
  type BrowserKnowledgePlatform,
} from './browser-knowledge.js';
import type { ScopedBrowserPlatformOptions } from './browser-scoped.js';

const AGENT_KNOWLEDGE_PREFIX = '/api/goodvibes-agent/knowledge';

/**
 * The agent's route table is the knowledge table with only the knowledge
 * prefix moved: the agent keeps its own knowledge space, while the work-plan,
 * artifact and companion-chat routes are shared. Building both from one
 * function keeps a route added to the knowledge table (and its facade method)
 * from being missing here.
 */
const AGENT_BROWSER_ROUTES = createKnowledgeBrowserRoutes(AGENT_KNOWLEDGE_PREFIX);

export type BrowserAgentPlatform = BrowserKnowledgePlatform;

export function createBrowserAgentPlatform(options: ScopedBrowserPlatformOptions = {}): BrowserAgentPlatform {
  return createBrowserKnowledgePlatformFromRoutes(AGENT_BROWSER_ROUTES, options);
}

export { forSession };
