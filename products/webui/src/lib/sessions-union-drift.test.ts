/** The browser's copy of the session wire vocabulary matches the platform's. */
import { describe, expect, test } from 'bun:test';
import { SHARED_SESSION_KINDS } from '@goodvibes-jev/engine/daemon-api/runtime-session-routes';
import { KNOWN_SESSION_KINDS, SESSION_UPDATE_INTENT_MAP } from './sessions-union';

// The platform's map is not on any package subpath (and exporting it only for a test
// would widen the public API), so the source file is loaded by location. A variable
// specifier keeps it out of this project's type graph.
const PLATFORM_EVENTS_SOURCE = new URL(
  '../../../../packages/engine/platform/src/platform/control-plane/method-catalog-events.ts',
  import.meta.url,
).href;
const { SESSION_UPDATE_INTENT_MAP: PLATFORM_INTENT_MAP } = (await import(PLATFORM_EVENTS_SOURCE)) as {
  SESSION_UPDATE_INTENT_MAP: Readonly<Record<string, readonly string[]>>;
};

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('sessions-union stays in step with the platform', () => {
  test('every session-update intent and its wire events', () => {
    expect(Object.keys(SESSION_UPDATE_INTENT_MAP).sort()).toEqual(Object.keys(PLATFORM_INTENT_MAP).sort());
    for (const [intent, events] of Object.entries(PLATFORM_INTENT_MAP)) {
      expect(sorted(SESSION_UPDATE_INTENT_MAP[intent as keyof typeof SESSION_UPDATE_INTENT_MAP])).toEqual(sorted(events));
    }
  });

  test('every shared session kind', () => {
    expect(sorted(KNOWN_SESSION_KINDS)).toEqual(sorted([...SHARED_SESSION_KINDS]));
  });
});
