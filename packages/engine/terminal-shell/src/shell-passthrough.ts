/**
 * ShellPassthrough, runs user-typed `!<command>` shell escapes in both
 * terminal apps.
 *
 * The submission router reads a leading `!` as "shell"; this runs the command
 * directly (a user-initiated terminal escape, not an agent tool call), shows
 * its output in the transcript, and buffers a context block that is prepended to the user's next
 * real message, making the result visible to the model on the next turn
 * without triggering a turn of its own.
 *
 * A buffer is used rather than appending a conversation message because the
 * platform drops `system` messages from the LLM view and does not merge consecutive
 * `user` messages (which would trip a consecutive-user-message API error).
 */
import { SHELL_CONTEXT_CLOSE, SHELL_CONTEXT_OPEN } from '@goodvibes-jev/engine/platform/platform/core';

export const SHELL_USAGE_HINT =
  '[Shell] Usage: !<command>, runs a shell command; its output is shown and added as context for your next message. Esc stops a command that is still running.';

export interface ShellRunResult {
  /** The command, its output and its exit status, as the transcript shows them. */
  readonly display: string;
  /** It exited with a failure status or was stopped. */
  readonly failed: boolean;
  /** Context block buffered for the user's next turn. */
  readonly context: string;
}

export interface ShellRunOptions {
  /**
   * Stop the command after this long. Unset, it runs until it finishes: it runs beside the
   * composer, and Esc (turn cancel) or closing the app stops it.
   */
  readonly timeoutMs?: number;
}

/** Output kept per command, for the feed and for the model's context. */
export const SHELL_OUTPUT_LIMIT_CHARS = 20_000;
/** Buffered blocks kept for the next message; the oldest are dropped past this. */
const MAX_PENDING_BLOCKS = 8;
/** After the shell exits, how long to wait for output still in the pipes before giving up on it. */
const OUTPUT_GRACE_MS = 250;

/** Keeps the start of a stream up to a character limit and counts what it had to drop. */
class CappedText {
  private readonly decoder = new TextDecoder();
  private text = '';
  dropped = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Uint8Array): void {
    this.add(this.decoder.decode(chunk, { stream: true }));
  }

  finish(): string {
    this.add(this.decoder.decode());
    return this.text;
  }

  private add(piece: string): void {
    const room = this.limit - this.text.length;
    if (piece.length <= room) {
      this.text += piece;
      return;
    }
    if (room > 0) this.text += piece.slice(0, room);
    this.dropped += piece.length - Math.max(0, room);
  }
}

export class ShellPassthrough {
  private pending: string[] = [];
  private readonly running = new Set<{ stop: () => void }>();

