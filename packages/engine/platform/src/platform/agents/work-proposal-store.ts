/**
 * Pending work proposals, the state half of the conversation-first gate.
 *
 * A proposal outlives the turn that created it (the owner may answer minutes
 * later from a phone), so it gets the standing housekeeping treatment:
 *
 * - bounded: a hard cap on simultaneously pending proposals, oldest evicted
 * - expiring: every record carries an absolute expiry; an expired proposal is
 *   not answerable, it is reported as expired
 * - content-validated: the persisted file is untrusted input; a malformed
 *   record is dropped and counted rather than throwing or being trusted
 * - reaped on recovery: the load path validates then immediately reaps, and a
 *   periodic sweep keeps a long-lived daemon from only cleaning up at boot
 * - one per source: a second request from the same conversation while one is
 *   pending folds into it, so a reply always has exactly one thing to answer
 * - disclosed: {@link WorkProposalStore.disclose} reports what was dropped and
 *   why, so a silently vanished proposal is never a mystery
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { logger } from '../utils/logger.js';
import { readDocument, writeDocument } from '../utils/atomic-json-store.js';
import { defineLifecycle } from '../utils/lifecycle-machine.js';
import { summarizeError } from '../utils/error-display.js';

export const WORK_PROPOSAL_SCHEMA_VERSION = 1;

/** How often a long-lived store re-sweeps for expired proposals. */
export const WORK_PROPOSAL_SWEEP_INTERVAL_MS = 5 * 60_000;

export type WorkProposalStatus = 'pending' | 'accepted' | 'declined' | 'expired';

/**
 * The proposal lifecycle. A proposal is answered once (accepted or declined);
 * answered and expired are final. `expired` is never assigned in memory (reap
 * deletes an unanswered proposal at its expiry rather than keeping an expired
 * row), but a persisted record can carry it and is accepted on load, so it
 * stays declared. Orthogonal to this, a proposal is answerable only once
 * `delivered` is true (see {@link WorkProposalRecord.delivered}).
 */
export const workProposalLifecycle = defineLifecycle<WorkProposalStatus>('work proposal', {
  pending: ['accepted', 'declined', 'expired'],
  accepted: [],
  declined: [],
  expired: [],
});

export interface WorkProposalRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: WorkProposalStatus;
  /** The channel the proposal was sent over, agreement must arrive here. */
  readonly surfaceKind: string;
  readonly surfaceId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly userId?: string | undefined;
  readonly sessionId?: string | undefined;
  /** The queued session input holding the owner's message, so agreeing starts the work for that message and no other. */
  readonly inputId?: string | undefined;
  /**
   * The queued inputs of earlier requests folded into this proposal: they are
   * answered, declined or closed together with `inputId`.
   */
  readonly foldedInputIds?: readonly string[] | undefined;
  /** The prompt that would be spawned if the owner agrees. */
  readonly task: string;
  /** One short line naming the work, for the proposal message. */
  readonly summary: string;
  /** How many of the owner's requests this proposal holds (absent: one). */
  readonly requestCount?: number | undefined;
  /**
   * Whether the proposal message actually reached the owner's channel.
   *
   * A proposal is created before it is sent, and the send can fail (no route
   * binding, delivery disabled for the surface, no deliverable target, the
   * transport threw). Until delivery is confirmed the owner has not SEEN this
   * proposal, so it must not be answerable: {@link WorkProposalStore.listPending}
   * excludes it, which is what stops an unrelated message from being read as
   * "yes" to a proposal that was never shown. Fails closed, a record
   * persisted without the field loads as undelivered.
   */
  readonly delivered: boolean;
}

export interface WorkProposalReapSummary {
  readonly expired: number;
  readonly overCap: number;
  readonly malformed: number;
  readonly resolved: number;
  /** Dropped because the proposal message never reached the owner's channel. */
  readonly undelivered: number;
  readonly total: number;
}

export const EMPTY_WORK_PROPOSAL_REAP_SUMMARY: WorkProposalReapSummary = {
  expired: 0,
  overCap: 0,
  malformed: 0,
  resolved: 0,
  undelivered: 0,
  total: 0,
};

