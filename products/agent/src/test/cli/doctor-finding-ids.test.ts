import { describe, expect, test } from 'bun:test';
import { buildCliDoctorFindings } from '../../cli/status.ts';
import type { CliStatusOptions } from '../../cli/status.ts';

type CliStatusService = NonNullable<CliStatusOptions['service']>;

const HOST_ISSUE = 'The configured control-plane port does not match the port the host is listening on.';
const POSTURE_ADVISORY = 'Agent adopts no host of its own; it dials the connected host.';

function options(service: CliStatusService): CliStatusOptions {
  const values: Record<string, unknown> = { 'permissions.mode': 'prompt' };
  return {
    configManager: { get: (key: string) => values[key] } as CliStatusOptions['configManager'],
    workingDirectory: '/project',
    homeDirectory: '/home/test',
    onboardingMarker: { scope: 'user', path: '/home/test/.goodvibes/agent/onboarding-checked.json', exists: false, payload: null },
    service,
  };
}

function posture(overrides: Partial<CliStatusService>): CliStatusService {
  return {
    advisories: [],
    config: { enabled: true, autostart: true, restartOnFailure: true, daemonEnabled: true, connectedHostDialEnabled: true },
    managed: {
      platform: 'manual', path: 'connected GoodVibes host', installed: false, autostart: false, running: false,
      logPath: '/home/test/.goodvibes/daemon/service/manual.log', commandPreview: 'managed outside goodvibes-agent',
      suggestedCommands: [], lastAction: 'status', pidPath: 'connected GoodVibes host', lastError: null,
    },
    endpoints: [],
    log: { path: '/project/.goodvibes/agent/service/manual.log', exists: true, size: 1, modifiedAt: 1 },
    issues: [],
    ...overrides,
  };
}

function idOf(findings: ReturnType<typeof buildCliDoctorFindings>, summary: string): string | undefined {
  return findings.find((finding) => finding.summary === summary)?.id;
}

describe('doctor finding ids', () => {
  test('a host issue and a posture advisory keep their ids whatever other findings come before them', () => {
    const alone = buildCliDoctorFindings(options(posture({ issues: [HOST_ISSUE], advisories: [POSTURE_ADVISORY] })));
    const withEarlierIssue = buildCliDoctorFindings(options(posture({
      issues: ['The connected host is not answering on its configured address.', HOST_ISSUE],
      advisories: [POSTURE_ADVISORY],
    })));

    expect(idOf(alone, HOST_ISSUE)).toBeDefined();
    expect(idOf(withEarlierIssue, HOST_ISSUE)).toBe(idOf(alone, HOST_ISSUE)!);
    expect(idOf(withEarlierIssue, POSTURE_ADVISORY)).toBe(idOf(alone, POSTURE_ADVISORY)!);
    expect(idOf(alone, POSTURE_ADVISORY)!.startsWith('runtime-posture-')).toBe(true);
  });
});
