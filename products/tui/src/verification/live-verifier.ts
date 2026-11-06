import { writeVerificationReportFiles } from '@goodvibes-jev/engine/terminal-shell/verification-primitives';
import {
  createVerificationPrimitives,
  renderVerificationTables,
  validateDaemonHealth,
  type LiveVerificationStatus,
  type LiveVerificationCheck,
} from '@goodvibes-jev/engine/terminal-shell/verification-primitives';
export type { LiveVerificationStatus, LiveVerificationCheck } from '@goodvibes-jev/engine/terminal-shell/verification-primitives';
const { runCommand, commandCheck, fetchCheck, countStatuses } = createVerificationPrimitives({
  compact,
  error: summarizeError,
  missingBearer: 'No daemon bearer token was available.',
  validateJsonOnNonZero: false,
});
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { auditGoodVibesHome } from '../config/goodvibes-home-audit.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

export interface LiveVerificationOptions {
  homeDir: string;
  binaryPath: string;
  projectRoot: string;
  daemonBaseUrl?: string;
  token?: string;
  strict?: boolean;
}

export interface LiveVerificationReport {
  generatedAt: string;
  homeDir: string;
  binaryPath: string;
  daemonBaseUrl: string;
  strict: boolean;
  checks: LiveVerificationCheck[];
  counts: Record<LiveVerificationStatus, number>;
  ok: boolean;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function redact(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]').replace(/"token"\s*:\s*"[^"]+"/g, '"token":"[redacted]"');
}

function compact(text: string, maxLength = 900): string {
  const trimmed = redact(text.trim());
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 16)}... [truncated]`;
}

function readDaemonToken(homeDir: string): string | undefined {
  if (process.env.GOODVIBES_DAEMON_TOKEN) return process.env.GOODVIBES_DAEMON_TOKEN;
  const tokenPath = join(homeDir, 'daemon', 'operator-tokens.json');
  if (!existsSync(tokenPath)) return undefined;
  try {
    const data = readJsonFile(tokenPath);
    if (data && typeof data === 'object' && typeof (data as { token?: unknown }).token === 'string') {
      return (data as { token: string }).token;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveDaemonBaseUrl(homeDir: string, explicit?: string): string {
  if (explicit) return explicit.replace(/\/+$/, '');
  if (process.env.GOODVIBES_DAEMON_URL) return process.env.GOODVIBES_DAEMON_URL.replace(/\/+$/, '');
  const settingsPath = join(homeDir, 'tui', 'settings.json');
  let port = 3421;
  if (existsSync(settingsPath)) {
    try {
      const settings = readJsonFile(settingsPath);
      const configuredPort = (settings as { controlPlane?: { port?: unknown } })?.controlPlane?.port;
      if (typeof configuredPort === 'number' && Number.isFinite(configuredPort)) port = configuredPort;
    } catch {
      // Keep the default; this verifier should report daemon state, not fail before checks run.
    }
  }
  return `http://127.0.0.1:${port}`;
}

