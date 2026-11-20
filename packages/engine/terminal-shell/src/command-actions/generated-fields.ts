/**
 * The registry fields a described command no longer writes by hand, each read
 * from its description: usage, the argument hint, the per-action hints, the
 * effect and read words, which typed words are secret, and the confirmation
 * question.
 */
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import type { CommandSecretArgs, TerminalCommandEffect } from '../command-registry.js';
import type { CommandConfirmation } from '../command-confirmation.js';
import {
  actionButton,
  actionSentence,
  effectiveRisk,
  linePattern,
  parseTypedLine,
  riskWords,
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
  return `[${description.actions.map((action) => action.word).join('|')}]`;
}

export function generatedSubcommandHints(description: CommandDescription<never>): Readonly<Record<string, string>> {
  const hints: Record<string, string> = {};
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

export function generatedSecretArgs(description: CommandDescription<never>): CommandSecretArgs {
  const subcommands: Record<string, number[] | { from: number }> = {};
  const flags = new Set<string>();
  for (const action of description.actions) {
    for (const input of action.inputs.filter(secretInput)) {
      if ('position' in input.typed) {
        const list = subcommands[action.word];
        const positions = Array.isArray(list) ? list : [];
        positions.push(input.typed.position);
        subcommands[action.word] = positions;
      } else if ('flag' in input.typed) {
        flags.add(input.typed.flag);
      } else {
        subcommands[action.word] = { from: 1 + action.inputs.filter((other) => 'position' in other.typed).length };
      }
    }
  }
  return {
    ...(Object.keys(subcommands).length > 0 ? { subcommands } : {}),
    ...(flags.size > 0 ? { flags: [...flags] } : {}),
  };
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
 * The question a complete line asks before it runs: any risk other than none
 * asks; a read or a risk-free change runs at once. A model-run owner-only line
 * is refused here, before anything is asked.
 */
export function generatedConfirm(description: CommandDescription<never>) {
  return (args: readonly string[], context: { readonly invokedByModel?: boolean | undefined }): CommandConfirmation | undefined => {
    const parsed = parseTypedLine(description, args);
    if (!('action' in parsed) || parsed.problem || parsed.missing.length > 0) return undefined;
    const owner = ownerOnlyFor(parsed.action, parsed.values);
    if (owner && context.invokedByModel === true) throw ownerOnlyActionRefusal(description.name, parsed.action, owner.reason, owner.instead);
    const risk = effectiveRisk(parsed.action, parsed.values);
    if (risk === 'none') return undefined;
    return {
      title: `${parsed.action.label}?`,
      detail: `${actionSentence(parsed.action, parsed.values)} This ${riskWords(risk)}.`,
      confirmLabel: actionButton(parsed.action),
    };
  };
}
