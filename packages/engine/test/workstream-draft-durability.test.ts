/**
 * What the draft journal on disk says after races, failed writes and launches:
 * a removed draft is not written back, a failed write never leaves an approved
 * pre-edit plan behind, a launch in flight is journaled as unapproved, and a
 * draft that is saved is never reclaimed by the save itself.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { AdaptivePlanner } from '../platform/src/platform/core/index.ts';
import type { ConfigManager } from '../platform/src/platform/config/index.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { RemoteRunnerRegistry, RemoteSupervisor } from '../platform/src/platform/runtime/remote/index.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import type { StartedContract } from '../platform/src/platform/contract/runner.ts';
import { createWorkstreamServices, type WorkstreamServicesDeps } from '../platform/src/platform/orchestration/workstream-services.ts';
import { WORKSTREAM_DRAFT_TTL_MS, createWorkstreamDraftStore } from '../platform/src/platform/orchestration/workstream-draft-store.ts';
import { resolveItemIndex } from '../platform/src/platform/orchestration/workstream-draft-edits.ts';
import type { WorkstreamDraft } from '../platform/src/platform/orchestration/workstream-draft-types.ts';
import { configGetCategoryStub, configGetStub } from './_helpers/config-manager-stub.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const configManager: Pick<ConfigManager, 'get' | 'getCategory'> = {
  get: configGetStub({ 'contract.commitScope': 'off', 'planner.decomposition': 'heuristic' }),
  getCategory: configGetCategoryStub({
    contract: { maxFixRounds: 3, autoCommit: false, transportRetryLimit: 0, transportRetryDelayMs: 0, commitScope: 'off', gates: [] },
  }),
};

const roots: string[] = [];
let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previousPort = installJudgmentPort(fakePort((name, question) => name === 'strategy' ? choiceAnswer(question, 'single', 0.97) : scoreAnswer(question, 1)).port);
});
afterEach(() => {
  installJudgmentPort(previousPort);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const draftsDir = (root: string) => join(root, '.goodvibes', 'orchestration', 'drafts');
const draftFiles = (root: string) => (existsSync(draftsDir(root)) ? readdirSync(draftsDir(root)).filter((f) => f.endsWith('.json')) : []);

function services(runner: WorkstreamServicesDeps['contractRunner']) {
  const root = makeProjectTempDir('gv-draft-durability'); roots.push(root);
  const made = createWorkstreamServices({
    agentManager: { spawn: () => { throw new Error('no agent expected'); }, getStatus: () => null, cancel: () => false, registerCancellationSignal: () => {}, releaseCancellationSignal: () => {} },
    configManager, adaptivePlanner: new AdaptivePlanner(), runtimeBus: new RuntimeEventBus(), projectRoot: root,
    contractRunner: runner, sessionId: 'session-1',
    remoteSupervisor: new RemoteSupervisor(new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] })),
    runtimeStore: createRuntimeStore(),
  });
  return { root, ...made };
}

const started = (): StartedContract => ({ contract: { id: 'c-1' }, owner: { id: 'o-1' } }) as unknown as StartedContract;
const okRunner: WorkstreamServicesDeps['contractRunner'] = { start: async () => started(), startFromPlan: async () => started() };

describe('draft facade and its journal', () => {
  test('an edit whose planning run outlives the draft does not write the removed draft back', async () => {
    const { root, orchestrationEngine, workstreamCommands } = services(okRunner);
    try {
      const draft = await workstreamCommands.proposeDraft('ship the demo');
      expect(draftFiles(root)).toHaveLength(1);
      const edit = workstreamCommands.editDraft(draft.id, 'ship the demo differently');
      workstreamCommands.removeDraft(draft.id);
      expect(await edit).toBeUndefined();
      expect(draftFiles(root)).toEqual([]);
    } finally { orchestrationEngine.dispose(); }
  });

  test('a failed write after an edit of an approved draft removes the older approved file and flags the draft', async () => {
    const { root, orchestrationEngine, workstreamCommands } = services(okRunner);
    try {
      const draft = await workstreamCommands.proposeDraft('ship the demo');
      workstreamCommands.approveDraft(draft.id);
      const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EIO'); });
      try {
        const edited = workstreamCommands.editItem(draft.id, '1', 'a different brief');
        expect(edited && !('error' in edited) && edited.journaled).toBe(false);
      } finally { rename.mockRestore(); }
      expect(draftFiles(root)).toEqual([]); // no approved pre-edit plan left to relaunch after a restart
      expect(workstreamCommands.getDraft(draft.id)?.approved).toBe(false);

      workstreamCommands.approveDraft(draft.id); // the next successful save clears the flag
      expect(workstreamCommands.getDraft(draft.id)?.journaled).toBeUndefined();
      expect(draftFiles(root)).toHaveLength(1);
    } finally { orchestrationEngine.dispose(); }
  });

  test('while a launch is in flight the journal holds the draft unapproved; a failed launch restores the approval', async () => {
    let release!: () => void, fail = true;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner: WorkstreamServicesDeps['contractRunner'] = {
      start: async () => { await gate; if (fail) throw new Error('runner refused'); return started(); },
      startFromPlan: async () => started(),
    };
    const { root, orchestrationEngine, workstreamCommands } = services(runner);
    try {
      const draft = await workstreamCommands.proposeDraft('ship the demo');
      workstreamCommands.approveDraft(draft.id);
      const launch = workstreamCommands.launchDraft(draft.id);
      void launch.catch(() => {});
      expect(createWorkstreamDraftStore(root).loadAll()[0]?.approved).toBe(false);
      release();
      await expect(launch).rejects.toThrow('runner refused');
      expect(createWorkstreamDraftStore(root).loadAll()[0]?.approved).toBe(true);

      fail = false;
      expect(await workstreamCommands.launchDraft(draft.id)).toEqual({ contractId: 'c-1', ownerAgentId: 'o-1' });
      expect(draftFiles(root)).toEqual([]);
    } finally { release(); orchestrationEngine.dispose(); }
  });

  test('a best-of-N draft without worktree isolation is refused at launch with the way to fix it', async () => {
    const { orchestrationEngine, workstreamCommands } = services(okRunner);
    try {
      const draft = await workstreamCommands.proposeDraft('ship the demo');
      Object.assign(draft.spec.items[0]!, { attempts: 3 });
      workstreamCommands.approveDraft(draft.id);
      await expect(workstreamCommands.launchDraft(draft.id)).rejects.toThrow('--isolation worktree');
      expect(workstreamCommands.getDraft(draft.id)).toBeDefined();
    } finally { orchestrationEngine.dispose(); }
  });
});

describe('draft store', () => {
  test('saving an old draft does not reclaim the file it just wrote', () => {
    const root = makeProjectTempDir('gv-draft-keep'); roots.push(root);
    const now = 10 * WORKSTREAM_DRAFT_TTL_MS;
    const store = createWorkstreamDraftStore(root, { now: () => now, sweepIntervalMs: 0 });
    const old = {
      id: 'wsd_old', task: 't', approved: false, createdAt: now - WORKSTREAM_DRAFT_TTL_MS - 1,
      spec: { title: 't', phases: [], items: [] }, gate: {}, proposal: {}, provenance: { kind: 'fallback', itemCount: 0 },
    } as unknown as WorkstreamDraft;
    expect(store.save(old)).toBe(true);
    expect(draftFiles(root)).toEqual(['wsd_old.json']);
  });

  test('save reports false when the write fails', () => {
    const root = makeProjectTempDir('gv-draft-fail'); roots.push(root);
    const store = createWorkstreamDraftStore(root);
    const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EIO'); });
    try {
      expect(store.save({ id: 'wsd_x', task: 't', approved: false, createdAt: Date.now(), spec: { title: 't', phases: [], items: [] } } as unknown as WorkstreamDraft)).toBe(false);
    } finally { rename.mockRestore(); }
  });
});

describe('resolveItemIndex', () => {
  const items = [{ id: '2', title: 'a', task: 'a' }, { id: '1', title: 'b', task: 'b' }];
  test('an empty reference names nothing', () => {
    expect(resolveItemIndex([{ id: 'only', title: 'a', task: 'a' }], '  ')).toBeUndefined();
  });
  test('a number that is also another item\'s id is ambiguous; one that is its own item\'s id is not', () => {
    expect(resolveItemIndex(items, '2')).toBeUndefined(); // ordinal 2 is the item with id "1", while id "2" is the first item
    expect(resolveItemIndex([{ id: '1', title: 'a', task: 'a' }, { id: 'x', title: 'b', task: 'b' }], '1')).toBe(0);
  });
});
