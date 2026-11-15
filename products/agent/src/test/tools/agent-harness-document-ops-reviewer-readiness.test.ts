import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { CommandContext } from '../../input/command-registry.ts';
import { buildReviewerReadinessChecklist } from '../../tools/agent-harness-document-ops-reviewer-readiness.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const READY = { documentsReady: true, modelCompareReady: true, artifactBrowserReady: true };

function artifact(id: string, metadata: Record<string, unknown>): ArtifactDescriptor {
  return { id, kind: 'data', mimeType: 'application/json', sizeBytes: 2, createdAt: 1, acquisitionMode: 'generated', fetchMode: 'none', metadata } as unknown as ArtifactDescriptor;
}
function contextWith(list: (limit?: number) => readonly ArtifactDescriptor[], resolveProjectPath?: (...parts: string[]) => string): CommandContext {
  const root = makeProjectTempDir('reviewer-readiness');
  return {
    workspace: { shellPaths: { resolveProjectPath: resolveProjectPath ?? ((...parts: string[]) => join(root, ...parts)) } },
    platform: { artifactStore: { list, readContent: () => null } },
  } as unknown as CommandContext;
}
const check = (checklist: ReturnType<typeof buildReviewerReadinessChecklist>, id: string) => {
  const found = checklist.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};

describe('reviewer readiness', () => {
  test('an unreadable document registry or a cut-off artifact list can never read as ready', () => {
    const clean = buildReviewerReadinessChecklist(contextWith(() => []), READY);
    expect(clean.status).toBe('ready');
    expect(clean.readProblems).toBeUndefined();

    const unreadableDocuments = buildReviewerReadinessChecklist(contextWith(() => [], () => { throw new Error('disk gone'); }), READY);
    expect(unreadableDocuments.status).toBe('attention');
    expect(unreadableDocuments.readProblems?.join(' ')).toContain('disk gone');
    expect(check(unreadableDocuments, 'document-review-state')).toMatchObject({ status: 'attention' });
    expect(check(unreadableDocuments, 'document-review-state').detail).toContain('Not verified');

    // The store holds more artifacts than one pass inspects: the pass must say so rather than report clear.
    const many = Array.from({ length: 1001 }, (_, index) => artifact(`a${index}`, { purpose: 'other' }));
    const cutOff = buildReviewerReadinessChecklist(contextWith((limit) => many.slice(0, limit)), READY);
    expect(cutOff.status).toBe('attention');
    expect(cutOff.readProblems?.join(' ')).toContain('1000');
    expect(check(cutOff, 'comparison-reveal').detail).toContain('Not verified');

    const throwingStore = buildReviewerReadinessChecklist(contextWith(() => { throw new Error('store offline'); }), READY);
    expect(throwingStore.status).toBe('attention');
    expect(check(throwingStore, 'handoff-archive-evidence').detail).toContain('Not verified');
  });

  test('revealed judgments are counted separately from those still awaiting a route decision', () => {
    const revealed = (id: string, comparisonId: string) => artifact(id, {
      purpose: 'agent-model-compare-judgment', comparisonId, revealIncludedInJudgment: true, winnerModel: 'openai:gpt-4.1',
    });
    const decision = artifact('decision-1', { purpose: 'agent-model-compare-route-decision', comparisonId: 'cmp-decided', judgmentArtifactId: 'judged-and-decided' });
    const checklist = buildReviewerReadinessChecklist(contextWith(() => [revealed('judged-and-decided', 'cmp-decided'), revealed('judged-waiting', 'cmp-waiting'), decision]), READY);
    expect(checklist.summary.revealedJudgments).toBe(2);
    expect(checklist.summary.judgmentsAwaitingRouteDecision).toBe(1);
    expect(check(checklist, 'route-change-decision').count).toBe(1);
  });

  test('a route decision saved before purpose was recorded still settles its judgment', () => {
    const revealed = artifact('judged-legacy', {
      purpose: 'agent-model-compare-judgment', comparisonId: 'cmp-1', revealIncludedInJudgment: true, winnerModel: 'openai:gpt-4.1',
    });
    const legacyDecision = { ...artifact('decision-legacy', { comparisonId: 'cmp-1', judgmentArtifactId: 'judged-legacy' }), filename: 'blind-model-comparison-route-decision-1.json' } as ArtifactDescriptor;
    const waiting = buildReviewerReadinessChecklist(contextWith(() => [revealed]), READY);
    expect(waiting.summary.judgmentsAwaitingRouteDecision).toBe(1);
    const settled = buildReviewerReadinessChecklist(contextWith(() => [revealed, legacyDecision]), READY);
    expect(settled.summary.judgmentsAwaitingRouteDecision).toBe(0);
  });
});
