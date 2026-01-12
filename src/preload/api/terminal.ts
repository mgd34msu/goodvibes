// ============================================================================
// TERMINAL PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const terminalApi = {
  startClaude: (options: { cwd?: string; name?: string; resumeSessionId?: string; sessionType?: string }) =>
    ipcRenderer.invoke('start-claude', options),
  startPlainTerminal: (options: { cwd?: string; name?: string }) =>
    ipcRenderer.invoke('start-plain-terminal', options),
  terminalInput: (id: number, data: string) =>
    ipcRenderer.invoke('terminal-input', { id, data }),
  terminalResize: (id: number, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal-resize', { id, cols, rows }),
  killTerminal: (id: number) =>
    ipcRenderer.invoke('kill-terminal', id),
  getTerminals: () =>
    ipcRenderer.invoke('get-terminals'),
};
