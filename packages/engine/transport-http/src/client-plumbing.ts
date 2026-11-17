import type { OmitNamed, RequiredNamedKeys } from '@goodvibes-jev/engine/contracts';
import { ContractError, admitRegex, type SharedRegexTester } from '@goodvibes-jev/engine/errors';

const MAX_SCHEMA_PATTERN_CHARS = 512;

/**
 * The required keys of a contract input.
 *
 * Delegates to `RequiredNamedKeys` rather than mapping over `keyof T` directly.
 * A contract input whose schema sets `additionalProperties: true` renders as
 * `Base & { readonly [key: string]: unknown }`, and `keyof` that intersection is
 * `string | number`, so a direct mapped type iterates the index keys instead of
 * the declared ones and yields `never`. That made `MethodArgs` below conclude
 * "no required fields", and hand the caller an OPTIONAL input argument, for
 * every open-envelope verb: 139 of the 443 operator methods.
 */
export type RequiredKeys<T extends object> = RequiredNamedKeys<T>;

/**
 * Maps a contract input object to the public client method argument tuple.
 * Required input fields make the first argument required; fully optional input
 * shapes keep it optional; `undefined` inputs expose only the options argument.
 */
export type MethodArgs<TInput, TOptions> =
  [TInput] extends [undefined]
    ? [input?: undefined, options?: TOptions]
    // `[TInput] extends [object]` rather than `TInput extends object`: the bare
    // form is a DISTRIBUTIVE conditional, so a union input is split and the
    // whole tail, including `RequiredKeys`, a mapped type doing one `Pick` per
    // property, is evaluated once per member. A method whose input is
    // `Base & (A | B | C)` (see method-catalog-shared.ts `branchedSchema`, used
    // by the verbs whose required set is conditional) therefore cost three full
    // passes over a thirty-property object, and with several such methods in
    // one map the operator client stopped compiling: TS2590, "union type too
    // complex to represent", at the `OperatorRemoteClient` literal.
    //
    // Nothing here wanted per-member behaviour. The question being asked is
    // "is this input an object at all", and the answer for a union is the same
    // for every member. Wrapping in a tuple asks it once, and yields one
    // argument tuple instead of a union of them, which is also the more usable
    // signature for a caller.
    : [TInput] extends [object]
      ? [RequiredKeys<TInput>] extends [never]
        ? [input?: TInput, options?: TOptions]
        : [input: TInput, options?: TOptions]
      : [input: TInput, options?: TOptions];

/**
 * Remove path-bound keys from a contract input before exposing method helpers.
 *
 * `OmitNamed` rather than `Omit<TInput, Extract<keyof TInput, TKeys>>` for the
 * same reason as `RequiredKeys` above: against an open envelope, `keyof TInput`
 * is `string | number`, so the omit removed nothing recognisable and the result
 * collapsed to the bare index signature, every remaining field, and its
 * requiredness, silently dropped from the helper's argument type.
 */
export type WithoutKeys<TInput, TKeys extends PropertyKey> =
  [TInput] extends [undefined]
    ? undefined
    : TInput extends object
      ? OmitNamed<TInput, TKeys>
      : TInput;

/**
 * Splits a generated client helper's rest tuple into input and options.
 * The tuple type already proves the argument shape; runtime work is only the
 * array-position split used by generated path helpers.
 */
export function splitClientArgs<TInput, TOptions>(
  args: readonly unknown[],
): readonly [TInput | undefined, TOptions | undefined] {
  if (args.length > 2) {
    throw new ContractError(`Contract client helper expected at most 2 arguments but received ${args.length}.`);
  }
  // drop misleading non-null assertions, args[0]/args[1] may be undefined.
  return [args[0] as TInput | undefined, args[1] as TOptions | undefined];
}

/** Convert a typed client input object into the record shape required by contract route helpers. */
export function clientInputRecord<TInput>(input: TInput | undefined): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

/**
 * Merge fixed path fields with the optional typed client input record.
 *
 * Fixed path fields are spread LAST so the explicit positional path parameter the
 * caller named always wins over a same-named field on the input object. The public
 * `WithoutKeys` type already strips path keys from the input for TypeScript callers,
 * but JS consumers get no such protection, without this ordering a stray
 * `{ sessionId: 'other' }` could redirect the request to a different resource id
 * than the caller positionally specified.
 */
export function mergeClientInput<TInput>(
  fixed: Record<string, unknown>,
  input: TInput | undefined,
): Record<string, unknown> {
  return {
    ...(clientInputRecord(input) ?? {}),
    ...fixed,
  };
}

