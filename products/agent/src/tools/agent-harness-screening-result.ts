/** Admit only the source owner's finite result protocol. A parsed receipt still
 * needs the native owner's project() to authenticate its source and lifetime. */
import { types as nodeTypes } from 'node:util';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { SourceScreeningHold, SourceScreeningReceipt } from '@goodvibes-jev/engine/platform/platform/security';

const holds = Object.freeze({
  'route-unavailable': true, 'protected-input': true, malformed: true, unsettled: true,
  cancelled: true, stale: true, capacity: true, busy: true,
} satisfies Record<SourceScreeningHold, true>);

function resultFields(value: unknown): PropertyDescriptorMap | undefined {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(value).length !== 2) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!Object.hasOwn(fields, 'status') || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) return undefined;
  return fields;
}

/** Never read a borrowed result getter, coerce its reason or export its values. */
export function requireSettledScreeningReceipt(value: unknown): SourceScreeningReceipt {
  const fields = resultFields(value);
  const status: unknown = fields?.status?.value;
  const receipt: unknown = fields && Object.hasOwn(fields, 'receipt') ? fields.receipt?.value : undefined;
  if (fields && status === 'settled' && receipt && typeof receipt === 'object' && !nodeTypes.isProxy(receipt)) {
    return receipt as SourceScreeningReceipt;
  }
  const error = new ToolInputProjectionError('held');
  const reason: unknown = fields && Object.hasOwn(fields, 'reason') ? fields.reason?.value : undefined;
  if (status === 'held' && typeof reason === 'string' && Object.hasOwn(holds, reason)) {
    Object.defineProperty(error, 'cause', { value: Object.freeze({ code: 'source-screening-held', reason }) });
  }
  throw error;
}
