/** Async address reads are distinct from missing settings and bulk config dumps. */
export const POSTAL_PARTS = ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const;
export type PostalPart = typeof POSTAL_PARTS[number];
export type PostalKind = 'shipping' | 'billing';
export type PostalParts = Readonly<Record<PostalPart, string>>;
export class PostalAddressHeldError extends Error {
  constructor() { super('The stored address needs a current verified reading before it can be used.'); this.name = 'PostalAddressHeldError'; }
}
export interface PreparedPostalAddress {
  readonly provenance?: 'classic';
  /** Without a decision model, no decision model checked any field taken from the owner-profile address text. */
  readonly profileAssessment?: 'not-evaluated';
  /**
   * Without a decision model, how the owner-profile address text was used:
   * `split-unchecked` when the session's model split it into fields that no
   * decision model checked (`splitParts` names the fields taken from it), so a
   * purchase asks the owner to approve them; `not-split` when it could not be
   * split and was not used.
   */
  readonly profileText?: 'split-unchecked' | 'not-split';
  readonly splitParts?: readonly PostalPart[];
  readonly value: PostalParts | null;
  /** Restriction only, never permission to disclose or place an order. */
  readonly assertCurrent: () => void;
}
export interface PostalReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export type ProfilePostalReader = (kind: PostalKind, options: PostalReadOptions) => Promise<PreparedPostalAddress>;

