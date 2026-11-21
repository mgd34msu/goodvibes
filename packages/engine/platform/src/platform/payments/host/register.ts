/**
 * register.ts, the `payments.*` handlers this daemon attaches.
 *
 * This is the one registrar for `payments.*`: every verb's handler is attached
 * here, over the `PaymentsGatewayService` built below, after the boot recovery
 * sweep settles. `routes/payments.ts` holds the wire types only.
 *
 * The handlers read their fields narrower than the published input schema
 * where being a card demands it (enough digits to be a card number, a three or
 * four digit CVV, a 1-12 month), each refused with a 400 naming the field;
 * `purchases.list` reads a numeric-looking query string as the number it
 * names. `payments.checkout.begin` and `payments.checkout.approve` need
 * `context.explicitUserRequest` and the paired principal, which reach a
 * handler attached through `registerCatalogHandlers`; the card is typed by the
 * purchase the daemon runs, and no verb types it.
 *
 * `deps.checkout` (a `CheckoutComposition`, see below) is REQUIRED, not
 * optional: in the real daemon it is always supplied
 * (runtime/payments-composition.ts), and its own `seam()` getter is what may
 * legitimately be absent, either because this composition never builds a
 * browser at all (no `homeDirectory`, a narrow embed) or because
 * `onBrowserCheckout` has not fired yet (see
 * runtime/browser-checkout-seam-holder.ts for why that race is benign). Either
 * way `payments.checkout.begin` answers an honest refusal rather than 501
 * NOT_INVOKABLE or a crash; see `checkoutBegin` below.
 *
 * ── Containment ───────────────────────────────────────────────────────────
 *
 * Every response below is BUILT from named fields rather than spread from a
 * store record: an allowlist
 * silently drops a field a later change adds, a denylist silently ships it, and
 * for anything on a card's code path that is the correct direction to fail.
 * No handler here reads card material, and no failure path forwards a message
 * from a call that had material in its arguments.
 */
import type { BudgetLedger } from '../budget.js';
import { readConfirmEveryPurchase, readDefaultCardId, readPaymentsEnabled, readPaymentsServiceConfig } from '../payments-config.js';
import type { PaymentsConfigReader } from '../payments-config.js';
import type { CardMetadata } from '../types.js';
import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';
import type { GatewayMethodDescriptor } from '../../control-plane/method-catalog-shared.js';
import type {
  PaymentPurchaseView,
  PaymentsGatewayService,
} from '../../control-plane/routes/payments.js';
import { logger } from '../../utils/logger.js';
import { registerCatalogHandlers } from '../../control-plane/host-handlers.js';
import { GatewayVerbError } from '../../control-plane/routes/gateway-verb-error.js';
import { describeCardTransportRefusal, mayCrossWithCardDetails } from '../entry-policy.js';
import type { TypedHandler, Unregister } from '../../control-plane/host-handlers.js';
import { CheckoutServiceHolder, checkoutApproveHandler, checkoutBeginHandler } from './checkout-handlers.js';
import { purchaseWindowStatusHandler, purchaseWindowAnswerHandler, purchaseSecurityCodeHandler } from './window-handlers.js';
import { paymentHostStopSentence, paymentHostStopView } from '../payment-host-health.js';
import { purchaseReconciliationHandler } from './reconciliation-handler.js';
import { standingCreateHandler, standingListHandler, standingDeleteHandler } from './standing-handlers.js';
import type { CheckoutComposition } from './checkout-handlers.js';
import { CardCreateIncompleteError, CardStoreUnreadableError } from './card-store.js';
import type { DaemonCardStore } from './card-store.js';
import { MAX_PURCHASE_LIST_LIMIT, PaymentPurchaseLedgerError } from './purchase-ledger.js';
import type { DaemonPurchaseLedger, StoredPurchase } from './purchase-ledger.js';

export type { CheckoutComposition } from './checkout-handlers.js';

