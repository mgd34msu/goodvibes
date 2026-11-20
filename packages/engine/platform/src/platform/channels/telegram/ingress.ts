/**
 * ingress.ts, supervises the Telegram INBOUND path.
 *
 * Background: registering `POST /webhook/telegram` is not the same as having
 * inbound Telegram. Telegram pushes nothing until it is told a URL exists
 * (setWebhook) or is asked for updates (getUpdates). With neither call wired
 * up, configuring a bot token produced a surface that could send but never
 * receive, outbound replies worked, so it looked half-alive rather than
 * broken. This supervisor is the missing half.
 *
 * Mode is decided by `surfaces.telegram.mode`, which is an explicit,
 * operator-visible setting rather than something inferred:
 *
 *   polling , long-poll getUpdates. Works on a laptop, behind NAT, with no
 *              public hostname and no tunnel. This is the mode most people can
 *              actually run.
 *   webhook , Telegram POSTs to a public HTTPS URL. Lower latency, but it
 *              requires an address Telegram's servers can reach.
 *
 * The two are mutually exclusive by construction, not by convention: Telegram
 * rejects getUpdates with 409 Conflict while a webhook is registered, so
 * polling deletes any registered webhook before its first poll, and webhook
 * mode never starts a loop. Exactly one path is armed per start(), and which
 * one, with the reason, is logged.
 */
import { Secret } from '../../security/secret.js';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import type { ConfigManager } from '../../config/manager.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { SurfaceAdapterContext } from '../../adapters/types.js';
import { processTelegramUpdate, telegramUpdateReceiveScope } from '../../adapters/telegram/index.js';
import { isSecretRefInput, normalizeSecretRef, resolveSecretInput } from '../../config/secret-refs.js';
import { looksLikeSecretRef } from '../../config/secret-ref-refusal.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { IngressProcessingHealth, ingressOutcome, type ChannelIngressAlarm } from '../ingress-alarm.js';
import { isAdmissionRefusal, WORK_ADMISSION_RECHECK_MS } from '../../daemon/work-admission.js';
import { TelegramApiError, TelegramBotApi, TelegramUpdateResponseError, type TelegramBotIdentity, type TelegramUpdate } from './api.js';
import { channelCredentials } from '../credential-holder.js';
import { TelegramPollingReceiveProgress, TelegramReceiveCoverageError, type TelegramReceiveScope } from './receive-progress.js';
import { bindEarlierTelegramCursor, TelegramOffsetStore, TelegramOffsetStoreError, type TelegramPollingCursor } from './offset-store.js';
import { CONFLICT_ESCALATION_ATTEMPTS, classifyTelegramConflict } from './conflict-policy.js';
import { TelegramCursorMigration } from './cursor-migration.js';
import type { TelegramCursorPreview, TelegramCursorMigrationResult } from './cursor-migration-data.js';
import type { TelegramSourceAccountLease, TelegramSourceAccountOwner } from './source-account.js';
import { PaymentReplyHistoryError } from '../../payments/reply-history.js';
import { isLoopbackHost } from '../../utils/reachable-base-url.js';

/** Telegram holds the request open this long when there is nothing to report. */
const POLL_TIMEOUT_SECONDS = 25;
/** Backoff floor and ceiling for transient failures. */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/**
 * How many times one update is handed to the processor when it answers with a
 * failure a second attempt can fix (408, 409, 429, 5xx) or throws, before it is
 * skipped. A webhook update gets the same from Telegram's own redelivery.
 */
const UPDATE_ATTEMPTS = 3;
/** Longest wait honoured between two attempts at one update, so other chats are not held long behind it. */
const UPDATE_RETRY_MAX_MS = 10_000;
/**
 * Extra random delay added to a conflict retry, so two consumers of one token
 * do not fall into lockstep and terminate each other's long poll forever.
 */
const CONFLICT_JITTER_MS = 5_000;
/** The route registered by the builtin channel plugin. */
const TELEGRAM_WEBHOOK_PATH = '/webhook/telegram';
/**
 * Failed polls in a row before the surface reports it is not receiving. One
 * failed long poll is routine; three is an outage the owner should see.
 */
const RECEIVE_FAILURES_BEFORE_DEGRADED = 3;
/**
 * How often an armed webhook asks Telegram whether its deliveries arrive: the
 * channel health sweep's period, so a dead tunnel shows at the next sweep.
 */
const WEBHOOK_DELIVERY_CHECK_MS = 60_000;

export type TelegramIngressMode = 'polling' | 'webhook' | 'inactive';

/**
 * What the ingress is doing about receiving, apart from which mode it is in.
 *
 *   receiving  polling returned, or the webhook is registered and Telegram
 *              reports no delivery failure
 *   blocked    polling is up but another receiver holds the bot (Telegram's
 *              409), a cursor saved by an earlier version waits for review, or
 *              the webhook is registered and Telegram cannot deliver to it
 *   retrying   polling or webhook registration is failing and is retried on
 *              the backoff; `reason` says why and when
 *   stopped    stopped on this node, on purpose
 *   inactive   cannot receive until a setting changes (a rejected token, a
 *              missing setting); `reason` says what to fix
 */
export type TelegramIngressKind = 'receiving' | 'blocked' | 'retrying' | 'stopped' | 'inactive';

export interface TelegramIngressStatus {
  readonly kind: TelegramIngressKind;
  readonly mode: TelegramIngressMode;
  /** Why this mode, and, when inactive, exactly what to fix. */
  readonly reason: string;
  readonly running: boolean;
  /**
   * The most recent inbound message this node could not PROCESS, while the run
   * of failures lasts. Deliberately not folded into `running`: the loop can be
   * turning over perfectly while everything it hands on throws, which is the
   * defect this field exists for. See IngressProcessingHealth.
   */
  readonly lastError?: string | undefined;
}

export interface TelegramIngressDeps {
  /** Construction-only receive clock; native composition uses Date.now. */
  readonly now?: (() => number) | undefined;
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  /** Where the getUpdates cursor lives; surface-scoped by the composition root. */
  readonly offsetFilePath: string;
  /** Native host publishes its reader floor before a new cursor format. */
  readonly beforeCursorWrite?: (() => void) | undefined;
  readonly beforeReceiveSpanWrite?: (() => void) | undefined;
  /** Lazy provider identity proof for selected intake and pending payment replies. */
  readonly telegramSourceAccounts?: TelegramSourceAccountOwner | undefined;
  /** Test seam: swap in a client with an injected fetch. */
  readonly createApi?: ((token: string) => TelegramBotApi) | undefined;
  /** Where a skipped message reaches the owner; absent still logs and degrades. */
  readonly ingressAlarm?: ChannelIngressAlarm | undefined;
  /**
   * Telegram told us another process is already long-polling this bot token.
   *
   * The cluster coordinator listens on this to stand this node down and re-run
   * its election. The poll loop reports it and then KEEPS POLLING on a jittered
   * backoff: standing down permanently is what made inbound Telegram go dead on
   * a live machine, because with `cluster.enabled` off there is no election to
   * stand down to, and the competing consumer is frequently transient anyway.
   */
  readonly onConcurrentConsumerConflict?: ((detail: string) => void) | undefined;
  /**
   * Where the conflict-retry jitter comes from: a fraction in [0, 1) scaled by
   * `CONFLICT_JITTER_MS`. Defaults to `Math.random`.
   *
   * A seam rather than a hidden `Math.random()` call because a test that has
   * to wait out an unobservable random delay is not testing recovery, it is
   * rolling dice: with a five-second spread and a five-second test timeout,
   * one run in five failed on the draw alone, and every one of those failures
   * looked exactly like a regression in recovery.
   */
  readonly conflictJitterFraction?: (() => number) | undefined;
}

/**
 * Telegram only delivers webhooks to a public HTTPS address. A loopback or
 * private-range URL is the single most likely misconfiguration (the daemon's
 * own default base URL is loopback), and silently accepting it produces a
 * webhook that is registered but never fires, indistinguishable from the bug
 * this file fixes. Reject it up front with a message naming the fix.
 */
export function describeWebhookUrlProblem(rawUrl: string): string | null {
  if (!rawUrl.trim()) {
    return 'no public base URL is configured (web.publicBaseUrl)';
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `web.publicBaseUrl is not a valid URL (${rawUrl})`;
  }
  if (url.protocol !== 'https:') {
    return `Telegram only delivers webhooks over HTTPS, but web.publicBaseUrl is ${url.protocol}//`;
  }
  // URL keeps the brackets on an IPv6 host (`[::1]`).
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = isLoopbackHost(host) || host === '::' || host === '0.0.0.0';
  const isPrivate = /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host)
    || /^fe[89ab][0-9a-f]:/.test(host)
    || host.endsWith('.local')
    || host.endsWith('.internal');
  if (isLoopback || isPrivate) {
    return `web.publicBaseUrl points at ${url.hostname}, which Telegram's servers cannot reach`;
  }
  return null;
}

