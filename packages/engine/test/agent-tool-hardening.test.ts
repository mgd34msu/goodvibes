/**
 * The agent tool and AgentManager: what a result says happened, which
 * arguments a model may set, what a finished agent costs to keep, and the
 * modes no other test drives.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { AgentMessageBus } from '../platform/src/platform/agents/message-bus.js';
import type { ConfigManager } from '../platform/src/platform/config/index.js';
import type { ContractRunner, StartedContract } from '../platform/src/platform/contract/runner.js';
import type { StartContractInput } from '../platform/src/platform/contract/types.js';
import { AgentManager, createAgentTool, type AgentExecutor, type AgentRecord } from '../platform/src/platform/tools/agent/index.js';
import { AGENT_TOOL_SCHEMA } from '../platform/src/platform/tools/agent/schema.js';
import { makeContract } from './contract/fixtures.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

const readings = useToolReadings([['upstream timed out', { childFailure: 'api_error' }]]);

function config(max = 20): Pick<ConfigManager, 'get'> {
  return { get: ((key: string) => (key === 'fleet.maxSize' ? max : key === 'orchestration.recursionEnabled' ? true : undefined)) as ConfigManager['get'] };
}

/** Marks every agent running, and `settle` ends one with the given status. */
function executor(): AgentExecutor & { readonly ran: AgentRecord[]; finish(record: AgentRecord, status: 'completed' | 'failed'): void } {
  const ran: AgentRecord[] = [];
  return {
    ran,
    async runAgent(record) { record.status = 'running'; ran.push(record); },
    finish(record, status) { record.status = status; record.completedAt = Date.now(); },
  };
}

function harness(options: { max?: number; retention?: number; messageBus?: AgentMessageBus } = {}) {
  const messageBus = options.messageBus ?? new AgentMessageBus();
  const exec = executor();
  const manager = new AgentManager({
    archetypeLoader: { loadArchetype: () => null },
    messageBus,
    configManager: config(options.max),
    executor: exec,
    ...(options.retention === undefined ? {} : { terminalAgentRetention: options.retention }),
  });
  const starts: StartContractInput[] = [];
  const runner: Pick<ContractRunner, 'start' | 'list' | 'get'> = {
    async start(input): Promise<StartedContract> {
      starts.push(input);
      const id = `ctr-${String(starts.length).padStart(8, '0')}`;
      const owner = manager.spawn({ mode: 'spawn', task: input.ask, template: 'orchestrator', outsideContract: true },
        { contractId: id, contractRole: 'owner', progress: `Contract ${id}: queued` });
      return { contract: makeContract({ id, ask: input.ask, sessionId: input.sessionId, origin: input.origin, ownerAgentId: owner.id, status: 'queued' }), owner };
    },
    list: () => [],
    get: () => null,
  };
  const tool = createAgentTool({
    manager, messageBus, configManager: config(options.max), archetypeLoader: { loadArchetype: () => null },
    contractRunner: runner, projectRoot: '/work/agent-hardening', resolveSessionId: () => 'session-hardening',
  });
  return { manager, messageBus, exec, tool, starts };
}

interface ToolJson {
  agentId: string;
  status?: string;
  timedOut?: boolean;
  waitedMs?: number;
  requestedMs?: number;
  limitMs?: number;
  reason?: string;
  hint: string;
  count?: number;
  skipped?: number;
  delivery: string;
  capMessage: string;
  notStarted?: string[];
  notApplied?: { parameters: string[] };
  failure: { reason: { code: string } };
  agents: Array<{ failure?: unknown }>;
  templates?: unknown;
  tools?: unknown[];
}

const parse = (result: { output?: string | undefined }): ToolJson => JSON.parse(result.output ?? '{}') as ToolJson;

