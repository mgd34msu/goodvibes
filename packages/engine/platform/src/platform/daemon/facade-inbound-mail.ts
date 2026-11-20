/**
 * facade-inbound-mail.ts, assembling the inbound-mail graph for the daemon.
 *
 * Every piece here already exists and is already tested. This file is the
 * wiring, and it is separate from `facade-composition.ts` for the same reason
 * `facade-cluster.ts` is: it is one subsystem's decisions in one place, and the
 * decisions are the kind that must be visible rather than buried in a hundred
 * lines of unrelated construction.
 *
 * Three of those decisions are worth reading before changing anything.
 *
 * **The stores live under `~/.goodvibes/daemon/`**, `resolveUserPath('daemon',
 * …)`, the surface-scoped mechanism, not a hand-built path. All three outlive a
 * restart, so all three are swept at load by the housekeeper before the watcher
 * serves any mail.
 *
 * **The expectation book is constructed HERE, once, with the real authority
 * probe.** It had never been constructed in production at all: its own
 * defensive check, refuse to open an expectation if email ever gained command
 * authority, could not have fired, because there was nothing for it to fire
 * in. `InboundExpectationRegistry` defaults to the genuine predicate, so
 * building it is what takes that check off the shelf.
 *
 * **The verbs are registered here too.** `email.expectation.open/list/cancel`
 * were cataloged with no production call site, which made the whole capability
 * inert in exactly the way §2.3 describes, the middle of the chain missing
 * while both ends worked. They are attached to the registry that this function
 * builds, alongside `email.inbound.status` over the supervisor.
 *
 * **The Gmail source is CONSTRUCTED here, and that is new.** `GmailMailSource`
 * was complete, tested and exported, and nothing in production ever built one:
 * `createInboundMailSourceFactory` took the builder as an optional `deps.gmail`
 * and this file passed nothing, so the factory answered `null` for
 * `kind: 'gmail'` on every machine while `selectionFacts` reported
 * `googleAdopted: options.gmail !== undefined`, permanently false. An owner
 * with Google adopted and no IMAP set up therefore had no inbound mail at all,
 * and was told "no Google credentials have been adopted on this machine".
 *
 * So `gmailReader` is a REQUIRED option rather than an optional one. The
 * compiler is the gate: a composition that stops supplying it stops building,
 * which is the one check that cannot itself go inert. The reader arrives as a
 * provider (see `facade-gmail-reader.ts`); the cursor store, the expectation
 * predicate and the clock are this file's own; and the poll cadence and the
 * capability re-probe wait arrive on the builder's input, read once in
 * `source-factory.ts` at create time. One key, one reader, a second read here
 * would be a second answer to a question the owner has already answered, and
 * the config gate accepts either call form so it could not tell them apart.
 *
 * **Whether this mailbox is a Gmail one is decided from the CREDENTIAL.** See
 * `isGmailMailbox`: a resolved reader is Google having answered, and
 * `surfaces.email.inbound.accounts` is read as a filter over that rather than
 * as the evidence for it. Making the config key the evidence is what let this
 * path stay dead for an owner who filled the key in the way its own description
 * tells the owner to.
 */

import {
  GmailMailSource,
  InboundExpectationRegistry,
  InboundMailHousekeeper,
  InboundMailStore,
  InboundMailSupervisor,
  MailboxCursorStore,
  PersistedExpectationStore,
  createInboundMailIntake,
  createInboundMailSourceFactory,
  createInboundNoticeHealth,
  createInboundTerminalFailureAnnouncer,
  expectationSweepIntervalMs,
  mailboxReaderKey,
  resolveWatcherSettings,
  systemWatcherClock,
  type GmailSourceBuilder,
  type InboundMailHealthEntry,
  type InboundMailObserver,
  type InboundMailSourceFactory,
  type InboundWatcherSettings,
  type InboundNoticeMode,
  type MailboxReaders,
  type NoticeRouteResolution,
} from '../email/inbound/index.js';
import { holdProcessLock } from '../utils/process-lock.js';
import { createHash } from 'node:crypto';
import type {
  GmailInboundReaderProvider,
  GmailInboundReaderResolution,
} from '../google/gmail-inbound-reader.js';
import { nodeEmailTransport } from '../email/node.js';
import { configReaderWithOrigins, readSurfaceEmailSettings, type ConfigReaderWithOrigins } from '../email/surface-config.js';
import { parseEmailSecretRef } from '../email/email-config.js';
import { isLoopbackHost } from '../utils/reachable-base-url.js';
import { registerEmailExpectationGatewayMethods } from '../control-plane/routes/email-expectations.js';
import { registerEmailInboundStatusGatewayMethod } from '../control-plane/routes/email-inbound-status.js';
import { logger } from '../utils/logger.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import { isOwnerConversation } from './owner-alert.js';
import type { GatewayMethodCatalog } from '../control-plane/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { RouteBindingManager } from '../channels/index.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import type { StructuredNotice } from '../email/inbound-notice.js';
import type { SurfaceNoticeDelivery } from './types.js';

/** The folder a mailbox is read from when its settings name none. */
const DEFAULT_MAILBOX = 'INBOX';

