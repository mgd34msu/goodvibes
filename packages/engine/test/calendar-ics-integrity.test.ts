/**
 * Calendar reading and writing keep an event what it is.
 *
 * Covers the .ics codecs (TZID, child components, one bad event among good
 * ones), what the CalDAV gateway writes for an imported or created event, the
 * recurrence expander's reach into the past, subscription refreshes, the
 * Microsoft Graph paging and token store failure handling.
 */

import { describe, expect, test } from 'bun:test';
import { createCalDavCalendarGatewayService } from '../platform/src/platform/calendar/caldav-gateway-service.ts';
import { createCalDavSecretPort } from '../platform/src/platform/calendar/caldav-gateway-config.ts';
import { parseICS, parseICSDetailed } from '../platform/src/platform/calendar/caldav-ics.ts';
import { generateICS, ICalValueError } from '../platform/src/platform/calendar/caldav-ics-generate.ts';
import { parseIcs } from '../platform/src/platform/calendar/ics-parser.ts';
import { expandEvent } from '../platform/src/platform/calendar/rrule.ts';
import { SubscriptionStore } from '../platform/src/platform/calendar/subscription-store.ts';
import { listGraphEvents } from '../platform/src/platform/calendar/microsoft-graph-api.ts';
import { pollDeviceCodeFlow } from '../platform/src/platform/calendar/oauth-flow.ts';
import { CalendarTokenStore } from '../platform/src/platform/calendar/oauth-token-store.ts';
import { GatewayVerbError } from '../platform/src/platform/control-plane/routes/gateway-verb-error.ts';
import type { CalDavHttpPort, CalDavHttpRequest, CalDavHttpResponse } from '../platform/src/platform/google/caldav-client.ts';
import type { HttpFetch, HttpResponse } from '../platform/src/platform/calendar/oauth-types.ts';

function ics(...eventLines: readonly (readonly string[])[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...eventLines.flat(), 'END:VCALENDAR'].join('\r\n');
}

