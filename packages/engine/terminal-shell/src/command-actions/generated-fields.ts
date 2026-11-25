/**
 * The registry fields a described command no longer writes by hand, each read
 * from its description: usage, the argument hint, the per-action hints, the
 * effect and read words, which typed words are secret, and the confirmation
 * question.
 */
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import type { CommandSecretArgs, TerminalCommandEffect } from '../command-registry.js';
import type { CommandConfirmation } from '../command-confirmation.js';
import {
  actionButton,
  actionSentence,
  effectiveRisk,
  linePattern,
  parseTypedLine,
  riskSentences,
  singleAction,
} from './typed-line.js';
import type { ActionDescription, ActionValues, CommandDescription, InputDescription } from './types.js';

/** The fields `defineCommand` generates; a converted command that also writes one is refused at registration. */
export const GENERATED_COMMAND_FIELDS = [
  'description', 'usage', 'argsHint', 'subcommands', 'effect', 'readVerbs', 'secretArgs', 'rawRest', 'strictArgs', 'confirm', 'aliases', 'hidden',
] as const;

export function generatedUsage(description: CommandDescription<never>): string {
  return description.actions.map((action) => linePattern(action)).join(' | ');
}

export function generatedArgsHint(description: CommandDescription<never>): string {
  const single = singleAction(description);
  if (single) return linePattern(single);
  return `[${description.actions.map((action) => action.word).join('|')}]`;
}

export function generatedSubcommandHints(description: CommandDescription<never>): Readonly<Record<string, string>> {
  const hints: Record<string, string> = {};
  if (singleAction(description)) return hints;
  for (const action of description.actions) {
    const pattern = linePattern(action).slice(action.word.length).trim();
    hints[action.word] = pattern ? `${pattern}   ${action.label}` : action.label;
  }
  return hints;
}

export function generatedEffect(description: CommandDescription<never>): { readonly effect: TerminalCommandEffect; readonly readVerbs: readonly string[] } {
  const reads = description.actions.filter((action) => action.touches === 'reads').map((action) => action.word);
  if (reads.length === description.actions.length) return { effect: 'read-only', readVerbs: reads };
  return { effect: 'mixed', readVerbs: reads };
}

function secretInput(input: InputDescription): boolean {
  return input.kind === 'secret';
}

/**
 * Which typed words hold a secret, read with the one parser the command runs
 * on (`parseTypedLine`), so the input history masks exactly what the action
 * takes as the secret, wherever options, `--yes` or a `--` put it: a secret
 * input's words, as a whole word or as the value of `--flag=value`. A line
 * the parser cannot read (an unknown option, words after a `--` the action
 * does not take) has every word after its action word masked: any of them may
 * be the secret, and the line is refused anyway.
 */
function typedSecretIndexes(description: CommandDescription<never>, args: readonly string[]): number[] {
  const parsed = parseTypedLine(description, args);
  if (!('action' in parsed)) return [];
  const secrets = parsed.action.inputs.filter(secretInput);
  if (secrets.length === 0) return [];
  const actionIndex = singleAction(description) ? -1 : args.findIndex((word) => word !== '--yes');
  const after = args.map((word, index) => ({ word, index })).filter((entry) => entry.index > actionIndex && entry.word !== '--yes');
  if (parsed.problem !== undefined) return after.map((entry) => entry.index);
  const words = new Set<string>();
  for (const input of secrets) {
    if (!parsed.given.includes(input.id)) continue;
    const value = parsed.values[input.id] ?? '';
    if (value) words.add(value);
    for (const part of value.split(/[\n ]/)) if (part) words.add(part);
  }
  if (words.size === 0) return [];
  return after.filter(({ word }) => words.has(word)
    || (word.startsWith('--') && word.includes('=') && words.has(word.slice(word.indexOf('=') + 1)))).map((entry) => entry.index);
}

export function generatedSecretArgs(description: CommandDescription<never>): CommandSecretArgs {
  const hasSecret = description.actions.some((action) => action.inputs.some(secretInput));
  return hasSecret ? { select: (args) => typedSecretIndexes(description, args) } : {};
}

/** The refusal an owner-only action gets when a model runs it. */
export function ownerOnlyActionRefusal(commandName: string, action: ActionDescription<never>, reason: string, instead: string | undefined): RefusalError {
  return new RefusalError(refusal({
    code: 'OWNER_ONLY_COMMAND',
    state: 'not run; nothing was changed',
    reason: `/${commandName} ${action.word} (${action.label}) only counts when the owner types it: ${reason}`,
    next: [`Ask the owner to type /${commandName} ${action.word} or to choose "${action.label}" from /${commandName}`, ...(instead ? [instead] : [])],
    status: 403,
  }));
}

/** Owner-only for this line: declared, or a value that loosens a protection (a model can never loosen one). */
export function ownerOnlyFor(action: ActionDescription<never>, values: ActionValues): { readonly reason: string; readonly instead: string | undefined } | undefined {
  if (action.ownerOnly) return action.ownerOnly;
  if (effectiveRisk(action, values) === 'loosens-a-protection') return { reason: 'it loosens a protection', instead: undefined };
  return undefined;
}

/**
 * The question a complete line asks before it runs. A line the owner typed in
 * full is the request: it asks nothing, whatever its risk, and its result says
 * what the risk did (actionRiskDoneLine). A line a model runs is put to the
 * owner when its risk is not none; a model-run owner-only line is refused
 * here, before anything is asked.
 */
export function generatedConfirm(description: CommandDescription<never>) {
  return (args: readonly string[], context: { readonly invokedByModel?: boolean | undefined }): CommandConfirmation | undefined => {
    if (context.invokedByModel !== true) return undefined;
    const parsed = parseTypedLine(description, args);
    if (!('action' in parsed) || parsed.problem || parsed.missing.length > 0) return undefined;
    const owner = ownerOnlyFor(parsed.action, parsed.values);
    if (owner) throw ownerOnlyActionRefusal(description.name, parsed.action, owner.reason, owner.instead);
    const risk = effectiveRisk(parsed.action, parsed.values);
    // An action that asks its own question, with what it read, is asked once: by itself.
    if (risk === 'none' || parsed.action.asksItself) return undefined;
    return {
      title: `${parsed.action.label}?`,
      detail: `${actionSentence(parsed.action, parsed.values)} ${riskSentences(parsed.action, parsed.values)}`,
      confirmLabel: actionButton(parsed.action),
    };
  };
}
