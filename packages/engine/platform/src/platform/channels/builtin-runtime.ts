import { createHash } from 'node:crypto';
import type { Tool } from '../types/tools.js';
import { resolveEmailPassword } from '../email/email-config.js';
import { SURFACE_EMAIL_PASSWORD_REF } from '../email/surface-config.js';
import type {
  ChannelAccountLifecycleAction,
  ChannelAccountLifecycleResult,
  ChannelAccountRecord,
  ChannelActorAuthorizationRequest,
  ChannelActorAuthorizationResult,
  ChannelCapabilityDescriptor,
  ChannelConversationKind,
  ChannelDirectoryEntry,
  ChannelDirectoryQueryOptions,
  ChannelOperatorActionDescriptor,
  ChannelResolvedTarget,
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelRuntimeObservation,
  ChannelSurface,
  ChannelTargetResolveOptions,
  ChannelToolDescriptor,
} from './types.js';
import type { ChannelPlugin } from './plugin-registry.js';
import type { ProviderRuntimeStatus, ProviderRuntimeSurface } from './provider-runtime.js';
import { buildBuiltinAccount, resolveBuiltinAccount } from './builtin/accounts.js';
import { observeBuiltinRuntime } from './builtin/health.js';
import {
  buildBuiltinContractHooks,
  editBuiltinAllowlist,
  type BuiltinAllowlistEditInput,
  getBuiltinDoctorReport,
  getBuiltinLifecycleState,
  listBuiltinRepairActions,
  resolveBuiltinAllowlist,
} from './builtin/contracts.js';
import {
  listBuiltinCapabilities,
  listBuiltinOperatorActions,
  listBuiltinTools,
} from './builtin/descriptors.js';
import { runHomeAssistantOperatorAction } from './builtin/homeassistant.js';
import { getBuiltinSetupSchema } from './builtin/setup-schema.js';
import { TelegramIngressSupervisor, type TelegramIngressStatus } from './telegram/ingress.js';
import { TelegramOffsetStoreError } from './telegram/offset-store.js';
import { logger } from '../utils/logger.js';
import { registerBuiltinChannelPlugins } from './builtin/plugins.js';
import type { BuiltinChannelRuntimeDeps, ManagedSurface } from './builtin/shared.js';
import type { InboundMailHealthEntry } from '../email/inbound/health.js';
import {
  authorizeBuiltinActorAction,
  runBuiltinAccountAction,
} from './builtin/account-actions.js';
import { findProviderOperation } from './builtin/provider-operations.js';
import {
  actionNotFound,
  actionOk,
  actionRefused,
  legacyActionValue,
  outcomeOfActionResult,
  runChannelAction,
  unknownChannelAction,
  type ChannelActionOutcome,
} from './action-outcome.js';
import {
  readConversationKind,
  readDirectoryScope,
  readLifecycleAction,
} from './builtin/parsing.js';
import {
  listBuiltinAgentTools,
  notifyBuiltinApprovalViaRouter,
  renderBuiltinChannelEvent,
} from './builtin/rendering.js';
import { providerRuntimeStatus as providerRuntimeStatusForSurface } from './builtin/surfaces.js';
import {
  inferBuiltinTargetConversationKind,
  lookupBuiltinDirectory,
  parseBuiltinExplicitTarget,
  resolveBuiltinParentConversationCandidates,
  resolveBuiltinSessionTarget,
  resolveBuiltinTarget,
} from './builtin/targets.js';

export class BuiltinChannelRuntime {
  constructor(private readonly deps: BuiltinChannelRuntimeDeps) {}

  private telegramIngress: TelegramIngressSupervisor | null = null;
  private telegramConfigUnsubscribes: Array<() => void> = [];
  private telegramRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private inboundMailConfigUnsubscribes: Array<() => void> = [];
  private inboundMailRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  private inboundMailPasswordDigest: string | null | undefined = undefined;
  private inboundMailPendingRestart: string | null = null;
  private consumerConflictHandler: ((detail: string) => void) | null = null;
  private surfaceResponsibility: ((surface: ChannelSurface) => boolean) | null = null;
  private telegramCredentialUnsubscribe: (() => void) | null = null;

  /**
   * Register who to tell when Telegram reports that ANOTHER process is already
   * long-polling this bot token (409, "terminated by other getUpdates").
   *
   * Late-bound on purpose: the composition root builds this runtime before it
   * builds the thing that decides which node consumes, and the report has to
   * reach that decision rather than dead-ending in a log line. Set before
   * startIngress() so the very first poll's conflict is routed.
   */
  setConsumerConflictHandler(handler: (detail: string) => void): void {
    this.consumerConflictHandler = handler;
  }

