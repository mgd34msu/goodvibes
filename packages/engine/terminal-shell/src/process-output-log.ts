/**
 * Timestamped local output of background processes.
 *
 * Facts come from code, at once and under every decision-model policy: the
 * listening port from one anchored pattern over each new line, and a failed
 * process's stderr lines marked as errors when it ends. A model reading is
 * asked only to colour lines nothing else decided, only for the process whose
 * view is open, once per line: a verdict is kept for the life of the line,
 * and lines leaving the retained window take nothing else with them.
 */
import { readProcessOutput } from './process-output-reading.js';

export interface ProcessLine {
  readonly at: number;
  readonly text: string;
  readonly stream: 'stdout' | 'stderr';
  /** Undefined observations remain neutrally styled. */
  readonly error: boolean | undefined;
}
export interface ProcessRecordView {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly done: boolean;
  readonly identity?: string;
  /** Ended with a non-zero exit, a signal or a timeout. Read only once `done`. */
  readonly failed?: boolean;
}
export const MAX_LINES = 5000;
/** Lines before the first unjudged line sent with a reading as context. */
const READING_CONTEXT_LINES = 16;
/** The newest unjudged lines one reading covers; older ones follow at later quiet windows while the view stays open. */
const READING_MAX_LINES = 256;
function clean(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
/**
 * A local server announcing where it listens: a loopback or any-address URL
 * with a port (`Local: http://localhost:5173/`), or `listening on [port] N`.
 */
const LISTENING_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})\b/i;
const LISTENING_PHRASE = /\blistening (?:on|at) (?:port )?:?(\d{1,5})\b/i;
export function listeningPortOf(text: string): number | undefined {
  const match = LISTENING_URL.exec(text) ?? LISTENING_PHRASE.exec(text);
  const port = match ? Number(match[1]) : NaN;
  return port >= 1 && port <= 65535 ? port : undefined;
}
interface StoredLine { readonly id: string; readonly at: number; readonly text: string; readonly raw: string; readonly stream: ProcessLine['stream']; error: boolean | undefined; }
interface StreamCursor { chunks: number; partial: string }
interface Source {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly out: number;
  readonly err: number;
  readonly done: boolean;
  readonly identity: string | undefined;
}
interface Entry {
  readonly lines: StoredLine[];
  readonly out: StreamCursor;
  readonly err: StreamCursor;
  /** Line ids a reading or a fact already decided; never asked again. */
  readonly judged: Set<string>;
  readonly lifetime: AbortController;
  source: Source;
  port: number | undefined;
  dropped: number;
  revision: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  start: (() => void) | undefined;
  reading: boolean;
}
const capture = (record: ProcessRecordView): Source => ({ stdout: record.stdout, stderr: record.stderr, out: record.stdout.length, err: record.stderr.length, done: record.done, identity: record.identity });
/** The same process whose output only grew (the process manager appends to its arrays). */
const continues = (source: Source, record: ProcessRecordView) => record.stdout === source.stdout && record.stderr === source.stderr && record.identity === source.identity && record.stdout.length >= source.out && record.stderr.length >= source.err;
const unchanged = (source: Source, record: ProcessRecordView) => continues(source, record) && record.stdout.length === source.out && record.stderr.length === source.err && record.done === source.done;

export class ProcessOutputLog {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<void>>();
  private sequence = 0;
  private disposed = false;
  constructor(private readonly onChange: () => void = () => {}, private readonly quietMs = 750) {}