interface PersistedFile {
  readonly version: number;
  readonly proposals: readonly WorkProposalRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const STATUSES: readonly WorkProposalStatus[] = ['pending', 'accepted', 'declined', 'expired'];

/** Cap on a single field so a hostile payload cannot bloat the store. */
const MAX_SUMMARY_LENGTH = 200;

/**
 * Validate one persisted entry. Returns null (never throws) for anything that
 * is not a well-formed proposal, so one bad record cannot take out the file.
 */
export function validateWorkProposal(value: unknown): WorkProposalRecord | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const task = optionalString(value.task);
  const surfaceKind = optionalString(value.surfaceKind);
  if (!id || !task || !surfaceKind) return null;
  const createdAt = value.createdAt;
  const expiresAt = value.expiresAt;
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return null;
  if ((expiresAt as number) <= (createdAt as number)) return null;
  const status = STATUSES.includes(value.status as WorkProposalStatus)
    ? (value.status as WorkProposalStatus)
    : 'pending';
  const summary = optionalString(value.summary) ?? task.slice(0, MAX_SUMMARY_LENGTH);
  return {
    id,
    createdAt: createdAt as number,
    expiresAt: expiresAt as number,
    status,
    surfaceKind,
    task,
    summary: summary.slice(0, MAX_SUMMARY_LENGTH),
    // Fails closed: a record written before this field existed, or one whose
    // delivery was never confirmed, loads as unseen and stays unanswerable.
    delivered: value.delivered === true,
    ...(optionalString(value.surfaceId) ? { surfaceId: optionalString(value.surfaceId) } : {}),
    ...(optionalString(value.routeId) ? { routeId: optionalString(value.routeId) } : {}),
    ...(optionalString(value.externalId) ? { externalId: optionalString(value.externalId) } : {}),
    ...(optionalString(value.threadId) ? { threadId: optionalString(value.threadId) } : {}),
    ...(optionalString(value.channelId) ? { channelId: optionalString(value.channelId) } : {}),
    ...(optionalString(value.userId) ? { userId: optionalString(value.userId) } : {}),
    ...(optionalString(value.sessionId) ? { sessionId: optionalString(value.sessionId) } : {}),
    ...(optionalString(value.inputId) ? { inputId: optionalString(value.inputId) } : {}),
    ...(Array.isArray(value.foldedInputIds) && value.foldedInputIds.some((entry) => typeof entry === 'string' && entry.length > 0)
      ? { foldedInputIds: value.foldedInputIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) }
      : {}),
    ...(Number.isSafeInteger(value.requestCount) && (value.requestCount as number) > 1 ? { requestCount: value.requestCount as number } : {}),
  };
}

/** The conversation a proposal answers in: the same key a reply is matched by. */
function sourceKey(record: Pick<WorkProposalRecord, 'surfaceKind' | 'userId' | 'threadId' | 'channelId' | 'externalId'>): string {
  return JSON.stringify([record.surfaceKind, record.userId ?? null, record.threadId ?? null, record.channelId ?? record.externalId ?? null]);
}

/** Why a pending proposal left the store without an answer. */
export type WorkProposalDropReason = 'expired' | 'over-cap' | 'folded';

/** Throws, with the reason, for anything but a proposals file of the current schema version. */
function parsePersistedFile(parsed: unknown): PersistedFile {
  if (!isRecord(parsed) || !Array.isArray(parsed.proposals)) throw new Error('proposals file is not an object with a proposals list');
  if (parsed.version !== WORK_PROPOSAL_SCHEMA_VERSION) {
    throw new Error(`proposals file was written by schema version ${String(parsed.version)}, expected ${WORK_PROPOSAL_SCHEMA_VERSION}`);
  }
  return parsed as unknown as PersistedFile;
}

export interface WorkProposalStoreOptions {
  /** Absent = memory only (tests, isolated contexts). */
  readonly storePath?: string | undefined;
  /** A function is read on every prune, so a config change applies without a restart. */
  readonly maxPending?: number | (() => number) | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * Called for a pending proposal that is dropped without an answer (expired,
   * pushed out by the cap, or folded into a newer proposal from the same
   * conversation), so the held message behind it can be closed instead of
   * waiting forever. A throw is logged and does not stop the reap.
   */
  readonly onUnanswered?: ((proposal: WorkProposalRecord, reason: WorkProposalDropReason) => void) | undefined;
}

export interface CreateWorkProposalInput {
  readonly surfaceKind: string;
  readonly task: string;
  readonly summary: string;
  readonly ttlMs: number;
  readonly surfaceId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly userId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly inputId?: string | undefined;
}

