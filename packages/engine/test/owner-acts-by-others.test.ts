// Proves: The model the Agent runs claims an approval, or cancels one that another caller raised.
// Red when: The approval actions port stops applying the reading's claim and cancel rule before it reaches the broker, so the Agent's credential claims an ask or cancels one it did not raise.
/**
 * Real components only: the approval actions port over a real approval broker; the Agent's credential is the model acting
 * for the user.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, type SharedApprovalRecord } from '../platform/src/platform/control-plane/approval-broker.ts';
import { localApprovalActions } from '../platform/src/platform/control-plane/approval-actions.ts';
import { actorFromPrincipal, NO_OWNER_USER } from '@goodvibes/engine/daemon-api/http-policy';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-owner-acts-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('the Agent\'s credential claims no approval and cancels only one it raised', async () => {
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  const actions = localApprovalActions(broker);
  // The Agent's credential: the model acting for the owner.
  const agent = actions.viewerOf(actorFromPrincipal({ principalId: 'pairing:agent-1', credentialKind: 'agent' }, NO_OWNER_USER));
  const raise = async (callId: string, raisedBy: string): Promise<SharedApprovalRecord> => {
    const raised = await broker.raiseApproval({
      request: { callId, tool: 'payments.purchase', args: { merchant: `${callId}.example` }, category: 'execute',
        analysis: { classification: 'payment', riskLevel: 'high', summary: 'Buy a burr coffee grinder for USD 120.00', reasons: [] } },
      metadata: { raisedVia: 'approvals.raise', raisedByPrincipal: raisedBy },
    });
    void raised.decision.catch(() => undefined);
    return raised.approval;
  };
  const owners = await raise('owners', 'owner');
  const its = await raise('its-own', 'pairing:agent-1');
  const act = { actor: 'pairing:agent-1', actorSurface: 'agent' };
  const status = (id: string) => broker.getApproval(id)?.status;

  const claimed = await actions.claim(owners.id, { ...act, expectedRevision: owners.revision }, agent);
  const cancelled = await actions.cancel(owners.id, { ...act, expectedRevision: owners.revision }, agent);
  expect([claimed.applied, cancelled.applied]).toEqual([false, false]);
  const code = (outcome: typeof claimed) => outcome.applied ? 'applied' : outcome.refusal.code;
  expect([code(claimed), code(cancelled)]).toEqual(['OWNER_ONLY', 'OWNER_ONLY']);
  expect(status(owners.id)).toBe('pending');

  // The control: an ask its own credential raised, which it no longer wants, it may cancel.
  expect((await actions.cancel(its.id, { ...act, expectedRevision: its.revision }, agent)).applied).toBe(true);
  expect(status(its.id)).toBe('cancelled');
});
