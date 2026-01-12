// ============================================================================
// PRELOAD SCRIPT - Bridge between main and renderer
// ============================================================================
//
// This script exposes APIs from the main process to the renderer process
// through Electron's contextBridge. APIs are split into domain modules.
// ============================================================================

import { contextBridge } from 'electron';

// Import domain APIs
import { terminalApi } from './api/terminal.js';
import { sessionsApi } from './api/sessions.js';
import { gitApi } from './api/git.js';
import { githubApi } from './api/github.js';
import { databaseApi } from './api/database.js';
import { settingsApi } from './api/settings.js';
import { projectsApi } from './api/projects.js';
import { hooksApi } from './api/hooks.js';
import { primitivesApi } from './api/primitives.js';
import { agencyApi } from './api/agency.js';
import { eventsApi } from './api/events.js';
import { projectRegistryApi } from './api/project-registry.js';
import { recommendationsApi } from './api/recommendations.js';

// Combine all APIs into single exposed object
const api = {
  // Terminal
  ...terminalApi,

  // Sessions
  ...sessionsApi,

  // Git
  ...gitApi,

  // GitHub
  ...githubApi,

  // Database (collections, tags, prompts, notes, notifications, knowledge, search, analytics)
  ...databaseApi,

  // Settings and app info
  ...settingsApi,

  // Projects (file/folder, recent projects, export)
  ...projectsApi,

  // Hooks
  ...hooksApi,

  // Primitives (MCP, agents, skills, tasks)
  ...primitivesApi,

  // Agency index
  ...agencyApi,

  // Events
  ...eventsApi,

  // Project registry (Phase 11)
  ...projectRegistryApi,

  // Recommendations (Phase 10)
  ...recommendationsApi,
};

// Expose API to renderer
contextBridge.exposeInMainWorld('goodvibes', api);

// Type declaration for renderer
export type GoodVibesAPI = typeof api;
