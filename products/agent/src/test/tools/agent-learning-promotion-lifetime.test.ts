import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createMemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/platform/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, type MemoryRecord } from '@goodvibes-jev/engine/platform/platform/state';
import { ToolInputProjectionError, ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { SqliteDecisionLog, actionOf, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { runSkillDraftProposer, assertSkillDraftRunResultCurrent, readSkillDraftLedger, type SkillDraftRunResult } from '../../agent/skill-draft-runner.ts';
import { runAutoPromoter, assertAutoPromoteResultCurrent, completedPromotionWrites, type AutoPromoteResult } from '../../tools/agent-harness-learning-auto-promote.ts';
import { harnessCatalogInvocationAuthority } from '../../tools/agent-harness-catalog-ingress.ts';
import type { CatalogRankingOptions } from '../../tools/agent-harness-catalog-ranking.ts';
import type { LearningCuratorNativeContext } from '../../tools/agent-harness-learning-curator-source.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

function barrier() {
  const value = Promise.withResolvers<void>();
  return { promise: value.promise, release: () => value.resolve() };
}

type Inspect = (result: SkillDraftRunResult | AutoPromoteResult, options: CatalogRankingOptions) => void;

async function fixture(settings: { readonly target?: string; readonly gradeConfidence?: number; readonly suspend?: boolean; readonly daemonMemory?: boolean; readonly duplicatePersonas?: boolean; readonly priorEffects?: Parameters<typeof AgentSkillRegistry.fromShellPaths>[1] } = {}) {
  const root = makeProjectTempDir('learning-promotion-lifetime');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  const embeddings = new MemoryEmbeddingProviderRegistry({ configManager: config });
  const store = new MemoryStore(join(root, 'memory.sqlite'), { embeddingRegistry: embeddings, enableVectorIndex: false });
  await store.init();
  const memory = createMemoryApi(new MemoryRegistry(store));
  const context: LearningCuratorNativeContext = { workspace: { shellPaths: paths }, clients: { agentKnowledgeApi: { memory } } };
  const skills = AgentSkillRegistry.fromShellPaths(paths, settings.priorEffects);
  const notes = AgentNoteRegistry.fromShellPaths(paths);
  if (settings.duplicatePersonas) {
    const personas = AgentPersonaRegistry.fromShellPaths(paths);
    for (const [name, body] of [['Release reviewer', 'First wording.'], ['Release reviewers', 'Second wording.'], ['Reviewer of releases', 'Third wording.']] as const)
      personas.create({ name, description: 'Reviews a release.', body, source: 'user' });
  } else for (const title of ['Archive recovery', 'Release review', 'Backup check']) {
    const note = notes.create({ title, body: `Complete synthetic steps for ${title}.`, tags: ['ordinary'] });
    notes.markReviewed(note.id);
  }
  const entered = barrier(), released = barrier();
  const rawReads = new Set<Promise<unknown>>();
  let suspended = false;
  const scripted = fakePort((wireName, question) => {
    // Every pair of records reads as the same entity and the first one survives; the call's own admission readings are unchanged.
    if (settings.duplicatePersonas && !/^(effect|risk|edge)__/.test(wireName)) {
      if (question.type === 'score') return scoreAnswer(question, 2, 0.9999);
      if (question.type === 'noul') return noulAnswer(wireName.startsWith('item_') ? 0.0001 : 0.9999);
      return choiceAnswer(question, '0', 0.9999);
    }
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    if (question.type === 'score') return scoreAnswer(question, name === 'link' ? 0 : 3, settings.gradeConfidence ?? 0.9999);
    if (question.type === 'noul') return noulAnswer(name === 'mutates' ? 0.999 : 0.001);
    const choice = name === 'target' ? settings.target ?? 'skill' : name === 'memory_class' ? 'decision'
      : name === 'disposition' ? 'act' : name === 'kind' ? 'write'
        : name === 'family' || name === 'capability' ? 'generic' : name === 'hazard' ? 'none' : undefined;
    if (!choice) throw new Error(`Unspecified native promotion fixture question ${name}`);
    return choiceAnswer(question, choice, 0.9999);
  });
  const rawPort: JudgmentPort = {
    model: scripted.port.model,
    ask(request) {
      const work = (async () => {
        if (settings.suspend && !suspended && Object.hasOwn(request.questions, 'target')) {
          suspended = true; entered.release(); await released.promise;
        }
        return scripted.port.ask(request);
      })();
      rawReads.add(work);
      void work.then(() => rawReads.delete(work), () => rawReads.delete(work));
      return work;
    },
  };
  const log = new SqliteDecisionLog(':memory:');
  const previous = installJudgmentPort(withDecisionLog(rawPort, log));
  const owner = ordinaryResearchOwner();
  const permissions = new PermissionManager(undefined, createPermissionConfigReader(config), new PolicyRuntimeState());
  const registry = new ToolRegistry(permissions);
  bindAgentResearchSourceOwner(registry, owner);
  const stops: unknown[] = [];
  let inspect: Inspect | undefined, beforeCurrent: (() => void) | undefined, sequence = 0, admissions = 0;
  const pending = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  const tool: Tool = {
    definition: { name: 'agent_harness', description: 'Native local learning promotion lifetime fixture.',
      sideEffects: ['state'], parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['skill', 'auto'] } }, required: ['mode'], additionalProperties: false } },
    async execute(args, execution) {
      const assertCurrent = () => {
        if (!harnessCatalogInvocationAuthority(args, execution, 'write')) throw new ToolInputProjectionError('held');
        beforeCurrent?.();
        if (!harnessCatalogInvocationAuthority(args, execution, 'write')) throw new ToolInputProjectionError('held');
      };
      assertCurrent();
      const options: CatalogRankingOptions = Object.freeze({ signal: execution?.signal, sourceOwner: owner, assertCurrent });
      if (args.mode === 'skill') {
        const result = await runSkillDraftProposer(context, skills, options);
        inspect?.(result, options);
        const output = JSON.stringify(result);
        assertSkillDraftRunResultCurrent(result, context, options); assertCurrent();
        return { success: true, output };
      }
      let result: AutoPromoteResult;
      try { result = await runAutoPromoter(context, skills, memory, options, settings.daemonMemory === true); }
      catch (stopped) { stops.push(stopped); throw stopped; }
      inspect?.(result, options);
      const output = JSON.stringify(result);
      assertAutoPromoteResultCurrent(result, context, options); assertCurrent();
      return { success: true, output };
    },
  };
  registry.register(tool);
  function run(mode: 'skill' | 'auto', controller = new AbortController()) {
    controllers.add(controller);
    const work = (async () => {
      const callId = `learning-effect-${++sequence}`;
      const prepared = await registry.prepareCall(callId, 'agent_harness', { mode }, { signal: controller.signal });
      const admission = await permissions.admitAutonomous(callId, 'agent_harness', prepared.args, {
        sourceOf: () => ({ goal: 'Propose disabled synthetic local learning records', criteria: ['Modify only the temporary native registry and ledger'] }),
        signal: controller.signal, schemaRevision: prepared.schemaRevision, preparedCall: { registry, call: prepared },
      });
      expect(admission.result.approved).toBe(true); admissions++;
      return registry.executePrepared(prepared, admission, { signal: controller.signal });
    })();
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  return { root, paths, store, memory, skills, notes, context, tool, log, run, entered, released, stops,
    admissions: () => admissions, inspect(callback: Inspect) { inspect = callback; },
    beforeCurrent(callback: () => void) { beforeCurrent = callback; },
    async drainReadings() { await Promise.allSettled([...rawReads]); },
    ledgerPath: () => skills.snapshot().path.replace(/skills\.json$/, 'skill-draft-ledger.json'),
    async close() {
      for (const controller of controllers) controller.abort();
      released.release();
      try { await Promise.allSettled([...pending, ...rawReads]); }
      finally {
        installJudgmentPort(previous);
        store.close(); log[Symbol.dispose]();
        await cleanupResearchScreeningFixtures();
      }
    },
  };
}

