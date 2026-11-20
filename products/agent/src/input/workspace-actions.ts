/**
 * Workspace rows that open a described command's action instead of a form.
 * Each converted command adds its rows in its own file under
 * `workspace-actions/`; the workspace consults this registry before it opens
 * a form, so a row needs no edit of the category tables to start using the
 * guided path. When every command is converted, the rows name their actions
 * directly and this registry and the form engine go.
 */
import { describedCommandByName, runGuided } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import type { CommandContext } from './command-registry.ts';
import { TODO_WORKSPACE_ACTIONS } from './workspace-actions/todo.ts';
import { SECRETS_WORKSPACE_ACTIONS } from './workspace-actions/secrets.ts';
import { MEMORY_WORKSPACE_ACTIONS } from './workspace-actions/memory.ts';

export interface WorkspaceActionTarget {
  /** The described command's name. */
  readonly command: string;
  /** The action id in its description. */
  readonly action: string;
}

// Each converted command spreads its own rows here. /mcp's rows name its actions directly (`command` rows), so it adds none.
const TARGETS: ReadonlyMap<string, WorkspaceActionTarget> = new Map(Object.entries({
  ...TODO_WORKSPACE_ACTIONS,
  ...SECRETS_WORKSPACE_ACTIONS,
  ...MEMORY_WORKSPACE_ACTIONS,
}));

/** The action a workspace row's form kind now opens, or undefined while the row still opens its form. */
export function workspaceActionFor(editorKind: string): WorkspaceActionTarget | undefined {
  return TARGETS.get(editorKind);
}

/**
 * Open the action's guided path over the composer. False when it cannot be
 * shown here (no picker on this surface, or the command is not described), so
 * the row falls back to its form.
 */
export function openWorkspaceAction(target: WorkspaceActionTarget, context: CommandContext | null | undefined): boolean {
  const described = describedCommandByName(target.command);
  const action = described?.actions.find((candidate) => candidate.id === target.action);
  if (!described || !action || !context?.openSelection) return false;
  void runGuided(described, { action }, context);
  return true;
}
