/**
 * operator-contract-schemas-payments.ts
 *
 * Input/output JSON schemas for the `payments.*` operator methods.
 *
 * Where card material may appear, and where it must stay absent: only the
 * input of `payments.cards.create` carries it (number, expiry month and year,
 * CVV, cardholder name), on its way to the daemon secret store. No output
 * schema returns the card number, the CVV or the cardholder name; the card
 * metadata a surface sees is label, brand, last4, kind and expiry month/year.
 * The checkout targets name card fields by name only, never their values. See
 * docs/payments.md §3.1 and §9.5.
 *
 * No verb types a card: the purchase the daemon runs
 * (`payments.checkout.begin`) reads the material in-process and types it.
 *
 * Handlers: payments/host/register.ts, the daemon's payments host; wire types in routes/payments.ts.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  enumSchema,
  nullableSchema,
  objectSchema,
} from './operator-contract-schemas-shared.js';
import { PAYMENT_OPERATION_STATES } from '../payments/operation-view.js';

/** A payment store that stopped itself, and what to do. Present only while one has. */
const PAYMENT_HOST_STOP_SCHEMA = objectSchema({
  store: STRING_SCHEMA, reason: STRING_SCHEMA, path: STRING_SCHEMA,
  message: { ...STRING_SCHEMA, description: 'Which store stopped, why, that nothing recorded was lost, and the step: restart the daemon.' },
}, ['store', 'reason', 'message']);

/** One daily pool: its limit, what today has spent, what is held, what is left. */
const POOL_SCHEMA = objectSchema(
  {
    limit: NUMBER_SCHEMA,
    spent: NUMBER_SCHEMA,
    reserved: NUMBER_SCHEMA,
    remaining: NUMBER_SCHEMA,
  },
  ['limit', 'spent', 'reserved', 'remaining'],
);

export const PAYMENTS_BUDGET_STATUS_INPUT_SCHEMA = objectSchema({}, []);

export const PAYMENTS_BUDGET_STATUS_OUTPUT_SCHEMA = objectSchema(
  {
    enabled: BOOLEAN_SCHEMA,
    /** The calendar day these totals belong to, in the daemon's timezone. */
    dayKey: STRING_SCHEMA,
    /** Resolved zone: the configured `daemon.timezone`, or 'UTC' when unset. */
    timezone: STRING_SCHEMA,
    currency: STRING_SCHEMA,
    item: POOL_SCHEMA,
    overage: POOL_SCHEMA,
    tolerance: POOL_SCHEMA,
    /**
     * Present when today also spent in another currency before payments.currency
     * changed: each currency's spend in its own minor units, never counted in the
     * pools above (a currency change starts a new pool).
     */
    earlierSpend: arraySchema(objectSchema({
      currency: STRING_SCHEMA, item: NUMBER_SCHEMA, overage: NUMBER_SCHEMA, tolerance: NUMBER_SCHEMA,
    }, ['currency', 'item', 'overage', 'tolerance'])),
    /** How many purchases are holding budget right now. */
    reservationCount: NUMBER_SCHEMA,
    /**
     * False on a clustered node that is not the elected payments leader.
     * Such a node refuses every purchase, today's spend does not replicate,
     * so a second spender would start from a clean daily budget.
     */
    isPaymentsLeader: BOOLEAN_SCHEMA,
    /** Present while a payment store has stopped itself; new purchases are refused with its message. */
    stopped: PAYMENT_HOST_STOP_SCHEMA,
  },
  ['enabled', 'dayKey', 'timezone', 'currency', 'item', 'overage', 'tolerance', 'reservationCount', 'isPaymentsLeader'],
);