/** The reason a processor's failure answer gave, or its status. */
async function skippedReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    const error = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
    if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 300);
  } catch {
    // The status is the reason when the answer carried no readable error.
  }
  return `HTTP ${response.status}`;
}

/**
 * Tells the sender of an update that could not be processed why nothing
 * started. A failed notice is logged; the skip itself already reached the
 * owner through the processing health.
 */
async function notifySkippedSender(api: TelegramBotApi, scope: TelegramReceiveScope, reason: string): Promise<void> {
  const text = `Your message could not be taken (${reason}), so nothing was started. Send it again in a few minutes.`;
  try {
    await api.sendMessage({ chatId: scope.conversationId, text, threadId: scope.threadId });
  } catch (error) {
    logger.warn('Telegram ingress: could not tell the sender a skipped message was not taken', {
      surface: 'telegram', conversationId: scope.conversationId, error: summarizeError(error),
    });
  }
}

export class TelegramIngressSupervisor {
  private stopped = true;
  private generation = 0;
  private credentialRevision = 0;
  private credentialUnsubscribe: (() => void) | null = null;
  /** The last credential comparison and the owner revisions it was made under. */
  private credentialCheck: { readonly key: string; readonly snapshot: string; readonly token: string; readonly result: boolean } | null = null;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private readonly retiringLoops = new Set<Promise<void>>();
  private webhookSetup: Promise<TelegramIngressStatus> | null = null;
  private pollingSetup: Promise<TelegramIngressStatus> | null = null;
  private cursorMigration: TelegramCursorMigration | undefined;
  private readonly cursorMigrations = new Set<TelegramCursorMigration>();
  /** Who this bot is, per getMe, see resolveBotIdentity. */
  private botIdentity: TelegramBotIdentity | null = null;
  /**
   * A cursor saved by an earlier version is waiting for the owner's review
   * because no bot was ever recorded for it. While it waits, the discovered
   * bot is not recorded either: that record is what would name the cursor's
   * bot, and writing the current bot into it would bind the cursor unasked.
   */
  private earlierCursorHeld = false;
  private currentStatus: TelegramIngressStatus = {
    kind: 'inactive',
    mode: 'inactive',
    reason: 'not started',
    running: false,
  };
  /**
   * Why polling is not receiving, while it is not. Kept apart from
   * `currentStatus` because a blocked or failing loop is still running, and
   * only a poll that comes back proves it receives again.
   */
  private receiveFailure: string | null = null;
  /** Why Telegram says an armed webhook's deliveries are not arriving, while that lasts. */
  private webhookDeliveryFailure: string | null = null;
  /** Polls that came back, counted so a rebuilt receiver resets its backoff once it works again. */
  private completedPolls = 0;
  /** The token the latest start() resolved, compared when a secret changes. */
  private startedToken: string | null = null;

  /** Whether this node can PROCESS what it receives, see the class header. */
  private readonly processing: IngressProcessingHealth;
  private readonly beforeCursorWrite: (() => void) | undefined;
  private readonly beforeReceiveSpanWrite: (() => void) | undefined;

  constructor(private readonly deps: TelegramIngressDeps) {
    this.processing = new IngressProcessingHealth('telegram', deps.ingressAlarm);
    this.beforeCursorWrite = deps.beforeCursorWrite?.bind(deps);
    this.beforeReceiveSpanWrite = deps.beforeReceiveSpanWrite?.bind(deps);
  }

  /**
   * The fraction the conflict jitter is drawn from, clamped into [0, 1).
   *
   * Clamped rather than trusted: a seam that a caller can set to 5 would turn
   * a five-second stagger into a twenty-five-second one, and the point of the
   * jitter is to break lockstep, not to extend an outage.
   */
  private conflictJitterFraction(): number {
    const draw = this.deps.conflictJitterFraction?.() ?? Math.random();
    if (!Number.isFinite(draw) || draw <= 0) return 0;
    return draw >= 1 ? 0.999_999 : draw;
  }

  get status(): TelegramIngressStatus {
    // Merged rather than stored on `currentStatus`: the mode transitions below
    // REPLACE that object wholesale, so a processing failure recorded there
    // would be erased by the next routine status refresh.
    const delivery = this.currentStatus.mode === 'webhook' ? this.webhookDeliveryFailure : null;
    const failures = [this.receiveFailure ?? undefined, delivery ?? undefined, this.processing.lastError].filter((entry): entry is string => Boolean(entry));
    if (failures.length === 0) return this.currentStatus;
    const base = delivery !== null && this.currentStatus.kind === 'receiving' ? { ...this.currentStatus, kind: 'blocked' as const, reason: delivery } : this.currentStatus;
    return { ...base, lastError: failures.join('; ') };
  }

  /**
   * Whether the bot token resolves differently from the one the latest start
   * used. Lets a secret-store write restart ingress only when it is this
   * bot's credential that changed.
   */
  async botTokenChangedSinceStart(): Promise<boolean> {
    const token = await this.resolveBotToken();
    return token !== (this.startedToken ?? '');
  }

  /**
   * The numeric id of the bot the latest start() resolved a token for, read
   * from the token itself, or null when no usable token was resolved. Known
   * before getMe answers, and whether or not it ever does.
   */
  get servingBotId(): string | null {
    const id = this.startedToken?.split(':')[0] ?? '';
    return /^[1-9]\d*$/.test(id) ? id : null;
  }

  /** The resolved bot identity, or null when getMe has not succeeded yet. */
  get identity(): TelegramBotIdentity | null {
    return this.botIdentity;
  }

  /**
   * Arm exactly one ingress path. Safe to call repeatedly: an already-running
   * supervisor is stopped first, so a config change re-decides cleanly rather
   * than layering a second loop on top of the first.
   */
  async start(): Promise<TelegramIngressStatus> {
    const stopping = this.stop();
    const generation = this.generation;
    await stopping;
    if (generation !== this.generation) return this.status;
    this.watchSourceCredentials();
    const credentialRevision = this.credentialRevision;
    const credentialSnapshot = this.sourceCredentialSnapshot();

    const config = this.deps.configManager;
    const enabled = Boolean(config.get('surfaces.telegram.enabled'));
    const token = await this.resolveBotToken();
    if (generation !== this.generation) return this.status;
    this.startedToken = token;

    if (!enabled) {
      // Retraction is setup work too: a later stop/start must abort and drain
      // this exact original provider request before registering a replacement.
      if (!token) return this.settle('inactive', 'the Telegram surface is disabled (surfaces.telegram.enabled=false)');
      const lifetime = new AbortController(); this.abort = lifetime;
      const owned = () => generation === this.generation && this.abort === lifetime && !lifetime.signal.aborted;
      const setup = Promise.resolve().then(async () => {
        if (!owned()) return this.status;
        await this.retractOwnWebhook(token, lifetime.signal, owned);
        if (!owned()) return this.status;
        // A configured token with the surface off is a common unfinished setup.
        return this.settle('inactive',
          'a Telegram bot token is configured but surfaces.telegram.enabled is false; set it to true to receive messages',
          false, 'warn');
      });
      // Publish before provider code can reenter stop, as in webhook setup.
      this.webhookSetup = setup;
      try { return await setup; }
      finally {
        if (this.webhookSetup === setup) this.webhookSetup = null;
        if (this.abort === lifetime) this.abort = null;
      }
    }
    if (!token) {
      return this.settle('inactive',
        'the Telegram surface is enabled but no bot token resolved; set surfaces.telegram.botToken '
        + '(a goodvibes://secrets/... reference is fine) or the TELEGRAM_BOT_TOKEN environment variable');
    }

    const mode = String(config.get('surfaces.telegram.mode') ?? 'webhook');
    const api = this.deps.createApi?.(token) ?? new TelegramBotApi(token);
    const migration = new TelegramCursorMigration({ filePath: this.deps.offsetFilePath, beforeWrite: this.beforeCursorWrite,
      identity: async owner => {
        const incarnation = typeof config.getConfigurationIncarnation === 'function' ? config.getConfigurationIncarnation() : undefined;
        const current = () => {
          owner.assertCurrent();
          if (generation !== this.generation || this.stopped || !config.get('surfaces.telegram.enabled')
            || config.get('surfaces.telegram.mode') !== 'polling' || this.credentialRevision !== credentialRevision
            || !this.sourceCredentialsUnchanged(credentialSnapshot, token)
            || incarnation !== (typeof config.getConfigurationIncarnation === 'function' ? config.getConfigurationIncarnation() : undefined)) {
            throw new TelegramOffsetStoreError('unavailable');
          }
        };
        current(); const identity = await api.getVerifiedIdentity(owner.signal); current();
        if (!identity) throw new TelegramOffsetStoreError('unavailable');
        return Object.freeze({ id: identity.id, username: identity.username, assertCurrent: current });
      },
    });
    this.cursorMigration = migration; this.cursorMigrations.add(migration);
    // Before resolveBotIdentity records this bot as the discovered one.
    this.earlierCursorHeld = bindEarlierTelegramCursor(this.deps.offsetFilePath,
      String(config.get('surfaces.telegram.discoveredBotTokenId') ?? ''), this.beforeCursorWrite) === 'held';

    // Learn who this bot is before arming ingress, so the very first message is
    // matched against a real handle rather than an empty string.
    await this.resolveBotIdentity(api, () => generation === this.generation);
    if (generation !== this.generation) return this.status;

    if (mode === 'polling') return this.startPolling(api, token, generation, credentialRevision, credentialSnapshot);
    if (mode === 'webhook') return this.startWebhook(api, token, generation, credentialRevision, credentialSnapshot);
    return this.settle('inactive', `surfaces.telegram.mode is "${mode}", which is not a supported ingress mode`);
  }

