/** Append-only exact project/root filename assignments. Readonly lookup creates
 * neither directories nor IDs; explicit activation uses populated exclusive
 * publication and retains actual parents, source files and temporary descriptor.
 */
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { captureExistingDirectory, confirmFileDurable } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
interface Project { readonly projectId: string; readonly projectRoot: string }
interface Assignment extends Project { readonly version: 1; readonly planId: string; readonly planFile: string; readonly unassignedFiles: readonly string[] }
export interface WorkPlanLocation {
  /** A readonly unregistered location is a candidate, not a claimed filename. */
  readonly path: string;
  readonly planId: string | null;
  readonly registered: boolean;
  readonly unassignedPaths: readonly string[];
  assertCurrent(): void;
  assertParentsCurrent(): void;
}
interface LocationOptions { readonly readOnly?: boolean; readonly assertCurrent?: (() => void) | undefined; readonly onEffect?: ((published?: boolean) => void) | undefined }
const MAX_PROJECTS = 4096;
const sameProject = (a: Project, b: Project) => a.projectId === b.projectId && a.projectRoot === b.projectRoot;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const planFilename = (value: unknown): value is string => typeof value === 'string' && value !== '.json' && value.endsWith('.json') && basename(value) === value && !value.includes('\\') && !value.includes('\0');
const nativePlanFilename = (value: unknown): value is string => typeof value === 'string' && /^\.native-plans\/(0|[1-9]\d*)\.json$/.test(value);
const stamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs].join(':');
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.birthtimeNs === b.birthtimeNs;
function unavailable(): never { throw new Error('Work plan ownership changed or is unreadable; existing plans and assignments were left untouched.'); }
function invoke(callback: (() => void) | undefined): void { const result: unknown = callback?.(); if (result !== undefined) { drainOwned(result); unavailable(); } }
/** Actual existing configured directory aliases are retained. Missing children
 * are created one level at a time below the already checked original parent.
 */
