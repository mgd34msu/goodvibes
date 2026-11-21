// Proves: A policy bundle's deny for a path under the home directory written with ~ never fires, so the call it forbids runs.
// Red when: The loader stops joining a path-scope pattern of ~/... onto the home directory, or the composition stops handing the loader the home, so the rule is resolved under the project root or the bundle is refused.
/**
 * The owner's policy bundle, loaded from the file `policy.bundlePath` names
 * the way start-up loads it, reviewed and promoted, then enforced by the gate
 * under the policy engine. Its one rule denies writes to `~/.ssh/**`.
 *
 * Real settings manager, feature flags, policy runtime state and registry,
 * permission manager, tool registry and executor over a temp home and
 * project. The write tool only records the paths it was asked to write; the
 * owner's prompt approves everything it is shown and counts the asks.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { HeldForOwnerLedger } from '../platform/src/platform/permissions/held-for-owner.ts';
import { createPolicyRuntimeState } from '../platform/src/platform/runtime/permissions/permission-composition.ts';
import { createFeatureFlagManager } from '../platform/src/platform/runtime/feature-flags/manager.ts';
import { deriveFeatureStates } from '../platform/src/platform/runtime/feature-flags/feature-settings.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-policy-home-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('a promoted bundle\'s deny for ~/.ssh refuses a write there unasked; a write elsewhere in the home still reaches the owner', async () => {
  const home = join(dir, 'home');
  const project = join(dir, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const bundlePath = join(project, 'policy.json');
  writeFileSync(bundlePath, JSON.stringify({
    bundleId: 'home-guard', issuedAt: '2026-11-01T00:00:00.000Z', issuer: 'owner',
    payload: { rules: [{ id: 'no-ssh-writes', type: 'path-scope', effect: 'deny', toolPattern: 'write', pathPatterns: ['~/.ssh/**'] }] },
  }));

  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: project, homeDir: home, configDir: join(dir, 'config'), ownsDaemonTier: true });
  expect(config.setMany([
    { key: 'permissions.mode' as ConfigKey, value: 'ask-me' },
    { key: 'permissions.engine' as ConfigKey, value: 'policy-engine' },
    { key: 'policy.registryEnabled' as ConfigKey, value: true },
    { key: 'policy.bundleSource' as ConfigKey, value: 'file' },
    { key: 'policy.bundlePath' as ConfigKey, value: bundlePath },
  ], localOwnerActor()).ok).toBe(true);
  const flags = createFeatureFlagManager();
  flags.loadFromConfig({ flags: deriveFeatureStates(config) });

  // Start-up loads the configured bundle as the candidate; the owner reviews it and promotes it.
  const policy = createPolicyRuntimeState(config, flags, {});
  const registry = policy.getRegistry();
  const lifecycle = {
    simulating: registry.markSimulating(),
    reviewed: registry.attachImpact({ checkedCalls: 0, skippedCalls: 0, changed: [] }),
    promoted: registry.promote().ok,
  };

  let asked = 0;
  const manager = new PermissionManager(async () => { asked++; return { approved: true }; }, createPermissionConfigReader(config), policy,
    null, flags, null, { heldForOwner: new HeldForOwnerLedger(), surfaceOf: () => undefined });
  const tools = new ToolRegistry(manager);
  const written: string[] = [];
  tools.register({ definition: { name: 'write', description: 'write', parameters: { type: 'object' }, sideEffects: ['write_fs'], core: true },
    execute: async (args) => { written.push(String((args as { path?: unknown }).path)); return { success: true, output: 'written' }; } });
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: tools,
    autonomousSource: () => ({ goal: 'Work on the fixture project', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'policy-home', emitterContext: () => ({ sessionId: 'policy-home', traceId: 'policy-home', source: 'orchestrator' }) };
  let calls = 0;
  const write = async (path: string) => {
    const before = asked;
    const [result] = await executeToolCalls(deps, `turn-${++calls}`, [{ id: `call-${calls}`, name: 'write', arguments: { path, content: 'x' } }]);
    return { ran: result?.success === true, ownerAsked: asked > before };
  };

  const keys = join(home, '.ssh', 'authorized_keys');
  const notes = join(home, 'notes.txt');
  expect({
    lifecycle,
    sshKeys: await write(keys),
    notes: await write(notes),
    written,
  }).toEqual({
    lifecycle: { simulating: true, reviewed: true, promoted: true },
    sshKeys: { ran: false, ownerAsked: false },
    notes: { ran: true, ownerAsked: true },
    written: [notes],
  });
});
