/** Persist one filename assignment per exact project ID/root pair. Slot records
 * are append-only and published fully populated with link(2), so simultaneous
 * first opens agree without a process-local cache or a filename digest.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

interface Project { readonly projectId: string; readonly projectRoot: string }
interface Assignment extends Project {
  readonly version: 1;
  readonly planId: string;
  readonly planFile: string;
  readonly unassignedFiles: readonly string[];
}
export interface WorkPlanLocation {
  readonly path: string;
  readonly planId: string;
  readonly unassignedPaths: readonly string[];
}
const sameProject = (a: Project, b: Project) => a.projectId === b.projectId && a.projectRoot === b.projectRoot;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const planFilename = (value: unknown): value is string => typeof value === 'string'
  && value !== '.json' && value.endsWith('.json') && basename(value) === value && !value.includes('\\') && !value.includes('\0');
const nativePlanFilename = (value: unknown): value is string => typeof value === 'string' && /^\.native-plans\/(0|[1-9]\d*)\.json$/.test(value);

function readDocument(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error('Work plan metadata is not a regular file.'), { code: 'WORK_PLAN_METADATA_KIND' });
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
}

function readAssignment(path: string, slot: number): Assignment | undefined {
  let value: unknown;
  try { value = readDocument(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error('Work plan project assignment is unreadable; preserve it before repairing the store.');
    throw error;
  }
  if (!object(value) || value.version !== 1 || typeof value.projectId !== 'string' || typeof value.projectRoot !== 'string'
    || typeof value.planId !== 'string' || !value.planId || (!planFilename(value.planFile) && !nativePlanFilename(value.planFile))
    || (nativePlanFilename(value.planFile) && value.planFile !== `.native-plans/${slot}.json`)
    || !Array.isArray(value.unassignedFiles) || !value.unassignedFiles.every(planFilename)) {
    throw new Error('Work plan project assignment is unreadable; preserve it before repairing the store.');
  }
  return value as unknown as Assignment;
}

/** Adopt only a plan whose own metadata names this exact project. Old short
 * and hashed filenames are both discoverable without recreating their hash.
 * Unreadable/unattributed files remain untouched and are disclosed to the user.
 */
function findExisting(directory: string, project: Project): { planFile?: string; planId?: string; unassignedFiles: string[] } {
  let match: { planFile: string; planId: string } | undefined;
  const unassignedFiles: string[] = [];
  for (const file of readdirSync(directory).filter(planFilename).sort()) {
    let value: unknown;
    try { value = readDocument(join(directory, file)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (!(error instanceof SyntaxError) && !['EACCES', 'EPERM', 'ELOOP', 'EISDIR', 'WORK_PLAN_METADATA_KIND']
        .includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      unassignedFiles.push(file); continue;
    }
    if (!object(value) || typeof value.projectId !== 'string' || typeof value.projectRoot !== 'string') {
      unassignedFiles.push(file); continue;
    }
    if (!sameProject({ projectId: value.projectId, projectRoot: value.projectRoot }, project)) continue;
    if (match) throw new Error('More than one saved work plan names this project; preserve both files before combining them.');
    match = { planFile: file, planId: typeof value.id === 'string' && value.id ? value.id : `wp-${randomUUID()}` };
  }
  return { ...match, unassignedFiles };
}

function location(directory: string, assignment: Assignment): WorkPlanLocation {
  return {
    path: join(directory, assignment.planFile), planId: assignment.planId,
    unassignedPaths: assignment.unassignedFiles.map(file => join(directory, file)),
  };
}

export function resolveWorkPlanLocation(directory: string, project: Project): WorkPlanLocation {
  const owners = join(directory, '.project-owners');
  mkdirSync(owners, { recursive: true, mode: 0o700 });
  // A missing assignment amid existing slots (or underneath an existing native
  // plan) is damage, not a vacant new-project slot. Never silently replace it.
  let nativeFiles: string[];
  try { nativeFiles = readdirSync(join(directory, '.native-plans')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; nativeFiles = []; }
  let highest = -1;
  for (const name of [...readdirSync(owners), ...nativeFiles]) {
    const numbered = /^(0|[1-9]\d*)\.json$/.exec(name);
    if (!numbered) continue;
    const slot = Number(numbered[1]);
    if (!Number.isSafeInteger(slot)) throw new Error('Work plan project assignment number is invalid.');
    highest = Math.max(highest, slot);
  }
  let existing: ReturnType<typeof findExisting> | undefined;
  for (let slot = 0; Number.isSafeInteger(slot); slot++) {
    const path = join(owners, `${slot}.json`);
    const assigned = readAssignment(path, slot);
    if (assigned) {
      if (sameProject(assigned, project)) return location(directory, assigned);
      continue;
    }
    if (slot <= highest) throw new Error('Work plan project assignment is missing; saved plan files were left untouched.');
    existing ??= findExisting(directory, project);
    const proposed: Assignment = {
      version: 1, ...project, planId: existing.planId ?? `wp-${randomUUID()}`,
      planFile: existing.planFile ?? `.native-plans/${slot}.json`,
      unassignedFiles: existing.unassignedFiles,
    };
    const temporary = join(owners, `.assign-${process.pid}-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(proposed)}\n`); fsyncSync(fd);
      try { linkSync(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A populated winner owns this slot. Read it before considering the
        // next one; equal first callers must never allocate separate plans.
        const winner = readAssignment(path, slot);
        if (!winner) throw new Error('Work plan project assignment disappeared.');
        if (sameProject(winner, project)) return location(directory, winner);
        continue;
      }
      const directoryFd = openSync(owners, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      return location(directory, proposed);
    } finally { try { closeSync(fd); } finally { unlinkSync(temporary); } }
  }
  throw new Error('Work plan project assignment space is exhausted.');
}
