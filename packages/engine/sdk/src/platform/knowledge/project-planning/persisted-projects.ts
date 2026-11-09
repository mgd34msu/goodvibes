/** Read project selectors before constructing an auto-initializing store.
 * No schema callback, migration, directory creation, chmod or persistence runs.
 * Returned IDs are ordinary data; this module cannot authorize a project.
 */
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { lstatSync, readlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { inspectNativePlanningProjectImage } from '../../state/sqlite-store.js';
import { captureExistingDirectory } from '../../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../../utils/file-observation.js';
export interface PersistedPlanningProjects {
  readonly exists: boolean;
  readonly projectIds: readonly string[];
  /** Original physical source, not a digest or permission token. */
  assertCurrent(): void;
  /** Initial-image restriction only. Actual SQLite initialization owns any new
   * intermediate directories; this never attests them or supplies authority. */
  assertInitialImage(): void;
}
export { PlanningProjectInspectionError } from './persisted-project-query.js';
import { PlanningProjectInspectionError } from './persisted-project-query.js';
function selectedPath(path: string, visited = new Set<string>()): { readonly path: string; assertCurrent(): void; assertInitialImage(): void } {
  const absolute = resolve(path); if (visited.has(absolute) || visited.size >= 40) throw new PlanningProjectInspectionError(); visited.add(absolute);
  const absent: string[] = []; let parent = dirname(absolute);
  while (!lstatSync(parent, { throwIfNoEntry: false })) { absent.unshift(parent); const next = dirname(parent); if (next === parent) throw new PlanningProjectInspectionError(); parent = next; }
  const directory = captureExistingDirectory(parent), leaf = lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
  const assertParents = (allowCreated = false) => { directory.assertCurrent(); for (const missing of absent) {
    const actual = lstatSync(missing, { throwIfNoEntry: false });
    if (actual && (!allowCreated || !actual.isDirectory() || actual.isSymbolicLink() || (process.geteuid && actual.uid !== process.geteuid()))) throw new PlanningProjectInspectionError();
  } };
  if (leaf?.isSymbolicLink()) {
    const target = readlinkSync(absolute), stamp = [leaf.dev, leaf.ino, leaf.mode, leaf.uid, leaf.gid, leaf.size, leaf.mtimeNs, leaf.ctimeNs, leaf.birthtimeNs].join(':');
    const linked = selectedPath(isAbsolute(target) ? target : join(dirname(absolute), target), visited);
    const current = (initial = false) => { assertParents(initial); const actual = lstatSync(absolute, { bigint: true });
      if (!actual.isSymbolicLink() || readlinkSync(absolute) !== target
        || [actual.dev, actual.ino, actual.mode, actual.uid, actual.gid, actual.size, actual.mtimeNs, actual.ctimeNs, actual.birthtimeNs].join(':') !== stamp) throw new PlanningProjectInspectionError(); if (initial) linked.assertInitialImage(); else linked.assertCurrent(); };
    current(); return Object.freeze({ path: linked.path, assertCurrent: () => current(), assertInitialImage: () => current(true) });
  }
  const physical = leaf ? fileObservationIdentity(absolute) : null;
  if (leaf && process.geteuid && leaf.uid !== BigInt(process.geteuid())) throw new PlanningProjectInspectionError();
  const current = (initial = false) => { assertParents(initial); const actual = lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
    if (physical === null ? actual !== undefined : actual === undefined || fileObservationIdentity(absolute) !== physical) throw new PlanningProjectInspectionError(); };
  current(); return Object.freeze({ path: absent.length === 0 ? join(directory.canonical, basename(absolute)) : absolute, assertCurrent: () => current(), assertInitialImage: () => current(true) });
}
/** This leaf accepts an exact native-selected path and only fixed SQL. Its
 * caller must retain the actual configured workspace/store family separately.
 */
export async function inspectPersistedPlanningProjects(path: string, assertOwnerCurrent: () => void): Promise<PersistedPlanningProjects> {
  const owner = () => { const result: unknown = assertOwnerCurrent(); if (result !== undefined) { drainOwned(result); throw new PlanningProjectInspectionError(); } };
  owner(); const selected = selectedPath(path); const current = () => { owner(); selected.assertCurrent(); };
  const initial = () => { owner(); selected.assertInitialImage(); };
  current(); const leaf = lstatSync(selected.path, { throwIfNoEntry: false });
  if (!leaf) return Object.freeze({ exists: false, projectIds: Object.freeze([]), assertCurrent: current, assertInitialImage: initial });
  const source = readFileObservation(selected.path); current();
  if (source.bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new PlanningProjectInspectionError();
  const projectIds = await inspectNativePlanningProjectImage(source.bytes, current); current();
  return Object.freeze({ exists: true, projectIds, assertCurrent: current, assertInitialImage: initial });
}
