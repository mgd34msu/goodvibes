/** Metadata-only inspection of actual saved work-plan ownership. Unknown root
 * plans remain untouched and unattributed, matching the WorkPlan store's recovery
 * policy. Corrupt owned assignment records cannot choose a default project.
 */
import { lstatSync, readdirSync, type BigIntStats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { captureExistingDirectory } from '../../utils/atomic-json-store.js';
import { readFileObservation } from '../../utils/file-observation.js';
import { ProjectIdentityUnavailableError } from './project-registry.js';
const physical = (entry: BigIntStats) => [entry.dev, entry.ino, entry.mode, entry.uid, entry.gid, entry.nlink, entry.size, entry.birthtimeNs, entry.mtimeNs, entry.ctimeNs].join(':');
export function inspectWorkPlanProjects(directory: string, workspace: string): { readonly projectIds: readonly string[]; assertCurrent(): void } {
  const absent: string[] = []; let parent = resolve(directory);
  while (!lstatSync(parent, { throwIfNoEntry: false })) { absent.unshift(parent); const next = dirname(parent); if (next === parent) throw new ProjectIdentityUnavailableError(); parent = next; }
  const owner = captureExistingDirectory(parent), files: Array<{ path: string; physical: string }> = [];
  const directories: Array<{ owner: ReturnType<typeof captureExistingDirectory>; path: string; names: readonly string[] }> = [], missingChildren: string[] = [];
  const ids = new Set<string>(); let count = 0;
  const names = (path: string) => readdirSync(path).filter(name => name.endsWith('.json')).sort();
  const physicalCurrent = () => { owner.assertCurrent(); for (const selected of directories) selected.owner.assertCurrent(); };
  const current = () => {
    physicalCurrent();
    for (const missing of absent) { const actual = lstatSync(missing, { throwIfNoEntry: false }); if (actual && (missing === resolve(directory) || !actual.isDirectory() || actual.isSymbolicLink() || (process.geteuid && actual.uid !== process.geteuid()))) throw new ProjectIdentityUnavailableError(); }
    for (const missing of missingChildren) if (lstatSync(missing, { throwIfNoEntry: false })) throw new ProjectIdentityUnavailableError();
    for (const selected of directories) { const actual = names(selected.path); if (actual.length !== selected.names.length || actual.some((name, index) => name !== selected.names[index])) throw new ProjectIdentityUnavailableError(); }
    for (const file of files) if (physical(lstatSync(file.path, { bigint: true })) !== file.physical) throw new ProjectIdentityUnavailableError();
  };
  if (absent.length > 0) return Object.freeze({ projectIds: Object.freeze([]), assertCurrent: current });
  for (const path of [resolve(directory), join(directory, '.project-owners'), join(directory, '.native-plans')]) {
    physicalCurrent(); const entry = lstatSync(path, { throwIfNoEntry: false }); if (!entry) { missingChildren.push(path); continue; }
    if (!entry.isDirectory() || entry.isSymbolicLink() || (process.geteuid && entry.uid !== process.geteuid())) throw new ProjectIdentityUnavailableError();
    const selected = captureExistingDirectory(path), members = names(path); directories.push({ owner: selected, path, names: members });
    const strict = path === join(directory, '.project-owners');
    for (const name of members) {
      if (++count > 4096) throw new ProjectIdentityUnavailableError();
      physicalCurrent(); const leaf = join(path, name), entry = lstatSync(leaf, { bigint: true }); files.push({ path: leaf, physical: physical(entry) });
      let parsed: unknown;
      try { const source = readFileObservation(leaf); parsed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(source.bytes)); }
      catch { if (strict) throw new ProjectIdentityUnavailableError(); continue; }
      const row = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      if (!row || typeof row['projectRoot'] !== 'string' || typeof row['projectId'] !== 'string' || !row['projectId']) { if (strict) throw new ProjectIdentityUnavailableError(); continue; }
      if (strict && (row['version'] !== 1 || typeof row['planId'] !== 'string' || !row['planId'] || typeof row['planFile'] !== 'string' || !Array.isArray(row['unassignedFiles']))) throw new ProjectIdentityUnavailableError();
      if (row['projectRoot'] === workspace) ids.add(row['projectId']); physicalCurrent();
    }
  }
  current(); return Object.freeze({ projectIds: Object.freeze([...ids].sort()), assertCurrent: current });
}
