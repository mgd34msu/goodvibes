import { describe, expect, test } from 'bun:test';
import type { CalendarSubscriptionRegistry, SubscriptionSecretStore } from '../../agent/calendar-subscription-registry.ts';
import { scheduleCalendarSubscriptionBootRefresh } from '../../runtime/calendar-boot-refresh.ts';

const secrets: SubscriptionSecretStore = { get: async () => null, set: async () => {}, delete: async () => {} };

describe('boot refresh pass that throws', () => {
  test('is reported as one visible line instead of leaving the calendar silently stale', async () => {
    const lines: string[] = [];
    let renders = 0;
    await scheduleCalendarSubscriptionBootRefresh({
      shellPaths: { resolveUserPath: () => '/unused' },
      secretsManager: secrets,
      systemMessageRouter: { low: (message: string) => { lines.push(message); } },
      requestRender: () => { renders += 1; },
      buildRegistry: () => ({ hasAny: () => true, refresh: async () => { throw new Error('disk unreadable'); } }) as unknown as CalendarSubscriptionRegistry,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[Calendar] refresh failed: disk unreadable');
    expect(renders).toBe(1);
  });

  test('a registry that cannot even be built is reported the same way', async () => {
    const lines: string[] = [];
    await scheduleCalendarSubscriptionBootRefresh({
      shellPaths: { resolveUserPath: () => '/unused' },
      secretsManager: secrets,
      systemMessageRouter: { low: (message: string) => { lines.push(message); } },
      requestRender: () => {},
      buildRegistry: () => { throw new Error('store corrupt'); },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('store corrupt');
  });
});
