import { validateHomeGraphSourceIdentityIndexes } from './store-homegraph-source-selector.js';
import { validateHomeGraphNodeIdentityIndexes } from './store-homegraph-node-selector.js';
import { validateSemanticNodeIdentityIndex } from './store-semantic-node-selector.js';
import { validateSemanticFactIdentityIndex } from './store-semantic-fact-selector.js';
import { validateKnowledgeRowRevisions } from './store-row-revisions.js';
import { validateKnowledgeNodeContentRevisions } from './store-node-content-revisions.js';
import { validateKnowledgeNodeActivationCache } from './store-node-activation-cache.js';
import { validateGeneratedProjectionIdentityIndex } from './store-generated-projection-selector.js';
import { validateArtifactReferenceIndexes } from './store-artifact-references.js';
import type { SqlDatabase } from '../state/sqlite-store.js';
import { validateWorkLedgerTable } from './store-work-ledger.js';
import { validateNativeWorkExecutionTable, validateNativeWorkExecutionIntentTable, validateNativeWorkSettlementTable } from './store-native-work-execution.js';
import { validateNativeConversationCaptureTable } from './store-native-intake.js';
import { validateNativeCiContinuationTable } from './store-native-ci-continuation.js';
import { validateNativeWorkIntentAndSettlementLayouts } from './store-native-work-tables.js';
import { validateKnowledgeEdgeChanges } from './store-edge-generations.js';

/**
 * Original v12 invariants must hold before an additive v13 migration.
 * `nativeWorkRows` walks every native execution intent, settlement and CI
 * continuation row: a migration asks for it once. The current-schema check,
 * which runs again whenever another writer changed the image, checks only
 * their layout, since each of those rows is checked where it is written and
 * where it is read (store-native-work-tables.ts).
 */
export function validateKnowledgeSchemaV12(db: Pick<SqlDatabase, 'exec'>, nativeWorkRows = true): void {
  validateWorkLedgerTable(db);
  validateNativeWorkExecutionTable(db);
  if (nativeWorkRows) { validateNativeWorkExecutionIntentTable(db); validateNativeWorkSettlementTable(db); }
  else validateNativeWorkIntentAndSettlementLayouts(db);
  validateNativeConversationCaptureTable(db);
  validateNativeCiContinuationTable(db, nativeWorkRows);
  validateKnowledgeEdgeChanges(db);
  validateKnowledgeRowRevisions(db);
}

/** Original v13 accepts the native activation dependency tables. */
export function validateKnowledgeSchemaV13(db: Pick<SqlDatabase, 'exec'>, nativeWorkRows = true): void {
  validateKnowledgeSchemaV12(db, nativeWorkRows);
  validateKnowledgeNodeContentRevisions(db);
  validateKnowledgeNodeActivationCache(db);
}

/** Original v14 projection, artifact and exact fact lookup invariants. */
export function validateKnowledgeSchemaV14(db: Pick<SqlDatabase, 'exec'>, nativeWorkRows = true): void {
  validateKnowledgeSchemaV13(db, nativeWorkRows);
  validateGeneratedProjectionIdentityIndex(db);
  validateArtifactReferenceIndexes(db);
  validateSemanticFactIdentityIndex(db);
}


/** Original v15 includes actual semantic-role selectors. */
export function validateKnowledgeSchemaV15(db: Pick<SqlDatabase, 'exec'>, nativeWorkRows = true): void {
  validateKnowledgeSchemaV14(db, nativeWorkRows);
  validateSemanticNodeIdentityIndex(db);
}

/** Original v16 includes exact Home Graph object tuple selectors. */
export function validateKnowledgeSchemaV16(db: Pick<SqlDatabase, 'exec'>, nativeWorkRows = true): void {
  validateKnowledgeSchemaV15(db, nativeWorkRows);
  validateHomeGraphNodeIdentityIndexes(db);
}

/** Current v17 adds native Home Graph source tuple selectors without rewriting rows. */
export function validateCurrentKnowledgeSchema(db: Pick<SqlDatabase, 'exec'>): void {
  validateKnowledgeSchemaV16(db, false);
  validateHomeGraphSourceIdentityIndexes(db);
}
