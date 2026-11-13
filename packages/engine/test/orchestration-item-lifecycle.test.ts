import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
/**
 * OrchestrationEngine: pipeline scheduling, dynamic phase
 * insertion, budget refusal, resume prefix replay, cancellation, and
 * primitive reuse (phantom guard + scoped commit).
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrationEngine, type OrchestrationEngineDeps } from '../platform/src/platform/orchestration/engine.js';
import { loadWorkstreamSnapshot } from '../platform/src/platform/orchestration/persistence.js';
import type { PhaseRunnerAgentManagerLike, WorktreeOps } from '../platform/src/platform/orchestration/phase-runner.js';
import type { OrchestrationEvent, PhaseSpec, WorkItemSpec } from '../platform/src/platform/orchestration/types.js';
import { emptyWorkItemUsage, mergeWorkItemUsage } from '../platform/src/platform/orchestration/types.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../platform/src/platform/runtime/event-envelope.js';
import type { AgentRecord } from '../platform/src/platform/tools/agent/manager.js';
import { AgentCapacityError } from '../platform/src/platform/tools/agent/capacity-error.js';

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    template: 'engineer',
    tools: [],
    status: 'running',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

function engineerReportOutput(
  summary: string,
  opts: { filesCreated?: string[]; filesModified?: string[] } = {},
): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'engineer',
      summary,
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [summary],
      filesCreated: opts.filesCreated ?? [],
      filesModified: opts.filesModified ?? [],
      filesDeleted: [],
      decisions: [],
      issues: [],
      uncertainties: [],
    }),
    '```',
  ].join('\n');
}

interface Harness {
  readonly bus: RuntimeEventBus;
  readonly agentManager: PhaseRunnerAgentManagerLike;
  readonly agentStore: Map<string, AgentRecord>;
  readonly spawnedTasks: string[];
  readonly cancelCalls: Array<{ id: string; kind: 'interrupt' | 'kill' }>;
  readonly registeredSignals: Map<string, AbortSignal>;
  readonly configManager: Pick<import('../platform/src/platform/config/manager.js').ConfigManager, 'get' | 'getCategory'>;
  readonly commitCalls: Array<{ message: string; paths?: string[] | undefined }>;
  readonly mergeCalls: string[];
  readonly cleanupCalls: string[];
  readonly projectRoot: string;
  readonly configOverrides: { gates: Array<{ name: string; command: string; enabled: boolean }>; commitScope: 'off' | 'scoped' | 'all' };
  makeEngine(depsOverrides?: Partial<OrchestrationEngineDeps>): ReturnType<typeof createOrchestrationEngine>;
  completeAgent(agentId: string, output: string): void;
  failAgent(agentId: string, error: string): void;
  cancelAgentEvent(agentId: string): void;
}

function makeHarness(projectRoot: string): Harness {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawnedTasks: string[] = [];
  const cancelCalls: Array<{ id: string; kind: 'interrupt' | 'kill' }> = [];
  const registeredSignals = new Map<string, AbortSignal>();
  const commitCalls: Array<{ message: string; paths?: string[] | undefined }> = [];
  const mergeCalls: string[] = [];
  const cleanupCalls: string[] = [];
  let counter = 0;

  const configOverrides = { gates: [] as Array<{ name: string; command: string; enabled: boolean }>, commitScope: 'scoped' as 'off' | 'scoped' | 'all' };

  // `get`/`getCategory` on the real ConfigManager are generic over `ConfigKey`
  // with a per-key conditional return type (`ConfigValue<K>` / `GoodVibesConfig[C]`,
  // a ~500-branch conditional). A by-string-key stub can't be typed against that
  // generic signature directly, TypeScript hits its own recursion limit
  // ("Excessive stack depth") comparing two such generic conditional signatures
  // structurally. Casting the whole mock once at the boundary (rather than
  // per-return-value) sidesteps that compiler limitation; ConfigManager's own
  // methods work around the same expressiveness gap internally with `as ConfigValue<K>`.
  const configManager = {
    get: (key: string): unknown => {
      if (key === 'contract.commitScope') return configOverrides.commitScope;
      return undefined;
    },
    getCategory: (category: string): unknown => {
      if (category === 'contract') {
        return {
          maxFixRounds: 5,
          autoCommit: true,
          transportRetryLimit: 1,
          transportRetryDelayMs: 1,
          commitScope: configOverrides.commitScope,
          gates: configOverrides.gates,
        };
      }
      return undefined;
    },
  } as unknown as Pick<import('../platform/src/platform/config/manager.js').ConfigManager, 'get' | 'getCategory'>;

  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn: (input) => {
      counter += 1;
      const id = `agent-${counter}`;
      const task = (input as { task: string }).task;
      spawnedTasks.push(task);
      const record = makeRecord({ id, task, template: (input as { template?: string }).template ?? 'engineer' });
      agentStore.set(id, record);
      return record;
    },
    getStatus: (id: string) => agentStore.get(id) ?? null,
    cancel: (id: string, kind: 'interrupt' | 'kill' = 'kill') => {
      cancelCalls.push({ id, kind });
      const record = agentStore.get(id);
      if (record) record.status = 'cancelled';
      return true;
    },
    registerCancellationSignal: (agentId, signal) => {
      registeredSignals.set(agentId, signal);
    },
    releaseCancellationSignal: (agentId) => {
      registeredSignals.delete(agentId);
    },
  };

  const createWorktree = (): WorktreeOps => ({
    merge: async (agentId) => {
      mergeCalls.push(agentId);
      return true;
    },
    cleanup: async (agentId) => {
      cleanupCalls.push(agentId);
    },
    commitWorkingTree: async (message, paths) => {
      commitCalls.push({ message, paths });
      return { hash: 'commit-hash', skippedIgnored: [] };
    },
    currentHead: async () => 'head-hash',
  });

  function makeEngine(depsOverrides: Partial<OrchestrationEngineDeps> = {}): ReturnType<typeof createOrchestrationEngine> {
    return createOrchestrationEngine({
      agentManager,
      configManager,
      runtimeBus: bus,
      projectRoot,
      createWorktree,
      persist: false,
      // Scheduling/budget/cancellation tests use bare fixture reports with no
      // real report-backed files in `projectRoot`; verifyEngineerClaims
      // would honestly flag those as phantom work (no claims, no git diff).
      // Tests that specifically exercise the phantom-work guard (the
      // "primitive reuse" describe block) override this back to false.
      skipClaimVerification: true,
      ...depsOverrides,
    });
  }

  function completeAgent(agentId: string, output: string): void {
    const record = agentStore.get(agentId)!;
    record.status = 'completed';
    record.fullOutput = output;
    record.usage = {
      inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1,
    };
    bus.emit('agents', createEventEnvelope(
      'AGENT_COMPLETED',
      { type: 'AGENT_COMPLETED', agentId, durationMs: 0 },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ));
  }

  function failAgent(agentId: string, error: string): void {
    const record = agentStore.get(agentId)!;
    record.status = 'failed';
    record.error = error;
    bus.emit('agents', createEventEnvelope(
      'AGENT_FAILED',
      { type: 'AGENT_FAILED', agentId, error, durationMs: 0 },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ));
  }

  function cancelAgentEvent(agentId: string): void {
    bus.emit('agents', createEventEnvelope(
      'AGENT_CANCELLED',
      { type: 'AGENT_CANCELLED', agentId, reason: 'operator cancellation' },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ));
  }

  return {
    bus, agentManager, agentStore, spawnedTasks, cancelCalls, registeredSignals, configManager,
    commitCalls, mergeCalls, cleanupCalls, projectRoot, configOverrides,
    makeEngine, completeAgent, failAgent, cancelAgentEvent,
  };
}

function enginePhase(): PhaseSpec {
  return { role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } };
}
/** A second pipeline phase: a read-only gate agent. */
function gatePhase(capacity = 1, gates: readonly string[] = []): PhaseSpec {
  return { role: 'general', capacity, kind: 'gate', gate: { scope: 'off', gates } };
}

