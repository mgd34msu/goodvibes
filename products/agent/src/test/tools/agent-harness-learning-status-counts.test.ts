import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { ToolInputProjectionError, learningCuratorScore } from '@goodvibes-jev/engine/platform/platform/tools';
import { learningProposalQuality } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemoryRecord } from '@goodvibes-jev/engine/platform/platform/state';
import type { JudgmentRequest, Questions } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { buildLearningCandidateCounts, buildLearningCandidates, assertLearningCandidateCollection } from '../../tools/agent-harness-learning-curator-proposals.ts';
import type { LearningCandidate } from '../../tools/agent-harness-learning-curator-types.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { try { await cleanupResearchScreeningFixtures(); } finally { installJudgmentPort(previous); } });

function readings() {
  return fakePort((name, question) => {
    if (question.type === 'score') return scoreAnswer(question, name === 'link' ? 2 : 3, 0.9999);
    if (question.type === 'noul') return noulAnswer(name.startsWith('item_') ? 0.0001 : 0.9999);
    return choiceAnswer(question, name === 'target' ? 'memory' : name === 'memory_class' ? 'decision' : '0', 0.9999);
  });
}
function grading(request: JudgmentRequest<Questions>): boolean {
  return request.context?.battery === learningCuratorScore.name || request.context?.battery === learningProposalQuality.name;
}
function memory(id: string, confidence = 90): MemoryRecord {
  return { id, summary: 'Retain the authored release procedure.', detail: `Complete source evidence ${id}.`, tags: [], provenance: [],
    scope: 'project', cls: 'fact', reviewState: 'fresh', confidence, createdAt: 1, updatedAt: 1 };
}
function expectedCounts(candidates: readonly LearningCandidate[], classic = false) {
  const count = (status: LearningCandidate['status']) => candidates.filter(candidate => candidate.status === status).length;
  return { candidates: candidates.length, needsReview: count('needs-review'), needsSetup: count('needs-setup'),
    needsConsolidation: classic ? null : count('needs-consolidation'), lowConfidence: count('low-confidence'),
    proposedBehavior: classic ? null : count('proposal-ready'), personalityIssues: candidates.filter(candidate => candidate.domain === 'vibe').length,
    readyToPromote: count('ready-to-promote') };
}

test('aggregate counts preserve every classified status while omitting both unused grading families and transition capabilities', async () => {
  const root = makeProjectTempDir('learning-status-counts');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const notes = AgentNoteRegistry.fromShellPaths(paths), skills = AgentSkillRegistry.fromShellPaths(paths);
  const note = notes.create({ title: 'Reviewed authored source', body: 'Use the release procedure for this project.', sourceUrl: 'https://example.test/manual', source: 'user' });
  notes.markReviewed(note.id);
  skills.create({ name: 'Authored command procedure', description: 'Requires a local command.', procedure: 'Run the local command.',
    enabled: true, requirements: [{ kind: 'command', name: 'missing-learning-counts-fixture-command' }], source: 'user' });
  const first = memory('one', 42), memories = [first, memory('two')];
  const work = { id: 'completed-authored-work', title: 'Keep the release procedure', status: 'done' as const,
    notes: 'Use the authored project release procedure.', createdAt: 1, updatedAt: 1, completedAt: 1 };
  const context = { workspace: { shellPaths: paths, workPlanStore: { listItems: () => [work] } },
    clients: { agentKnowledgeApi: { memory: { getAll: () => memories } } } };
  const port = readings(); installJudgmentPort(port.port);
  const options = { sourceOwner: ordinaryResearchOwner() };
  const ranked = await buildLearningCandidates(context, options); ranked.assertCurrent();
  const all = expectedCounts(ranked.candidates);
  for (const key of ['needsReview', 'needsSetup', 'needsConsolidation', 'lowConfidence', 'proposedBehavior', 'readyToPromote'] as const) expect(all[key]).toBeGreaterThan(0);
  expect(port.requests.filter(grading).length).toBeGreaterThan(0);
  expect(ranked.promptRecords.length).toBeGreaterThan(0);
  expect(ranked.candidates.every(candidate => typeof candidate.priority === 'number' && candidate.scores !== null)).toBe(true);
  const required = port.requests.filter(request => !grading(request)).map(request => Object.keys(request.questions));
  port.requests.length = 0;
  const counts = await buildLearningCandidateCounts(context, options); counts.assertCurrent();
  const { assertCurrent: _assertCurrent, ...actual } = counts;
  expect(actual).toEqual(all); expect(port.requests.filter(grading)).toEqual([]);
  expect(port.requests.map(request => Object.keys(request.questions))).toEqual(required);
  expect(Object.isFrozen(counts)).toBe(true);
  expect(Object.keys(counts).sort()).toEqual(['assertCurrent', ...Object.keys(all)].sort());
  expect(() => Reflect.apply(assertLearningCandidateCollection, undefined, [counts, context, options])).toThrow(ToolInputProjectionError);
  Object.defineProperty(first, 'detail', { value: 'A genuine changed source after the original operation.' });
  expect(counts.assertCurrent).toThrow(ToolInputProjectionError);
});

