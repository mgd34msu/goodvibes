/**
 * extract.ts, turning a probe result into one observation.
 *
 * Three extractors, all bounded and all pure:
 *   jsonpath , `$`, `.key`, `["key"]`, `[0]`, `[*]` against parsed JSON
 *   regex    , one match, optionally a capture group
 *   jq-subset, a `.path[…]` selector optionally piped into length/keys/first/last
 *
 * None of them evaluates an expression. `jq-subset` is a hand-written walker
 * over a validated selector grammar, not a jq interpreter, precisely so there
 * is no expression language to escape from.
 */

import { createHash } from 'node:crypto';
import type { TriggerExtract, TriggerObservation, TriggerValue } from './types.js';
import { compiledRegex } from './validation.js';

const MAX_REGEX_INPUT_CHARS = 65_536;

/** Deterministic string form used by change / transition / dedup comparisons. */
export function stableText(value: TriggerValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  const entries = Object.entries(value as Record<string, TriggerValue>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${key}:${stableText(entry)}`).join(',')}}`;
}

/** Numeric coercion, or null when the value simply is not a number. */
export function numericOf(value: TriggerValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(value)) return value.length;
  return null;
}

/** Characters of a result kept on a stored observation; a change past them is still seen through the hash. */
export const OBSERVATION_SAMPLE_CHARS = 512;
/** Nesting kept from a probe result; anything deeper is held as its text form. */
const MAX_OBSERVED_DEPTH = 32;

/**
 * The probe result as plain JSON data. A number JSON cannot hold (`1e999`
 * parses to Infinity) becomes its text, and nesting past the bound becomes the
 * text of that branch, so an observation can always be stored.
 */
export function toJsonValue(value: unknown, depth = 0): TriggerValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'object') return value === undefined ? null : String(value);
  if (depth >= MAX_OBSERVED_DEPTH) return stableText(value as TriggerValue);
  if (Array.isArray(value)) return value.map((entry: unknown) => toJsonValue(entry, depth + 1));
  const result: Record<string, TriggerValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== undefined) result[key] = toJsonValue(entry, depth + 1);
  }
  return result;
}

/** Short digest of an observation's full text; the identity change and transition rules compare. */
export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** The digest of an observation, computed for one saved before observations carried it. */
export function observationHash(observation: TriggerObservation): string {
  return observation.hash ?? textHash(observation.text);
}

/** Text for a reason or prompt: the sample, marked when it was cut. */
export function observationLabel(observation: TriggerObservation): string {
  return observation.truncated === true ? `${observation.text}… (${observation.hash ?? 'cut'})` : observation.text;
}

/** One observation, made once per check: plain JSON data with its digest. The rule sees this, whole. */
export function toObservation(raw: TriggerValue, at: number): TriggerObservation {
  const value = toJsonValue(raw);
  const text = stableText(value);
  return { at, value, text, numeric: numericOf(value), hash: textHash(text) };
}

/**
 * The form an observation is kept in. A value whose text is longer than the
 * sample keeps only the sample (as text), its digest and its number, so the
 * ring never holds a body and a change past the sample is still seen.
 */
export function storedObservation(observation: TriggerObservation): TriggerObservation {
  if (observation.text.length <= OBSERVATION_SAMPLE_CHARS) return observation;
  const sample = observation.text.slice(0, OBSERVATION_SAMPLE_CHARS);
  return { at: observation.at, value: sample, text: sample, numeric: observation.numeric, hash: observationHash(observation), truncated: true };
}

function parseJsonIfPossible(input: TriggerValue): TriggerValue {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (trimmed.length === 0) return input;
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"' && !/^-?\d/.test(trimmed) && trimmed !== 'true' && trimmed !== 'false' && trimmed !== 'null') {
    return input;
  }
  try {
    return JSON.parse(trimmed) as TriggerValue;
  } catch {
    return input;
  }
}

interface PathStep {
  readonly kind: 'key' | 'index' | 'wildcard';
  readonly key?: string;
  readonly index?: number;
}

/** Parses the validated JSONPath subset into steps. Never sees untrusted syntax. */
function parseJsonPath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  let cursor = 1; // skip the leading `$`
  while (cursor < path.length) {
    const char = path[cursor];
    if (char === '.') {
      const end = findNext(path, cursor + 1);
      steps.push({ kind: 'key', key: path.slice(cursor + 1, end) });
      cursor = end;
      continue;
    }
    if (char === '[') {
      const close = path.indexOf(']', cursor);
      if (close === -1) break;
      const inner = path.slice(cursor + 1, close);
      if (inner === '*') {
        steps.push({ kind: 'wildcard' });
      } else if (inner.startsWith('"')) {
        steps.push({ kind: 'key', key: inner.slice(1, -1) });
      } else {
        steps.push({ kind: 'index', index: Number(inner) });
      }
      cursor = close + 1;
      continue;
    }
    cursor += 1;
  }
  return steps;
}

