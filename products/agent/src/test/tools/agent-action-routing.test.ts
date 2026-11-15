import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { assertCurrentToolEffect, assertCurrentToolInvocation } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createShellPathService } from '@/runtime/index.ts';
import { ConfigManager } from '../../config/index.ts';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentScheduleTool } from '../../tools/agent-schedule-tool.ts';
import { createAgentRouteTool } from '../../tools/agent-route-tool.ts';
import { createAgentProcessTool } from '../../tools/agent-terminal-process-tools.ts';
import { createAgentSetupTool } from '../../tools/agent-setup-tool.ts';
import { createAgentSessionsTool } from '../../tools/agent-sessions-tool.ts';
import { createAgentSupportTool } from '../../tools/agent-support-tool.ts';
import { createAgentSecurityTool } from '../../tools/agent-security-tool.ts';
import { createAgentSettingsTool } from '../../tools/agent-settings-tool.ts';
import { createAgentWorkspaceTool } from '../../tools/agent-workspace-tool.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  const scripted = fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    if (question.type === 'noul') return noulAnswer(0.001);
    if (question.type !== 'choice') throw new Error('Unexpected synthetic routing question');
    const label = name === 'disposition' ? Object.hasOwn(question.criteria, 'act') ? 'act' : 'reject'
      : name === 'kind' ? 'read' : 'generic';
    return choiceAnswer(question, label, 0.999);
  });
  previous = installJudgmentPort(withDecisionLog(scripted.port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });

const CHILDREN = ['agent_operator_method', 'agent_operator_action', 'agent_autonomy_schedule', 'agent_reminder_schedule', 'agent_schedule_edit',
  'agent_harness', 'import_goodvibes_settings'] as const;

/** A facade tool registered in a real admitting registry, with recording stand-ins for every child it can call. */
function facadeFixture(facadeName: string, build: (registry: ReturnType<typeof recordedEffectFixture>['registry'], root: string) => Tool) {
  const root = makeProjectTempDir('action-routing');
  const placeholder: Tool = { definition: { name: facadeName, description: 'Replaced by the real facade.', parameters: {} }, execute: async () => ({ success: false }) };
  const admitted = recordedEffectFixture(placeholder, 'prompt', {}, root);
  const tool = build(admitted.registry, root);
  placeholder.definition = tool.definition; placeholder.execute = tool.execute;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  for (const name of CHILDREN) {
    admitted.registry.register({ definition: { name, description: 'Synthetic recording child.', parameters: { type: 'object', additionalProperties: true } },
      async execute(args, options) {
        if (!assertCurrentToolInvocation(args, options)) return { success: false };
        calls.push({ name, args });
        if (name !== 'agent_operator_method' && name !== 'agent_harness' && !assertCurrentToolEffect(args, options, 'write') && name !== 'import_goodvibes_settings') return { success: false };
        return { success: true, output: name };
      } });
  }
  return { ...admitted, tool, calls, name: tool.definition.name };
}

function scheduleFixture() {
  const f = facadeFixture('schedule', (registry, root) => {
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const config = new ConfigManager({ surfaceRoot: 'agent', configDir: paths.resolveUserPath('agent'), homeDir: root, workingDir: root });
    return createAgentScheduleTool(paths, config, registry);
  });
  // The registry knows the facade under its real name only after registration.
  return f;
}

