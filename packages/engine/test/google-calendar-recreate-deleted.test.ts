// Proves: Creating a Google Calendar event under a UID whose event was deleted answers created while nothing is on the owner's calendar.
// Red when: A 409 for the UID is answered with the existing event without checking that Google holds it as cancelled, or the cancelled event is not restored.
/**
 * A caller's UID becomes the Google event id, so a create sent again after a
 * lost answer is a duplicate and the first event is returned. Google keeps a
 * deleted event's id taken: inserting it again answers 409 and reading it
 * returns the event with `status: "cancelled"`. Answering that with "created"
 * tells an agent or a schedule the meeting is booked while the owner's
 * calendar does not show it, and nothing will try again.
 *
 * Real daemon calendar composition, its settings and secret stores, the real
 * Google connection and API client; Google (token endpoint and Calendar API)
 * is a stand-in at the HTTP wire that keeps every event, its status and etag,
 * and answers as Google does for a taken id.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { createDaemonCalendarGatewayService } from '../platform/src/platform/control-plane/routes/calendar-composition.ts';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '../platform/src/platform/google/setup-plan.ts';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface GoogleEvent { id: string; status: 'confirmed' | 'cancelled'; etag: string; summary: string; start: unknown; end: unknown }

/** Google at the wire: the token endpoint and one calendar's events. */
function google() {
  const events = new Map<string, GoogleEvent>();
  let version = 0;
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return json(200, { access_token: 'calendar-access', expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/calendar.events' });
    }
    const base = '/calendar/v3/calendars/primary/events';
    if (!pathname.startsWith(base)) return json(404, { error: { code: 404, message: 'Not Found' } });
    const id = decodeURIComponent(pathname.slice(base.length + 1));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const stamp = (event: GoogleEvent): GoogleEvent => { version += 1; event.etag = `"${String(version)}"`; return event; };
    if (method === 'POST' && id.length === 0) {
      const wanted = String(body.id);
      // An id once used, also by an event since deleted, stays taken.
      if (events.has(wanted)) return json(409, { error: { code: 409, message: 'The requested identifier already exists.' } });
      const event = stamp({ id: wanted, status: 'confirmed', etag: '', summary: String(body.summary), start: body.start, end: body.end });
      events.set(wanted, event);
      return json(200, event);
    }
    const event = events.get(id);
    if (event === undefined) return json(404, { error: { code: 404, message: 'Not Found' } });
    const ifMatch = new Headers(init.headers).get('If-Match');
    if (ifMatch !== null && ifMatch !== event.etag) return json(412, { error: { code: 412, message: 'Precondition Failed' } });
    if (method === 'GET') return json(200, event);
    if (method === 'DELETE') { stamp(event).status = 'cancelled'; return new Response(null, { status: 204 }); }
    if (method === 'PATCH') {
      if (typeof body.summary === 'string') event.summary = body.summary;
      if (body.start !== undefined) event.start = body.start;
      if (body.end !== undefined) event.end = body.end;
      if (body.status === 'confirmed' || body.status === 'cancelled') event.status = body.status;
      return json(200, stamp(event));
    }
    return json(405, { error: { code: 405, message: 'Method Not Allowed' } });
  };
  return { events, fetch };
}

test('re-creating an event under the UID of a deleted one puts it back on the calendar with the new fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-google-recreate-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configManager = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json'), ownsDaemonTier: true });
  expect(configManager.setMany([{ key: GOOGLE_CONFIG_KEYS.oauthClientId as ConfigKey, value: 'owner-calendar-client' }], localOwnerActor()).ok).toBe(true);
  const secretsManager = new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: join(root, 'home'), projectRoot: root, policy: 'plaintext_allowed' });
  await secretsManager.set(GOOGLE_SECRET_KEYS.oauthClientSecret, 'owner-client-secret', { scope: 'user' });
  await secretsManager.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'owner-refresh-grant', { scope: 'user' });
  const server = google();
  const calendar = createDaemonCalendarGatewayService({
    configManager, secretsManager, homeDirectory: join(root, 'home'),
    calendarFetch: { fetch: server.fetch }, untrustedContentLedger: new UntrustedContentLedger(),
  })!;

  const first = await calendar.createEvent({ uid: 'standup-1', title: 'Standup', start: '2026-12-01T09:00:00Z', end: '2026-12-01T09:15:00Z' });
  expect(await calendar.deleteEvent!(first.eventId)).toMatchObject({ deleted: true });
  expect(server.events.get(first.eventId)?.status).toBe('cancelled');

  const again = await calendar.createEvent({ uid: 'standup-1', title: 'Standup, moved', start: '2026-12-02T09:00:00Z', end: '2026-12-02T09:15:00Z' });
  expect(again.eventId).toBe(first.eventId);
  expect(server.events.get(again.eventId)).toMatchObject({ status: 'confirmed', summary: 'Standup, moved', start: { dateTime: '2026-12-02T09:00:00Z' } });
});
