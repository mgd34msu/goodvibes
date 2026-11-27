/**
 * daemon-home-custody.ts, whether the daemon's home is this account's alone, all the way up (gate-review-6 G10, G16).
 *
 * The daemon keeps its records, its operator token, its user store and the socket its programs register through in
 * its home. A home another account may write, or a folder above it another account may write (it could rename the
 * home away and put its own in its place), lets that account plant any of them; so the daemon does not start there,
 * and says which folder and the one command that fixes it. Nothing an unprivileged process can do switches program
 * verification off instead (the daemon no longer runs on with "unverified" programs in such a home).
 *
 * Each folder from `/` down to the home is looked at (as written, and again along its real path, so a link on the way
 * is judged where it leads): it must belong to root or to this account, and no other account may write it, except a
 * folder with the sticky bit (as /tmp has), where the next folder must then belong to this account. The home itself
 * must belong to this account and be written by no one else, and must not be a link.
 */
import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { dirname, sep } from 'node:path';

/** Why the daemon does not start in `home`, with the fix, or undefined when the home is this account's alone. */
export function daemonHomeCustodyRefusal(home: string, uid: number): string | undefined {
  let homeEntry: Stats | undefined;
  try { homeEntry = lstatSync(home); } catch { homeEntry = undefined; }
  if (homeEntry?.isSymbolicLink()) {
    return `The daemon will not start: its home ${home} is a link, so whoever can change the link chooses the daemon's records. Make it a folder of your own: rm ${home} (the link only), then start the daemon again.`;
  }
  for (const path of [home, safeRealPath(home)]) {
    if (path === undefined) continue;
    const refused = walk(path, uid);
    if (refused !== undefined) return refused;
  }
  return undefined;
}

function safeRealPath(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}

/** Every existing folder from `/` to `path`, the deepest last. */
function chain(path: string): string[] {
  const folders: string[] = [];
  let at = path;
  for (;;) {
    folders.unshift(at);
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return folders.length > 0 && folders[0] !== sep ? [sep, ...folders] : folders;
}

/**
 * The owner the system's own folders show here: root, and, when this process runs in a user namespace that does not
 * map the host's root (a container, a sandbox), the kernel's overflow id the host's root is shown as.
 */
function systemOwners(): ReadonlySet<number> {
  const owners = new Set<number>([0]);
  try {
    const map = readFileSync('/proc/self/uid_map', 'utf8').trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    const identity = map.length === 1 && map[0]![0] === 0 && map[0]![1] === 0;
    if (!identity) owners.add(Number(readFileSync('/proc/sys/kernel/overflowuid', 'utf8').trim()) || 65534);
  } catch { /* not Linux: root only */ }
  return owners;
}

function walk(path: string, uid: number): string | undefined {
  const folders = chain(path);
  const system = systemOwners();
  let afterSticky = false;
  for (const [index, folder] of folders.entries()) {
    let entry: Stats;
    try { entry = statSync(folder); } catch { continue; /* not made yet: the daemon makes it 0700 itself */ }
    const last = index === folders.length - 1;
    const ownerOk = last || afterSticky ? entry.uid === uid : system.has(entry.uid) || entry.uid === uid;
    if (!ownerOk) {
      return `The daemon will not start: ${folder} belongs to another account, so that account could replace the daemon's home `
        + `and plant its records. Put the daemon's home under a folder only you and root can change (set GOODVIBES_DAEMON_HOME), then start it again.`;
    }
    const othersWrite = (entry.mode & 0o022) !== 0;
    const sticky = (entry.mode & 0o1000) !== 0;
    if (othersWrite && (last || !sticky)) {
      return `The daemon will not start: ${folder} can be written by another account, so that account could replace the daemon's records, `
        + `its operator token and the programs it trusts. Fix it with: chmod go-w ${folder}`;
    }
    afterSticky = othersWrite && sticky;
  }
  return undefined;
}