describe('schedule routing', () => {
  test('a reminder text with a schedule id is refused, not created as a second reminder', async () => {
    const f = scheduleFixture();
    const result = await f.run({ scheduleId: 'r1', message: 'new text', every: '1d' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be edited');
    expect(result.error).toContain('r1');
    expect(f.calls).toHaveLength(0);
  });

  test('a new value with no kind reaches the edit tool, which refuses the half-given pair', async () => {
    const f = scheduleFixture();
    await f.run({ scheduleId: 's1', scheduleValue: '2h', name: 'x' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.name).toBe('agent_schedule_edit');
    expect(f.calls[0]!.args.scheduleValue).toBe('2h');
    expect(f.calls[0]!.args.scheduleKind).toBeUndefined();
  });

  test('an action word that is not a schedule action is refused and reaches no child', async () => {
    const f = scheduleFixture();
    await expect(f.run({ action: 'frobnicate', message: 'text', every: '1d' })).rejects.toThrow('do not match the registered schema at $.action');
    expect(f.calls).toHaveLength(0);
  });

  test('creating a reminder takes no schedule id', async () => {
    const f = scheduleFixture();
    const result = await f.run({ action: 'reminder', scheduleId: 'r1', message: 'text', every: '1d' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('takes no scheduleId');
    expect(f.calls).toHaveLength(0);
  });
});

describe('setup import', () => {
  function setupFixture() {
    return facadeFixture('setup', (registry) => createAgentSetupTool({ commandContext: {} as CommandContext, toolRegistry: registry }));
  }

  test('import and apply_import apply without confirm; import_settings only previews', async () => {
    for (const [action, expected] of [['import', 'apply'], ['apply_import', 'apply'], ['import_settings', 'preview']] as const) {
      const f = setupFixture();
      await f.run({ action });
      expect(f.calls.map((call) => call.args.action)).toEqual([expected]);
    }
  });

  test('following the preview hint on setup reaches an apply attempt', async () => {
    const f = setupFixture();
    await f.run({ action: 'import_settings' });
    await f.run({ action: 'import' });
    expect(f.calls.map((call) => call.args.action)).toEqual(['preview', 'apply']);
  });

  test('a mode word that is not a setup action is refused', async () => {
    const f = setupFixture();
    const result = await f.run({ mode: 'apply-everything' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown setup action "apply-everything"');
    expect(f.calls).toHaveLength(0);
  });
});

describe('an action word the tool does not know is refused rather than replaced by a default', () => {
  const harness: Tool = { definition: { name: 'agent_harness', description: 'unused', parameters: { type: 'object' } },
    execute: async () => { throw new Error('the harness must not be reached for an unknown action'); } };
  const deps = { commandRegistry: {} as CommandRegistry, commandContext: {} as CommandContext, toolRegistry: {} as never, harnessTool: harness };

  test.each([
    ['sessions', () => createAgentSessionsTool(deps), { action: 'remove', sessionId: 's1' }, 'list, search, status, get'],
    ['support', () => createAgentSupportTool(deps), { mode: 'zzz' }, 'status, bundle'],
    ['security', () => createAgentSecurityTool(deps), { mode: 'zzz' }, 'status, finding, explain'],
  ] as const)('%s', async (_name, make, args, valid) => {
    const result = await make().execute({ ...args });
    expect(result.success).toBe(false);
    expect(result.error).toContain(valid);
  });

  test('route refuses an unknown action word instead of planning the query', async () => {
    const result = await createAgentRouteTool({} as CommandContext).execute({ action: 'frobnicate', query: 'fix the failing tests' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown route action "frobnicate"');
    expect(result.error).toContain('plan, status');
  });

  test('process refuses an unknown action word', async () => {
    const result = await createAgentProcessTool({} as CommandContext).execute({ action: 'frobnicate' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown process action "frobnicate"');
  });

  test('settings names the valid actions, including the preview spelling', async () => {
    const tool = createAgentSettingsTool({ ...deps, harnessTool: harness, settingsImportTool: harness });
    const result = await tool.execute({ action: 'remove', key: 'display.theme' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('preview_import');
    const actionEnum = (tool.definition.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(actionEnum).toContain('preview_import');
  });

  test('workspace refuses a misspelled run instead of inspecting', async () => {
    const tool = createAgentWorkspaceTool({ ...deps, harnessTool: harness });
    const result = await tool.execute({ action: 'runn', actionId: 'onboarding-apply-close', confirm: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown workspace action "runn"');
    expect(result.error).toContain('run_keybinding');
  });

  test('no workspace parameter says confirm authorizes anything', () => {
    const tool = createAgentWorkspaceTool({ ...deps, harnessTool: harness });
    const text = JSON.stringify(tool.definition.parameters);
    expect(text).not.toContain('Required true');
    expect(text).not.toContain('authorizing');
  });
});
