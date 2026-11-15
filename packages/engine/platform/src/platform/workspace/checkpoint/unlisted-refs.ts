/**
 * unlisted-refs.ts
 *
 * Reconciles checkpoint refs in the side repo with the manifest. A ref with no
 * manifest record is unrestorable and, because it keeps its objects reachable,
 * never reclaimed: it is left by a quarantined index or by a create that died
 * between moving the ref and saving the manifest. Callers hold the
 * cross-process lock, so no concurrent create can be mid-way between the two.
 */

import { CHECKPOINT_REF_PREFIX, type SideGitRunner } from './side-git.js';
import type { CheckpointKind, WorkspaceCheckpoint } from './types.js';

const KINDS: readonly CheckpointKind[] = ['turn', 'agent-run', 'manual'];

/** Rebuild manifest records for refs the manifest does not list; metadata comes from the commit (`wcp: <kind> <label>`). */
export async function recordsForUnlistedRefs(sideGit: SideGitRunner, listed: ReadonlySet<string>, now: () => number): Promise<WorkspaceCheckpoint[]> {
  const records: WorkspaceCheckpoint[] = [];
  for (const ref of await sideGit.listCheckpointRefs()) {
    if (listed.has(ref.id) || !/^[A-Za-z0-9_-]{1,256}$/.test(ref.id)) continue;
    const info = await sideGit.commitInfo(ref.commit);
    const match = /^wcp: (\S+) ?(.*)$/.exec(info?.subject ?? '');
    const kind = KINDS.find((k) => k === match?.[1]) ?? 'manual';
    records.push({
      id: ref.id,
      kind,
      label: match?.[2] || ref.id,
      createdAt: info?.createdAt ?? now(),
      parentId: null,
      retentionClass: kind === 'manual' ? 'forensic' : 'standard',
      commit: ref.commit,
      sizeBytes: 0,
    });
  }
  return records;
}

/** Delete refs the manifest does not list; returns how many were removed. */
export async function deleteUnlistedRefs(sideGit: SideGitRunner, listed: ReadonlySet<string>): Promise<number> {
  let deleted = 0;
  for (const ref of await sideGit.listCheckpointRefs()) {
    if (listed.has(ref.id)) continue;
    try {
      await sideGit.deleteRef(`${CHECKPOINT_REF_PREFIX}${ref.id}`);
      deleted += 1;
    } catch {
      // best effort: the next sweep retries
    }
  }
  return deleted;
}
