/**
 * A Google calendar list with no window starts at yesterday, not at the oldest
 * event: Google orders by start time, so an unbounded list returns the oldest
 * events first.
 */

import { describe, expect, test } from 'bun:test';

import { createGoogleCalendarGatewayService } from '../platform/src/platform/google/gateway-calendar-service.ts';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '../platform/src/platform/google/setup-plan.ts';
import type { GoogleConnectionSources } from '../platform/src/platform/google/connection.ts';

const NOW = Date.parse('2026-06-10T12:00:00.000Z');

function sources(): GoogleConnectionSources {
  return {
    files: { exists: () => false, readText: () => null },
    homeDirectory: '/home/tester',
    configGet: (key: string) => (key === GOOGLE_CONFIG_KEYS.oauthClientId ? 'client-123' : undefined),
    secretGet: async (key: string) => {
      if (key === GOOGLE_SECRET_KEYS.oauthClientSecret) return 'client-secret';
      if (key === GOOGLE_SECRET_KEYS.oauthRefreshToken) return 'refresh';
      return null;
    },
  };
}

function service(eventUrls: string[]) {
  return createGoogleCalendarGatewayService({
    sources: sources(),
    now: () => NOW,
    fetch: {
      fetch: async (url: string): Promise<Response> => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({ access_token: 'tok', expires_in: 3600, scope: '', token_type: 'Bearer' });
        }
        eventUrls.push(url);
        return Response.json({ items: [] });
      },
    },
  });
}

describe('google calendar list window', () => {
  test('no window sends timeMin of 24 hours ago', async () => {
    const urls: string[] = [];
    await service(urls).listEvents({});
    expect(new URL(urls[0]!).searchParams.get('timeMin')).toBe('2026-06-09T12:00:00.000Z');
  });

  test('an explicit from is passed through unchanged', async () => {
    const urls: string[] = [];
    await service(urls).listEvents({ from: '2026-01-01T00:00:00Z' });
    expect(new URL(urls[0]!).searchParams.get('timeMin')).toBe('2026-01-01T00:00:00Z');
  });

  test('export reads without the default window', async () => {
    const urls: string[] = [];
    await service(urls).exportIcs({});
    expect(new URL(urls[0]!).searchParams.has('timeMin')).toBe(false);
  });
});
