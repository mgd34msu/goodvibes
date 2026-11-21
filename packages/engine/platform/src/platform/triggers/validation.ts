/**
 * validation.ts, the door the declarative DSL is checked at.
 *
 * The rule this file exists to enforce: a trigger definition is DATA. There is
 * no probe kind that evaluates a JS expression, no extract kind that runs code,
 * and no fire action that composes a new command at fire time. The platform has no
 * JS sandbox, and a config-driven unattended watcher is not the place to add
 * one, so anything that smells like code is rejected here rather than defended
 * against later.
 *
 * Probes are argv-form: a command probe takes `command` plus an `args` array
 * and is spawned without a shell, so no extracted value can ever become a shell
 * metacharacter. Nothing in a probe is interpolated at run time.
 */

import { deliveryChannelProblem } from '../channels/delivery/types.js';
import type {
  ComparisonOperator,
  TriggerDefinition,
  TriggerExtract,
  TriggerFireAction,
  TriggerProbe,
  TriggerRule,
  TriggerSpec,
  WindowAggregate,
} from './types.js';

export class TriggerDefinitionError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'TriggerDefinitionError';
    this.field = field;
  }
}

const PROBE_KINDS = new Set(['http', 'file', 'command', 'platform-tool']);
const EXTRACT_KINDS = new Set(['jsonpath', 'regex', 'jq-subset', 'raw']);
const RULE_KINDS = new Set([
  'change',
  'value',
  'transition',
  'threshold',
  'debounce-n',
  'dedup-ttl',
  'rate-of-change',
  'windowed-aggregate',
  'correlation',
]);
const ACTION_KINDS = new Set(['agent-turn', 'action-grant']);
/** The operators rules.ts compare() implements; the Record keeps the list in step with the type. */
const COMPARISON_OPERATORS = new Set(Object.keys({
  eq: true, ne: true, lt: true, lte: true, gt: true, gte: true, contains: true, 'not-contains': true, matches: true,
} satisfies Record<ComparisonOperator, true>));
/** The aggregates rules.ts aggregate() computes. */
const WINDOW_AGGREGATES = new Set(Object.keys({
  min: true, max: true, mean: true, sum: true, count: true, stddev: true,
} satisfies Record<WindowAggregate, true>));

/**
 * Kinds a caller might reach for to smuggle code in. Named explicitly so the
 * refusal message says what is wrong instead of "unknown kind".
 */
const REJECTED_PROBE_KINDS: Readonly<Record<string, string>> = {
  js: 'JavaScript probes are not supported, the trigger DSL is declarative.',
  javascript: 'JavaScript probes are not supported, the trigger DSL is declarative.',
  eval: 'Expression evaluation is not a probe kind.',
  expression: 'Expression evaluation is not a probe kind.',
  script: 'Script probes are not supported, use a command probe with argv and no shell.',
  shell: 'Shell probes are not supported, use a command probe with argv and no shell.',
  function: 'Function probes are not supported, the trigger DSL is declarative.',
};

const REJECTED_ACTION_KINDS: Readonly<Record<string, string>> = {
  shell: 'A trigger may not compose a shell command at fire time. Pre-register an action grant instead.',
  command: 'A trigger may not compose a command at fire time. Pre-register an action grant instead.',
  exec: 'A trigger may not exec at fire time. Pre-register an action grant instead.',
  js: 'A trigger may not run JavaScript at fire time.',
  eval: 'A trigger may not evaluate an expression at fire time.',
};

const ALLOWED_REGEX_FLAGS = new Set(['i', 'm', 's', 'u']);
const JSONPATH_PATTERN = /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\["[^"\]]+"\]|\[\d+\]|\[\*\])*$/;
const JQ_SUBSET_PATTERN = /^\.(?:[A-Za-z_][A-Za-z0-9_-]*|\[\d+\]|\[\])*(?:\s*\|\s*(?:length|keys|first|last))?$/;
const MAX_REGEX_LENGTH = 512;
const MAX_STRING_LENGTH = 8_192;

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TriggerDefinitionError(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TriggerDefinitionError(field, 'must be a non-empty string');
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw new TriggerDefinitionError(field, `must be at most ${MAX_STRING_LENGTH} characters`);
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
    throw new TriggerDefinitionError(field, `must be a positive integer no greater than ${max}`);
  }
  return value;
}