export interface InboundMailCompositionOptions {
  readonly configManager: ConfigManager;
  readonly secretsManager: Pick<SecretsManager, 'get'>
    & Partial<Pick<SecretsManager, 'onDidInvalidateCredentials' | 'getCredentialMutationState'>>;
  readonly shellPaths: Pick<ShellPathService, 'resolveUserPath'>;
  /**
   * `isRouteBindingEnabled` is in the slice deliberately. Without it, a build
   * with `integrations.routeBinding` switched off is indistinguishable from one
   * where the owner has simply connected nothing: both answer `[]` from
   * `listBindings()`, and inbound mail silently became a recorder.
   */
  readonly routeBindings: Pick<
    RouteBindingManager,
    'listBindings' | 'getBinding' | 'isRouteBindingEnabled' | 'start'
  >;
  readonly gatewayMethods: GatewayMethodCatalog;
  /**
   * `DaemonSurfaceDeliveryHelper.deliverStructuredNotice`.
   *
   * Takes the STRUCTURE, not a rendered string, so nothing on the inbound path
   * ever holds channel-formatted text. The helper resolves the surface from the
   * binding and picks the escaper there, the only code that turns spans into
   * text is the code that knows where they are going.
   */
  readonly deliverStructuredNotice: (
    binding: AutomationRouteBinding | undefined,
    notice: StructuredNotice,
  ) => Promise<SurfaceNoticeDelivery>;
  /**
   * The owner user id of a channel surface (`DaemonSurfaceDeliveryHelper.channelOwner`),
   * so the default notice route is one of the owner's own one-to-one conversations.
   */
  readonly channelOwner: (surface: string) => string | undefined;
  /**
   * How this machine's Google credential is turned into Gmail-reading I/O.
   *
   * REQUIRED, deliberately. Its optional predecessor (`gmail?:
   * GmailSourceBuilder`) is what let the whole Gmail path ship inert: nothing
   * ever filled it, and an unfilled optional field is indistinguishable from a
   * machine with no Google account. A required provider that ANSWERS
   * `unavailable` with a reason carries the same information and cannot be
   * forgotten, `createBuiltinChannelRuntime` stops compiling if it is dropped.
   *
   * Called once per supervisor start rather than held as a resolved value, so a
   * credential adopted while the daemon is running is picked up on the next
   * start instead of at the next restart.
   */
  readonly gmailReader: GmailInboundReaderProvider;
  /**
   * Where the inbox (and anything else that wants this mailbox's mail) meets
   * the reader composed here. Absent, notices are the only consumer.
   */
  readonly mailboxReaders?: MailboxReaders | undefined;
  /** Replaces the live IMAP/Gmail source factory, so a test can hold the sink a started source delivers into. */
  readonly sources?: InboundMailSourceFactory | undefined;
}

/**
 * The accounts this node watches.
 *
 * `surfaces.email.inbound.accounts` is a JSON array: the first entry is the
 * daemon's own mailbox, and each further one is watched over IMAP with the
 * connection `surfaces.email.inbound.mailboxes` gives it. An empty list is
 * honest about watching nothing rather than defaulting to a mailbox nobody
 * named.
 */
function readWatchedAccounts(configManager: ConfigManager): { readonly account: string; readonly further: readonly string[] } | null {
  const raw = configManager.get('surfaces.email.inbound.accounts');
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const named = parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
    const [account, ...rest] = named;
    return account === undefined ? null : { account, further: [...new Set(rest.filter((entry) => entry !== account))] };
  } catch {
    // A malformed list is a configuration error, not a mailbox. Reported by
    // the supervisor's status rather than guessed at here.
    return null;
  }
}

/** The resolution, with the full binding this file needs to hand the delivery helper. */
type NoticeRouteAnswer =
  | { readonly kind: 'bound'; readonly binding: AutomationRouteBinding }
  | Extract<NoticeRouteResolution, { kind: 'unavailable' }>;

/**
 * Where the owner is told about inbound mail (§8), or why there is nowhere.
 *
 * A named binding id wins. `default`, the shipped value, means "inherit
 * whatever the owner already uses", and with no separate owner-notice-route
 * concept in the platform, the honest reading of that is the route binding
 * most recently seen: the one the owner last reached the daemon on.
 *
 * Every arm that cannot produce a binding names ITSELF rather than collapsing
 * to one `null`, and that is the fix rather than a nicety. Three genuinely
 * different states used to arrive here identically:
 *
 *  - route binding is switched off, so `listBindings()` answers `[]` no matter
 *    how many bindings are stored. An unrelated feature flag, silently turning
 *    inbound mail into a recorder.
 *  - the owner has connected no channel at all, which is a fresh install.
 *  - `surfaces.email.inbound.notice.route` names a binding that is not there,
 *    which is a typo or a binding that was removed.
 *
 * All three were recorded as `no-route-binding` and none of them was reported
 * as anything, so a message the owner never heard about looked the same as a
 * message the owner had never configured a route for. The record still says
 * `no-route-binding`, that is the delivery layer's vocabulary and the store's
 *, while the condition surfaced through `email.inbound.status` and the health
 * entry carries the reason and its own remedial step.
 */
function resolveNoticeRoute(
  configManager: ConfigManager,
  routeBindings: InboundMailCompositionOptions['routeBindings'],
  channelOwner: InboundMailCompositionOptions['channelOwner'],
): NoticeRouteAnswer {
  if (!routeBindings.isRouteBindingEnabled()) {
    return {
      kind: 'unavailable',
      reason: 'route-binding-disabled',
      detail: 'route binding is switched off, so the daemon has no notice routes at all and '
        + 'every arriving message is being recorded without ever being announced.',
      fix: 'Set integrations.routeBinding to true, or set surfaces.email.inbound.notice.mode to '
        + '"none" if recording without announcing is what you want.',
    };
  }
  const configured = configManager.get('surfaces.email.inbound.notice.route');
  if (typeof configured === 'string' && configured.trim().length > 0 && configured.trim() !== 'default') {
    const named = routeBindings.getBinding(configured.trim());
    if (named) return { kind: 'bound', binding: named };
    return {
      kind: 'unavailable',
      reason: 'notice-route-not-found',
      detail: `surfaces.email.inbound.notice.route names the route binding "${configured.trim()}", `
        + 'and there is no binding with that id.',
      fix: 'Point surfaces.email.inbound.notice.route at a binding that exists, or set it back to '
        + '"default" to use the route you most recently reached the daemon on.',
    };
  }
  // The default is the owner's own: the newest one-to-one conversation with
  // the owner (or a private-by-nature surface), never a group or a shared
  // channel, however recently it was used. A shared one is used only when
  // notice.route names it.
  const bindings = routeBindings.listBindings();
  const owners = new Map<string, string | undefined>();
  const ownerOf = (surface: string): string | undefined => {
    if (!owners.has(surface)) owners.set(surface, channelOwner(surface));
    return owners.get(surface);
  };
  let newest: AutomationRouteBinding | null = null;
  for (const binding of bindings) {
    if (!isOwnerConversation(binding, ownerOf(binding.surfaceKind))) continue;
    if (newest === null || binding.lastSeenAt > newest.lastSeenAt) newest = binding;
  }
  if (newest !== null) return { kind: 'bound', binding: newest };
  if (bindings.length > 0) {
    return {
      kind: 'unavailable',
      reason: 'no-owner-route',
      detail: 'none of the connected conversations is a one-to-one conversation with the owner, and arriving '
        + 'mail is announced by default only there, never in a group or shared channel.',
      fix: 'Message the daemon directly from your own account on a connected channel, or point '
        + 'surfaces.email.inbound.notice.route at the route binding (shared or not) that should hear about it.',
    };
  }
  return {
    kind: 'unavailable',
    reason: 'no-route-binding',
    detail: 'no channel has ever been connected, so there is no route to announce arriving mail '
      + 'on and every message is being recorded silently.',
    fix: 'Connect a channel the daemon can reach you on (Telegram, Slack, ntfy, …), or point '
      + 'surfaces.email.inbound.notice.route at an existing route binding.',
  };
}

