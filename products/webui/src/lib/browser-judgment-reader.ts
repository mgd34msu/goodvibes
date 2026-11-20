import type { BrowserJudgmentBatteryId, BrowserJudgmentValueMap } from '@goodvibes/engine/daemon-api';

export type BrowserJudgmentReading<K extends BrowserJudgmentBatteryId> =
  | { readonly status: 'settled'; readonly value: BrowserJudgmentValueMap[K] }
  | { readonly status: 'held' };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * The one reader of the daemon's judgment reply. The daemon's projection already proved that
 * the readings support the value before sending it, so this checks only that the reply answers
 * this request (protocol, battery, version, request id) and returns the value or `held`.
 * Unknown fields are ignored, so an additive change on the daemon never blanks a feature;
 * the caller reads only the value fields it uses.
 */
/** The identity fields of a `BrowserJudgmentRequest`; the battery names the value type. */
export interface BrowserJudgmentRequestIdentity<K extends BrowserJudgmentBatteryId> {
  readonly protocolVersion: number;
  readonly requestId: string;
  readonly battery: K;
  readonly batteryVersion: number;
}

export function readBrowserJudgment<K extends BrowserJudgmentBatteryId>(request: BrowserJudgmentRequestIdentity<K>, raw: unknown): BrowserJudgmentReading<K> | undefined {
  const reply = record(raw);
  if (!reply || reply.protocolVersion !== request.protocolVersion || reply.batteryVersion !== request.batteryVersion
    || reply.battery !== request.battery || reply.requestId !== request.requestId) return undefined;
  if (reply.status === 'held') return { status: 'held' };
  const value = record(reply.value);
  return reply.status === 'settled' && value ? { status: 'settled', value: value as BrowserJudgmentValueMap[K] } : undefined;
}