  /**
   * Tell health which received surfaces this node is meant to be reading.
   *
   * Late-bound for the same reason as the conflict handler: leadership is
   * composed after this runtime. Unset, every surface counts as this node's.
   */
  setSurfaceResponsibility(isResponsible: ((surface: ChannelSurface) => boolean) | null): void {
    this.surfaceResponsibility = isResponsible;
  }

  /**
   * Arm the inbound paths that surfaces must actively establish.
   *
   * Registering an HTTP route is not enough for Telegram: it delivers nothing
   * until told a webhook URL exists or asked for updates. Called on daemon
   * start, after the HTTP listener is up so a registered webhook has somewhere
   * to land.
   */
  /**
   * The Telegram bot this node can actually read, or null when it cannot read
   * any, no token resolves, or the host gave no cursor storage to persist a
   * poll offset in.
   *
   * Read before the node contests the Telegram surface in the LAN election: a
   * node that cannot serve it must never win it, because the loser of that
   * election stands down and Telegram then goes unread by anybody.
   */
  async resolveServableTelegramBotId(): Promise<string | null> {
    if (!this.deps.telegramOffsetPath) return null;
    this.telegramIngress ??= this.buildTelegramIngress(this.deps.telegramOffsetPath);
    return this.telegramIngress.resolveServableBotId();
  }

  private buildTelegramIngress(offsetFilePath: string): TelegramIngressSupervisor {
    return new TelegramIngressSupervisor({
      configManager: this.deps.configManager,
      secretsManager: this.deps.secretsManager,
      serviceRegistry: this.deps.serviceRegistry,
      buildSurfaceAdapterContext: this.deps.buildSurfaceAdapterContext,
      offsetFilePath,
      beforeCursorWrite: this.deps.beforeTelegramCursorWrite?.bind(this.deps),
      beforeReceiveSpanWrite: this.deps.beforeTelegramReceiveSpanWrite?.bind(this.deps),
      telegramSourceAccounts: this.deps.telegramSourceAccounts,
      ...(this.deps.ingressAlarm ? { ingressAlarm: this.deps.ingressAlarm } : {}),
      onConcurrentConsumerConflict: (detail) => {
        this.consumerConflictHandler?.(detail);
        this.deps.onTelegramConsumerConflict?.(detail);
      },
    });
  }

  async startIngress(): Promise<void> {
    if (!this.deps.telegramOffsetPath) {
      // No surface-scoped storage was supplied, so a polling cursor cannot be
      // persisted. Say so rather than silently skipping inbound Telegram.
      if (this.deps.configManager.get('surfaces.telegram.enabled')) {
        logger.error('Telegram is enabled but is NOT receiving messages', {
          surface: 'telegram',
          reason: 'the host supplied no offset storage path, so the getUpdates cursor cannot be persisted',
          action: 'the embedder must pass telegramOffsetPath to BuiltinChannelRuntime to receive Telegram messages',
        });
      }
      return;
    }
    this.telegramIngress ??= this.buildTelegramIngress(this.deps.telegramOffsetPath);
    this.watchTelegramConfig();
    await this.telegramIngress.start();
  }

