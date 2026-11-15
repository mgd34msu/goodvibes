import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { ConfigManager, DEFAULT_CONFIG } from '@goodvibes-jev/engine/platform/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/platform/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { createLocalMemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/platform/platform/state';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { judgmentPort, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createAgentLearningConsolidationTool, registerAgentLearningConsolidationTool } from '../../tools/agent-learning-consolidation-tool.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

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
afterEach(cleanupResearchScreeningFixtures);

async function openRegistry(paths: ReturnType<typeof createShellPathService>, file: string): Promise<MemoryRegistry> {
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
  const store = new MemoryStore(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, file), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
  });
  await store.init();
  return new MemoryRegistry(store);
}

describe('agent_learning_consolidation with an adopted daemon', () => {
  test('memory duplicates are read and changed through the memory spine, not the local registry', async () => {
    const root = makeProjectTempDir('goodvibes-agent-learning-consolidation-spine');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      // The daemon's store holds the records; the boot-time local image is empty.
      const local = await openRegistry(paths, 'local-memory.sqlite');
      const daemon = await openRegistry(paths, 'daemon-memory.sqlite');
      const first = await daemon.add({ scope: 'project', cls: 'fact', summary: 'Release checklist', detail: 'Run package verification before release.', tags: ['release'], review: { confidence: 80 } });
      const second = await daemon.add({ scope: 'project', cls: 'fact', summary: 'Release checklist!', detail: 'Also run UX inventory before release.', tags: ['ux'], review: { confidence: 60 } });

      let sequence = 0;
      const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode: 'prompt' as const });
      const reader: PermissionConfigReader = {
        getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory: root }),
        getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => root,
      };
      const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
      const registry = new ToolRegistry(manager); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
      const spine = createLocalMemoryAccess(daemon);
      registerAgentLearningConsolidationTool(registry, paths, local, spine);
      const raw = createAgentLearningConsolidationTool(paths, local, registry, spine);
      const tool: Tool = { ...raw, async execute(args, options) {
        const id = `consolidation-spine-${++sequence}`;
        const call = await registry.prepareCall(id, 'agent_learning_consolidation', args, { signal: options?.signal });
        const admission = await manager.admitAutonomous(id, 'agent_learning_consolidation', call.args, {
          sourceOf: () => ({ goal: 'Verify consolidation through the memory spine', criteria: ['Only modify the temporary fixture stores'] }),
          signal: options?.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
        });
        if (!admission.result.approved) throw new Error(admission.result.reasonCode);
        return registry.executePrepared(call, admission);
      } };

      const preview = await tool.execute({ mode: 'preview', query: 'release checklist' });
      expect(preview.success).toBe(true);
      const candidate = JSON.parse(preview.output ?? '{}') as { readonly candidateId: string; readonly duplicateIds: readonly string[]; readonly survivorId: string };
      expect(candidate.candidateId).toContain('consolidation:memory');
      expect([candidate.survivorId, ...candidate.duplicateIds].sort()).toEqual([first.id, second.id].sort());

      const stale = await tool.execute({ mode: 'stale', candidateId: candidate.candidateId, confirm: true, explicitUserRequest: 'Stage the duplicate memory stale.' });
      expect(stale.success).toBe(true);
      expect(daemon.get(candidate.duplicateIds[0]!)?.reviewState).toBe('stale');
      expect(local.getAll()).toHaveLength(0);

      const deleted = await tool.execute({ mode: 'delete', candidateId: candidate.candidateId, confirm: true, explicitUserRequest: 'Delete the stale duplicate memory.' });
      expect(deleted.success).toBe(true);
      expect(daemon.get(candidate.duplicateIds[0]!)).toBeNull();
      expect(daemon.get(candidate.survivorId)).not.toBeNull();
      expect(local.getAll()).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
