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

const QUANTIFIER = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/;

/**
 * True when a regular expression cannot backtrack without bound: no
 * backreference or lookaround, at most one unbounded repeat, and every group
 * repeated more than once has a fixed width with no alternation. A group made
 * optional with `?` may have any width. This admits every pattern the shipped
 * contracts use (fixed-width ids, `\S`, bounded runs, one trailing `+`) and
 * refuses nested or overlapping repetition such as `(a+)+` or `(a|aa)*`.
 */
export function isLinearSchemaPattern(source: string): boolean {
  interface Frame { variable: boolean; alternation: boolean }
  const frames: Frame[] = [{ variable: false, alternation: false }];
  let last: 'atom' | Frame | null = null;
  let unbounded = 0;
  let index = 0;
  const markVariable = () => { for (const frame of frames) frame.variable = true; };
  while (index < source.length) {
    const char = source[index]!;
    if (char === '\\') {
      const escaped = source[index + 1] ?? '';
      if (/[1-9k]/.test(escaped)) return false;
      index += 2;
      last = 'atom';
      continue;
    }
    if (char === '[') {
      index += 1;
      if (source[index] === '^') index += 1;
      if (source[index] === ']') index += 1;
      while (index < source.length && source[index] !== ']') index += source[index] === '\\' ? 2 : 1;
      index += 1;
      last = 'atom';
      continue;
    }
    if (char === '(') {
      if (/^\(\?<?[=!]/.test(source.slice(index, index + 4))) return false;
      frames.push({ variable: false, alternation: false });
      const named = /^\(\?(?::|<[^>]*>)/.exec(source.slice(index));
      index += named ? named[0].length : 1;
      last = null;
      continue;
    }
    if (char === ')') {
      if (frames.length < 2) return false;
      const frame = frames.pop()!;
      if (frame.variable || frame.alternation) markVariable();
      index += 1;
      last = frame;
      continue;
    }
    if (char === '|') {
      frames[frames.length - 1]!.alternation = true;
      index += 1;
      last = null;
      continue;
    }
    const quantifier = QUANTIFIER.exec(source.slice(index));
    if (quantifier && last !== null) {
      const [, symbol, min, comma, max] = quantifier;
      const upper = symbol === '?' ? 1 : symbol ? Infinity : comma === undefined ? Number(min) : max ? Number(max) : Infinity;
      const lower = symbol === '+' ? 1 : symbol ? 0 : Number(min);
      if (last !== 'atom' && upper > 1 && (last.variable || last.alternation)) return false;
      if (upper === Infinity && ++unbounded > 1) return false;
      if (upper !== lower) markVariable();
      index += quantifier[0].length;
      last = null;
      continue;
    }
    index += 1;
    last = 'atom';
  }
  return frames.length === 1;
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
