import type { TriggerManager } from './manager.js';
import { TriggerMigrationRequiredError, TriggerStoreOwnershipError, TriggerStoreVersionError } from './store.js';
import { TRIGGER_OPERATOR_MESSAGES, type TriggerOperatorFailureKind, type TriggerOperatorStatus, type TriggerMigrationResult } from './operator-view.js';
export type TriggerOperatorSupervisor = Pick<TriggerManager, 'inspectRecords' | 'executionOwnership' | 'migratePrevious'>;
export class TriggerOperatorError extends Error {
  override readonly name = 'TriggerOperatorError';
  constructor(readonly kind: TriggerOperatorFailureKind) { super(TRIGGER_OPERATOR_MESSAGES[kind]); }
}
function translate(error: unknown): never {
  if (error instanceof TriggerOperatorError) throw error;
  if (error instanceof TriggerStoreVersionError) throw new TriggerOperatorError('future-version');
  if (error instanceof TriggerStoreOwnershipError) throw new TriggerOperatorError('other-process');
  if (error instanceof TriggerMigrationRequiredError) throw new TriggerOperatorError('migration-required');
  throw new TriggerOperatorError('unavailable');
}
/** Inspect the original supervisor without load/acquire/start or recovery effects. */
export function triggerOperatorStatus(supervisor: TriggerOperatorSupervisor): TriggerOperatorStatus {
  try {
    const records = supervisor.inspectRecords().map(record => Object.freeze({ id: record.definition.id,
      label: record.definition.label, kind: record.definition.spec.kind, state: record.state }));
    const ownership = supervisor.executionOwnership;
    return Object.freeze({ ownership, migrationRequired: ownership === 'migration-required', records: Object.freeze(records),
      message: ownership === 'migration-required' ? TRIGGER_OPERATOR_MESSAGES['migration-required']
        : ownership === 'other-process' ? TRIGGER_OPERATOR_MESSAGES['other-process']
        : ownership === 'local' ? 'This process owns trigger execution. No migration is required.'
        : 'This process has not claimed trigger execution. Start its normal runtime before requesting migration.' });
  } catch (error) { translate(error); }
}
/** The caller supplies an explicit operator statement, never inferred OS proof.
 * All actual execution/migration ownership remains with the original manager. */
export function migrateOperatorTriggers(supervisor: TriggerOperatorSupervisor, input: { readonly olderInstancesClosed: true }): TriggerMigrationResult {
  try {
    if (input.olderInstancesClosed !== true) throw new TriggerOperatorError('migration-required');
    const status = triggerOperatorStatus(supervisor);
    if (status.ownership === 'other-process') throw new TriggerOperatorError('other-process');
    if (!status.migrationRequired) throw new TriggerOperatorError('not-required');
    supervisor.migratePrevious({ olderInstancesClosed: true });
    const result = triggerOperatorStatus(supervisor);
    if (result.ownership !== 'local') throw new TriggerOperatorError(result.ownership === 'other-process' ? 'other-process' : 'unavailable');
    return Object.freeze({ migrated: true, status: result });
  } catch (error) { translate(error); }
}
