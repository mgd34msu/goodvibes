/**
 * /ops interventions, live proof of the operator control-plane path.
 *
 * This surface shipped dead for three months: OpsControlPlane construction
 * was gated on 'operator-control-plane', an id never registered in any platform
 * registry, so isEnabled was permanently false, /ops task|agent always
 * errored, and the Ops Control view never left its not-configured state.
 * The gate now rides the real control-plane gateway capability
 * (controlPlane.gateway, enabled in a stock configuration).
 *
 * These tests treat the whole path as previously unproven:
 *   - the gate id bootstrap.ts uses (the platform's CONTROL_PLANE_FEATURE_FLAG)
 *     is a registered flag that derives honestly from controlPlane.gateway
 *     (on by default, off when the key is off);
 *   - the /ops command family performs real interventions through
 *     createRuntimeOpsApi + OpsControlPlane against a REAL task manager and
 *     runtime store (no mocks in the intervention path);
 *   - illegal actions and missing targets surface honest [Ops] errors;
 *   - an id no registry knows is permanently false, which is how this surface
 *     shipped dead; the registered-id test fails for such an id.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  OpsControlPlane,
  RuntimeEventBus,
  createRuntimeOpsApi,
  createTaskManager,
} from '@/runtime/index.ts';
import type { OpsAgentCanceller } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';
import { withPublicErrorText } from '../helpers/user-error-reading.ts';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { CONTROL_PLANE_FEATURE_FLAG } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { bindFeatureSettingsBridge, deriveFeatureStates } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SESSION_ID = 'ops-proof-session';

/** `null`: no agent manager is wired, as when the control plane is built without one. */
function makeEnv(options: { readonly withCanceller?: boolean } = {}) {
  const store = createRuntimeStore();
  const bus = new RuntimeEventBus();
  const dispatch = createDomainDispatch(store);
  const taskManager = createTaskManager(store, bus, SESSION_ID);
  // Stands in for the agent manager: it runs every agent it is asked about and,
  // like the real manager, publishes AGENT_CANCELLED, which moves the store record.
  const cancelCalls: string[] = [];
  const canceller: OpsAgentCanceller = {
    cancel: (agentId) => {
      cancelCalls.push(agentId);
      dispatch.dispatchAgentEvent({ type: 'AGENT_CANCELLED', agentId, timestamp: Date.now() } as never);
      return true;
    },
  };
  const opsControlPlane = new OpsControlPlane(taskManager, bus, store, SESSION_ID,
    options.withCanceller === false ? undefined : canceller);
  const opsApi = createRuntimeOpsApi({
    // Read model: a thin live projection of the real store (reads are not
    // under test here; the intervention path is).
    tasksReadModel: {
      getSnapshot: () => ({
        tasks: [...store.getState().tasks.tasks.values()],
        updatedAt: Date.now(),
      }) as never,
    },
    taskManager,
    opsControlPlane,
  });

  const printed: string[] = [];
  const registry = new CommandRegistry();
  registerOperatorRuntimeCommands(registry);
  const ctx = {
    print: (text: string) => { printed.push(text); },
    clients: { opsApi },
    ops: {},
    platform: {},
    session: {},
  } as unknown as CommandContext;
  const run = async (line: string): Promise<void> => {
    const [name, ...args] = line.split(' ');
    const command = registry.get(name!);
    if (!command) throw new Error(`command not registered: ${name}`);
    await command.handler(args, ctx);
  };

  return { store, bus, dispatch, taskManager, opsControlPlane, opsApi, printed, run, cancelCalls };
}

