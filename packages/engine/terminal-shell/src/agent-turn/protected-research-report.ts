import { snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate/judgment-input';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner, type ProtectedSource, type ProtectedResearchReference, type SourceScreeningHold } from '@goodvibes-jev/engine/platform/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools/input-projection';
import type { ToolInputProjectionProblem, ToolInputProjector, ToolInputProjectionRequest, ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { prepareAgentResearchReportInput, omittedReferencePattern } from './research-report-input.js';
import { RESEARCH_SCREENING_UNCONFIGURED_DETAIL } from './research-source-screening.js';

/** What a refused screening acquisition is missing, as a fixed sentence (it names no value). */
export { RESEARCH_SCREENING_UNCONFIGURED_DETAIL };

const WITHHELD = '[source URL withheld]';
/** One report: all fields together, and the number of cited sources. */
export const RESEARCH_REPORT_LIMITS = Object.freeze({ characters: SOURCE_SCREENING_LIMITS.characters, sources: 50 });
export const RESEARCH_REPORT_LIMITS_TEXT = `A report holds at most ${RESEARCH_REPORT_LIMITS.characters.toLocaleString('en-US')} characters across all fields and at most ${RESEARCH_REPORT_LIMITS.sources} sources.`;
/** Screenings in flight for one report; each is one request when hosted screening is on. */
const SCREENING_CONCURRENCY = 8;
/**
 * The report's free text: what a person wrote and the artifact will hold. Only
 * these values are sent for privacy screening. Field names, routing and control
 * fields, ids, dates, numbers and booleans are the program's own structure, are
 * never sent, and so cannot come back changed. URLs are screened as references.
 */
const TEXT_FIELDS = ['title', 'question', 'summary', 'reportMarkdown', 'methodology', 'confidence', 'explicitUserRequest'] as const;
const TEXT_LIST_FIELDS = ['findings', 'gaps', 'recommendations', 'tags'] as const;
const SOURCE_TEXT_FIELDS = ['title', 'name', 'publisher', 'credibility', 'note', 'summary', 'evidence'] as const;

/** A cleared preview is kept this long for the save of the same arguments, so preview-then-save screens once. */
const PREVIEW_REUSE_MS = 10 * 60_000;
const PREVIEW_REUSE_LIMIT = 8;
const clearedPreviews = new WeakMap<ProtectedSourceOwner, Map<string, { readonly args: Record<string, unknown>; readonly expiresAt: number }>>();
/** The arguments a preview and its save share: everything but `preview`. */
function previewKey(raw: Record<string, unknown>): string {
  const { preview: _preview, ...rest } = raw;
  return JSON.stringify(rest);
}

const owners = new WeakMap<ToolRegistry, ProtectedSourceOwner>();
const reportOwners = new WeakMap<ToolRegistry, ProtectedSourceOwner>();
/** Trusted composition only. This never creates, discovers or qualifies a local service. */
export function bindAgentResearchSourceOwner(registry: ToolRegistry, owner: ProtectedSourceOwner): void { owners.set(registry, owner); }
export function agentResearchSourceOwner(registry: ToolRegistry | undefined): ProtectedSourceOwner | undefined { return registry && owners.get(registry); }
/** A research report grant never authorizes unrelated private-source readers. */
export function bindAgentResearchReportSourceOwner(registry: ToolRegistry, owner: ProtectedSourceOwner): void { reportOwners.set(registry, owner); }
export function agentResearchReportSourceOwner(registry: ToolRegistry | undefined): ProtectedSourceOwner | undefined {
  return registry && (reportOwners.get(registry) ?? owners.get(registry));
}

export interface ResearchReportOperation { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined; }
export interface PreparedResearchReport {
  readonly args: Record<string, unknown>;
  assertCurrent(): void;
  release(): Promise<void>;
  bind(args: Record<string, unknown>): void;
}
interface PreparedBinding { readonly owner: ProtectedSourceOwner; readonly prepared: PreparedResearchReport; readonly serialized: string; }
const bindings = new WeakMap<object, PreparedBinding>();
/** Authority or binding no longer holds; the arguments are not the cause. */
function refuse(): never { throw new ToolInputProjectionError('held'); }
/** Every detail is a fixed sentence or a count; never a caller-supplied value. */
function stop(problem: ToolInputProjectionProblem, detail?: string): never { throw new ToolInputProjectionError(problem, detail); }
const STRUCTURE_CHANGED = 'Privacy screening changed the separators of a source written as one line. Keep private details out of the title | url | credibility | note framing, or give the source as an object, and re-issue the call.';

function freezePreparedInput(value: Record<string, unknown>): void {
  captureResearchInput(value);
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(value);
}

/** Complete capture, including every source before display limits or parsing. */
export function captureResearchInput(value: unknown): Record<string, unknown> {
  let nodes = 0;
  const seen = new Set<object>();
  function inspect(entry: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 64) stop('invalid', 'The report arguments are nested too deeply or hold too many values.');
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return;
    seen.add(entry);
    for (const child of Object.values(entry)) inspect(child, depth + 1);
  }
  inspect(value, 0);
  let result: unknown;
  try { result = snapshotJudgmentInput(value, 'research report'); }
  catch (error) {
    // The privacy floor's own message is fixed and names no value.
    if (error instanceof Error && error.name === 'JudgmentInputError') stop('invalid', error.message);
    throw error;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) stop('invalid', 'The report arguments must be one JSON object.');
  return result as Record<string, unknown>;
}

/** A prepared report is frozen, so its identity is the proof; the check left is the caller's own (signal, admission). */
export function hasPreparedResearchReport(input: object, owner: ProtectedSourceOwner | undefined): boolean {
  const binding = bindings.get(input);
  if (!binding || binding.owner !== owner) return false;
  binding.prepared.assertCurrent();
  return true;
}

/** Fixed public report adapter copies only existing cleared values into known aliases. */
export function inheritPreparedResearchReport(from: object, to: Record<string, unknown>): void {
  const binding = bindings.get(from);
  if (!binding) return;
  if (!hasPreparedResearchReport(from, binding.owner)) refuse();
  const source = from as Record<string, unknown>;
  for (const [key, value] of Object.entries(to)) {
    const original = key === 'runId' ? source.runId ?? source.id : key === 'question' ? source.question ?? source.query : source[key];
    if (JSON.stringify(value) !== JSON.stringify(original)) refuse();
  }
  freezePreparedInput(to);
  bindings.set(to, { ...binding, serialized: JSON.stringify(to) });
}

function sourceRows(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n').filter(row => row.trim()) : [];
}
function declaredUrl(row: unknown): string | undefined {
  if (typeof row === 'string') return row.trim().replace(/^[-*]\s+/, '').split('|').map(part => part.trim()).find(part => /^https?:/i.test(part));
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const url = (row as Record<string, unknown>).url;
    return typeof url === 'string' && url.trim() ? url.trim() : undefined;
  }
  return undefined;
}

