/**
 * A review queue file that cannot be read does not disable delegated review:
 * the unreadable file is set aside and the queue starts empty, and one
 * malformed row costs only that row.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DelegatedInboundReviewReceiver, type DelegatedReviewGrant } from '../platform/src/platform/control-plane/delegated-inbound-receiver.ts';
import type { NativeInboundResolvedSource } from '../platform/src/platform/control-plane/native-inbound-source.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-review-corruption-'));
  dirs.push(dir);
  return dir;
}

function sourceFor(requestId: string): NativeInboundResolvedSource {
  return {
    ref: { sessionId: 's1', inputId: `sin-${requestId}`, sourceId: 'src-1', sourceRevision: 'rev-1', requestId },
    origin: { kind: 'external-original', accountId: 'acct', accountRevision: 'a1', routeId: 'route', routeRevision: 'r1' },
    original: { text: 'synthetic', unsupportedSources: [] },
  };
}
const grant = {
  configurationId: 'cfg', ownerRevision: 'o1', workspaceRevision: 'w1', approvalId: 'approval-1',
  owner: { kind: 'pairing-token', principalId: 'owner', tokenId: 'tok', authorityId: 'auth', authorityRevision: 'r1', scopes: [] },
  sourceExpiresAt: Date.now() + 60_000,
  choices: {
    processingPurpose: 'accept-external-message-for-owner-review', sourceRetention: 'memory-only-until-review-close-or-deadline', sourceRetentionMs: 30_000,
    derivedRecord: 'external-source-reference-only-v1', derivedRecordRetentionMs: 60_000, execution: 'none', ownerMayReadOriginal: true,
  },
} as DelegatedReviewGrant;
const options = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });

test('an unparseable queue file is set aside and a later review is accepted on an empty queue', async () => {
  const dir = storeDir();
  const path = join(dir, 'reviews.json');
  writeFileSync(path, '{"records":[{"id":"trunc');
  const receiver = new DelegatedInboundReviewReceiver(path);
  try {
    expect(await receiver.list()).toEqual([]);
    expect(await receiver.receiver(grant).accept(sourceFor('req-after-corruption'), options())).toMatchObject({ disposition: 'transferred' });
    // The damaged bytes were kept for a person to inspect, next to the new queue.
    expect(readdirSync(dir).filter((name) => name !== 'reviews.json').length).toBeGreaterThan(0);
    expect(readFileSync(path, 'utf8')).toContain('req-after-corruption');
  } finally { receiver.close(); }
});

test('one malformed row is dropped and the valid rows around it are kept', async () => {
  const dir = storeDir();
  const path = join(dir, 'reviews.json');
  const first = new DelegatedInboundReviewReceiver(path);
  await first.receiver(grant).accept(sourceFor('req-kept'), options());
  first.close();
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { records: unknown[] };
  saved.records.push({ id: 'malformed' });
  writeFileSync(path, JSON.stringify(saved));

  const second = new DelegatedInboundReviewReceiver(path);
  try {
    const records = await second.list();
    expect(records.map((record) => record.ref.requestId)).toEqual(['req-kept']);
  } finally { second.close(); }
});
