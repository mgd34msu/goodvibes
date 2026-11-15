import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * A stable identity token for "this pid, started at this moment", so a record
 * naming a pid can tell the process it was written by from an unrelated process
 * that later reused the number. Equal tokens for one pid mean the same process;
 * differing tokens mean it is a different one. `null` means the platform could
 * not say, and callers must then treat the owner as unprovable (never as dead).
 *
 * Linux reads the kernel's start tick. Other platforms (macOS, BSD) ask `ps`
 * for the start timestamp, which has one-second resolution; a pid reused inside
 * the same second by a different program is not distinguishable, and in that
 * case the owner is kept (the unsafe direction is treating a live owner as dead).
 */
export function processStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Fields after the parenthesised command name; starttime is field 22.
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return start !== undefined && /^\d+$/.test(start) ? start : null;
    } catch { return null; }
  }
  if (process.platform === 'win32') return null;
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const text = result.stdout.trim().replace(/\s+/g, ' ');
    return text.length > 0 && text.length <= 64 && /^[A-Za-z0-9: ]+$/.test(text) ? `ps:${text}` : null;
  } catch { return null; }
}
