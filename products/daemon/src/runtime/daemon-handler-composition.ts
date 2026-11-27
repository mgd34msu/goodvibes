import type { DaemonTriagePermissionHost, DaemonTriageTaggingRequest } from './tagged-inbox-composition.js';
import type { OwnedInboxTagging, OwnerMailObservation } from '@goodvibes/engine/platform/platform/intake';
/** Product host surfaces over canonical engine implementations. */
import type { MailboxReaders } from '@goodvibes/engine/platform/platform/email';
import { registerOwnedMailInbox } from './owned-inbox-mail.js';
import type { ConfigKey, ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { createDaemonCredentialStore } from '@goodvibes/engine/platform/platform/config';
import { clusterRoleGate, type ClusterCoordinator } from '@goodvibes/engine/platform/platform/cluster';
import type { GatewayMethodCatalog, NativeMutationHost } from '@goodvibes/engine/platform/platform/control-plane';
import { registerRoutingMethods, registerDraftMethods, type ChannelDeliveryRouter } from '@goodvibes/engine/platform/platform/channels';
import type { DistributedRuntimeManager } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { InboxPollingControl, RegisterInboxSurfaceOptions } from '@goodvibes/engine/platform/platform/intake';
import { registerDaemonHandlers, type DaemonHandlerSurfaces, type RoutingRegistration } from '../daemon/handlers/index.js';
import type { HandlerContext, HandlerLogger, OwnedHandlerSurface } from '../daemon/handlers/context.js';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import { daemonReceiptStoreAt, daemonReceiptsPath } from '@goodvibes/engine/platform/platform/daemon/receipts';
import { createPaymentsServices } from './payments-composition.js';
import { mergeKeepingGetters } from './merge-keeping-getters.js';
import { recordGroupSpend } from '@goodvibes/engine/platform/platform/payments';
import { createOwnerMailRelay, OWNER_MAIL_PENDING_FILE } from './owner-mail-relay.js';
import { controlPlaneStorePath } from '@goodvibes/engine/platform/platform/control-plane';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { inboxPollerGate } from './cluster-composition.js';
import type { ShellPathService } from './index.js';
import type { SecretsManager } from '../config/secrets.js';
import type { BrowserCheckoutSeamHolder } from './browser-checkout-seam-holder.js';
import type { HostedInboxScreeningAcquisition, HostedInboxScreeningOperation, HostedInboxScreeningSource } from './hosted-source-screening-composition.js';

/**
 * Required while the built-in adapter/triage product port remains incomplete.
 * Tests supply fixture adapters to the real inbox registrar. There is no empty
 * production default and this seam is not evidence of built-in provider parity.
 */
export interface DaemonInboxControls extends Required<Pick<RegisterInboxSurfaceOptions, 'gatePolling'>> {
  /** Publish the admitted native reader floor before opaque Discord identity data. */
  readonly beforeDiscordIdentityWrite?: (() => void) | undefined;
  readonly beforeAccountIdentityWrite?: (() => void) | undefined;
  readonly beforeInboxTriageIdentityWrite?: (() => void) | undefined;
  readonly beforeSourceRevisionWrite?: (() => void) | undefined;
  readonly beforeInboxTriageReceiptWrite?: ((receiptVersion?: 3 | 4) => void) | undefined;
  /** Root-owned capability; only explicit source options request it. */
  readonly createTriageTagging?: (request: DaemonTriageTaggingRequest) => OwnedInboxTagging;
  /** Explicit awaitable election withdrawal for account-verified clustered owners. */
  readonly gatePollingOwned?: (providerId: string, control: InboxPollingControl) => () => Promise<void>;
  /** Subscribe to local config/credential revocation without exposing secrets. */
  readonly onAccountInvalidation?: (listener: () => void) => () => void;
  /** Subscribe to changes of one provider's own settings and credentials (inbox-provider-facts.ts). */
  readonly onProviderInvalidation?: (provider: import('./inbox-provider-facts.js').InboxProvider, listener: () => void) => () => void;
  /** Value-free notifications from the native configuration owner. */
  readonly onConfigurationChange?: (key: ConfigKey, listener: () => void) => () => void;
  /** Receives each screened message on the owner's mailbox (see owner-mail-relay.ts). */
  readonly onOwnerMail?: ((mail: OwnerMailObservation) => void) | undefined;
  /** Where the email inbox attaches to the mailbox reader the daemon facade composes. */
  readonly mailboxReaders?: MailboxReaders | undefined;
  /** Native exact-pair consent, privately resolved credentials and revocable source lifetime. */
  readonly acquireHostedScreening?: (source: HostedInboxScreeningSource, operation: HostedInboxScreeningOperation) => Promise<HostedInboxScreeningAcquisition>;
}

export type DaemonInboxFactory = (
  context: HandlerContext,
  routing: RoutingRegistration,
  options: DaemonInboxControls,
) => OwnedHandlerSurface | Promise<OwnedHandlerSurface>;

export interface DaemonHandlerCompositionOptions {
  readonly paymentContinuationOwner?: import('./payments-composition.js').PaymentsCompositionOptions['paymentContinuationOwner'];
  readonly nativeDataWriter?: import('@goodvibes/engine/platform/platform/runtime/self-update').NativeDataWriteOwner | undefined;
  readonly triagePermissionHost?: DaemonTriagePermissionHost;
  readonly nativeMutationHost?: NativeMutationHost | undefined;
  readonly hasProfile?: ((profileId: string) => boolean) | undefined;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly secretsManager: SecretsManager;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly shellPaths: ShellPathService;
  readonly distributedRuntime: DistributedRuntimeManager;
  /** Startup is owned by the root, not by the borrowed remote surface. */
  readonly distributedRuntimeReady: Promise<void>;
  readonly clusterCoordinator: ClusterCoordinator;
  readonly checkoutSeam: BrowserCheckoutSeamHolder['get'];
  readonly channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver'> & Partial<Pick<ChannelDeliveryRouter, 'deliverWithReceipt'>>;
  readonly inboxFactory: DaemonInboxFactory;
  /** Purchase notices are posted here as well as on the configured channels. */
  readonly ownerInbox?: import('./payments-composition.js').PaymentsCompositionOptions['ownerInbox'];
  /** The meeting point the daemon facade's mailbox readers register on. */
  readonly mailboxReaders?: MailboxReaders | undefined;
  /** Its entries can name where an inbox provider's credential is stored. */
  readonly serviceRegistry?: { get(serviceName: string): object | null } | undefined;
  /** The authority record; in a group the day's payment spend is counted on it. */
  readonly authorityRecord?: import('@goodvibes/engine/platform/platform/cluster').AuthorityRecordFile | undefined;
  /** A group member's name from the roster, for referring the owner to the machine that runs a role. */
  readonly clusterMemberName?: ((nodeId: string) => string | null) | undefined;
}

/** Return only after each real surface is ready; failed acquisition rolls back. */
export async function createDaemonHandlerComposition(
  options: DaemonHandlerCompositionOptions,
): Promise<DaemonHandlerSurfaces> {
  if (typeof options.inboxFactory !== 'function') {
    throw new Error('An explicit daemon inbox factory is required until built-in provider composition is restored.');
  }
  // The platform logger reaches the daemon log and activity trail; a raw
  // console write would leave a refused inbox or payments source invisible there.
  const asData = (meta: unknown): Record<string, unknown> | undefined =>
    meta === undefined ? undefined : typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta as Record<string, unknown> : { detail: meta };
  const handlerLogger: HandlerLogger = {
    info: (message, meta) => logger.info(message, asData(meta)),
    warn: (message, meta) => logger.warn(message, asData(meta)),
    error: (message, meta) => logger.error(message, asData(meta)),
  };
  const handlerContext: HandlerContext = {
    catalog: options.gatewayMethods,
    credentials: createDaemonCredentialStore(options.secretsManager),
    configManager: options.configManager,
    workingDirectory: options.workingDirectory,
    homeDirectory: options.homeDirectory,
    logger: handlerLogger,
    recordReceipt: (text) => { daemonReceiptStoreAt(daemonReceiptsPath(options.configManager)).record(text); },
    ...(options.nativeMutationHost ? { nativeMutationHost: options.nativeMutationHost } : {}),
    ...(options.hasProfile ? { hasProfile: options.hasProfile } : {}),
  };
  // Every screened owner mail stays in this durable list until payments has checked it against the purchases.
  const ownerMail = createOwnerMailRelay({
    pendingPath: controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, OWNER_MAIL_PENDING_FILE),
  });
  return registerDaemonHandlers(handlerContext, {
    registerRouting: registerRoutingMethods,
    registerInbox: (ctx, routing) => registerOwnedMailInbox(options.inboxFactory, ctx, routing, {
      // Each provider is elected separately; standby nodes still serve storage.
      gatePolling: (providerId, control) => options.clusterCoordinator.register(inboxPollerGate(providerId, control)),
      beforeDiscordIdentityWrite: () => options.nativeDataWriter?.declare('discord-inbox-identities-v1'),
      beforeAccountIdentityWrite: () => options.nativeDataWriter?.declare('account-inbox-identities-v1'),
      beforeInboxTriageIdentityWrite: () => options.nativeDataWriter?.declare('inbox-triage-identities-v1'),
      beforeSourceRevisionWrite: () => options.nativeDataWriter?.declare('inbox-triage-source-revisions-v1'),
      beforeInboxTriageReceiptWrite: receiptVersion => {
        options.nativeDataWriter?.declare('inbox-triage-model-receipts-v2');
        options.nativeDataWriter?.declare('inbox-triage-account-bindings-v1');
        if (receiptVersion === 3) options.nativeDataWriter?.declare('inbox-triage-failed-bindings-v3');
        if (receiptVersion === 4) options.nativeDataWriter?.declare('inbox-triage-source-revisions-v1');
      },
      gatePollingOwned: (providerId, control) => options.clusterCoordinator.registerOwned(inboxPollerGate(providerId, control)),
      onOwnerMail: ownerMail.observe,
      ...(options.mailboxReaders ? { mailboxReaders: options.mailboxReaders } : {}),
    }, { configManager: options.configManager, secretsManager: options.secretsManager,
      ...(options.serviceRegistry ? { serviceRegistry: options.serviceRegistry } : {}) }, options.triagePermissionHost),
    registerDrafts: registerDraftMethods,
    registerPayments: () => {
      const coordinator = options.clusterCoordinator;
      const services = createPaymentsServices({
        paymentContinuationOwner: options.paymentContinuationOwner,
        nativeDataWriter: options.nativeDataWriter,
        gatewayMethods: options.gatewayMethods,
        configManager: options.configManager,
        secretsManager: options.secretsManager,
        shellPaths: options.shellPaths,
        // One machine in a group runs payments: the holder of the payments
        // role, which the cluster election gives to exactly one machine at a
        // time. Alone, this machine holds it.
        isPaymentsLeader: () => coordinator.holdsRole('payments'),
        // The day's spend is counted across the group: a role that moves mid-day
        // leaves one daily budget, not one per machine that held it.
        // Each day's spend is kept per currency: the ledger names the currency of every draw.
        ...(coordinator.enabled && options.authorityRecord ? { groupSpend: recordGroupSpend(options.authorityRecord) } : {}),
        paymentsHolder: () => {
          const holder = coordinator.roleHolder('payments');
          return holder === null ? null : options.clusterMemberName?.(holder) ?? holder;
        },
        checkoutSeam: options.checkoutSeam,
        channelDeliveryRouter: options.channelDeliveryRouter,
        ownerMail,
        ownerInbox: options.ownerInbox,
      });
      if (!coordinator.enabled) return services;
      // Contest the role; a machine that takes it recovers the checkouts a
      // previous holder left interrupted here before it buys anything new.
      const withdraw = coordinator.registerOwned(clusterRoleGate('payments', () => services.recoverAsLeader()));
      const close = (): Promise<void> => Promise.allSettled([withdraw(), services.close()]).then((results) => {
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
      });
      return mergeKeepingGetters(services, { close, unregister: () => { void close().catch(() => {}); } });
    },
  });
}
