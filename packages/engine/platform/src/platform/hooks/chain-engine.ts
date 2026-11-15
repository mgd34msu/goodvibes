import type { HookChain, HookEvent, HookResult, ChainStep } from './types.js';
import type { HookDispatcher } from './dispatcher.js';
import { matchesEventPath } from './matcher.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Parse a duration string like "30s" or "5m" into milliseconds */
function parseDuration(s: string): number {
  const match = s.match(/^(\d+(\.\d+)?)(s|m|ms)$/);
  if (!match) return 0;
  const value = parseFloat(match[1]!);
  const unit = match[3]!;
  if (unit === 'ms') return value;
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60_000;
  return 0;
}

/**
 * Tokenizer for the safe expression evaluator.
 * Produces a flat list of tokens from the condition string.
 */
type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'dot' }
  | { kind: 'bang' }
  | { kind: 'invalid'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i]!)) { i++; continue; }
    // String literals (single or double quoted)
    if (input[i] === '\'' || input[i] === '"') {
      const quote = input[i++];
      let s = '';
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) { i++; }
        s += input[i++];
      }
      if (i >= input.length) {
        // No closing quote: the expression is cut off, so it is refused rather than read as the text so far.
        tokens.push({ kind: 'invalid', value: String(quote) });
        break;
      }
      i++; // closing quote
      tokens.push({ kind: 'string', value: s });
      continue;
    }
    // Numbers
    if (/[0-9]/.test(input[i]!) || (input[i] === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let n = '';
      if (input[i] === '-') n += input[i++];
      while (i < input.length && /[0-9.]/.test(input[i]!)) n += input[i++];
      tokens.push({ kind: 'number', value: parseFloat(n) });
      continue;
    }
    // Operators: ===, !==, >=, <=, >, <, &&, ||
    if (input.startsWith('===', i)) { tokens.push({ kind: 'op', value: '===' }); i += 3; continue; }
    if (input.startsWith('!==', i)) { tokens.push({ kind: 'op', value: '!==' }); i += 3; continue; }
    if (input.startsWith('>=', i)) { tokens.push({ kind: 'op', value: '>=' }); i += 2; continue; }
    if (input.startsWith('<=', i)) { tokens.push({ kind: 'op', value: '<=' }); i += 2; continue; }
    if (input.startsWith('&&', i)) { tokens.push({ kind: 'op', value: '&&' }); i += 2; continue; }
    if (input.startsWith('||', i)) { tokens.push({ kind: 'op', value: '||' }); i += 2; continue; }
    if (input[i] === '>') { tokens.push({ kind: 'op', value: '>' }); i++; continue; }
    if (input[i] === '<') { tokens.push({ kind: 'op', value: '<' }); i++; continue; }
    if (input[i] === '!') { tokens.push({ kind: 'bang' }); i++; continue; }
    if (input[i] === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (input[i] === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (input[i] === '.') { tokens.push({ kind: 'dot' }); i++; continue; }
    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(input[i]!)) {
      let id = '';
      while (i < input.length && /[a-zA-Z0-9_$]/.test(input[i]!)) id += input[i++];
      if (id === 'true') tokens.push({ kind: 'bool', value: true });
      else if (id === 'false') tokens.push({ kind: 'bool', value: false });
      else if (id === 'null') tokens.push({ kind: 'null' });
      else if (id === 'undefined') tokens.push({ kind: 'undefined' });
      else tokens.push({ kind: 'ident', value: id });
      continue;
    }
    // Unknown character: kept as a token so the evaluator can refuse the whole expression.
    tokens.push({ kind: 'invalid', value: input[i]! });
    i++;
  }
  return tokens;
}

/**
 * Evaluate a safe condition expression against a context object.
 *
 * Allowed syntax:
 *   - Property access on context: `message`, `count`, `status`
 *   - Dot-chained property access: `event.type`
 *   - Comparison operators: `===`, `!==`, `>`, `<`, `>=`, `<=`
 *   - Logical operators: `&&`, `||`
 *   - Unary negation: `!expr`
 *   - String methods: `.startsWith()`, `.endsWith()`, `.includes()`
 *   - Literals: strings, numbers, booleans, null, undefined
 *   - Grouping: `(expr)`
 *
 * Does NOT use `eval`, `new Function`, or `vm.runInNewContext`.
 * An identifier that is not in the context, or a property the value does not
 * own, reads as undefined (so `!flag` is true when `flag` is absent). An
 * expression that uses an unsupported construct (an unknown character, an
 * unterminated string, unbalanced parentheses, or tokens left over after a
 * complete expression) evaluates to false and is logged.
 */
