/**
 * The daemon-owned payments capability, adapted from pinned daemon 443e5ee.
 *
 * Stores retain the existing surface-scoped paths and daemon-tier secret port.
 * The serving browser seam is read through its current host-owned getter;
 * native graph composition installs it before handler acquisition, while the
 * browser engine and driver remain lazy.
 * Merchant semantics use the registered Jev reading, never the retired prompt
 * adapter. The returned inbox is the exact source used by the notifier: the
 * root must pass it to DaemonConfig.paymentReplies for channel ingress.
 *
 * This composition owns that inbox. Stop ingress, then await close before
 * releasing the graph or registering replacement handlers. A facade listener
 * restart borrows the inbox and must not close it. close retires checkout
 * admission and drains preflight, browser operations, interrupted recovery and
 * accepted reply readings before the stores/catalog can be reused.
 */
import { logger } from '@goodvibes/engine/platform/platform/utils';
import { controlPlaneStorePath } from '@goodvibes/engine/platform/platform/control-plane';
import type { GatewayMethodCatalog } from '@goodvibes/engine/platform/platform/control-plane';
import { createJevMerchantJudge, readCvvHandling, PaymentReplyInbox, reportOrderConfirmation, mailboxAddress, SecurityCodeRequests } from '@goodvibes/engine/platform/platform/payments';
import type { BudgetLedger, PaymentsConfigReader } from '@goodvibes/engine/platform/platform/payments';
import { getProcessUntrustedContentLedger } from '@goodvibes/engine/platform/platform/security';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { SecretsManager } from '../config/secrets.js';
import type { ChannelDeliveryRouter } from '@goodvibes/engine/platform/platform/channels';
import type { ShellPathService } from './index.js';
import {
  DaemonApprovalStore,
  DaemonCardStore,
  DaemonPurchaseLedger,
  DaemonStandingAuthorizations,
  DurableBudgetLedger,
  DurableCheckoutJournal,
  DurablePaymentOperations,
  MAX_PURCHASE_LIST_LIMIT,
  ProtectedPaymentRequests,
  confirmSubmittedPurchase,
  createNativeCheckoutWindowRestorer,
  channelBackedPaymentNotifier,
  configBackedAddressStore,
  readNotifyChannels,
  readPaymentsServiceConfig,
  withOwnerInbox,
  createLimitOffers,
  registerPaymentsMethods,
  type CheckoutComposition,
  type LimitOfferInbox,
  type PaymentNotifier,
  type RestoredInboxWindow,
  type PaymentsSecretStore,
} from '@goodvibes/engine/platform/platform/payments';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { BrowserCheckoutSeamHolder } from './browser-checkout-seam-holder.js';
import type { OwnerMailHandler, OwnerMailRelay } from './owner-mail-relay.js';

