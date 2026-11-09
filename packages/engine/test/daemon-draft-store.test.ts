import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { historicalChannelDraftWireReference } from '../sdk/src/platform/channels/host-drafts/wire-reference.js';
import { rmSync } from 'node:fs';
import type { AtRestCipher } from '../sdk/src/platform/config/daemon-credential-store.js';
import { HandlerSqliteStore } from '../sdk/src/platform/state/daemon-handler-sqlite-store.js';
import {
  DraftSyncStore,
  MAX_DRAFT_LIST_LIMIT,
} from '../sdk/src/platform/channels/host-drafts/draft-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

// Deterministic reversible cipher: NOT real crypto, but exercises the
// encrypt-at-rest contract (store persists ciphertext, never plaintext).
function makeFakeCipher(): AtRestCipher & { encryptCalls: string[] } {
  const encryptCalls: string[] = [];
  return {
    encryptCalls,
    async encrypt(plaintext: string): Promise<string> {
      encryptCalls.push(plaintext);
      return `enc:${Buffer.from(plaintext, 'utf-8').toString('base64')}`;
    },
    async decrypt(ciphertext: string): Promise<string> {
      const stripped = ciphertext.replace(/^enc:/, '');
      return Buffer.from(stripped, 'base64').toString('utf-8');
    },
  };
}

function makeStore(workingDirectory: string, cipher: AtRestCipher): DraftSyncStore {
  let idCounter = 0;
  let clock = 1_000;
  return new DraftSyncStore({
    workingDirectory,
    cipher,
    generateId: () => {
      idCounter += 1;
      return `id-${idCounter}`;
    },
    now: () => {
      clock += 1;
      return new Date(clock).toISOString();
    },
  });
}

