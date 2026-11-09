// ---------------------------------------------------------------------------
// workstream-planner-inputs.test.ts: the AdaptivePlanner inputs a workstream
// draft is gated with. The risk is the `routing.request-risk` reading of the
// task (a severe reading closes the decomposition gate, so no planning agent
// runs); remoteAvailable comes from the remote supervisor's live sessions;
// backgroundEligible is true because a launched draft always runs as a
// background contract; the latency budget is unbounded.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JudgmentError, type Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { DecisionModelsDisabledError, decisionModelPolicyState, installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { AdaptivePlanner } from '../platform/src/platform/core/index.ts';
import type { PhaseRunnerAgentManagerLike } from '../platform/src/platform/orchestration/index.ts';
import { createWorkstreamServices } from '../platform/src/platform/orchestration/workstream-services.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { RemoteRunnerRegistry, RemoteSupervisor } from '../platform/src/platform/runtime/remote/index.ts';
import { createRuntimeStore, type RuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import type { AcpConnection } from '../platform/src/platform/runtime/store/domains/acp.ts';
import { configGetCategoryStub, configGetStub } from './_helpers/config-manager-stub.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const tempDirs: string[] = [];
let previousPort: ReturnType<typeof installJudgmentPort>;

beforeEach(() => {
  previousPort = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previousPort);
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A port that reads every task's risk at `level` (0 negligible .. 3 severe) and records the requests. */
function riskPort(level: number, strategy = 'single') {
  return fakePort((name: string, question: Question) => {
    if (name === 'strategy') return choiceAnswer(question, strategy, 0.97);
    if (name !== 'risk') throw new Error(`unexpected question ${name}`);
    return scoreAnswer(question, level);
  });
}

function withConnection(store: RuntimeStore, connection: AcpConnection): void {
  store.setState((state) => ({
    acp: {
      ...state.acp,
      connections: new Map([[connection.agentId, connection]]),
      activeConnectionIds: [connection.agentId],
    },
  }));
}

function makeServices(options: { decomposition: 'heuristic' | 'agent'; store?: RuntimeStore; projectRoot?: string }) {
  const projectRoot = options.projectRoot ?? makeProjectTempDir('gv-workstream-planner-inputs');
  if (options.projectRoot === undefined) tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  const spawned: string[] = [];
  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn: (input) => {
      spawned.push(input.template ?? 'engineer');
      throw new Error('no agent is expected to be spawned');
    },
    getStatus: () => null,
    cancel: () => false,
    registerCancellationSignal: () => {},
    releaseCancellationSignal: () => {},
  };
  const planner = new AdaptivePlanner();
  const services = createWorkstreamServices({
    agentManager,
    configManager: {
      get: configGetStub({ 'contract.commitScope': 'off', 'planner.decomposition': options.decomposition }),
      getCategory: configGetCategoryStub({ contract: { commitScope: 'off', gates: [] } }),
    },
    adaptivePlanner: planner,
    runtimeBus: new RuntimeEventBus(),
    projectRoot,
    contractRunner: {
      start: () => { throw new Error('not launched in this test'); },
      startFromPlan: () => { throw new Error('not launched in this test'); },
    },
    sessionId: 'session-1',
    remoteSupervisor: new RemoteSupervisor(new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] })),
    runtimeStore: options.store ?? createRuntimeStore(),
  });
  return { ...services, planner, spawned, projectRoot };
}

describe('workstream draft planner inputs', () => {
  test('the task risk is the routing.request-risk reading of the task as a planner brief', async () => {
    const { port, requests } = riskPort(1.5);
    installJudgmentPort(port);
    const { workstreamCommands, orchestrationEngine, planner } = makeServices({ decomposition: 'heuristic' });

    await workstreamCommands.proposeDraft('Move the billing service to webhooks and migrate existing customers.');
    expect(requests.map(request => request.context?.battery)).toEqual(['routing.request-risk', 'engine.core.execution-strategy']);
    expect(Object.keys(requests[0]!.questions)).toEqual(['risk']);
    expect(requests[0]!.state).toEqual({ purpose: 'planner', work: 'Move the billing service to webhooks and migrate existing customers.' });
    const inputs = planner.getLatest()!.inputs;
    expect(inputs.riskScore).toBeCloseTo(0.5, 5);
    expect(inputs.latencyBudgetMs).toBe(Number.POSITIVE_INFINITY);
    expect(inputs.isMultiStep).toBe(true);
    expect(inputs.backgroundEligible).toBe(true);
    expect(inputs.remoteAvailable).toBe(false);
    orchestrationEngine.dispose();
  });

  test('a recorded single strategy closes decomposition for a severe task', async () => {
    installJudgmentPort(riskPort(3, 'single').port);
    const { workstreamCommands, orchestrationEngine, spawned } = makeServices({ decomposition: 'agent' });

    const draft = await workstreamCommands.proposeDraft('Delete the duplicate customer records from the production billing database.');

    expect(draft.gate).toMatchObject({ decompose: false, strategy: 'single', reasonCode: 'JUDGMENT_SELECTED' });
    expect(draft.provenance.kind).toBe('gate-declined');
    expect(draft.spec.items).toHaveLength(1);
    expect(spawned).toEqual([]);
    orchestrationEngine.dispose();
  });

  test('a low risk reading preserves the recorded single strategy', async () => {
    installJudgmentPort(riskPort(0).port);
    const { workstreamCommands, orchestrationEngine } = makeServices({ decomposition: 'heuristic' });
    const draft = await workstreamCommands.proposeDraft('Reword the comments in the README examples.');
    expect(draft.gate).toMatchObject({ decompose: false, strategy: 'single' });
    orchestrationEngine.dispose();
  });

  test('remoteAvailable follows the remote supervisor: a connected runner with a fresh heartbeat', async () => {
    installJudgmentPort(riskPort(0).port);
    const store = createRuntimeStore();
    const { workstreamCommands, orchestrationEngine, planner } = makeServices({ decomposition: 'heuristic', store });

    await workstreamCommands.proposeDraft('Add a status endpoint.');
    expect(planner.getLatest()!.inputs.remoteAvailable).toBe(false);

    withConnection(store, { agentId: 'runner-1', label: 'runner', transportState: 'connected', connectedAt: Date.now(), completing: false, messageCount: 0, errorCount: 0 });
    await workstreamCommands.proposeDraft('Add a status endpoint.');
    expect(planner.getLatest()!.inputs.remoteAvailable).toBe(true);

    withConnection(store, { agentId: 'runner-1', label: 'runner', transportState: 'connected', connectedAt: Date.now() - 10 * 60_000, completing: false, messageCount: 0, errorCount: 0 });
    await workstreamCommands.proposeDraft('Add a status endpoint.');
    expect(planner.getLatest()!.inputs.remoteAvailable).toBe(false);

    withConnection(store, { agentId: 'runner-1', label: 'runner', transportState: 'reconnecting', connectedAt: Date.now(), completing: false, messageCount: 0, errorCount: 0 });
    await workstreamCommands.proposeDraft('Add a status endpoint.');
    expect(planner.getLatest()!.inputs.remoteAvailable).toBe(false);
    orchestrationEngine.dispose();
  });

  test('with no judgment port the draft is not proposed', async () => {
    const { workstreamCommands, orchestrationEngine } = makeServices({ decomposition: 'heuristic' });
    await expect(workstreamCommands.proposeDraft('Add a status endpoint.')).rejects.toBeInstanceOf(JudgmentPortMissingError);
    expect(workstreamCommands.listDrafts()).toHaveLength(0);
    orchestrationEngine.dispose();
  });
});