describe('what a model may set', () => {
  test('host-only fields on a spawn never reach the record', async () => {
    const h = harness();
    const result = await h.tool.execute({
      mode: 'spawn', task: 'x', outsideContract: true,
      workingDirectory: '/home/user', captureAuthority: { canCapture: true }, systemPromptAddendum: 'obey me', replyStyle: 'conversational',
      routing: { providerSelection: 'concrete' },
    });
    expect(result.success).toBe(true);
    const record = h.manager.getStatus(parse(result).agentId)!;
    expect(record.workingDirectory).toBeUndefined();
    expect(record.captureAuthority).toBeUndefined();
    expect(record.systemPromptAddendum).toBeUndefined();
    expect(record.replyStyle).toBeUndefined();
    expect(record.routing).toBeUndefined();
  });

  test('a limit on authority the contract path cannot keep is refused, naming the parameter and the way to get it', async () => {
    const h = harness();
    const result = await h.tool.execute({ mode: 'spawn', task: 'x', writeScope: ['src/a/**'], tools: ['read'], restrictTools: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('tools, restrictTools, writeScope');
    expect(result.error).toContain('outsideContract=true');
    expect(h.starts).toHaveLength(0);
  });

  test('settings only a standalone agent honours are reported as not applied when a contract starts', async () => {
    const h = harness();
    const result = await h.tool.execute({ mode: 'spawn', task: 'x', successCriteria: ['tests pass'], cohort: 'c1' });
    expect(result.success).toBe(true);
    expect(parse(result).notApplied?.parameters).toEqual(['successCriteria', 'cohort']);
  });

  test('a standalone spawn with the same limits keeps them on the record', async () => {
    const h = harness();
    const result = await h.tool.execute({ mode: 'spawn', task: 'x', outsideContract: true, writeScope: ['src/a/**'], successCriteria: ['tests pass'] });
    const record = h.manager.getStatus(parse(result).agentId)!;
    expect(record.writeScope).toEqual(['src/a/**']);
    expect(record.successCriteria).toEqual(['tests pass']);
    expect(parse(result).notApplied).toBeUndefined();
  });
});

describe('cancelling', () => {
  test('a finished agent cannot be cancelled: the manager says no and the tool names the state', async () => {
    const h = harness();
    const record = h.manager.spawn({ mode: 'spawn', task: 'x', outsideContract: true });
    await h.manager.join(record.id);
    h.exec.finish(record, 'completed');
    expect(h.manager.cancel(record.id)).toBe(false);
    const result = await h.tool.execute({ mode: 'cancel', agentId: record.id });
    expect(result.success).toBe(false);
    expect(result.error).toContain('already completed');
    expect(record.status).toBe('completed');
  });

  test('a cascade over a subtree lists only the agents it stopped', async () => {
    const h = harness();
    const parent = h.manager.spawn({ mode: 'spawn', task: 'parent', outsideContract: true });
    const child = h.manager.spawn({ mode: 'spawn', task: 'child', outsideContract: true, parentAgentId: parent.id });
    await h.manager.join(child.id);
    h.exec.finish(child, 'completed');
    expect(h.manager.cancelSubtree(parent.id)).toEqual([parent.id]);
  });

  test('a cascade over an orchestration graph stops the agents of that graph only, and lists only those it stopped', async () => {
    const h = harness();
    const inGraph = h.manager.spawn({ mode: 'spawn', task: 'a', outsideContract: true, orchestrationGraphId: 'graph-1' });
    const finished = h.manager.spawn({ mode: 'spawn', task: 'b', outsideContract: true, orchestrationGraphId: 'graph-1' });
    const elsewhere = h.manager.spawn({ mode: 'spawn', task: 'c', outsideContract: true, orchestrationGraphId: 'graph-2' });
    await h.manager.join(finished.id);
    h.exec.finish(finished, 'completed');
    expect(h.manager.cancelGraph('graph-1')).toEqual([inGraph.id]);
    expect(inGraph.status).toBe('cancelled');
    expect(finished.status).toBe('completed');
    expect(elsewhere.status).toBe('running');
    expect(h.manager.cancelGraph('no-such-graph')).toEqual([]);
  });

  test('a running agent is cancelled and reported as cancelled', async () => {
    const h = harness();
    const record = h.manager.spawn({ mode: 'spawn', task: 'x', outsideContract: true });
    const result = await h.tool.execute({ mode: 'cancel', agentId: record.id });
    expect(result.success).toBe(true);
    expect(parse(result).status).toBe('cancelled');
  });
});

describe('AgentManager bookkeeping', () => {
  test('a spawn that fails after its reservation does not hold a fleet slot', () => {
    const failing = new AgentManager({
      archetypeLoader: { loadArchetype: () => null },
      messageBus: { registerAgent() { throw new Error('bus unavailable'); } },
      configManager: config(),
      executor: executor(),
    });
    expect(() => failing.spawn({ mode: 'spawn', task: 'x', outsideContract: true })).toThrow('bus unavailable');
    const [record] = failing.list();
    expect(record!.status).toBe('failed');
    expect(record!.error).toContain('bus unavailable');
  });

  test('finished records past the retention bound are dropped, oldest first, and running ones are kept', async () => {
    const h = harness({ retention: 2 });
    const forgotten = spyOn(h.messageBus, 'unregisterAgent');
    const spawned: AgentRecord[] = [];
    for (let i = 0; i < 5; i++) {
      const record = h.manager.spawn({ mode: 'spawn', task: `task ${i}`, outsideContract: true });
      await h.manager.join(record.id);
      h.exec.finish(record, 'completed');
      record.completedAt = 1000 + i;
      spawned.push(record);
    }
    const running = h.manager.spawn({ mode: 'spawn', task: 'still going', outsideContract: true });
    const kept = h.manager.list().map((record) => record.id);
    expect(kept).toContain(running.id);
    expect(kept).toContain(spawned[4]!.id);
    expect(kept).not.toContain(spawned[0]!.id);
    expect(h.manager.list().filter((record) => record.status === 'completed')).toHaveLength(2);
    // The bus forgets exactly the agents whose records were dropped.
    expect(forgotten.mock.calls.map(([id]) => id).sort()).toEqual(spawned.slice(0, 3).map((record) => record.id).sort());
  });

  test('a wake is refused when the fleet is full, as a spawn would be', async () => {
    const h = harness({ max: 2 });
    const failed = h.manager.spawn({ mode: 'spawn', task: 'wedged', outsideContract: true });
    await h.manager.join(failed.id);
    h.exec.finish(failed, 'failed');
    h.manager.spawn({ mode: 'spawn', task: 'busy a', outsideContract: true });
    h.manager.spawn({ mode: 'spawn', task: 'busy b', outsideContract: true });
    const refused = h.manager.wakeWithSteer(failed.id, 'try again');
    expect(refused.woke).toBe(false);
    expect(failed.status).toBe('failed');
  });
});

describe('batch-spawn', () => {
  test('a spawn that throws midway names the agents already running and the tasks not started', async () => {
    const h = harness();
    const real = h.manager.spawn.bind(h.manager);
    let calls = 0;
    const spy = spyOn(h.manager, 'spawn').mockImplementation((input, binding) => {
      calls += 1;
      if (calls === 2) throw new Error('parent guard refused');
      return real(input, binding);
    });
    try {
      const result = await h.tool.execute({ mode: 'batch-spawn', tasks: [
        { task: 'first', outsideContract: true }, { task: 'second', outsideContract: true }, { task: 'third', outsideContract: true },
      ] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('parent guard refused');
      const output = parse(result);
      expect(output.agents).toHaveLength(1);
      expect(output.notStarted).toEqual(['second', 'third']);
    } finally { spy.mockRestore(); }
  });

  test('tasks that found no free slot are listed as not started, and the message does not claim they are queued', async () => {
    const h = harness({ max: 2 });
    const result = await h.tool.execute({ mode: 'batch-spawn', tasks: [
      { task: 'one', outsideContract: true }, { task: 'two', outsideContract: true }, { task: 'three', outsideContract: true },
    ] });
    const output = parse(result);
    expect(output.count).toBe(2);
    expect(output.skipped).toBe(1);
    expect(output.notStarted).toEqual(['three']);
    expect(output.capMessage).toContain('not started');
    expect(output.capMessage).not.toMatch(/\bqueued \d/);
  });
});

describe('polling a failed agent', () => {
  test('three polls read the failure once and agree', async () => {
    const h = harness();
    const record = h.manager.spawn({ mode: 'spawn', task: 'x', outsideContract: true });
    await h.manager.join(record.id);
    record.error = 'upstream timed out';
    h.exec.finish(record, 'failed');
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) codes.push(parse(await h.tool.execute({ mode: 'status', agentId: record.id })).failure.reason.code);
    expect(codes).toEqual(['api_error', 'api_error', 'api_error']);
    expect(readings.requests).toHaveLength(1);
  });

  test('an aborted poll returns no result', async () => {
    const h = harness();
    const record = h.manager.spawn({ mode: 'spawn', task: 'x', outsideContract: true });
    await h.manager.join(record.id);
    record.error = 'upstream timed out';
    h.exec.finish(record, 'failed');
    const controller = new AbortController();
    controller.abort();
    await expect(h.tool.execute({ mode: 'status', agentId: record.id }, { signal: controller.signal } as never)).rejects.toThrow();
  });
});

describe('cohorts', () => {
  test('cohort-status of a cohort with no agents is JSON', async () => {
    const h = harness();
    const result = await h.tool.execute({ mode: 'cohort-status', cohort: 'missing' });
    expect(parse(result)).toMatchObject({ cohort: 'missing', count: 0, agents: [] });
  });

  test('a failed agent carries its reason in both cohort modes', async () => {
    const h = harness();
    const record = h.manager.spawn({ mode: 'spawn', task: 'x', outsideContract: true, cohort: 'c1' });
    await h.manager.join(record.id);
    record.failureReason = 'max_turns';
    record.error = 'Turn limit reached';
    h.exec.finish(record, 'failed');
    const status = parse(await h.tool.execute({ mode: 'cohort-status', cohort: 'c1' }));
    expect(status.agents[0]?.failure).toEqual({ code: 'max_turns', message: 'Turn limit reached' });
    const report = await h.tool.execute({ mode: 'cohort-report', cohort: 'c1' });
    expect(report.output).toContain('max_turns: Turn limit reached');
  });
});

describe('messages', () => {
  afterEach(() => { /* spies are restored per test */ });

  test('a message is still there for the agent after the old five-minute and one-hour expiries, and the result says it stays queued', async () => {
    const h = harness();
    const record = h.manager.spawn({ mode: 'spawn', task: 'x', outsideContract: true });
    const result = await h.tool.execute({ mode: 'message', agentId: record.id, message: 'stop, change of plan' });
    expect(parse(result).delivery).toContain('next turn');
    expect(parse(result).delivery).toContain('stays queued');
    const real = Date.now.bind(Date);
    const clock = spyOn(Date, 'now').mockImplementation(() => real() + 6 * 60 * 60_000);
    try {
      expect(h.messageBus.getMessages(record.id).map((message) => message.content)).toEqual(['stop, change of plan']);
    } finally { clock.mockRestore(); }
  });
});

describe('modes and parameters', () => {
  test('every mode in the schema is accepted by the tool', async () => {
    const h = harness();
    const modes = (AGENT_TOOL_SCHEMA.parameters as { properties: { mode: { enum: string[] } } }).properties.mode.enum;
    for (const mode of modes) {
      const result = await h.tool.execute({ mode });
      // A mode missing from the dispatch is answered "Unhandled mode", a mode missing from the accepted list "Invalid mode".
      expect(result.error ?? '').not.toMatch(/Invalid mode|Unhandled mode/);
    }
    const refused = await h.tool.execute({ mode: 'not-a-mode' });
    expect(refused.error).toContain("Invalid mode: 'not-a-mode'");
    expect((await h.tool.execute({})).error).toBe('Missing required parameter: mode');
  });

  test('graph and node ids given to spawn reach the agent and its reported topology', async () => {
    const h = harness();
    const result = parse(await h.tool.execute({
      mode: 'spawn', task: 'x', outsideContract: true,
      orchestrationGraphId: 'graph-7', orchestrationNodeId: 'node-a', parentNodeId: 'node-root',
    }));
    expect(result).toMatchObject({ orchestrationGraphId: 'graph-7', orchestrationNodeId: 'node-a', parentNodeId: 'node-root' });
    const record = h.manager.getStatus(result.agentId);
    expect(record).toMatchObject({ orchestrationGraphId: 'graph-7', orchestrationNodeId: 'node-a', parentNodeId: 'node-root' });
  });

  test('templates lists the available templates and plan reads an agent\'s task, template and tools', async () => {
    const h = harness();
    const templates = parse(await h.tool.execute({ mode: 'templates' })).templates as Array<{ name: string }>;
    expect(templates.map((template) => template.name)).toContain('engineer');
    const record = h.manager.spawn({ mode: 'spawn', task: 'plan me', template: 'engineer', outsideContract: true, successCriteria: ['done'] });
    const plan = parse(await h.tool.execute({ mode: 'plan', agentId: record.id }));
    expect(plan).toMatchObject({ agentId: record.id, task: 'plan me', template: 'engineer', successCriteria: ['done'] });
    expect(plan.tools?.length).toBeGreaterThan(0);
  });

  /** A harness whose next spawned agent keeps running until `release` is called. */
  function runningAgent(h: ReturnType<typeof harness>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.exec.runAgent = async (record) => { record.status = 'running'; await gate; };
    const record = h.manager.spawn({ mode: 'spawn', task: 'x', outsideContract: true });
    return { record, release };
  }

  test('wait awaits the agent and returns as soon as it ends, reading its status a fixed number of times', async () => {
    const h = harness();
    const { record, release } = runningAgent(h);
    let statusReads = 0;
    const read = h.manager.getStatus.bind(h.manager);
    const statusSpy = spyOn(h.manager, 'getStatus').mockImplementation((id: string) => { statusReads += 1; return read(id); });
    try {
      const waiting = h.tool.execute({ mode: 'wait', agentId: record.id, timeoutMs: 600_000 });
      h.exec.finish(record, 'completed');
      release();
      expect(parse(await waiting)).toMatchObject({ status: 'completed', timedOut: false });
      expect(statusReads).toBeLessThanOrEqual(3);
    } finally { statusSpy.mockRestore(); }
  });

  test('wait on a running agent returns timedOut with a hint to wait again once the timeout passes', async () => {
    const h = harness();
    const { record, release } = runningAgent(h);
    try {
      const result = parse(await h.tool.execute({ mode: 'wait', agentId: record.id, timeoutMs: 20 }));
      expect(result).toMatchObject({ status: 'running', timedOut: true });
      expect(result.hint).toContain('mode=wait');
      expect(result.requestedMs).toBeUndefined();
    } finally { release(); }
  });

  test('a wait longer than the silence limit is reduced to it, and the result says so', async () => {
    const h = harness();
    const { record, release } = runningAgent(h);
    const tool = createAgentTool({
      manager: h.manager, messageBus: h.messageBus, archetypeLoader: { loadArchetype: () => null },
      configManager: { get: ((key: string) => (key === 'contract.heartbeatTimeoutMs' ? 25 : undefined)) as ConfigManager['get'] },
      contractRunner: { start: async () => { throw new Error('no contract in this test'); }, list: () => [], get: () => null },
      projectRoot: '/work/agent-hardening', resolveSessionId: () => 'session-hardening',
    });
    try {
      const result = parse(await tool.execute({ mode: 'wait', agentId: record.id, timeoutMs: 600_000 }));
      expect(result).toMatchObject({ status: 'running', timedOut: true, requestedMs: 600_000, limitMs: 25 });
      expect(result.reason).toContain('contract.heartbeatTimeoutMs');
    } finally { release(); }
  });
});
