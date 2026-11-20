import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { openRecordLog, type RecordLog } from '../state/record-log.js';
import { noteCarriedForward } from '../state/carried-forward.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { WITHHELD_PROMPT_ANSWER, type PermissionPromptDecision, type PermissionPromptRequest, type PermissionRequestHandler } from '../permissions/prompt.js';
import { buildDurableRuleForDecision, compileRules, type CompiledRuleMatch } from '../permissions/approval-rules.js';
import type { ControlPlaneSurfaceMessage } from './types.js';
import type { AskPresentation } from '../permissions/ask-presentation.js';
import { logger } from '../utils/logger.js';
import { isRecord } from '../utils/record-coerce.js';
import { contentDigest } from '../utils/target-ref.js';
import { resolveApprovalHunkSelection } from './approval-hunk-apply.js';
import { raiseSharedApproval, type PendingApprovalEntry, type RaisedApproval } from './approval-broker-raise.js';
import { OwnerApprovalAuthority, type OwnerApprovalGuard, type OwnerApprovalProof, type RaisedOwnerApproval, type ResolveSharedApprovalInput } from './approval-broker-owner.js';
import { awaitPermission } from '../permissions/cancellation.js';
import { assertExplicitApprovalDisposition, finishedApprovalOutcome, isSharedApprovalDisposition, ordinaryApprovalDecision, type SharedApprovalDecision } from './approval-disposition.js';
import {
  adminApprovalViewer,
  approvalLifecycle,
  approvalRefusal,
  isOpenApprovalStatus,
  readApproval,
  type ApprovalActor,
  type ApprovalCause,
  type ApprovalHold,
  type ApprovalRequester,
  type ApprovalTransition,
  type TransitionOutcome,
  type TransitionRequest,
} from './approval-lifecycle.js';

/**
 * `claimed` is advisory: it records who said they are handling an ask so other
 * surfaces can show it, and gates nothing. Any participant may still approve,
 * deny or cancel a claimed ask, and a later claim replaces `claimedBy`.
 */
export type SharedApprovalStatus = 'pending' | 'claimed' | 'approved' | 'denied' | 'cancelled' | 'expired';

export interface SharedApprovalAuditRecord {
  readonly id: string;
  readonly action: 'created' | 'claimed' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'updated';
  readonly actor: string;
  readonly actorSurface?: string | undefined;
  /** The node the actor reached; absent for the broker's own moves (they happen on the home node). */
  readonly actorNode?: string | undefined;
  readonly createdAt: number;
  readonly note?: string | undefined;
}

