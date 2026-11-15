import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { InboxCursorStore } from '../platform/src/platform/intake/cursor-store.ts';
import type { InboundChannelItem } from '../platform/src/platform/intake/provider-adapter.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const item = (over: Partial<InboundChannelItem> & { id: string }): InboundChannelItem => ({
  provider: 'slack', kind: 'dm', fromDigest: '0123456789abcdef', subjectPreview: 'Direct message', bodyPreview: 'hello', receivedAt: 1_000, unread: true, ...over,
});

let dir: string;
let store: InboxCursorStore;
beforeEach(async () => { dir = await makeProjectTempDir('inbox-cursor-ownership'); store = new InboxCursorStore(dir); await store.init(); });
afterEach(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });

test('upsertItems refuses an id another provider owns and leaves that row untouched', () => {
  store.upsertItems([item({ id: 'shared', provider: 'slack', bodyPreview: 'original' })]);
  expect(() => store.upsertItems([item({ id: 'fresh', provider: 'discord' }), item({ id: 'shared', provider: 'discord', bodyPreview: 'taken over' })]))
    .toThrow('belongs to another provider');
  const rows = store.listItems({ limit: 10 });
  expect(rows.map(row => [row.id, row.provider, row.bodyPreview])).toEqual([['shared', 'slack', 'original']]);
});