export interface PaymentsCompositionOptions {
  readonly paymentContinuationOwner?: Pick<import('@goodvibes/engine/platform/platform/payments').NativeCheckoutWindowRestorationOptions, 'pairing' | 'scopes'> | undefined;
  readonly nativeDataWriter?: import('@goodvibes/engine/platform/platform/runtime/self-update').NativeDataWriteOwner | undefined;
  /** `set` writes the owner's answer to a spending-limit offer; absent, no offer is made. */
  readonly configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'preparePostalAddress' | 'resolveForConsumer' | 'set'>>;
  readonly shellPaths: ShellPathService;
  readonly secretsManager: Pick<SecretsManager, 'get' | 'set' | 'delete'>;
  /** Binding the catalog is what turns the family from a 501 facade into handlers. */
  readonly gatewayMethods: GatewayMethodCatalog;
  /**
   * Whether this node is the one currently allowed to spend.
   *
   * Reported by `payments.budget.status` and never defaulted, see the platform's
   * gates.ts: on a clustered install the wrong answer is a double-spend.
   */
  readonly isPaymentsLeader: () => boolean;
  /**
   * In a group: where the other machines' spend is read and this machine's is
   * told (the authority record), so the daily budget is spent once in the group.
   */
  readonly groupSpend?: import('@goodvibes/engine/platform/platform/payments').GroupSpendSource | undefined;
  /** The name of the machine that runs payments when this one does not; named in the refusal. */
  readonly paymentsHolder?: (() => string | null) | undefined;
  /** Where the checkout pair reads the browser-checkout seam; see this file's header. */
  readonly checkoutSeam: BrowserCheckoutSeamHolder['get'];
  /** Delivers a purchase notice; the SAME router every other channel send in this daemon uses. */
  readonly channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver'> & Partial<Pick<ChannelDeliveryRouter, 'deliverWithReceipt'>>;
  /** Where the owner's mailbox hands over each screened message; absent means no order-confirmation reports. */
  readonly ownerMail?: Pick<OwnerMailRelay, 'attach'> | undefined;
  /**
   * The owner inbox: every purchase notice is also posted there and can be
   * answered there, so a window always reaches the owner (terminal apps and web
   * UI) whatever payments.notifyChannels names. A window that reached it is
   * resumed after a restart from the item's recorded answer. With the
   * key lookup, feed and claim of the daemon's inbox, the owner is also offered,
   * once per limit, to set a spending limit a purchase met unset.
   */
  readonly ownerInbox?: (RestoredInboxWindow['port'] & Partial<Pick<LimitOfferInbox, 'latestByKey' | 'subscribe' | 'take' | 'confirmDelivered'>>) | undefined;
}

/** Most messages remembered so a poll that offers one again is not reported twice. */
const REPORTED_MAIL_MEMORY = 512;

/**
 * Reads each message on the owner's mailbox against the purchase ledger and, when
 * it is about one purchase, sends the owner a report of that purchase through the
 * payment notifier: once per kind of mail (confirmed, shipped, delivered). A mail tied to a
 * purchase recorded as unverified moves it, and its operation, to purchased, and that report
 * says so. Messages are handled one at a time, each with one reading of
 * which recent purchase it is about (without a decision model: the owner is
 * asked, see confirmation-report.ts). Nothing here can fail the mailbox poll: a
 * failed reading or send is logged, and the message is forgotten so the
 * mailbox offering it again tries again.
 */
export function createOrderMailObserver(deps: {
  readonly purchases: Pick<DaemonPurchaseLedger, 'list'> & Partial<Pick<DaemonPurchaseLedger, 'recordRefund' | 'reportedMailKinds' | 'recordMailReported' | 'recordConfirmed' | 'get'>>;
  readonly notifier: Pick<PaymentNotifier, 'deliver'>;
  /** Absent: an unverified purchase stays unverified whatever the shop mails. */
  readonly operations?: Pick<DurablePaymentOperations, 'get' | 'recover'> | undefined;
}): OwnerMailHandler {
  const { recordConfirmed, get } = deps.purchases;
  const operations = deps.operations;
  const recordConfirmation = recordConfirmed && get && operations
    ? (purchaseId: string, orderNumber: string | null) => confirmSubmittedPurchase({
      purchases: { recordConfirmed: recordConfirmed.bind(deps.purchases), get: get.bind(deps.purchases) }, operations,
    }, purchaseId, orderNumber)
    : undefined;
  const seen = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  return (mail) => {
    // With no decision model in use the mail is still checked against the
    // ledger in code, and the owner is asked about a shop's mail nothing read.
    if (seen.has(mail.id)) return;
    seen.add(mail.id);
    if (seen.size > REPORTED_MAIL_MEMORY) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    tail = tail.then(async () => {
      const { purchases } = deps.purchases.list({ limit: MAX_PURCHASE_LIST_LIMIT, dayKey: undefined });
      if (purchases.length === 0) return;
      const outcome = await reportOrderConfirmation({
        mail: { senderAddress: mailboxAddress(mail.senderAddress), receivedAtMs: mail.receivedAtMs, subject: mail.subject, body: mail.body },
        purchases,
        send: async (message) => {
          const deliveries = await deps.notifier.deliver({ kind: 'notice', message });
          if (!deliveries.some(delivery => delivery.delivered)) logger.warn('A purchase confirmation report reached no channel', { channels: deliveries.length });
        },
        ...(deps.purchases.recordRefund ? { recordRefund: deps.purchases.recordRefund.bind(deps.purchases) } : {}),
        ...(recordConfirmation ? { recordConfirmation } : {}),
        // Each purchase is reported once per kind (confirmed, shipped, delivered), across restarts.
        ...(deps.purchases.reportedMailKinds && deps.purchases.recordMailReported ? { reports: {
          kinds: deps.purchases.reportedMailKinds.bind(deps.purchases),
          record: deps.purchases.recordMailReported.bind(deps.purchases),
        } } : {}),
      });
      if (outcome.kind === 'not-reported' && outcome.reason === 'ambiguous') {
        logger.info('A store mail reads as about more than one purchase; no confirmation report was sent');
      }
    }).catch((error: unknown) => {
      seen.delete(mail.id);
      // Fixed text and the error name only: the underlying message can carry mail text.
      logger.warn('A store mail could not be checked against purchases', { error: error instanceof Error ? error.name : 'unknown' });
    });
  };
}

