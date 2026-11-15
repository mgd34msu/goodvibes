import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { ConfigManager, DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/platform/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/platform/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/platform/platform/state';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { writeReceipt } from '../../tools/agent-learning-consolidation-core.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import {
  createAgentLearningConsolidationTool,
  registerAgentLearningConsolidationTool,
} from '../../tools/agent-learning-consolidation-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    if (name === 'match') return noulAnswer(0.99);
    if (question.type === 'score' && ['usefulness', 'freshness', 'source_quality', 'risk', 'priority', 'confidence', 'link'].includes(name)) {
      return scoreAnswer(question, name === 'risk' ? 0 : name === 'link' ? 2 : 4, 0.999);
    }
    if ((name === 'same_record' || name.startsWith('fits_')) && question.type === 'noul') return noulAnswer(0.999);
    if (question.type === 'choice') {
      const label = Object.hasOwn(question.criteria, '0') ? '0' : name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'hazard' ? 'none' : 'generic';
      return choiceAnswer(question, label, 0.999);
    }
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unscripted consolidation reading ${name}`);
  }).port, log));
});
afterEach(() => { installJudgmentPort(previousPort); log[Symbol.dispose](); });
afterAll(cleanupResearchScreeningFixtures);

type ShellPaths = ReturnType<typeof createShellPathService>;

interface Fixture {
  readonly root: string;
  readonly paths: ShellPaths;
  readonly memoryRegistry: MemoryRegistry;
  readonly tool: ReturnType<typeof createAgentLearningConsolidationTool>;
  readonly rawTool: Tool;
  readonly setMode: (mode: PermissionMode) => void;
  readonly cleanup: () => void;
}

async function createMemoryRegistry(paths: ShellPaths): Promise<MemoryRegistry> {
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const store = new MemoryStore(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite'), { embeddingRegistry });
  await store.init();
  return new MemoryRegistry(store);
}

async function makeFixture(): Promise<Fixture> {
  const root = makeProjectTempDir('goodvibes-agent-learning-consolidation');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const memoryRegistry = await createMemoryRegistry(paths);
  let mode: PermissionMode = 'prompt'; let sequence = 0;
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory: root }),
    getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => root,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
  registerAgentLearningConsolidationTool(registry, paths, memoryRegistry);
  const rawTool = createAgentLearningConsolidationTool(paths, memoryRegistry, registry);
  const tool: Tool = { ...rawTool, async execute(args, options) {
    const id = `consolidation-effect-${++sequence}`;
    const call = await registry.prepareCall(id, 'agent_learning_consolidation', args, { signal: options?.signal });
    const admission = await manager.admitAutonomous(id, 'agent_learning_consolidation', call.args, {
      sourceOf: () => ({ goal: 'Verify isolated local consolidation phases', criteria: ['Only modify the temporary fixture stores'] }),
      signal: options?.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    if (!admission.result.approved) throw new Error(admission.result.reasonCode);
    return registry.executePrepared(call, admission);
  } };
  return {
    root,
    paths,
    memoryRegistry,
    tool, rawTool, setMode(next) { mode = next; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedDuplicateSkills(paths: ShellPaths): { readonly survivorId: string; readonly duplicateId: string } {
  const registry = AgentSkillRegistry.fromShellPaths(paths);
  const survivor = registry.create({
    name: 'Release checklist',
    description: 'Run package verification before release.',
    procedure: 'Run package verification and summarize release risks.',
    tags: ['release'],
    triggers: ['release'],
    enabled: true,
    source: 'agent',
  });
  registry.markReviewed(survivor.id);
  const duplicate = registry.create({
    name: 'Release checklist!',
    description: 'Also run UX inventory before release.',
    procedure: 'Run UX inventory and package verification.',
    tags: ['ux-inventory'],
    triggers: ['ux'],
    source: 'agent',
  });
  return { survivorId: survivor.id, duplicateId: duplicate.id };
}

function seedTwoDuplicateSkills(paths: ShellPaths): readonly string[] {
  const { duplicateId } = seedDuplicateSkills(paths);
  const second = AgentSkillRegistry.fromShellPaths(paths).create({
    name: 'Release checklist?',
    description: 'Also confirm the changelog before release.',
    procedure: 'Confirm the changelog and run package verification.',
    tags: ['changelog'],
    triggers: ['changelog'],
    source: 'agent',
  });
  return [duplicateId, second.id];
}

/** Runs `change` once, after the named registry method has completed its first call. */
function afterFirstCall<T extends object>(target: T, method: keyof T & string, change: () => void): () => void {
  const original = target[method] as unknown as (...args: unknown[]) => unknown;
  let calls = 0;
  (target as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (++calls === 1) change();
    return result;
  };
  return () => { (target as Record<string, unknown>)[method] = original; };
}


interface Outcome { readonly success: boolean; readonly output?: string; readonly error?: string }
const json = (outcome: Outcome): Record<string, unknown> => JSON.parse(outcome.output ?? '{}') as Record<string, unknown>;

describe('agent_learning_consolidation receipts around a phase', () => {
  test('a phase whose receipt cannot be written changes nothing, and the retry records its own receipt first', async () => {
    const fixture = await makeFixture();
    const learningDir = fixture.paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning');
    try {
      const ids = seedDuplicateSkills(fixture.paths);
      const preview = json(await fixture.tool.execute({ mode: 'preview', query: 'release checklist' }));
      const candidateId = String(preview.candidateId);
      mkdirSync(learningDir, { recursive: true }); chmodSync(learningDir, 0o500);
      const blocked = await fixture.tool.execute({ mode: 'stale', candidateId, explicitUserRequest: 'Stage the duplicate.' });
      expect(blocked.success).toBe(false);
      // The receipt is the only pre-image, so no record is touched before it exists.
      expect(AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.duplicateId)?.reviewState).toBe('fresh');
      chmodSync(learningDir, 0o700);
      const staged = json(await fixture.tool.execute({ mode: 'stale', candidateId, explicitUserRequest: 'Stage the duplicate.' }));
      expect(staged.status).toBe('applied');
      expect(AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.duplicateId)?.reviewState).toBe('stale');
    } finally { try { chmodSync(learningDir, 0o700); } catch { /* never created */ } fixture.cleanup(); }
  }, 240_000);

  test('a rollback is recorded once, cannot be repeated, and receipts cannot be rolled back', async () => {
    const fixture = await makeFixture();
    try {
      const ids = seedDuplicateSkills(fixture.paths);
      const preview = json(await fixture.tool.execute({ mode: 'preview', query: 'release checklist' }));
      const staged = json(await fixture.tool.execute({ mode: 'stale', candidateId: String(preview.candidateId), explicitUserRequest: 'Stage the duplicate.' }));
      const staleReceiptId = String((staged.receipt as { receiptId: string }).receiptId);
      const rolledBack = json(await fixture.tool.execute({ mode: 'rollback', receiptId: staleReceiptId, explicitUserRequest: 'Undo staging.' }));
      expect(rolledBack.status).toBe('applied');
      expect(AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.duplicateId)?.reviewState).toBe('fresh');
      const listed = json(await fixture.tool.execute({ mode: 'receipts' })) as { receipts: Array<{ receiptId: string; phase: string }> };
      const rollbackReceipt = listed.receipts.find((entry) => entry.phase === 'rollback');
      expect(rollbackReceipt).toBeDefined();
      const again = await fixture.tool.execute({ mode: 'rollback', receiptId: staleReceiptId, explicitUserRequest: 'Undo staging again.' });
      expect(again.success).toBe(false);
      expect(again.error).toContain('already rolled back');
      const ofRollback = await fixture.tool.execute({ mode: 'rollback', receiptId: rollbackReceipt!.receiptId, explicitUserRequest: 'Undo the undo.' });
      expect(ofRollback.success).toBe(false);
      expect(ofRollback.error).toContain('only merge and stale receipts');
    } finally { fixture.cleanup(); }
  }, 240_000);

  test('rolling back after the staged duplicate was deleted refuses instead of reporting restored ids', async () => {
    const fixture = await makeFixture();
    try {
      const ids = seedDuplicateSkills(fixture.paths);
      const preview = json(await fixture.tool.execute({ mode: 'preview', query: 'release checklist' }));
      const staged = json(await fixture.tool.execute({ mode: 'stale', candidateId: String(preview.candidateId), explicitUserRequest: 'Stage the duplicate.' }));
      AgentSkillRegistry.fromShellPaths(fixture.paths).deleteSkill(ids.duplicateId);
      const result = await fixture.tool.execute({ mode: 'rollback', receiptId: String((staged.receipt as { receiptId: string }).receiptId), explicitUserRequest: 'Undo staging.' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('no longer exist');
    } finally { fixture.cleanup(); }
  }, 240_000);
});

describe('agent_learning_consolidation rollback of a merge receipt', () => {
  const mergeReceipt = (ids: { survivorId: string; duplicateId: string }, extra: Record<string, unknown>) => ({
    id: 'lcon-merge-seeded', createdAt: '2026-01-01T00:00:00.000Z', domain: 'skill' as const, candidateId: 'consolidation:skill:release-checklist',
    phase: 'merge' as const, explicitUserRequest: 'Merge.', survivorId: ids.survivorId, duplicateIds: [ids.duplicateId],
    beforeSurvivor: { description: 'Old description.', tags: ['old'], triggers: ['old'] }, beforeDuplicates: [], ...extra,
  });

  test('a merge receipt without the post-merge survivor is refused and the survivor keeps its later edits', async () => {
    const fixture = await makeFixture();
    try {
      const ids = seedDuplicateSkills(fixture.paths);
      writeReceipt(fixture.paths, mergeReceipt(ids, {}));
      const result = await fixture.tool.execute({ mode: 'rollback', receiptId: 'lcon-merge-seeded', explicitUserRequest: 'Undo the merge.' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be checked for later edits');
      expect(AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.survivorId)?.description).toBe('Run package verification before release.');
    } finally { fixture.cleanup(); }
  }, 240_000);

  test('a merge receipt is refused when the survivor changed after the merge and restores it when it did not', async () => {
    const fixture = await makeFixture();
    try {
      const ids = seedDuplicateSkills(fixture.paths);
      const registry = AgentSkillRegistry.fromShellPaths(fixture.paths);
      const left = registry.get(ids.survivorId)!;
      writeReceipt(fixture.paths, mergeReceipt(ids, { afterSurvivor: { description: 'As the merge left it.', tags: left.tags, triggers: left.triggers } }));
      const refused = await fixture.tool.execute({ mode: 'rollback', receiptId: 'lcon-merge-seeded', explicitUserRequest: 'Undo the merge.' });
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('was changed after the merge (description)');
      expect(registry.get(ids.survivorId)?.description).toBe('Run package verification before release.');
      writeReceipt(fixture.paths, mergeReceipt(ids, { id: 'lcon-merge-unchanged', afterSurvivor: { description: left.description, tags: left.tags, triggers: left.triggers } }));
      const restored = json(await fixture.tool.execute({ mode: 'rollback', receiptId: 'lcon-merge-unchanged', explicitUserRequest: 'Undo the merge.' }));
      expect(restored.status).toBe('applied');
      expect(registry.get(ids.survivorId)?.description).toBe('Old description.');
    } finally { fixture.cleanup(); }
  }, 240_000);
});

describe('agent_learning_consolidation phases that stop part-way', () => {
  test.each(['host hold', 'failure'] as const)('a stale phase that hits a %s after the first duplicate names what changed and the receipt', async (how) => {
    const fixture = await makeFixture();
    const proto = AgentSkillRegistry.prototype;
    let restore = () => {};
    try {
      const duplicates = seedTwoDuplicateSkills(fixture.paths);
      const preview = json(await fixture.tool.execute({ mode: 'preview', query: 'release checklist' }));
      expect((preview.duplicateIds as string[] | undefined)?.length ?? 2).toBeGreaterThanOrEqual(2);
      restore = afterFirstCall(proto, 'markStale', () => {
        // Another writer touching the receipts file makes the next write a host hold (projection stale).
        if (how === 'host hold') writeReceipt(fixture.paths, { id: 'lcon-other', createdAt: '2026-01-01T00:00:00.000Z', domain: 'skill', candidateId: 'other', phase: 'stale',
          explicitUserRequest: 'Other.', survivorId: 'a', duplicateIds: ['b'], beforeDuplicates: [] });
        else proto.markStale = () => { throw new Error('disk full'); };
      });
      const result = await fixture.tool.execute({ mode: 'stale', candidateId: String(preview.candidateId), explicitUserRequest: 'Stage the duplicates.' });
      restore();
      expect(result.success).toBe(false);
      expect(result.error).toContain('stale stopped part-way');
      if (how === 'host hold') expect(result.error).toContain('the host stopped the call (stale)');
      expect(result.error).toMatch(/Already changed: \S+\./);
      expect(result.error).toMatch(/Receipt lcon-stale-/);
      const states = duplicates.map((id) => AgentSkillRegistry.fromShellPaths(fixture.paths).get(id)?.reviewState);
      expect(states.filter((state) => state === 'stale')).toHaveLength(1);
      const listed = json(await fixture.tool.execute({ mode: 'receipts' })) as { receipts: Array<{ receiptId: string; phase: string }> };
      const own = listed.receipts.filter((entry) => entry.receiptId.startsWith('lcon-stale-'));
      expect(own).toHaveLength(1);
      expect(result.error).toContain(own[0]!.receiptId);
    } finally { restore(); fixture.cleanup(); }
  }, 240_000);

  test('a delete phase writes its receipt before the first delete and names the receipt when it stops part-way', async () => {
    const fixture = await makeFixture();
    const proto = AgentSkillRegistry.prototype;
    let restore = () => {};
    try {
      const duplicates = seedTwoDuplicateSkills(fixture.paths);
      const preview = json(await fixture.tool.execute({ mode: 'preview', query: 'release checklist' }));
      const candidateId = String(preview.candidateId);
      json(await fixture.tool.execute({ mode: 'stale', candidateId, explicitUserRequest: 'Stage the duplicates.' }));
      restore = afterFirstCall(proto, 'deleteSkill', () => { proto.deleteSkill = () => { throw new Error('disk full'); }; });
      const result = await fixture.tool.execute({ mode: 'delete', candidateId, explicitUserRequest: 'Delete the duplicates.' });
      restore();
      expect(result.success).toBe(false);
      expect(result.error).toContain('delete stopped part-way: disk full.');
      const listed = json(await fixture.tool.execute({ mode: 'receipts' })) as { receipts: Array<{ receiptId: string; phase: string }> };
      const deleteReceipt = listed.receipts.find((entry) => entry.phase === 'delete');
      expect(deleteReceipt).toBeDefined();
      expect(result.error).toContain(deleteReceipt!.receiptId);
      const remaining = duplicates.filter((id) => AgentSkillRegistry.fromShellPaths(fixture.paths).get(id));
      expect(remaining).toHaveLength(1);
      expect(result.error).toContain(duplicates.find((id) => !remaining.includes(id))!);
    } finally { restore(); fixture.cleanup(); }
  }, 240_000);

  test('a recreate that stops part-way, even on a host hold, names the records already recreated', async () => {
    const fixture = await makeFixture();
    const proto = AgentSkillRegistry.prototype;
    let restore = () => {};
    try {
      const registry = AgentSkillRegistry.fromShellPaths(fixture.paths);
      const snapshots = ['Release checklist', 'Changelog review'].map((name) => {
        const created = registry.create({ name, description: `${name} description.`, procedure: `${name} procedure.`, source: 'agent' });
        return JSON.parse(JSON.stringify(created)) as Record<string, unknown>;
      });
      for (const snapshot of snapshots) registry.deleteSkill(String(snapshot.id));
      writeReceipt(fixture.paths, { id: 'lcon-delete-1-skills', createdAt: '2026-01-01T00:00:00.000Z', domain: 'skill', candidateId: 'skills', phase: 'delete',
        explicitUserRequest: 'Delete duplicates.', survivorId: 'keep', duplicateIds: snapshots.map((snapshot) => String(snapshot.id)), beforeDuplicates: snapshots });
      restore = afterFirstCall(proto, 'create', () => writeReceipt(fixture.paths, { id: 'lcon-other', createdAt: '2026-01-01T00:00:00.000Z', domain: 'skill', candidateId: 'other', phase: 'stale',
        explicitUserRequest: 'Other.', survivorId: 'a', duplicateIds: ['b'], beforeDuplicates: [] }));
      const result = await fixture.tool.execute({ mode: 'recreate', receiptId: 'lcon-delete-1-skills', explicitUserRequest: 'Bring them back.' });
      restore();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Recreate stopped part-way');
      expect(result.error).toContain(`Already recreated: ${String(snapshots[0]!.id)}.`);
      expect(result.error).toContain('lcon-delete-1-skills');
    } finally { restore(); fixture.cleanup(); }
  }, 240_000);

  test('a recreate of stale snapshots stopped before the review state is restored still names the created record', async () => {
    const fixture = await makeFixture();
    const proto = AgentSkillRegistry.prototype;
    let restore = () => {};
    try {
      const registry = AgentSkillRegistry.fromShellPaths(fixture.paths);
      const created = registry.create({ name: 'Release checklist', description: 'Release checklist description.', procedure: 'Release checklist procedure.', source: 'agent' });
      const snapshot = { ...(JSON.parse(JSON.stringify(created)) as Record<string, unknown>), reviewState: 'stale', staleReason: 'Duplicate.' };
      registry.deleteSkill(created.id);
      writeReceipt(fixture.paths, { id: 'lcon-delete-1-stale', createdAt: '2026-01-01T00:00:00.000Z', domain: 'skill', candidateId: 'skills', phase: 'delete',
        explicitUserRequest: 'Delete duplicates.', survivorId: 'keep', duplicateIds: [created.id], beforeDuplicates: [snapshot] });
      restore = afterFirstCall(proto, 'create', () => writeReceipt(fixture.paths, { id: 'lcon-other', createdAt: '2026-01-01T00:00:00.000Z', domain: 'skill', candidateId: 'other', phase: 'stale',
        explicitUserRequest: 'Other.', survivorId: 'a', duplicateIds: ['b'], beforeDuplicates: [] }));
      const result = await fixture.tool.execute({ mode: 'recreate', receiptId: 'lcon-delete-1-stale', explicitUserRequest: 'Bring it back.' });
      restore();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Recreate stopped part-way');
      expect(result.error).toContain(`Already recreated: ${created.id}.`);
      expect(result.error).toContain('lcon-delete-1-stale');
    } finally { restore(); fixture.cleanup(); }
  }, 240_000);

  test('a recreate of fresh snapshots stopped at its final receipt still names the created record', async () => {
    const fixture = await makeFixture();
    const proto = AgentSkillRegistry.prototype;
    let restore = () => {};
    try {
      const registry = AgentSkillRegistry.fromShellPaths(fixture.paths);
      const created = registry.create({ name: 'Release checklist', description: 'Release checklist description.', procedure: 'Release checklist procedure.', source: 'agent' });
      const snapshot = JSON.parse(JSON.stringify(created)) as Record<string, unknown>;
      registry.deleteSkill(created.id);
      writeReceipt(fixture.paths, { id: 'lcon-delete-1-fresh', createdAt: '2026-01-01T00:00:00.000Z', domain: 'skill', candidateId: 'skills', phase: 'delete',
        explicitUserRequest: 'Delete duplicates.', survivorId: 'keep', duplicateIds: [created.id], beforeDuplicates: [snapshot] });
      // No review state is restored for a fresh snapshot, so the next guarded write is the final receipt.
      restore = afterFirstCall(proto, 'create', () => writeReceipt(fixture.paths, { id: 'lcon-other', createdAt: '2026-01-01T00:00:00.000Z', domain: 'skill', candidateId: 'other', phase: 'stale',
        explicitUserRequest: 'Other.', survivorId: 'a', duplicateIds: ['b'], beforeDuplicates: [] }));
      const result = await fixture.tool.execute({ mode: 'recreate', receiptId: 'lcon-delete-1-fresh', explicitUserRequest: 'Bring it back.' });
      restore();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Recreate stopped part-way');
      expect(result.error).toContain(`Already recreated: ${created.id}.`);
      expect(result.error).toContain('lcon-delete-1-fresh');
    } finally { restore(); fixture.cleanup(); }
  }, 240_000);
});

describe('agent_learning_consolidation recreate', () => {
  test('a memory recreate that imported fewer records than the receipt holds is not reported as applied', async () => {
    const fixture = await makeFixture();
    try {
      writeReceipt(fixture.paths, { id: 'lcon-delete-1-gone', createdAt: '2026-01-01T00:00:00.000Z', domain: 'memory', candidateId: 'gone', phase: 'delete',
        explicitUserRequest: 'Delete duplicates.', survivorId: 'keep', duplicateIds: ['mem-gone'],
        beforeDuplicates: [{ id: 'mem-gone', summary: 'Release day is Thursday.', cls: 'fact', scope: 'project', tags: [], provenance: [] }] });
      fixture.memoryRegistry.importBundle = async () => ({ importedRecords: 0, skippedRecords: 1, importedLinks: 0, skippedLinks: 0 } as Awaited<ReturnType<typeof fixture.memoryRegistry.importBundle>>);
      const result = await fixture.tool.execute({ mode: 'recreate', receiptId: 'lcon-delete-1-gone', explicitUserRequest: 'Bring the record back.' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('imported 0 of 1');
      const listed = json(await fixture.tool.execute({ mode: 'receipts' })) as { receipts: Array<{ phase: string }> };
      expect(listed.receipts.map((entry) => entry.phase)).toEqual(['delete']);
    } finally { fixture.cleanup(); }
  }, 120_000);
});
