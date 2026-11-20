import { createSharedRegexTester, RegexAdmissionError, type JudgmentReadingOptions, type SharedRegexTester } from '@goodvibes/engine/errors';
/**
 * Argument shape/content policy rule evaluator.
 *
 * ArgShapeRule matches tool calls by testing that all specified key/value pairs
 * are present in the tool's arguments. Values may be literal matches or regex
 * patterns (strings prefixed with `/`). Independently testable.
 */

import type {
  ArgShapeRule,
  EvaluationStep,
} from '../types.js';
import { compileSafeRegExp, safeRegExpTest } from '../../../utils/safe-regex.js';

/** Result returned by evaluateArgShapeRule. */
export interface ArgShapeRuleResult {
  matched: boolean;
  step: EvaluationStep;
}

/**
 * toolMatchesArgPattern, Returns true if `toolName` is matched by the rule's
 * `toolPattern` field (which may be a single string, `'*'`, or an array).
 */
function toolMatchesArgPattern(
  toolName: string,
  toolPattern: string | string[],
): boolean {
  if (Array.isArray(toolPattern)) {
    return toolPattern.some((p) => p === '*' || p === toolName);
  }
  return toolPattern === '*' || toolPattern === toolName;
}

/**
 * matchArgValue, Tests a single argument value against an expected matcher.
 *
 * - If `expected` is written `/pattern/` or `/pattern/flags`, it is a regex.
 * - Otherwise (including a literal path such as `/etc/passwd`), strict equality is used.
 *
 * @param actual  , The actual argument value.
 * @param expected, The expected matcher value from the rule.
 */
function matchArgValue(actual: unknown, expected: unknown): boolean {
  const regex = typeof expected === 'string' ? parseRegexMatcher(expected) : null;
  if (regex !== null) {
    try {
      const re = compileSafeRegExp(regex.source, regex.flags, { operation: 'permission arg-shape', maxPatternChars: 256 });
      return safeRegExpTest(re, String(actual), { operation: 'permission arg-shape', maxInputChars: 4_096 });
    } catch {
      // Invalid regex, treat as literal string match
      return actual === expected;
    }
  }
  return actual === expected;
}

/**
 * A matcher is a regex only when it reads `/source/flags` with a closing slash and flags from the
 * set JavaScript knows. An absolute path such as `/etc/passwd` is a literal: its tail after the
 * last slash is not a flag set.
 */
function parseRegexMatcher(expected: string): { source: string; flags: string } | null {
  const lastSlash = expected.lastIndexOf('/');
  if (!expected.startsWith('/') || lastSlash < 2) return null;
  const flags = expected.slice(lastSlash + 1);
  if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) return null;
  return { source: expected.slice(1, lastSlash), flags };
}

/**
 * evaluateArgShapeRule, Evaluates a single ArgShapeRule against a tool call.
 *
 * Returns `matched: true` only when:
 *   1. The tool name matches the rule's `toolPattern`, AND
 *   2. ALL key/value matchers in `argMatchers` match the corresponding arg values.
 *
 * @param rule    , The ArgShapeRule to evaluate.
 * @param toolName, Name of the tool being called.
 * @param args    , Arguments passed to the tool.
 */
function evaluateWithMatcher(
  rule: ArgShapeRule,
  toolName: string,
  args: Record<string, unknown>,
  matches: (actual: unknown, expected: unknown) => boolean,
): ArgShapeRuleResult {
  const toolMatches = toolMatchesArgPattern(toolName, rule.toolPattern);

  if (!toolMatches) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `arg-shape-rule:${rule.id}`,
        matched: false,
        detail: `tool "${toolName}" does not match pattern "${rule.toolPattern}"`,
      },
    };
  }

  const matchers = Object.entries(rule.argMatchers);
  if (matchers.length === 0) {
    // Empty matchers, matches any args for the tool
    return {
      matched: true,
      step: {
        layer: 'policy',
        check: `arg-shape-rule:${rule.id}`,
        matched: true,
        detail: 'tool matched with empty arg matchers (wildcard)',
      },
    };
  }

  const failedMatchers: string[] = [];
  for (const [key, expected] of matchers) {
    const actual = args[key]!;
    if (!matches(actual, expected)) {
      failedMatchers.push(key);
    }
  }

  if (failedMatchers.length === 0) {
    return {
      matched: true,
      step: {
        layer: 'policy',
        check: `arg-shape-rule:${rule.id}`,
        matched: true,
        detail: `all ${matchers.length} arg matcher(s) satisfied`,
      },
    };
  }

  return {
    matched: false,
    step: {
      layer: 'policy',
      check: `arg-shape-rule:${rule.id}`,
      matched: false,
      detail: `arg matchers failed for keys: [${failedMatchers.join(', ')}]`,
    },
  };
}

