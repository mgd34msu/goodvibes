import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { ConfigManager, DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/platform/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/platform/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { createSetupSmokeReferenceCapture, resolveSetupSmokeNativeEvidence } from '../../tools/agent-setup-smoke-reference.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog, readings: ReturnType<typeof fakePort>;
const roots: string[] = [];
beforeEach(() => {
  readings = fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    if (question.type === 'noul') return noulAnswer(0.001);
    const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read'
      : name === 'family' || name === 'capability' ? 'generic' : undefined;
    if (!label) throw new Error(`Unexpected smoke-owner fixture question ${name}`);
    return choiceAnswer(question, label, 0.999);
  });
  log = new SqliteDecisionLog(':memory:'); previous = installJudgmentPort(withDecisionLog(readings.port, log));
});
afterEach(() => {
  installJudgmentPort(previous); log[Symbol.dispose]();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scene() {
  const root = makeProjectTempDir('native-smoke-owner'); roots.push(root);
  const store = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  const context = { platform: { configManager, artifactStore: store }, workspace: { shellPaths: { homeDirectory: root, workingDirectory: root } } } as unknown as CommandContext;
  let mode: PermissionMode = 'prompt', sequence = 0, beforeCreate: (() => void) | undefined;
  let retainedArgs: Record<string, unknown> | undefined, retainedOptions: Parameters<Tool['execute']>[1];
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory: root }),
    getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => root,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState()), registry = new ToolRegistry(manager);
  const tool: Tool = { definition: { name: 'agent_harness', description: 'Save captured redacted synthetic setup output.', sideEffects: ['state'],
    parameters: { type: 'object', properties: { mode: { type: 'string' }, setupItemId: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['mode'], additionalProperties: true } },
    async execute(args, options) {
      retainedArgs = args; retainedOptions = options;
      const evidence = resolveSetupSmokeNativeEvidence(args, options, context);
      await Promise.resolve(); beforeCreate?.(); evidence.assertCurrent();
      const descriptor = await evidence.createArtifact?.({ kind: 'document', text: evidence.fields.map(field => `${field.label}\n${field.value}`).join('\n'), metadata: { purpose: 'agent-setup-smoke-evidence' } });
      evidence.assertCurrent();
      return { success: true, output: JSON.stringify({ id: descriptor?.id, fields: evidence.fields }) };
    } };
  registry.register(tool, { inputProjection: { captureNativeReferences: createSetupSmokeReferenceCapture(context), async project(request) { return { status: 'projected', args: request.args }; } } });
  const prepare = (args: Record<string, unknown>, signal?: AbortSignal) => registry.prepareCall(`native-smoke-${++sequence}`, 'agent_harness', args, { signal });
  const run = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const call = await prepare(args, signal);
    const admission = await manager.admitAutonomous(call.callId, call.name, call.args, { signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      sourceOf: () => ({ goal: 'Save redacted synthetic user-run smoke output in an isolated local artifact', criteria: ['Keep raw credential values private and require the exact active ownership'] }) });
    expect(admission.result.approved).toBe(true);
    return registry.executePrepared(call, admission);
  };
  return { context, store, tool, registry, prepare, run, root, beforeCreate(callback: () => void) { beforeCreate = callback; },
    setMode(next: PermissionMode) { mode = next; }, retained: () => ({ args: retainedArgs!, options: retainedOptions }) };
}


describe('setup smoke evidence limits', () => {
  test('a field over the limit is saved with a marker saying how much was left out', async () => {
    const f = scene();
    const result = await f.run({ mode: 'run_setup_smoke', setupItemId: 'install-smoke', fields: { notes: `${'a'.repeat(9_000)}` } });
    expect(result.success).toBe(true);
    const saved = (JSON.parse(result.output!) as { fields: { id: string; value: string }[] }).fields.find(field => field.id === 'notes')!.value;
    expect(saved).toContain('[truncated:');
    expect(saved.length).toBeLessThanOrEqual(8_000);
  });

  test('a field under the limit is saved whole', async () => {
    const f = scene();
    const result = await f.run({ mode: 'run_setup_smoke', setupItemId: 'install-smoke', fields: { notes: 'short note' } });
    const saved = (JSON.parse(result.output!) as { fields: { id: string; value: string }[] }).fields.find(field => field.id === 'notes')!.value;
    expect(saved).toBe('short note');
  });

  test('fields naming no known evidence id are refused as invalid arguments, not as a hold by the host', async () => {
    const f = scene();
    await expect(f.run({ mode: 'run_setup_smoke', setupItemId: 'install-smoke', fields: { mystery: 'x' } })).rejects.toThrow('invalid');
  });
});
