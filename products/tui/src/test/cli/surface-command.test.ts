import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { parseGoodVibesCli, type CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import { handleSurfacesCommand } from '../../cli/surface-command.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runtimeFor(argv: string[]): CliCommandRuntime {
  const root = mkdtempSync(join(tmpdir(), 'tui-surfaces-')); roots.push(root);
  const workingDir = join(root, 'project'); mkdirSync(workingDir);
  const configDir = join(root, 'config'); mkdirSync(configDir);
  const configManager = new ConfigManager({ homeDir: root, workingDir, configDir, surfaceRoot: 'tui' });
  return { cli: parseGoodVibesCli(argv, 'goodvibes'), configManager, workingDirectory: workingDir, homeDirectory: root };
}

describe('goodvibes surfaces enable', () => {
  test('enabling an external surface says the HTTP listener now binds every interface', async () => {
    const runtime = runtimeFor(['surfaces', 'enable', 'slack']);
    expect(runtime.configManager.get('httpListener.hostMode')).toBe('local');
    const result = await handleSurfacesCommand(runtime);
    expect(result.exitCode).toBe(0);
    expect(runtime.configManager.get('httpListener.host')).toBe('0.0.0.0');
    expect(result.output).toContain('http-listener: network 0.0.0.0:');
    expect(result.output).toContain('reachable from other machines');
  });

  test('--hostname 127.0.0.1 keeps an external surface on loopback and the output does not claim exposure', async () => {
    const runtime = runtimeFor(['surfaces', 'enable', 'slack', '--hostname', '127.0.0.1']);
    const result = await handleSurfacesCommand(runtime);
    expect(result.exitCode).toBe(0);
    expect(runtime.configManager.get('httpListener.hostMode')).toBe('local');
    expect(result.output).toContain('http-listener: local 127.0.0.1:');
    expect(result.output).not.toContain('reachable from other machines');
  });

  test('a refused flag leaves the surface and its endpoints as they were', async () => {
    const runtime = runtimeFor(['surfaces', 'enable', 'web', '--hostname', '0.0.0.0']);
    // A managed setting refuses its override: the endpoint step fails after the host mode was already applied.
    const configManager = runtime.configManager;
    const applyOverride = configManager.setRuntimeOverride.bind(configManager);
    configManager.setRuntimeOverride = ((key: string, value: unknown) => {
      if (key === 'web.host') throw new Error('Setting web.host is managed and cannot be changed.');
      return applyOverride(key as never, value as never);
    }) as typeof configManager.setRuntimeOverride;
    const before = {
      web: runtime.configManager.get('web.enabled'),
      daemon: runtime.configManager.get('daemon.enabled'),
      controlPlane: runtime.configManager.get('controlPlane.enabled'),
      hostMode: runtime.configManager.get('web.hostMode'),
      host: runtime.configManager.get('web.host'),
    };
    const result = await handleSurfacesCommand(runtime);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Invalid --hostname');
    expect({
      web: runtime.configManager.get('web.enabled'),
      daemon: runtime.configManager.get('daemon.enabled'),
      controlPlane: runtime.configManager.get('controlPlane.enabled'),
      hostMode: runtime.configManager.get('web.hostMode'),
      host: runtime.configManager.get('web.host'),
    }).toEqual(before);
  });
});

describe('goodvibes surfaces check', () => {
  test('the web endpoint is reported reachable through the control-plane listener, not its own unlistened port', async () => {
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const runtime = runtimeFor(['surfaces', 'check']);
      runtime.configManager.setRuntimeOverride('controlPlane.enabled', true);
      runtime.configManager.setRuntimeOverride('controlPlane.hostMode', 'local');
      runtime.configManager.setRuntimeOverride('controlPlane.port', listener.port);
      runtime.configManager.setRuntimeOverride('web.enabled', true);
      runtime.configManager.setRuntimeOverride('web.hostMode', 'local');
      // Nothing serves web.port itself.
      runtime.configManager.setRuntimeOverride('web.port', listener.port === 1 ? 2 : 1);
      const result = await handleSurfacesCommand(runtime);
      expect(result.output).toContain('control-plane: yes');
      expect(result.output).toMatch(/web: yes .*reachable=yes/);
    } finally {
      listener.stop(true);
    }
  });
});