export interface JsonSchemaValidationFailure {
  readonly path: string;
  readonly expected: string;
  readonly received: string;
}

/** Options for {@link firstJsonSchemaFailureAsync}. */
export interface JsonSchemaValidationOptions {
  readonly signal?: AbortSignal | undefined;
  /** Called after each isolated pattern test; throws to stop the validation. */
  readonly assertCurrent?: (() => void) | undefined;
  /**
   * The holder's long-lived isolated tester. When given, a pattern that does
   * not run natively is tested there instead of in an executor started for
   * this one validation.
   */
  readonly isolatedTester?: Pick<SharedRegexTester, 'test'> | undefined;
}

/**
 * Validate a value against a JSON Schema synchronously. Gives the same result
 * as {@link firstJsonSchemaFailureAsync} for every schema whose patterns run
 * natively (every pattern in the shipped contracts); a pattern that needs the
 * isolated executor cannot be evaluated here and is reported as a failure of
 * that field instead.
 */
export function firstJsonSchemaFailure(
  schema: Record<string, unknown>, value: unknown, path = '$', root: Record<string, unknown> = schema, _depth = 0,
): JsonSchemaValidationFailure | undefined {
  const walk = walkJsonSchema(schema, value, path, root, _depth);
  let next = walk.next();
  while (!next.done) {
    const pattern = schemaPattern(next.value.source);
    if (!pattern) {
      return { path: next.value.path, expected: `pattern ${next.value.source}`, received: 'a pattern that only the asynchronous validator can evaluate' };
    }
    pattern.lastIndex = 0;
    next = walk.next(pattern.test(next.value.value));
  }
  return next.value;
}

/**
 * Validate a value against a JSON Schema. A pattern that runs natively (see
 * `schemaPattern`) is tested in place; any other pattern, which only an
 * untrusted schema such as a third-party tool definition carries, runs in the
 * caller's long-lived isolated tester, or without one in an isolated executor
 * started for this call. The schema and the value are the caller's settled
 * values, so neither is copied or re-scanned.
 */
export async function firstJsonSchemaFailureAsync(
  schema: Record<string, unknown>, value: unknown,
  options: JsonSchemaValidationOptions = {},
): Promise<JsonSchemaValidationFailure | undefined> {
  const signal = options.signal, assertOwnerCurrent = options.assertCurrent, shared = options.isolatedTester;
  signal?.throwIfAborted();
  const walk = walkJsonSchema(schema, value);
  let next = walk.next();
  let isolated: Map<string, Awaited<ReturnType<typeof admitRegex>>> | undefined;
  try {
    while (!next.done) {
      const { source, value: input } = next.value;
      const pattern = schemaPattern(source);
      if (pattern) {
        pattern.lastIndex = 0;
        next = walk.next(pattern.test(input));
        continue;
      }
      const current = () => { signal?.throwIfAborted(); assertOwnerCurrent?.(); };
      if (shared) {
        const matches = await shared.test(source, input, signal);
        current();
        next = walk.next(matches);
        continue;
      }
      isolated ??= new Map();
      let handle = isolated.get(source);
      if (!handle) {
        handle = await admitRegex(source, '', { operation: 'schema pattern', signal, assertCurrent: current });
        isolated.set(source, handle);
      }
      const matches = await handle.test(input);
      current();
      next = walk.next(matches);
    }
    return next.value;
  } finally {
    if (isolated) for (const handle of isolated.values()) await handle[Symbol.asyncDispose]();
  }
}

// Compiled schema patterns by source, for the life of the process. A contract
// carries about ten distinct patterns, so the bound only matters for a caller
// that validates against many untrusted schemas.
const MAX_CACHED_SCHEMA_PATTERNS = 512;
const schemaPatterns = new Map<string, RegExp | null>();

/**
 * The compiled pattern when it is safe to run on this thread, or null when it
 * must run in the isolated executor. Decided once per distinct source.
 * Throws a SyntaxError for a pattern that is not a valid regular expression.
 */
function schemaPattern(source: string): RegExp | null {
  const known = schemaPatterns.get(source);
  if (known !== undefined) return known;
  const compiled = new RegExp(source);
  const pattern = source.length <= MAX_SCHEMA_PATTERN_CHARS && isLinearSchemaPattern(source) ? compiled : null;
  if (schemaPatterns.size >= MAX_CACHED_SCHEMA_PATTERNS) schemaPatterns.clear();
  schemaPatterns.set(source, pattern);
  return pattern;
}

