import type { CommandContext } from '../input/command-registry.ts';
import type { AgentVibeFile, BlockedAgentVibeFile } from '@goodvibes/engine/terminal-shell/agent-turn/vibe-file';
import { discoverVibeFiles } from '@goodvibes/engine/terminal-shell/agent-turn/vibe-file';
import { previewHarnessText } from '@goodvibes/engine/terminal-shell/agent-turn/preview-text';
import { homeRelativePath } from '@goodvibes/engine/terminal-shell/agent-turn/home-path';

export interface AgentHarnessVibeHealthFile {
  readonly path: string;
  readonly scope: string;
  readonly truncated?: boolean;
}

export interface AgentHarnessVibeHealthBlockedFile {
  readonly path: string;
  readonly scope: string;
  readonly reason: string;
}

export interface AgentHarnessVibeHealth {
  readonly status: 'ready' | 'check' | 'recommended';
  readonly applied: number;
  readonly blocked: number;
  readonly truncated: number;
  readonly files: readonly AgentHarnessVibeHealthFile[];
  readonly blockedFiles: readonly AgentHarnessVibeHealthBlockedFile[];
  readonly searchedPaths: readonly string[];
  readonly projectInitPath: string;
  readonly globalInitPath: string;
  readonly nextAction: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly signals: readonly string[];
}

function describeVibeFile(file: AgentVibeFile, home: string): AgentHarnessVibeHealthFile {
  return {
    path: homeRelativePath(file.path, home),
    scope: file.scope,
    ...(file.truncated ? { truncated: true } : {}),
  };
}

function describeBlockedVibeFile(file: BlockedAgentVibeFile, home: string): AgentHarnessVibeHealthBlockedFile {
  return {
    path: homeRelativePath(file.path, home),
    scope: file.scope,
    reason: previewHarnessText(file.reason, 180),
  };
}

export function agentHarnessVibeHealth(context: CommandContext): AgentHarnessVibeHealth {
  const shellPaths = context.workspace.shellPaths;
  if (!shellPaths) {
    return {
      status: 'recommended',
      applied: 0,
      blocked: 0,
      truncated: 0,
      files: [],
      blockedFiles: [],
      searchedPaths: [],
      projectInitPath: '',
      globalInitPath: '',
      nextAction: 'VIBE.md discovery is unavailable because shell paths are not wired into this runtime.',
      userRoute: 'Agent Workspace -> Local Context -> Inspect VIBE.md; /personas vibe',
      modelRoute: 'vibe action:"status"',
      signals: ['VIBE.md discovery unavailable: shell paths are not wired.'],
    };
  }
  const snapshot = discoverVibeFiles(shellPaths);
  const truncated = snapshot.files.filter((file) => file.truncated);
  const status = snapshot.blocked.length > 0 || truncated.length > 0
    ? 'check'
    : snapshot.files.length > 0
      ? 'ready'
      : 'recommended';
  const nextAction = snapshot.blocked.length > 0
    ? 'Run /personas vibe, inspect blocked files, and edit or remove secret-looking content before relying on personality instructions.'
    : truncated.length > 0
      ? 'Run /personas vibe and shorten the truncated VIBE.md file if the omitted content matters.'
      : snapshot.files.length > 0
        ? 'Review /personas vibe when changing project or global personality instructions.'
        : 'Create a project VIBE.md or import a reviewed persona when the user wants a custom assistant feel.';
  const signals = [
    `applied VIBE.md files: ${snapshot.files.length}`,
    `blocked VIBE.md files: ${snapshot.blocked.length}`,
    `truncated VIBE.md files: ${truncated.length}`,
    ...(snapshot.files.slice(0, 3).map((file) => `${file.scope}: ${homeRelativePath(file.path, shellPaths.homeDirectory)}${file.truncated ? ' (truncated)' : ''}`)),
    ...(snapshot.blocked.slice(0, 3).map((file) => `blocked ${file.scope}: ${homeRelativePath(file.path, shellPaths.homeDirectory)} - ${previewHarnessText(file.reason, 96)}`)),
  ];
  return {
    status,
    applied: snapshot.files.length,
    blocked: snapshot.blocked.length,
    truncated: truncated.length,
    files: snapshot.files.map((file) => describeVibeFile(file, shellPaths.homeDirectory)),
    blockedFiles: snapshot.blocked.map((file) => describeBlockedVibeFile(file, shellPaths.homeDirectory)),
    searchedPaths: snapshot.searchedPaths.map((path) => homeRelativePath(path, shellPaths.homeDirectory)),
    projectInitPath: homeRelativePath(snapshot.projectInitPath, shellPaths.homeDirectory),
    globalInitPath: homeRelativePath(snapshot.globalInitPath, shellPaths.homeDirectory),
    nextAction,
    userRoute: 'Agent Workspace -> Local Context -> Inspect VIBE.md; /personas vibe',
    modelRoute: 'vibe action:"status"',
    signals,
  };
}