let projectRoot: string;
let h: Harness;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'orch-engine-'));
  // Scheduling uses fake commits, but the launch-residue proof must still
  // come from an actual repository owned by this fixture.
  const initialized = Bun.spawnSync(['git', 'init', '-q'], { cwd: projectRoot });
  if (initialized.exitCode !== 0) throw new Error(new TextDecoder().decode(initialized.stderr));
  writeFileSync(join(projectRoot, '.gitignore'), '.goodvibes/\n');
  h = makeHarness(projectRoot);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});


describe('item lifecycle guards', () => {
  test('a run that throws after kill() cannot auto-retry the killed item back to pending', async () => {
    const engine = h.makeEngine({
      maxItemRetries: 2,
      agentManager: { ...h.agentManager, releaseCancellationSignal: () => { throw new Error('release blew up after kill'); } },
    });
    const events: OrchestrationEvent[] = [];
    engine.on(event => events.push(event));
    const ws = engine.createWorkstream({ title: 'ws', phases: [enginePhase()], items: [{ id: 'a', title: 'A', task: 'do A' }] });
    engine.start(ws.id);
    await flushMicrotasks();
    const item = ws.items[0]!;
    expect(item.state).toBe('in-phase');
    expect(engine.kill(item.id)).toBe(true);
    expect(item.state).toBe('failed');
    h.cancelAgentEvent(item.agentId!);
    await flushMicrotasks(80);
    expect(item.state).toBe('failed');
    expect(events.filter(event => event.type === 'item-retried')).toHaveLength(0);
    expect(item.retryCount ?? 0).toBe(0);
  });
});