/**
 * True when a regular expression is proven to run in time linear in its input
 * on a backtracking engine, so it may run on this thread. Anything the proof
 * cannot cover runs in the isolated executor instead, which is always correct.
 *
 * The proof: no backreference, lookaround or inline modifier; every part
 * matches a given stretch of text in at most one way (alternatives start with
 * different characters or are distinct fixed strings; a repeated group always
 * has one way to match and cannot match empty); and two parts that can each
 * match a varying amount of text never meet unless the second must start with
 * a character none of the text since the first can contain, so where one ends
 * and the next begins is decided by the input. A pattern with such a part is
 * also anchored with `^`, so it is tried from one position only. This admits
 * every pattern the shipped contracts use (fixed-width ids, `\S`, bounded runs,
 * `^\d+(?:\.\d{1,3})?$`) and refuses nested or overlapping repetition such as
 * `(a+)+`, `(a|aa)*`, `a{0,255}a{0,255}` and `(?:a|a)?(?:a|a)?`.
 */
export function isLinearSchemaPattern(source: string): boolean {
  const cursor: PatternCursor = { source, index: 0 };
  const pattern = readAlternatives(cursor);
  if (!pattern || cursor.index !== source.length) return false;
  return pattern.anchored || (pattern.determined && pattern.maxWidth <= MAX_UNANCHORED_PATTERN_WIDTH);
}

// A pattern with one way to match, tried at every position of an unanchored
// search, costs its width per position; past this width it must be anchored.
const MAX_UNANCHORED_PATTERN_WIDTH = 1024;

// Character sets as sorted, merged UTF-16 code unit ranges: schema patterns
// compile without flags, so one character is one code unit.
type CharRanges = readonly (readonly [number, number])[];
const MAX_CODE_UNIT = 0xffff;
const NO_CHARS: CharRanges = [];

function charRanges(list: readonly (readonly [number, number])[]): CharRanges {
  const sorted = [...list].sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const [low, high] of sorted) {
    const last = merged[merged.length - 1];
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

function unionChars(left: CharRanges, right: CharRanges): CharRanges {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return charRanges([...left, ...right]);
}

function complementChars(set: CharRanges): CharRanges {
  const out: [number, number][] = [];
  let next = 0;
  for (const [low, high] of set) {
    if (low > next) out.push([next, low - 1]);
    next = high + 1;
  }
  if (next <= MAX_CODE_UNIT) out.push([next, MAX_CODE_UNIT]);
  return out;
}

function charsOverlap(left: CharRanges, right: CharRanges): boolean {
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const [leftLow, leftHigh] = left[i]!;
    const [rightLow, rightHigh] = right[j]!;
    if (leftHigh < rightLow) i += 1;
    else if (rightHigh < leftLow) j += 1;
    else return true;
  }
  return false;
}

const DIGIT_CHARS = charRanges([[0x30, 0x39]]);
const WORD_CHARS = charRanges([[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]]);
const SPACE_CHARS = charRanges([
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
]);
const ANY_BUT_LINE_END = complementChars(charRanges([[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]]));
const CLASS_ESCAPES: Readonly<Record<string, CharRanges>> = {
  d: DIGIT_CHARS, D: complementChars(DIGIT_CHARS),
  w: WORD_CHARS, W: complementChars(WORD_CHARS),
  s: SPACE_CHARS, S: complementChars(SPACE_CHARS),
};
const CONTROL_ESCAPES: Readonly<Record<string, number>> = { t: 9, n: 10, v: 11, f: 12, r: 13 };

interface PatternCursor { readonly source: string; index: number }

/** What the linearity proof needs to know about one part of a pattern. */
interface PatternPart {
  /** At most one way to match from a given position. */
  readonly determined: boolean;
  /**
   * When not determined: the characters the text matched since the part's
   * last choice may contain, which whatever follows must not start with.
   */
  readonly trailing: CharRanges | null;
  readonly nullable: boolean;
  /** Characters a non-empty match can start with. */
  readonly first: CharRanges;
  /** Characters a match can contain. */
  readonly chars: CharRanges;
  /**
   * The characters every match holds at each of its first positions (at most
   * MAX_PATTERN_PREFIX); `prefixComplete` when that covers the whole match.
   */
  readonly prefix: readonly CharRanges[];
  readonly prefixComplete: boolean;
  /** Longest match in code units; Infinity when unbounded. */
  readonly maxWidth: number;
  /** The one string this part matches, when it matches exactly one. */
  readonly literal: string | null;
  /** Begins with a `^` assertion. */
  readonly anchored: boolean;
}

