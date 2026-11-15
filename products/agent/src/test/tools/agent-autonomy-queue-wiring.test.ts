import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { captureAutonomyLiveRecords } from '../../tools/agent-harness-autonomy-live-records.ts';
import { operatorMethodRoute } from '../../tools/agent-harness-setup-posture-utils.ts';
import { describeCliCommandPolicy } from '../../tools/agent-harness-cli-command-policy.ts';
import { EFFECT_ADMISSION_SENTENCE } from '../../tools/agent-harness-effect-admission.ts';
import { autonomyQueueSummary } from '../../tools/agent-harness-autonomy-queue.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { createStaticUiReadModel } from '../helpers/ui-read-models.ts';
import { createHarnessFixtureReadings, makeFixture } from './agent-harness-tool-fixture.ts';

const NOW = 1_700_000_100_000;
const TASKS = 25;

let previousPort: JudgmentPort | undefined;
let log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), log));
});
afterEach(() => { installJudgmentPort(previousPort); log[Symbol.dispose](); });
afterAll(cleanupResearchScreeningFixtures);

const task = (index: number) => ({
  id: `task-${index}`, kind: 'daemon', title: `Task ${index}`, status: 'completed', owner: 'daemon', cancellable: false,
  childTaskIds: [], queuedAt: NOW - 10_000 - index, startedAt: NOW - 9_000 - index, endedAt: NOW - 8_000 - index,
});

type QueueRow = { readonly queueItemId: string; readonly current: string; readonly liveRecords?: readonly Record<string, unknown>[] };

describe('queue rows built from the real sources', () => {
  test('a capped task list reads "N of M" in the connected-host task row', async () => {
    const fixture = makeFixture();
    try {
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      readModels.tasks = createStaticUiReadModel({ tasks: Array.from({ length: TASKS }, (_, index) => task(index)) });
      const result = await autonomyQueueSummary(fixture.context, { includeParameters: true }, { sourceOwner: ordinaryResearchOwner() });
      const row = (result.queue as readonly QueueRow[]).find(item => item.queueItemId === 'connected-host-tasks');
      expect(row?.current).toContain('20 of 25 live connected-host task record(s)');
    } finally { await fixture.cleanup(); }
  }, 120_000);

  test('research runs beyond the cap are counted as omitted', async () => {
    const fixture = makeFixture();
    try {
      const registry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      for (let index = 0; index < 10; index += 1) registry.create({ title: `Run ${index}`, question: `Question ${index}?`, nextSteps: ['Read'] });
      const bundle = await captureAutonomyLiveRecords(fixture.context);
      expect(bundle.researchRuns).toHaveLength(8);
      expect(bundle.omitted?.researchRuns).toBe(2);
    } finally { await fixture.cleanup(); }
  }, 120_000);

  test('routes copied from a host watcher record carry their origin in the queue row', async () => {
    const fixture = makeFixture();
    try {
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      readModels.watchers = { runs: [{ runId: 'r1', status: 'running', cancelRoute: 'agent_operator_method methodId:"tasks.cancel" input:{"taskId":"t1"}' }] };
      const result = await autonomyQueueSummary(fixture.context, {}, { sourceOwner: ordinaryResearchOwner() });
      const records = (result.queue as readonly QueueRow[]).flatMap(row => row.liveRecords ?? []);
      const watcherRun = records.find(record => String(record.id).startsWith('watcher-run:'));
      expect(watcherRun?.cancelRoute).toContain('tasks.cancel');
      expect(watcherRun?.routeOrigin).toBe('host-record');
    } finally { await fixture.cleanup(); }
  }, 120_000);
});

describe('operator-method routes do not teach confirm as authority', () => {
  test('a repair route names the method only', () => {
    expect(operatorMethodRoute('services.restart')).toBe('agent_operator_method methodId:"services.restart" input:{}');
  });

  test('the ci/principals command policy states the recorded admission rule', () => {
    const policy = describeCliCommandPolicy('ci');
    expect(policy.boundary).toContain(EFFECT_ADMISSION_SENTENCE);
    expect(policy.boundary).not.toContain('confirm + explicitUserRequest');
  });
});
