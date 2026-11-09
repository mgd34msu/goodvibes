import { validateKnowledgeRowRevisions } from './store-row-revisions.js';
import { validateKnowledgeNodeContentRevisions } from './store-node-content-revisions.js';
import { validateKnowledgeNodeActivationCache } from './store-node-activation-cache.js';
import type { SqlDatabase } from '../state/sqlite-store.js';
import { validateWorkLedgerTable } from './store-work-ledger.js';
import { validateNativeWorkExecutionTable, validateNativeWorkExecutionIntentTable, validateNativeWorkSettlementTable } from './store-native-work-execution.js';
import { validateNativeConversationCaptureTable } from './store-native-intake.js';
import { validateNativeCiContinuationTable } from './store-native-ci-continuation.js';
import { validateKnowledgeEdgeChanges } from './store-edge-generations.js';

/** Original v12 invariants must hold before an additive v13 migration. */
export function validateKnowledgeSchemaV12(db: Pick<SqlDatabase, 'exec'>): void {
  validateWorkLedgerTable(db);
  validateNativeWorkExecutionTable(db);
  validateNativeWorkExecutionIntentTable(db);
  validateNativeConversationCaptureTable(db);
  validateNativeWorkSettlementTable(db);
  validateNativeCiContinuationTable(db);
  validateKnowledgeEdgeChanges(db);
  validateKnowledgeRowRevisions(db);
}

/** Complete current schema checks, shared with the closed native read plan. */
export function validateCurrentKnowledgeSchema(db: Pick<SqlDatabase, 'exec'>): void {
  validateKnowledgeSchemaV12(db);
  validateKnowledgeNodeContentRevisions(db);
  validateKnowledgeNodeActivationCache(db);
}