const MAX_PATTERN_PREFIX = 32;

const ASSERTION_PART: PatternPart = {
  determined: true, trailing: null, nullable: true, first: NO_CHARS, chars: NO_CHARS,
  prefix: [], prefixComplete: true, maxWidth: 0, literal: '', anchored: false,
};

function charPart(chars: CharRanges, code: number | null): PatternPart {
  return {
    determined: true, trailing: null, nullable: false, first: chars, chars,
    prefix: [chars], prefixComplete: true, maxWidth: 1,
    literal: code === null ? null : String.fromCharCode(code), anchored: false,
  };
}

/** True when no text matches both parts: they differ at the start or at some position both must fill. */
function partsExclusive(left: PatternPart, right: PatternPart): boolean {
  if (!(left.nullable && right.nullable) && !charsOverlap(left.first, right.first)) return true;
  const shared = Math.min(left.prefix.length, right.prefix.length);
  for (let position = 0; position < shared; position += 1) {
    if (!charsOverlap(left.prefix[position]!, right.prefix[position]!)) return true;
  }
  return false;
}

interface ReadEscape { readonly chars: CharRanges; readonly code: number | null; readonly assertion: boolean; readonly next: number }

/** The escape at `index` (a backslash), or null when the proof does not cover it. */
function readEscape(source: string, index: number, inClass: boolean): ReadEscape | null {
  const escaped = source[index + 1];
  if (escaped === undefined) return null;
  const single = (code: number, next = index + 2): ReadEscape => ({ chars: [[code, code]], code, assertion: false, next });
  const classChars = CLASS_ESCAPES[escaped];
  if (classChars) return { chars: classChars, code: null, assertion: false, next: index + 2 };
  if (escaped === 'b') return inClass ? single(8) : { chars: NO_CHARS, code: null, assertion: true, next: index + 2 };
  if (escaped === 'B' && !inClass) return { chars: NO_CHARS, code: null, assertion: true, next: index + 2 };
  // Backreferences, octal escapes and named references.
  if (/[1-9k]/.test(escaped)) return null;
  if (escaped === '0') return /[0-9]/.test(source[index + 2] ?? '') ? null : single(0);
  const control = CONTROL_ESCAPES[escaped];
  if (control !== undefined) return single(control);
  if (escaped === 'x' || escaped === 'u') {
    const digits = escaped === 'x' ? 2 : 4;
    const hex = source.slice(index + 2, index + 2 + digits);
    if (hex.length === digits && /^[0-9a-fA-F]+$/.test(hex)) return single(Number.parseInt(hex, 16), index + 2 + digits);
    return single(escaped.charCodeAt(0));
  }
  if (escaped === 'c') {
    const letter = source[index + 2] ?? '';
    return /[A-Za-z]/.test(letter) ? single(letter.charCodeAt(0) % 32, index + 3) : null;
  }
  return single(escaped.charCodeAt(0));
}

/** The character class at `index` (an opening bracket), or null when the proof does not cover it. */
function readClass(source: string, index: number): { chars: CharRanges; next: number } | null {
  let at = index + 1;
  const negated = source[at] === '^';
  if (negated) at += 1;
  const members: (readonly [number, number])[] = [];
  const readMember = (position: number): ReadEscape | null => {
    if (source[position] === '\\') return readEscape(source, position, true);
    const code = source.charCodeAt(position);
    return { chars: [[code, code]], code, assertion: false, next: position + 1 };
  };
  while (at < source.length && source[at] !== ']') {
    const low = readMember(at);
    if (!low) return null;
    at = low.next;
    if (source[at] === '-' && at + 1 < source.length && source[at + 1] !== ']') {
      const high = readMember(at + 1);
      if (!high) return null;
      if (low.code === null || high.code === null) {
        members.push(...low.chars, ...high.chars, [0x2d, 0x2d]);
      } else {
        if (low.code > high.code) return null;
        members.push([low.code, high.code]);
      }
      at = high.next;
    } else {
      members.push(...low.chars);
    }
  }
  if (source[at] !== ']') return null;
  const chars = charRanges(members);
  return { chars: negated ? complementChars(chars) : chars, next: at + 1 };
}

