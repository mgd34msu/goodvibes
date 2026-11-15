import { PERSONAL_OPS_LIVE_READ_TEMPLATE } from '../../tools/agent-harness-personal-ops-records.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { createAgentTool } from '@goodvibes-jev/engine/platform/platform/tools';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { AGENT_TEMPLATES, AGENT_TOOL_MODES } from '../../tools/agent-harness-agent-orchestration-policy.ts';
import { AGENT_READ_ONLY_TOOL_MODES } from '../../tools/agent-tool-policy-guard.ts';
import { wrapAgentContextToolForAgentPolicy } from '../../tools/agent-context-policy.ts';
import { runBackgroundProcessAction } from '../../tools/agent-harness-background-processes.ts';
import { clampTimeout, clampWaitTimeout, MAX_WAIT_TIMEOUT_MS } from '../../tools/agent-harness-process-timeout-policy.ts';
import { autonomyQueueCatalogStatus } from '../../tools/agent-harness-autonomy-queue.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createHarnessFixtureReadings, makeFixture } from './agent-harness-tool-fixture.ts';

type JsonRecord = Record<string, unknown>;

async function schemaProperty(name: string): Promise<{ readonly enum?: readonly string[] }> {
  resetTestRuntimeServices();
  const services = await getTestRuntimeServices();
  const tool = createAgentTool({
    manager: services.agentManager, messageBus: services.agentMessageBus, configManager: services.configManager,
    contractRunner: services.contractRunner, projectRoot: services.workingDirectory, resolveSessionId: () => 'agent-schema-test',
  });
  const properties = (tool.definition.parameters as { readonly properties: Record<string, { readonly enum?: readonly string[] }> }).properties;
  return properties[name]!;
}

describe('orchestration lists follow the real agent tool', () => {
  test('advertised modes are exactly the modes the agent tool accepts', async () => {
    expect([...(await schemaProperty('mode')).enum!].sort()).toEqual([...AGENT_TOOL_MODES].sort());
    expect([...AGENT_TOOL_MODES].sort()).toEqual([...AGENT_READ_ONLY_TOOL_MODES].sort());
  });

  test('advertised templates are exactly the templates the agent tool accepts', async () => {
    expect([...AGENT_TEMPLATES].sort()).toEqual([...(await schemaProperty('template')).enum!].sort());
  });
});

describe('capabilities contract teaches only what the tools accept', () => {
  async function contractText(): Promise<string> {
    const tool: Tool = { definition: { name: 'goodvibes_context', description: '', parameters: { type: 'object', properties: {} } }, execute: async () => ({ success: true, output: '' }) };
    wrapAgentContextToolForAgentPolicy(tool);
    const result = await tool.execute({ mode: 'capabilities' });
    expect(result.success).toBe(true);
    return result.output ?? '';
  }

  test('never tells the model to pass a client secret to google', async () => {
    const text = await contractText();
    expect(text).not.toContain('with both');
    expect(text).toContain('Never take a client secret as a tool argument');
  });

  test('does not present confirm:true as authority for a settings write or import', async () => {
    const payload = JSON.parse(await contractText()) as { readonly commonRoutes: JsonRecord; readonly currentContract: JsonRecord };
    for (const key of ['settings', 'settingsImport', 'setSetting']) {
      expect(String(payload.commonRoutes[key])).not.toContain('confirm:true');
    }
    expect(String(payload.currentContract.confirmations)).toContain('are context, not authority');
  });

  test('teaches the live personal_ops read as the route the tool accepts, without confirm arguments', async () => {
    const payload = JSON.parse(await contractText()) as { readonly commonRoutes: JsonRecord };
    const route = String(payload.commonRoutes.personalOps);
    expect(route).toContain(PERSONAL_OPS_LIVE_READ_TEMPLATE);
    expect(route).not.toContain('confirm:true');
    expect(route).not.toContain('explicitUserRequest:');
  });
});

