import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { PermissionManager, type GateOptions, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import type { PermissionRequestHandler } from '../platform/src/platform/permissions/prompt.ts';
import type { GatePresetName } from '../platform/src/platform/gate/presets.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { cloneDefaultConfig } from '../platform/src/platform/config/manager-bootstrap.ts';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let requests: JudgmentRequest<Questions>[];
let choice: 'act' | 'reject';
beforeEach(() => {
  forgetGateReadings(); requests = []; choice = 'act'; log = new SqliteDecisionLog(':memory:');
  const readings = gateReadingsPort([['erase-fixture', { mutates: true, irreversible: true, beyondProject: true, catastrophic: true }]]);
  const semantic = fakePort((_name, question) => choiceAnswer(question, choice, 0.99));
  const port: JudgmentPort = { model: readings.port.model, async ask(request) {
    requests.push(request as JudgmentRequest<Questions>);
    return Object.hasOwn(request.questions, 'disposition') ? semantic.port.ask(request) : readings.port.ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

function fixture(mode: GatePresetName, reply: PermissionRequestHandler = async () => ({ approved: false }), gate: GateOptions = {}) {
  let currentMode = mode;
  let autoApprove = false;
  const permissions = cloneDefaultConfig().permissions;
  const config: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: { ...permissions, mode: currentMode }, directory: '/synthetic/modes', autoApprove }),
    getSnapshot: () => ({ permissions: { ...permissions, mode: currentMode } }),
    getWorkingDirectory: () => '/synthetic/modes', isAutoApproveEnabled: () => autoApprove,
  };
  const prompts: Parameters<PermissionRequestHandler>[0][] = [];
  const manager = new PermissionManager(async (request, options) => { prompts.push(request); return reply(request, options); }, config, new PolicyRuntimeState(), null, null, null, gate);
  const registry = new ToolRegistry(manager);
  const bodies: Record<string, unknown>[] = [];
  registry.register({ definition: { name: 'exec', description: 'Intercepted body; no shell process runs.', parameters: { type: 'object' } },
    execute: async args => { bodies.push(args); return { success: true, output: 'intercepted' }; } });
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Perform the requested synthetic operation', criteria: ['Use the exact requested arguments'] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'mode-fixture', emitterContext: () => ({ sessionId: 'mode-fixture', traceId: 'mode-fixture', source: 'orchestrator' }) };
  const run = (args: Record<string, unknown> = { commands: [{ cmd: 'ordinary-fixture' }] }) => executeToolCalls(deps, 'turn-1', [{ id: 'call-1', name: 'exec', arguments: args }]);
  return { manager, registry, config, prompts, bodies, deps, run, setMode: (next: GatePresetName) => { currentMode = next; }, autoApprove: () => { autoApprove = true; } };
}

test('safe-owner runs ordinary commands without asking or a semantic permission receipt', async () => {
  const f = fixture('safe-owner');
  const [result] = await f.run();
  expect(result?.success).toBe(true); expect(f.prompts).toHaveLength(0); expect(f.bodies).toHaveLength(1);
  expect(result?.autonomousDecision).toBeUndefined();
  expect(requests.some(request => Object.hasOwn(request.questions, 'disposition'))).toBe(false);
});

test.each([true, false])('safe-owner binds the exact risky call to owner reply approved=%s', async approved => {
  const f = fixture('safe-owner', async () => ({ approved }));
  const args = { commands: [{ cmd: 'erase-fixture' }] };
  const [result] = await f.run(args);
  expect(result?.success).toBe(approved); expect(f.bodies).toHaveLength(approved ? 1 : 0);
  expect(f.prompts).toHaveLength(1); expect(f.prompts[0]?.args).toEqual(args);
  expect(requests.some(request => Object.hasOwn(request.questions, 'disposition'))).toBe(false);
});

test.each(['act', 'reject'] as const)('safe-jev resolves risk as %s without an owner handler', async selected => {
  choice = selected;
  const f = fixture('safe-jev', async () => { throw new Error('The owner must not be asked'); });
  const [result] = await f.run({ commands: [{ cmd: 'erase-fixture' }] });
  expect(result?.success).toBe(selected === 'act'); expect(f.prompts).toHaveLength(0);
  expect(f.bodies).toHaveLength(selected === 'act' ? 1 : 0); expect(result?.autonomousDecision?.outcome).toBe(selected);
  expect(log.query().some(entry => entry.status === 'answered')).toBe(true);
});

test('YOLO executes exact arguments without safety judgment under valid host authority', async () => {
  const f = fixture('yolo', async () => { throw new Error('No YOLO prompt'); }, { surfaceOf: () => 'terminal',
    workspaceTrust: { prepareAutonomousConstraint: async () => () => {} } });
  const args = { commands: [{ cmd: 'erase-fixture' }], password: 'synthetic-inline-value' };
  const [result] = await f.run(args);
  expect(result?.success).toBe(true); expect(f.bodies).toEqual([args]); expect(f.prompts).toHaveLength(0); expect(requests).toHaveLength(0);
  await expect(f.run(args)).rejects.toThrow('claimed'); expect(f.bodies).toHaveLength(1);
});

test('legacy autoApprove selects effective YOLO before all safety checks', async () => {
  const f = fixture('safe-owner'); f.autoApprove();
  expect(f.manager.getMode()).toBe('yolo');
  const [result] = await f.run({ commands: [{ cmd: 'erase-fixture' }] });
  expect(result?.success).toBe(true); expect(f.prompts).toHaveLength(0); expect(requests).toHaveLength(0);
});

test('mode replacement after admission invalidates execution even in YOLO', async () => {
  const f = fixture('yolo');
  const admit = f.manager.admitAutonomous.bind(f.manager);
  f.manager.admitAutonomous = async (...args) => { const admission = await admit(...args); f.setMode('safe-owner'); return admission; };
  const [result] = await f.run(); expect(result?.success).toBe(false); expect(f.bodies).toHaveLength(0);
});

test('the same policy is used by direct checks: owner asks, Jev decides, YOLO bypasses', async () => {
  const owner = fixture('safe-owner', async () => ({ approved: true }));
  expect((await owner.manager.checkDetailed('exec', { command: 'erase-fixture' })).approved).toBe(true);
  expect(owner.prompts).toHaveLength(1);
  choice = 'reject'; const jev = fixture('safe-jev');
  expect((await jev.manager.checkDetailed('exec', { command: 'erase-fixture' })).approved).toBe(false);
  expect(jev.prompts).toHaveLength(0);
  const before = requests.length; const yolo = fixture('yolo');
  expect((await yolo.manager.checkDetailed('exec', { command: 'erase-fixture' })).approved).toBe(true);
  expect(requests).toHaveLength(before); expect(yolo.prompts).toHaveLength(0);
});

test('coherent mode owner sampling never calls legacy snapshot getters', () => {
  const f = fixture('safe-owner');
  f.config.getSnapshot = () => { throw new Error('No legacy getter'); };
  f.config.isAutoApproveEnabled = () => { throw new Error('No legacy getter'); };
  expect(f.manager.getMode()).toBe('safe-owner'); f.setMode('safe-jev'); expect(f.manager.getMode()).toBe('safe-jev');
});

test('owner revised arguments are freshly prepared, detached and executed once without a second prompt', async () => {
  const revised = { commands: [{ cmd: 'owner-revised-fixture' }] };
  const f = fixture('safe-owner', async () => ({ approved: true, modifiedArgs: revised }));
  const admit = f.manager.admitAutonomous.bind(f.manager);
  f.manager.admitAutonomous = async (...args) => {
    const admission = await admit(...args);
    if (admission.revision) revised.commands[0]!.cmd = 'late-reply-mutation';
    return admission;
  };
  const [result] = await f.run({ commands: [{ cmd: 'erase-fixture' }] });
  expect(result?.success).toBe(true);
  expect(f.prompts).toHaveLength(1);
  expect(f.bodies).toEqual([{ commands: [{ cmd: 'owner-revised-fixture' }] }]);
  expect(result?.autonomousDecision).toBeUndefined();
  await expect(f.run()).rejects.toThrow('claimed'); expect(f.bodies).toHaveLength(1);
});

test('mode replacement while applying an owner revision invalidates the original invocation', async () => {
  const f = fixture('safe-owner', async () => ({ approved: true, modifiedArgs: { commands: [{ cmd: 'owner-revised-fixture' }] } }));
  const admit = f.manager.admitAutonomous.bind(f.manager);
  f.manager.admitAutonomous = async (...args) => {
    const admission = await admit(...args);
    if (admission.revision) f.setMode('yolo');
    return admission;
  };
  await expect(f.run({ commands: [{ cmd: 'erase-fixture' }] })).rejects.toThrow('Permission configuration changed while deciding');
  expect(f.bodies).toHaveLength(0); expect(f.prompts).toHaveLength(1);
});

test('direct owner checks retain the existing modifiedArgs response without pretending the original args were approved', async () => {
  const revised = { command: 'owner-revised-fixture' };
  const f = fixture('safe-owner', async () => ({ approved: true, modifiedArgs: revised }));
  const result = await f.manager.checkDetailed('exec', { command: 'erase-fixture' });
  revised.command = 'late-mutation';
  expect(result.approved).toBe(true); expect(result.modifiedArgs).toEqual({ command: 'owner-revised-fixture' });
});

test('cancelling a pending owner reply prevents late approval from executing', async () => {
  let reply: ((value: { approved: boolean }) => void) | undefined;
  let entered: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture('safe-owner', () => new Promise(resolve => { reply = resolve; entered?.(); }));
  const cancel = new AbortController(); f.deps.turnSignal = cancel.signal;
  const pending = f.run({ commands: [{ cmd: 'erase-fixture' }] });
  await waiting; cancel.abort();
  await expect(pending).rejects.toBeDefined();
  reply?.({ approved: true }); await Promise.resolve();
  expect(f.bodies).toHaveLength(0);
});

test('a safe-owner outer admission cannot waive a different risky nested action', async () => {
  const f = fixture('safe-owner', async () => ({ approved: false }));
  let outerBodies = 0;
  f.registry.register({ definition: { name: 'outer', description: 'Synthetic delegated operation', parameters: { type: 'object' } },
    execute: async (_args, options) => {
      outerBodies++;
      return f.registry.executeNested('nested-1', 'exec', { commands: [{ cmd: 'erase-fixture' }] }, options);
    } });
  const [result] = await executeToolCalls(f.deps, 'outer-turn', [{ id: 'outer-1', name: 'outer', arguments: { operation: 'ordinary-fixture' } }]);
  expect(outerBodies).toBe(1);
  expect(f.prompts).toHaveLength(1); expect(f.prompts[0]?.tool).toBe('exec');
  expect(f.bodies).toHaveLength(0); expect(result?.success).toBe(false);
});

test('an exact current body permission recheck reuses its admission without another owner prompt', async () => {
  const f = fixture('safe-owner', async () => ({ approved: true }));
  let duplicateApproved = false;
  f.registry.register({ definition: { name: 'outer', description: 'Synthetic delegated operation', parameters: { type: 'object' } },
    execute: async args => {
      const check = await f.manager.checkDetailed('outer', args);
      duplicateApproved = check.approved;
      return { success: check.approved };
    } });
  const [result] = await executeToolCalls(f.deps, 'outer-turn', [{ id: 'outer-1', name: 'outer', arguments: { command: 'erase-fixture' } }]);
  expect(result?.success).toBe(true); expect(duplicateApproved).toBe(true); expect(f.prompts).toHaveLength(1);
});

test('a safe-owner body cannot pass another command through the direct-check compatibility path', async () => {
  const f = fixture('safe-owner', async () => ({ approved: false }));
  let nestedApproved = true;
  f.registry.register({ definition: { name: 'outer', description: 'Synthetic delegated operation', parameters: { type: 'object' } },
    execute: async () => {
      const check = await f.manager.checkDetailed('exec', { command: 'erase-fixture' });
      nestedApproved = check.approved;
      return { success: true };
    } });
  const [result] = await executeToolCalls(f.deps, 'outer-turn', [{ id: 'outer-1', name: 'outer', arguments: { command: 'ordinary-fixture' } }]);
  expect(result?.success).toBe(true); expect(nestedApproved).toBe(false); expect(f.prompts).toHaveLength(1);
});

test('safe-jev evaluates a distinct nested action even after permitting its outer operation', async () => {
  const readings = gateReadingsPort([['erase-fixture', { mutates: true, irreversible: true, beyondProject: true, catastrophic: true }]]);
  const semantic = fakePort((_name, question, state) => choiceAnswer(question, JSON.stringify(state).includes('erase-fixture') ? 'reject' : 'act', 0.99));
  installJudgmentPort(withDecisionLog({ model: readings.port.model, async ask(request) {
    requests.push(request as JudgmentRequest<Questions>);
    return Object.hasOwn(request.questions, 'disposition') ? semantic.port.ask(request) : readings.port.ask(request);
  } }, log));
  const f = fixture('safe-jev', async () => { throw new Error('No owner callback'); });
  f.registry.register({ definition: { name: 'outer', description: 'Synthetic delegated operation', parameters: { type: 'object' } },
    execute: async (_args, options) => f.registry.executeNested('nested-1', 'exec', { commands: [{ cmd: 'erase-fixture' }] }, options) });
  const [result] = await executeToolCalls(f.deps, 'outer-turn', [{ id: 'outer-1', name: 'outer', arguments: { command: 'ordinary-fixture' } }]);
  expect(result?.success).toBe(false); expect(f.bodies).toHaveLength(0); expect(f.prompts).toHaveLength(0);
  expect(requests.filter(request => Object.hasOwn(request.questions, 'disposition'))).toHaveLength(2);
});
