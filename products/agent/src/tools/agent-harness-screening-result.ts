/** Admit only the source owner's finite result protocol. A parsed receipt still
 * needs the native owner's project() to authenticate its source and lifetime. */
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { SourceScreeningHold, SourceScreeningReceipt } from '@goodvibes-jev/engine/platform/platform/security';

const holds = Object.freeze({
  'route-unavailable': true, 'proxy-configured': true, 'protected-input': true, malformed: true, unsettled: true,
  cancelled: true, stale: true, busy: true,
} satisfies Record<SourceScreeningHold, true>);

/** The owner's result as its two fields, or undefined when it is not one. */
function resultFields(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, 'status')) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

/** A settled result's receipt; anything else is held, with the owner's reason when it names one. */
export function requireSettledScreeningReceipt(value: unknown): SourceScreeningReceipt {
  const fields = resultFields(value);
  const status: unknown = fields?.status;
  const receipt: unknown = fields?.receipt;
  if (fields && status === 'settled' && receipt && typeof receipt === 'object') {
    return receipt as SourceScreeningReceipt;
  }
  const error = new ToolInputProjectionError('held');
  const reason: unknown = fields?.reason;
  if (status === 'held' && typeof reason === 'string' && Object.hasOwn(holds, reason)) {
    Object.defineProperty(error, 'cause', { value: Object.freeze({ code: 'source-screening-held', reason }) });
  }
  throw error;
}
