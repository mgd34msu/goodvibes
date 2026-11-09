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

/** Original v13 accepts the native activation dependency tables. */
export function validateKnowledgeSchemaV13(db: Pick<SqlDatabase, 'exec'>): void {
  validateKnowledgeSchemaV12(db);
  validateKnowledgeNodeContentRevisions(db);
  validateKnowledgeNodeActivationCache(db);
}

/** Original v14 projection, artifact and exact fact lookup invariants. */
export function validateKnowledgeSchemaV14(db: Pick<SqlDatabase, 'exec'>): void {
  validateKnowledgeSchemaV13(db);
  validateGeneratedProjectionIdentityIndex(db);
  validateArtifactReferenceIndexes(db);
  validateSemanticFactIdentityIndex(db);
}


/** Original v15 includes actual semantic-role selectors. */
export function validateKnowledgeSchemaV15(db: Pick<SqlDatabase, 'exec'>): void {
  validateKnowledgeSchemaV14(db);
  validateSemanticNodeIdentityIndex(db);
}

/** Original v16 includes exact Home Graph object tuple selectors. */
export function validateKnowledgeSchemaV16(db: Pick<SqlDatabase, 'exec'>): void {
  validateKnowledgeSchemaV15(db);
  validateHomeGraphNodeIdentityIndexes(db);
}

/** Current v17 adds native Home Graph source tuple selectors without rewriting rows. */
export function validateCurrentKnowledgeSchema(db: Pick<SqlDatabase, 'exec'>): void {
  validateKnowledgeSchemaV16(db);
  validateHomeGraphSourceIdentityIndexes(db);
}