export class WorkProposalStore {
  private readonly proposals = new Map<string, WorkProposalRecord>();
  private readonly storePath: string | undefined;
  private readonly maxPending: () => number;
  private readonly now: () => number;
  private readonly onUnanswered: ((proposal: WorkProposalRecord, reason: WorkProposalDropReason) => void) | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInterval = WORK_PROPOSAL_SWEEP_INTERVAL_MS;
  private sweepEnabled = true;
  private lastReap: WorkProposalReapSummary = EMPTY_WORK_PROPOSAL_REAP_SUMMARY;
  private loadMalformed = 0;
  /**
   * Set when a store file existed but could not be used. A file that reads but
   * does not parse is moved aside (`preserved`) before anything is written; one
   * that cannot even be read is reported and replaced by the next change.
   */
  private unreadableStore: { readonly preserved: boolean; readonly detail: string } | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private initialization: Promise<WorkProposalReapSummary> | null = null;

  constructor(options: WorkProposalStoreOptions = {}) {
    this.storePath = options.storePath;
    this.onUnanswered = options.onUnanswered;
    const configured = options.maxPending ?? 20;
    this.maxPending = () => {
      const value = typeof configured === 'function' ? configured() : configured;
      return Number.isFinite(value) ? Math.max(1, value) : 20;
    };
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Load, validate, and reap. Fail-safe: an unreadable or corrupt store means
   * no pending proposals, never a crash, the worst case is that the owner
   * has to ask again, which is strictly better than answering a bad record.
   * The unusable file itself is preserved, not overwritten by the next write.
   */
  init(): Promise<WorkProposalReapSummary> {
    return this.initialization ??= this.load();
  }

  private async load(): Promise<WorkProposalReapSummary> {
    const path = this.storePath;
    if (path) {
      const name = basename(path);
      const existed = existsSync(path);
      try {
        // An unusable file is moved aside with a receipt by the document reader, once, here.
        const file = readDocument<PersistedFile>(path, {
          label: 'work-proposals',
          recovery: 'Pending work proposals started empty, so the owner has to ask again; the proposals the preserved copy held are not applied and can be read from it by hand.',
          validate: parsePersistedFile,
        });
        if (file) {
          for (const entry of file.proposals) {
            const record = validateWorkProposal(entry);
            if (!record) {
              this.loadMalformed += 1;
              continue;
            }
            this.proposals.set(record.id, record);
          }
        } else if (existed) {
          this.unreadableStore = { preserved: true, detail: `${name} could not be used and was moved aside as ${name}.corrupt-<time>; pending proposals started empty` };
        }
      } catch (error) {
        // The proposals it held expire within their TTL and the owner's messages stay in the session,
        // so the next change replaces the file rather than leaving new proposals unsaved for the run.
        const reason = summarizeError(error);
        this.unreadableStore = { preserved: false, detail: `${name} could not be read or moved aside (${reason}); pending proposals started empty and the next change replaces it` };
        logger.warn('WorkProposalStore: store file could not be read or preserved; starting empty', { error: reason });
      }
    }
    const summary = this.reap();
    this.ensureSweep();
    return summary;
  }

  /** Resume housekeeping explicitly, including after an owner's restart. */
  startSweep(intervalMs = WORK_PROPOSAL_SWEEP_INTERVAL_MS): void {
    this.sweepInterval = intervalMs;
    this.sweepEnabled = true;
    this.ensureSweep();
  }

  private ensureSweep(): void {
    if (!this.sweepEnabled || this.sweepTimer || this.proposals.size === 0) return;
    // Resolved records are retained until expiry too. Stopping when only
    // resolved records remain would leave them in an idle store indefinitely.
    this.sweepTimer = setInterval(() => {
      const summary = this.reap();
      if (summary.total > 0) void this.persist();
      if (this.proposals.size === 0) this.clearSweep();
    }, this.sweepInterval);
    this.sweepTimer.unref?.();
  }

  private clearSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  dispose(): void {
    // init() can still be reading disk. Its eventual completion and ordinary
    // writes must not re-arm this stopped owner; only startSweep can.
    // Mutations are fenced synchronously so flush() drains a closed write set.
    this.sweepEnabled = false;
    this.clearSweep();
  }

  /**
   * Create the proposal for a work request. When the same conversation already
   * has a pending proposal, the new request is folded into it: one new proposal
   * whose task lists both, with a fresh expiry and a fresh notice, and the older
   * record is dropped (reported to `onUnanswered` as `folded`). The older
   * record's held inputs travel on the new one (`foldedInputIds`), so they are
   * settled with its answer instead of being closed as unanswered. Two pending
   * proposals on one source would leave every reply ambiguous.
   */
  create(input: CreateWorkProposalInput): WorkProposalRecord {
    if (!this.sweepEnabled) throw new Error('Work proposal store is stopped');
    this.reap();
    const createdAt = this.now();
    const key = sourceKey(input);
    const earlier = [...this.proposals.values()].find((record) => record.status === 'pending' && sourceKey(record) === key);
    if (earlier) {
      this.proposals.delete(earlier.id);
      this.notifyUnanswered(earlier, 'folded');
      logger.info('Work proposal folded into a newer request from the same conversation', { proposalId: earlier.id, surface: earlier.surfaceKind });
    }
    const requestCount = (earlier?.requestCount ?? (earlier ? 1 : 0)) + 1;
    const foldedInputIds = earlier ? [...(earlier.foldedInputIds ?? []), ...(earlier.inputId ? [earlier.inputId] : [])] : [];
    const record: WorkProposalRecord = {
      id: `wp_${randomUUID()}`,
      createdAt,
      expiresAt: createdAt + Math.max(1, input.ttlMs),
      status: 'pending',
      surfaceKind: input.surfaceKind,
      task: earlier ? `${earlier.task}\n\nAlso requested in the same conversation before the proposal was answered:\n${input.task}` : input.task,
      summary: (earlier ? `${earlier.summary}; ${input.summary}` : input.summary).slice(0, MAX_SUMMARY_LENGTH),
      ...(requestCount > 1 ? { requestCount } : {}),
      // Not answerable until the send is confirmed, see markDelivered.
      delivered: false,
      ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
      ...(input.routeId ? { routeId: input.routeId } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.inputId ? { inputId: input.inputId } : {}),
      ...(foldedInputIds.length > 0 ? { foldedInputIds } : {}),
    };
    this.proposals.set(record.id, record);
    this.ensureSweep();
    const overCap = this.enforceCap();
    if (overCap > 0) {
      // Disclose the eviction: a proposal that vanished because the cap was
      // reached must be visible in the housekeeping report, not silent.
      this.lastReap = {
        ...this.lastReap,
        overCap: this.lastReap.overCap + overCap,
        total: this.lastReap.total + overCap,
      };
    }
    void this.persist();
    return record;
  }

  get(id: string): WorkProposalRecord | null {
    this.reap();
    return this.proposals.get(id) ?? null;
  }

  /**
   * Confirm that the proposal message reached the owner's channel. Only after
   * this does the proposal become answerable.
   */
  markDelivered(id: string): WorkProposalRecord | null {
    if (!this.sweepEnabled) return null;
    const record = this.proposals.get(id);
    if (!record || record.status !== 'pending' || record.delivered) return null;
    const delivered: WorkProposalRecord = { ...record, delivered: true };
    this.proposals.set(id, delivered);
    void this.persist();
    return delivered;
  }

  /**
   * The proposal never reached the owner. Drop it rather than leaving a
   * proposal pending that nobody can answer, and, more importantly, that a
   * later unrelated message could be matched against.
   */
  markUndeliverable(id: string, reason: string): void {
    if (!this.sweepEnabled) return;
    const record = this.proposals.get(id);
    if (!record) return;
    this.proposals.delete(id);
    this.lastReap = {
      ...this.lastReap,
      undelivered: this.lastReap.undelivered + 1,
      total: this.lastReap.total + 1,
    };
    logger.error('Work proposal dropped: the owner was never shown it', {
      proposalId: id,
      surface: record.surfaceKind,
      routeId: record.routeId ?? null,
      summary: record.summary,
      reason,
    });
    void this.persist();
  }

  /**
   * Pending proposals, newest first, optionally narrowed to one surface.
   *
   * The reap runs first so an expired proposal is never returned as
   * answerable, and undelivered proposals are excluded: a proposal the owner
   * was never shown cannot be the thing their next message was answering.
   */
  listPending(filter: { readonly surfaceKind?: string | undefined; readonly userId?: string | undefined } = {}): WorkProposalRecord[] {
    if (!this.sweepEnabled) return [];
    this.reap();
    return [...this.proposals.values()]
      .filter((record) => record.status === 'pending' && record.delivered)
      .filter((record) => !filter.surfaceKind || record.surfaceKind === filter.surfaceKind)
      .filter((record) => !filter.userId || !record.userId || record.userId === filter.userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Resolve a proposal. Returns null when the id is unknown, the proposal is
   * no longer pending (an already-answered or expired proposal cannot be
   * answered a second time), or its message was never confirmed delivered (the
   * owner has not seen it, so there is nothing for them to have answered).
   */
  resolve(id: string, outcome: 'accepted' | 'declined'): WorkProposalRecord | null {
    if (!this.sweepEnabled) return null;
    this.reap();
    const record = this.proposals.get(id);
    if (!record || !record.delivered || !workProposalLifecycle.can(record.status, outcome)) return null;
    const resolved: WorkProposalRecord = { ...record, status: outcome };
    this.proposals.set(id, resolved);
    void this.persist();
    return resolved;
  }

  /**
   * Drop expired, resolved, and over-cap records. Pure with respect to I/O,
   * the caller persists. Safe to call on every read path.
   */
  reap(): WorkProposalReapSummary {
    const now = this.now();
    let expired = 0;
    let resolved = 0;
    for (const [id, record] of this.proposals) {
      if (record.status !== 'pending') {
        // Resolved records are kept only long enough to answer a duplicate
        // reply arriving right behind the first one.
        if (now - record.createdAt > record.expiresAt - record.createdAt) {
          this.proposals.delete(id);
          resolved += 1;
        }
        continue;
      }
      if (record.expiresAt <= now) {
        this.proposals.delete(id);
        this.notifyUnanswered(record, 'expired');
        expired += 1;
      }
    }
    const overCap = this.enforceCap();
    const summary: WorkProposalReapSummary = {
      expired,
      overCap,
      malformed: this.loadMalformed,
      resolved,
      // Undelivered records are dropped eagerly by markUndeliverable, not by
      // the sweep, so the per-reap count is always zero; the cumulative
      // disclosure below is where they show up.
      undelivered: 0,
      total: expired + overCap + this.loadMalformed + resolved,
    };
    this.loadMalformed = 0;
    if (summary.total > 0) {
      this.lastReap = {
        expired: this.lastReap.expired + summary.expired,
        overCap: this.lastReap.overCap + summary.overCap,
        malformed: this.lastReap.malformed + summary.malformed,
        resolved: this.lastReap.resolved + summary.resolved,
        undelivered: this.lastReap.undelivered,
        total: this.lastReap.total + summary.total,
      };
    }
    return summary;
  }

  /** Cumulative housekeeping disclosure, what was dropped and why. */
  disclose(): {
    readonly pending: number;
    readonly awaitingDelivery: number;
    readonly tracked: number;
    readonly reaped: WorkProposalReapSummary;
    /** Present when the store file on disk could not be used; says whether it was kept and why proposals started empty. */
    readonly unreadableStore?: { readonly preserved: boolean; readonly detail: string };
  } {
    const pending = [...this.proposals.values()].filter((record) => record.status === 'pending');
    return {
      pending: pending.length,
      // Created but not yet confirmed on the wire, so not answerable yet.
      awaitingDelivery: pending.filter((record) => !record.delivered).length,
      tracked: this.proposals.size,
      reaped: this.lastReap,
      ...(this.unreadableStore ? { unreadableStore: this.unreadableStore } : {}),
    };
  }

  private enforceCap(): number {
    const pending = [...this.proposals.values()]
      .filter((record) => record.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    const maxPending = this.maxPending();
    if (pending.length <= maxPending) return 0;
    const excess = pending.slice(0, pending.length - maxPending);
    for (const record of excess) {
      this.proposals.delete(record.id);
      this.notifyUnanswered(record, 'over-cap');
    }
    return excess.length;
  }

  private notifyUnanswered(record: WorkProposalRecord, reason: WorkProposalDropReason): void {
    if (!this.onUnanswered) return;
    try {
      this.onUnanswered(record, reason);
    } catch (error) {
      logger.warn('A dropped work proposal could not be settled', {
        proposalId: record.id,
        error: summarizeError(error),
      });
    }
  }

  /** Best-effort durable write, serialized so concurrent resolves cannot interleave. */
  private persist(): Promise<void> {
    const path = this.storePath;
    if (!path) return Promise.resolve();
    this.writeChain = this.writeChain.then(async () => {
      try {
        // Constructor-time loading and admitted mutations share this existing
        // write chain. Never overwrite persisted proposals with a pre-load
        // snapshot, and let flush() drain the read needed by accepted writes.
        await this.initialization;
        const snapshot: PersistedFile = {
          version: WORK_PROPOSAL_SCHEMA_VERSION,
          proposals: [...this.proposals.values()],
        };
        writeDocument(path, snapshot);
      } catch (error) {
        logger.warn('WorkProposalStore: persist failed', { error: summarizeError(error) });
      }
    });
    return this.writeChain;
  }

  /** Drain every write admitted before the caller closed this store. */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}
