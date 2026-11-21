// Proves: The Slack inbox loses messages: conversations beyond a page budget are never read, a failure discards what a tick already read, or a message that screening could not look at is passed over or shown unscreened.
// Red when: Conversations after the first pages are never polled, a rate limit discards a tick's reads or advances an unread conversation, or a held message is shown in the clear or passed by the cursor unscreened.
/**
 * Slack and Discord inboxes keep one cursor per conversation and lose nothing:
 * a large account is read whole across ticks, a failure keeps what the tick
 * already read, the cursor never passes a message screening could not look at,
 * and a message screening holds is published as withheld instead of stopping
 * the inbox. The providers are scripted at their HTTP answers.
 */
import { expect, test } from 'bun:test';
import { createSlackInboxAdapter, type SlackInboxHttp } from '../platform/src/platform/intake/providers/slack.ts';
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

test('a poll whose messages were never stored gives the same messages again; once stored, the next one follows', async () => {
  const fake = slack(['D1'], () => ({ ok: true, body: { ok: true, has_more: false, messages: [
    { ts: ts(NOW - 2_000), user: 'U-FRIEND', text: 'second' },
    { ts: ts(NOW - 3_000), user: 'U-FRIEND', text: 'first' },
  ] } }));
  const adapter = createSlackInboxAdapter(context('xoxb-fixture'), { http: fake.http, mapItem: async input => mapped(input.text), now: () => NOW });
  const stored = new Map([['D1', NOW - 10_000]]);
  const taken = await adapter.poll({ limit: 1, conversations: stored });
  expect(taken.items.map(item => item.bodyPreview)).toEqual(['first']);
  // The poller's commit failed: the stored cursor did not move, so the next tick must hand 'first' over again.
  const again = await adapter.poll({ limit: 1, conversations: stored });
  expect(again.items.map(item => item.bodyPreview)).toEqual(['first']);
  const committed = await adapter.poll({ limit: 1, conversations: new Map([['D1', again.conversationAdvance!.D1!]]) });
  expect(committed.items.map(item => item.bodyPreview)).toEqual(['second']);
});
