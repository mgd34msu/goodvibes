/**
 * fatal-boot-write.ts, the two descriptor writes, with nothing else attached.
 *
 * This file imports `node:fs` and nothing more, deliberately, because
 * `bin/goodvibes-agent.ts` routes through it and that shim must keep working
 * on a real npm install. This package declares NO runtime dependencies,
 * `@goodvibes-jev/engine/platform` is a devDependency and reaches an installed user
 * only inlined inside the bundled `dist/package/main.js`, so any module the
 * shim imports that statically reaches the platform would fail to resolve on the
 * exact installs the shim exists to explain.
 *
 * The platform-dependent half this file does not carry, `reportFatalBootFailure`,
 * previously mirrored locally in `utils/fatal-boot-report.ts`, is the platform's
 * own `@goodvibes-jev/engine/platform/platform/daemon` export, which adopted this
 * file's own byte-accepting write loop as the shared implementation. Every
 * non-`bin/` caller of `writeFatalLine`/`writeExitingStdoutLine` imports them
 * from here directly.
 */

import { writeSync } from 'node:fs';

/** stdout and stderr, as the file descriptors they actually are. */
const STDOUT_FD = 1;
const STDERR_FD = 2;

/**
 * Write `line` to `fd`, looping until every byte is accepted.
 *
 * The loop is a deliberate local difference from the platform's copy, which issues
 * one `writeSync` because it only ever carries a short fatal line. This repo
 * also routes `--help`, `--version`, completion scripts and the whole `status`
 * render through these functions, and a single `writeSync` of several kilobytes
 * into a pipe can return a short count, which would truncate the output rather
 * than silence it, a quieter version of the same defect. Keep the loop when the
 * platform export is adopted, or move it upstream.
 */
function writeLineToFd(fd: number, line: string): void {
  try {
    writeAllToFd(fd, Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf-8'));
  } catch {
    // A closed or unwritable descriptor must never turn a diagnostic into a
    // second failure. There is nothing further to fall back to: this IS the
    // fallback.
  }
}

/** A non-blocking pipe whose reader is slow reports EAGAIN until it drains. */
const MAX_EAGAIN_RETRIES = 40;
const EAGAIN_BACKOFF_MS = 5;

function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write every byte of `payload`. A full non-blocking pipe (EAGAIN) is waited out
 * with a bounded backoff instead of ending the loop, which would drop the rest of
 * a long `--help` or `status` render without any sign. Any other error, or a
 * pipe that stays full, ends the write and keeps what got through.
 */
export function writeAllToFd(
  fd: number,
  payload: Buffer,
  write: (fd: number, buffer: Buffer, offset: number, length: number) => number = writeSync,
  pause: (ms: number) => void = pauseSync,
): void {
  let written = 0;
  let retries = 0;
  while (written < payload.length) {
    let n: number;
    try {
      n = write(fd, payload, written, payload.length - written);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'EAGAIN' || retries >= MAX_EAGAIN_RETRIES) return;
      retries += 1;
      pause(EAGAIN_BACKOFF_MS * retries);
      continue;
    }
    // A zero-byte write would spin forever; stop and take what got through.
    if (n <= 0) break;
    written += n;
    retries = 0;
  }
}

/**
 * Write one line to stderr synchronously, immune to a replaced
 * `process.stderr` and to exit-time truncation. Use this for anything that
 * gates a process exit.
 */
export function writeFatalLine(line: string): void {
  writeLineToFd(STDERR_FD, line);
}

/**
 * The stdout twin, for output that must survive an exit that follows it,
 * `--help`, `--version` and `completion` all print and then exit immediately,
 * which is the same race.
 */
export function writeExitingStdoutLine(line: string): void {
  writeLineToFd(STDOUT_FD, line);
}
