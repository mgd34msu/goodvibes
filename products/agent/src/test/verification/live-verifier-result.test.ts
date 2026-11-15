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

  /**
   * A two-space knowledge host. Ingest stores a probe in the space its route
   * names; Agent search returns the Agent space's rows, plus the default
   * space's rows when `crossed` is set. Every other route answers with text
   * that must not reach the release artifact.
   */
  function stubKnowledgeHost(options: { readonly crossed: boolean; readonly bodyMarker: string }) {
    const spaces: Record<'agent' | 'default', { id: string; title: string }[]> = { agent: [], default: [] };
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const space = url.pathname.startsWith('/api/goodvibes-agent/knowledge') ? 'agent' : 'default';
      if (url.pathname.endsWith('/ingest/artifact')) {
        const title = String((init?.body as FormData).get('title'));
        const source = { id: `src-${space}-${spaces[space].length + 1}`, title };
        spaces[space].push(source);
        return Response.json({ source, issues: [] }, { status: 201 });
      }
      if (space === 'agent' && url.pathname.endsWith('/search')) {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        const visible = options.crossed ? [...spaces.agent, ...spaces.default] : spaces.agent;
        return Response.json({ results: visible.filter((source) => source.title === query).map((source) => ({ kind: 'source', id: source.id, source })) });
      }
      return Response.json({ answer: options.bodyMarker, sources: [options.bodyMarker] });
    }) as never;
  }

  it('passes the isolation check only when the Agent route keeps the default space out', async () => {
    const root = makeProjectTempDir('goodvibes-live-verifier-knowledge');
    try {
      const bodyMarker = 'KNOWLEDGE-BODY-MARKER-7f3a';
      const options = { homeDir: join(root, 'home'), binaryPath: passingBinary(root), projectRoot, token: 'token-for-verifier-test' };
      spies.push(spyOn(globalThis, 'fetch').mockImplementation(stubKnowledgeHost({ crossed: false, bodyMarker })));
      const split = await buildLiveVerificationReport(options);
      for (const check of split.checks.filter((entry) => entry.id.startsWith('agent-knowledge-'))) {
        expect(check.status).toBe('pass');
        expect(JSON.stringify(check)).not.toContain(bodyMarker);
      }

      spies.splice(0).forEach((spy) => spy.mockRestore());
      spies.push(spyOn(globalThis, 'fetch').mockImplementation(stubKnowledgeHost({ crossed: true, bodyMarker })));
      const crossed = await buildLiveVerificationReport(options);
      expect(crossed.checks.find((check) => check.id === 'agent-knowledge-search-isolated')?.status).toBe('fail');
      expect(crossed.ok).toBe(false);
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
