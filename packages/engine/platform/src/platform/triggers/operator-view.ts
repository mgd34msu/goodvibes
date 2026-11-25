/** Runtime-neutral operator projection. Never includes commands, arguments,
 * grant material, observations or process output. */
export type TriggerExecutionOwnership = 'local' | 'other-process' | 'unclaimed';
export interface TriggerOperatorRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly state: string;
}
export interface TriggerOperatorStatus {
  readonly ownership: TriggerExecutionOwnership;
  readonly records: readonly TriggerOperatorRecord[];
  readonly message: string;
}
export type TriggerOperatorFailureKind = 'other-process' | 'future-version' | 'unavailable';
export const TRIGGER_OPERATOR_MESSAGES: Readonly<Record<TriggerOperatorFailureKind, string>> = Object.freeze({
  'other-process': 'Another GoodVibes process supervises these triggers. Inspect them here, or close that process: this one takes over on its next supervision tick.',
  'future-version': 'This trigger state was written by a newer GoodVibes reader. Update this installation before continuing; the saved state has been preserved.',
  unavailable: 'Trigger state could not be read. The daemon log names the file and the cause; check that file and its permissions; Automation reads the triggers again when they can be read.',
});
export function readTriggerOperatorStatus(value: unknown): TriggerOperatorStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid trigger status');
  const row = value as Record<string, unknown>;
  if (!['local', 'other-process', 'unclaimed'].includes(String(row['ownership']))
    || typeof row['message'] !== 'string' || !Array.isArray(row['records'])) throw new Error('Invalid trigger status');
  const records = row['records'].map((entry: unknown): TriggerOperatorRecord => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid trigger record');
    const record = entry as Record<string, unknown>;
    if (typeof record['id'] !== 'string' || typeof record['label'] !== 'string' || typeof record['kind'] !== 'string' || typeof record['state'] !== 'string') throw new Error('Invalid trigger record');
    return Object.freeze({ id: record['id'], label: record['label'], kind: record['kind'], state: record['state'] });
  });
  return Object.freeze({ ownership: row['ownership'] as TriggerExecutionOwnership, records: Object.freeze(records), message: row['message'] });
}
