import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedSessionStore } from '../platform/src/platform/hosted-sessions/store.ts';
import type { HostedSessionRecord } from '../platform/src/platform/hosted-sessions/types.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hosted-store-limits-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function record(id: string): HostedSessionRecord {
  return { id, workspaceRoot: '/w', title: 'a session', status: 'idle', detachPolicy: 'survive', effectiveDetachPolicy: 'survive', attachedClients: [],
    createdAt: 1_000, updatedAt: 1_000, turnCount: 0, messageCount: 0, restoredFromDisk: false, contractIds: [] };
}

test.each([0, -1, Number.NaN])('a session cap of %p never evicts a persisted session', async maxSessions => {
  const store = new HostedSessionStore(dir, { maxSessions, maxMessagesPerSession: 10, terminatedRetentionMs: 60_000 });
  for (const id of ['a', 'b', 'c']) await store.save(record(id), null);
  const loaded = await store.load(2_000);
  expect(loaded.evicted).toEqual([]);
  expect(loaded.restored.map(session => session.record.id).sort()).toEqual(['a', 'b', 'c']);
  expect(existsSync(join(dir, 'a.json'))).toBe(true);
});

test('a session file missing a required field is moved aside with the field named, not restored', async () => {
  const store = new HostedSessionStore(dir, { maxSessions: 5, maxMessagesPerSession: 10, terminatedRetentionMs: 60_000 });
  const { attachedClients: _dropped, ...partial } = record('partial');
  writeFileSync(join(dir, 'partial.json'), JSON.stringify({ version: 2, record: partial, conversation: null }));
  const loaded = await store.load(2_000);
  expect(loaded.restored).toEqual([]);
  expect(loaded.rejected).toEqual([{ file: 'partial.json', reason: expect.stringContaining('attached client list') }]);
  expect(existsSync(join(dir, 'partial.json.rejected'))).toBe(true);
  expect(readFileSync(join(dir, 'partial.json.rejected'), 'utf8')).toContain('partial');
});
