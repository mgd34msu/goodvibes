import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadPersistedProviders, persistProviders, type DiscoveredServer, type ScanResult } from '../platform/src/platform/discovery/index.ts';
import { scheduleBackgroundMcpDiscovery, startBackgroundProviderDiscovery } from '../platform/src/platform/runtime/bootstrap-background.ts';
import type { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.ts';
import type { McpRegistry } from '../platform/src/platform/mcp/registry.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const SURFACE = 'test-surface';

function server(host: string, port: number, models: string[]): DiscoveredServer {
  return { name: `server-${host}`, host, port, baseURL: `http://${host}:${port}/v1`, models, serverType: 'ollama' };
}

function setup(options: { persisted?: DiscoveredServer[]; found: DiscoveredServer[]; model: string; registerNetworkServers?: boolean }) {
  const home = makeProjectTempDir('background-discovery');
  const shellPaths = { workingDirectory: home, homeDirectory: home };
  if (options.persisted) persistProviders({ ...shellPaths, surfaceRoot: SURFACE }, options.persisted);
  const registered: DiscoveredServer[][] = [];
  const configWrites: Array<[string, unknown]> = [];
  const low: string[] = [];
  const high: string[] = [];
  const runtime = { model: options.model, provider: options.model.split(':')[0]! };
  const result: ScanResult = { servers: options.found, scannedHosts: 1, scannedPorts: 1, durationMs: 0 };
  const scanning = Promise.resolve(result);
  const handle = startBackgroundProviderDiscovery({
    configManager: {
      get: (key: string) => (key === 'provider.model' ? options.model : undefined),
      set: (key: string, value: unknown) => { configWrites.push([key, value]); },
    } as unknown as ConfigManager,
    providerRegistry: {
      has: () => true,
      register: () => {},
      registerDiscoveredProviders: (servers: DiscoveredServer[]) => { registered.push(servers); },
      setCurrentModel: () => { throw new Error('the runtime model must not be switched'); },
    } as unknown as ProviderRegistry,
    runtime,
    requestRender: () => {},
    restoreRuntimeModel: () => {},
    systemMessageRouter: { low: (message) => { low.push(message); }, high: (message) => { high.push(message); } },
    shellPaths,
    surfaceRoot: SURFACE,
    scan: () => scanning,
    ...(options.registerNetworkServers === undefined ? {} : { registerNetworkServers: options.registerNetworkServers }),
  });
  return { handle, scanning, registered, configWrites, low, high, runtime, shellPaths };
}

describe('background provider discovery', () => {
  test('a server on the network is suggested, not registered or remembered', async () => {
    const lan = server('192.168.1.50', 11434, ['llama3']);
    const local = server('127.0.0.1', 11434, ['phi']);
    const fixture = setup({ found: [lan, local], model: 'openrouter:openrouter/free' });
    await fixture.scanning;
    expect(fixture.registered.flat().map((found) => found.host)).toEqual(['127.0.0.1']);
    expect(fixture.low.some((message) => message.includes('192.168.1.50') && message.includes('not registered'))).toBe(true);
    expect(loadPersistedProviders({ ...fixture.shellPaths, surfaceRoot: SURFACE }).map((found) => found.host)).toEqual(['127.0.0.1']);
  });

  test('a host that opts in registers and remembers network servers', async () => {
    const lan = server('192.168.1.50', 11434, ['llama3']);
    const fixture = setup({ found: [lan], model: 'openrouter:openrouter/free', registerNetworkServers: true });
    await fixture.scanning;
    expect(fixture.registered.flat()).toEqual([lan]);
    expect(loadPersistedProviders({ ...fixture.shellPaths, surfaceRoot: SURFACE })).toHaveLength(1);
  });

  test('a network server remembered earlier is not registered at startup', () => {
    const fixture = setup({ persisted: [server('10.0.0.9', 11434, ['llama3'])], found: [], model: 'openrouter:openrouter/free' });
    expect(fixture.registered).toEqual([]);
    expect(fixture.low.some((message) => message.includes('10.0.0.9') && message.includes('not registered'))).toBe(true);
  });

  test('one scan that misses the server the saved model lives on changes nothing and says so', async () => {
    const a = server('127.0.0.1', 11434, ['llama3']);
    const b = server('127.0.0.1', 1234, ['phi']);
    const fixture = setup({ persisted: [a, b], found: [b], model: 'ollama:llama3' });
    await fixture.scanning;
    expect(fixture.configWrites).toEqual([]);
    expect(fixture.runtime.model).toBe('ollama:llama3');
    expect(fixture.high.join('\n')).toContain('did not answer this scan');
    expect(fixture.high.join('\n')).toContain('unchanged');
    // The missed server stays in the cache until it ages out.
    expect(loadPersistedProviders({ ...fixture.shellPaths, surfaceRoot: SURFACE }).map((found) => found.port).sort((x, y) => x - y)).toEqual([1234, 11434]);
  });
});

describe('background MCP discovery shutdown', () => {
  test('stop releases the registry connections and hands back the wait', async () => {
    let released = false;
    const mcpRegistry = {
      serverNames: [],
      connectAll: async () => {},
      disconnectAll: async () => { released = true; },
    } as unknown as McpRegistry;
    const handle = scheduleBackgroundMcpDiscovery({
      mcpRegistry,
      systemMessageRouter: { low: () => {}, high: () => {} },
      requestRender: () => {},
      shellPaths: { workingDirectory: '/', homeDirectory: '/' },
      surfaceRoot: SURFACE,
    });
    const pending = handle.stop();
    await pending;
    expect(released).toBe(true);
    expect(handle.stopped).toBe(true);
  });

  test('a failed release is logged, not thrown into shutdown', async () => {
    const mcpRegistry = {
      serverNames: [],
      connectAll: async () => {},
      disconnectAll: async () => { throw new Error('child would not exit'); },
    } as unknown as McpRegistry;
    const handle = scheduleBackgroundMcpDiscovery({
      mcpRegistry,
      systemMessageRouter: { low: () => {}, high: () => {} },
      requestRender: () => {},
      shellPaths: { workingDirectory: '/', homeDirectory: '/' },
      surfaceRoot: SURFACE,
    });
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});
