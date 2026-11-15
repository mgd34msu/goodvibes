/**
 * calendar-subscription-feed-safety.test.ts, a feed address is an outward
 * request to a public host, and one subscription cannot overwrite another.
 *
 * No test here touches a network: the fetcher is given an injected `send`, and
 * the refusals under test happen before any request is made.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedFetcher, FeedFetchResult } from '@goodvibes-jev/engine/platform/platform/calendar';
import {
  CalendarSubscriptionRegistry,
  createHttpFeedFetcher,
  type SubscriptionSecretStore,
} from '../../agent/calendar-subscription-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const ics = (uid: string, summary: string): string => [
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
  'DTSTART:20260706T090000Z', 'DTEND:20260706T093000Z', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmpStore = (): string => {
  const dir = makeProjectTempDir('gv-cal-safety'); dirs.push(dir);
  return join(dir, 'subscriptions.json');
};

function memorySecrets(failDelete = false): { store: Map<string, string>; secrets: SubscriptionSecretStore } {
  const store = new Map<string, string>();
  return { store, secrets: {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, v); },
    delete: async (k) => { if (failDelete) throw new Error('keyring locked'); store.delete(k); },
  } };
}

const ok = (body: string): FeedFetchResult => ({ kind: 'ok', body });
const fetchReq = (url: string) => ({ url });

describe('createHttpFeedFetcher refuses what is not a public https feed, before any request', () => {
  for (const url of ['file:///etc/hostname', 'http://127.0.0.1:1/feed.ics', 'ftp://example.test/a.ics', 'not a url']) {
    test(`refuses ${url}`, async () => {
      let sent = 0;
      const fetcher = createHttpFeedFetcher({ send: async () => { sent += 1; return new Response('x'); } });

      const result = await fetcher(fetchReq(url));

      expect(result.kind).toBe('error');
      expect(sent).toBe(0);
    });
  }

  test('a loopback or private address is refused by the platform check even over https', async () => {
    const result = await createHttpFeedFetcher()(fetchReq('https://127.0.0.1:1/feed.ics'));
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('Feed URL') });
  });

  test('webcal is fetched as https', async () => {
    const seen: string[] = [];
    const fetcher = createHttpFeedFetcher({ send: async (url) => { seen.push(url); return new Response('BEGIN:VCALENDAR'); } });

    const result = await fetcher(fetchReq('webcal://cal.example.test/a.ics'));

    expect(result.kind).toBe('ok');
    expect(seen).toEqual(['https://cal.example.test/a.ics']);
  });

  test('a redirect to a non-https or internal target is refused at that hop', async () => {
    const seen: string[] = [];
    const fetcher = createHttpFeedFetcher({
      send: async (url) => {
        seen.push(url);
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      },
    });

    const result = await fetcher(fetchReq('https://cal.example.test/a.ics'));

    expect(result.kind).toBe('error');
    expect(seen).toEqual(['https://cal.example.test/a.ics']);
  });

  test('a redirect between public https hosts is followed', async () => {
    const seen: string[] = [];
    const fetcher = createHttpFeedFetcher({
      send: async (url) => {
        seen.push(url);
        return seen.length === 1
          ? new Response(null, { status: 301, headers: { location: 'https://cdn.example.test/b.ics' } })
          : new Response('BEGIN:VCALENDAR');
      },
    });

    const result = await fetcher(fetchReq('https://cal.example.test/a.ics'));

    expect(result.kind).toBe('ok');
    expect(seen).toEqual(['https://cal.example.test/a.ics', 'https://cdn.example.test/b.ics']);
  });

  test('a body larger than the cap is refused, not buffered', async () => {
    const fetcher = createHttpFeedFetcher({ maxBytes: 100, send: async () => new Response('x'.repeat(500)) });

    const result = await fetcher(fetchReq('https://cal.example.test/a.ics'));

    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('larger than') });
  });

  test('a host that never answers returns an error when its time runs out', async () => {
    const fetcher = createHttpFeedFetcher({
      timeoutMs: 1,
      send: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    });

    const result = await fetcher(fetchReq('https://cal.example.test/a.ics'));

    expect(result.kind).toBe('error');
  });
});

describe('subscription names that share a stored address', () => {
  test('"work" is refused when "Work" is subscribed, and the first feed address is untouched', async () => {
    const { store, secrets } = memorySecrets();
    const fetcher: FeedFetcher = async () => ok(ics('e1', 'Standup'));
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher });
    expect((await reg.subscribe('https://a.example.test/a.ics', 'Work')).ok).toBe(true);

    const second = await reg.subscribe('https://b.example.test/b.ics', 'work');

    expect(second).toMatchObject({ ok: false, stage: 'duplicate' });
    expect([...store.values()]).toEqual(['https://a.example.test/a.ics']);
  });

  test('names that differ only by punctuation, which map to one secret key, are refused', async () => {
    const { secrets } = memorySecrets();
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: async () => ok(ics('e1', 'x')) });
    await reg.subscribe('https://a.example.test/a.ics', 'work-cal');

    const second = await reg.subscribe('https://b.example.test/b.ics', 'work_cal');

    expect(second).toMatchObject({ ok: false, stage: 'duplicate' });
  });
});

describe('refresh does not overwrite a subscription re-created under the same name', () => {
  test('the new feed\'s events survive a refresh of the old one that finished late', async () => {
    const { secrets } = memorySecrets();
    let tick = 1000;
    let releaseOld: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldFetches = 0;
    const fetcher: FeedFetcher = async (req) => {
      if (req.url.endsWith('/old.ics')) {
        oldFetches += 1;
        if (oldFetches === 2) await gate; // the refresh, not the first subscribe
        return ok(ics('old', 'Old feed event'));
      }
      return ok(ics('new', 'New feed event'));
    };
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher, clock: () => (tick += 10) });
    await reg.subscribe('https://a.example.test/old.ics', 'a');

    const refreshing = reg.refresh('a');
    for (let i = 0; i < 20 && oldFetches < 2; i += 1) await Promise.resolve();
    expect(await reg.unsubscribe('a')).toBe(true);
    await reg.subscribe('https://a.example.test/new.ics', 'a');
    releaseOld();
    await refreshing;

    expect(reg.seeds().map((s) => s.title)).toEqual(['New feed event']);
  });
});

describe('unsubscribe reports what became of the stored address', () => {
  test('a secret store that refuses the delete is named, not swallowed', async () => {
    const { secrets } = memorySecrets(true);
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: async () => ok(ics('e1', 'x')) });
    await reg.subscribe('https://a.example.test/a.ics', 'Work');

    const report = await reg.unsubscribeWithReport('Work');

    expect(report).toMatchObject({ removed: true, secret: 'failed', secretKey: 'GOODVIBES_CALENDAR_SUB_WORK', secretError: 'keyring locked' });
    expect(reg.hasAny()).toBe(false);
  });

  test('a delete that worked says so', async () => {
    const { store, secrets } = memorySecrets();
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: async () => ok(ics('e1', 'x')) });
    await reg.subscribe('https://a.example.test/a.ics', 'Work');

    expect((await reg.unsubscribeWithReport('Work')).secret).toBe('deleted');
    expect(store.size).toBe(0);
  });
});

describe('a feed on the owner\'s own network needs the per-feed opt-in', () => {
  const lanUrl = 'https://192.168.1.20/cal.ics';
  const publicOnly: FeedFetcher = async () => ({ kind: 'error', message: 'Feed URL resolves to a private address' });

  test('without the opt-in the subscription is refused; with it the private-host fetcher is used, now and on every refresh', async () => {
    const { secrets } = memorySecrets();
    const used: string[] = [];
    const privateHostFetcher: FeedFetcher = async (req) => { used.push(req.url); return ok(ics('e1', 'Standup')); };
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: publicOnly, privateHostFetcher });

    expect(await reg.subscribe(lanUrl, 'Home')).toMatchObject({ ok: false, stage: 'fetch' });
    expect(used).toEqual([]);

    expect((await reg.subscribe(lanUrl, 'Home', undefined, { allowPrivateHost: true })).ok).toBe(true);
    expect((await reg.statuses())[0]).toMatchObject({ name: 'Home', allowPrivateHost: true });
    const refreshed = await reg.refresh('Home');

    expect(refreshed[0]!.outcome).toBe('updated');
    expect(used).toEqual([lanUrl, lanUrl]);
  });

  test('createHttpFeedFetcher with allowPrivateHosts reaches a private https address and still refuses http', async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => { seen.push(String(url)); return new Response('BEGIN:VCALENDAR'); }) as typeof fetch;
    try {
      const fetcher = createHttpFeedFetcher({ allowPrivateHosts: true });

      expect((await fetcher(fetchReq(lanUrl))).kind).toBe('ok');
      expect((await fetcher(fetchReq('http://192.168.1.20/cal.ics'))).kind).toBe('error');
      expect(seen).toEqual([lanUrl]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
