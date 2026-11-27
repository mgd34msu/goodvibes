/**
 * work-delegation.ts, how a terminal program hands a model's delegation to the
 * daemon's one runner. A spawn that is not outside every contract (a model's
 * `agent` call with a decision model set, a team's or a recipe's agents) is
 * not run in the program: it becomes a piece of work on the daemon for the
 * program's project, tied to the conversation that asked. The spawned record
 * is that work's owner here: it shows the work's progress while the program
 * follows it, and settles with the work's result, as an owner record of a
 * contract did. The work itself is the daemon's: it runs on when the program
 * closes, and its result then waits in Work.
 */
import type { AgentRecord } from './record.js';

/** What following a piece of work tells the record that follows it. */
export type DelegatedWorkUpdate =
  /** Where the work stands now, in the Work place's words; `waiting` when it waits on the owner in Work. */
  | { readonly kind: 'progress'; readonly line: string; readonly waiting?: boolean | undefined }
  /** It is done: its result, as the conversation reads it. */
  | { readonly kind: 'done'; readonly output: string }
  /** It failed: why, in words, with where to act on it. */
  | { readonly kind: 'failed'; readonly error: string }
  /** It was stopped (in Work, by a script, or by this conversation). */
  | { readonly kind: 'stopped'; readonly reason: string };

/** What following one piece of work came to: the record was settled, or the program stopped following it. */
export interface DelegatedWork {
  /** The work's id on the daemon. */
  readonly workId: string;
  /** Ends when the record is settled from the work's end, or when the program stops following it (it closes). */
  readonly settled: Promise<void>;
  /** Stop the work on the daemon (the conversation's own cancel of its agent): false when it had ended already. */
  cancel(reason: string): boolean;
}

export interface AgentWorkDelegation {
  /**
   * Hand the record's task to the daemon as a piece of work, and follow it: `report` is told where it stands and how
   * it ended. Throws, with the daemon's words, when the daemon did not take it.
   */
  delegate(record: AgentRecord, options: {
    readonly signal: AbortSignal;
    readonly report: (update: DelegatedWorkUpdate) => void;
    /**
     * Who the turn that asked acts for, when it is someone else's input (security/turn-input-party.ts): the work it hands
     * over carries that party (the daemon keeps it on the work's record). Absent: the owner's own conversation.
     */
    readonly otherParty?: string | undefined;
  }): Promise<DelegatedWork>;
  /** Stop following every work (the program is closing, or a headless run ends): each runs on; never stops a work. */
  close?(): void;
}
