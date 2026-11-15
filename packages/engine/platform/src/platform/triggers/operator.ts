import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { TriggerManager } from './manager.js';
import { StoreSchemaDowngradeError } from '../state/store-versioning.js';
import { TriggerStoreOwnershipError } from './store.js';
import { TRIGGER_OPERATOR_MESSAGES, type TriggerOperatorFailureKind, type TriggerOperatorStatus, type TriggerMigrationResult } from './operator-view.js';
export type TriggerOperatorSupervisor = Pick<TriggerManager, 'inspectRecords' | 'executionOwnership'>;
export class TriggerOperatorError extends Error {
  override readonly name = 'TriggerOperatorError';
  constructor(readonly kind: TriggerOperatorFailureKind) { super(TRIGGER_OPERATOR_MESSAGES[kind]); }
}
function translate(error: unknown): never {
  if (error instanceof TriggerOperatorError) throw error;
  if (error instanceof StoreSchemaDowngradeError) throw new TriggerOperatorError('future-version');
  if (error instanceof TriggerStoreOwnershipError) throw new TriggerOperatorError('other-process');
  // The wire text stays generic; the real cause is kept for whoever reads the daemon log.
  logger.warn('Trigger operator request failed on an unexpected error', { error: summarizeError(error) });
  throw new TriggerOperatorError('unavailable');
}
/** Inspect the original supervisor without load/acquire/start or recovery effects. */
export function triggerOperatorStatus(supervisor: TriggerOperatorSupervisor): TriggerOperatorStatus {
  try {
    const records = supervisor.inspectRecords().map(record => Object.freeze({ id: record.definition.id,
      label: record.definition.label, kind: record.definition.spec.kind, state: record.state }));
    const ownership = supervisor.executionOwnership;
    return Object.freeze({ ownership, migrationRequired: false, records: Object.freeze(records),
      message: ownership === 'other-process' ? TRIGGER_OPERATOR_MESSAGES['other-process']
        : ownership === 'local' ? 'This process supervises these triggers.'
        : records.length === 0 ? 'No triggers are stored for this surface.'
        : 'No process supervises these triggers yet. They start when watchers.triggers.enabled is true.' });
  } catch (error) { translate(error); }
}
/**
 * Earlier trigger state is imported when the trigger database is created, so
 * there is never a migration to request; this answers that, with the status.
 */
export function migrateOperatorTriggers(supervisor: TriggerOperatorSupervisor, input: { readonly olderInstancesClosed: true }): TriggerMigrationResult {
  try {
    void input;
    const status = triggerOperatorStatus(supervisor);
    if (status.ownership === 'other-process') throw new TriggerOperatorError('other-process');
    throw new TriggerOperatorError('not-required');
  } catch (error) { translate(error); }
}
