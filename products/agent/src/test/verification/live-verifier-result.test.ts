import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { homedir } from 'node:os';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildLiveVerificationReport } from '../../verification/live-verifier.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const projectRoot = resolve(join(import.meta.dir, '..', '..', '..'));

interface FakeAgentBinaryOptions {
  readonly statusOutput?: string;
  readonly compatOutput: string;
  readonly compatExitCode: number;
  readonly knowledgeOutput: string;
  readonly knowledgeExitCode: number;
  readonly providersOutput?: string;
  readonly doctorOutput?: string;
  readonly doctorExitCode?: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeFakeAgentBinary(root: string, options: FakeAgentBinaryOptions): string {
  const binaryPath = join(root, 'goodvibes-agent-fake');
  const script = [
    '#!/usr/bin/env bash',
    'set -eu',
    'normalized=()',
    'while (($# > 0)); do',
    '  case "$1" in',
    '    --runtime-url|--runtime)',
    '      shift',
    '      if (($# > 0)); then shift; fi',
    '      ;;',
    '    --runtime-url=*|--runtime=*)',
    '      shift',
    '      ;;',
    '    *)',
    '      normalized+=("$1")',
    '      shift',
    '      ;;',
    '  esac',
    'done',
    'set -- "${normalized[@]}"',
    'case "$*" in',
    '  "--version") printf "%s\\n" "0.0.0"; exit 0 ;;',
    `  "status --json") printf "%s\\n" ${shellQuote(options.statusOutput ?? '{"ok":true}')}; exit 0 ;;`,
    `  "compat --json") printf "%s\\n" ${shellQuote(options.compatOutput)}; exit ${options.compatExitCode} ;;`,
    `  "knowledge status --json") printf "%s\\n" ${shellQuote(options.knowledgeOutput)}; exit ${options.knowledgeExitCode} ;;`,
    `  "providers") printf "%s\\n" ${shellQuote(options.providersOutput ?? 'provider inventory')}; exit 0 ;;`,
    `  "doctor --output text") printf "%s\\n" ${shellQuote(options.doctorOutput ?? 'doctor ok')}; exit ${options.doctorExitCode ?? 0} ;;`,
    'esac',
    'printf "unexpected command: %s\\n" "$*" >&2',
    'exit 64',
    '',
  ].join('\n');
  writeFileSync(binaryPath, script, 'utf8');
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}


afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
const spies: { mockRestore(): void }[] = [];

const passingBinary = (root: string) => writeFakeAgentBinary(root, {
  compatOutput: '{"compatible":true}', compatExitCode: 0, knowledgeOutput: '{"status":"ready"}', knowledgeExitCode: 0,
});

describe('live verification result', () => {
  it('strict mode does not pass when checks were skipped for lack of a token', async () => {
    const root = makeProjectTempDir('goodvibes-live-verifier-strict');
    try {
      const options = { homeDir: join(root, 'home'), binaryPath: passingBinary(root), projectRoot };
      const lenient = await buildLiveVerificationReport(options);
      const strict = await buildLiveVerificationReport({ ...options, strict: true });
      expect(strict.counts.skip).toBeGreaterThan(0);
      expect(strict.counts.fail).toBe(0);
      expect(strict.counts.warn).toBe(0);
      expect(lenient.ok).toBe(true);
      expect(strict.ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps the knowledge response text out of the release artifact when the isolation checks pass', async () => {
    const root = makeProjectTempDir('goodvibes-live-verifier-knowledge');
    try {
      const marker = 'KNOWLEDGE-BODY-MARKER-7f3a';
      spies.push(spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(JSON.stringify({ answer: marker, sources: [marker] }), { status: 200 })) as never));
      const report = await buildLiveVerificationReport({ homeDir: join(root, 'home'), binaryPath: passingBinary(root), projectRoot, token: 'token-for-verifier-test' });
      const knowledge = report.checks.filter((check) => check.id.startsWith('agent-knowledge-'));
      expect(knowledge.length).toBeGreaterThan(0);
      for (const check of knowledge) {
        expect(check.status).toBe('pass');
        expect(JSON.stringify(check)).not.toContain(marker);
        expect(check.detail).toContain('omitted from release artifact');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('masks the account home directory even when it is not the parent of the verified home', async () => {
    const root = makeProjectTempDir('goodvibes-live-verifier-home');
    try {
      const binaryPath = writeFakeAgentBinary(root, {
        compatOutput: `broken output at ${homedir()}/.cache/private-file`, compatExitCode: 2, knowledgeOutput: '{}', knowledgeExitCode: 0,
      });
      const report = await buildLiveVerificationReport({ homeDir: join(root, 'home'), binaryPath, projectRoot });
      const compat = report.checks.find((check) => check.id === 'cli-compat-json')!;
      expect(compat.detail).toContain('[home]/.cache/private-file');
      expect(compat.detail).not.toContain(homedir());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('says how many risk advisories the doctor run noted instead of "without findings"', async () => {
    const root = makeProjectTempDir('goodvibes-live-verifier-doctor');
    try {
      const binaryPath = writeFakeAgentBinary(root, {
        compatOutput: '{"compatible":true}', compatExitCode: 0, knowledgeOutput: '{}', knowledgeExitCode: 0,
        doctorOutput: ['Warnings', '  - [risk:security:auto-approve-enabled] Auto-approve is on.'].join('\n'),
        doctorExitCode: 1,
      });
      const report = await buildLiveVerificationReport({ homeDir: join(root, 'home'), binaryPath, projectRoot });
      const doctor = report.checks.find((check) => check.id === 'cli-doctor')!;
      expect(doctor.status).toBe('pass');
      expect(doctor.detail).toContain('1 operator-configuration risk advisory');
      expect(doctor.detail).not.toContain('without findings');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
