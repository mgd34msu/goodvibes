import type { PostalReadOptions } from '../config/postal-address.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { captureCheckoutOwnership, type CheckoutOperationOwnership } from './checkout-ownership.js';
/**
 * address.ts, the address on the order is the one the owner stored.
 *
 * ══ The defect this closes ════════════════════════════════════════════════
 *
 * The profile stores a shipping and a billing address and maps them into
 * config, and nothing in the checkout path read either. The card got typed into
 * the page and the delivery address did not, which made the profile
 * write-only for the exact purpose it was built for, the same shape of defect
 * as a card store nothing could read.
 *
 * ══ Why the DAEMON supplies the value ═════════════════════════════════════
 *
 * Not for concealment. An address is not a PAN and there is nothing to hide
 * from the model here, it is about the value being AUTHORITATIVE rather than
 * recalled. A model retyping a postcode from its memory of a conversation three
 * turns ago is a model that can drop a digit, and the failure is silent: the
 * order goes through, the notice looks right, and a parcel goes to a house
 * number that does not exist.
 *
 * So the split is the same as the card's: the model identifies which field on
 * the page wants what, and the daemon supplies every character.
 *
 * ══ Missing is a refusal, never a guess ═══════════════════════════════════
 *
 * No stored shipping address means stop and say which field is missing and how
 * to set it. Not: infer one from a previous order, from the billing address,
 * from a channel message, or from anything on the page. A half-filled address
 * form is worse than a refusal, because it can succeed.
 *
 * The owner-profile address text is the owner's own stored address too. With no
 * decision model to check how the session's model split it into fields, those
 * fields go on the order only through an explicit approval that lists every
 * field (silence buys nothing); text that could not be split is named in the
 * refusal, so the owner knows why it was not used.
 *
 * ══ Billing is INDEPENDENT of shipping ════════════════════════════════════
 *
 * There is no `payments.billingSameAsShipping` setting in the schema, checked,
 * not assumed. Absent an explicit instruction from the owner that they are the
 * same, they are two addresses, and a checkout asking for both requires both to
 * be stored. Defaulting billing to shipping would be this module inventing a
 * preference they never expressed, and on a card payment a wrong billing address
 * is a declined transaction at best and a fraud flag at worst.
 */
import { sanitizeOwnerNoticeField } from '../security/notice-text.js';
import type { PostalAddress } from './types.js';

export type AddressKind = 'shipping' | 'billing';

export type AddressFieldName =
  | 'name'
  | 'line1'
  | 'line2'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'country';

/**
 * Every field except `line2`, which is genuinely optional, plenty of addresses
 * have no second line, and requiring one would refuse a valid address, and
 * `region`, which only some countries use (see `countryUsesRegion`).
 */
const REQUIRED_FIELDS: readonly AddressFieldName[] = [
  'name',
  'line1',
  'city',
  'postalCode',
  'country',
];

/**
 * Countries whose postal addresses carry a state, province, prefecture or
 * similar region that carriers and checkouts expect. Elsewhere (Singapore,
 * the United Kingdom, the Netherlands, New Zealand and most of the world) a
 * region does not exist, so demanding one would make the owner invent a value
 * that is then typed into the merchant's form.
 */
const REGION_COUNTRIES: ReadonlySet<string> = new Set([
  'AE', 'AR', 'AU', 'BR', 'CA', 'CN', 'ES', 'ID', 'IN', 'IT', 'JP', 'KR', 'MX', 'MY', 'US',
]);

/** Spelled-out names owners commonly store for the region countries above. */
const REGION_COUNTRY_NAMES: Readonly<Record<string, string>> = {
  'united arab emirates': 'AE', argentina: 'AR', australia: 'AU', brazil: 'BR', brasil: 'BR', canada: 'CA',
  china: 'CN', spain: 'ES', 'españa': 'ES', indonesia: 'ID', india: 'IN', italy: 'IT', italia: 'IT',
  japan: 'JP', 'south korea': 'KR', korea: 'KR', 'republic of korea': 'KR', mexico: 'MX', 'méxico': 'MX',
  malaysia: 'MY', 'united states': 'US', 'united states of america': 'US', usa: 'US', 'u.s.a.': 'US', 'u.s.': 'US',
};

/** Whether an address in `country` (an ISO code or a common name) needs a region. */
export function countryUsesRegion(country: string): boolean {
  const value = country.trim();
  if (value.length === 0) return false;
  if (REGION_COUNTRIES.has(value.toUpperCase())) return true;
  return REGION_COUNTRY_NAMES[value.toLowerCase()] !== undefined;
}

