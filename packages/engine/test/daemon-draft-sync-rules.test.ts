/**
 * The draft mirror records how a draft ended and refuses to go backwards: an
 * older copy never replaces a newer edit, and a sent draft cannot be saved as
 * unsent by another surface.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AtRestCipher } from '../platform/src/platform/config/daemon-credential-store.js';
import { DraftSyncStore } from '../platform/src/platform/channels/host-drafts/draft-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cipher: AtRestCipher = {
  async encrypt(plaintext) { return `enc:${Buffer.from(plaintext).toString('base64')}`; },
  async decrypt(ciphertext) { return Buffer.from(ciphertext.replace(/^enc:/, ''), 'base64').toString(); },
};

describe('draft mirror sync rules', () => {
  let store: DraftSyncStore;

  beforeEach(async () => {
    store = new DraftSyncStore({ workingDirectory: makeProjectTempDir('gv-draft-rules'), cipher });
    await store.init();
  });
  afterEach(async () => { await store.close(); });

  test('an older copy of a draft does not replace a newer edit', async () => {
    const created = await store.upsert({ message: 'first', title: 'v1', updatedAt: '2026-01-01T00:00:00.000Z' });
    await store.upsert({ id: created.draft.id, message: 'edited elsewhere', title: 'v2', updatedAt: '2026-01-03T00:00:00.000Z' });
    await expect(store.upsert({ id: created.draft.id, message: 'offline edit', title: 'v-old', updatedAt: '2026-01-02T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 409, code: 'DRAFT_STALE' });
    const current = store.get(created.draft.id)!;
    expect(current.title).toBe('v2');
    expect(current.updatedAt).toBe('2026-01-03T00:00:00.000Z');
  });

  test('offering the same copy again is accepted', async () => {
    const stamp = '2026-01-01T00:00:00.000Z';
    const created = await store.upsert({ message: 'm', updatedAt: stamp });
    const again = await store.upsert({ id: created.draft.id, message: 'm', updatedAt: stamp });
    expect(again.created).toBe(false);
  });

  test('a draft saved as sent is listed as sent with its response id', async () => {
    const created = await store.upsert({ message: 'm', status: 'queued' });
    await store.upsert({ id: created.draft.id, message: 'm', status: 'sent', sentResponseId: 'msg-42' });
    expect(store.list({ status: 'sent' }).map((draft) => draft.sentResponseId)).toEqual(['msg-42']);
    expect(store.count('queued')).toBe(0);
  });

  test('a failed draft keeps its error until it is saved again', async () => {
    const created = await store.upsert({ message: 'm', status: 'queued' });
    const failed = await store.upsert({ id: created.draft.id, message: 'm', status: 'failed', sendError: 'bridge down' });
    expect(failed.draft.sendError).toBe('bridge down');
    const retried = await store.upsert({ id: created.draft.id, message: 'm', status: 'queued' });
    expect(retried.draft.sendError).toBeUndefined();
  });

  test('a sent draft cannot be saved back as unsent', async () => {
    const created = await store.upsert({ message: 'm', status: 'sent', sentResponseId: 'msg-1' });
    await expect(store.upsert({ id: created.draft.id, message: 'm', status: 'queued' }))
      .rejects.toMatchObject({ status: 409, code: 'DRAFT_ALREADY_SENT' });
    expect(store.get(created.draft.id)!.status).toBe('sent');
  });

});
