/** What a headless invocation asks for, read from the flags the product's CLI catalog parsed. */
export type NativeHeadlessMode = 'submit' | 'status' | 'retry' | 'resume' | 'cancel';

/** `run`-only limits, from the parsed `--timeout`, `--max-turns`, `--omit-accumulated` and `--answer-permissions`. */
export interface HeadlessRunFlags {
  readonly timeoutMs?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly omitAccumulated?: boolean | undefined;
  /** Read owner answers to permission prompts from stdin (stream-json only). */
  readonly answerPermissions?: boolean | undefined;
  /** Read the prompt from this file, or from stdin for `-`. */
  readonly promptFile?: string | undefined;
}

/** The flags of a parsed command line this module reads: the catalogs declare them, one parser fills them. */
export interface HeadlessCliFlags {
  /** Set by `--intake-status|retry|resume|cancel`; the catalog refuses two of them on one line. */
  readonly intakeMode?: Exclude<NativeHeadlessMode, 'submit'> | undefined;
  readonly timeout?: string | undefined;
  readonly maxTurns?: string | undefined;
  readonly omitAccumulated?: boolean | undefined;
  readonly answerPermissions?: boolean | undefined;
  readonly promptFile?: string | undefined;
}

export interface HeadlessInvocation {
  readonly mode: NativeHeadlessMode;
  readonly errors: string[];
  /** Present when any `run` flag was given. */
  readonly run?: HeadlessRunFlags;
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;
const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * The intake mode and `run` limits of one parsed command line. The values are
 * checked here (a positive duration, a positive whole number); where each flag
 * may appear is the catalog parser's.
 */
export function headlessInvocationFromFlags(flags: HeadlessCliFlags): HeadlessInvocation {
  const errors: string[] = [];
  let timeoutMs: number | undefined;
  let maxTurns: number | undefined;
  if (flags.timeout !== undefined) {
    const match = DURATION.exec(flags.timeout);
    const ms = match ? Number(match[1]) * UNIT_MS[match[2] ?? 's']! : NaN;
    if (Number.isFinite(ms) && ms >= 1) timeoutMs = Math.round(ms);
    else errors.push(`--timeout expects a positive duration such as 90, 90s, 5m or 1h, not "${flags.timeout}".`);
  }
  if (flags.maxTurns !== undefined) {
    const turns = /^\d+$/.test(flags.maxTurns) ? Number(flags.maxTurns) : NaN;
    if (Number.isSafeInteger(turns) && turns >= 1) maxTurns = turns;
    else errors.push(`--max-turns expects a positive whole number, not "${flags.maxTurns}".`);
  }
  const run: HeadlessRunFlags = {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(flags.omitAccumulated ? { omitAccumulated: true } : {}),
    ...(flags.answerPermissions ? { answerPermissions: true } : {}),
    ...(flags.promptFile !== undefined ? { promptFile: flags.promptFile } : {}),
  };
  return { mode: flags.intakeMode ?? 'submit', errors, ...(Object.keys(run).length ? { run } : {}) };
}
