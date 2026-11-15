import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { inspectConnectedHostMetrics } from '../../cli/connected-host-metrics.ts';
import { inspectCliExternalRuntime } from '../../cli/external-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function options(withToken = true) {
  const root = makeProjectTempDir('gv-agent-external-runtime');
  roots.push(root);
  const homeDirectory = join(root, 'home');
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  if (withToken) writeFileSync(join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'test-token' }));
  return {
    configManager: new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, workingDir: root, homeDir: homeDirectory }),
    homeDirectory,
  };
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('connected host probes', () => {
  test('a host that answers /status with an error is reachable, and says what it refused', async () => {
    globalThis.fetch = mockFetch(async () => new Response('server error', { status: 500 }));
    const snapshot = await inspectCliExternalRuntime(options());
    expect(snapshot.reachable).toBe(true);
    expect(snapshot.compatible).toBe(false);
    expect(snapshot.statusCode).toBe(500);
    expect(snapshot.agentKnowledge.probed).toBe(false);
  });

  test('a host that does not answer is unreachable', async () => {
    globalThis.fetch = mockFetch(async () => { throw new Error('connection refused'); });
    expect((await inspectCliExternalRuntime(options())).reachable).toBe(false);
  });

  test('with no operator token the knowledge route is reported as not probed', async () => {
    const requested: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      requested.push(urlOf(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const snapshot = await inspectCliExternalRuntime(options(false));
    expect(snapshot.agentKnowledge.probed).toBe(false);
    expect(requested.some((url) => url.includes('/knowledge/'))).toBe(false);
  });

  test('a 200 metrics body with neither counters nor gauges is not read as healthy zeros', async () => {
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({ error: 'x' }), { status: 200 }));
    const snapshot = await inspectConnectedHostMetrics(options());
    expect(snapshot.status).toBe('error');
    expect(snapshot.metrics).toBeNull();
  });

  test('a metrics body with counters is read', async () => {
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({ counters: {}, gauges: {} }), { status: 200 }));
    expect((await inspectConnectedHostMetrics(options())).status).toBe('ok');
  });
});