  /** Run `command` in `cwd`, returning display + model-context renderings. */
  async run(command: string, cwd: string, options: ShellRunOptions = {}): Promise<ShellRunResult> {
    const timeoutMs = options.timeoutMs;
    // Its own process group, so stopping it reaches every part of a pipeline or `a; b` list and not only bash.
    const proc = Bun.spawn(['bash', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe', detached: process.platform !== 'win32' });
    const outcome: { stoppedBy: 'timeout' | 'cancelled' | null } = { stoppedBy: null };
    const stop = (reason: 'timeout' | 'cancelled'): void => {
      if (outcome.stoppedBy) return;
      outcome.stoppedBy = reason;
      try {
        if (process.platform === 'win32') proc.kill('SIGKILL');
        else process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // The group is already gone; fall back to the shell itself.
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
      }
    };
    const handle = { stop: () => stop('cancelled') };
    this.running.add(handle);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop('timeout'), timeoutMs);
    const out = new CappedText(SHELL_OUTPUT_LIMIT_CHARS);
    const err = new CappedText(SHELL_OUTPUT_LIMIT_CHARS);
    // Kept only to cancel at the end; the stream's own reader type (Node's web-stream one under Bun.spawn) has that.
    const readers: Array<Pick<ReadableStreamDefaultReader<Uint8Array>, 'cancel'>> = [];
    const drain = async (stream: ReadableStream<Uint8Array>, sink: CappedText): Promise<void> => {
      const reader = stream.getReader();
      readers.push(reader);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          sink.push(value);
        }
      } catch {
        // A cancelled reader ends the drain; what was read so far is kept.
      }
    };
    try {
      const drained = Promise.all([drain(proc.stdout, out), drain(proc.stderr, err)]);
      const exitCode = await proc.exited;
      // A background child can keep the pipes open after the shell has gone.
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([drained, new Promise<void>((resolve) => { grace = setTimeout(resolve, OUTPUT_GRACE_MS); })]);
      clearTimeout(grace);
      for (const reader of readers) void reader.cancel().catch(() => {});
      const combined = [out.finish(), err.finish()].filter((s) => s.trim().length > 0).join('\n').trimEnd();
      const dropped = out.dropped + err.dropped;
      const notes: string[] = [];
      if (dropped > 0) notes.push(`output cut: ${dropped} more character${dropped === 1 ? '' : 's'} not kept`);
      if (outcome.stoppedBy === 'timeout' && timeoutMs !== undefined) notes.push(`stopped after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs} ms`} without finishing`);
      if (outcome.stoppedBy === 'cancelled') notes.push('stopped before it finished');
      const body = combined.length > 0 ? combined : '(no output)';
      const status = `exit ${exitCode}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`;
      const result: ShellRunResult = {
        display: `$ ${command}\n${body}\n(${status})`,
        failed: exitCode !== 0 || outcome.stoppedBy !== null,
        context: `${SHELL_CONTEXT_OPEN}\n$ ${command}\n--- output (${status}) ---\n${body}\n${SHELL_CONTEXT_CLOSE}`,
      };
      this.pending.push(result.context);
      while (this.pending.length > MAX_PENDING_BLOCKS) this.pending.shift();
      return result;
    } finally {
      clearTimeout(timer);
      this.running.delete(handle);
    }
  }

  /** Stop every command still running (a turn cancel, or the app closing). */
  cancelRunning(): void {
    for (const handle of [...this.running]) handle.stop();
  }

  /** Take (and clear) the buffered shell context blocks. */
  takeContext(): string[] {
    const blocks = this.pending;
    this.pending = [];
    return blocks;
  }

  /** Give back blocks taken for a message that was not sent, ahead of any buffered since. */
  restoreContext(blocks: readonly string[]): void {
    this.pending = [...blocks, ...this.pending].slice(-MAX_PENDING_BLOCKS);
  }

  /** Prepend (and clear) any buffered shell context onto an outgoing message. */
  consumeContext(text: string): string {
    return withShellContext(this.takeContext(), text);
  }
}

/** A message with shell context blocks in front of it. */
export function withShellContext(blocks: readonly string[], text: string): string {
  if (blocks.length === 0) return text;
  const context = blocks.join('\n\n');
  return text ? `${context}\n\n${text}` : context;
}

/** The shell context taken for one message. `restore()` returns it once; `release()` drops it. */
export interface ShellContextHandle {
  readonly blocks: string[];
  restore(): void;
  release(): void;
}

/**
 * Takes the buffered shell context for a message that has not been admitted yet. Each message gets
 * its own handle, so a second message sent while the first is still being routed cannot overwrite
 * what the first would restore. `restore()` gives the blocks back to the buffer if the message is
 * refused or fails; `release()` ends the hold once the message was admitted, so a later refusal of
 * something else cannot bring old output back.
 */
export class ShellContextHold {
  constructor(private readonly shell: ShellPassthrough) {}

  take(): ShellContextHandle {
    const blocks = this.shell.takeContext();
    let held: string[] = blocks;
    return {
      blocks,
      restore: () => {
        if (held.length === 0) return;
        this.shell.restoreContext(held);
        held = [];
      },
      release: () => { held = []; },
    };
  }
}
