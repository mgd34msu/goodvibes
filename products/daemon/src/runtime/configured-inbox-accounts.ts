/** Native account selectors remain independent of permission to screen message text. */
import { configReaderWithOrigins, createSurfaceEmailInboxConfigReader } from '@goodvibes-jev/engine/platform/platform/email';
import { triageAuthorityFromScreening, type EmailInboxAccount, type SlackInboxAccount, type OwnedInboxSource, type OwnedInboxRead, type ProviderStatus } from '@goodvibes-jev/engine/platform/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/platform/platform/security';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';
import type { DaemonInboxSourceFactory } from './multiowner-inbox-composition.js';
import { createSlackDaemonInboxSourceFactory, type SlackDaemonInboxSourceFactories } from './slack-inbox-composition.js';
import { createEmailDaemonInboxSourceFactory, type EmailDaemonInboxSourceFactories } from './email-inbox-composition.js';
import { createConfiguredDiscordDaemonInboxSourceFactory, parseConfiguredDiscordInboxAccount, type ConfiguredDiscordInboxAccount, type DiscordDaemonInboxSourceFactories } from './discord-inbox-composition.js';
import type { HostedInboxScreeningOperation } from './hosted-source-screening-composition.js';
import { INBOX_ADMISSION_ACTIONS, InboxAdmissionRefusal, inboxAdmissionClearsOnItsOwn, inboxAdmissionReason, inboxAdmissionRefusalOf, inboxBuildStage,
  type InboxAdmissionReason } from './inbox-admission-refusal.js';

type Context = Parameters<DaemonInboxFactory>[0];
type Controls = Parameters<DaemonInboxFactory>[2];

// A selected account lives until one of its provider's own settings or
// credentials changes (inbox-provider-facts.ts): every `surfaces.<provider>.*`
// key, the cluster switch, the screening consent and credentials. A write of
// anything else leaves it, its store and its poller running.
function selectedAccount<T>(context: Context, controls: Controls, provider: 'slack' | 'email' | 'discord',
  read: () => T): { account: T; operation: HostedInboxScreeningOperation; close(): void } {
  if (!controls.onProviderInvalidation) throw new Error('Configured inbox requires native account subscriptions');
  const lifetime = new AbortController();
  const subscriptions: Array<() => void> = [];
  let closed = false;
  let closeFailure: AggregateError | undefined;
  const close = () => {
    if (closed) { if (closeFailure) throw closeFailure; return; }
    closed = true; lifetime.abort();
    const failures: unknown[] = [];
    for (const unsubscribe of subscriptions.reverse()) { try { unsubscribe(); } catch (error) { failures.push(error); } }
    if (failures.length) {
      closeFailure = new AggregateError(failures, 'Configured inbox account subscriptions did not close');
      throw closeFailure;
    }
  };
  try {
    subscriptions.push(controls.onProviderInvalidation(provider, () => lifetime.abort()));
    // The one currentness check for every layer of this account: the
    // subscription above aborts the lifetime on a write to any fact it depends on,
    // so no layer re-reads them. A settings file whose provider section was
    // quarantined at load is the one fact a key read cannot show.
    const assertCurrent = (): void => {
      const quarantine = context.configManager.getIngestionQuarantine?.();
      if (closed || lifetime.signal.aborted || !quarantine || quarantine.some(entry => entry.key === '(whole file)' || entry.key === 'surfaces'
        || entry.key === `surfaces.${provider}` || entry.key.startsWith(`surfaces.${provider}.`))) {
        throw new InboxAdmissionRefusal('settings-changing', 'Configured inbox account changed or is unavailable');
      }
    };
    assertCurrent();
    const account = read();
    assertCurrent();
    return { account, operation: { signal: lifetime.signal, assertCurrent }, close };
  } catch (error) { close(); throw error; }
}

