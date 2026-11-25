/**
 * hook-runs-poster.ts, the hooks this terminal program ran, posted to the
 * daemon's one hook trace (`hooks.trace.post`; hooks/trace.ts in the
 * platform), where the Tools and extensions place, the web UI and an agent
 * read which hooks ran, when, on what, and what each did, from every program.
 *
 * Each run is posted as its dispatcher records it. Runs the daemon did not
 * take (it is down or still starting) wait, the newest kept, and go with the
 * next post or when the program's daemon connection is back. Nothing waits on
 * a clock.
 */
import { resolve } from 'node:path';
import type { HookActivityRecord } from '@goodvibes/engine/platform/platform/hooks';
import { hookTraceRecordOf, type HookTraceRecord } from '@goodvibes/engine/platform/platform/hooks/trace-words';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/** The most runs kept waiting while the daemon does not answer; the oldest go first. */
const MAX_WAITING = 200;
/** The most runs in one post (the method's own bound). */
const MAX_PER_POST = 100;

export interface HookRunsSource {
  /** Told of each hook run as it is recorded; returns the stop. */
  onRecord(listener: (record: HookActivityRecord) => void): () => void;
}

export interface HookRunsPosterOptions {
  readonly runs: HookRunsSource;
  readonly invoke: (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly onDaemonBack: (listener: () => void) => () => void;
  readonly program: 'tui' | 'agent';
  /** The project folder this program's turns work in. */
  readonly project?: string | undefined;
}

/** Post this program's hook runs to the daemon's hook trace. Returns the stop. */
export function postHookRunsToDaemon(options: HookRunsPosterOptions): () => void {
  const started = Date.now().toString(36);
  const project = options.project ? resolve(options.project) : undefined;
  let sequence = 0;
  let waiting: HookTraceRecord[] = [];
  let sending = false;
  let stopped = false;

  const send = async (): Promise<void> => {
    if (sending || stopped || waiting.length === 0) return;
    sending = true;
    const batch = waiting.slice(0, MAX_PER_POST);
    try {
      // The program and the project are the post's: the daemon sets them on every run.
      const runs = batch.map(({ program: _program, project: _project, ...run }) => run);
      await options.invoke('hooks.trace.post', { program: options.program, ...(project ? { project } : {}), runs });
      const sent = new Set(batch.map((run) => run.id));
      waiting = waiting.filter((run) => !sent.has(run.id));
    } catch (error) {
      // Kept for the next post, or for when the daemon is back.
      logger.debug('hook runs not posted to the daemon yet', { waiting: waiting.length, error: summarizeError(error) });
      sending = false;
      return;
    }
    sending = false;
    if (waiting.length > 0) void send();
  };

  const stopRecords = options.runs.onRecord((record) => {
    waiting.push(hookTraceRecordOf(record, { id: `${options.program}:${process.pid}:${started}:${++sequence}`, program: options.program, ...(project ? { project } : {}) }));
    if (waiting.length > MAX_WAITING) waiting = waiting.slice(-MAX_WAITING);
    void send();
  });
  const stopBack = options.onDaemonBack(() => { void send(); });
  return () => {
    stopped = true;
    stopRecords();
    stopBack();
  };
}
