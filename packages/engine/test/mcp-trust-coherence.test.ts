import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { McpClient } from '../platform/src/platform/mcp/client.ts';
import {
  McpLifecycleManager,
  McpPermissionManager,
  McpSchemaFreshnessTracker,
  buildMcpAttackPathReview,
} from '../platform/src/platform/runtime/mcp/index.ts';
import type { McpEvent } from '../platform/src/events/mcp.ts';

describe('schema freshness: a failure while quarantined', () => {
  test('is counted but does not lift the quarantine', () => {
    const tracker = new McpSchemaFreshnessTracker();
    tracker.registerServer('s');
    tracker.markQuarantined('s', 'operator_flagged');

    tracker.markFailed('s', 'call aborted');

    expect(tracker.isQuarantined('s')).toBe(true);
    expect(tracker.getFreshness('s')).toBe('quarantined');
  });

  test('a failure on an unquarantined server still marks the fetch failed', () => {
    const tracker = new McpSchemaFreshnessTracker();
    tracker.registerServer('s');
    tracker.markFailed('s', 'boom');
    expect(tracker.getFreshness('s')).toBe('fetch_failed');
  });
});

describe('permission decisions and the trust level/mode pair', () => {
  test('evaluating a tool call records a decision', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained', allowedPaths: ['/work'] });

    await manager.evaluateToolCall('docs', 'read', { path: '/elsewhere/x' });

    const [decision, ...rest] = manager.listRecentDecisions();
    expect(rest).toEqual([]);
    expect(decision).toMatchObject({ serverName: 'docs', toolName: 'read', verdict: 'deny', profileMode: 'constrained', incoherent: true });
  });

  test('a block applied through the trust level is enforced on a live call', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('s');
    manager.setTrustLevel('s', 'blocked');
    expect((await manager.evaluateToolCall('s', 't', {})).verdict).toBe('deny');
  });

  test('a block applied through the trust mode is enforced by the level check too', () => {
    const manager = new McpPermissionManager();
    manager.registerServer('s');
    manager.setTrustMode('s', 'blocked');
    expect(manager.isToolAllowed('s', 't').allowed).toBe(false);

    manager.setTrustMode('s', 'ask-on-risk');
    expect(manager.isToolAllowed('s', 't').allowed).toBe(true);
  });

  test('a server registered with a blocked profile mode is blocked at the level check', () => {
    const manager = new McpPermissionManager();
    manager.registerServer('s', 'standard', { mode: 'blocked' });
    expect(manager.isToolAllowed('s', 't').allowed).toBe(false);
  });

  test('the posture review does not claim an approval step the call path never takes', () => {
    const review = buildMcpAttackPathReview({
      servers: [{
        name: 'docs', role: 'docs', trustMode: 'ask-on-risk', allowedPaths: ['/work'], allowedHosts: ['a.example'],
        schemaFreshness: 'fresh', connected: true,
      }],
    });
    const finding = review.findings[0]!;
    expect(finding.verdict).toBe('allow');
    expect(finding.reason).not.toContain('requires approval');
  });
});

describe('scope enforcement on arguments with unlisted names', () => {
  const guarded = (): McpPermissionManager => {
    const manager = new McpPermissionManager();
    manager.registerServer('files', 'standard', {
      role: 'filesystem', mode: 'constrained', allowedPaths: ['/work'], allowedHosts: ['Example.com'],
    });
    return manager;
  };

  test('a relative path under an arbitrary argument name is held to allowedPaths', async () => {
    expect((await guarded().evaluateToolCall('files', 't', { target: 'secrets/key' })).verdict).toBe('deny');
    expect((await guarded().evaluateToolCall('files', 't', { target: '/work/notes.md' })).verdict).toBe('allow');
  });

  test('a non-http URL under an arbitrary argument name is held to allowedHosts', async () => {
    expect((await guarded().evaluateToolCall('files', 't', { sink: 'wss://evil.test/x' })).verdict).toBe('deny');
  });

  test('a bare host under an arbitrary argument name is held to allowedHosts', async () => {
    expect((await guarded().evaluateToolCall('files', 't', { server: 'evil.test' })).verdict).toBe('deny');
    expect((await guarded().evaluateToolCall('files', 't', { server: '10.0.0.5:8080' })).verdict).toBe('deny');
    expect((await guarded().evaluateToolCall('files', 't', { server: 'www.example.com' })).verdict).toBe('allow');
  });

  test('a parent or current directory under an arbitrary argument name is held to allowedPaths', async () => {
    expect((await guarded().evaluateToolCall('files', 't', { target: '..' })).verdict).toBe('deny');
    expect((await guarded().evaluateToolCall('files', 't', { target: '.' })).verdict).toBe('deny');
  });

  test('an allowed host is compared case-insensitively and without a scheme or port', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('net', 'standard', { role: 'general', mode: 'constrained', allowedHosts: ['Example.com', 'https://api.other.test:8443'] });
    expect((await manager.evaluateToolCall('net', 't', { url: 'https://www.example.com/a' })).verdict).toBe('allow');
    expect((await manager.evaluateToolCall('net', 't', { url: 'https://api.other.test/a' })).verdict).toBe('allow');
    expect((await manager.evaluateToolCall('net', 't', { url: 'https://evil.test/a' })).verdict).toBe('deny');
  });
});

describe('McpLifecycleManager restart', () => {
  const restores: Array<() => void> = [];
  afterEach(() => { while (restores.length) restores.pop()!(); });

  function stubClient(): void {
    const c = spyOn(McpClient.prototype, 'connect').mockImplementation(async () => {});
    const l = spyOn(McpClient.prototype, 'listTools').mockImplementation(async () => []);
    const d = spyOn(McpClient.prototype, 'disconnect').mockImplementation(async () => {});
    restores.push(() => { c.mockRestore(); l.mockRestore(); d.mockRestore(); });
  }

  test('a stopped server is started again by startServer', async () => {
    stubClient();
    const mgr = new McpLifecycleManager();
    const events: McpEvent[] = [];
    mgr.onEvent((e) => events.push(e));
    const config = { name: 'srv', command: 'x', args: [] } as never;

    await mgr.startServer(config);
    await mgr.stopServer('srv', 'operator stop');
    expect(mgr.getState('srv')).toBe('disconnected');

    await mgr.startServer(config);
    expect(mgr.getState('srv')).toBe('connected');
    expect(events.filter((e) => e.type === 'MCP_CONNECTED')).toHaveLength(2);
  });

  test('starting a server that is already connected leaves it alone', async () => {
    stubClient();
    const mgr = new McpLifecycleManager();
    const config = { name: 'srv', command: 'x', args: [] } as never;
    await mgr.startServer(config);
    await mgr.startServer(config);
    expect(mgr.getState('srv')).toBe('connected');
  });

  test('stopping an already stopped server keeps the original stop reason', async () => {
    stubClient();
    const mgr = new McpLifecycleManager();
    await mgr.startServer({ name: 'srv', command: 'x', args: [] } as never);
    await mgr.stopServer('srv', 'first');
    await mgr.stopAll();
    expect(mgr.getServer('srv')?.lastError).toBe('first');
  });

  test('a remote server is announced with the http transport', async () => {
    stubClient();
    const mgr = new McpLifecycleManager();
    const events: McpEvent[] = [];
    mgr.onEvent((e) => events.push(e));
    await mgr.startServer({ name: 'remote', url: 'https://mcp.example/x' } as never);
    expect(events.find((e) => e.type === 'MCP_CONFIGURED')).toMatchObject({ transport: 'http' });
  });
});
