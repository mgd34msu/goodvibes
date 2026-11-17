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
  /** Classic returns native stored fields; no prose profile address was interpreted. */
  readonly profileAssessment?: 'not-evaluated';
  readonly value: PostalParts | null;
  /** Restriction only, never permission to disclose or place an order. */
  readonly assertCurrent: () => void;
}
export interface PostalReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export type ProfilePostalReader = (kind: PostalKind, options: PostalReadOptions) => Promise<PreparedPostalAddress>;