function directoryOwner(directory: string, create: boolean, options: LocationOptions, internal = false) {
  if (internal && lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) unavailable();
  const absent: string[] = []; let parent = resolve(directory);
  while (!lstatSync(parent, { throwIfNoEntry: false })) { absent.unshift(parent); const next = dirname(parent); if (next === parent) unavailable(); parent = next; }
  const held = [captureExistingDirectory(parent)];
  const physical = () => { for (const selected of held) selected.assertCurrent(); };
  const current = () => { invoke(options.assertCurrent); physical(); if (!create) for (const path of absent) if (lstatSync(path, { throwIfNoEntry: false })) unavailable(); };
  for (const path of absent) {
    current(); if (!create) return { exists: false, current, physical };
    let entry = lstatSync(path, { bigint: true, throwIfNoEntry: false }), created = false;
    if (!entry) { try { mkdirSync(path, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } entry = lstatSync(path, { bigint: true }); }
    if (!entry.isDirectory() || entry.isSymbolicLink() || (process.geteuid && entry.uid !== BigInt(process.geteuid()))) unavailable();
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const original = fstatSync(fd, { bigint: true }); if (!sameFile(entry, original)) unavailable();
      if (created) fchmodSync(fd, 0o700);
      if (!sameFile(original, lstatSync(path, { bigint: true }))) unavailable();
      const captured = captureExistingDirectory(path); held.push(captured); physical();
      if (created) invoke(() => options.onEffect?.(false)); current();
    } finally { closeSync(fd); }
  }
  current(); return { exists: true, current, physical };
}
function readDocument(path: string) {
  const source = readFileObservation(path);
  const current = () => { if (fileObservationIdentity(path) !== source.physical) unavailable(); };
  const value: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(source.bytes)); current();
  return { value, current };
}
function readAssignment(path: string, slot: number): { readonly value: Assignment; current(): void } | undefined {
  let observed: ReturnType<typeof readDocument>;
  try { observed = readDocument(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Work plan project assignment is unreadable; preserve it before repairing the store.'); }
  const value = observed.value;
  if (!object(value) || value.version !== 1 || typeof value.projectId !== 'string' || !value.projectId || typeof value.projectRoot !== 'string'
    || typeof value.planId !== 'string' || !value.planId || (!planFilename(value.planFile) && !nativePlanFilename(value.planFile))
    || (nativePlanFilename(value.planFile) && value.planFile !== `.native-plans/${slot}.json`)
    || !Array.isArray(value.unassignedFiles) || !value.unassignedFiles.every(planFilename)) unavailable();
  return { value: value as unknown as Assignment, current: observed.current };
}
function names(directory: string): string[] { try { return readdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
/** Old unattributed/unreadable plans remain visible and untouched. Only exact
 * actual saved project metadata selects an old filename, without recomputing it.
 */
function findExisting(directory: string, project: Project) {
  let match: { planFile: string; planId: string } | undefined; const unassignedFiles: string[] = [], retained: Array<() => void> = [];
  const members = names(directory).filter(planFilename).sort(); if (members.length > MAX_PROJECTS) unavailable();
  for (const file of members) {
    const path = join(directory, file), original = lstatSync(path, { bigint: true });
    retained.push(() => { if (stamp(lstatSync(path, { bigint: true })) !== stamp(original)) unavailable(); });
    let value: unknown; try { value = readDocument(path).value; } catch { unassignedFiles.push(file); continue; }
    if (!object(value) || typeof value.projectId !== 'string' || typeof value.projectRoot !== 'string') { unassignedFiles.push(file); continue; }
    if (!sameProject({ projectId: value.projectId, projectRoot: value.projectRoot }, project)) continue;
    if (match) throw new Error('More than one saved work plan names this project; preserve both files before combining them.');
    if (typeof value.id !== 'string' || !value.id) { unassignedFiles.push(file); continue; }
    match = { planFile: file, planId: value.id };
  }
  const current = () => { const actual = names(directory).filter(planFilename).sort(); if (actual.length !== members.length || actual.some((name, index) => name !== members[index])) unavailable(); for (const check of retained) check(); };
  current(); return { ...match, unassignedFiles, current };
}
function location(directory: string, assignment: Assignment, assertCurrent: () => void, assertParentsCurrent: () => void): WorkPlanLocation {
  return Object.freeze({ path: join(directory, assignment.planFile), planId: assignment.planId, registered: true,
    unassignedPaths: Object.freeze(assignment.unassignedFiles.map(file => join(directory, file))), assertCurrent, assertParentsCurrent });
}
export function resolveWorkPlanLocation(directory: string, project: Project, options: LocationOptions = {}): WorkPlanLocation {
  const readOnly = options.readOnly === true, restriction = options.assertCurrent?.bind(options), notification = options.onEffect?.bind(options);
  options = Object.freeze({ readOnly, assertCurrent: restriction, onEffect: notification });
  const directoryGuard = directoryOwner(directory, !readOnly, options), owners = join(directory, '.project-owners'), nativeDirectory = join(directory, '.native-plans');
  const ownerGuard = directoryOwner(owners, !readOnly, options, true), selectedRows: Array<() => void> = [];
  let nativeGuard = directoryOwner(nativeDirectory, false, options, true);
  const parentsCurrent = () => { directoryGuard.physical(); ownerGuard.physical(); nativeGuard.physical(); };
  const current = () => { directoryGuard.current(); ownerGuard.current(); nativeGuard.current(); for (const check of selectedRows) check(); };
  const selectedLocation = (assignment: Assignment) => {
    if (!readOnly && nativePlanFilename(assignment.planFile) && !nativeGuard.exists) nativeGuard = directoryOwner(nativeDirectory, true, options, true);
    current(); return location(directory, assignment, current, parentsCurrent);
  };
  current(); const nativeFiles = names(nativeDirectory), ownerFiles = names(owners); current(); let highest = -1;
  if (nativeFiles.length > MAX_PROJECTS || ownerFiles.length > MAX_PROJECTS) unavailable();
  for (const name of [...ownerFiles, ...nativeFiles]) { const numbered = /^(0|[1-9]\d*)\.json$/.exec(name); if (!numbered) continue; const slot = Number(numbered[1]); if (!Number.isSafeInteger(slot) || slot >= MAX_PROJECTS) unavailable(); highest = Math.max(highest, slot); }
  let existing: ReturnType<typeof findExisting> | undefined;
  for (let slot = 0; slot < MAX_PROJECTS; slot++) {
    current(); const path = join(owners, `${slot}.json`), assigned = readAssignment(path, slot);
    if (assigned) { selectedRows.push(assigned.current); if (sameProject(assigned.value, project)) { if (!options.readOnly) { confirmFileDurable(path); current(); } return selectedLocation(assigned.value); } continue; }
    if (slot <= highest) throw new Error('Work plan project assignment is missing; saved plan files were left untouched.');
    existing ??= findExisting(directory, project); existing.current();
    if (options.readOnly) return Object.freeze({ path: join(directory, existing.planFile ?? `.native-plans/${slot}.json`), planId: existing.planId ?? null, registered: false,
      unassignedPaths: Object.freeze(existing.unassignedFiles.map(file => join(directory, file))), assertCurrent: () => { current(); existing!.current(); }, assertParentsCurrent: parentsCurrent });
    const proposed: Assignment = { version: 1, ...project, planId: existing.planId ?? `wp-${randomUUID()}`, planFile: existing.planFile ?? `.native-plans/${slot}.json`, unassignedFiles: existing.unassignedFiles };
    current(); existing.current();
    const temporary = join(owners, `.assign-${process.pid}-${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), original = fstatSync(fd, { bigint: true });
    try {
      fchmodSync(fd, 0o600); writeFileSync(fd, `${JSON.stringify(proposed)}\n`); fsyncSync(fd);
      const prepared = stamp(fstatSync(fd, { bigint: true }));
      invoke(() => options.onEffect?.(false)); current(); existing.current();
      if (stamp(fstatSync(fd, { bigint: true })) !== prepared || stamp(lstatSync(temporary, { bigint: true })) !== prepared) unavailable();
      try { linkSync(temporary, path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        current(); const winner = readAssignment(path, slot); if (!winner) unavailable(); selectedRows.push(winner.current);
        if (sameProject(winner.value, project)) { confirmFileDurable(path); current(); return selectedLocation(winner.value); }
        continue;
      }
      if (!sameFile(lstatSync(path, { bigint: true }), original) || !sameFile(lstatSync(temporary, { bigint: true }), original)) unavailable();
      unlinkSync(temporary); const published = stamp(fstatSync(fd, { bigint: true }));
      const publicationCurrent = () => { current(); if (stamp(fstatSync(fd, { bigint: true })) !== published || stamp(lstatSync(path, { bigint: true })) !== published) unavailable(); };
      publicationCurrent(); invoke(() => options.onEffect?.(false)); publicationCurrent(); confirmFileDurable(path); publicationCurrent();
      const actual = readAssignment(path, slot); if (!actual || !sameProject(actual.value, project) || actual.value.planId !== proposed.planId) unavailable(); selectedRows.push(actual.current);
      return selectedLocation(actual.value);
    } finally {
      try { directoryGuard.physical(); ownerGuard.physical(); const actual = lstatSync(temporary, { bigint: true, throwIfNoEntry: false }); if (actual && sameFile(actual, original)) { unlinkSync(temporary); invoke(() => options.onEffect?.(false)); } }
      finally { closeSync(fd); }
    }
  }
  throw new Error('Work plan project assignment space is exhausted.');
}
