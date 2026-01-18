// ============================================================================
// AGENCY INDEX IPC HANDLERS
// ============================================================================
//
// All handlers use Zod validation for input sanitization.
// ============================================================================

import { ipcMain } from 'electron';
import { ZodError } from 'zod';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as agencyIndex from '../../database/agencyIndex.js';
import { initializeAgentIndexer, getAgentIndexer } from '../../services/agentIndexer.js';
import { initializeSkillIndexer, getSkillIndexer } from '../../services/skillIndexer.js';
import { getContextInjectionService, initializeContextInjectionService } from '../../services/contextInjection.js';
import {
  numericIdSchema,
  sessionIdSchema,
  filePathSchema,
  agencyInitConfigSchema,
  entityTypeSchema,
  slugSchema,
  categoryPathSchema,
  paginationLimitSchema,
  searchAgentsSchema,
  searchSkillsSchema,
  activateAgentSchema,
  deactivateAgentSchema,
  queueSkillSchema,
  clearSkillQueueSchema,
  contextInjectionSchema,
  workingDirectorySchema,
} from '../schemas/index.js';

const logger = new Logger('IPC:Agency');

// ============================================================================
// VALIDATION ERROR RESPONSE
// ============================================================================

interface ValidationErrorResponse {
  success: false;
  error: string;
  code: 'VALIDATION_ERROR';
  details?: Array<{ path: string; message: string }>;
}

/**
 * Formats a ZodError into a user-friendly error response
 */
function formatValidationError(error: ZodError): ValidationErrorResponse {
  const details = error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  }));

  return {
    success: false,
    error: `Validation failed: ${details.map((d) => d.message).join(', ')}`,
    code: 'VALIDATION_ERROR',
    details,
  };
}

