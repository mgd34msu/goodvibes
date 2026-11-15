/**
 * connector-settings-behavior.test.ts, behaviour coverage for the calendar
 * connector's settings (`calendar.*`). The mailbox is `surfaces.email.*`.
 *
 * Every key below is driven to at least two distinct values through the REAL
 * code in this repository that consumes it, and each assertion is an
 * observable difference in outcome between those values. A ConfigManager
 * set/get round-trip would verify ConfigManager, not the setting, and
 * settings-behavior-coverage.ts rules it out by name, so nothing here is one.
 *
 *  - `CalendarOAuthService` (agent/calendar/calendar-oauth-service.ts) resolves
 *    the operator's own OAuth app out of config plus the secret store.
 *  - `resolveCapabilityIndex` (capabilities/capability-index.ts) decides what
 *    the agent tells its owner it can do, and `calendar.google.icsUrl` is one
 *    of the two configuration-evidence probes behind "read the calendar".
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { CalendarConnector } from '@goodvibes-jev/engine/platform/platform/calendar';
import {
  CalendarOAuthService,
  type CalendarSecretSlice,
} from '../../agent/calendar/calendar-oauth-service.ts';
import { registerBuiltinCapabilities } from '../../capabilities/builtin-capabilities.ts';
import {
  resetCapabilityIndexForTests,
  resolveCapabilityIndex,
} from '../../capabilities/capability-index.ts';
import { emptyProbeContext, type ProbeContext } from '../../capabilities/capability-probe-runner.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// calendar.google.clientSecretRef through the real OAuth service
// ---------------------------------------------------------------------------

function memorySecrets(): CalendarSecretSlice & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async set(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

/** Fails loudly if a resolution test ever reaches the network. */
function throwingConnector(): CalendarConnector {
  const boom = () => { throw new Error('connector should not be called'); };
  return { beginConnectAuthCode: boom, beginConnectDeviceCode: boom, listAccounts: async () => [] } as unknown as CalendarConnector;
}

describe('calendar.google.clientSecretRef decides whether a confidential client can authenticate', () => {
  test('unset resolves no client secret; a stored reference resolves the value from the secret store', async () => {
    const secrets = memorySecrets();
    await secrets.set('GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF', 'google-confidential-secret');

    const withoutRef = new CalendarOAuthService({
      config: { get: (key: string) => ({ 'calendar.google.clientId': 'google-id' } as Record<string, unknown>)[key] },
      secrets: memorySecrets(),
      connector: throwingConnector(),
    });
    const withRef = new CalendarOAuthService({
      config: {
        get: (key: string) => ({
          'calendar.google.clientId': 'google-id',
          'calendar.google.clientSecretRef': 'goodvibes://secrets/goodvibes/GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF',
        } as Record<string, unknown>)[key],
      },
      secrets,
      connector: throwingConnector(),
    });

    // A Desktop-app client using PKCE needs no secret, so "unset" is a real
    // configuration rather than an error, but a Web-app registration cannot
    // exchange a code without one, and this is where that value comes from.
    expect((await withoutRef.resolveOverrides('google')).clientSecret).toBeUndefined();
    expect((await withRef.resolveOverrides('google')).clientSecret).toBe('google-confidential-secret');
  });
});

// ---------------------------------------------------------------------------
// calendar.google.icsUrl through the capability index
// ---------------------------------------------------------------------------

describe('calendar.google.icsUrl is configuration evidence for reading the calendar', () => {
  let home = '';

  beforeEach(() => {
    // Deliberately bare: no ~/.gmail-mcp credentials and no OAuth client id, so
    // the calendar capability is in needs-setup and the only thing that can
    // move is the feed address.
    home = makeProjectTempDir('gv-connector-ics');
    resetCapabilityIndexForTests();
    registerBuiltinCapabilities({ homeDirectory: home, workingDirectory: home });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    resetCapabilityIndexForTests();
  });

  function context(icsUrlPresent: boolean): ProbeContext {
    return {
      ...emptyProbeContext(),
      registeredToolNames: new Set(['google']),
      configValuePresent: (key: string) => icsUrlPresent && key === 'calendar.google.icsUrl',
    };
  }

  test('with a feed address configured the index reports a disagreement instead of a silent needs-setup', () => {
    const without = resolveCapabilityIndex(context(false), { homeDirectory: home });
    const withFeed = resolveCapabilityIndex(context(true), { homeDirectory: home });

    // Same machine, same routes, one setting different.
    expect(without.needsSetup).toContain('calendar.read');
    expect(withFeed.needsSetup).toContain('calendar.read');

    expect(without.disagreements.some((entry) => entry.capabilityId === 'calendar.read')).toBe(false);

    const flagged = withFeed.disagreements.find((entry) => entry.capabilityId === 'calendar.read');
    expect(flagged).toBeDefined();
    // The evidence names the feed, so the owner is told what was found rather
    // than being told the calendar is simply not set up.
    expect(flagged!.evidence.join(' ')).toContain('calendar.google.icsUrl');
  });
});