function findNext(path: string, from: number): number {
  for (let index = from; index < path.length; index += 1) {
    const char = path[index];
    if (char === '.' || char === '[') return index;
  }
  return path.length;
}

function applySteps(input: TriggerValue, steps: readonly PathStep[]): TriggerValue {
  let current: TriggerValue = input;
  for (const [position, step] of steps.entries()) {
    if (current === null || current === undefined) return null;
    if (step.kind === 'wildcard') {
      let items: readonly TriggerValue[];
      if (Array.isArray(current)) items = current as readonly TriggerValue[];
      else if (typeof current === 'object') items = Object.values(current as Record<string, TriggerValue>);
      else return null;
      // The steps after `[*]` apply to every element, so `$.items[*].name` yields the names.
      const rest = steps.slice(position + 1);
      return rest.length === 0 ? items : items.map((item) => applySteps(item, rest));
    }
    if (step.kind === 'index') {
      if (!Array.isArray(current)) return null;
      const entry = current[step.index ?? 0];
      current = entry === undefined ? null : entry;
      continue;
    }
    if (typeof current !== 'object' || Array.isArray(current)) return null;
    const entry = (current as Record<string, TriggerValue>)[step.key ?? ''];
    current = entry === undefined ? null : entry;
  }
  return current;
}

/**
 * Parses the validated jq subset into the same step list plus an optional
 * terminal filter. `.a.b[0] | length` becomes steps + 'length'.
 */
function parseJqSubset(expression: string): { steps: PathStep[]; filter: string | null } {
  const [selectorPart, filterPart] = expression.split('|');
  const selector = (selectorPart ?? '').trim();
  const filter = filterPart ? filterPart.trim() : null;
  const steps: PathStep[] = [];
  let cursor = 0;
  while (cursor < selector.length) {
    const char = selector[cursor];
    if (char === '.') {
      const end = findNext(selector, cursor + 1);
      const key = selector.slice(cursor + 1, end);
      if (key.length > 0) steps.push({ kind: 'key', key });
      cursor = end;
      continue;
    }
    if (char === '[') {
      const close = selector.indexOf(']', cursor);
      if (close === -1) break;
      const inner = selector.slice(cursor + 1, close);
      steps.push(inner.length === 0 ? { kind: 'wildcard' } : { kind: 'index', index: Number(inner) });
      cursor = close + 1;
      continue;
    }
    cursor += 1;
  }
  return { steps, filter };
}

function applyJqFilter(value: TriggerValue, filter: string): TriggerValue {
  switch (filter) {
    case 'length':
      if (Array.isArray(value)) return value.length;
      if (typeof value === 'string') return value.length;
      if (value !== null && typeof value === 'object') return Object.keys(value as Record<string, TriggerValue>).length;
      return 0;
    case 'keys':
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value as Record<string, TriggerValue>).sort();
      }
      return [];
    case 'first':
      return Array.isArray(value) ? (value[0] ?? null) : value;
    case 'last':
      return Array.isArray(value) ? (value[value.length - 1] ?? null) : value;
    default:
      return value;
  }
}

/**
 * Runs one extractor over a probe result. Throws nothing on a miss, a miss is
 * `null`, which is a perfectly good observation for a `change` rule to see.
 */
export function runExtract(extract: TriggerExtract, input: TriggerValue): TriggerValue {
  switch (extract.kind) {
    case 'raw':
      return input;
    case 'jsonpath': {
      const parsed = parseJsonIfPossible(input);
      return applySteps(parsed, parseJsonPath(extract.path));
    }
    case 'jq-subset': {
      const parsed = parseJsonIfPossible(input);
      const { steps, filter } = parseJqSubset(extract.expression);
      const selected = applySteps(parsed, steps);
      return filter ? applyJqFilter(selected, filter) : selected;
    }
    case 'regex': {
      // The pattern runs synchronously on the daemon, so the text it scans is bounded.
      const full = typeof input === 'string' ? input : stableText(input);
      const source = full.length > MAX_REGEX_INPUT_CHARS ? full.slice(0, MAX_REGEX_INPUT_CHARS) : full;
      const regex = compiledRegex(extract.pattern, 'extract', extract.flags);
      const match = regex.exec(source);
      if (!match) return null;
      const group = extract.group ?? 0;
      return match[group] ?? null;
    }
    default:
      return null;
  }
}
