/**
 * The hook API that the runtime hands to products: its dispatcher view must
 * list chains registered on the live dispatcher, not only the managed ones.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookDispatcher, HookWorkbench } from '@goodvibes-jev/engine/platform/platform/hooks';

// The transport, provider, knowledge and MCP layers are not under test here and
// need the rest of the runtime composition; replace them with inert values.
mock.module('../platform/src/platform/runtime/foundation-services.js', () => ({
  createDirectTransportServices: () => ({}),
}));
mock.module('../platform/src/platform/runtime/transports/direct.js', () => ({
  createDirectTransportFromServices: () => ({}),
}));
mock.module('../platform/src/platform/runtime/runtime-provider-api.js', () => ({
  createRuntimeProviderApi: () => ({}),
}));
mock.module('../platform/src/platform/runtime/runtime-knowledge-api.js', () => ({
  createRuntimeKnowledgeApi: () => ({}),
}));
mock.module('../platform/src/platform/runtime/runtime-mcp-api.js', () => ({
  createRuntimeMcpApi: () => ({}),
}));

const { createRuntimeFoundationClients } = await import('../platform/src/platform/runtime/foundation-clients.ts');
type Options = Parameters<typeof createRuntimeFoundationClients>[0];

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('createRuntimeFoundationClients hook API', () => {
  test('hookApi.dispatcher.listChains() lists a chain registered on the runtime dispatcher', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-foundation-clients-'));
    dirs.push(dir);
    const hookDispatcher = new HookDispatcher();
    const hookWorkbench = new HookWorkbench(hookDispatcher, () => join(dir, 'hooks.json'));
    hookDispatcher.registerChain({
      name: 'live',
      steps: [{ match: 'Pre:tool:*' }],
      action: { match: 'Post:tool:x', type: 'command', command: 'true' },
    });
    // Only the hook services are read by the hook API; the rest of the slice is
    // consumed by the layers replaced above.
    const runtimeServices = { hookDispatcher, hookWorkbench } as unknown as Options['runtimeServices'];
    const clients = createRuntimeFoundationClients({
      runtimeServices,
      tasksReadModel: { getSnapshot: () => ({}) } as unknown as Options['tasksReadModel'],
      taskManager: {} as unknown as Options['taskManager'],
    });
    expect(clients.hookApi.dispatcher.listChains().map((chain) => chain.name)).toEqual(['live']);
    expect(clients.hookApi.workbench.listManagedChains()).toHaveLength(0);
  });
});
