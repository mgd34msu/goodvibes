import type { WorkspaceActionTarget } from '../workspace-actions.ts';

/** The workspace's memory rows open the actions of `/memory` (terminal-shell/memory-command.ts). */
export const MEMORY_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  memory: { command: 'memory', action: 'remember' },
  'memory-search': { command: 'memory', action: 'search' },
  'memory-get': { command: 'memory', action: 'see-record' },
  'memory-link': { command: 'memory', action: 'link' },
  'memory-promote': { command: 'memory', action: 'move' },
  'memory-explain': { command: 'memory', action: 'explain' },
  'memory-export': { command: 'memory', action: 'save' },
  'memory-handoff-export': { command: 'memory', action: 'save' },
  'memory-import': { command: 'memory', action: 'load' },
  'memory-handoff-import': { command: 'memory', action: 'load' },
  'memory-handoff-inspect': { command: 'memory', action: 'inspect' },
  'memory-vector-rebuild': { command: 'memory', action: 'rebuild-index' },
};
