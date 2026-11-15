/**
 * Discord rate-limits reaction changes on one message; a label write waits the
 * asked time once and says, per label, how far it got when it cannot finish.
 */
import { expect, test } from 'bun:test';
import { applyDiscordTagEffects } from '../platform/src/platform/intake/triage/tagger/discord.js';

function http(responses: Response[]) {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next;
  }) as typeof fetch;
  return { calls, fetcher };
}
const guard = () => ({ signal: new AbortController().signal, assertCurrent() {} });
const target = { channel: '123', message: '234' };
const both = [{ name: 'GoodVibes/Spam', reaction: '🚫' }, { name: 'GoodVibes/Priority', reaction: '🚨' }];
const message = () => Response.json({ id: '234', reactions: [] });
const limited = (retryAfter: string) => new Response(null, { status: 429, headers: { 'retry-after': retryAfter } });

test('a reaction refused for rate limiting is sent again once after the asked wait', async () => {
  const f = http([message(), new Response(null, { status: 204 }), limited('0'), new Response(null, { status: 204 })]);
  const write = await applyDiscordTagEffects(target, both, [], 'synthetic', guard(), {}, f.fetcher);
  expect(f.calls.map(call => call.method ?? 'GET')).toEqual(['GET', 'PUT', 'PUT', 'PUT']);
  expect(f.calls[2]!.url).toBe(f.calls[3]!.url);
  expect(write.effects.map(effect => effect.outcome)).toEqual(['applied', 'applied']);
});

test('a limit that persists leaves the first label applied and the second failed', async () => {
  const f = http([message(), new Response(null, { status: 204 }), limited('0'), limited('0')]);
  const write = await applyDiscordTagEffects(target, both, [], 'synthetic', guard(), {}, f.fetcher);
  expect(write.effects.map(effect => effect.outcome)).toEqual(['applied', 'failed']);
});

test('a wait longer than a label write should hold is not slept on', async () => {
  const f = http([message(), limited('600')]);
  const write = await applyDiscordTagEffects(target, [both[0]!], [], 'synthetic', guard(), {}, f.fetcher);
  expect(f.calls).toHaveLength(2);
  expect(write.effects.map(effect => effect.outcome)).toEqual(['failed']);
});
