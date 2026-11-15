import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, type SharedApprovalRecord } from '../platform/src/platform/control-plane/approval-broker.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';

interface Snapshot extends Record<string, unknown> { readonly approvals: readonly SharedApprovalRecord[] }

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-approval-settle-'));
  cleanup.push(dir);
  return join(dir, 'approvals.json');
}
function request(callId: string): PermissionPromptRequest {
  return { callId, tool: 'write', args: { path: `${callId}.txt` }, category: 'write',
    analysis: { classification: 'write', riskLevel: 'medium', summary: 'write a file', reasons: [] } };
}

class FailingStore extends PersistentStore<Snapshot> {
  failWrites = false;
  loads = 0;
  override async load(): Promise<Snapshot | null> { this.loads += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return super.load(); }
  override async persist(snapshot: Snapshot): Promise<void> {
    if (this.failWrites) throw new Error('disk full');
    await super.persist(snapshot);
  }
}

test('a cancel whose write fails still releases the waiting tool call as denied', async () => {
  const store = new FailingStore(storePath());
  const broker = new ApprovalBroker({ store });
  const raised = await broker.raiseApproval({ request: request('cancel-io') });
  store.failWrites = true;
  await expect(broker.cancelApproval(raised.approval.id, 'web-user')).rejects.toThrow('disk full');
  expect(await raised.decision).toMatchObject({ approved: false });
});

test('two concurrent first starts load the store once and keep records created in between', async () => {
  const store = new FailingStore(storePath());
  const broker = new ApprovalBroker({ store });
  const first = broker.start();
  const second = broker.start();
  await Promise.all([first, second]);
  expect(store.loads).toBe(1);
});

test('a failed load is retried by the next start instead of being remembered', async () => {
  const path = storePath();
  writeFileSync(path, '{"approvals":[{"id":"broken"}]}');
  const broker = new ApprovalBroker({ storePath: path });
  await expect(broker.start()).rejects.toThrow("approval 'broken' is malformed");
  writeFileSync(path, '{"approvals":[]}');
  await broker.start();
  expect(broker.listApprovals()).toEqual([]);
});

test('a claim during an owner decision write does not turn the owner approval into a cancel', async () => {
  const path = storePath();
  let release!: () => void;
  let entered!: () => void;
  const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
  let hold = false;
  class HeldStore extends PersistentStore<Snapshot> {
    override async persist(snapshot: Snapshot): Promise<void> {
      if (hold) { hold = false; entered(); await new Promise<void>((resolve) => { release = resolve; }); }
      await super.persist(snapshot);
    }
  }
  const broker = new ApprovalBroker({ store: new HeldStore(path) });
  const raised = await broker.raiseOwnerApproval({ request: request('owner'), requireOwnerDecision: { assertCurrent: () => undefined } });
  hold = true;
  const resolving = raised.resolveOwnerDecision({ decision: { approved: true }, actor: 'owner', actorSurface: 'paired', assertCurrent: () => undefined });
  await enteredWrite;
  const claimed = broker.claimApproval(raised.approval.id, 'web-user');
  await Promise.resolve();
  release();
  expect((await resolving)?.status).toBe('approved');
  await claimed;
  expect(broker.getApproval(raised.approval.id)?.status).toBe('approved');
  expect((await raised.decision).approved).toBe(true);
});
