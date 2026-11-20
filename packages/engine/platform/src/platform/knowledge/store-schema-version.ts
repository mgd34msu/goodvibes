/** Schema marker shared by native pre-store reads and normal versioned opening. */
export const KNOWLEDGE_SCHEMA_VERSION = 18;
/**
 * The first release whose reader opens this schema. Raised in the same change
 * that raises the version: the data-compatibility preflight refuses an older
 * reader before the store is opened (runtime/native-reader-compatibility.ts).
 */
export const KNOWLEDGE_SCHEMA_READER_FLOOR = '3.3.0';
/** The durable format a knowledge store write declares: named from the version above, never beside it. */
export const KNOWLEDGE_SCHEMA_FORMAT = `knowledge-schema-v${KNOWLEDGE_SCHEMA_VERSION}` as const;