export function registerAgencyHandlers(): void {
  // ============================================================================
  // INITIALIZATION AND STATUS
  // ============================================================================

  ipcMain.handle('agency-index-status', withContext('agency-index-status', async () => {
    return agencyIndex.getIndexStats();
  }));

  ipcMain.handle('agency-index-init', withContext('agency-index-init', async (_, config: unknown) => {
    const result = agencyInitConfigSchema.safeParse(config);
    if (!result.success) {
      logger.warn('agency-index-init validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      // Create tables
      agencyIndex.createAgencyIndexTables();

      // Initialize indexers
      initializeAgentIndexer({
        agencyPath: result.data.agencyPath,
        agentSubpath: '.claude/agents/webdev',
      });

      initializeSkillIndexer({
        agencyPath: result.data.agencyPath,
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

  ipcMain.handle('agency-get-categories', withContext('agency-get-categories', async (_, type: unknown) => {
    // type is optional, validate only if provided
    if (type !== undefined) {
      const result = entityTypeSchema.safeParse(type);
      if (!result.success) {
        logger.warn('agency-get-categories validation failed', { errors: result.error.errors });
        return formatValidationError(result.error);
      }
      return agencyIndex.getCategories(result.data);
    }
    return agencyIndex.getCategories();
  }));

  ipcMain.handle('agency-get-category-tree', withContext('agency-get-category-tree', async (_, type: unknown) => {
    const result = entityTypeSchema.safeParse(type);
    if (!result.success) {
      logger.warn('agency-get-category-tree validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getCategoryTree(result.data);
  }));

  // ============================================================================
  // INDEXED AGENT OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-get-indexed-agents', withContext('agency-get-indexed-agents', async () => {
    return agencyIndex.getAllIndexedAgents();
  }));

  ipcMain.handle('agency-get-indexed-agent', withContext('agency-get-indexed-agent', async (_, id: unknown) => {
    const result = numericIdSchema.safeParse(id);
    if (!result.success) {
      logger.warn('agency-get-indexed-agent validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getIndexedAgent(result.data);
  }));

  ipcMain.handle('agency-get-indexed-agent-by-slug', withContext('agency-get-indexed-agent-by-slug', async (_, slug: unknown) => {
    const result = slugSchema.safeParse(slug);
    if (!result.success) {
      logger.warn('agency-get-indexed-agent-by-slug validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getIndexedAgentBySlug(result.data);
  }));

  ipcMain.handle('agency-get-agents-by-category', withContext('agency-get-agents-by-category', async (_, categoryPath: unknown) => {
    const result = categoryPathSchema.safeParse(categoryPath);
    if (!result.success) {
      logger.warn('agency-get-agents-by-category validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getIndexedAgentsByCategoryPath(result.data);
  }));

  ipcMain.handle('agency-get-popular-agents', withContext('agency-get-popular-agents', async (_, limit: unknown) => {
    const result = paginationLimitSchema.safeParse(limit);
    if (!result.success) {
      logger.warn('agency-get-popular-agents validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getPopularAgents(result.data);
  }));

  ipcMain.handle('agency-get-recent-agents', withContext('agency-get-recent-agents', async (_, limit: unknown) => {
    const result = paginationLimitSchema.safeParse(limit);
    if (!result.success) {
      logger.warn('agency-get-recent-agents validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getRecentlyUsedAgents(result.data);
  }));

  ipcMain.handle('agency-search-agents', withContext('agency-search-agents', async (_, data: unknown) => {
    const result = searchAgentsSchema.safeParse(data);
    if (!result.success) {
      logger.warn('agency-search-agents validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.searchIndexedAgents(result.data.query, result.data.limit);
  }));

  // ============================================================================
  // INDEXED SKILL OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-get-indexed-skills', withContext('agency-get-indexed-skills', async () => {
    return agencyIndex.getAllIndexedSkills();
  }));

  ipcMain.handle('agency-get-indexed-skill', withContext('agency-get-indexed-skill', async (_, id: unknown) => {
    const result = numericIdSchema.safeParse(id);
    if (!result.success) {
      logger.warn('agency-get-indexed-skill validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getIndexedSkill(result.data);
  }));

  ipcMain.handle('agency-get-indexed-skill-by-slug', withContext('agency-get-indexed-skill-by-slug', async (_, slug: unknown) => {
    const result = slugSchema.safeParse(slug);
    if (!result.success) {
      logger.warn('agency-get-indexed-skill-by-slug validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getIndexedSkillBySlug(result.data);
  }));

  ipcMain.handle('agency-get-skills-by-category', withContext('agency-get-skills-by-category', async (_, categoryPath: unknown) => {
    const result = categoryPathSchema.safeParse(categoryPath);
    if (!result.success) {
      logger.warn('agency-get-skills-by-category validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getIndexedSkillsByCategoryPath(result.data);
  }));

  ipcMain.handle('agency-get-skills-by-agent', withContext('agency-get-skills-by-agent', async (_, agentSlug: unknown) => {
    const result = slugSchema.safeParse(agentSlug);
    if (!result.success) {
      logger.warn('agency-get-skills-by-agent validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getIndexedSkillsByAgent(result.data);
  }));

  ipcMain.handle('agency-get-popular-skills', withContext('agency-get-popular-skills', async (_, limit: unknown) => {
    const result = paginationLimitSchema.safeParse(limit);
    if (!result.success) {
      logger.warn('agency-get-popular-skills validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getPopularSkills(result.data);
  }));

  ipcMain.handle('agency-get-recent-skills', withContext('agency-get-recent-skills', async (_, limit: unknown) => {
    const result = paginationLimitSchema.safeParse(limit);
    if (!result.success) {
      logger.warn('agency-get-recent-skills validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getRecentlyUsedSkills(result.data);
  }));

  ipcMain.handle('agency-search-skills', withContext('agency-search-skills', async (_, data: unknown) => {
    const result = searchSkillsSchema.safeParse(data);
    if (!result.success) {
      logger.warn('agency-search-skills validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.searchIndexedSkills(result.data.query, result.data.limit);
  }));

  // ============================================================================
  // ACTIVE AGENT OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-activate-agent', withContext('agency-activate-agent', async (_, data: unknown) => {
    const result = activateAgentSchema.safeParse(data);
    if (!result.success) {
      logger.warn('agency-activate-agent validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    const service = getContextInjectionService();
    return service.activateAgentForSession(
      result.data.agentId,
      result.data.sessionId,
      result.data.projectPath,
      result.data.priority
    );
  }));

  ipcMain.handle('agency-deactivate-agent', withContext('agency-deactivate-agent', async (_, data: unknown) => {
    const result = deactivateAgentSchema.safeParse(data);
    if (!result.success) {
      logger.warn('agency-deactivate-agent validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    const service = getContextInjectionService();
    service.deactivateAgentForSession(
      result.data.agentId,
      result.data.sessionId,
      result.data.projectPath
    );
    return { success: true };
  }));

  ipcMain.handle('agency-get-active-agents-for-session', withContext('agency-get-active-agents-for-session', async (_, sessionId: unknown) => {
    const result = sessionIdSchema.safeParse(sessionId);
    if (!result.success) {
      logger.warn('agency-get-active-agents-for-session validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getActiveAgentsForSession(result.data);
  }));

  ipcMain.handle('agency-get-active-agents-for-project', withContext('agency-get-active-agents-for-project', async (_, projectPath: unknown) => {
    const result = filePathSchema.safeParse(projectPath);
    if (!result.success) {
      logger.warn('agency-get-active-agents-for-project validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getActiveAgentsForProject(result.data);
  }));

  ipcMain.handle('agency-get-all-active-agents', withContext('agency-get-all-active-agents', async () => {
    return agencyIndex.getAllActiveAgentConfigs();
  }));

  // ============================================================================
  // SKILL QUEUE OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-queue-skill', withContext('agency-queue-skill', async (_, data: unknown) => {
    const result = queueSkillSchema.safeParse(data);
    if (!result.success) {
      logger.warn('agency-queue-skill validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    const service = getContextInjectionService();
    return service.queueSkillForSession(
      result.data.skillId,
      result.data.sessionId,
      result.data.projectPath,
      result.data.priority
    );
  }));

  ipcMain.handle('agency-remove-queued-skill', withContext('agency-remove-queued-skill', async (_, id: unknown) => {
    const result = numericIdSchema.safeParse(id);
    if (!result.success) {
      logger.warn('agency-remove-queued-skill validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    const service = getContextInjectionService();
    service.removeSkillFromQueue(result.data);
    return { success: true };
  }));

  ipcMain.handle('agency-get-pending-skills', withContext('agency-get-pending-skills', async () => {
    return agencyIndex.getAllPendingSkills();
  }));

  ipcMain.handle('agency-get-pending-skills-for-session', withContext('agency-get-pending-skills-for-session', async (_, sessionId: unknown) => {
    const result = sessionIdSchema.safeParse(sessionId);
    if (!result.success) {
      logger.warn('agency-get-pending-skills-for-session validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return agencyIndex.getPendingSkillsForSession(result.data);
  }));

  ipcMain.handle('agency-clear-skill-queue', withContext('agency-clear-skill-queue', async (_, data: unknown) => {
    const result = clearSkillQueueSchema.safeParse(data);
    if (!result.success) {
      logger.warn('agency-clear-skill-queue validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    const service = getContextInjectionService();
    service.clearQueue(result.data.sessionId, result.data.projectPath);
    return { success: true };
  }));

  // ============================================================================
  // CONTEXT INJECTION OPERATIONS
  // ============================================================================

  ipcMain.handle('agency-inject-context', withContext('agency-inject-context', async (_, context: unknown) => {
    const result = contextInjectionSchema.safeParse(context);
    if (!result.success) {
      logger.warn('agency-inject-context validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    const service = getContextInjectionService();
    return service.injectForSession(result.data);
  }));

  ipcMain.handle('agency-read-claude-md', withContext('agency-read-claude-md', async (_, workingDirectory: unknown) => {
    const result = workingDirectorySchema.safeParse(workingDirectory);
    if (!result.success) {
      logger.warn('agency-read-claude-md validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    const service = getContextInjectionService();
    return service.readClaudeMd(result.data);
  }));

  ipcMain.handle('agency-clear-injected-sections', withContext('agency-clear-injected-sections', async (_, workingDirectory: unknown) => {
    const result = workingDirectorySchema.safeParse(workingDirectory);
    if (!result.success) {
      logger.warn('agency-clear-injected-sections validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    const service = getContextInjectionService();
    return service.clearInjectedSections(result.data);
  }));

  ipcMain.handle('agency-get-section-markers', withContext('agency-get-section-markers', async () => {
    const service = getContextInjectionService();
    return service.getSectionMarkers();
  }));

  // ============================================================================
  // USAGE TRACKING
  // ============================================================================

  ipcMain.handle('agency-record-agent-usage', withContext('agency-record-agent-usage', async (_, id: unknown) => {
    const result = numericIdSchema.safeParse(id);
    if (!result.success) {
      logger.warn('agency-record-agent-usage validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    agencyIndex.recordAgentUsage(result.data);
    return { success: true };
  }));

  ipcMain.handle('agency-record-skill-usage', withContext('agency-record-skill-usage', async (_, id: unknown) => {
    const result = numericIdSchema.safeParse(id);
    if (!result.success) {
      logger.warn('agency-record-skill-usage validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    agencyIndex.recordSkillUsage(result.data);
    return { success: true };
  }));

  logger.info('Agency handlers registered (with Zod validation)');
}