/** A card as every surface sees it. Metadata only, by construction. */
const CARD_METADATA_SCHEMA = objectSchema(
  {
    id: STRING_SCHEMA,
    label: STRING_SCHEMA,
    brand: STRING_SCHEMA,
    last4: STRING_SCHEMA,
    kind: enumSchema(['virtual', 'real']),
    expiryMonth: NUMBER_SCHEMA,
    expiryYear: NUMBER_SCHEMA,
    /** Declared by the owner and unverifiable by us; never treated as enforcement. */
    issuerCapMinorUnits: nullableSchema(NUMBER_SCHEMA),
    addedAt: STRING_SCHEMA,
    /** Whether every required secret field is present, never the values. */
    materialComplete: BOOLEAN_SCHEMA,
  },
  ['id', 'label', 'brand', 'last4', 'kind', 'expiryMonth', 'expiryYear', 'issuerCapMinorUnits', 'addedAt', 'materialComplete'],
);

export const PAYMENTS_CARDS_LIST_INPUT_SCHEMA = objectSchema({}, []);

export const PAYMENTS_CARDS_LIST_OUTPUT_SCHEMA = objectSchema(
  { cards: arraySchema(CARD_METADATA_SCHEMA), defaultCardId: STRING_SCHEMA },
  ['cards', 'defaultCardId'],
);

/**
 * Adding a card. Card material goes IN and never comes back out.
 *
 * The response is the metadata record only, there is deliberately no echo of
 * what was submitted, because an echo is a read path and the whole point is
 * that no read path exists.
 */
export const PAYMENTS_CARDS_CREATE_INPUT_SCHEMA = objectSchema(
  {
    label: STRING_SCHEMA,
    kind: enumSchema(['virtual', 'real']),
    number: STRING_SCHEMA,
    expiryMonth: NUMBER_SCHEMA,
    expiryYear: NUMBER_SCHEMA,
    cvv: STRING_SCHEMA,
    cardholderName: STRING_SCHEMA,
    issuerCapMinorUnits: nullableSchema(NUMBER_SCHEMA),
  },
  ['label', 'kind', 'number', 'expiryMonth', 'expiryYear', 'cvv', 'cardholderName'],
);

export const PAYMENTS_CARDS_CREATE_OUTPUT_SCHEMA = objectSchema(
  { card: CARD_METADATA_SCHEMA },
  ['card'],
);

export const PAYMENTS_CARDS_DELETE_INPUT_SCHEMA = objectSchema({ id: STRING_SCHEMA }, ['id']);

export const PAYMENTS_CARDS_DELETE_OUTPUT_SCHEMA = objectSchema(
  { id: STRING_SCHEMA, deleted: BOOLEAN_SCHEMA, secretsCleared: NUMBER_SCHEMA },
  ['id', 'deleted', 'secretsCleared'],
);

/** Only a live purchase notice. A window reference never grants authority. */
const PAYMENT_WINDOW_SCHEMA = objectSchema({
  purchaseId: STRING_SCHEMA, windowId: STRING_SCHEMA, kind: enumSchema(['approval', 'veto']),
  notice: STRING_SCHEMA, deadlineMs: NUMBER_SCHEMA,
}, ['purchaseId', 'windowId', 'kind', 'notice', 'deadlineMs']);

