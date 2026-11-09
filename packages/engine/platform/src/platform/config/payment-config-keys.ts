/** Canonical payment config references. Card bytes remain in the daemon secret store. */
import type { ConfigKey } from './schema.js';

export const PAYMENTS_CARD_NUMBER_CONFIG_KEY = 'payments.cardNumber' as ConfigKey;
export const PAYMENTS_CARD_EXPIRY_CONFIG_KEY = 'payments.cardExpiry' as ConfigKey;
export const PAYMENTS_CARD_CVV_CONFIG_KEY = 'payments.cardCvv' as ConfigKey;
export const PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY = 'payments.cardholderName' as ConfigKey;

/** The real platform schema key for the CVV-handling selector, not synthetic. */
export const PAYMENTS_CVV_HANDLING_CONFIG_KEY: ConfigKey = 'payments.cvvHandling';

/**
 * The real platform schema keys for the two addresses, in the order the guided
 * `/payments address` flow asks for them.
 *
 * These are ordinary (non-secret) CONFIG_SCHEMA string keys, listed here only
 * so the command and its tests share one ordering, not to redefine the schema.
 * A postal address is not a credential: it is printed on every parcel and is
 * already visible in the settings modal, so it is entered in the CLEAR. Routing
 * it through the concealed-input path would mask something that does not need
 * masking, and would teach the reflex that bullets mean "this field is fine to
 * type anywhere", the opposite of what the card fields need it to mean.
 */
export const PAYMENTS_ADDRESS_FIELD_SUFFIXES: readonly string[] = ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'];

export type PaymentsAddressKind = 'billing' | 'shipping';

/**
 * The fourteen address keys, written out as literals rather than assembled from
 * a template.
 *
 * A `payments.${kind}Address.${field}` template is shorter and is the wrong
 * choice here. Written out, these keys are greppable, someone auditing what
 * the payment flow writes to the daemon's config can find every one of them by
 * searching for the key they are looking at, and the repo's own settings
 * coverage scan (verification/settings-consumed-keys.ts) can see that this
 * code consumes them, which a runtime-assembled string hides. A
 * typo in a template also produces a silently wrong key that ConfigManager
 * accepts, because a flat leaf under an existing section is tolerated.
 */
const PAYMENTS_ADDRESS_KEYS: Readonly<Record<PaymentsAddressKind, Readonly<Record<string, ConfigKey>>>> = {
  billing: {
    name: 'payments.billingAddress.name',
    line1: 'payments.billingAddress.line1',
    line2: 'payments.billingAddress.line2',
    city: 'payments.billingAddress.city',
    region: 'payments.billingAddress.region',
    postalCode: 'payments.billingAddress.postalCode',
    country: 'payments.billingAddress.country',
  },
  shipping: {
    name: 'payments.shippingAddress.name',
    line1: 'payments.shippingAddress.line1',
    line2: 'payments.shippingAddress.line2',
    city: 'payments.shippingAddress.city',
    region: 'payments.shippingAddress.region',
    postalCode: 'payments.shippingAddress.postalCode',
    country: 'payments.shippingAddress.country',
  },
};

/** `payments.billingAddress.line1` etc. Throws on an unknown field rather than inventing a key. */
export function paymentsAddressConfigKey(kind: PaymentsAddressKind, field: string): ConfigKey {
  const fields = PAYMENTS_ADDRESS_KEYS[kind];
  const key = Object.hasOwn(fields, field) ? fields[field] : undefined;
  if (key === undefined) throw new Error(`Unknown payments address field "${field}".`);
  return key;
}

export function paymentsAddressConfigKeys(kind: PaymentsAddressKind): readonly ConfigKey[] {
  return PAYMENTS_ADDRESS_FIELD_SUFFIXES.map((field) => paymentsAddressConfigKey(kind, field));
}

export const PAYMENTS_SYNTHETIC_CONFIG_KEYS: readonly ConfigKey[] = [
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
];

export function isPaymentsSyntheticConfigKey(key: string): key is ConfigKey {
  return (PAYMENTS_SYNTHETIC_CONFIG_KEYS as readonly string[]).includes(key);
}
