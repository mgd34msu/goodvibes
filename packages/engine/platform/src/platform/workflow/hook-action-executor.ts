import { logger } from '../utils/logger.js';
import { shellSplit } from '../utils/shell-split.js';
import type { HookEvent } from '../hooks/types.js';
import type { HookActionDefinition } from '../tools/workflow/index.js';
import { matchesEventPath } from '../hooks/matcher.js';
import { summarizeError } from '../utils/error-display.js';
import { toRecord } from '../utils/record-coerce.js';
import type { AutomationCommandExit, AutomationCommands } from './automation-commands.js';

// ---------------------------------------------------------------------------
// HookActionExecutor
// ---------------------------------------------------------------------------
// Evaluates hook-action conditions and starts their commands when a hook event
// fires. Kept decoupled from HookDispatcher to avoid circular imports.
// ---------------------------------------------------------------------------

export interface HookActionManagerLike {
  list(): HookActionDefinition[];
  /** Starts, limits, times and tracks this manager's actions; disposing it stops only these. */
  readonly commands: AutomationCommands;
  /** Keeps the outcome of a fire on the stored definition, so a list shows what happened. */
  recordFire?(result: HookActionFireResult): void;
  /** Keeps how a started action ended on the stored definition. */
  recordExit?(hookActionId: string, exit: AutomationCommandExit): void;
}

/**
 * Result of evaluating one hook action against a hook event.
 */
export interface HookActionFireResult {
  hookActionId: string;
  event: string;
  action: string;
  executed: boolean;
  error?: string | undefined;
  pid?: number | undefined;
}

/** A hook action's command that runs longer than this is killed. */
export const HOOK_ACTION_TIMEOUT_MS = 60_000;
/** Most simultaneous runs of one hook action; a further fire is refused with a stated reason. */
export const HOOK_ACTION_MAX_IN_FLIGHT = 4;

/** Test seams and per-call overrides for {@link fireHookActions}. */
export interface HookActionExecutionOptions {
  /** Starts the action process. Defaults to Bun.spawn. */
  readonly spawn?: typeof Bun.spawn | undefined;
  /** Arms the kill timer and returns its canceller. Defaults to an unref'd setTimeout. */
  readonly startTimer?: ((callback: () => void, ms: number) => () => void) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxInFlight?: number | undefined;
}

/**
 * Evaluate all enabled hook actions against a fired hook event. Matching ones
 * have their command started through `manager.commands`, and each fire's
 * outcome is kept on its definition as soon as it is known.
 */