export const PAYMENTS_PURCHASE_STATUS_INPUT_SCHEMA = objectSchema({ purchaseId: STRING_SCHEMA });
const PAYMENT_OPERATION_SCHEMA = objectSchema({
  purchaseId: STRING_SCHEMA, operationId: STRING_SCHEMA, state: enumSchema(PAYMENT_OPERATION_STATES),
  phase: nullableSchema(enumSchema(['deciding', 'awaiting-window', 'arming-payment', 'submit-pending', 'submitted'])),
  createdAtMs: { type: 'integer', minimum: 0, maximum: 8_640_000_000_000_000 },
  updatedAtMs: { type: 'integer', minimum: 0, maximum: 8_640_000_000_000_000 },
  outcome: nullableSchema(STRING_SCHEMA), totalMinorUnits: nullableSchema({ type: 'integer', minimum: 0 }),
  currency: nullableSchema({ type: 'string', pattern: '^[A-Z]{3}$' }),
  /** The specific reason a purchase ended unbought, as the owner was told it. */
  reason: nullableSchema({ ...STRING_SCHEMA, maxLength: 4000 }),
  /** The merchant verification step (3-D Secure, CAPTCHA, one-time code) waiting on the owner. */
  challengeStep: nullableSchema({ ...STRING_SCHEMA, maxLength: 4000 }),
  /** The owner limit a refusal names, in minor units of `currency`. */
  exceeded: nullableSchema(objectSchema({
    limit: enumSchema(['daily-item-budget', 'per-purchase-ceiling', 'requested-maximum', 'daily-overage-budget', 'card-limit']),
    setting: STRING_SCHEMA,
    availableMinorUnits: { type: 'integer', minimum: 0 }, neededMinorUnits: { type: 'integer', minimum: 0 }, excessMinorUnits: { type: 'integer', minimum: 0 },
    unset: BOOLEAN_SCHEMA,
  }, ['limit', 'availableMinorUnits', 'neededMinorUnits', 'excessMinorUnits', 'unset'])),
}, ['purchaseId', 'operationId', 'state', 'phase', 'createdAtMs', 'updatedAtMs', 'outcome', 'totalMinorUnits', 'currency']);
/** A purchase whose status record could not be read. Present only when one exists. */
const PAYMENT_UNREADABLE_OPERATION_SCHEMA = objectSchema({ purchaseId: STRING_SCHEMA, reason: STRING_SCHEMA }, ['purchaseId', 'reason']);
/** A purchase waiting for the owner to type its card security code. Never carries a code. */
const PAYMENT_SECURITY_CODE_REQUEST_SCHEMA = objectSchema({
  purchaseId: STRING_SCHEMA, windowId: STRING_SCHEMA, merchantDomain: STRING_SCHEMA, cardLast4: STRING_SCHEMA, deadlineMs: NUMBER_SCHEMA,
}, ['purchaseId', 'windowId', 'merchantDomain', 'cardLast4', 'deadlineMs']);
export const PAYMENTS_PURCHASE_STATUS_OUTPUT_SCHEMA = objectSchema({
  windows: { ...arraySchema(PAYMENT_WINDOW_SCHEMA), maxItems: 256 },
  operations: { ...arraySchema(PAYMENT_OPERATION_SCHEMA), maxItems: 356 },
  unreadable: { ...arraySchema(PAYMENT_UNREADABLE_OPERATION_SCHEMA), maxItems: 356 },
  securityCodes: { ...arraySchema(PAYMENT_SECURITY_CODE_REQUEST_SCHEMA), maxItems: 256 },
  stopped: PAYMENT_HOST_STOP_SCHEMA,
}, ['windows', 'operations']);
export const PAYMENTS_PURCHASE_SECURITY_CODE_INPUT_SCHEMA = objectSchema({
  purchaseId: STRING_SCHEMA, windowId: STRING_SCHEMA,
  code: { ...STRING_SCHEMA, maxLength: 16, description: 'The three or four digits of the card security code, typed by the owner for this one purchase. Never stored.' },
  confirm: BOOLEAN_SCHEMA,
}, ['purchaseId', 'windowId', 'code', 'confirm']);
export const PAYMENTS_PURCHASE_SECURITY_CODE_OUTPUT_SCHEMA = objectSchema({
  purchaseId: STRING_SCHEMA, windowId: STRING_SCHEMA, accepted: { const: true, type: 'boolean' },
}, ['purchaseId', 'windowId', 'accepted']);
export const PAYMENTS_PURCHASE_ANSWER_INPUT_SCHEMA = objectSchema({
  purchaseId: STRING_SCHEMA, windowId: STRING_SCHEMA, confirm: BOOLEAN_SCHEMA,
}, ['purchaseId', 'windowId', 'confirm']);
export const PAYMENTS_PURCHASE_ANSWER_OUTPUT_SCHEMA = objectSchema({
  purchaseId: STRING_SCHEMA, windowId: STRING_SCHEMA, accepted: BOOLEAN_SCHEMA,
  answer: enumSchema(['approve', 'deny', 'acknowledge', 'object']),
}, ['purchaseId', 'windowId', 'accepted', 'answer']);
export const PAYMENTS_PURCHASE_CANCEL_INPUT_SCHEMA = { oneOf: [
  PAYMENTS_PURCHASE_ANSWER_INPUT_SCHEMA,
  objectSchema({ purchaseId: STRING_SCHEMA, operationId: STRING_SCHEMA, confirm: BOOLEAN_SCHEMA }, ['purchaseId', 'operationId', 'confirm']),
] };
export const PAYMENTS_PURCHASE_CANCEL_OUTPUT_SCHEMA = { oneOf: [
  PAYMENTS_PURCHASE_ANSWER_OUTPUT_SCHEMA,
  objectSchema({ purchaseId: STRING_SCHEMA, operationId: STRING_SCHEMA, accepted: { const: true, type: 'boolean' }, mayHaveSubmitted: BOOLEAN_SCHEMA }, ['purchaseId', 'operationId', 'accepted', 'mayHaveSubmitted']),
] };
export const PAYMENTS_PURCHASE_RECONCILE_INPUT_SCHEMA = objectSchema({
  purchaseId: STRING_SCHEMA, operationId: STRING_SCHEMA, outcome: enumSchema(['purchased', 'not-purchased']),
  inspectedMerchantHistory: { type: 'boolean', const: true }, confirm: { type: 'boolean', const: true },
}, ['purchaseId', 'operationId', 'outcome', 'inspectedMerchantHistory', 'confirm']);
export const PAYMENTS_PURCHASE_RECONCILE_OUTPUT_SCHEMA = PAYMENT_OPERATION_SCHEMA;
const PAYMENT_RECONCILIATION_SCHEMA = objectSchema({
  purchaseId: STRING_SCHEMA, operationId: STRING_SCHEMA, outcome: enumSchema(['purchased', 'not-purchased']),
  principalId: STRING_SCHEMA, atMs: NUMBER_SCHEMA, merchantDomain: STRING_SCHEMA, totalMinorUnits: NUMBER_SCHEMA, currency: STRING_SCHEMA,
}, ['purchaseId', 'operationId', 'outcome', 'principalId', 'atMs', 'merchantDomain', 'totalMinorUnits', 'currency']);