export interface PaymentsServices {
  readonly cards: DaemonCardStore;
  readonly purchases: DaemonPurchaseLedger;
  readonly budget: BudgetLedger;
  /**
   * Resolves once every payments verb is attached; the platform runs its boot
   * recovery sweep first, so attachment lands a beat after composition.
   * Rejects if attaching the daemon's local handlers failed. The daemon's
   * handler registration awaits it, so a rejection stops runtime startup.
   */
  readonly ready: Promise<void>;
  /** Borrowed by DaemonConfig; this payment composition owns its lifetime. */
  readonly paymentReplies: PaymentReplyInbox;
  /** This machine took the group's payments role: recover what a previous holder left interrupted here. */
  readonly recoverAsLeader: () => Promise<void>;
  /** Await before handing this catalog to a replacement composition. */
  readonly close: () => Promise<void>;
  /** Legacy synchronous teardown; new composition roots must await close. */
  readonly unregister: () => void;
}

/**
 * The narrow secret port the card store gets: three operations over the daemon
 * tier, and no way to reach any other credential in the process. The same
 * treatment cluster-group-composition.ts gives the group key.
 */
function daemonScopedSecrets(secretsManager: Pick<SecretsManager, 'get' | 'set' | 'delete'>): PaymentsSecretStore {
  return {
    get: (key) => secretsManager.get(key),
    set: async (key, value) => {
      await secretsManager.set(key, value, { scope: 'daemon', medium: 'secure' });
    },
    delete: async (key) => {
      await secretsManager.delete(key, { scope: 'daemon' });
    },
  };
}

/** Read live, per call: a budget raised five minutes ago applies to the next read. */
function livePaymentsConfig(configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'resolveForConsumer'>>): PaymentsConfigReader {
  const resolveForConsumer = configManager.resolveForConsumer?.bind(configManager);
  return {
    get: (key: string) => configManager.get(key as Parameters<ConfigManager['get']>[0]),
    // The owner's currency and zone come from the profile when the setting is unset.
    ...(resolveForConsumer ? { resolveForConsumer: (key: string) => resolveForConsumer(key as Parameters<ConfigManager['get']>[0]) } : {}),
  };
}

/**
 * A notifier that follows `payments.notifyChannels` as it changes.
 *
 * The platform notifier resolves its channel list once, when it is built, so a
 * list set after boot would never be notified until a restart. This rebuilds
 * it whenever the configured list differs from the one the current notifier was
 * built with. A window already prepared keeps the channel report its own call
 * took, so a change between preparing and arming never moves that window.
 */
export function liveChannelPaymentNotifier(
  config: PaymentsConfigReader,
  router: Parameters<typeof channelBackedPaymentNotifier>[1],
  replies: Parameters<typeof channelBackedPaymentNotifier>[2],
): PaymentNotifier {
  let listKey = readNotifyChannels(config).join(',');
  let current = channelBackedPaymentNotifier(config, router, replies);
  const fresh = (): PaymentNotifier => {
    const key = readNotifyChannels(config).join(',');
    if (key !== listKey) {
      current = channelBackedPaymentNotifier(config, router, replies);
      listKey = key;
    }
    return current;
  };
  const prepare = current.prepareWindow;
  return {
    ...(prepare ? { prepareWindow: (input: Parameters<NonNullable<PaymentNotifier['prepareWindow']>>[0]) => fresh().prepareWindow!(input) } : {}),
    deliver: (input) => fresh().deliver(input),
    awaitAnswer: (input) => fresh().awaitAnswer(input),
  };
}

