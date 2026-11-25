/**
 * trace.ts, the hook trace: which hooks ran, when, on what, and what each did.
 *
 * Hooks fire in every program that runs turns (the terminal app, the Agent,
 * the daemon's own turns), each with its own dispatcher and its own in-memory
 * activity (activity.ts). The trace is the one record of all of them, kept by
 * the daemon: its own dispatcher's runs are added as they happen, and each
 * terminal program posts its runs (`hooks.trace.post`). Every addition says
 * the list changed (`hook-trace`), so a screen showing the trace reads it
 * again by itself. Bounded: the newest runs are kept, the oldest let go.
 * A run's shape and words are in trace-words.ts (browser-safe).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { noteListChanged } from '../runtime/list-changes.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { readHookTraceRecord, type HookTraceRecord } from './trace-words.js';

export * from './trace-words.js';

/** The daemon's one hook trace, kept in a file of its own. */
export class HookTraceStore {
  private records: HookTraceRecord[] | null = null;
  private readonly seen = new Set<string>();

  constructor(private readonly path: string, private readonly limit = 300) {}

  private load(): HookTraceRecord[] {
    if (this.records !== null) return this.records;
    let loaded: HookTraceRecord[] = [];
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown;
        const runs = (parsed as { runs?: unknown } | null)?.runs;
        const list: unknown[] = Array.isArray(runs) ? runs : [];
        loaded = list.flatMap((entry) => { const record = readHookTraceRecord(entry); return record ? [record] : []; });
      } catch (error) {
        // An unreadable trace starts again empty; the file is replaced at the next run.
        logger.warn('HookTraceStore: the hook trace could not be read; it starts again', { path: this.path, error: summarizeError(error) });
      }
    }
    loaded.sort((a, b) => b.at - a.at);
    this.records = loaded.slice(0, this.limit);
    for (const record of this.records) this.seen.add(record.id);
    return this.records;
  }

  /** Keep these runs (a run already kept is not kept twice); answers how many were new. */
  add(runs: readonly HookTraceRecord[]): number {
    const records = this.load();
    const fresh = runs.filter((run) => !this.seen.has(run.id));
    if (fresh.length === 0) return 0;
    for (const run of fresh) this.seen.add(run.id);
    records.push(...fresh);
    records.sort((a, b) => b.at - a.at);
    for (const dropped of records.splice(this.limit)) this.seen.delete(dropped.id);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: 1, runs: records })}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      // Kept in memory for this run of the daemon; the file catches up at the next write.
      logger.warn('HookTraceStore: the hook trace could not be written', { path: this.path, error: summarizeError(error) });
    }
    noteListChanged({ list: 'hook-trace', change: 'created' });
    return fresh.length;
  }

  /** The newest runs first; only one project's when `project` is given (runs that named no project are kept in). */
  list(options: { readonly project?: string | undefined; readonly limit?: number | undefined } = {}): readonly HookTraceRecord[] {
    const records = this.load();
    const mine = options.project ? records.filter((record) => record.project === undefined || record.project === options.project) : records;
    return mine.slice(0, Math.max(1, Math.min(options.limit ?? 100, this.limit)));
  }
}
