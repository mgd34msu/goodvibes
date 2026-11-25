/**
 * ask-words.ts, how an ask for a model's `capability_run` call reads: the
 * capability's own label as the question ("Bind a key to an action?"), its
 * sentence filled from the inputs, and each input on a labelled line, a
 * secret one hidden. Never the call's arguments as JSON. Each program that
 * decides such calls registers it over the catalog it decides by (the
 * terminal programs' own, the daemon's).
 */
import { presentToolAskWith } from '../permissions/tool-ask-words.js';
import { CAPABILITY_RUN_TOOL } from '../tools/capability/definitions.js';
import type { CapabilityEntry } from './catalog.js';
import { fillSentence, hiddenSecret, lastsWords } from './outcome.js';
import type { FixedChoice } from './types.js';

function valueText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join(', ');
  return undefined;
}

const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The words of one capability_run call, or undefined when its id names no capability of `lookup`. */
export function capabilityAskWords(lookup: (id: string) => CapabilityEntry | undefined, args: Readonly<Record<string, unknown>>) {
  const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
  if (!id) return undefined;
  const entry = lookup(id);
  const raw = args['inputs'] && typeof args['inputs'] === 'object' && !Array.isArray(args['inputs']) ? args['inputs'] as Record<string, unknown> : {};
  if (!entry) {
    // A daemon method named by its id: named so, each field it is sent on its own line.
    const lines = Object.entries(raw).flatMap(([name, value]) => {
      const text = valueText(value) ?? (value !== undefined ? JSON.stringify(value) : undefined);
      return text === undefined ? [] : [`${name}: ${clip(text.replace(/\s+/g, ' '), 120)}`];
    });
    return { question: `Call the daemon's ${id}?`, lines };
  }
  const secret = new Set(entry.inputs.filter((input) => input.kind === 'secret').map((input) => input.id));
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const text = valueText(value);
    // A secret's value arrives hidden already ("(hidden, 12 characters)"); it is never shown, whatever arrived.
    if (text !== undefined) values[name] = secret.has(name) ? (text.startsWith('(hidden') ? text : hiddenSecret(text)) : clip(text.replace(/\s+/g, ' '), 120);
  }
  // A choice is shown by its label ("Open the menu"), the value it stands for after it when they differ.
  const shown = Object.fromEntries(Object.entries(values).map(([name, value]) => {
    const input = entry.inputs.find((candidate) => candidate.id === name);
    const choice = input && Array.isArray(input.choices) ? (input.choices as readonly FixedChoice[]).find((candidate) => candidate.value === value) : undefined;
    return [name, choice && choice.label !== value ? choice.label : value];
  }));
  const lines = [
    fillSentence(entry.sentence, shown, lastsWords(entry, values)),
    ...entry.inputs.flatMap((input) => shown[input.id] !== undefined ? [`${input.label}: ${shown[input.id]}`] : []),
    // An input the capability does not have is shown as given, so nothing the call carries is left out of the ask.
    ...Object.keys(shown).filter((name) => !entry.inputs.some((input) => input.id === name)).map((name) => `${name}: ${shown[name]}`),
  ];
  return { question: `${entry.label}?`, lines };
}

/** Word the asks for `capability_run` calls from this catalog (the last one registered in a process is used). */
export function presentCapabilityRunAsks(lookup: (id: string) => CapabilityEntry | undefined): () => void {
  return presentToolAskWith(CAPABILITY_RUN_TOOL, (args) => capabilityAskWords(lookup, args));
}
