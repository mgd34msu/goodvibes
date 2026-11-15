import type {
  KnowledgeIssueRecord,
  KnowledgeJobMode,
  KnowledgeJobRecord,
  KnowledgeMaterializedProjection,
  KnowledgeStatus,
} from './types.js';
import type { BrowserKnowledgeIngestResult } from './browser-history/index.js';
import type { KnowledgeSemanticService } from './semantic/index.js';

export interface KnowledgeServiceJobRunnerContext {
  readonly lint: () => Promise<readonly KnowledgeIssueRecord[]>;
  readonly reindex: () => Promise<{ readonly status: KnowledgeStatus; readonly issues: readonly KnowledgeIssueRecord[]; readonly provenance?: 'classic'; readonly recompileFailures?: readonly { readonly sourceId: string; readonly error: string }[]; readonly semanticEnrichment?: 'attempted' | 'not-evaluated' }>;
  readonly refreshSources: (
    kind: 'stale' | 'bookmark',
    sourceIds?: readonly string[],
    limit?: number | undefined,
  ) => Promise<number>;
  readonly syncBrowserHistory: (input: { readonly limit?: number | undefined }) => Promise<BrowserKnowledgeIngestResult>;
  readonly materializeProjection: (input: {
    readonly kind: 'overview' | 'bundle';
    readonly limit: number;
  }) => Promise<KnowledgeMaterializedProjection>;
  readonly semanticService: KnowledgeSemanticService;
  readonly runConsolidation: (
    kind: 'light-consolidation' | 'deep-consolidation',
    input: { readonly limit?: number | undefined; readonly autoPromote: boolean },
  ) => Promise<{ readonly id: string; readonly metrics: Record<string, number> }>;
}

/** A job that ran but achieved nothing; the run is recorded `failed` with this message. */
export class KnowledgeJobFailedError extends Error {
  override readonly name = 'KnowledgeJobFailedError';
}

function firstError(errors: readonly (string | { readonly error?: unknown })[]): string {
  const first = errors[0];
  const text = typeof first === 'string' ? first : typeof first?.error === 'string' ? first.error : undefined;
  return text ? ` (first: ${text})` : '';
}

export async function runKnowledgeServiceJobByKind(
  kind: KnowledgeJobRecord['kind'],
  input: { readonly mode?: KnowledgeJobMode | undefined; readonly sourceIds?: readonly string[] | undefined; readonly limit?: number | undefined },
  context: KnowledgeServiceJobRunnerContext,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case 'lint': {
      const issues = await context.lint();
      return { issueCount: issues.length };
    }
    case 'reindex': {
      const result = await context.reindex();
      return { sourceCount: result.status.sourceCount, issueCount: result.issues.length,
        ...(result.provenance ? { provenance: result.provenance } : {}),
        ...(result.recompileFailures?.length ? { recompileFailed: result.recompileFailures.length, recompileFailures: result.recompileFailures } : {}),
        ...(result.semanticEnrichment ? { semanticEnrichment: result.semanticEnrichment } : {}) };
    }
    case 'refresh-stale':
      return { refreshed: await context.refreshSources('stale', input.sourceIds, input.limit) };
    case 'refresh-bookmarks':
      return { refreshed: await context.refreshSources('bookmark', input.sourceIds, input.limit) };
    case 'sync-browser-history': {
      const result = await context.syncBrowserHistory({ limit: input.limit });
      // Partial failures stay `completed` with counts in the result; a run in
      // which nothing was imported or captured and something failed did not do
      // its work (a retained capture with compilation held is reported in outcomes).
      if (result.imported === 0 && result.captured === 0 && (result.failed > 0 || result.errors.length > 0)) {
        throw new KnowledgeJobFailedError(`Browser history sync imported nothing: ${result.failed} failed, ${result.errors.length} error(s)${firstError(result.errors)}.`);
      }
      return {
        imported: result.imported,
        failed: result.failed,
        captured: result.captured,
        capturePartial: result.outcomes.filter((outcome) => outcome.capture === 'partial').length,
        captureFailed: result.outcomes.filter((outcome) => outcome.capture === 'failed').length,
        compilationHeld: result.outcomes.filter((outcome) => outcome.compilation === 'held').length,
        compilationFailed: result.outcomes.filter((outcome) => outcome.compilation === 'failed').length,
        outcomes: result.outcomes,
        profileCount: result.profiles.length,
        errorCount: result.errors.length,
      };
    }
    case 'rebuild-projections': {
      const overview = await context.materializeProjection({ kind: 'overview', limit: Math.max(8, input.limit ?? 12) });
      const bundle = await context.materializeProjection({ kind: 'bundle', limit: Math.max(12, input.limit ?? 18) });
      const preserved = [...new Set([...(overview.preservedUnscopedSourceIds ?? []), ...(bundle.preservedUnscopedSourceIds ?? [])])];
      return {
        projections: [
          { targetId: overview.bundle.target.targetId, artifactId: overview.artifact.id, ...(overview.source ? { sourceId: overview.source.id } : {}) },
          { targetId: bundle.bundle.target.targetId, artifactId: bundle.artifact.id, ...(bundle.source ? { sourceId: bundle.source.id } : {}) },
        ],
        ...(preserved.length ? { preservedUnscopedSourceIds: preserved, note: overview.note ?? bundle.note } : {}),
      };
    }
    case 'semantic-enrichment': {
      const result = await context.semanticService.reindex({
        sourceIds: input.sourceIds,
        limit: input.limit,
      });
      // Some sources failing is a labelled partial result (`failed`, `errors`);
      // every attempted source failing is a failed run, not a green one.
      if (result.failed > 0 && result.enriched === 0 && result.skipped === 0) {
        throw new KnowledgeJobFailedError(`Semantic enrichment failed for all ${result.failed} source(s)${firstError(result.errors.map((entry) => entry.error))}.`);
      }
      return result;
    }
    case 'semantic-self-improvement': {
      const result = await context.semanticService.selfImprove({
        sourceIds: input.sourceIds,
        limit: input.limit,
        reason: 'scheduled',
      });
      // A refused run (nothing processed, a reason given) or one in which every
      // processed gap errored did nothing; a coalesced or truncated run is expected.
      const processed = result.processedGaps ?? 0;
      if (result.errors.length > 0 && !result.coalesced && result.queuedTasks === 0 && result.closedGaps === 0 && result.linkedRepairs === 0
        && (processed === 0 || result.errors.length >= processed)) {
        throw new KnowledgeJobFailedError(`Semantic self-improvement did not complete: ${result.errors.length} error(s)${firstError(result.errors.map((entry) => entry.error))}.`);
      }
      return { ...result };
    }
    case 'light-consolidation': {
      const report = await context.runConsolidation('light-consolidation', {
        limit: input.limit,
        autoPromote: false,
      });
      return { reportId: report.id, metrics: report.metrics };
    }
    case 'deep-consolidation': {
      const report = await context.runConsolidation('deep-consolidation', {
        limit: input.limit,
        autoPromote: true,
      });
      return { reportId: report.id, metrics: report.metrics };
    }
    default:
      return {};
  }
}