/** One purchase, as the audit ledger recorded it. */
const PURCHASE_RECORD_SCHEMA = objectSchema(
  {
    purchaseId: STRING_SCHEMA,
    atUtc: STRING_SCHEMA,
    dayKey: STRING_SCHEMA,
    timezone: STRING_SCHEMA,
    merchantDomain: STRING_SCHEMA,
    item: STRING_SCHEMA,
    currency: STRING_SCHEMA,
    itemMinorUnits: NUMBER_SCHEMA,
    taxMinorUnits: NUMBER_SCHEMA,
    feesMinorUnits: NUMBER_SCHEMA,
    shippingMinorUnits: NUMBER_SCHEMA,
    totalMinorUnits: NUMBER_SCHEMA,
    /** Original owner maximum; absent on requests without one and earlier receipts. */
    requestedMaximumMinorUnits: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    shippingTierRequested: STRING_SCHEMA,
    shippingTierUsed: STRING_SCHEMA,
    /** Present when the ladder stepped delivery down to fit the overage pool. */
    steppedDown: BOOLEAN_SCHEMA,
    itemPoolDraw: NUMBER_SCHEMA,
    overagePoolDraw: NUMBER_SCHEMA,
    tolerancePoolDraw: NUMBER_SCHEMA,
    cardLast4: STRING_SCHEMA,
    /** approval | veto | none, which window ran, and how it ended. */
    windowKind: STRING_SCHEMA,
    windowOutcome: STRING_SCHEMA,
    /** Which command-authority channel actually answered, when one did. */
    answeredBy: nullableSchema(STRING_SCHEMA),
    outcome: STRING_SCHEMA,
    refusalReason: nullableSchema(STRING_SCHEMA),
    merchantOrderId: nullableSchema(STRING_SCHEMA),
    /** Set when money came back. Recorded for reconciliation; credits no pool. */
    refundedAt: nullableSchema(STRING_SCHEMA),
    /**
     * Whether the merchant carried established recourse, and on what grounds.
     *
     * This is the fact that decided what SILENCE meant on this purchase, so it
     * belongs in the row beside the outcome. Without it a reader can see that
     * one purchase asked and another did not, and cannot see why.
     */
    merchantRecognised: BOOLEAN_SCHEMA,
    merchantQualifier: nullableSchema(STRING_SCHEMA),
    /** Whether the owner named the storefront or it was found while browsing. */
    merchantDiscovered: BOOLEAN_SCHEMA,
    /** The owner's standing authorisation a scheduled or triggered purchase ran under; absent otherwise. */
    standingAuthorizationId: STRING_SCHEMA,
  },
  [
    'purchaseId', 'atUtc', 'dayKey', 'timezone', 'merchantDomain', 'item', 'currency',
    'itemMinorUnits', 'taxMinorUnits', 'feesMinorUnits', 'shippingMinorUnits', 'totalMinorUnits',
    'shippingTierRequested', 'shippingTierUsed', 'steppedDown',
    'itemPoolDraw', 'overagePoolDraw', 'tolerancePoolDraw', 'cardLast4',
    'windowKind', 'windowOutcome', 'answeredBy', 'outcome', 'refusalReason',
    'merchantOrderId', 'refundedAt',
    'merchantRecognised', 'merchantQualifier', 'merchantDiscovered',
  ],
);

