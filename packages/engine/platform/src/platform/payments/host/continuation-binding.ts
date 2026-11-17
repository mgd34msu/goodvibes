/** A lossless private operation reference, not a content fingerprint. The
 * existing grant format has a fixed 32-byte field: 16-byte domain tag followed
 * by the original operation UUID's 16 bytes. No new retry identity is minted.
 * Operation ids are plain UUIDs; an id saved with the earlier spelling (each
 * hex digit written as a letter a to p) names the same 16 bytes. */
import type { NativeContinuationGrant } from '../../pairing/pairing-token-store.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { PaymentOperationStoreError } from './operation-store.js';

const PREFIX = Buffer.from('payment-op/v1').toString('hex').padEnd(32, '0');
export function paymentContinuationBinding(operationId: string): string {
  const match = /^payment-operation:([0-9a-p]{8}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{12})$/.exec(operationId);
  const uuid = match?.[1]?.replace(/-/g, ''); if (!uuid) throw new PaymentOperationStoreError('unavailable');
  // A plain v4 UUID always holds the digit 4, so a run of letters alone is the earlier spelling.
  if (/^[a-p]{32}$/.test(uuid)) return PREFIX + uuid.replace(/[a-p]/g, nibble => (nibble.charCodeAt(0) - 97).toString(16));
  if (/^[0-9a-f]{32}$/.test(uuid)) return PREFIX + uuid;
  throw new PaymentOperationStoreError('unavailable');
}

/** Parsing verifies a reference's shape/binding only. The original pairing
 * owner must independently confirm its actual issued and unrevoked record. */
export function capturePaymentContinuation(value: unknown, operationId: string): NativeContinuationGrant {
  const grant = captureOwnedJson(value);
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw new PaymentOperationStoreError('unavailable');
  const row = grant as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || typeof row['id'] !== 'string'
    || !/^continuation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row['id'])
    || row['binding'] !== paymentContinuationBinding(operationId)) throw new PaymentOperationStoreError('unavailable');
  return grant as unknown as NativeContinuationGrant;
}
