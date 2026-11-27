/**
 * process-identity.ts, one process on this machine named so that a later reader can tell whether that very process
 * still runs: `<pid>:<start>`, the start being the kernel's start time of the process (field 22 of /proc/<pid>/stat,
 * in clock ticks since boot). A number reused by a later process has another start, so it never reads as the same one.
 *
 * Linux only. Elsewhere no identity is made, and nothing named is ever read as gone.
 */
import { readFileSync } from 'node:fs';

interface ProcessState {
  readonly start: string;
  /** The kernel's one-letter state: `Z` (exited, not yet reaped) and `X` (dead) are no longer running. */
  readonly state: string;
}

function readState(pid: number): ProcessState | 'gone' | 'unknown' {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' || (error as NodeJS.ErrnoException | null)?.code === 'ESRCH' ? 'gone' : 'unknown';
  }
  // The command name sits in parentheses and may hold spaces or parentheses itself: the fields follow its last ')'.
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  const state = fields[0];
  const start = fields[19];
  return state && start && /^\d+$/.test(start) ? { state, start } : 'unknown';
}

/** The identity of the running process `pid`, or undefined when it cannot be read (another platform, or no such process). */
export function processIdentity(pid: number): string | undefined {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return undefined;
  const read = readState(pid);
  return typeof read === 'object' && read.state !== 'Z' && read.state !== 'X' ? `${pid}:${read.start}` : undefined;
}

/**
 * True only when the process an identity names is known to have ended: no process has its number, another process
 * (another start) has it now, or it has exited. A process that cannot be read, a malformed identity and another platform
 * read as not gone.
 */
export function processEnded(identity: string): boolean {
  if (process.platform !== 'linux') return false;
  const match = /^(\d+):(\d+)$/.exec(identity);
  if (!match) return false;
  const read = readState(Number(match[1]));
  if (read === 'gone') return true;
  if (read === 'unknown') return false;
  return read.start !== match[2] || read.state === 'Z' || read.state === 'X';
}

/** The process number an identity names, for words a person reads. */
export function processNumberOf(identity: string): string {
  return identity.split(':', 1)[0] ?? identity;
}
