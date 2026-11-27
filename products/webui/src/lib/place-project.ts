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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { subscribeEvents, useEventStreamState } from './event-stream';
import { chatCallProject, invokeThroughMethod, setCallProject } from './goodvibes';
import { accountKey } from './account-storage';
import { subscribeClientLifetime } from './client-lifetime';

const STORAGE_KEY = 'goodvibes.places.project' as const;

/**
 * The chooser's "Every project": the owner's own choice to read every project's per-project things (memory) at once.
 * No project is named then; the call says `everyProject`, which the daemon takes only from the owner in person (from
 * anyone else it reads only what belongs to no project). A list bound to one project asks for a project instead.
 */
export const EVERY_PROJECT = '*every-project*';
export const PLACE_PROJECTS_KEY = ['places', 'projects'] as const;

/**
 * The new chat's "No project (one is made for this chat)": a chat started naming no project. It reads and answers only
 * until the owner's own message there first needs somewhere to work; the daemon then makes the chat its own project
 * (an automatic project, under "Folder for automatic projects") and its first answer says where its files are. It is a
 * choice for a new chat only, kept for this visit, and leaves the places' project as it is.
 */
export const NO_PROJECT = '*no-project*';
let newChatWithoutProject = false;
const newChatListeners = new Set<() => void>();

/** Whether the next new chat is started with no project (the chat line's "No project" choice). */
export function newChatHasNoProject(): boolean {
  return newChatWithoutProject;
}

/** Choose whether the next new chat is started with no project; choosing a project for it clears this. */
export function chooseNoProjectForNewChat(none: boolean): void {
  if (newChatWithoutProject === none) return;
  newChatWithoutProject = none;
  for (const listener of [...newChatListeners]) listener();
}

export function useNewChatHasNoProject(): boolean {
  return useSyncExternalStore((listener) => { newChatListeners.add(listener); return () => { newChatListeners.delete(listener); }; },
    () => newChatWithoutProject, () => newChatWithoutProject);
}

/** The choice kept for the person signed in now (account-storage.ts): never another person's. */
function stored(): string | undefined {
  try { return window.localStorage.getItem(accountKey(STORAGE_KEY)) ?? undefined; } catch { return undefined; }
}

let chosen: string | undefined = typeof window === 'undefined' ? undefined : stored();
// Every call names the project last chosen in this browser from the first one (goodvibes.ts `setCallProject`).
setCallProject(chosen);
const listeners = new Set<() => void>();

