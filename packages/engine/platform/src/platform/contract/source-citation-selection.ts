import { estimateTokens, LIMITS, type JudgmentPort } from '@goodvibes-jev/judgment';
import type { UnitEvidence } from './evidence.js';
import { retainOwnedJson } from '../gate/judgment-input.js';
import { sourceCitationBatch } from './batteries/source-citation-purpose.js';
import type { JudgmentUsage } from './types.js';

interface CitationCache { readonly report: string; readonly byPath: Map<string, Map<number, boolean>>; }
// Only the current complete report is cached for this actual unit owner.
// A late read for another report writes its own frame, never the current one.
const caches = new WeakMap<object, CitationCache>();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const citations = (path: string, text: string) => [...text.matchAll(
  new RegExp('(?<![\\w./-])' + escape(path) + '(?::|#L)(\\d+)(?:[-–]L?(\\d+))?', 'g'),
)].map(match => ({ path, start: Number(match[1]), end: Number(match[2] ?? match[1]), offset: match.index,
  context: text.slice(Math.max(0, match.index - 160), Math.min(text.length, match.index + match[0].length + 160)) }));

/** Keep every observation and the full report. Only receipt-only source
 * quotations are removed from the check's view; raw evidence stays on the unit.
 */
export async function selectSourceCitationEvidence(owner: object, evidence: UnitEvidence, port: JudgmentPort, signal?: AbortSignal): Promise<{ evidence: UnitEvidence; usage: JudgmentUsage }> {
  const usage: JudgmentUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  if (!evidence.sourceReads?.length || estimateTokens(evidence.sourceReads) < LIMITS.maxStateWithQuestionTokens) return { evidence, usage };
  const report = evidence.output, originalReads = evidence.sourceReads;
  const source = retainOwnedJson(originalReads);
  const assertCurrent = () => {
    signal?.throwIfAborted(); source.assertCurrent();
    if (evidence.output !== report || evidence.sourceReads !== originalReads) throw new Error('Source citation evidence changed');
  };
  assertCurrent();
  const cited = originalReads.filter(read => read.contentKind === 'cited-source' && read.returnedContent);
  const retained = caches.get(owner);
  const cache = retained?.report === report ? retained : { report, byPath: new Map<string, Map<number, boolean>>() };
  caches.set(owner, cache);
  const occurrences = [...new Set(cited.map(read => read.path))].flatMap(path => citations(path, report));
  const pending = occurrences.filter(citation => !cache.byPath.get(citation.path)?.has(citation.offset));
  const batches = Array.from({ length: Math.ceil(pending.length / 16) }, (_, index) => pending.slice(index * 16, (index + 1) * 16));
  const results = await Promise.allSettled(batches.map(async batch => {
    const read = await sourceCitationBatch(batch.length).run(port, { report, citations: batch },
      { site: 'contract.check.source-citation-purpose', beforeAttempt: assertCurrent, ...(signal === undefined ? {} : { signal }) });
    assertCurrent();
    usage.calls++; usage.inputTokens += read.result.usage?.inputTokens ?? 0; usage.outputTokens += read.result.usage?.outputTokens ?? 0;
    for (let index = 0; index < batch.length; index++) {
      const reading = read.readings[`citation_${index}`]!;
      const citation = batch[index]!;
      const byOffset = cache.byPath.get(citation.path) ?? new Map<number, boolean>();
      cache.byPath.set(citation.path, byOffset);
      byOffset.set(citation.offset, reading.verdict === 'yes' && reading.outcome === 'act');
    }
    read.recordAction('select-primary-citations-with-all-scope-records-retained');
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  assertCurrent();
  const receiptOnly = occurrences.map(citation => cache.byPath.get(citation.path)?.get(citation.offset) === true);
  const claims = occurrences.filter((_, index) => !receiptOnly[index]);
  let changed = false;
  const sourceReads = evidence.sourceReads.map(read => {
    if (read.contentKind !== 'cited-source' || !read.returnedContent) return read;
    const ranges = claims.filter(citation => citation.path === read.path);
    const rows = read.returnedContent.split('\n').filter(row => {
      const match = /^[ \t]*(\d+) \|/.exec(row), line = Number(match?.[1]);
      return match && ranges.some(({ start, end }) => line >= start && line <= end);
    });
    const { returnedContent: _contents, contentKind: _kind, ...scope } = read;
    if (rows.join('\n') === read.returnedContent) return read;
    changed = true;
    return rows.length ? { ...scope, returnedContent: rows.join('\n'), contentKind: 'cited-source' as const } : scope;
  });
  return { evidence: changed ? { ...evidence, sourceReads } : evidence, usage };
}