test.each(['empty', 'classic'] as const)('count-only %s inspection remains equivalent without fabricated scores or model calls', async mode => {
  const port = readings(); installJudgmentPort(port.port);
  const context = mode === 'empty' ? {} : { clients: { agentKnowledgeApi: { memory: { getAll: () => [memory('classic-memory')] } } } };
  const run = async () => {
    const options = { sourceOwner: ordinaryResearchOwner() };
    const ranked = await buildLearningCandidates(context, options); ranked.assertCurrent();
    const expected = expectedCounts(ranked.candidates, mode === 'classic');
    port.requests.length = 0;
    const counts = await buildLearningCandidateCounts(context, options); counts.assertCurrent();
    const { assertCurrent: _assertCurrent, ...actual } = counts;
    expect(actual).toEqual(expected); expect(port.requests).toEqual([]);
    expect('prepareTransition' in counts).toBe(false); expect('candidates' in counts && typeof counts.candidates).toBe('number');
  };
  if (mode === 'classic') await withDecisionModelPolicy(() => 'Classic - Off', run); else await run();
});

test.each(['hidden-private', 'redacted'] as const)('count-only status retains complete %s source protection before any decision', async mode => {
  const record = memory('protected-source');
  const marker = 'Synthetic content selected for actual source redaction.';
  if (mode === 'hidden-private') Object.defineProperty(record, 'opaque', { value: { original: '4111111111111111' }, enumerable: false });
  else Object.defineProperty(record, 'detail', { value: marker });
  const privacy = researchScreeningFixture({ spans: mode === 'redacted' ? exactSensitiveSpans([marker]) : undefined });
  const port = readings(); installJudgmentPort(port.port);
  const context = { clients: { agentKnowledgeApi: { memory: { getAll: () => [record] } } } };
  const pending = buildLearningCandidateCounts(context, { sourceOwner: privacy.owner });
  if (mode === 'hidden-private') await expect(pending).rejects.toMatchObject({ name: 'JudgmentInputError', problem: 'card-material' });
  else await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
  expect(port.requests).toHaveLength(0); expect(record.detail).toBe(mode === 'redacted' ? marker : 'Complete source evidence protected-source.');
});

test.each(['source', 'cancel'] as const)('count-only source screening holds an actual %s retirement and drains its original receipt', async mode => {
  const record = memory('original-source'), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let entered = false;
  const privacy = researchScreeningFixture({ async beforeProposal() { if (!entered) { entered = true; started.resolve(); await release.promise; } } });
  const controller = new AbortController(), port = readings(); installJudgmentPort(port.port);
  const pending = buildLearningCandidateCounts({ clients: { agentKnowledgeApi: { memory: { getAll: () => [record] } } } },
    { sourceOwner: privacy.owner, signal: controller.signal });
  const observed = pending.catch(error => error);
  try {
    await started.promise;
    if (mode === 'source') Object.defineProperty(record, 'summary', { value: 'Changed original source during actual screening.' }); else controller.abort();
    release.resolve();
    const failure: unknown = await observed;
    expect(failure).toBeInstanceOf(Error); expect(port.requests).toHaveLength(0);
  } finally { release.resolve(); await observed; }
});
