// ============================================================================
// PROJECTS PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const projectsApi = {
  // ============================================================================
  // FILE/FOLDER
  // ============================================================================
  selectFolder: () =>
    ipcRenderer.invoke('select-folder'),
  createFolder: () =>
    ipcRenderer.invoke('create-folder'),
  openInExplorer: (folderPath: string) =>
    ipcRenderer.invoke('open-in-explorer', folderPath),

  // ============================================================================
  // RECENT PROJECTS
  // ============================================================================
  getRecentProjects: () =>
    ipcRenderer.invoke('get-recent-projects'),
  addRecentProject: (projectPath: string, name?: string) =>
    ipcRenderer.invoke('add-recent-project', { path: projectPath, name }),
  removeRecentProject: (projectPath: string) =>
    ipcRenderer.invoke('remove-recent-project', projectPath),
  pinProject: (projectPath: string) =>
    ipcRenderer.invoke('pin-project', projectPath),
  clearRecentProjects: () =>
    ipcRenderer.invoke('clear-recent-projects'),

  // ============================================================================
  // EXPORT
  // ============================================================================
  exportSession: (sessionId: string, format: string) =>
    ipcRenderer.invoke('export-session', { sessionId, format }),
  bulkExport: (sessionIds: string[]) =>
    ipcRenderer.invoke('bulk-export', sessionIds),
};