const QUANTIFIER = /(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/y;
const NAMED_GROUP = /\(\?<[A-Za-z_$][\w$]*>/y;

function readAlternatives(cursor: PatternCursor): PatternPart | null {
  const branches: PatternPart[] = [];
  for (;;) {
    const branch = readSequence(cursor);
    if (!branch) return null;
    branches.push(branch);
    if (cursor.source[cursor.index] !== '|') break;
    cursor.index += 1;
  }
  if (branches.length === 1) return branches[0]!;
  let nullable = 0;
  let exclusive = true;
  for (let i = 0; i < branches.length; i += 1) {
    if (branches[i]!.nullable) nullable += 1;
    for (let j = 0; j < i && exclusive; j += 1) {
      if (!partsExclusive(branches[i]!, branches[j]!)) exclusive = false;
    }
  }
  // Two alternatives that can match the same text give that text two ways to
  // match, which a repetition or a sequence multiplies. Exclusive alternatives
  // can each start a match of a different length only when they are distinct
  // fixed strings, which also never match the same text.
  if (nullable > 1) return null;
  if (!exclusive) {
    const literals = branches.map((branch) => branch.literal);
    if (literals.some((literal) => literal === null) || new Set(literals).size !== literals.length) return null;
  }
  let first = NO_CHARS;
  let chars = NO_CHARS;
  for (const branch of branches) {
    first = unionChars(first, branch.first);
    chars = unionChars(chars, branch.chars);
  }
  const shared = Math.min(...branches.map((branch) => branch.prefix.length));
  const prefix: CharRanges[] = [];
  for (let position = 0; position < shared; position += 1) {
    prefix.push(branches.reduce<CharRanges>((union, branch) => unionChars(union, branch.prefix[position]!), NO_CHARS));
  }
  const determined = exclusive && nullable === 0 && branches.every((branch) => branch.determined);
  return {
    determined,
    trailing: determined ? null : chars,
    nullable: nullable > 0,
    first,
    chars,
    prefix,
    prefixComplete: false,
    maxWidth: Math.max(...branches.map((branch) => branch.maxWidth)),
    literal: null,
    anchored: branches.every((branch) => branch.anchored),
  };
}

function readSequence(cursor: PatternCursor): PatternPart | null {
  const { source } = cursor;
  // The characters the text since the last part with more than one way to
  // match may contain; null when every part so far has had one way.
  let pending: CharRanges | null = null;
  let nullable = true;
  let first = NO_CHARS;
  let chars = NO_CHARS;
  let maxWidth = 0;
  let literal: string | null = '';
  let anchored: boolean | undefined;
  const prefix: CharRanges[] = [];
  let prefixComplete = true;
  while (cursor.index < source.length && source[cursor.index] !== '|' && source[cursor.index] !== ')') {
    const part = readQuantifiedPart(cursor);
    if (!part) return null;
    anchored ??= part.anchored;
    if (prefixComplete) {
      prefix.push(...part.prefix.slice(0, MAX_PATTERN_PREFIX - prefix.length));
      prefixComplete = part.prefixComplete && prefix.length < MAX_PATTERN_PREFIX;
    }
    if (pending === null) {
      // Everything before had one way to match, so this part's start is
      // decided; what stays open is the part's own trailing choice.
      if (!part.determined) pending = part.trailing ?? part.chars;
    } else if (!part.nullable && !charsOverlap(part.first, pending)) {
      // This part must start on a character the pending text cannot hold,
      // so the input decides where that text ends.
      pending = part.determined ? null : part.trailing ?? part.chars;
    } else if (!part.determined && charsOverlap(part.first, pending)) {
      return null;
    } else {
      pending = unionChars(pending, part.chars);
    }
    if (nullable) first = unionChars(first, part.first);
    nullable &&= part.nullable;
    chars = unionChars(chars, part.chars);
    maxWidth += part.maxWidth;
    literal = literal !== null && part.literal !== null ? literal + part.literal : null;
  }
  return {
    determined: pending === null, trailing: pending, nullable, first, chars, prefix, prefixComplete,
    maxWidth, literal, anchored: anchored ?? false,
  };
}

function readQuantifiedPart(cursor: PatternCursor): PatternPart | null {
  const atom = readAtom(cursor);
  if (!atom) return null;
  const { source } = cursor;
  QUANTIFIER.lastIndex = cursor.index;
  const quantifier = QUANTIFIER.exec(source);
  if (!quantifier || atom.assertion) return atom.part;
  cursor.index = QUANTIFIER.lastIndex;
  const [, symbol, min, comma, max] = quantifier;
  const upper = symbol === '?' ? 1 : symbol ? Infinity : comma === undefined ? Number(min) : max ? Number(max) : Infinity;
  const lower = symbol === '+' ? 1 : symbol ? 0 : Number(min);
  const part = atom.part;
  // A part repeated more than once either has one way to match or must start
  // on a character its own trailing choice cannot hold, so the input decides
  // where each repetition ends; a part that can match empty gives an optional
  // or repeated match two ways to be empty.
  if (upper > 1 && !part.determined && (part.nullable || charsOverlap(part.first, part.trailing ?? part.chars))) return null;
  if (part.nullable && upper !== lower) return null;
  const none = upper === 0;
  const determined = none || (part.determined && lower === upper);
  // The repetitions every match makes come first, in order.
  const prefix: CharRanges[] = [];
  for (let repetition = 0; repetition < lower && prefix.length < MAX_PATTERN_PREFIX; repetition += 1) {
    prefix.push(...part.prefix.slice(0, MAX_PATTERN_PREFIX - prefix.length));
    if (!part.prefixComplete || part.prefix.length === 0) break;
  }
  const prefixComplete = none || (lower === upper && part.prefixComplete && prefix.length === part.prefix.length * lower);
  return {
    determined,
    trailing: determined ? null : lower === upper ? part.trailing ?? part.chars : part.chars,
    nullable: lower === 0 || part.nullable,
    first: none ? NO_CHARS : part.first,
    chars: none ? NO_CHARS : part.chars,
    prefix,
    prefixComplete,
    maxWidth: none || part.maxWidth === 0 ? 0 : part.maxWidth * upper,
    literal: part.literal !== null && lower === upper && lower <= 64 ? part.literal.repeat(lower) : null,
    anchored: part.anchored && lower > 0,
  };
}

function readAtom(cursor: PatternCursor): { part: PatternPart; assertion: boolean } | null {
  const { source } = cursor;
  const char = source[cursor.index]!;
  if (char === '^' || char === '$') {
    cursor.index += 1;
    return { part: char === '^' ? { ...ASSERTION_PART, anchored: true } : ASSERTION_PART, assertion: true };
  }
  if (char === '\\') {
    const escape = readEscape(source, cursor.index, false);
    if (!escape) return null;
    cursor.index = escape.next;
    return escape.assertion ? { part: ASSERTION_PART, assertion: true } : { part: charPart(escape.chars, escape.code), assertion: false };
  }
  if (char === '[') {
    const set = readClass(source, cursor.index);
    if (!set) return null;
    cursor.index = set.next;
    return { part: charPart(set.chars, null), assertion: false };
  }
  if (char === '.') {
    cursor.index += 1;
    return { part: charPart(ANY_BUT_LINE_END, null), assertion: false };
  }
  if (char === '(') {
    NAMED_GROUP.lastIndex = cursor.index;
    if (source.startsWith('(?:', cursor.index)) cursor.index += 3;
    else if (NAMED_GROUP.test(source)) cursor.index = NAMED_GROUP.lastIndex;
    else if (source[cursor.index + 1] === '?') return null;
    else cursor.index += 1;
    const inner = readAlternatives(cursor);
    if (!inner || source[cursor.index] !== ')') return null;
    cursor.index += 1;
    return { part: inner, assertion: false };
  }
  if (char === '*' || char === '+' || char === '?' || char === ')' || char === '|') return null;
  if (char === '{') {
    QUANTIFIER.lastIndex = cursor.index;
    if (QUANTIFIER.test(source)) return null;
  }
  cursor.index += 1;
  const code = char.charCodeAt(0);
  return { part: charPart([[code, code]], code), assertion: false };
}

type PatternRequest = { source: string; value: string; path: string };
type SchemaArguments = [schema: Record<string, unknown>, value: unknown, path: string, root: Record<string, unknown>, depth: number];
type SchemaStep = Generator<PatternRequest | { walk: SchemaArguments }, JsonSchemaValidationFailure | undefined, boolean | JsonSchemaValidationFailure | undefined>;
function* requestSchema(...walk: SchemaArguments): SchemaStep {
  return (yield { walk }) as JsonSchemaValidationFailure | undefined;
}
/** Iterate the schema/value call stack; cyclic refs cannot bypass validation. */
function* walkJsonSchema(schema: Record<string, unknown>, value: unknown, path = '$', root = schema, depth = 0): Generator<PatternRequest, JsonSchemaValidationFailure | undefined, boolean> {
  const active = new Map<Record<string, unknown>, Set<unknown>>();
  const stack: { args: SchemaArguments; iterator: SchemaStep }[] = [];
  const push = (args: SchemaArguments) => {
    let values = active.get(args[0]);
    if (!values) { values = new Set(); active.set(args[0], values); }
    values.add(args[1]);
    stack.push({ args, iterator: walkJsonSchemaStep(...args) });
  };
  push([schema, value, path, root, depth]);
  let answer: boolean | JsonSchemaValidationFailure | undefined;
  while (stack.length) {
    const current = stack[stack.length - 1]!;
    const step = current.iterator.next(answer);
    answer = undefined;
    if (step.done) {
      active.get(current.args[0])!.delete(current.args[1]);
      stack.pop(); answer = step.value;
      continue;
    }
    if ('walk' in step.value) {
      const args = step.value.walk;
      if (active.get(args[0])?.has(args[1])) {
        answer = { path: args[2], expected: 'a resolvable non-cyclic schema constraint', received: 'cyclic schema reference' };
      } else push(args);
    } else answer = yield step.value;
  }
  return answer as JsonSchemaValidationFailure | undefined;
}

function* walkJsonSchemaStep(
  schema: Record<string, unknown>,
  value: unknown,
  path = '$',
  root: Record<string, unknown> = schema,
  _depth = 0,
): SchemaStep {
  if (typeof schema.$ref === 'string') {
    const resolved = resolveLocalSchemaRef(root, schema.$ref);
    return resolved ? yield* requestSchema(resolved, value, path, root, _depth + 1) : undefined;
  }
  const excluded = schema.not;
  if (excluded === true || (excluded !== null && typeof excluded === 'object' && !Array.isArray(excluded)
    && (yield* requestSchema(excluded as Record<string, unknown>, value, path, root, _depth + 1)) === undefined)) {
    return { path, expected: 'not to match the excluded schema', received: typeOfJsonValue(value) };
  }
  const allOf = readSchemaList(schema.allOf);
  for (const child of allOf) {
    const failure = yield* requestSchema(child, value, path, root, _depth + 1);
    if (failure) return failure;
  }
  const anyOf = readSchemaList(schema.anyOf);
  if (anyOf.length > 0) {
    const failures: (JsonSchemaValidationFailure | undefined)[] = [];
    for (const child of anyOf) failures.push(yield* requestSchema(child, value, path, root, _depth + 1));
    if (failures.every(Boolean)) return bestSchemaFailure(failures) ?? { path, expected: 'one matching schema', received: typeOfJsonValue(value) };
  }
  const oneOf = readSchemaList(schema.oneOf);
  if (oneOf.length > 0) {
    let matches = 0;
    for (const child of oneOf) if (!(yield* requestSchema(child, value, path, root, _depth + 1))) matches++;
    if (matches !== 1) return { path, expected: 'exactly one matching schema', received: `${matches} matches` };
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => Object.is(candidate, value))) {
    return { path, expected: `one of ${enumValues.map(String).join(', ')}`, received: typeOfJsonValue(value) };
  }
  if ('const' in schema && !Object.is(schema.const, value)) {
    return { path, expected: JSON.stringify(schema.const), received: typeOfJsonValue(value) };
  }
  const types = readSchemaTypes(schema.type);
  if (types.length > 0 && !types.some((type) => valueMatchesJsonType(value, type))) {
    return { path, expected: types.join(' | '), received: typeOfJsonValue(value) };
  }
  const minimum = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  if (typeof value === 'number' && minimum !== undefined && value < minimum) {
    return { path, expected: `>= ${minimum}`, received: String(value) };
  }
  const maximum = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  if (typeof value === 'number' && maximum !== undefined && value > maximum) {
    return { path, expected: `<= ${maximum}`, received: String(value) };
  }
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : undefined;
  const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  // JSON Schema lengths count Unicode code points, as the canonical Jev parser
  // does for summaries, rather than UTF-16 code units.
  let stringLength = 0;
  if (typeof value === 'string' && (minLength !== undefined || maxLength !== undefined)) {
    for (const _character of value) stringLength += 1;
  }
  if (typeof value === 'string' && minLength !== undefined && stringLength < minLength) {
    return { path, expected: `length >= ${minLength}`, received: `length ${stringLength}` };
  }
  if (typeof value === 'string' && maxLength !== undefined && stringLength > maxLength) {
    return { path, expected: `length <= ${maxLength}`, received: `length ${stringLength}` };
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string') {
    const matches = yield { source: schema.pattern, value, path };
    if (!matches) return { path, expected: `pattern ${schema.pattern}`, received: 'non-matching string' };
  }
  if (typeof value === 'string' && typeof schema.format === 'string' && !stringMatchesJsonSchemaFormat(value, schema.format)) {
    return { path, expected: `format ${schema.format}`, received: 'non-matching string' };
  }
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === 'object' && !Array.isArray(itemSchema)) {
      for (let index = 0; index < value.length; index++) {
        // pass _depth + 1 so depth-reset through array items is prevented.
        const failure = yield* requestSchema(itemSchema as Record<string, unknown>, value[index], `${path}[${index}]`, root, _depth + 1);
        if (failure) return failure;
      }
    }
    const minItems = typeof schema.minItems === 'number' ? schema.minItems : undefined;
    if (minItems !== undefined && value.length < minItems) return { path, expected: `items >= ${minItems}`, received: `${value.length} items` };
    const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
    if (maxItems !== undefined && value.length > maxItems) return { path, expected: `items <= ${maxItems}`, received: `${value.length} items` };
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        let key: string | undefined;
        try {
          // JSON object member order is irrelevant; array order and primitive
          // types remain significant. Wire values are JSON, never live objects.
          key = JSON.stringify(item, (_key: string, current: unknown) => current !== null
            && typeof current === 'object' && !Array.isArray(current)
            ? Object.fromEntries(Object.entries(current).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
            : current);
        } catch {
          return { path, expected: 'JSON values for unique items', received: 'unserializable value' };
        }
        if (key === undefined) return { path, expected: 'JSON values for unique items', received: typeOfJsonValue(item) };
        if (seen.has(key)) return { path, expected: 'unique items', received: 'duplicate item' };
        seen.add(key);
      }
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const key of required) {
      if (!(key in objectValue)) return { path: `${path}.${key}`, expected: 'required field', received: 'missing' };
    }
    const properties = schema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
        if (!(key in objectValue)) continue;
        if (!propertySchema || typeof propertySchema !== 'object' || Array.isArray(propertySchema)) continue;
        // pass _depth + 1 so nested property recursion respects the walk depth limit.
        const failure = yield* requestSchema(propertySchema as Record<string, unknown>, objectValue[key], `${path}.${key}`, root, _depth + 1);
        if (failure) return failure;
      }
    }
    const additional = schema.additionalProperties;
    const declared = properties !== null && typeof properties === 'object' && !Array.isArray(properties)
      ? new Set(Object.keys(properties)) : new Set<string>();
    for (const key of Object.keys(objectValue)) {
      if (declared.has(key)) continue;
      if (additional === false) return { path: `${path}.${key}`, expected: 'no additional property', received: 'present' };
      if (additional !== null && typeof additional === 'object' && !Array.isArray(additional)) {
        const failure = yield* requestSchema(additional as Record<string, unknown>, objectValue[key], `${path}.${key}`, root, _depth + 1);
        if (failure) return failure;
      }
    }
  }
  return undefined;
}

function resolveLocalSchemaRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split('/')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined;
}

function bestSchemaFailure(failures: readonly (JsonSchemaValidationFailure | undefined)[]): JsonSchemaValidationFailure | undefined {
  return failures
    .filter((failure): failure is JsonSchemaValidationFailure => Boolean(failure))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function readSchemaList(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

function readSchemaTypes(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function valueMatchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return true;
  }
}

function stringMatchesJsonSchemaFormat(value: string, format: string): boolean {
  switch (format) {
    case 'date-time':
      // JSON Schema date-time requires a full date/time separator; Date.parse
      // alone accepts date-only strings in some runtimes.
      return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
        && !Number.isNaN(Date.parse(value));
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
    case 'time':
      return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value);
    case 'duration':
      return /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/.test(value);
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'hostname':
      return isValidHostname(value);
    case 'ipv4':
      return isValidIpv4(value);
    case 'ipv6':
      return isValidIpv6(value);
    case 'uri':
    case 'url':
      return isValidUrl(value);
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    default:
      return true;
  }
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

function isValidIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isValidIpv6(value: string): boolean {
  try {
    new URL(`http://[${value}]`);
    return true;
  } catch {
    return false;
  }
}

function typeOfJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