describe('/ops gate: control-plane gateway capability', () => {
  function makeGate() {
    const root = makeProjectTempDir('gv-ops-gate');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root, homeDir: root });
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    const unbind = bindFeatureSettingsBridge(configManager, featureFlags);
    return { configManager, featureFlags, dispose: () => { unbind(); configManager.stopWatchingConfigFiles(); } };
  }

  test('the gate id is a registered flag, never the unregistered id that shipped dead', () => {
    const gate = makeGate();
    try {
      // getState throws for an id no registry knows; isEnabled would silently say false.
      expect(() => gate.featureFlags.getState(CONTROL_PLANE_FEATURE_FLAG)).not.toThrow();
      expect(() => gate.featureFlags.getState('operator-control-plane')).toThrow();
    } finally {
      gate.dispose();
    }
  });

  test('bootstrap gates OpsControlPlane on the registered flag, not a literal id', () => {
    const source = readFileSync(new URL('../../runtime/bootstrap.ts', import.meta.url), 'utf8');
    expect(source).toContain('featureFlags.isEnabled(CONTROL_PLANE_FEATURE_FLAG)\n    ? new OpsControlPlane(');
    expect(source).not.toContain("'operator-control-plane'");
  });

  test('the gate is on in a stock configuration and follows controlPlane.gateway', () => {
    const gate = makeGate();
    try {
      expect(gate.featureFlags.isEnabled(CONTROL_PLANE_FEATURE_FLAG)).toBe(true);
      gate.configManager.setDynamic('controlPlane.gateway', false);
      expect(gate.featureFlags.isEnabled(CONTROL_PLANE_FEATURE_FLAG)).toBe(false);
      gate.configManager.setDynamic('controlPlane.gateway', true);
      expect(gate.featureFlags.isEnabled(CONTROL_PLANE_FEATURE_FLAG)).toBe(true);
    } finally {
      gate.dispose();
    }
  });
});

describe('/ops task interventions: real task manager, real control plane', () => {
  test('pause blocks a running task, resume returns it to running', async () => {
    const env = makeEnv();
    const task = env.taskManager.createTask({ kind: 'exec', title: 'long run', owner: 'test', cancellable: true });
    env.taskManager.startTask(task.id);
    expect(env.taskManager.getTask(task.id)?.status).toBe('running');

    await env.run(`ops task pause ${task.id} operator pause note`);
    expect(env.taskManager.getTask(task.id)?.status).toBe('blocked');
    expect(env.printed.some((line) => line.includes(`Task ${task.id}: pause dispatched.`))).toBe(true);

    await env.run(`ops task resume ${task.id}`);
    expect(env.taskManager.getTask(task.id)?.status).toBe('running');
    expect(env.printed.some((line) => line.includes(`Task ${task.id}: resume dispatched.`))).toBe(true);
  });

  test('cancel moves a queued task to cancelled and the store agrees', async () => {
    const env = makeEnv();
    const task = env.taskManager.createTask({ kind: 'exec', title: 'doomed', owner: 'test', cancellable: true });

    await env.run(`ops task cancel ${task.id} not needed anymore`);
    expect(env.taskManager.getTask(task.id)?.status).toBe('cancelled');
    expect(env.store.getState().tasks.tasks.get(task.id)?.status).toBe('cancelled');
    expect(env.printed.some((line) => line.includes(`Task ${task.id}: cancel dispatched.`))).toBe(true);
  });

  test('retry revives a failed task', async () => {
    const env = makeEnv();
    const task = env.taskManager.createTask({ kind: 'exec', title: 'flaky', owner: 'test', cancellable: true });
    env.taskManager.startTask(task.id);
    env.taskManager.failTask(task.id, { error: 'boom' });
    expect(env.taskManager.getTask(task.id)?.status).toBe('failed');

    await env.run(`ops task retry ${task.id}`);
    const revived = env.taskManager.getTask(task.id)?.status;
    expect(revived === 'queued' || revived === 'running').toBe(true);
    expect(env.printed.some((line) => line.includes(`Task ${task.id}: retry dispatched.`))).toBe(true);
  });

  test('an illegal action surfaces an honest [Ops] error, not a silent no-op', async () => {
    const env = makeEnv();
    const task = env.taskManager.createTask({ kind: 'exec', title: 'done already', owner: 'test', cancellable: true });
    env.taskManager.startTask(task.id);
    env.taskManager.completeTask(task.id, { summary: 'ok' });

    await env.run(`ops task cancel ${task.id}`);
    expect(env.taskManager.getTask(task.id)?.status).toBe('completed');
    expect(env.printed.some((line) => line.startsWith('[Ops] Error:'))).toBe(true);
  });

  test('a missing task id surfaces an honest [Ops] error', async () => {
    const env = makeEnv();
    expect(() => env.opsApi.tasks.pause('task-that-never-existed')).toThrow('[OpsControlPlane] task not found: task-that-never-existed');
    await withPublicErrorText(['[OpsControlPlane] task not found: task-that-never-existed'], () => env.run('ops task pause task-that-never-existed'), {
      ordinaryFields: ['found'],
      credentialProjections: [{ phase: 'source', target: 'span-1', parts: [
        { kind: 'text', text: '[OpsControlPlane] task not found: ' },
        { kind: 'span', reference: 'span-1', syntax: 'assignment-value', field: 'found' },
        { kind: 'text', text: '' },
      ] }],
      residualProjections: [{ parts: [
        { kind: 'text', text: '[OpsControlPlane] task not found: ' },
        { kind: 'withheld', reference: 'span-1' },
        { kind: 'text', text: '' },
      ] }],
    });
    expect(env.store.getState().tasks.tasks.size).toBe(0);
    expect(env.printed.some((line) => line.startsWith('[Ops] Error:') && line.includes('task-that-never-existed'))).toBe(true);
    expect(env.printed.join('\n')).not.toContain('dispatched');
  });
});

