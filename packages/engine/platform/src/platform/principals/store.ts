/**
 * principals/store.ts
 *
 * Durable persistence for the principal registry: one versioned JSON document,
 * opened once with `readDocument` (a missing file is an empty registry; an
 * unreadable one is moved aside with a receipt) and written whole with
 * `writeDocument` on each change.
 */
import { readDocument, writeDocument } from '../utils/atomic-json-store.js';
import type { PrincipalRecord } from './types.js';

interface PrincipalsSnapshot {
  version: 1;
  principals: PrincipalRecord[];
}

function validateSnapshot(parsed: unknown): PrincipalsSnapshot {
  const snapshot = parsed as Partial<PrincipalsSnapshot> | null;
  if (typeof snapshot !== 'object' || snapshot === null || snapshot.version !== 1 || !Array.isArray(snapshot.principals)) {
    throw new Error('Principal registry store snapshot is invalid.');
  }
  return { version: 1, principals: snapshot.principals };
}

export class PrincipalStore {
  constructor(private readonly path: string) {}

  load(): PrincipalRecord[] {
    return readDocument(this.path, {
      label: 'principals',
      validate: validateSnapshot,
      recovery: 'The list of people and devices starts empty: every channel sender is treated as someone unknown until they are added again.',
    })?.principals ?? [];
  }

  save(principals: readonly PrincipalRecord[]): void {
    writeDocument(this.path, { version: 1, principals: [...principals] }, { mode: 0o600 });
  }
}
