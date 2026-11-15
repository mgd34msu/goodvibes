/**
 * A client composition that fails part-way must give back what it already took,
 * and a host that owns the permission-rule file must be the only writer of it.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClientRuntimeServices } from '../platform/src/platform/runtime/client-services.ts';
import { surfaceHomeClaimPath } from '../platform/src/platform/runtime/home-single-writer.ts';
import type { UserPermissionRuleAccess } from '../platform/src/platform/runtime/client-services.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function compose(extra: Partial<Parameters<typeof createClientRuntimeServices>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gv-client-composition-'));
  roots.push(home);
  const workingDir = join(home, 'work');
  mkdirSync(workingDir, { recursive: true });
  const options = {
    configManager: new ConfigManager({ surfaceRoot: 'agent', configDir: join(home, 'cfg'), workingDir, homeDir: home }),
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'agent',
    workingDir,
    homeDirectory: home,
    requestApproval: async () => ({ approved: true }),
    modelDiscovery: 'skip' as const,
    ...extra,
  };
  return { home, build: () => createClientRuntimeServices(options) };
}

test('a composition that throws after claiming the home releases the claim', async () => {
  const { home, build } = compose({
    homeSingleWriter: 'claim',
    providerRegistryFactory: () => { throw new Error('provider stack refused'); },
  });
  expect(build).toThrow('provider stack refused');
  // Scope disposal is asynchronous; give it bounded event-loop turns to finish.
  for (let turn = 0; turn < 50 && existsSync(surfaceHomeClaimPath(home, 'agent')); turn++) await Promise.resolve();
  expect(existsSync(surfaceHomeClaimPath(home, 'agent'))).toBe(false);
});

test('a floor given the host permission-rule store uses it instead of building its own', () => {
  const borrowed = { rules: () => [], add: async () => undefined } as unknown as UserPermissionRuleAccess;
  const services = compose({ userPermissionRuleStore: borrowed }).build();
  try {
    expect(services.userPermissionRuleStore).toBe(borrowed);
  } finally {
    services.dispose();
  }
});
