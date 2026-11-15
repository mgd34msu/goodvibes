/**
 * Tests for the inbox mirror: the commit path the poller uses, the commit
 * sequence behind `since`, conversation cursors, and retention.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  InboxCursorStore,
  type InboxSweepSummary,
} from '../platform/src/platform/intake/cursor-store.ts';
import type { InboundChannelItem } from '../platform/src/platform/intake/provider-adapter.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { seedInboxRows } from './_helpers/inbox-seed.ts';

function item(over: Partial<InboundChannelItem> & { id: string }): InboundChannelItem {
  return {
    provider: 'slack',
    kind: 'dm',
    fromDigest: '0123456789abcdef',
    subjectPreview: 'Direct message',
    bodyPreview: 'hello',
    receivedAt: 1_000,
    unread: true,
    ...over,
  };
}

let dir: string;
let store: InboxCursorStore;

beforeEach(async () => {
  dir = await makeProjectTempDir('inbox-cursor');
  store = new InboxCursorStore(dir);
  await store.init();
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('InboxCursorStore', () => {
  test('commits dedup by id and count only new items', async () => {
    expect(await seedInboxRows(store, [item({ id: 'a' }), item({ id: 'b' })])).toBe(2);
    expect(await seedInboxRows(store, [item({ id: 'a' }), item({ id: 'c' })])).toBe(1);
    expect(store.countItems()).toBe(3);
  });

  test('listItems filters by provider, newest first', async () => {
    await seedInboxRows(store, [
      item({ id: 's1', provider: 'slack', receivedAt: 100 }),
      item({ id: 's2', provider: 'slack', receivedAt: 300 }),
      item({ id: 'd1', provider: 'discord', receivedAt: 200 }),
    ]);
    expect(store.listItems({ providers: ['slack'], limit: 10 }).map((i) => i.id)).toEqual(['s2', 's1']);
  });

  // A watermark is "committed after", not "sent after": a row committed later
  // with an older provider time is still new to a caller that polls with since.
  test('since returns a row committed after the watermark even when its own time is older', async () => {
    await seedInboxRows(store, [item({ id: 'email:late-read', provider: 'email', receivedAt: 20_000 })]);
    const watermark = store.maxSequence();
    await seedInboxRows(store, [item({ id: 'slack:sent-earlier', provider: 'slack', receivedAt: 5_000 })]);
    expect(store.listItems({ since: watermark, limit: 10 }).map((i) => i.id)).toEqual(['slack:sent-earlier']);
    expect(store.countItems(undefined, watermark)).toBe(1);
  });

  test('conversation cursors are kept per conversation and never move back', async () => {
    await store.commitTimestampPoll('slack', [item({ id: 'slack:C1:1', receivedAt: 400 })], () => {}, { C1: 400, C2: 900 });
    await store.commitTimestampPoll('slack', [], () => {}, { C1: 300 });
    expect([...store.getConversationCursors('slack')].sort()).toEqual([['C1', 400], ['C2', 900]]);
    expect(store.getConversationCursors('discord').size).toBe(0);
  });

  test('a commit refuses an id another provider owns', async () => {
    await seedInboxRows(store, [item({ id: 'shared', provider: 'slack', bodyPreview: 'original' })]);
    await expect(store.commitTimestampPoll('discord', [item({ id: 'shared', provider: 'discord' })], () => {})).rejects.toThrow();
    expect(store.listItems({ limit: 5 }).map((i) => [i.id, i.provider, i.bodyPreview])).toEqual([['shared', 'slack', 'original']]);
  });

  test('pruneOlderThan removes old items, keeps cursors, and is provider-scoped', async () => {
    await seedInboxRows(store, [
      item({ id: 'old', provider: 'slack', receivedAt: 100 }),
      item({ id: 'new', provider: 'slack', receivedAt: 500 }),
      item({ id: 'dold', provider: 'discord', receivedAt: 50 }),
    ]);
    expect(store.pruneOlderThan(200, ['slack'])).toBe(1);
    expect(store.listItems({ limit: 10 }).map((i) => i.id).sort()).toEqual(['dold', 'new']);
    expect(store.getCursor('slack')).toBe(500);
    expect(store.pruneOlderThan(100)).toBe(1);
    expect(store.countItems()).toBe(1);
  });

  test('committed rows and cursors survive a reopen', async () => {
    const recent = Date.now() - 1_000;
    await seedInboxRows(store, [item({ id: 'persist', receivedAt: recent })]);
    await store.close();
    const reopened = new InboxCursorStore(dir);
    await reopened.init();
    try {
      expect(reopened.countItems()).toBe(1);
      expect(reopened.getCursor('slack')).toBe(recent);
    } finally {
      await reopened.close();
    }
  });
});

describe('InboxCursorStore retention', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  test('the age TTL sweep runs at init and reclaims stale rows', async () => {
    const now = Date.now();
    await seedInboxRows(store, [
      item({ id: 'stale', receivedAt: now - 40 * DAY_MS }),
      item({ id: 'recent', receivedAt: now - 1 * DAY_MS }),
    ]);
    await store.close();

    const sweeps: InboxSweepSummary[] = [];
    const reopened = new InboxCursorStore(dir, undefined, {
      onSweep: (summary) => sweeps.push(summary),
    });
    await reopened.init();
    try {
      expect(reopened.listItems({ limit: 10 }).map((i) => i.id)).toEqual(['recent']);
      // Disclosure carries the right counts.
      expect(sweeps).toHaveLength(1);
      expect(sweeps[0]).toMatchObject({ expired: 1, capped: 0, remaining: 1 });
      // Cursors are monotonic watermarks and are never reaped.
      expect(reopened.getCursor('slack')).toBe(now - 1 * DAY_MS);
    } finally {
      await reopened.close();
    }
  });

  test('the count cap keeps the newest rows and drops the rest', async () => {
    const now = Date.now();
    const capped = new InboxCursorStore(dir, 'cap.sqlite', { itemCap: 3 });
    await capped.init();
    try {
      await seedInboxRows(capped, [
        item({ id: 'i0', receivedAt: now - 5_000 }),
        item({ id: 'i1', receivedAt: now - 4_000 }),
        item({ id: 'i2', receivedAt: now - 3_000 }),
        item({ id: 'i3', receivedAt: now - 2_000 }),
        item({ id: 'i4', receivedAt: now - 1_000 }),
      ]);
      const summary = capped.sweepRetention();
      expect(summary).toMatchObject({ expired: 0, capped: 2, remaining: 3 });
      expect(capped.listItems({ limit: 10 }).map((i) => i.id)).toEqual(['i4', 'i3', 'i2']);
    } finally {
      await capped.close();
    }
  });

  test('sweeping twice reclaims nothing the second time', async () => {
    const now = Date.now();
    const swept = new InboxCursorStore(dir, 'idempotent.sqlite', { itemCap: 2 });
    await swept.init();
    try {
      await seedInboxRows(swept, [
        item({ id: 'a', receivedAt: now - 40 * DAY_MS }),
        item({ id: 'b', receivedAt: now - 3_000 }),
        item({ id: 'c', receivedAt: now - 2_000 }),
        item({ id: 'd', receivedAt: now - 1_000 }),
      ]);
      const first = swept.sweepRetention();
      expect(first).toMatchObject({ expired: 1, capped: 1, remaining: 2 });
      const second = swept.sweepRetention();
      expect(second).toMatchObject({ expired: 0, capped: 0, remaining: 2 });
      expect(swept.listItems({ limit: 10 }).map((i) => i.id)).toEqual(['d', 'c']);
    } finally {
      await swept.close();
    }
  });

  test('the sweep keeps running on a timer, not only at startup', async () => {
    const now = Date.now();
    let tick: (() => void) | null = null;
    const sweeps: InboxSweepSummary[] = [];
    const timed = new InboxCursorStore(dir, 'timed.sqlite', {
      itemCap: 1,
      sweepIntervalMs: 1_000,
      onSweep: (summary) => sweeps.push(summary),
      setIntervalImpl: ((fn: () => void) => {
        tick = fn;
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    await timed.init();
    try {
      // Nothing to reclaim at init, so the timer is what must catch this.
      expect(sweeps).toHaveLength(0);
      await seedInboxRows(timed, [
        item({ id: 'x', receivedAt: now - 2_000 }),
        item({ id: 'y', receivedAt: now - 1_000 }),
      ]);
      expect(tick).not.toBeNull();
      tick!();
      // The timer callback is async (it flushes), so wait for the sweep it
      // produces rather than sleeping a fixed 20 ms and hoping. 20 ms is a
      // number only an idle machine can promise for a flush that touches the
      // database; under a concurrent load this read `Expected length: 1 /
      // Received length: 0` while the sweep was simply still in flight. The
      // poll returns the moment the sweep is recorded, so a fast host pays
      // nothing, and a sweep that never happens still fails.
      const sweepDeadline = Date.now() + 30_000;
      while (sweeps.length === 0) {
        if (Date.now() > sweepDeadline) {
          throw new Error('the retention timer never produced a sweep within 30000ms');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(timed.countItems()).toBe(1);
      expect(sweeps).toHaveLength(1);
      expect(sweeps[0]).toMatchObject({ capped: 1, remaining: 1 });
    } finally {
      await timed.close();
    }
  });

  test('a sweep over an empty table discloses nothing', async () => {
    const sweeps: InboxSweepSummary[] = [];
    const quiet = new InboxCursorStore(dir, 'quiet.sqlite', {
      onSweep: (summary) => sweeps.push(summary),
    });
    await quiet.init();
    try {
      expect(sweeps).toHaveLength(0);
      expect(quiet.sweepRetention()).toMatchObject({ expired: 0, capped: 0, remaining: 0 });
    } finally {
      await quiet.close();
    }
  });

  test('a store closed while init() is still in flight never arms the retention timer', async () => {
    // registerInboxMethods() starts init() without awaiting it, so a daemon
    // told to stop inside the first tick of its life closes the store while its
    // bootstrap is mid-await. init() then reached startSweepTimer() AFTER the
    // only call that could clear it had already run, and the sweep ticked for
    // the life of the process with no owner left to stop it.
    const armed: number[] = [];
    const cleared: number[] = [];
    const racing = new InboxCursorStore(dir, 'racing.sqlite', {
      sweepIntervalMs: 1_000,
      setIntervalImpl: ((_fn: () => void, ms: number) => {
        armed.push(ms);
        return armed.length as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearIntervalImpl: ((handle: number) => {
        cleared.push(handle);
      }) as unknown as typeof clearInterval,
    });

    const booting = racing.init();
    await racing.close();
    await booting;

    expect(armed).toEqual([]);
    expect(cleared).toEqual([]);
  });
});
