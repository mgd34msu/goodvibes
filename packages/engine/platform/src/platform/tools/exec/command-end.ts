/**
 * command-end.ts: a command is finished when its own process has exited.
 *
 * The exec tool reads a command's stdout and stderr through pipes. A process the
 * command started and left running (`server &`, a daemon, a half-started
 * sandbox helper) inherits those pipes and keeps them open, so "read until the
 * end of the output" would wait as long as that process lives. No timer can tell
 * "the output is complete" from "more is coming", so none is used.
 *
 * Instead the shell that runs the command writes an end mark on both streams
 * once the command has returned, then exits with the command's status. Pipes keep
 * order: everything the command wrote arrives before the mark, so reading up to
 * the mark takes all of it, and nothing after it is the command's. A process the
 * command left running is not stopped; it is named in one line of the result.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

/** A mark no command prints by chance. */
export function newEndMark(): string {
  return `__GOODVIBES_EXEC_END_${randomUUID().replaceAll('-', '')}__`;
}

/**
 * The shell text that runs `command` in a subshell (so its own `exit`, `exec` or
 * traps end only the subshell), then writes `mark` on stdout and stderr and exits
 * with the command's status.
 */
export function withEndMark(command: string, mark: string): string {
  return `(\n${command}\n)\n__goodvibes_status=$?\nprintf '%s' '${mark}'\nprintf '%s' '${mark}' >&2\nexit "$__goodvibes_status"`;
}

/** Splits a stream's text at the end mark, holding back a possible start of the mark split across two reads. */
export class EndMarkReader {
  private held = '';
  found = false;

  constructor(private readonly mark: string) {}

  /** The part of `chunk` that is the command's output; nothing once the mark was read. */
  take(chunk: string): string {
    if (this.found) return '';
    const text = this.held + chunk;
    const at = text.indexOf(this.mark);
    if (at >= 0) {
      this.found = true;
      this.held = '';
      return text.slice(0, at);
    }
    let keep = Math.min(this.mark.length - 1, text.length);
    while (keep > 0 && !this.mark.startsWith(text.slice(text.length - keep))) keep -= 1;
    this.held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }

  /** What was held back, for a stream that ended without the mark (the shell was stopped). */
  flush(): string {
    const held = this.held;
    this.held = '';
    return held;
  }
}

/**
 * Reads `stream` into `append` up to the end mark or the end of the stream,
 * whichever comes first, and resolves with what lets the stream go. At the mark
 * the read stops; the caller lets the stream go once it has looked for a process
 * still holding it (leftRunningNote reads the pipe this process holds): what a
 * left-behind process writes later is not the command's output.
 */
export async function readToEndMark(
  stream: ReadableStream<Uint8Array>,
  mark: EndMarkReader,
  append: (text: string) => void,
): Promise<() => void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try { chunk = await reader.read(); } catch (error) { reader.releaseLock(); throw error; }
    if (chunk.done) {
      const tail = mark.take(decoder.decode()) + mark.flush();
      if (tail) append(tail);
      reader.releaseLock();
      return () => {};
    }
    const text = mark.take(decoder.decode(chunk.value, { stream: true }));
    if (text) append(text);
    // Not awaited: a pipe another process still holds never completes a cancel.
    if (mark.found) return () => { void reader.cancel().catch(() => {}); };
  }
}

/** The pipes this process holds (their `pipe:[inode]` names), read from /proc/self/fd. */
function ownPipes(): Set<string> {
  const pipes = new Set<string>();
  try {
    for (const fd of readdirSync('/proc/self/fd')) {
      try {
        const target = readlinkSync(`/proc/self/fd/${fd}`);
        if (target.startsWith('pipe:')) pipes.add(target);
      } catch { /* closed meanwhile */ }
    }
  } catch { /* no /proc */ }
  return pipes;
}

/**
 * The one line for a command whose own process exited while a process it started
 * still runs and still holds its output: in its process group, alive, with its
 * stdout or stderr on a pipe this process reads. Null when there is none, or
 * when that cannot be told (no /proc; a process that left the command's group).
 */
export function leftRunningNote(groupLeader: number | undefined): string | null {
  if (process.platform !== 'linux' || typeof groupLeader !== 'number' || groupLeader <= 1) return null;
  try { process.kill(-groupLeader, 0); } catch { return null; }
  const pipes = ownPipes();
  const holders: number[] = [];
  try {
    for (const entry of readdirSync('/proc')) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) !== groupLeader || fields[0] === 'Z' || fields[0] === 'X') continue;
        // A pipe whose other end this process reads, or a socket (Bun hands a child its output as one end of a socket
        // pair, whose two ends have different inodes): either way the command's output, which this group was made for.
        const holds = [1, 2].some((fd) => {
          try { const target = readlinkSync(`/proc/${pid}/fd/${fd}`); return pipes.has(target) || target.startsWith('socket:'); } catch { return false; }
        });
        if (holds) holders.push(pid);
      } catch { /* gone, or another user's */ }
    }
  } catch { return null; }
  if (holders.length === 0) return null;
  return `A process this command started is still running and still holds its output (pid ${holders.join(', ')}); it was left running, and what it writes from now on is not read.`;
}
