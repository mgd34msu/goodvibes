import type { KnowledgeStore } from './store.js';
import type { KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import { emitKnowledgeLintCompleted } from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { getSourceRefreshWindowMs, isSourcePastRefreshWindow, LINT_NAMESPACE } from './shared.js';
import { getKnowledgeSpaceId, knowledgeSpaceMetadata } from './spaces.js';

export interface KnowledgeLintContext {
  readonly store: KnowledgeStore;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
}

/**
 * Runs the knowledge health checks and keeps the lint issue list in step with
 * them. With `sourceIds` only those sources are checked and only their lint
 * issues are replaced: an ingest re-checks the one document it added, not the
 * store. Without, every source is checked. Either way an issue that did not
 * change is not rewritten, and the pass is one save at most.
 */
export async function lintKnowledgeStore(context: KnowledgeLintContext, sourceIds?: readonly string[]): Promise<readonly KnowledgeIssueRecord[]> {
  await context.store.init();
  const store = context.store;
  const scoped = sourceIds ? new Set(sourceIds) : undefined;
  const sources = scoped
    ? [...scoped].flatMap((id) => { const source = store.getSource(id); return source ? [source] : []; })
    : store.listSources(Number.MAX_SAFE_INTEGER);
  const issues: KnowledgeIssueUpsertInput[] = [];
  // One pass over the edges answers "is this source linked" for every source checked.
  const linkedSourceIds = new Set<string>();
  for (const edge of store.listEdges()) if (edge.fromKind === 'source' && (!scoped || scoped.has(edge.fromId))) linkedSourceIds.add(edge.fromId);
  for (const source of sources) issues.push(...lintSource(store, source, linkedSourceIds.has(source.id)));

  // The duplicate check compares a source with every other source of the same canonical URL.
  const canonicalUris = new Set(sources.flatMap((source) => source.canonicalUri ? [source.canonicalUri] : []));
  if (canonicalUris.size > 0) {
    const byCanonical = new Map<string, KnowledgeSourceRecord[]>();
    for (const source of store.iterateSources()) {
      if (!source.canonicalUri || !canonicalUris.has(source.canonicalUri)) continue;
      const bucket = byCanonical.get(source.canonicalUri) ?? [];
      bucket.push(source);
      byCanonical.set(source.canonicalUri, bucket);
    }
    for (const bucket of byCanonical.values()) {
      if (bucket.length <= 1) continue;
      for (const source of bucket) {
        if (scoped && !scoped.has(source.id)) continue;
        issues.push(issueForSource(source, 'warning', 'duplicate-canonical-uri', `Duplicate canonical URL detected: ${source.canonicalUri}`));
      }
    }
  }

  if (!scoped) {
    for (const node of store.iterateNodes()) {
      if (node.kind === 'memory' && node.status === 'stale') issues.push(issueForStaleMemory(node));
    }
  }

  const replaced = await store.replaceIssues(issues, LINT_NAMESPACE, scoped ? { sourceIds: scoped } : undefined);
  context.emitIfReady((bus, ctx) => emitKnowledgeLintCompleted(bus, ctx, {
    issueCount: replaced.length,
  }));
  return replaced;
}

function lintSource(store: KnowledgeStore, source: KnowledgeSourceRecord, linked: boolean): KnowledgeIssueUpsertInput[] {
  const issues: KnowledgeIssueUpsertInput[] = [];
  const extraction = store.getExtractionBySourceId(source.id);
  if (source.status === 'failed' || source.crawlError) {
    issues.push(issueForSource(source, 'error', 'crawl-failed', source.crawlError ? `Source crawl failed: ${source.crawlError}` : 'Source crawl failed.'));
  }
  if (source.status === 'indexed' && (!source.title || !source.summary)) {
    issues.push(issueForSource(source, 'warning', 'metadata-incomplete', 'Indexed source is missing a title or summary.'));
  }
  if (!extraction && source.status === 'indexed') {
    issues.push(issueForSource(source, 'warning', 'missing-extraction', 'Indexed source is missing a structured extraction record.'));
  }
  if (isSourcePastRefreshWindow(source)) {
    const refreshWindowDays = Math.max(1, Math.round(getSourceRefreshWindowMs(source) / (24 * 60 * 60 * 1000)));
    issues.push(issueForSource(
      source,
      'info',
      'stale-source',
      `Source is older than its ${refreshWindowDays}-day refresh window and should be recrawled.`,
    ));
  }
  if (!linked) {
    issues.push(issueForSource(source, 'warning', 'source-unlinked', 'Source has no compiled knowledge links yet.'));
  }
  if (extraction && extraction.sections.length === 0 && !extraction.summary) {
    issues.push(issueForSource(source, 'warning', 'sparse-extraction', 'Structured extraction produced almost no usable sections or summary.'));
  }
  return issues;
}

/** A lint issue sits in the space of the record it is about; its family says lint owns it. */
function issueForSource(
  source: KnowledgeSourceRecord,
  severity: KnowledgeIssueRecord['severity'],
  code: string,
  message: string,
): KnowledgeIssueUpsertInput {
  return {
    id: `issue-${code}-${source.id}`,
    severity,
    code,
    message,
    status: 'open',
    sourceId: source.id,
    metadata: knowledgeSpaceMetadata(getKnowledgeSpaceId(source), { issueFamily: LINT_NAMESPACE }),
  };
}

function issueForStaleMemory(node: KnowledgeNodeRecord): KnowledgeIssueUpsertInput {
  return {
    id: `issue-stale-memory-${node.id}`,
    severity: 'info',
    code: 'stale-memory',
    message: 'Mirrored memory record is stale and should be reviewed before being trusted heavily.',
    status: 'open',
    nodeId: node.id,
    metadata: knowledgeSpaceMetadata(getKnowledgeSpaceId(node), { issueFamily: LINT_NAMESPACE }),
  };
}
