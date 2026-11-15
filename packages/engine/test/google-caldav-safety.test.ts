/**
 * CalDAV: where the credentials may go, what a stalled or oversized server can
 * do to a call, and what one malformed response may cost.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  CalDavClient,
  type CalDavHttpPort,
  type CalDavHttpRequest,
  type CalDavHttpResponse,
} from '../platform/src/platform/google/caldav-client.ts';
import { parseCalendarDataEvents, parseMultistatus } from '../platform/src/platform/google/caldav-parse.ts';
import { createFetchCalDavHttpPort } from '../platform/src/platform/google/node.ts';

const AUTH = { kind: 'basic', username: 'mike', password: 'pw' } as const;

function multistatus(inner: string): string {
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${inner}</D:multistatus>`;
}

function recordingPort(respond: (request: CalDavHttpRequest) => CalDavHttpResponse | Promise<CalDavHttpResponse>) {
  const requests: CalDavHttpRequest[] = [];
  const port: CalDavHttpPort = {
    async request(input) {
      requests.push(input);
      return respond(input);
    },
  };
  return { port, requests };
}

const principalNaming = (href: string) => multistatus(
  `<D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>${href}</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
);

describe('CalDAV credentials stay with the server the person chose', () => {
  test('a principal href on another host is refused and nothing is sent there', async () => {
    const { port, requests } = recordingPort(() => ({
      status: 207,
      headers: {},
      body: principalNaming('http://attacker.example/steal/'),
    }));
    const client = new CalDavClient({ http: port, auth: AUTH });
    const result = await client.discover('https://caldav.example.com/dav/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('credentials were not sent');
    expect(requests).toHaveLength(1);
    expect(requests.every((request) => request.url.startsWith('https://caldav.example.com/'))).toBe(true);
  });

  test('a principal on a sibling host of the same domain is followed over https, and nowhere else', async () => {
    const { port, requests } = recordingPort(() => ({ status: 207, headers: {}, body: principalNaming('https://p42-caldav.example.com/123/principal/') }));
    const client = new CalDavClient({ http: port, auth: AUTH });
    const principal = await client.discoverPrincipal('https://caldav.example.com/');
    expect(principal.ok).toBe(true);
    if (!principal.ok) return;
    await client.discoverCalendarHome(principal.principalUrl);
    expect(requests.map((request) => new URL(request.url).host)).toEqual(['caldav.example.com', 'p42-caldav.example.com']);
    const downgraded = await client.discoverCalendarHome('http://p42-caldav.example.com/123/principal/');
    expect(downgraded.ok).toBe(false);
    const foreign = await client.discoverCalendarHome('https://caldav.example.net/123/principal/');
    expect(foreign.ok).toBe(false);
    expect(requests).toHaveLength(2);
  });

  test('a first address that is plain http on a non-loopback host sends nothing', async () => {
    const { port, requests } = recordingPort(() => ({ status: 207, headers: {}, body: '' }));
    const client = new CalDavClient({ http: port, auth: AUTH });
    const result = await client.discoverPrincipal('http://caldav.example.com/dav/');
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  test('a loopback http server is allowed', async () => {
    const { port, requests } = recordingPort(() => ({ status: 207, headers: {}, body: principalNaming('/principals/me/') }));
    const client = new CalDavClient({ http: port, auth: AUTH });
    const result = await client.discoverPrincipal('http://127.0.0.1:9/dav/');
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  test('the client threads its cancellation signal to every request', async () => {
    const controller = new AbortController();
    const { port, requests } = recordingPort(() => ({ status: 207, headers: {}, body: principalNaming('/p/') }));
    const client = new CalDavClient({ http: port, auth: AUTH, signal: controller.signal });
    await client.discoverPrincipal('https://caldav.example.com/dav/');
    expect(requests[0]?.signal).toBe(controller.signal);
  });

  test('an invalid query range is reported as a result, not thrown', async () => {
    const { port, requests } = recordingPort(() => ({ status: 207, headers: {}, body: '' }));
    const client = new CalDavClient({ http: port, auth: AUTH });
    const result = await client.listEvents('https://caldav.example.com/cal/', { start: new Date(Number.NaN), end: new Date() });
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe('the fetch-backed CalDAV port', () => {
  const servers: Array<{ stop(force?: boolean): void }> = [];
  afterAll(() => {
    for (const server of servers) server.stop(true);
  });

  test('a server that never answers ends in a failure result once the timeout passes', async () => {
    const silent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => undefined) });
    servers.push(silent);
    const client = new CalDavClient({
      http: createFetchCalDavHttpPort({ timeoutMs: 100 }),
      auth: AUTH,
    });
    const result = await client.discoverPrincipal(`http://127.0.0.1:${silent.port}/dav/`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('could not reach the calendar server');
  });

  test('a response larger than the cap is refused instead of buffered', async () => {
    const big = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x'.repeat(5_000)) });
    servers.push(big);
    const client = new CalDavClient({
      http: createFetchCalDavHttpPort({ maxBodyBytes: 1_000 }),
      auth: AUTH,
    });
    const result = await client.discoverPrincipal(`http://127.0.0.1:${big.port}/dav/`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('larger than');
  });

  test('an aborted caller signal stops the request', async () => {
    const silent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => undefined) });
    servers.push(silent);
    const controller = new AbortController();
    controller.abort();
    const client = new CalDavClient({ http: createFetchCalDavHttpPort(), auth: AUTH, signal: controller.signal });
    const result = await client.discoverPrincipal(`http://127.0.0.1:${silent.port}/dav/`);
    expect(result.ok).toBe(false);
  });
});

describe('CalDAV parsing keeps what it can read', () => {
  test('one out-of-range numeric entity does not empty the whole response', () => {
    const xml = multistatus(
      '<D:response><D:href>/cal/a.ics</D:href><D:propstat><D:prop><D:displayname>Work &#99999999; team</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>',
    );
    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.props['displayname']).toContain('Work');
  });

  test('an alarm inside an event does not rename it', () => {
    const ics = [
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a@x', 'SUMMARY:Planning', 'DTSTART:20260801T100000Z', 'DTEND:20260801T110000Z',
      'BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:Reminder mail', 'DESCRIPTION:ping', 'END:VALARM',
      'LOCATION:Room 4', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const events = parseCalendarDataEvents(ics);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe('Planning');
    expect(events[0]?.location).toBe('Room 4');
  });

  test('an override of one occurrence keeps its RECURRENCE-ID so it is not a duplicate of the series', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'UID:s@x', 'SUMMARY:Weekly', 'DTSTART:20260801T100000Z', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:s@x', 'SUMMARY:Weekly (moved)', 'DTSTART:20260809T120000Z', 'RECURRENCE-ID:20260808T100000Z', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseCalendarDataEvents(ics);
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.recurrenceId !== undefined)?.recurrenceId).toBe('20260808T100000Z');
    expect(events.find((event) => event.rrule !== undefined)?.recurrenceId).toBeUndefined();
  });
});
