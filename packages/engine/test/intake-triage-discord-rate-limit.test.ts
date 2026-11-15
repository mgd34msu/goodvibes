/**
 * Discord rate-limits reaction adds on one message; a tagging pass waits the
 * asked time once and says how far it got when it cannot finish.
 */
import { expect, test } from 'bun:test';
import { applyDiscordTags } from '../platform/src/platform/intake/triage/tagger/discord.js';

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
const both = ['GoodVibes/Spam', 'GoodVibes/Priority'] as const;
const limited = (retryAfter: string) => new Response(null, { status: 429, headers: { 'retry-after': retryAfter } });

test('a reaction refused for rate limiting is sent again once after the asked wait', async () => {
  const f = http([new Response(null, { status: 204 }), limited('0'), new Response(null, { status: 204 })]);
  await applyDiscordTags(target, both, 'synthetic', guard(), {}, f.fetcher);
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'PUT', 'PUT']);
  expect(f.calls[1]!.url).toBe(f.calls[2]!.url);
});

test('a limit that persists reports how many reactions were applied', async () => {
  const f = http([new Response(null, { status: 204 }), limited('0'), limited('0')]);
  await expect(applyDiscordTags(target, both, 'synthetic', guard(), {}, f.fetcher)).rejects.toThrow('after 1 of 2 applied');
});

test('a wait longer than a tagging pass should hold is not slept on', async () => {
  const f = http([limited('600')]);
  await expect(applyDiscordTags(target, ['GoodVibes/Spam'], 'synthetic', guard(), {}, f.fetcher)).rejects.toThrow('rate-limited');
  expect(f.calls).toHaveLength(1);
});