/** The fields this stored address must have, given its country. */
function requiredFieldsFor(address: PostalAddress): readonly AddressFieldName[] {
  return countryUsesRegion(addressFieldValue(address, 'country'))
    ? [...REQUIRED_FIELDS.slice(0, 3), 'region', ...REQUIRED_FIELDS.slice(3)]
    : REQUIRED_FIELDS;
}

/** Where one address field goes on the page the model is looking at. */
export interface AddressFieldTarget {
  readonly kind: AddressKind;
  readonly field: AddressFieldName;
  /** Opaque to this module: a snapshot ref, resolved by the driver. */
  readonly target: string;
}

/**
 * The daemon's read path to the stored addresses.
 *
 * A port for the same reason `CardMaterialStore` is one: the checkout flow must
 * be drivable end to end without a config tree, and the assertion that the
 * order carries the STORED value needs a store a test can control.
 */
export interface AddressStore {
  /** Prepare a purchase-local snapshot. Legacy injected stores remain synchronous-data sources. */
  prepare?(kinds: readonly AddressKind[], options?: PostalReadOptions): Promise<AddressStore>;
  /** A retained restriction; never permission to transmit the address. */
  readonly assertCurrent?: (() => void) | undefined;
  read(kind: AddressKind, options?: PostalReadOptions): Promise<PostalAddress | null>;
  /**
   * With no decision model in use: whether this kind's address took fields
   * from the owner-profile address text that no decision model checked, or
   * that text could not be used. Undefined whenever a decision model read it.
   */
  profileText?(kind: AddressKind): ProfileAddressText | undefined;
}

/** How the owner-profile address text was used when no decision model read it. */
export type ProfileAddressText =
  | { readonly state: 'split-unchecked'; readonly fields: readonly AddressFieldName[] }
  | { readonly state: 'not-split' };

const FIELD_LABELS: Readonly<Record<AddressFieldName, string>> = {
  name: 'name', line1: 'line 1', line2: 'line 2', city: 'city', region: 'region', postalCode: 'postal code', country: 'country',
};

/** The sentence a refusal adds when the profile text was not read by a decision model. */
function profileTextNote(kind: AddressKind, profileText: ProfileAddressText | undefined): string {
  if (profileText?.state === 'not-split') {
    return ` Your owner profile has the ${kind} address written as text, but no decision model is in use and it could not be split into these fields, so it was not used.`;
  }
  if (profileText?.state === 'split-unchecked') {
    return ` The ${profileText.fields.map(field => FIELD_LABELS[field]).join(', ')} came from the ${kind} address text in your owner profile; the rest was not in it.`;
  }
  return '';
}

/**
 * One line for the purchase approval when address fields came from the
 * owner-profile text unchecked: every field typed into the order, so the owner
 * approves exactly what is sent. Null when nothing came from that text.
 */
export function renderUncheckedProfileAddress(address: PostalAddress | null, kind: AddressKind, profileText: ProfileAddressText | undefined): string | null {
  if (address === null || profileText?.state !== 'split-unchecked') return null;
  const fields = (Object.keys(FIELD_LABELS) as AddressFieldName[])
    .filter(field => addressFieldValue(address, field).trim().length > 0)
    .map(field => `${FIELD_LABELS[field]} '${sanitizeOwnerNoticeField(addressFieldValue(address, field), 120)}'`);
  return `the ${kind} address, read from the address text in your owner profile by your model: ${fields.join(', ')}`;
}

export interface AddressCheck {
  readonly ok: boolean;
  readonly missing: readonly AddressFieldName[];
  readonly reason: string | null;
}

/** One field's stored value. `line2`, and `region` outside the countries that use one, may be empty. */
export function addressFieldValue(address: PostalAddress, field: AddressFieldName): string {
  return address[field] ?? '';
}

/**
 * Whether a stored address is complete enough to put on an order.
 *
 * Names every missing field rather than the first, so one refusal tells the
 * owner everything they have to go and set.
 */
