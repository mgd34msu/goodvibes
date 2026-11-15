/** Daemon-local, explicitly selected third-party intake. Never an owner-text capture. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { captureDelegatedOwner, sameDelegatedOwner, delegatedReviewOwnership } from './delegated-review-owner.js';
import type { DelegatedReviewOwner } from '../control-plane/delegated-inbound-wire.js';
import type { TelegramSourceAccountReader, TelegramSourceAccountSnapshot, TelegramSourceAccountHandle } from '../channels/telegram/source-account.js';
import type { NativeExecutionAuthority } from '../security/http-auth.js';
import type { ApprovalBroker } from '../control-plane/approval-broker.js';
import type { SharedSessionBroker } from '../control-plane/session-broker.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RouteBindingManager } from '../channels/route-manager.js';
import { createNativeInboundSourceOwner, sameNativeInboundSourceRef, type NativeInboundSourceRef } from '../control-plane/native-inbound-source.js';
import { NativeInboundReceiverRefusal, createNativeInboundHandoff } from '../control-plane/native-inbound-handoff.js';
import { DelegatedInboundReviewReceiver, type DelegatedReviewGrant, type DelegatedReviewRecord } from '../control-plane/delegated-inbound-receiver.js';
import { DelegatedIntakeRefusal, delegatedHold, delegatedTelegramDecisionSchema, type DelegatedTelegramAcceptance, type DelegatedTelegramConfiguration, type DelegatedTelegramDecision, type DelegatedTelegramResult } from '../control-plane/delegated-inbound-wire.js';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { defineLifecycle } from '../utils/lifecycle-machine.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/native-error-summary.js';
// Isolate the provider reader from the long-lived coordinator closure context.
const sourceReader = (read: () => string) => () => ({ text: read(), unsupportedSources: [] });
const routeKey = (chatId: string, threadId?: string) => JSON.stringify([chatId, threadId ?? null]);
const routeFacts = (route: AutomationRouteBinding) => Object.freeze([route.id, route.surfaceKind, route.surfaceId, route.channelId, route.threadId, route.externalId, route.createdAt, route.kind, route.sessionPolicy, route.threadPolicy]);
interface Selection { readonly chatId: string; readonly threadId?: string; }
interface SelectionStore extends Record<string, unknown> { readonly selected: readonly Selection[]; }
interface Configuration {
  readonly id: string; readonly choice: DelegatedTelegramConfiguration; readonly owner: NativeExecutionAuthority;
  readonly account: TelegramSourceAccountSnapshot;
  readonly expected: DelegatedReviewOwner; readonly revision: string; readonly controller: AbortController;
  readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout>;
}
export interface DelegatedTelegramIngress {
  readonly binding: AutomationRouteBinding; readonly chatId: string; readonly threadId?: string | undefined;
  readonly senderId?: string | undefined; readonly edited?: boolean | undefined; readonly providerMessageId: string;
  readonly account?: TelegramSourceAccountHandle | null | undefined;
  readonly readOriginal: () => string;
}
export interface DelegatedTelegramAdapter {
  selects(chatId: string, threadId?: string): Promise<boolean>;
  accept(input: DelegatedTelegramIngress): Promise<DelegatedTelegramAcceptance>;
}
type RaisedOwnerApproval = Awaited<ReturnType<ApprovalBroker['raiseOwnerApproval']>>;
/**
 * A pending review's state. `awaiting-owner`, `deciding`, `approved`, `held` and
 * `cancelled` are the intake's own; `transferred`, `started` and `unknown` are the
 * handoff dispositions an approved review ends in, which `status` has always
 * reported verbatim.
 */