/** @deprecated Synchronous compatibility only. Production evaluation is async. */
export function evaluateArgShapeRule(rule: ArgShapeRule, toolName: string, args: Record<string, unknown>): ArgShapeRuleResult {
  return evaluateWithMatcher(rule, toolName, args, matchArgValue);
}

const ARG_SHAPE_OPERATION = 'permission arg-shape';
const ARG_SHAPE_MAX_PATTERN_CHARS = 256;
const ARG_SHAPE_MAX_INPUT_CHARS = 4_096;
/** A rule's pattern gets this long to test one argument; past it the test is refused and the worker replaced. */
const ARG_SHAPE_DEADLINE_MS = 1_000;

/**
 * The one isolated worker every permission rule set's patterns run in. The
 * gate builds its rule list per check, so a tester held per list would start a
 * worker per check; held here it starts on the first regex matcher and serves
 * every later one. A pattern past its deadline is refused and the worker
 * replaced. The idle worker never keeps the process alive.
 */
let permissionPatterns: SharedRegexTester | undefined;
function permissionPatternTester(): SharedRegexTester {
  return permissionPatterns ??= createSharedRegexTester({
    operation: ARG_SHAPE_OPERATION, timeoutMs: ARG_SHAPE_DEADLINE_MS, maxPatternChars: ARG_SHAPE_MAX_PATTERN_CHARS,
  });
}

export async function evaluateArgShapeRuleAsync(
  rule: ArgShapeRule, toolName: string, args: Record<string, unknown>, options: JudgmentReadingOptions = {},
): Promise<ArgShapeRuleResult> {
  const current = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  current();
  // Everything the reading compares is read before the first await, so a
  // caller's later change to the rule or the arguments cannot reach it.
  const capturedRule: ArgShapeRule = { ...rule, argMatchers: { ...rule.argMatchers },
    toolPattern: Array.isArray(rule.toolPattern) ? [...rule.toolPattern] : rule.toolPattern };
  const capturedArgs: Record<string, unknown> = {};
  for (const key of Object.keys(capturedRule.argMatchers)) capturedArgs[key] = args[key];
  const matches = new Map<unknown, boolean>();
  if (toolMatchesArgPattern(toolName, capturedRule.toolPattern)) {
    const tester = permissionPatternTester();
    for (const [key, expected] of Object.entries(capturedRule.argMatchers)) {
      const regex = typeof expected === 'string' ? parseRegexMatcher(expected) : null;
      if (regex === null) continue;
      const { source, flags } = regex;
      // Same fallback as the synchronous path: a matcher that is not a valid expression is a literal.
      try { void new RegExp(source, flags); } catch { continue; }
      const actual = String(capturedArgs[key]);
      if (actual.length > ARG_SHAPE_MAX_INPUT_CHARS) throw new RegexAdmissionError(ARG_SHAPE_OPERATION, `input exceeds ${ARG_SHAPE_MAX_INPUT_CHARS} characters`);
      current();
      matches.set(key, await tester.test(source, actual, options.signal, flags));
      current();
    }
  }
  // Preserve key identity, including equal matcher text used for unequal args.
  let index = 0;
  const keys = Object.keys(capturedRule.argMatchers);
  const result = evaluateWithMatcher(capturedRule, toolName, capturedArgs, (actual, expected) => {
    const key = keys[index++]!;
    return matches.has(key) ? matches.get(key)! : actual === expected;
  });
  current();
  return result;
}
