// ============================================================================
// FEATURES PRELOAD API
// ============================================================================
//
// API for installing Claude Code features (agents, skills, commands, hooks)
// to the user's .claude/ directory structure
// ============================================================================

import { ipcRenderer } from 'electron';

export const featuresApi = {
  /**
   * Install an agent to .claude/agents/{name}.md
   */
  installAgent: (data: {
    name: string;
    content: string;
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('feature:installAgent', data),

  /**
   * Install a skill to .claude/skills/{name}.md
   */
  installSkill: (data: {
    name: string;
    content: string;
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('feature:installSkill', data),

  /**
   * Install a command to .claude/commands/{name}.md
   */
  installCommand: (data: {
    name: string;
    content: string;
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('feature:installCommand', data),

  /**
   * Install a hook to .claude/hooks/{name}.sh (or .ps1 on Windows)
   * and update .claude/settings.json with hook configuration
   */
  installHook: (data: {
    name: string;
    script: string;
    eventType: 'PreToolUse' | 'PermissionRequest' | 'PostToolUse' | 'PostToolUseFailure' | 'Notification' | 'UserPromptSubmit' | 'Stop' | 'SubagentStart' | 'SubagentStop' | 'PreCompact' | 'SessionStart' | 'SessionEnd' | 'Setup';
    matcher?: string;
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('feature:installHook', data),

  /**
   * Uninstall an agent from .claude/agents/{name}.md
   */
  uninstallAgent: (data: {
    name: string;
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('feature:uninstallAgent', data),

  /**
   * Uninstall a skill from .claude/skills/{name}.md
   */
  uninstallSkill: (data: {
    name: string;
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('feature:uninstallSkill', data),

  /**
   * Uninstall a command from .claude/commands/{name}.md
   */
  uninstallCommand: (data: {
    name: string;
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('feature:uninstallCommand', data),

  /**
   * Uninstall a hook from .claude/hooks/{name}.sh (or .ps1 on Windows)
   * and remove from .claude/settings.json
   */
  uninstallHook: (data: {
    name: string;
    eventType: 'PreToolUse' | 'PermissionRequest' | 'PostToolUse' | 'PostToolUseFailure' | 'Notification' | 'UserPromptSubmit' | 'Stop' | 'SubagentStart' | 'SubagentStop' | 'PreCompact' | 'SessionStart' | 'SessionEnd' | 'Setup';
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('feature:uninstallHook', data),
};
