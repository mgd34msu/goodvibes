/**
 * Segmenter, splits a list of CommandTokens into discrete CommandSegments
 * at compound command boundaries (&&, ||, ;, |).
 *
 * Each segment carries its own token list, resolved command name, positional
 * args, flags, and the operator that connects it to the next segment.
 */

import type { CommandSegment, CommandToken } from './types.js';
import { canonicalize, isEnvAssignmentToken } from './canonicalizer.js';

/** Operator token types that act as segment boundaries. */
type SegmentBoundary = '&&' | '||' | ';' | '|';

const BOUNDARY_VALUES = new Set<string>(['&&', '||', ';', '|']);

/**
 * The word a token contributes as the command, or undefined when the token only
 * precedes it: an environment assignment, a `{` / `!` group opener, a `}` closer,
 * or the parentheses of a `(subshell)` (`(git` names git).
 */
function commandWordOf(token: CommandToken): string | undefined {
  if (token.type !== 'command' && token.type !== 'argument' && token.type !== 'path') return undefined;
  const value = token.value;
  if (isEnvAssignmentToken(value) || value === '{' || value === '}' || value === '!') return undefined;
  if (value.startsWith('(') || value === ')') {
    const inner = value.replace(/^\(+/, '').replace(/\)+$/, '');
    return inner === '' ? undefined : inner;
  }
  return value;
}

/**
 * Builds a single CommandSegment from a slice of tokens and an optional
 * trailing operator.
 *
 * @param tokens - Tokens belonging to this segment (excluding operator).
 * @param operator - The operator that follows this segment, if any.
 * @returns A fully populated CommandSegment.
 */
function buildSegment(
  tokens: CommandToken[],
  operator?: SegmentBoundary,
): CommandSegment {
  let commandIndex = -1;
  let rawCommand = '';
  for (let i = 0; i < tokens.length; i++) {
    const word = commandWordOf(tokens[i]!);
    if (word !== undefined) {
      commandIndex = i;
      rawCommand = word;
      break;
    }
  }
  const command = canonicalize(rawCommand);

  const args = tokens
    .filter((t, i) => i > commandIndex && t.type === 'argument')
    .map((t) => t.value);

  const flags = tokens
    .filter((t) => t.type === 'flag')
    .map((t) => t.value);

  const raw = tokens.map((t) => t.value).join(' ');

  return { raw, tokens, command, args, flags, operator };
}

/**
 * Splits an ordered list of CommandTokens into CommandSegments, splitting
 * at operator and pipe tokens (&&, ||, ;, |).
 *
 * @param tokens - The full token list from the tokenizer.
 * @returns Ordered array of CommandSegment objects.
 */
export function segment(tokens: CommandToken[]): CommandSegment[] {
  if (tokens.length === 0) return [];

  const segments: CommandSegment[] = [];
  let currentTokens: CommandToken[] = [];

  for (const token of tokens) {
    if (
      (token.type === 'operator' || token.type === 'pipe') &&
      BOUNDARY_VALUES.has(token.value)
    ) {
      const operator = token.value as SegmentBoundary;
      segments.push(buildSegment(currentTokens, operator));
      currentTokens = [];
    } else {
      currentTokens.push(token);
    }
  }

  // Push the final segment (no trailing operator)
  if (currentTokens.length > 0) {
    segments.push(buildSegment(currentTokens));
  }

  return segments;
}
