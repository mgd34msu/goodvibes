import { createPreparedAgentRuntimeServices } from '../helpers/prepared-runtime-services.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { executeToolCalls } from '@goodvibes-jev/engine/platform/platform/core';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import { composeAgentPermissionManager } from '../../runtime/bootstrap-core.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

test.each(['safe-owner', 'safe-jev', 'yolo'] as const)('%s publishes a non-mode settings change with a successful actual receipt', async mode => {
  const root = makeProjectTempDir(`mode-settings-${mode}`);
  const workspace = join(root, 'workspace'), home = join(root, 'home'), configDir = join(home, '.goodvibes', 'agent');
  mkdirSync(workspace, { recursive: true }); mkdirSync(configDir, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir: home, configDir });
  config.set('permissions.mode', mode); config.set('display.theme', 'vaporwave');
  const previous = installJudgmentPort(undefined);
  const runtime = (await createPreparedAgentRuntimeServices({ modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
    configManager: config, workingDir: workspace, homeDirectory: home, getConversationTitle: () => 'Settings mode fixture' }));
  using log = new SqliteDecisionLog(':memory:');
  let prompts = 0;
  runtime.permissionPromptRef.requestPermission = async () => { prompts++; return { approved: false }; };
  const fake = fakePort((wireName, question) => {
    const name = wireName.includes('__') ? wireName.slice(wireName.indexOf('__') + 2) : wireName;
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria);
      const selected = ['none', 'generic', 'read', 'act'].find(label => labels.includes(label)) ?? labels[0];
      if (!selected) throw new Error('Fixture requires an offered choice');
      return choiceAnswer(question, selected, 0.999);
    }
    return noulAnswer(name === 'mutates' ? 0.999 : 0.001);
  });
  installJudgmentPort(withDecisionLog(fake.port, log));
  try {
    const registry = composeAgentToolRegistry({ services: runtime, configManager: config, homeDirectory: home,
      resolveSessionId: () => 'mode-settings', getLastUserMessage: () => 'Set the scratch theme to nord' }).toolRegistry;
    const manager = composeAgentPermissionManager(runtime);
    const [result] = await executeToolCalls({ toolRegistry: registry, permissionManager: manager,
      autonomousSource: () => ({ goal: 'Set the scratch theme to nord', criteria: ['Persist nord in the scratch settings file'] }),
      hookDispatcher: null, runtimeBus: null, sessionId: 'mode-settings',
      emitterContext: () => ({ sessionId: 'mode-settings', traceId: 'fixture', source: 'orchestrator' }),
    }, 'turn', [{ id: 'theme-write', name: 'goodvibes_settings', arguments: { mode: 'set', key: 'display.theme', value: 'nord' } }]);
    expect(result?.success, result?.error ?? result?.output).toBe(true);
    expect(JSON.parse(result?.output ?? '{}')).toMatchObject({ status: 'committed', current: 'nord' });
    expect(config.get('display.theme')).toBe('nord');
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8'))).toMatchObject({ display: { theme: 'nord' } });
    expect(prompts).toBe(0);
  } finally {
    await runtime.processManager.close(); await runtime.close(); installJudgmentPort(previous);
  }
});