export interface SharedApprovalRecord {
  readonly id: string;
  readonly callId: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly status: SharedApprovalStatus;
  readonly request: PermissionPromptRequest;
  /** Deny-only durable marker; approval also requires an ephemeral host capability. */
  readonly requiresOwnerDecision?: true | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * 1 when raised, +1 on every change of what can be decided (a claim, a
   * decision, an end). An action presents the revision it read
   * (`expectedRevision`). A note about the ask (a prompt that could not be
   * delivered, a remote run's report) or a raiser's hold does not move it.
   */
  readonly revision: number;
  /** 1 when raised, +1 on every write of the record, notes and holds included: what update frames are ordered by. */
  readonly sequence: number;
  /** The node whose broker owns this record and decides it: the daemon's cluster node id, `local` outside a daemon. */
  readonly homeNode: string;
  /** Who waits for the answer; what the reading's receipt is read from. */
  readonly requester: ApprovalRequester;
  /** Why it ended when no decision ended it (cancelled, expired), or that a remembered rule settled it. */
  readonly cause?: ApprovalCause | undefined;
  readonly claimedBy?: string | undefined;
  readonly claimedAt?: number | undefined;
  readonly resolvedAt?: number | undefined;
  readonly resolvedBy?: string | undefined;
  readonly decision?: SharedApprovalDecision | undefined;
  /**
   * When this ask stops waiting, for asks that were given a timeout.
   *
   * PERSISTED deliberately: the expiry timer is in memory and rebuilt empty on
   * start, so the deadline on the record is what lets `start()` re-arm it, or
   * expire it at once when the deadline passed while the process was down.
   */
  readonly expiresAt?: number | undefined;
  readonly metadata: Record<string, unknown>;
  readonly audit: readonly SharedApprovalAuditRecord[];
}


export interface RequestSharedApprovalInput {
  readonly request: PermissionPromptRequest;
  /** In-process consumer lifetime only; never persisted in request or metadata. */
  readonly signal?: AbortSignal | undefined;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly localPrompt?: PermissionRequestHandler | undefined;
  /** Host-only guard; never reconstructed from metadata or accepted over the wire. */
  readonly requireOwnerDecision?: OwnerApprovalGuard | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Which surface the local prompt belongs to, for the audit trail. Defaults
   * to the terminal app ('tui'/'tui-local') for callers that do not say.
   */
  readonly localPromptSurface?: string | undefined;
  readonly localPromptActor?: string | undefined;
}

/** What the approvals port needs of the cross-node relay (approval-relay.ts implements it). */
export interface ApprovalRelayPort {
  remote(): readonly SharedApprovalRecord[];
  get(node: string, id: string): SharedApprovalRecord | null;
  reachable(node: string): boolean;
  forward(node: string, id: string, input: {
    readonly action: 'claim' | 'approve' | 'deny' | 'amend' | 'cancel';
    readonly expectedRevision: number;
    readonly reason?: string | undefined;
    readonly note?: string | undefined;
    readonly selectedHunks?: readonly number[] | undefined;
  }, viewer: import('./approval-lifecycle.js').ApprovalViewer): Promise<import('./approval-lifecycle.js').TransitionOutcome & { readonly reading: import('./approval-lifecycle.js').ApprovalReading | null }>;
}

/** Who acts on an approval, and the revision of the record they acted on. */
export interface ApprovalActionInput {
  readonly actor: string;
  readonly actorSurface?: string | undefined;
  /** The node the actor reached; the home node when absent. */
  readonly actorNode?: string | undefined;
  readonly note?: string | undefined;
  /**
   * The revision of the record the caller showed or read. Required of every
   * caller; `undefined` only for the broker's own timer, signal, restart and
   * local-prompt paths.
   */
  readonly expectedRevision: number | undefined;
}

type ApprovalListener = (approval: SharedApprovalRecord) => void;
type ApprovalPublisher = {
  publishEvent(event: string, payload: unknown): void;
  publishSurfaceMessage(message: Omit<ControlPlaneSurfaceMessage, 'id' | 'createdAt'>): void;
};

function sortApprovals(records: Iterable<SharedApprovalRecord>): SharedApprovalRecord[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/**
 * Settled approvals nobody decided (withdrawn, expired, or settled by a
 * remembered rule) kept in memory and on disk; the oldest past this leave.
 * An approval a person approved or denied is never dropped: it is what the
 * owner allowed or refused, when and for what. Open approvals are never
 * counted or evicted: they have a live waiter.
 */
const MAX_APPROVAL_RECORDS = 500;

/** Approved or denied by a person (not by a remembered rule): kept for good. */
function decidedByPerson(record: SharedApprovalRecord): boolean {
  return (record.status === 'approved' || record.status === 'denied') && record.cause !== 'remembered-rule';
}
const WITHHELD_ANSWER = WITHHELD_PROMPT_ANSWER;
const TERMINAL_APPROVAL_STATUSES = new Set<SharedApprovalStatus>(['approved', 'denied', 'cancelled', 'expired']);
/** The home node of a broker outside a daemon, whose records never leave its process. */
export const LOCAL_APPROVAL_NODE = 'local';

const APPROVAL_AUDIT_ACTIONS = new Set<SharedApprovalAuditRecord['action']>([
  'created', 'claimed', 'approved', 'denied', 'cancelled', 'expired', 'updated',
]);
const APPROVAL_CAUSES = new Set<ApprovalCause>([
  'requester-left', 'requester-restarted', 'cancelled-by-actor', 'owner-decision-stale', 'deadline', 'deadline-while-down', 'remembered-rule',
]);
const PERMISSION_CATEGORIES = new Set(['read', 'write', 'execute', 'delegate']);
const PERMISSION_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function throwInvalidApprovalSnapshot(): never {
  throw new Error('Shared approval store snapshot is invalid.');
}

function validateOptionalString(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') throwInvalidApprovalSnapshot();
}

function validateOptionalNumber(value: unknown): void {
  if (value !== undefined && !isFiniteNumber(value)) throwInvalidApprovalSnapshot();
}

function validatePermissionPromptRequestSnapshot(value: unknown): void {
  if (!isRecord(value)) throwInvalidApprovalSnapshot();
  const category = value['category'];
  if (
    typeof value['callId'] !== 'string'
    || typeof value['tool'] !== 'string'
    || !isRecord(value['args'])
    || typeof category !== 'string'
    || !PERMISSION_CATEGORIES.has(category)
  ) {
    throwInvalidApprovalSnapshot();
  }
  const analysis = value['analysis'];
  if (!isRecord(analysis)) throwInvalidApprovalSnapshot();
  const riskLevel = analysis['riskLevel'];
  if (
    typeof analysis['classification'] !== 'string'
    || typeof riskLevel !== 'string'
    || !PERMISSION_RISK_LEVELS.has(riskLevel)
    || typeof analysis['summary'] !== 'string'
    || !isStringArray(analysis['reasons'])
  ) {
    throwInvalidApprovalSnapshot();
  }
  validateOptionalString(value['workingDirectory']);
  validateOptionalString(value['ownerOnly']);
}

function validateApprovalAuditRecord(value: unknown): void {
  if (!isRecord(value)) throwInvalidApprovalSnapshot();
  if (
    typeof value['id'] !== 'string'
    || typeof value['action'] !== 'string'
    || !APPROVAL_AUDIT_ACTIONS.has(value['action'] as SharedApprovalAuditRecord['action'])
    || typeof value['actor'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
  ) {
    throwInvalidApprovalSnapshot();
  }
  validateOptionalString(value['actorSurface']);
  validateOptionalString(value['actorNode']);
  validateOptionalString(value['note']);
}

function validateRequester(value: unknown): void {
  if (!isRecord(value)) throwInvalidApprovalSnapshot();
  const kind = value['kind'];
  if (kind === 'in-process' || kind === 'record-reader') return;
  if (kind !== 'wire' || !Array.isArray(value['holds'])) throwInvalidApprovalSnapshot();
  for (const hold of value['holds'] as unknown[]) {
    if (!isRecord(hold) || typeof hold['id'] !== 'string') throwInvalidApprovalSnapshot();
    validateOptionalNumber(hold['releasedAt']);
  }
}

/** An open ask as stored: its waiter may still be watching it, so it must be readable. */
function isStoredOpenApproval(value: unknown): boolean {
  return isRecord(value) && (value['status'] === 'pending' || value['status'] === 'claimed');
}

/**
 * Read one stored approval. A finished record stores only its disposition
 * (plus the verdict for `remembered`); its status and `approved` are derived
 * here by the one rule in approval-disposition.ts. A record without a
 * revision, home node or requester is not one this version wrote.
 */
function decodeStoredApproval(value: unknown): SharedApprovalRecord {
  if (!isRecord(value)) throwInvalidApprovalSnapshot();
  if (
    typeof value['id'] !== 'string'
    || typeof value['callId'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
    || !isFiniteNumber(value['updatedAt'])
    || !Number.isInteger(value['revision']) || (value['revision'] as number) < 1
    || !Number.isInteger(value['sequence']) || (value['sequence'] as number) < 1
    || typeof value['homeNode'] !== 'string' || value['homeNode'].length === 0
    || !isRecord(value['metadata'])
    || !Array.isArray(value['audit'])
  ) {
    throwInvalidApprovalSnapshot();
  }
  validatePermissionPromptRequestSnapshot(value['request']);
  validateRequester(value['requester']);
  validateOptionalString(value['sessionId']);
  validateOptionalString(value['routeId']);
  validateOptionalString(value['claimedBy']);
  validateOptionalNumber(value['claimedAt']);
  validateOptionalNumber(value['resolvedAt']);
  validateOptionalNumber(value['expiresAt']);
  validateOptionalString(value['resolvedBy']);
  if (value['cause'] !== undefined && !APPROVAL_CAUSES.has(value['cause'] as ApprovalCause)) throwInvalidApprovalSnapshot();
  if (value['requiresOwnerDecision'] !== undefined && value['requiresOwnerDecision'] !== true) throwInvalidApprovalSnapshot();
  for (const audit of value['audit']) validateApprovalAuditRecord(audit);
  const storedStatus = value['status'];
  const decision = value['decision'];
  if (decision === undefined) {
    if (storedStatus !== 'pending' && storedStatus !== 'claimed') throwInvalidApprovalSnapshot();
    return value as unknown as SharedApprovalRecord;
  }
  if (!isRecord(decision)) throwInvalidApprovalSnapshot();
  if (decision['remember'] !== undefined && typeof decision['remember'] !== 'boolean') throwInvalidApprovalSnapshot();
  const disposition = decision['disposition'];
  if (!isSharedApprovalDisposition(disposition)) throwInvalidApprovalSnapshot();
  if (disposition === 'amended' && (decision['remember'] === true || decision['rememberTier'] !== undefined)) throwInvalidApprovalSnapshot();
  const outcome = finishedApprovalOutcome(disposition, typeof decision['approved'] === 'boolean' ? decision['approved'] : undefined);
  if (!outcome) throwInvalidApprovalSnapshot();
  return { ...value, status: outcome.status, decision: { ...decision, approved: outcome.approved } } as unknown as SharedApprovalRecord;
}

/**
 * A record of the snapshot file 3.3.1 kept (`approvals.json`, `{ approvals: [...] }`),
 * in the form this version stores. Revision and sequence start at 1 and the
 * home node is this broker's. The requester is the one 3.3.1 implied: an ask
 * raised over the wire stayed open for its caller after a restart, and any
 * other open ask was cancelled. A finished record written before dispositions
 * takes the disposition its status names. The result is read by
 * decodeStoredApproval like any other line.
 */
function approvalFromSnapshotFile(value: unknown, homeNode: string): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value['id'] !== 'string') return null;
  const metadata = value['metadata'];
  const upgraded: Record<string, unknown> = {
    ...value,
    revision: 1,
    sequence: 1,
    homeNode,
    requester: isRecord(metadata) && metadata['raisedVia'] === 'approvals.raise' ? { kind: 'wire', holds: [] } : { kind: 'in-process' },
  };
  const decision = value['decision'];
  const status = value['status'];
  if (isRecord(decision) && decision['disposition'] === undefined && typeof status === 'string'
    && TERMINAL_APPROVAL_STATUSES.has(status as SharedApprovalStatus)) {
    upgraded['decision'] = { ...decision, disposition: status };
  }
  return upgraded;
}

/** The words a settled approval keeps, as shown when it was decided (ApprovalBroker #keepWording). */
export interface SettledApprovalWording {
  readonly title: string;
  readonly question: string;
  readonly subject?: { readonly kind: 'command' | 'paths' | 'urls' | 'text' | 'money'; readonly lines: readonly string[] } | undefined;
  readonly consequence?: string | undefined;
}

export function isSettledWording(value: unknown): value is SettledApprovalWording {
  return isRecord(value) && typeof value['title'] === 'string' && typeof value['question'] === 'string';
}

/** The fields of an ask's presentation a settled record's kept words replace; what was not kept is left out, not rebuilt. */
export function settledPresentation(wording: SettledApprovalWording): Pick<AskPresentation, 'title' | 'question' | 'subject' | 'consequence'> {
  return {
    title: wording.title,
    question: wording.question,
    subject: wording.subject,
    consequence: wording.consequence === undefined ? undefined : { text: wording.consequence, withPlace: wording.consequence, tone: 'plain' },
  };
}

/** Words for a settled ask whose own words were not kept (settled by 3.3.1, or before words were kept): what happened, and when. */
function unwordedSettlement(status: SharedApprovalStatus, at: number): SettledApprovalWording {
  const day = new Date(at).toISOString().slice(0, 10);
  const what = status === 'approved' ? `A request you approved on ${day}`
    : status === 'denied' ? `A request you refused on ${day}`
      : status === 'expired' ? `A request that expired unanswered on ${day}` : `A request that was withdrawn on ${day}`;
  return { title: what, question: what };
}

/** A settled record read without kept words gets the words that say what happened; an open one is worded live. */
function withSettledWording(record: SharedApprovalRecord): SharedApprovalRecord {
  if (isOpenApprovalStatus(record.status) || isSettledWording(record.metadata['wording'])) return record;
  return { ...record, metadata: { ...record.metadata, wording: unwordedSettlement(record.status, record.resolvedAt ?? record.updatedAt) } };
}

function argumentsDigest(args: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(args)).digest('hex')}`;
}

/** The stored form of each finished record, built once per record object (records are replaced, never mutated). */
const storedFinishedRecords = new WeakMap<SharedApprovalRecord, Record<string, unknown>>();

/**
 * What goes on disk. An open ask keeps everything: its arguments are what
 * the owner is being shown. A finished one keeps the tool name, the summary
 * and a digest of the arguments instead of the arguments themselves (which
 * for a write or an edit are file contents), and only its disposition in
 * place of status and verdict. The record in memory is unchanged, so the
 * surfaces and waiters of this process still see the full decision.
 */
function encodeStoredApproval(record: SharedApprovalRecord): SharedApprovalRecord | Record<string, unknown> {
  if (!TERMINAL_APPROVAL_STATUSES.has(record.status) || record.decision === undefined) return record;
  const cached = storedFinishedRecords.get(record);
  if (cached) return cached;
  const { status: _status, decision, request, metadata, ...rest } = record;
  const { approved, modifiedArgs, disposition, ...decisionRest } = decision;
  const stored: Record<string, unknown> = {
    ...rest,
    request: { ...request, args: {} },
    metadata: {
      ...metadata,
      argumentsDigest: typeof metadata['argumentsDigest'] === 'string' ? metadata['argumentsDigest'] : argumentsDigest(request.args),
      ...(modifiedArgs !== undefined ? { modifiedArgumentsDigest: argumentsDigest(modifiedArgs) } : {}),
    },
    decision: disposition === 'remembered' ? { ...decisionRest, approved, disposition } : { ...decisionRest, disposition },
  };
  storedFinishedRecords.set(record, stored);
  return stored;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildAudit(action: SharedApprovalAuditRecord['action'], actor: string, actorSurface?: string, note?: string, actorNode?: string): SharedApprovalAuditRecord {
  return {
    id: `apra-${randomUUID().slice(0, 8)}`,
    action,
    actor,
    actorSurface,
    ...(actorNode !== undefined ? { actorNode } : {}),
    createdAt: Date.now(),
    ...(note ? { note } : {}),
  };
}

/** Deterministic JSON for coalescing, object keys sorted at every level. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Identical concurrent asks coalesce on this key: one prompt answers all. */
function approvalCoalesceKey(sessionId: string | undefined, tool: string, args: Record<string, unknown>): string {
  return `${sessionId ?? ''}|${tool}|${stableJson(args)}`;
}

/** The broker's own moves (timer, signal, restart) are made by it, on its node. */
const BROKER_ACTOR: ApprovalActor = { id: 'approval-broker', surface: 'service' };

/** A transition the unit decided to apply, with what the waiters and the caller get afterwards. */
interface PlannedTransition {
  readonly request: TransitionRequest;
  readonly current: SharedApprovalRecord | null;
  readonly next?: SharedApprovalRecord | undefined;
  /** Set when the caller's action was not applied as asked (the record may still have moved, e.g. expired). */
  readonly refusal?: ReturnType<typeof approvalRefusal> | undefined;
  readonly withheldAnswer?: string | undefined;
  /** The owner proof's check, run before and after the write. */
  readonly ownerCheck?: (() => void) | undefined;
}

/**
 * When the log holds this many lines more than the records it keeps, it is
 * compacted to one line per kept record (one temp file, one rename), inside
 * the write that crossed it.
 */
const COMPACT_SLACK = 1_000;

/** The log at `storePath` (`approvals.jsonl`); a `.json` name is read as the `.jsonl` beside it. */
function approvalLogPath(storePath: string): string {
  return storePath.endsWith('.jsonl') ? storePath : storePath.endsWith('.json') ? `${storePath}l` : `${storePath}.jsonl`;
}

export class ApprovalBroker {
  /**
   * The approvals log: one line per change of one record (the record as
   * stored), appended and synced in one write; the newest line per id is the
   * record. Opened on first load.
   */
  private log: RecordLog<Record<string, unknown>> | null = null;
  private readonly logPath: string;
  /** Deny-direction records applied in memory after a failed write: written ahead of the next record. */
  readonly #unsaved = new Set<string>();
  private readonly approvals = new Map<string, SharedApprovalRecord>();
  private readonly pendingResolvers = new Map<string, PendingApprovalEntry>();
  /** Raises being written, by coalesce key: an identical raise waits for the first one's write instead of making its own record. */
  private readonly raising = new Map<string, Promise<void>>();
  readonly #ownerApprovals = new OwnerApprovalAuthority();
  /** What an approval puts in effect when approved, run inside the answer (onApproved). */
  readonly #approvedEffects = new Map<string, () => unknown | Promise<unknown>>();
  private readonly listeners = new Set<ApprovalListener>();
  /** Every write runs one at a time, in call order; each transition is checked and written inside one unit. */
  private readonly writes = new StoreWriteQueue();
  private publisher: ApprovalPublisher | null = null;
  private loaded = false;
  /** One load at a time: a second early caller must not clear a map the first already filled. */
  private loading: Promise<void> | null = null;
  /** Names the store in a notice about a record that cannot be read. */
  private readonly storeFile: string;
  #homeNode: string | (() => string);
  /** Words each ask with the host's facts (permissions/ask-facts-host.ts); set by the composition that has them. */
  #presenter: ((request: PermissionPromptRequest, sessionId?: string | undefined) => AskPresentation) | null = null;

  constructor(
    options: {
      /** Where approvals are kept: a `.jsonl` log (a `.json` name is read as the `.jsonl` beside it). */
      readonly storePath: string;
      /** This broker's node: the daemon's cluster node id (read on first raise), `local` elsewhere. */
      readonly nodeId?: string | (() => string) | undefined;
    },
  ) {
    if (!options.storePath) throw new Error('ApprovalBroker requires a storePath.');
    this.logPath = approvalLogPath(options.storePath);
    this.storeFile = this.logPath;
    this.#homeNode = options.nodeId ?? LOCAL_APPROVAL_NODE;
  }

  /** The node that owns this broker's records. Resolved once, when first asked. */
  get homeNode(): string {
    if (typeof this.#homeNode === 'function') {
      try {
        this.#homeNode = this.#homeNode();
      } catch (error) {
        logger.warn('This node\'s id could not be read; approvals are recorded as local', { error: failureText(error) });
        this.#homeNode = LOCAL_APPROVAL_NODE;
      }
    }
    return this.#homeNode;
  }

  /** Other nodes' approvals, read and decided through the group (approval-relay.ts); null outside a group. */
  #relay: ApprovalRelayPort | null = null;

  /** The daemon wires the cross-node relay when it is in a group; the approvals port reads it. */
  useRelay(relay: ApprovalRelayPort | null): void {
    this.#relay = relay;
  }

  get relay(): ApprovalRelayPort | null {
    return this.#relay;
  }

  /** The daemon names its cluster node once it is composed, before anything is raised. */
  useHomeNode(nodeId: string | (() => string)): void {
    this.#homeNode = nodeId;
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setPublisher(publisher: ApprovalPublisher | null): void {
    this.publisher = publisher;
  }

  /** The gateway this broker publishes on; the owner inbox built over it publishes its own items there too. */
  get eventPublisher(): Pick<ApprovalPublisher, 'publishEvent'> | null {
    return this.publisher;
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    this.loading ??= this.load().catch((error: unknown) => {
      // A failed load is retried by the next caller rather than remembered.
      this.loading = null;
      throw error;
    });
    await this.loading;
  }

  /**
   * A finished record that cannot be read is set aside with a notice naming
   * the file and the id, and loading carries on: it answers nobody. An open
   * ask that cannot be read stops the load, because a waiter may still be
   * watching it and dropping it would leave that waiter with no answer.
   */
  private async load(): Promise<void> {
    this.log?.close();
    const log = openRecordLog<Record<string, unknown>>(this.logPath, { fsync: 'each' });
    this.log = log;
    if (log.size === 0) this.#carryForwardSnapshotFile(log);
    // The newest line of each id is its record.
    const newest = new Map<string, unknown>();
    let position = 0;
    for (const line of log.scan()) {
      position += 1;
      newest.set(typeof line['id'] === 'string' ? line['id'] : `at line ${position}`, line);
    }
    const stored = [...newest.values()];
    this.approvals.clear();
    stored.forEach((value, index) => {
      let approval: SharedApprovalRecord;
      try {
        approval = decodeStoredApproval(value);
      } catch {
        const id = isRecord(value) && typeof value['id'] === 'string' ? value['id'] : `at position ${index}`;
        if (isStoredOpenApproval(value)) {
          throw new Error(`The waiting approval ${id} in ${this.storeFile} cannot be read. Move the file aside, or remove that entry from it; no approval can be raised or answered until then.`);
        }
        logger.warn('A finished approval record cannot be read and was set aside', { file: this.storeFile, approvalId: id });
        return;
      }
      this.approvals.set(approval.id, withSettledWording(approval));
    });
    this.pruneTerminalApprovals();
    // A log that grew far past what it keeps (settled records pruned, many lines per record) is compacted now.
    if (log.size > this.approvals.size + COMPACT_SLACK) await this.#compact();
    this.loaded = true;
    this.rearmRestoredTimers();
  }

  /**
   * 3.3.1 kept approvals in one snapshot file, `approvals.json` beside this
   * log. While the log is empty and that file is there, its records are
   * appended to the log in this version's form, each line synced, and only
   * then is the file removed. It runs once: afterwards the log has lines or
   * the file is gone. A file that cannot be read is left where it is, named.
   */
  #carryForwardSnapshotFile(log: RecordLog<Record<string, unknown>>): void {
    const snapshotPath = this.logPath.endsWith('.jsonl') ? this.logPath.slice(0, -1) : null;
    if (!snapshotPath || !existsSync(snapshotPath)) return;
    let records: unknown[];
    try {
      const snapshot: unknown = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      if (!isRecord(snapshot) || !Array.isArray(snapshot['approvals'])) throw new Error('it holds no approvals list');
      records = snapshot['approvals'] as unknown[];
    } catch (error) {
      logger.warn('Approvals saved by an earlier version could not be read and were left in place', { file: snapshotPath, error: failureText(error) });
      return;
    }
    let carried = 0;
    for (const record of records) {
      const upgraded = approvalFromSnapshotFile(record, this.homeNode);
      if (!upgraded) continue;
      log.append(upgraded);
      carried += 1;
    }
    rmSync(snapshotPath, { force: true });
    noteCarriedForward('approval', carried);
    logger.info('Approvals saved by an earlier version were carried into the approvals log', { from: snapshotPath, to: this.logPath, approvals: carried });
  }

  /**
   * Append these records' lines, each one write and one sync, after any
   * deny-direction record a failed write left unsaved; then compact when the
   * log holds far more lines than records. Runs inside a write-queue unit.
   */
  async #append(records: readonly SharedApprovalRecord[]): Promise<void> {
    const log = this.log;
    if (!log) throw new Error('The approvals log is not open.');
    for (const id of [...this.#unsaved]) {
      const record = this.approvals.get(id);
      if (record && !records.some((entry) => entry.id === id)) log.append(encodeStoredApproval(record) as Record<string, unknown>);
      this.#unsaved.delete(id);
    }
    for (const record of records) log.append(encodeStoredApproval(record) as Record<string, unknown>);
    if (log.size > this.approvals.size + records.length + COMPACT_SLACK) await this.#compact(records);
  }

  /** One line per kept record: the newest line of every record the map holds (or is about to hold). */
  async #compact(pending: readonly SharedApprovalRecord[] = []): Promise<void> {
    const keep = new Map<string, number>();
    for (const record of this.approvals.values()) keep.set(record.id, record.sequence);
    for (const record of pending) keep.set(record.id, record.sequence);
    await this.log!.compact((line) => typeof line['id'] === 'string' && keep.get(line['id']) === line['sequence']);
  }

  /**
   * Re-arm expiry for approvals restored from disk.
   *
   * A deadline that passed while the process was down expires IMMEDIATELY
   * (`expired-while-down`) rather than being extended: silence for the full
   * window is silence whether or not we were running to hear it.
   *
   * There are no local resolvers for a restored record (the awaiting caller
   * died with the previous process), so this settles the RECORD, which is what
   * every surface reads. An in-process ask with no deadline, and a change put
   * to the owner, are cancelled (`requester-restarted`): their waiter died, so
   * an answer would reach nobody. An ask raised over the wire belongs to a
   * caller in another process that may still be watching it, so it stays open
   * for that caller with its holds as recorded.
   */
  private rearmRestoredTimers(): void {
    const now = Date.now();
    for (const approval of this.approvals.values()) {
      if (!isOpenApprovalStatus(approval.status)) continue;
      if (this.pendingResolvers.has(approval.id)) continue;
      const wire = approval.requester.kind !== 'in-process';
      if (approval.expiresAt === undefined || (approval.metadata['ownerAct'] === true && !wire)) {
        if (wire) {
          this.pendingResolvers.set(approval.id, { resolvers: [], externallyOwned: true });
          continue;
        }
        this.#internal(approval.id, { to: 'cancelled', actor: BROKER_ACTOR, cause: 'requester-restarted',
          note: 'the process that asked restarted, so nothing is waiting for this answer' }, 'Restored approval cancellation failed');
        continue;
      }
      const remaining = approval.expiresAt - now;
      if (remaining <= 0) {
        this.#internal(approval.id, { to: 'expired', cause: 'deadline-while-down', note: 'deadline passed while the daemon was not running' },
          'Restored approval expiration failed');
        continue;
      }
      const timer = setTimeout(() => {
        this.#internal(approval.id, { to: 'expired', cause: 'deadline', note: 'timed out after a restart re-armed its deadline' }, 'Approval expiration failed');
      }, remaining);
      timer.unref?.();
      this.pendingResolvers.set(approval.id, { resolvers: [], timer, externallyOwned: true });
    }
  }

  /** A move the broker makes on its own (timer, signal, restart): no revision presented, failures logged. */
  #internal(id: string, transition: ApprovalTransition, failure: string): void {
    void this.#transition({ id, expectedRevision: undefined, transition }).catch((error: unknown) => {
      logger.warn(failure, { approvalId: id, error: failureText(error) });
    });
  }

  listApprovals(limit = 100): SharedApprovalRecord[] {
    return sortApprovals(this.approvals.values()).slice(0, Math.max(1, limit));
  }

  getApproval(approvalId: string): SharedApprovalRecord | null {
    return this.approvals.get(approvalId) ?? null;
  }

  /** Raise a shared ask, optionally restricted to its host-owned decision capability. */
  async raiseApproval(input: RequestSharedApprovalInput): Promise<RaisedApproval> {
    return this.#ownerApprovals.raise(input, {
      start: () => this.start(),
      approvals: this.approvals,
      pendingResolvers: this.pendingResolvers,
      raising: this.raising,
      homeNode: () => this.homeNode,
      create: (record) => this.#create(record),
      addHold: async (approvalId, holdId) => {
        const outcome = await this.#transition({ id: approvalId, expectedRevision: undefined,
          transition: { to: 'updated', actor: BROKER_ACTOR, addHold: holdId, note: 'another surface raised the same ask' } });
        return outcome.applied ? outcome.record : null;
      },
      publish: (approval) => this.publish(approval),
      expire: (approvalId, note) => this.#transition({ id: approvalId, expectedRevision: undefined, transition: { to: 'expired', cause: 'deadline', note } }).then(() => undefined),
      cancel: async (approvalId) => {
        await this.#transition({ id: approvalId, expectedRevision: undefined,
          transition: { to: 'cancelled', actor: BROKER_ACTOR, cause: 'requester-left', note: 'requesting consumer no longer current' } });
      },
      buildAudit,
      coalesceKey: approvalCoalesceKey,
      resolve: (id, decision, proof) => this.#resolveApproval(id, decision, proof),
    });
  }

  /** The resolver is an in-process capability, never part of a stored approval. */
  async raiseOwnerApproval(input: RequestSharedApprovalInput & { readonly requireOwnerDecision: OwnerApprovalGuard }): Promise<RaisedOwnerApproval> {
    if (!input.requireOwnerDecision) throw new Error('Owner approval requires a host guard.');
    return await this.raiseApproval(input) as RaisedOwnerApproval;
  }

  /** Raise an ask and wait for the answer, the in-process permission path. */
  async requestApproval(input: RequestSharedApprovalInput): Promise<PermissionPromptDecision> {
    const signal = input.signal;
    const ownedInput = { ...input, signal };
    return awaitPermission(async () => (await this.raiseApproval(ownedInput)).decision, signal);
  }

  /** Say you are handling an ask. Advisory: it gates nobody. */
  async claimApproval(approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome> {
    return this.#transition({
      id: approvalId,
      expectedRevision: input.expectedRevision,
      transition: { to: 'claimed', actor: actorOf(input), ...(input.note !== undefined ? { note: input.note } : {}) },
    });
  }

  async resolveApproval(approvalId: string, input: ResolveSharedApprovalInput): Promise<TransitionOutcome> {
    return this.#resolveApproval(approvalId, input);
  }

  /**
   * Put `effect` in force when this approval is approved, inside the answer:
   * the approver's resolve returns only after it ran, and a failure comes back
   * to the approver as the answer's error with the reason, never only a log
   * line. Denial, expiry or cancellation drop it. Returns the unregister.
   */
  onApproved(approvalId: string, effect: () => unknown | Promise<unknown>): () => void {
    this.#approvedEffects.set(approvalId, effect);
    return () => { if (this.#approvedEffects.get(approvalId) === effect) this.#approvedEffects.delete(approvalId); };
  }

  async #resolveApproval(approvalId: string, input: ResolveSharedApprovalInput, proof?: OwnerApprovalProof): Promise<TransitionOutcome> {
    const approved = input.approved;
    const disposition = input.disposition;
    assertExplicitApprovalDisposition(approved, disposition);
    if (disposition === 'amended' && (input.remember === true || input.rememberTier !== undefined)) {
      throw Object.assign(new Error('An amendment cannot create a remembered approval rule.'), { code: 'INVALID_ARGUMENT', status: 400 });
    }
    await this.start();
    const approval = this.approvals.get(approvalId);
    // Per-hunk selection is only meaningful on approve; a deny is always a
    // whole-request rejection. The modified args come from the pending
    // request's OWN edits so the result is identical for every surface.
    let modifiedArgs = input.modifiedArgs;
    if (approval && input.selectedHunks !== undefined && approved && isOpenApprovalStatus(approval.status)) {
      const resolution = resolveApprovalHunkSelection(approval.request, input.selectedHunks);
      if (!resolution.ok) throw Object.assign(new Error(resolution.reason), { code: 'INVALID_ARGUMENT', status: 400 });
      modifiedArgs = resolution.modifiedArgs;
    }
    // The text typed for a command's prompt is usually a password: it travels
    // with THIS transition to the waiter and nowhere else. The stored,
    // published and returned record carries a marker instead.
    // Which arguments this approval runs the call with, taken before a typed
    // answer is withheld: a surface that approved the same ask with another
    // narrowing compares it and runs this recorded decision instead of its own.
    const argsDigest = approved && approval ? contentDigest(modifiedArgs ?? approval.request.args) : undefined;
    let withheldAnswer: string | undefined;
    if (approved && approval?.request.attribution?.kind === 'exec-prompt' && typeof modifiedArgs?.['answer'] === 'string') {
      withheldAnswer = modifiedArgs['answer'];
      modifiedArgs = { ...modifiedArgs, answer: WITHHELD_ANSWER };
    }
    const decision: SharedApprovalDecision = {
      approved,
      ...(disposition !== undefined ? { disposition } : { disposition: approved ? 'approved' : 'denied' }),
      ...(input.remember !== undefined ? { remember: input.remember } : {}),
      ...(input.rememberTier !== undefined ? { rememberTier: input.rememberTier } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(modifiedArgs !== undefined ? { modifiedArgs } : {}),
      ...(argsDigest !== undefined ? { argsDigest } : {}),
      ...(input.relayRequestId !== undefined ? { relayRequestId: input.relayRequestId } : {}),
    };
    let outcome: TransitionOutcome;
    try {
      outcome = await this.#transition({
        id: approvalId,
        expectedRevision: input.expectedRevision,
        transition: {
          to: approved ? 'approved' : 'denied',
          actor: actorOf(input),
          decision,
          ...(withheldAnswer !== undefined ? { withheldAnswer } : {}),
          ...(proof !== undefined ? { ownerProof: proof } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        },
      });
    } catch (error) {
      if (!(error instanceof OwnerDecisionStaleError)) throw error;
      // The owner's capability went stale between its check and its write: the
      // ask is cancelled, so nothing it would have released runs later.
      await this.#transition({ id: approvalId, expectedRevision: undefined,
        transition: { to: 'cancelled', actor: BROKER_ACTOR, cause: 'owner-decision-stale', note: 'owner decision no longer current' } });
      throw error.cause instanceof Error ? error.cause : error;
    }
    if (outcome.applied && approval && input.rememberTier && input.rememberTier !== 'session') {
      await this.#sweepRemembered(approval, input, approved);
    }
    const effect = outcome.applied ? this.#approvedEffects.get(approvalId) : undefined;
    if (outcome.applied) this.#approvedEffects.delete(approvalId);
    if (effect && approved) {
      try {
        await effect();
      } catch (error) {
        throw Object.assign(new Error(`Approved, but the change could not be put in effect: ${error instanceof Error ? error.message : String(error)}. Nothing was changed; ask for it again.`, { cause: error }),
          { code: 'APPROVED_NOT_APPLIED', status: 500 });
      }
    }
    return outcome;
  }

  /**
   * A generalizing remember tier answers more than this one ask: every queued
   * ask the remembered decision covers (same rule match) is settled with the
   * same verdict, in one write. modifiedArgs are call-specific and never
   * propagate to swept asks. A candidate that moved meanwhile is left as it is.
   */
  async #sweepRemembered(approval: SharedApprovalRecord, input: ResolveSharedApprovalInput, approved: boolean): Promise<void> {
    const rule = buildDurableRuleForDecision({
      toolName: approval.request.tool,
      args: approval.request.args,
      tier: input.rememberTier!,
      effect: approved ? 'allow' : 'deny',
      // An allow given to an owner-only item is remembered as that item's answer, as the gate keeps it.
      ...(approved && approval.request.ownerOnly ? { ownerOnly: approval.request.ownerOnly } : {}),
    });
    if (!rule) return;
    const lookup = compileRules([rule]);
    const swept: TransitionRequest[] = [];
    for (const candidate of [...this.approvals.values()]) {
      if (candidate.id === approval.id || !isOpenApprovalStatus(candidate.status)) continue;
      if (approved && candidate.requiresOwnerDecision) continue;
      // The gate's rule for an owner-only item (gate/classify.ts): only an allow given to that
      // same item settles it. An ask that offers nothing to remember is answered one call at a time.
      if (approved && candidate.request.ownerOnly !== undefined && candidate.request.ownerOnly !== rule.ownerOnly) continue;
      if (approved && candidate.request.rememberOptions?.length === 0) continue;
      // A remembered rule belongs to the project it was made in, so it answers only that project's asks.
      if (candidate.request.workingDirectory !== approval.request.workingDirectory) continue;
      if (this.pendingResolvers.get(candidate.id)?.retired) continue;
      // A device grant is for one capability on one device; the tool-wide rule behind it must not answer other device asks.
      if ((candidate.metadata['deviceCapability'] !== undefined || approval.metadata['deviceCapability'] !== undefined)
        && (candidate.metadata['deviceNodeId'] !== approval.metadata['deviceNodeId']
          || candidate.metadata['deviceCapability'] !== approval.metadata['deviceCapability'])) continue;
      const stillWaiting = (): void => {
        if (this.approvals.get(candidate.id) !== candidate || this.pendingResolvers.get(candidate.id)?.retired) {
          throw new Error('Remembered approval candidate is no longer pending');
        }
      };
      let covered: CompiledRuleMatch | null;
      try {
        covered = await lookup.match(candidate.request.tool, candidate.request.args, {
          projectRoot: candidate.request.workingDirectory,
          signal: this.pendingResolvers.get(candidate.id)?.promptController?.signal,
          assertCurrent: stillWaiting,
        });
      } catch (error) {
        if (this.approvals.get(candidate.id) !== candidate || this.pendingResolvers.get(candidate.id)?.retired) continue;
        throw error;
      }
      if (!covered) continue;
      swept.push({
        id: candidate.id,
        // The candidate as it was matched: one that moved since is refused and left alone.
        expectedRevision: candidate.revision,
        transition: {
          to: approved ? 'approved' : 'denied',
          actor: actorOf(input),
          decision: { approved, disposition: 'remembered', ...(input.reason !== undefined ? { reason: input.reason } : {}) },
          note: `covered by remembered ${input.rememberTier} decision on ${approval.id}`,
        },
      });
    }
    if (swept.length === 0) return;
    // The decision itself is already durable and reported applied; a failed
    // write of the swept asks leaves them waiting, which is not an error here.
    await this.#commit(swept, 'remembered-rule').catch((error: unknown) => {
      logger.warn('Remembered approval sweep not written; the covered asks are still waiting', { approvalId: approval.id, error: failureText(error) });
    });
  }

  async recordRemoteUpdate(
    approvalId: string,
    input: {
      readonly actor: string;
      readonly actorSurface?: string | undefined;
      readonly note?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<TransitionOutcome> {
    return this.#transition({
      id: approvalId,
      // A report about the ask, not an action on it: it never needs the revision a person saw.
      expectedRevision: undefined,
      transition: { to: 'updated', actor: { id: input.actor, surface: input.actorSurface ?? 'remote' },
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}), ...(input.note !== undefined ? { note: input.note } : {}) },
    });
  }

  async cancelApproval(approvalId: string, input: ApprovalActionInput): Promise<TransitionOutcome> {
    return this.#transition({
      id: approvalId,
      expectedRevision: input.expectedRevision,
      transition: { to: 'cancelled', actor: actorOf(input), cause: 'cancelled-by-actor', ...(input.note !== undefined ? { note: input.note } : {}) },
    });
  }

  /**
   * A surface that raised this ask over the wire gives up its hold on it.
   *
   * On an open ask the surface is leaving: while another surface that raised
   * it is still waiting the ask stays open for them; the last hold to go
   * cancels it (`requester-left`). On a decided ask the surface confirms it
   * received the answer, which is the receipt evidence: the reading says
   * `delivered` once every hold is released. Releasing a hold twice changes
   * nothing. Without `holdId` the call gives up one hold still held; an ask
   * with no tracked holds is cancelled outright while open.
   */
  async releaseApproval(approvalId: string, input: Omit<ApprovalActionInput, 'expectedRevision'> & { readonly holdId?: string | undefined }): Promise<TransitionOutcome> {
    return this.#transition({
      id: approvalId,
      // A release names its hold; that, not a revision, makes a repeat harmless.
      expectedRevision: undefined,
      transition: { to: 'released', actor: actorOf(input), ...(input.holdId !== undefined ? { holdId: input.holdId } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}) },
    });
  }

  /** One transition, checked and written in one unit of the write queue. */
  async #transition(request: TransitionRequest): Promise<TransitionOutcome> {
    await this.start();
    const [outcome] = await this.#commit([request]);
    return outcome!;
  }

  /**
   * The one transition path. Inside one unit of the write queue, so no other
   * write interleaves between check and write: read each record, refuse a
   * settled one (`APPROVAL_SETTLED`), a stale revision (`APPROVAL_CHANGED`),
   * an illegal move, an approve without the owner's current proof
   * (`OWNER_DECISION_REQUIRED`); turn an action that arrives after the
   * deadline into the expiry it is (`APPROVAL_EXPIRED`). Then write the whole
   * snapshot with the new records in place, and put them in memory only after
   * the write landed (save, then acknowledge). The deny direction (denied,
   * cancelled, expired) keeps the fail-closed rule: its waiters are refused
   * even when the write fails, and the error says so. After the unit, waiters
   * are answered (an approve's typed answer goes to its own waiter only) and
   * the new revision is published.
   */
  async #commit(requests: readonly TransitionRequest[], cause?: ApprovalCause): Promise<TransitionOutcome[]> {
    const planned: PlannedTransition[] = [];
    // Set inside the write unit: the write's failure, and an owner decision that went stale after it landed.
    const ended: { failed?: { readonly error: unknown }; staleOwner?: OwnerDecisionStaleError } = {};
    const committed: PlannedTransition[] = [];
    await this.writes.run(async () => {
      const working = new Map<string, SharedApprovalRecord>();
      for (const request of requests) {
        const plan = this.#plan(request, working, cause);
        planned.push(plan);
        if (plan.next) working.set(plan.next.id, plan.next);
      }
      const changing = planned.filter((plan) => plan.next !== undefined);
      if (changing.length === 0) return;
      for (const plan of changing) {
        try {
          plan.ownerCheck?.();
        } catch (error) {
          this.#ownerApprovals.settle(plan.request.id);
          throw error;
        }
      }
      this.pruneTerminalApprovals();
      try {
        await this.#append(changing.map((plan) => plan.next!));
      } catch (error) {
        ended.failed = { error };
        // Deny direction: a refusal can never do what nobody agreed to, so its
        // waiters are refused and the record moves in memory; the next write saves it.
        for (const plan of changing) {
          if (!plan.next || !denyDirection(plan.next.status)) continue;
          this.approvals.set(plan.next.id, plan.next);
          this.#unsaved.add(plan.next.id);
          committed.push(plan);
        }
        for (const plan of changing) if (plan.ownerCheck) this.#ownerApprovals.settle(plan.request.id);
        return;
      }
      for (const plan of changing) {
        if (plan.ownerCheck) {
          try {
            plan.ownerCheck();
          } catch (error) {
            // On disk but no longer current: not put in effect; the caller cancels it.
            ended.staleOwner = new OwnerDecisionStaleError(plan.request.id, error);
            continue;
          }
        }
        this.approvals.set(plan.next!.id, plan.next!);
        committed.push(plan);
      }
    });
    for (const plan of committed) {
      const next = plan.next!;
      if (TERMINAL_APPROVAL_STATUSES.has(next.status) && next.decision) this.resolvePending(next.id, next.decision, plan.withheldAnswer);
      this.publish(next);
    }
    if (ended.staleOwner) throw ended.staleOwner;
    if (ended.failed) {
      const failure = ended.failed.error;
      const plan = planned.find((entry) => entry.next !== undefined);
      const id = plan?.request.id ?? requests[0]?.id ?? 'the approval';
      if (plan?.next && denyDirection(plan.next.status)) {
        throw new Error(`The ${plan.next.status === 'denied' ? 'denial' : plan.next.status === 'expired' ? 'expiry' : 'cancellation'} of ${id} was applied and the waiting call was refused, but it could not be saved (${failureText(failure)}). It is saved with the next approvals write.`, { cause: failure });
      }
      throw new Error(`The change to ${id} could not be saved (${failureText(failure)}). Nothing changed: the ask is as it was; act on it again.`, { cause: failure });
    }
    return planned.map((plan): TransitionOutcome => {
      if (plan.refusal) return { applied: false, record: this.approvals.get(plan.request.id) ?? plan.current, refusal: plan.refusal };
      if (!plan.next || !committed.includes(plan)) {
        return { applied: false, record: this.approvals.get(plan.request.id) ?? plan.current, refusal: approvalRefusal('APPROVAL_CHANGED', plan.current) };
      }
      return { applied: true, record: plan.next };
    });
  }

  /** Decide, without writing, what one request does to its record. Synchronous: it runs inside the write unit. */
  #plan(request: TransitionRequest, working: ReadonlyMap<string, SharedApprovalRecord>, cause?: ApprovalCause): PlannedTransition {
    const current = working.get(request.id) ?? this.approvals.get(request.id) ?? null;
    const transition = request.transition;
    if (!current) return { request, current, refusal: approvalRefusal('UNKNOWN_APPROVAL', null) };
    const now = Date.now();
    const open = isOpenApprovalStatus(current.status);
    if (transition.to === 'updated' || transition.to === 'released') {
      if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) {
        return { request, current, refusal: approvalRefusal('APPROVAL_CHANGED', current) };
      }
      return this.#planSideways(request, current, transition, now);
    }
    if (!open) return { request, current, refusal: approvalRefusal('APPROVAL_SETTLED', current) };
    if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) {
      return { request, current, refusal: approvalRefusal('APPROVAL_CHANGED', current) };
    }
    const check = approvalLifecycle.check(current.status, transition.to);
    if (!check.ok) return { request, current, refusal: approvalRefusal('ILLEGAL_TRANSITION', current, check.reason) };
    // The deadline is rechecked at the write, not only when the call arrived.
    if (transition.to !== 'expired' && current.expiresAt !== undefined && current.expiresAt <= now) {
      const next = this.#next(current, { to: 'expired', cause: 'deadline', note: 'its deadline passed before an action on it was applied' }, now);
      return { request, current, next, refusal: approvalRefusal('APPROVAL_EXPIRED', next) };
    }
    if ((transition.to === 'approved' || transition.to === 'denied') && this.pendingResolvers.get(current.id)?.retired) {
      const next = this.#next(current, { to: 'cancelled', actor: BROKER_ACTOR, cause: 'requester-left', note: 'all requesting consumers cancelled' }, now);
      return { request, current, next, refusal: approvalRefusal('APPROVAL_SETTLED', next, 'Everyone who asked stopped waiting, so it was cancelled; nothing was decided.') };
    }
    let ownerCheck: (() => void) | undefined;
    if (transition.to === 'approved' && current.requiresOwnerDecision) {
      try {
        ownerCheck = this.#ownerApprovals.check(current, transition.decision, transition.ownerProof);
      } catch {
        return { request, current, refusal: approvalRefusal('OWNER_DECISION_REQUIRED', current) };
      }
    }
    const next = this.#next(current, transition, now, cause);
    return {
      request, current, next,
      ...(transition.to === 'approved' && transition.withheldAnswer !== undefined ? { withheldAnswer: transition.withheldAnswer } : {}),
      ...(ownerCheck !== undefined ? { ownerCheck } : {}),
    };
  }

  /** `updated` and `released`: no status move of their own (a last release of an open ask also cancels it). */
  #planSideways(
    request: TransitionRequest,
    current: SharedApprovalRecord,
    transition: Extract<ApprovalTransition, { to: 'updated' | 'released' }>,
    now: number,
  ): PlannedTransition {
    const open = isOpenApprovalStatus(current.status);
    if (transition.to === 'updated') {
      if (transition.addHold !== undefined && !open) return { request, current, refusal: approvalRefusal('APPROVAL_SETTLED', current) };
      return { request, current, next: this.#next(current, transition, now) };
    }
    const requester = current.requester;
    if (requester.kind !== 'wire') {
      // Nothing tracks who holds it: leaving it cancels it while it is open.
      if (!open) return { request, current, refusal: approvalRefusal('APPROVAL_SETTLED', current) };
      return { request, current, next: this.#next(current, { to: 'cancelled', actor: transition.actor, cause: 'requester-left', note: transition.note }, now) };
    }
    const hold = transition.holdId !== undefined
      ? requester.holds.find((entry) => entry.id === transition.holdId)
      : requester.holds.find((entry) => entry.releasedAt === undefined);
    if (!hold || hold.releasedAt !== undefined) {
      return { request, current, refusal: approvalRefusal('APPROVAL_SETTLED', current, 'That hold was already given up; nothing changed.') };
    }
    const holds: ApprovalHold[] = requester.holds.map((entry) => (entry === hold ? { id: entry.id, releasedAt: now } : entry));
    const released = this.#next(current, { to: 'updated', actor: transition.actor, note: transition.note ?? (open ? 'the asking surface left' : 'the asking surface received the answer') }, now, undefined, { kind: 'wire', holds });
    // Another surface that raised it still waits: it stays open for them.
    if (!open || holds.some((entry) => entry.releasedAt === undefined)) return { request, current, next: released };
    const cancelled = this.#next(released, { to: 'cancelled', actor: transition.actor, cause: 'requester-left', note: 'every surface that asked stopped waiting' }, now);
    return { request, current, next: { ...cancelled, sequence: current.sequence + 1 } };
  }

  /** The record after one transition: revision + 1, updated now, one audit entry. */
  #next(current: SharedApprovalRecord, transition: ApprovalTransition, now: number, cause?: ApprovalCause, requester?: ApprovalRequester): SharedApprovalRecord {
    // Every write moves the sequence; only a change of what can be decided moves the revision.
    const decides = transition.to !== 'updated' && transition.to !== 'released';
    const settles = transition.to === 'approved' || transition.to === 'denied' || transition.to === 'cancelled' || transition.to === 'expired';
    const base = { ...current, revision: decides ? current.revision + 1 : current.revision, sequence: current.sequence + 1, updatedAt: now,
      ...(settles ? { metadata: this.#keepWording(current, transition.to, now) } : {}) };
    switch (transition.to) {
      case 'claimed':
        return { ...base, status: 'claimed', claimedBy: transition.actor.id, claimedAt: now,
          audit: [...current.audit, buildAudit('claimed', transition.actor.id, transition.actor.surface, transition.note, transition.actor.node)] };
      case 'approved':
      case 'denied':
        return { ...base, status: transition.to, resolvedAt: now, resolvedBy: transition.actor.id, decision: transition.decision,
          ...(cause !== undefined ? { cause } : {}),
          audit: [...current.audit, buildAudit(transition.to, transition.actor.id, transition.actor.surface, transition.note, transition.actor.node)] };
      case 'cancelled':
        return { ...base, status: 'cancelled', resolvedAt: now, resolvedBy: transition.actor.id, cause: transition.cause,
          decision: { approved: false, remember: false, disposition: 'cancelled' },
          audit: [...current.audit, buildAudit('cancelled', transition.actor.id, transition.actor.surface, transition.note, transition.actor.node)] };
      case 'expired':
        return { ...base, status: 'expired', resolvedAt: now, resolvedBy: BROKER_ACTOR.id, cause: transition.cause,
          decision: { approved: false, remember: false, disposition: 'expired' },
          audit: [...current.audit, buildAudit('expired', BROKER_ACTOR.id, BROKER_ACTOR.surface, transition.note)] };
      case 'updated': {
        const holds: ApprovalRequester | undefined = transition.addHold === undefined ? requester
          : { kind: 'wire', holds: [...(current.requester.kind === 'wire' ? current.requester.holds : []), { id: transition.addHold }] };
        return { ...base, metadata: { ...current.metadata, ...(transition.metadata ?? {}) },
          ...(holds !== undefined ? { requester: holds } : {}),
          audit: [...current.audit, buildAudit('updated', transition.actor.id, transition.actor.surface, transition.note, transition.actor.node)] };
      }
      case 'released':
        // Planned by #planSideways into `updated` (and `cancelled`); never built directly.
        return { ...base, ...(requester !== undefined ? { requester } : {}) };
    }
  }

  /** Write a new record, and only then let anyone see it (F61): the map, the waiters, the timer and the event follow the write. */
  async #create(record: SharedApprovalRecord): Promise<void> {
    await this.writes.run(async () => {
      this.pruneTerminalApprovals();
      await this.#append([record]);
      this.approvals.set(record.id, record);
    });
  }

  /** Resolve every waiter attached to an approval (coalesced asks share one record). */
  private resolvePending(approvalId: string, recorded: SharedApprovalDecision, withheldAnswer?: string): void {
    this.#ownerApprovals.retire(approvalId);
    const pending = this.pendingResolvers.get(approvalId);
    if (!pending) return;
    const ordinary = ordinaryApprovalDecision(recorded);
    const decision = withheldAnswer !== undefined && ordinary.modifiedArgs !== undefined
      ? { ...ordinary, modifiedArgs: { ...ordinary.modifiedArgs, answer: withheldAnswer } }
      : ordinary;
    if (pending.timer) clearTimeout(pending.timer);
    if (recorded.disposition === 'cancelled' || recorded.disposition === 'expired') pending.promptController?.abort();
    for (const resolve of pending.resolvers) resolve(decision);
    this.pendingResolvers.delete(approvalId);
  }

  /**
   * Drop the oldest settled approvals nobody decided once they exceed
   * MAX_APPROVAL_RECORDS, bounding the in-memory Map and the log. Open
   * approvals and approvals a person decided are never evicted.
   */
  private pruneTerminalApprovals(): void {
    const terminal: SharedApprovalRecord[] = [];
    for (const record of this.approvals.values()) {
      if (TERMINAL_APPROVAL_STATUSES.has(record.status) && !decidedByPerson(record)) terminal.push(record);
    }
    if (terminal.length <= MAX_APPROVAL_RECORDS) return;
    terminal.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    for (const record of terminal.slice(MAX_APPROVAL_RECORDS)) {
      this.approvals.delete(record.id);
    }
  }

  /**
   * The words a settled record keeps (metadata.wording): the question, subject
   * and consequence as the person who decided saw them, worded from the open
   * record while its arguments are still held. A settled record's arguments
   * are withheld on disk, so they are never worded again afterwards. Words
   * only: a typed answer is in the decision, never here.
   */
  #keepWording(current: SharedApprovalRecord, to: SharedApprovalStatus, at: number): Record<string, unknown> {
    if (isSettledWording(current.metadata['wording'])) return current.metadata;
    const shown = this.presentationOf(current);
    const wording: SettledApprovalWording = shown
      ? { title: shown.title, question: shown.question,
        ...(shown.subject ? { subject: { kind: shown.subject.kind, lines: shown.subject.lines.slice(0, 5).map((line) => line.slice(0, 200)) } } : {}),
        ...(shown.consequence ? { consequence: shown.consequence.text } : {}) }
      : unwordedSettlement(to, at);
    return { ...current.metadata, wording };
  }

  /**
   * Word every ask this broker publishes and lists (`approval-update`,
   * `approvals.list`) with `presenter`, so a surface draws the same question,
   * consequence and choices without another read. One pure call per record.
   */
  usePresentation(presenter: ((request: PermissionPromptRequest, sessionId?: string | undefined) => AskPresentation) | null): void {
    this.#presenter = presenter;
  }

  /**
   * The ask's words, when a presenter is set: compact (the question, subject,
   * consequence, choices and remember tiers) for a list row or an event, in
   * full (with the details: arguments, checklist) for the read of one record.
   */
  presentationOf(record: SharedApprovalRecord, full = false): AskPresentation | undefined {
    if (this.#presenter === null) return undefined;
    try {
      const settled = record.metadata['wording'];
      // A settled ask reads as it was asked: its kept words, never words rebuilt from withheld arguments.
      const presentation = isSettledWording(settled) && !isOpenApprovalStatus(record.status)
        ? { ...this.#presenter(record.request, record.sessionId), ...settledPresentation(settled) }
        : this.#presenter(record.request, record.sessionId);
      // Compact: the details (arguments, checklist) stay for the read of one record (ask-presentation.ts compactAskPresentation).
      return full ? presentation : { ...presentation, details: [] };
    } catch (error) {
      logger.debug('An approval could not be worded; it is sent without its words', { approvalId: record.id, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  private publish(approval: SharedApprovalRecord): void {
    // The record is already durable and its waiters are settled by the caller.
    // A publisher that refuses (the gateway feature is off, a stream closed
    // under it) must not turn a recorded decision into an error for the asker.
    try {
      const now = Date.now();
      this.publisher?.publishEvent('approval-update', {
        approval,
        // The reading for an admin who may answer: what is waiting, the deadline, the decision and its receipt.
        reading: readApproval(approval, adminApprovalViewer(approval.homeNode), now),
        // The ask's words while it waits, so a surface draws the card from the frame alone.
        ...(isOpenApprovalStatus(approval.status) ? withPresentation(this.presentationOf(approval)) : {}),
        createdAt: now,
      });
    } catch (error) {
      logger.warn('Approval update not published', { approvalId: approval.id, error: error instanceof Error ? error.message : String(error) });
    }
    try {
      this.publisher?.publishSurfaceMessage({
        surface: 'web',
        title: isOpenApprovalStatus(approval.status) ? 'Approval required' : 'Approval resolved',
        body: `${approval.request.tool}: ${approval.request.analysis.summary}`,
        level: approval.status === 'approved'
          ? 'success'
          : approval.status === 'denied' || approval.status === 'expired'
            ? 'warn'
            : 'info',
        metadata: {
          approvalId: approval.id,
          status: approval.status,
          revision: approval.revision,
          callId: approval.callId,
          sessionId: approval.sessionId,
          routeId: approval.routeId,
        },
      });
    } catch (error) {
      logger.warn('Approval surface message not published', { approvalId: approval.id, error: error instanceof Error ? error.message : String(error) });
    }
    for (const listener of this.listeners) {
      try {
        listener(approval);
      } catch {
        // Listener failures do not block approval creation.
      }
    }
  }
}

/** An owner decision that was written but whose capability went stale before it took effect. */
class OwnerDecisionStaleError extends Error {
  constructor(approvalId: string, cause: unknown) {
    super(`The owner decision on ${approvalId} is no longer current.`, { cause });
    this.name = 'OwnerDecisionStaleError';
  }
}

function denyDirection(status: SharedApprovalStatus): boolean {
  return status === 'denied' || status === 'cancelled' || status === 'expired';
}

function actorOf(input: { readonly actor: string; readonly actorSurface?: string | undefined; readonly actorNode?: string | undefined }): ApprovalActor {
  return { id: input.actor, surface: input.actorSurface ?? 'web', ...(input.actorNode !== undefined ? { node: input.actorNode } : {}) };
}

/** The `presentation` field of a frame or row, when there are words. */
function withPresentation(presentation: AskPresentation | undefined): { readonly presentation?: AskPresentation } {
  return presentation ? { presentation } : {};
}
