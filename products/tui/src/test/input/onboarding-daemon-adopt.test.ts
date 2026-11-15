import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { handleConnectExistingDaemonForHandler } from '../../input/handler-onboarding-daemon-adopt.ts';
import type { InputHandlerLike } from '../../input/handler-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let root: string;
beforeEach(() => { root = makeProjectTempDir('onboarding-daemon-adopt'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function harness(restart: () => Promise<unknown>, blockers: readonly string[] = []) {
  const home = join(root, 'home');
  const configManager = new ConfigManager({ surfaceRoot: 'tui', homeDir: home, workingDir: join(root, 'workspace') });
  const printed: string[] = [];
  const fields: Record<string, string | number> = {
    'network.adopt-daemon-host': 'wrong.example.test',
    'network.adopt-daemon-port': 4999,
    'network.adopt-daemon-token': 'pasted-token',
  };
  const handler = {
    onboardingOperation: null,
    onboardingWizard: {
      getStringFieldValue: (id: string, fallback: string) => String(fields[id] ?? fallback),
      getPortFieldValue: (id: string, fallback: number) => Number(fields[id] ?? fallback),
      getBlockingFieldLabels: () => blockers,
    },
    uiServices: {
      environment: { homeDirectory: home },
      platform: { configManager, externalServices: { restart } },
    },
    commandContext: { print: (text: string) => { printed.push(text); } },
    requestRender() {},
  } as unknown as InputHandlerLike;
  return { handler, configManager, printed, daemonHome: join(home, '.goodvibes', 'daemon') };
}

describe('Connect to existing daemon', () => {
  test('a verified daemon becomes this terminal\'s target and the local bind is not moved', async () => {
    const { handler, configManager } = harness(async () => ({ daemonStatus: { mode: 'external', host: 'wrong.example.test', port: 4999, baseUrl: 'http://wrong.example.test:4999' } }));
    const bind = { host: configManager.get('controlPlane.host'), port: configManager.get('controlPlane.port') };

    await handleConnectExistingDaemonForHandler(handler);

    expect(configManager.get('daemon.connectedHost.url')).toBe('http://wrong.example.test:4999');
    expect({ host: configManager.get('controlPlane.host'), port: configManager.get('controlPlane.port') }).toEqual(bind);
  });

  test('a daemon that cannot be verified leaves host, port and token as they were', async () => {
    let restarts = 0;
    const { handler, configManager, printed, daemonHome } = harness(async () => { restarts++; return {}; });
    mkdirSync(daemonHome, { recursive: true });
    const tokenFile = join(daemonHome, 'operator-tokens.json');
    const original = '{"token":"gv_original","peerId":"p","createdAt":1}';
    writeFileSync(tokenFile, original, { mode: 0o600 });
    const before = {
      hostMode: configManager.get('controlPlane.hostMode'),
      host: configManager.get('controlPlane.host'),
      port: configManager.get('controlPlane.port'),
      url: configManager.get('daemon.connectedHost.url'),
    };

    await handleConnectExistingDaemonForHandler(handler);

    expect({
      hostMode: configManager.get('controlPlane.hostMode'),
      host: configManager.get('controlPlane.host'),
      port: configManager.get('controlPlane.port'),
      url: configManager.get('daemon.connectedHost.url'),
    }).toEqual(before);
    expect(readFileSync(tokenFile, 'utf8')).toBe(original);
    expect(printed.join('\n')).toContain('could not verify');
    expect(printed.join('\n')).toContain('were restored and the connection was restarted');
    // One restart to try the new endpoint, one to move the live connection back to the old one.
    expect(restarts).toBe(2);
  });

  test('a restart that throws removes a token file the attempt created and restores the config', async () => {
    const { handler, configManager, printed, daemonHome } = harness(async () => { throw new Error('restart refused'); });
    const before = configManager.get('controlPlane.port');

    await handleConnectExistingDaemonForHandler(handler);

    expect(configManager.get('controlPlane.port')).toBe(before);
    expect(configManager.get('daemon.connectedHost.url')).toBe('');
    expect(existsSync(join(daemonHome, 'operator-tokens.json'))).toBe(false);
    expect(printed.join('\n')).toContain('restart refused');
    expect(printed.join('\n')).toContain('were restored, but restarting the connection on them failed');
  });

  test('an invalid host or port is reported and nothing is changed or restarted', async () => {
    let restarts = 0;
    const { handler, configManager, printed, daemonHome } = harness(async () => { restarts++; return {}; },
      ['Network: Existing daemon port must be a port number from 1 to 65535.']);
    const before = configManager.get('controlPlane.port');

    await handleConnectExistingDaemonForHandler(handler);

    expect(restarts).toBe(0);
    expect(configManager.get('controlPlane.port')).toBe(before);
    expect(existsSync(join(daemonHome, 'operator-tokens.json'))).toBe(false);
    expect(printed.join('\n')).toContain('Existing daemon port must be a port number');
  });
});
