// ============================================================================
// AGENCY INDEX IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as agencyIndex from '../../database/agencyIndex.js';
import { initializeAgentIndexer, getAgentIndexer } from '../../services/agentIndexer.js';
import { initializeSkillIndexer, getSkillIndexer } from '../../services/skillIndexer.js';
import { getContextInjectionService, initializeContextInjectionService } from '../../services/contextInjection.js';

const logger = new Logger('IPC:Agency');

export function registerAgencyHandlers(): void {
  // ============================================================================
  // INITIALIZATION AND STATUS
  // ============================================================================

  ipcMain.handle('agency-index-status', withContext('agency-index-status', async () => {
    return agencyIndex.getIndexStats();
  }));

  ipcMain.handle('agency-index-init', withContext('agency-index-init', async (_, config: { agencyPath: string }) => {
    try {
      // Create tables
      agencyIndex.createAgencyIndexTables();

      // Initialize indexers
      initializeAgentIndexer({
        agencyPath: config.agencyPath,
        agentSubpath: '.claude/agents/webdev',
      });

      initializeSkillIndexer({
        agencyPath: config.agencyPath,
        skillSubpath: '.claude/skills/webdev',
      });

      // Initialize context injection service
      initializeContextInjectionService();

      return { success: true };
    } catch (err) {
      const error = err as Error;
      logger.error(`Failed to initialize agency index: ${error.message}`);
      return { success: false, error: error.message };
    }
  }));

  // ============================================================================
  // AGENT INDEXER OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-index-agents', withContext('agency-index-agents', async () => {
    try {
      const indexer = getAgentIndexer();
      return await indexer.indexAll();
    } catch (err) {
      const error = err as Error;
      return { success: false, count: 0, errors: [error.message] };
    }
  }));

  ipcMain.handle('agency-agent-indexer-status', withContext('agency-agent-indexer-status', async () => {
    try {
      const indexer = getAgentIndexer();
      return indexer.getStatus();
    } catch {
      return { indexing: false, lastIndexTime: null, agentCount: 0 };
    }
  }));

  // ============================================================================
  // SKILL INDEXER OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-index-skills', withContext('agency-index-skills', async () => {
    try {
      const indexer = getSkillIndexer();
      return await indexer.indexAll();
    } catch (err) {
      const error = err as Error;
      return { success: false, count: 0, errors: [error.message] };
    }
  }));

  ipcMain.handle('agency-skill-indexer-status', withContext('agency-skill-indexer-status', async () => {
    try {
      const indexer = getSkillIndexer();
      return indexer.getStatus();
    } catch {
      return { indexing: false, lastIndexTime: null, skillCount: 0 };
    }
  }));

  // ============================================================================
  // CATEGORY OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-get-categories', withContext('agency-get-categories', async (_, type?: 'agent' | 'skill') => {
    return agencyIndex.getCategories(type);
  }));

  ipcMain.handle('agency-get-category-tree', withContext('agency-get-category-tree', async (_, type: 'agent' | 'skill') => {
    return agencyIndex.getCategoryTree(type);
  }));

  // ============================================================================
  // INDEXED AGENT OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-get-indexed-agents', withContext('agency-get-indexed-agents', async () => {
    return agencyIndex.getAllIndexedAgents();
  }));

  ipcMain.handle('agency-get-indexed-agent', withContext('agency-get-indexed-agent', async (_, id: number) => {
    return agencyIndex.getIndexedAgent(id);
  }));

  ipcMain.handle('agency-get-indexed-agent-by-slug', withContext('agency-get-indexed-agent-by-slug', async (_, slug: string) => {
    return agencyIndex.getIndexedAgentBySlug(slug);
  }));

  ipcMain.handle('agency-get-agents-by-category', withContext('agency-get-agents-by-category', async (_, categoryPath: string) => {
    return agencyIndex.getIndexedAgentsByCategoryPath(categoryPath);
  }));

  ipcMain.handle('agency-get-popular-agents', withContext('agency-get-popular-agents', async (_, limit?: number) => {
    return agencyIndex.getPopularAgents(limit);
  }));

  ipcMain.handle('agency-get-recent-agents', withContext('agency-get-recent-agents', async (_, limit?: number) => {
    return agencyIndex.getRecentlyUsedAgents(limit);
  }));

  ipcMain.handle('agency-search-agents', withContext('agency-search-agents', async (_, { query, limit }: { query: string; limit?: number }) => {
    return agencyIndex.searchIndexedAgents(query, limit);
  }));

  // ============================================================================
  // INDEXED SKILL OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-get-indexed-skills', withContext('agency-get-indexed-skills', async () => {
    return agencyIndex.getAllIndexedSkills();
  }));

  ipcMain.handle('agency-get-indexed-skill', withContext('agency-get-indexed-skill', async (_, id: number) => {
    return agencyIndex.getIndexedSkill(id);
  }));

  ipcMain.handle('agency-get-indexed-skill-by-slug', withContext('agency-get-indexed-skill-by-slug', async (_, slug: string) => {
    return agencyIndex.getIndexedSkillBySlug(slug);
  }));

  ipcMain.handle('agency-get-skills-by-category', withContext('agency-get-skills-by-category', async (_, categoryPath: string) => {
    return agencyIndex.getIndexedSkillsByCategoryPath(categoryPath);
  }));

  ipcMain.handle('agency-get-skills-by-agent', withContext('agency-get-skills-by-agent', async (_, agentSlug: string) => {
    return agencyIndex.getIndexedSkillsByAgent(agentSlug);
  }));

  ipcMain.handle('agency-get-popular-skills', withContext('agency-get-popular-skills', async (_, limit?: number) => {
    return agencyIndex.getPopularSkills(limit);
  }));

  ipcMain.handle('agency-get-recent-skills', withContext('agency-get-recent-skills', async (_, limit?: number) => {
    return agencyIndex.getRecentlyUsedSkills(limit);
  }));

  ipcMain.handle('agency-search-skills', withContext('agency-search-skills', async (_, { query, limit }: { query: string; limit?: number }) => {
    return agencyIndex.searchIndexedSkills(query, limit);
  }));

  // ============================================================================
  // ACTIVE AGENT OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-activate-agent', withContext('agency-activate-agent', async (_, { agentId, sessionId, projectPath, priority }: { agentId: number; sessionId?: string; projectPath?: string; priority?: number }) => {
    const service = getContextInjectionService();
    return service.activateAgentForSession(agentId, sessionId, projectPath, priority);
  }));

  ipcMain.handle('agency-deactivate-agent', withContext('agency-deactivate-agent', async (_, { agentId, sessionId, projectPath }: { agentId: number; sessionId?: string; projectPath?: string }) => {
    const service = getContextInjectionService();
    service.deactivateAgentForSession(agentId, sessionId, projectPath);
    return true;
  }));

  ipcMain.handle('agency-get-active-agents-for-session', withContext('agency-get-active-agents-for-session', async (_, sessionId: string) => {
    return agencyIndex.getActiveAgentsForSession(sessionId);
  }));

  ipcMain.handle('agency-get-active-agents-for-project', withContext('agency-get-active-agents-for-project', async (_, projectPath: string) => {
    return agencyIndex.getActiveAgentsForProject(projectPath);
  }));

  ipcMain.handle('agency-get-all-active-agents', withContext('agency-get-all-active-agents', async () => {
    return agencyIndex.getAllActiveAgentConfigs();
  }));

  // ============================================================================
  // SKILL QUEUE OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-queue-skill', withContext('agency-queue-skill', async (_, { skillId, sessionId, projectPath, priority }: { skillId: number; sessionId?: string; projectPath?: string; priority?: number }) => {
    const service = getContextInjectionService();
    return service.queueSkillForSession(skillId, sessionId, projectPath, priority);
  }));

  ipcMain.handle('agency-remove-queued-skill', withContext('agency-remove-queued-skill', async (_, id: number) => {
    const service = getContextInjectionService();
    service.removeSkillFromQueue(id);
    return true;
  }));

  ipcMain.handle('agency-get-pending-skills', withContext('agency-get-pending-skills', async () => {
    return agencyIndex.getAllPendingSkills();
  }));

  ipcMain.handle('agency-get-pending-skills-for-session', withContext('agency-get-pending-skills-for-session', async (_, sessionId: string) => {
    return agencyIndex.getPendingSkillsForSession(sessionId);
  }));

  ipcMain.handle('agency-clear-skill-queue', withContext('agency-clear-skill-queue', async (_, { sessionId, projectPath }: { sessionId?: string; projectPath?: string }) => {
    const service = getContextInjectionService();
    service.clearQueue(sessionId, projectPath);
    return true;
  }));

  // ============================================================================
  // CONTEXT INJECTION OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-inject-context', withContext('agency-inject-context', async (_, context: { sessionId: string; projectPath: string; workingDirectory: string }) => {
    const service = getContextInjectionService();
    return service.injectForSession(context);
  }));

  ipcMain.handle('agency-read-claude-md', withContext('agency-read-claude-md', async (_, workingDirectory: string) => {
    const service = getContextInjectionService();
    return service.readClaudeMd(workingDirectory);
  }));

  ipcMain.handle('agency-clear-injected-sections', withContext('agency-clear-injected-sections', async (_, workingDirectory: string) => {
    const service = getContextInjectionService();
    return service.clearInjectedSections(workingDirectory);
  }));

  ipcMain.handle('agency-get-section-markers', withContext('agency-get-section-markers', async () => {
    const service = getContextInjectionService();
    return service.getSectionMarkers();
  }));

  // ============================================================================
  // USAGE TRACKING
  // ============================================================================

  ipcMain.handle('agency-record-agent-usage', withContext('agency-record-agent-usage', async (_, id: number) => {
    agencyIndex.recordAgentUsage(id);
    return true;
  }));

  ipcMain.handle('agency-record-skill-usage', withContext('agency-record-skill-usage', async (_, id: number) => {
    agencyIndex.recordSkillUsage(id);
    return true;
  }));

  logger.info('Agency handlers registered');
}
