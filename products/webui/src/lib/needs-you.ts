/**
 * The shell's counts: the number on the Work entry in the sidebar (what waits
 * for you) and the account menu's "1 running". Both are the work board's own
 * `counts` (views/work/work-items.ts readWork, contracts work-board.ts) over the
 * sources the shell already reads, so they are the Work page's group counts and
 * never a second derivation: an idle watcher, a heartbeat or a schedule between
 * runs is not counted as running, and an ask is counted once.
 *
 * The shell reads the hosted-session list with Work's own key and request, so a
 * daemon-hosted session answering right now is counted here as on the page.
 */
import { readWork, type WorkSources } from '../views/work/work-items';

export type ShellCountSources = Pick<WorkSources, 'asks' | 'nodes' | 'attemptGroups' | 'tasks' | 'hosted'>;

export interface ShellCounts {
  /** Rows under "Waiting for you". */
  readonly waiting: number;
  /** Rows under "Running now". */
  readonly running: number;
}

export function shellCounts(sources: ShellCountSources, now: number = Date.now()): ShellCounts {
  const { counts } = readWork(sources, now).board;
  return { waiting: counts.waiting, running: counts.running };
}