describe('DraftSyncStore', () => {
  let dir: string;
  let cipher: ReturnType<typeof makeFakeCipher>;
  let store: DraftSyncStore;

  beforeEach(async () => {
    dir = makeProjectTempDir('gv-drafts');
    cipher = makeFakeCipher();
    store = makeStore(dir, cipher);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('new arbitrary protected IDs retain one opaque wire identity through restart without SHA', async () => {
    const hashing = spyOn(crypto, 'createHash');
    try {
      const id = 'draft-20261011000001-deadbeef';
      const first = await store.upsert({ id, message: 'private body' });
      const reference = first.draft.wireReference;
      expect(reference).toMatch(/^draft-reference-v2-[a-p-]+$/);
      expect(store.resolveReferenceId(reference)).toBe(id);
      expect(store.list()[0]?.wireReference).toBe(reference);
      expect((await store.upsert({ id, message: 'edited' })).draft.wireReference).toBe(reference);
      await store.save(); // The ordinary sync handler explicitly publishes after upsert.
      await store.close(); store = makeStore(dir, cipher); await store.init();
      expect(store.get(id)?.wireReference).toBe(reference);
      expect(store.resolveReferenceId(reference)).toBe(id);
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
      await expect(store.upsert({ id: 'different', wireReference: reference, message: 'conflicting label' })).rejects.toThrow('ambiguous');
    } finally { hashing.mockRestore(); }
  });

  test('only actual pre-field rows match old handles; old explicit writers preserve new labels', async () => {
    const id = 'draft-20261011000001-deadbeef';
    await store.upsert({ id, message: 'retained original body' }); await store.save(); await store.close();
    const old = new HandlerSqliteStore({ workingDirectory: dir, fileName: 'drafts.sqlite', schema: [] });
    await old.init();
    old.run('DROP INDEX idx_drafts_wireReference');
    old.run('ALTER TABLE drafts DROP COLUMN wireReference');
    old.run('ALTER TABLE drafts DROP COLUMN legacyWireReference');
    const ciphertext = old.get<{ bodyEnc: string }>('SELECT bodyEnc FROM drafts WHERE id = ?', [id]);
    expect(ciphertext).not.toBeNull();
    await old.save(); await old.close();
    const handle = historicalChannelDraftWireReference(id);
    store = makeStore(dir, cipher); await store.init();
    const canonical = store.get(id)!.wireReference;
    expect(store.resolveReferenceId(handle)).toBe(id);
    expect(canonical).not.toBe(handle);
    await expect(store.upsert({ id: 'fresh-row', wireReference: handle, message: 'shadow old alias' })).rejects.toThrow('ambiguous');
    await expect(store.upsert({ id: handle, message: 'shadow old alias as ID' })).rejects.toThrow('ambiguous');
    expect(store.count()).toBe(1);
    await store.close();
    const oldWriter = new HandlerSqliteStore({ workingDirectory: dir, fileName: 'drafts.sqlite', schema: [] });
    await oldWriter.init();
    oldWriter.run('UPDATE drafts SET title = ? WHERE id = ?', ['old reader edit', id]);
    expect(oldWriter.get<{ wireReference: string }>('SELECT wireReference FROM drafts WHERE id = ?', [id])).toEqual({ wireReference: canonical });
    expect(oldWriter.get<{ bodyEnc: string }>('SELECT bodyEnc FROM drafts WHERE id = ?', [id])).toEqual(ciphertext);
    // Already ambiguous data from an actual old explicit-column writer is
    // retained, but no historical handle may arbitrarily choose either row.
    oldWriter.run('INSERT INTO drafts (id, version, createdAt, updatedAt, status, bodyEnc) VALUES (?,1,?,?,?,?)',
      [handle, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'draft', 'enc:ZGlmZmVyZW50']);
    await oldWriter.save(); await oldWriter.close();
    store = makeStore(dir, cipher); await store.init();
    expect(store.get(id)).toMatchObject({ wireReference: canonical, title: 'old reader edit' });
    // Both a direct ID and an actual old content-derived alias match: refuse.
    expect(() => store.resolveReferenceId(handle)).toThrow('ambiguous');
  });

  test('create assigns a uuid, defaults version 1, reports created:true', async () => {
    const result = await store.upsert({ message: 'hello world' });
    expect(result.created).toBe(true);
    expect(result.draft.id).toBe('id-1');
    expect(result.draft.version).toBe(1);
    expect(result.draft.status).toBe('draft');
  });

  test('body is encrypted at rest; plaintext never appears in records', async () => {
    const { draft } = await store.upsert({ message: 'secret body' });
    expect(cipher.encryptCalls).toContain('secret body');
    const record = store.get(draft.id);
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain('secret body');
    const asRec = record as unknown as Record<string, unknown>;
    expect(asRec.body).toBeUndefined();
    expect(asRec.bodyEnc).toBeUndefined();
  });

  test('the message field is redacted without a deterministic private-body token', async () => {
    const body = 'the quick brown fox';
    const { draft } = await store.upsert({ message: body });
    expect(draft.message).toBe('[redacted]');
    expect(draft).not.toHaveProperty('messageDigest');
    expect(draft.message).not.toBe(body);
  });

  test('opening an existing store removes body digests and preserves encrypted drafts', async () => {
    const { draft } = await store.upsert({ message: 'private draft', webhook: 'private hook', title: 'Retain this draft' });
    await store.save(); await store.close();
    const existing = new HandlerSqliteStore({ workingDirectory: dir, fileName: 'drafts.sqlite', schema: [] });
    await existing.init();
    let ciphertext: { bodyEnc: string; webhookEnc: string } | null = null;
    try {
      existing.run("ALTER TABLE drafts ADD COLUMN messageDigest TEXT NOT NULL DEFAULT 'previous-body-digest'");
      ciphertext = existing.get<{ bodyEnc: string; webhookEnc: string }>('SELECT bodyEnc, webhookEnc FROM drafts WHERE id = ?', [draft.id]);
      expect(ciphertext).not.toBeNull();
      await existing.save();
    } finally { await existing.close(); }
    // Upgrade does not need the key just to remove display-only metadata.
    store = makeStore(dir, { async encrypt() { throw new Error('Unexpected encryption'); }, async decrypt() { throw new Error('Unexpected decryption'); } });
    await store.init();
    expect(store.get(draft.id)).toMatchObject({ id: draft.id, title: 'Retain this draft', message: '[redacted]', webhook: '[redacted]' });
    await store.close();
    const upgraded = new HandlerSqliteStore({ workingDirectory: dir, fileName: 'drafts.sqlite', schema: [] });
    await upgraded.init();
    try {
      expect(upgraded.all<{ name: string }>('PRAGMA table_info(drafts)').some(column => column.name === 'messageDigest')).toBe(false);
      expect(upgraded.get<{ bodyEnc: string; webhookEnc: string }>('SELECT bodyEnc, webhookEnc FROM drafts WHERE id = ?', [draft.id])).toEqual(ciphertext);
    } finally { await upgraded.close(); }
  });

  test('webhook is encrypted at rest and always redacted on read', async () => {
    const { draft } = await store.upsert({
      message: 'm',
      webhook: '[redacted]',
    });
    expect(draft.webhook).toBe('[redacted]');
    // A raw value passed directly to the store is encrypted then redacted on read.
    const direct = await store.upsert({ message: 'm', webhook: 'opaque-hook-value' });
    expect(cipher.encryptCalls).toContain('opaque-hook-value');
    const record = store.get(direct.draft.id);
    expect(record?.webhook).toBe('[redacted]');
    expect(JSON.stringify(record)).not.toContain('opaque-hook-value');
  });

  test('update preserves createdAt, bumps updatedAt, reports created:false', async () => {
    const created = await store.upsert({ message: 'v1' });
    const original = store.get(created.draft.id)!;
    const updated = await store.upsert({ id: created.draft.id, message: 'v2', version: 2 });
    expect(updated.created).toBe(false);
    expect(updated.draft.createdAt).toBe(original.createdAt);
    expect(updated.draft.version).toBe(2);
    expect(Date.parse(updated.draft.updatedAt)).toBeGreaterThan(Date.parse(original.updatedAt));
  });

  test('caller-supplied updatedAt is persisted verbatim', async () => {
    const ts = '2026-01-02T03:04:05.000Z';
    const { draft } = await store.upsert({ message: 'm', updatedAt: ts });
    expect(draft.updatedAt).toBe(ts);
  });

  test('full-replace: omitting an optional field clears it on update', async () => {
    const created = await store.upsert({ message: 'm', title: 'keep', tags: ['a', 'b'] });
    expect(store.get(created.draft.id)?.title).toBe('keep');
    await store.upsert({ id: created.draft.id, message: 'm2' });
    const after = store.get(created.draft.id)!;
    expect(after.title).toBeUndefined();
    expect(after.tags).toBeUndefined();
  });

  test('list returns newest-updated first and count reflects totals', async () => {
    await store.upsert({ message: 'a' });
    await store.upsert({ message: 'b' });
    const drafts = store.list();
    expect(drafts.length).toBe(2);
    expect(Date.parse(drafts[0]!.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(drafts[1]!.updatedAt),
    );
    expect(store.count()).toBe(2);
  });

  test('list filters by status and count honours the filter', async () => {
    await store.upsert({ message: 'a', status: 'draft' });
    await store.upsert({ message: 'b', status: 'queued' });
    expect(store.list({ status: 'queued' }).map((d) => d.status)).toEqual(['queued']);
    expect(store.count('queued')).toBe(1);
    expect(store.count('draft')).toBe(1);
  });

  test('list clamps an over-large limit to MAX_DRAFT_LIST_LIMIT', async () => {
    for (let i = 0; i < 3; i += 1) await store.upsert({ message: `m${i}` });
    const drafts = store.list({ limit: MAX_DRAFT_LIST_LIMIT + 10_000 });
    expect(drafts.length).toBe(3);
  });

  test('get returns null for an unknown id; delete reports existence', async () => {
    expect(store.get('nope')).toBeNull();
    const { draft } = await store.upsert({ message: 'm' });
    expect(store.delete(draft.id)).toBe(true);
    expect(store.delete(draft.id)).toBe(false);
    expect(store.get(draft.id)).toBeNull();
  });

  test('persists across reopen (save + reinit reads the mirror back)', async () => {
    const { draft } = await store.upsert({ message: 'durable' });
    await store.save();
    await store.close();
    const reopened = makeStore(dir, cipher);
    await reopened.init();
    try {
      const record = reopened.get(draft.id);
      expect(record?.id).toBe(draft.id);
      expect(record?.message).toBe('[redacted]');
    } finally {
      await reopened.close();
    }
  });
});