export function safeEvaluate(condition: string, context: Record<string, unknown>): boolean {
  const tokens = tokenize(condition);
  let pos = 0;

  function peek(): Token | undefined { return tokens[pos]!; }
  function consume(): Token { return tokens[pos++]!; }

  function parseExpr(): unknown { return parseOr(); }

  function parseOr(): unknown {
    let left = parseAnd();
    while (peek()?.kind === 'op' && (peek() as { value: string }).value === '||') {
      consume();
      const right = parseAnd();
      left = !!(left) || !!(right);
    }
    return left;
  }

  function parseAnd(): unknown {
    let left = parseComparison();
    while (peek()?.kind === 'op' && (peek() as { value: string }).value === '&&') {
      consume();
      const right = parseComparison();
      left = !!(left) && !!(right);
    }
    return left;
  }

  function parseComparison(): unknown {
    let left = parseUnary();
    const t = peek();
    if (t?.kind === 'op') {
      const op = (t as { value: string }).value;
      if (['===', '!==', '>', '<', '>=', '<='].includes(op)) {
        consume();
        const right = parseUnary();
        switch (op) {
          case '===': return left === right;
          case '!==': return left !== right;
          case '>':   return (left as number) > (right as number);
          case '<':   return (left as number) < (right as number);
          case '>=':  return (left as number) >= (right as number);
          case '<=':  return (left as number) <= (right as number);
        }
      }
    }
    return left;
  }

  function parseUnary(): unknown {
    if (peek()?.kind === 'bang') {
      consume();
      return !parseUnary();
    }
    return parsePostfix();
  }

  function parsePostfix(): unknown {
    let val = parsePrimary();
    // Handle dot-chained property access and allowed string methods
    while (peek()?.kind === 'dot') {
      consume(); // consume '.'
      const t = peek();
      if (!t || t.kind !== 'ident') break;
      const name = (t as { kind: 'ident'; value: string }).value;
      consume(); // consume method/property name
      // Check for method call syntax: .startsWith(...), .endsWith(...), .includes(...)
      if (peek()?.kind === 'lparen') {
        consume(); // '('
        const arg = parsePrimary();
        if (peek()?.kind !== 'rparen') throw new Error('unbalanced parentheses');
        consume(); // ')'
        if (typeof val === 'string') {
          if (name === 'startsWith') { val = val.startsWith(String(arg)); continue; }
          if (name === 'endsWith') { val = val.endsWith(String(arg)); continue; }
          if (name === 'includes') { val = val.includes(String(arg)); continue; }
        }
        val = false;
      } else {
        // Property access
        // Own properties only: an inherited one (`constructor`, `__proto__`) is not payload data.
        if (val !== null && val !== undefined && typeof val === 'object' && Object.prototype.hasOwnProperty.call(val, name)) {
          val = (val as Record<string, unknown>)[name];
        } else {
          val = undefined;
        }
      }
    }
    return val;
  }

  function parsePrimary(): unknown {
    const t = peek();
    if (!t) return undefined;
    if (t.kind === 'lparen') {
      consume();
      const val = parseExpr();
      if (peek()?.kind !== 'rparen') throw new Error('unbalanced parentheses');
      consume();
      return val;
    }
    if (t.kind === 'string') { consume(); return t.value; }
    if (t.kind === 'number') { consume(); return t.value; }
    if (t.kind === 'bool') { consume(); return t.value; }
    if (t.kind === 'null') { consume(); return null; }
    if (t.kind === 'undefined') { consume(); return undefined; }
    if (t.kind === 'ident') {
      consume();
      // Only allow access to keys present in context
      return Object.prototype.hasOwnProperty.call(context, t.value)
        ? context[t.value]
        : undefined;
    }
    return undefined;
  }

  try {
    const invalid = tokens.find((token) => token.kind === 'invalid') as { value: string } | undefined;
    if (invalid) {
      logger.warn('ChainEngine: condition uses an unsupported character, evaluating to false', { condition, character: invalid.value });
      return false;
    }
    const value = parseExpr();
    if (pos !== tokens.length) {
      logger.warn('ChainEngine: condition has unsupported trailing tokens, evaluating to false', { condition });
      return false;
    }
    return !!value;
  } catch (err) {
    logger.error('ChainEngine: condition evaluation error', {
      condition,
      error: summarizeError(err),
    });
    return false;
  }
}

