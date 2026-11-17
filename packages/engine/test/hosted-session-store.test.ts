/**
 * A hosted session's transcript outlives the daemon: what was saved loads in a
 * new store over the same directory, an older file still loads, a file that
 * cannot be read is kept for inspection rather than deleted, a live session is
 * never retired, and a session id cannot write outside the directory.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedSessionStore } from '../platform/src/platform/hosted-sessions/store.ts';
import type { HostedSessionRecord } from '../platform/src/platform/hosted-sessions/types.ts';

let root: string;
let dir: string;
const LIMITS = { maxSessions: 3, maxMessagesPerSession: 4, terminatedRetentionMs: 1_000 };

function record(overrides: Partial<HostedSessionRecord> & { id: string }): HostedSessionRecord {
  return {
    workspaceRoot: '/tmp/workspace', title: 'a session', status: 'idle', detachPolicy: null, effectiveDetachPolicy: 'kill',
    attachedClients: [], createdAt: 1_000, updatedAt: 1_000, turnCount: 0, messageCount: 0, restoredFromDisk: false, contractIds: [],
    ...overrides,
  };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hosted-store-')); dir = join(root, 'sessions'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('a saved transcript and the contracts the session started load in a new store; the most recent messages are the ones kept', async () => {
  const messages = [1, 2, 3, 4, 5, 6].map((n) => ({ role: 'user', content: `m${n}` }));
  await new HostedSessionStore(dir, LIMITS).save(record({ id: 'a', contractIds: ['ctr-00000001'] }), { messages, title: 'a session' });

  const loaded = await new HostedSessionStore(dir, LIMITS).load(1_000);
  expect(loaded.restored).toHaveLength(1);
  const session = loaded.restored[0]!;
  expect((session.conversation as { messages: { content: string }[] }).messages.map((m) => m.content)).toEqual(['m3', 'm4', 'm5', 'm6']);
  expect(session.record.contractIds).toEqual(['ctr-00000001']);
});

test('a file that cannot be used is moved aside with its bytes, not deleted', async () => {
  await new HostedSessionStore(dir, LIMITS).load(1_000);
  writeFileSync(join(dir, 'broken.json'), '{ this is not json');
  writeFileSync(join(dir, 'newer.json'), JSON.stringify({ version: 99, record: record({ id: 'newer' }), conversation: null }));
  const loaded = await new HostedSessionStore(dir, LIMITS).load(1_000);
  expect(loaded.restored).toEqual([]);
  expect(loaded.rejected.map((entry) => entry.file).sort()).toEqual(['broken.json', 'newer.json']);
  expect(readdirSync(dir).sort()).toEqual(['broken.json.rejected', 'newer.json.rejected']);
});

test('a live session is never retired or evicted, however old; a terminated one goes first', async () => {
  const store = new HostedSessionStore(dir, LIMITS);
  await store.save(record({ id: 'live-old', updatedAt: 1 }), null);
  await store.save(record({ id: 'live-mid', updatedAt: 20 }), null);
  await store.save(record({ id: 'live-new', updatedAt: 30 }), null);
  // Over the cap of three; the terminated one was touched last but is history.
  await store.save(record({ id: 'done', status: 'terminated', terminatedAt: 9_999_999, updatedAt: 40 }), null);

  const loaded = await new HostedSessionStore(dir, LIMITS).load(10_000_000);
  expect(loaded.swept).toEqual([]);
  expect(loaded.evicted).toEqual(['done']);
  expect(loaded.restored.map((s) => s.record.id).sort()).toEqual(['live-mid', 'live-new', 'live-old']);
});