type PendingState = 'awaiting-owner' | 'deciding' | 'approved' | 'held' | 'cancelled' | 'transferred' | 'started' | 'unknown';
const pendingLifecycle = defineLifecycle<PendingState>('delegated Telegram review', {
  'awaiting-owner': ['deciding', 'held', 'cancelled'],
  // A decision attempt that fails returns to awaiting-owner so the owner can retry.
  deciding: ['awaiting-owner', 'approved', 'held', 'cancelled'],
  // Once approved the source is being handed off; only the handoff's own outcome follows.
  approved: ['held', 'unknown', 'transferred', 'started'],
  held: [], cancelled: [], transferred: [], started: [], unknown: [],
});
/** Move a pending review along the declared table; an illegal move (a late callback over a final state) is ignored. */
function movePending(pending: { state: PendingState }, to: PendingState): boolean {
  if (!pendingLifecycle.can(pending.state, to)) return false;
  pending.state = to;
  return true;
}
/** A stored review row as a command result carries it. */
function reviewRecordView(record: DelegatedReviewRecord): DelegatedTelegramResult<'list'>['records'][number] {
  const { owner, ...fields } = record;
  return { ...fields, execution: 'not-started', ...(owner ? { owner: { ...owner, scopes: [...owner.scopes] } } : {}) };
}
/** Most live provider messages one intake tracks; entries leave when their source deadline passes. */
const MAX_TRACKED_INGRESSES = 500;
/** Redelivery guard for a message edit that replaced a captured original. */
const EDIT_DEDUPE_FALLBACK_MS = 600_000;
// Brokers keep only unfinished and recent rows per session, so asking for "all" is bounded by the broker.
const ALL_INPUTS = Number.MAX_SAFE_INTEGER;
interface IngressEntry {
  readonly result: Promise<DelegatedTelegramAcceptance>;
  /** Infinity while the capture is still being decided; then the source deadline. */
  until: number;
  requestId?: string;
}
interface Pending {
  readonly ref: NativeInboundSourceRef; readonly configuration: Configuration;
  readonly sourceController: AbortController; readonly assertCurrent: () => void;
  readonly sourceExpiresAt: { value: number }; readonly timers: Set<ReturnType<typeof setTimeout>>;
  readonly approval: RaisedOwnerApproval;
  readonly run: () => Promise<DelegatedTelegramResult<'decide'>>;
  readonly approveRetainedSource: () => void;
  grant?: DelegatedReviewGrant;
  /** What the review queue said when it refused the handoff, for the decide result. */
  refusal?: string;
  state: PendingState;
}
export class DelegatedTelegramIntake implements DelegatedTelegramAdapter {
  private readonly configurations = new Map<string, Configuration>();
  private readonly selectionAttempts = new Map<string, string>();
  private readonly selected = new Map<string, Selection>();
  private readonly ingresses = new Map<string, IngressEntry>();
  private readonly pending = new Map<string, Pending>();
  private readonly selectionStore: PersistentStore<SelectionStore>;
  private readonly selectionWrites = new StoreWriteQueue();
  private readonly receiver: DelegatedInboundReviewReceiver;
  private loading?: Promise<void>;
  private readonly workspaceRevision: string;
  private closed = false;
  private lifecycleGeneration = 0;
  private accountUnsubscribe?: (() => void) | undefined;
  constructor(private readonly deps: {
    readonly broker: SharedSessionBroker; readonly approvals: ApprovalBroker; readonly routes: Pick<RouteBindingManager, 'getBinding' | 'getBindingIncarnation'>;
    readonly accounts: TelegramSourceAccountReader; readonly workspaceRoot: string;
    readonly selectionPath: string; readonly receiptPath: string; readonly beforeReviewOwnerWrite?: () => void;
  }) {
    this.selectionStore = new PersistentStore(deps.selectionPath);
    this.receiver = new DelegatedInboundReviewReceiver(deps.receiptPath, deps.beforeReviewOwnerWrite);
    this.workspaceRevision = randomUUID();
    this.watchAccount();
  }
  private watchAccount(): void {
    if (!this.accountUnsubscribe) this.accountUnsubscribe = this.deps.accounts.subscribeIdentityChange(account => {
      for (const config of this.configurations.values()) if (config.account.id !== account.id || config.account.revision !== account.revision) { config.controller.abort(); clearTimeout(config.timer); }
    });
  }
  private start(): Promise<void> {
    return this.loading ??= (async () => {
      const saved = await this.selectionStore.load();
      for (const selection of saved?.selected ?? []) this.selected.set(routeKey(selection.chatId, selection.threadId), selection);
    })();
  }
  async selects(chatId: string, threadId?: string): Promise<boolean> { await this.start(); return this.selected.has(routeKey(chatId, threadId)); }
  private assertConfiguration(config: Configuration, requireAdmissionAccount = true): void {
    const current = config.owner.current();
    if (this.closed || config.controller.signal.aborted || Date.now() >= config.expiresAt
      || !sameDelegatedOwner(current, config.expected)
      || this.configurations.get(routeKey(config.choice.chatId, config.choice.threadId)) !== config) {
      config.controller.abort(); throw new DelegatedIntakeRefusal('configuration-not-current');
    }
    // This cached identity is deny-only. configure, ingress, and approve must
    // separately perform acquire/read against the actual credential owner.
    const account = this.deps.accounts.current();
    if (requireAdmissionAccount && (!account || account.id !== config.account.id || account.revision !== config.account.revision)) throw new DelegatedIntakeRefusal('account-proof-changed');
  }
  /** Provider/credential I/O must finish outside the paired-owner critical section. */
  async prepareAccount(signal?: AbortSignal): Promise<TelegramSourceAccountHandle | null> {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const bounded = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Telegram account verification timed out')), 5_000);
      onAbort = () => reject(new Error('Telegram account verification cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([bounded, (async () => {
        const handle = await this.deps.accounts.acquire();
        if (!handle || !await this.deps.accounts.read(handle)) return null;
        this.deps.accounts.assertCurrent(handle); return handle;
      })()]);
    } finally { if (timer) clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); }
  }
  async selectConfiguration(choice: DelegatedTelegramConfiguration, owner: NativeExecutionAuthority): Promise<string> {
    const generation = this.lifecycleGeneration; await this.start();
    const initialOwner = owner.current(); if (!initialOwner || this.closed || generation !== this.lifecycleGeneration) throw new DelegatedIntakeRefusal(initialOwner ? 'lifecycle-changed' : 'owner-changed');
    const expected = captureDelegatedOwner(initialOwner);
    const key = routeKey(choice.chatId, choice.threadId); const attempt = randomUUID();
    this.selectionAttempts.set(key, attempt); const previous = this.configurations.get(key); previous?.controller.abort(); if (previous) clearTimeout(previous.timer);
    this.selected.set(key, { chatId: choice.chatId, ...(choice.threadId ? { threadId: choice.threadId } : {}) });
    const selection = { selected: [...this.selected.values()] };
    await this.selectionWrites.run(() => this.selectionStore.persist(selection, { durable: true }));
    const current = owner.current(); if (this.closed || generation !== this.lifecycleGeneration) throw new DelegatedIntakeRefusal('lifecycle-changed');
    if (!sameDelegatedOwner(current, expected)) throw new DelegatedIntakeRefusal('owner-changed');
    return attempt;
  }
  async configure(choice: DelegatedTelegramConfiguration, owner: NativeExecutionAuthority, prepared?: TelegramSourceAccountHandle | null, selectedAttempt?: string): Promise<DelegatedTelegramResult<'configure'>> {
    const generation = this.lifecycleGeneration;
    const attempt = selectedAttempt ?? await this.selectConfiguration(choice, owner);
    const initialOwner = owner.current(); if (!initialOwner) throw new DelegatedIntakeRefusal('owner-changed');
    const expected = captureDelegatedOwner(initialOwner);
    const key = routeKey(choice.chatId, choice.threadId);
    const assertOwner = () => { if (this.closed || generation !== this.lifecycleGeneration || this.selectionAttempts.get(key) !== attempt) throw new DelegatedIntakeRefusal('lifecycle-changed');
      const current = owner.current(); if (!sameDelegatedOwner(current, expected)) throw new DelegatedIntakeRefusal('owner-changed'); };
    assertOwner();
    const handle = prepared === undefined ? await this.prepareAccount() : prepared;
    const account = handle ? this.deps.accounts.assertCurrent(handle) : null;
    assertOwner();
    const stillSelected = 'The chat stays selected and held; call inbound.telegram.release with its chatId to return it to normal handling.';
    if (!handle || !account) return delegatedHold('account-proof-required', { route: 'selected-and-held', nextStep: `Check the Telegram bot token for this daemon, then call inbound.telegram.configure again. ${stillSelected}` });
    this.deps.accounts.assertCurrent(handle);
    const expectedAccount = choice.accountId.replace(/^@/, '').trim().toLowerCase();
    if (expectedAccount !== account.id && expectedAccount !== account.username.toLowerCase()) return delegatedHold('account-not-chosen', { route: 'selected-and-held', accountIdentity: account, nextStep: `Call inbound.telegram.configure with accountId set to the account shown in accountIdentity. ${stillSelected}` });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), choice.configurationLifetimeMs); timer.unref();
    const config: Configuration = { id: `telegram-config-${randomUUID()}`, choice: Object.freeze({ ...choice }), owner, expected, account,
      revision: randomUUID(), controller, timer, expiresAt: Date.now() + choice.configurationLifetimeMs };
    this.configurations.set(key, config); this.assertConfiguration(config);
    return { outcome: 'configured', configurationId: config.id, accountIdentity: account, expiresAt: config.expiresAt, pendingRetentionMs: choice.pendingRetentionMs,
      processing: 'requires-per-message-approval', restart: 'selected-route-held-without-original-or-grant' };
  }
  async accept(input: DelegatedTelegramIngress): Promise<DelegatedTelegramAcceptance> {
    const generation = this.lifecycleGeneration; await this.start();
    if (this.closed || generation !== this.lifecycleGeneration) return delegatedHold('lifecycle-changed');
    if (!input.account) return delegatedHold('account-proof-required');
    const account = await this.deps.accounts.read(input.account);
    if (!account) return delegatedHold('account-proof-unavailable');
    try { this.deps.accounts.assertCurrent(input.account); } catch { return delegatedHold('account-proof-changed'); }
    if (this.closed || generation !== this.lifecycleGeneration) return delegatedHold('lifecycle-changed');
    if (!input.providerMessageId) return delegatedHold('message-identity-missing');
    const key = JSON.stringify([account.id, account.revision, input.binding.id, input.providerMessageId]);
    this.prune();
    const previous = this.ingresses.get(key);
    const full = delegatedHold('tracking-full');
    if (input.edited) {
      if (!previous && this.ingresses.size >= MAX_TRACKED_INGRESSES) return full;
      const held = delegatedHold('message-edited');
      const retention = this.configurations.get(routeKey(input.chatId, input.threadId))?.choice.pendingRetentionMs ?? EDIT_DEDUPE_FALLBACK_MS;
      this.ingresses.set(key, { result: Promise.resolve(held), until: Date.now() + retention });
      if (previous) { const found = await previous.result; const entry = found.outcome === 'awaiting-owner' ? this.pending.get(found.ref.requestId) : undefined; entry?.sourceController.abort(); }
      return held;
    }
    if (previous) return previous.result;
    if (this.ingresses.size >= MAX_TRACKED_INGRESSES) return full;
    const entry: IngressEntry = { result: this.acceptOnce(input, account, generation), until: Infinity };
    this.ingresses.set(key, entry);
    // A held answer that captured nothing needs no redelivery guard; a captured one keeps it until its source deadline.
    void entry.result.then(result => {
      if (result.outcome === 'awaiting-owner') { entry.until = result.sourceExpiresAt; entry.requestId = result.ref.requestId; }
      else if (this.ingresses.get(key) === entry) this.ingresses.delete(key);
    }, () => { if (this.ingresses.get(key) === entry) this.ingresses.delete(key); });
    return entry.result;
  }
  /** Forget redelivery guards and pending reviews whose source deadline has passed. */
  private prune(): void {
    const now = Date.now();
    for (const [requestId, entry] of this.pending) {
      if (now < entry.sourceExpiresAt.value) continue;
      entry.sourceController.abort(); this.pending.delete(requestId);
    }
    for (const [key, entry] of this.ingresses) {
      const live = entry.requestId ? this.pending.get(entry.requestId)?.sourceExpiresAt.value : undefined;
      if (now >= Math.max(entry.until, live ?? 0)) this.ingresses.delete(key);
    }
  }
  private async acceptOnce(input: DelegatedTelegramIngress, account: TelegramSourceAccountSnapshot, generation: number): Promise<DelegatedTelegramAcceptance> {
    if (this.closed || generation !== this.lifecycleGeneration) return delegatedHold('lifecycle-changed');
    const config = this.configurations.get(routeKey(input.chatId, input.threadId));
    if (!config) return delegatedHold('no-configuration');
    try { this.assertConfiguration(config); if (config.account.id !== account.id || config.account.revision !== account.revision) throw new Error('Account scope changed'); } catch { return delegatedHold('configuration-not-current'); }
    const sourceController = new AbortController(); const sourceExpiresAt = { value: Date.now() + config.choice.pendingRetentionMs };
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const expire = (at: number) => { const timer = setTimeout(() => sourceController.abort(), Math.max(1, at - Date.now())); timer.unref(); timers.add(timer); };
    expire(sourceExpiresAt.value);
    const expectedRoute = routeFacts(input.binding);
    const bindingId = input.binding.id;
    const incarnation = this.deps.routes.getBindingIncarnation(bindingId);
    let boundSessionId: string | undefined;
    let approvedSource = false;
    const assertCurrent = () => {
      this.assertConfiguration(config, !approvedSource); sourceController.signal.throwIfAborted();
      const route = this.deps.routes.getBinding(bindingId);
      if (Date.now() >= sourceExpiresAt.value || !route || !incarnation || this.deps.routes.getBindingIncarnation(bindingId) !== incarnation || !isDeepStrictEqual(routeFacts(route), expectedRoute) || (boundSessionId !== undefined && route.sessionId !== boundSessionId)) { sourceController.abort(); throw new DelegatedIntakeRefusal('source-unavailable'); }
    };
    const lifetime = AbortSignal.any([sourceController.signal, config.controller.signal]);
    const sources = createNativeInboundSourceOwner({ origin: { kind: 'external-original', accountId: config.account.id,
      accountRevision: config.account.revision, routeId: input.binding.id, routeRevision: incarnation ?? 'unavailable' }, lifetime, assertCurrent,
      readBrokerInput: target => this.findInput(target.sessionId, target.inputId) ?? null });
    lifetime.addEventListener('abort', () => { for (const timer of timers) clearTimeout(timer); sources.close(); }, { once: true });
    let queuedRef = undefined as NativeInboundSourceRef | undefined;
    try {
      this.deps.accounts.assertCurrent(input.account!);
      const handle = sources.producer.capture(sourceReader(input.readOriginal), lifetime);
      let ref!: NativeInboundSourceRef;
      const submitted = await this.deps.broker.submitDelegatedMessage({ routeId: input.binding.id, surfaceKind: 'telegram', surfaceId: input.binding.surfaceId,
        externalId: input.binding.externalId, threadId: input.threadId ?? input.chatId, userId: input.senderId,
        body: '[External Telegram message held for explicit owner review]', title: 'External Telegram intake',
        metadata: { providerMessageId: input.providerMessageId } }, row => {
          boundSessionId = row.sessionId;
          ref = sources.producer.bind(handle, { sessionId: row.sessionId, inputId: row.id }); queuedRef = ref; return { ref, assertCurrent };
        });
      assertCurrent();
      const approval = await this.deps.approvals.raiseOwnerApproval({ sessionId: ref.sessionId, signal: lifetime,
        timeoutMs: Math.max(1, sourceExpiresAt.value - Date.now()),
        request: { callId: ref.requestId, tool: 'inbound.telegram.review', category: 'delegate', args: { ref, origin: { kind: 'external-original', accountId: config.account.id, accountRevision: config.account.revision, username: config.account.username, routeId: input.binding.id },
          configurationId: config.id, providerMessageId: input.providerMessageId, chatId: input.chatId, ...(input.threadId ? { threadId: input.threadId } : {}), externalAuthorId: input.senderId ?? 'unknown-external-author', pendingSourceExpiresAt: sourceExpiresAt.value, requiredChoices: 'processingPurpose, sourceRetentionMs, derivedRecordRetentionMs, ownerMayReadOriginal=true, execution=none', decisionCommand: 'inbound.telegram.decide' },
          analysis: { classification: 'external-message-review', riskLevel: 'high', summary: 'Approve one external Telegram message for owner review only. Choose a bounded original-memory lifetime and a metadata-only review-record lifetime. No work execution.',
            reasons: ['Original content is not copied into this approval. Use the provider message identity to review the source.', 'Only the paired owner decision command can approve. Generic approve, remembered rules, and channel replies cannot.', 'Raw source is released at the chosen deadline or review cancellation. Persisted metadata expires while running, or is pruned at next startup.'] }, rememberOptions: [] },
        requireOwnerDecision: { assertCurrent, validateDecision: decision => {
          if (!decision.approved) return;
          const parsed = delegatedTelegramDecisionSchema.parse(decision.modifiedArgs);
          if (!parsed.approved || parsed.approvalId !== approval.approval.id || !sameNativeInboundSourceRef(parsed.ref, ref)) throw new Error('Decision does not bind this exact source');
        } },
      });
      assertCurrent();
      const pending: Pending = { ref, configuration: config, sourceController, sourceExpiresAt, timers, assertCurrent, approval, state: 'awaiting-owner', approveRetainedSource: () => { approvedSource = true; }, run: async () => delegatedHold('handoff-held', { ref }) };
      const handoff = createNativeInboundHandoff({ sources: sources.resolver, lifetime,
        owner: { withCurrent: async (_source, use) => { assertCurrent(); if (!pending.grant) throw new Error('No exact owner approval');
          return use(assertCurrent, `${config.revision}:${config.id}:${approval.approval.id}`, lifetime); } },
        receiver: { accept: async (source, options) => {
          if (!pending.grant) throw new Error('No exact grant');
          try { return await this.receiver.receiver(pending.grant).accept(source, options); }
          catch (error) { if (error instanceof NativeInboundReceiverRefusal) pending.refusal = error.message; throw error; }
        },
          inspect: async reference => pending.grant ? this.receiver.receiver(pending.grant).inspect(reference) : null,
          cancel: reference => this.receiver.cancel(reference) },
      });
      const run = async (): Promise<DelegatedTelegramResult<'decide'>> => {
        const result = await handoff.run({ sessionId: ref.sessionId, input: submitted.submission.input, task: '' });
        const disposition = result.disposition ?? 'held';
        movePending(pending, disposition);
        if (disposition === 'transferred') await submitted.complete({ disposition: 'transferred', ref, requestId: ref.requestId });
        if (disposition !== 'held') return { outcome: disposition, ref, execution: 'not-started' };
        return pending.refusal ? delegatedHold('review-queue-refused', { ref, message: pending.refusal }) : delegatedHold('handoff-held', { ref });
      };
      Object.assign(pending, { run }); this.pending.set(ref.requestId, pending);
      // Await the real broker outcome without holding the provider invocation open.
      // Any outcome but an approval (deny, expiry, cancel, revoke) leaves no
      // work to do, so the held input must not stay queued and keep the session busy.
      const retireQueuedInput = () => this.retireQueuedInput(ref);
      void approval.decision.then(async decision => {
        if (decision.approved) return;
        movePending(pending, 'held'); sourceController.abort(); await retireQueuedInput();
      }).catch(async () => { sourceController.abort(); await retireQueuedInput().catch(() => {}); });
      return { outcome: 'awaiting-owner', approvalId: approval.approval.id, ref, sourceExpiresAt: sourceExpiresAt.value };
    } catch (error) {
      sourceController.abort();
      // A failure after the broker queued the message must not leave that input holding the session busy.
      if (queuedRef) await this.retireQueuedInput(queuedRef).catch(() => {});
      logger.warn('Delegated Telegram intake held a message; no original was kept', { routeId: input.binding.id, providerMessageId: input.providerMessageId, error: summarizeError(error) });
      return delegatedHold('source-unavailable');
    }
  }
  private findInput(sessionId: string, inputId: string) { return this.deps.broker.getInputs(sessionId, ALL_INPUTS).find(row => row.id === inputId); }
  private async retireQueuedInput(ref: NativeInboundSourceRef): Promise<void> {
    if (this.findInput(ref.sessionId, ref.inputId)?.state === 'queued') await this.deps.broker.cancelInput(ref.sessionId, ref.inputId);
  }
  async decide(input: DelegatedTelegramDecision, authority: NativeExecutionAuthority, prepared?: TelegramSourceAccountHandle | null): Promise<DelegatedTelegramResult<'decide'>> {
    const pending = this.pending.get(input.ref.requestId);
    if (!pending || !sameNativeInboundSourceRef(pending.ref, input.ref) || pending.approval.approval.id !== input.approvalId) throw new DelegatedIntakeRefusal('source-unavailable');
    const current = authority.current(); if (!sameDelegatedOwner(current, pending.configuration.expected)) throw new DelegatedIntakeRefusal('not-owner');
    const expectedOwner = pending.configuration.expected;
    const assertOwner = () => { const active = authority.current(); if (!sameDelegatedOwner(active, expectedOwner)) throw new DelegatedIntakeRefusal('owner-changed'); };
    {
      if (input.approved) {
        const handle = prepared === undefined ? await this.prepareAccount() : prepared; const account = handle ? this.deps.accounts.assertCurrent(handle) : null;
        if (!handle || !account || account.id !== pending.configuration.account.id || account.revision !== pending.configuration.account.revision) throw new DelegatedIntakeRefusal('account-proof-unavailable');
        this.deps.accounts.assertCurrent(handle);
      }
      const assert = () => { assertOwner(); pending.assertCurrent(); };
      assert(); if (pending.state !== 'awaiting-owner') throw new DelegatedIntakeRefusal('already-decided');
      if (input.approved && input.choices) {
        const expiresAt = Date.now() + input.choices.sourceRetentionMs;
        if (expiresAt > pending.configuration.expiresAt) throw new DelegatedIntakeRefusal('lifetime-exceeds-configuration');
        pending.grant = { configurationId: pending.configuration.id, ownerRevision: pending.configuration.revision, owner: expectedOwner, workspaceRevision: this.workspaceRevision,
          approvalId: input.approvalId, choices: Object.freeze({ ...input.choices }), sourceExpiresAt: expiresAt };
      }
      movePending(pending, 'deciding');
      // Once the broker has recorded the owner's answer, a later failure must not look retryable.
      let resolved = false;
      try {
      const settled = await pending.approval.resolveOwnerDecision({ decision: { approved: input.approved, ...(input.approved ? { modifiedArgs: input } : {}) }, actor: expectedOwner.principalId, actorSurface: 'paired-owner-command', assertCurrent: assert });
      resolved = true;
      assertOwner();
      if (input.approved && (settled?.status !== 'approved' || settled.decision?.disposition !== 'approved' || JSON.stringify(settled.decision.modifiedArgs) !== JSON.stringify(input))) { pending.sourceController.abort(); throw new DelegatedIntakeRefusal('not-durably-resolved'); }
      if (!input.approved) {
        pending.sourceController.abort();
        await this.retireQueuedInput(input.ref); assertOwner();
        return { outcome: 'denied', ref: input.ref, execution: 'not-started' };
      }
      assert();
      for (const timer of pending.timers) clearTimeout(timer); pending.timers.clear();
      pending.approveRetainedSource();
      pending.sourceExpiresAt.value = pending.grant!.sourceExpiresAt;
      const timer = setTimeout(() => pending.sourceController.abort(), Math.max(1, pending.sourceExpiresAt.value - Date.now())); timer.unref(); pending.timers.add(timer);
      movePending(pending, 'approved'); const outcome = await pending.run(); assertOwner(); return outcome;
      } catch (error) {
        // A failed attempt must not strand the review in 'deciding': that state
        // rejects every retry. Before the broker recorded an answer, return it to
        // the owner. After that the broker and the review would disagree if it went
        // back to awaiting-owner, so it is held (original released, cancel still
        // allowed) or, once handed off, unknown.
        // movePending assigns state, which the compiler cannot see through the earlier narrowing.
        const stateNow: string = pending.state;
        if (stateNow === 'deciding' && !resolved) { delete pending.grant; movePending(pending, 'awaiting-owner'); }
        else if (stateNow === 'deciding') {
          delete pending.grant; pending.sourceController.abort(); movePending(pending, 'held');
          await this.retireQueuedInput(input.ref).catch(() => {});
        } else if (stateNow === 'approved') movePending(pending, 'unknown');
        throw error;
      }
    }
  }
  private captureOwner(authority: NativeExecutionAuthority): { owner: DelegatedReviewOwner; assertCurrent: () => void } {
    if (this.closed) throw new DelegatedIntakeRefusal('lifecycle-changed');
    const initial = authority.current(); if (!initial) throw new DelegatedIntakeRefusal('owner-changed');
    const owner = captureDelegatedOwner(initial), generation = this.lifecycleGeneration;
    return { owner, assertCurrent: () => {
      const current = authority.current();
      if (this.closed || generation !== this.lifecycleGeneration) throw new DelegatedIntakeRefusal('lifecycle-changed');
      if (!sameDelegatedOwner(current, owner)) throw new DelegatedIntakeRefusal('owner-changed');
    } };
  }
  async status(ref: NativeInboundSourceRef, authority: NativeExecutionAuthority, read = false): Promise<DelegatedTelegramResult<'status'>> {
    const { owner, assertCurrent } = this.captureOwner(authority);
    const pending = this.pending.get(ref.requestId);
    const record = await this.receiver.get(ref); assertCurrent();
    if (record) {
      if (!delegatedReviewOwnership(owner)(record)) throw new DelegatedIntakeRefusal('not-owner');
      let original = await this.receiver.read(ref); assertCurrent();
      if (original) {
        try {
          if (!pending || !sameNativeInboundSourceRef(pending.ref, ref)) throw new Error('Original source proof is unavailable');
          pending.assertCurrent();
        } catch { this.receiver.release(ref); original = null; }
      }
      return { outcome: 'recorded', record: reviewRecordView(record), source: original ? 'available-in-memory' : 'expired-or-lost', recovery: original ? 'owner-review-available' : 'new-original-required', ...(read && original ? { original: { text: original.text, unsupportedSources: original.unsupportedSources.map(entry => ({ ...entry })) } } : {}) };
    }
    if (!pending || !sameNativeInboundSourceRef(pending.ref, ref)) return delegatedHold('missing-source-proof');
    if (!isDeepStrictEqual(owner, pending.configuration.expected)) throw new DelegatedIntakeRefusal('not-owner');
    const approvalId = pending.approval.approval.id;
    if (pending.state === 'cancelled') return { ref, outcome: 'cancelled', source: 'released', approvalId };
    // Handed to the queue, and the queue no longer holds it: cancelled or expired there.
    if (pending.state === 'transferred') return delegatedHold('review-closed', { ref, approvalId, source: 'expired-or-lost' });
    let available = true; try { pending.assertCurrent(); } catch { available = false; }
    if (!available) return delegatedHold('source-unavailable', { ref, approvalId, source: 'expired-or-lost' });
    if (pending.state === 'held') return delegatedHold('review-held', { ref, approvalId, source: 'expired-or-lost' });
    return { ref, outcome: pending.state, source: 'awaiting-owner', approvalId };
  }
  async list(authority: NativeExecutionAuthority): Promise<DelegatedTelegramResult<'list'>> {
    const { owner, assertCurrent } = this.captureOwner(authority);
    this.prune();
    const records = await this.receiver.list(); assertCurrent();
    return { outcome: 'listed', records: records.filter(delegatedReviewOwnership(owner)).map(reviewRecordView),
      pending: [...this.pending.values()].filter(entry => isDeepStrictEqual(entry.configuration.expected, owner)).map(entry => ({ ref: entry.ref, approvalId: entry.approval.approval.id, sourceExpiresAt: entry.sourceExpiresAt.value, outcome: entry.sourceController.signal.aborted ? 'held' : entry.state })) };
  }
  async cancel(ref: NativeInboundSourceRef, authority: NativeExecutionAuthority): Promise<DelegatedTelegramResult<'cancel'>> {
    const { owner, assertCurrent } = this.captureOwner(authority);
    const pending = this.pending.get(ref.requestId); const record = await this.receiver.get(ref); assertCurrent();
    if (record) { if (!delegatedReviewOwnership(owner)(record)) throw new DelegatedIntakeRefusal('not-owner'); }
    else if (pending && sameNativeInboundSourceRef(pending.ref, ref)) { if (!isDeepStrictEqual(pending.configuration.expected, owner)) throw new DelegatedIntakeRefusal('not-owner'); }
    else return delegatedHold('missing-source-proof');
    if (pending) { pending.sourceController.abort(); movePending(pending, 'cancelled'); await this.deps.approvals.cancelApproval(pending.approval.approval.id, owner.principalId, 'paired-owner-command'); assertCurrent(); }
    await this.retireQueuedInput(ref); assertCurrent();
    await this.receiver.cancel(ref); assertCurrent(); return { outcome: 'cancelled', execution: 'not-started' };
  }
  revoke(configurationId: string, authority: NativeExecutionAuthority): DelegatedTelegramResult<'revoke'> {
    const { owner } = this.captureOwner(authority);
    const config = [...this.configurations.values()].find(value => value.id === configurationId);
    if (!config) return delegatedHold('configuration-unavailable', { nextStep: 'Nothing to revoke; call inbound.telegram.configure to set up a configuration, or inbound.telegram.release with the chatId to stop routing the chat.' });
    if (!isDeepStrictEqual(owner, config.expected)) throw new DelegatedIntakeRefusal('not-owner');
    config.controller.abort(); clearTimeout(config.timer);
    return { outcome: 'revoked', route: 'remains-selected-and-held' };
  }
  /**
   * Selecting a chat routes every later message through this intake and, with no
   * live configuration, holds it. Releasing returns the chat to normal handling.
   */
  async release(target: string | { readonly chatId: string; readonly threadId?: string | undefined }, authority: NativeExecutionAuthority): Promise<DelegatedTelegramResult<'release'>> {
    const { owner, assertCurrent } = this.captureOwner(authority);
    await this.start();
    let key: string;
    if (typeof target === 'string') {
      const config = [...this.configurations.values()].find(value => value.id === target);
      if (!config) return delegatedHold('configuration-unavailable', { nextStep: 'Call inbound.telegram.release with the chatId (and threadId) of the selected chat instead.' });
      if (!isDeepStrictEqual(owner, config.expected)) throw new DelegatedIntakeRefusal('not-owner');
      key = routeKey(config.choice.chatId, config.choice.threadId);
    } else {
      key = routeKey(target.chatId, target.threadId);
      if (!this.selected.has(key)) return delegatedHold('chat-not-selected');
      const config = this.configurations.get(key);
      if (config && !isDeepStrictEqual(owner, config.expected)) throw new DelegatedIntakeRefusal('not-owner');
    }
    const live = this.configurations.get(key);
    if (live) { live.controller.abort(); clearTimeout(live.timer); }
    this.configurations.delete(key); this.selectionAttempts.delete(key); this.selected.delete(key);
    const selection = { selected: [...this.selected.values()] };
    await this.selectionWrites.run(() => this.selectionStore.persist(selection, { durable: true })); assertCurrent();
    return { outcome: 'released', route: 'normal-handling-resumes' };
  }
  /** A new daemon lifecycle restores commands, never previous source/grant lifetimes. */
  startLifecycle(): void { this.closed = false; this.watchAccount(); this.receiver.reopen(); }
  close(): void { this.ingresses.clear(); this.pending.clear(); this.selectionAttempts.clear(); this.accountUnsubscribe?.(); this.accountUnsubscribe = undefined; this.lifecycleGeneration++; this.closed = true; for (const config of this.configurations.values()) { config.controller.abort(); clearTimeout(config.timer); } this.receiver.close(); }
}
