import { describe, expect, test } from 'bun:test';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { DaemonSurfaceActionHelper } from '../platform/src/platform/daemon/surface-actions.ts';
import type { ChannelPolicyDecision } from '../platform/src/platform/channels/types.ts';

function harness() {
  const policy = { surface: 'slack', allowlistUserIds: ['owner', 'guest'], groupPolicies: [], enabled: true };
  const effects: string[] = [];
  const run = { id: 'run-1', status: 'running' };
  const helper = new DaemonSurfaceActionHelper({
    channelPolicy: { getPolicy: () => policy, listPolicies: () => [policy] },
    automationManager: {
      getRun: (id: string) => id === 'run-1' ? run : undefined,
      cancelRun: async (id: string) => { effects.push(`cancel:${id}`); return { id }; },
      retryRun: async (id: string) => { effects.push(`retry:${id}`); return { id }; },
    },
    agentManager: { getStatus: () => undefined },
    sessionBroker: { getSession: () => undefined },
  } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
  helper.authorizeSurfaceIngress = async () => ({ allowed: true, reason: 'authorized', policy } as unknown as ChannelPolicyDecision);
  const context = helper.buildSurfaceAdapterContext();
  const send = async (userId: string, text: string) => {
    await context.authorizeSurfaceIngress({ surface: 'slack', userId, text });
    const command = await context.parseSurfaceControlCommand(text);
    return command ? context.performSurfaceControlCommand(command) : null;
  };
  return { send, effects };
}

describe('surface control commands on a multi-user allowlist', () => {
  test('an admitted guest cannot cancel, retry or read status of a run; the owner can', async () => {
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const h = harness();
      for (const action of ['cancel', 'retry', 'status']) {
        const reply = await h.send('guest', `/${action} run-1`);
        expect(reply).toContain('refused');
        expect(reply).not.toContain('Run run-1');
      }
      expect(h.effects).toEqual([]);
      expect(await h.send('owner', '/status run-1')).toContain('Run run-1');
      await h.send('owner', '/cancel run-1');
      expect(h.effects).toEqual(['cancel:run-1']);
    });
  });
});