function expectNoOwnedWrites(h: Awaited<ReturnType<typeof fixture>>) {
  expect(h.skills.list()).toHaveLength(0);
  expect(h.memory.getAll()).toHaveLength(0);
  expect(fs.existsSync(h.ledgerPath())).toBe(false);
}

test('an actual recorded write admission creates disabled native drafts and their exact ledger', async () => {
  const h = await fixture();
  try {
    const result = await h.run('auto');
    expect(result.success).toBe(true); expect(h.admissions()).toBe(1);
    const drafts = h.skills.list();
    expect(drafts).toHaveLength(3);
    expect(drafts.every(record => record.enabled === false)).toBe(true);
    expect(h.skills.snapshot().activeSkills).toHaveLength(0);
    expect(readSkillDraftLedger(h.skills).map(entry => entry.skillId)).toEqual(drafts.map(record => record.id));
    expect(h.memory.getAll()).toHaveLength(0);
  } finally { await h.close(); }
});

test('caller flags or a direct unadmitted invocation cannot begin a promotion', async () => {
  const h = await fixture();
  try {
    await expect(h.tool.execute({ mode: 'skill', confirm: true, explicitUserRequest: 'Caller assertion' })).rejects.toBeDefined();
    expect(h.admissions()).toBe(0); expectNoOwnedWrites(h);
  } finally { await h.close(); }
});

