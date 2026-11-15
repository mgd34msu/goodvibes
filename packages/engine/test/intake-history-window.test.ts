import { expect, test } from 'bun:test';
import { createSlackInboxAdapter } from '../platform/src/platform/intake/providers/slack.ts';
import { createDiscordInboxAdapter } from '../platform/src/platform/intake/providers/discord.ts';
import type { AdapterContext } from '../platform/src/platform/intake/provider-adapter.ts';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const SEED = 30 * DAY;
const COUNT = 1_200;
/** Message times (ms), oldest first, spread evenly across the 30 day seed window. */
const times = Array.from({ length: COUNT }, (_, index) => NOW - SEED + Math.floor((index + 1) * (SEED - DAY) / COUNT));
const ctx: AdapterContext = {
  credentials: { resolveRef: async () => null, resolveConfigSecret: async () => 'xoxb-synthetic-token' },
  logger: { info() {}, warn() {}, error() {} },
};
const mapItem = () => ({ fromDigest: 'ffffffffffffffff', subjectPreview: 'Subject', bodyPreview: 'Body' });
const slackTs = (ms: number) => `${Math.floor(ms / 1_000)}.${String((ms % 1_000) * 1_000).padStart(6, '0')}`;

function slack(quiet = 0) {
  const histories: { oldest: number; latest: number }[] = [];
  const adapter = createSlackInboxAdapter(ctx, { now: () => NOW, mapItem, http: async url => {
    const method = url.pathname.slice('/api/'.length);
    if (method === 'auth.test') return { ok: true, body: { ok: true, user_id: 'USELF' } };
    if (method === 'conversations.list') {
      const all = [...Array.from({ length: quiet }, (_, index) => ({ id: `DQ${index}`, user: 'UQUIET' })), { id: 'D1', user: 'UPARTNER' }];
      const start = Number(url.searchParams.get('cursor') ?? '0');
      const more = start + 100 < all.length;
      return { ok: true, body: { ok: true, channels: all.slice(start, start + 100), ...(more ? { response_metadata: { next_cursor: String(start + 100) } } : {}) } };
    }
    const oldest = Number(url.searchParams.get('oldest') ?? '0') * 1_000, latest = Number(url.searchParams.get('latest')) * 1_000;
    if (!url.searchParams.has('cursor')) histories.push({ oldest, latest });
    if (url.searchParams.get('channel') !== 'D1') return { ok: true, body: { ok: true, messages: [], has_more: false } };
    // Newest first, 50 per page, cursor is the offset.
    const inside = times.filter(time => time > oldest && time < latest).reverse();
    const offset = Number(url.searchParams.get('cursor') ?? '0');
    const page = inside.slice(offset, offset + 50);
    const more = offset + 50 < inside.length;
    return { ok: true, body: { ok: true, messages: page.map(time => ({ ts: slackTs(time), user: 'UPARTNER', text: 'hello' })), has_more: more,
      ...(more ? { response_metadata: { next_cursor: String(offset + 50) } } : {}) } };
  } });
  return { adapter, histories };
}

test('a first Slack poll starts at a bounded seed window and narrows past a conversation too busy for it', async () => {
  const f = slack();
  const result = await f.adapter.poll({ limit: 5 });
  expect(result.state).toBe('ready');
  expect(result.items).toHaveLength(5);
  // The oldest complete prefix: the five oldest messages of the whole seed window.
  expect(result.items.map(item => item.receivedAt)).toEqual(times.slice(0, 5).map(time => Math.floor(time / 1_000) * 1_000 + Math.round((time % 1_000))));
  const first = f.histories[0]!;
  expect(first.oldest).toBe(NOW - SEED);
  // 1,200 messages exceed the per-conversation page cap, so a narrower window finished the scan.
  expect(f.histories.some(window => window.latest < first.latest)).toBe(true);
});

test('a Slack poll with many quiet conversations ahead of a busy one still narrows to a ready result', async () => {
  const f = slack(120);
  const result = await f.adapter.poll({ limit: 5 });
  expect(result.state).toBe('ready');
  expect(result.items).toHaveLength(5);
});

test('a Slack poll with a cursor never reaches behind it', async () => {
  const f = slack();
  const since = times[100]!;
  const result = await f.adapter.poll({ limit: 3, since });
  expect(result.state).toBe('ready');
  expect(result.items.every(item => item.receivedAt > since)).toBe(true);
  expect(f.histories.every(window => window.oldest === since)).toBe(true);
});

const EPOCH_MS = 1_420_070_400_000;
const snowflake = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();
test('a Discord poll with no cursor stops at the seed window instead of paging a DM from its first message', async () => {
  const requested: bigint[] = [];
  const adapter = createDiscordInboxAdapter({ ...ctx, credentials: { resolveRef: async () => null, resolveConfigSecret: async () => 'synthetic-token' } }, {
    now: () => NOW, mapItem,
    listDmChannels: async input => ({ complete: true, accountId: input.selfId, channels: [{ id: '100000000000000002', type: 1 }] }),
    http: async url => {
      if (url.pathname === '/api/v10/users/@me') return { ok: true, body: { id: '100000000000000001' } };
      const before = BigInt(url.searchParams.get('before')!);
      requested.push(before);
      const inside = times.map(time => ({ time, id: snowflake(time) })).filter(entry => BigInt(entry.id) < before).reverse().slice(0, 50);
      return { ok: true, body: inside.map(entry => ({ id: entry.id, channel_id: '100000000000000002', author: { id: '100000000000000003' }, content: 'hello' })) };
    } });
  const result = await adapter.poll({ limit: 5 });
  expect(result.state).toBe('ready');
  expect(result.items).toHaveLength(5);
  expect(result.items[0]!.receivedAt).toBeGreaterThan(NOW - SEED);
  expect(result.items[0]!.receivedAt).toBe(Number(BigInt(snowflake(times[0]!)) >> 22n) + EPOCH_MS);
});

test('a Discord poll with many quiet conversations ahead of a busy one still narrows to a ready result', async () => {
  const quiet = Array.from({ length: 120 }, (_, index) => ({ id: String(100000000000001000n + BigInt(index)), type: 1 as const }));
  const busy = '100000000000000002';
  const adapter = createDiscordInboxAdapter({ ...ctx, credentials: { resolveRef: async () => null, resolveConfigSecret: async () => 'synthetic-token' } }, {
    now: () => NOW, mapItem,
    listDmChannels: async input => ({ complete: true, accountId: input.selfId, channels: [...quiet, { id: busy, type: 1 as const }] }),
    http: async url => {
      if (url.pathname === '/api/v10/users/@me') return { ok: true, body: { id: '100000000000000001' } };
      if (!url.pathname.includes(`/channels/${busy}/`)) return { ok: true, body: [] };
      const before = BigInt(url.searchParams.get('before')!);
      const inside = times.map(time => ({ time, id: snowflake(time) })).filter(entry => BigInt(entry.id) < before).reverse().slice(0, 50);
      return { ok: true, body: inside.map(entry => ({ id: entry.id, channel_id: busy, author: { id: '100000000000000003' }, content: 'hello' })) };
    } });
  const result = await adapter.poll({ limit: 5 });
  expect(result.state).toBe('ready');
  expect(result.items).toHaveLength(5);
});