/** A screening that did not settle, in the caller's terms: what stopped and the next step. */
function screeningStop(reason: SourceScreeningHold, what: string): never {
  switch (reason) {
    case 'cancelled': return stop('cancelled');
    case 'stale': return stop('stale', 'The screening setup changed while the report was being prepared.');
    case 'proxy-configured': return stop('unavailable', 'A proxy variable is set for this process, so report text is not sent for hosted screening. Unset it, or choose the Classic decision policy.');
    case 'route-unavailable': case 'busy': return stop('unavailable', 'The report screening service did not answer.');
    default: return stop('invalid', `${what} could not be cleared by privacy screening. Remove credentials or private details from it and re-issue the call.`);
  }
}

/** Runs every task with at most `limit` in flight; the first failure stops new starts. */
async function runBounded(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < tasks.length) {
      const task = tasks[next++]!;
      try { await task(); } catch (error) { failed = true; throw error; }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  const rejection = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejection) throw rejection.reason;
}

/**
 * Full-source privacy and name-only URL-role receipts are BOTH required. Unlike
 * the role-only framed adapter, released arguments contain only complete privacy
 * projections. These receipts still grant no publication or execution authority.
 *
 * A refusal keeps its cause: `unconfigured` (screening is not set up), `invalid`
 * (a limit or a source the caller can change), `unavailable`/`stale` (the
 * screening service), `cancelled`, and `held` only when authority stopped holding.
 */