export async function fireHookActions(
  event: HookEvent,
  manager: HookActionManagerLike,
  options: HookActionExecutionOptions = {},
): Promise<HookActionFireResult[]> {
  const results: HookActionFireResult[] = [];
  const triggers = manager.list().filter((t) => t.enabled);

  for (const trigger of triggers) {
    if (!matchesEventPath(trigger.event, event.path)) continue;

    // Optional JS-expression condition guard
    if (trigger.condition) {
      const evaluation = evaluateCondition(trigger.condition, event);
      if (!evaluation.passed) {
        // A condition that could not be evaluated is not the same as one that did not match.
        const result: HookActionFireResult = {
          hookActionId: trigger.id,
          event: trigger.event,
          action: trigger.action,
          executed: false,
          ...(evaluation.error !== undefined ? { error: `Condition could not be evaluated: ${evaluation.error}` } : {}),
        };
        results.push(result);
        // A condition that simply did not match is not a fire.
        if (result.error !== undefined) manager.recordFire?.(result);
        continue;
      }
    }

    const fireResult = await executeAction(trigger, event, manager, options);
    results.push(fireResult);
    manager.recordFire?.(fireResult);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Safe condition evaluator, no eval() or new Function()
// ---------------------------------------------------------------------------
//
// Supports a restricted expression language for hook action conditions.
// Operators: === !== == != > < >= <= && || ! (parentheses)
// Operands: dotted property paths on `event` or `payload`, string literals,
//           number literals, boolean literals (true/false/null/undefined).
//
// Examples:
//   event.phase === 'Post'
//   payload.tool === 'exec' && event.category !== 'system'
//   !payload.skipped

type ConditionValue = string | number | boolean | null | undefined;

function resolvePath(root: Record<string, unknown>, path: string): ConditionValue {
  const parts = path.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    // Reject the condition, rather than treating a forbidden path as missing:
    // `payload.constructor === undefined` must not become an allowed action.
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw new Error('Prototype paths are not supported in hook action conditions');
    }
    if (cur == null || typeof cur !== 'object') return undefined;
    const property = Object.getOwnPropertyDescriptor(cur, part);
    if (property === undefined) return undefined;
    if (!('value' in property)) throw new Error('Hook action conditions require data properties');
    cur = property.value;
  }
  if (cur === null) return null;
  if (cur === undefined) return undefined;
  if (typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') return cur;
  // Conditions operate on data, never user-defined coercion hooks.
  throw new Error('Hook action conditions require primitive operands');
}

/** Tokenise a condition string into an array of tokens. */
function tokenise(condition: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < condition.length) {
    // Skip whitespace
    if (/\s/.test(condition[i]!)) { i++; continue; }

    // String literals
    if (condition[i] === '"' || condition[i] === "'") {
      const quote = condition[i]!;
      let j = i + 1;
      while (j < condition.length && condition[j] !== quote) {
        if (condition[j] === '\\') j++; // skip escape
        j++;
      }
      if (j >= condition.length) throw new Error('Unterminated string literal in condition');
      tokens.push(condition.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // Multi-char operators
    const twoChar = condition.slice(i, i + 2);
    if (['===', '!=='].includes(condition.slice(i, i + 3))) {
      tokens.push(condition.slice(i, i + 3)); i += 3; continue;
    }
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(twoChar)) {
      tokens.push(twoChar); i += 2; continue;
    }

    // Single-char operators / parens
    if ('!><()'.includes(condition[i]!)) {
      tokens.push(condition[i]!); i++; continue;
    }

    // Numbers
    if (/[0-9]/.test(condition[i]!) || (condition[i] === '-' && /[0-9]/.test(condition[i + 1] ?? ''))) {
      let j = i;
      if (condition[j] === '-') j++;
      while (j < condition.length && /[0-9.]/.test(condition[j]!)) j++;
      tokens.push(condition.slice(i, j)); i = j; continue;
    }

    // Identifiers (including dotted paths and keywords)
    if (/[a-zA-Z_$]/.test(condition[i]!)) {
      let j = i;
      while (j < condition.length && /[a-zA-Z0-9_.$]/.test(condition[j]!)) j++;
      tokens.push(condition.slice(i, j)); i = j; continue;
    }

    // Unknown character, abort
    throw new Error(`Unexpected character '${condition[i]}' in condition`);
  }
  return tokens;
}

function parseValue(token: string, event: HookEvent): ConditionValue {
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return null;
  if (token === 'undefined') return undefined;
  // String literal
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  // Number
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(token)) return Number(token);
  // Property path, only event.* and payload.*
  if (token.startsWith('event.')) {
    return resolvePath(toRecord(event), token.slice(6));
  }
  if (token.startsWith('payload.')) {
    return resolvePath((event.payload ?? {}) as Record<string, unknown>, token.slice(8));
  }
  // Bare 'event' or 'payload'
  if (token === 'event') return JSON.stringify(event);
  if (token === 'payload') return JSON.stringify(event.payload ?? {});
  throw new Error(`Unrecognised token '${token}' in condition`);
}

/**
 * Recursive descent parser for the restricted condition language.
 * Grammar (simplified):
 *   expr   := or
 *   or     := and ('||' and)*
 *   and    := unary ('&&' unary)*
 *   unary  := '!' unary | compare
 *   compare:= atom (('==='|'!=='|'=='|'!='|'>'|'<'|'>='|'<=') atom)?
 *   atom   := '(' expr ')' | VALUE
 */
class ConditionParser {
  private pos = 0;
  constructor(private tokens: string[], private event: HookEvent) {}

