/**
 * sessions-sources.ts, what the program holding the conversation supplies to
 * the Sessions place (sessions-place.ts): its saved sessions with the open one
 * (searched by what was said in them), this conversation's branches, its
 * record's bookmarked blocks, the project's cross-session task graph, and the
 * hosted session this terminal joined. Each is read when the place reads it,
 * never kept here; a folder or file that cannot be read is said as such (the
 * place shows "Could not read ..."), never shown as an empty list.
 */
import { readdirSync, existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { searchSessionMessages } from '@goodvibes/engine/platform/platform/sessions';
import type { PlaceProgramSource } from './place-host.js';

interface SavedSessionsReader {
  list(): readonly unknown[];
  /** Every saved session with its messages' text, each file read once (searched in memory as the words are typed). */
  readSearchable?(): readonly { readonly session: { readonly name: string }; readonly messages: readonly string[] }[];
  /** Told when a saved session is deleted (by this program); returns the stop. */
  onDeleted?(listener: (sessionId: string) => void): () => void;
}

/** The project's cross-session task graph as this program reads it. */
interface TaskGraphReader {
  snapshot(): { readonly refs: unknown; readonly edges: unknown; readonly handoffs: unknown };
}

export interface SessionsPlaceHost {
  /** The program's saved sessions in this project; null when it keeps none. */
  readonly sessionManager: () => SavedSessionsReader | null | undefined;
  /** The folder they are kept in, to tell a folder that cannot be read from one that holds none. */
  readonly sessionsDir: () => string | undefined;
  /** The open conversation. */
  readonly current: () => { readonly id: string; readonly title: string; readonly messages: number; readonly model: string; readonly provider: string };
  /** This conversation's branches, or why this program keeps none. */
  readonly branches: () => readonly { readonly name: string; readonly messageCount: number; readonly isCurrent: boolean }[] | { readonly none: string };
  /** The open conversation's bookmarked blocks; undefined when this program keeps none. */
  readonly bookmarks?: (() => readonly { readonly key: string; readonly label: string; readonly timestamp: number }[]) | undefined;
  /** The project's cross-session task graph; null when this program has none open. */
  readonly taskGraph?: (() => TaskGraphReader | null | undefined) | undefined;
  /** The graph's file, watched so a change another terminal makes shows by itself. */
  readonly taskGraphFile?: (() => string | undefined) | undefined;
  /** True in a program that changes only its own session's part of the graph (the Agent): other tasks show no control. */
  readonly ownTasksOnly?: boolean | undefined;
  /** The hosted session this terminal joined, as its status lines; undefined when none is joined or the program cannot join one. */
  readonly joined?: (() => {
    readonly id: string; readonly title: string; readonly lines: readonly string[];
    /** The tool the session is running now, from its own events (its name); absent while none runs. */
    readonly runningTool?: string | undefined;
  } | undefined) | undefined;
  /** Told when the joined session changes; returns the stop. */
  readonly onJoinedChange?: ((listener: () => void) => () => void) | undefined;
}

/** Throw the folder's own reason when it exists and cannot be listed. */
function assertReadable(dir: string | undefined): void {
  if (!dir || !existsSync(dir)) return;
  try {
    readdirSync(dir);
  } catch (error) {
    throw new Error(`the folder ${dir} could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** A session's title by its id, for the task graph's rows (the open one and the saved ones this program knows). */
function sessionTitles(host: SessionsPlaceHost): Record<string, string> {
  const titles: Record<string, string> = {};
  try {
    for (const info of host.sessionManager()?.list() ?? []) {
      const meta = info as { readonly name?: unknown; readonly title?: unknown };
      if (typeof meta.name === 'string' && typeof meta.title === 'string' && meta.title) titles[meta.name] = meta.title;
    }
  } catch {
    // Titles are a courtesy: a task row names its session by id when they cannot be read.
  }
  const current = host.current();
  titles[current.id] = current.title && current.title !== '(untitled)' ? `${current.title} (open here)` : 'this conversation';
  return titles;
}

/**
 * Told when the file changes, whoever wrote it: its folder is watched (the graph is replaced whole on each write), or
 * the nearest folder above that exists, until the file's own folder is made. Returns the stop.
 */
function watchFile(path: string | undefined, onChange: () => void): () => void {
  if (!path) return () => {};
  let watcher: FSWatcher | undefined;
  let stopped = false;
  const attach = (): void => {
    watcher?.close();
    watcher = undefined;
    let folder = dirname(path);
    while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
    const own = folder === dirname(path);
    try {
      watcher = watch(folder, { persistent: false }, (_event, name) => {
        if (stopped) return;
        if (own ? name === null || name === basename(path) : true) onChange();
        // The file's folder now exists: watch it instead.
        if (!own && existsSync(dirname(path))) attach();
      });
    } catch {
      watcher = undefined;
    }
  };
  attach();
  return () => { stopped = true; watcher?.close(); };
}

/** The Sessions place's program sources, by the names sessions-place.ts reads. */
export function sessionsPlaceSources(host: SessionsPlaceHost): Readonly<Record<string, PlaceProgramSource>> {
  // What the saved sessions said, read once when a search of them starts (its first word typed) and kept while the
  // words are typed; let go whenever the list is read again (it changed, or `r`), so the next search reads it anew.
  let said: ReturnType<NonNullable<SavedSessionsReader['readSearchable']>> | undefined;
  return {
    sessions: {
      read() {
        said = undefined;
        const manager = host.sessionManager();
        if (!manager) throw new Error('this program keeps no saved sessions');
        assertReadable(host.sessionsDir());
        return { current: host.current(), saved: manager.list() };
      },
      subscribe(onChange) {
        return host.sessionManager()?.onDeleted?.(() => { said = undefined; onChange(); }) ?? (() => {});
      },
      // What was said in each saved session: the first line that holds the words, filtered in memory.
      find(words) {
        const found = new Map<string, string>();
        said ??= host.sessionManager()?.readSearchable?.() ?? [];
        for (const result of searchSessionMessages(said, words)) {
          const line = result.snippets[0];
          if (line) found.set(result.session.name, line.replace(/\s+/g, ' ').trim());
        }
        return found;
      },
    },
    branches: {
      read() {
        const branches = host.branches();
        if ('none' in branches) throw new Error(branches.none);
        return { branches };
      },
      subscribe: () => () => {},
    },
    record: {
      read: () => ({ bookmarks: host.bookmarks?.() ?? [] }),
      subscribe: () => () => {},
    },
    'task-graph': {
      read() {
        const graph = host.taskGraph?.();
        if (!graph) throw new Error('this program has no cross-session task graph open');
        return { ...graph.snapshot(), titles: sessionTitles(host), here: host.current().id, ...(host.ownTasksOnly ? { ownTasksOnly: true } : {}) };
      },
      subscribe: (onChange) => watchFile(host.taskGraphFile?.(), onChange),
    },
    'hosted-joined': {
      read: () => host.joined?.() ?? {},
      subscribe: (onChange) => host.onJoinedChange?.(onChange) ?? (() => {}),
    },
  };
}
