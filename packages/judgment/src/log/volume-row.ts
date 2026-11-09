import type { DecisionId, DecisionVolumeEntry } from './types.ts';

/** Fixed native result columns only, validated before counters leave SQLite. */
export interface DecisionVolumeRow {
  readonly id: unknown;
  readonly battery: unknown;
  readonly site: unknown;
  readonly context_kind: unknown;
  readonly battery_kind: unknown;
  readonly site_kind: unknown;
  readonly lineage_kind: unknown;
  readonly logical_id: unknown;
  readonly logical_kind: unknown;
  readonly attempts_kind: unknown;
  readonly attempt_count: unknown;
  readonly omitted_count: unknown;
  readonly omitted_kind: unknown;
  readonly wire_attempts: unknown;
  readonly unknown_attempts: unknown;
  readonly invalid_attempts: unknown;
}
function invalid(): never { throw new Error('Decision volume counters are unavailable.'); }
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function label(value: unknown, kind: unknown): string | undefined {
  if (kind === null || kind === 'null') { if (value !== null) invalid(); return undefined; }
  if (kind !== 'text' || typeof value !== 'string') invalid();
  return value;
}
export function decisionVolumeRow(row: DecisionVolumeRow): DecisionVolumeEntry {
  if (typeof row.id !== 'string' || row.context_kind !== 'object') invalid();
  const battery = label(row.battery, row.battery_kind), site = label(row.site, row.site_kind);
  const context = Object.freeze({ ...(battery === undefined ? {} : { battery }), ...(site === undefined ? {} : { site }) });
  const missing = row.lineage_kind === null || row.lineage_kind === 'null';
  if (missing) return Object.freeze({ id: row.id as DecisionId, context, volume: Object.freeze({
    targetAttempts: 0, wireAttempts: 0, unknownDispatchAttempts: 0, callsWithoutAttemptEvidence: 1 as const,
  }) });
  if (row.lineage_kind !== 'object' || row.attempts_kind !== 'array' || count(row.invalid_attempts) !== 0) invalid();
  const logicalRequestId = label(row.logical_id, row.logical_kind);
  const attempts = count(row.attempt_count), wireAttempts = count(row.wire_attempts), unknown = count(row.unknown_attempts);
  let omitted = 0;
  if (row.omitted_kind !== null && row.omitted_kind !== 'null') {
    if (row.omitted_kind !== 'integer' && row.omitted_kind !== 'real') invalid();
    omitted = count(row.omitted_count);
  }
  if (wireAttempts + unknown > attempts) invalid();
  const targetAttempts = count(attempts + omitted), unknownDispatchAttempts = count(unknown + omitted);
  return Object.freeze({ id: row.id as DecisionId, context, volume: Object.freeze({
    ...(logicalRequestId === undefined ? {} : { logicalRequestId }), targetAttempts, wireAttempts, unknownDispatchAttempts,
    callsWithoutAttemptEvidence: attempts === 0 && omitted === 0 ? 1 as const : 0 as const,
  }) });
}
