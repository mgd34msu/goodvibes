/** Operator decisions on consolidation candidates. Synthetic storage and explicit readings only. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import {
  decideKnowledgeConsolidationCandidate as decide,
  refreshKnowledgeConsolidationCandidates as refresh,
  type KnowledgeConsolidationContext,
} from '../platform/src/platform/knowledge/consolidation.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../platform/src/platform/state/index.js';
import { authoredPrivacyAnswer } from './_helpers/authored-error-readings.js';

const roots: string[] = [];
const memories: MemoryStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const memory of memories.splice(0)) memory.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function readings() {
  const readPrivacy = authoredPrivacyAnswer({ parts: [] });
  installJudgmentPort(fakePort((name, question, state) => {
    if (name === 'keep') return noulAnswer(0.97);
    if (name === 'memory_class') return choiceAnswer(question, 'architecture', 0.97);
    if (name === 'kind') return readPrivacy(name, question, state);
    throw new Error(`Unexpected fixture question: ${name}`);
  }).port);
}

async function harness(status: 'indexed' | 'stale') {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-consolidation-decisions-'));
  roots.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const memory = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }), enableVectorIndex: false,
  });
  memories.push(memory);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  await store.init();
  const context: KnowledgeConsolidationContext = { store, memoryRegistry: new MemoryRegistry(memory), syncReviewedMemory: async () => {} };
  const source = await store.upsertSource({ connectorId: 'url', sourceType: 'url', title: 'Outbox invariant', summary: 'Persist order and outbox event in one transaction.', sessionId: 'synthetic-session', status });
  await store.upsertUsageRecord({ targetKind: 'source', targetId: source.id, usageKind: 'search-hit', sessionId: 'synthetic-session', score: 1 });
  readings();
  const [candidate] = await refresh(context);
  return { context, store, memory, candidate: candidate! };
}

describe('consolidation candidate decisions', () => {
  test('accepting a source-refresh candidate refreshes that source; without a refresh owner it stays open', async () => {
    const h = await harness('stale');
    expect(h.candidate.candidateType).toBe('source-refresh');
    await expect(decide(h.context, h.candidate.id, 'accept')).rejects.toThrow();
    expect(h.store.getConsolidationCandidate(h.candidate.id)?.status).toBe('open');
    const refreshed: string[] = [];
    const wired = { ...h.context, refreshSource: async (id: string) => { refreshed.push(id); return 1; } };
    expect((await decide(wired, h.candidate.id, 'accept')).status).toBe('accepted');
    expect(refreshed).toEqual([h.candidate.subjectId]);
    expect(h.memory.retrieve()).toHaveLength(0);
  });

  test('an unknown memory class or scope is refused before anything is written', async () => {
    const h = await harness('indexed');
    expect(h.candidate.candidateType).toBe('memory-promotion');
    await expect(decide(h.context, h.candidate.id, 'accept', { memoryClass: 'bogus' })).rejects.toThrow();
    await expect(decide(h.context, h.candidate.id, 'accept', { scope: 'galaxy' })).rejects.toThrow();
    expect(h.store.getConsolidationCandidate(h.candidate.id)?.status).toBe('open');
    expect(h.memory.retrieve()).toHaveLength(0);
    const accepted = await decide(h.context, h.candidate.id, 'accept', { memoryClass: 'runbook', scope: 'team' });
    expect(accepted.status).toBe('accepted');
    expect(h.memory.retrieve()[0]?.cls).toBe('runbook');
  });
});
