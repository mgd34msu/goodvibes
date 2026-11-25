/**
 * Inputs checked against a capability's definition before it runs, the same
 * for a model's call, a script's and a request over the wire: unknown names,
 * a required input left out, a value that is not one of a fixed list's
 * choices, a number or yes/no that is not one. A choice read from a live list
 * is checked by the handler that reads the list.
 */
import { withDefaults, type CapabilityEntry } from './catalog.js';
import type { FixedChoice } from './types.js';

export type CapabilityInputCheck =
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly problem: string; readonly input?: string | undefined };

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // A repeating option's values arrive as a list and are joined with a newline, as the typed line joins them.
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join('\n');
  return undefined;
}

export function checkCapabilityInputs(entry: Pick<CapabilityEntry, 'id' | 'inputs'>, raw: unknown): CapabilityInputCheck {
  const given = raw === undefined || raw === null ? {} : raw;
  if (typeof given !== 'object' || Array.isArray(given)) return { ok: false, problem: `${entry.id} takes its inputs as an object of names and values.` };
  const known = new Map(entry.inputs.map((input) => [input.id, input]));
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
    const input = known.get(name);
    if (!input) {
      const names = entry.inputs.map((each) => each.id).join(', ');
      return { ok: false, input: name, problem: `${entry.id} has no input named ${name}. ${names ? `Its inputs are: ${names}.` : 'It takes no inputs.'}` };
    }
    const text = asText(value);
    if (text === undefined) return { ok: false, input: name, problem: `${name} of ${entry.id} takes text, not ${Array.isArray(value) ? 'a list of other values' : typeof value}.` };
    values[name] = text;
  }
  for (const input of entry.inputs) {
    const value = values[input.id];
    if (value === undefined || value === '') {
      if (input.required === true && !(input.showWhen && values[input.showWhen.input] !== input.showWhen.is)) {
        return { ok: false, input: input.id, problem: `${entry.id} needs ${input.id} (${input.label}): ${input.help}.` };
      }
      continue;
    }
    if (Array.isArray(input.choices)) {
      const choices = input.choices as readonly FixedChoice[];
      for (const part of value.split('\n')) {
        if (!choices.some((choice) => choice.value === part)) {
          return { ok: false, input: input.id, problem: `${input.id} of ${entry.id} is one of ${choices.map((choice) => `${choice.value} (${choice.label})`).join(', ')}, not "${part}".` };
        }
      }
    }
    if ((input.kind === 'number' || input.kind === 'money') && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
      return { ok: false, input: input.id, problem: `${input.id} of ${entry.id} takes a number, not "${value}".` };
    }
    if (input.kind === 'yes-no' && !Array.isArray(input.choices) && !['yes', 'no'].includes(value)) {
      return { ok: false, input: input.id, problem: `${input.id} of ${entry.id} is yes or no, not "${value}".` };
    }
  }
  return { ok: true, values: withDefaults(entry, values) };
}