interface ChainState {
  currentStep: number;
  captures: Record<string, string>;
  lastAdvance: number;
  /** Timer ID for debounce tracking */
  debounceTimer?: ReturnType<typeof setTimeout> | undefined;
  /** Pending debounce event */
  pendingDebounce?: HookEvent | undefined;
}

/** Runs a completed chain's action and reports how it went. */
export type ChainActionRunner = (chain: HookChain, event: HookEvent) => Promise<HookResult>;

/** Combines two results: any failure fails, the first deny wins, context joins. */
function mergeResults(a: HookResult | null, b: HookResult): HookResult {
  if (!a) return b;
  const merged: HookResult = { ok: a.ok && b.ok };
  const error = a.error ?? b.error;
  if (error !== undefined) merged.error = error;
  const deny = a.decision === 'deny' ? a : b.decision === 'deny' ? b : undefined;
  const decision = deny ? 'deny' : (a.decision ?? b.decision);
  if (decision !== undefined) merged.decision = decision;
  const reason = deny ? deny.reason : (a.reason ?? b.reason);
  if (reason !== undefined) merged.reason = reason;
  const context = [a.additionalContext, b.additionalContext].filter((part): part is string => !!part).join('\n');
  if (context) merged.additionalContext = context;
  const updatedInput = b.updatedInput ?? a.updatedInput;
  if (updatedInput !== undefined) merged.updatedInput = updatedInput;
  const code = a.code ?? b.code;
  if (code !== undefined) merged.code = code;
  return merged;
}

export class ChainEngine {
  private dispatcher: Pick<HookDispatcher, 'fire'>;
  private readonly runAction: ChainActionRunner;
  private chains: HookChain[] = [];
  private states = new Map<string, ChainState>();

  /**
   * `runAction` runs a completed chain's action; without one the action's
   * `match` path is fired on the dispatcher, which re-enters event handling.
   */
  constructor(dispatcher: Pick<HookDispatcher, 'fire'>, runAction?: ChainActionRunner) {
    this.dispatcher = dispatcher;
    this.runAction = runAction ?? ((chain, event) => this.dispatcher.fire({
      ...event,
      path: chain.action.match as unknown as import('./types.js').HookEventPath,
    }));
  }

  /** Register a chain and initialize its state. Chains are tracked by name, so a repeated name is refused. */
  register(chain: HookChain): void {
    if (this.states.has(chain.name)) throw new Error(`chain "${chain.name}" is already registered`);
    this.chains.push(chain);
    this.states.set(chain.name, {
      currentStep: 0,
      captures: {},
      lastAdvance: 0,
    });
  }