export const PAYMENTS_PURCHASES_LIST_INPUT_SCHEMA = objectSchema(
  { limit: NUMBER_SCHEMA, dayKey: STRING_SCHEMA },
  [],
);

export const PAYMENTS_PURCHASES_LIST_OUTPUT_SCHEMA = objectSchema(
  { purchases: arraySchema(PURCHASE_RECORD_SCHEMA), total: NUMBER_SCHEMA, reconciliations: arraySchema(PAYMENT_RECONCILIATION_SCHEMA) },
  ['purchases', 'total'],
);


// ---------------------------------------------------------------------------
// payments.checkout.begin
// ---------------------------------------------------------------------------

/**
 * One line item, as the caller read it off the page.
 *
 * Every amount is a STRING here on purpose. The daemon parses these to integer
 * minor units with its own parser, which refuses anything ambiguous; accepting
 * a number would mean trusting whoever did the reading to have parsed
 * "1.299,00" the same way we would, and that is the exact mistake that costs a
 * factor of a thousand.
 */
const CHECKOUT_LINE_SCHEMA = objectSchema(
  { label: STRING_SCHEMA, quantity: STRING_SCHEMA, unitPrice: STRING_SCHEMA },
  ['label', 'quantity', 'unitPrice'],
);

const CHECKOUT_FEE_SCHEMA = objectSchema(
  { label: STRING_SCHEMA, amount: STRING_SCHEMA },
  ['label', 'amount'],
);

/** A promotion, credit or gift-card line; `amount` is what it takes off, as the page shows it. */
const CHECKOUT_DISCOUNT_SCHEMA = objectSchema(
  { label: STRING_SCHEMA, amount: STRING_SCHEMA },
  ['label', 'amount'],
);

const CHECKOUT_SHIPPING_OPTION_SCHEMA = objectSchema(
  { label: STRING_SCHEMA, cost: STRING_SCHEMA },
  ['label', 'cost'],
);

/** What the owner asked for, so the cart can be checked against it. */
const REQUESTED_LINE_SCHEMA = objectSchema(
  { label: STRING_SCHEMA, quantity: NUMBER_SCHEMA },
  ['label', 'quantity'],
);

const ADDRESS_FIELD_TARGET_SCHEMA = objectSchema(
  {
    kind: enumSchema(['shipping', 'billing']),
    field: enumSchema(['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country']),
    ref: STRING_SCHEMA,
  },
  ['kind', 'field', 'ref'],
);

const CARD_TARGET_SCHEMA = objectSchema(
  {
    field: enumSchema(['number', 'expiry', 'expiryMonth', 'expiryYear', 'cvv', 'cardholderName']),
    ref: STRING_SCHEMA,
  },
  ['field', 'ref'],
);

