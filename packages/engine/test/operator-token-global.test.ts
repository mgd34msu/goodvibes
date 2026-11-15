/**
 * operator-token-global.test.ts
 *
 * Operator tokens are global-only at <daemonHomeDir>/operator-tokens.json.
 *
 * Tests:
 *   1. Token present at global path → getOrCreateCompanionToken returns it
 *   2. No token anywhere → getOrCreateCompanionToken creates one at global path
 *   3. writeOperatorTokenFile sets mode 0600
 *   4. The token on disk, handed to the daemon's own auth (DaemonControlPlaneHelper.authenticateRequest)
 *      behind DaemonHttpRouter: the stored bearer → 200, a wrong or missing bearer → 401
 *
 * Explicitly: NO test for workspace-scoped fallback. If you find yourself
 * writing a "workspace tokens also work" test, stop, that's the wrong spec.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { workspaceOperatorTokenCandidates } from '../platform/src/platform/runtime/operator-token-cleanup.ts';
import {
  DaemonControlPlaneHelper,
  type DaemonControlPlaneContext,
} from '../platform/src/platform/daemon/control-plane.ts';
import {
  resolveOperatorTokenPath,
  writeOperatorTokenFile,
} from '../platform/src/platform/workspace/daemon-home.ts';
import {
  getOrCreateCompanionToken,
} from '../platform/src/platform/pairing/companion-token.ts';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.ts';
import type { ConfigManager } from '../platform/src/platform/config/manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-op-tok-${suffix}-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function makeMinimalRouterContext(overrides: { authenticateRequest?: (req: Request) => unknown } = {}) {
  const bus = new RuntimeEventBus();
  const configManager = { set: () => {}, get: () => undefined } as unknown as ConfigManager;
  const registry = {
    listModels: () => [],
    getCurrentModel: () => null as never,
    getConfiguredProviderIds: () => [],
    setCurrentModel: () => {},
  } as unknown as ProviderRegistry;

  return {
    configManager,
    serviceRegistry: {} as never,
    userAuth: {} as never,
    agentManager: {} as never,
    automationManager: {} as never,
    approvalBroker: {} as never,
    controlPlaneGateway: { createEventStream: () => { throw new Error('not expected'); } } as never,
    gatewayMethods: { findByHttpBinding: () => null } as never,
    providerRegistry: registry,
    sessionBroker: {} as never,
    routeBindings: {} as never,
    channelPolicy: {} as never,
    channelPlugins: {} as never,
    surfaceRegistry: {} as never,
    distributedRuntime: {} as never,
    watcherRegistry: {} as never,
    voiceService: {} as never,
    webSearchService: {} as never,
    knowledgeService: {} as never,
    knowledgeGraphqlService: {} as never,
    mediaProviders: {} as never,
    multimodalService: {} as never,
    artifactStore: {} as never,
    memoryRegistry: {} as never,
    memoryEmbeddingRegistry: {} as never,
    platformServiceManager: {} as never,
    integrationHelpers: null,
    runtimeBus: bus,
    runtimeStore: null,
    runtimeDispatch: null,
    githubWebhookSecret: null,
    authToken: () => null,
    buildSurfaceAdapterContext: () => { throw new Error('not expected'); },
    buildGenericWebhookAdapterContext: () => { throw new Error('not expected'); },
    authenticateRequest: overrides.authenticateRequest ?? (() => ({ principal: { principalId: 'owner', principalKind: 'user', admin: true, scopes: [] } })),
    extractAuthToken: () => '',
    requireAuthenticatedSession: () => null,
    requireAdmin: () => null,
    requireRemotePeer: async () => { throw new Error('not expected'); },
    describeAuthenticatedPrincipal: () => null,
    invokeGatewayMethodCall: async () => { throw new Error('not expected'); },
    queueSurfaceReplyFromBinding: () => {},
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    trySpawnAgent: () => { throw new Error('not expected'); },
    companionChatManager: null,
    secretsManager: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Token at global path → getOrCreateCompanionToken returns it
// ---------------------------------------------------------------------------

describe('global-only operator token: existing token is returned', () => {
  let daemonHome: string;

  beforeEach(() => { daemonHome = tempDir('existing'); });
  afterEach(() => { cleanup(daemonHome); });

  test('returns stored token when file exists at global path', () => {
    const tokenPath = resolveOperatorTokenPath(daemonHome);
    const stored = { token: 'gv_stored_abc123', peerId: 'peer1', createdAt: 1000000 };
    writeOperatorTokenFile(daemonHome, JSON.stringify(stored, null, 2));

    const result = getOrCreateCompanionToken({ daemonHomeDir: daemonHome });
    expect(result.token).toBe('gv_stored_abc123');
    expect(result.peerId).toBe('peer1');

    // File must remain at global path
    expect(existsSync(tokenPath)).toBe(true);
  });

  test('creates a new token when global path does not exist', () => {
    const tokenPath = resolveOperatorTokenPath(daemonHome);
    expect(existsSync(tokenPath)).toBe(false);

    const result = getOrCreateCompanionToken({ daemonHomeDir: daemonHome });
    expect(typeof result.token).toBe('string');
    expect(result.token.startsWith('gv_')).toBe(true);
    expect(typeof result.peerId).toBe('string');
    expect(existsSync(tokenPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. No workspace-scoped token file is ever consulted
// ---------------------------------------------------------------------------

describe('global-only: workspace-scoped token path is never read', () => {
  let workspaceRoot: string;

  beforeEach(() => { workspaceRoot = makeProjectTempDir('gv-op-tok-no-ws'); });
  afterEach(() => { cleanup(workspaceRoot); });

  test('generates fresh token even when every legacy workspace-scoped file is present', () => {
    // The daemon home sits inside the workspace, the layout in which a
    // workspace fallback would be reachable. Decoys go at the real legacy paths.
    const daemonHome = join(workspaceRoot, '.goodvibes', 'daemon');
    mkdirSync(daemonHome, { recursive: true });
    const decoyPaths = workspaceOperatorTokenCandidates(workspaceRoot, 'test-surface');
    expect(decoyPaths.length).toBeGreaterThan(0);
    const wsToken = { token: 'gv_workspace_should_not_be_used', peerId: 'ws_peer', createdAt: 999 };
    for (const decoy of decoyPaths) {
      mkdirSync(join(decoy, '..'), { recursive: true });
      writeFileSync(decoy, JSON.stringify(wsToken));
    }

    const result = getOrCreateCompanionToken({ daemonHomeDir: daemonHome });

    expect(result.token).not.toBe(wsToken.token);
    expect(result.peerId).not.toBe(wsToken.peerId);
    expect(result.token.startsWith('gv_')).toBe(true);
    // The fresh token was written to the global path, and the decoys were left as they were.
    expect(JSON.parse(readFileSync(resolveOperatorTokenPath(daemonHome), 'utf8')).token).toBe(result.token);
    for (const decoy of decoyPaths) expect(JSON.parse(readFileSync(decoy, 'utf8')).token).toBe(wsToken.token);
  });
});

// ---------------------------------------------------------------------------
// 3. writeOperatorTokenFile sets mode 0600
// ---------------------------------------------------------------------------

describe('writeOperatorTokenFile: mode 0600', () => {
  let daemonHome: string;

  beforeEach(() => { daemonHome = tempDir('chmod'); });
  afterEach(() => { cleanup(daemonHome); });

  test('file written by writeOperatorTokenFile has mode 0600', () => {
    writeOperatorTokenFile(daemonHome, JSON.stringify({ token: 'gv_x', peerId: 'p', createdAt: 0 }));
    const tokenPath = resolveOperatorTokenPath(daemonHome);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('file written by getOrCreateCompanionToken has mode 0600', () => {
    getOrCreateCompanionToken({ daemonHomeDir: daemonHome });
    const tokenPath = resolveOperatorTokenPath(daemonHome);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// 4. The token file feeds the daemon's real auth, behind DaemonHttpRouter
// ---------------------------------------------------------------------------

describe('operator token file through the daemon auth and router', () => {
  let daemonHome: string;

  beforeEach(() => { daemonHome = tempDir('real-auth'); });
  afterEach(() => { cleanup(daemonHome); });

  /** The router's authentication is the control-plane helper's, against the token the daemon read from disk. */
  function makeRouter(): DaemonHttpRouter {
    const { token } = getOrCreateCompanionToken({ daemonHomeDir: daemonHome });
    const helper = new DaemonControlPlaneHelper({
      authToken: () => token,
      trustProxyEnabled: () => false,
      userAuth: { validateSession: () => null },
      gatewayMethods: new GatewayMethodCatalog(),
    } as unknown as DaemonControlPlaneContext);
    return new DaemonHttpRouter(makeMinimalRouterContext({ authenticateRequest: (req) => helper.authenticateRequest(req) }) as never);
  }

  function storedToken(): string {
    return JSON.parse(readFileSync(resolveOperatorTokenPath(daemonHome), 'utf8')).token as string;
  }

  test('the stored bearer token is accepted', async () => {
    writeOperatorTokenFile(daemonHome, JSON.stringify({ token: 'gv_real_test_token', peerId: 'test-peer', createdAt: 1 }));
    const router = makeRouter();
    try {
      expect(storedToken()).toBe('gv_real_test_token');
      const res = await router.handleRequest(new Request('http://localhost/api/models', {
        method: 'GET',
        headers: { Authorization: 'Bearer gv_real_test_token' },
      }));
      expect(res.status).toBe(200);
      expect((await res.json() as Record<string, unknown>)['providers']).toBeInstanceOf(Array);
    } finally { router.dispose(); }
  });

  test('a freshly minted token is accepted, and a different bearer is rejected', async () => {
    const router = makeRouter();
    try {
      const ok = await router.handleRequest(new Request('http://localhost/api/models', {
        headers: { Authorization: `Bearer ${storedToken()}` },
      }));
      expect(ok.status).toBe(200);
      const wrong = await router.handleRequest(new Request('http://localhost/api/models', {
        headers: { Authorization: 'Bearer gv_wrong_token' },
      }));
      expect(wrong.status).toBe(401);
    } finally { router.dispose(); }
  });

  test('a request with no credentials is rejected', async () => {
    const router = makeRouter();
    try {
      const res = await router.handleRequest(new Request('http://localhost/api/models'));
      expect(res.status).toBe(401);
    } finally { router.dispose(); }
  });
});
