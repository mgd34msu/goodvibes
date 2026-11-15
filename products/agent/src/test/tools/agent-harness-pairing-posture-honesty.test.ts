import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { readConfigBooleanOrNull } from '../../tools/agent-harness-pairing-posture.ts';
import { createHarnessFixtureReadings, executeHarnessJson, makeFixture } from './agent-harness-tool-fixture.ts';

afterAll(cleanupResearchScreeningFixtures);

let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
beforeEach(() => {
  fixtureLog = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
});
afterEach(() => { installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); });

interface Posture {
  readonly pairing: { readonly endpoint: { readonly enabled: boolean | null; readonly url: string; readonly advertisedHost: string }; readonly token: { readonly path: string; readonly present: boolean } };
  readonly routes: readonly { readonly pairingRouteId: string; readonly effect: string; readonly modelRoute: string; readonly requiresConfirmation: boolean; readonly harnessRoute?: string }[];
}

function seededFixture() {
  const fixture = makeFixture();
  mkdirSync(join(fixture.root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'honesty-secret-token' }));
  return fixture;
}

describe('pairing posture a model reads', () => {
  test('the token file is named relative to the home directory, never by absolute path', async () => {
    const fixture = seededFixture();
    try {
      const posture = await executeHarnessJson<Posture>(fixture, { mode: 'pairing_posture', includeParameters: true });
      expect(posture.pairing.token.present).toBe(true);
      expect(posture.pairing.token.path).toStartWith('<home>/');
      expect(JSON.stringify(posture)).not.toContain(fixture.root);
      expect(JSON.stringify(posture)).not.toContain('honesty-secret-token');
    } finally { await fixture.cleanup(); }
  });

  test('QR and manual token display are owner-terminal routes with no model route to run them', async () => {
    const fixture = seededFixture();
    try {
      const posture = await executeHarnessJson<Posture>(fixture, { mode: 'pairing_posture', includeParameters: true });
      for (const id of ['qr-pairing', 'manual-token-display']) {
        const route = posture.routes.find((entry) => entry.pairingRouteId === id)!;
        expect(route.effect).toBe('owner-terminal-only');
        expect(route.requiresConfirmation).toBe(false);
        expect(route.modelRoute).toContain('ask the user');
        expect(route.modelRoute).not.toContain('run_command');
        expect(route.harnessRoute).toBeUndefined();
      }
    } finally { await fixture.cleanup(); }
  });

  test('an IPv6 bind host is bracketed so the advertised URL is valid', async () => {
    const fixture = seededFixture();
    try {
      fixture.configManager.setDynamic('controlPlane.hostMode', 'custom');
      fixture.configManager.setDynamic('controlPlane.host', '::1');
      const posture = await executeHarnessJson<Posture>(fixture, { mode: 'pairing_posture', includeParameters: true });
      expect(posture.pairing.endpoint.url).toStartWith('http://[::1]:');
      expect(() => new URL(posture.pairing.endpoint.url)).not.toThrow();
    } finally { await fixture.cleanup(); }
  });

  test('an unreadable web or voice setting is reported as unknown, not as disabled', async () => {
    const fixture = seededFixture();
    try {
      const manager = fixture.configManager as unknown as { get(key: string): unknown };
      const original = manager.get.bind(manager);
      // Only the posture's own reader fails; the shared config snapshot still reads the setting.
      manager.get = (key: string) => {
        if ((key === 'web.enabled' || key === 'ui.voiceEnabled') && new Error().stack?.includes('readConfigBooleanOrNull')) throw new Error('config store unreadable');
        return original(key);
      };
      const posture = await executeHarnessJson<{ routes: readonly { pairingRouteId: string; deviceCapabilityMap?: { capabilities: readonly { id: string; status: string; summary: string }[] } }[] }>(
        fixture, { mode: 'pairing_posture', includeParameters: true });
      const capabilities = posture.routes.find((route) => route.pairingRouteId === 'device-capability-map')?.deviceCapabilityMap?.capabilities ?? [];
      expect(capabilities.length).toBeGreaterThan(0);
      for (const id of ['browser-cockpit-pwa', 'voice-controls']) {
        const entry = capabilities.find((item) => item.id === id)!;
        expect(entry.status).toBe('attention');
        expect(entry.summary).toContain('could not be read');
        expect(entry.summary).not.toContain('disabled');
      }
    } finally { await fixture.cleanup(); }
  });

  test('a control-plane setting that cannot be read is unknown, not disabled', () => {
    const context = (get: (key: string) => unknown) => ({ platform: { configManager: { get } } }) as unknown as CommandContext;
    expect(readConfigBooleanOrNull(context(() => { throw new Error('config store unreadable'); }), 'controlPlane.enabled')).toBeNull();
    expect(readConfigBooleanOrNull(context(() => false), 'controlPlane.enabled')).toBe(false);
    expect(readConfigBooleanOrNull(context(() => 'true'), 'controlPlane.enabled')).toBe(true);
    expect(readConfigBooleanOrNull(context(() => undefined), 'controlPlane.enabled')).toBe(false);
  });
});