describe('process wait timeouts', () => {
  test('a wait of 0 is a single look; a start of 0 stays unbounded', () => {
    expect(clampWaitTimeout(0, 30_000)).toEqual({ timeoutMs: 0, capped: false });
    expect(clampTimeout(0, 0)).toBe(0);
  });

  test('a wait longer than one turn should block is capped and says so', () => {
    expect(clampWaitTimeout(MAX_WAIT_TIMEOUT_MS * 10, 30_000)).toEqual({ timeoutMs: MAX_WAIT_TIMEOUT_MS, capped: true });
  });

  test('a negative timeout is refused with its own message', () => {
    expect(() => clampTimeout(-1, 0)).toThrow('timeoutMs must be 0 or greater');
  });

  function processContext(statusOf: () => { done: boolean; exitCode: number | null }) {
    const entry = () => ({ id: 'bg_1', pid: 4242, cmd: 'sleep 600', startTime: 1_000, stdout: [], stderr: [], killDeadline: null, ...statusOf() });
    const manager = {
      list: () => [entry()],
      getStatus: (id: string) => id === 'bg_1' ? entry() : undefined,
      getOutput: () => ({ stdout: '', stderr: '' }),
    };
    return { workspace: { processManager: manager, shellPaths: undefined }, session: undefined } as unknown as CommandContext;
  }

  test('wait with timeoutMs 0 on a running process returns still_running at once', async () => {
    const context = processContext(() => ({ done: false, exitCode: null }));
    const result = await runBackgroundProcessAction(context, { processAction: 'wait', processId: 'bg_1', timeoutMs: 0 });
    expect(result.status).toBe('still_running');
    expect(String(result.policy)).toContain('timeoutMs 0 returns the current status');
  });

  test('a process that finishes while its status is being described still produces an answer', async () => {
    let reads = 0;
    const context = processContext(() => ({ done: ++reads > 2, exitCode: reads > 2 ? 0 : null }));
    const result = await runBackgroundProcessAction(context, { processAction: 'wait', processId: 'bg_1', timeoutMs: 0 });
    expect(['still_running', 'completed']).toContain(String(result.status));
    expect(reads).toBeGreaterThan(2);
  });
});

describe('autonomy queue reports supervised work', () => {
  test('a running agent is counted and cancellable, not reported as an empty ready row', async () => {
    const fixture = makeFixture();
    try {
      const idle = autonomyQueueCatalogStatus(fixture.context) as { readonly active: number; readonly cancellable: number };
      Object.defineProperty(fixture.context.ops, 'agentManager', { value: { exportState: () => [{ status: 'running' }, { status: 'completed' }] }, configurable: true });
      const busy = autonomyQueueCatalogStatus(fixture.context) as { readonly active: number; readonly cancellable: number };
      expect(busy.active - idle.active).toBe(1);
      expect(busy.cancellable - idle.cancellable).toBe(1);
    } finally { await fixture.cleanup(); }
  });

  test('a tracked background process that is still running is counted', async () => {
    const fixture = makeFixture();
    try {
      const idle = autonomyQueueCatalogStatus(fixture.context) as { readonly active: number; readonly cancellable: number };
      Object.defineProperty(fixture.context.workspace.processManager!, 'list', { value: () => [{ done: false }, { done: true }], configurable: true });
      const busy = autonomyQueueCatalogStatus(fixture.context) as { readonly active: number; readonly cancellable: number };
      expect(busy.active - idle.active).toBe(1);
      expect(busy.cancellable - idle.cancellable).toBe(1);
    } finally { await fixture.cleanup(); }
  });
});

describe('the context tool forwards through the harness invocation guard', () => {
  let previousPort: JudgmentPort | undefined;
  let log: SqliteDecisionLog;
  beforeEach(() => {
    log = new SqliteDecisionLog(':memory:');
    previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), log));
  });
  afterEach(() => { installJudgmentPort(previousPort); log[Symbol.dispose](); });

  test('a tools query answered through the admitted registry path succeeds', async () => {
    const fixture = makeFixture();
    try {
      const context: Tool = { definition: { name: 'goodvibes_context', description: '', parameters: { type: 'object', properties: {} } }, execute: async () => ({ success: true, output: '' }) };
      wrapAgentContextToolForAgentPolicy(context, fixture.toolRegistry);
      fixture.toolRegistry.register(context);
      const result = await fixture.executeAdmittedCall('call-context-tools', 'goodvibes_context', { mode: 'tools' });
      expect(result.success).toBe(true);
      expect(JSON.parse(result.output ?? '{}').source).toBe('agent_harness');
    } finally { await fixture.cleanup(); }
  });
});
