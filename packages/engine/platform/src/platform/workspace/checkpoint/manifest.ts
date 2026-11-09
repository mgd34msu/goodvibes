/** Validate actual stored checkpoint metadata before indexing/retention uses it.
 * Extra fields remain readable; this is shape validation, not Git authority.
 */
import type { WorkspaceCheckpoint } from './types.js';
export class CheckpointManifestShapeError extends Error { override readonly name = 'CheckpointManifestShapeError'; constructor() { super('Checkpoint manifest shape is invalid.'); } }
export interface Manifest { readonly checkpoints: readonly WorkspaceCheckpoint[] }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function validateCheckpointManifest(value: unknown): Manifest {
  const invalid = (): never => { throw new CheckpointManifestShapeError(); };
  if (!record(value) || !Array.isArray(value['checkpoints'])) return invalid();
  const ids = new Set<string>();
  for (const checkpoint of value['checkpoints']) {
    if (!record(checkpoint) || !identifier(checkpoint['id']) || ids.has(checkpoint['id'])
      || (typeof checkpoint['kind'] !== 'string' || !['turn', 'agent-run', 'manual'].includes(checkpoint['kind'])) || typeof checkpoint['label'] !== 'string'
      || !finite(checkpoint['createdAt']) || !finite(checkpoint['sizeBytes'])
      || (checkpoint['parentId'] !== null && !identifier(checkpoint['parentId']))
      || (typeof checkpoint['retentionClass'] !== 'string' || !['short', 'standard', 'forensic'].includes(checkpoint['retentionClass']))
      || typeof checkpoint['commit'] !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(checkpoint['commit'])) return invalid();
    for (const key of ['turnId', 'agentId', 'sessionId']) if (checkpoint[key] !== undefined && typeof checkpoint[key] !== 'string') return invalid();
    ids.add(checkpoint['id']);
  }
  return value as unknown as Manifest;
}