/**
 * Build the payment stores and bind the answerable verbs to them.
 *
 * The card and purchase stores read lazily and write only when a verb asks
 * them to, so composing either by itself creates no file activity. The budget
 * ledger is different: `DurableBudgetLedger`'s constructor reads
 * `payments-budget.json` synchronously to load today's pools
 * (daemon/handlers/payments/budget-store.ts), so constructing the result of
 * THIS function does touch disk, once, for that one file, before any verb is
 * ever called.
 */
export function createPaymentsServices(options: PaymentsCompositionOptions): PaymentsServices {
  const nativeDataWriter = options.nativeDataWriter;
  const declareNativeData = nativeDataWriter?.declare.bind(nativeDataWriter);
  const config = livePaymentsConfig(options.configManager);
  const paymentReplies = new PaymentReplyInbox();
  // In memory only: a typed security code lives until the one card entry it is for.
  const securityCodes = new SecurityCodeRequests();
  const cards = new DaemonCardStore({
    filePath: controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-cards.json'),
    secrets: daemonScopedSecrets(options.secretsManager),
    cvvHandling: () => readCvvHandling(config),
  });
  const purchases = new DaemonPurchaseLedger({
    filePath: controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-purchases.json'),
    beforeReconciliationWrite: declareNativeData ? () => declareNativeData('payment-operation-reconciliation-v2') : undefined,
  });
  const operations = new DurablePaymentOperations(controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-operations'),
    declareNativeData ? () => declareNativeData('payment-operation-reconciliation-v2') : undefined);
  const budget = new DurableBudgetLedger(
    controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-budget.json'),
    Date.now,
    declareNativeData ? () => declareNativeData('payment-retained-holds-v2') : undefined,
    declareNativeData ? () => declareNativeData('payment-operation-reconciliation-v2') : undefined,
    id => operations.get(id)?.outcome?.startsWith('owner-reconciliation-pending-') === true,
    () => purchases.list({ limit: 1, dayKey: undefined }).total > 0
      || operations.list().some(operation => operation.totalMinorUnits !== null
        && operation.phase !== null && ['awaiting-window', 'arming-payment', 'submit-pending', 'submitted'].includes(operation.phase)),
    // 3.3.1 recorded amounts with no currency: they are in the one its limits were counted in.
    () => readPaymentsServiceConfig(config).budgetCurrency,
  );
  if (options.groupSpend) budget.attachGroupSpend(options.groupSpend);
  const channelNotifier = liveChannelPaymentNotifier(config, options.channelDeliveryRouter, paymentReplies);
  const notifier = options.ownerInbox === undefined
    ? channelNotifier
    : withOwnerInbox(channelNotifier, options.ownerInbox, (kind) => {
      const windows = readPaymentsServiceConfig(config);
      return kind === 'approval' ? windows.approvalMinutes : windows.vetoMinutes;
    });
  const detachOwnerMail = options.ownerMail?.attach(createOrderMailObserver({ purchases, notifier, operations }));
  const inbox = options.ownerInbox;
  const setConfig = options.configManager.set?.bind(options.configManager);
  const limitOffers = inbox?.latestByKey && inbox.subscribe && inbox.take && inbox.confirmDelivered && setConfig
    ? createLimitOffers({
      postNow: (item) => inbox.postNow(item),
      latestByKey: inbox.latestByKey.bind(inbox),
      subscribe: inbox.subscribe.bind(inbox),
      take: inbox.take.bind(inbox),
      confirmDelivered: inbox.confirmDelivered.bind(inbox),
      withdraw: (id, reason) => inbox.withdraw(id, reason),
    }, {
      get: (key) => options.configManager.get(key),
      set: (key, value) => setConfig(key, value),
    }, () => readPaymentsServiceConfig(config).budgetCurrency)
    : undefined;
  const checkout: CheckoutComposition = {
    seam: options.checkoutSeam,
    addresses: configBackedAddressStore(config, options.configManager.preparePostalAddress?.bind(options.configManager)),
    notifier,
    replies: paymentReplies,
    securityCodes,
    ...(limitOffers ? { limitOffers } : {}),
    ...(options.paymentContinuationOwner ? { restoreWindow: createNativeCheckoutWindowRestorer({
      ...options.paymentContinuationOwner, catalog: options.gatewayMethods, config,
      seam: options.checkoutSeam, replies: paymentReplies, router: options.channelDeliveryRouter,
      isPaymentsLeader: options.isPaymentsLeader, ownerInbox: options.ownerInbox,
    }), retireContinuation: options.paymentContinuationOwner.pairing.revokeNativeContinuation.bind(options.paymentContinuationOwner.pairing) } : {}),
    merchantJudge: createJevMerchantJudge(),
    untrusted: getProcessUntrustedContentLedger(),
    // The persisted owner approvals `payments.checkout.approve` mints and
    // `begin` spends, beside the other payments stores. Each access refreshes
    // the actual file under the shared mutation lock; another daemon's spent
    // grant cannot remain spendable in this composition's memory.
    approvals: new DaemonApprovalStore(
      controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-approvals.json'),
    ),
    // The owner's standing authorisations, which let a scheduled or triggered
    // run begin a purchase he authorised in advance (/payments repeats).
    standing: new DaemonStandingAuthorizations(
      controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-standing.json'),
    ),
    // The durable in-flight checkout journal. Every phase write the registry
    // makes, the `submit-pending` flush before the merchant submit included,
    // lands here before the flow proceeds, so a crash in the one ambiguous
    // window leaves a record a restart can disclose instead of nothing.
    operations,
    requests: new ProtectedPaymentRequests(controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-requests'),
      declareNativeData ? version => declareNativeData(version === 2 ? 'payment-window-checkpoints-v2' : 'payment-window-checkpoints-v1') : undefined,
      () => declareNativeData?.('payment-reply-history-v1'),
      () => declareNativeData?.('payment-reply-coverage-v1'),
      () => declareNativeData?.('payment-receive-spans-v1'),
      declareNativeData ? () => declareNativeData('payment-multi-recipient-checkpoints-v1') : undefined),
    journal: new DurableCheckoutJournal(
      controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-checkout-journal.json'),
    ),
  };
  const registration = registerPaymentsMethods(options.gatewayMethods, {
    cards,
    purchases,
    budget,
    config,
    isPaymentsLeader: options.isPaymentsLeader,
    ...(options.paymentsHolder ? { paymentsHolder: options.paymentsHolder } : {}),
    checkout,
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    const errors: unknown[] = [], jobs: Promise<void>[] = [];
    detachOwnerMail?.();
    limitOffers?.close();
    securityCodes.close();
    // Retire both owners synchronously. Attempt both even if one close fails.
    try { jobs.push(registration.close()); } catch (error) { errors.push(error); }
    try { jobs.push(paymentReplies.close()); } catch (error) { errors.push(error); }
    void Promise.allSettled(jobs).then((results) => {
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length > 0) {
        // Fixed diagnostic only: underlying failures can contain owned paths.
        try { logger.warn('Payment composition did not close cleanly', { failureCount: errors.length }); } catch { /* Preserve the cleanup failure. */ }
        reject(new AggregateError(errors, 'Payment composition did not close cleanly'));
      } else resolve();
    });
    // Legacy void callers must not cause unhandled rejection. Awaiting the
    // same promise still reports cleanup failures to the new composition root.
    void closing.catch(() => {});
    return closing;
  };
  return {
    cards, purchases, budget, paymentReplies, ready: registration.ready, recoverAsLeader: registration.recoverAsLeader, close,
    unregister: () => { void close(); },
  };
}
