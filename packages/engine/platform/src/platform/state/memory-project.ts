/**
 * Which project a "this project" memory record is for.
 *
 * Memory is one store for every program and project (`~/.goodvibes/shared/memory.sqlite`). A record saved for a
 * project ("This project") carries that project's identity, the resolved path of its folder, and is given only to
 * work in that project. A record with no project is the person's own (team records, and records whose project could
 * not be told) and is given everywhere.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { MemoryRecord } from './memory-store.js';
import { projectIdentityOf } from '../workspace/project-identity.js';

/** The identity a record's project is compared by: the resolved folder of the project. */
export function memoryProjectIdentity(folder: string): string {
  // The product's one project identity (workspace/project-identity.ts): a subfolder is in its project.
  return projectIdentityOf(folder);
}

/** The asking folder's project identity, or undefined when the caller named no folder. */
export function memoryProjectOf(folder: string | undefined | null): string | undefined {
  return typeof folder === 'string' && folder.trim() ? memoryProjectIdentity(folder.trim()) : undefined;
}

/**
 * Whether a record may be given to work in `project`: the person's own records always; a project's records only in
 * that project. Work whose project is not known (`undefined`) is given only the person's own.
 */
export function isMemoryForProject(record: Pick<MemoryRecord, 'project'>, project: string | undefined): boolean {
  return record.project === undefined || record.project === project;
}

function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The project a 3.5.0 "this project" record (saved with no project) was really saved in, where that can be told:
 *  1. a `file` provenance link whose absolute path is inside exactly one known project folder;
 *  2. else a `session` provenance link whose session a terminal program saved in exactly one known project folder
 *     (`<project>/.goodvibes/{tui,agent}/sessions/<id>.json` or a folder of that name);
 *  3. else a `session` link whose shared session record (the daemon's sessions list) names a known project folder.
 * When none of these tells exactly one project, undefined: the record stays the person's own, given everywhere.
 */
export function attributeOldProjectRecord(
  record: Pick<MemoryRecord, 'provenance'>,
  knownProjects: readonly string[],
  sessionProjects: ReadonlyMap<string, string>,
): string | undefined {
  const projects = [...new Set(knownProjects.map((folder) => memoryProjectIdentity(folder)))];
  const only = (matches: readonly string[]): string | undefined => {
    const distinct = [...new Set(matches)];
    return distinct.length === 1 ? distinct[0] : undefined;
  };
  const byFile = only(record.provenance
    .filter((link) => link.kind === 'file' && isAbsolute(link.ref))
    .flatMap((link) => projects.filter((project) => inside(project, link.ref))));
  if (byFile) return byFile;
  const sessions = record.provenance.filter((link) => link.kind === 'session').map((link) => link.ref);
  if (sessions.length === 0) return undefined;
  const bySavedSession = only(sessions.flatMap((id) => projects.filter((project) => ['tui', 'agent'].some((surface) => {
    const dir = join(project, '.goodvibes', surface, 'sessions');
    return existsSync(join(dir, `${id}.json`)) || existsSync(join(dir, id));
  }))));
  if (bySavedSession) return bySavedSession;
  return only(sessions.flatMap((id) => {
    const folder = sessionProjects.get(id);
    return folder && projects.includes(memoryProjectIdentity(folder)) ? [memoryProjectIdentity(folder)] : [];
  }));
}

/**
 * Once per store, at the daemon's start: every 3.5.0 "this project" record is given the project it was saved in
 * where attributeOldProjectRecord can tell, the rest stay the person's own. Returns the owner's one line, or
 * undefined when it ran before or there was nothing to attribute.
 */
export function attributeOldProjectMemory(
  registry: { attributeOldProjectRecords(attribute: (record: MemoryRecord) => string | undefined): { readonly attributed: ReadonlyMap<string, number>; readonly keptOwn: number } | null },
  homeDirectory: string,
  sessions: readonly { readonly id: string; readonly project?: string | undefined }[],
): string | undefined {
  const knownProjects = knownProjectFolders(homeDirectory);
  const sessionProjects = new Map(sessions.filter((session) => typeof session.project === 'string' && isAbsolute(session.project))
    .map((session) => [session.id, session.project as string]));
  const done = registry.attributeOldProjectRecords((record) => attributeOldProjectRecord(record, knownProjects, sessionProjects));
  if (!done || (done.attributed.size === 0 && done.keptOwn === 0)) return undefined;
  const per = [...done.attributed].map(([project, count]) => `${count} to ${project}`).join(', ');
  return [
    'Memory saved for "This project" now carries its project and is given only to work in that project.',
    done.attributed.size > 0 ? `Records saved before this version were given the project they were saved in (told by the file or the session they came from): ${per}.` : '',
    done.keptOwn > 0 ? `${done.keptOwn} record${done.keptOwn === 1 ? '' : 's'} could not be told apart by project and stay${done.keptOwn === 1 ? 's' : ''} yours, given to every project; the Memory place lists ${done.keptOwn === 1 ? 'it' : 'them'} as "every project", and "Change where a record applies" from a project makes one that project's.` : '',
  ].filter(Boolean).join(' ');
}

/**
 * The project folders this home knows: every folder bound to a project identity (`<home>/.goodvibes/project-identities`)
 * and every registered workspace (`<home>/.goodvibes/shared/workspace-registrations.json`, any shape that lists roots).
 */
export function knownProjectFolders(homeDirectory: string): string[] {
  const folders = new Set<string>();
  const identities = join(homeDirectory, '.goodvibes', 'project-identities');
  let names: string[] = [];
  try { names = readdirSync(identities); } catch { /* none */ }
  for (const name of names) {
    if (!name.startsWith('binding-') || !name.endsWith('.json')) continue;
    try {
      const binding = JSON.parse(readFileSync(join(identities, name), 'utf-8')) as { workspace?: unknown };
      if (typeof binding.workspace === 'string' && binding.workspace) folders.add(binding.workspace);
    } catch { /* a damaged binding names no folder */ }
  }
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && isAbsolute(value)) folders.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      for (const key of ['root', 'path', 'workspace', 'workspaces']) if (key in row) collect(row[key]);
    }
  };
  try { collect(JSON.parse(readFileSync(join(homeDirectory, '.goodvibes', 'shared', 'workspace-registrations.json'), 'utf-8'))); } catch { /* none */ }
  return [...folders];
}
