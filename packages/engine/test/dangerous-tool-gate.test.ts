import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import type { GatePresetName } from '../platform/src/platform/gate/presets.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import type { ToolCall } from '../platform/src/platform/types/tools.ts';
import { cloneDefaultConfig } from '../platform/src/platform/config/manager-bootstrap.ts';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
beforeEach(() => {
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(gateReadingsPort([]).port as JudgmentPort, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

function fixture(mode: GatePresetName) {
  const permissions = cloneDefaultConfig().permissions;
  const config: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: { ...permissions, mode }, directory: '/synthetic/danger', autoApprove: false }),
    getSnapshot: () => ({ permissions: { ...permissions, mode } }),
    getWorkingDirectory: () => '/synthetic/danger', isAutoApproveEnabled: () => false,
  };
  const prompts: string[] = [];
  const manager = new PermissionManager(async request => { prompts.push(request.tool); return { approved: true }; }, config, new PolicyRuntimeState(), null, null, null, {});
  const registry = new ToolRegistry(manager);
  const ran: string[] = [];
  for (const [name, dangerous] of [['channel_edit_allowlist', true], ['channel_status', false]] as const) {
    registry.register({ definition: { name, description: 'Intercepted body.', parameters: { type: 'object' }, ...(dangerous ? { dangerous } : {}) },
      execute: async () => { ran.push(name); return { success: true, output: 'ok' }; } });
  }
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Perform the requested synthetic operation', criteria: ['Use the exact requested arguments'] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'danger-fixture', emitterContext: () => ({ sessionId: 'danger-fixture', traceId: 'danger-fixture', source: 'orchestrator' }) };
  const run = (name: string) => executeToolCalls(deps, 'turn-1', [{ id: 'call-1', name, arguments: {} }]);
  const runCall = (call: ToolCall) => executeToolCalls(deps, 'turn-1', [call]);
  return { prompts, ran, run, runCall };
}

test('safe-owner asks the owner before a tool that declares itself dangerous', async () => {
  const f = fixture('safe-owner');
  const [result] = await f.run('channel_edit_allowlist');
  expect(f.prompts).toEqual(['channel_edit_allowlist']);
  expect(result?.success).toBe(true); expect(f.ran).toEqual(['channel_edit_allowlist']);
});

test('safe-owner does not ask about a tool of the same kind that is not dangerous', async () => {
  const f = fixture('safe-owner');
  await f.run('channel_status');
  expect(f.prompts).toEqual([]); expect(f.ran).toEqual(['channel_status']);
});

test('allow-all runs a dangerous tool without asking', async () => {
  const f = fixture('yolo');
  await f.run('channel_edit_allowlist');
  expect(f.prompts).toEqual([]); expect(f.ran).toEqual(['channel_edit_allowlist']);
});

test('a call whose arguments could not be read is answered with the reason and never runs', async () => {
  const f = fixture('yolo');
  const [result] = await f.runCall({ id: 'call-1', name: 'channel_status', arguments: {}, argumentError: "Tool call 'channel_status' was not run: the arguments are not valid JSON." });
  expect(result?.success).toBe(false); expect(result?.error).toContain('not valid JSON');
  expect(f.ran).toEqual([]); expect(f.prompts).toEqual([]);
});
