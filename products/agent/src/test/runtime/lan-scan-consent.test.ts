import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import type { BackgroundProviderDiscoveryOptions, BackgroundRuntimeTaskHandle, HostSystemMessageSink } from '@/runtime/index.ts';
import {
  discoveredProvidersFilePath,
  loadLanScanConsent,
  runGatedLanScan,
  saveLanScanConsent,
  NETWORK_SCAN_ENABLE_COMMAND,
  type LanScanGateOptions,
} from '../../runtime/lan-scan-consent.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SURFACE_ROOT = 'agent';

/**
 * A recording fake for the {low, high} system-message sink. Never a real
 * router, just captures what was sent so tests can assert on exact wording
 * and on the absence of raw host:port text.
 */
function makeRouterSpy() {
  const low: string[] = [];
  const high: string[] = [];
  const router: HostSystemMessageSink = {
    low: (m: string) => low.push(m),
    high: (m: string) => high.push(m),
  };
  return { router, low, high };
}

function makeGateOptions(root: string, overrides: Partial<LanScanGateOptions> = {}): LanScanGateOptions {
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const { router } = makeRouterSpy();
  return {
    configManager: {} as unknown as BackgroundProviderDiscoveryOptions['configManager'],
    providerRegistry: {} as unknown as BackgroundProviderDiscoveryOptions['providerRegistry'],
    runtime: { model: 'openrouter:openrouter/free', provider: 'openrouter' },
    requestRender: () => {},
    restoreRuntimeModel: () => {},
    systemMessageRouter: router,
    shellPaths,
    surfaceRoot: SURFACE_ROOT,
    ...overrides,
  };
}

/** A fake discovery pass, this is the ONLY thing allowed to stand in for the
 * platform's real subnet scan in tests. It never touches the network. */
function fakeDiscovery(
  emit: (opts: BackgroundProviderDiscoveryOptions) => void,
): { readonly fn: (opts: BackgroundProviderDiscoveryOptions) => BackgroundRuntimeTaskHandle; calls: number } {
  let calls = 0;
  const fn = (opts: BackgroundProviderDiscoveryOptions): BackgroundRuntimeTaskHandle => {
    calls += 1;
    emit(opts);
    return { stopped: false, stop() {} };
  };
  return { fn, get calls() { return calls; } };
}

describe('lan-scan-consent: persistence', () => {
  test('loadLanScanConsent returns undefined when nothing has ever been decided', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)).toBeUndefined();
  });

  test('saveLanScanConsent + loadLanScanConsent round-trips granted and declined', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });

    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'granted');
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)?.decision).toBe('granted');

    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'declined');
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)?.decision).toBe('declined');
  });

  test('an invalid/corrupt consent file is treated as undecided, not a crash', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const path = shellPaths.resolveUserPath(SURFACE_ROOT, 'network-discovery-consent.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json', 'utf-8');
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)).toBeUndefined();
  });

  test('discoveredProvidersFilePath points at the same location the platform persists scan results to', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    expect(discoveredProvidersFilePath(shellPaths, SURFACE_ROOT)).toBe(
      join(root, '.goodvibes', SURFACE_ROOT, 'discovered-providers.json'),
    );
  });
});

describe('runGatedLanScan: the network is scanned only with consent (test doubles only: never a real network probe)', () => {
  function recordRun(root: string, router = makeRouterSpy().router) {
    const runs: BackgroundProviderDiscoveryOptions[] = [];
    runGatedLanScan(makeGateOptions(root, { systemMessageRouter: router, startDiscovery: (opts) => {
      runs.push(opts);
      return { stopped: false, stop() {} };
    } }));
    return runs;
  }

  test('first run: this computer is scanned, the network is not, and the network scan is explained once and recorded off', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const { router, low } = makeRouterSpy();
    const runs = recordRun(root, router);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.registerNetworkServers).toBe(false);
    expect(low).toHaveLength(1);
    expect(low[0]).toContain(NETWORK_SCAN_ENABLE_COMMAND);
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)?.decision).toBe('declined');
  });

  test('declined: still a local pass, never the network, and no repeated reminder', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    saveLanScanConsent(createShellPathService({ workingDirectory: root, homeDirectory: root }), SURFACE_ROOT, 'declined');
    const { router, low } = makeRouterSpy();
    const runs = recordRun(root, router);
    expect(runs.map((run) => run.registerNetworkServers)).toEqual([false]);
    expect(low).toEqual([]);
  });

  test('granted: the network is scanned', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    saveLanScanConsent(createShellPathService({ workingDirectory: root, homeDirectory: root }), SURFACE_ROOT, 'granted');
    expect(recordRun(root).map((run) => run.registerNetworkServers)).toEqual([true]);
  });

  test('the report is worded as counts, never a host:port', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const { router, low } = makeRouterSpy();
    const runs = recordRun(root, router);
    const server = { name: 'LM Studio', host: '10.0.0.5', port: 1234, models: 3 };
    runs[0]!.report?.restored?.({ registered: [server], unregisteredNetwork: [server] });
    runs[0]!.report?.scanned?.({ found: [server, server], kept: [server], unregisteredNetwork: [] });
    const said = low.slice(1);
    expect(said).toHaveLength(4);
    for (const line of said) expect(line).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });
});
