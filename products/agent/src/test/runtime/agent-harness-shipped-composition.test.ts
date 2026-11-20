// Proves: The Agent's own tool registry, composed as the shipped Agent composes it, runs a model call. tool-call-end-to-end.test.ts proves the engine tools on the terminal composition; this is the only proof for the Agent's registry.
// Red when: ComposeAgentToolRegistry, registerAgentTools, autonomous admission or executePrepared stop an agent_harness call from running.
import { createPreparedAgentRuntimeServices } from '../helpers/prepared-runtime-services.ts';
import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import { registerAgentTools } from '../../runtime/bootstrap-agent-tools.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createEmitterContext, executeToolCalls } from '@goodvibes-jev/engine/platform/platform/core';

// The Agent's registry built the way bootstrap-core.ts and bootstrap.ts build
// it, with the local first-party read owner the shipped Agent binds, and a call
// run through the executor and the graph's own permission manager as the
// Agent's turn runs it (autonomous admission, then executePrepared).
test('a model call of agent_harness runs and answers on the registry the shipped Agent composes', async () => {
  const root = makeProjectTempDir('agent-harness-shipped-composition');
  const workspace = join(root, 'workspace');
  const homeDir = join(root, 'home');
  const configDir = join(homeDir, '.goodvibes', 'agent');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir, configDir });
  const services = await createPreparedAgentRuntimeServices({ modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), configManager, workingDir: workspace, homeDirectory: homeDir });
  // A decision model that is present and answers at once, so only the composition is under test.
  services.judgment.port.ask = fakePort((_name, question) => question.type === 'choice'
    ? choiceAnswer(question, Object.keys(question.criteria)[0]!, 0.99)
    : noulAnswer(0.01)).port.ask;
  const { toolRegistry, dispose } = composeAgentToolRegistry({
    services, configManager, homeDirectory: homeDir,
    resolveSessionId: () => 'shipped-composition',
    researchReportSourceOwner: services.researchReportSourceOwner,
    researchSourceOwner: services.localReadSourceOwner,
  });
  try {
    // The shell's command context is only read for the fields below during registration and a summary read.
    const commandContext = {
      workspace: { shellPaths: services.shellPaths },
      provider: { providerRegistry: services.providerRegistry },
      platform: { config: configManager.getAll(), configManager },
      session: { runtime: { sessionId: 'shipped-composition' } },
      extensions: {}, ops: {},
    } as unknown as CommandContext;
    registerAgentTools({ toolRegistry, commandRegistry: new CommandRegistry(), commandContext, configManager, services, getSessionId: () => 'shipped-composition' });
    await services.permissionManager.prepareAutonomousOwner();
    const run = (id: string) => executeToolCalls({
      autonomousSource: () => ({ goal: 'What can you do?', criteria: [] }),
      toolRegistry, permissionManager: services.permissionManager, hookDispatcher: services.hookDispatcher, runtimeBus: services.runtimeBus,
      sessionId: 'shipped-composition', emitterContext: (turn) => createEmitterContext('shipped-composition', turn), workingDirectory: workspace,
    }, id, [{ id, name: 'agent_harness', arguments: { mode: 'summary' } }]);
    // The model saw agent_harness as one line; a call whose arguments fit its full schema runs at once.
    const [result] = await run('first-call');
    expect(result?.success, String(result?.error ?? '')).toBe(true);
  } finally {
    try { await dispose(); } finally { await services.close(); }
  }
});
