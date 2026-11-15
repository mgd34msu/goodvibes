import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, type SharedApprovalRecord } from '../platform/src/platform/control-plane/approval-broker.js';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.js';
import { CONTROL_PLANE_GATEWAY_FLAG_ID } from '../platform/src/platform/control-plane/gateway-disabled-response.js';
import { createFeatureFlagManager } from '../platform/src/platform/runtime/feature-flags/manager.js';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.js';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.js';

interface Snapshot extends Record<string, unknown> { readonly approvals: readonly SharedApprovalRecord[] }
class FailingStore extends PersistentStore<Snapshot> {
  failWrites = false;
  override async persist(snapshot: Snapshot): Promise<void> {
    if (this.failWrites) throw new Error('disk full');
    await super.persist(snapshot);
  }
}

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-approval-broker-'));
  cleanup.push(dir);
  return join(dir, 'approvals.json');
}
function request(callId: string, args: Record<string, unknown> = { file: 'a.txt' }): PermissionPromptRequest {
  return { callId, tool: 'write', args, category: 'write',
    analysis: { classification: 'write', riskLevel: 'medium', summary: 'write a file', reasons: [] } };
}

describe('approvals with the control-plane gateway switched off', () => {
  test('an ask is still recorded and answered; only the broadcast is skipped', async () => {
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: { [CONTROL_PLANE_GATEWAY_FLAG_ID]: 'disabled' } });
    const gateway = new ControlPlaneGateway({ featureFlags });
    const broker = new ApprovalBroker({ storePath: storePath() });
    broker.setPublisher(gateway);
    const raised = await broker.raiseApproval({ request: request('gateway-off') });
    expect(raised.approval.status).toBe('pending');
    const resolved = await broker.resolveApproval(raised.approval.id, { approved: true, actor: 'operator' });
    expect(resolved?.status).toBe('approved');
    expect(await raised.decision).toMatchObject({ approved: true });
    const cancelled = await broker.raiseApproval({ request: request('gateway-off-2', { file: 'b.txt' }) });
    expect((await broker.cancelApproval(cancelled.approval.id, 'operator'))?.status).toBe('cancelled');
  });
});

describe('releasing a raised ask', () => {
  test('a retried release by the same surface does not cancel an ask another surface still waits on', async () => {
    const broker = new ApprovalBroker({ storePath: storePath() });
    const metadata = { raisedVia: 'approvals.raise' };
    const first = await broker.raiseApproval({ request: request('wire-1'), metadata });
    const second = await broker.raiseApproval({ request: request('wire-2'), metadata });
    expect(second.coalesced).toBe(true);
    expect(second.approval.id).toBe(first.approval.id);

    expect(first.holdId).toBeDefined();
    expect(second.holdId).toBeDefined();
    expect(second.holdId).not.toBe(first.holdId);

    const firstRelease: { applied?: boolean } = {};
    const retried: { applied?: boolean } = {};
    await broker.releaseApproval(first.approval.id, 'operator', 'web', undefined, firstRelease, first.holdId);
    await broker.releaseApproval(first.approval.id, 'operator', 'web', undefined, retried, first.holdId);
    expect(broker.getApproval(first.approval.id)?.status).toBe('pending');
    expect(retried.applied).toBe(false);

    const last: { applied?: boolean } = {};
    await broker.releaseApproval(first.approval.id, 'operator', 'web', undefined, last, second.holdId);
    expect(broker.getApproval(first.approval.id)?.status).toBe('cancelled');
    expect(last.applied).toBe(true);
  });
});

describe('an approval whose write failed', () => {
  test('tells the approver the decision is held and still takes effect with the next write', async () => {
    const store = new FailingStore(storePath());
    const broker = new ApprovalBroker({ store });
    const first = await broker.raiseApproval({ request: request('first', { file: 'first.txt' }) });
    let settled = false;
    void first.decision.then(() => { settled = true; });

    store.failWrites = true;
    const outcome: { applied?: boolean } = {};
    await expect(broker.resolveApproval(first.approval.id, { approved: true, actor: 'operator', outcome })).rejects.toThrow(/disk full.*takes effect when the next write succeeds/s);
    expect(outcome.applied).toBe(false);
    expect(settled).toBe(false);
    store.failWrites = false;

    // The failure told the approver the decision is held; an unrelated write then commits it.
    const second = await broker.raiseApproval({ request: request('second', { file: 'second.txt' }) });
    expect(await first.decision).toMatchObject({ approved: true });
    expect(second.approval.status).toBe('pending');
  });
});

describe('an owner approval that loses currentness before its write', () => {
  test('stays answerable instead of being stuck as resolving', async () => {
    const broker = new ApprovalBroker({ storePath: storePath() });
    let armed = false;
    let calls = 0;
    const raised = await broker.raiseOwnerApproval({
      request: request('owner'),
      requireOwnerDecision: { assertCurrent: () => { if (armed && ++calls === 3) throw new Error('owner pairing changed'); } },
    });
    const resolution = { decision: { approved: true }, actor: 'paired-owner', actorSurface: 'paired-gateway', assertCurrent: () => undefined };
    armed = true;
    await expect(raised.resolveOwnerDecision(resolution)).rejects.toThrow('owner pairing changed');
    armed = false;
    expect(broker.getApproval(raised.approval.id)?.status).toBe('pending');
    const answered = await raised.resolveOwnerDecision(resolution);
    expect(answered?.status).toBe('approved');
  });
});
