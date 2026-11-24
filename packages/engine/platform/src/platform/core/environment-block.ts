/**
 * The environment the model is told about: the working folder, the operating
 * system, today's date, and whether the folder is a git repository with its
 * branch and uncommitted changes.
 *
 * It travels in the host channel (host-instructions.ts, key `environment`),
 * after the conversation, never in the system prompt: the date changes and the
 * repository changes as the model works, and the system prompt and the history
 * before it stay byte-identical so the provider's cached prefix holds.
 *
 * Cost: one `git status` per session, on its first turn; every later turn
 * reuses it and reads only the clock.
 */
import { platform, release } from 'node:os';
import { GitService } from '../git/service.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

/** What is read once per session. */
export interface SessionEnvironment {
  readonly workingDirectory: string;
  readonly operatingSystem: string;
  /** `undefined` when git could not say (not installed, unreadable). */
  readonly git?: { readonly repository: false } | { readonly repository: true; readonly branch: string; readonly detached: boolean; readonly uncommitted: number } | undefined;
}

const OS_NAMES: Readonly<Record<string, string>> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows', freebsd: 'FreeBSD', openbsd: 'OpenBSD' };

/** Reads the session's facts: one `git status` in `workingDirectory`, without taking git's optional locks. */
export async function readSessionEnvironment(workingDirectory: string): Promise<SessionEnvironment> {
  const operatingSystem = `${OS_NAMES[platform()] ?? platform()} ${release()}`;
  try {
    const status = await new GitService(workingDirectory, undefined, { noOptionalLocks: true }).status();
    return { workingDirectory, operatingSystem,
      git: { repository: true, branch: status.current ?? '', detached: status.detached, uncommitted: status.files.length } };
  } catch (error) {
    const message = summarizeError(error);
    if (/not a git repository/i.test(message)) return { workingDirectory, operatingSystem, git: { repository: false } };
    logger.debug('Environment: git status could not be read', { workingDirectory, error: message });
    return { workingDirectory, operatingSystem };
  }
}

/** The local calendar date, `2026-11-24 (Tuesday)`. */
function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} (${weekday})`;
}

/** The block the model reads, for one request on `now`. */
export function environmentBlock(environment: SessionEnvironment, now: Date): string {
  const git = environment.git;
  const repository = git === undefined ? undefined
    : !git.repository ? 'Git: the working folder is not a git repository.'
      : `Git: a repository, ${git.detached ? 'detached HEAD' : `branch ${git.branch || '(none yet)'}`}; `
        + `${git.uncommitted === 0 ? 'no uncommitted changes' : `${git.uncommitted} file${git.uncommitted === 1 ? '' : 's'} with uncommitted changes`} at the start of this session.`;
  return ['## Environment', `Working folder: ${environment.workingDirectory}`, `Operating system: ${environment.operatingSystem}`,
    `Today: ${localDate(now)}`, ...(repository ? [repository] : [])].join('\n');
}

const sessions = new WeakMap<object, { readonly directory: string; readonly facts: Promise<SessionEnvironment> }>();

/** The session's facts, read on its first turn and kept with its conversation; a changed folder reads them again. */
export function sessionEnvironment(session: object, workingDirectory: string): Promise<SessionEnvironment> {
  const known = sessions.get(session);
  if (known && known.directory === workingDirectory) return known.facts;
  const facts = readSessionEnvironment(workingDirectory);
  sessions.set(session, { directory: workingDirectory, facts });
  return facts;
}
