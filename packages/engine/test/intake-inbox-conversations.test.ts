/**
 * Slack and Discord inboxes keep one cursor per conversation: a large account
 * is read across ticks, a failure keeps what the tick already read, the
 * owner's own messages are not inbound, and a message screening holds is
 * published as withheld instead of stopping the inbox.
 */
import { expect, test } from 'bun:test';
import { createSlackInboxAdapter, type SlackInboxHttp } from '../platform/src/platform/intake/providers/slack.ts';
import { createDiscordInboxAdapter, type DiscordInboxHttp } from '../platform/src/platform/intake/providers/discord.ts';
import { WITHHELD_PREVIEW_TEXT, type ProtectedInboxPreview } from '../platform/src/platform/intake/protected-preview.ts';
import type { AdapterContext } from '../platform/src/platform/intake/provider-adapter.ts';

const NOW = 1_800_000_000_000;
const context = (token: string): AdapterContext => ({ logger: { info() {}, warn() {}, error() {} },
  credentials: { resolveRef: async () => null, resolveConfigSecret: async () => token } });
const ts = (ms: number) => `${String(Math.floor(ms / 1000))}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
const mapped = (text: string): ProtectedInboxPreview => ({ status: 'mapped', fields: { fromDigest: '0123456789abcdef', subjectPreview: 'Direct message', bodyPreview: text } });

function slack(conversations: readonly string[], history: (channel: string) => Awaited<ReturnType<SlackInboxHttp>>) {
  const calls: string[] = [];
  const http: SlackInboxHttp = async url => {
    const method = url.pathname.slice('/api/'.length);
    calls.push(method === 'conversations.history' ? `history:${url.searchParams.get('channel')}` : method);
    if (method === 'auth.test') return { ok: true, body: { ok: true, user_id: 'U-SELF' } };
    if (method === 'conversations.list') {
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const page = conversations.slice(start, start + 100);
      return { ok: true, body: { ok: true, channels: page.map(id => ({ id, user: `U-${id}` })),
        response_metadata: { next_cursor: start + 100 < conversations.length ? String(start + 100) : '' } } };
    }
    return history(url.searchParams.get('channel')!);
  };
  return { http, calls };
}

test('201 quiet Slack conversations are all read over a few ticks, never failing on a page budget', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => `D${String(i).padStart(4, '0')}`);
  const fake = slack(ids, () => ({ ok: true, body: { ok: true, messages: [], has_more: false } }));
  const adapter = createSlackInboxAdapter(context('xoxb-fixture'), { http: fake.http, mapItem: async () => mapped('x'), now: () => NOW });
  for (let tick = 0; tick < 6; tick += 1) {
    const result = await adapter.poll({ limit: 50 });
    expect(result.state).toBe('empty');
    expect(result.error).toBeUndefined();
  }
  // The account and its conversations were read once, not on every tick.
  expect(fake.calls.filter(call => call === 'auth.test')).toHaveLength(1);
  expect(new Set(fake.calls.filter(call => call.startsWith('history:'))).size).toBe(201);
});

test('a rate limit keeps what the tick read and says when the next attempt is', async () => {
  const fake = slack(['D1', 'D2'], channel => channel === 'D1'
    ? { ok: true, body: { ok: true, has_more: false, messages: [{ ts: ts(NOW - 5_000), user: 'U-FRIEND', text: 'hello' }] } }
    : { ok: false, reason: 'rate-limited', retryAt: NOW + 60_000 });
  const adapter = createSlackInboxAdapter(context('xoxb-fixture'), { http: fake.http, mapItem: async input => mapped(input.text), now: () => NOW });
  const result = await adapter.poll({ limit: 50 });
  expect(result.state).toBe('unavailable');
  expect(result.items.map(item => item.bodyPreview)).toEqual(['hello']);
  expect(Object.keys(result.conversationAdvance ?? {})).toEqual(['D1']);
  expect(result.error).toContain('rate limiting');
  expect(result.error).toContain('next attempt is at');
});

test("with a user token the owner's own messages are not read back as inbound", async () => {
  const fake = slack(['D1'], () => ({ ok: true, body: { ok: true, has_more: false, messages: [
    { ts: ts(NOW - 2_000), user: 'U-SELF', text: 'my own reply', reactions: [{ name: 'eyes' }] },
    { ts: ts(NOW - 1_000), user: 'U-FRIEND', text: 'their message' },
  ] } }));
  const adapter = createSlackInboxAdapter(context('xoxp-fixture'), { http: fake.http, mapItem: async input => mapped(input.text), now: () => NOW });
  const result = await adapter.poll({ limit: 50 });
  expect(result.items.map(item => [item.bodyPreview, item.kind])).toEqual([['their message', 'dm']]);
});

test('a message screening holds is published as withheld and the conversation moves past it', async () => {
  const fake = slack(['D1'], () => ({ ok: true, body: { ok: true, has_more: false, messages: [
    { ts: ts(NOW - 3_000), user: 'U-FRIEND', text: 'first' },
    { ts: ts(NOW - 2_000), user: 'U-FRIEND', text: 'held' },
    { ts: ts(NOW - 1_000), user: 'U-FRIEND', text: 'third' },
  ] } }));
  const adapter = createSlackInboxAdapter(context('xoxb-fixture'), { http: fake.http, now: () => NOW,
    mapItem: async input => input.text === 'held'
      ? { status: 'withheld', fields: { fromDigest: '0123456789abcdef', subjectPreview: 'Withheld message', bodyPreview: WITHHELD_PREVIEW_TEXT } }
      : mapped(input.text) });
  const result = await adapter.poll({ limit: 50 });
  expect(result.state).toBe('ready');
  expect(result.items.map(item => item.bodyPreview)).toEqual(['first', WITHHELD_PREVIEW_TEXT, 'third']);
  expect(result.conversationAdvance?.D1).toBe(NOW - 1_000);
});

test('when screening cannot run, the conversation keeps what was screened and stops before the rest', async () => {
  const fake = slack(['D1'], () => ({ ok: true, body: { ok: true, has_more: false, messages: [
    { ts: ts(NOW - 3_000), user: 'U-FRIEND', text: 'first' },
    { ts: ts(NOW - 2_000), user: 'U-FRIEND', text: 'second' },
  ] } }));
  const adapter = createSlackInboxAdapter(context('xoxb-fixture'), { http: fake.http, now: () => NOW,
    mapItem: async input => input.text === 'second' ? { status: 'unavailable' } : mapped(input.text) });
  const result = await adapter.poll({ limit: 50 });
  expect(result.state).toBe('unavailable');
  expect(result.items.map(item => item.bodyPreview)).toEqual(['first']);
  expect(result.conversationAdvance?.D1).toBe(NOW - 2_000 - 1);
});

test('one unreadable Discord channel is named; the other configured channel is still read', async () => {
  const http: DiscordInboxHttp = async url => {
    if (url.pathname === '/api/v10/users/@me') return { ok: true, body: { id: '100000000000000001', bot: true } };
    return { ok: true, body: [{ id: String((BigInt(NOW - 1_000 - 1_420_070_400_000) << 22n) + 1n), channel_id: '100000000000000010',
      author: { id: '100000000000000777' }, content: 'hi there' }] };
  };
  const adapter = createDiscordInboxAdapter(context('fixture-token'), { http, now: () => NOW, mapItem: async input => mapped(input.text),
    listDmChannels: async () => ({ accountId: '100000000000000001', channels: [{ id: '100000000000000010', type: 1 }],
      unreadable: [{ id: '100000000000000020', reason: 'denied' }] }) });
  const result = await adapter.poll({ limit: 50 });
  expect(result.items.map(item => item.bodyPreview)).toEqual(['hi there']);
  expect(result.state).toBe('unavailable');
  expect(result.error).toContain('100000000000000020');
  expect(result.error).toContain('surfaces.discord.inboxChannelIds');
});
