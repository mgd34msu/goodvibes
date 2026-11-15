import { describe, expect, it } from 'bun:test';
import type { LiveVerificationReport } from '../../verification/live-verifier.ts';
import { homeAuditCheck, renderLiveVerificationReportMarkdown, verificationCommandEnv } from '../../verification/live-verifier.ts';

describe('live verification report', () => {
  it('renders summary counts and check rows', () => {
    const report: LiveVerificationReport = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      homeDir: '/tmp/goodvibes',
      binaryPath: '/repo/dist/goodvibes',
      daemonBaseUrl: 'http://127.0.0.1:3421',
      strict: false,
      counts: { pass: 2, warn: 1, fail: 0, skip: 0 },
      ok: true,
      checks: [
        {
          id: 'ledger',
          title: 'Verification inventory ledger',
          status: 'pass',
          summary: '100% local verification signal.',
        },
        {
          id: 'surface',
          title: 'CLI surfaces readiness command',
          status: 'warn',
          summary: 'Web surface is not reachable.',
          detail: 'web enabled but not reachable on 0.0.0.0:3423',
        },
      ],
    };

    const markdown = renderLiveVerificationReportMarkdown(report);

    expect(markdown).toContain('| pass | 2 |');
    expect(markdown).toContain('| CLI surfaces readiness command | warn | Web surface is not reachable. |');
    expect(markdown).toContain('web enabled but not reachable');
    expect(markdown).toContain('Result: PASS');
  });
});

describe('live verification home handling', () => {
  it('points the CLI commands at the tree root of an explicit .goodvibes home', () => {
    expect(verificationCommandEnv('/x/.goodvibes', {}).GOODVIBES_HOME).toBe('/x');
    expect(verificationCommandEnv('/x/custom-home', {}).GOODVIBES_HOME).toBe('/x/custom-home');
  });

  it('says so in the summary when the audit warns only because of stale settings', () => {
    const audit = { findings: [], settings: { staleCandidates: ['a', 'b'], recognizedKeyCount: 5 } } as unknown as Parameters<typeof homeAuditCheck>[0];
    const check = homeAuditCheck(audit);
    expect(check.status).toBe('warn');
    expect(check.summary).toContain('2 stale setting candidate(s)');
    expect(check.summary).not.toContain('No ownership');
  });

  it('reports a clean audit as a pass with the no-findings summary', () => {
    const audit = { findings: [], settings: { staleCandidates: [], recognizedKeyCount: 5 } } as unknown as Parameters<typeof homeAuditCheck>[0];
    const check = homeAuditCheck(audit);
    expect(check.status).toBe('pass');
    expect(check.summary).toContain('No ownership');
  });
});
