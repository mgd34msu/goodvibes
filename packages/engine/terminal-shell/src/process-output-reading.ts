import { captureJudgmentPort, decisionModelPolicyState, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult, snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { processOutputError } from './batteries/process-output.js';
import { decisionOrClassic } from '@goodvibes-jev/engine/platform/platform/runtime/decision-policy';

export const PROCESS_OUTPUT_READING_LIMITS = { questions: 64, concurrency: 4, endpointCandidates: 256 } as const;
/** Lines before a page's first target sent with that page as context. */
const PROCESS_OUTPUT_PAGE_CONTEXT_LINES = 16;
export interface ProcessOutputEvidenceLine { readonly id: string; readonly text: string; readonly raw: string; readonly stream: 'stdout' | 'stderr'; }
export interface ProcessEndpointCandidate { readonly id: string; readonly lineId: string; readonly start: number; readonly end: number; readonly port: number; }
export interface ProcessOutputEvidence {
  readonly lines: readonly ProcessOutputEvidenceLine[];
  readonly partials: { readonly stdout: string; readonly stderr: string };
  readonly done: boolean;
}
export interface ProcessOutputReading {
  readonly provenance?: 'classic';
  readonly errors: ReadonlyMap<string, boolean | undefined>;
  readonly port: number | undefined;
  readonly assertCurrent: () => void;
  /** Completed line observations remain valid only under this original authority. */
  readonly assertAuthorityCurrent: () => void;
  readonly recordPublication: () => void;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function captureEvidence(evidence: ProcessOutputEvidence, lineIds: readonly string[]): { readonly evidence: ProcessOutputEvidence; readonly lineIds: readonly string[] } {
  const captured = snapshotJudgmentInput({ evidence, lineIds });
  const invalid = (): never => { throw new Error('Invalid process output evidence'); };
  if (!record(captured) || !record(captured.evidence) || !Array.isArray(captured.lineIds)) return invalid();
  const source = captured.evidence;
  if (!Array.isArray(source.lines) || !record(source.partials) || typeof source.partials.stdout !== 'string' || typeof source.partials.stderr !== 'string' || typeof source.done !== 'boolean') return invalid();
  const lines = source.lines.map((line): ProcessOutputEvidenceLine => {
    if (!record(line) || typeof line.id !== 'string' || typeof line.text !== 'string' || typeof line.raw !== 'string' || (line.stream !== 'stdout' && line.stream !== 'stderr')) return invalid();
    return { id: line.id, text: line.text, raw: line.raw, stream: line.stream };
  });
  const ids = new Set(lines.map(line => line.id));
  if (ids.size !== lines.length || !captured.lineIds.every((id: unknown) => typeof id === 'string' && ids.has(id))) return invalid();
  const targets = captured.lineIds.filter((id: unknown): id is string => typeof id === 'string');
  if (new Set(targets).size !== targets.length) return invalid();
  return { evidence: { lines, partials: { stdout: source.partials.stdout, stderr: source.partials.stderr }, done: source.done }, lineIds: targets };
}

/**
 * Literal integer spans in output. The log finds a listening port with one
 * anchored pattern (`listeningPortOf`), so nothing asks a model about these.
 */
export function processEndpointCandidates(lines: readonly ProcessOutputEvidenceLine[]): readonly ProcessEndpointCandidate[] | undefined {
  const candidates: ProcessEndpointCandidate[] = [];
  for (const line of lines) for (const match of line.text.matchAll(/(?<![\w.+-])\d{1,5}(?![\w.])/g)) {
    const port = Number(match[0]);
    if (port < 1 || port > 65535) continue;
    if (candidates.length >= PROCESS_OUTPUT_READING_LIMITS.endpointCandidates) return undefined;
    candidates.push({ id: `endpoint-${candidates.length}`, lineId: line.id, start: match.index, end: match.index + match[0].length, port });
  }
  return candidates;
}

export async function readProcessOutput(evidence: ProcessOutputEvidence, lineIds: readonly string[], options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> & { readonly authoritySignal: AbortSignal }): Promise<ProcessOutputReading> {
  return decisionOrClassic(() => readDecisionProcessOutput(evidence, lineIds, options), () => {
    const captured = captureEvidence(evidence, lineIds);
    const authorityCurrent = () => { options.authoritySignal.throwIfAborted(); decisionModelPolicyState(); };
    const current = () => { authorityCurrent(); options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    current();
    // Raw output stays visible. No unknown line is called an error without that evidence.
    return { provenance: 'classic' as const, errors: new Map(captured.lineIds.map(id => [id, undefined])), port: undefined,
      assertCurrent: current, assertAuthorityCurrent: authorityCurrent, recordPublication: current };
  });
}
async function readDecisionProcessOutput(evidence: ProcessOutputEvidence, lineIds: readonly string[], options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> & { readonly authoritySignal: AbortSignal }): Promise<ProcessOutputReading> {
  // One screening of the evidence as given; nothing is copied twice.
  const captured = captureEvidence(evidence, lineIds);
  const source = captured.evidence;
  // One page failing stops the others: the reading as a whole is then unavailable.
  const batchLifetime = new AbortController();
  const owner = captureJudgmentPort('terminal-shell.process-output', { signal: options.signal ? AbortSignal.any([options.signal, batchLifetime.signal]) : batchLifetime.signal, assertCurrent: options.assertCurrent, prepareResultCapture: prepareJudgmentResult });
  const authorityCurrent = () => { options.authoritySignal.throwIfAborted(); };
  owner.assertCurrent();
  const index = new Map(source.lines.map((line, position) => [line.id, position]));
  const pages: string[][] = [];
  for (let start = 0; start < captured.lineIds.length; start += PROCESS_OUTPUT_READING_LIMITS.questions) {
    pages.push(captured.lineIds.slice(start, start + PROCESS_OUTPUT_READING_LIMITS.questions));
  }
  const errors = new Map<string, boolean | undefined>();
  const publications: Array<() => void> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PROCESS_OUTPUT_READING_LIMITS.concurrency, pages.length) }, async () => {
    while (cursor < pages.length) {
      owner.assertCurrent();
      const page = pages[cursor++];
      if (!page || page.length === 0) continue;
      // Each request carries its own targets and the few lines before them, never the whole log.
      const from = Math.max(0, (index.get(page[0]!) ?? 0) - PROCESS_OUTPUT_PAGE_CONTEXT_LINES);
      const to = (index.get(page[page.length - 1]!) ?? source.lines.length - 1) + 1;
      const state = { lines: source.lines.slice(from, to).map(({ id, text, stream }) => ({ id, text, stream })), done: source.done };
      const result = await processOutputError.readPage(owner.port, state, page.map((id) => ({ id, key: `error:${id}` })), { signal: owner.signal, site: processOutputError.name, beforeAttempt: owner.assertCurrent });
      owner.assertCurrent();
      for (const [id, value] of result.observations) errors.set(id, value);
      publications.push(() => { result.recordPublication(); });
    }
  });
  try { await Promise.all(workers); }
  catch (error) { batchLifetime.abort(); await Promise.allSettled(workers); throw error; }
  owner.assertCurrent();
  return { errors, port: undefined, assertCurrent: owner.assertCurrent, assertAuthorityCurrent: authorityCurrent,
    recordPublication() { for (const publish of publications) publish(); },
  };
}