  /**
   * Terminate the poll loop promptly and drop any in-flight long-poll.
   *
   * The AbortController is released only AFTER the loop has settled. Clearing
   * it first would strand a loop that was mid-await when stop() ran: its next
   * backoff would find no signal to listen on and sleep the full interval,
   * holding shutdown for up to a minute.
   */
  async stop(): Promise<void> {
    const generation = ++this.generation;
    this.cursorMigration = undefined;
    const retiringMigrations = [...this.cursorMigrations];
    const migrationClose = Promise.allSettled(retiringMigrations.map(async owner => { await owner.close(); this.cursorMigrations.delete(owner); }))
      .then(results => { if (results.some(result => result.status === 'rejected')) throw new Error('Telegram cursor recovery did not retire cleanly'); });
    this.deps.telegramSourceAccounts?.invalidate();
    this.credentialUnsubscribe?.();
    this.credentialUnsubscribe = null;
    this.stopped = true;
    const abort = this.abort;
    abort?.abort();
    const loop = this.loop;
    this.loop = null;
    if (loop) {
      this.retiringLoops.add(loop);
      const retired = () => { this.retiringLoops.delete(loop); };
      void loop.then(retired, retired);
    }
    const retiringLoops = [...this.retiringLoops];
    const webhookSetup = this.webhookSetup, pollingSetup = this.pollingSetup;
    // A second stop/start must join work already retired by the first stop.
    // Clearing the active pointer does not release the original queue lease.
    await Promise.allSettled(retiringLoops);
    if (webhookSetup) await webhookSetup.catch(() => { /* setup reports its own failures */ });
    if (pollingSetup) await pollingSetup.catch(() => { /* setup reports its own failures */ });
    await migrationClose;
    if (this.abort === abort) this.abort = null;
    // A stopped supervisor is not in polling or webhook mode any more. Leaving
    // the old mode made a stopped webhook read healthy and a stopped poller
    // read as a loop that died. An inactive reason already names its cause.
    if (generation === this.generation && this.currentStatus.mode !== 'inactive') {
      this.setStatus('stopped', 'inactive', 'Telegram ingress is stopped on this node');
    }
  }

  previewCursorMigration(): Promise<TelegramCursorPreview> {
    return this.cursorMigration?.preview() ?? Promise.reject(new TelegramOffsetStoreError('unavailable'));
  }

  async commitCursorMigration(input: { readonly previewId: string; readonly confirm: true }): Promise<TelegramCursorMigrationResult> {
    const owner = this.cursorMigration, generation = this.generation;
    if (!owner) throw new TelegramOffsetStoreError('unavailable');
    const result = await owner.commit(input);
    // The write may be complete when shutdown wins the next microtask. Never
    // restart a retired serving owner or call the saved write a failure.
    let running = false;
    if (this.cursorMigration === owner && generation === this.generation) {
      try { const status = await this.start(); running = status.mode === 'polling' && status.running; }
      catch { /* Saved migration stands; channel status can be inspected. */ }
    }
    return Object.freeze({ state: 'migrated', ...result, running,
      message: running ? 'The saved cursor is bound to this bot and polling has restarted.'
        : 'The saved cursor is bound to this bot. Check channel status before restarting polling.' });
  }

  // ── mode setup ────────────────────────────────────────────────────────────

  private async startWebhook(
    api: TelegramBotApi,
    token: string,
    generation: number,
    credentialRevision: number,
    credentialSnapshot: string | null,
  ): Promise<TelegramIngressStatus> {
    const base = String(this.deps.configManager.get('web.publicBaseUrl') ?? '');
    const problem = describeWebhookUrlProblem(base);
    if (problem) {
      return this.settle('inactive',
        `Telegram webhook mode cannot start: ${problem}. `
        + 'Either publish the daemon at a public HTTPS URL, or set surfaces.telegram.mode=polling '
        + 'to receive messages without one.');
    }

    if (generation !== this.generation) return this.status;
    this.stopped = false;
    const lifetime = new AbortController();
    this.abort = lifetime;
    const sourceOwner = this.deps.telegramSourceAccounts;
    const attachWebhook = sourceOwner?.attachWebhook?.bind(sourceOwner);
    const live = (): boolean => generation === this.generation && !this.stopped
      && this.abort === lifetime && !lifetime.signal.aborted
      && Boolean(this.deps.configManager.get('surfaces.telegram.enabled'))
      && this.deps.configManager.get('surfaces.telegram.mode') === 'webhook'
      && String(this.deps.configManager.get('web.publicBaseUrl') ?? '') === base;
    const currentCredentials = (): boolean => live() && this.credentialUnsubscribe !== null
      && this.credentialRevision === credentialRevision
      && this.sourceCredentialsUnchanged(credentialSnapshot, token);
    // External credential resolvers without a local currentness fence retain
    // configured-secret ingress, but cannot lend native payment authority.
    const managed = attachWebhook !== undefined && typeof sourceOwner?.authorizeWebhook === 'function'
      && currentCredentials();
    const url = `${base.replace(/\/+$/, '')}${TELEGRAM_WEBHOOK_PATH}`;
    const register = async (attempt: number): Promise<TelegramIngressStatus> => {
      // Each acknowledged native registration gets its own private credential.
      // Keep configured shared-secret ingress for embedders, without native proof.
      let secret: string;
      try {
        secret = managed ? `gvtw_${randomBytes(24).toString('base64url')}` : await this.resolveWebhookSecret();
        if (!live()) { lifetime.abort(); return this.status; }
        if (managed && !currentCredentials()) {
          lifetime.abort();
          return this.settle('inactive', 'Telegram credentials changed during webhook setup; run the Telegram start account action to set it up with the current credentials');
        }
        if (!managed && !secret) {
          // Without a secret the webhook route answers 503 to every update, so
          // registering would report "receiving" while every message is refused.
          lifetime.abort();
          return this.settle('inactive', 'Telegram webhook mode needs a secret to verify inbound updates: set surfaces.telegram.webhookSecret, '
            + 'or set surfaces.telegram.mode=polling to receive messages without a public URL.');
        }
        // Registering webhook delivery gives up native polling custody. Save
        // that gap before the provider can route original updates elsewhere.
        const store = new TelegramOffsetStore(this.deps.offsetFilePath, api.botId, this.beforeCursorWrite, this.beforeReceiveSpanWrite);
        if (store.load().mode !== 'blocked') {
          const cursor = store.retainPolling();
          try {
            const spans = cursor.receiveSpans();
            if (spans.length) cursor.replaceReceiveSpans(spans.map(span => ({ ...span, invalid: true })), () => {
              if (!currentCredentials()) throw new Error('Telegram registration owner changed');
            });
          } finally { cursor.release(); }
        }
        await api.setWebhook(url, secret || undefined, lifetime.signal);
        if (!live()) { lifetime.abort(); return this.status; }
        if (managed && !currentCredentials()) {
          lifetime.abort();
          return this.settle('inactive', 'Telegram credentials changed during webhook setup; run the Telegram start account action to set it up with the current credentials');
        }
        if (managed && attachWebhook) attachWebhook({
          secret,
          lifetime: lifetime.signal,
          readIdentity: signal => api.getVerifiedIdentity(signal),
          isCurrentSync: currentCredentials,
          isCurrent: async () => {
            if (!currentCredentials()) return false;
            const currentToken = await this.resolveBotToken();
            return currentCredentials() && currentToken === token;
          },
        });
      } catch (error) {
        const wasLive = live();
        if (!wasLive) { lifetime.abort(); return this.status; }
        // Provider text may echo the private registration credential, so the
        // reasons below name the failure class and never quote the provider.
        if (error instanceof TelegramApiError && error.isUnauthorized) {
          lifetime.abort();
          // A token rotated in a password manager is read afresh by the next start, send and retest.
          channelCredentials.release();
          return this.settle('inactive', 'Telegram webhook registration failed: the bot token was rejected. '
            + 'Check surfaces.telegram.botToken; retrying cannot fix a revoked or mistyped token.');
        }
        // Everything else is retried on the capped backoff while the surface
        // stays enabled in webhook mode: the network or tunnel not up yet,
        // Telegram unable to resolve the public host, a cursor that would not save.
        // A settings change restarts setup at once.
        const delayMs = Math.min(BACKOFF_MIN_MS * 2 ** Math.min(attempt - 1, 16), BACKOFF_MAX_MS);
        // A cursor that would not save is not a connectivity problem; say what it is.
        const cause = error instanceof TelegramOffsetStoreError
          ? error.message
          : 'check that web.publicBaseUrl reaches this daemon over HTTPS';
        const failure = `Telegram webhook registration failed (attempt ${attempt}); retrying in ${Math.ceil(delayMs / 1_000)}s: ${cause}`;
        logger.error('Telegram is enabled but is NOT receiving messages', { surface: 'telegram', action: failure });
        this.setStatus('retrying', 'webhook', failure, false, failure);
        this.retryWebhookRegistration(lifetime, delayMs, () => register(attempt + 1));
        return this.currentStatus;
      }
      if (!secret) {
        logger.warn('Telegram ingress: webhook registered without a secret token', {
          detail: 'set surfaces.telegram.webhookSecret so inbound callbacks can be verified',
        });
      }
      this.watchWebhookDelivery(api, url, lifetime);
      return this.settle('webhook', `Telegram updates will be delivered to ${url}`, false);
    };
    // Publish setup ownership before injected provider/resolver code can run.
    const setup = Promise.resolve().then(() => register(1));
    this.webhookSetup = setup;
    try {
      return await setup;
    } finally {
      if (this.webhookSetup === setup) this.webhookSetup = null;
    }
  }

