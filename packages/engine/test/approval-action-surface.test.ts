/** An approval answered from a chat surface is audited under that surface, not as a web click. */
import { expect, test } from 'bun:test';
import { handleInteractiveApprovalAction } from '../platform/src/platform/daemon/facade-approval-action.ts';

function rig(surface?: string) {
  const calls: Array<{ method: string; actor: string; surface: unknown }> = [];
  const broker = {
    claimApproval: async (_id: string, actor: string, actorSurface?: string) => { calls.push({ method: 'claim', actor, surface: actorSurface }); return { id: 'a' }; },
    cancelApproval: async (_id: string, actor: string, actorSurface?: string) => { calls.push({ method: 'cancel', actor, surface: actorSurface }); return { id: 'a' }; },
    resolveApproval: async (_id: string, input: { actor: string; actorSurface?: string }) => { calls.push({ method: 'resolve', actor: input.actor, surface: input.actorSurface }); return { id: 'a' }; },
  };
  const context = {
    broker: broker as unknown as Parameters<typeof handleInteractiveApprovalAction>[0]['broker'],
    parseBody: async () => null,
    actor: () => (surface ? `${surface}:U123` : 'operator'),
    ...(surface ? { surface: () => surface } : {}),
    record: (_r: Request, _p: string, response: Response) => response,
  };
  return { calls, context };
}

test('an approval pressed in Slack is recorded with the slack surface and the Slack user', async () => {
  const { calls, context } = rig('slack');
  for (const action of ['claim', 'approve', 'deny', 'cancel'] as const) await handleInteractiveApprovalAction(context, 'a', action, new Request('http://x/'));
  expect(calls).toEqual([
    { method: 'claim', actor: 'slack:U123', surface: 'slack' },
    { method: 'resolve', actor: 'slack:U123', surface: 'slack' },
    { method: 'resolve', actor: 'slack:U123', surface: 'slack' },
    { method: 'cancel', actor: 'slack:U123', surface: 'slack' },
  ]);
});

test('an approval without a surface stays a web action', async () => {
  const { calls, context } = rig();
  await handleInteractiveApprovalAction(context, 'a', 'approve', new Request('http://x/'));
  expect(calls).toEqual([{ method: 'resolve', actor: 'operator', surface: 'web' }]);
});
