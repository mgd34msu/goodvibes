import { toJSONSchema, ZodPipe, type z } from 'zod/v4';
import { legacyWorkLedgerManifestSchema } from '../workflow/work-ledger/types.js';

/** Only transport structure: the host still canonicalizes, detaches and
 * validates every complete legacy manifest with its original bounded parser. */
export const LEGACY_WORK_LEDGER_MANIFEST_JSON_SCHEMA = Object.freeze({ type: 'object' as const, additionalProperties: true });
export function workLedgerJsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'output'): Record<string, unknown> {
  return toJSONSchema(schema, {
    io,
    // Output conversion reaches the transform before its containing pipe's
    // override. Admit only this exact known transform, never an arbitrary one.
    unrepresentable({ zodSchema }) {
      return legacyWorkLedgerManifestSchema instanceof ZodPipe && zodSchema === legacyWorkLedgerManifestSchema.out
        ? LEGACY_WORK_LEDGER_MANIFEST_JSON_SCHEMA : 'throw';
    },
    override({ zodSchema, jsonSchema }) {
      if (zodSchema === legacyWorkLedgerManifestSchema) Object.assign(jsonSchema, LEGACY_WORK_LEDGER_MANIFEST_JSON_SCHEMA);
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    },
  });
}
