/** An owner reply must report what happened to the ask, not what it intended. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { tryResolveApprovalReplyFromChannel } from '../platform/src/platform/daemon/approval-reply.ts';
import type { ChannelIngressPolicyInput, ChannelPolicyDecision } from '../platform/src/platform/channels/index.ts';
import { useApprovalReadings } from './helpers/approval-readings.ts';

const readings = useApprovalReadings();
const OWNER = 'U-OWNER';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function pendingAsk() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-approval-settled-')); dirs.push(dir);
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  const ask = await broker.raiseApproval({ routeId: 'route-1', request: { callId: 'call-1', tool: 'deploy', args: { destination: 'production' }, category: 'execute',
    analysis: { classification: 'execute', riskLevel: 'high', summary: 'Deploy production', reasons: [] } } });
  return { broker, ask };
}
const input = { surface: 'slack', userId: OWNER, text: 'Yes, go ahead.', conversationKind: 'direct' } as unknown as ChannelIngressPolicyInput;
const allowed = { allowed: true, policy: { allowlistUserIds: [OWNER] } } as unknown as ChannelPolicyDecision;
const routeBindings = { getBinding: (id: string) => ({ id, surfaceKind: 'slack' }) } as never;

test('a reply that finds the ask already settled by someone else is not reported as consumed', async () => {
  const { broker, ask } = await pendingAsk();
  readings.set({ reply: 'approve' });
  const settledFirst = { ...broker, listApprovals: broker.listApprovals.bind(broker),
    resolveApproval: async (id: string, resolution: Parameters<ApprovalBroker['resolveApproval']>[1]) => {
      await broker.resolveApproval(id, { approved: false, disposition: 'denied', actor: 'another-surface', actorSurface: 'web' });
      return broker.resolveApproval(id, resolution);
    } };
  expect(await tryResolveApprovalReplyFromChannel(input, allowed, { approvalBroker: settledFirst, routeBindings })).toBe(false);
  expect(broker.getApproval(ask.approval.id)?.status).toBe('denied');
});

test('a reply that settles the ask is reported as consumed', async () => {
  const { broker, ask } = await pendingAsk();
  readings.set({ reply: 'approve' });
  expect(await tryResolveApprovalReplyFromChannel(input, allowed, { approvalBroker: broker, routeBindings })).toBe(true);
  expect(broker.getApproval(ask.approval.id)?.status).toBe('approved');
});
