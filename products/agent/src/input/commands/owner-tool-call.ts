/**
 * An action whose work is one call of an Agent tool (a document draft, a saved
 * artifact, a model comparison, a research run): the owner typed the line or
 * answered its guided form, so the call runs as the owner's confirmed act
 * through the registry's owner-confirmed entry. A deny rule or plan mode still
 * refuses. A model never gets here: these actions are owner-only, and a model
 * calls the tool itself, which asks before it changes anything.
 */
import type { ActionDescription } from '@goodvibes/engine/terminal-shell/command-actions';
import type { CommandContext } from '../command-registry.ts';
import { commandRefusal } from './confirmation.ts';

/** The owner-only rule for an action that runs `tool` as the owner's own act. */
export function ownerToolCall(tool: string): NonNullable<ActionDescription<CommandContext>['ownerOnly']> {
  return { reason: `it runs ${tool} as your own confirmed act`, instead: `Call the ${tool} tool, which asks before it changes anything.` };
}

/** A read that runs `tool` as the owner's act: owner-only too, so the model's catalogue sends it to the tool. */
export function ownerRead(tool: string, action: ActionDescription<CommandContext>): ActionDescription<CommandContext> {
  return { ...action, ownerOnly: ownerToolCall(tool) };
}

/** Runs one tool call as the owner's act and returns what it printed; a failed call is a refusal with the tool's reason. */
export async function runOwnerToolCall(ctx: CommandContext, tool: string, args: Record<string, unknown>, what: string): Promise<string> {
  if (ctx.invokedByModel) throw commandRefusal(`Not run: ${what} runs only when you ask for it.`, `Call the ${tool} tool instead.`);
  const registry = ctx.extensions?.toolRegistry;
  if (!registry || typeof registry.executeOwnerConfirmed !== 'function') {
    throw commandRefusal(`Not run: this Agent has no tool registry, so ${tool} cannot run here.`);
  }
  const request = `The owner asked for this: ${what}.`;
  let result: { readonly success: boolean; readonly output?: string | undefined; readonly error?: string | undefined };
  try {
    result = await registry.executeOwnerConfirmed(`command-${tool}`, tool, { ...args }, {
      goal: request,
      criteria: [`Run ${tool} with exactly the values the owner gave.`],
    });
  } catch (error) {
    result = { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.success) throw commandRefusal(`Not done: ${result.error ?? `${tool} did not succeed and gave no reason.`}`);
  return result.output?.trim() || `${what}: done.`;
}

/** Comma- or newline-separated words, trimmed, empty ones dropped. */
export function splitWords(value: string | undefined): readonly string[] {
  return (value ?? '').split(/[,\n]/).map((entry) => entry.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
}

/** One entry per line (an entry may contain commas). */
export function splitLines(value: string | undefined): readonly string[] {
  return (value ?? '').split('\n').map((entry) => entry.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
}

/** A whole number of at least 1, or undefined for blank or not a number. */
export function positiveNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : undefined;
}

/** The fields of `values` that were given, so a blank optional value is left out of the call. */
export function given(values: Readonly<Record<string, string | undefined>>, ...ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const value = values[id]?.trim();
    if (value) out[id] = value;
  }
  return out;
}
