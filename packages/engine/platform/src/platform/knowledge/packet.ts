import type { KnowledgeStore } from './store.js';
import type { KnowledgeSpaceScopeInput } from './spaces.js';
import type { KnowledgeScopeSelectionOptions } from './scope-selection.js';
import type { KnowledgePacket, KnowledgePacketDetail, KnowledgePacketItem, KnowledgeSearchResult, KnowledgeUsageRecord } from './types.js';
import { emitKnowledgePacketBuilt } from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { KnowledgeEvidenceRelevanceHeldError as Held } from './semantic/evidence-ranking/reader.js';
import { freezeSupport } from './semantic/verification/projection.js';
import { readPublicKnowledgeSelection } from './public-retrieval.js';
import { DEFAULT_PACKET_BUDGET, DEFAULT_PACKET_LIMIT, estimateTokens, renderPacket, renderKnowledgePacketItem } from './shared.js';

export interface KnowledgePacketContext {
  readonly store: KnowledgeStore;
  readonly deferUsage: (input: {
    readonly targetKind: KnowledgeUsageRecord['targetKind'];
    readonly targetId: string;
    readonly usageKind: KnowledgeUsageRecord['usageKind'];
    readonly task?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly score?: number | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => void;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
}

type ScopeOptions = Pick<KnowledgeScopeSelectionOptions, 'signal' | 'assertCurrent' | 'shouldStop'>;
type PacketOptions = { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } & KnowledgeSpaceScopeInput & ScopeOptions;
const RELEVANCE_REASON = 'Selected by the shared semantic relevance reading; legacy retrieval points were not computed';

/** Await policy-owned retrieval; Classic ranks literal overlap without semantic confidence. */
export async function searchKnowledge(context: KnowledgePacketContext, query: string, limit = 10,
  scope: KnowledgeSpaceScopeInput = {}, options: ScopeOptions = {}): Promise<KnowledgeSearchResult[]> {
  const selection = await readPublicKnowledgeSelection(context.store, { query, scope, mode: 'search' }, options);
  selection.assertCurrent();
  const results = selection.accepted.slice(0, Math.max(1, limit)).map((entry): KnowledgeSearchResult => ({
    kind: entry.kind, id: entry.id, score: entry.localScore ?? 0,
    reason: entry.provenance === 'classic' ? 'Classic literal token overlap; semantic relevance was not assessed' : RELEVANCE_REASON,
    ...(entry.provenance ? { provenance: entry.provenance, scoreSource: 'literal-overlap' as const } : {}),
    ...(entry.source ? { source: entry.source } : {}), ...(entry.node ? { node: entry.node } : {}),
  }));
  for (const result of results.slice(0, 6)) {
    selection.assertCurrent();
    context.deferUsage({ targetKind: result.kind, targetId: result.id, usageKind: 'search-hit', task: query,
      score: result.score, metadata: { reason: result.reason, ...(result.provenance ? { provenance: result.provenance } : {}) } });
  }
  return results;
}

export async function buildKnowledgePacket(context: KnowledgePacketContext, task: string, writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT, options: PacketOptions = {}): Promise<KnowledgePacket> {
  const prepared = await preparePacket(context, task, writeScope, limit, options);
  prepared.assertCurrent();
  return prepared.packet;
}

export async function buildKnowledgePromptPacket(context: KnowledgePacketContext, task: string, writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT, options: PacketOptions = {}): Promise<string | null> {
  return (await prepareKnowledgePromptPacket(context, task, writeScope, limit, options)).prompt;
}

/** A rendered prompt packet and the request it answers: a plain value the caller passes on. */
export interface PreparedKnowledgePromptPacket {
  readonly task: string;
  readonly writeScope: readonly string[];
  readonly prompt: string | null;
}

/** Prepare at an actual asynchronous execution boundary before synchronous layout. */
export async function prepareKnowledgePromptPacket(context: KnowledgePacketContext, task: string, writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT, options: PacketOptions = {}): Promise<PreparedKnowledgePromptPacket> {
  const selection = await preparePacket(context, task, writeScope, limit, options);
  selection.assertCurrent();
  return Object.freeze({ task, writeScope: Object.freeze([...selection.packet.writeScope]),
    prompt: renderPacket(selection.packet.items, selection.packet) });
}

function requestSnapshot(task: string, writeScope: readonly string[], limit: number, options: PacketOptions) {
  const detail = options.detail ?? 'standard';
  if (!['compact', 'standard', 'detailed'].includes(detail) || !Number.isFinite(limit)
    || (options.budgetLimit !== undefined && !Number.isFinite(options.budgetLimit))) throw new Held('malformed');
  const request = { task, writeScope: [...writeScope], knowledgeSpaceId: options.knowledgeSpaceId, includeAllSpaces: options.includeAllSpaces };
  assertJudgmentInput({ task: request.task, writeScope: request.writeScope });
  return { request, detail, budgetLimit: Math.max(80, options.budgetLimit ?? DEFAULT_PACKET_BUDGET[detail]),
    signal: options.signal, assertCurrent: options.assertCurrent, shouldStop: options.shouldStop };
}

async function preparePacket(context: KnowledgePacketContext, task: string, writeScope: readonly string[], limit: number, options: PacketOptions) {
  const captured = requestSnapshot(task, writeScope, limit, options);
  // The request is read once into plain values; only the caller's own signal
  // and checks can say it is no longer wanted.
  const assertRequestCurrent = () => {
    if (captured.signal?.aborted || captured.shouldStop?.()) throw new Held('aborted');
    captured.assertCurrent?.();
  };
  const selection = await readPublicKnowledgeSelection(context.store, {
    query: task, writeScope: captured.request.writeScope, mode: 'packet', limit: Math.max(1, limit) * 2,
    scope: { knowledgeSpaceId: captured.request.knowledgeSpaceId, includeAllSpaces: captured.request.includeAllSpaces },
    ...(captured.signal ? { signal: captured.signal } : {}),
  }, { signal: captured.signal, shouldStop: captured.shouldStop, assertCurrent: assertRequestCurrent });
  const assertCurrent = () => { assertRequestCurrent(); selection.assertCurrent(); };
  assertCurrent();
  const { detail, budgetLimit } = captured;
  const usageCounts = buildUsageCounts(context);
  context.store.readAheadExtractions(selection.accepted.flatMap((row) => row.source ? [row.id] : []));
  const candidates: KnowledgePacketItem[] = selection.accepted.map((row) => {
    const related = selection.relatedLabels(row.kind, row.id);
    let summary: string | undefined;
    let evidence: readonly string[];
    if (row.source) {
      const spans = row.spans ?? [];
      // Exact-span readings own meaning. Detail changes layout, never clips an
      // exception or revives a summary that the reader did not select.
      const summaries = spans.filter((span) => ['source.summary', 'source.description', 'extraction.summary'].includes(span.field));
      summary = (detail === 'compact' ? spans : summaries).map((span) => span.text).join('\n\n') || undefined;
      evidence = detail === 'compact' ? [] : spans.filter((span) => !summaries.includes(span)).map((span) => span.text);
    } else {
      summary = row.node?.summary;
      evidence = row.nodeText ? [row.nodeText] : [];
    }
    const item: KnowledgePacketItem = {
      kind: row.kind, id: row.id,
      title: row.source ? row.source.title ?? row.source.canonicalUri ?? row.source.sourceUri ?? row.source.id : row.node!.title,
      ...(summary !== undefined ? { summary } : {}),
      ...(row.source ? { uri: row.source.canonicalUri ?? row.source.sourceUri } : {}),
      reason: selection.provenance === 'classic' ? 'Classic local retrieval; fields are quoted without semantic excerpt verification' : RELEVANCE_REASON,
      score: row.localScore ?? 0, estimatedTokens: 0, related, evidence,
      ...(selection.provenance ? { provenance: selection.provenance } : {}),
      metadata: row.source ? { sourceType: row.source.sourceType, status: row.source.status,
        extractionFormat: context.store.getExtractionBySourceId(row.id)?.format, usageCount: usageCounts.get(`source:${row.id}`) ?? 0 }
        : { kind: row.node!.kind, status: row.node!.status, usageCount: usageCounts.get(`node:${row.id}`) ?? 0 },
    };
    return { ...item, estimatedTokens: estimateTokens(renderKnowledgePacketItem(item)) };
  });
  const items: KnowledgePacketItem[] = [];
  let estimatedTokens = 0, droppedForBudget = 0;
  // Preserve whole-item packing after complete semantic reading. The first
  // item is retained even above budget; the rank window applies only here.
  for (const item of candidates.slice(0, Math.max(1, limit * 4))) {
    if (items.length >= Math.max(1, limit)) break;
    if (estimatedTokens + item.estimatedTokens > budgetLimit && items.length > 0) { droppedForBudget++; continue; }
    items.push(item); estimatedTokens += item.estimatedTokens;
  }
  const totalCandidates = candidates.length, droppedCount = totalCandidates - items.length;
  const packet: KnowledgePacket = freezeSupport({ task, writeScope: [...captured.request.writeScope], generatedAt: Date.now(),
    detail, strategy: selection.provenance === 'classic' ? 'Classic local retrieval with complete quoted fields' : 'semantic-ranked exact-span packet', budgetLimit, estimatedTokens, items,
    totalCandidates, droppedCount, truncated: droppedCount > 0, droppedForBudget, budgetExhausted: droppedForBudget > 0,
    candidates: selection.candidates });
  assertCurrent();
  for (const item of items) {
    assertCurrent();
    context.deferUsage({ targetKind: item.kind, targetId: item.id, usageKind: 'packet-item', task, score: item.score,
      metadata: { detail, writeScope: [...packet.writeScope], ...(item.provenance ? { provenance: item.provenance } : {}) } });
  }
  assertCurrent();
  context.emitIfReady((bus, ctx) => emitKnowledgePacketBuilt(bus, ctx, { task: eventTaskPreview(task), itemCount: items.length, estimatedTokens, detail }));
  return { packet, assertCurrent };
}

/** The event stream reaches every subscriber: carry a bounded preview, not the whole task text. */
function eventTaskPreview(task: string): string {
  return task.length > 80 ? `${task.slice(0, 80)}...` : task;
}

/** Usage is descriptive metadata and never admits or ranks candidates. */
function buildUsageCounts(context: KnowledgePacketContext): Map<string, number> {
  const counts = new Map<string, number>();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const record of context.store.listUsageRecords(10_000)) {
    if (record.createdAt < cutoff) continue;
    const key = `${record.targetKind}:${record.targetId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
