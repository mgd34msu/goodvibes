import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { operatorTokenPath } from '@goodvibes/engine/platform/platform/pairing/companion-token';
import { parseDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { isThisMachineHost } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';
import { bindCredential, daemonAuthHeaders, daemonTarget, type BoundCredentialSource, type DaemonTarget } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target';
export type LiveVerificationStatus = 'pass' | 'warn' | 'fail' | 'skip';
export interface LiveVerificationCheck {
  id: string;
  title: string;
  status: LiveVerificationStatus;
  summary: string;
  detail?: string | undefined;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** stdout passed the capture limit, so only its start is in `stdout`. */
  truncated?: boolean | undefined;
}
/** Bytes kept per stream: bounds memory for a probe that floods its output; parsed JSON fits well under it. */
const MAX_CAPTURED_STREAM_BYTES = 8 * 1024 * 1024;

function capturingSink(): { readonly push: (chunk: Buffer) => void; readonly text: () => string; readonly truncated: () => boolean } {
  const chunks: Buffer[] = [];
  let size = 0;
  let dropped = false;
  return {
    push(chunk) {
      if (size + chunk.length > MAX_CAPTURED_STREAM_BYTES) dropped = true;
      if (size >= MAX_CAPTURED_STREAM_BYTES) return;
      const kept = chunk.length > MAX_CAPTURED_STREAM_BYTES - size ? chunk.subarray(0, MAX_CAPTURED_STREAM_BYTES - size) : chunk;
      chunks.push(kept);
      size += kept.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => dropped,
  };
}

export function createVerificationPrimitives(policy: {
  readonly compact: (text: string, maxLength?: number | undefined) => string;
  readonly error: (error: unknown) => string;
  readonly missingBearer: string;
  readonly validateJsonOnNonZero: boolean;
}) {
  const compact = policy.compact;
  function runCommand(
    command: string,
    args: string[],
    cwd: string,
    options:
      | number
      | {
          readonly env?: NodeJS.ProcessEnv | undefined;
          readonly timeoutMs?: number | undefined;
        } = {},
  ): Promise<CommandResult> {
    const settings = typeof options === 'number' ? { timeoutMs: options } : options;
    return new Promise((resolveCommand) => {
      const child = spawn(command, args, {
        cwd,
        env: settings.env ?? { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = capturingSink();
      const stderr = capturingSink();
      let timedOut = false;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      // A grandchild that inherited the pipes can keep them open after the child is gone, so
      // 'close' may never fire. Whatever path ends the probe, resolve once with what was captured.
      const settle = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (graceTimer) clearTimeout(graceTimer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolveCommand({
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut,
          truncated: stdout.truncated(),
        });
      };
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => {
          child.kill('SIGKILL');
          settle(child.exitCode);
        }, 1000);
      }, settings.timeoutMs ?? 15000);
      child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (graceTimer) clearTimeout(graceTimer);
        resolveCommand({
          exitCode: -1,
          stdout: '',
          stderr: policy.error(error),
          timedOut,
        });
      });
      // 'close' fires after the stdio streams end; 'exit' can fire while output is still unread,
      // so after 'exit' the streams get a short grace to drain before the probe resolves anyway.
      child.on('exit', (exitCode) => {
        if (settled) return;
        if (timeout) clearTimeout(timeout);
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = setTimeout(() => settle(exitCode), 1000);
      });
      child.on('close', (exitCode) => settle(exitCode));
    });
  }
  function commandCheck(
    id: string,
    title: string,
    result: CommandResult,
    passSummary: string,
    options?:
      | {
          warnOnNonZero?: boolean | undefined;
          parseJson?: boolean | undefined;
          passDetail?: string | undefined;
        }
      | undefined,
  ): LiveVerificationCheck {
    const parseJsonOutput = (): string | null => {
      if (result.truncated) return `Output passed the ${MAX_CAPTURED_STREAM_BYTES / (1024 * 1024)} MiB capture limit, so only its start was kept and it cannot be read as JSON.`;
      try {
        JSON.parse(result.stdout);
        return null;
      } catch (error) {
        return policy.error(error);
      }
    };
    if (result.timedOut) {
      return {
        id,
        title,
        status: options?.warnOnNonZero ? 'warn' : 'fail',
        summary: 'Command timed out.',
        detail: compact(`${result.stdout}\n${result.stderr}`),
      };
    }
    if (result.exitCode !== 0) {
      if (policy.validateJsonOnNonZero && options?.parseJson) {
        const parseError = parseJsonOutput();
        if (parseError !== null) {
          return {
            id,
            title,
            status: 'fail',
            summary: `Command exited ${result.exitCode} and did not return valid JSON.`,
            detail: compact(`${result.stdout}\n${result.stderr}\n${parseError}`),
          };
        }
      }
      return {
        id,
        title,
        status: options?.warnOnNonZero ? 'warn' : 'fail',
        summary: `Command exited ${result.exitCode}.`,
        detail: compact(`${result.stdout}\n${result.stderr}`),
      };
    }
    if (options?.parseJson) {
      const parseError = parseJsonOutput();
      if (parseError !== null) {
        return {
          id,
          title,
          status: 'fail',
          summary: 'Command succeeded but did not return valid JSON.',
          detail: parseError,
        };
      }
    }
    return {
      id,
      title,
      status: 'pass',
      summary: passSummary,
      detail: options?.passDetail ?? compact(result.stdout || result.stderr),
    };
  }
  async function fetchCheck(
    id: string,
    title: string,
    url: string,
    target: DaemonTarget,
    validate: (
      status: number,
      body: string,
    ) => {
      status: LiveVerificationStatus;
      summary: string;
      detail?: string | undefined;
    },
  ): Promise<LiveVerificationCheck> {
    if (!target.credential) {
      return {
        id,
        title,
        status: 'skip',
        summary: target.thisMachine ? policy.missingBearer
          : `${policy.missingBearer} No token is held for ${target.origin.baseUrl}; this machine's daemon token is never sent to another daemon (pass its own token).`,
      };
    }
    try {
      // The one header builder: refuses a URL on any origin but the target's.
      const response = await fetch(url, {
        headers: daemonAuthHeaders(target, url),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.text();
      const validated = validate(response.status, body);
      return {
        id,
        title,
        ...validated,
        detail: validated.detail ?? compact(body),
      };
    } catch (error) {
      return {
        id,
        title,
        status: 'fail',
        summary: 'Request failed.',
        detail: policy.error(error),
      };
    }
  }
  function countStatuses(checks: readonly LiveVerificationCheck[]): Record<LiveVerificationStatus, number> {
    return checks.reduce<Record<LiveVerificationStatus, number>>(
      (counts, check) => {
        counts[check.status] += 1;
        return counts;
      },
      { pass: 0, warn: 0, fail: 0, skip: 0 },
    );
  }
  return { runCommand, commandCheck, fetchCheck, countStatuses };
}
export function renderVerificationTables(
  header: readonly string[],
  report: {
    readonly checks: readonly LiveVerificationCheck[];
    readonly counts: Record<LiveVerificationStatus, number>;
    readonly ok: boolean;
  },
): string {
  const lines: string[] = [
    ...header,
    '| Status | Count |',
    '|---|---:|',
    `| pass | ${report.counts.pass} |`,
    `| warn | ${report.counts.warn} |`,
    `| fail | ${report.counts.fail} |`,
    `| skip | ${report.counts.skip} |`,
    '',
    '| Check | Status | Summary |',
    '|---|---|---|',
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.title} | ${check.status} | ${check.summary.replace(/\|/g, '\\|')} |`);
  }
  const detailed = report.checks.filter((check) => check.detail?.trim());
  if (detailed.length > 0) {
    lines.push('', '## Details', '');
    for (const check of detailed) {
      lines.push(`### ${check.title}`, '', '```text', check.detail?.trim() ?? '', '```', '');
    }
  }
  lines.push(report.ok ? 'Result: PASS' : 'Result: FAIL', '');
  return lines.join('\n');
}
export function validateDaemonHealth(status: number, body: string): Pick<LiveVerificationCheck, 'status' | 'summary'> {
  if (status !== 200) return { status: 'fail', summary: `/api/health returned ${status}.` };
  try {
    const parsed = JSON.parse(body) as {
      overall?: unknown | undefined;
    };
    return { status: parsed.overall === 'healthy' ? 'pass' : 'warn', summary: `Health overall=${String(parsed.overall ?? 'unknown')}.` };
  } catch {
    return { status: 'warn', summary: '/api/health returned 200 but was not parseable JSON.' };
  }
}