export async function buildLiveVerificationReport(options: LiveVerificationOptions): Promise<LiveVerificationReport> {
  const homeDir = resolve(options.homeDir);
  const projectRoot = resolve(options.projectRoot);
  const binaryPath = resolve(options.binaryPath);
  const daemonBaseUrl = resolveDaemonBaseUrl(homeDir, options.daemonBaseUrl);
  const token = options.token ?? readDaemonToken(homeDir);
  const checks: LiveVerificationCheck[] = [];

  const audit = await auditGoodVibesHome({ homeDir });
  const staleCandidates = audit.settings?.staleCandidates?.length ?? 0;
  checks.push({
    id: 'goodvibes-home-audit',
    title: 'GoodVibes home ownership/settings audit',
    status: audit.findings.length === 0 && staleCandidates === 0 ? 'pass' : 'warn',
    summary:
      audit.findings.length === 0
        ? 'No ownership, stale-setting, or secret-permission findings.'
        : `${audit.findings.length} audit finding(s).`,
    detail:
      audit.findings.length === 0
        ? `${audit.settings?.recognizedKeyCount ?? 0} current schema key(s), ${staleCandidates} stale candidate(s).`
        : audit.findings.map((finding) => `${finding.severity}: ${finding.message}`).join('\n'),
  });

  checks.push({
    id: 'compiled-cli-present',
    title: 'Compiled GoodVibes CLI binary',
    status: existsSync(binaryPath) ? 'pass' : 'fail',
    summary: existsSync(binaryPath) ? `Found ${binaryPath}.` : `Missing ${binaryPath}.`,
  });

  if (existsSync(binaryPath)) {
    checks.push(
      commandCheck(
        'cli-version',
        'CLI version command',
        await runCommand(binaryPath, ['version'], projectRoot),
        'CLI version returned successfully.',
      ),
    );
    checks.push(
      commandCheck(
        'cli-status-json',
        'CLI status JSON command',
        await runCommand(binaryPath, ['status', '--output', 'json'], projectRoot),
        'CLI status returned parseable JSON.',
        { parseJson: true },
      ),
    );
    checks.push(
      commandCheck(
        'cli-providers',
        'CLI providers command',
        await runCommand(binaryPath, ['providers'], projectRoot),
        'Provider inventory rendered successfully.',
      ),
    );
    checks.push(
      commandCheck(
        'cli-control-plane-status',
        'CLI control-plane status command',
        await runCommand(binaryPath, ['control-plane', 'status'], projectRoot),
        'Control-plane status rendered successfully.',
        { warnOnNonZero: true },
      ),
    );
    checks.push(
      commandCheck(
        'cli-listener-test',
        'CLI listener readiness command',
        await runCommand(binaryPath, ['listener', 'test'], projectRoot),
        'HTTP listener readiness rendered successfully.',
        { warnOnNonZero: true },
      ),
    );
    checks.push(
      commandCheck(
        'cli-surfaces-check',
        'CLI surfaces readiness command',
        await runCommand(binaryPath, ['surfaces', 'check'], projectRoot),
        'Surface readiness rendered successfully.',
        { warnOnNonZero: true },
      ),
    );
    checks.push(
      commandCheck(
        'cli-service-check',
        'CLI service posture command',
        await runCommand(binaryPath, ['service', 'check'], projectRoot),
        'Service posture rendered successfully.',
        { warnOnNonZero: true },
      ),
    );
    checks.push(
      commandCheck(
        'cli-doctor',
        'CLI doctor command',
        await runCommand(binaryPath, ['doctor', '--output', 'text'], projectRoot),
        'Doctor completed without findings.',
        { warnOnNonZero: true },
      ),
    );
  }

  checks.push(
    await fetchCheck('daemon-status', 'Authenticated daemon /status', `${daemonBaseUrl}/status`, token, (status, body) => {
      if (status !== 200) return { status: 'fail', summary: `/status returned ${status}.` };
      try {
        const parsed = JSON.parse(body) as { version?: unknown; sdkVersion?: unknown };
        const version =
          typeof parsed.sdkVersion === 'string' ? parsed.sdkVersion : typeof parsed.version === 'string' ? parsed.version : 'unknown';
        return { status: 'pass', summary: `/status returned 200, version ${version}.` };
      } catch {
        return { status: 'warn', summary: '/status returned 200 but was not parseable JSON.' };
      }
    }),
  );

  checks.push(
    await fetchCheck('daemon-health', 'Authenticated daemon /api/health', `${daemonBaseUrl}/api/health`, token, validateDaemonHealth),
  );

  checks.push(
    await fetchCheck(
      'openai-compatible-models',
      'OpenAI-compatible /v1/models route',
      `${daemonBaseUrl}/v1/models`,
      token,
      (status, body) => {
        if (status !== 200) return { status: 'fail', summary: `/v1/models returned ${status}.` };
        try {
          const parsed = JSON.parse(body) as { data?: unknown };
          const models = Array.isArray(parsed.data) ? parsed.data.length : 0;
          return {
            status: models > 0 ? 'pass' : 'warn',
            summary: `/v1/models returned ${models} model(s).`,
          };
        } catch {
          return { status: 'warn', summary: '/v1/models returned 200 but was not parseable JSON.' };
        }
      },
    ),
  );

  const counts = countStatuses(checks);
  const ok = counts.fail === 0 && (!options.strict || counts.warn === 0);
  return {
    generatedAt: new Date().toISOString(),
    homeDir,
    binaryPath,
    daemonBaseUrl,
    strict: options.strict ?? false,
    checks,
    counts,
    ok,
  };
}

export function renderLiveVerificationReportMarkdown(report: LiveVerificationReport): string {
  return renderVerificationTables(
    [
      '# GoodVibes Live Verification',
      '',
      `Generated: ${report.generatedAt}`,
      `Home: \`${report.homeDir}\``,
      `Binary: \`${report.binaryPath}\``,
      `Daemon: \`${report.daemonBaseUrl}\``,
      '',
    ],
    report,
  );
}

export function writeLiveVerificationReportFiles(report: LiveVerificationReport, outputDir: string): void {
  writeVerificationReportFiles(report, outputDir, renderLiveVerificationReportMarkdown);
}