describe('/ops agent interventions', () => {
  test('cancel transitions a live agent record to cancelled', async () => {
    const env = makeEnv();
    env.dispatch.dispatchAgentEvent({
      type: 'AGENT_SPAWNING',
      agentId: 'agent-live-1',
      task: 'demo work',
      timestamp: Date.now(),
    } as never);
    expect(env.store.getState().agents.agents.get('agent-live-1')?.status).toBe('spawning');

    await env.run('ops agent cancel agent-live-1 no longer needed');
    expect(env.cancelCalls).toEqual(['agent-live-1']);
    expect(env.store.getState().agents.agents.get('agent-live-1')?.status).toBe('cancelled');
    expect(env.printed.some((line) => line.includes('Agent agent-live-1: cancel dispatched.'))).toBe(true);
  });

  test('cancel without an agent manager refuses and leaves the agent running', async () => {
    const env = makeEnv({ withCanceller: false });
    env.dispatch.dispatchAgentEvent({
      type: 'AGENT_SPAWNING',
      agentId: 'agent-live-2',
      task: 'demo work',
      timestamp: Date.now(),
    } as never);

    await env.run('ops agent cancel agent-live-2');
    expect(env.store.getState().agents.agents.get('agent-live-2')?.status).toBe('spawning');
    expect(env.printed.some((line) => line.startsWith('[Ops] Error:') && line.includes('no agent manager is connected'))).toBe(true);
    expect(env.printed.join('\n')).not.toContain('dispatched');
  });

  test('a missing agent id surfaces an honest [Ops] error', async () => {
    const env = makeEnv();
    expect(() => env.opsApi.agents.cancel('agent-that-never-existed')).toThrow('[OpsControlPlane] agent not found: agent-that-never-existed');
    await withPublicErrorText(['[OpsControlPlane] agent not found: agent-that-never-existed'], () => env.run('ops agent cancel agent-that-never-existed'), {
      ordinaryFields: ['found'],
      credentialProjections: [{ phase: 'source', target: 'span-1', parts: [
        { kind: 'text', text: '[OpsControlPlane] agent not found: ' },
        { kind: 'span', reference: 'span-1', syntax: 'assignment-value', field: 'found' },
        { kind: 'text', text: '' },
      ] }],
      residualProjections: [{ parts: [
        { kind: 'text', text: '[OpsControlPlane] agent not found: ' },
        { kind: 'withheld', reference: 'span-1' },
        { kind: 'text', text: '' },
      ] }],
    });
    expect(env.store.getState().agents.agents.size).toBe(0);
    expect(env.printed.some((line) => line.startsWith('[Ops] Error:') && line.includes('agent-that-never-existed'))).toBe(true);
    expect(env.printed.join('\n')).not.toContain('dispatched');
  });
});
