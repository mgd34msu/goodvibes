import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { withExecutionModeOwner, type GatePresetName } from '@goodvibes-jev/engine/platform/platform/gate';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/platform/platform/utils';
import { wrapExecToolForAgentPolicy, wrapFetchToolForAgentPolicy, wrapModeRestrictedToolForAgentPolicy } from '../../tools/agent-tool-policy-guard.ts';
import { createAgentLocalStateInputProjector } from '../../tools/agent-local-state-admission.ts';
import { assertAgentMemoryInput } from '../../tools/agent-memory-input-guard.ts';
import { assertNoSecretLikeMemoryText } from '../../agent/memory-safety.ts';
import { assertNoSecretLikeText } from '../../agent/persona-registry.ts';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';

const withMode = <T>(mode: GatePresetName, run: () => T): T =>
  withExecutionModeOwner({ getMode: () => mode, getRevision: () => 0 }, run);

function fixture(name: string): { tool: Tool; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { calls, tool: { definition: { name, description: 'Original tool description', parameters: {
    type: 'object', properties: { mode: { type: 'string', enum: ['read', 'write'] }, parallel: { type: 'boolean' },
      commands: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, background: { type: 'boolean' } } } },
      urls: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' }, body: { type: 'string' } } } } },
  } }, execute: async args => { calls.push(args); return { success: true, output: 'fixture' }; } } };
}

test('Agent wrappers preserve the registered capabilities required by the execution modes', () => {
  const cases: { name: string; wrap: (tool: Tool) => void }[] = [
    { name: 'exec', wrap: wrapExecToolForAgentPolicy }, { name: 'fetch', wrap: wrapFetchToolForAgentPolicy },
    { name: 'task', wrap: tool => wrapModeRestrictedToolForAgentPolicy(tool, {
      allowedModes: ['read'], modeSet: new Set(['read']), description: 'Old read-only policy', denial: 'Old denial', removedProperties: ['parallel'],
    }) },
  ];
  for (const entry of cases) {
    const value = fixture(entry.name); const definition = structuredClone(value.tool.definition);
    entry.wrap(value.tool);
    expect(value.tool.definition).toEqual(definition);
  }
});

test('YOLO executes supported registered actions without a second Agent policy veto', async () => {
  const cases: { name: string; args: Record<string, unknown>; wrap: (tool: Tool) => void }[] = [
    { name: 'exec', args: { parallel: true, commands: [{ cmd: 'fixture only', background: true }] }, wrap: wrapExecToolForAgentPolicy },
    { name: 'fetch', args: { urls: [{ url: 'https://example.invalid', method: 'POST', body: 'fixture' }] }, wrap: wrapFetchToolForAgentPolicy },
    { name: 'task', args: { mode: 'write' }, wrap: value => wrapModeRestrictedToolForAgentPolicy(value, {
      allowedModes: ['read'], modeSet: new Set(['read']), description: 'Old read-only policy', denial: 'Old denial',
    }) },
  ];
  for (const entry of cases) {
    const value = fixture(entry.name); entry.wrap(value.tool);
    const registry = new ToolRegistry(); registry.register(value.tool);
    await withMode('yolo', async () => {
      const prepared = await registry.prepareCall(`fixture-${entry.name}`, entry.name, entry.args);
      const result = await registry.executePrepared(prepared, () => {});
      expect(result.success).toBe(true);
      expect(value.calls).toEqual([entry.args]);
      await expect(registry.executePrepared(prepared, () => {})).rejects.toThrow();
    });
  }
});

test.each(['safe-owner', 'safe-jev', 'yolo'] as const)('%s preserves explicitly granted outside-project path scope', mode => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-yolo-path-'));
  const project = join(dir, 'project'); mkdirSync(project);
  const outside = join(dir, 'outside.txt'); writeFileSync(outside, 'fixture');
  try {
    expect(() => resolveAndValidatePath(outside, project)).toThrow('outside the project root');
    expect(() => withMode(mode, () => resolveAndValidatePath(outside, project, false))).toThrow('outside the project root');
    expect(withMode(mode, () => resolveAndValidatePath(outside, project, true))).toBe(outside);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['safe-owner', 'safe-jev', 'yolo'] as const)('%s local-state preparation preserves secret containment and exact target lifetime', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-mode-state-'));
  const target = join(dir, 'state.json'); writeFileSync(target, '{}');
  const projector = createAgentLocalStateInputProjector(() => ({ targets: [{ root: dir, path: target, access: 'write' }], assertDescriptors() {} }), () => false);
  const request = { callId: 'fixture', name: 'memory', args: { text: 'password=fixture-value' }, assertCurrent() {} };
  try {
    await withMode(mode, async () => {
      await expect(projector.project(request)).rejects.toThrow('held');
      const result = await projector.project({ ...request, args: { text: 'A harmless note' } });
      expect(result.status).toBe('projected');
      if (result.status !== 'projected') throw new Error('Expected projected fixture');
      result.assertCurrent?.();
      await result.release?.();
      expect(() => result.assertCurrent?.()).toThrow('released');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['safe-owner', 'safe-jev', 'yolo'] as const)('%s preserves local-record secret rules, structural validation and judgment privacy', mode => {
  const text = 'password=fixture-value';
  withMode(mode, () => {
    expect(() => assertAgentMemoryInput({ text })).toThrow('held');
    expect(() => assertNoSecretLikeMemoryText([text])).toThrow('secret-looking');
    expect(() => assertNoSecretLikeText([text])).toThrow('secret-looking');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => assertAgentMemoryInput(cyclic)).toThrow('invalid');
    expect(() => snapshotJudgmentInput({ password: 'fixture-value' })).toThrow();
  });
});
