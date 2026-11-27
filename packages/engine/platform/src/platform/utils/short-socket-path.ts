/**
 * short-socket-path.ts, a Unix socket path short enough for a socket address (under 108 bytes): the path itself, or,
 * for a longer one (a daemon home deep in a folder tree), the same place through a handle on its folder held by this
 * process (`/proc/self/fd/<n>/<name>`, Linux), released once the socket is bound or connected. The daemon binds its
 * program socket and the programs connect to it through this alike (daemon/program-socket.ts,
 * runtime/client/call-context.ts).
 */
import { closeSync, openSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export function shortSocketPath(path: string): { readonly path: string; readonly release: () => void } {
  if (Buffer.byteLength(path) < 100 || process.platform !== 'linux') return { path, release: () => {} };
  let folder: number;
  try { folder = openSync(dirname(path), 'r'); } catch { return { path, release: () => {} }; }
  let released = false;
  return {
    path: `/proc/self/fd/${folder}/${basename(path)}`,
    release: () => { if (released) return; released = true; try { closeSync(folder); } catch { /* closed */ } },
  };
}
