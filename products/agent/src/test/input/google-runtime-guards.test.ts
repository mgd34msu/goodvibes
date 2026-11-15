import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { FeedFetcher } from '@goodvibes-jev/engine/platform/platform/calendar';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '@goodvibes-jev/engine/platform/platform/google';
import type { CommandContext } from '../../input/command-registry.ts';
import { subscriptionRegistryForRead } from '../../input/commands/calendar-subscription-runtime.ts';
import { forgetGoogleCredentials } from '../../input/commands/google-connection-actions.ts';
import { runGoogleCommand } from '../../input/commands/google-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const ICS = 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Private\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Standup\r\nDTSTART:20260706T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
const ICAL_URL = 'https://calendar.google.com/calendar/ical/me%40example.test/private-token/basic.ics';

function rig() {
  const root = makeProjectTempDir('google-runtime-guards');
  const out: string[] = [];
  const secrets = new Map<string, string>();
  const config = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json') });
  const ctx = {
    session: { runtime: { sessionId: 'google-guards' } },
    workspace: { shellPaths: { homeDirectory: root, resolveUserPath: (_surface: string, ...parts: string[]) => join(root, ...parts) } },
    platform: {
      configManager: config,
      secretsManager: {
        get: async (key: string) => secrets.get(key) ?? null,
        set: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); },
      },
    },
    print: (text: string) => { out.push(text); },
  } as unknown as CommandContext;
  return { ctx, out, secrets, config };
}

const okFeed: FeedFetcher = async () => ({ kind: 'ok', body: ICS });
const failedFeed: FeedFetcher = async () => ({ kind: 'error', message: 'host unreachable' });

describe('/google calendar-address', () => {
  test('subscribes to the address so /calendar can read events from it', async () => {
    const { ctx, out, secrets, config } = rig();
    await runGoogleCommand(['calendar-address', ICAL_URL], ctx, okFeed);
    expect(out.join('\n')).toContain("subscribed to it as 'Google calendar' (1 events loaded)");
    const statuses = await subscriptionRegistryForRead(ctx).statuses();
    expect(statuses.map((status) => status.name)).toEqual(['Google calendar']);
    expect(secrets.get(GOOGLE_SECRET_KEYS.calendarIcsUrl)).toBe(ICAL_URL);
    const storedAddress: unknown = config.get(GOOGLE_CONFIG_KEYS.calendarIcsUrl as never);
    expect(storedAddress).toBe(GOOGLE_CONFIG_KEYS.calendarIcsUrl);
  });

  test('forget removes the feed subscription and its stored address, and the address can then be set again', async () => {
    const { ctx, out, secrets } = rig();
    await runGoogleCommand(['calendar-address', ICAL_URL], ctx, okFeed);
    await runGoogleCommand(['forget', '--yes'], ctx, okFeed);
    expect(await subscriptionRegistryForRead(ctx).statuses()).toEqual([]);
    expect([...secrets.values()]).not.toContain(ICAL_URL);
    expect(out.join('\n')).toContain("Removed the 'Google calendar' calendar feed");
    out.length = 0;
    await runGoogleCommand(['calendar-address', ICAL_URL], ctx, okFeed);
    expect(out.join('\n')).toContain("subscribed to it as 'Google calendar'");
    expect(secrets.get(GOOGLE_SECRET_KEYS.calendarIcsUrl)).toBe(ICAL_URL);
  });

  test('the workspace card path (forgetGoogleCredentials) also removes the feed subscription and its private address', async () => {
    const { ctx, secrets } = rig();
    await runGoogleCommand(['calendar-address', ICAL_URL], ctx, okFeed);
    const receipt = await forgetGoogleCredentials(ctx, ['refresh-token', 'client-secret', 'app-password', 'calendar-address'], true);
    expect(await subscriptionRegistryForRead(ctx).statuses()).toEqual([]);
    expect([...secrets.values()]).not.toContain(ICAL_URL);
    expect(receipt).toContain("Removed the 'Google calendar' calendar feed");
  });

  test('forgetting without the calendar address, or without a yes, leaves the feed subscribed', async () => {
    const { ctx } = rig();
    await runGoogleCommand(['calendar-address', ICAL_URL], ctx, okFeed);
    await forgetGoogleCredentials(ctx, ['refresh-token'], true);
    await forgetGoogleCredentials(ctx, ['calendar-address'], false);
    expect((await subscriptionRegistryForRead(ctx).statuses()).map((status) => status.name)).toEqual(['Google calendar']);
  });

  test('setting a new address replaces the earlier feed instead of failing as a duplicate', async () => {
    const { ctx, out, secrets } = rig();
    const second = 'https://calendar.google.com/calendar/ical/me%40example.test/rotated-token/basic.ics';
    await runGoogleCommand(['calendar-address', ICAL_URL], ctx, okFeed);
    out.length = 0;
    await runGoogleCommand(['calendar-address', second], ctx, okFeed);
    expect(out.join('\n')).not.toContain('Nothing was stored');
    expect((await subscriptionRegistryForRead(ctx).statuses()).map((status) => status.name)).toEqual(['Google calendar']);
    expect(secrets.get(GOOGLE_SECRET_KEYS.calendarIcsUrl)).toBe(second);
    expect([...secrets.values()]).not.toContain(ICAL_URL);
  });

  test('an address that cannot be read stores nothing and says why, instead of reporting success', async () => {
    const { ctx, out, secrets } = rig();
    await runGoogleCommand(['calendar-address', ICAL_URL], ctx, failedFeed);
    const text = out.join('\n');
    expect(text).toContain('Nothing was stored');
    expect(text).toContain('host unreachable');
    expect(secrets.size).toBe(0);
    expect(await subscriptionRegistryForRead(ctx).statuses()).toEqual([]);
  });

  test('a new address that cannot be read leaves the working feed and its stored address in place', async () => {
    const { ctx, secrets } = rig();
    await runGoogleCommand(['calendar-address', ICAL_URL], ctx, okFeed);
    await runGoogleCommand(['calendar-address', `${ICAL_URL}-typo`], ctx, failedFeed);
    expect((await subscriptionRegistryForRead(ctx).statuses()).map((status) => status.name)).toEqual(['Google calendar']);
    expect(secrets.get(GOOGLE_SECRET_KEYS.calendarIcsUrl)).toBe(ICAL_URL);
  });

  test('an address that is not https is refused before any fetch', async () => {
    const { ctx, out, secrets } = rig();
    let fetched = 0;
    await runGoogleCommand(['calendar-address', 'http://example.test/basic.ics'], ctx, async () => { fetched += 1; return { kind: 'ok', body: ICS }; });
    expect(fetched).toBe(0);
    expect(secrets.size).toBe(0);
    expect(out.join('\n')).toContain('Give the private iCal address');
  });
});

describe('/google setup --path', () => {
  test('a mistyped path runs nothing and names the valid ones', async () => {
    const { ctx, out, secrets } = rig();
    await runGoogleCommand(['setup', '--path', 'oauhth'], ctx);
    expect(out.join('\n')).toContain('Unknown setup path');
    expect(out.join('\n')).toContain('app-password|oauth|existing-client');
    expect(secrets.size).toBe(0);
  });

  test('a path flag with no value is also refused', async () => {
    const { ctx, out } = rig();
    await runGoogleCommand(['setup', '--path'], ctx);
    expect(out.join('\n')).toContain('Unknown setup path');
  });
});