/** The verbs this module attaches. Named so a test can assert the exact set. */
export const ATTACHED_PAYMENTS_METHOD_IDS: readonly string[] = [
  'payments.budget.status',
  'payments.cards.list',
  'payments.cards.create',
  'payments.cards.delete',
  'payments.purchases.list',
  'payments.checkout.approve',
  'payments.checkout.begin',
  'payments.purchase.status',
  'payments.purchase.approve',
  'payments.purchase.deny',
  'payments.purchase.cancel',
  'payments.purchase.reconcile',
  'payments.purchase.securityCode',
  'payments.standing.list',
  'payments.standing.create',
  'payments.standing.delete',
];

/**
 * Kept, empty, rather than deleted: `gateway-payments-verbs.test.ts` and
 * `register.test.ts` iterate this to assert the unattached set, and an empty
 * array keeps that assertion meaningful (a future verb added here without a
 * handler still gets caught) instead of forcing every caller to delete the
 * loop. Nothing in this module's registration reads it any more.
 */
export const UNATTACHED_PAYMENTS_METHOD_IDS: readonly { readonly id: string; readonly reason: string }[] = [];

const DEFAULT_PURCHASE_LIST_LIMIT = 100;

export interface PaymentsHandlerDeps {
  readonly cards: DaemonCardStore;
  readonly purchases: DaemonPurchaseLedger;
  /** Today's pools. The checkout flow is the sole writer; the composition root is responsible for making this durable. */
  readonly budget: BudgetLedger;
  readonly config: PaymentsConfigReader;
  /**
   * Whether this node is the one allowed to spend.
   *
   * Reported, never defaulted, see the platform's gates.ts: on a clustered install a
   * wrong answer here is a double-spend. The composition root supplies the
   * coordinator's own answer.
   */
  readonly isPaymentsLeader: () => boolean;
  /** The name of the machine that runs payments when this one does not; see gates.ts. */
  readonly paymentsHolder?: (() => string | null) | undefined;
  readonly now?: (() => number) | undefined;
  readonly checkout: CheckoutComposition;
}

// ---------------------------------------------------------------------------
// Input readers
//
// Each names the FIELD and never the value, the property the platform's own route
// module enforces: an error string is a read path like any other.
// ---------------------------------------------------------------------------

function invalid(field: string, requirement: string): GatewayVerbError {
  return new GatewayVerbError(`${field} ${requirement}`, 'INVALID_ARGUMENT', 400, field);
}

/**
 * Run a card-store call and refuse in the caller's terms.
 *
 * Two outcomes, and the difference is what the caller is allowed to be told:
 *
 *  - `CardStoreUnreadableError` is a message this codebase WROTE, naming the
 *    file and what to do about it. It is forwarded verbatim because the operator
 *    cannot fix a damaged card file they are not told about, and 409 says the
 *    honest thing: nothing is wrong with the request, the store is not in a
 *    state that can serve it.
 *  - Anything else came out of the secret store, and its message can name the
 *    store path, the key, or the value it was handling. It is DISCARDED and
 *    replaced here. Without this, `registerCatalogHandler`'s generic wrapper
 *    forwards the original as a 500 body, which put a store path in front of any
 *    caller holding read:payments.
 */
async function overStore<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CardStoreUnreadableError || error instanceof PaymentPurchaseLedgerError) {
      throw new GatewayVerbError(error.message, 'FAILED_PRECONDITION', 409);
    }
    void error;
    throw new GatewayVerbError(`${what} failed.`, 'INTERNAL_ERROR', 500);
  }
}

function readString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(field, 'is required.');
  }
  return value.trim();
}

