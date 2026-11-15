/**
 * Calls to Gmail and Google Calendar: what is sent, and what is reported when
 * a call fails or only partly succeeds.
 */
import { describe, expect, test } from 'bun:test';
import { GoogleApiClient } from '../platform/src/platform/google/api-client.ts';
import { GoogleTokenManager } from '../platform/src/platform/google/token-manager.ts';
import { createGoogleCalendarGatewayService } from '../platform/src/platform/google/gateway-calendar-service.ts';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '../platform/src/platform/google/setup-plan.ts';
import { isGatewayVerbError } from '../platform/src/platform/control-plane/routes/gateway-verb-error.ts';
import type { GoogleConnectionSources } from '../platform/src/platform/google/connection.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetch: (url: string, init: RequestInit) => Promise<Response>): GoogleApiClient {
  const tokens = new GoogleTokenManager(
    {
      clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', accessToken: 'access',
      expiresAtMs: Date.now() + 3_600_000, scopes: [], tokenUri: 'https://oauth2.googleapis.com/token',
      origin: 'secret-store', location: 'store',
    },
    { refresh: async () => { throw new Error('unexpected refresh'); } },
  );
  return new GoogleApiClient(tokens, { fetch });
}

describe('listing mail', () => {
  test('a message that cannot be read makes the list a failure, not a shorter inbox', async () => {
    const api = client(async (url) => {
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] });
      if (url.includes('/messages/m2')) return json({ error: { message: 'backend error' } }, 500);
      return json({ id: 'm1', threadId: 't', payload: { headers: [] }, labelIds: [] });
    });
    const result = await api.listMessages();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('Read 1 of 3');
  });

  test('a message deleted between the list and the read is simply left out', async () => {
    const api = client(async (url) => {
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1' }, { id: 'm2' }] });
      if (url.includes('/messages/m2')) return json({ error: { message: 'not found' } }, 404);
      return json({ id: 'm1', threadId: 't', payload: { headers: [] }, labelIds: [] });
    });
    const result = await api.listMessages();
    expect(result.ok && result.value.map((message) => message.id)).toEqual(['m1']);
  });
});

describe('sending mail', () => {
  test('a connection that fails after the request left says the outcome is unknown and to check Sent', async () => {
    const api = client(async () => { throw new Error('socket hang up'); });
    const result = await api.sendMessage({ to: 'a@x.test', subject: 'Hi', body: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.transport).toBe('unreachable');
      expect(result.problem).toContain('may or may not have been sent');
      expect(result.fix).toContain('Sent');
    }
  });
});

describe('creating a Google event', () => {
  test('attendees, the zone, recurrence and the source uid are in the request body, and invitations are requested', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const api = client(async (url, init) => {
      seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      return json({ id: 'e1', summary: 'Standup' });
    });
    const result = await api.createEvent({
      summary: 'Standup',
      start: '2026-08-01T10:00:00',
      end: '2026-08-01T10:15:00',
      timeZone: 'Europe/Berlin',
      attendees: ['a@x.test', ' b@y.test '],
      notifyAttendees: true,
      recurrence: ['RRULE:FREQ=DAILY'],
      sourceUid: 'uid-1',
    });
    expect(result.ok).toBe(true);
    expect(seen).not.toBeNull();
    const request = seen as unknown as { url: string; body: Record<string, unknown> };
    expect(request.url).toContain('sendUpdates=all');
    expect(request.body.attendees).toEqual([{ email: 'a@x.test' }, { email: 'b@y.test' }]);
    expect(request.body.start).toEqual({ dateTime: '2026-08-01T10:00:00', timeZone: 'Europe/Berlin' });
    expect(request.body.recurrence).toEqual(['RRULE:FREQ=DAILY']);
    expect(request.body.extendedProperties).toEqual({ private: { icsUid: 'uid-1' } });
  });

  test('without notifyAttendees no invitation mail is requested', async () => {
    let url = '';
    const api = client(async (requested) => { url = requested; return json({ id: 'e1', summary: 'x' }); });
    await api.createEvent({ summary: 'x', start: '2026-08-01T10:00:00Z', end: '2026-08-01T11:00:00Z', attendees: ['a@x.test'] });
    expect(url).not.toContain('sendUpdates');
  });
});