// Another person signed in (or nobody is): the project in use and a new chat's "No project" are read again for them,
// so no call of theirs names the previous person's project.
if (typeof window !== 'undefined') {
  subscribeClientLifetime(() => {
    chosen = stored();
    setCallProject(chosen);
    newChatWithoutProject = false;
    for (const listener of [...listeners]) listener();
    for (const listener of [...newChatListeners]) listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Choose the project (kept in this browser for the next visit). */
export function chooseProject(project: string): void {
  chosen = project;
  setCallProject(project);
  try { window.localStorage.setItem(accountKey(STORAGE_KEY), project); } catch { /* this browser keeps nothing: the choice lasts this visit */ }
  for (const listener of [...listeners]) listener();
}

interface ProjectsRead {
  readonly roots: readonly string[];
  /** The projects whose folder cannot be reached now (`reachable: false`: a disk not mounted, a parent folder renamed). */
  readonly unreachable: readonly string[];
}

/** The projects the daemon knows (`workspaces.projects.list`), its own folder first. */
async function readProjects(): Promise<ProjectsRead> {
  const answer = await invokeThroughMethod('workspaces.projects.list', {});
  const rows = answer && typeof answer === 'object' && Array.isArray((answer as { projects?: unknown }).projects) ? (answer as { projects: unknown[] }).projects : [];
  const read = rows.flatMap((row) => {
    const root = row && typeof row === 'object' ? (row as { root?: unknown }).root : undefined;
    return typeof root === 'string' && root.trim() !== '' ? [{ root, unreachable: (row as { reachable?: unknown }).reachable === false }] : [];
  });
  return {
    roots: [...new Set(read.map((row) => row.root))],
    unreachable: [...new Set(read.filter((row) => row.unreachable).map((row) => row.root))],
  };
}

/** The words beside a project whose folder cannot be reached now; nothing of it is lost, and it is the same project when its folder is back. */
const NOT_REACHABLE_NOW = 'not reachable now';

/** A project's name in a chooser: its last folder, with "not reachable now" when its folder cannot be reached. */
export function projectChoiceLabel(places: PlaceProjects, project: string, name: string = projectName(project)): string {
  return places.unreachable.includes(project) ? `${name} (${NOT_REACHABLE_NOW})` : name;
}

export interface PlaceProjects {
  /** The folders to choose from (empty until read, or when the daemon names none). */
  readonly projects: readonly string[];
  /** The ones whose folder cannot be reached now, shown "not reachable now" (still the same projects). */
  readonly unreachable: readonly string[];
  /** The project in use: the chosen one when the daemon still knows it, else the first it names. */
  readonly project: string | undefined;
  readonly choose: (project: string) => void;
  readonly status: 'reading' | 'ready' | 'failed';
  readonly reason?: string | undefined;
}

/** Whether a frame of the workspace domain says a project was added or let go (a `workspaces.*` capability ran). */
function changesProjects(frame: unknown): boolean {
  const outer = (typeof frame === 'object' && frame !== null ? frame : {}) as { type?: unknown; list?: unknown; id?: unknown; payload?: unknown };
  const inner = (typeof outer.payload === 'object' && outer.payload !== null ? outer.payload : {}) as { type?: unknown; list?: unknown; id?: unknown };
  for (const event of [inner, outer]) {
    if (event.type === 'LIST_CHANGED' && event.list === 'capabilities' && typeof event.id === 'string') return event.id.startsWith('workspaces.');
  }
  return false;
}

export function usePlaceProjects(): PlaceProjects {
  const read = useQuery({ queryKey: PLACE_PROJECTS_KEY, queryFn: readProjects, staleTime: Infinity });
  // Projects that could not be read are read again when the daemon's event stream is live again (no timer).
  const stream = useEventStreamState('app');
  const { isError, refetch } = read;
  useEffect(() => { if (stream.status === 'live' && isError) void refetch(); }, [stream.status, isError, refetch]);
  // The list follows the daemon the way every place's lists do (hooks/usePlaceLists.ts): a project added or let go is
  // announced on the event lane and read again; after a lane that dropped comes back, or lost frames, it is read again
  // too, since a notice may have been missed. No poll and no timer.
  const queryClient = useQueryClient();
  useEffect(() => subscribeEvents({
    domains: ['workspace'],
    events: ['workspace'],
    onEvent: (_name, payload) => { if (changesProjects(payload)) void queryClient.invalidateQueries({ queryKey: PLACE_PROJECTS_KEY }); },
    onReady: (resumed) => { if (resumed) void queryClient.invalidateQueries({ queryKey: PLACE_PROJECTS_KEY }); },
    onGap: () => { void queryClient.invalidateQueries({ queryKey: PLACE_PROJECTS_KEY }); },
  }), [queryClient]);
  const current = useSyncExternalStore(subscribe, () => chosen, () => chosen);
  const projects = read.data?.roots ?? [];
  const unreachable = read.data?.unreachable ?? [];
  const project = current && (projects.includes(current) || current === EVERY_PROJECT) ? current : projects[0];
  // The project in use is the one every call names, also when it is the first the daemon offers (none chosen yet).
  useEffect(() => { setCallProject(project); }, [project]);
  const choose = useCallback((next: string) => chooseProject(next), []);
  return {
    projects, unreachable, project, choose,
    status: read.isError ? 'failed' : read.data ? 'ready' : 'reading',
    ...(read.isError ? { reason: read.error instanceof Error ? read.error.message : String(read.error) } : {}),
  };
}

/**
 * The project a call made outside the places is for (the palette's runner, an action sheet): the open chat's while a
 * chat is open (goodvibes.ts `setChatCallProject`), else the one last chosen in this browser ("Every project" names none).
 */
export function lastChosenProject(): string | undefined {
  const chat = chatCallProject();
  if (chat) return chat;
  return chosen && chosen.startsWith('/') ? chosen : undefined;
}

/** A project's short name: its last folder. */
export function projectName(project: string): string {
  return project.split('/').filter(Boolean).at(-1) ?? project;
}
