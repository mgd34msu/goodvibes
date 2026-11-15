import { createHash, randomUUID } from 'node:crypto';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { WITHHELD_PROMPT_ANSWER, type PermissionPromptDecision, type PermissionPromptRequest, type PermissionRequestHandler } from '../permissions/prompt.js';
import { buildDurableRuleForDecision, matchDurableRulesAsync } from '../permissions/approval-rules.js';
import type { ControlPlaneSurfaceMessage } from './types.js';
import { logger } from '../utils/logger.js';
import { isRecord } from '../utils/record-coerce.js';
import { resolveApprovalHunkSelection } from './approval-hunk-apply.js';
import type { PendingApprovalEntry, RaisedApproval } from './approval-broker-raise.js';
import { OwnerApprovalAuthority, type OwnerApprovalGuard, type OwnerApprovalProof, type RaisedOwnerApproval, type ResolveSharedApprovalInput, type ApprovalActionOutcome } from './approval-broker-owner.js';
import { awaitPermission } from '../permissions/cancellation.js';
import { assertExplicitApprovalDisposition, finishedApprovalOutcome, isSharedApprovalDisposition, ordinaryApprovalDecision, type SharedApprovalDecision } from './approval-disposition.js';

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
  readonly claimedBy?: string | undefined;
  readonly claimedAt?: number | undefined;
  readonly resolvedAt?: number | undefined;
  readonly resolvedBy?: string | undefined;
  readonly decision?: SharedApprovalDecision | undefined;
  /**
   * When this ask stops waiting, for asks that were given a timeout.
   *
   * PERSISTED deliberately. The expiry timer lives in `pendingResolvers`, which
   * is in-memory and rebuilt empty on start, so before this field existed a
   * restart left a pending approval with no timer, no deadline and no way to
   * ever resolve, it sat 'pending' forever. Recording the deadline on the
   * record is what lets `start()` re-arm it, or expire it immediately when the
   * deadline passed while the process was down. See `rearmRestoredTimers`.
   */
  readonly expiresAt?: number | undefined;
  readonly metadata: Record<string, unknown>;
  readonly audit: readonly SharedApprovalAuditRecord[];
}

