/**
 * calendar-oauth-config-failures.test.ts, a bad setting is a staged config
 * failure, and one broken provider does not hide the other's events.
 */

import { describe, expect, test } from 'bun:test';
import type { CalendarConnector } from '@goodvibes-jev/engine/platform/platform/calendar';
import {
  CalendarOAuthService,
  type CalendarConfigReader,
  type CalendarSecretSlice,
} from '../../agent/calendar/calendar-oauth-service.ts';

const secrets = (): CalendarSecretSlice => ({ get: async () => null, set: async () => {}, delete: async () => {} });
const config = (values: Record<string, unknown>): CalendarConfigReader => ({ get: (key: string) => values[key] });
const boom = () => { throw new Error('connector should not be called'); };

// A client secret reference whose % sequence cannot be decoded.
const MALFORMED = { 'calendar.google.clientId': 'id', 'calendar.google.clientSecretRef': 'goodvibes://secrets/goodvibes/100%' };

describe('a malformed secret reference', () => {
  for (const method of ['connectLoopback', 'connectDeviceCode', 'connectAuto'] as const) {
    test(`${method} returns a config-stage failure instead of throwing`, async () => {
      const service = new CalendarOAuthService({
        config: config(MALFORMED), secrets: secrets(),
        connector: { beginConnectAuthCode: boom, beginConnectDeviceCode: boom, listAccounts: async () => [] } as unknown as CalendarConnector,
      });

      const result = await service[method]('google');

      expect(result).toMatchObject({ ok: false, stage: 'config', error: expect.stringContaining('calendar.google.clientSecretRef') });
    });
  }
});

describe('listing events across providers', () => {
  const event = (title: string) => ({ title }) as never;

  test('events from the readable provider are returned and the broken one is reported', async () => {
    const connector = {
      listAccounts: async () => [{ provider: 'google' }, { provider: 'microsoft' }],
      listEvents: async (cfg: { provider: string }) => [event(`from ${cfg.provider}`)],
    } as unknown as CalendarConnector;
    const service = new CalendarOAuthService({
      config: config({ ...MALFORMED, 'calendar.microsoft.clientId': 'ms-id' }), secrets: secrets(), connector,
    });

    const result = await service.listEventsDetailed({ start: '2026-01-01', end: '2026-01-02' } as never);

    expect(result.events).toEqual([event('from microsoft')]);
    expect(result.failures).toEqual([{ provider: 'google', error: expect.stringContaining('malformed') }]);
    expect(await service.listEvents({ start: '2026-01-01', end: '2026-01-02' } as never)).toEqual([event('from microsoft')]);
  });
});