  /**
   * Read new output of every process. `viewing` is the process whose view is
   * open: only its unjudged lines are read by a model, after its output has
   * been quiet for `quietMs`. Returns true when anything visible changed.
   */
  poll(records: ReadonlyMap<string, ProcessRecordView>, now = Date.now(), viewing?: string): boolean {
    if (this.disposed) return false;
    let changed = false;
    for (const [id, entry] of this.entries) if (!records.has(id)) { this.entries.delete(id); this.retire(entry); changed = true; }
    for (const [id, record] of records) {
      let entry = this.entries.get(id);
      if (entry && !continues(entry.source, record)) { this.entries.delete(id); this.retire(entry); entry = undefined; changed = true; }
      if (!entry) {
        entry = { lines: [], out: { chunks: 0, partial: '' }, err: { chunks: 0, partial: '' }, judged: new Set(), lifetime: new AbortController(),
          source: { stdout: record.stdout, stderr: record.stderr, out: 0, err: 0, done: false, identity: record.identity },
          port: undefined, dropped: 0, revision: 0, timer: undefined, start: undefined, reading: false };
        this.entries.set(id, entry);
      }
      if (!unchanged(entry.source, record)) {
        const outChanged = this.read(entry, entry.out, record.stdout, 'stdout', record.done, now);
        const errChanged = this.read(entry, entry.err, record.stderr, 'stderr', record.done, now);
        if (record.done && !entry.source.done) this.ended(entry, record.failed === true);
        entry.source = capture(record);
        entry.revision++;
        changed = changed || outChanged || errChanged || record.done;
        // New output restarts the quiet window of a reading not yet started.
        if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; entry.start = undefined; }
      }
      if (id === viewing) this.schedule(entry);
    }
    return changed;
  }
  lines(id: string): readonly ProcessLine[] { return this.entries.get(id)?.lines ?? []; }
  dropped(id: string): number { return this.entries.get(id)?.dropped ?? 0; }
  revision(id: string): number { return this.entries.get(id)?.revision ?? 0; }
  /** The port the process announced it listens on, while it runs. Display only, never an execution grant. */
  port(id: string): number | undefined { return this.entries.get(id)?.port; }
  /** Start any reading waiting for quiet output now, and wait for every reading in flight. */
  async whenSettled(): Promise<void> {
    for (const entry of this.entries.values()) entry.start?.();
    await Promise.all([...this.pending]);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const entry of this.entries.values()) this.retire(entry);
    this.entries.clear();
    await Promise.all([...this.pending]);
  }
  private retire(entry: Entry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined; entry.start = undefined;
    entry.lifetime.abort();
  }
  /** A process that ended no longer listens; a failed one's stderr lines report its failure. */
  private ended(entry: Entry, failed: boolean): void {
    entry.port = undefined;
    if (!failed) return;
    for (const line of entry.lines) {
      if (line.stream !== 'stderr' || entry.judged.has(line.id)) continue;
      line.error = true;
      entry.judged.add(line.id);
    }
  }
  private unjudged(entry: Entry): StoredLine[] {
    return entry.lines.filter((line) => !entry.judged.has(line.id) && line.text.length > 0);
  }
  private schedule(entry: Entry): void {
    if (entry.reading || entry.timer !== undefined || this.unjudged(entry).length === 0) return;
    const start = () => {
      if (entry.start !== start) return;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.timer = undefined; entry.start = undefined;
      const targets = this.unjudged(entry).slice(-READING_MAX_LINES);
      if (targets.length === 0 || entry.lifetime.signal.aborted) return;
      const first = entry.lines.indexOf(targets[0]!);
      const context = entry.lines.slice(Math.max(0, first - READING_CONTEXT_LINES), first).filter((line) => !targets.includes(line));
      const evidence = {
        lines: [...context, ...targets].map(({ id, text, raw, stream }) => ({ id, text, raw, stream })),
        partials: { stdout: '', stderr: '' },
        done: entry.source.done,
      };
      entry.reading = true;
      const work = (async () => {
        try {
          const reading = await readProcessOutput(evidence, targets.map((line) => line.id), { signal: entry.lifetime.signal, authoritySignal: entry.lifetime.signal });
          if (entry.lifetime.signal.aborted) return;
          for (const line of targets) {
            const verdict = reading.errors.get(line.id);
            if (verdict !== undefined) line.error = verdict;
          }
          reading.recordPublication();
          entry.revision++;
          this.onChange();
        } catch { /* An unavailable or uncertain reading leaves the lines neutral. */ }
        finally {
          // Each line is asked once, whatever the answer: nothing is sent twice.
          for (const line of targets) entry.judged.add(line.id);
          entry.reading = false;
        }
      })();
      this.pending.add(work);
      void work.then(() => this.pending.delete(work));
    };
    entry.start = start;
    entry.timer = setTimeout(start, this.quietMs);
  }
  private read(entry: Entry, cursor: StreamCursor, chunks: readonly string[], stream: ProcessLine['stream'], done: boolean, now: number): boolean {
    let changed = false;
    if (chunks.length > cursor.chunks) {
      const parts = (cursor.partial + chunks.slice(cursor.chunks).join('')).split(/\r?\n/);
      cursor.chunks = chunks.length; cursor.partial = parts.pop() ?? '';
      for (const part of parts) this.push(entry, part, stream, now);
      changed = parts.length > 0;
    }
    if (done && cursor.partial) { this.push(entry, cursor.partial, stream, now); cursor.partial = ''; changed = true; }
    return changed;
  }
  private push(entry: Entry, raw: string, stream: ProcessLine['stream'], at: number): void {
    const text = clean(raw.includes('\r') ? raw.slice(raw.lastIndexOf('\r') + 1) : raw).trimEnd();
    entry.lines.push({ id: `line-${this.sequence++}`, at, text, raw, stream, error: undefined });
    const port = listeningPortOf(text);
    if (port !== undefined) entry.port = port;
    if (entry.lines.length > MAX_LINES) {
      const extra = entry.lines.length - MAX_LINES;
      for (const line of entry.lines.splice(0, extra)) entry.judged.delete(line.id);
      entry.dropped += extra;
    }
  }
}