function sources(): GoogleConnectionSources {
  return {
    files: { exists: () => false, readText: () => null },
    homeDirectory: '/home/tester',
    configGet: (key: string) => (key === GOOGLE_CONFIG_KEYS.oauthClientId ? 'client-123' : undefined),
    secretGet: async (key: string) => {
      if (key === GOOGLE_SECRET_KEYS.oauthClientSecret) return 'client-secret';
      if (key === GOOGLE_SECRET_KEYS.oauthRefreshToken) return 'refresh-live';
      return null;
    },
  };
}

interface Recorded { readonly method: string; readonly url: string; readonly body: Record<string, unknown> | null }

function gateway(options: { readonly alreadyImported?: readonly string[]; readonly unreachable?: boolean } = {}) {
  const calls: Recorded[] = [];
  const service = createGoogleCalendarGatewayService({
    sources: sources(),
    fetch: {
      fetch: async (url: string, init?: RequestInit): Promise<Response> => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return json({ access_token: 'live', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events', token_type: 'Bearer' });
        }
        const method = init?.method ?? 'GET';
        calls.push({ method, url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown> });
        if (options.unreachable) throw new Error('network down');
        if (method === 'POST') return json({ id: `created-${calls.length}`, summary: 'x' });
        const queried = decodeURIComponent(url);
        const hit = (options.alreadyImported ?? []).find((uid) => queried.includes(`icsUid=${uid}`));
        return json({ items: hit === undefined ? [] : [{ id: 'existing', summary: 'already here' }] });
      },
    },
  });
  return { service, calls, posts: () => calls.filter((call) => call.method === 'POST') };
}

