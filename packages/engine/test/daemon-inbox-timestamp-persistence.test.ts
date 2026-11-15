import { afterEach, describe, expect, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { InboxCursorStore } from '../platform/src/platform/intake/cursor-store.ts';
import type { InboundChannelItem } from '../platform/src/platform/intake/provider-adapter.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const row = (id = 'slack:new', receivedAt = 200): InboundChannelItem => ({ id, provider: 'slack', kind: 'dm',
  fromDigest: '0123456789abcdef', subjectPreview: 'Redacted', bodyPreview: 'Redacted', receivedAt, unread: true });
async function open(dir = makeProjectTempDir('inbox-timestamp-persistence')) {
  const store = new InboxCursorStore(dir, undefined, { sweepIntervalMs: 0, now: () => 0 });
  cleanup.push(() => store.close()); await store.init(); return { store, dir };
}

describe('timestamp inbox atomic persistence', () => {
  test('dedup, captured input and monotonic cursor survive reopen', async () => {
    const { store, dir } = await open();
    const input = row();
    const pending = store.commitTimestampPoll('slack', [input], () => {});
    input.id = 'mutated'; input.receivedAt = 999;
    expect(await pending).toBe(1);
    expect(await store.commitTimestampPoll('slack', [row('slack:new', 100)], () => {})).toBe(0);
    await store.close(); const { store: recovered } = await open(dir);
    expect(recovered.countItems()).toBe(1); expect(recovered.getCursor('slack')).toBe(200);
    expect(recovered.listItems({ limit: 10 })[0]?.id).toBe('slack:new');
  });


});
