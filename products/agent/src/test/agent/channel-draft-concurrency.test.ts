/**
 * channel-draft-concurrency.test.ts, drafts keep their data when writers
 * overlap, never claim more than a person asked, and never leak a webhook.
 *
 * Each test holds the daemon call open (a deferred promise) and lets another
 * writer act while it is in flight, because that window is where a snapshot
 * written back from before the await undoes the other writer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  channelDraftFilePath,
  deleteDraft,
  formatChannelDraftList,
  getDraft,
  listDrafts,
  markDraftFailed,
  markDraftSent,
  mergeDraftViews,
  queueDraftToSend,
  readChannelDrafts,
  saveDraft,
  syncChannelDrafts,
  type ChannelDraft,
  type ChannelDraftWebhookSecrets,
} from '../../agent/channel-draft.ts';
import type { DaemonOperatorInvoke } from '../../agent/daemon-operator-client.ts';

let root: string;
const shellPaths = { resolveUserPath: (...segments: string[]) => join(root, ...segments) };

beforeEach(() => { root = makeProjectTempDir('gv-draft-conc'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function memorySecrets(): ChannelDraftWebhookSecrets & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
  };
}

interface Call { readonly methodId: string; readonly input: Record<string, unknown>; readonly explicitUserRequest: boolean | undefined }

const down: DaemonOperatorInvoke = async (methodId) => ({ ok: false, methodId, route: '', kind: 'connected_host_unavailable', error: 'down' });

function recordingDaemon(calls: Call[], during?: () => void | Promise<void>): DaemonOperatorInvoke {
  return async (methodId, input = {}, options = {}) => {
    calls.push({ methodId, input, explicitUserRequest: options.explicitUserRequest });
    await during?.();
    return { ok: true, methodId, route: '', body: { draft: input } };
  };
}

describe('a daemon call in flight does not undo other writers', () => {
  test('saveDraft keeps a draft saved and a draft marked sent while its own offer was pending', async () => {
    const sent = await saveDraft(shellPaths, { message: 'to be sent', channel: 'slack:a' });
    await saveDraft(shellPaths, { message: 'to be deleted', channel: 'slack:b' });
    let newId = '';
    const invoke = recordingDaemon([], async () => {
      // Another writer, with the offer for "slow" still open.
      markDraftSent(shellPaths, sent.draft.id, 'r-1');
      newId = (await saveDraft(shellPaths, { message: 'composed meanwhile', channel: 'slack:c' })).draft.id;
    });

    const slow = await saveDraft(shellPaths, { message: 'slow', channel: 'slack:d' }, { invoke });

    const ids = readChannelDrafts(shellPaths).drafts.map((d) => d.id);
    expect(ids).toContain(slow.draft.id);
    expect(ids).toContain(newId);
    expect(getDraft(shellPaths, sent.draft.id)).toMatchObject({ status: 'sent', sentResponseId: 'r-1' });
  });

  test('syncChannelDrafts does not bring back a deleted draft or revert a sent one', async () => {
    const keep = await saveDraft(shellPaths, { message: 'keep me', channel: 'slack:a' }, { invoke: down });
    const gone = await saveDraft(shellPaths, { message: 'delete me', channel: 'slack:b' }, { invoke: down });
    const finished = await saveDraft(shellPaths, { message: 'will be sent', channel: 'slack:c' }, { invoke: down });
    let calls = 0;
    const invoke = recordingDaemon([], async () => {
      calls += 1;
      if (calls !== 1) return;
      await deleteDraft(shellPaths, gone.draft.id);
      markDraftSent(shellPaths, finished.draft.id, 'r-9');
    });

    await syncChannelDrafts(shellPaths, invoke);

    const drafts = readChannelDrafts(shellPaths).drafts;
    expect(drafts.map((d) => d.id)).not.toContain(gone.draft.id);
    expect(drafts.find((d) => d.id === finished.draft.id)).toMatchObject({ status: 'sent', sentResponseId: 'r-9' });
    expect(drafts.find((d) => d.id === keep.draft.id)?.daemonSyncState).toBe('synced');
  });

  test('a draft rewritten while the sync offer was pending keeps its newer text and stays pending', async () => {
    const saved = await saveDraft(shellPaths, { message: 'first text', channel: 'slack:a' }, { invoke: down });
    const invoke = recordingDaemon([], async () => {
      await saveDraft(shellPaths, { id: saved.draft.id, message: 'edited text', channel: 'slack:a' }, { invoke: down });
    });

    await syncChannelDrafts(shellPaths, invoke);

    expect(getDraft(shellPaths, saved.draft.id)).toMatchObject({ message: 'edited text', daemonSyncState: 'pending' });
  });
});

describe('queueDraftToSend hands a draft out once', () => {
  test('two overlapping calls produce one delivery input', async () => {
    const saved = await saveDraft(shellPaths, { message: 'send once', channel: 'slack:a' });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const invoke = recordingDaemon([], () => gate);

    const first = queueDraftToSend(shellPaths, saved.draft.id, { invoke });
    const second = queueDraftToSend(shellPaths, saved.draft.id, { invoke });
    const settled = Promise.allSettled([first, second]);
    release();
    const [a, b] = await settled;

    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(getDraft(shellPaths, saved.draft.id)?.status).toBe('queued');
  });
});

describe('saving a draft with a new target replaces the old one', () => {
  test('a draft saved with a channel and re-saved with a route is sent to exactly one target', async () => {
    const first = await saveDraft(shellPaths, { message: 'hello', channel: 'slack:a' });
    const again = await saveDraft(shellPaths, { id: first.draft.id, message: 'hello', route: 'r1' });

    expect(again.draft.route).toBe('r1');
    expect(again.draft.channel).toBeUndefined();
    const queued = await queueDraftToSend(shellPaths, first.draft.id);
    expect(queued.deliveryInput.route).toBe('r1');
    expect(queued.deliveryInput.channel).toBeUndefined();
  });

  test('retargeting from a webhook removes the stored secret and key', async () => {
    const webhookSecrets = memorySecrets();
    const first = await saveDraft(shellPaths, { message: 'hi', webhook: 'https://hooks.example.test/x' }, { webhookSecrets });
    expect(webhookSecrets.values.size).toBe(1);
    const again = await saveDraft(shellPaths, { id: first.draft.id, message: 'hi', channel: 'slack:a' }, { webhookSecrets });

    expect(again.draft.webhookSecretKey).toBeUndefined();
    expect(webhookSecrets.values.size).toBe(0);
    expect((await queueDraftToSend(shellPaths, first.draft.id, { webhookSecrets })).deliveryInput.channel).toBe('slack:a');
  });

  test('an aborted retarget keeps the stored webhook secret the draft still points at', async () => {
    const webhookSecrets = memorySecrets();
    const url = 'https://hooks.example.test/x';
    const first = await saveDraft(shellPaths, { message: 'hi', webhook: url }, { webhookSecrets });
    const controller = new AbortController();
    const aborting: DaemonOperatorInvoke = async (methodId) => {
      controller.abort();
      return { ok: false, methodId, route: '', kind: 'connected_host_unavailable', error: 'down' };
    };

    await expect(saveDraft(shellPaths, { id: first.draft.id, message: 'hi', channel: 'slack:a' },
      { webhookSecrets, invoke: aborting, signal: controller.signal })).rejects.toThrow();

    expect([...webhookSecrets.values.values()]).toEqual([url]);
    expect((await queueDraftToSend(shellPaths, first.draft.id, { webhookSecrets })).deliveryInput.webhook).toBe(url);
  });
});

describe('saving a draft again keeps what the caller left out', () => {
  test('a re-save with only the id and the message keeps the target, route, link, title and tags', async () => {
    const saved = await saveDraft(shellPaths, {
      message: 'first', channel: 'slack:ops', route: 'ops-route', link: 'https://example.test/x', title: 'Ops', tags: ['a', 'b'],
    });

    await saveDraft(shellPaths, { id: saved.draft.id, message: 'first, retried' }, { invoke: down });

    expect(getDraft(shellPaths, saved.draft.id)).toMatchObject({
      message: 'first, retried', channel: 'slack:ops', route: 'ops-route', link: 'https://example.test/x', title: 'Ops', tags: ['a', 'b'],
    });
  });

  test('an empty string clears the field it names and nothing else', async () => {
    const saved = await saveDraft(shellPaths, { message: 'first', channel: 'slack:ops', title: 'Ops' });

    await saveDraft(shellPaths, { id: saved.draft.id, message: 'first', title: '' });

    const draft = getDraft(shellPaths, saved.draft.id)!;
    expect(draft.title).toBeUndefined();
    expect(draft.channel).toBe('slack:ops');
  });

  test('re-saving a sent draft to offer it again keeps its status and delivery response', async () => {
    const saved = await saveDraft(shellPaths, { message: 'done', channel: 'slack:a' }, { invoke: down });
    markDraftSent(shellPaths, saved.draft.id, 'r-77');
    const calls: Call[] = [];

    await saveDraft(shellPaths, { id: saved.draft.id, message: 'done' }, { invoke: recordingDaemon(calls) });

    expect(calls[0]!.input).toMatchObject({ status: 'sent', sentResponseId: 'r-77', channel: 'slack:a' });
    expect(getDraft(shellPaths, saved.draft.id)).toMatchObject({ status: 'sent', sentResponseId: 'r-77', daemonSyncState: 'synced' });
  });
});

describe('syncing one draft', () => {
  test('only the named draft is offered, the others stay pending', async () => {
    const one = await saveDraft(shellPaths, { message: 'one', channel: 'slack:a' }, { invoke: down });
    const two = await saveDraft(shellPaths, { message: 'two', channel: 'slack:b' }, { invoke: down });
    markDraftSent(shellPaths, one.draft.id, 'r-1');
    const calls: Call[] = [];

    const report = await syncChannelDrafts(shellPaths, recordingDaemon(calls), { draftId: one.draft.id });

    expect(report).toEqual({ attempted: 1, synced: 1, refused: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ status: 'sent', sentResponseId: 'r-1' });
    expect(getDraft(shellPaths, two.draft.id)?.daemonSyncState).toBe('pending');
  });
});

describe('saveDraft cannot undo a sent draft', () => {
  test('setting a sent draft back to draft is refused and it stays sent', async () => {
    const saved = await saveDraft(shellPaths, { message: 'done', channel: 'slack:a' });
    markDraftSent(shellPaths, saved.draft.id, 'r-1');

    await expect(saveDraft(shellPaths, { id: saved.draft.id, message: 'done', channel: 'slack:a', status: 'draft' })).rejects.toThrow(/final/);

    expect(getDraft(shellPaths, saved.draft.id)?.status).toBe('sent');
  });
});

describe('what the daemon is told', () => {
  test('a sync is not claimed to be a person asking', async () => {
    await saveDraft(shellPaths, { message: 'held', channel: 'slack:a' }, { invoke: down });
    const calls: Call[] = [];

    await syncChannelDrafts(shellPaths, recordingDaemon(calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.explicitUserRequest).toBe(false);
  });

  test('a webhook URL is neither sent to the daemon nor written to the draft file; delivery reads it from the secret store', async () => {
    const url = 'https://hooks.example.test/services/T0/B0/secret-token';
    const calls: Call[] = [];
    const webhookSecrets = memorySecrets();

    const saved = await saveDraft(shellPaths, { message: 'hook it', webhook: url }, { invoke: recordingDaemon(calls), webhookSecrets });
    const queued = await queueDraftToSend(shellPaths, saved.draft.id, { invoke: recordingDaemon(calls), webhookSecrets });

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(JSON.stringify(call.input)).not.toContain('secret-token');
      expect(call.input.webhook).toBe('[redacted]');
      expect(call.input).not.toHaveProperty('webhookSecretKey');
    }
    expect(readFileSync(channelDraftFilePath(shellPaths), 'utf-8')).not.toContain('secret-token');
    expect(JSON.stringify(saved.draft)).not.toContain('secret-token');
    expect(queued.deliveryInput.webhook).toBe(url);
    expect([...webhookSecrets.values.values()]).toEqual([url]);
    // A later re-save of just the text keeps the same stored webhook.
    await saveDraft(shellPaths, { id: saved.draft.id, message: 'hook it again' }, { webhookSecrets });
    expect(readFileSync(channelDraftFilePath(shellPaths), 'utf-8')).not.toContain('secret-token');
    markDraftFailed(shellPaths, saved.draft.id, 'bridge down');
    expect((await queueDraftToSend(shellPaths, saved.draft.id, { webhookSecrets })).deliveryInput.webhook).toBe(url);
  });

  test('a shell with no secret store refuses a webhook draft rather than write the URL to the file', async () => {
    await expect(saveDraft(shellPaths, { message: 'hook it', webhook: 'https://hooks.example.test/T0/secret-token' })).rejects.toThrow(/secret store/);

    expect(readChannelDrafts(shellPaths).exists).toBe(false);
  });

  test('a draft whose stored webhook cannot be read is not sent, and says why', async () => {
    const webhookSecrets = memorySecrets();
    const saved = await saveDraft(shellPaths, { message: 'hook it', webhook: 'https://hooks.example.test/T0/secret-token' }, { webhookSecrets });
    webhookSecrets.values.clear();

    await expect(queueDraftToSend(shellPaths, saved.draft.id, { webhookSecrets })).rejects.toThrow(/could not be read, so nothing was sent/);

    expect(getDraft(shellPaths, saved.draft.id)?.status).toBe('draft');
  });

  test('a webhook URL an older version wrote into the file moves to the secret store on the next save', async () => {
    const url = 'https://hooks.example.test/T0/legacy-token';
    const saved = await saveDraft(shellPaths, { message: 'old draft', channel: 'slack:a' });
    const path = channelDraftFilePath(shellPaths);
    const file = JSON.parse(readFileSync(path, 'utf-8'));
    file.drafts[0].webhook = url;
    writeFileSync(path, JSON.stringify(file));
    const webhookSecrets = memorySecrets();

    await saveDraft(shellPaths, { id: saved.draft.id, message: 'old draft, edited' }, { webhookSecrets });

    expect(readFileSync(path, 'utf-8')).not.toContain('legacy-token');
    expect([...webhookSecrets.values.values()]).toEqual([url]);
  });

  test('deleting a draft deletes its stored webhook', async () => {
    const webhookSecrets = memorySecrets();
    const saved = await saveDraft(shellPaths, { message: 'hook it', webhook: 'https://hooks.example.test/T0/secret-token' }, { webhookSecrets });

    await deleteDraft(shellPaths, saved.draft.id, { webhookSecrets });

    expect(webhookSecrets.values.size).toBe(0);
  });

  test('a draft marked sent or failed is offered again with its outcome, then stops being pending', async () => {
    const sentDraft = await saveDraft(shellPaths, { message: 'composed offline', channel: 'slack:a' }, { invoke: down });
    const failedDraft = await saveDraft(shellPaths, { message: 'will not go', channel: 'slack:b' }, { invoke: down });
    markDraftSent(shellPaths, sentDraft.draft.id, 'r-2');
    markDraftFailed(shellPaths, failedDraft.draft.id, 'bridge down');
    expect(getDraft(shellPaths, sentDraft.draft.id)?.daemonSyncState).toBe('pending');
    const calls: Call[] = [];

    const report = await syncChannelDrafts(shellPaths, recordingDaemon(calls));

    expect(report).toEqual({ attempted: 2, synced: 2, refused: 0 });
    expect(calls.map((c) => c.input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'sent', sentResponseId: 'r-2' }),
      expect.objectContaining({ status: 'failed', sendError: 'bridge down' }),
    ]));
    expect(getDraft(shellPaths, sentDraft.draft.id)).toMatchObject({ status: 'sent', daemonSyncState: 'synced' });
  });

  test('a daemon that answers the draft is stale leaves it pending with the daemon\'s reason', async () => {
    const saved = await saveDraft(shellPaths, { message: 'edited elsewhere', channel: 'slack:a' }, { invoke: down });
    const stale: DaemonOperatorInvoke = async (methodId) => ({
      ok: false, methodId, route: '', kind: 'connected_host_error', error: 'Draft was changed on another surface; this save was not applied.',
    });

    const report = await syncChannelDrafts(shellPaths, stale);

    expect(report).toEqual({ attempted: 1, synced: 0, refused: 1 });
    expect(getDraft(shellPaths, saved.draft.id)).toMatchObject({ daemonSyncState: 'pending', syncError: expect.stringContaining('changed on another surface') });
  });
});

describe('the cross-surface list', () => {
  const daemonRow = (id: string): ChannelDraft => ({
    version: 1, id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    status: 'queued', message: '[redacted]', daemonSyncState: 'synced', origin: 'daemon',
  });

  test('a draft sent here stays sent and keeps its text when the daemon lists it as queued and redacted', async () => {
    const saved = await saveDraft(shellPaths, { message: 'the real text', channel: 'slack:a' }, { invoke: recordingDaemon([]) });
    markDraftSent(shellPaths, saved.draft.id, 'r-3');
    const local = listDrafts(shellPaths).drafts;
    const wireId = saved.draft.wireReference ?? saved.draft.id;

    const merged = mergeDraftViews([daemonRow(wireId)], local);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ status: 'sent', message: 'the real text', sentResponseId: 'r-3', daemonSyncState: 'synced' });
  });

  test('a draft only the daemon holds is listed as having no readable text', () => {
    const merged = mergeDraftViews([daemonRow('draft-from-phone')], []);

    expect(merged[0]).toMatchObject({ id: 'draft-from-phone', bodyUnavailable: true });
    expect(formatChannelDraftList({ path: 'p', exists: true, drafts: merged })).not.toContain('[redacted]');
  });
});

describe('persisted shape', () => {
  test('view-only fields are not written to the drafts file', async () => {
    await saveDraft(shellPaths, { message: 'plain' });
    const raw = readFileSync(channelDraftFilePath(shellPaths), 'utf8');
    expect(raw).not.toContain('bodyUnavailable');
    expect(raw).not.toContain('origin');
  });
});

describe('the outbox bound never drops an unsent draft', () => {
  function seed(drafts: readonly Record<string, unknown>[]): void {
    const path = channelDraftFilePath(shellPaths);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, drafts }));
  }
  const row = (index: number, status: 'draft' | 'sent', updatedAt: string) => ({
    version: 1, id: `draft-${status}-${index}`, createdAt: updatedAt, updatedAt, status, message: `m${index}`, daemonSyncState: 'synced',
  });

  test('past the bound the oldest sent draft goes and an older unsent draft stays', async () => {
    seed([
      ...Array.from({ length: 199 }, (_, index) => row(index, 'sent', `2026-02-01T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`)),
      row(0, 'draft', '2025-01-01T00:00:00.000Z'),
    ]);
    await saveDraft(shellPaths, { message: 'one more' });
    const ids = readChannelDrafts(shellPaths).drafts.map((draft) => draft.id);
    expect(ids).toHaveLength(200);
    expect(ids).toContain('draft-draft-0');
  });

  test('a save that would have to drop an unsent draft is refused and nothing is dropped', async () => {
    seed(Array.from({ length: 200 }, (_, index) => row(index, 'draft', `2026-02-01T00:00:00.${String(index).padStart(3, '0')}Z`)));
    await expect(saveDraft(shellPaths, { message: 'no room' })).rejects.toThrow(/not sent/);
    expect(readChannelDrafts(shellPaths).drafts).toHaveLength(200);
  });
});
