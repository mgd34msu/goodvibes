/**
 * checkin/state-reader.ts
 *
 * Binds a CheckinStateReader to the live runtime through narrow, structural
 * views of sessions, automation runs, the owner inbox and contracts, narrow
 * enough that the real records satisfy them directly and that a test can
 * hand-roll them without the real services.
 *
 * The check-in asks one question: does anything need the owner now? So the
 * briefing's "needs attention" lines are exactly the facts that mean "owner
 * needed": an approval or question waiting in the owner inbox (and how long),
 * a contract waiting for the owner's decision (and its question), an
 * automation run that failed since the last check-in. Messages a session has
 * not picked up yet are the owner's own messages waiting on the agent, so
 * they are reported as that, after the owner-needed lines, never as the owner
 * being waited on.
 */
import type { CheckinDecision, CheckinJudge, CheckinStateReader, CheckinStateSnapshot } from './types.js';

export interface CheckinSessionView {
  readonly status: string;
  readonly activeAgentId?: string | undefined;
  readonly pendingInputCount: number;
  readonly title: string;
  readonly surfaceKinds: readonly string[];
}

export interface CheckinRunView {
  readonly status: string;
  readonly endedAt?: number | undefined;
  readonly jobId?: string | undefined;
  readonly error?: string | undefined;
}

/** An owner inbox item (approval, question, claim, purchase window, queued action). */
export interface CheckinOwnerItemView {
  readonly kind: string;
  readonly status: string;
  readonly title: string;
  readonly createdAt: number;
}

/** A contract, as far as the check-in needs it. */
export interface CheckinContractView {
  readonly goal: string;
  readonly status: string;
  readonly escalations: readonly { readonly question: string; readonly resolvedAt?: number | undefined }[];
}

export interface CheckinRuntimeReaders {
  listSessions(): readonly CheckinSessionView[];
  listRuns(): readonly CheckinRunView[];
  /** The owner inbox's items; absent when the host has no inbox. */
  listOwnerItems?(): readonly CheckinOwnerItemView[];
  /** Contracts; absent when the host runs none. */
  listContracts?(): readonly CheckinContractView[];
  /**
   * When the last check-in that was delivered, or judged and stayed quiet,
   * ran (from the receipt store, so it survives a restart); null when none
   * has. Failed runs are reported from then on. Absent: the last snapshot.
   */
  lastSettledCheckinAt?(): Promise<number | null> | number | null;
  now?(): number;
}

/** The live reader, which also says how many owner-needed facts its last snapshot held. */
export interface RuntimeCheckinStateReader extends CheckinStateReader {
  /** Owner-needed lines in the last snapshot; null before the first. */
  ownerNeeded(): number | null;
  /**
   * What the owner-needed count was read from, each as the clause a quiet
   * check-in states ("no contract waiting for a decision"). A source the host
   * does not run is absent, so a quiet answer never claims what nobody read.
   */
  ownerSources(): readonly string[];
}

const RECENT_COMPLETION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Lines of each kind in one briefing; the counts above them stay exact. */
const MAX_LINES_PER_KIND = 5;
/** Non-channel surfaces: a session on these is a product surface, not an inbound channel. */
const PRODUCT_SURFACES = new Set(['tui', 'web', 'webui', 'agent', 'companion-chat', 'companion-task']);

function isChannelSession(session: CheckinSessionView): boolean {
  return session.surfaceKinds.some((kind) => !PRODUCT_SURFACES.has(kind));
}

function describeAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `for ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `for ${hours} h`;
  return `for ${Math.round(hours / 24)} days`;
}

const OWNER_ITEM_WORDS: Readonly<Record<string, string>> = {
  approval: 'Approval',
  question: 'Question',
  claim: 'Claim',
  purchase: 'Purchase',
  'queued-action': 'Queued action',
};

/** Build the live state reader. Deterministic given its injected views. */
export function createRuntimeCheckinStateReader(readers: CheckinRuntimeReaders): RuntimeCheckinStateReader {
  const now = readers.now ?? Date.now;
  let lastSnapshotAt: number | null = null;
  let ownerNeeded: number | null = null;
  const ownerSources = [
    ...(readers.listOwnerItems ? ['no approval or question waiting'] : []),
    ...(readers.listContracts ? ['no contract waiting for a decision'] : []),
    'no failed automation run',
  ];
  return {
    ownerNeeded: () => ownerNeeded,
    ownerSources: () => ownerSources,
    snapshot: async (): Promise<CheckinStateSnapshot> => {
      const at = now();
      const sessions = readers.listSessions();
      const open = sessions.filter((s) => s.status !== 'closed');
      const running = open.filter((s) => typeof s.activeAgentId === 'string' && s.activeAgentId.length > 0);
      const waitingOnAgent = open.filter((s) => s.pendingInputCount > 0);
      const unpickedChannelMessages = open
        .filter(isChannelSession)
        .reduce((sum, s) => sum + Math.max(0, s.pendingInputCount), 0);
      const runs = readers.listRuns();
      const recentCompletions = runs
        .filter((r) => r.status === 'completed' && typeof r.endedAt === 'number' && r.endedAt >= at - RECENT_COMPLETION_WINDOW_MS)
        .length;

      // Failed since the last check-in that delivered or judged quiet (none: one day back).
      // A check-in whose delivery failed did not move it, so its failures are told next time.
      const settledAt = readers.lastSettledCheckinAt ? await readers.lastSettledCheckinAt() : lastSnapshotAt;
      const failedSince = settledAt ?? at - RECENT_COMPLETION_WINDOW_MS;
      const failedRuns = runs
        .filter((r) => r.status === 'failed' && typeof r.endedAt === 'number' && r.endedAt > failedSince)
        .map((r) => `Automation run${r.jobId ? ` of ${r.jobId}` : ''} failed${r.error ? `: ${r.error}` : ''}`);
      const ownerItems = (readers.listOwnerItems?.() ?? [])
        .filter((item) => item.status === 'open')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((item) => `${OWNER_ITEM_WORDS[item.kind] ?? item.kind} waiting ${describeAge(at - item.createdAt)}: ${item.title}`);
      const contracts = (readers.listContracts?.() ?? [])
        .filter((contract) => contract.status === 'awaiting-owner')
        .map((contract) => {
          const question = [...contract.escalations].reverse().find((escalation) => escalation.resolvedAt === undefined)?.question;
          return `Contract "${contract.goal}" is waiting for your decision${question ? `: ${question}` : ''}`;
        });
      const ownerLines = [
        ...ownerItems.slice(0, MAX_LINES_PER_KIND),
        ...contracts.slice(0, MAX_LINES_PER_KIND),
        ...failedRuns.slice(0, MAX_LINES_PER_KIND),
      ];
      const queuedLines = waitingOnAgent
        .slice(0, MAX_LINES_PER_KIND)
        .map((s) => `${s.pendingInputCount} message${s.pendingInputCount === 1 ? '' : 's'} not yet picked up by ${s.title || 'an untitled session'}`);

      lastSnapshotAt = at;
      ownerNeeded = ownerItems.length + contracts.length + failedRuns.length;
      return {
        runningSessions: running.length,
        blockedSessions: waitingOnAgent.length,
        unreadChannelItems: unpickedChannelMessages,
        recentCompletions,
        needsAttention: [...ownerLines, ...queuedLines],
      };
    },
  };
}

/**
 * The judge, asked only when the last snapshot holds something that needs the
 * owner. A check-in with nothing owner-needed records `quiet` with no model
 * request: counts and queued messages alone are never a reason to interrupt.
 */
export function judgeOnlyWhenOwnerNeeded(judge: CheckinJudge, reader: RuntimeCheckinStateReader): CheckinJudge {
  const quiet: CheckinDecision = {
    contact: false,
    reason: `Nothing needs the owner: ${reader.ownerSources().join(', ')}.`,
  };
  return {
    decide: (briefing, options) => reader.ownerNeeded() === 0 ? Promise.resolve(quiet) : judge.decide(briefing, options),
  };
}
