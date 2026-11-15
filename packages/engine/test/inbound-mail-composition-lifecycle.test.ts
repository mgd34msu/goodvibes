/** What composeInboundMail starts alongside the supervisor stops with it, and reads settings when a source is built. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as inbound from '../platform/src/platform/email/inbound/index.js';
import { readSurfaceEmailSettings } from '../platform/src/platform/email/surface-config.js';
import { composeInboundMail } from '../platform/src/platform/daemon/facade-inbound-mail.js';

let factoryDeps: { settings: Record<string, unknown>; getConfig: (key: string) => unknown } | undefined;
const realFactory = inbound.createInboundMailSourceFactory;
spyOn(inbound, 'createInboundMailSourceFactory').mockImplementation(((deps: NonNullable<typeof factoryDeps>) => {
  factoryDeps = deps; return realFactory(deps as never);
}) as never);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function compose(values: Record<string, unknown>, describe?: (key: string) => { tier: string }) {
  const root = mkdtempSync(join(tmpdir(), 'gv-inbound-lifecycle-')); dirs.push(root);
  const unsubscribed: string[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const native = globalThis.setInterval;
  const arm = spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => { const timer = native(...args); timers.push(timer); return timer; }) as typeof setInterval);
  const cleared: unknown[] = [];
  const nativeClear = globalThis.clearInterval;
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(((timer: Parameters<typeof clearInterval>[0]) => { cleared.push(timer); nativeClear(timer); }) as typeof clearInterval);
  try {
    const supervisor = composeInboundMail({
      configManager: { get: (key: string) => values[key], ...(describe ? { describeConfigKeySource: describe } : {}), onDidChangeIncarnation: () => () => { unsubscribed.push('config'); } } as never,
      secretsManager: { get: async () => null, onDidInvalidateCredentials: () => () => { unsubscribed.push('credentials'); } } as never,
      shellPaths: { resolveUserPath: (_scope: string, name: string) => join(root, name) } as never,
      routeBindings: { listBindings: () => [], getBinding: () => undefined, isRouteBindingEnabled: () => true } as never,
      gatewayMethods: { get: (id: string) => ({ id }), register: () => {} } as never,
      deliverStructuredNotice: async () => ({ delivered: true }) as never,
      gmailReader: async () => ({ kind: 'unavailable' as const, detail: 'No Google account is connected.', fix: '' }),
    });
    expect(supervisor).not.toBeNull();
    return { supervisor: supervisor!, timers, cleared, unsubscribed, release: () => { clear.mockRestore(); for (const timer of timers) nativeClear(timer); } };
  } finally { arm.mockRestore(); }
  // clearInterval stays observed until the caller releases, so a later stop() is seen.
}
const baseValues = (): Record<string, unknown> => ({ 'surfaces.email.inbound.enabled': true, 'surfaces.email.inbound.accounts': JSON.stringify(['primary']),
  'surfaces.email.inbound.source': 'imap', 'surfaces.email.inbound.notice.mode': 'none', 'surfaces.email.inbound.notice.route': 'default',
  'surfaces.email.imap.host': 'imap.example.test', 'surfaces.email.user': 'watched@example.test' });

test('stopping the supervisor stops the housekeeping and expectation timers and releases the listeners', async () => {
  const rig = compose(baseValues());
  expect(rig.timers).toHaveLength(2);
  try {
    await rig.supervisor.stop();
    expect(rig.cleared).toEqual(expect.arrayContaining(rig.timers));
    expect(rig.unsubscribed.sort()).toEqual(['config', 'credentials']);
  } finally { rig.release(); }
});

test('a recheck cadence changed while the daemon runs is what the next source is built with', () => {
  const values = { ...baseValues(), 'surfaces.email.inbound.capabilityRecheckMinutes': 60, 'surfaces.email.inbound.pollIntervalSeconds': 120 };
  const rig = compose(values);
  try {
    expect(factoryDeps!.settings.capabilityRecheckMs).toBe(60 * 60_000);
    values['surfaces.email.inbound.capabilityRecheckMinutes'] = 5;
    values['surfaces.email.inbound.pollIntervalSeconds'] = 30;
    expect(factoryDeps!.settings.capabilityRecheckMs).toBe(5 * 60_000);
    expect({ ...factoryDeps!.settings }).toMatchObject({ capabilityRecheckMs: 5 * 60_000, pollIntervalMs: 30_000 });
  } finally { rig.release(); }
});

test('the inbound source factory reads ports with the origin-aware reader, so an explicit default-valued port is kept', () => {
  // The manager answers 993 for an unset imap.port too; only its origin says the operator chose it.
  const values = { ...baseValues(), 'surfaces.email.imap.port': 993, 'surfaces.email.imap.secure': false };
  const rig = compose(values, (key) => ({ tier: key === 'surfaces.email.imap.port' ? 'global' : 'default' }));
  try {
    expect(readSurfaceEmailSettings(factoryDeps!.getConfig).imapPort).toBe(993);
  } finally { rig.release(); }
});