/** The innermost cause's error name and errno-style code: which failure it was, without its message. */
function failureKind(error: unknown): { readonly name?: string; readonly code?: string } {
  let current: unknown = error;
  let name: string | undefined, code: string | undefined;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    if (current instanceof Error) name = current.name;
    const own = Object.getOwnPropertyDescriptor(current, 'code');
    if (own && 'value' in own && typeof own.value === 'string' && /^E[A-Z0-9_]{2,30}$/.test(own.value)) code = own.value;
    const cause = Object.getOwnPropertyDescriptor(current, 'cause');
    current = cause && 'value' in cause ? cause.value : undefined;
  }
  return { ...(name === undefined ? {} : { name }), ...(code === undefined ? {} : { code }) };
}

function boundedName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 320 && value.trim() === value && !/[\r\n\0]/.test(value);
}

export function selectConfiguredSlackInboxAccount(context: Context, controls: Controls) {
  return selectedAccount(context, controls, 'slack', (): SlackInboxAccount => {
    const reader: { get(key: string): unknown } = context.configManager;
    const workspaceId = reader.get('surfaces.slack.workspaceId'), userId = reader.get('surfaces.slack.inboxUserId');
    if (reader.get('surfaces.slack.enabled') !== true || !boundedName(workspaceId) || workspaceId.length > 200
      || !boundedName(userId) || userId.length > 200) throw new InboxAdmissionRefusal('account-incomplete', 'Slack inbox requires its expected workspace and user identity');
    return Object.freeze({ workspaceId, userId });
  });
}

export function selectConfiguredEmailInboxAccount(context: Context, controls: Controls) {
  return selectedAccount(context, controls, 'email', (): EmailInboxAccount => {
    const mail = createSurfaceEmailInboxConfigReader(configReaderWithOrigins(context.configManager));
    const host = mail('email.imapHost'), username = mail('email.username'), mailbox = mail('email.mailbox');
    const port = mail('email.imapPort');
    if (!boundedName(host) || !boundedName(username) || !boundedName(mailbox)
      || mail('email.imapSecurity') !== 'tls' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new InboxAdmissionRefusal('account-incomplete', 'Email inbox requires its expected TLS host, account, port and mailbox');
    }
    return Object.freeze({ host, username, mailbox, port, security: 'tls' });
  });
}

export function selectConfiguredDiscordInboxAccount(context: Context, controls: Controls) {
  return selectedAccount(context, controls, 'discord', (): ConfiguredDiscordInboxAccount => {
    if (context.configManager.get('surfaces.discord.enabled') !== true) {
      throw new InboxAdmissionRefusal('account-incomplete', 'Discord inbox requires its expected bot and one-to-one DM registry');
    }
    const parsed = parseConfiguredDiscordInboxAccount(context.configManager);
    if ('incomplete' in parsed) throw new InboxAdmissionRefusal('account-incomplete', parsed.incomplete);
    return parsed.account;
  });
}