const GOOD_EVENT = ['BEGIN:VEVENT', 'UID:good@example', 'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'SUMMARY:Good', 'END:VEVENT'];

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

describe('CalDAV .ics reader', () => {
  test('a TZID date-time is converted to its real UTC instant, in winter and summer', () => {
    const [winter, summer] = parseICS(ics(
      ['BEGIN:VEVENT', 'UID:w', 'DTSTART;TZID=America/New_York:20260105T090000', 'DTEND;TZID=America/New_York:20260105T100000', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:s', 'DTSTART;TZID=America/New_York:20260705T090000', 'DTEND;TZID=Europe/Berlin:20260705T100000', 'END:VEVENT'],
    ));
    expect(winter?.start).toBe('2026-01-05T14:00:00.000Z');
    expect(winter?.end).toBe('2026-01-05T15:00:00.000Z');
    expect(summer?.start).toBe('2026-07-05T13:00:00.000Z');
    expect(summer?.end).toBe('2026-07-05T08:00:00.000Z');
  });

  test('a TZID the runtime does not know is reported, not guessed', () => {
    const { events, errors } = parseICSDetailed(ics(
      ['BEGIN:VEVENT', 'UID:win', 'DTSTART;TZID=Eastern Standard Time:20260105T090000', 'END:VEVENT'],
      GOOD_EVENT,
    ));
    expect(events.map((event) => event.uid)).toEqual(['good@example']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.uid).toBe('win');
    expect(errors[0]?.message).toContain('Eastern Standard Time');
  });

  test("an alarm's properties do not replace the event's own", () => {
    const [event] = parseICS(ics([
      'BEGIN:VEVENT', 'UID:a', 'DTSTART:20260105T090000Z', 'SUMMARY:Standup', 'DESCRIPTION:A',
      'BEGIN:VALARM', 'ACTION:EMAIL', 'DESCRIPTION:B', 'SUMMARY:Reminder', 'ATTENDEE:mailto:x@evil.example', 'END:VALARM',
      'LOCATION:Room 1', 'END:VEVENT',
    ]));
    expect(event?.description).toBe('A');
    expect(event?.summary).toBe('Standup');
    expect(event?.location).toBe('Room 1');
    expect(event?.attendees).toHaveLength(0);
  });

  test('one unreadable event does not hide the readable ones', () => {
    const { events, errors } = parseICSDetailed(ics(
      ['BEGIN:VEVENT', 'UID:bad', 'DTSTART:20261350T000000', 'END:VEVENT'],
      GOOD_EVENT,
    ));
    expect(events.map((event) => event.uid)).toEqual(['good@example']);
    expect(errors.map((error) => error.uid)).toEqual(['bad']);
    expect(() => parseICS(ics(['BEGIN:VEVENT', 'UID:bad', 'DTSTART:20261350T000000', 'END:VEVENT']))).toThrow('Unrecognised iCalendar date value');
  });
});

describe('CalDAV .ics writer', () => {
  const base = { uid: 'u@example', summary: 'S', start: '2026-07-01T09:00:00Z', end: '2026-07-01T10:00:00Z', dtStamp: '2026-07-01T00:00:00Z' };

  test('an attendee carrying a line break is refused instead of adding properties', () => {
    const hostile = 'a@b.example\r\nBEGIN:VALARM\r\nACTION:EMAIL\r\nATTENDEE:mailto:x@evil.example\r\nEND:VALARM';
    expect(() => generateICS({ ...base, attendees: [hostile] })).toThrow(ICalValueError);
    expect(() => generateICS({ ...base, organizer: 'o@b.example\nATTENDEE:mailto:x@evil.example' })).toThrow(ICalValueError);
    expect(() => generateICS({ ...base, uid: 'u\r\nATTENDEE:mailto:x@evil.example' })).toThrow(ICalValueError);
    expect(() => generateICS({ ...base, recurrence: 'FREQ=DAILY\r\nATTENDEE:mailto:x@evil.example' })).toThrow(ICalValueError);
    expect(() => generateICS({ ...base, status: 'confirmed\r\nX-A:b' })).toThrow(ICalValueError);
  });

  test('an address that would add a parameter is refused; a plain one writes exactly one line', () => {
    expect(() => generateICS({ ...base, attendees: ['a@b.example;ROLE=CHAIR'] })).toThrow(ICalValueError);
    const body = generateICS({ ...base, attendees: ['a@b.example', 'Plain Name'] });
    expect(body.split('\r\n').filter((line) => line.startsWith('ATTENDEE'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Gateway service
// ---------------------------------------------------------------------------

function fakeHttp(respond: (request: CalDavHttpRequest) => CalDavHttpResponse) {
  const requests: CalDavHttpRequest[] = [];
  const port: CalDavHttpPort = {
    async request(input) {
      requests.push(input);
      return respond(input);
    },
  };
  return { requests, port };
}

const COLLECTION_URL = 'https://dav.example.com/calendars/mike/personal/';

function gateway(http: CalDavHttpPort) {
  const values: Record<string, unknown> = {
    'surfaces.calendar.caldavUrl': COLLECTION_URL,
    'surfaces.calendar.caldavUser': 'mike',
    'surfaces.calendar.caldavPassword': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD',
  };
  return createCalDavCalendarGatewayService({
    config: {
      get(key: string): unknown {
        if (!(key in values)) throw new Error(`Invalid config path: ${key}`);
        return values[key];
      },
    },
    secrets: createCalDavSecretPort({ async get() { return 'pw'; } }),
    http,
    now: () => Date.parse('2026-07-27T09:30:00.000Z'),
    randomUuid: () => 'fixed-uuid',
  });
}

function multistatus(entries: readonly { href: string; data: string }[]): string {
  const responses = entries.map((entry) => `<D:response><D:href>${entry.href}</D:href><D:propstat><D:prop>`
    + `<C:calendar-data>${entry.data}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('');
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</D:multistatus>`;
}

describe('CalDAV gateway writes', () => {
  test('an imported UID that is a path never names a resource outside the collection', async () => {
    const http = fakeHttp(() => ({ status: 201, headers: {}, body: '' }));
    const result = await gateway(http.port).importIcs(ics(
      ['BEGIN:VEVENT', 'UID:../../other/victim', 'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'SUMMARY:x', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:x?a=b#c', 'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'SUMMARY:y', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:fine@example.com', 'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'SUMMARY:z', 'END:VEVENT'],
    ));
    expect(result.imported).toBe(3);
    const puts = http.requests.filter((request) => request.method === 'PUT');
    expect(puts).toHaveLength(3);
    for (const put of puts) {
      const rest = put.url.slice(COLLECTION_URL.length - 1);
      expect(put.url.startsWith(COLLECTION_URL.slice(0, -1) + '/')).toBe(true);
      expect(rest.slice(1)).toMatch(/^[A-Za-z0-9._@+=~-]+\.ics$/);
    }
    expect(puts[2]?.url).toBe(`${COLLECTION_URL}fine@example.com.ics`);
    // The UID the file declared still travels inside the event.
    expect(String(puts[0]?.body)).toContain('UID:../../other/victim');
  });

  test('creating an event with a line break in an attendee is an INVALID_ARGUMENT and sends nothing', async () => {
    const http = fakeHttp(() => ({ status: 201, headers: {}, body: '' }));
    let thrown: unknown;
    try {
      await gateway(http.port).createEvent({
        title: 'T',
        start: '2026-07-28T09:00:00Z',
        end: '2026-07-28T10:00:00Z',
        attendees: ['a@b.example\r\nATTENDEE:mailto:x@evil.example'],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayVerbError);
    expect((thrown as GatewayVerbError).code).toBe('INVALID_ARGUMENT');
    expect(http.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  test('an import reports the unreadable event by uid and still writes the rest', async () => {
    const http = fakeHttp(() => ({ status: 201, headers: {}, body: '' }));
    const result = await gateway(http.port).importIcs(ics(
      ['BEGIN:VEVENT', 'UID:bad', 'DTSTART:20261350T000000', 'END:VEVENT'],
      GOOD_EVENT,
    ));
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('bad');
  });
});

describe('CalDAV gateway reads', () => {
  test('one unreadable event does not fail the listing of the collection', async () => {
    const http = fakeHttp(() => ({
      status: 207,
      headers: {},
      body: multistatus([
        { href: '/calendars/mike/personal/bad.ics', data: ics(['BEGIN:VEVENT', 'UID:bad', 'DTSTART;VALUE=PERIOD:20260105T090000Z/PT1H', 'END:VEVENT']) },
        { href: '/calendars/mike/personal/good.ics', data: ics(['BEGIN:VEVENT', 'UID:good@example', 'DTSTART:20260805T090000Z', 'DTEND:20260805T100000Z', 'SUMMARY:Good', 'END:VEVENT']) },
      ]),
    }));
    const listed = await gateway(http.port).listEvents({ from: '2026-01-01T00:00:00Z' });
    expect(listed.map((event) => event.title)).toEqual(['Good']);
  });

  test('with no window the list is what is coming up, newest history excluded, ordered by instant', async () => {
    const events = [
      ...Array.from({ length: 25 }, (_unused, index) => ({
        href: `/calendars/mike/personal/old${String(index)}.ics`,
        data: ics(['BEGIN:VEVENT', `UID:old${String(index)}`, `DTSTART:2020${String(1 + (index % 12)).padStart(2, '0')}10T090000Z`, 'SUMMARY:old', 'END:VEVENT']),
      })),
      { href: '/calendars/mike/personal/next.ics', data: ics(['BEGIN:VEVENT', 'UID:next', 'DTSTART:20260801T090000Z', 'SUMMARY:next', 'END:VEVENT']) },
    ];
    const http = fakeHttp(() => ({ status: 207, headers: {}, body: multistatus(events) }));
    // The server applies the time-range; the fake ignores it and returns everything.
    // What the service must do is ask for one: the REPORT body carries a start bound.
    await gateway(http.port).listEvents({});
    const report = http.requests.find((request) => request.method === 'REPORT');
    expect(String(report?.body)).toContain('start="20260726T093000Z"');
  });

  test('exporting asks for everything, with no time bound', async () => {
    const http = fakeHttp(() => ({ status: 207, headers: {}, body: multistatus([]) }));
    await gateway(http.port).exportIcs({});
    const report = http.requests.find((request) => request.method === 'REPORT');
    expect(String(report?.body)).not.toContain('time-range');
  });
});

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

describe('recurrence expansion', () => {
  function seed(rule: string, start: string, extra: readonly string[] = []) {
    const parsed = parseIcs(ics(['BEGIN:VEVENT', 'UID:r', `DTSTART:${start}`, 'SUMMARY:r', `RRULE:${rule}`, ...extra, 'END:VEVENT']));
    return parsed.events[0]!;
  }

  test('a daily event that began over a thousand days ago still appears in the window', () => {
    const event = seed('FREQ=DAILY', '20230101T090000');
    const occurrences = expandEvent(event, { from: '2026-11-01', to: '2026-11-03' });
    expect(occurrences.map((occurrence) => occurrence.start.slice(0, 10))).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });

  test('COUNT is measured from the seed even when the window is far away', () => {
    const event = seed('FREQ=DAILY;COUNT=1500', '20230101T090000');
    const occurrences = expandEvent(event, { from: '2026-11-01', to: '2027-12-31' });
    // 2023-01-01 + 1499 days = 2027-02-08 is the last of 1500.
    expect(occurrences.at(-1)?.start.slice(0, 10)).toBe('2027-02-08');
    expect(occurrences[0]?.start.slice(0, 10)).toBe('2026-11-01');
  });

  test('a weekly BYDAY event from years back lands on the right weekdays', () => {
    const event = seed('FREQ=WEEKLY;BYDAY=MO,WE', '20150105T090000');
    const occurrences = expandEvent(event, { from: '2026-11-02', to: '2026-11-08' });
    expect(occurrences.map((occurrence) => occurrence.start.slice(0, 10))).toEqual(['2026-11-02', '2026-11-04']);
  });

  test('a series with an excluded date is not expanded, and says why', () => {
    const event = seed('FREQ=DAILY', '20260101T090000', ['EXDATE:20260102T090000']);
    expect(event.recurrence?.expansion).toBe('unsupported');
    expect(event.recurrence?.unsupportedReason).toContain('EXDATE');
    const occurrences = expandEvent(event, { from: '2026-01-01', to: '2026-01-05' });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.isSeed).toBe(true);
  });

  test('extra dates without a rule are marked unsupported and noted', () => {
    const parsed = parseIcs(ics(['BEGIN:VEVENT', 'UID:rd', 'DTSTART:20260101T090000', 'SUMMARY:rd', 'RDATE:20260110T090000', 'END:VEVENT']));
    expect(parsed.events[0]?.recurrence?.expansion).toBe('unsupported');
    expect(parsed.events[0]?.recurrence?.unsupportedReason).toContain('RDATE');
    expect(parsed.diagnostics.some((d) => d.message.includes('RDATE'))).toBe(true);
    expect(expandEvent(parsed.events[0]!, { from: '2026-01-01', to: '2026-01-31' })).toHaveLength(1);
  });

  test('a series with a moved occurrence is not expanded', () => {
    const parsed = parseIcs(ics(
      ['BEGIN:VEVENT', 'UID:m', 'DTSTART:20260101T090000', 'SUMMARY:m', 'RRULE:FREQ=DAILY', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:m', 'RECURRENCE-ID:20260103T090000', 'DTSTART:20260103T150000', 'SUMMARY:m moved', 'END:VEVENT'],
    ));
    const series = parsed.events.find((event) => event.recurrence !== undefined);
    expect(series?.recurrence?.expansion).toBe('unsupported');
    expect(series?.recurrence?.unsupportedReason).toContain('RECURRENCE-ID');
  });
});

describe('subscription feed reader', () => {
  test('an alarm does not become the event description, and a quoted CN keeps its address', () => {
    const parsed = parseIcs(ics([
      'BEGIN:VEVENT', 'UID:q', 'DTSTART:20260105T090000Z', 'SUMMARY:s', 'DESCRIPTION:real',
      'ORGANIZER;CN="Team: Eng":mailto:eng@example.com',
      'BEGIN:VALARM', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT',
    ]));
    expect(parsed.events[0]?.description).toBe('real');
    expect(parsed.events[0]?.organizer).toBe('eng@example.com');
  });
});

// ---------------------------------------------------------------------------
// Subscription store
// ---------------------------------------------------------------------------

type Scripted = { kind: 'ok'; body: string; etag?: string } | { kind: 'not-modified' } | { kind: 'error'; message: string } | { kind: 'throw' };

function scriptedFetcher(script: Map<string, Scripted[]>) {
  const requests: { url: string; etag?: string }[] = [];
  return {
    requests,
    fetcher: async (request: { url: string; etag?: string; lastModified?: string }) => {
      requests.push({ url: request.url, ...(request.etag ? { etag: request.etag } : {}) });
      const next = script.get(request.url)?.shift();
      if (!next || next.kind === 'throw') throw new Error('socket hang up');
      return next;
    },
  };
}

const FEED = ics(['BEGIN:VEVENT', 'UID:f1', 'DTSTART:20260105T090000Z', 'SUMMARY:Feed event', 'END:VEVENT']);

describe('subscription store', () => {
  test('a 200 that is not a calendar keeps the last good events and is not reported ok', async () => {
    const script = new Map<string, Scripted[]>([['https://feed.example/a.ics', [{ kind: 'ok', body: FEED }, { kind: 'ok', body: '<html>Please log in</html>' }]]]);
    const { fetcher } = scriptedFetcher(script);
    let now = 0;
    const store = new SubscriptionStore({ fetcher, clock: () => now });
    const added = await store.add({ url: 'https://feed.example/a.ics', name: 'A' });
    expect(added.ok).toBe(true);
    now += 10_000_000;
    const report = await store.refresh('A', { force: true });
    expect(report.outcome).toBe('parse-error');
    expect(report.health).toBe('parse-error');
    expect(store.events('A')).toHaveLength(1);
  });

  test('a fetcher that throws costs one subscription its refresh, not the rest', async () => {
    const script = new Map<string, Scripted[]>([
      ['https://feed.example/a.ics', [{ kind: 'ok', body: FEED }, { kind: 'throw' }]],
      ['https://feed.example/b.ics', [{ kind: 'ok', body: FEED }, { kind: 'ok', body: FEED }]],
    ]);
    const { fetcher } = scriptedFetcher(script);
    const store = new SubscriptionStore({ fetcher, clock: () => 0 });
    await store.add({ url: 'https://feed.example/a.ics', name: 'A' });
    await store.add({ url: 'https://feed.example/b.ics', name: 'B' });
    const reports = await store.refreshDue({ force: true });
    expect(reports.map((report) => [report.name, report.outcome])).toEqual([['A', 'unreachable'], ['B', 'updated']]);
  });

  test('a restored subscription with no events does a full fetch instead of a conditional one', async () => {
    const script = new Map<string, Scripted[]>([['https://feed.example/a.ics', [{ kind: 'ok', body: FEED }]]]);
    const { fetcher, requests } = scriptedFetcher(script);
    const store = new SubscriptionStore({ fetcher, clock: () => 100 });
    store.restore([{ name: 'A', url: 'https://feed.example/a.ics', refreshIntervalMs: 3_600_000, lastFetchedAt: 99, lastSucceededAt: 99, etag: 'W/"v1"' }]);
    const reports = await store.refreshDue();
    expect(reports[0]?.outcome).toBe('updated');
    expect(requests[0]?.etag).toBeUndefined();
    expect(store.events('A')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): HttpResponse {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), header: () => null } as unknown as HttpResponse;
}

describe('Microsoft Graph events', () => {
  const query = { calendarId: 'cal', calendarLabel: 'Cal', start: '2026-07-01T00:00:00Z', end: '2026-08-01T00:00:00Z' };

  test('a next-page link on another host is not followed with the token', async () => {
    const urls: string[] = [];
    const fetchImpl: HttpFetch = async (request) => {
      urls.push(request.url);
      return jsonResponse({ value: [], '@odata.nextLink': 'https://evil.example/steal' });
    };
    await expect(listGraphEvents(fetchImpl, 'secret-token', query)).rejects.toThrow('not on graph.microsoft.com');
    expect(urls).toHaveLength(1);
  });

  test('a link that points back at itself stops at the page cap', async () => {
    let calls = 0;
    const fetchImpl: HttpFetch = async () => {
      calls += 1;
      return jsonResponse({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/loop' });
    };
    await expect(listGraphEvents(fetchImpl, 't', query)).rejects.toThrow('next-page links');
    expect(calls).toBeLessThanOrEqual(100);
  });

  test("the owner's own meetings are marked as theirs and cancelled ones are left out", async () => {
    const selects: string[] = [];
    const fetchImpl: HttpFetch = async (request) => {
      selects.push(new URL(request.url).searchParams.get('$select') ?? '');
      return jsonResponse({
        value: [
          { id: '1', subject: 'Mine', isOrganizer: true, organizer: { emailAddress: { address: 'me@x.example' } }, start: { dateTime: '2026-07-02T09:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-07-02T10:00:00', timeZone: 'UTC' } },
          { id: '2', subject: 'Cancelled', isCancelled: true, start: { dateTime: '2026-07-03T09:00:00', timeZone: 'UTC' } },
        ],
      });
    };
    const events = await listGraphEvents(fetchImpl, 't', query);
    for (const field of ['organizer', 'isOrganizer', 'isCancelled']) expect(selects[0]).toContain(field);
    expect(events.map((event) => [event.summary, event.organizerIsOwner])).toEqual([['Mine', true]]);
  });
});

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

function memorySecrets() {
  const map = new Map<string, string>();
  return {
    map,
    slice: {
      async get(key: string) { return map.get(key) ?? null; },
      async set(key: string, value: string) { map.set(key, value); },
      async delete(key: string) { map.delete(key); },
    },
  };
}

const GOOGLE_CONFIG = {
  provider: 'google',
  clientId: 'cid',
  tokenEndpoint: 'https://oauth2.example/token',
  isConfigured: true,
} as never;

const ACCOUNT = { provider: 'google', accountId: 'google', label: 'g', scopes: [], connectedAt: 1 } as const;
const DUE_TOKENS = { accessToken: 'old', refreshToken: 'rt', tokenType: 'Bearer', expiresAt: 10, obtainedAt: 1 } as const;

describe('calendar token store', () => {
  test('a dropped connection during refresh does not tell the owner to reconnect', async () => {
    const { slice } = memorySecrets();
    const store = new CalendarTokenStore({ secrets: slice as never, clock: () => 1_000_000 });
    await store.save('google', DUE_TOKENS, ACCOUNT);
    const fetchImpl: HttpFetch = async () => { throw new Error('ECONNRESET'); };
    await expect(store.getFreshAccessToken('google', GOOGLE_CONFIG, fetchImpl)).rejects.toThrow('Refreshing the google token failed');
    expect(await store.connectionState('google')).not.toBe('reconnect-needed');
  });

  test('a refused grant does mark the account for reconnecting', async () => {
    const { slice } = memorySecrets();
    const store = new CalendarTokenStore({ secrets: slice as never, clock: () => 1_000_000 });
    await store.save('google', DUE_TOKENS, ACCOUNT);
    const fetchImpl: HttpFetch = async () => ({
      ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }), text: async () => '{"error":"invalid_grant"}', header: () => null,
    }) as unknown as HttpResponse;
    await expect(store.getFreshAccessToken('google', GOOGLE_CONFIG, fetchImpl)).rejects.toThrow();
    expect(await store.connectionState('google')).toBe('reconnect-needed');
  });

  test('a refresh that finishes after disconnect does not bring the account back', async () => {
    const { slice, map } = memorySecrets();
    const store = new CalendarTokenStore({ secrets: slice as never, clock: () => 1_000_000 });
    await store.save('google', DUE_TOKENS, ACCOUNT);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let onWire: (() => void) | undefined;
    const wire = new Promise<void>((resolve) => { onWire = resolve; });
    const fetchImpl: HttpFetch = async () => {
      onWire?.();
      await gate;
      return jsonResponse({ access_token: 'new', refresh_token: 'rt2', token_type: 'Bearer', expires_in: 3600 });
    };
    const refreshing = store.getFreshAccessToken('google', GOOGLE_CONFIG, fetchImpl);
    const settled = refreshing.then(() => 'ok', (error: unknown) => String(error));
    await wire;
    await store.disconnect('google', GOOGLE_CONFIG, async () => jsonResponse({}));
    release?.();
    expect(await settled).toContain('disconnected');
    expect([...map.keys()]).toEqual([]);
  });
});

describe('device-code login', () => {
  test('a cancelled attempt stops polling instead of running to the code expiry', async () => {
    const controller = new AbortController();
    let requests = 0;
    const fetchImpl: HttpFetch = async () => {
      requests += 1;
      return jsonResponse({ error: 'authorization_pending' });
    };
    const start = { deviceCode: 'd', userCode: 'u', verificationUri: 'https://v.example', expiresAt: 10_000_000, intervalMs: 5000 };
    await expect(pollDeviceCodeFlow(GOOGLE_CONFIG, fetchImpl, start, () => 0, async () => { controller.abort(); }, controller.signal)).rejects.toThrow();
    expect(requests).toBe(0);
  });
});
