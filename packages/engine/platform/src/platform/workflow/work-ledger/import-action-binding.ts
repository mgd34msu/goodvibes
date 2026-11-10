import { workLedgerCommandSchema } from './types.js';

let importActionSequence = 0;

/** Identity capture only; host construction supplies these facts, not payload authority. */
export function captureLegacyImportAction(input: {
  readonly storeId: string; readonly projectId: string; readonly principalKind: string;
  readonly principalId: string; readonly command: unknown;
}) {
  const identity = [input.storeId, input.projectId, input.principalKind, input.principalId];
  if (identity.some(value => typeof value !== 'string' || !value.trim() || value.length > 4096)) throw new Error('Complete authenticated import identity required');
  const command = workLedgerCommandSchema.parse(input.command);
  if (command.type !== 'import_legacy' || command.manifest.projectId !== input.projectId) throw new Error('Import action project mismatch');
  const commandJson = JSON.stringify(command);
  importActionSequence++;
  if (!Number.isSafeInteger(importActionSequence)) throw new Error('Import action identity exhausted');
  // Only ordinary owner/request identifiers enter this private pending-map key.
  // Complete command bytes remain separate for exact conflict detection.
  return Object.freeze({ requestKey: JSON.stringify([...identity, command.requestId]), actionId: `import-action-${importActionSequence}`, commandJson,
    storeId: input.storeId, projectId: input.projectId, principalKind: input.principalKind, principalId: input.principalId,
    requestId: command.requestId, expectedRevision: command.expectedRevision });
}
