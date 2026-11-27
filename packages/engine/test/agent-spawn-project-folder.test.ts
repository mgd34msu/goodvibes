// Proves: An agent the model starts from a turn in a project works in another folder than that project, so it reads and writes where the owner never asked for work.
// Red when: The agent tool stops giving a spawn its turn's project as the agent's working folder, so the agent runs in the folder the process started in (the daemon's own folder for a daemon-run turn).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { AgentManager } from '../platform/src/platform/tools/agent/manager.js';
import { AgentMessageBus } from '../platform/src/platform/agents/message-bus.js';
import { createAgentTool } from '../platform/src/platform/tools/agent/index.js';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';

const roots: string[] = [];
// No decision model in use (Hybrid, none set up): whether the agents start is the gate's, which decided this call.
let retirePolicy: () => void;
beforeEach(() => { retirePolicy = configureDecisionModelPolicy(() => 'Hybrid', () => false); });
afterEach(() => { retirePolicy(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('an agent started from a turn in a project works in that project, each project its own', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-spawn-folder-')));
  roots.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const messageBus = new AgentMessageBus();
  // The real manager, with nothing to carry the agent out: what is proved is the folder the spawn is given.
  const manager = new AgentManager({ messageBus, configManager });
  const unused = (): never => { throw new Error('no contract is started in this proof'); };
  for (const name of ['alpha', 'beta']) {
    const project = join(root, 'projects', name);
    mkdirSync(project, { recursive: true });
    const tool = createAgentTool({ manager, messageBus, configManager, projectRoot: project,
      contractRunner: { start: unused, list: unused, get: unused }, resolveSessionId: () => `session-${name}` });
    const spawned = await tool.execute({ mode: 'spawn', task: `write the ${name} note`, outsideContract: true });
    expect(spawned.success).toBe(true);
    const record = manager.list().find((entry) => entry.sessionId === `session-${name}`);
    expect(record?.workingDirectory).toBe(project);
  }
});