  parse(): boolean {
    const result = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token '${this.tokens[this.pos]}' at position ${this.pos}`);
    }
    return Boolean(result);
  }

  private peek(): string | undefined { return this.tokens[this.pos]; }
  private consume(): string { return this.tokens[this.pos++]!; }
  private match(t: string): boolean { if (this.peek() === t) { this.pos++; return true; } return false; }

  private parseOr(): ConditionValue {
    let left = this.parseAnd();
    // The operator and right operand are always consumed, even when the left
    // side already decides the result, so the rest of the condition still parses.
    while (this.peek() === '||') {
      this.consume();
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(): ConditionValue {
    let left = this.parseUnary();
    while (this.peek() === '&&') {
      this.consume();
      const right = this.parseUnary();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseUnary(): ConditionValue {
    if (this.peek() === '!') { this.consume(); return !Boolean(this.parseUnary()); }
    return this.parseCompare();
  }

  private parseCompare(): ConditionValue {
    const left = this.parseAtom();
    const op = this.peek();
    if (op && ['===', '!==', '==', '!=', '>', '<', '>=', '<='].includes(op)) {
      this.consume();
      const right = this.parseAtom();
      switch (op) {
        case '===': return left === right;
        case '!==': return left !== right;
        // Loose equality is intentional: user-authored hook action conditions may
        // use `==` to allow type-coercive matching (e.g. numeric payload field
        // compared to string literal). Strict `===` is also supported.
        // eslint-disable-next-line eqeqeq
        case '==': return left == right;
        // eslint-disable-next-line eqeqeq
        case '!=': return left != right;
        case '>': return Number(left) > Number(right);
        case '<': return Number(left) < Number(right);
        case '>=': return Number(left) >= Number(right);
        case '<=': return Number(left) <= Number(right);
      }
    }
    return left;
  }

  private parseAtom(): ConditionValue {
    const t = this.peek();
    if (t === undefined) throw new Error('Unexpected end of condition');
    if (t === '(') {
      this.consume();
      const val = this.parseOr();
      if (!this.match(')')) throw new Error('Expected closing parenthesis');
      return val;
    }
    this.consume();
    return parseValue(t, this.event);
  }
}

/** An event with nothing in it: a condition is parsed against it once, when the hook action is added. */
const EMPTY_EVENT: HookEvent = { path: 'Pre:tool:none', phase: 'Pre', category: 'tool', specific: 'none', sessionId: '', timestamp: 0, payload: {} };

/**
 * Why a condition can never be evaluated (an unsupported character or token, a
 * prototype path, unbalanced parentheses), or undefined when it parses. Run
 * once at add time so a typo is refused where the agent reads it, instead of
 * failing silently on every event.
 */
export function conditionProblem(condition: string): string | undefined {
  const evaluation = evaluateCondition(condition, EMPTY_EVENT, false);
  return evaluation.error;
}

/**
 * Safely evaluate a simple boolean condition string.
 * The condition has access to `event` and `payload` (alias for event.payload).
 * Uses a restricted expression parser, no eval() or new Function().
 * Returns false if the condition is invalid or throws.
 */
function evaluateCondition(condition: string, event: HookEvent, log = true): { passed: boolean; error?: string } {
  try {
    const tokens = tokenise(condition);
    if (tokens.length === 0) return { passed: true }; // empty condition = always pass
    const parser = new ConditionParser(tokens, event);
    return { passed: parser.parse() };
  } catch (err) {
    const error = summarizeError(err);
    if (log) logger.warn('HookActionExecutor: condition evaluation error', { condition, error });
    return { passed: false, error };
  }
}

/**
 * Starts a hook action through the manager's automation commands: the argv
 * admitted when it was added, the project root, the environment the exec path
 * gives a command (credential-bearing variables withheld), a kill timer, a
 * per-action in-flight limit, and tracking so disposal kills it.
 */
async function executeAction(
  trigger: HookActionDefinition,
  event: HookEvent,
  manager: HookActionManagerLike,
  options: HookActionExecutionOptions,
): Promise<HookActionFireResult> {
  const base: Omit<HookActionFireResult, 'executed'> = {
    hookActionId: trigger.id,
    event: trigger.event,
    action: trigger.action,
  };

  // HookActionManager.add stores the admitted argv; a definition built elsewhere
  // is split here the same strict way (an empty argument keeps its place, an
  // unterminated quote is refused).
  let parts: readonly string[];
  try {
    parts = trigger.argv ?? shellSplit(trigger.action, { strict: true });
  } catch (err) {
    return { ...base, executed: false,
      error: `Action could not be parsed: ${summarizeError(err)}. The action was not run; close the quote in hook action ${trigger.id} and add it again.` };
  }
  if (parts.length === 0) {
    return { ...base, executed: false, error: `Empty action command: hook action ${trigger.id} has no command to run; give it an action or remove it.` };
  }

  const outcome = await manager.commands.start({
    kind: 'hook-action',
    key: trigger.id,
    argv: parts,
    sandboxed: trigger.sandboxed,
    env: { GV_HOOK_ACTION_ID: trigger.id, GV_HOOK_EVENT: event.path, GV_HOOK_PHASE: event.phase },
    maxInFlight: options.maxInFlight ?? HOOK_ACTION_MAX_IN_FLIGHT,
    timeoutMs: options.timeoutMs ?? HOOK_ACTION_TIMEOUT_MS,
    onExit: (exit) => manager.recordExit?.(trigger.id, exit),
    spawn: options.spawn,
    startTimer: options.startTimer,
  });
  if (outcome.started) {
    logger.debug('HookActionExecutor: action spawned', { hookActionId: trigger.id, pid: outcome.pid, action: trigger.action });
    return { ...base, executed: true, pid: outcome.pid };
  }
  switch (outcome.reason) {
    case 'busy':
      logger.warn('HookActionExecutor: in-flight limit reached', { hookActionId: trigger.id, running: outcome.running, maxInFlight: outcome.limit });
      return { ...base, executed: false, error: `Not started: ${outcome.running} runs of this hook action are still running (limit ${outcome.limit}). Wait for them to finish or narrow its event.` };
    case 'stopped':
      return { ...base, executed: false, error: `Not started: ${outcome.message}` };
    case 'failed':
      logger.warn('HookActionExecutor: failed to spawn action', { hookActionId: trigger.id, error: outcome.message });
      return { ...base, executed: false, error: outcome.message };
  }
}
