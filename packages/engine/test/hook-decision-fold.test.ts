// Proves: A call one of the owner's Pre hooks asks about or denies runs without the owner because another hook allowed it.
// Red when: The hook dispatcher lets a later hook's allow replace an earlier ask or deny, so the gate admits the call without putting it to the owner.
/**
 * Two of the owner's command hooks on the same Pre:tool point, loaded from a
 * real hooks file into the real dispatcher, in front of the real permission
 * manager, tool registry and executor in ask-me mode. The tool only reads, so
 * the gate runs it unasked; the owner refuses whatever he is asked.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { HeldForOwnerLedger } from '../platform/src/platform/permissions/held-for-owner.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { HookDispatcher } from '../platform/src/platform/hooks/dispatcher.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-hook-fold-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Decision = 'allow' | 'ask' | 'deny';

/** Runs one `look` call behind two Pre hooks answering `first` then `second`. */
async function callBehindHooks(first: Decision, second: Decision) {
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: join(dir, 'workspace'), homeDir: join(dir, 'home'), configDir: join(dir, 'config'), ownsDaemonTier: true });
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'ask-me' }], localOwnerActor()).ok).toBe(true);
  let ownerAsked = 0;
  const manager = new PermissionManager(async () => { ownerAsked++; return { approved: false }; },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, { heldForOwner: new HeldForOwnerLedger(), surfaceOf: () => undefined });
  const registry = new ToolRegistry(manager);
  let ran = 0;
  registry.register({ definition: { name: 'read', description: 'read', parameters: { type: 'object' }, sideEffects: ['read_fs'], core: true },
    execute: async () => { ran++; return { success: true, output: 'looked' }; } });

  const hook = (decision: Decision) => ({ type: 'command', command: `echo '{"decision":"${decision}","reason":"hook said ${decision}"}'` });
  const hooksFile = join(dir, `hooks-${first}-${second}.json`);
  writeFileSync(hooksFile, JSON.stringify({ hooks: { 'Pre:tool:read': [hook(first), hook(second)] } }), { mode: 0o600 });
  const dispatcher = new HookDispatcher();
  dispatcher.loadFromFile(hooksFile);
  expect(dispatcher.listHooks()).toHaveLength(2);

  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Work on the fixture project', criteria: [] }),
    hookDispatcher: dispatcher, runtimeBus: null, sessionId: 'fold', emitterContext: () => ({ sessionId: 'fold', traceId: 'fold', source: 'orchestrator' }) };
  const [result] = await executeToolCalls(deps, `turn-${first}-${second}`, [{ id: `call-${first}-${second}`, name: 'read', arguments: { path: join(dir, 'workspace', 'notes.txt') } }]);
  return { ran, ownerAsked, success: result!.success };
}

test('a Pre hook that asks or denies is not overruled by another hook that allows: the owner is asked, or the call is refused', async () => {
  // Control: two allows leave the read to the gate, which runs it unasked.
  expect(await callBehindHooks('allow', 'allow')).toEqual({ ran: 1, ownerAsked: 0, success: true });
  // An ask followed by an allow still puts the call to the owner, who refuses it.
  expect(await callBehindHooks('ask', 'allow')).toEqual({ ran: 0, ownerAsked: 1, success: false });
  expect(await callBehindHooks('allow', 'ask')).toEqual({ ran: 0, ownerAsked: 1, success: false });
  // A deny anywhere refuses without asking.
  expect(await callBehindHooks('deny', 'allow')).toEqual({ ran: 0, ownerAsked: 0, success: false });
  expect(await callBehindHooks('ask', 'deny')).toEqual({ ran: 0, ownerAsked: 0, success: false });
});
