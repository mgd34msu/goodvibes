/**
 * The sandbox escalation handler reads its advisory settings for every ask, so turning auto-approve
 * off holds for the next escalation without a restart.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { buildSandboxEscalationHandler } from '../platform/src/platform/runtime/permissions/sandbox-escalation-wiring.ts';

afterEach(() => { installJudgmentPort(undefined); });

describe('sandbox escalation settings are live', () => {
  test('switching auto-approve off makes the next escalation ask the owner', async () => {
    installJudgmentPort(fakePort(() => noulAnswer(0.04)).port);
    let judgment = 'auto-approve';
    let asked = 0;
    const handler = buildSandboxEscalationHandler({
      requestApproval: async () => { asked += 1; return { approved: false }; },
      configManager: { get: () => judgment } as never,
      featureFlags: { isEnabled: () => true },
    });
    const escalation = {
      command: 'curl https://example.com',
      escalations: ['wants network'],
      boundary: 'workspace writable, network disabled',
      policyReasons: [],
    };

    expect(await handler(escalation as never, undefined as never)).toBe(true);
    expect(asked).toBe(0);

    judgment = 'annotate';
    expect(await handler(escalation as never, undefined as never)).toBe(false);
    expect(asked).toBe(1);
  });
});