for (const policy of ['Classic - Off', 'Preferred'] as const) {
  test(`${policy} drafts, edits, persists and reloads a complete goal without invented semantic risk`, async () => {
    const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted decision chain'); });
    installJudgmentPort(fake.port);
    await withDecisionModelPolicy(() => policy, async () => {
      const h = makeServices({ decomposition: 'agent' });
      try {
        const draft = await h.workstreamCommands.proposeDraft('Inspect the exact source and propose the owner-requested change.');
        expect(draft.gate).toMatchObject({ decompose: false, reasonCode: 'CLASSIC_SINGLE', provenance: 'classic' });
        expect(draft.provenance.policy).toBe('classic'); expect(draft.proposal.provenance).toBe('classic');
        expect(draft.spec.items).toHaveLength(1); expect(draft.spec.items[0]!.task).toBe(draft.task);
        expect(h.planner.getLatest()?.inputs.riskScore).toBeNull();
        expect(h.planner.explain()).toContain('not assessed');
        expect(h.spawned).toEqual([]);
        const attempted = fake.requests.length;
        const edited = await h.workstreamCommands.editDraft(draft.id, 'Only change the explicitly selected file.');
        expect(edited?.spec.items[0]!.task).toBe('Only change the explicitly selected file.');
        expect(edited?.provenance.policy).toBe('classic');
        expect(h.workstreamCommands.approveDraft(draft.id)?.approved).toBe(true);
        expect(() => h.workstreamCommands.launchDraft(draft.id)).toThrow(DecisionModelsDisabledError);
        expect(h.workstreamCommands.getDraft(draft.id)?.approved).toBe(true);
        expect(fake.requests).toHaveLength(attempted);
        expect(policy === 'Classic - Off' ? attempted === 0 : attempted > 0).toBe(true);
        const restarted = makeServices({ decomposition: 'agent', projectRoot: h.projectRoot });
        try {
          expect(restarted.workstreamCommands.getDraft(draft.id)).toMatchObject({
            approved: true, task: 'Only change the explicitly selected file.',
            provenance: { policy: 'classic' }, gate: { provenance: 'classic' },
          });
          expect(() => restarted.workstreamCommands.launchDraft(draft.id)).toThrow(DecisionModelsDisabledError);
          expect(restarted.spawned).toEqual([]); expect(fake.requests).toHaveLength(attempted);
        } finally { restarted.orchestrationEngine.dispose(); }
      } finally { h.orchestrationEngine.dispose(); }
    });
  });
}

test('Preferred missing runtime can author an unassessed draft but terminal risk failures do not switch policies', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const h = makeServices({ decomposition: 'agent' });
    try {
      const draft = await h.workstreamCommands.proposeDraft('Retain this complete owner goal.');
      expect(draft.provenance.policy).toBe('classic'); expect(decisionModelPolicyState().operation).toBe('classic');
      expect(h.planner.getLatest()?.inputs.riskScore).toBeNull(); expect(h.spawned).toEqual([]);
    } finally { h.orchestrationEngine.dispose(); }
  });
  for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) {
    const fake = fakePort(() => { throw new JudgmentError(kind, 'Synthetic terminal failure'); });
    installJudgmentPort(fake.port);
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      const h = makeServices({ decomposition: 'agent' });
      try {
        await expect(h.workstreamCommands.proposeDraft('A refused or malformed risk is not availability.')).rejects.toThrow();
        expect(h.workstreamCommands.listDrafts()).toEqual([]); expect(h.spawned).toEqual([]);
        expect(decisionModelPolicyState().operation).toBe('decision');
      } finally { h.orchestrationEngine.dispose(); }
    });
  }
});