const ics = (events: string): string => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n${events}END:VCALENDAR\r\n`;
const vevent = (lines: string[]): string => `BEGIN:VEVENT\r\nDTSTAMP:20260701T000000Z\r\n${lines.join('\r\n')}\r\nEND:VEVENT\r\n`;

describe('the Google calendar gateway', () => {
  test('attendees on a create reach Google', async () => {
    const { service, posts } = gateway();
    await service.createEvent({
      title: 'Review', start: '2026-09-01T09:00:00Z', end: '2026-09-01T10:00:00Z', attendees: ['a@x.test'],
    });
    expect(posts()[0]?.body?.attendees).toEqual([{ email: 'a@x.test' }]);
  });

  test('an event that ends before it starts is refused before anything is sent', async () => {
    const { service, calls } = gateway();
    let error: unknown;
    try {
      await service.createEvent({ title: 'Backwards', start: '2026-09-01T10:00:00Z', end: '2026-09-01T09:00:00Z' });
    } catch (caught) {
      error = caught;
    }
    expect(isGatewayVerbError(error) && error.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('a call that never reaches Google is a 502, not a bad request', async () => {
    const { service } = gateway({ unreachable: true });
    let error: unknown;
    try {
      await service.createEvent({ title: 'x', start: '2026-09-01T09:00:00Z', end: '2026-09-01T10:00:00Z' });
    } catch (caught) {
      error = caught;
    }
    expect(isGatewayVerbError(error) && error.status).toBe(502);
  });

  test('an imported event keeps its time zone and its recurrence rule', async () => {
    const { service, posts } = gateway();
    const result = await service.importIcs(ics(
      vevent(['UID:tz-1', 'SUMMARY:Berlin sync', 'DTSTART;TZID=Europe/Berlin:20260801T100000', 'DTEND;TZID=Europe/Berlin:20260801T110000'])
      + vevent(['UID:weekly-1', 'SUMMARY:Weekly', 'DTSTART:20260801T100000Z', 'DTEND:20260801T110000Z', 'RRULE:FREQ=WEEKLY;BYDAY=SA']),
    ));
    expect(result.imported).toBe(2);
    const [berlin, weekly] = posts().map((post) => post.body);
    expect(berlin?.start).toEqual({ dateTime: '2026-08-01T10:00:00', timeZone: 'Europe/Berlin' });
    expect(weekly?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=SA']);
    expect((weekly?.start as { timeZone?: string }).timeZone).toBe('UTC');
  });

  test('an event with no time zone is reported as not imported instead of being placed at a guessed hour', async () => {
    const { service, posts } = gateway();
    const result = await service.importIcs(ics(
      vevent(['UID:float-1', 'SUMMARY:Floating', 'DTSTART:20260801T100000', 'DTEND:20260801T110000']),
    ));
    expect(result.imported).toBe(0);
    expect(result.errors.join(' ')).toContain('no time zone');
    expect(posts()).toHaveLength(0);
  });

  test('importing a file again skips the events already imported from it', async () => {
    const { service, posts } = gateway({ alreadyImported: ['uid-seen'] });
    const result = await service.importIcs(ics(
      vevent(['UID:uid-seen', 'SUMMARY:Seen', 'DTSTART:20260801T100000Z', 'DTEND:20260801T110000Z'])
      + vevent(['UID:uid-new', 'SUMMARY:New', 'DTSTART:20260802T100000Z', 'DTEND:20260802T110000Z']),
    ));
    expect(result.imported).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(result.errors.join(' ')).toContain('already in the calendar');
  });
  test('a recurring event with an excluded date is reported, not sent as the bare rule', async () => {
    const { service, posts } = gateway();
    const result = await service.importIcs(ics(
      vevent(['UID:ex-1', 'SUMMARY:Weekly', 'DTSTART:20260801T100000Z', 'DTEND:20260801T110000Z', 'RRULE:FREQ=WEEKLY;BYDAY=SA', 'EXDATE:20260808T100000Z']),
    ));
    expect(result.imported).toBe(0);
    expect(posts()).toHaveLength(0);
    expect(result.errors.join(' ')).toContain('EXDATE');
  });

  test('an event with extra dates and no rule is reported, not imported as a single event', async () => {
    const { service, posts } = gateway();
    const result = await service.importIcs(ics(
      vevent(['UID:rd-1', 'SUMMARY:Extra', 'DTSTART:20260801T100000Z', 'DTEND:20260801T110000Z', 'RDATE:20260810T100000Z']),
    ));
    expect(result.imported).toBe(0);
    expect(posts()).toHaveLength(0);
    expect(result.errors.join(' ')).toContain('RDATE');
  });

  test('a rule this build does not expand locally is still imported with its full RRULE', async () => {
    const { service, posts } = gateway();
    const result = await service.importIcs(ics(
      vevent(['UID:m-1', 'SUMMARY:Monthly', 'DTSTART:20260815T100000Z', 'DTEND:20260815T110000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15']),
    ));
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(1);
    expect(JSON.stringify(posts()[0]?.body)).toContain('FREQ=MONTHLY;BYMONTHDAY=15');
  });

  test('an override of one occurrence is reported as such, and attendees are sent', async () => {
    const { service, posts } = gateway();
    const result = await service.importIcs(ics(
      vevent(['UID:o-1', 'SUMMARY:Moved', 'DTSTART:20260808T120000Z', 'DTEND:20260808T130000Z', 'RECURRENCE-ID:20260808T100000Z'])
      + vevent(['UID:a-1', 'SUMMARY:Meet', 'DTSTART:20260802T100000Z', 'DTEND:20260802T110000Z', 'ATTENDEE;CN=Bob:mailto:bob@example.com']),
    ));
    expect(result.imported).toBe(1);
    expect(result.errors.join(' ')).toContain('RECURRENCE-ID');
    expect((posts()[0]?.body as { attendees?: unknown }).attendees).toEqual([{ email: 'bob@example.com' }]);
  });
});