/** Selected account lifetime encloses acquisition and every original provider operation. */
export function createConfiguredHostedInboxSourceFactory(provider: 'slack' | 'email' | 'discord',
  factories: { readonly slack?: SlackDaemonInboxSourceFactories; readonly email?: EmailDaemonInboxSourceFactories;
    readonly discord?: DiscordDaemonInboxSourceFactories } = {}): DaemonInboxSourceFactory {
  return async (context, routing, controls) => {
    if (!controls.acquireHostedScreening) throw new Error('Configured inbox requires native hosted screening consent and credentials');
    const selection = provider === 'slack' ? selectConfiguredSlackInboxAccount(context, controls)
      : provider === 'email' ? selectConfiguredEmailInboxAccount(context, controls) : selectConfiguredDiscordInboxAccount(context, controls);
    let acquisition: Awaited<ReturnType<NonNullable<Controls['acquireHostedScreening']>>> | undefined;
    let source: OwnedInboxSource | undefined;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) closing = (async () => {
        // Abort first, drain the source, then release its acquisition subscriptions.
        const failures: unknown[] = [];
        try { selection.close(); } catch (error) { failures.push(error); }
        try { await source?.close(); } catch (error) { failures.push(error); }
        try { await acquisition?.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Configured inbox source did not close cleanly');
      })();
      return closing;
    };
    try {
      acquisition = await controls.acquireHostedScreening(provider === 'slack' ? 'slack-inbox'
        : provider === 'email' ? 'email-inbox' : 'discord-bot-dms', selection.operation);
      selection.operation.assertCurrent();
      const screening: ProtectedSourceOwnerOptions = acquisition.options;
      // Triage asks on the same model route screening was admitted on, and stops with it.
      const triageAuthority = triageAuthorityFromScreening(provider, undefined, screening);
      const operation = selection.operation;
      if (provider === 'slack' && 'workspaceId' in selection.account) {
        source = await createSlackDaemonInboxSourceFactory({ account: selection.account, screening, triageAuthority, operation }, factories.slack)(context, routing, controls);
      } else if (provider === 'email' && 'host' in selection.account) {
        source = await createEmailDaemonInboxSourceFactory({ account: selection.account, screening, triageAuthority, operation }, factories.email)(context, routing, controls);
      } else if (provider === 'discord' && 'channelIds' in selection.account) {
        source = await createConfiguredDiscordDaemonInboxSourceFactory(screening, factories.discord,
          { account: selection.account, operation, triageAuthority })(context, routing, controls);
      } else throw new Error('Configured inbox account family changed');
      selection.operation.assertCurrent();
      return { ...source, close, unregister() { void close().catch(() => {}); } };
    } catch (error) { await close(); throw error; }
  };
}

/**
 * After a failed admission the source retries on its own, because the event
 * that would normally trigger a replacement (a settings or credential write
 * settling) may already have fired while admission was being refused. A
 * failure that clears without anyone acting (a busy store, an edit in
 * progress, an untyped failure such as a provider outage) keeps retrying at
 * the last delay until it is admitted; the others stop after the last delay
 * and wait for the settings or credential write that fixes them.
 */
const ADMISSION_RETRY_DELAYS_MS: readonly number[] = Object.freeze([2_000, 10_000, 60_000]);

export interface ReacquiringInboxOptions {
  /** Backoff between admission retries, the last one repeated for failures that clear on their own; an empty list disables retrying. */
  readonly retryDelaysMs?: readonly number[] | undefined;
  /** Schedules a callback and returns its canceller. Injected so tests own time. */
  readonly schedule?: ((callback: () => void, delayMs: number) => () => void) | undefined;
}

function scheduleWithTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * What a source whose account is not admitted answers a read with: no items and
 * a provider status that says `unavailable` and why. It carries no provider
 * data, and it fails its currentness check as soon as the source is replaced or
 * closed, so a composite read over several providers still serves the others.
 */
function unavailableRead(provider: string, reason: InboxAdmissionReason | 'reacquiring',
  assertSourceCurrent: () => void): OwnedInboxRead {
  let released = false;
  // `polled` is true so the wire shows `error` with the reason rather than a
  // `pending` that would read as "still starting": the admission result is settled.
  const status: ProviderStatus = { id: provider, state: 'unavailable', configured: true, itemCount: 0, polled: true, error: reason };
  const current = (): void => { if (released) throw new Error('Inbox read is retired'); assertSourceCurrent(); };
  return {
    providerIds: [provider],
    release: () => { released = true; },
    assertCurrent: current,
    async validate() { current(); },
    sources: {
      store: { listItems: () => [], countItems: () => 0, countItemsByProvider: () => new Map(),
        maxSequence: () => 0, getImapCheckpoint: () => null },
      poller: { snapshotStatuses: selected => !selected || selected.includes(provider) ? [{ ...status }] : [],
        isProviderRunning: () => false },
    },
  };
}

