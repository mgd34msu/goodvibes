/** Inspect original argv, never flattened commandArgs: -- ends option authority. */
export type NativeHeadlessMode = 'submit' | 'status' | 'retry' | 'resume' | 'cancel';

const recovery = new Map<string, NativeHeadlessMode>([
  ['--intake-status', 'status'],
  ['--intake-retry', 'retry'],
  ['--intake-resume', 'resume'],
  ['--intake-cancel', 'cancel'],
]);

// These flags consume only following tokens that do not start with a dash.
const optionalValueOptions = new Set(['--resume', '-r']);

/** `run`-only flags, parsed before the product's CLI parser sees argv. */
export interface HeadlessRunFlags {
  readonly timeoutMs?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly omitAccumulated?: boolean | undefined;
  /** Read owner answers to permission prompts from stdin (stream-json only). */
  readonly answerPermissions?: boolean | undefined;
}
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;
const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export interface HeadlessInvocation {
  readonly argv: string[];
  readonly mode: NativeHeadlessMode;
  readonly errors: string[];
  /** Present when any `run` flag was given. */
  readonly run?: HeadlessRunFlags;
}

/**
 * One walk over argv that removes the headless-only options (`--intake-*`, `--timeout`,
 * `--max-turns`, `--omit-accumulated`, `--answer-permissions`) with one set of rules for
 * `--`, `=value` and "the previous token takes a value". `valueOptions` are every
 * value-taking flag of the product's catalog, aliases included; `optional` are flags whose
 * value is optional.
 */
export function extractHeadlessInvocation(
  argv: readonly string[],
  grammar: { readonly valueOptions: Iterable<string>; readonly optional?: readonly string[] | undefined; readonly intake?: boolean; readonly run?: boolean },
): HeadlessInvocation {
  const required = new Set(grammar.valueOptions);
  const optional = new Set([...optionalValueOptions, ...(grammar.optional ?? [])]);
  const intake = grammar.intake !== false;
  const runFlags = grammar.run !== false;
  const result: string[] = [];
  const errors: string[] = [];
  let mode: NativeHeadlessMode = 'submit';
  let timeoutMs: number | undefined;
  let maxTurns: number | undefined;
  let omitAccumulated: boolean | undefined;
  let answerPermissions: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      result.push(...argv.slice(i));
      break;
    }
    // A value of the previous option is kept as it is, even when it looks like an
    // option: stripping it could turn a later positional into the missing value
    // (and promote an operand into recovery authority). An inline =value never
    // reserves the following token.
    if (i > 0 && required.has(argv[i - 1]!)) {
      result.push(token);
      continue;
    }
    const action = intake ? recovery.get(token) : undefined;
    if (action) {
      const previous = argv[i - 1];
      const next = argv[i + 1];
      // Removing this option must not let an optional flag swallow a token
      // that was originally positional (including an empty string).
      if (previous !== undefined && optional.has(previous) && next !== undefined && !next.startsWith('-')) {
        errors.push(`Native intake recovery after ${previous} would change its optional value. Use an inline ${previous}=value or move the recovery option.`);
        result.push(token);
        continue;
      }
      if (mode !== 'submit') errors.push('Choose exactly one native intake recovery option.');
      mode = action;
      continue;
    }
    if (intake && [...recovery.keys()].some(flag => token.startsWith(`${flag}=`))) {
      errors.push('Native intake recovery options take no value.');
      continue;
    }
    const eq = token.indexOf('=');
    const name = runFlags && token.startsWith('--') && eq !== -1 ? token.slice(0, eq) : token;
    if (runFlags && name === '--omit-accumulated') {
      if (eq !== -1) errors.push('--omit-accumulated takes no value.');
      omitAccumulated = true;
      continue;
    }
    if (runFlags && name === '--answer-permissions') {
      if (eq !== -1) errors.push('--answer-permissions takes no value.');
      answerPermissions = true;
      continue;
    }
    if (!runFlags || (name !== '--timeout' && name !== '--max-turns')) {
      result.push(token);
      continue;
    }
    const value = eq !== -1 ? token.slice(eq + 1) : argv[++i];
    if (name === '--timeout') {
      const match = value === undefined ? null : DURATION.exec(value);
      const ms = match ? Number(match[1]) * UNIT_MS[match[2] ?? 's']! : NaN;
      if (Number.isFinite(ms) && ms >= 1) timeoutMs = Math.round(ms);
      else errors.push(`--timeout expects a positive duration such as 90, 90s, 5m or 1h${value === undefined ? '' : `, not "${value}"`}.`);
    } else {
      const turns = value === undefined || !/^\d+$/.test(value) ? NaN : Number(value);
      if (Number.isSafeInteger(turns) && turns >= 1) maxTurns = turns;
      else errors.push(`--max-turns expects a positive whole number${value === undefined ? '' : `, not "${value}"`}.`);
    }
  }
  const run: HeadlessRunFlags = { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(maxTurns === undefined ? {} : { maxTurns }), ...(omitAccumulated ? { omitAccumulated } : {}), ...(answerPermissions ? { answerPermissions } : {}) };
  return { argv: result, mode, errors, ...(Object.keys(run).length ? { run } : {}) };
}

/** The `--intake-*` part of {@link extractHeadlessInvocation} alone. */
export function extractNativeHeadlessOptions(argv: readonly string[], grammar: { readonly required?: readonly string[]; readonly optional?: readonly string[] } = {}): { argv: string[]; mode: NativeHeadlessMode; errors: string[] } {
  const { argv: rest, mode, errors } = extractHeadlessInvocation(argv, { valueOptions: grammar.required ?? [], optional: grammar.optional, run: false });
  return { argv: rest, mode, errors };
}

/** The `run` flags part of {@link extractHeadlessInvocation} alone. */
export function extractHeadlessRunFlags(argv: readonly string[], valueOptions: ReadonlySet<string>): { argv: string[]; flags: HeadlessRunFlags; errors: string[] } {
  const { argv: rest, errors, run } = extractHeadlessInvocation(argv, { valueOptions, intake: false });
  return { argv: rest, flags: run ?? {}, errors };
}
/** Options a catalog marks as always taking a value. */
export function catalogValueOptions(catalog: { readonly globalFlags: readonly { readonly tokens: readonly string[]; readonly kind: string }[];
  readonly commands: readonly { readonly flags: readonly { readonly tokens: readonly string[]; readonly kind: string }[] }[] }, extra: readonly string[] = []): ReadonlySet<string> {
  const takesValue = new Set(['string', 'port', 'string-list', 'enum']);
  const specs = [...catalog.globalFlags, ...catalog.commands.flatMap(command => command.flags)];
  return new Set([...specs.filter(spec => takesValue.has(spec.kind)).flatMap(spec => spec.tokens), ...extra]);
}