function recordedActions(log: SqliteDecisionLog) {
  return log.query({ limit: Number.MAX_SAFE_INTEGER }).flatMap(entry => {
    const action = actionOf(entry);
    return action === undefined ? [] : [{ id: entry.id, action }];
  });
}

test('abort during a noncooperating captured reading refuses without writes or a late retained action', async () => {
  const h = await fixture({ suspend: true }), controller = new AbortController();
  const pending = h.run('skill', controller);
  try {
    await h.entered.promise;
    controller.abort(new Error('The original caller stopped'));
    await expect(pending).rejects.toBeDefined();
    const actions = recordedActions(h.log);
    expectNoOwnedWrites(h);
    h.released.release();
    await pending.catch(() => {});
    await h.drainReadings();
    expect(recordedActions(h.log)).toEqual(actions);
  } finally { h.released.release(); await pending.catch(() => {}); await h.close(); }
});

test('a stop after the first draft is created leaves every created draft listed in the ledger', async () => {
  const controller = new AbortController();
  let published = 0;
  const h = await fixture({ priorEffects: { onEffect(effect) { if (effect === true && ++published === 1) controller.abort(new Error('The original caller stopped')); } } });
  try {
    await expect(h.run('skill', controller)).rejects.toBeDefined();
    const created = h.skills.list();
    // The stop came after the first create and before the third, so the pass was cut short with at least one draft durable.
    expect(created.length).toBeGreaterThan(0); expect(created.length).toBeLessThan(3);
    expect(readSkillDraftLedger(h.skills).map(entry => entry.skillId)).toEqual(created.map(record => record.id));
  } finally { await h.close(); }
});

test.each(['source', 'ledger'] as const)('a concurrent %s write during grading is not adopted or overwritten', async change => {
  const h = await fixture({ suspend: true });
  const pending = h.run('skill');
  try {
    await h.entered.promise;
    let concurrentBytes: string | undefined;
    if (change === 'source') AgentPersonaRegistry.fromShellPaths(h.paths).create({ name: 'Unrelated preference', description: 'An independent change', body: 'Preserve this unrelated native record.' });
    else {
      fs.mkdirSync(dirname(h.ledgerPath()), { recursive: true });
      concurrentBytes = `${JSON.stringify({ version: 1, entries: [{ skillId: 'unrelated', name: 'other', candidateId: 'other', proposedAt: '2026-01-01T00:00:00.000Z' }] }, null, 2)}\n`;
      fs.writeFileSync(h.ledgerPath(), concurrentBytes);
    }
    h.released.release();
    await expect(pending).rejects.toBeDefined();
    expect(h.skills.list()).toHaveLength(0); expect(h.memory.getAll()).toHaveLength(0);
    if (concurrentBytes !== undefined) expect(fs.readFileSync(h.ledgerPath(), 'utf8')).toBe(concurrentBytes);
    else expect(AgentPersonaRegistry.fromShellPaths(h.paths).list()).toHaveLength(1);
  } finally { h.released.release(); await pending.catch(() => {}); await h.close(); }
});