/** A zero-or-more whole count (a TTL or interval that may be 0), the form the persisted snapshot demands. */
function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TriggerDefinitionError(field, 'must be a non-negative whole number');
  }
  return value;
}

function requireStringMap(value: unknown, field: string): void {
  const entries = requireObject(value, field);
  for (const [key, entry] of Object.entries(entries)) {
    if (typeof entry !== 'string') throw new TriggerDefinitionError(`${field}.${key}`, 'must be a string');
  }
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') throw new TriggerDefinitionError(field, 'must be a string when present');
}

function optionalChoice(value: unknown, choices: readonly string[], field: string): void {
  if (value !== undefined && !(typeof value === 'string' && choices.includes(value))) {
    throw new TriggerDefinitionError(field, `must be one of ${choices.join(', ')}`);
  }
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TriggerDefinitionError(field, 'must be a finite number');
  }
  return value;
}

/**
 * Rejects anything non-serialisable anywhere in a definition subtree. A
 * function on any field is the exact shape "arbitrary JS" would arrive in.
 */
export function assertPlainData(value: unknown, field: string, depth = 0): void {
  if (depth > 12) {
    throw new TriggerDefinitionError(field, 'is nested too deeply');
  }
  if (value === null || value === undefined) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    // JSON has no Infinity or NaN: the snapshot store refuses them at save and would take the whole trigger family down.
    if (!Number.isFinite(value)) throw new TriggerDefinitionError(field, 'must be a finite number');
    return;
  }
  if (type === 'function') {
    throw new TriggerDefinitionError(field, 'must not be a function, the trigger DSL is declarative data, not code');
  }
  if (type !== 'object') {
    throw new TriggerDefinitionError(field, `must not be a ${type} value`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertPlainData(entry, `${field}[${index}]`, depth + 1); });
    return;
  }
  if (value instanceof RegExp || value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new TriggerDefinitionError(field, 'must be plain JSON data');
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertPlainData(entry, `${field}.${key}`, depth + 1);
  }
}

/** Set only while a stored definition is re-read, so a pattern saved before this rule existed does not make its whole store unreadable. It is still refused when it runs. */
let readingPersistedDefinition = false;

/**
 * True when a group that contains an unbounded repeat (`*`, `+`, `{n,}`) is
 * itself repeated without a bound. That shape backtracks exponentially, and
 * these patterns run synchronously on the daemon's event loop against
 * untrusted lines, so it is refused at the door rather than defended later.
 */
function hasNestedUnboundedQuantifier(pattern: string): boolean {
  const unbounded = (at: number): number => {
    const char = pattern[at];
    if (char === '*' || char === '+') return 1;
    if (char === '{') {
      const close = pattern.indexOf('}', at);
      if (close !== -1 && /^\{\d+,\}$/.test(pattern.slice(at, close + 1))) return close - at + 1;
    }
    return 0;
  };
  const groups: boolean[] = [];
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '\\') { index += 1; continue; }
    if (inClass) { if (char === ']') inClass = false; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === '(') { groups.push(false); continue; }
    if (char === ')') {
      const inner = groups.pop() ?? false;
      const width = unbounded(index + 1);
      if (width > 0 && inner) return true;
      if (groups.length > 0 && (inner || width > 0)) groups[groups.length - 1] = true;
      index += width;
      continue;
    }
    const width = unbounded(index);
    if (width > 0 && groups.length > 0) groups[groups.length - 1] = true;
    index += Math.max(0, width - 1);
  }
  return false;
}

export function validateRegexSource(pattern: string, field: string, flags?: string | undefined): RegExp {
  if (pattern.length > MAX_REGEX_LENGTH) {
    throw new TriggerDefinitionError(field, `pattern must be at most ${MAX_REGEX_LENGTH} characters`);
  }
  const resolvedFlags = flags ?? '';
  for (const flag of resolvedFlags) {
    if (!ALLOWED_REGEX_FLAGS.has(flag)) {
      throw new TriggerDefinitionError(field, `flag "${flag}" is not allowed (only i, m, s and u are accepted; g and y keep lastIndex state between checks)`);
    }
  }
  if (!readingPersistedDefinition && hasNestedUnboundedQuantifier(pattern)) {
    throw new TriggerDefinitionError(field, 'repeats a group that itself repeats without a bound (for example (a+)+), which can stall the daemon on a crafted line; use a bounded or non-nested repeat');
  }
  try {
    return new RegExp(pattern, resolvedFlags);
  } catch (error) {
    throw new TriggerDefinitionError(field, `is not a valid regular expression: ${String(error)}`);
  }
}

