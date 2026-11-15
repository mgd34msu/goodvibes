/**
 * HTTP integration test for POST /config runtime.workingDir.
 *
 * Uses the real route handler (createDaemonSystemRouteHandlers) wired with a
 * real WorkspaceSwapManager backed by tmp directories. No full DaemonServer
 * boot is required, we test at the route-handler layer.
 */
import { describe, expect, spyOn, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDaemonSystemRouteHandlers,
} from '../daemon-api/src/index.ts';
import { WorkspaceSwapManager } from '../platform/src/platform/workspace/workspace-swap-manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-http-test-${suffix}-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const AUTH_TOKEN = 'test-token-b3';

function makeRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function makeSystemContext(daemonHome: string, workingDir: string, swapManager: WorkspaceSwapManager) {
  const fakeWatcherRegistry = {
    list: () => [],
    addWatcher: () => ({ id: 'w1' }),
    removeWatcher: () => true,
    getWatcher: () => null,
    updateWatcher: () => null,
    triggerWatcher: () => null,
  };
  return {
    approvalBroker: {
      listPending: () => [],
      approve: () => null,
      reject: () => null,
    },
    configManager: {
      get: (key: string) => {
        if (key === 'runtime.workingDir') return workingDir;
        return undefined;
      },
      set: async () => {},
      list: () => ({}),
    },
    integrationHelpers: {
      list: () => [],
      get: () => null,
      install: async () => ({}),
      uninstall: async () => ({}),
    },
    inspectInboundTls: () => ({ mode: 'off' }),
    inspectOutboundTls: () => ({ mode: 'system' }),
    isValidConfigKey: (_key: string) => true,
    parseJsonBody: async (req: Request) => {
      const body = await req.json();
      return body as Record<string, unknown>;
    },
    parseOptionalJsonBody: async (req: Request) => {
      try {
        return await req.json() as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    platformServiceManager: {
      status: () => ({}),
      install: () => ({}),
      start: () => ({}),
      stop: () => ({}),
      restart: () => ({}),
      uninstall: () => ({}),
    },
    requireAdmin: (_req: Request) => null,
    requireAuthenticatedSession: (_req: Request) => ({ username: 'admin', roles: ['admin'] }),
    routeBindings: {
      start: async () => {},
      stop: async () => {},
      list: () => [],
      find: () => null,
      bind: async () => ({}),
      unbind: async () => {},
      patch: async () => null,
      getBinding: () => null,
    },
    swapManager,
    watcherRegistry: fakeWatcherRegistry,
  };
}

// ---------------------------------------------------------------------------
// Runtime workspace swap tests
// ---------------------------------------------------------------------------

describe('POST /config runtime.workingDir: HTTP integration', () => {
  let daemonHome: string;
  let workingDir: string;

  beforeEach(() => {
    daemonHome = tempDir('daemon');
    workingDir = tempDir('work');
  });

  afterEach(() => cleanup(daemonHome, workingDir));

  test('POST /config with valid new dir returns 200 and persists to daemon-settings.json', async () => {
    const newDir = tempDir('newwork');
    const swapManager = new WorkspaceSwapManager(workingDir, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
    });

    const ctx = makeSystemContext(daemonHome, workingDir, swapManager);
    const req = makeRequest('/api/config', { key: 'runtime.workingDir', value: newDir });
    const handlers = createDaemonSystemRouteHandlers(ctx as unknown as Parameters<typeof createDaemonSystemRouteHandlers>[0]);
    const response = await handlers.postConfig(req);
    expect(response.status).toBe(200);

    const settingsPath = join(daemonHome, 'daemon-settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(settings['runtime.workingDir']).toBe(newDir);
    cleanup(newDir);
  });

  test('POST /config with empty value returns 400 INVALID_PATH', async () => {
    const swapManager = new WorkspaceSwapManager(workingDir, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
    });
    const ctx = makeSystemContext(daemonHome, workingDir, swapManager);
    const req = makeRequest('/api/config', { key: 'runtime.workingDir', value: '' });
    const handlers = createDaemonSystemRouteHandlers(ctx as unknown as Parameters<typeof createDaemonSystemRouteHandlers>[0]);
    const response = await handlers.postConfig(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body['code']).toBe('INVALID_PATH');
  });

  test('POST /config with a file path (not a dir) returns 400 INVALID_PATH', async () => {
    // Create a file at the target path so mkdir will fail
    const filePath = join(daemonHome, 'i-am-a-file.txt');
    writeFileSync(filePath, 'not a dir');

    const swapManager = new WorkspaceSwapManager(workingDir, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
    });
    const ctx = makeSystemContext(daemonHome, workingDir, swapManager);
    // request a subdir of a file, mkdir will fail
    const req = makeRequest('/api/config', { key: 'runtime.workingDir', value: join(filePath, 'subdir') });
    const handlers = createDaemonSystemRouteHandlers(ctx as unknown as Parameters<typeof createDaemonSystemRouteHandlers>[0]);
    const response = await handlers.postConfig(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body['code']).toBe('INVALID_PATH');
  });

  test('POST /config saves the change for the next start and names what moves then', async () => {
    const newDir = tempDir('newwork');
    const swapManager = new WorkspaceSwapManager(workingDir, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
    });
    const ctx = makeSystemContext(daemonHome, workingDir, swapManager);
    const handlers = createDaemonSystemRouteHandlers(ctx as unknown as Parameters<typeof createDaemonSystemRouteHandlers>[0]);
    const response = await handlers.postConfig(makeRequest('/api/config', { key: 'runtime.workingDir', value: newDir }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body['persisted']).toBe(true);
    expect(body['requiresRestart']).toContain('sessions');
    // The running process stays whole on its start root.
    expect(swapManager.getCurrentWorkingDir()).toBe(workingDir);
    expect(swapManager.getPendingWorkingDir()).toBe(newDir);
    cleanup(newDir);
  });

  describe('a caller that is not an admin', () => {
    async function postWithAdmin(requireAdmin: (req: Request) => Response | null) {
      const newDir = tempDir('newwork');
      const swapManager = new WorkspaceSwapManager(workingDir, {
        runtimeBus: null,
        daemonHomeDir: daemonHome,
      });
      const requestSwap = spyOn(swapManager, 'requestSwap');
      const ctx = { ...makeSystemContext(daemonHome, workingDir, swapManager), requireAdmin };
      const handlers = createDaemonSystemRouteHandlers(ctx as unknown as Parameters<typeof createDaemonSystemRouteHandlers>[0]);
      const response = await handlers.postConfig(makeRequest('/api/config', { key: 'runtime.workingDir', value: newDir }));
      const outcome = { response, swaps: requestSwap.mock.calls.length, settingsWritten: existsSync(join(daemonHome, 'daemon-settings.json')) };
      cleanup(newDir);
      return outcome;
    }

    test('is refused with 403 before the working directory is saved', async () => {
      const outcome = await postWithAdmin(() => Response.json({ error: 'Forbidden' }, { status: 403 }));
      expect(outcome.response.status).toBe(403);
      expect(outcome.swaps).toBe(0);
      expect(outcome.settingsWritten).toBe(false);
    });

    test('is refused when admin access is withdrawn while the request body is being read', async () => {
      let calls = 0;
      const outcome = await postWithAdmin(() => (++calls === 1 ? null : Response.json({ error: 'Forbidden' }, { status: 403 })));
      expect(calls).toBe(2);
      expect(outcome.response.status).toBe(403);
      expect(outcome.swaps).toBe(0);
      expect(outcome.settingsWritten).toBe(false);
    });
  });
});