/** Replace a revoked native source only after its real storage and poll owners drain. */
export function createReacquiringDaemonInboxSourceFactory(provider: 'slack' | 'email' | 'discord',
  factory: DaemonInboxSourceFactory, options: ReacquiringInboxOptions = {}): DaemonInboxSourceFactory {
  const retryDelays = options.retryDelaysMs ?? ADMISSION_RETRY_DELAYS_MS;
  const schedule = options.schedule ?? scheduleWithTimer;
  return (context, routing, controls) => {
    const onProvider = controls.onProviderInvalidation;
    if (!onProvider) throw new Error('Native inbox source requires account invalidation');
    // Only this provider's own settings and credentials replace the source.
    const subscribe = (listener: () => void): (() => void) => onProvider(provider, listener);
    const lifetime = new AbortController();
    let revision = 0;
    let closed = false;
    let requested = false;
    let retirementFailed = false;
    let admissionFailure: { readonly error: unknown; readonly reason: InboxAdmissionReason } | undefined;
    let retryAttempts = 0;
    let cancelRetry: (() => void) | undefined;
    let current: OwnedInboxSource | undefined;
    let retiring: Promise<void> = Promise.resolve();
    let running: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    const unavailable = () => new Error('Native inbox account is unavailable');
    const retire = (source: OwnedInboxSource): Promise<void> => {
      let draining: Promise<void>;
      try { draining = source.close(); } catch (error) { draining = Promise.reject(error); }
      retiring = Promise.allSettled([retiring, draining]).then(results => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) {
          retirementFailed = true;
          throw new AggregateError(failures.map(result => result.reason), 'Native inbox source retirement failed');
        }
      });
      void retiring.catch(() => {});
      return retiring;
    };
    const retireCurrent = (): void => {
      const previous = current;
      current = undefined;
      if (previous) void retire(previous).catch(() => {});
    };
    // Closing this facade also revokes an account that is still being acquired.
    const scoped = (listener: () => void): (() => void) => {
      if (closed) throw unavailable();
      const stopNative = subscribe(listener);
      const stop = () => listener();
      lifetime.signal.addEventListener('abort', stop, { once: true });
      return () => { lifetime.signal.removeEventListener('abort', stop); stopNative(); };
    };
    // The account, its owners and its screening see this provider's changes only.
    const ownedControls: Controls = { ...controls, onAccountInvalidation: scoped,
      onProviderInvalidation: (requested, listener) => {
        if (requested !== provider) throw new Error('Native inbox source asked for another provider\'s changes');
        return scoped(listener);
      } };
    const stopRetry = (): void => {
      const cancel = cancelRetry;
      cancelRetry = undefined;
      try { cancel?.(); } catch { /* A timer that cannot be cancelled still finds the source closed. */ }
    };
    const retryAdmission = (): void => {
      if (closed || retirementFailed || cancelRetry || retryDelays.length === 0) return;
      const persistent = admissionFailure !== undefined && inboxAdmissionClearsOnItsOwn(admissionFailure.reason);
      if (retryAttempts >= retryDelays.length && !persistent) return;
      const delay = retryDelays[Math.min(retryAttempts++, retryDelays.length - 1)]!;
      cancelRetry = schedule(() => {
        cancelRetry = undefined;
        if (closed || retirementFailed || current) return;
        requested = true;
        void queue().catch(() => {});
      }, delay);
    };
    const reconcile = async (): Promise<void> => {
      while (requested && !closed && !retirementFailed) {
        requested = false;
        await retiring;
        if (closed || retirementFailed) return;
        const captured = revision;
        let candidate: OwnedInboxSource | undefined;
        try {
          candidate = await factory(context, routing, ownedControls);
          await candidate.ready;
          if (candidate.providerIds.length !== 1 || candidate.providerIds[0] !== provider) {
            throw new Error('Native inbox source membership changed');
          }
          if (closed || captured !== revision) {
            await retire(candidate);
            continue;
          }
          current = candidate;
          admissionFailure = undefined;
          retryAttempts = 0;
          stopRetry();
        } catch (error) {
          const reason = inboxAdmissionReason(error);
          admissionFailure = { error, reason };
          if (candidate) await retire(candidate);
          if (retirementFailed) throw error;
          // Mutation onset can legitimately refuse new admission, and the
          // notification that would replace this source may already have
          // fired, so retry on its own as well (see ADMISSION_RETRY_DELAYS_MS). A retired owner
          // is never reused. The fixed reason is reported with the build step
          // that failed and the innermost cause's error name and errno-style
          // code; the message can sit next to account or credential material
          // and stays out.
          const stage = inboxBuildStage(error);
          try {
            context.logger.warn('Native inbox source admission is unavailable', {
              provider, reason, ...(stage ? { stage } : {}), action: INBOX_ADMISSION_ACTIONS[reason], ...failureKind(error),
            });
          } catch { /* Reporting cannot grant admission. */ }
          retryAdmission();
        }
      }
    };
    const queue = (): Promise<void> => {
      requested = true;
      if (running) return running;
      const work = Promise.resolve().then(reconcile);
      running = work;
      const settled = () => {
        if (running === work) running = undefined;
        if (requested && !closed && !retirementFailed) void queue().catch(() => {});
      };
      void work.then(settled, settled);
      return work;
    };
    const changed = (): void => {
      if (closed) return;
      revision++;
      retireCurrent();
      // A fresh native notification replaces the failure state and the backoff.
      admissionFailure = undefined;
      retryAttempts = 0;
      stopRetry();
      void queue().catch(() => {});
    };
    const unsubscribe = subscribe(changed);
    const ready = queue().then(() => {
      if (closed || retirementFailed) throw unavailable();
      if (!current) {
        // An account that cannot be admitted yet degrades this provider alone:
        // reads report it unavailable with the reason. So does a provider
        // account owner that could not be built (the provider unreachable at
        // boot): no store was leased or opened yet. Any other failure still
        // stops the start, because it may mean unproven storage.
        if (admissionFailure && (inboxAdmissionRefusalOf(admissionFailure.error)
          || inboxBuildStage(admissionFailure.error) === 'owner')) return;
        if (admissionFailure) throw admissionFailure.error;
        throw unavailable();
      }
    });
    void ready.catch(() => {});
    const close = (): Promise<void> => {
      if (closing) return closing;
      const deferred = Promise.withResolvers<void>();
      closing = deferred.promise;
      closed = true; revision++;
      stopRetry();
      const failures: unknown[] = [];
      try { lifetime.abort(); } catch (error) { failures.push(error); }
      try { unsubscribe(); } catch (error) { failures.push(error); }
      retireCurrent();
      void (async () => {
        const acquisition = await Promise.allSettled([running]);
        if (acquisition[0]?.status === 'rejected') failures.push(acquisition[0].reason);
        try { await retiring; } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Native inbox source did not close cleanly');
      })().then(deferred.resolve, deferred.reject);
      return closing;
    };
    return {
      providerIds: Object.freeze([provider]), ready, close,
      unregister() { void close().catch(() => {}); },
      getImapCheckpoint(providerId) {
        if (closed || !current || !current.getImapCheckpoint) throw unavailable();
        return current.getImapCheckpoint(providerId);
      },
      async acquireRead(requireFinalProof) {
        await ready;
        const source = current, captured = revision;
        if (closed || retirementFailed) throw unavailable();
        if (!source) {
          // Being rebuilt after its own settings changed: this provider reports
          // `reacquiring` and a composite read still serves the others.
          const reason = admissionFailure?.reason ?? (running ? 'reacquiring' : undefined);
          if (!reason) throw unavailable();
          return unavailableRead(provider, reason, () => {
            if (closed || captured !== revision || retirementFailed) throw unavailable();
          });
        }
        const read = await source.acquireRead(requireFinalProof);
        const assertCurrent = (): void => {
          if (closed || current !== source || captured !== revision || retirementFailed) throw unavailable();
          read.assertCurrent();
        };
        try { assertCurrent(); } catch (error) { read.release(); throw error; }
        return { ...read, assertCurrent, release: () => read.release(),
          async validate() { assertCurrent(); await read.validate(); assertCurrent(); },
        };
      },
    };
  };
}