/** The caller supplies the prepared report and its product-specific heading. */
export function writeVerificationReportFiles<Report>(report: Report, outputDir: string, markdown: (report: Report) => string): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'live-verification.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(join(outputDir, 'live-verification.md'), markdown(report), 'utf8');
}

/**
 * The daemon home a verifier of the `.goodvibes` tree `homeDir` reads: the tree's
 * own `daemon` directory, unless GOODVIBES_DAEMON_HOME relocates it, which
 * `resolveGoodVibesDaemonHome` resolves exactly as the daemon does.
 */
export function verificationDaemonHome(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env['GOODVIBES_DAEMON_HOME']?.trim() ? resolveGoodVibesDaemonHome(homeDir, env) : join(homeDir, 'daemon');
}

function readLocalOperatorToken(tokenPath: string, readJson: (path: string) => unknown): string | undefined {
  if (!existsSync(tokenPath)) return undefined;
  try {
    const data = readJson(tokenPath);
    if (data && typeof data === 'object' && 'token' in data && typeof data.token === 'string') return data.token;
  } catch {
    return undefined;
  }
  return undefined;
}

/** The control-plane port the product's own settings file names, else 3421. */
function verificationLocalPort(settingsPath: string, readJson: (path: string) => unknown): number {
  if (!existsSync(settingsPath)) return 3421;
  try {
    const value = (readJson(settingsPath) as { controlPlane?: { port?: unknown } })?.controlPlane?.port;
    return typeof value === 'number' && Number.isFinite(value) ? value : 3421;
  } catch {
    return 3421;
  }
}

