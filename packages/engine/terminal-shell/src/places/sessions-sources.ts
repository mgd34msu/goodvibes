/**
 * sessions-sources.ts, what the program holding the conversation supplies to
 * the Sessions place (sessions-place.ts): its saved sessions with the open one,
 * this conversation's branches, and the hosted session this terminal joined.
 * Each is read when the place reads it, never kept here; a folder that cannot
 * be read is said as such (the place shows "Could not read ..."), never shown
 * as an empty list.
 */
import { readdirSync, existsSync } from 'node:fs';
import type { PlaceProgramSource } from './place-host.js';

interface SavedSessionsReader {
  list(): readonly unknown[];
  /** Told when a saved session is deleted (by this program); returns the stop. */
  onDeleted?(listener: (sessionId: string) => void): () => void;
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
  /** The hosted session this terminal joined, as its status lines; undefined when none is joined or the program cannot join one. */
  readonly joined?: (() => { readonly id: string; readonly title: string; readonly lines: readonly string[] } | undefined) | undefined;
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

/** The Sessions place's three program sources, by the names sessions-place.ts reads. */
export function sessionsPlaceSources(host: SessionsPlaceHost): Readonly<Record<string, PlaceProgramSource>> {
  return {
    sessions: {
      read() {
        const manager = host.sessionManager();
        if (!manager) throw new Error('this program keeps no saved sessions');
        assertReadable(host.sessionsDir());
        return { current: host.current(), saved: manager.list() };
      },
      subscribe(onChange) {
        return host.sessionManager()?.onDeleted?.(() => onChange()) ?? (() => {});
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
    'hosted-joined': {
      read: () => host.joined?.() ?? {},
      subscribe: (onChange) => host.onJoinedChange?.(onChange) ?? (() => {}),
    },
  };
}
