/**
 * browser-profile-carry.ts, the Agent's browser profile for Google carried into
 * the daemon's once.
 *
 * Until 3.5.0 the Agent drove Google's pages (the Cloud console, the app
 * password page) in its own browser profile, `~/.goodvibes/agent/browser/
 * profiles/google`, where the person signed in by hand. Connecting is the
 * daemon's work now, in the daemon's profile, `~/.goodvibes/goodvibes/browser/
 * profiles/google`. So someone signed in through the Agent does not sign in
 * again, the first time the daemon needs a browser for Google it copies the
 * Agent's profile into its own place, when the daemon has none yet:
 *
 *   - the Agent's profile is read and left exactly as it was, so a 3.5.0 Agent
 *     after a rollback opens it as before (the daemon's copy is unused by it);
 *   - a profile is a Chromium user-data directory; nothing in it names its own
 *     path, and its cookies are sealed with the key of the browser build and the
 *     user, not of the folder, so the copy opens signed in for the same browser
 *     the daemon launches (the one this product installs for every program);
 *   - a profile the Agent's browser has open (its `SingletonLock` names a
 *     process that is alive) is not copied, since a live browser rewrites its
 *     databases while it runs; the daemon's window then starts empty and the
 *     person signs in once more, which the run says;
 *   - the lock files and the caches are not copied (a cache is rebuilt, a lock
 *     names the Agent's process); the copy is made under a temporary name and
 *     renamed into place, so a copy cut short is never taken for a profile.
 */
import { cpSync, existsSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { browserProfileRoot } from '../browser/index.js';

/** The profile name Google's pages are read in, in both layouts. */
export const GOOGLE_BROWSER_PROFILE = 'google';

/** What came of carrying the profile, in words a run's note uses. */
export type GoogleProfileCarry =
  | { readonly carried: true; readonly note: string }
  | { readonly carried: false; readonly note?: string | undefined };

/** Files and folders not carried: the running browser's locks, and caches the browser rebuilds. */
const NOT_CARRIED = /^(Singleton(Lock|Socket|Cookie)|lockfile|.*Cache|Crashpad|BrowserMetrics.*)$/;

function liveLock(profile: string): boolean {
  try {
    const match = /-(\d+)$/.exec(readlinkSync(join(profile, 'SingletonLock')));
    const pid = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // No lock (ENOENT), or one whose process is gone (ESRCH): not open. A process we may not signal (EPERM) is alive.
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

/**
 * Copies the Agent's Google profile into the daemon's place (`daemonSurfaceRoot`) once: only when the daemon has no
 * Google profile yet and the Agent has one that is not open.
 */
export function carryAgentGoogleProfile(homeDirectory: string, daemonSurfaceRoot: string, agentSurfaceRoot = 'agent'): GoogleProfileCarry {
  const from = join(browserProfileRoot(homeDirectory, agentSurfaceRoot), GOOGLE_BROWSER_PROFILE);
  const to = join(browserProfileRoot(homeDirectory, daemonSurfaceRoot), GOOGLE_BROWSER_PROFILE);
  if (from === to || existsSync(to) || !existsSync(from)) return { carried: false };
  if (liveLock(from)) {
    return { carried: false, note: 'The Agent\'s browser has its Google window open, so its sign-in was not carried over: sign in to Google once in the window this opens.' };
  }
  const partial = `${to}.carrying`;
  try {
    rmSync(partial, { recursive: true, force: true });
    cpSync(from, partial, { recursive: true, verbatimSymlinks: true, filter: (source) => !NOT_CARRIED.test(basename(source)) });
    renameSync(partial, to);
    return { carried: true, note: 'Carried the Agent\'s Google browser sign-in over to the daemon\'s browser; the Agent\'s own copy is left as it was.' };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    return { carried: false, note: `The Agent's Google browser sign-in could not be carried over (${error instanceof Error ? error.message : String(error)}): sign in to Google once in the window this opens.` };
  }
}