interface SharedApprovalStoreSnapshot extends Record<string, unknown> {
  readonly approvals: readonly SharedApprovalRecord[];
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
   * Which surface the local prompt belongs to, for the audit trail.
   *
   * Was hardcoded to 'tui'/'tui-local' regardless of caller, so every product
   * that answers at its own terminal, the agent, and now the payment
   * capability's approval prompts, recorded a decision made somewhere it was
   * not. That is a lie in exactly the record you consult to find out who
   * approved a purchase. Defaults preserve the old values for callers that do
   * not say, because the TUI was the only caller when they were written.
   */
  readonly localPromptSurface?: string | undefined;
  readonly localPromptActor?: string | undefined;
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
 * Maximum number of terminal (resolved) approval records retained in memory and
 * on disk. Mirrors ChannelPolicyManager's MAX_AUDIT_RECORDS so a long-running
 * control-plane daemon does not grow the snapshot without bound. Pending and
 * claimed approvals are never counted or evicted, they have a live awaited
 * promise + resolver and must survive until resolved.
 */
const MAX_APPROVAL_RECORDS = 500;
const WITHHELD_ANSWER = WITHHELD_PROMPT_ANSWER;
const TERMINAL_APPROVAL_STATUSES = new Set<SharedApprovalStatus>(['approved', 'denied', 'cancelled', 'expired']);

const APPROVAL_STATUSES = new Set<SharedApprovalStatus>(['pending', 'claimed', 'approved', 'denied', 'cancelled', 'expired']);
const APPROVAL_AUDIT_ACTIONS = new Set<SharedApprovalAuditRecord['action']>([
  'created',
  'claimed',
  'approved',
  'denied',
  'cancelled',
  'expired',
  'updated',
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
  validateOptionalString(value['note']);
}

/** An open ask as stored: its waiter may still be watching it, so it must be readable. */
function isStoredOpenApproval(value: unknown): boolean {
  return isRecord(value) && (value['status'] === 'pending' || value['status'] === 'claimed');
}

/**
 * Read one stored approval. A finished record stores only its disposition
 * (plus the verdict for `remembered`); its status and `approved` are derived
 * here by the one rule in approval-disposition.ts. A record written before
 * dispositions existed keeps its stored status and verdict.
 */
function decodeStoredApproval(value: unknown): SharedApprovalRecord {
  if (!isRecord(value)) throwInvalidApprovalSnapshot();
  if (
    typeof value['id'] !== 'string'
    || typeof value['callId'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
    || !isFiniteNumber(value['updatedAt'])
    || !isRecord(value['metadata'])
    || !Array.isArray(value['audit'])
  ) {
    throwInvalidApprovalSnapshot();
  }
  validatePermissionPromptRequestSnapshot(value['request']);
  validateOptionalString(value['sessionId']);
  validateOptionalString(value['routeId']);
  validateOptionalString(value['claimedBy']);
  validateOptionalNumber(value['claimedAt']);
  validateOptionalNumber(value['resolvedAt']);
  validateOptionalNumber(value['expiresAt']);
  validateOptionalString(value['resolvedBy']);
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
  if (disposition === undefined) {
    // Written before dispositions: its two fields are all there is.
    if (typeof storedStatus !== 'string' || !TERMINAL_APPROVAL_STATUSES.has(storedStatus as SharedApprovalStatus)
      || typeof decision['approved'] !== 'boolean') throwInvalidApprovalSnapshot();
    return value as unknown as SharedApprovalRecord;
  }
  if (!isSharedApprovalDisposition(disposition)) throwInvalidApprovalSnapshot();
  if (disposition === 'amended' && (decision['remember'] === true || decision['rememberTier'] !== undefined)) throwInvalidApprovalSnapshot();
  const outcome = finishedApprovalOutcome(disposition, typeof decision['approved'] === 'boolean' ? decision['approved'] : undefined);
  if (!outcome) throwInvalidApprovalSnapshot();
  return { ...value, status: outcome.status, decision: { ...decision, approved: outcome.approved } } as unknown as SharedApprovalRecord;
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
  const { status, decision, request, metadata, ...rest } = record;
  const { approved, modifiedArgs, disposition, ...decisionRest } = decision;
  const stored: Record<string, unknown> = {
    ...rest,
    // A record written before dispositions has no other statement of how it ended.
    ...(disposition === undefined ? { status } : {}),
    request: { ...request, args: {} },
    metadata: {
      ...metadata,
      argumentsDigest: typeof metadata['argumentsDigest'] === 'string' ? metadata['argumentsDigest'] : argumentsDigest(request.args),
      ...(modifiedArgs !== undefined ? { modifiedArgumentsDigest: argumentsDigest(modifiedArgs) } : {}),
    },
    decision: disposition === undefined ? { ...decisionRest, approved }
      : disposition === 'remembered' ? { ...decisionRest, approved, disposition }
        : { ...decisionRest, disposition },
  };
  storedFinishedRecords.set(record, stored);
  return stored;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildAudit(action: SharedApprovalAuditRecord['action'], actor: string, actorSurface?: string, note?: string): SharedApprovalAuditRecord {
  return {
    id: `apra-${randomUUID().slice(0, 8)}`,
    action,
    actor,
    actorSurface,
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

export class ApprovalBroker {
  private readonly store: PersistentStore<SharedApprovalStoreSnapshot>;
  private readonly approvals = new Map<string, SharedApprovalRecord>();
  private readonly pendingResolvers = new Map<string, PendingApprovalEntry>();
  readonly #ownerApprovals = new OwnerApprovalAuthority();
  /**
   * The text typed in answer to a command's terminal prompt is usually a
   * password. It goes to the waiting command and nowhere else: the stored,
   * published and returned record carries a marker instead, and this map (never
   * persisted) holds the real text until the waiter has it.
   */
  readonly #withheldAnswers = new Map<string, string>();
  private readonly listeners = new Set<ApprovalListener>();
  /** Whole-store writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();
  private publisher: ApprovalPublisher | null = null;
  private loaded = false;
  /** One load at a time: a second early caller must not clear a map the first already filled. */
  private loading: Promise<void> | null = null;
  /** Names the store in a notice about a record that cannot be read. */
  private readonly storeFile: string;

  constructor(
    options: {
      readonly store?: PersistentStore<SharedApprovalStoreSnapshot> | undefined;
      readonly storePath?: string | undefined;
    },
  ) {
    if (!options.store && !options.storePath) {
      throw new Error('ApprovalBroker requires an explicit store or storePath.');
    }
    const storePath = options.storePath;
    this.store = options.store ?? new PersistentStore<SharedApprovalStoreSnapshot>(storePath as string);
    this.storeFile = storePath ?? 'the approvals store';
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
    const snapshot: unknown = await this.store.load();
    if (snapshot !== null && (!isRecord(snapshot) || !Array.isArray(snapshot['approvals']))) {
      throw new Error(`${this.storeFile} is not an approvals store. Move it aside to start with no recorded approvals.`);
    }
    const stored: readonly unknown[] = snapshot === null ? [] : snapshot['approvals'] as unknown[];
    this.approvals.clear();
    stored.forEach((value, index) => {
      let approval: SharedApprovalRecord;
      try {
        approval = decodeStoredApproval(value);
      } catch {
        const id = isRecord(value) && typeof value['id'] === 'string' ? value['id'] : `at position ${index}`;
        if (isStoredOpenApproval(value)) {
          throw new Error(`The waiting approval ${id} in ${this.storeFile} cannot be read. Remove that entry from the file; no approval can be raised or answered until then.`);
        }
        logger.warn('A finished approval record cannot be read and was set aside', { file: this.storeFile, approvalId: id });
        return;
      }
      this.approvals.set(approval.id, approval);
    });
    this.pruneTerminalApprovals();
    this.loaded = true;
    this.rearmRestoredTimers();
  }

  /**
   * Re-arm expiry for approvals restored from disk.
   *
   * Without this, a restart orphaned every timed approval: the timer lived only
   * in `pendingResolvers`, which is rebuilt empty, so a record reloaded as
   * 'pending' had nothing left that would ever resolve it and sat pending
   * forever. For a tool-permission ask that is a stale row; for a payment
   * approval it is money in limbo.
   *
   * A deadline that passed while the process was down expires IMMEDIATELY rather
   * than being extended. Silence for the full window is silence whether or not
   * we were running to hear it, and for an approval silence means denied, the
   * direction that cannot spend money nobody agreed to.
   *
   * There are no local resolvers to call for a restored record (the awaiting
   * caller died with the previous process), so this settles the RECORD, which
   * is what every surface reads.
   *
   * A record with no deadline that was raised IN this process is cancelled: its
   * waiter died with the previous process, so an answer would reach nobody,
   * and leaving it pending lets the next identical ask coalesce onto it and
   * wait with no prompt at all. A record raised over the wire
   * (`approvals.raise`) belongs to a caller in another process that may still
   * be watching it, so it stays open for that caller.
   */
  private rearmRestoredTimers(): void {
    const now = Date.now();
    for (const approval of this.approvals.values()) {
      if (approval.status !== 'pending' && approval.status !== 'claimed') continue;
      if (this.pendingResolvers.has(approval.id)) continue;
      if (approval.expiresAt === undefined) {
        if (approval.metadata['raisedVia'] === 'approvals.raise') {
          this.pendingResolvers.set(approval.id, { resolvers: [], externallyOwned: true });
          continue;
        }
        void this.cancelApproval(approval.id, 'approval-broker', 'service', 'the process that asked restarted, so nothing is waiting for this answer')
          .catch((error: unknown) => {
            logger.warn('Restored approval cancellation failed', {
              approvalId: approval.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        continue;
      }

      const remaining = approval.expiresAt - now;
      if (remaining <= 0) {
        void this.expireApproval(approval.id, 'deadline passed while the daemon was not running')
          .catch((error: unknown) => {
            logger.warn('Restored approval expiration failed', {
              approvalId: approval.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        continue;
      }

      const timer = setTimeout(() => {
        void this.expireApproval(approval.id, 'timed out after a restart re-armed its deadline')
          .catch((error: unknown) => {
            logger.warn('Approval expiration failed', {
              approvalId: approval.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, remaining);
      timer.unref?.();
      this.pendingResolvers.set(approval.id, { resolvers: [], timer, externallyOwned: true });
    }
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
      persist: async () => { await this.persist(); },
      publish: (approval) => this.publish(approval),
      expire: (approvalId, note) => this.expireApproval(approvalId, note),
      cancel: async (approvalId) => { await this.cancelApproval(approvalId, 'approval-broker', 'service', 'requesting consumer no longer current'); },
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

  async claimApproval(approvalId: string, actor: string, actorSurface = 'web', note?: string, outcome?: ApprovalActionOutcome): Promise<SharedApprovalRecord | null> {
    if (outcome) outcome.applied = false;
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status !== 'pending' && approval.status !== 'claimed') return approval;
    // Replacing the record while its owner decision is being written would make
    // that decision look stale and turn it into a cancel; it settles in one write.
    if (this.#ownerApprovals.isResolving(approvalId)) return approval;
    const updated: SharedApprovalRecord = {
      ...approval,
      status: 'claimed',
      claimedBy: actor,
      claimedAt: Date.now(),
      updatedAt: Date.now(),
      audit: [...approval.audit, buildAudit('claimed', actor, actorSurface, note)],
    };
    this.approvals.set(approvalId, updated);
    if (outcome) outcome.applied = true;
    await this.persist();
    this.publish(updated);
    return updated;
  }

  async resolveApproval(approvalId: string, input: ResolveSharedApprovalInput): Promise<SharedApprovalRecord | null> {
    return this.#resolveApproval(approvalId, input);
  }

  async #resolveApproval(approvalId: string, input: ResolveSharedApprovalInput, proof?: OwnerApprovalProof): Promise<SharedApprovalRecord | null> {
    const approved = input.approved;
    const disposition = input.disposition;
    assertExplicitApprovalDisposition(approved, disposition);
    if (input.outcome) input.outcome.applied = false;
    if (disposition === 'amended' && (input.remember === true || input.rememberTier !== undefined)) {
      throw Object.assign(new Error('An amendment cannot create a remembered approval rule.'), { code: 'INVALID_ARGUMENT', status: 400 });
    }
    await this.start();
    if (this.pendingResolvers.get(approvalId)?.retired) {
      return this.cancelApproval(approvalId, 'approval-broker', 'service', 'all requesting consumers cancelled');
    }
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    const ownerCheck = this.#ownerApprovals.check(approval, input, proof);
    const assertOwnerCurrent = ownerCheck ? (): void => {
      ownerCheck();
      if (this.approvals.get(approvalId) !== approval) throw new Error('Owner approval changed while resolving.');
    } : undefined;
    if (TERMINAL_APPROVAL_STATUSES.has(approval.status)) return approval;
    // Per-hunk selection is only meaningful on approve; a deny is always a
    // whole-request rejection. Compute the modified args from the pending
    // request's OWN edits so the result is identical for every calling surface.
    let modifiedArgs = input.modifiedArgs;
    if (input.selectedHunks !== undefined && approved) {
      const resolution = resolveApprovalHunkSelection(approval.request, input.selectedHunks);
      if (!resolution.ok) {
        throw Object.assign(new Error(resolution.reason), {
          code: 'INVALID_ARGUMENT',
          status: 400,
        });
      }
      modifiedArgs = resolution.modifiedArgs;
    }
    let withheldAnswer = false;
    if (approved && approval.request.attribution?.kind === 'exec-prompt' && typeof modifiedArgs?.['answer'] === 'string') {
      this.#withheldAnswers.set(approvalId, modifiedArgs['answer']);
      modifiedArgs = { ...modifiedArgs, answer: WITHHELD_ANSWER };
      withheldAnswer = true;
    }
    const updated: SharedApprovalRecord = {
      ...approval,
      status: approved ? 'approved' : 'denied',
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: input.actor,
      decision: {
        approved,
        ...(disposition !== undefined ? { disposition } : {}),
        ...(input.remember !== undefined ? { remember: input.remember } : {}),
        ...(input.rememberTier !== undefined ? { rememberTier: input.rememberTier } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(modifiedArgs !== undefined ? { modifiedArgs } : {}),
      },
      audit: [
        ...approval.audit,
        buildAudit(approved ? 'approved' : 'denied', input.actor, input.actorSurface, input.note),
      ],
    };
    const forgetAnswer = (): void => { if (withheldAnswer) this.#withheldAnswers.delete(approvalId); };
    if (this.pendingResolvers.get(approvalId)?.retired) {
      forgetAnswer();
      return this.cancelApproval(approvalId, 'approval-broker', 'service', 'all requesting consumers cancelled');
    }
    try {
      assertOwnerCurrent?.();
    } catch (error) {
      // The decision never started writing; the ask stays answerable.
      forgetAnswer();
      this.#ownerApprovals.settle(approvalId);
      throw error;
    }

    if (!approved) {
      // Deny direction: the waiting call is refused whether or not the write
      // lands, because a refusal can never do what nobody agreed to.
      this.approvals.set(approvalId, updated);
      if (input.outcome) input.outcome.applied = true;
      try {
        await this.persist();
      } catch (error) {
        throw new Error(
          `The denial of ${approvalId} was applied and the waiting call was refused, but it could not be saved (${failureText(error)}). It is saved with the next approvals write.`,
          { cause: error },
        );
      } finally {
        this.resolvePending(approvalId, updated.decision!);
        this.publish(updated);
      }
    } else {
      // An approval takes effect only once it is written: until then the ask
      // stays waiting, so it can still be answered, cancelled or expired, and
      // nothing can release it later on its own.
      let committed: SharedApprovalRecord | null;
      try {
        committed = await this.persist({ record: updated, check: assertOwnerCurrent });
      } catch (error) {
        forgetAnswer();
        if (!assertOwnerCurrent) {
          throw new Error(
            `The approval of ${approvalId} could not be saved (${failureText(error)}). The ask is still waiting: approve it again, deny it or cancel it.`,
            { cause: error },
          );
        }
        await this.cancelApproval(approvalId, 'approval-broker', 'service', 'owner decision no longer current');
        // A signal cancellation may already have queued its own write; land the
        // cancelled record before returning the failed owner answer.
        await this.persist();
        throw error;
      }
      if (!committed) {
        // A cancel or an expiry finished first; that answer stands.
        forgetAnswer();
        return this.approvals.get(approvalId) ?? null;
      }
      if (input.outcome) input.outcome.applied = true;
      this.publish(updated);
      this.resolvePending(approvalId, updated.decision!);
    }

    // A generalizing remember tier answers more than this one ask: sweep every
    // queued pending ask the remembered decision covers (same rule match) and
    // resolve it with the same verdict. modifiedArgs are call-specific and
    // never propagate to swept asks.
    if (input.rememberTier && input.rememberTier !== 'session') {
      const rule = buildDurableRuleForDecision({
        toolName: approval.request.tool,
        args: approval.request.args,
        tier: input.rememberTier,
        effect: approved ? 'allow' : 'deny',
      });
      if (rule) {
        for (const candidate of [...this.approvals.values()]) {
          if (candidate.id === approvalId) continue;
          if (candidate.status !== 'pending' && candidate.status !== 'claimed') continue;
          if (approved && candidate.requiresOwnerDecision) continue;
          // A remembered rule belongs to the project it was made in, so it answers only that project's asks.
          if (candidate.request.workingDirectory !== approval.request.workingDirectory) continue;
          if (this.pendingResolvers.get(candidate.id)?.retired) continue;
          // A device grant is for one capability on one device; the tool-wide rule behind it must not answer other device asks.
          if ((candidate.metadata['deviceCapability'] !== undefined || approval.metadata['deviceCapability'] !== undefined)
            && (candidate.metadata['deviceNodeId'] !== approval.metadata['deviceNodeId']
              || candidate.metadata['deviceCapability'] !== approval.metadata['deviceCapability'])) continue;
          const candidateCurrent = () => {
            assertOwnerCurrent?.();
            if (this.approvals.get(candidate.id) !== candidate || this.pendingResolvers.get(candidate.id)?.retired)
              throw new Error('Remembered approval candidate is no longer pending');
          };
          let covered: Awaited<ReturnType<typeof matchDurableRulesAsync>>;
          try {
            covered = await matchDurableRulesAsync([rule], candidate.request.tool, candidate.request.args, {
              projectRoot: candidate.request.workingDirectory,
              signal: this.pendingResolvers.get(candidate.id)?.promptController?.signal,
              assertCurrent: candidateCurrent,
            });
          } catch (error) {
            if (this.approvals.get(candidate.id) !== candidate || this.pendingResolvers.get(candidate.id)?.retired) continue;
            throw error;
          }
          if (!covered || this.approvals.get(candidate.id) !== candidate || this.pendingResolvers.get(candidate.id)?.retired) continue;
          candidateCurrent();
          const swept: SharedApprovalRecord = {
            ...candidate,
            status: approved ? 'approved' : 'denied',
            updatedAt: Date.now(),
            resolvedAt: Date.now(),
            resolvedBy: input.actor,
            decision: {
              approved,
              disposition: 'remembered',
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
            },
            audit: [
              ...candidate.audit,
              buildAudit(approved ? 'approved' : 'denied', input.actor, input.actorSurface,
                `covered by remembered ${input.rememberTier} decision on ${approvalId}`),
            ],
          };
          if (this.pendingResolvers.get(candidate.id)?.retired) continue;
          this.approvals.set(candidate.id, swept);
          this.publish(swept);
          this.resolvePending(candidate.id, swept.decision ?? { approved });
        }
        // The decision itself is already durable and reported applied; a failed
        // write of the swept asks is retried by the next write, not an error here.
        await this.persist().catch((error: unknown) => {
          logger.warn('Remembered approval sweep not yet written', { approvalId, error: error instanceof Error ? error.message : String(error) });
        });
      }
    }
    return updated;
  }

  /** Resolve every waiter attached to an approval (coalesced asks share one record). */
  private resolvePending(approvalId: string, recorded: SharedApprovalDecision): void {
    this.#ownerApprovals.retire(approvalId);
    const withheld = this.#withheldAnswers.get(approvalId);
    this.#withheldAnswers.delete(approvalId);
    const pending = this.pendingResolvers.get(approvalId);
    if (!pending) return;
    const ordinary = ordinaryApprovalDecision(recorded);
    const decision = withheld !== undefined && ordinary.modifiedArgs !== undefined
      ? { ...ordinary, modifiedArgs: { ...ordinary.modifiedArgs, answer: withheld } }
      : ordinary;
    if (pending.timer) clearTimeout(pending.timer);
    if (recorded.disposition === 'cancelled' || recorded.disposition === 'expired') pending.promptController?.abort();
    for (const resolve of pending.resolvers) resolve(decision);
    this.pendingResolvers.delete(approvalId);
  }

  async recordRemoteUpdate(
    approvalId: string,
    input: {
      readonly actor: string;
      readonly actorSurface?: string | undefined;
      readonly note?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<SharedApprovalRecord | null> {
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    if (this.#ownerApprovals.isResolving(approvalId)) {
      logger.warn('Approval update not recorded while its owner decision is being written', { approvalId, actor: input.actor });
      return approval;
    }
    const updated: SharedApprovalRecord = {
      ...approval,
      updatedAt: Date.now(),
      metadata: {
        ...approval.metadata,
        ...(input.metadata ?? {}),
      },
      audit: [...approval.audit, buildAudit('updated', input.actor, input.actorSurface, input.note)],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);
    return updated;
  }

  async cancelApproval(approvalId: string, actor: string, actorSurface = 'web', note?: string, outcome?: ApprovalActionOutcome): Promise<SharedApprovalRecord | null> {
    if (outcome) outcome.applied = false;
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status === 'approved' || approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired') {
      return approval;
    }
    const updated: SharedApprovalRecord = {
      ...approval,
      status: 'cancelled',
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: actor,
      decision: { approved: false, remember: false, disposition: 'cancelled' },
      audit: [...approval.audit, buildAudit('cancelled', actor, actorSurface, note)],
    };
    this.approvals.set(approvalId, updated);
    if (outcome) outcome.applied = true;
    try {
      await this.persist();
    } catch (error) {
      throw new Error(
        `The cancellation of ${approvalId} was applied and the waiting call was refused, but it could not be saved (${failureText(error)}). It is saved with the next approvals write.`,
        { cause: error },
      );
    } finally {
      // Deny-direction: a waiter released before the write is durable can only
      // refuse its tool call, so a failed write must not leave it hanging.
      this.resolvePending(approvalId, updated.decision!);
      this.publish(updated);
    }
    return updated;
  }

  /**
   * A surface that raised this ask over the wire gives up its claim on it.
   * While another surface that raised the same ask is still waiting the record
   * stays pending for it (returned unchanged, not applied); the last one to
   * leave cancels it. Records without tracked holds cancel outright.
   *
   * `holdId` is the id `raiseApproval` returned to the surface that is
   * leaving. With it, releasing twice is harmless: the second call finds the
   * hold already gone and changes nothing. Without it the call gives up one
   * anonymous hold, which a retry cannot tell from a second surface leaving.
   */
  async releaseApproval(approvalId: string, actor: string, actorSurface = 'web', note?: string, outcome?: ApprovalActionOutcome, holdId?: string): Promise<SharedApprovalRecord | null> {
    if (outcome) outcome.applied = false;
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    const pending = this.pendingResolvers.get(approvalId);
    if (pending && (approval.status === 'pending' || approval.status === 'claimed')) {
      if (holdId !== undefined && pending.holdIds !== undefined) {
        // A release names the hold it gives up, so a retry of the same release
        // changes nothing instead of consuming a hold another surface owns.
        if (!pending.holdIds.delete(holdId)) return approval;
        pending.raiseHolds = Math.max(1, (pending.raiseHolds ?? 1) - 1);
        if (pending.holdIds.size > 0) return approval;
      } else if ((pending.raiseHolds ?? 1) > 1) {
        pending.raiseHolds = (pending.raiseHolds ?? 1) - 1;
        return approval;
      }
    }
    return this.cancelApproval(approvalId, actor, actorSurface, note, outcome);
  }

  private async expireApproval(approvalId: string, note: string): Promise<void> {
    const approval = this.approvals.get(approvalId);
    if (!approval) return;
    if (approval.status !== 'pending' && approval.status !== 'claimed') return;
    const updated: SharedApprovalRecord = {
      ...approval,
      status: 'expired',
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: 'approval-broker',
      decision: { approved: false, remember: false, disposition: 'expired' },
      audit: [...approval.audit, buildAudit('expired', 'approval-broker', 'service', note)],
    };
    this.approvals.set(approvalId, updated);
    try {
      await this.persist();
    } finally {
      this.resolvePending(approvalId, updated.decision!);
      this.publish(updated);
    }
  }

  /**
   * Drop the oldest terminal (approved/denied/cancelled/expired) approvals once
   * they exceed MAX_APPROVAL_RECORDS, bounding both the in-memory Map and the
   * persisted snapshot. Pending/claimed approvals are excluded and never evicted,
   * so their awaiting callers and pendingResolvers are never orphaned.
   */
  private pruneTerminalApprovals(): void {
    const terminal: SharedApprovalRecord[] = [];
    for (const record of this.approvals.values()) {
      if (TERMINAL_APPROVAL_STATUSES.has(record.status)) terminal.push(record);
    }
    if (terminal.length <= MAX_APPROVAL_RECORDS) return;
    terminal.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    for (const record of terminal.slice(MAX_APPROVAL_RECORDS)) {
      this.approvals.delete(record.id);
    }
  }

  /**
   * Replace the store file with the approvals as they stand when this write
   * runs, after every write queued before it has finished.
   *
   * The snapshot is taken inside the queued unit, so the last write to land
   * always carries the newest state and a write queued earlier can never put
   * an older view back on disk. `commit` is an approval that is not yet in
   * effect: it is written in place of its waiting record and enters the map
   * only after the write succeeded and `check` (the owner proof) still holds,
   * inside the same unit, so the next write already carries it. If the ask
   * was settled meanwhile (cancelled, expired), the commit is dropped and null
   * is returned.
   */
  private async persist(commit?: { readonly record: SharedApprovalRecord; readonly check?: (() => void) | undefined }): Promise<SharedApprovalRecord | null> {
    let committed: SharedApprovalRecord | null = null;
    await this.writes.run(async () => {
      const waiting = (): boolean => {
        const current = commit ? this.approvals.get(commit.record.id) : undefined;
        return current !== undefined && !TERMINAL_APPROVAL_STATUSES.has(current.status);
      };
      const override = commit && waiting() ? commit.record : undefined;
      if (override) commit?.check?.();
      this.pruneTerminalApprovals();
      const approvals = sortApprovals(this.approvals.values())
        .map((approval) => override?.id === approval.id ? override : approval);
      await this.store.persist({ approvals: approvals.map(encodeStoredApproval) as SharedApprovalRecord[] });
      if (!override) return;
      commit?.check?.();
      if (!waiting()) return;
      this.approvals.set(override.id, override);
      committed = override;
    });
    return committed;
  }

  private publish(approval: SharedApprovalRecord): void {
    // The record is already durable and its waiters are settled by the caller.
    // A publisher that refuses (the gateway feature is off, a stream closed
    // under it) must not turn a recorded decision into an error for the asker.
    try {
      this.publisher?.publishEvent('approval-update', {
        approval,
        createdAt: Date.now(),
      });
    } catch (error) {
      logger.warn('Approval update not published', { approvalId: approval.id, error: error instanceof Error ? error.message : String(error) });
    }
    try {
      this.publisher?.publishSurfaceMessage({
        surface: 'web',
        title: approval.status === 'pending' || approval.status === 'claimed' ? 'Approval required' : 'Approval resolved',
        body: `${approval.request.tool}: ${approval.request.analysis.summary}`,
        level: approval.status === 'approved'
          ? 'success'
          : approval.status === 'denied' || approval.status === 'expired'
            ? 'warn'
            : 'info',
        metadata: {
          approvalId: approval.id,
          status: approval.status,
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
