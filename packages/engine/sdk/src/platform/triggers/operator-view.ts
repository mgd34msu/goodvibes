/** Runtime-neutral operator projection. Never includes commands, arguments,
 * grant material, observations or process output. */
export type TriggerExecutionOwnership = 'local' | 'other-process' | 'migration-required' | 'unclaimed';
export interface TriggerOperatorRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly state: string;
}
export interface TriggerOperatorStatus {
  readonly ownership: TriggerExecutionOwnership;
  readonly migrationRequired: boolean;
  readonly records: readonly TriggerOperatorRecord[];
  readonly message: string;
}
export interface TriggerMigrationResult { readonly migrated: true; readonly status: TriggerOperatorStatus }
export type TriggerOperatorFailureKind = 'other-process' | 'migration-required' | 'not-required' | 'future-version' | 'unavailable';
export const TRIGGER_OPERATOR_MESSAGES: Readonly<Record<TriggerOperatorFailureKind, string>> = Object.freeze({
  'other-process': 'Another GoodVibes process owns these triggers. Inspect them here, or close that process and reopen the owning surface before migrating.',
  'migration-required': 'Close every older GoodVibes instance using these triggers, then explicitly acknowledge that they are closed before migrating. This acknowledgement is your statement, not a process-liveness check.',
  'not-required': 'These triggers do not currently require migration. Refresh their status before taking another action.',
  'future-version': 'This trigger state was written by a newer GoodVibes reader. Update this installation before continuing; the saved state has been preserved.',
  unavailable: 'Trigger state or its original owner is unavailable. Check the selected surface, storage permissions and active GoodVibes processes, then reopen trigger recovery. Saved state has been preserved.',
});
export function readTriggerOperatorStatus(value: unknown): TriggerOperatorStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid trigger status');
  const row = value as Record<string, unknown>;
  if (!['local', 'other-process', 'migration-required', 'unclaimed'].includes(String(row['ownership']))
    || row['migrationRequired'] !== (row['ownership'] === 'migration-required') || typeof row['message'] !== 'string' || !Array.isArray(row['records'])) throw new Error('Invalid trigger status');
  const records = row['records'].map((entry: unknown): TriggerOperatorRecord => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid trigger record');
    const record = entry as Record<string, unknown>;
    if (typeof record['id'] !== 'string' || typeof record['label'] !== 'string' || typeof record['kind'] !== 'string' || typeof record['state'] !== 'string') throw new Error('Invalid trigger record');
    return Object.freeze({ id: record['id'], label: record['label'], kind: record['kind'], state: record['state'] });
  });
  return Object.freeze({ ownership: row['ownership'] as TriggerExecutionOwnership, migrationRequired: row['migrationRequired'] as boolean, records: Object.freeze(records), message: row['message'] });
}
export function readTriggerMigrationResult(value: unknown): TriggerMigrationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('migrated' in value) || value.migrated !== true || !('status' in value)) throw new Error('Invalid trigger migration result');
  return Object.freeze({ migrated: true, status: readTriggerOperatorStatus(value.status) });
}
