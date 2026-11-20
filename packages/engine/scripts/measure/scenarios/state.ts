/**
 * Stores whose write cost the repair changed, each driven through the method
 * the product calls, at the path the product composition gives it under the
 * isolated home: a contract's progress save, a question and its answer in the
 * owner inbox across two store handles (two processes), an edit of one task in
 * a 200-task work plan, and a settings save of several keys.
 */
import { randomUUID } from 'node:crypto';
import { createShellPathService } from '../../../platform/src/platform/runtime/shell-paths.ts';
import { ConfigManager, type ConfigChange } from '../../../platform/src/platform/config/manager.ts';
import { ContractStore } from '../../../platform/src/platform/contract/store.ts';
import { CURRENT_CONTRACT_SCHEMA_VERSION, newContractId, type Contract, type ContractDecision } from '../../../platform/src/platform/contract/types.ts';
import { CONTRACT_INPUT_EXCLUSIONS, type ContractInputFile, type ContractInputSnapshot } from '../../../platform/src/platform/contract/input-snapshot.ts';
import { emptyWorkItemUsage } from '../../../platform/src/platform/orchestration/types.ts';
import { QuestionStore, ownerInboxStorePath, OWNER_ANSWER_SESSION_METADATA } from '../../../platform/src/platform/control-plane/question-store.ts';
import { REGULAR_KNOWLEDGE_DB_FILE } from '../../../platform/src/platform/knowledge/store-config.ts';
import { createConfiguredPlanningStore, prepareConfiguredProjectContext } from '../../../platform/src/platform/knowledge/project-planning/configured-project.ts';
import { ProjectPlanningService } from '../../../platform/src/platform/knowledge/project-planning/service.ts';
import { ProjectWorkPlan } from '../../../platform/src/platform/knowledge/project-planning/work-plan.ts';
import { decisions } from './stores.ts';
import { assertOutcome, type Instance, type MeasureEnv, type Scenario } from '../harness.ts';
import { localOwnerActor } from '../../../daemon-api/src/actor.ts';

const P = 'packages/engine/platform/src/platform';
const SURFACE = 'tui';

// ---------------------------------------------------------------- contract progress

const hex = (seed: number, length: number): string => {
  let out = '';
  for (let i = 0; out.length < length; i++) out += ((seed * 2654435761 + i * 40503) >>> 0).toString(16).padStart(8, '0');
  return out.slice(0, length);
};

/** A captured input naming `files` files, as a version-2 capture records them. */
function inputSnapshot(workspace: string, files: number): ContractInputSnapshot {
  const manifest: ContractInputFile[] = Array.from({ length: files }, (_, i) => ({
    path: `src/area-${i % 40}/module-${i}.ts`, kind: 'file', mode: '100644',
    oid: hex(i + 1, 40), digest: hex(i + 7, 64), identity: `2049:${100_000 + i}:33188:${1_000 + i}:1700000000000000000:1700000000000000000`,
  }));
  return {
    version: 2, id: randomUUID(), sourceRoot: workspace, sourceIdentity: '2049:4242', gitIdentity: 'git:measure',
    ownerHead: hex(901, 40), ownerRef: 'refs/heads/main', indexFingerprint: hex(902, 64),
    inputTree: hex(903, 40), inputCommit: hex(904, 40), capturedAt: Date.now(), dirty: false,
    exclusions: [...CONTRACT_INPUT_EXCLUSIONS], files: manifest,
  };
}

function newContract(workspace: string, files: number): Contract {
  return {
    id: newContractId(), schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION, sessionId: 'measure-session', origin: 'cli',
    ask: 'Measure what a progress save writes', ownerAgentId: 'agent-measure-owner', projectRoot: workspace,
    inputSnapshot: inputSnapshot(workspace, files), isolation: 'shared',
    goal: 'Keep a contract moving', criteria: [], groups: [], units: [], status: 'running', checks: [], fixRounds: 0,
    escalations: [], decisions: [], usage: emptyWorkItemUsage(), judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    plannerAgentIds: [], createdAt: Date.now(),
  };
}

