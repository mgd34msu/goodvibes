import { attachDaemonInboxTagging, type DaemonTriageTaggingActivation } from './tagged-inbox-composition.js';
import { createMultiOwnerDaemonInboxFactory } from './multiowner-inbox-composition.js';
import { createInboxRouteResolver } from '@goodvibes-jev/engine/platform/platform/channels';
import type { ClusterClock } from '@goodvibes-jev/engine/platform/platform/cluster';
import { ownAccountInboxStore } from './account-inbox-store.js';
import { atInboxBuildStage, type InboxBuildStage } from './inbox-admission-refusal.js';
/** Explicit single-account mail inbox; does not enable all-provider default serve. */
import { realpath } from 'node:fs/promises';
import { configReaderWithOrigins, createSurfaceEmailInboxConfigReader, mailboxReaderKey } from '@goodvibes-jev/engine/platform/platform/email';
import { createEmailInboxOwner, acquireAccountInboxIdentity, registerInboxSurface, createOwnedInboxSource, createOwnedTriagedInboxSource,
  type EmailInboxAccount, type EmailInboxOwner, type EmailInboxScreening, type InboxSurfaceRegistration, type InboxTriageAuthority } from '@goodvibes-jev/engine/platform/platform/intake';
import type { DaemonInboxSourceFactory } from './multiowner-inbox-composition.js';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';

export interface EmailDaemonInboxOptions {
  /** Separately established semantic destination/account grant, never inferred from screening. */
  readonly triageAuthority?: InboxTriageAuthority;
  readonly triageTagging?: DaemonTriageTaggingActivation;
  /** Expected TLS endpoint/account/mailbox established by the trusted host. */
  readonly account: EmailInboxAccount;
  /** The privacy screening route, or `unscreened` when there is none: the mail is kept and each row says it was not screened. */
  readonly screening: EmailInboxScreening;
  /**
   * The selected account's lifetime: aborted by the selector's setting and
   * credential subscriptions. With it, that is the only currentness check.
   */
  readonly operation?: { readonly signal: AbortSignal; assertCurrent(): void } | undefined;
}
export interface EmailDaemonInboxFactories {
  readonly createOwner?: (...args: Parameters<typeof createEmailInboxOwner>) => EmailInboxOwner;
  readonly registerSurface?: typeof registerInboxSurface;
  /** Constructor-only deterministic clock, never decoded from configuration. */
  readonly eligibilityClock?: ClusterClock;
}

/** Independently owned email account, with no canonical method binding. */
export interface EmailDaemonInboxSourceFactories extends Omit<EmailDaemonInboxFactories, 'registerSurface'> {
  readonly createSource?: typeof createOwnedInboxSource;
}

export function createEmailDaemonInboxSourceFactory(options: EmailDaemonInboxOptions,
  factories: EmailDaemonInboxSourceFactories = {}): DaemonInboxSourceFactory {
  const authority = options.triageAuthority;
  return createEmailAccountFactory(options, factories, factories.createSource ?? ((context, source, owner, beforeIdentityWrite, beforeReceiptWrite) =>
    createOwnedTriagedInboxSource(context, { ...source, providerId: 'email', accountScopeId: owner.scopeId,
      ...(owner.triageStoreFileName ? { triageStoreFileName: owner.triageStoreFileName } : {}),
      beforeIdentityWrite, beforeReceiptWrite,
      acquireReadLease: () => owner.acquireReadLease(), ...(authority ? { authority } : {}),
    })));
}

export function createEmailDaemonInboxFactory(options: EmailDaemonInboxOptions,
  factories: EmailDaemonInboxFactories = {}): DaemonInboxFactory {
  if (!factories.registerSurface || options.triageTagging || options.triageAuthority) {
    if (factories.registerSurface) throw new Error('Triage requires an owned source, not a legacy registrar');
    return createMultiOwnerDaemonInboxFactory([createEmailDaemonInboxSourceFactory(options, factories)]);
  }
  return createEmailAccountFactory(options, factories, factories.registerSurface ?? registerInboxSurface);
}

