import { afterEach, describe, expect, test } from 'bun:test';
import { fetchConnectedHostReadOnlyRoute } from '../../input/connected-host-routes.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function context(): CommandContext {
  const root = makeProjectTempDir('gv-connected-host-route');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'tok' }));
  return {
    platform: { configManager: { get: (key: string) => (key === 'controlPlane.port' ? 3421 : '127.0.0.1') } },
    workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
  } as unknown as CommandContext;
}

describe('connected host read-only routes', () => {
  test('a host that accepts the connection and never answers fails as unavailable instead of hanging', async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const result = await fetchConnectedHostReadOnlyRoute(context(), '/api/channels/status', { timeoutMs: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('connected_host_unavailable');
    }
  });
});