/** Compiled patterns by flags and source; a rule or extractor runs on every check, and a pattern is checked and compiled once. */
const compiledPatterns = new Map<string, RegExp>();
const MAX_COMPILED_PATTERNS = 256;

/** The checked, compiled form of a pattern, cached so a check does not re-scan and re-compile it. */
export function compiledRegex(pattern: string, field: string, flags?: string | undefined): RegExp {
  const key = `${flags ?? ''}\u0000${pattern}`;
  const cached = compiledPatterns.get(key);
  if (cached) return cached;
  const regex = validateRegexSource(pattern, field, flags);
  if (compiledPatterns.size >= MAX_COMPILED_PATTERNS) compiledPatterns.delete(compiledPatterns.keys().next().value!);
  compiledPatterns.set(key, regex);
  return regex;
}

export function validateProbe(input: unknown, field = 'probe'): TriggerProbe {
  const probe = requireObject(input, field);
  const kind = probe.kind;
  if (typeof kind === 'string' && REJECTED_PROBE_KINDS[kind]) {
    throw new TriggerDefinitionError(`${field}.kind`, REJECTED_PROBE_KINDS[kind]);
  }
  if (typeof kind !== 'string' || !PROBE_KINDS.has(kind)) {
    throw new TriggerDefinitionError(`${field}.kind`, `must be one of ${[...PROBE_KINDS].join(', ')}`);
  }
  assertPlainData(probe, field);
  if (probe.timeoutMs !== undefined) {
    // A stored record from before this rule may hold 0; it still loads, and runs with the default budget (runProbe).
    if (readingPersistedDefinition) requireCount(probe.timeoutMs, `${field}.timeoutMs`);
    else if (typeof probe.timeoutMs !== 'number' || !Number.isSafeInteger(probe.timeoutMs) || probe.timeoutMs <= 0) {
      throw new TriggerDefinitionError(`${field}.timeoutMs`, 'must be a positive whole number of milliseconds; omit it for the default budget');
    }
  }

  if (kind === 'http') {
    const url = requireString(probe.url, `${field}.url`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TriggerDefinitionError(`${field}.url`, 'must be an absolute http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TriggerDefinitionError(`${field}.url`, 'must use http or https');
    }
    if (probe.method !== undefined && !['GET', 'HEAD', 'POST'].includes(String(probe.method))) {
      throw new TriggerDefinitionError(`${field}.method`, 'must be GET, HEAD or POST');
    }
    if (probe.headers !== undefined) requireStringMap(probe.headers, `${field}.headers`);
    optionalString(probe.body, `${field}.body`);
    optionalChoice(probe.capture, ['body', 'status', 'envelope'], `${field}.capture`);
    return probe as unknown as TriggerProbe;
  }

  if (kind === 'file') {
    requireString(probe.path, `${field}.path`);
    if (probe.maxBytes !== undefined) requirePositiveInt(probe.maxBytes, `${field}.maxBytes`, 16 * 1024 * 1024);
    optionalChoice(probe.capture, ['content', 'stat'], `${field}.capture`);
    return probe as unknown as TriggerProbe;
  }

  if (kind === 'command') {
    validateArgv(probe.command, probe.args, field);
    optionalString(probe.cwd, `${field}.cwd`);
    optionalChoice(probe.capture, ['stdout', 'stderr', 'exit-code', 'envelope'], `${field}.capture`);
    return probe as unknown as TriggerProbe;
  }

  requireString(probe.tool, `${field}.tool`);
  return probe as unknown as TriggerProbe;
}

/**
 * argv validation shared by command probes, stream commands, on-exit commands
 * and action grants. No shell is ever involved, so the only thing that matters
 * is that the executable name is a real single token and every arg is a string.
 */
export function validateArgv(command: unknown, args: unknown, field: string): { command: string; args: string[] } {
  const resolved = requireString(command, `${field}.command`);
  if (/[\n\r\0]/.test(resolved)) {
    throw new TriggerDefinitionError(`${field}.command`, 'must not contain newlines or null bytes');
  }
  if (args !== undefined && !Array.isArray(args)) {
    throw new TriggerDefinitionError(`${field}.args`, 'must be an array of strings');
  }
  const resolvedArgs = Array.isArray(args) ? args : [];
  resolvedArgs.forEach((arg, index) => {
    if (typeof arg !== 'string') {
      throw new TriggerDefinitionError(`${field}.args[${index}]`, 'must be a string');
    }
    if (arg.includes('\0')) {
      throw new TriggerDefinitionError(`${field}.args[${index}]`, 'must not contain null bytes');
    }
  });
  return { command: resolved, args: resolvedArgs as string[] };
}

export function validateExtract(input: unknown, field = 'extract'): TriggerExtract {
  const extract = requireObject(input, field);
  const kind = extract.kind;
  if (typeof kind !== 'string' || !EXTRACT_KINDS.has(kind)) {
    throw new TriggerDefinitionError(`${field}.kind`, `must be one of ${[...EXTRACT_KINDS].join(', ')}`);
  }
  assertPlainData(extract, field);

  if (kind === 'jsonpath') {
    const path = requireString(extract.path, `${field}.path`);
    if (!JSONPATH_PATTERN.test(path)) {
      throw new TriggerDefinitionError(`${field}.path`, 'must be the supported JSONPath subset: $ followed by .key, ["key"], [0] or [*]');
    }
    return extract as unknown as TriggerExtract;
  }
  if (kind === 'regex') {
    validateRegexSource(
      requireString(extract.pattern, `${field}.pattern`),
      field,
      typeof extract.flags === 'string' ? extract.flags : undefined,
    );
    if (extract.group !== undefined && (typeof extract.group !== 'number' || !Number.isInteger(extract.group) || extract.group < 0)) {
      throw new TriggerDefinitionError(`${field}.group`, 'must be a non-negative integer');
    }
    return extract as unknown as TriggerExtract;
  }
  if (kind === 'jq-subset') {
    const expression = requireString(extract.expression, `${field}.expression`);
    if (!JQ_SUBSET_PATTERN.test(expression)) {
      throw new TriggerDefinitionError(
        `${field}.expression`,
        'must be the supported jq subset: a .path[…] selector optionally piped into length, keys, first or last',
      );
    }
    return extract as unknown as TriggerExtract;
  }
  return extract as unknown as TriggerExtract;
}

/** A string the engine implements; an unknown one would make the rule silently never fire. */
function requireOneOf(value: unknown, allowed: ReadonlySet<string>, field: string): string {
  const text = requireString(value, field);
  if (!allowed.has(text)) {
    throw new TriggerDefinitionError(field, `must be one of ${[...allowed].join(', ')}`);
  }
  return text;
}

export function validateRule(input: unknown, field = 'rule', depth = 0): TriggerRule {
  if (depth > 4) {
    throw new TriggerDefinitionError(field, 'nests rules too deeply (max 4)');
  }
  const rule = requireObject(input, field);
  const kind = rule.kind;
  if (typeof kind !== 'string' || !RULE_KINDS.has(kind)) {
    throw new TriggerDefinitionError(`${field}.kind`, `must be one of ${[...RULE_KINDS].join(', ')}`);
  }
  assertPlainData(rule, field);

  switch (kind) {
    case 'change':
      break;
    case 'value':
      requireOneOf(rule.operator, COMPARISON_OPERATORS, `${field}.operator`);
      if (rule.operand === undefined) {
        throw new TriggerDefinitionError(`${field}.operand`, 'is required');
      }
      if (rule.operator === 'matches') {
        validateRegexSource(requireString(rule.operand, `${field}.operand`), `${field}.operand`);
      }
      break;
    case 'transition':
      requireString(rule.from, `${field}.from`);
      requireString(rule.to, `${field}.to`);
      break;
    case 'threshold': {
      if (rule.direction !== 'above' && rule.direction !== 'below') {
        throw new TriggerDefinitionError(`${field}.direction`, 'must be "above" or "below"');
      }
      const enter = requireFiniteNumber(rule.enter, `${field}.enter`);
      const exit = requireFiniteNumber(rule.exit, `${field}.exit`);
      if (rule.direction === 'above' && exit > enter) {
        throw new TriggerDefinitionError(`${field}.exit`, 'must be at or below `enter` for an "above" threshold (hysteresis needs a re-arm band)');
      }
      if (rule.direction === 'below' && exit < enter) {
        throw new TriggerDefinitionError(`${field}.exit`, 'must be at or above `enter` for a "below" threshold (hysteresis needs a re-arm band)');
      }
      break;
    }
    case 'debounce-n':
      requirePositiveInt(rule.count, `${field}.count`, 10_000);
      validateRule(rule.inner, `${field}.inner`, depth + 1);
      break;
    case 'dedup-ttl':
      requirePositiveInt(rule.ttlMs, `${field}.ttlMs`, 30 * 24 * 60 * 60 * 1000);
      validateRule(rule.inner, `${field}.inner`, depth + 1);
      break;
    case 'rate-of-change':
      requirePositiveInt(rule.windowMs, `${field}.windowMs`, 30 * 24 * 60 * 60 * 1000);
      requireOneOf(rule.operator, COMPARISON_OPERATORS, `${field}.operator`);
      requireFiniteNumber(rule.operand, `${field}.operand`);
      break;
    case 'windowed-aggregate':
      requirePositiveInt(rule.windowMs, `${field}.windowMs`, 30 * 24 * 60 * 60 * 1000);
      requireOneOf(rule.aggregate, WINDOW_AGGREGATES, `${field}.aggregate`);
      requireOneOf(rule.operator, COMPARISON_OPERATORS, `${field}.operator`);
      requireFiniteNumber(rule.operand, `${field}.operand`);
      if (rule.minSamples !== undefined) requirePositiveInt(rule.minSamples, `${field}.minSamples`, 10_000);
      break;
    case 'correlation': {
      if (!Array.isArray(rule.triggerIds) || rule.triggerIds.length === 0) {
        throw new TriggerDefinitionError(`${field}.triggerIds`, 'must list at least one trigger id');
      }
      if (rule.triggerIds.length > 32) {
        throw new TriggerDefinitionError(`${field}.triggerIds`, 'must list at most 32 trigger ids');
      }
      rule.triggerIds.forEach((id, index) => { requireString(id, `${field}.triggerIds[${index}]`); });
      requirePositiveInt(rule.withinMs, `${field}.withinMs`, 30 * 24 * 60 * 60 * 1000);
      if (!['all', 'any', 'sequence'].includes(String(rule.require))) {
        throw new TriggerDefinitionError(`${field}.require`, 'must be "all", "any" or "sequence"');
      }
      break;
    }
    default:
      break;
  }
  return rule as unknown as TriggerRule;
}

export function validateAction(input: unknown, field = 'action'): TriggerFireAction {
  const action = requireObject(input, field);
  const kind = action.kind;
  if (typeof kind === 'string' && REJECTED_ACTION_KINDS[kind]) {
    throw new TriggerDefinitionError(`${field}.kind`, REJECTED_ACTION_KINDS[kind]);
  }
  if (typeof kind !== 'string' || !ACTION_KINDS.has(kind)) {
    throw new TriggerDefinitionError(
      `${field}.kind`,
      `must be one of ${[...ACTION_KINDS].join(', ')}, a firing trigger runs an agent turn or a pre-registered action grant, never a newly composed command`,
    );
  }
  assertPlainData(action, field);
  if (kind === 'agent-turn') {
    // Optional: each watcher kind renders a default template that already
    // states what happened. This field only prepends standing instructions.
    if (action.prompt !== undefined && typeof action.prompt !== 'string') {
      throw new TriggerDefinitionError(`${field}.prompt`, 'must be a string when present');
    }
    if (typeof action.prompt === 'string' && action.prompt.length > MAX_STRING_LENGTH) {
      throw new TriggerDefinitionError(`${field}.prompt`, `must be at most ${MAX_STRING_LENGTH} characters`);
    }
    // Where the answer goes: a channel as configuration writes one. Refused here, not at fire time.
    if (action.deliverTo !== undefined) {
      if (typeof action.deliverTo !== 'string' || action.deliverTo.trim() === '') {
        throw new TriggerDefinitionError(`${field}.deliverTo`, 'must be a channel such as "telegram" or "slack:C123" when present');
      }
      const problem = deliveryChannelProblem(action.deliverTo.trim());
      if (problem) throw new TriggerDefinitionError(`${field}.deliverTo`, `${problem}; leave it out to deliver the answer to the owner inbox`);
    }
    // A fired trigger starts its own agent; nothing attaches it to an existing session.
    // Refusing the field beats accepting it and running the turn somewhere else.
    if (action.sessionId !== undefined && !readingPersistedDefinition) {
      throw new TriggerDefinitionError(`${field}.sessionId`, 'is not supported: a fired trigger starts its own agent and cannot run inside a session. Leave sessionId out; the agent that fired is listed with the trigger\'s history');
    }
  } else {
    requireString(action.grantId, `${field}.grantId`);
    requireString(action.digest, `${field}.digest`);
  }
  return action as unknown as TriggerFireAction;
}

export function validateSpec(input: unknown, field = 'spec'): TriggerSpec {
  const spec = requireObject(input, field);
  assertPlainData(spec, field);
  switch (spec.kind) {
    case 'stream':
      validateArgv(spec.command, spec.args, field);
      validateExtract({ ...requireObject(spec.match, `${field}.match`), kind: 'regex' }, `${field}.match`);
      if (spec.exclude !== undefined) {
        validateExtract({ ...requireObject(spec.exclude, `${field}.exclude`), kind: 'regex' }, `${field}.exclude`);
      }
      optionalString(spec.cwd, `${field}.cwd`);
      if (spec.restart !== undefined && typeof spec.restart !== 'boolean') throw new TriggerDefinitionError(`${field}.restart`, 'must be true or false');
      if (spec.dedupTtlMs !== undefined) requireCount(spec.dedupTtlMs, `${field}.dedupTtlMs`);
      if (spec.batchIntervalMs !== undefined) requireCount(spec.batchIntervalMs, `${field}.batchIntervalMs`);
      if (spec.batchLines !== undefined) requirePositiveInt(spec.batchLines, `${field}.batchLines`, 10_000);
      if (spec.queueLimit !== undefined) requirePositiveInt(spec.queueLimit, `${field}.queueLimit`, 1_000_000);
      return spec as unknown as TriggerSpec;
    case 'condition':
      validateProbe(spec.probe, `${field}.probe`);
      validateExtract(spec.extract, `${field}.extract`);
      validateRule(spec.rule, `${field}.rule`);
      if (spec.intervalMs !== undefined) requirePositiveInt(spec.intervalMs, `${field}.intervalMs`, 24 * 60 * 60 * 1000);
      return spec as unknown as TriggerSpec;
    case 'on-exit':
      validateArgv(spec.command, spec.args, field);
      optionalString(spec.cwd, `${field}.cwd`);
      if (spec.env !== undefined) requireStringMap(spec.env, `${field}.env`);
      if (spec.outputTailBytes !== undefined) requireCount(spec.outputTailBytes, `${field}.outputTailBytes`);
      if (spec.maxDurationMs !== undefined) {
        requirePositiveInt(spec.maxDurationMs, `${field}.maxDurationMs`, 7 * 24 * 60 * 60 * 1000);
      }
      if (spec.stdin !== undefined && spec.stdin !== 'none' && spec.stdin !== 'empty') {
        throw new TriggerDefinitionError(
          `${field}.stdin`,
          'must be "none" or "empty", there is no interactive option because nobody is at the keyboard',
        );
      }
      return spec as unknown as TriggerSpec;
    default:
      throw new TriggerDefinitionError(`${field}.kind`, 'must be "stream", "condition" or "on-exit"');
  }
}

export function validateDefinition(input: unknown, options: { readonly persisted?: boolean } = {}): TriggerDefinition {
  if (options.persisted !== true) return validateDefinitionFields(input);
  readingPersistedDefinition = true;
  try { return validateDefinitionFields(input); } finally { readingPersistedDefinition = false; }
}

function validateDefinitionFields(input: unknown): TriggerDefinition {
  const definition = requireObject(input, 'definition');
  const id = requireString(definition.id, 'definition.id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new TriggerDefinitionError('definition.id', 'must be 1-128 characters of letters, digits, dot, underscore or hyphen');
  }
  requireString(definition.label, 'definition.label');
  optionalString(definition.description, 'definition.description');
  optionalString(definition.ownerSessionId, 'definition.ownerSessionId');
  validateSpec(definition.spec);
  validateAction(definition.action);
  // The whole definition is saved as JSON, so a non-finite number in createdAt or any extra top-level field must be refused here, not at save.
  assertPlainData(definition, 'definition');
  return {
    ...(definition as unknown as TriggerDefinition),
    createdAt: typeof definition.createdAt === 'number' ? definition.createdAt : Date.now(),
  };
}