function createEmailAccountFactory<T extends InboxSurfaceRegistration>(options: EmailDaemonInboxOptions,
  factories: Pick<EmailDaemonInboxFactories, 'createOwner' | 'eligibilityClock'>,
  register: (context: Parameters<DaemonInboxFactory>[0], options: Parameters<typeof registerInboxSurface>[1], owner: EmailInboxOwner,
    beforeIdentityWrite: (() => void) | undefined, beforeReceiptWrite: ((receiptVersion?: 3 | 4) => void) | undefined) => T | Promise<T>,
): (...args: Parameters<DaemonInboxFactory>) => Promise<T> {
  const triageTagging = options.triageTagging ? Object.freeze({ onReady: options.triageTagging.onReady }) : undefined;
  if (triageTagging && typeof triageTagging.onReady !== 'function') throw new Error('Triage tagging requires an explicit owner callback');
  return async (context, routing, controls) => {
    if (triageTagging && (!controls.createTriageTagging || !controls.onAccountInvalidation)) throw new Error('Triage tagging requires the canonical daemon permission and credential owners');
    const resolveProfileId = routing.resolveProfileId.bind(routing);
    const resolveRouteId = createInboxRouteResolver({
      getProfileForChannel: resolveProfileId, resolveProfile: resolveProfileId,
    });
    // The canonical daemon mailbox has no separate enable switch. Its shared
    // reader derives readiness from configured endpoint/account fields.
    const mailConfig = createSurfaceEmailInboxConfigReader(configReaderWithOrigins(context.configManager));
    const clustered = context.configManager.get('cluster.enabled') === true;
    if (clustered && !controls.gatePollingOwned) throw new Error('Clustered inbox requires owned gate retirement');
    const selected = options.operation;
    const current = selected ? (): void => { selected.assertCurrent(); } : (): void => {
      if ((context.configManager.get('cluster.enabled') === true) !== clustered
        || mailConfig('email.enabled') !== true) throw new Error('Email inbox requires enabled stable cluster mode');
    };
    current();
    // The mailbox reader is the only thing that reads this mailbox; the inbox is one of its consumers.
    const readers = controls.mailboxReaders;
    const readerKey = mailboxReaderKey({ host: options.account.host, user: options.account.username, mailbox: options.account.mailbox });
    if (!readers || readerKey === null) throw new Error('Email inbox requires the mailbox reader it consumes');
    const workingDirectory = await realpath(context.workingDirectory);
    current();
    let owner: EmailInboxOwner;
    let identity: Awaited<ReturnType<typeof acquireAccountInboxIdentity>>;
    let stage: InboxBuildStage = 'identity';
    try {
      identity = await acquireAccountInboxIdentity({ workingDirectory, assertCurrent: current,
        beforeWrite: controls.beforeAccountIdentityWrite }, { provider: 'email', account: options.account });
      current();
      stage = 'owner';
      owner = (factories.createOwner ?? createEmailInboxOwner)({ identity, account: options.account,
        screening: options.screening, assertCurrent: current, resolveRouteId,
        ...(controls.onOwnerMail ? { onMail: controls.onOwnerMail } : {}) });
    } catch (error) {
      throw atInboxBuildStage('email', stage, error);
    }
    const selectedOwner = owner;
    let detach: (() => void) | undefined;
    let released = false;
    const result = await ownAccountInboxStore({
      provider: 'email', controls, workingDirectory, clustered, owner: selectedOwner, assertCurrent: current,
      ...(factories.eligibilityClock ? { eligibilityClock: factories.eligibilityClock } : {}),
      // Placed by the mailbox reader's own surface; this store contests nothing.
      placedByReader: true,
      prepare: current,
      electionScope: () => selectedOwner.scopeId,
      register: async store => register({ ...context, workingDirectory }, {
        adapters: new Map([['email', selectedOwner.adapter]]), beforeSourceRevisionWrite: controls.beforeSourceRevisionWrite, ...store,
        acquireReadLease: () => selectedOwner.acquireReadLease(),
      }, selectedOwner, controls.beforeInboxTriageIdentityWrite, controls.beforeInboxTriageReceiptWrite),
      releaseExtras: () => { released = true; detach?.(); },
    });
    // Attached once the mirror is open, so the first batch has somewhere to go;
    // a mirror the reader never fed asks it for the history window once.
    void result.ready.then(() => {
      if (released) return;
      detach = readers.attach(readerKey, selectedOwner.consumer, { requestHistory: selectedOwner.needsHistory() });
    }, () => {});
    return triageTagging ? attachDaemonInboxTagging(result, triageTagging, controls, {
      provider: 'email', accountScopeId: selectedOwner.scopeId, assertCurrent: current,
      imap: { host: selectedOwner.account.host, port: selectedOwner.account.port, user: selectedOwner.account.username, mailbox: selectedOwner.account.mailbox },
    }) : result;
  };
}
