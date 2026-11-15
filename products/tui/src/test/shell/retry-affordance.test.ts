// A sentence typed after an error or a started fix session goes where it was
// typed: only the Alt chords run the offered action, and only while it is on
// offer.
import { describe, expect, test } from 'bun:test';
import { actionHint, createShellActionOffers, handleShellActionChord } from '../../shell/retry-affordance.ts';

function harness() {
  const offers = createShellActionOffers();
  const calls = { retry: 0, opened: [] as string[] };
  const deps = { retry: () => { calls.retry += 1; }, openSession: (id: string) => { calls.opened.push(id); }, render: () => {} };
  return { offers, calls, route: (data: string) => handleShellActionChord(data, offers, deps) };
}

describe('shell action chords', () => {
  test('plain r, m and j are never consumed, even with both actions on offer', () => {
    const { offers, calls, route } = harness();
    offers.retry = { exhausted: false };
    offers.fixSessionId = 'fix-1';
    for (const key of ['r', 'm', 'j', 'run it again', '\r']) expect(route(key)).toBe(false);
    expect(calls).toEqual({ retry: 0, opened: [] });
    expect(actionHint(offers)).not.toBeNull();
  });

  test('Alt+R retries once in either terminal encoding; Alt+J opens the offered session once', () => {
    const { offers, calls, route } = harness();
    offers.retry = { exhausted: true };
    expect(route('\x1b[114;3u')).toBe(true);
    expect(route('\x1br')).toBe(false); // the offer was used
    offers.retry = { exhausted: false };
    expect(route('\x1br')).toBe(true);
    offers.fixSessionId = 'fix-2';
    expect(route('\x1bj')).toBe(true);
    expect(route('\x1b[106;3u')).toBe(false);
    expect(calls).toEqual({ retry: 2, opened: ['fix-2'] });
    expect(actionHint(offers)).toBeNull();
  });
});