  /**
   * Run a webhook registration again after `delayMs`, as owned setup work so
   * stop() aborts the wait and joins the attempt, never racing it.
   */
  private retryWebhookRegistration(lifetime: AbortController, delayMs: number, attempt: () => Promise<TelegramIngressStatus>): void {
    if (lifetime.signal.aborted) return;
    const onAbort = (): void => { clearTimeout(timer); };
    const timer = setTimeout(() => {
      lifetime.signal.removeEventListener('abort', onAbort);
      if (lifetime.signal.aborted || this.abort !== lifetime) return;
      const retry = Promise.resolve().then(attempt);
      this.webhookSetup = retry;
      const release = (): void => { if (this.webhookSetup === retry) this.webhookSetup = null; };
      void retry.then(release, release);
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    lifetime.signal.addEventListener('abort', onAbort, { once: true });
  }

  /**
   * "Registered" is not "delivered": Telegram keeps the evidence of whether its
   * deliveries arrive (the updates it is holding and its last delivery error),
   * so an armed webhook asks for it on the health sweep's period. A new error,
   * a growing queue or a different registered address shows the surface
   * degraded with Telegram's own reason, which raises the dead-channel alert;
   * the next clean reading clears it. One provider call per period, none per
   * message; the timer ends with the registration's lifetime.
   */
  private watchWebhookDelivery(api: TelegramBotApi, url: string, lifetime: AbortController): void {
    this.webhookDeliveryFailure = null;
    let since = Math.floor((this.deps.now?.() ?? Date.now()) / 1_000);
    let lastPending: number | null = null;
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking || lifetime.signal.aborted) return;
      checking = true;
      try {
        const info = await api.getWebhookInfo(lifetime.signal);
        if (lifetime.signal.aborted || this.abort !== lifetime) return;
        const problems: string[] = [];
        if (info.url !== url) problems.push(info.url ? `Telegram now delivers to a different address (${info.url})` : 'Telegram has no webhook registered for this bot');
        if (info.lastErrorDate !== undefined && info.lastErrorDate >= since) {
          problems.push(`Telegram reports its last delivery failed: ${info.lastErrorMessage ?? 'no reason given'}`);
        }
        if (lastPending !== null && info.pendingUpdateCount > lastPending) {
          problems.push(`${info.pendingUpdateCount} updates are waiting at Telegram`);
        }
        lastPending = info.pendingUpdateCount;
        since = Math.floor((this.deps.now?.() ?? Date.now()) / 1_000);
        const failure = problems.length > 0
          ? `Telegram cannot deliver to ${url}: ${problems.join('; ')}. Check that web.publicBaseUrl reaches this daemon over HTTPS.`
          : null;
        if (failure !== this.webhookDeliveryFailure) {
          if (failure) logger.error('Telegram is enabled but is NOT receiving messages', { surface: 'telegram', action: failure });
          else logger.info('Telegram ingress: webhook deliveries are arriving again', { surface: 'telegram' });
          this.webhookDeliveryFailure = failure;
        }
      } catch (error) {
        if (!lifetime.signal.aborted) {
          logger.warn('Telegram ingress: could not read webhook delivery status', { surface: 'telegram', error: summarizeError(error) });
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => { void check(); }, WEBHOOK_DELIVERY_CHECK_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    lifetime.signal.addEventListener('abort', () => { clearInterval(timer); }, { once: true });
  }

  private async startPolling(
    api: TelegramBotApi,
    token: string,
    generation: number,
    credentialRevision: number,
    credentialSnapshot: string | null,
  ): Promise<TelegramIngressStatus> {
    if (generation !== this.generation) return this.status;
    this.stopped = false;
    const lifetime = new AbortController(); this.abort = lifetime;
    // Publish ownership before provider code, including an injected transport,
    // can reenter stop. A replacement joins the original setup's actual work.
    const setup = Promise.resolve().then(() => this.startPollingSetup(api, token, generation, credentialRevision, credentialSnapshot, lifetime));
    this.pollingSetup = setup;
    try { return await setup; }
    finally { if (this.pollingSetup === setup) this.pollingSetup = null; }
  }

  private async startPollingSetup(
    api: TelegramBotApi, token: string, generation: number, credentialRevision: number,
    credentialSnapshot: string | null, lifetime: AbortController,
  ): Promise<TelegramIngressStatus> {
    const owned = () => generation === this.generation && !this.stopped && this.abort === lifetime && !lifetime.signal.aborted;
    if (!owned()) return this.status;
    // Deleting first is what makes the two modes mutually exclusive: leaving a
    // stale webhook registered would make every getUpdates return 409.
    let priorWebhook = true;
    try {
      const info = await api.getWebhookInfo(lifetime.signal);
      priorWebhook = info.url.length > 0;
    } catch { /* Unknown earlier receiving custody cannot certify old silence. */ }
    if (!owned()) return this.status;
    try {
      await api.deleteWebhook(false, lifetime.signal);
    } catch (error) {
      if (!owned()) return this.status;
      logger.warn('Telegram ingress: could not clear a registered webhook before polling', {
        error: summarizeError(error),
        detail: 'polling will report a conflict if one is still registered',
      });
    }
    if (!owned()) return this.status;
    const live = (): boolean => generation === this.generation && !this.stopped
      && this.abort === lifetime && !lifetime.signal.aborted
      && Boolean(this.deps.configManager.get('surfaces.telegram.enabled'))
      && this.deps.configManager.get('surfaces.telegram.mode') === 'polling';
    const attachSource = (cursor: TelegramPollingCursor, receiveProgress: TelegramPollingReceiveProgress) => this.deps.telegramSourceAccounts?.attach({
      receiveProgress,
      lifetime: lifetime.signal,
      readIdentity: (signal) => api.getVerifiedIdentity(signal),
      isCurrentSync: () => {
        cursor.assertCurrent();
        return live() && this.credentialUnsubscribe !== null && this.credentialRevision === credentialRevision
          && this.sourceCredentialsUnchanged(credentialSnapshot, token);
      },
      isCurrent: async () => {
        cursor.assertCurrent();
        if (!live()) return false;
        const currentToken = await this.resolveBotToken();
        cursor.assertCurrent();
        return live() && currentToken === token;
      },
    });
    // Queue partition only, not proof of sender/payment authority. Actual
    // replies still acquire the original verified native account capability.
    let store: TelegramOffsetStore;
    try { store = new TelegramOffsetStore(this.deps.offsetFilePath, api.botId, this.beforeCursorWrite, this.beforeReceiveSpanWrite); }
    catch {
      lifetime.abort();
      return this.settle('inactive', 'The Telegram bot identity cannot select a saved cursor. Check its bot token, then run the Telegram start account action.');
    }
    const start = store.load();
    const createStore = (): TelegramOffsetStore => new TelegramOffsetStore(this.deps.offsetFilePath, api.botId, this.beforeCursorWrite, this.beforeReceiveSpanWrite);
    // Reserve the runner before any dependency can synchronously reenter stop.
    this.loop = this.runOwnedPolling(api, store, createStore, lifetime.signal, attachSource, priorWebhook)
      .finally(() => { lifetime.abort(); });
    if (start.mode === 'blocked') {
      // An earlier-version cursor waiting for review; the loop polls once it is bound.
      this.markBlocked(start.reason);
      return this.currentStatus;
    }
    return this.settle('polling',
      `long-polling Telegram getUpdates for bot ${api.botId} (no public URL required)`, true);
  }

  // ── the poll loop ─────────────────────────────────────────────────────────

  /**
   * Own one receiving session for this bot, and keep owning it. Only a rejected
   * token ends receiving (runPollLoop settles that, and a token change restarts
   * it). Every other failure, a receive span that would not save, a payment
   * reply that could not be archived, a malformed batch, resumes on the backoff
   * with the reason in the status, the same way a 409 recovers. The store is
   * kept across those retries: its offsets are the last ones processed. Only an
   * earlier-version cursor waiting for review is read again from disk, on the
   * backoff, so a review done elsewhere is picked up.
   */
  private async runOwnedPolling(api: TelegramBotApi, initialStore: TelegramOffsetStore, createStore: () => TelegramOffsetStore,
    lifetime: AbortSignal,
    attach: (cursor: TelegramPollingCursor, progress: TelegramPollingReceiveProgress) => TelegramSourceAccountLease | undefined,
    priorWebhook = false): Promise<void> {
    await Promise.resolve();
    let store = initialStore;
    let gap = priorWebhook;
    let backoffMs = BACKOFF_MIN_MS;
    const owned = (): boolean => !this.stopped && !lifetime.aborted && this.abort?.signal === lifetime;
    while (owned()) {
      let cursor: TelegramPollingCursor;
      try { cursor = store.retainPolling(); }
      catch (error) {
        if (error instanceof TelegramOffsetStoreError && error.kind === 'unbound') {
          this.markBlocked(error.message);
          await this.delay(backoffMs);
        } else {
          await this.retryReceiving(error, backoffMs);
        }
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        store = createStore();
        continue;
      }
      const pollsBefore = this.completedPolls;
      let failure: unknown = null;
      try {
        lifetime.throwIfAborted();
        if (!owned()) return;
        const progress = new TelegramPollingReceiveProgress(lifetime, this.deps.now ?? Date.now, cursor);
        // Receive coverage is unknown across a webhook period or a failed poll loop.
        if (gap) progress.gap();
        const source = attach(cursor, progress);
        await this.runPollLoop(api, cursor, lifetime, source, progress);
      } catch (error) {
        failure = error;
      } finally {
        // Even an injected getUpdates that ignores abort finishes before the
        // next session takes the cursor.
        cursor.release();
      }
      // runPollLoop returns on its own only when stopped or the token was rejected.
      if (!owned() || failure === null) return;
      if (this.completedPolls > pollsBefore) backoffMs = BACKOFF_MIN_MS;
      await this.retryReceiving(failure, backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      gap = true;
    }
  }

  /** Say why receiving is not working and when it resumes, then wait that long. */
  private async retryReceiving(error: unknown, delayMs: number): Promise<void> {
    if (this.stopped) return;
    const detail = error instanceof Error && error.message ? error.message : summarizeError(error);
    const failure = `Telegram receiving failed and resumes in ${Math.ceil(delayMs / 1_000)}s: ${detail}`;
    logger.error('Telegram is enabled but is NOT receiving messages', { surface: 'telegram', action: failure });
    this.setStatus('retrying', 'polling', failure, true, failure);
    await this.delay(delayMs);
  }

  private async runPollLoop(
    api: TelegramBotApi,
    cursor: TelegramPollingCursor,
    lifetime: AbortSignal,
    sourceAccount?: TelegramSourceAccountLease,
    receiveProgress?: TelegramPollingReceiveProgress,
  ): Promise<void> {
    let backoffMs = BACKOFF_MIN_MS;
    let conflictRecoveries = 0;
    let failedPolls = 0;

    while (!this.stopped && !lifetime.aborted) {
      try {
        const offset = cursor.capture().observation.offset ?? undefined;
        const startedAtMs = receiveProgress?.beginRequest();
        const updates = await api.getUpdates({
          offset,
          timeoutSeconds: receiveProgress?.timeoutSeconds(POLL_TIMEOUT_SECONDS) ?? POLL_TIMEOUT_SECONDS,
          signal: lifetime,
        });
        lifetime.throwIfAborted(); cursor.assertCurrent();
        this.completedPolls += 1;
        backoffMs = BACKOFF_MIN_MS;
        conflictRecoveries = 0;
        failedPolls = 0;
        // A poll that came back is the only proof the surface recovered, so it
        // is the only thing that clears a blocked status. Recovery is
        // announced, because an operator who was told this surface was dead is
        // owed the other half of that sentence.
        if (this.receiveFailure !== null) {
          logger.info('Telegram ingress: polling recovered and is receiving messages again', {
            surface: 'telegram',
            previous: this.receiveFailure,
          });
          this.setStatus('receiving', 'polling',
            `long-polling Telegram getUpdates for bot ${api.botId} (no public URL required)`, true);
        }
        if (updates.length > 0) {
          // Each update's offset is saved as soon as it is processed, so a
          // restart part-way through a batch never replays the updates already
          // handled (a "yes" to a proposal, a purchase answer): one small
          // document write per processed update.
          const persist = (next: number): void => {
            cursor.save(next, () => {
              lifetime.throwIfAborted();
              if (this.stopped || this.abort?.signal !== lifetime) throw new Error('Telegram polling owner retired');
            });
          };
          await this.dispatchBatch(updates, api, persist, offset, sourceAccount, receiveProgress);
        }
        cursor.assertCurrent();
        this.deps.telegramSourceAccounts?.prunePaymentReceiveSpans?.();
        if (startedAtMs !== undefined) receiveProgress?.completeRequest(startedAtMs, updates.length === 0);
      } catch (error) {
        if (this.stopped || lifetime.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        // A receive span that would not save, the payment reply archive or the
        // receive record could not be trusted: nothing past it is confirmed.
        // The owner marks a receive gap and resumes (runOwnedPolling).
        if (error instanceof TelegramOffsetStoreError || error instanceof PaymentReplyHistoryError
          || error instanceof TelegramUpdateResponseError || error instanceof TelegramReceiveCoverageError) throw error;
        if (error instanceof TelegramApiError && error.errorCode === 409) receiveProgress?.gap();

        const terminal = await this.handlePollError(error, api, () => {
          conflictRecoveries += 1;
          return conflictRecoveries;
        }, lifetime);
        if (this.stopped || lifetime.aborted) return;
        if (terminal) {
          this.setStatus('inactive', 'inactive', terminal);
          return;
        }
        failedPolls += 1;
        if (failedPolls >= RECEIVE_FAILURES_BEFORE_DEGRADED && this.receiveFailure === null) {
          const failure = `Telegram polling has failed ${failedPolls} times in a row and is retrying; `
            + `no messages are being received (${summarizeError(error)})`;
          this.setStatus('retrying', 'polling', this.currentStatus.reason, true, failure);
          logger.error('Telegram is enabled but is NOT receiving messages', { surface: 'telegram', action: failure });
        }
        const dictated = error instanceof TelegramApiError && error.retryAfterSeconds !== null
          ? error.retryAfterSeconds * 1_000
          : null;
        // Jitter, so two consumers of the same token do not settle into
        // lockstep and spend the rest of the day terminating each other's long
        // poll at the same instant. Only ever adds delay, never removes it.
        const jitter = error instanceof TelegramApiError && error.errorCode === 409
          ? Math.floor(this.conflictJitterFraction() * CONFLICT_JITTER_MS)
          : 0;
        await this.delay((dictated ?? backoffMs) + jitter);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }

  /**
   * Classify a poll failure. Returns a terminal reason when retrying cannot
   * possibly help, a revoked token or a webhook that will not clear, so the
   * loop stops with an actionable message instead of backing off forever
   * against something only the operator can fix.
   */
  private async handlePollError(
    error: unknown,
    api: TelegramBotApi,
    countConflict: () => number,
    lifetime: AbortSignal,
  ): Promise<string | null> {
    if (error instanceof TelegramApiError && error.errorCode === 409) {
      await this.handleConflict(error, api, countConflict(), lifetime);
      // NEVER terminal. See handleConflict.
      return null;
    }

    if (error instanceof TelegramApiError && error.isUnauthorized) {
      // A token rotated in a password manager is read afresh by the next start, send and retest.
      channelCredentials.release();
      const reason = 'Telegram polling stopped: the bot token was rejected '
        + `(${error.message}). Check surfaces.telegram.botToken, a revoked or mistyped token `
        + 'cannot be recovered by retrying.';
      logger.error('Telegram ingress: bot token rejected', { detail: reason });
      return reason;
    }

    logger.warn('Telegram ingress: poll failed; backing off', { error: summarizeError(error) });
    return null;
  }

  /**
   * A 409 Conflict, handled so that it can never end the loop.
   *
   * ── What went wrong before ────────────────────────────────────────────────
   *
   * A 409 was terminal down both of its branches, and inbound Telegram went
   * permanently dead on a live machine because of it: polling stopped at
   * 12:24 and stayed stopped until a human restarted the daemon, with every
   * message in between unread and nothing but a log line to say so.
   *
   * Worse, it died down the WRONG branch. Telegram uses 409 for two unrelated
   * situations, a registered webhook, and another process long-polling the
   * same token, and they were told apart by matching the error description
   * against "terminated by other getUpdates". Anything that did not match that
   * string fell through to the webhook branch, because `isWebhookConflict` was
   * defined as "409 and not concurrent". So webhook was the DEFAULT for every
   * 409 whose description was missing, reworded, or replaced by an
   * intermediary's own error body. A string that has to be exhaustive to be
   * safe is not a classification, it is a guess.
   *
   * The evidence on that machine settles which case it actually was: no
   * webhook was ever registered (`getWebhookInfo` reported none, and the logs
   * contain no `setWebhook` call), and deleteWebhook was called three times
   * without the 409 ever clearing. A 409 that survives a successful
   * deleteWebhook is, by construction, not a webhook conflict.
   *
   * ── What it does now ──────────────────────────────────────────────────────
   *
   * The cause is ESTABLISHED rather than guessed: `getWebhookInfo` is the
   * authority, because it answers the actual question. The description is used
   * only to enrich the message a person reads.
   *
   * And neither cause is fatal:
   *
   *  - **A webhook really is registered.** Clear it and retry. If repeated
   *    clears do not take, that is operator-actionable, so it is escalated to
   *    an error that names the fix, and the loop KEEPS RETRYING on the backoff.
   *    A registered webhook can be removed by a person at any moment, and when
   *    it is, polling must resume by itself.
   *
   *  - **Another consumer holds the token.** Report it, so a cluster
   *    coordinator can stand this node down and re-run its election, then back
   *    off and keep retrying. The other consumer is frequently transient, a
   *    test daemon, a second checkout, a stale process, and standing down
   *    forever means the owner's messages are lost until somebody notices.
   *    With `cluster.enabled` off there is no election to stand down TO, which
   *    is exactly how the live failure became permanent.
   *
   * Retrying is bounded and jittered rather than tight, so two consumers do
   * not spin terminating each other's long poll.
   */
  private async handleConflict(
    error: TelegramApiError,
    api: TelegramBotApi,
    attempt: number,
    lifetime: AbortSignal,
  ): Promise<void> {
    // Both provider calls below ride the loop's lifetime: stop() must not wait
    // on them, and an answer that lands after stop() must not report anything.
    const retired = (): boolean => this.stopped || lifetime.aborted;
    const webhookUrl = await this.registeredWebhookUrl(api, lifetime);
    if (retired()) return;
    const action = classifyTelegramConflict({
      description: error.description || `HTTP ${String(error.errorCode)}`,
      webhookUrl,
      clustered: Boolean(this.deps.configManager.get('cluster.enabled')),
      attempt,
    });

    if (action.kind === 'clear-webhook') {
      try {
        await api.deleteWebhook(false, lifetime);
      } catch (deleteError) {
        if (retired()) return;
        logger.warn('Telegram ingress: deleteWebhook failed while clearing a conflict', {
          surface: 'telegram',
          error: summarizeError(deleteError),
        });
      }
      if (retired()) return;
      if (action.escalate && action.reason !== null) {
        this.markBlocked(action.reason);
      } else {
        logger.warn('Telegram ingress: a webhook may be registered, so polling is blocked (409)', {
          surface: 'telegram',
          attempt,
          webhookUrl: action.webhookUrl ?? '(none reported by getWebhookInfo)',
          action: 'removing the webhook and retrying',
        });
      }
      return;
    }

    if (action.escalate) {
      this.markBlocked(action.reason);
    } else {
      logger.warn('Telegram ingress: another consumer holds this bot token', {
        surface: 'telegram',
        attempt,
        detail: action.reason,
      });
    }
    // Told on every occurrence: a coordinator that wants to stand this node
    // down can, and one that is not running simply has no listener.
    this.deps.onConcurrentConsumerConflict?.(action.reason);
  }

  /**
   * Ask Telegram whether a webhook is actually registered.
   *
   * This is the authority for classifying a 409, replacing a regex over an
   * error description that only worked when the description said what we
   * expected. A failure to answer is reported as "no webhook": the alternative
   * default sent every unclassifiable conflict down the webhook path, which is
   * the branch that used to give up.
   */
  private async registeredWebhookUrl(api: TelegramBotApi, signal: AbortSignal): Promise<string | null> {
    try {
      const info = await api.getWebhookInfo(signal);
      const url = typeof info.url === 'string' ? info.url.trim() : '';
      return url.length > 0 ? url : null;
    } catch (error) {
      if (signal.aborted) return null;
      logger.warn('Telegram ingress: could not read webhook status while classifying a conflict', {
        surface: 'telegram',
        error: summarizeError(error),
        detail: 'treating the conflict as a competing consumer, which is the recoverable reading',
      });
      return null;
    }
  }

  /**
   * A surface that is up but not consuming has to say so where someone will
   * see it, not only in a log line nobody reads.
   *
   * `running` stays true on purpose: the loop is alive and still trying, and
   * reporting it as stopped would be the same lie in the other direction.
   * `reason` carries what is wrong and what to do about it, and the level is
   * `error` because an operator who switched this surface ON and is receiving
   * nothing has the most expensive failure in the system.
   */
  private markBlocked(reason: string): void {
    const full = `Telegram polling is blocked: ${reason}`;
    if (this.currentStatus.reason !== full) {
      logger.error('Telegram is enabled but is NOT receiving messages', {
        surface: 'telegram',
        action: full,
      });
    }
    // Running, but not receiving: health reads this as degraded, not healthy.
    this.setStatus('blocked', 'polling', full, true, full);
  }

  /**
   * The one place the ingress status changes, so what it is doing, whether it is
   * receiving, and why not, are written together and cannot drift apart.
   *
   * `failure` is why a running loop is not receiving; only `blocked` and
   * `retrying` carry one, and only a poll that comes back (`receiving`) clears
   * it. `running` stays true for those two on purpose: the loop is alive and
   * still trying.
   */
  private setStatus(
    kind: TelegramIngressKind,
    mode: TelegramIngressMode,
    reason: string,
    running = false,
    failure: string | null = null,
  ): void {
    this.currentStatus = { kind, mode, reason, running };
    this.receiveFailure = kind === 'blocked' || kind === 'retrying' ? failure : null;
  }

  /**
   * Hand each update to the SAME processor the webhook route uses, saving the
   * confirmation offset past each one as soon as its processing returned, so a
   * crash or stop mid-batch replays only the update that was in flight.
   *
   * An update's job ends when the session broker has accepted it: a message
   * that arrives while every agent is busy is queued there and started when
   * one ends, so the processor answers it as accepted. An update the processor
   * answered with a failure a second attempt can fix (or that threw) is handed
   * to it again, up to UPDATE_ATTEMPTS times with a short wait (its Retry-After
   * when given, capped at UPDATE_RETRY_MAX_MS); the provider message claim is
   * released on a failed start and the broker keeps the durable one, so a
   * second attempt never stores or starts the message twice. An update that
   * still fails is skipped, the owner sees it in the processing health, and
   * the sender is told nothing started.
   */
  private async dispatchBatch(
    updates: readonly TelegramUpdate[],
    api: TelegramBotApi,
    persist: (next: number) => void,
    current: number | undefined,
    sourceAccount?: TelegramSourceAccountLease,
    receiveProgress?: TelegramPollingReceiveProgress,
  ): Promise<void> {
    let offset = current;
    const context = this.deps.buildSurfaceAdapterContext();
    for (const update of updates) {
      if (this.stopped) break;
      const updateId = typeof update.update_id === 'number' ? update.update_id : null;
      const scope = telegramUpdateReceiveScope(update);
      const messageUpdate = ['message', 'edited_message', 'channel_post', 'edited_channel_post'].some(key => Object.hasOwn(update, key));
      if (messageUpdate && !scope) receiveProgress?.gap();
      let attempt = 0;
      let settled = false;
      while (!settled) {
        attempt += 1;
        const lastAttempt = attempt >= UPDATE_ATTEMPTS;
        try {
          const response = await processTelegramUpdate(update, context, {
            sendMessage: (input) => api.sendMessage(input),
            botId: api.botId,
            ...(sourceAccount ? { acquireSourceAccount: sourceAccount.acquire } : {}),
          });
          // The daemon is restarting into an update and could not keep this update (a delegated review): it is not
          // an attempt; the poller waits, and a stop leaves the offset before it so the next process fetches it again.
          if (isAdmissionRefusal(response) && updateId !== null) {
            attempt -= 1;
            await this.delay(WORK_ADMISSION_RECHECK_MS);
            if (this.stopped) return;
            continue;
          }
          const outcome = ingressOutcome(response);
          if (outcome === 'failed' && updateId !== null && !lastAttempt) {
            const dictated = Number(response.headers.get('retry-after'));
            await this.delay(Math.min(UPDATE_RETRY_MAX_MS, Number.isFinite(dictated) && dictated > 0 ? dictated * 1_000 : BACKOFF_MIN_MS * 2 ** (attempt - 1)));
          } else if (outcome === 'failed' && updateId !== null) {
            settled = true;
            receiveProgress?.gap(scope);
            this.processing.recordFailure(`Telegram update could not be processed after ${attempt} tries (HTTP ${response.status}) and was skipped`, { updateId });
            // The sender, who passed the channel policy to get this far, is told
            // why nothing started instead of hearing nothing.
            if (scope) await notifySkippedSender(api, scope, await skippedReason(response));
          } else {
            settled = true;
            if (!response.ok) receiveProgress?.gap(scope);
            if (outcome === 'processed') this.processing.recordSuccess();
            else if (outcome === 'failed') this.processing.recordFailure(`Telegram update could not be processed (HTTP ${response.status}) and was skipped`, { updateId });
          }
        } catch (error) {
          if (error instanceof PaymentReplyHistoryError) throw error;
          if (!lastAttempt && updateId !== null) {
            await this.delay(BACKOFF_MIN_MS * 2 ** (attempt - 1));
          } else {
            settled = true;
            receiveProgress?.gap(scope);
            // Still advance past it, a cursor wedged on one poison update
            // redelivers it forever. What is no longer true is that skipping is
            // quiet: IngressProcessingHealth degrades the surface and reaches the
            // owner, and the sender is told nothing started.
            this.processing.recordFailure(summarizeError(error), { updateId });
            if (scope) await notifySkippedSender(api, scope, 'it could not be processed');
          }
        }
        // A stop during the wait leaves the offset where it is, so the update is fetched again on the next start.
        if (!settled && this.stopped) return;
      }
      if (updateId !== null) {
        offset = Math.max(offset ?? 0, updateId + 1);
        persist(offset);
      }
    }
  }

  /**
   * Resolve the bot's own identity from its token and cache it in config.
   *
   * `surfaces.telegram.botUsername` being blank does NOT mean the bot has no
   * username, it means nobody typed one in. Telegram's getMe returns the
   * handle, id and display name for any valid token, so the daemon asks instead
   * of degrading: without a handle, @mentions in groups are not recognised,
   * `/goodvibes@thebot` is not stripped correctly, and `/start@someotherbot`
   * in a shared group is answered as if it were ours. (Route bindings do not
   * depend on the handle: they are keyed on the bot id from the token.)
   *
   * Rules:
   * - An explicitly configured username WINS for the bot it was set for. A
   *   discovered value never overwrites an operator's choice for that bot; it
   *   only fills a blank.
   * - The discovery is keyed to the token, so rotating to a different bot
   *   re-discovers and replaces the handle on file, which named the old bot,
   *   rather than serving a stale handle on every later start.
   * - A failure never blocks startup. Ingress still arms, receiving messages
   *   matters more than perfect mention matching, but it says at warn level
   *   exactly what will not work until the call succeeds, and the next start()
   *   retries.
   */
  private async resolveBotIdentity(api: TelegramBotApi, current: () => boolean): Promise<void> {
    const config = this.deps.configManager;
    const configured = String(config.get('surfaces.telegram.botUsername') ?? '').replace(/^@/, '').trim();
    const cachedFor = String(config.get('surfaces.telegram.discoveredBotTokenId') ?? '');
    if (configured && cachedFor === api.botId) {
      this.botIdentity = { id: api.botId, username: configured, displayName: '' };
      return;
    }
    if (configured && cachedFor !== api.botId && cachedFor !== '') {
      // The handle on file belongs to a different token. Re-discover rather
      // than run a new bot under the previous bot's identity.
      logger.info('Telegram ingress: bot token changed; re-resolving the bot identity', { botId: api.botId });
    } else if (configured) {
      // Operator-supplied and never discovered, honour it, but still record
      // which token it belongs to so a later rotation is detected.
      this.botIdentity = { id: api.botId, username: configured, displayName: '' };
      this.rememberDiscoveredToken(api.botId);
      return;
    }

    // The handle on file was recorded against a different bot, so it names
    // that bot; the new bot's own handle replaces it rather than living on.
    const staleDiscovery = configured !== '' && cachedFor !== '' && cachedFor !== api.botId;
    let identity: TelegramBotIdentity;
    try {
      identity = await api.getMe();
    } catch (error) {
      if (error instanceof TelegramApiError && error.isUnauthorized) channelCredentials.release();
      if (!current()) return;
      logger.warn('Telegram ingress: could not resolve the bot username from its token', {
        botId: api.botId,
        error: summarizeError(error),
        impact: '@mentions in groups will not be recognised, /goodvibes@botname will not be stripped, '
          + 'and a /start addressed to another bot in a shared group may be answered as if it were ours',
        detail: 'set surfaces.telegram.botUsername manually, or run the Telegram start account action to retry getMe',
      });
      return;
    }
    // A start that was replaced while getMe was in flight must not write the
    // identity of the token it was started with over the newer one.
    if (!current()) return;
    if (!identity.username) {
      logger.warn('Telegram ingress: getMe returned no username for this bot', { botId: identity.id });
      return;
    }
    this.botIdentity = identity;
    try {
      if (!configured || staleDiscovery) config.set('surfaces.telegram.botUsername', identity.username);
      this.rememberDiscoveredToken(identity.id);
      logger.info('Telegram ingress: resolved the bot identity from its token', {
        botId: identity.id,
        botUsername: identity.username,
        displayName: identity.displayName,
      });
    } catch (error) {
      // Discovery still succeeded in memory; only the cache write failed.
      logger.warn('Telegram ingress: could not persist the discovered bot username', {
        botUsername: identity.username,
        error: summarizeError(error),
      });
    }
  }

  private rememberDiscoveredToken(botId: string): void {
    if (this.earlierCursorHeld) return;
    try {
      this.deps.configManager.set('surfaces.telegram.discoveredBotTokenId', botId);
    } catch {
      // A host without this key in its schema simply re-discovers next start.
    }
  }

  /**
   * Remove a webhook THIS deployment registered, and only that one.
   *
   * Checked against the configured public base URL first, so disabling the
   * surface never silently tears down a webhook pointing somewhere else, the
   * same bot token may legitimately be driven by another deployment, and
   * deleting its registration would break a system we do not own.
   */
  private async retractOwnWebhook(token: string, signal: AbortSignal, owned: () => boolean): Promise<void> {
    const base = String(this.deps.configManager.get('web.publicBaseUrl') ?? '').replace(/\/+$/, '');
    if (!base || !owned()) return;
    const api = this.deps.createApi?.(token) ?? new TelegramBotApi(token);
    try {
      const info = await api.getWebhookInfo(signal);
      if (!owned() || !info.url || info.url !== `${base}${TELEGRAM_WEBHOOK_PATH}`) return;
      await api.deleteWebhook(false, signal);
      if (!owned()) return;
      logger.info('Telegram ingress: retracted the webhook for a disabled surface', { url: info.url });
    } catch (error) {
      if (!owned()) return;
      logger.warn('Telegram ingress: could not retract the webhook for a disabled surface', {
        error: summarizeError(error),
      });
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Owner-mediated writes revoke synchronously, before any await can resume. */
  private watchSourceCredentials(): void {
    if (!this.deps.telegramSourceAccounts || this.credentialUnsubscribe) return;
    if (typeof this.deps.secretsManager.onDidChange !== 'function') return;
    const descriptor = this.sourceCredentialSnapshot();
    const token = this.resolveSourceTokenSync();
    this.credentialUnsubscribe = this.deps.secretsManager.onDidChange(() => {
      // An unrelated API key in the same store must not strand this poller.
      if (this.sourceCredentialSnapshot() === descriptor && this.resolveSourceTokenSync() === token) return;
      this.credentialRevision++;
      this.deps.telegramSourceAccounts?.invalidate();
    });
  }

  /**
   * Whether the bot credential is still the one polling started with. The
   * answer is kept with the owners' revisions it was read under (settings
   * incarnation, credential store revision, one `stat` of the services
   * file) and read again only when one of them moved, so the check run on
   * every poll does not re-read services.json and the credential store.
   */
  private sourceCredentialsUnchanged(snapshot: string | null, token: string): boolean {
    if (snapshot === null) return false;
    const key = this.credentialRevisionsKey();
    const kept = this.credentialCheck;
    if (key !== null && kept !== null && kept.key === key && kept.snapshot === snapshot && kept.token === token) return kept.result;
    const result = this.sourceCredentialSnapshot() === snapshot && this.resolveSourceTokenSync() === token;
    this.credentialCheck = key === null ? null : { key, snapshot, token, result };
    return result;
  }

  /** Null when an owner has no revision: every check then reads afresh. */
  private credentialRevisionsKey(): string | null {
    const config = this.deps.configManager, secrets = this.deps.secretsManager;
    if (typeof config.getConfigurationIncarnation !== 'function' || !secrets.revisionSource) return null;
    const path = this.deps.serviceRegistry.userServicesFilePath;
    let services = 'absent';
    if (path) {
      try {
        const stat = statSync(path);
        services = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
    }
    return `${config.getConfigurationIncarnation()}:${secrets.revisionSource.revision()}:${services}`;
  }

  /**
   * Private owner state only, never returned, logged, hashed, or persisted.
   * Registry.get re-reads services.json synchronously, including external edits.
   * Actual effective local/env credential bytes are rechecked separately by
   * resolveSourceTokenSync; neither check lends those bytes to the reader.
   */
  private sourceCredentialSnapshot(): string | null {
    if (!this.deps.telegramSourceAccounts) return null;
    if (typeof this.deps.serviceRegistry.get !== 'function') return null;
    try {
      return JSON.stringify([
        this.deps.configManager.get('surfaces.telegram.botToken'),
        this.deps.serviceRegistry.get('telegram'),
      ]);
    } catch { return null; }
  }

  /**
   * Selected intake supports locally fenceable credentials only. External and
   * nested secret refs have no synchronous owner revision and must hold; legacy
   * ingress retains its existing general async resolver below.
   */
  private resolveSourceTokenSync(): string | null {
    type Resolution = ReturnType<SecretsManager['resolveLocalSecretSync']>;
    const literal = (value: unknown): Resolution => {
      if (value === undefined || value === null || value === '') return { state: 'absent' };
      return typeof value !== 'string' || isSecretRefInput(value) || looksLikeSecretRef(value)
        ? { state: 'unsupported' } : { state: 'resolved', value: Secret.of(value, 'telegram bot token') };
    };
    const local = (key: string): Resolution => typeof this.deps.secretsManager.resolveLocalSecretSync === 'function'
      ? this.deps.secretsManager.resolveLocalSecretSync(key) : { state: 'unsupported' };
    const reference = (value: unknown): Resolution => {
      const ref = normalizeSecretRef(value);
      if (ref?.source === 'env') return literal(process.env[ref.id]);
      if (ref?.source === 'goodvibes') return local(ref.id);
      return { state: 'unsupported' };
    };
    try {
      const registry = this.deps.serviceRegistry.get('telegram');
      if (registry) {
        const candidate = registry.tokenRef ?? (isSecretRefInput(registry.tokenKey) ? registry.tokenKey : undefined);
        const fromRegistry = candidate ? reference(candidate) : registry.tokenKey ? local(registry.tokenKey) : { state: 'absent' } as const;
        if (fromRegistry.state === 'unsupported') return null;
        if (fromRegistry.state === 'resolved' && !fromRegistry.value.empty) return fromRegistry.value.reveal('dispatch');
      }
      const configured = this.deps.configManager.get('surfaces.telegram.botToken');
      const configuredLiteral = typeof configured === 'string' ? configured.trim() : configured;
      const fromConfig = isSecretRefInput(configured) ? reference(configured) : literal(configuredLiteral);
      if (fromConfig.state === 'unsupported') return null;
      if (fromConfig.state === 'resolved' && !fromConfig.value.empty) return fromConfig.value.reveal('dispatch');
      const environment = literal(process.env.TELEGRAM_BOT_TOKEN);
      return environment.state === 'resolved' ? environment.value.reveal('dispatch') : null;
    } catch { return null; }
  }

  /**
   * The public numeric id of the bot this node can ACTUALLY read, or null when
   * no token resolves.
   *
   * Asked before the node is allowed to contest the Telegram surface in the
   * LAN election. Winning a surface with no token would starve the machine
   * that does have one: the loser stands down and the winner reads nothing.
   *
   * Only the id half of the token is returned, the secret half is never
   * returned, logged, or hashed.
   */
  async resolveServableBotId(): Promise<string | null> {
    const token = await this.resolveBotToken();
    if (!token) return null;
    const separator = token.indexOf(':');
    return separator === -1 ? token : token.slice(0, separator);
  }

  /**
   * Resolve the bot token through the secret-reference path, so config can hold
   * `goodvibes://secrets/...` rather than a literal token in a settings file.
   */
  private async resolveBotToken(): Promise<string> {
    const fromRegistry = await this.deps.serviceRegistry.resolveSecret('telegram', 'primary');
    if (fromRegistry) return fromRegistry;
    const fromConfig = await this.resolveConfigSecret(
      this.deps.configManager.get('surfaces.telegram.botToken'),
    );
    return fromConfig || process.env.TELEGRAM_BOT_TOKEN || '';
  }

  private async resolveWebhookSecret(): Promise<string> {
    const fromRegistry = await this.deps.serviceRegistry.resolveSecret('telegram', 'signingSecret');
    if (fromRegistry) return fromRegistry;
    const fromConfig = await this.resolveConfigSecret(
      this.deps.configManager.get('surfaces.telegram.webhookSecret'),
    );
    return fromConfig || process.env.TELEGRAM_WEBHOOK_SECRET || '';
  }

  private async resolveConfigSecret(value: unknown): Promise<string> {
    const resolved = await resolveSecretInput(value, {
      resolveLocalSecret: (key) => this.deps.secretsManager.get(key),
      homeDirectory: this.deps.secretsManager.getGlobalHome?.() ?? undefined,
    }, 'dispatch');
    return resolved ?? '';
  }

  /**
   * Sleep that wakes immediately on stop() rather than pinning shutdown.
   *
   * The abort listener is removed on the normal timeout path too: backoff can
   * run many times against one AbortController, and listeners that only unbind
   * when they fire would pile up on a long-lived signal.
   */
  private delay(ms: number): Promise<void> {
    // stop() may have landed while the caller was awaiting something else;
    // never begin a fresh backoff sleep for a loop that is already finished.
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = this.abort?.signal;
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private settle(
    mode: TelegramIngressMode,
    reason: string,
    running = false,
    severity?: 'warn',
  ): TelegramIngressStatus {
    // Polling setup alone proves nothing about receiving, so a failure carried
    // across a restart is cleared only by a poll that returns. Any other mode
    // replaces polling, and with it the polling failure.
    const carried = mode === 'polling' ? this.receiveFailure : null;
    this.setStatus(
      mode === 'inactive' ? 'inactive' : carried !== null ? 'retrying' : 'receiving',
      mode,
      reason,
      running,
      carried,
    );
    if (mode !== 'inactive') {
      logger.info('Telegram ingress active', { surface: 'telegram', mode, reason });
      return this.currentStatus;
    }
    if (severity === 'warn') {
      logger.warn('Telegram ingress is inactive', { surface: 'telegram', action: reason });
      return this.currentStatus;
    }
    // Never fail silently, and the level has to match what the operator
    // believes. An operator who switched the surface OFF and sees it inactive
    // has no problem; an operator who switched it ON and has an inert surface
    // has the most expensive failure in the system: the daemon looks healthy,
    // the config looks right, and messages vanish. Those are different events
    // and they get different levels.
    const enabled = Boolean(this.deps.configManager.get('surfaces.telegram.enabled'));
    if (enabled) {
      logger.error('Telegram is enabled but is NOT receiving messages', { surface: 'telegram', action: reason });
    } else {
      logger.info('Telegram ingress is inactive', { surface: 'telegram', reason });
    }
    return this.currentStatus;
  }
}
