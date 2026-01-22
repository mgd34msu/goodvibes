// ============================================================================
// IPC SCHEMAS BARREL EXPORT
// ============================================================================
//
// Note: Several files export schemas with identical names. We use explicit
// exports to avoid naming conflicts. Primitives are the canonical source for
// shared schemas like projectPathSchema, sessionIdSchema, hexColorSchema.
// ============================================================================

// Primitives - base schemas (canonical source for common schemas)
export * from './primitives.js';

// Terminal
export * from './terminal.js';

// Settings
export * from './settings.js';

// Collections
export * from './collections.js';

// Tags
export * from './tags.js';

// Prompts
export * from './prompts.js';

// Notes
export * from './notes.js';

// Notifications
export * from './notifications.js';

// Knowledge
export * from './knowledge.js';

// Search
export * from './search.js';

// Database (activity logs, analytics)
export * from './database.js';

// Git
export * from './git.js';

// GitHub
export * from './github.js';

// Hooks
export * from './hooks.js';

// Agents & primitives
export * from './agents.js';

// Export
export * from './export.js';

// Clipboard - canonical source for clipboard schemas
export * from './clipboard.js';

// Features - feature installation schemas
export * from './features.js';

// Window - skip to avoid duplicates with clipboard.ts
// Use clipboard.ts for clipboardWriteSchema, contextMenuOptionsSchema, terminalContextMenuOptionsSchema

// Sessions - skip duplicates (sessionIdSchema, projectPathSchema from primitives)
export {
  sessionPaginationLimitSchema,
  sessionSearchQuerySchema,
  getSessionsForProjectSchema,
  sessionSearchSchema,
  getRecentSessionsSchema,
  type GetSessionsForProjectInput,
  type SessionSearchInput,
  type GetRecentSessionsInput,
} from './sessions.js';

// Project Config - skip projectPathSchema duplicate, use primitives version
export {
  getProjectConfigInputSchema,
  deleteProjectConfigInputSchema,
  updateProjectConfigInputSchema,
  projectSettingsSchema,
  createProjectConfigInputSchema,
  type CreateProjectConfigInput,
  type UpdateProjectConfigInput,
} from './projectConfig.js';

// Projects (file dialogs, recent projects)
export * from './projects.js';

// Agency (agent/skill indexing, context injection) - skip searchQuerySchema (conflicts with search.js)
export {
  entityTypeSchema,
  slugSchema,
  categoryPathSchema,
  prioritySchema,
  agencyInitConfigSchema,
  searchAgentsSchema,
  activateAgentSchema,
  deactivateAgentSchema,
  searchSkillsSchema,
  queueSkillSchema,
  clearSkillQueueSchema,
  contextInjectionSchema,
  workingDirectorySchema,
  type EntityType,
  type AgencyInitConfig,
  type SearchAgentsInput,
  type ActivateAgentInput,
  type DeactivateAgentInput,
  type SearchSkillsInput,
  type QueueSkillInput,
  type ClearSkillQueueInput,
  type ContextInjectionInput,
} from './agency.js';

// Theme - skip hexColorSchema duplicate (use primitives version)
export {
  VALID_THEME_IDS,
  themeIdSchema,
  themeVariantSchema,
  rgbaColorSchema,
  cssColorSchema,
  setColorThemeInputSchema,
  setThemeModeInputSchema,
  getThemeInputSchema,
  getThemeModeInputSchema,
  themeSettingSchema,
  isThemeSettingKey,
  validateThemeSettingValue,
  type ThemeId,
  type ThemeVariant,
  type SetColorThemeInput,
  type SetThemeModeInput,
} from './theme.js';