export function checkAddress(address: PostalAddress | null, kind: AddressKind, profileText?: ProfileAddressText): AddressCheck {
  if (address === null) {
    return {
      ok: false,
      missing: [...REQUIRED_FIELDS],
      reason:
        `Refused: no ${kind} address is stored, so I have nowhere to send this.${profileTextNote(kind, profileText)} `
        + `Set it in the TUI, the agent or the webui under payments.${kind}Address before asking me to buy something.`,
    };
  }
  const missing = requiredFieldsFor(address).filter((field) => addressFieldValue(address, field).trim().length === 0);
  if (missing.length === 0) return { ok: true, missing: [], reason: null };
  return {
    ok: false,
    missing,
    reason:
      `Refused: the stored ${kind} address is missing ${missing.join(', ')}.${profileTextNote(kind, profileText)} `
      + `I will not guess at an address or fill part of one, set the missing fields under payments.${kind}Address and ask me again.`,
  };
}

export interface AddressFillDeps extends CheckoutOperationOwnership {
  readonly store: AddressStore;
  readonly fill: (target: string, value: string) => Promise<void>;
}

export interface AddressFillResult {
  readonly ok: boolean;
  readonly filled: number;
  readonly failedField: string | null;
  readonly reason: string | null;
}

/**
 * Put the stored addresses on the page.
 *
 * Every kind the targets mention is read and checked BEFORE anything is typed,
 * so a checkout wanting both addresses with only one stored refuses without
 * having half-filled the form.
 */
export async function fillAddresses(
  targets: readonly AddressFieldTarget[],
  deps: AddressFillDeps,
): Promise<AddressFillResult> {
  deps = { ...deps };
  targets = targets.map(target => Object.freeze({ ...target }));
  const owner = captureCheckoutOwnership(deps);
  const storedOwner = captureCheckoutOwnership({ signal: owner.signal, assertCurrent: deps.store.assertCurrent?.bind(deps.store) });
  const current = () => { owner.assertCurrent(); storedOwner.assertCurrent(); };
  const kinds = [...new Set(targets.map((entry) => entry.kind))];
  const resolved = new Map<AddressKind, PostalAddress>();

  try {
    for (const kind of kinds) {
      current();
      const address = captureOwnedJson(await deps.store.read(kind, { signal: owner.signal })) as PostalAddress | null;
      current();
      const check = checkAddress(address, kind, deps.store.profileText?.(kind));
      if (!check.ok || address === null) {
        return { ok: false, filled: 0, failedField: `${kind}.${check.missing[0] ?? 'address'}`, reason: check.reason };
      }
      resolved.set(kind, address);
    }
  } catch { return { ok: false, filled: 0, failedField: 'address', reason: 'The stored address reading is unavailable or no longer current.' }; }

  let filled = 0;
  for (const entry of targets) {
    const address = resolved.get(entry.kind);
    if (address === undefined) continue;
    const value = addressFieldValue(address, entry.field);
    // line2 and a region the country does not use are the fields allowed to
    // be empty, and an empty fill would clear whatever the page had rather
    // than leaving it alone.
    if (value.trim().length === 0 && (entry.field === 'line2' || entry.field === 'region')) continue;
    try {
      current();
      await deps.fill(entry.target, value);
      current();
    } catch {
      return {
        ok: false,
        filled,
        failedField: `${entry.kind}.${entry.field}`,
        reason: `The ${entry.kind} ${entry.field} field could not be filled on this checkout.`,
      };
    }
    filled += 1;
  }
  return { ok: true, filled, failedField: null, reason: null };
}

/**
 * The destination, for the message the owner is being asked to veto.
 *
 * The owner should be able to see WHERE it is going in the notice, not only
 * what it costs, a correct total to the wrong address is still a wrong
 * order, and this is the last point at which they can catch it.
 *
 * Rendered from the STORED value and sanitized like every other notice field.
 * The address is the owner's own text, so it goes through the owner-field sanitize
 * which keeps underscores, but it is still neutralised rather than trusted:
 * a guarantee that holds only while every call site threads provenance
 * correctly is not a guarantee.
 */
export function renderDestination(address: PostalAddress | null): string | null {
  if (address === null) return null;
  const parts = [
    addressFieldValue(address, 'name'),
    addressFieldValue(address, 'line1'),
    // The flat or unit number is the part most likely to be wrong, so the
    // owner sees it in the notice.
    addressFieldValue(address, 'line2'),
    addressFieldValue(address, 'city'),
    addressFieldValue(address, 'region'),
    addressFieldValue(address, 'postalCode'),
    addressFieldValue(address, 'country'),
  ].filter((part) => part.trim().length > 0);
  if (parts.length === 0) return null;
  return sanitizeOwnerNoticeField(parts.join(', '), 200);
}
