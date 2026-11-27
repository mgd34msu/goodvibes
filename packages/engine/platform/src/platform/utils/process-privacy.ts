/**
 * process-privacy.ts, keeping a GoodVibes program's own environment and memory from the person's other processes.
 *
 * A program's environment (`/proc/<pid>/environ`) and memory are readable by every process of the same account,
 * including a command a model runs with no sandbox around it. The terminal app, the Agent and the daemon can hold the
 * operator token (`GOODVIBES_DAEMON_TOKEN`, when the person sets it), provider keys the person exported, and in memory
 * every credential they read. On Linux each marks itself not dumpable at start (`prctl(PR_SET_DUMPABLE, 0)`): its
 * `/proc/<pid>/environ`, `mem` and the like then belong to root, and no other process of the account (a model's
 * command, a tool server, a script) can read them or attach to it. A program it starts is not affected (the mark is
 * reset when that program starts), so it never keeps a credential in a child's environment either (tools/exec and the
 * tool-server and language-server starts scrub them).
 *
 * Elsewhere (macOS, Windows) nothing is done: the operating system keeps other processes out of a process's memory by
 * its own rules, and its environment is not a file another process reads.
 */
import { dlopen, FFIType } from 'bun:ffi';

/** prctl's option that sets whether the process may be dumped or read through /proc by its own account (linux/prctl.h). */
const PR_SET_DUMPABLE = 4;

/** Set whether this process may be read through /proc by its own account (Linux). True when it took effect. */
function setDumpable(value: 0 | 1): boolean {
  if (process.platform !== 'linux') return false;
  for (const library of ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1']) {
    try {
      const libc = dlopen(library, {
        prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      });
      try {
        return libc.symbols.prctl(PR_SET_DUMPABLE, value, 0, 0, 0) === 0;
      } finally {
        libc.close();
      }
    } catch {
      // Not this library's name here: try the next.
    }
  }
  return false;
}

/** Whether this process marked itself not dumpable (keepProcessPrivate). */
let markedPrivate = false;

/** Mark this process not dumpable (Linux). True when it took effect; false where it is not done or could not be. */
export function keepProcessPrivate(): boolean {
  markedPrivate = setDumpable(0);
  return markedPrivate;
}

/** How many registrations hold this process open now: it is private again only when the last of them closes. */
let openings = 0;

/**
 * Let the local daemon read which program this process is, for its own step of one registration (daemon/program-peer.ts,
 * over the daemon's program socket, runtime/client/call-context.ts): the process is readable by its account from now
 * until the answer closes it, and never longer than `capMs` by this process's own timer, whatever the far end does.
 * Several registrations at once are counted: each one's close ends only its own opening. A process that was not private
 * (another platform, or one that never marked itself) is left as it was. Answers the close (safe to call twice).
 */
export function openForReading(capMs: number): () => void {
  if (!markedPrivate) return () => {};
  if (openings === 0 && !setDumpable(1)) return () => {};
  openings += 1;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(cap);
    openings -= 1;
    if (openings === 0) setDumpable(0);
  };
  const cap = setTimeout(close, capMs);
  return close;
}