export interface VerificationHostTargetInput {
  readonly homeDir: string;
  /** The daemon URL the run checks (see {@link resolveVerificationHostUrl}). */
  readonly url: string;
  /** A token the person passed for this run: bound to `url`'s origin. */
  readonly explicitToken?: string | undefined;
  /** Environment variables holding a token the person set for the host being checked (the connected host). */
  readonly hostEnvKeys?: readonly string[] | undefined;
  /** Environment variables holding this machine's daemon token (GOODVIBES_DAEMON_TOKEN). */
  readonly localEnvKeys?: readonly string[] | undefined;
  readonly readJson: (path: string) => unknown;
  /** The product's own settings file, whose `controlPlane.port` is this machine's daemon port. */
  readonly settingsPath?: string | undefined;
  /** Overrides the operator token file of the daemon home (see verificationDaemonHome). */
  readonly tokenPath?: string | undefined;
}

/**
 * The daemon a verification run talks to and the credential bound to it: a
 * token passed or set for the host being checked goes to that host; this
 * machine's daemon token (its environment override or the operator token
 * file) only when the URL is this machine's daemon, a local address at the
 * port the settings name. Any other daemon gets no credential, so its checks
 * are skipped instead of carrying this machine's token there.
 */
export function verificationHostTarget(input: VerificationHostTargetInput): DaemonTarget {
  let origin: ReturnType<typeof parseDaemonOrigin> = null;
  try { origin = parseDaemonOrigin(new URL(input.url).origin); } catch { origin = null; }
  if (!origin) throw new TypeError(`${input.url} is not a daemon address (scheme://host:port).`);
  const thisMachine = isThisMachineHost(origin.host)
    && origin.port === verificationLocalPort(input.settingsPath ?? join(input.homeDir, 'tui', 'settings.json'), input.readJson);
  const bound = (token: string, source: BoundCredentialSource): DaemonTarget => daemonTarget(origin!, bindCredential(origin!, token, source), thisMachine);
  if (input.explicitToken?.trim()) return bound(input.explicitToken, 'explicit');
  for (const key of input.hostEnvKeys ?? []) {
    const value = process.env[key]?.trim();
    if (value) return bound(value, 'environment');
  }
  if (!thisMachine) return daemonTarget(origin, null, false);
  for (const key of input.localEnvKeys ?? []) {
    const value = process.env[key]?.trim();
    if (value) return bound(value, 'environment');
  }
  const local = readLocalOperatorToken(input.tokenPath ?? operatorTokenPath(verificationDaemonHome(input.homeDir)), input.readJson);
  return local ? bound(local, 'local-daemon') : daemonTarget(origin, null, true);
}
/** `settingsPath` is the calling product's own settings file; it defaults to the terminal product's. */
export function resolveVerificationHostUrl(
  homeDir: string,
  explicit: string | undefined,
  envKeys: readonly string[],
  readJson: (path: string) => unknown,
  settingsPath: string = join(homeDir, 'tui', 'settings.json'),
): string {
  if (explicit) return explicit.replace(/\/+$/, '');
  for (const key of envKeys) {
    const value = process.env[key];
    if (value) return value.replace(/\/+$/, '');
  }
  let port = 3421;
  if (existsSync(settingsPath)) {
    try {
      const settings = readJson(settingsPath);
      const value = (settings as { controlPlane?: { port?: unknown } })?.controlPlane?.port;
      if (typeof value === 'number' && Number.isFinite(value)) port = value;
    } catch {
      /* Discovery reports host state even when legacy settings are unreadable. */
    }
  }
  return `http://127.0.0.1:${port}`;
}

export function createVerificationCompactor(redact: (text: string) => string) {
  return (text: string, maxLength = 900): string => {
    const trimmed = redact(text.trim());
    return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 16)}... [truncated]`;
  };
}