  /** Called after each event to advance matching chains */
  async evaluate(event: HookEvent, runAction: ChainActionRunner = this.runAction): Promise<HookResult | null> {
    let result: HookResult | null = null;

    for (const chain of [...this.chains]) {
      let state = this.states.get(chain.name);
      if (!state) continue;

      let step = chain.steps[state.currentStep] as ChainStep | undefined;
      if (!step) continue;

      if (step.within && state.lastAdvance > 0) {
        const withinMs = parseDuration(step.within);
        if (withinMs > 0 && Date.now() - state.lastAdvance > withinMs) {
          this._resetState(chain.name);
          // Re-check from step 0 with same event
          state = this.states.get(chain.name)!;
          step = chain.steps[state.currentStep] as ChainStep | undefined;
          if (!step || !matchesEventPath(step.match, event.path)) continue;
        }
      }

      // An optional step without a debounce is skipped when the event that
      // arrives belongs to the step after it.
      if (step.optional && !step.debounce && !matchesEventPath(step.match, event.path)) {
        const next = chain.steps[state.currentStep + 1] as ChainStep | undefined;
        if (next && matchesEventPath(next.match, event.path)) {
          state.currentStep++;
          step = next;
        }
      }

      if (!matchesEventPath(step.match, event.path)) continue;

      // Evaluate condition if present
      if (step.condition) {
        if (!safeEvaluate(step.condition, event.payload)) continue;
      }

      // Handle debounce for optional steps
      if (step.debounce && step.optional) {
        const debounceMs = parseDuration(step.debounce);
        if (state.debounceTimer !== undefined) {
          clearTimeout(state.debounceTimer);
        }
        const pendingState = state;
        const debouncedStep = step;
        pendingState.pendingDebounce = event;
        pendingState.debounceTimer = setTimeout(async () => {
          try {
            pendingState.debounceTimer = undefined;
            const pendingEvent = pendingState.pendingDebounce;
            if (!pendingEvent) return;
            pendingState.pendingDebounce = undefined;
            // Advance after debounce
            this._advanceState(chain, pendingState, pendingEvent, debouncedStep);
            if (pendingState.currentStep >= chain.steps.length) {
              this._resetState(chain.name);
              try {
                await this.runAction(chain, { ...pendingEvent, path: chain.action.match as unknown as import('./types.js').HookEventPath });
              } catch (err) {
                logger.error('ChainEngine: chain action error', {
                  chain: chain.name,
                  error: summarizeError(err),
                });
              }
            }
          } catch (err) {
            logger.error('ChainEngine: debounce callback error', {
              chain: chain.name,
              error: summarizeError(err),
            });
          }
        }, debounceMs);
        pendingState.debounceTimer.unref?.();
        continue;
      }

      // Advance step
      this._advanceState(chain, state, event, step);

      // Fire chain action if all steps complete. The state is reset first so
      // an event that arrives while the action runs starts a fresh pass.
      if (state.currentStep >= chain.steps.length) {
        const actionEvent: HookEvent = {
          ...event,
          path: chain.action.match as unknown as import('./types.js').HookEventPath,
        };
        this._resetState(chain.name);
        try {
          result = mergeResults(result, await runAction(chain, actionEvent));
        } catch (err) {
          logger.error('ChainEngine: chain action error', {
            chain: chain.name,
            error: summarizeError(err),
          });
          result = mergeResults(result, { ok: false, error: summarizeError(err) });
        }
      }
    }

    return result;
  }

  private _advanceState(chain: HookChain, state: ChainState, event: HookEvent, step: ChainStep): void {
    // Capture variables if specified
    if (step.capture) {
      for (const [varName, payloadKey] of Object.entries(step.capture)) {
        const val = event.payload[payloadKey]!;
        if (val !== undefined) {
          state.captures[varName] = String(val);
        }
      }
    }
    state.lastAdvance = Date.now();
    state.currentStep++;
  }

  private _resetState(chainName: string): void {
    const state = this.states.get(chainName);
    if (state?.debounceTimer !== undefined) {
      clearTimeout(state.debounceTimer);
    }
    this.states.set(chainName, {
      currentStep: 0,
      captures: {},
      lastAdvance: 0,
    });
  }

  /** Stop tracking one chain by name; false when it is not registered. */
  unregister(chainName: string): boolean {
    const idx = this.chains.findIndex((chain) => chain.name === chainName);
    if (idx === -1) return false;
    this._resetState(chainName);
    this.states.delete(chainName);
    this.chains.splice(idx, 1);
    return true;
  }

  /** Stop tracking every chain. */
  clear(): void {
    for (const chain of this.chains) this._resetState(chain.name);
    this.chains = [];
    this.states.clear();
  }

  /** Reset a specific chain */
  reset(chainName: string): void {
    this._resetState(chainName);
  }

  /** Reset all chains */
  resetAll(): void {
    for (const chain of this.chains) {
      this._resetState(chain.name);
    }
  }

  /** Get chain states for debugging */
  getStates(): Map<string, { currentStep: number; captures: Record<string, string>; lastAdvance: number }> {
    const result = new Map<string, { currentStep: number; captures: Record<string, string>; lastAdvance: number }>();
    for (const [name, state] of this.states.entries()) {
      result.set(name, {
        currentStep: state.currentStep,
        captures: { ...state.captures },
        lastAdvance: state.lastAdvance,
      });
    }
    return result;
  }
}
