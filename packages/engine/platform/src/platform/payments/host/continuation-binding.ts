/** A lossless private operation reference, not a content fingerprint. The
 * existing grant format has a fixed 32-byte field: 16-byte domain tag followed
 * by the original operation UUID's 16 bytes. No new retry identity is minted. */
import type { NativeContinuationGrant } from '../../pairing/pairing-token-store.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { PaymentOperationStoreError } from './operation-store.js';

const PREFIX = Buffer.from('payment-op/v1').toString('hex').padEnd(32, '0');
export function paymentContinuationBinding(operationId: string): string {
  const match = /^payment-operation:([a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12})$/.exec(operationId);
  const uuid = match?.[1]; if (!uuid) throw new PaymentOperationStoreError('unavailable');
  return PREFIX + uuid.replace(/-/g, '').replace(/[a-p]/g, nibble => (nibble.charCodeAt(0) - 97).toString(16));
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
