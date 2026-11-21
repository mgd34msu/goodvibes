// Proves: Changing an event on the owner's CalDAV calendar erases its organizer's or attendees' names, answers and roles.
// Red when: An update rewrites the stored ORGANIZER or a kept ATTENDEE line from its bare address, or keeps an attendee the update removed.
/**
 * A CalDAV event carries who organised it and, per attendee, a display name,
 * the answer they gave (PARTSTAT) and their role. Those lines were written by
 * the calendar and the attendees, not by us: an update made here must not
 * rewrite them from the bare address.
 *
 * Real daemon calendar composition over the real settings and secret stores and
 * the real fetch transport; the CalDAV server is a loopback stand-in that keeps
 * whatever it was last PUT and checks If-Match.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { daemonSecretKeyFor } from '../platform/src/platform/config/daemon-secret-keys.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { createDaemonCalendarGatewayService } from '../platform/src/platform/control-plane/routes/calendar-composition.ts';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const HREF = '/dav/owner/personal/planning.ics';
const ORGANIZER = 'ORGANIZER;CN="Olivia Owner":mailto:owner@example.test';
const JANE = 'ATTENDEE;CN="Jane Doe";PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:jane@example.test';
const BOB = 'ATTENDEE;CN="Bob Roe";PARTSTAT=TENTATIVE;ROLE=OPT-PARTICIPANT:mailto:bob@example.test';
const STORED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Calendar//EN',
  'BEGIN:VEVENT', 'UID:planning-1@example.test', 'DTSTAMP:20261120T090000Z',
  'DTSTART:20261201T100000Z', 'DTEND:20261201T110000Z', 'SUMMARY:Planning',
  ORGANIZER, JANE, BOB,
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

/** The CalDAV server: one stored event, a new ETag on every PUT, If-Match checked. */
function caldavServer() {
  const store = { body: STORED, etag: '"v1"', version: 1 };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== HREF) return new Response('', { status: 404 });
      if (request.method === 'GET') return new Response(store.body, { headers: { ETag: store.etag, 'Content-Type': 'text/calendar' } });
      if (request.method === 'PUT') {
        const match = request.headers.get('If-Match');
        if (match !== null && match !== store.etag) return new Response('', { status: 412 });
        store.body = await request.text();
        store.version += 1;
        store.etag = `"v${String(store.version)}"`;
        return new Response(null, { status: 204, headers: { ETag: store.etag } });
      }
      return new Response('', { status: 405 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { port: server.port, store };
}

/** The ORGANIZER and ATTENDEE lines of the stored event, unfolded. */
function participants(body: string): string[] {
  return body.replace(/\r\n[ \t]/g, '').split('\r\n').filter((line) => /^(ORGANIZER|ATTENDEE)[;:]/i.test(line));
}

test('an update keeps the organizer and every unchanged attendee line as stored, and drops only an attendee it removes', async () => {
  const server = caldavServer();
  const root = mkdtempSync(join(tmpdir(), 'gv-caldav-update-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configManager = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json'), ownsDaemonTier: true });
  expect(configManager.setMany([
    { key: 'surfaces.calendar.caldavUrl' as ConfigKey, value: `http://127.0.0.1:${String(server.port)}/dav/owner/personal/` },
    { key: 'surfaces.calendar.caldavUser' as ConfigKey, value: 'owner@example.test' },
  ], localOwnerActor()).ok).toBe(true);
  const secretsManager = new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: join(root, 'home'), projectRoot: root, policy: 'plaintext_allowed' });
  await secretsManager.set(daemonSecretKeyFor('surfaces.calendar.caldavPassword'), 'calendar-app-password', { scope: 'user' });
  const calendar = createDaemonCalendarGatewayService({ configManager, secretsManager, untrustedContentLedger: new UntrustedContentLedger() })!;

  // A title-only change: nobody's line is touched.
  await calendar.updateEvent!(HREF, { title: 'Quarterly planning' });
  expect(server.store.body).toContain('SUMMARY:Quarterly planning');
  expect(participants(server.store.body)).toEqual([ORGANIZER, JANE, BOB]);

  // The attendee list named: Jane stays as she answered, Bob goes, a new guest is added.
  await calendar.updateEvent!(HREF, { attendees: ['jane@example.test', 'new@example.test'] });
  const after = participants(server.store.body);
  expect(after.filter((line) => !/new@example\.test/i.test(line))).toEqual([ORGANIZER, JANE]);
  expect(after.filter((line) => /^ATTENDEE[;:].*mailto:new@example\.test$/i.test(line))).toHaveLength(1);
});
