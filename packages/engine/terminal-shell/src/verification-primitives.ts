import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      }, settings.timeoutMs ?? 15000);
      child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
      child.on('error', (error) => {
        clearTimeout(timeout);
        resolveCommand({
          exitCode: -1,
          stdout: '',
          stderr: policy.error(error),
          timedOut,
        });
      });
      child.on('exit', (exitCode) => {
        clearTimeout(timeout);
        resolveCommand({
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
        });
      });
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
    token: string | undefined,
    validate: (
      status: number,
      body: string,
    ) => {
      status: LiveVerificationStatus;
      summary: string;
      detail?: string | undefined;
    },
  ): Promise<LiveVerificationCheck> {
    if (!token) {
      return {
        id,
        title,
        status: 'skip',
        summary: policy.missingBearer,
      };
    }
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
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

/** Read-only verifier discovery. Product-specific environment precedence is supplied explicitly. */
export function readVerificationHostToken(
  homeDir: string,
  envKeys: readonly string[],
  readJson: (path: string) => unknown,
): string | undefined {
  for (const key of envKeys) if (process.env[key]) return process.env[key];
  const tokenPath = join(homeDir, 'daemon', 'operator-tokens.json');
  if (!existsSync(tokenPath)) return undefined;
  try {
    const data = readJson(tokenPath);
    if (data && typeof data === 'object' && 'token' in data && typeof data.token === 'string') return data.token;
  } catch {
    return undefined;
  }
  return undefined;
}
export function resolveVerificationHostUrl(
  homeDir: string,
  explicit: string | undefined,
  envKeys: readonly string[],
  readJson: (path: string) => unknown,
): string {
  if (explicit) return explicit.replace(/\/+$/, '');
  for (const key of envKeys) {
    const value = process.env[key];
    if (value) return value.replace(/\/+$/, '');
  }
  const settingsPath = join(homeDir, 'tui', 'settings.json');
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
