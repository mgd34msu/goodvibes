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

export function extractNativeHeadlessOptions(argv: readonly string[], grammar: { readonly required?: readonly string[]; readonly optional?: readonly string[] } = {}): { argv: string[]; mode: NativeHeadlessMode; errors: string[] } {
  // The caller passes every value-taking flag of its own catalog, aliases included.
  const required = new Set(grammar.required ?? []);
  const optional = new Set([...optionalValueOptions, ...(grammar.optional ?? [])]);
  const result: string[] = [];
  const errors: string[] = [];
  let mode: NativeHeadlessMode = 'submit';

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      result.push(...argv.slice(i));
      break;
    }
    // Even an invalid, option-shaped operand must survive for the main
    // parser to reject. Stripping it could turn a later positional into the
    // missing value and silently promote the operand into recovery authority.
    // Check the original preceding token, so adjacent missing-value flags are
    // also protected. An inline =value never reserves the following token.
    if (i > 0 && required.has(argv[i - 1]!)) {
      result.push(token);
      continue;
    }

    const action = recovery.get(token);
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
    } else if ([...recovery.keys()].some(flag => token.startsWith(`${flag}=`))) {
      errors.push('Native intake recovery options take no value.');
    } else {
      result.push(token);
    }
  }
  return { argv: result, mode, errors };
}

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
/**
 * Remove `--timeout`, `--max-turns`, `--omit-accumulated` and `--answer-permissions` from argv. `valueOptions`
 * are the product's value-taking options, so `-p --timeout` keeps `--timeout` as the
 * prompt; `--` ends option parsing exactly as it does for the main parser.
 */
export function extractHeadlessRunFlags(argv: readonly string[], valueOptions: ReadonlySet<string>): { argv: string[]; flags: HeadlessRunFlags; errors: string[] } {
  const rest: string[] = [];
  const errors: string[] = [];
  let timeoutMs: number | undefined;
  let maxTurns: number | undefined;
  let omitAccumulated: boolean | undefined;
  let answerPermissions: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (i > 0 && valueOptions.has(argv[i - 1]!)) {
      rest.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = token.startsWith('--') && eq !== -1 ? token.slice(0, eq) : token;
    if (name === '--omit-accumulated') {
      if (eq !== -1) errors.push('--omit-accumulated takes no value.');
      omitAccumulated = true;
      continue;
    }
    if (name === '--answer-permissions') {
      if (eq !== -1) errors.push('--answer-permissions takes no value.');
      answerPermissions = true;
      continue;
    }
    if (name !== '--timeout' && name !== '--max-turns') {
      rest.push(token);
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
  return { argv: rest, flags: { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(maxTurns === undefined ? {} : { maxTurns }), ...(omitAccumulated ? { omitAccumulated } : {}), ...(answerPermissions ? { answerPermissions } : {}) }, errors };
}
/** Options a catalog marks as always taking a value. */
export function catalogValueOptions(catalog: { readonly globalFlags: readonly { readonly tokens: readonly string[]; readonly kind: string }[];
  readonly commands: readonly { readonly flags: readonly { readonly tokens: readonly string[]; readonly kind: string }[] }[] }, extra: readonly string[] = []): ReadonlySet<string> {
  const takesValue = new Set(['string', 'port', 'string-list', 'enum']);
  const specs = [...catalog.globalFlags, ...catalog.commands.flatMap(command => command.flags)];
  return new Set([...specs.filter(spec => takesValue.has(spec.kind)).flatMap(spec => spec.tokens), ...extra]);
}
