/**
 * The external-message review queue recovers from a failure instead of
 * staying broken until the daemon restarts.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DelegatedInboundReviewReceiver, type DelegatedReviewGrant } from '../platform/src/platform/control-plane/delegated-inbound-receiver.ts';
import { NativeInboundReceiverRefusal } from '../platform/src/platform/control-plane/native-inbound-handoff.ts';
import type { NativeInboundResolvedSource } from '../platform/src/platform/control-plane/native-inbound-source.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-review-receiver-')); dirs.push(dir); return join(dir, 'reviews.json');
}

const source: NativeInboundResolvedSource = {
  ref: { sessionId: 's1', inputId: 'sin-1', sourceId: 'src-1', sourceRevision: 'rev-1', requestId: 'req-1' },
  origin: { kind: 'external-original', accountId: 'acct', accountRevision: 'a1', routeId: 'route', routeRevision: 'r1' },
  original: { text: 'synthetic', unsupportedSources: [] },
};
const grant = {
  configurationId: 'cfg', ownerRevision: 'o1', workspaceRevision: 'w1', approvalId: 'approval-1',
  owner: { principalId: 'owner', scopes: [] }, sourceExpiresAt: Date.now() + 60_000,
  choices: { derivedRecordRetentionMs: 60_000 },
} as unknown as DelegatedReviewGrant;

test('a review queue that failed to load is loaded again on the next call', async () => {
  const path = storePath();
  // A row that fails its schema is dropped, so the load writes the queue back.
  writeFileSync(path, '{"records":[{"unreadable":true}]}');
  const receiver = new DelegatedInboundReviewReceiver(path);
  const store = (receiver as unknown as { store: { persist: (...args: unknown[]) => Promise<void> } }).store;
  const persist = store.persist.bind(store);
  let fail = true;
  store.persist = async (...args: unknown[]) => { if (fail) throw new Error('disk full'); await persist(...args); };
  await expect(receiver.list()).rejects.toThrow('disk full');
  fail = false;
  expect(await receiver.list()).toEqual([]);
});

test('an acceptance whose write failed can be retried instead of reading as an existing request', async () => {
  const receiver = new DelegatedInboundReviewReceiver(storePath());
  const store = (receiver as unknown as { store: { persist: (...args: unknown[]) => Promise<void> } }).store;
  const persist = store.persist.bind(store);
  let fail = true;
  store.persist = async (...args: unknown[]) => { if (fail) throw new Error('disk full'); await persist(...args); };
  const options = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });
  await expect(receiver.receiver(grant).accept(source, options())).rejects.toThrow('disk full');
  fail = false;
  expect(await receiver.receiver(grant).accept(source, options())).toMatchObject({ disposition: 'transferred' });
  receiver.close();
});

test('a closed receiver and an expired source refuse before any effect, as a retryable refusal', async () => {
  const options = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });
  const expired = { ...grant, sourceExpiresAt: Date.now() - 1 } as DelegatedReviewGrant;
  const open = new DelegatedInboundReviewReceiver(storePath());
  await expect(open.receiver(expired).accept(source, options())).rejects.toBeInstanceOf(NativeInboundReceiverRefusal);
  expect(await open.list()).toEqual([]);
  open.close();
  await expect(open.receiver(grant).accept(source, options())).rejects.toBeInstanceOf(NativeInboundReceiverRefusal);
});
