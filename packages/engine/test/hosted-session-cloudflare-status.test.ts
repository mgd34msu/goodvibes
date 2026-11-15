/**
 * A hosted session's Cloudflare status counts the daemon's bearer token as the Worker operator token,
 * as the daemon's own status route does, instead of reporting no Worker token.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices, type ClientRuntimeServices } from '../platform/src/platform/runtime/client-services.ts';
import { createHostedSessionRuntime } from '../platform/src/platform/hosted-sessions/session-runtime.ts';
import type { PermissionPromptDecision } from '../platform/src/platform/permissions/prompt.ts';
import { installHostedSessionReadings } from './_helpers/hosted-session-readings.ts';

let root: string;
let workspace: string;
let services: ClientRuntimeServices;
let readings: ReturnType<typeof installHostedSessionReadings>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-cloudflare-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const configManager = new ConfigManager({ surfaceRoot: 'goodvibes', configDir: join(root, 'cfg'), workingDir: workspace, homeDir: root });
  services = createClientRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir: workspace,
    homeDirectory: root,
    requestApproval: async (): Promise<PermissionPromptDecision> => ({ approved: true }),
    modelDiscovery: 'skip',
  });
  readings = installHostedSessionReadings({ tools: [] });
});

afterEach(() => {
  readings.restore();
  services.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function workerToken(cloudflareAuthToken?: () => string | null): Promise<boolean | undefined> {
  const session = createHostedSessionRuntime({
    sessionId: `hosted-cloudflare-${cloudflareAuthToken ? 'token' : 'none'}`,
    workspaceRoot: workspace,
    floor: { services, contractRunner: services.contractRunner, dispose: (): void => {} },
    systemPrompt: 'hosted',
    ...(cloudflareAuthToken ? { cloudflareAuthToken } : {}),
  });
  try {
    const result = await session.toolRegistry.execute('call-1', 'goodvibes_context', { mode: 'cloudflare_status' });
    expect(result.success).toBe(true);
    const body = JSON.parse(String(result.output)) as { cloudflare: { configured?: { workerToken?: boolean } } };
    expect(String(result.output)).not.toContain('daemon-token');
    return body.cloudflare.configured?.workerToken;
  } finally { session.dispose(); }
}

test('a hosted session reports the Worker token as present when the daemon has a token', async () => {
  expect(await workerToken()).toBe(false);
  expect(await workerToken(() => 'daemon-token')).toBe(true);
});