export async function prepareProtectedResearchReport(
  owner: ProtectedSourceOwner | undefined,
  input: unknown,
  operation: ResearchReportOperation = {},
): Promise<PreparedResearchReport> {
  if (!owner) stop('unconfigured', RESEARCH_SCREENING_UNCONFIGURED_DETAIL);
  /** The caller's authority, then the abort signal. */
  const checkOperation = () => {
    if (operation.signal?.aborted) stop('cancelled');
    try { operation.assertCurrent?.(); }
    catch (error) {
      if (error instanceof ToolInputProjectionError) throw error;
      if (operation.signal?.aborted) stop('cancelled');
      refuse();
    }
  };
  const existing = input && typeof input === 'object' ? bindings.get(input) : undefined;
  if (existing?.owner === owner) {
    // The bound arguments are frozen: what was screened is what is written.
    const assertCurrent = () => { existing.prepared.assertCurrent(); checkOperation(); };
    assertCurrent();
    return { ...existing.prepared, args: input as Record<string, unknown>, assertCurrent, release: async () => {} };
  }
  const raw = captureResearchInput(input);
  const rows = sourceRows(raw.sources);
  if (!rows.length) stop('invalid', 'At least one reviewed source is required for a research report artifact.');
  if (rows.length > RESEARCH_REPORT_LIMITS.sources) stop('invalid', `${RESEARCH_REPORT_LIMITS_TEXT} This one has ${rows.length} sources; drop or merge sources.`);
  const urls = rows.map(declaredUrl);
  const distinctUrls = [...new Set(urls.filter((url): url is string => !!url))];

  let released = false;
  const handles: Array<ProtectedSource | ProtectedResearchReference> = [];
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true;
    operation.signal?.removeEventListener('abort', abort);
    releasing = Promise.allSettled(handles.map(handle => Promise.resolve().then(() => owner.release(handle)))).then(results => {
      if (results.some(result => result.status === 'rejected')) throw new ToolInputProjectionError('unavailable');
    });
    return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  // One check before the write: the call is still wanted and still admitted.
  // The screening receipts are not re-projected; the cleared text cannot change.
  const assertCurrent = () => {
    if (released) stop('released');
    checkOperation();
  };
  const finish = (args: Record<string, unknown>): PreparedResearchReport => {
    const serialized = JSON.stringify(args);
    const result: PreparedResearchReport = Object.freeze({ args, assertCurrent, release,
      bind(candidate: Record<string, unknown>) { assertCurrent(); if (JSON.stringify(candidate) !== serialized) refuse(); freezePreparedInput(candidate); bindings.set(candidate, { owner, prepared: result, serialized }); },
    });
    result.bind(args); return result;
  };

  // The save of arguments a preview just cleared reuses that clearance.
  const reuse = clearedPreviews.get(owner);
  const key = previewKey(raw);
  if (raw.preview !== true && reuse) {
    const now = Date.now();
    for (const [entryKey, entry] of reuse) if (entry.expiresAt <= now) reuse.delete(entryKey);
    const cleared = reuse.get(key);
    if (cleared) {
      reuse.delete(key);
      checkOperation();
      return finish(snapshotJudgmentInput({ ...cleared.args, ...(raw.preview === undefined ? {} : { preview: raw.preview }) }, 'research report') as Record<string, unknown>);
    }
  }

  // The working copy: sources as rows, so a cleared value goes back where it came from.
  const view = structuredClone({ ...raw, sources: [...rows] }) as Record<string, unknown> & { sources: unknown[] };
  const strings: string[] = [];
  const slots: Array<(value: string) => void> = [];
  const text = (holder: Record<string, unknown> | unknown[], key: string | number): void => {
    const value = (holder as Record<string | number, unknown>)[key];
    if (typeof value !== 'string' || !value) return;
    strings.push(value);
    slots.push(cleared => { (holder as Record<string | number, unknown>)[key] = cleared; });
  };
  for (const field of TEXT_FIELDS) text(view, field);
  for (const field of TEXT_LIST_FIELDS) {
    const value = view[field];
    if (Array.isArray(value)) value.forEach((_, position) => text(value, position));
    else text(view, field);
  }
  view.sources.forEach((row, position) => {
    if (typeof row === 'string') { text(view.sources, position); return; }
    if (row && typeof row === 'object' && !Array.isArray(row)) for (const field of SOURCE_TEXT_FIELDS) text(row as Record<string, unknown>, field);
  });
  // One report is bounded as a whole. No clipping, partial report or first-50
  // selection may hide material from the input floor or semantic owner.
  const characters = strings.reduce((size, entry) => size + entry.length, 0);
  if (characters > RESEARCH_REPORT_LIMITS.characters) stop('invalid', `${RESEARCH_REPORT_LIMITS_TEXT} This one has ${characters} characters; shorten it or split it into two reports.`);
  const textBatches = Math.ceil(strings.length / SOURCE_SCREENING_LIMITS.parts);
  if (textBatches + distinctUrls.length > SOURCE_SCREENING_LIMITS.sources) {
    stop('invalid', `The report has too many separate text fields and source URLs to screen (${textBatches} batches of ${SOURCE_SCREENING_LIMITS.parts} fields plus ${distinctUrls.length} URLs; at most ${SOURCE_SCREENING_LIMITS.sources}). Merge list items or drop sources.`);
  }

  const captureStop = (error: unknown, what?: string): never => {
    if (error instanceof ToolInputProjectionError) throw error;
    if (what && error instanceof Error && error.name === 'JudgmentInputError') stop('invalid', `${what} holds credential material or too many query parameters. Remove them and re-issue the call.`);
    // The owner is full (other reports in flight) or closing.
    return stop('capacity');
  };
  /** Captures text in batches; the tasks screen them, `projected()` gives the parts in input order. */
  const textScreening = (texts: readonly string[]) => {
    // Identical batches are screened once (the owner answers `busy` to a
    // second concurrent screening of the same text).
    const unique = new Map<string, number>();
    const order: number[] = [];
    const batches: ProtectedSource[] = [];
    for (let offset = 0; offset < texts.length; offset += SOURCE_SCREENING_LIMITS.parts) {
      const slice = texts.slice(offset, offset + SOURCE_SCREENING_LIMITS.parts);
      const batchKey = JSON.stringify(slice);
      const known = unique.get(batchKey);
      if (known !== undefined) { order.push(known); continue; }
      if (released) stop('released');
      try { const handle = owner.capture(slice); handles.push(handle); batches.push(handle); }
      catch (error) { captureStop(error); }
      unique.set(batchKey, batches.length - 1); order.push(batches.length - 1);
    }
    const parts: string[][] = new Array(batches.length);
    return {
      tasks: batches.map((handle, index) => async () => {
        const result = await owner.screen(handle, operation);
        if (result.status !== 'settled') screeningStop(result.reason, 'The report text');
        parts[index] = [...owner.project(result.receipt)];
      }),
      projected: () => order.flatMap(index => parts[index]!),
    };
  };
  try {
    checkOperation();
    const screening = textScreening(strings);
    const omitted = new Set<string>();
    const referenceTasks = distinctUrls.map(url => {
      const what = `Source ${urls.indexOf(url) + 1}'s URL`;
      let handle: ProtectedResearchReference;
      try { handle = owner.captureResearchReference(url); handles.push(handle); }
      catch (error) { return captureStop(error, what); }
      return async () => {
        const result = await owner.screenResearchReference(handle, operation);
        if (result.status !== 'settled') screeningStop(result.reason, what);
        if (owner.projectResearchReference(result.receipt).status === 'omitted') omitted.add(url);
      };
    });
    operation.signal?.addEventListener('abort', abort, { once: true });
    // Text and URLs are screened side by side, each once.
    await runBounded([...screening.tasks, ...referenceTasks], SCREENING_CONCURRENCY);
    const projected = screening.projected();
    checkOperation();
    // Omitted references are replaced in the original text, never in a
    // projection: a partly redacted alias would no longer match and would leave
    // a changed link. A field the projection left unchanged takes the
    // replacement directly (removing a URL cannot make cleared text private);
    // only a field the projection changed is screened again.
    if (omitted.size) {
      const pattern = new RegExp([...omitted].sort((a, b) => b.length - a.length).map(omittedReferencePattern).join('|'), 'g');
      const rescreen: number[] = [];
      for (const [position, entry] of strings.entries()) {
        const candidate = entry.replace(pattern, WITHHELD);
        if (candidate === entry) continue;
        if (projected[position] === entry) projected[position] = candidate;
        else rescreen.push(position);
      }
      if (rescreen.length) {
        const again = textScreening(rescreen.map(position => strings[position]!.replace(pattern, WITHHELD)));
        await runBounded(again.tasks, SCREENING_CONCURRENCY);
        const parts = again.projected();
        rescreen.forEach((position, index) => { projected[position] = parts[index]!; });
        checkOperation();
      }
    }
    slots.forEach((assign, position) => assign(projected[position]!));
    // Source record syntax is framing, never semantic repair. Refuse changed
    // separators rather than collapse rows/cells and reassign a citation ID.
    for (const [position, row] of rows.entries()) {
      const changed = view.sources[position];
      if (typeof row === 'string' && (typeof changed !== 'string'
        || row.split('|').length !== changed.split('|').length)) stop('invalid', STRUCTURE_CHANGED);
      const url = urls[position];
      if (url && !omitted.has(url) && declaredUrl(changed) !== url) stop('invalid', `Source ${position + 1}'s URL was changed by privacy screening. Remove private details from that URL or drop it, and re-issue the call.`);
    }
    let prepared: ReturnType<typeof prepareAgentResearchReportInput<Record<string, unknown>>>;
    try { prepared = prepareAgentResearchReportInput(view); }
    catch { return stop('invalid', 'The sources could not be read. Give each source as {title, url, credibility, note} or as "title | url | credibility | note".'); }
    if (prepared.sources.length !== rows.length) stop('invalid', 'Every source needs a title or a URL.');
    const finalSources = prepared.sources.map((source, position) => {
      const original = urls[position];
      if (!original) return source;
      if (omitted.has(original)) {
        const { url: _url, ...rest } = source;
        return Object.freeze({ ...rest, urlOmitted: true as const });
      }
      return source.url ? Object.freeze({ ...source, url: original }) : source;
    });
    const args = snapshotJudgmentInput({ ...prepared, sources: finalSources }, 'research report') as Record<string, unknown>;
    if (raw.preview === true) {
      const kept = clearedPreviews.get(owner) ?? new Map<string, { readonly args: Record<string, unknown>; readonly expiresAt: number }>();
      clearedPreviews.set(owner, kept);
      while (kept.size >= PREVIEW_REUSE_LIMIT) kept.delete(kept.keys().next().value as string);
      const { preview: _preview, ...cleared } = args;
      kept.set(key, { args: cleared, expiresAt: Date.now() + PREVIEW_REUSE_MS });
    }
    return finish(args);
  } catch (error) {
    await release().catch(() => {});
    if (error instanceof ToolInputProjectionError) {
      if (error.problem === 'unconfigured' && !error.detail) stop('unconfigured', RESEARCH_SCREENING_UNCONFIGURED_DETAIL);
      throw error;
    }
    if (operation.signal?.aborted) stop('cancelled');
    return stop('unavailable', 'Report screening failed before a result was returned.');
  }
}

export function createAgentResearchReportProjector(
  owner: ProtectedSourceOwner | undefined,
  isReport: (args: Record<string, unknown>) => boolean = () => true,
  /** Fills arguments that name stored material (a run's sources) before screening. */
  expand: (args: Record<string, unknown>) => Record<string, unknown> = args => args,
): ToolInputProjector {
  return Object.freeze({ async project(request: ToolInputProjectionRequest) {
    if (!isReport(request.args)) return { status: 'projected' as const, args: request.args,
      assertRepairedArgs(args: Record<string, unknown>) { if (isReport(args)) refuse(); },
    };
    const prepared = await prepareProtectedResearchReport(owner, expand(request.args), { signal: request.signal, assertCurrent: request.assertCurrent });
    return { status: 'projected' as const, args: prepared.args, assertCurrent: prepared.assertCurrent,
      assertRepairedArgs: prepared.bind, release: prepared.release };
  } });
}