function contractSave(files: number): Scenario {
  return {
    name: `contract-save-${files}-files`,
    drives: `ContractStore.put then write (the runner's checkpoint, contract/runner.ts) of a running contract whose captured input names ${files} files, after one progress step: a decision appended, the status line and the usage changed. The save appends what changed; the base holding the manifest was written once at creation.`,
    entries: [`${P}/contract/store.ts:654 ContractStore.write -> save (diff appended to progress.log)`, `${P}/contract/checkpoint-progress.ts ContractProgressTracker.diff`, `${P}/contract/runner.ts:694 checkpoint`],
    async setup(env: MeasureEnv): Promise<Instance> {
      const store = new ContractStore({ projectRoot: env.workspace, sweepIntervalMs: 0 });
      const contract = newContract(env.workspace, files);
      const creation = store.reserveCreation(contract.id);
      store.publishCreation(creation, contract);
      store.put(contract);
      assertOutcome(store.write(contract.id), `the new contract could not be saved: ${store.writeFailure(contract.id)?.message ?? 'no reason'}`);
      creation.release();
      return {
        async op(run) {
          const decision: ContractDecision = { id: `decision-${run + 1}`, at: Date.now(), action: 'checked', targetId: contract.id, reason: `progress step ${run + 1}`, decisionIds: [] };
          contract.decisions.push(decision);
          contract.statusLine = `step ${run + 1} of the measured run`;
          contract.usage = { ...contract.usage, turnCount: contract.usage.turnCount + 1, toolCallCount: contract.usage.toolCallCount + 3 };
          store.put(contract);
          assertOutcome(store.write(contract.id), `the progress save failed: ${store.writeFailure(contract.id)?.message ?? 'no reason'}`);
        },
        verify(run) {
          // What a restarted process reads: another store over the same project.
          const reader = new ContractStore({ projectRoot: env.workspace, sweepIntervalMs: 0 });
          try {
            const read = reader.load(contract.id);
            assertOutcome(read.kind === 'present', `contract ${contract.id} does not load after the save (${read.kind === 'failed' ? read.refusal.reason : read.kind})`);
            const loaded = read.value;
            assertOutcome(loaded.statusLine === `step ${run + 1} of the measured run` && loaded.decisions.length === contract.decisions.length,
              `the loaded contract shows "${loaded.statusLine}" with ${loaded.decisions.length} decisions; the save made "${contract.statusLine}" with ${contract.decisions.length}`);
            assertOutcome(loaded.inputSnapshot?.files?.length === files, `the loaded contract names ${loaded.inputSnapshot?.files?.length ?? 0} captured files, not ${files}`);
          } finally { reader.dispose(); }
        },
        dispose() { store.dispose(); },
      };
    },
  };
}

// ---------------------------------------------------------------- owner inbox

const ownerInboxQuestionAnswer: Scenario = {
  name: 'owner-inbox-question-answer',
  drives: 'One owner-inbox question asked through one QuestionStore handle and answered through a second handle over the same file (an agent in one process, the owner in another), then taken by the asker: post, get and answer on the second handle, undelivered and recordDelivery on the first.',
  entries: [`${P}/control-plane/question-store.ts:312 QuestionStore.post`, `${P}/control-plane/question-store.ts:344 QuestionStore.answer`, `${P}/control-plane/question-store.ts:358 QuestionStore.recordDelivery`],
  async setup(env: MeasureEnv): Promise<Instance> {
    const path = ownerInboxStorePath(createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home }));
    const asker = new QuestionStore({ path });
    const owner = new QuestionStore({ path });
    // Both handles open their connection before the measured runs, as long-lived processes have.
    asker.revision(); owner.revision();
    return {
      async op(run) {
        const now = Date.now();
        const { created, entry } = asker.post({
          kind: 'question', title: `Deploy step ${run + 1}?`, detail: 'The measured agent asks before it goes on.', options: ['yes', 'no'],
          askedBy: 'measure agent', metadata: { [OWNER_ANSWER_SESSION_METADATA]: 'measure-session' },
        }, now, () => true);
        assertOutcome(created, `the question was not posted: an open item already had its key (${entry.item.id})`);
        assertOutcome(owner.get(entry.item.id) !== undefined, `the second handle does not see question ${entry.item.id}`);
        const answered = owner.answer(entry.item.id, { option: 'yes' }, { actor: 'owner', surface: 'tui' }, now);
        assertOutcome(answered?.applied === true, `the owner's answer to ${entry.item.id} was not applied`);
        const waiting = asker.undelivered({ session: 'measure-session' });
        const mine = waiting.find((candidate) => candidate.item.id === entry.item.id);
        assertOutcome(mine?.answer?.option === 'yes', `the asker does not see the answer to ${entry.item.id} (${waiting.length} undelivered)`);
        const delivered = asker.recordDelivery(entry.item.id, 'delivered', undefined, now);
        assertOutcome(delivered?.applied === true, `the delivery of ${entry.item.id} was not recorded`);
        return { questionsAnswered: 1 };
      },
      verify() {
        const reopened = new QuestionStore({ path });
        try {
          const open = [...reopened.entries()].filter((entry) => entry.closedAt === undefined || entry.delivery === undefined);
          assertOutcome(open.length === 0, `${open.length} questions are still open or undelivered after reopening the store`);
        } finally { reopened.close(); }
      },
      dispose() { asker.close(); owner.close(); },
    };
  },
};

// ---------------------------------------------------------------- work plan

const PLAN_TASKS = 200;