  /**
   * Re-decide ingress when the surface is reconfigured, so edits apply without
   * a restart, the same live-reload path an external settings edit takes.
   * start() stops any running loop first, so a mode change swaps cleanly rather
   * than leaving both a poll loop and a webhook armed.
   */
  private watchTelegramConfig(): void {
    if (this.telegramConfigUnsubscribes.length > 0) return;
    const keys = [
      'surfaces.telegram.enabled',
      'surfaces.telegram.mode',
      'surfaces.telegram.botToken',
      'surfaces.telegram.webhookSecret',
      'web.publicBaseUrl',
    ] as const;
    const restart = (): void => {
      // Revoke selected intake immediately, before the coalesced restart.
      this.deps.telegramSourceAccounts?.invalidate();
      // Coalesce: editing several keys in one save must re-decide once, not
      // once per key, or the modes race each other during the transition.
      if (this.telegramRestartTimer) clearTimeout(this.telegramRestartTimer);
      this.telegramRestartTimer = setTimeout(() => {
        this.telegramRestartTimer = null;
        void this.telegramIngress?.start().catch((error: unknown) => {
          logger.warn('Telegram ingress restart after a config change failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 250);
      (this.telegramRestartTimer as unknown as { unref?: () => void }).unref?.();
    };
    for (const key of keys) {
      this.telegramConfigUnsubscribes.push(this.deps.configManager.subscribe(key, restart));
    }
    // The token usually lives in the secret store, which config does not see.
    // A loop that stopped on a rejected token stays stopped unless a corrected
    // secret restarts it; unrelated secrets must not restart polling.
    if (typeof this.deps.secretsManager.onDidChange === 'function') {
      this.telegramCredentialUnsubscribe = this.deps.secretsManager.onDidChange(() => {
        const ingress = this.telegramIngress;
        if (!ingress) return;
        void ingress.botTokenChangedSinceStart().then((changed) => {
          if (changed && this.telegramIngress === ingress && this.telegramConfigUnsubscribes.length > 0) restart();
        }, (error: unknown) => {
          logger.warn('Telegram ingress could not re-read its bot token after a secret change', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    }
  }

  /** Tear the inbound paths down; the poll loop must not outlive the daemon. */
  async stopIngress(): Promise<void> {
    this.deps.telegramSourceAccounts?.invalidate();
    if (this.telegramRestartTimer) {
      clearTimeout(this.telegramRestartTimer);
      this.telegramRestartTimer = null;
    }
    for (const unsubscribe of this.telegramConfigUnsubscribes.splice(0)) unsubscribe();
    this.telegramCredentialUnsubscribe?.();
    this.telegramCredentialUnsubscribe = null;
    await this.telegramIngress?.stop();
  }

  /**
   * Current inbound Telegram state, including why it is inactive.
   *
   * Read by `observeSurfaceRuntime`, which is what every Telegram status
   * snapshot is now derived from. It previously had no caller at all while the
   * reported state was computed from the token's presence, so a bot whose poll
   * loop had stopped reported healthy, this function knew, and nobody asked.
   */
  telegramIngressStatus(): TelegramIngressStatus | null {
    return this.telegramIngress?.status ?? null;
  }

  // -------------------------------------------------------------------------
  // Inbound mail (docs/decisions/2026-07-27-inbound-email-design.md §3.5)
  //
  // Beside the Telegram ingress methods rather than folded into
  // startIngress()/stopIngress(): each is its OWN cluster surface, and a node
  // that lost the Telegram election must still read the mailbox it did win.
  // Starting them together would re-couple exactly what the per-surface split
  // un-coupled.
  // -------------------------------------------------------------------------

  /** Arm inbound mail. Says so loudly when a mailbox is wanted and unwatched. */
  async startInboundMail(): Promise<void> {
    const supervisor = this.deps.inboundMail;
    if (!supervisor) {
      if (this.deps.configManager.get('surfaces.email.inbound.enabled')) {
        logger.error('Inbound mail is enabled but NO mailbox is being watched', {
          surface: 'email-inbound',
          reason: 'this composition supplied no inbound-mail supervisor',
          action: 'the embedder must pass inboundMail to BuiltinChannelRuntime to watch a mailbox',
        });
      }
      return;
    }
    this.watchInboundMailConfig();
    await supervisor.start();
  }

  /**
   * Look at the mailbox again when anything it depends on changes.
   *
   * Three kinds of change, each with the effect it really has:
   *
   * - What the running source re-reads on every reconnect (host, port,
   *   account user, the keys `readSurfaceEmailSettings` reads):
   *   `recheckNow()` makes that reconnect now instead of at the next
   *   `capabilityRecheckMinutes`.
   * - What decides which source is built and which mailbox it opens (the
   *   source, the account list, the mailbox): `recheckNow()` sees the
   *   supervisor's start inputs changed and rebuilds the source, so the
   *   change takes effect without a restart.
   * - The inbound mode, which the watcher's settings fix when the daemon
   *   composes them: nothing here can apply it, so status says it waits for a
   *   restart instead of reading as though it took effect.
   *
   * The password lives in the secret store, which does announce changes. A
   * change that leaves the mail password as it was does nothing; a corrected
   * password rechecks at once, the way Telegram restarts on a corrected token.
   *
   * Coalesced the same way the Telegram watcher coalesces its restart: saving a
   * settings page writes several keys, and one re-probe per key would be several
   * reconnections against a mail server for one edit.
   */
  private watchInboundMailConfig(): void {
    if (this.inboundMailConfigUnsubscribes.length > 0) return;
    const keys = [
      'surfaces.email.imap.host',
      'surfaces.email.host',
      'surfaces.email.imap.port',
      'surfaces.email.imap.user',
      'surfaces.email.user',
      'surfaces.email.imap.mailbox',
      'surfaces.email.inbound.source',
      'surfaces.email.inbound.accounts',
    ] as const;
    const recheck = (): void => {
      if (this.inboundMailRecheckTimer) clearTimeout(this.inboundMailRecheckTimer);
      this.inboundMailRecheckTimer = setTimeout(() => {
        this.inboundMailRecheckTimer = null;
        this.deps.inboundMail?.recheckNow();
      }, 250);
      (this.inboundMailRecheckTimer as unknown as { unref?: () => void }).unref?.();
    };
    for (const key of keys) {
      this.inboundMailConfigUnsubscribes.push(this.deps.configManager.subscribe(key, recheck));
    }
    const startedMode = this.deps.configManager.get('surfaces.email.inbound.mode');
    this.inboundMailConfigUnsubscribes.push(this.deps.configManager.subscribe('surfaces.email.inbound.mode', (mode) => {
      this.inboundMailPendingRestart = mode === startedMode ? null : `surfaces.email.inbound.mode changed to '${String(mode)}' and takes effect after the daemon restarts`;
      if (this.inboundMailPendingRestart) logger.info('Inbound mail mode changed; it takes effect after the daemon restarts', { mode });
    }));
    if (typeof this.deps.secretsManager?.onDidChange === 'function') {
      void this.readInboundMailPasswordDigest().then((digest) => { this.inboundMailPasswordDigest ??= digest; });
      const unsubscribe = this.deps.secretsManager.onDidChange(() => {
        void this.readInboundMailPasswordDigest().then((digest) => {
          if (digest === this.inboundMailPasswordDigest) return;
          this.inboundMailPasswordDigest = digest;
          if (this.inboundMailConfigUnsubscribes.length > 0) recheck();
        });
      });
      this.inboundMailConfigUnsubscribes.push(unsubscribe);
    }
  }

  /**
   * A digest of the mail password as the source would resolve it, or null when
   * it does not resolve. Kept so an unrelated secret write does not reconnect
   * to the mail server; the value itself is never held here.
   */
  private async readInboundMailPasswordDigest(): Promise<string | null> {
    try {
      const password = await resolveEmailPassword(SURFACE_EMAIL_PASSWORD_REF, this.deps.secretsManager);
      return createHash('sha256').update(password).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Stop reading the mailbox and release its connection.
   *
   * Awaited, and it must not resolve early: the ordered cluster handoff tells
   * the successor node to start only after this promise settles, and two nodes
   * holding one mailbox both announce every message.
   */
  async stopInboundMail(): Promise<void> {
    if (this.inboundMailRecheckTimer) {
      clearTimeout(this.inboundMailRecheckTimer);
      this.inboundMailRecheckTimer = null;
    }
    for (const unsubscribe of this.inboundMailConfigUnsubscribes.splice(0)) unsubscribe();
    await this.deps.inboundMail?.stop();
  }

  /**
   * Email's health entry, read from the live supervisor.
   *
   * Deliberately not a `ChannelStatusSnapshot`: email is not a
   * `ManagedSurface`, and its state is what the watcher is DOING rather than
   * whether a credential happens to be present in the config file.
   */
  inboundMailHealth(): InboundMailHealthEntry | null {
    const health = this.deps.inboundMail?.health() ?? null;
    if (!health || !this.inboundMailPendingRestart) return health;
    return {
      ...health,
      reason: `${health.reason} ${this.inboundMailPendingRestart}.`,
      metadata: { ...health.metadata, pendingRestart: this.inboundMailPendingRestart },
    };
  }

  /**
   * Which mailbox this node would watch, for the cluster election.
   *
   * Read before the node contests the surface: a node that watches no mailbox
   * must never win the election for one, because the loser stands down and the
   * mailbox then goes unread by anybody.
   */
  inboundMailIdentity(): { readonly account: string; readonly mailbox: string } | null {
    const health = this.deps.inboundMail?.health();
    return health ? { account: health.account, mailbox: health.mailbox } : null;
  }

  /**
   * What this node can see of a surface's live path.
   *
   * Public because health is worth asking about outside a status sweep, the
   * health watcher and the doctor report both want the same answer, and two
   * answers to one question is how the reported state drifted from reality in
   * the first place.
   */
  observeSurfaceRuntime(surface: ChannelSurface): ChannelRuntimeObservation {
    const responsibility = this.surfaceResponsibility;
    return observeBuiltinRuntime({
      telegramIngressStatus: () => this.telegramIngressStatus(),
      providerRuntimeStatus: (providerSurface) => this.deps.providerRuntime?.status(providerSurface) ?? null,
      processingFailure: (current) => this.deps.ingressAlarm?.failure(current)?.detail,
      ...(responsibility ? { isResponsible: responsibility } : {}),
    }, surface);
  }

  registerPlugins(): void {
    registerBuiltinChannelPlugins({
      deps: this.deps,
      observeRuntime: (surface) => this.observeSurfaceRuntime(surface),
      buildAccount: (surface) => this.buildAccount(surface),
      resolveAccount: (surface, accountId) => this.resolveAccount(surface, accountId),
      listCapabilities: (surface) => this.listCapabilities(surface),
      listTools: (surface) => this.listTools(surface),
      runTool: (surface, toolId, input) => this.runTool(surface, toolId, input),
      listOperatorActions: (surface) => this.listOperatorActions(surface),
      runOperatorAction: (surface, actionId, input) => this.runOperatorAction(surface, actionId, input),
      buildContractHooks: (surface) => this.buildContractHooks(surface),
      buildProductHooks: (surface) => this.buildProductHooks(surface),
      lookupDirectory: (surface, query, options) => this.lookupDirectory(surface, query, options),
      lookupRouteDirectory: (surface, query, options) => this.lookupRouteDirectory(surface, query, options),
      notifyApprovalViaRouter: (surface, approval, binding) => this.notifyApprovalViaRouter(surface, approval, binding),
      providerRuntimeStatus: (surface) => this.providerRuntimeStatus(surface),
    });
    // The outcome-returning entry points, so the registry's invokeTool and
    // invokeOperatorAction can tell not-found from refused from unknown for
    // every built-in surface.
    for (const plugin of this.deps.channelPlugins.list()) {
      if (!plugin.id.startsWith('surface:')) continue;
      const surface = plugin.surface;
      this.deps.channelPlugins.setOutcomeHandlers(plugin.id, {
        invokeTool: (toolId, input) => this.invokeTool(surface, toolId, input),
        invokeOperatorAction: (actionId, input) => this.invokeOperatorAction(surface, actionId, input),
      });
    }
  }

  private accountContext() {
    return {
      deps: this.deps,
      providerRuntimeStatus: (surface: ProviderRuntimeSurface) => this.providerRuntimeStatus(surface),
      observeRuntime: (surface: ChannelSurface) => this.observeSurfaceRuntime(surface),
    };
  }

  async buildAccount(surface: ChannelSurface): Promise<ChannelAccountRecord> {
    return buildBuiltinAccount(this.accountContext(), surface);
  }

  async resolveAccount(surface: ChannelSurface, accountId: string): Promise<ChannelAccountRecord | null> {
    return resolveBuiltinAccount(this.accountContext(), surface, accountId);
  }

  private contractContext() {
    return {
      deps: this.deps,
      channelPolicy: this.deps.channelPolicy,
      buildAccount: (surface: ChannelSurface) => this.buildAccount(surface),
      resolveAccount: (surface: ChannelSurface, accountId: string) => this.resolveAccount(surface, accountId),
      resolveTarget: (surface: ChannelSurface, options: ChannelTargetResolveOptions) => this.resolveTarget(surface, options),
      observeRuntime: (surface: ChannelSurface) => this.observeSurfaceRuntime(surface),
    };
  }

  async listCapabilities(surface: ChannelSurface): Promise<ChannelCapabilityDescriptor[]> {
    const account = await this.buildAccount(surface);
    const plugin = this.deps.channelPlugins.getBySurface(surface);
    return listBuiltinCapabilities(surface, account, plugin?.capabilities ?? []);
  }

  listOperatorActions(surface: ChannelSurface): ChannelOperatorActionDescriptor[] {
    return listBuiltinOperatorActions(surface);
  }

  listTools(surface: ChannelSurface): ChannelToolDescriptor[] {
    return listBuiltinTools(surface);
  }

  /** The older signature: the answer, or null. `invokeTool` says which outcome it was. */
  async runTool(surface: ChannelSurface, toolId: string, input?: Record<string, unknown>): Promise<unknown> {
    return legacyActionValue(await this.invokeTool(surface, toolId, input), surface);
  }

  async invokeTool(surface: ChannelSurface, toolId: string, input?: Record<string, unknown>): Promise<ChannelActionOutcome> {
    const tools = this.listTools(surface);
    const tool = tools.find((entry) => entry.id === toolId || entry.name === toolId);
    const actionId = tool?.actionIds[0];
    if (!actionId) return unknownChannelAction(surface, 'tool', toolId, tools.map((entry) => entry.name));
    return this.invokeOperatorAction(surface, actionId, input);
  }

  /** The older signature: the answer, or null. `invokeOperatorAction` says which outcome it was. */
  async runOperatorAction(
    surface: ChannelSurface,
    actionId: string,
    input?: Record<string, unknown>,
  ): Promise<unknown> {
    return legacyActionValue(await this.invokeOperatorAction(surface, actionId, input), surface);
  }

  /**
   * Run one operator action. Total: every call ends ok, not found, refused, or
   * unknown action (with the surface's action ids), and only ok is success.
   */
  async invokeOperatorAction(
    surface: ChannelSurface,
    actionId: string,
    input?: Record<string, unknown>,
  ): Promise<ChannelActionOutcome> {
    return runChannelAction(() => this.dispatchOperatorAction(surface, actionId, input));
  }

  private async dispatchOperatorAction(
    surface: ChannelSurface,
    actionId: string,
    input?: Record<string, unknown>,
  ): Promise<ChannelActionOutcome> {
    if (surface === 'telegram' && (actionId === 'cursor-migration-preview' || actionId === 'cursor-migration-commit')) {
      if (!this.telegramIngress) throw new TelegramOffsetStoreError('unavailable');
      if (actionId === 'cursor-migration-preview') return actionOk(await this.telegramIngress.previewCursorMigration());
      if (input?.confirm !== true || typeof input.previewId !== 'string' || Object.keys(input).some(key => key !== 'confirm' && key !== 'previewId')) {
        throw new TelegramOffsetStoreError('invalid-request');
      }
      return actionOk(await this.telegramIngress.commitCursorMigration({ previewId: input.previewId, confirm: true }));
    }
    if (surface === 'homeassistant') {
      const homeAssistantResult = await runHomeAssistantOperatorAction({ deps: this.deps }, actionId, input);
      if (homeAssistantResult.handled) return outcomeOfActionResult(homeAssistantResult.result);
    }
    const providerOperation = findProviderOperation(surface, actionId);
    if (providerOperation) return providerOperation.run({ deps: this.deps }, surface, input);
    const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
    switch (actionId) {
      case 'inspect-account': {
        if (!accountId) return actionOk(await this.buildAccount(surface));
        const account = await this.resolveAccount(surface, accountId);
        return account
          ? actionOk(account)
          : actionNotFound(`The ${surface} account '${accountId}'`, [`Call inspect-account without accountId to see the ${surface} account and its id.`]);
      }
      case 'inspect-status': {
        const status = (await this.deps.channelPlugins.listStatus()).find((entry) => entry.surface === surface);
        return status ? actionOk(status) : actionNotFound(`A status for ${surface}`, ['Check that the surface is registered in this daemon.']);
      }
      case 'setup-schema':
        return actionOk(this.getSetupSchema(surface));
      case 'doctor':
        return actionOk(await this.getDoctorReport(surface, accountId));
      case 'repair-actions':
        return actionOk(await this.listRepairActions(surface, accountId));
      case 'lifecycle-state':
        return actionOk(await this.getLifecycleState(surface, accountId));
      case 'list-directory': {
        const scope = readDirectoryScope(input?.scope);
        const entries = await this.deps.channelPlugins.queryDirectory(surface, {
          query: typeof input?.query === 'string' ? input.query : undefined,
          ...(scope ? { scope } : {}),
          groupId: typeof input?.groupId === 'string' ? input.groupId : undefined,
          limit: typeof input?.limit === 'number' ? input.limit : undefined,
          ...(input?.live === true ? { live: true } : {}),
        });
        return actionOk(entries);
      }
      case 'list-capabilities':
        return actionOk(await this.listCapabilities(surface));
      case 'account-action': {
        const action = readLifecycleAction(input?.action ?? input?.accountAction);
        if (!action) {
          return actionRefused({
            code: 'CHANNEL_ACCOUNT_ACTION_UNKNOWN',
            state: 'nothing was run',
            reason: `account-action needs action, one of: ${CHANNEL_ACCOUNT_LIFECYCLE_ACTIONS.join(', ')}; it was ${typeof (input?.action ?? input?.accountAction) === 'string' ? `'${String(input?.action ?? input?.accountAction)}'` : 'missing'}.`,
            next: [`Pass action as one of: ${CHANNEL_ACCOUNT_LIFECYCLE_ACTIONS.join(', ')}.`],
          });
        }
        const result = await this.runAccountAction(surface, action, accountId, input);
        return outcomeOfActionResult(result, [`Run the ${surface} doctor to see what the surface needs.`]);
      }
      case 'resolve-target': {
        const targetInput = typeof input?.target === 'string'
          ? input.target
          : typeof input?.input === 'string'
            ? input.input
            : typeof input?.query === 'string'
              ? input.query
              : '';
        if (targetInput.trim().length === 0) {
          return actionRefused({ state: 'nothing was resolved', reason: 'resolve-target needs the target to resolve.', next: ['Pass target, for example #channel or @person.'] });
        }
        const preferredKind = readConversationKind(input?.preferredKind);
        const target = await this.resolveTarget(surface, {
          input: targetInput,
          ...(accountId ? { accountId } : {}),
          ...(preferredKind ? { preferredKind } : {}),
          ...(typeof input?.threadId === 'string' ? { threadId: input.threadId } : {}),
          ...(typeof input?.createIfMissing === 'boolean' ? { createIfMissing: input.createIfMissing } : {}),
          ...(typeof input?.live === 'boolean' ? { live: input.live } : {}),
        });
        return target
          ? actionOk(target)
          : actionNotFound(`A ${surface} target named '${targetInput}'`, ['Search the surface directory with live: true, or pass a typed id such as channel:<id>.']);
      }
      case 'authorize-actor-action': {
        const requestedAction = typeof input?.actionId === 'string' ? input.actionId.trim() : '';
        if (!requestedAction) {
          return actionRefused({
            state: 'nothing was evaluated',
            reason: 'authorize-actor-action needs actionId, the action to check; it was missing or empty.',
            next: ['Pass actionId, for example start or logout.'],
          });
        }
        const targetInput = typeof input?.target === 'string' ? input.target : undefined;
        const target = targetInput
          ? await this.resolveTarget(surface, { input: targetInput, ...(accountId ? { accountId } : {}) })
          : undefined;
        return actionOk(await this.authorizeActorAction(surface, {
          actionId: requestedAction,
          ...(typeof input?.actorId === 'string' ? { actorId: input.actorId } : {}),
          ...(accountId ? { accountId } : {}),
          ...(target ? { target } : {}),
          metadata: {},
        }));
      }
      case 'resolve-allowlist':
        return actionOk(await this.resolveAllowlist(surface, readAllowlistEditInput(input)));
      case 'edit-allowlist':
        return actionOk(await this.editAllowlist(surface, readAllowlistEditInput(input)));
    }
    return unknownChannelAction(surface, 'action', actionId, this.listOperatorActions(surface).map((action) => action.id));
  }

  private buildContractHooks(surface: ChannelSurface): Pick<
    ChannelPlugin,
    | 'setupVersion'
    | 'renderPolicy'
    | 'getSetupSchema'
    | 'doctor'
    | 'listRepairActions'
    | 'getLifecycleState'
    | 'resolveAllowlist'
    | 'editAllowlist'
  > {
    return buildBuiltinContractHooks(this.contractContext(), surface);
  }

  private getSetupSchema(surface: ChannelSurface) {
    return getBuiltinSetupSchema(surface);
  }

  private async listRepairActions(surface: ChannelSurface, accountId?: string) {
    return listBuiltinRepairActions(this.contractContext(), surface, accountId);
  }

  private async getDoctorReport(surface: ChannelSurface, accountId?: string) {
    return getBuiltinDoctorReport(this.contractContext(), surface, accountId);
  }

  private async getLifecycleState(surface: ChannelSurface, accountId?: string) {
    return getBuiltinLifecycleState(this.contractContext(), surface, accountId);
  }

  private async resolveAllowlist(surface: ChannelSurface, input: Parameters<typeof resolveBuiltinAllowlist>[2]) {
    return resolveBuiltinAllowlist(this.contractContext(), surface, input);
  }

  private async editAllowlist(surface: ChannelSurface, input: Parameters<typeof editBuiltinAllowlist>[2]) {
    return editBuiltinAllowlist(this.contractContext(), surface, input);
  }

  private buildProductHooks(surface: ChannelSurface): Pick<
    ChannelPlugin,
    | 'runAccountAction'
    | 'authorizeActorAction'
    | 'parseExplicitTarget'
    | 'inferTargetConversationKind'
    | 'resolveTarget'
    | 'resolveSessionTarget'
    | 'resolveParentConversationCandidates'
    | 'renderEvent'
    | 'listAgentTools'
  > {
    return {
      runAccountAction: (action, accountId, input) => this.runAccountAction(surface, action, accountId, input),
      authorizeActorAction: (request) => this.authorizeActorAction(surface, request),
      parseExplicitTarget: (input, options) => this.parseExplicitTarget(surface, input, options),
      inferTargetConversationKind: (input, options) => this.inferTargetConversationKind(input, options),
      resolveTarget: (options) => this.resolveTarget(surface, options),
      resolveSessionTarget: (target) => this.resolveSessionTarget(target),
      resolveParentConversationCandidates: (options) => this.resolveParentConversationCandidates(surface, options),
      renderEvent: (request) => this.renderChannelEvent(surface, request),
      listAgentTools: () => this.listAgentTools(surface),
    };
  }

  private async renderChannelEvent(surface: ChannelSurface, request: ChannelRenderRequest): Promise<ChannelRenderResult> {
    return renderBuiltinChannelEvent({
      deps: this.deps,
      listTools: (currentSurface) => this.listTools(currentSurface),
      invokeTool: (currentSurface, toolId, input) => this.invokeTool(currentSurface, toolId, input),
    }, surface, request);
  }

  private async notifyApprovalViaRouter(
    surface: ChannelSurface,
    approval: Parameters<typeof notifyBuiltinApprovalViaRouter>[2],
    binding: Parameters<typeof notifyBuiltinApprovalViaRouter>[3],
  ): Promise<void> {
    await notifyBuiltinApprovalViaRouter({
      deps: this.deps,
      listTools: (currentSurface) => this.listTools(currentSurface),
      invokeTool: (currentSurface, toolId, input) => this.invokeTool(currentSurface, toolId, input),
    }, surface, approval, binding);
  }

  private listAgentTools(surface: ChannelSurface): readonly Tool[] {
    return listBuiltinAgentTools({
      deps: this.deps,
      listTools: (currentSurface) => this.listTools(currentSurface),
      invokeTool: (currentSurface, toolId, input) => this.invokeTool(currentSurface, toolId, input),
    }, surface);
  }

  private async runAccountAction(
    surface: ChannelSurface,
    action: ChannelAccountLifecycleAction,
    accountId?: string,
    input?: Record<string, unknown>,
  ): Promise<ChannelAccountLifecycleResult> {
    return runBuiltinAccountAction({
      deps: this.deps,
      restartTelegramIngress: async () => {
        if (!this.deps.telegramOffsetPath) return null;
        await this.startIngress();
        return this.telegramIngressStatus();
      },
      buildAccount: (currentSurface) => this.buildAccount(currentSurface),
      resolveAccount: (currentSurface, currentAccountId) => this.resolveAccount(currentSurface, currentAccountId),
    }, surface, action, accountId, input);
  }

  private async authorizeActorAction(
    surface: ChannelSurface,
    request: ChannelActorAuthorizationRequest,
  ): Promise<ChannelActorAuthorizationResult> {
    return authorizeBuiltinActorAction({
      deps: this.deps,
      channelPolicy: this.deps.channelPolicy,
      buildAccount: (currentSurface) => this.buildAccount(currentSurface),
      resolveAccount: (currentSurface, currentAccountId) => this.resolveAccount(currentSurface, currentAccountId),
    }, surface, request);
  }

  private parseExplicitTarget(
    surface: ChannelSurface,
    input: string,
    options?: ChannelTargetResolveOptions,
  ): ChannelResolvedTarget | null {
    return parseBuiltinExplicitTarget(surface, input, options);
  }

  private inferTargetConversationKind(
    input: string,
    options?: ChannelTargetResolveOptions,
  ): ChannelConversationKind {
    return inferBuiltinTargetConversationKind(input, options);
  }

  private async resolveTarget(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<ChannelResolvedTarget | null> {
    return resolveBuiltinTarget({ deps: this.deps }, surface, options);
  }

  private async resolveParentConversationCandidates(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<readonly ChannelResolvedTarget[]> {
    return resolveBuiltinParentConversationCandidates({ deps: this.deps }, surface, options);
  }

  private resolveSessionTarget(target: ChannelResolvedTarget): string {
    return resolveBuiltinSessionTarget(target);
  }

  private providerRuntimeStatus(surface: ProviderRuntimeSurface): ProviderRuntimeStatus | null {
    return providerRuntimeStatusForSurface(this.deps, surface);
  }

  private async lookupDirectory(
    surface: ManagedSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<ChannelDirectoryEntry[]> {
    return lookupBuiltinDirectory({ deps: this.deps }, surface, query, options);
  }

  private async lookupRouteDirectory(
    surface: ManagedSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<ChannelDirectoryEntry[]> {
    return lookupBuiltinDirectory({ deps: this.deps }, surface, query, { ...options, live: false });
  }
}

const CHANNEL_ACCOUNT_LIFECYCLE_ACTIONS: readonly ChannelAccountLifecycleAction[] = [
  'inspect', 'setup', 'retest', 'connect', 'disconnect', 'start', 'stop', 'login', 'logout', 'wait_login',
];

function readAllowlistEditInput(input: Record<string, unknown> | undefined): BuiltinAllowlistEditInput {
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
  const add = strings(input?.add);
  const remove = strings(input?.remove);
  const callerKind = readConversationKind(input?.callerConversationKind);
  return {
    ...(add ? { add } : {}),
    ...(remove ? { remove } : {}),
    ...(typeof input?.groupId === 'string' ? { groupId: input.groupId } : {}),
    ...(typeof input?.channelId === 'string' ? { channelId: input.channelId } : {}),
    ...(typeof input?.workspaceId === 'string' ? { workspaceId: input.workspaceId } : {}),
    ...(input?.kind === 'user' || input?.kind === 'channel' || input?.kind === 'group' ? { kind: input.kind } : {}),
    ...(typeof input?.metadata === 'object' && input.metadata !== null ? { metadata: input.metadata as Record<string, unknown> } : {}),
    ...(input?.force === true ? { force: true } : {}),
    ...(typeof input?.callerUserId === 'string' && input.callerUserId.trim() ? { callerUserId: input.callerUserId.trim() } : {}),
    ...(typeof input?.callerConversationId === 'string' && input.callerConversationId.trim() ? { callerConversationId: input.callerConversationId.trim() } : {}),
    ...(callerKind ? { callerConversationKind: callerKind } : {}),
  };
}