test('a real native writer callback cannot adopt an unrelated source write before its planned publication', async () => {
  let reentrant: (() => void) | undefined;
  const h = await fixture({ priorEffects: { onEffect(published) { if (published !== true) reentrant?.(); } } });
  try {
    reentrant = () => {
      reentrant = undefined;
      AgentPersonaRegistry.fromShellPaths(h.paths).create({ name: 'Reentrant preference', description: 'Independent source', body: 'Do not adopt this state into the planned skill.' });
    };
    await expect(h.run('skill')).rejects.toBeDefined();
    expectNoOwnedWrites(h);
    expect(AgentPersonaRegistry.fromShellPaths(h.paths).list()).toHaveLength(1);
  } finally { await h.close(); }
});

test('final issued-result checks reject copied output, other options and changed ledger before publication', async () => {
  const h = await fixture();
  try {
    h.inspect((result, options) => {
      if (!('entries' in result)) throw new Error('Expected the native skill result');
      expect(() => assertSkillDraftRunResultCurrent({ ...result }, h.context, options)).toThrow(ToolInputProjectionError);
      expect(() => assertSkillDraftRunResultCurrent(result, h.context, { ...options })).toThrow(ToolInputProjectionError);
      fs.appendFileSync(h.ledgerPath(), ' ');
    });
    await expect(h.run('skill')).rejects.toBeDefined();
    expect(h.skills.list()).toHaveLength(3);
  } finally { await h.close(); }
});

test.each(['memory', 'persona', 'routine'] as const)('an authentic reviewed-note %s proposal reaches its native durable create path', async target => {
  const h = await fixture({ target });
  try {
    const result = await h.run('auto');
    expect(result.success).toBe(true); expect(h.admissions()).toBe(1);
    expect(h.skills.list()).toHaveLength(0); expect(fs.existsSync(h.ledgerPath())).toBe(false);
    if (target === 'memory') {
      const rows = h.memory.getAll();
      expect(rows).toHaveLength(3);
      expect(rows.every(record => record.cls === 'decision')).toBe(true);
      expect(rows.map(record => record.confidence)).toEqual([75, 75, 75]);
      expect(rows.every(record => typeof record.detail === 'string' && record.detail.startsWith('Complete synthetic steps for '))).toBe(true);
      const reopened = new MemoryStore(join(h.root, 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(h.root, 'config') }) }), enableVectorIndex: false });
      try { await reopened.init(); expect<readonly (MemoryRecord | null)[]>(rows.map(record => reopened.get(record.id))).toEqual(rows); }
      finally { reopened.close(); }
    } else if (target === 'persona') {
      const rows = AgentPersonaRegistry.fromShellPaths(h.paths).list();
      expect(rows).toHaveLength(3);
      expect(rows.every(record => record.body.startsWith('Complete synthetic steps for '))).toBe(true);
      expect(AgentPersonaRegistry.fromShellPaths(h.paths).snapshot().activePersonaId).toBeNull();
    } else {
      const rows = AgentRoutineRegistry.fromShellPaths(h.paths).list();
      expect(rows).toHaveLength(3);
      expect(rows.every(record => record.steps.startsWith('Complete synthetic steps for '))).toBe(true);
      // A routine made from note or session text stays off until its owner enables it.
      expect(rows.every(record => record.enabled === false)).toBe(true);
    }
    expect(h.notes.list()).toHaveLength(3);
  } finally { await h.close(); }
});

test('with a daemon serving memory, a memory proposal is skipped with the reason and nothing is written locally', async () => {
  const h = await fixture({ target: 'memory', daemonMemory: true });
  try {
    const result = await h.run('auto');
    expect(result.success).toBe(true);
    const report = JSON.parse(result.output ?? '{}') as { readonly promoted: number; readonly skipped: number; readonly log: readonly string[] };
    expect(report.promoted).toBe(0);
    expect(report.skipped).toBe(3);
    expect(report.log.every(line => line.includes('served by the connected daemon'))).toBe(true);
    expect(h.memory.getAll()).toHaveLength(0);
  } finally { await h.close(); }
});