/** The binding for a send, or `undefined` so the delivery helper refuses by its own name. */
function noticeBindingFor(
  configManager: ConfigManager,
  routeBindings: InboundMailCompositionOptions['routeBindings'],
  channelOwner: InboundMailCompositionOptions['channelOwner'],
): AutomationRouteBinding | undefined {
  const route = resolveNoticeRoute(configManager, routeBindings, channelOwner);
  return route.kind === 'bound' ? route.binding : undefined;
}

function readNoticeMode(configManager: ConfigManager): InboundNoticeMode {
  const mode = configManager.get('surfaces.email.inbound.notice.mode');
  return mode === 'none' || mode === 'expected-only' ? mode : 'all';
}

function readNumberSetting(configManager: ConfigManager, key: Parameters<ConfigManager['get']>[0], fallback: number): number {
  const value = configManager.get(key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build the inbound-mail supervisor and register its verbs, or answer `null`
 * when this composition watches no mailbox.
 *
 * `null` is not a failure and it is not silence: `BuiltinChannelRuntime`
 * reports at ERROR when inbound mail is enabled and nothing was composed, and
 * the cluster registration declines to contest a surface this node cannot
 * serve, a node that won that election would stand every other node down and
 * then read nothing.
 */
export function composeInboundMail(
  options: InboundMailCompositionOptions,
): InboundMailSupervisor | null {
  const { configManager, shellPaths } = options;
  const surfaceSettings = readSurfaceEmailSettings(configReaderWithOrigins(configManager));
  const watched = readWatchedAccounts(configManager);
  // The mailbox is read whenever it is configured, not only when notices are
  // on: the inbox reads through this same reader. Its account label is the
  // first watched account, or the mail user when none is named.
  const account = watched?.account ?? surfaceSettings.username?.trim();
  if (account === undefined || account.length === 0) return null;

  const mailbox = surfaceSettings.mailbox ?? DEFAULT_MAILBOX;
  const readerKey = mailboxReaderKey({ host: surfaceSettings.imapHost, user: surfaceSettings.username, mailbox });
  const readers = readerKey === null ? undefined : options.mailboxReaders;

  const storePath = (name: string): string => shellPaths.resolveUserPath('daemon', name);
  const cursors = new MailboxCursorStore(storePath('email-inbound-cursors.json'), {
    // Reaping a cursor whose account left the config is the store's first
    // rule, and it needs to know what "in config" means: any listed account,
    // read now, so a further mailbox keeps its place while it is listed.
    isAccountConfigured: (candidate) => candidate === account
      || (readWatchedAccounts(configManager)?.further.includes(candidate) ?? false),
  });
  // One reader per mailbox on this machine: a second daemon finds the lease held and does not sign in.
  const readerLease = (name: string) => () => holdProcessLock(storePath(
    `email-inbound-reader-${createHash('sha256').update(name).digest('hex').slice(0, 24)}.lock`));
  const records = new InboundMailStore(storePath('email-inbound-records.json'), {
    policy: {
      retentionMs: readNumberSetting(configManager, 'surfaces.email.inbound.retentionDays', 30) * 86_400_000,
      maxRecords: readNumberSetting(configManager, 'surfaces.email.inbound.maxRecords', 5_000),
    },
  });
  const expectationStore = new PersistedExpectationStore(storePath('email-inbound-expectations.json'));
  const housekeeper = new InboundMailHousekeeper({
    cursors,
    records,
    expectations: expectationStore,
    disclosurePath: storePath('email-inbound-housekeeping.json'),
  });

  // Declared before the registry and assigned after the supervisor, so the
  // registry can ASK for the live capability verdict without either object
  // having to be constructed twice. The probe answers `null` until the
  // supervisor exists and until it has probed anything, which is the honest
  // answer: nothing has looked at the mailbox yet.
  let supervisor: InboundMailSupervisor | undefined;

  const expectationWindowMs = readNumberSetting(
    configManager, 'surfaces.email.inbound.expectationWindowMinutes', 15,
  ) * 60_000;

  const expectations = new InboundExpectationRegistry({
    store: expectationStore,
    defaultWindowMs: expectationWindowMs,
    // An expectation opened against a mailbox already known
    // unreadable is refused at open time, so the workstream learns now rather
    // than from a fifteen-minute silence it cannot tell from "nothing came".
    capability: () => supervisor?.capability ?? null,
    onExpired: (report) => {
      // An expectation that ends without its message fails with a named
      // reason and is REPORTED, rather than lapsing into silence.
      logger.warn(
        report.reason === 'capability-lost'
          ? 'A verification expectation was failed because the mailbox stopped being readable'
          : 'A verification expectation expired without a matching message',
        {
          surface: 'email-inbound',
          expectation: report.id,
          serviceDomain: report.serviceDomain,
          reason: report.reason,
          ...(report.capabilityReason === undefined ? {} : { capabilityReason: report.capabilityReason }),
          detail: report.detail,
        },
      );
    },
  });

  const readSettings = (): InboundWatcherSettings => resolveWatcherSettings({
    account,
    mailbox,
    mode: readInboundMode(configManager),
    pollIntervalMs: readNumberSetting(configManager, 'surfaces.email.inbound.pollIntervalSeconds', 120) * 1_000,
    idleReissueMs: readNumberSetting(configManager, 'surfaces.email.inbound.idleReissueMinutes', 27) * 60_000,
    maxBackoffMs: readNumberSetting(configManager, 'surfaces.email.inbound.reconnect.maxBackoffSeconds', 300) * 1_000,
    capabilityRecheckMs: readNumberSetting(configManager, 'surfaces.email.inbound.capabilityRecheckMinutes', 60) * 60_000,
  });
  // Each field reads the owner's current setting when the source factory builds a source (it spreads or
  // reads this object then), so a changed cadence applies at the next source start instead of at a daemon restart.
  const settings = {} as InboundWatcherSettings;
  for (const key of Object.keys(readSettings()) as (keyof InboundWatcherSettings)[]) {
    Object.defineProperty(settings, key, { enumerable: true, get: () => readSettings()[key] });
  }

  // ONE instance, shared by the intake that writes it and the supervisor that
  // reports it. Two instances would be two answers to "is the owner being told", and
  // the one the status verb read would be the one nothing wrote to.
  const noticeHealth = createInboundNoticeHealth();

  // The announcer tells the owner about terminal
  // failures; the registry has to know about them too, because an expectation
  // is a promise to watch a mailbox and a mailbox that cannot be read makes
  // that promise unkeepable. Composed here rather than folded into the
  // announcer: they are two consumers of one fact, and an announcer that also
  // retired expectations would be doing something its name does not say.
  //
  // `capabilityChanged` itself is the one that decides what to fail, a
  // `degraded` transition (reconnecting, backing off) fails NOTHING, because
  // the reconnect fetches everything above the cursor.
  const announcer = createInboundTerminalFailureAnnouncer({
    send: (notice) => options.deliverStructuredNotice(
      noticeBindingFor(configManager, options.routeBindings, options.channelOwner),
      notice,
    ),
  });
  const observer: InboundMailObserver = {
    terminalFailure: (failure) => { announcer.terminalFailure(failure); },
    stateChanged: (transition) => {
      announcer.stateChanged(transition);
      void expectations.capabilityChanged(transition.to).catch((error: unknown) => {
        // The watcher must keep running whatever happens here, and the owner
        // must not be left thinking expectations were retired when they were
        // not. Reported rather than swallowed.
        logger.error('Open expectations could not be failed after a capability change', {
          surface: 'email-inbound',
          reason: transition.to.reason,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    },
    // The intake, the watcher and the Gmail source report what happened to a
    // message here (a failed delivery, a notice refused, a cursor reset, a lost
    // connection). With no handler these reached nothing at all.
    note: (note) => {
      const fields = { surface: 'email-inbound', kind: note.kind, mailbox: note.mailbox, detail: note.detail };
      // Routine progress is debug; anything that means mail is waiting, was
      // skipped or went unannounced is a warning someone should see.
      if (note.kind === 'delta-drained' || note.kind === 'idle-reissued' || note.kind === 'expunge-observed') {
        logger.debug('Inbound mail', fields);
      } else if (note.kind === 'cursor-established') {
        logger.info('Inbound mail', fields);
      } else {
        logger.warn('Inbound mail', fields);
      }
    },
  };

  /**
   * The reader resolved by the start that is happening right now.
   *
   * `InboundMailSupervisor.start()` asks `selectionFacts()` and then, if the
   * selection came out `gmail`, asks the factory to build the source. Those are
   * two steps of ONE decision, so the second must use the credential the first
   * decided on. Resolving twice would open the credential store twice and, on a
   * revocation landing between them, would build a source over a grant the
   * selection had not approved.
   *
   * Reset to null before every resolve so a stale reader can never serve a
   * later start: a restart after a credential was removed must see `null`, not
   * the reader the previous start happened to obtain.
   */
  let resolved: GmailInboundReaderResolution | null = null;

  const gmailBuilder: GmailSourceBuilder = async (input) => {
    const resolution = resolved ?? await options.gmailReader();
    if (resolution.kind !== 'ready') return null;
    return new GmailMailSource({
      account: input.account,
      mailbox: input.mailbox,
      history: resolution.reader.history,
      currentHistoryId: resolution.reader.currentHistoryId,
      // The first-run history window for a consumer that shows the mailbox (the inbox).
      ...(resolution.reader.listRecentMessageIds ? { listRecentMessageIds: resolution.reader.listRecentMessageIds } : {}),
      cursors,
      sink: input.sink,
      clock: systemWatcherClock,
      // The predicate, not the registry: §2.1's structural rule is that a
      // source must not hold anything that could OPEN an expectation, and a
      // closure over a presence question is a boolean where the registry would
      // be a capability. See `ExpectationPresence` in gmail-source.ts.
      //
      // `hasOpen()` rather than `list().length > 0`, and that is a correctness
      // fix rather than a tidier spelling. `list()` reaped what it found
      // expired and dropped the reports, and this predicate runs every five
      // seconds while an expectation is open, far faster than the thirty-second
      // reporting sweep, so it won the race every time and a verification that
      // never arrived expired without anybody being told. See
      // `InboundExpectationRegistry.hasOpen`.
      expectationOpen: () => expectations.hasOpen(),
      // An opening wakes the idle wait at once, so the wait is one timer
      // rather than a wake-up every pollExpectingMs for the whole interval.
      expectationOpened: (wake) => expectations.onOpened(wake),
      // The owner's own cadence, read from their two Gmail poll settings by
      // `source-factory.ts` at CREATE time and handed in here. Not re-read:
      // one key, one reader. A second read in this file would be a second
      // answer to the same question, and the config gate cannot see the
      // difference because it accepts either call form.
      pollExpectingMs: input.pollExpectingMs,
      pollIdleMs: input.pollIdleMs,
      // The same re-probe wait the IMAP path uses, from the same setting, so a
      // refused grant is re-asked at one interval rather than two. Also handed
      // in, from the `settings` this file resolved and passed to the factory.
      capabilityRecheckMs: input.capabilityRecheckMs,
      // `surfaces.email.inbound.onInsufficientCapability`, read once by
      // `source-factory.ts` at CREATE time and handed in, one key, one reader,
      // the rule the two poll intervals are annotated with above. Re-reading it
      // here would be a second answer to a question that decides whether the
      // daemon announces mail it can never act on.
      capabilityPolicy: input.capabilityPolicy,
      // The supervisor's observer, which forwards to `observer` above. Handing
      // the source `observer` directly went around the supervisor, so its
      // status never heard a Gmail verdict change after start: a held refusal
      // that recovered stayed `inactive`, and one that started failing stayed
      // `running`.
      observer: input.observer,
    });
  };

  // One intake for every watched mailbox: the same records, expectations and notice route.
  const handle = createInboundMailIntake({
    expectations: expectations.matcher,
    records,
    notices: {
      resolveBinding: () => resolveNoticeRoute(configManager, options.routeBindings, options.channelOwner),
      // The binding the route was resolved to, by its id: never a second resolution that could pick another.
      send: (notice, binding) => options.deliverStructuredNotice(
        binding ? options.routeBindings.getBinding(binding.id) : undefined,
        notice,
      ),
    },
    noticeMode: () => readNoticeMode(configManager),
    now: () => new Date(),
    noticeHealth,
  });

  supervisor = new InboundMailSupervisor({
    config: configManager,
    account,
    mailbox,
    sources: options.sources ?? createInboundMailSourceFactory({
      getConfigurationIncarnation: () => configManager.getConfigurationIncarnation?.(),
      onDidChangeConfiguration: (listener) => configManager.onDidChangeIncarnation?.(listener) ?? (() => {}),
      getConfig: configReaderWithOrigins(configManager),
      secrets: options.secretsManager,
      transport: nodeEmailTransport,
      cursors,
      settings,
      gmail: gmailBuilder,
    }),
    // Asked at every start, so a Google credential adopted after boot is seen
    // on the next start rather than at the next restart.
    //
    // `googleAdopted` is the answer from a composition that actually opened the
    // credential and asked Google for the mailbox, not, as it was, the
    // presence of an injected builder that nothing ever injected. When it is
    // false the reason travels with it, because "no account connected", "the
    // grant was refused" and "Google could not be reached" need three different
    // actions and used to arrive as one silent `false`.
    selectionFacts: async () => {
      resolved = null;
      const resolution = await options.gmailReader();
      resolved = resolution;
      if (resolution.kind !== 'ready') {
        return {
          googleAdopted: false,
          mailAccountIsGmail: false,
          gmailUnavailable: `${resolution.detail}${resolution.fix === '' ? '' : ` ${resolution.fix}`}`,
        };
      }
      return {
        googleAdopted: true,
        mailAccountIsGmail: isGmailMailbox(configManager, account, resolution.reader.address),
      };
    },
    cursors,
    records,
    expectations,
    expectationPolicy: expectationStore,
    housekeeper,
    noticeHealth,
    handle,
    // §3.4b: a terminal state is ANNOUNCED, not merely recorded. This used to
    // be a `logger.error` and nothing else, the once-per-transition tracker
    // built, and its sink a log line, for the one condition that means no mail
    // will ever arrive again. It goes to the owner through the same structured
    // notice port arriving mail goes through, and still logs.
    observer,
    readerLease: readerLease(`${account}\n${mailbox}`),
    ...(readers !== undefined && readerKey !== null ? { consumers: () => readers.consumers(readerKey) } : {}),
  });
  if (readers !== undefined && readerKey !== null) {
    const reader = supervisor;
    readers.register(readerKey, {
      requestHistory: () => { reader.requestHistory(); },
      consumersChanged: () => { reader.consumersChanged(); },
    });
  }

  // Everything below runs while the supervisor runs and is released when it stops, so a node that handed the
  // mailbox over (or a stopped daemon) neither sweeps nor writes the stores and does not keep listeners.
  // The expectation sweep sits beside the housekeeper rather than inside the supervisor's start because
  // `email.expectation.open` can register an expectation while no source is running, so it also starts here.
  const expectationSweepMs = expectationSweepIntervalMs(expectationWindowMs);
  let releaseBackground: (() => void) | null = null;
  const attachBackground = (): void => {
    if (releaseBackground) return;
    // The existing supervisor rebuilds same-identity sources after source retirement.
    // A different account/mailbox still requires a fresh composition with new sinks.
    const unsubscribeConfig = configManager.onDidChangeIncarnation?.(() => queueMicrotask(() => {
      supervisor?.recheckNow();
      // A changed notice route may deliver what the old one could not.
      if (handle.heldNotices() > 0) void handle.sendHeldNotices();
    }));
    const unsubscribeCredentials = options.secretsManager.onDidInvalidateCredentials?.(() => {
      if (!options.secretsManager.getCredentialMutationState?.().pending) supervisor?.recheckNow();
    });
    // Switching notices off ends any refusal: nothing is being refused any
    // more, and switching them back on must not revive a refusal from before.
    const clearRefusalWhenOff = (): void => {
      if (readNoticeMode(configManager) === 'none') noticeHealth.clear('notices were switched off');
    };
    clearRefusalWhenOff();
    const unsubscribeNoticeMode = configManager.subscribe('surfaces.email.inbound.notice.mode', clearRefusalWhenOff);
    housekeeper.start(6 * 60 * 60_000);
    expectations.startSweeping(expectationSweepMs);
    // Notices held when the route was down before a restart are still owed.
    void handle.sendHeldNotices();
    releaseBackground = () => {
      unsubscribeConfig?.(); unsubscribeCredentials?.(); unsubscribeNoticeMode();
      handle.stop();
      housekeeper.stop(); expectations.stopSweeping();
      releaseBackground = null;
    };
  };
  // Each further account is its own supervisor over the same stores and intake,
  // built from its own entry in surfaces.email.inbound.mailboxes. Its failures
  // reach the owner through an announcer of its own; they do not fail open
  // expectations, which the first mailbox can still satisfy.
  const furtherObserver = (): InboundMailObserver => {
    const own = createInboundTerminalFailureAnnouncer({
      send: (notice) => options.deliverStructuredNotice(noticeBindingFor(configManager, options.routeBindings, options.channelOwner), notice),
    });
    return {
      terminalFailure: (failure) => { own.terminalFailure(failure); },
      stateChanged: (transition) => { own.stateChanged(transition); },
      note: (note) => { observer.note?.(note); },
    };
  };
  const further = new FurtherMailboxes(configManager, (entry) => new InboundMailSupervisor({
    config: { get: entry.config as unknown as ConfigManager['get'] },
    account: entry.account,
    mailbox: entry.mailbox,
    sources: options.sources ?? createInboundMailSourceFactory({
      getConfigurationIncarnation: () => configManager.getConfigurationIncarnation?.(),
      onDidChangeConfiguration: (listener) => configManager.onDidChangeIncarnation?.(listener) ?? (() => {}),
      getConfig: entry.config,
      secrets: options.secretsManager,
      password: { ref: entry.passwordRef, setting: `surfaces.email.inbound.mailboxes.${entry.account}.passwordRef` },
      transport: nodeEmailTransport,
      cursors,
      settings,
    }),
    // Read over IMAP only: the Google credential reads the daemon's own mailbox.
    selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
    cursors,
    records,
    expectations,
    expectationPolicy: expectationStore,
    housekeeper,
    // The first mailbox's start sweeps the shared stores and restores expectations.
    restoresStores: false,
    noticeHealth,
    handle,
    observer: furtherObserver(),
    readerLease: readerLease(`${entry.account}\n${entry.mailbox}`),
  }));

  const startSupervisor = supervisor.start.bind(supervisor);
  const stopSupervisor = supervisor.stop.bind(supervisor);
  const recheckSupervisor = supervisor.recheckNow.bind(supervisor);
  const supervisorHealth = supervisor.health.bind(supervisor);
  const describeSupervisor = supervisor.describeStatus.bind(supervisor);
  supervisor.start = async () => {
    // The owner's routes are read from disk on first use. Mail that arrived
    // while the daemon was down is read the moment the source starts, so the
    // routes are loaded first: otherwise that mail finds no route and is
    // recorded as never announced. Routes that cannot be read do not stop the
    // reader: the mail is still recorded, and the missing route is reported.
    try { await options.routeBindings.start(); }
    catch (error) {
      logger.warn('Inbound mail started without the owner\'s channel routes', { surface: 'email-inbound', detail: error instanceof Error ? error.message : String(error) });
    }
    attachBackground();
    const [status] = await Promise.all([startSupervisor(), further.start()]);
    return status;
  };
  supervisor.stop = async () => {
    try { await Promise.all([stopSupervisor(), further.stop()]); } finally { releaseBackground?.(); }
  };
  supervisor.recheckNow = () => { recheckSupervisor(); further.recheckNow(); };
  supervisor.health = () => further.foldHealth(supervisorHealth());
  // The snapshot's health is read through `health()` above, so it already names the further mailboxes.
  supervisor.describeStatus = async () => {
    const snapshot = await describeSupervisor();
    return { ...snapshot, reason: snapshot.health.reason };
  };

  registerEmailExpectationGatewayMethods(options.gatewayMethods, expectations, () => supervisor?.status ?? { running: false, reason: 'The inbound mail supervisor is not available.' });
  registerEmailInboundStatusGatewayMethod(options.gatewayMethods, supervisor);
  // Six hours is right for reaping records off disk; it is not right for a promise measured in
  // minutes, so the expectation sweep runs on its own cadence.
  attachBackground();
  return supervisor;
}

/** One further account's mailbox, read from `surfaces.email.inbound.mailboxes`. */
interface FurtherMailboxEntry {
  readonly account: string;
  readonly mailbox: string;
  readonly passwordRef: string;
  /** The mailbox settings as this account's supervisor and source read them; see `furtherMailboxConfig`. */
  readonly config: ConfigReaderWithOrigins;
  /** Changes when anything that decides how this mailbox is reached changes. */
  readonly signature: string;
}

type FurtherMailboxReading =
  | { readonly kind: 'watch'; readonly entry: FurtherMailboxEntry }
  | { readonly kind: 'unwatched'; readonly account: string; readonly reason: string };

/** The secret a further account's password is read from when its entry names none. */
function furtherMailboxPasswordKey(account: string): string {
  const name = account.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `GOODVIBES_EMAIL_INBOUND_${name.length > 0 ? name : 'ACCOUNT'}_PASSWORD`;
}

/** Every account after the first, each with the mailbox it is watched on or why it is not watched. */
function readFurtherMailboxes(configManager: ConfigManager): readonly FurtherMailboxReading[] {
  const names = readWatchedAccounts(configManager)?.further ?? [];
  if (names.length === 0) return [];
  const raw = configManager.get('surfaces.email.inbound.mailboxes');
  let table: Record<string, unknown> = {};
  if (typeof raw === 'string' && raw.trim().length > 0) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return names.map((account): FurtherMailboxReading => ({
        kind: 'unwatched',
        account,
        reason: 'surfaces.email.inbound.mailboxes is not a JSON object; set it to {"<account>":{"host":"…","user":"…"}}',
      }));
    }
    table = parsed as Record<string, unknown>;
  }
  return names.map((account) => readFurtherMailbox(configManager, account, table[account]));
}

function readFurtherMailbox(configManager: ConfigManager, account: string, value: unknown): FurtherMailboxReading {
  const unwatched = (reason: string): FurtherMailboxReading => ({ kind: 'unwatched', account, reason });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return unwatched(`it has no entry in surfaces.email.inbound.mailboxes; add "${account}": {"host":"…","user":"…"} there`);
  }
  const fields = value as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const field = fields[key];
    return typeof field === 'string' && field.trim().length > 0 ? field.trim() : undefined;
  };
  const host = text('host');
  const user = text('user');
  if (host === undefined || user === undefined) {
    return unwatched('its entry in surfaces.email.inbound.mailboxes needs both host and user');
  }
  const secure = fields['secure'] !== false;
  if (!secure && !isLoopbackHost(host)) {
    return unwatched(`its entry sets secure to false for ${host}, which would send the password in plain text and is allowed only for a loopback host; set secure to true`);
  }
  const rawPort = fields['port'];
  if (rawPort !== undefined && !(typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65_535)) {
    return unwatched('the port in its entry must be a whole number from 1 to 65535');
  }
  const port = typeof rawPort === 'number' ? rawPort : undefined;
  const mailbox = text('mailbox') ?? DEFAULT_MAILBOX;
  const passwordRef = text('passwordRef') ?? `goodvibes://secrets/goodvibes/${encodeURIComponent(furtherMailboxPasswordKey(account))}`;
  const parsedRef = parseEmailSecretRef(`surfaces.email.inbound.mailboxes.${account}.passwordRef`, passwordRef);
  if ('problem' in parsedRef) return unwatched(parsedRef.problem);
  return {
    kind: 'watch',
    entry: {
      account,
      mailbox,
      passwordRef,
      config: furtherMailboxConfig(configManager, { account, host, port, secure, user, mailbox }),
      signature: JSON.stringify([host, port ?? null, secure, user, mailbox, passwordRef]),
    },
  };
}

/**
 * The mailbox settings a further account's supervisor and source read: the
 * `surfaces.email.*` keys that say which mailbox and how to reach it answer
 * from the account's own entry (forced to IMAP, keyed on its own account
 * name), and every inbound behaviour setting answers from the shared config,
 * so all mailboxes are watched the same way.
 */
function furtherMailboxConfig(
  configManager: ConfigManager,
  mailbox: {
    readonly account: string;
    readonly host: string;
    readonly port: number | undefined;
    readonly secure: boolean;
    readonly user: string;
    readonly mailbox: string;
  },
): ConfigReaderWithOrigins {
  const shared = configReaderWithOrigins(configManager);
  const own: Readonly<Record<string, unknown>> = {
    'surfaces.email.host': mailbox.host,
    'surfaces.email.imap.host': mailbox.host,
    'surfaces.email.imap.port': mailbox.port,
    'surfaces.email.imap.secure': mailbox.secure,
    'surfaces.email.user': mailbox.user,
    'surfaces.email.imap.user': mailbox.user,
    'surfaces.email.from': mailbox.user,
    'surfaces.email.imap.mailbox': mailbox.mailbox,
    // The first mailbox's password settings never apply here; the source is given this account's own.
    'surfaces.email.password': '',
    'surfaces.email.imap.password': '',
    'surfaces.email.inbound.source': 'imap',
    'surfaces.email.inbound.accounts': JSON.stringify([mailbox.account]),
  };
  const read = (key: string): unknown => (key in own ? own[key] : shared(key));
  return Object.assign(read, {
    isSet: (key: string): boolean => {
      if (key === 'surfaces.email.imap.port') return mailbox.port !== undefined;
      return key in own || (shared.isSet?.(key) ?? false);
    },
  });
}

/**
 * The supervisors of the accounts after the first, kept in step with
 * `surfaces.email.inbound.accounts` and `surfaces.email.inbound.mailboxes`.
 * Read again on every recheck (each settings write asks for one), so a mailbox
 * added, changed or removed takes effect without a restart; an account whose
 * entry is missing or unusable is named in the health entry with its fix.
 */
class FurtherMailboxes {
  private readonly held = new Map<string, { readonly signature: string; readonly supervisor: InboundMailSupervisor }>();
  private unwatched: readonly { readonly account: string; readonly reason: string }[] = [];
  private wanted = false;
  /** Reconciles run one after another, so two quick settings writes never build one account twice. */
  private settling: Promise<void> = Promise.resolve();

  constructor(
    private readonly configManager: ConfigManager,
    private readonly build: (entry: FurtherMailboxEntry) => InboundMailSupervisor,
  ) {}

  start(): Promise<void> {
    this.wanted = true;
    return this.reconcile();
  }

  stop(): Promise<void> {
    this.wanted = false;
    return this.reconcile();
  }

  recheckNow(): void {
    if (!this.wanted) return;
    void this.reconcile().catch((error: unknown) => {
      logger.error('Further inbound mailboxes could not be brought in line with the settings', {
        surface: 'email-inbound',
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private reconcile(): Promise<void> {
    const next = this.settling.then(() => this.apply());
    this.settling = next.catch(() => undefined);
    return next;
  }

  private async apply(): Promise<void> {
    const readings = this.wanted ? readFurtherMailboxes(this.configManager) : [];
    const unwatched: { readonly account: string; readonly reason: string }[] = [];
    const desired = new Map<string, FurtherMailboxEntry>();
    for (const reading of readings) {
      if (reading.kind === 'watch') desired.set(reading.entry.account, reading.entry);
      else unwatched.push({ account: reading.account, reason: reading.reason });
    }
    this.unwatched = unwatched;
    const stopping: Promise<void>[] = [];
    for (const [account, held] of this.held) {
      if (desired.get(account)?.signature === held.signature) continue;
      this.held.delete(account);
      stopping.push(held.supervisor.stop());
    }
    await Promise.all(stopping);
    const starting: Promise<unknown>[] = [];
    for (const [account, entry] of desired) {
      const held = this.held.get(account);
      if (held) {
        held.supervisor.recheckNow();
        continue;
      }
      const supervisor = this.build(entry);
      this.held.set(account, { signature: entry.signature, supervisor });
      starting.push(supervisor.start());
    }
    await Promise.all(starting);
  }

  /** The first mailbox's health entry with every further mailbox's state folded into it. */
  foldHealth(first: InboundMailHealthEntry): InboundMailHealthEntry {
    if (first.state === 'disabled' || (this.held.size === 0 && this.unwatched.length === 0)) return first;
    const others = [...this.held.values()].map(({ supervisor }) => supervisor.health());
    const clauses = [
      ...others.map((health) => `${health.account} (${health.mailbox}) is ${health.state}: ${health.reason}`),
      ...this.unwatched.map((entry) => `${entry.account} is not watched: ${entry.reason}`),
    ];
    const allHealthy = this.unwatched.length === 0 && others.every((health) => health.state === 'healthy');
    return {
      ...first,
      state: first.state === 'healthy' && !allHealthy ? 'degraded' : first.state,
      reason: `${first.reason} Further mailboxes: ${clauses.join('; ')}.`,
      metadata: {
        ...first.metadata,
        mailboxes: others.map((health) => ({
          account: health.account,
          mailbox: health.mailbox,
          state: health.state,
          mode: health.mode,
          reason: health.reason,
        })),
        unwatchedAccounts: this.unwatched,
      },
    };
  }
}

function readInboundMode(configManager: ConfigManager): 'idle' | 'poll' | 'auto' {
  const mode = configManager.get('surfaces.email.inbound.mode');
  return mode === 'idle' || mode === 'poll' ? mode : 'auto';
}

/**
 * Whether the mailbox this node watches is one the adopted Google credential
 * can read.
 *
 * **The credential is the evidence. Configuration is a filter over it.** That
 * ordering is the fix, and the previous ordering is why this had to be fixed
 * twice.
 *
 * A resolved reader means `users.getProfile` answered: the credential works,
 * and it names the address those credentials read. That is a fact obtained from
 * Google. The previous version asked instead whether the first entry of
 * `surfaces.email.inbound.accounts` equalled that address, which made a
 * configuration convention the source of truth, and the convention does not
 * hold. The schema calls that key a list of "mailbox account identifiers, e.g.
 * `["primary"]`", its description is what the owner reads when they set it,
 * and `sameAddress('primary', 'owner@gmail.com')` is false. So an owner who
 * connected Google, turned inbound mail on and filled the key in the way its
 * own description tells them to got `mailAccountIsGmail: false`, `auto` chose
 * IMAP, and, with no IMAP host configured, which is the whole premise of this
 * path, the factory answered `null`: the exact end state the Gmail
 * construction fix was written to close. Only a key holding a full Gmail
 * address made it work, and the test that covered it set one.
 *
 * So the question this asks is no longer "does config prove it is Gmail" but
 * "does config name a DIFFERENT mailbox". Three arms:
 *
 * **The account names an address.** It is compared, because an owner who wrote
 * an address meant that mailbox. Equal to the connected one is direct evidence.
 * Different, and Gmail's API cannot read it, unless the configured IMAP host
 * is a Google one, which is the Workspace-custom-domain case below.
 *
 * **The account is an identifier, and no IMAP host is configured.** Nothing
 * names another mailbox, and a working Google credential does name one. True.
 * This is the owner's machine.
 *
 * **The account is an identifier and an IMAP host IS configured.** The owner
 * has pointed this watcher at a specific server; whether it is a Gmail mailbox is
 * that host's domain to answer, exactly as before.
 *
 * The IMAP-host test is unchanged and still right when it fires: an address at
 * a Google Workspace custom domain is a Gmail mailbox whatever it looks like,
 * and an `@gmail.com` address forwarded into somebody else's IMAP server is
 * not.
 */
function isGmailMailbox(
  configManager: ConfigManager,
  account: string,
  connectedAddress: string,
): boolean {
  const host = (readSurfaceEmailSettings(configReaderWithOrigins(configManager)).imapHost ?? '')
    .trim().toLowerCase();
  if (namesAnAddress(account)) {
    if (sameAddress(account, connectedAddress)) return true;
    return isGoogleHost(host);
  }
  // No host configured: nothing in this machine's configuration names a mailbox
  // other than the one the credential reads, and the credential resolved. That
  // is direct evidence, not a fallback, `resolveGmailInboundReader` has
  // already proved the grant works and asked Google which address it belongs
  // to. An `unavailable` resolution never reaches here at all; the caller
  // answers `mailAccountIsGmail: false` with the reader's own reason.
  if (host.length === 0) return true;
  return isGoogleHost(host);
}

/**
 * Whether an `accounts` entry is an email address or a mailbox identifier.
 *
 * The schema allows both, `["primary"]` is its own example, and they mean
 * different things here: an address is a claim about WHICH mailbox and gets
 * compared, an identifier is a label for this watcher and claims nothing.
 * Treating an identifier as an address is what produced a false negative for
 * every owner who followed the description.
 *
 * A local part, an `@`, and a dotted domain. Deliberately not RFC 5322: this
 * only has to separate `owner@gmail.com` from `primary`, and a permissive
 * pattern that accepted `primary` as an address would put it straight back on
 * the arm that compares.
 */
function namesAnAddress(account: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.trim());
}

/** Whether a configured IMAP host is one of Google's. Takes it already normalized. */
function isGoogleHost(host: string): boolean {
  return /(^|\.)(gmail\.com|googlemail\.com|google\.com)$/.test(host);
}

/**
 * Address equality, case-folded and trimmed, and nothing cleverer.
 *
 * Deliberately NOT Gmail's dot-and-plus folding. Deciding that
 * `o.wner+tag@gmail.com` is the same mailbox as `owner@gmail.com` would be this
 * file inventing a provider rule, and being wrong about it means watching a
 * mailbox the owner did not name. An address that needs folding is one the
 * owner can write the way Google reports it.
 */
function sameAddress(left: string, right: string): boolean {
  const normalize = (value: string): string => value.trim().toLowerCase();
  const a = normalize(left);
  return a.length > 0 && a === normalize(right);
}
