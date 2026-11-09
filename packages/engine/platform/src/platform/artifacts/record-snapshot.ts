/** Actual JSON metadata becomes one detached immutable stored record. This is
 * captured once at publication/load, never serialized again by live guards.
 */
import type { ArtifactRecord } from './types.js';
export function freezeArtifactRecord(record: ArtifactRecord): ArtifactRecord {
  if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) throw new Error('Artifact metadata must serialize to an object.');
  const pending: object[] = [record];
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index]!;
    for (const value of Object.values(item)) if (value !== null && typeof value === 'object') pending.push(value);
    Object.freeze(item);
  }
  return record;
}
export function parseArtifactRecord(serialized: string): ArtifactRecord {
  return freezeArtifactRecord(JSON.parse(serialized) as ArtifactRecord);
}