test('a settled none destination creates no durable record or draft ledger', async () => {
  const h = await fixture({ target: 'none' });
  try {
    expect((await h.run('auto')).success).toBe(true);
    expectNoOwnedWrites(h);
    expect(AgentPersonaRegistry.fromShellPaths(h.paths).list()).toHaveLength(0);
    expect(AgentRoutineRegistry.fromShellPaths(h.paths).list()).toHaveLength(0);
  } finally { await h.close(); }
});

test('an unoffered destination cannot become a favorable native create', async () => {
  const h = await fixture({ target: 'unsupported' });
  try {
    await expect(h.run('auto')).rejects.toBeDefined();
    expectNoOwnedWrites(h);
    expect(AgentPersonaRegistry.fromShellPaths(h.paths).list()).toHaveLength(0);
    expect(AgentRoutineRegistry.fromShellPaths(h.paths).list()).toHaveLength(0);
  } finally { await h.close(); }
});

test('a caller callback changing hidden result data is refused by the final post-callback output check', async () => {
  const h = await fixture();
  try {
    let change: (() => void) | undefined;
    h.beforeCurrent(() => { const apply = change; change = undefined; apply?.(); });
    h.inspect(result => {
      if (!('entries' in result)) throw new Error('Expected the native skill result');
      const entry = result.entries[0];
      if (!entry) throw new Error('Expected a durable ledger entry');
      change = () => Object.defineProperty(entry, 'undisplayed', { value: 'Changed after rendering', enumerable: false });
    });
    await expect(h.run('skill')).rejects.toBeDefined();
    expect(h.skills.list()).toHaveLength(3);
    expect(readSkillDraftLedger(h.skills)).toHaveLength(3);
  } finally { await h.close(); }
});


test('an uncertain original grade cannot write a memory or silently substitute default confidence', async () => {
  const h = await fixture({ target: 'memory', gradeConfidence: 0.1 });
  try {
    await expect(h.run('auto')).rejects.toBeDefined();
    expect(h.admissions()).toBe(1);
    expectNoOwnedWrites(h);
    expect(AgentPersonaRegistry.fromShellPaths(h.paths).list()).toHaveLength(0);
    expect(AgentRoutineRegistry.fromShellPaths(h.paths).list()).toHaveLength(0);
  } finally { await h.close(); }
});

test('a stop after the first duplicate is staged reports that write instead of hiding it behind a refusal', async () => {
  const h = await fixture({ duplicatePersonas: true });
  try {
    const personas = () => AgentPersonaRegistry.fromShellPaths(h.paths);
    const staged = () => personas().list().filter(record => record.reviewState === 'stale').length;
    h.beforeCurrent(() => { if (staged() === 1) throw new ToolInputProjectionError('held'); });
    await expect(h.run('auto')).rejects.toBeDefined();
    // The group had two duplicates to stage; the stop came after the first became durable.
    expect(staged()).toBe(1);
    const reported = completedPromotionWrites(h.stops[0]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('consolidated duplicate persona:');
    expect((h.stops[0] as Error).message).toContain('Writes already made before it stopped');
  } finally { await h.close(); }
});

test.each(['persona', 'routine'] as const)('a stop after the first %s promotion is durable reports that write', async target => {
  const h = await fixture({ target });
  try {
    const count = () => (target === 'persona' ? AgentPersonaRegistry.fromShellPaths(h.paths).list() : AgentRoutineRegistry.fromShellPaths(h.paths).list()).length;
    h.beforeCurrent(() => { if (count() === 1) throw new ToolInputProjectionError('held'); });
    await expect(h.run('auto')).rejects.toBeDefined();
    expect(count()).toBe(1);
    const reported = completedPromotionWrites(h.stops[0]);
    expect(reported.join(' ')).toContain(`wrote ${target} for`);
  } finally { await h.close(); }
});
