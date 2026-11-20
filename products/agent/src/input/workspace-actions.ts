/**
 * The Agent workspace is a view over the described slash commands
 * (terminal-shell/command-actions/): a row that does something names the
 * command and action it runs, and opening it opens that action's guided form,
 * the same one the slash command opens. The row's name, what it does and
 * whether it only reads all come from the action's description, so the
 * workspace and the command cannot say different things.
 */
import {
  describedCommandByName,
  fillSentence,
  lastsWords,
  renderTypedLine,
  runGuided,
  type ActionDescription,
  type ActionValues,
  type CommandDescription,
} from '@goodvibes/engine/terminal-shell/command-actions';
import type { CommandContext } from './command-registry.ts';

/** What a row runs: a command, one of its actions (by id or typed word), and any values the row fills in. */
export interface WorkspaceActionTarget {
  readonly command: string;
  readonly action?: string | undefined;
  readonly values?: ActionValues | undefined;
}

interface ResolvedTarget {
  readonly command: CommandDescription<never>;
  readonly action: ActionDescription<never> | undefined;
}

/** The described command and action a row names, or undefined while the command is not described. */
export function resolveWorkspaceAction(target: WorkspaceActionTarget): ResolvedTarget | undefined {
  const command = describedCommandByName(target.command);
  if (!command) return undefined;
  const wanted = target.action;
  const action = wanted ? command.actions.find((candidate) => candidate.id === wanted) ?? command.actions.find((candidate) => candidate.word === wanted) : undefined;
  return { command, action };
}

/** The line a person could type for the row. */
export function workspaceActionLine(target: WorkspaceActionTarget): string {
  const resolved = resolveWorkspaceAction(target);
  if (resolved?.action) return renderTypedLine(resolved.command, resolved.action.id, target.values ?? {});
  return `/${target.command}${target.action ? ` ${target.action}` : ''}`;
}

/** The row's name: the action's own label, or the command's title for a row that opens the whole command. */
export function workspaceActionLabel(target: WorkspaceActionTarget): string {
  const resolved = resolveWorkspaceAction(target);
  if (resolved?.action) return resolved.action.label;
  if (resolved && !target.action) return resolved.command.title;
  return workspaceActionLine(target);
}

/** What the row does: the action's sentence, its blanks still to be filled shown as "…". */
export function workspaceActionDetail(target: WorkspaceActionTarget): string {
  const resolved = resolveWorkspaceAction(target);
  if (resolved?.action) {
    const blanks: Record<string, string> = Object.fromEntries(resolved.action.inputs.map((input) => [input.id, '…']));
    const values = { ...blanks, ...target.values };
    return fillSentence(resolved.action.sentence, values, lastsWords(resolved.action, values));
  }
  if (resolved) return `${resolved.command.summary}.`;
  return `Runs ${workspaceActionLine(target)}.`;
}

/** Whether the row only reads (it changes nothing). */
export function workspaceActionReadsOnly(target: WorkspaceActionTarget): boolean {
  const action = resolveWorkspaceAction(target)?.action;
  return action ? action.lasts === 'not-a-change' && action.touches === 'reads' : false;
}

/**
 * Open the row's action over the composer: its guided form, or the command's
 * own list when the row names the whole command. False when this surface
 * cannot show a guided form or the command is not described; the caller then
 * runs the typed line instead.
 */
export function openWorkspaceAction(target: WorkspaceActionTarget, context: CommandContext | null | undefined): boolean {
  const resolved = resolveWorkspaceAction(target);
  if (!resolved || !context?.openSelection) return false;
  // A row whose action the command no longer has opens the command's own list.
  void runGuided(resolved.command, resolved.action ? { action: resolved.action, ...(target.values ? { values: target.values } : {}) } : {}, context);
  return true;
}
