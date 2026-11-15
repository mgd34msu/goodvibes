import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { captureAutonomyLiveRecords } from '../../tools/agent-harness-autonomy-live-records.ts';
import { describeItem, shownOf } from '../../tools/agent-harness-autonomy-queue.ts';
import type { AutonomyQueueItem, AutonomyQueueLiveRecord } from '../../tools/agent-harness-autonomy-queue-types.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createStaticUiReadModel } from '../helpers/ui-read-models.ts';
import { createHarnessFixtureReadings } from './agent-harness-tool-fixture.ts';

const NOW = 1_700_000_100_000;
const TOTAL = 25;
const LIMIT = 20;

let previousPort: JudgmentPort | undefined;
let log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), log));
});
afterEach(() => { installJudgmentPort(previousPort); log[Symbol.dispose](); });

const range = <T>(build: (index: number) => T): readonly T[] => Array.from({ length: TOTAL }, (_, index) => build(index));

const task = (index: number) => ({
  id: `task-${index}`, kind: 'daemon', title: `Task ${index}`, status: 'completed', owner: 'daemon', cancellable: false,
  childTaskIds: [], queuedAt: NOW - 10_000 - index, startedAt: NOW - 9_000 - index, endedAt: NOW - 8_000 - index,
});

const approval = (index: number) => ({
  id: `approval-${index}`, callId: `call-${index}`, sessionId: 'session-alpha', routeId: 'route-1', status: 'approved',
  request: {
    callId: `call-${index}`, tool: 'shell.exec', args: { cmd: 'git status' }, category: 'execute',
    analysis: { classification: 'shell-command', riskLevel: 'low', summary: 'Run git status.', reasons: ['Runs a command.'], target: 'git status', targetKind: 'command', surface: 'shell', blastRadius: 'project' },
  },
  createdAt: NOW - 20_000 - index, updatedAt: NOW - 10_000 - index, metadata: {}, audit: [],
});

const job = (index: number) => ({
  id: `sched-${index}`, labels: [], createdAt: NOW - 600_000, updatedAt: NOW - 30_000, name: `Brief ${index}`, status: 'enabled', enabled: true,
  schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
  execution: { prompt: 'Summarize.', target: { kind: 'background' } },
  delivery: { mode: 'surface', targets: [], fallbackTargets: [], includeSummary: true, includeTranscript: false, includeLinks: true },
  failure: { action: 'retry', maxConsecutiveFailures: 3, cooldownMs: 60_000, retryPolicy: { maxAttempts: 2, delayMs: 30_000, strategy: 'fixed' } },
  source: { kind: 'agent' },
  nextRunAt: NOW + 3_600_000 + index, runCount: 0, successCount: 0, failureCount: 0, deleteAfterRun: false,
});

describe('live record lists say how many records the host holds beyond the cap', () => {
  const contextWith = (readModels: Record<string, unknown>) => ({ platform: { readModels }, workspace: {} }) as unknown as CommandContext;

  test('a task list reports the tasks it left out', async () => {
    const bundle = await captureAutonomyLiveRecords(contextWith({ tasks: createStaticUiReadModel({ tasks: range(task) }) }));
    expect(bundle.tasks).toHaveLength(LIMIT);
    expect(bundle.omitted).toMatchObject({ tasks: TOTAL - LIMIT, schedules: 0 });
  }, 120_000);

  test('an approval list reports the approvals it left out', async () => {
    const controlPlane = createStaticUiReadModel({
      connectionState: 'connected', activeClientIds: [], requestCount: 0, errorCount: 0, host: '127.0.0.1', port: 3421,
      clients: [], approvals: range(approval), sessions: [], recentEvents: [],
    });
    const bundle = await captureAutonomyLiveRecords(contextWith({ controlPlane }));
    expect(bundle.approvals).toHaveLength(LIMIT);
    expect(bundle.omitted).toMatchObject({ approvals: TOTAL - LIMIT, tasks: 0 });
  }, 120_000);

  test('a schedule list reports the schedules it left out', async () => {
    const bundle = await captureAutonomyLiveRecords(contextWith({ automation: createStaticUiReadModel({ jobs: range(job), runs: [] }) }));
    expect(bundle.schedules).toHaveLength(LIMIT);
    expect(bundle.omitted).toMatchObject({ schedules: TOTAL - LIMIT, tasks: 0 });
  }, 120_000);
});

describe('queue rows never read a capped list as the whole', () => {
  test('the count reads "N of M" only when records were left out', () => {
    expect(shownOf(LIMIT, TOTAL - LIMIT)).toBe('20 of 25');
    expect(shownOf(3, 0)).toBe('3');
  });

  const record = (index: number): AutonomyQueueLiveRecord => ({ id: `r${index}`, label: `Record ${index}`, status: 'completed', summary: 'done', inspectRoute: 'autonomy action:"queue"' });
  const item: AutonomyQueueItem = {
    id: 'connected-host-tasks', label: 'Connected-host tasks', status: 'ready', owner: 'connected-host', kind: 'host-task', visible: true,
    cancellable: false, count: TOTAL, current: 'tasks', next: 'inspect', inspectRoute: 'autonomy action:"queue"', modelRoute: 'autonomy action:"queue"',
    liveRecords: Array.from({ length: LIMIT }, (_, index) => record(index)),
  };

  test('an item lists how many live records its output left out', () => {
    expect(describeItem(item, false).liveRecordsNotShown).toBe(LIMIT - 3);
    expect(describeItem(item, true).liveRecordsNotShown).toBe(LIMIT - 8);
    expect(describeItem({ ...item, liveRecords: [record(0)] }, false).liveRecordsNotShown).toBeUndefined();
  });
});