/**
 * Beginning a checkout.
 *
 * Note which `required` entries are present. The handler refuses without every
 * one of them, and a catalog that declared fewer would produce a 400 no
 * consumer could have predicted from the schema, the omission found in
 * method-catalog-email.ts, where the handler enforces `uid` and the descriptor
 * declares nothing.
 */
export const PAYMENTS_CHECKOUT_BEGIN_INPUT_SCHEMA = objectSchema(
  {
    /** Persist one ID before sending. Lost responses must query this same ID. */
    requestId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' },
    sessionId: STRING_SCHEMA,
    pageId: STRING_SCHEMA,
    merchantDomain: STRING_SCHEMA,
    checkoutUrl: STRING_SCHEMA,
    /** The owner's own words for what they asked to buy. Never a page title. */
    item: STRING_SCHEMA,
    cardId: { ...STRING_SCHEMA, description: 'A card id from payments.cards.list. Omitted, the purchase is paid with payments.defaultCardId.' },
    /** True when the agent found this storefront for the owner rather than the owner naming it. The domain is then graded for recourse instead of taint-checked; an unvouched shop asks the owner. */
    merchantDiscovered: BOOLEAN_SCHEMA,
    requestedLines: { ...arraySchema(REQUESTED_LINE_SCHEMA), minItems: 1 },
    lines: { ...arraySchema(CHECKOUT_LINE_SCHEMA), minItems: 1 },
    tax: STRING_SCHEMA,
    fees: arraySchema(CHECKOUT_FEE_SCHEMA),
    discounts: arraySchema(CHECKOUT_DISCOUNT_SCHEMA),
    shippingOptions: { ...arraySchema(CHECKOUT_SHIPPING_OPTION_SCHEMA), minItems: 1 },
    statedTotal: STRING_SCHEMA,
    currency: STRING_SCHEMA,
    orderSummaryText: STRING_SCHEMA,
    cardFields: { ...arraySchema(CARD_TARGET_SCHEMA), minItems: 1 },
    addressFields: arraySchema(ADDRESS_FIELD_TARGET_SCHEMA),
    shippingTargets: arraySchema(STRING_SCHEMA),
    placeOrderTarget: STRING_SCHEMA,
    preferredTier: enumSchema(['normal', 'fast', 'fastest']),
    expirySeparator: STRING_SCHEMA,
    twoDigitYear: BOOLEAN_SCHEMA,
    askedInSession: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$', description: 'The session whose turn began this purchase: the agent\'s operator call sets it from its own turn, so the purchase window names the chat it came from. A label only; it decides nothing about the purchase.' },
    standingId: { type: 'string', pattern: '^standing-[0-9a-f]{8}$', description: 'For a purchase a schedule or trigger starts, with nobody asking in the moment: the id of the owner\'s standing authorisation from payments.standing.list. The item must be that entry\'s item and the merchant one of its shops; the purchase may come to at most the smaller of its per-purchase maximum and what is left of its period. Omit it for a purchase the owner asked for now.' },
    requestedMax: { ...STRING_SCHEMA, pattern: '^\\d+(?:\\.\\d{1,3})?$', description: 'Owner-requested maximum for the entire purchase, including tax, mandatory fees and delivery. Supply one non-negative decimal amount in the configured budget currency, such as 20.00, without grouping, currency symbols or prose. Precision must fit that currency. Exceeding it requires a new explicit approval; silence never raises it. Required while payments.confirmEveryPurchase is on: it is the amount the owner approved.' },
  },
  [
    'requestId', 'sessionId', 'pageId', 'merchantDomain', 'checkoutUrl', 'item',
    'requestedLines', 'lines', 'shippingOptions', 'cardFields', 'placeOrderTarget',
  ],
);

/**
 * What comes back.
 *
 * Amounts are integers WE computed, never the merchant's text, and there is no
 * field here that could carry card material.
 */
