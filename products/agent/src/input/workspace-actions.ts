/**
 * The Agent workspace is a view over the described slash commands
 * (terminal-shell/command-actions/): a row that does something names the
 * command and action it runs, and opening it opens that action's guided form,
 * the same one the slash command opens. The row's name, what it does and
 * whether it only reads all come from the action's description, so the
 * workspace and the command cannot say different things.
 */
import {
  daemonCapabilityAction,
  describedCommandByName,
  fillSentence,
  lastsWords,
  renderTypedLine,
  runGuided,
  sessionCapabilityAction,
  type ActionDescription,
  type ActionValues,
  type CommandDescription,
} from '@goodvibes/engine/terminal-shell/command-actions';
import { DAEMON_CAPABILITIES, SESSION_CAPABILITIES, type CapabilityDefinition } from '@goodvibes/engine/platform/platform/capabilities';
import type { SessionCapabilityServices } from '@goodvibes/engine/terminal-shell/agent-turn/capability-tools';
import type { CommandContext } from './command-registry.ts';
import { capabilityBinding } from './commands/capability-binding.ts';
import { sessionCapabilityServices } from './commands/session-capabilities.ts';

/** What a row runs: a command, one of its actions (by id or typed word), and any values the row fills in. */
export interface WorkspaceActionTarget {
  readonly command: string;
  readonly action?: string | undefined;
  readonly values?: ActionValues | undefined;
}

interface ResolvedTarget {
  readonly command: CommandDescription<never>;
  readonly action: ActionDescription<never> | undefined;
  /** True when the row runs a daemon capability no slash command carries: never as a typed line. */
  readonly capability?: true | undefined;
}

/**
 * A daemon capability the row names by its command and action (`knowledge ingest-url`, `memory remember`) once no
 * slash command carries it: its definition's action, run through the daemon's `capabilities.run` as the owner's own
 * request, so every write reaches the daemon's one store (its knowledge, memory and profile).
 */
function daemonCapabilityTarget(target: WorkspaceActionTarget): ResolvedTarget | undefined {
  const wanted = target.action;
  if (!wanted) return undefined;
  const named = (entry: { readonly definition: { readonly actionId: string; readonly word: string }; readonly command: { readonly name: string } }): boolean =>
    entry.command.name === target.command && (entry.definition.actionId === wanted || entry.definition.word === wanted);
  const moved = DAEMON_CAPABILITIES.find(named);
  // One that runs where the conversation is (starting a routine): run here, with this conversation's services.
  const here = moved ? undefined : SESSION_CAPABILITIES.find(named);
  if (here) {
    const action = sessionCapabilityAction<CommandContext, SessionCapabilityServices>(here.definition as unknown as CapabilityDefinition<SessionCapabilityServices>, sessionCapabilityServices,
      { terminalOnly: 'It runs in this conversation.' }) as unknown as ActionDescription<never>;
    const command: CommandDescription<never> = { name: here.command.name, title: here.command.title, summary: here.definition.label, group: 'Knowledge', actions: [action] };
    return { command, action, capability: true };
  }
  if (!moved) return undefined;
  const action = daemonCapabilityAction<CommandContext>(moved.definition as unknown as CapabilityDefinition<never>, capabilityBinding) as unknown as ActionDescription<never>;
  const command: CommandDescription<never> = { name: moved.command.name, title: moved.command.title, summary: moved.definition.label, group: 'Knowledge', actions: [action] };
  return { command, action, capability: true };
}

/** The described command and action a row names (or the daemon capability it names), or undefined while neither is there. */
export function resolveWorkspaceAction(target: WorkspaceActionTarget): ResolvedTarget | undefined {
  const command = describedCommandByName(target.command);
  const wanted = target.action;
  const action = command && wanted ? command.actions.find((candidate) => candidate.id === wanted) ?? command.actions.find((candidate) => candidate.word === wanted) : undefined;
  if (command && (action || !wanted)) return { command, action };
  return daemonCapabilityTarget(target) ?? (command ? { command, action } : undefined);
}

/** The line a person could type for the row. */
export function workspaceActionLine(target: WorkspaceActionTarget): string {
  const resolved = resolveWorkspaceAction(target);
  // A capability no slash command carries has no line to type: its name stands for it.
  if (resolved?.capability && resolved.action) return resolved.action.label;
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
