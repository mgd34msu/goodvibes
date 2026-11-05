import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { cloneDefaultConfig } from '../sdk/src/platform/config/manager-bootstrap.ts';
import { PermissionManager, createPermissionConfigReader, type GateOptions, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { ToolRegistry, assertCurrentToolEffect, type ToolExecutionEffect } from '../sdk/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import type { GatePresetName } from '../sdk/src/platform/gate/presets.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const modes = ['safe-owner', 'safe-jev', 'yolo'] as const;
const safeModes = ['safe-owner', 'safe-jev'] as const;
const inputSurfaces = ['email', 'webhook', 'unregistered-fixture-source'] as const;
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let requests: unknown[];
beforeEach(() => {
  forgetGateReadings(); requests = []; log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort([
    ['host-read', { mutates: false, kind: 'read' }],
    ['rm -rf source-fixture', { mutates: true, irreversible: true }],
    ['weaken-security-fixture', { mutates: true, weakensSecurity: true }],
    ['ordinary-outward-fixture', { mutates: true, outward: true }],
    ['ordinary-beyond-project-fixture', { mutates: true, beyondProject: true }],
  ]);
  const semantic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  const port: JudgmentPort = withDecisionLog({ model: gate.port.model, async ask(request) {
    requests.push(request);
    return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  previous = installJudgmentPort(port);
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

type Tools = ReturnType<typeof cloneDefaultConfig>['permissions']['tools'];
function fixture(mode: GatePresetName, options: { tools?: Partial<Tools>; gate?: GateOptions; reader?: PermissionConfigReader; approved?: boolean } = {}) {
  const defaults = cloneDefaultConfig().permissions;
  const permissions = { ...defaults, mode, tools: { ...defaults.tools, ...options.tools } };
  const frame = () => ({ permissions, autoApprove: false, directory: '/synthetic/host-constraints' });
  const reader: PermissionConfigReader = options.reader ?? {
    getAutonomousSnapshot: frame, getSnapshot: () => ({ permissions }),
    getWorkingDirectory: () => frame().directory, isAutoApproveEnabled: () => false,
  };
  let prompts = 0;
  const manager = new PermissionManager(async () => { prompts++; return { approved: options.approved ?? false }; }, reader, new PolicyRuntimeState(), null, null, null, options.gate);
  const registry = new ToolRegistry(manager);
  const bodies: string[] = [];
  const register = (name: string, effect?: ToolExecutionEffect) => registry.register({
    definition: { name, description: 'Intercepted host constraint fixture; no shell or network.', parameters: { type: 'object' } },
    async execute(args, execution) {
      execution?.assertCurrent?.();
      if (effect && !assertCurrentToolEffect(args, execution, effect)) throw new Error('An authentic effect admission is required');
      bodies.push(name);
      return { success: true, output: 'intercepted' };
    },
  });
  register('exec', 'write'); register('write', 'write'); register('send_fixture', 'send'); register('read');
  const deps: ToolExecutionDeps = {
    permissionManager: manager, toolRegistry: registry, hookDispatcher: null, runtimeBus: null,
    autonomousSource: () => ({ goal: 'Perform the exact synthetic operation requested by the owner', criteria: ['Retain host constraints'] }),
    sessionId: 'host-constraints', emitterContext: () => ({ sessionId: 'host-constraints', traceId: 'host-constraints', source: 'orchestrator' }),
  };
  let call = 0;
  const run = (name = 'exec', command = name === 'read' ? 'host-read' : 'ordinary-host-fixture') => executeToolCalls(deps, 'host-turn', [
    { id: `host-call-${++call}`, name, arguments: name === 'exec' ? { commands: [{ cmd: command }] } : { command } },
  ]);
  return { manager, registry, deps, bodies, run, register, prompts: () => prompts };
}

async function attempt(run: ReturnType<typeof fixture>['run'], name = 'exec') {
  try {
    const [result] = await run(name);
    return { success: result?.success === true, detail: result?.error ?? '' };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { success: false, detail: error.message };
  }
}

test.each(safeModes.map(mode => [mode] as const))('%s preserves explicit exec and read denials before either decision callback', async mode => {
  const f = fixture(mode, { tools: { exec: 'deny', read: 'deny' }, approved: true });
  expect((await attempt(f.run, 'exec')).success).toBe(false);
  expect((await attempt(f.run, 'read')).success).toBe(false);
  expect((await f.manager.checkDetailed('exec', { command: 'ordinary-host-fixture' })).approved).toBe(false);
  expect((await f.manager.checkDetailed('read', { path: 'src/private.ts' })).approved).toBe(false);
  expect(await f.manager.readAccess('src/private.ts')).toBe('restricted');
  expect(f.bodies).toHaveLength(0); expect(f.prompts()).toBe(0); expect(requests).toHaveLength(0);
});

function savedConfig(settings: unknown) {
  const root = makeProjectTempDir('permission-host-config');
  const configDir = join(root, 'config'), workingDir = join(root, 'workspace');
  mkdirSync(configDir); mkdirSync(workingDir);
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings));
  return new ConfigManager({ configDir, workingDir, surfaceRoot: 'agent' });
}

test('a saved custom-mode tool denial survives loading through the real ConfigManager', async () => {
  const config = savedConfig({ permissions: { mode: 'custom', tools: { exec: 'deny', read: 'deny' } } });
  const f = fixture('safe-owner', { reader: createPermissionConfigReader(config), approved: true });
  expect(f.manager.getMode()).toBe('safe-owner');
  expect((await attempt(f.run, 'exec')).success).toBe(false);
  expect(await f.manager.readAccess('src/private.ts')).toBe('restricted');
  expect(f.bodies).toHaveLength(0); expect(f.prompts()).toBe(0); expect(requests).toHaveLength(0);
});

test('a saved default prompt mode still executes an ordinary command automatically', async () => {
  const config = savedConfig({ permissions: { mode: 'prompt' } });
  const f = fixture('safe-owner', { reader: createPermissionConfigReader(config) });
  expect(f.manager.getMode()).toBe('safe-owner');
  expect((await attempt(f.run)).success).toBe(true);
  expect(f.bodies).toEqual(['exec']); expect(f.prompts()).toBe(0);
});

for (const mode of modes) {
  for (const surface of inputSurfaces) {
    test(`${mode} refuses write, exec and send from ${surface} without asking either owner`, async () => {
      const f = fixture(mode, { gate: { surfaceOf: () => surface }, approved: true });
      for (const tool of ['write', 'exec', 'send_fixture']) expect((await attempt(f.run, tool)).success, tool).toBe(false);
      expect(f.bodies).toHaveLength(0); expect(f.prompts()).toBe(0); expect(requests).toHaveLength(0);
    });
    test(`${mode} permits reading evidence from ${surface}`, async () => {
      const f = fixture(mode, { gate: { surfaceOf: () => surface } });
      expect((await attempt(f.run, 'read')).success).toBe(true);
      expect(f.bodies).toEqual(['read']); expect(f.prompts()).toBe(0);
    });
    test(`${mode} does not let an admitted read launder a send from ${surface}`, async () => {
      const f = fixture(mode, { gate: { surfaceOf: () => surface } });
      f.registry.unregister('read'); f.register('read', 'send');
      expect((await attempt(f.run, 'read')).success).toBe(false);
      expect(f.bodies).toHaveLength(0); expect(f.prompts()).toBe(0);
    });
  }
  test(`${mode} preserves terminal authority for writes, commands and sends`, async () => {
    const f = fixture(mode, { gate: { surfaceOf: () => 'terminal' } });
    for (const tool of ['write', 'exec', 'send_fixture']) expect((await attempt(f.run, tool)).success, tool).toBe(true);
    expect(f.bodies).toEqual(['write', 'exec', 'send_fixture']); expect(f.prompts()).toBe(0);
  });
  test(`${mode} cannot bypass a mandatory workspace preparation failure`, async () => {
    let preparations = 0;
    const f = fixture(mode, { gate: { workspaceTrust: { async prepareAutonomousConstraint() { preparations++; throw new Error('Fixture workspace restricted'); } } } });
    const result = await attempt(f.run);
    expect(result.success).toBe(false); expect(result.detail).toContain('Fixture workspace restricted');
    expect(preparations).toBe(1); expect(f.bodies).toHaveLength(0); expect(f.prompts()).toBe(0); expect(requests).toHaveLength(0);
  });
  test(`${mode} holds non-read execution when a required workspace capability is explicitly undefined`, async () => {
    const f = fixture(mode, { gate: { workspaceTrust: undefined } });
    const result = await attempt(f.run);
    expect(result.success).toBe(false); expect(result.detail).toContain('workspace trust capability');
    expect(f.bodies).toHaveLength(0); expect(f.prompts()).toBe(0); expect(requests).toHaveLength(0);
  });
  test(`${mode} revalidates the workspace grant immediately before its prepared body`, async () => {
    let valid = true, preparations = 0;
    const f = fixture(mode, { gate: { workspaceTrust: { async prepareAutonomousConstraint() {
      preparations++; return () => { if (!valid) throw new Error('Fixture workspace grant revoked'); };
    } } } });
    const admit = f.manager.admitAutonomous.bind(f.manager);
    f.manager.admitAutonomous = async (...args) => { const admission = await admit(...args); valid = false; return admission; };
    const result = await attempt(f.run);
    expect(result.success).toBe(false); expect(result.detail).toContain('Fixture workspace grant revoked');
    expect(preparations).toBe(1); expect(f.bodies).toHaveLength(0); expect(f.prompts()).toBe(0);
  });
}

test.each([true, false])('safe-owner asks for an irreversible local command, owner approved=%s', async approved => {
  const f = fixture('safe-owner', { approved });
  const [result] = await f.run('exec', 'rm -rf source-fixture');
  expect(result?.success).toBe(approved); expect(f.prompts()).toBe(1); expect(f.bodies).toHaveLength(approved ? 1 : 0);
});

test.each([true, false])('safe-owner asks before weakening security, owner approved=%s', async approved => {
  const f = fixture('safe-owner', { approved });
  const [result] = await f.run('exec', 'weaken-security-fixture');
  expect(result?.success).toBe(approved); expect(f.prompts()).toBe(1); expect(f.bodies).toHaveLength(approved ? 1 : 0);
});

test.each(['ordinary-outward-fixture', 'ordinary-beyond-project-fixture'])('safe-owner automatically permits ordinary high-stakes %s', async command => {
  const f = fixture('safe-owner');
  const [result] = await f.run('exec', command);
  expect(result?.success).toBe(true); expect(f.prompts()).toBe(0); expect(f.bodies).toEqual(['exec']);
});
