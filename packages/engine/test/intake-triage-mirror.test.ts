/**
 * Triage labels live beside their rows: one model request scores a batch, the
 * label shows on the row it scored, and a row whose content changed is scored
 * again rather than shown with a stale label.
 */
import { afterEach, expect, test } from 'bun:test';
import { createSystemOnePort, type Questions } from '@goodvibes-jev/judgment';
import { InboxCursorStore } from '../platform/src/platform/intake/cursor-store.ts';
import type { InboundChannelItem } from '../platform/src/platform/intake/provider-adapter.ts';
import { triageMirrorRows } from '../platform/src/platform/intake/triage/pipeline.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const stores: InboxCursorStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

const row = (id: string, bodyPreview: string): InboundChannelItem => ({ id: `email:${id}`, provider: 'email', kind: 'dm',
  fromDigest: '0123456789abcdef', subjectPreview: 'Notice', bodyPreview, receivedAt: Date.now(), unread: true });

/** A judgment route that reads every item as spam and, more confidently, as urgent; counts requests. */
function yesPort() {
  let requests = 0;
  const port = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:9', apiKey: '', authentication: 'none' },
    model: 'jev-1.13.0', signal: new AbortController().signal, timeoutMs: 30_000, retry: {}, fetch: async (_url, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as { model: string; questions: Questions };
      return Response.json({ model: body.model, usage: { input_tokens: 10, output_tokens: 2, truncated: false },
        answers: Object.fromEntries(Object.keys(body.questions).map(name => [name, { type: 'noul', noul: name.includes('urgency') ? 0.999 : 0.99 }])) });
    } });
  return { port, requests: () => requests };
}

async function mirror() {
  const store = new InboxCursorStore(makeProjectTempDir('triage-mirror'), 'mirror.sqlite', { sweepIntervalMs: 0,
    triageScope: { providerId: 'email', accountScopeId: 'fixture-account' } });
  stores.push(store); await store.init();
  return store;
}

test('one request scores a batch; spam wins over urgency; the label shows on its row', async () => {
  const store = await mirror();
  await store.commitTimestampPoll('email', [row('one', 'Pay the fee today or lose the account'), row('two', 'Another notice')], () => {});
  const { port, requests } = yesPort();
  const rows = store.untriagedItems('email', 50).map(({ item, revision }) => ({ id: item.id, provider: item.provider, kind: item.kind,
    subject: item.subjectPreview, snippet: item.bodyPreview, unread: item.unread, revision }));
  const { stored } = await triageMirrorRows(store, 'email', port, { candidates: rows });
  expect(requests()).toBe(1);
  expect(stored).toBe(2);
  expect(store.listItems({ limit: 10 }).map(item => item.triageLabel)).toEqual(['spam', 'spam']);
  expect(store.untriagedItems('email', 50)).toEqual([]);
});

test('a row whose content changed loses its label and is scored again', async () => {
  const store = await mirror();
  await store.commitTimestampPoll('email', [row('one', 'First text')], () => {});
  const before = store.untriagedItems('email', 50).map(({ item, revision }) => ({ id: item.id, provider: item.provider, kind: item.kind,
    subject: item.subjectPreview, snippet: item.bodyPreview, unread: item.unread, revision }));
  // The content changes after it was read for scoring and before the label is stored.
  await store.commitTimestampPoll('email', [row('one', 'Edited text')], () => {});
  const { stored } = await triageMirrorRows(store, 'email', yesPort().port, { candidates: before });
  expect(stored).toBe(0);
  expect(store.listItems({ limit: 1 })[0]?.triageLabel).toBeUndefined();
  expect(store.untriagedItems('email', 50).map(candidate => candidate.item.id)).toEqual(['email:one']);
});