const workPlanEdit: Scenario = {
  name: 'work-plan-edit-200',
  drives: `ProjectWorkPlan.update of one task's notes in a project work plan holding ${PLAN_TASKS} tasks, over the planning service composed as runtime/runtime-graph.ts composes it (the project context prepared and activated, the wiki store from createConfiguredPlanningStore, ProjectPlanningService.forConfiguredWorkspace; the plan file under the user's home).`,
  entries: [`${P}/knowledge/project-planning/work-plan.ts:183 ProjectWorkPlan.update`, `${P}/knowledge/project-planning/service.ts ProjectPlanningService.updateWorkPlanTask`, `${P}/knowledge/project-planning/work-plan-rows.ts WorkPlanRows`],
  async setup(env: MeasureEnv): Promise<Instance> {
    const judgment = decisions(env);
    /** One program's plan: its own settings, project context, store and planning service. */
    const open = async (): Promise<{ plan: ProjectWorkPlan; close(): Promise<void> }> => {
      const configManager = new ConfigManager({ surfaceRoot: SURFACE, homeDir: env.home, workingDir: env.workspace });
      await prepareConfiguredProjectContext(configManager, env.workspace, REGULAR_KNOWLEDGE_DB_FILE, { activate: true });
      const store = createConfiguredPlanningStore(configManager, REGULAR_KNOWLEDGE_DB_FILE, { family: 'wiki' });
      await store.init();
      const { service, projectId } = ProjectPlanningService.forConfiguredWorkspace(store, configManager, env.workspace);
      const plan = new ProjectWorkPlan({ service, projectId, projectRoot: env.workspace, surface: SURFACE });
      return { plan, async close() { service.dispose(); await store.close(); } };
    };
    const main = await open();
    const ids: string[] = [];
    for (let i = 0; i < PLAN_TASKS; i++) ids.push((await main.plan.add(`Task ${i}: ${i % 2 === 0 ? 'write the module' : 'review the change'}`, { notes: 'Seeded by the measurement harness.' })).task.taskId);
    const target = (run: number): string => ids[(run + 1) * 37 % PLAN_TASKS]!;
    return {
      async op(run) {
        const result = await main.plan.update(target(run), { notes: `Edited in measured run ${run}` });
        assertOutcome(result.task.taskId === target(run) && result.task.notes === `Edited in measured run ${run}`, `the edit returned task ${result.task.taskId} with notes "${result.task.notes ?? ''}"`);
      },
      async verify(run) {
        // Another program over the same plan file reads the edit and all the other tasks.
        const other = await open();
        try {
          const task = await other.plan.get(target(run));
          assertOutcome(task.notes === `Edited in measured run ${run}`, `another reader sees notes "${task.notes ?? ''}" on the edited task`);
          const snapshot = await other.plan.snapshot();
          assertOutcome(snapshot.tasks.length === PLAN_TASKS, `the plan holds ${snapshot.tasks.length} tasks, not ${PLAN_TASKS}`);
        } finally { await other.close(); }
      },
      async dispose() { await main.close(); judgment.restore(); },
    };
  },
};

// ---------------------------------------------------------------- settings

/** Five surface-tier settings saved together, as a settings screen or an import saves them. */
const SETTINGS_BATCH = (run: number): ConfigChange[] => [
  { key: 'display.collapseThreshold', value: 31 + (run & 1) },
  { key: 'display.lineNumbers', value: run & 1 ? 'code' : 'all' },
  { key: 'display.showThinking', value: (run & 1) === 1 },
  { key: 'display.showTokenSpeed', value: (run & 1) === 0 },
  { key: 'display.showToolPreview', value: (run & 1) === 1 },
] as ConfigChange[];

const configSetMany: Scenario = {
  name: 'config-set-5-keys',
  drives: "ConfigManager.setMany of five surface-tier display settings by the owner (one update: one admission, one write of the surface's settings file, one revision).",
  entries: [`${P}/config/manager.ts:1542 ConfigManager.setMany`, `${P}/utils/atomic-json-store.ts writeJsonFileAtomic`],
  async setup(env: MeasureEnv): Promise<Instance> {
    const manager = new ConfigManager({ surfaceRoot: SURFACE, homeDir: env.home, workingDir: env.workspace });
    return {
      async op(run) {
        const result = manager.setMany(SETTINGS_BATCH(run), localOwnerActor());
        assertOutcome(result.ok, `the settings were not saved: ${result.ok ? '' : result.refusal.reason}`);
        return { keysSaved: result.saved.length };
      },
      verify(run) {
        // What the next start reads: a new manager over the same files.
        const reader = new ConfigManager({ surfaceRoot: SURFACE, homeDir: env.home, workingDir: env.workspace });
        for (const change of SETTINGS_BATCH(run)) {
          const value = reader.get(change.key);
          assertOutcome(value === change.value, `${change.key} reads ${JSON.stringify(value)} after saving ${JSON.stringify(change.value)}`);
        }
      },
    };
  },
};

export const scenarios: Scenario[] = [contractSave(100), contractSave(5000), ownerInboxQuestionAnswer, workPlanEdit, configSetMany];
