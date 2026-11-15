/**
 * An automation spawns its agent with the action binding the manager recorded
 * for that input, alongside the task, model and tool restrictions it asked for.
 */
import { expect, test } from 'bun:test';
import { automationActionBinding, bindAutomationAction, type SpawnAutomationTaskInput } from '@goodvibes-jev/engine/platform/platform/automation';
import { createAutomationSpawnTask } from '../../runtime/automation-spawn.ts';

const source = { goal: 'keep the build green', criteria: ['the build passes'] };

function spawnWith(input: Partial<SpawnAutomationTaskInput>) {
  const calls: Array<{ spec: unknown; binding: unknown }> = [];
  const agentManager = { spawn: (spec: unknown, binding?: unknown) => { calls.push({ spec, binding }); return { id: 'agent-1' }; } };
  const full = bindAutomationAction({ prompt: 'check the build', ...input } as SpawnAutomationTaskInput, {
    assertCurrent: () => {},
    sourceOf: () => source,
  });
  const id = createAutomationSpawnTask(agentManager as never)(full);
  return { id, calls, input: full };
}

test('the spawned agent gets the binding recorded for the input, and its id is returned', () => {
  const { id, calls, input } = spawnWith({});
  expect(id).toBe('agent-1');
  expect(calls).toHaveLength(1);
  const binding = calls[0]?.binding as { autonomousSource?: () => unknown } | undefined;
  expect(binding).toBeDefined();
  expect(binding).toBe(automationActionBinding(input));
  expect(binding?.autonomousSource?.()).toEqual(source);
});

test('the task, model, provider and tool allowlist are passed through, and an allowlist restricts the tools', () => {
  const { calls } = spawnWith({ modelId: 'm', modelProvider: 'p', toolAllowlist: ['read', 'find'] });
  expect(calls[0]?.spec).toEqual({
    mode: 'spawn', task: 'check the build', model: 'm', provider: 'p', tools: ['read', 'find'], restrictTools: true,
    context: 'automation-manager:visible-agent',
  });
});
