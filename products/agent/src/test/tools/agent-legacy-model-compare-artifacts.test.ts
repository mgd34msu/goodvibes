import { describe, expect, test } from 'bun:test';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { isModelCompareRouteDecisionArtifact } from '../../input/agent-workspace-review-packet-utils.ts';
import { isModelCompareJudgmentArtifact, localModelBenchmarkSnapshot } from '../../tools/agent-harness-local-model-benchmarks.ts';

const artifact = (filename: string, metadata: Record<string, unknown>): ArtifactDescriptor => ({ id: 'a1', filename, metadata } as unknown as ArtifactDescriptor);

describe('comparison artifacts saved before purpose was recorded', () => {
  test('a legacy route decision is recognised by its filename, a recorded other purpose is not', () => {
    expect(isModelCompareRouteDecisionArtifact(artifact('blind-model-comparison-route-decision-1.json', {}))).toBe(true);
    expect(isModelCompareRouteDecisionArtifact(artifact('blind-model-comparison-route-decision-1.json', { purpose: 'agent-model-compare' }))).toBe(false);
    expect(isModelCompareRouteDecisionArtifact(artifact('notes.json', {}))).toBe(false);
  });
  test('a legacy judgment is recognised by its filename', () => {
    expect(isModelCompareJudgmentArtifact(artifact('blind-model-comparison-judgment-1.json', {}))).toBe(true);
    expect(isModelCompareJudgmentArtifact(artifact('blind-model-comparison-judgment-1.json', { purpose: 'agent-model-compare' }))).toBe(false);
  });
  test('a legacy judgment of a local benchmark is listed by the benchmark snapshot', () => {
    const benchmark = { id: 'bench-1', filename: 'x.json', createdAt: 1, metadata: { purpose: 'agent-model-compare', benchmarkKind: 'local-model-route' } } as unknown as ArtifactDescriptor;
    const legacy = { id: 'judge-1', filename: 'blind-model-comparison-judgment-1.json', createdAt: 2, metadata: { sourceArtifactId: 'bench-1' } } as unknown as ArtifactDescriptor;
    const other = { id: 'note-1', filename: 'notes.json', createdAt: 3, metadata: { sourceArtifactId: 'bench-1' } } as unknown as ArtifactDescriptor;
    const snapshot = localModelBenchmarkSnapshot({ platform: { artifactStore: { list: () => [benchmark, legacy, other] } } });
    expect(snapshot.judgments.map((entry) => entry.id)).toEqual(['judge-1']);
  });
});
