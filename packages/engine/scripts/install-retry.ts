/**
 * Retry for the package-install steps of the release scripts (install smoke,
 * artifact lane). npm and bun fetches hit transient connection faults on CI
 * runners; a single blip must not fail a release, and a failure npm names
 * with a non-transient code (a missing package, a bad integrity hash) must
 * not be retried.
 *
 * npm prints the error's `code` field on a fixed `npm error code <CODE>` line
 * (`npm ERR! code` before npm 10), and a spawn failure carries it on the
 * error object; that code decides. With no code the install is simply tried
 * again, up to three attempts, because an install is idempotent.
 */
type CommandError = Error & {
  readonly code?: unknown;
  readonly stderr?: Buffer | string;
  readonly stdout?: Buffer | string;
};

/** The errno codes that name a transient connection fault. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
  'ERR_SOCKET_TIMEOUT',
  // npm prints a registry's HTTP failure as `npm error code E429` or `E503`.
  'E429',
]);

/** A registry 5xx printed by npm as `E500`..`E599`. */
const REGISTRY_SERVER_ERROR = /^E5\d\d$/;

function isTransientCode(code: string): boolean {
  const upper = code.toUpperCase();
  return TRANSIENT_CODES.has(upper) || REGISTRY_SERVER_ERROR.test(upper);
}

function outputText(value: Buffer | string | undefined): string {
  return value === undefined ? '' : value.toString();
}

/**
 * The structured error code of a failed install: the error object's own
 * `code` (a spawn failure), else the code npm printed on its fixed
 * `npm error code <CODE>` line. Null when neither is present.
 */
export function installErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const commandError = error as CommandError;
  if (typeof commandError.code === 'string' && commandError.code.length > 0) return commandError.code;
  const output = `${outputText(commandError.stderr)}\n${outputText(commandError.stdout)}`;
  const line = /^npm (?:error|ERR!) code (\S+)\s*$/m.exec(output);
  return line?.[1] ?? null;
}

/**
 * Whether a failed install is worth another attempt. A coded failure is
 * settled by the errno table: a transient code retries, any other does not.
 * A codeless failure (bun prints prose; npm omits the line for some failures)
 * retries: an install is idempotent, so another attempt within the bounded
 * backoff costs at most seconds and its own output says what went wrong.
 */
export function isTransientInstallFailure(error: unknown): boolean {
  const code = installErrorCode(error);
  return code === null || isTransientCode(code);
}

export interface InstallRetryOptions {
  /** Log prefix, e.g. `install-smoke`. */
  readonly prefix: string;
  /** What the step is, e.g. `npm install`. */
  readonly label: string;
  /** Waits between attempts; defaults to a timer. Tests inject one that returns at once. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const BACKOFF_MS = [0, 2000, 5000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

/**
 * Runs an install step, retrying a transient or codeless failure up to three
 * attempts with backoff. The step should capture its output (stdio 'pipe')
 * so a failure carries the npm code line; the output is echoed either way so
 * the run still shows it, and the last failure is thrown as the install's own.
 */
export async function retryTransientInstall(op: () => string | void, options: InstallRetryOptions): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 1) {
        const delay = BACKOFF_MS[attempt - 1] ?? 5000;
        console.log(`[${options.prefix}] ${options.label}: attempt ${attempt}/${MAX_ATTEMPTS} after ${delay}ms backoff`);
        await (options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(delay);
      }
      const output = op();
      if (typeof output === 'string' && output.trim()) console.log(output.trimEnd());
      return;
    } catch (err) {
      lastErr = err;
      if (err && typeof err === 'object') {
        const stdout = outputText((err as CommandError).stdout).trimEnd();
        const stderr = outputText((err as CommandError).stderr).trimEnd();
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
      }
      if (attempt === MAX_ATTEMPTS) throw err;
      if (!isTransientInstallFailure(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[${options.prefix}] ${options.label}: failed, retrying (${message.slice(0, 200)})`);
    }
  }
  throw lastErr;
}