export const PAYMENTS_CHECKOUT_BEGIN_OUTPUT_SCHEMA = objectSchema(
  {
    outcome: STRING_SCHEMA,
    purchaseId: nullableSchema(STRING_SCHEMA),
    reason: nullableSchema(STRING_SCHEMA),
    merchantOrderId: nullableSchema(STRING_SCHEMA),
    totalMinorUnits: nullableSchema(NUMBER_SCHEMA),
    currency: nullableSchema(STRING_SCHEMA),
    shippingTierUsed: nullableSchema(STRING_SCHEMA),
    steppedDown: BOOLEAN_SCHEMA,
    /** Set when 3-D Secure, a CAPTCHA or an OTP interrupted the submit. */
    challengeStep: nullableSchema(STRING_SCHEMA),
  },
  ['outcome', 'purchaseId', 'reason', 'merchantOrderId', 'totalMinorUnits', 'currency', 'shippingTierUsed', 'steppedDown', 'challengeStep'],
);

/** One standing authorisation: amounts are minor units of `currency`; `summary` is the line a surface shows. */
const STANDING_AUTHORIZATION_SCHEMA = objectSchema(
  {
    id: STRING_SCHEMA,
    item: STRING_SCHEMA,
    merchants: arraySchema(STRING_SCHEMA),
    currency: STRING_SCHEMA,
    maxPerPurchaseMinorUnits: NUMBER_SCHEMA,
    maxPerPeriodMinorUnits: NUMBER_SCHEMA,
    periodDays: NUMBER_SCHEMA,
    spentMinorUnits: NUMBER_SCHEMA,
    leftMinorUnits: NUMBER_SCHEMA,
    createdAt: STRING_SCHEMA,
    expiresAt: nullableSchema(STRING_SCHEMA),
    live: BOOLEAN_SCHEMA,
    summary: STRING_SCHEMA,
  },
  ['id', 'item', 'merchants', 'currency', 'maxPerPurchaseMinorUnits', 'maxPerPeriodMinorUnits', 'periodDays',
    'spentMinorUnits', 'leftMinorUnits', 'createdAt', 'expiresAt', 'live', 'summary'],
);

export const PAYMENTS_STANDING_LIST_INPUT_SCHEMA = objectSchema({}, []);
export const PAYMENTS_STANDING_LIST_OUTPUT_SCHEMA = objectSchema(
  { authorizations: arraySchema(STANDING_AUTHORIZATION_SCHEMA) },
  ['authorizations'],
);

export const PAYMENTS_STANDING_CREATE_INPUT_SCHEMA = objectSchema(
  {
    confirm: BOOLEAN_SCHEMA,
    item: { ...STRING_SCHEMA, description: 'The owner\'s words for what may be bought; a scheduled purchase must name exactly this item.' },
    merchants: { type: 'array', items: STRING_SCHEMA, minItems: 1, description: 'The shop domains it may be bought from.' },
    maxPerPurchase: { ...STRING_SCHEMA, description: 'The most one purchase may come to, in the budget currency, such as 60.00.' },
    maxPerPeriod: { ...STRING_SCHEMA, description: 'The most all purchases under it may come to within periodDays, in the budget currency.' },
    periodDays: { type: 'integer', minimum: 1, maximum: 366 },
    expires: { ...STRING_SCHEMA, description: 'Optional last day, such as 2027-06-30; absent, it lasts until removed.' },
  },
  ['confirm', 'item', 'merchants', 'maxPerPurchase', 'maxPerPeriod', 'periodDays'],
);
export const PAYMENTS_STANDING_CREATE_OUTPUT_SCHEMA = objectSchema(
  { created: BOOLEAN_SCHEMA, authorization: STANDING_AUTHORIZATION_SCHEMA },
  ['created', 'authorization'],
);

export const PAYMENTS_STANDING_DELETE_INPUT_SCHEMA = objectSchema(
  { confirm: BOOLEAN_SCHEMA, id: STRING_SCHEMA },
  ['confirm', 'id'],
);
export const PAYMENTS_STANDING_DELETE_OUTPUT_SCHEMA = objectSchema(
  { id: STRING_SCHEMA, deleted: BOOLEAN_SCHEMA },
  ['id', 'deleted'],
);