function readInteger(source: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(field, `must be a whole number between ${String(min)} and ${String(max)}.`);
  }
  return value;
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A number that arrived as a query string (a GET) or as JSON (an invoke). */
function optionalCount(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Response builders (allowlists, never spreads)
// ---------------------------------------------------------------------------

interface CardView {
  readonly id: string;
  readonly label: string;
  readonly brand: string;
  readonly last4: string;
  readonly kind: 'virtual' | 'real';
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly issuerCapMinorUnits: number | null;
  readonly addedAt: string;
  readonly materialComplete: boolean;
}

function cardView(card: CardMetadata, materialComplete: boolean): CardView {
  return {
    id: card.id,
    label: card.label,
    brand: card.brand,
    last4: card.last4,
    kind: card.kind,
    expiryMonth: card.expiryMonth,
    expiryYear: card.expiryYear,
    issuerCapMinorUnits: card.issuerCapMinorUnits,
    addedAt: card.addedAt,
    materialComplete,
  };
}

function purchaseView(row: StoredPurchase): PaymentPurchaseView {
  return {
    purchaseId: row.purchaseId,
    atUtc: row.atUtc,
    dayKey: row.dayKey,
    timezone: row.timezone,
    merchantDomain: row.merchantDomain,
    item: String(row.item),
    currency: String(row.currency),
    itemMinorUnits: row.itemMinorUnits,
    taxMinorUnits: row.taxMinorUnits,
    feesMinorUnits: row.feesMinorUnits,
    shippingMinorUnits: row.shippingMinorUnits,
    totalMinorUnits: row.totalMinorUnits,
    ...(row.requestedMaximumMinorUnits === undefined ? {} : { requestedMaximumMinorUnits: row.requestedMaximumMinorUnits }),
    shippingTierRequested: row.shippingTierRequested,
    shippingTierUsed: row.shippingTierUsed,
    steppedDown: row.steppedDown === true,
    itemPoolDraw: row.itemPoolDraw,
    overagePoolDraw: row.overagePoolDraw,
    tolerancePoolDraw: row.tolerancePoolDraw,
    cardLast4: row.cardLast4,
    windowKind: row.windowKind,
    windowOutcome: row.windowOutcome,
    answeredBy: row.answeredBy ?? null,
    outcome: row.outcome,
    refusalReason: row.refusalReason ?? null,
    merchantOrderId: row.merchantOrderId ?? null,
    refundedAt: row.refundedAt ?? null,
    merchantRecognised: row.merchantRecognised === true,
    merchantQualifier: row.merchantQualifier ?? null,
    merchantDiscovered: row.merchantDiscovered === true,
    ...(row.standingAuthorizationId === undefined ? {} : { standingAuthorizationId: row.standingAuthorizationId }),
  };
}

// ---------------------------------------------------------------------------

/**
 * `payments.budget.status`, with the payment host's health beside the pools.
 *
 * A stopped budget ledger has no pools to show, so it answers with the one
 * sentence that names it; any other stopped store is reported as `stopped`
 * while today's pools are still shown.
 */
function budgetStatusHandler(deps: PaymentsHandlerDeps, service: PaymentsGatewayService, holder: CheckoutServiceHolder): TypedHandler<unknown, unknown> {
  return async () => {
    const stop = holder.hostStop({ approvals: readConfirmEveryPurchase(deps.config) });
    if (stop && deps.budget.stopped()) throw new GatewayVerbError(paymentHostStopSentence(stop), 'FAILED_PRECONDITION', 409);
    const view = await service.budgetStatus();
    return {
      enabled: view.enabled, dayKey: view.pools.dayKey, timezone: view.pools.timezone, currency: view.currency,
      item: view.pools.item, overage: view.pools.overage, tolerance: view.pools.tolerance,
      ...(view.pools.earlierSpend ? { earlierSpend: view.pools.earlierSpend } : {}),
      reservationCount: view.reservationCount, isPaymentsLeader: view.isPaymentsLeader,
      ...(stop ? { stopped: paymentHostStopView(stop) } : {}),
    };
  };
}

/**
 * The store-facing half of the payment verbs: the one place that talks to
 * `DaemonCardStore` and `DaemonPurchaseLedger`. Card views are built from named
 * fields, and a failed card write never forwards the message of a call that had
 * the card in its arguments.
 */
function buildPaymentsGatewayService(deps: PaymentsHandlerDeps): PaymentsGatewayService {
  const now = deps.now ?? Date.now;

  return {
    async budgetStatus() {
      const config = readPaymentsServiceConfig(deps.config);
      const nowMs = now();
      const pools = deps.budget.snapshot(config.limits, nowMs, config.timezone);
      const live = deps.budget.state().reservations.filter((entry) => entry.retainUntilSettled === true || entry.expiresAtMs > nowMs);
      return {
        enabled: readPaymentsEnabled(deps.config),
        currency: String(config.budgetCurrency),
        pools,
        reservationCount: live.length,
        isPaymentsLeader: deps.isPaymentsLeader(),
      };
    },

    async listCards() {
      return overStore('Listing the stored cards', async () => {
        const built: CardView[] = [];
        for (const card of deps.cards.list()) {
          built.push(cardView(card, await deps.cards.materialComplete(card.id)));
        }
        // A default that names a card which no longer exists (deleted since it was
        // chosen) is reported as no default, so a surface does not render a stale
        // choice as if it were usable.
        const configured = readDefaultCardId(deps.config);
        return { cards: built, defaultCardId: built.some((card) => card.id === configured) ? configured : '' };
      });
    },

    async createCard(input) {
      let card: CardMetadata;
      try {
        card = await deps.cards.create(input);
      } catch (error) {
        // A damaged card file is the operator's to fix and its message says how,
        // so it is forwarded; see overStore. Everything else is discarded, because
        // the failing call had the card in its arguments.
        if (error instanceof CardStoreUnreadableError) {
          throw new GatewayVerbError(error.message, 'FAILED_PRECONDITION', 409);
        }
        // Part of the card stayed saved: said, with the id that removes it.
        if (error instanceof CardCreateIncompleteError) throw new GatewayVerbError(error.message, 'INTERNAL_ERROR', 500);
        void error;
        throw new GatewayVerbError('Storing the card failed. Nothing was saved.', 'INTERNAL_ERROR', 500);
      }
      return cardView(card, await overStore('Reading the card back', () => deps.cards.materialComplete(card.id)));
    },

    async deleteCard(id) {
      return overStore('Deleting the card', () => deps.cards.remove(id));
    },

    async listPurchases(input) {
      return overStore('Reading purchase history', async () => {
        const result = deps.purchases.list(input);
        return { purchases: result.purchases.map(purchaseView), total: result.total, reconciliations: result.reconciliations };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * What `registerPaymentsMethods` returns now that attachment has an async
 * phase. `unregister` is valid immediately, including before `ready` settles.
 * `ready` resolves once every handler is attached and REJECTS if attaching the
 * local handlers failed, so the caller that drops it must handle the
 * rejection (daemon-handler-composition.ts logs it; tests await it).
 */
export interface PaymentsRegistration {
  readonly ready: Promise<void>;
  /**
   * This machine just took the group's payments role: recover the checkouts a
   * previous holder of it left interrupted here, exactly as boot does. Runs
   * after `ready`; the shared registry keeps a live operation from being read
   * as interrupted.
   */
  readonly recoverAsLeader: () => Promise<void>;
  readonly unregister: Unregister;
  /**
   * Resolves once a begun purchase's checkout operation on this host has
   * ended (final state, owner notice and cleanup written); at once when none
   * is running for it. What payments.checkout.begin accepted ends here.
   */
  readonly purchaseEnded: (purchaseId: string) => Promise<void>;
  /** Stop admission immediately and drain accepted checkout and recovery work. */
  readonly close: () => Promise<void>;
}

/**
 * Attach every `payments.*` handler to the descriptors the catalog holds.
 *
 * The boot recovery sweep runs first, so the handlers attach a beat after this
 * function returns; `ready` is how a caller observes that.
 *
 * NOT gated on `payments.enabled`. That key defaults to false, and
 * `payments.cards.*` is how a surface CONFIGURES the capability, so gating
 * registration on it would leave the configuration surface unreachable until the
 * capability was already configured, which is the shape of the defect this
 * module exists to fix. The setting is reported live by `budget.status` instead,
 * and it is `checkPaymentGates` at purchase time that stops a disabled daemon
 * from spending.
 */
export function registerPaymentsMethods(
  catalog: GatewayMethodCatalog,
  deps: PaymentsHandlerDeps,
): PaymentsRegistration {
  // Every descriptor this module attaches to, captured BEFORE any
  // registration runs. `registerCatalogHandlers`' teardown removes the
  // DESCRIPTOR from the catalog entirely rather than clearing its handler slot
  // (a `Map.delete`), so restoring a handler-less descriptor after teardown
  // needs the descriptor object captured here.
  const descriptors = new Map<string, GatewayMethodDescriptor>();
  for (const id of ATTACHED_PAYMENTS_METHOD_IDS) {
    const descriptor = catalog.get(id);
    if (descriptor) descriptors.set(id, descriptor);
  }

  const checkoutServiceHolder = new CheckoutServiceHolder(deps, deps.checkout.journal);
  const service = buildPaymentsGatewayService(deps);

  // Boot recovery runs TO COMPLETION before any handler attaches, so no
  // checkout verb can start a purchase the sweep would then read as
  // interrupted. A failed sweep is logged and does not withhold the verbs: it
  // is a disclosure duty, not a serving precondition once it has stopped.
  const bootRecovery = (async (): Promise<void> => {
    try {
      const sweep = await checkoutServiceHolder.recoverInterruptedCheckouts();
      logger.info('payments boot recovery settled', { sweep });
    } catch (error) {
      logger.error('payments boot recovery failed', { error });
    }
  })();

  const cardsList: TypedHandler<unknown, Record<string, unknown>> = async () => {
    const { cards, defaultCardId } = await service.listCards();
    return { cards, defaultCardId };
  };

  const cardsDelete: TypedHandler<unknown, Record<string, unknown>> = async ({ body }) => {
    const id = readString(asRecord(body), 'id');
    const result = await service.deleteCard(id);
    return { id, deleted: result.deleted, secretsCleared: result.secretsCleared };
  };

  const cardsCreate: TypedHandler<unknown, Record<string, unknown>> = async ({ body, context }) => {
    // card.enter crosses only this machine, TLS or the tailnet; refused before the body is read.
    if (!mayCrossWithCardDetails(context.transport)) throw new GatewayVerbError(describeCardTransportRefusal(), 'CARD_ENTRY_TRANSPORT', 403);
    const params = asRecord(body);
    const kind = readString(params, 'kind');
    if (kind !== 'virtual' && kind !== 'real') {
      throw invalid('kind', "must be 'virtual' or 'real'.");
    }
    const label = readString(params, 'label');
    const number = readString(params, 'number');
    // Narrower than the published input schema, which types these as a plain
    // string and a plain number. Each check below is a property of BEING a card
    // rather than a policy about one: a value that fails it could not be
    // charged, and storing it would produce a card the surface offers and the
    // checkout can never fill. None of them names anything but the field.
    if (number.replace(/\D/g, '').length < 12) {
      throw invalid('number', 'does not contain enough digits to be a card number.');
    }
    const expiryMonth = readInteger(params, 'expiryMonth', 1, 12);
    // A full four-digit year: `cardFieldValue` derives the two-digit form by
    // slicing this one, so a year stored as 29 would type as "29" in a
    // four-digit field and as "29" in a two-digit one, and only one of those is
    // right.
    const expiryYear = readInteger(params, 'expiryYear', 1000, 9999);
    const cvv = readString(params, 'cvv');
    if (!/^[0-9]{3,4}$/.test(cvv)) {
      throw invalid('cvv', 'must be the three or four digit code printed on the card.');
    }
    const cardholderName = readString(params, 'cardholderName');
    const rawCap = params['issuerCapMinorUnits'];
    // Absent or null means no declared cap. Anything else that is not a whole,
    // non-negative number is refused: storing the card without it would show the
    // owner an uncapped card they did not ask for.
    if (rawCap !== undefined && rawCap !== null && !(typeof rawCap === 'number' && Number.isSafeInteger(rawCap) && rawCap >= 0)) {
      throw invalid('issuerCapMinorUnits', 'must be a non-negative whole number or absent.');
    }

    const card = await service.createCard({
      label,
      kind,
      number,
      expiryMonth,
      expiryYear,
      cvv,
      cardholderName,
      issuerCapMinorUnits: typeof rawCap === 'number' ? rawCap : null,
    });
    return { card };
  };

  const purchasesList: TypedHandler<unknown, Record<string, unknown>> = async ({ body, query }) => {
    const params = { ...query, ...asRecord(body) };
    const requested = optionalCount(params['limit']);
    const rawDay = params['dayKey'];
    const dayKey = typeof rawDay === 'string' && rawDay.trim().length > 0 ? rawDay.trim() : undefined;
    return service.listPurchases({
      limit: Math.min(requested ?? DEFAULT_PURCHASE_LIST_LIMIT, MAX_PURCHASE_LIST_LIMIT),
      dayKey,
    });
  };

  // Restores every descriptor this module attached to, handler-less, so a
  // later registration on the SAME catalog (a restart without recompose)
  // finds them there to attach to instead of failing with METHOD_NOT_FOUND.
  const restoreDescriptors = (): void => {
    for (const [, descriptor] of descriptors) {
      catalog.register(descriptor, undefined, { replace: true });
    }
  };

  let torn = false;
  let localTeardown: Unregister | undefined;

  const ready = bootRecovery.then(() => {
    // Teardown already ran while recovery was settling: leave the descriptors
    // handler-less instead of attaching to a surface that was already released.
    if (torn) {
      restoreDescriptors();
      return;
    }
    localTeardown = registerCatalogHandlers(catalog, [
      { id: 'payments.cards.list', handler: cardsList as TypedHandler<unknown, unknown> },
      { id: 'payments.cards.create', handler: cardsCreate as TypedHandler<unknown, unknown> },
      { id: 'payments.cards.delete', handler: cardsDelete as TypedHandler<unknown, unknown> },
      { id: 'payments.purchases.list', handler: purchasesList as TypedHandler<unknown, unknown> },
      // The confirmation its descriptor declares (`owner-request`: `confirm: true`
      // from a person's credential) is what makes this verb owner-direct: the
      // handler then passes `surface: 'owner-direct'` from its own code path.
      // See checkout-handlers.ts's `checkoutApproveHandler`.
      { id: 'payments.checkout.approve', handler: checkoutApproveHandler(deps) as TypedHandler<unknown, unknown> },
      { id: 'payments.checkout.begin', handler: checkoutBeginHandler(deps, checkoutServiceHolder) as TypedHandler<unknown, unknown> },
      { id: 'payments.budget.status', handler: budgetStatusHandler(deps, service, checkoutServiceHolder) },
      { id: 'payments.purchase.status', handler: purchaseWindowStatusHandler(deps.checkout, checkoutServiceHolder.operations,
        () => checkoutServiceHolder.hostStop({ approvals: readConfirmEveryPurchase(deps.config) })) },
      { id: 'payments.purchase.reconcile', handler: purchaseReconciliationHandler(checkoutServiceHolder.reconciliations) },
      { id: 'payments.purchase.securityCode', handler: purchaseSecurityCodeHandler(deps.checkout) },
      // Adding and withdrawing a standing authorisation are the owner's own acts; their descriptors declare owner-request.
      { id: 'payments.standing.list', handler: standingListHandler(deps, deps.checkout.operations) as TypedHandler<unknown, unknown> },
      { id: 'payments.standing.create', handler: standingCreateHandler(deps, deps.checkout.operations) as TypedHandler<unknown, unknown> },
      { id: 'payments.standing.delete', handler: standingDeleteHandler(deps) as TypedHandler<unknown, unknown> },
      ...(['approve', 'deny', 'cancel'] as const).map(action => ({
        id: `payments.purchase.${action}`, handler: purchaseWindowAnswerHandler(deps.checkout, action, checkoutServiceHolder.operations),
      })),
    ]);
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    torn = true;
    const errors: unknown[] = [];
    const jobs: Promise<void>[] = [ready];
    // Retire the owner before catalog callbacks can admit more work.
    try { jobs.push(checkoutServiceHolder.close()); } catch (error) { errors.push(error); }
    try { localTeardown?.(); } catch (error) { errors.push(error); }
    try { restoreDescriptors(); } catch (error) { errors.push(error); }
    void Promise.allSettled(jobs).then(results => {
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length) reject(new AggregateError(errors, 'Payment registration did not close cleanly'));
      else resolve();
    });
    // The compatibility void teardown observes rejection; close still reports it.
    void closing.catch(() => {});
    return closing;
  };
  const recoverAsLeader = async (): Promise<void> => {
    await ready;
    if (torn) return;
    try {
      const sweep = await checkoutServiceHolder.recoverInterruptedCheckouts();
      logger.info('payments recovery on taking the payments role settled', { sweep });
    } catch (error) {
      logger.error('payments recovery on taking the payments role failed', { error });
    }
  };
  return { ready, recoverAsLeader, close, unregister: () => { void close(); },
    purchaseEnded: (purchaseId: string) => checkoutServiceHolder.operations.ended(purchaseId) };
}
