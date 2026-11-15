import { describe, expect, test } from 'bun:test';
import {
  collectionPathFor,
  createCalDavSecretPort,
  resolveCalDavGatewayConfig,
  resolveResourceUrl,
  type CalDavGatewayConfig,
} from '../platform/src/platform/calendar/caldav-gateway-config.js';

const COLLECTION = 'https://dav.example.com/calendars/mike/personal';
const BASE = `${COLLECTION}/`;

function config(values: Record<string, unknown>) {
  const all: Record<string, unknown> = {
    'surfaces.calendar.caldavUrl': BASE,
    'surfaces.calendar.caldavUser': 'mike',
    ...values,
  };
  return { get: (key: string): unknown => { if (!(key in all)) throw new Error(`Invalid config path: ${key}`); return all[key]; } };
}

function secretsOf(entries: Record<string, string>) {
  const asked: string[] = [];
  const port = createCalDavSecretPort({ async get(key: string) { asked.push(key); return entries[key] ?? null; } });
  return { port, asked };
}

describe('the calendar password reference', () => {
  test('cannot name a secret outside the calendar namespace', async () => {
    const { port, asked } = secretsOf({ GOODVIBES_PROVIDERS_OPENAI_API_KEY: 'sk-other', GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD: 'derived' });
    await expect(resolveCalDavGatewayConfig(
      config({ 'surfaces.calendar.caldavPassword': 'goodvibes://secrets/goodvibes/GOODVIBES_PROVIDERS_OPENAI_API_KEY' }),
      port,
    )).rejects.toMatchObject({ code: 'CALENDAR_CREDENTIALS_MISSING' });
    expect(asked).not.toContain('GOODVIBES_PROVIDERS_OPENAI_API_KEY');
  });

  test('a configured reference that does not resolve is an error, not a switch to the derived secret', async () => {
    const { port } = secretsOf({ GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD: 'derived' });
    await expect(resolveCalDavGatewayConfig(
      config({ 'surfaces.calendar.caldavPassword': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_CALENDAR_RENAMED' }),
      port,
    )).rejects.toMatchObject({ code: 'CALENDAR_CREDENTIALS_MISSING' });
  });

  test('a malformed reference is a credentials error, not a decoding exception', async () => {
    const { port } = secretsOf({});
    await expect(resolveCalDavGatewayConfig(
      config({ 'surfaces.calendar.caldavPassword': 'goodvibes://secrets/goodvibes/%E0%A4%A' }),
      port,
    )).rejects.toMatchObject({ code: 'CALENDAR_CREDENTIALS_MISSING' });
  });
});

describe('event and calendar ids cannot leave their calendar', () => {
  const settings: CalDavGatewayConfig = { baseUrl: BASE, username: 'mike', password: 'x', defaultCalendarId: 'default', collectionMap: {} };

  test('dot segments in an href or a resource name are refused', () => {
    expect(() => resolveResourceUrl(COLLECTION, BASE, '/calendars/mike/personal/../../admin/x.ics')).toThrow(/not inside the requested calendar/);
    expect(() => resolveResourceUrl(COLLECTION, BASE, '../../admin/x.ics')).toThrow(/not inside the requested calendar/);
    expect(() => resolveResourceUrl(COLLECTION, BASE, '/calendars/mike/personal/%2e%2e/%2e%2e/admin/x.ics')).toThrow(/not inside the requested calendar/);
    expect(resolveResourceUrl(COLLECTION, BASE, '/calendars/mike/personal/a.ics')).toBe(`${COLLECTION}/a.ics`);
    expect(resolveResourceUrl(COLLECTION, BASE, 'b.ics')).toBe(`${COLLECTION}/b.ics`);
  });

  test('a calendar id of .. is not turned into a parent collection', () => {
    expect(() => collectionPathFor(settings, '..')).toThrow(/not a calendar name/);
    expect(collectionPathFor(settings, 'work')).toBe('/work/');
  });
});
