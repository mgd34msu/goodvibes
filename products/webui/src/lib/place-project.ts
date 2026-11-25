/**
 * place-project.ts, the project a place's reads and acts are for.
 *
 * A read or act bound to a project (a hooks file, an MCP config file, a
 * project's secrets, its worktrees) takes the project from its caller: a
 * terminal program sends its own folder, and the browser, which has none,
 * sends the one the person chose. The choice is from the projects the daemon
 * knows (`workspaces.projects.list`: its own working folder and every
 * registered one), opening on the one last chosen in this browser, else the
 * first the daemon names. It is sent as `workingDirectory` with every
 * `capabilities.run` and `places.counts` call, and as a project-bound list's
 * own input (`projectAs`), so nothing silently acts on a folder the person did
 * not choose. The last choice is kept in this browser
 * only (a convenience: a browser that keeps nothing opens on the first).
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useEventStreamState } from './event-stream';
import { invokeThroughMethod, setCallProject } from './goodvibes';

const STORAGE_KEY = 'goodvibes.places.project';
export const PLACE_PROJECTS_KEY = ['places', 'projects'] as const;

function stored(): string | undefined {
  try { return window.localStorage.getItem(STORAGE_KEY) ?? undefined; } catch { return undefined; }
}

let chosen: string | undefined = typeof window === 'undefined' ? undefined : stored();
// Every call names the project last chosen in this browser from the first one (goodvibes.ts `setCallProject`).
setCallProject(chosen);
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Choose the project (kept in this browser for the next visit). */
export function chooseProject(project: string): void {
  chosen = project;
  setCallProject(project);
  try { window.localStorage.setItem(STORAGE_KEY, project); } catch { /* this browser keeps nothing: the choice lasts this visit */ }
  for (const listener of [...listeners]) listener();
}

/** The projects the daemon knows (`workspaces.projects.list`), its own folder first. */
async function readProjects(): Promise<readonly string[]> {
  const answer = await invokeThroughMethod('workspaces.projects.list', {});
  const rows = answer && typeof answer === 'object' && Array.isArray((answer as { projects?: unknown }).projects) ? (answer as { projects: unknown[] }).projects : [];
  const roots = rows.map((row) => (row && typeof row === 'object' ? (row as { root?: unknown }).root : undefined));
  return [...new Set(roots.filter((root): root is string => typeof root === 'string' && root.trim() !== ''))];
}

export interface PlaceProjects {
  /** The folders to choose from (empty until read, or when the daemon names none). */
  readonly projects: readonly string[];
  /** The project in use: the chosen one when the daemon still knows it, else the first it names. */
  readonly project: string | undefined;
  readonly choose: (project: string) => void;
  readonly status: 'reading' | 'ready' | 'failed';
  readonly reason?: string | undefined;
}

export function usePlaceProjects(): PlaceProjects {
  const read = useQuery({ queryKey: PLACE_PROJECTS_KEY, queryFn: readProjects, staleTime: Infinity });
  // Projects that could not be read are read again when the daemon's event stream is live again (no timer).
  const stream = useEventStreamState('app');
  const { isError, refetch } = read;
  useEffect(() => { if (stream.status === 'live' && isError) void refetch(); }, [stream.status, isError, refetch]);
  const current = useSyncExternalStore(subscribe, () => chosen, () => chosen);
  const projects = read.data ?? [];
  const project = current && projects.includes(current) ? current : projects[0];
  // The project in use is the one every call names, also when it is the first the daemon offers (none chosen yet).
  useEffect(() => { setCallProject(project); }, [project]);
  const choose = useCallback((next: string) => chooseProject(next), []);
  return {
    projects, project, choose,
    status: read.isError ? 'failed' : read.data ? 'ready' : 'reading',
    ...(read.isError ? { reason: read.error instanceof Error ? read.error.message : String(read.error) } : {}),
  };
}

/** The project as last chosen in this browser (for a call made outside the places: the palette's runner). */
export function lastChosenProject(): string | undefined {
  return chosen;
}

/** A project's short name: its last folder. */
export function projectName(project: string): string {
  return project.split('/').filter(Boolean).at(-1) ?? project;
}
