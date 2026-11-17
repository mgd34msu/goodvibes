/**
 * A product's interactive terminal app in a pseudo-terminal, driven by keystrokes.
 *
 * python3's pty module opens the terminal (120x40, xterm-256color) and runs the
 * app in it; this side writes keys to it and reads its screen output. Closing
 * stops the app and the relay by their own pids, never by name.
 */
import type { Subprocess } from 'bun';

const RELAY = `
import os, pty, signal, sys, select, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
def stop(*_):
    try: os.kill(pid, signal.SIGKILL)
    except OSError: pass
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
out = sys.stdout.buffer
while True:
    try: ready, _, _ = select.select([fd, 0], [], [])
    except InterruptedError: continue
    if fd in ready:
        try: data = os.read(fd, 65536)
        except OSError: data = b''
        if not data: break
        out.write(data); out.flush()
    if 0 in ready:
        data = os.read(0, 65536)
        if not data: stop()
        os.write(fd, data)
try: os.waitpid(pid, 0)
except OSError: pass
`;

/** Screen text without escape sequences or other control characters. */
export function plainScreen(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/[ \t]+/g, ' ');
}

export interface TerminalApp {
  readonly pid: number;
  /** Everything the app has written to the terminal, as written. */
  raw(): string;
  /** That output as plain text (see plainScreen). */
  screen(): string;
  /** Type text one key at a time, as a person does. */
  type(text: string, perKeyMs?: number): Promise<void>;
  /** Send raw bytes (Enter is "\r"). */
  press(bytes: string): void;
  /** Wait until the plain screen output written after `from` matches. */
  waitFor(pattern: RegExp, timeoutMs: number, from?: number): Promise<RegExpMatchArray | null>;
  close(): Promise<void>;
}

export function openTerminalApp(argv: readonly string[], options: { readonly cwd: string; readonly env: Record<string, string> }): TerminalApp {
  const child: Subprocess<'pipe', 'pipe', 'pipe'> = Bun.spawn(['python3', '-c', RELAY, ...argv], {
    cwd: options.cwd, env: { ...options.env, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  let output = '';
  const decoder = new TextDecoder();
  void (async () => { for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true }); })();
  void new Response(child.stderr).text();
  const app: TerminalApp = {
    pid: child.pid,
    raw: () => output,
    screen: () => plainScreen(output),
    async type(text, perKeyMs = 15) {
      for (const key of text) { child.stdin.write(key); await child.stdin.flush(); await Bun.sleep(perKeyMs); }
    },
    press(bytes) { child.stdin.write(bytes); void child.stdin.flush(); },
    async waitFor(pattern, timeoutMs, from = 0) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = plainScreen(output.slice(from)).match(pattern);
        if (found || Date.now() > deadline) return found;
        await Bun.sleep(100);
      }
    },
    async close() {
      child.kill('SIGTERM');
      const ended = await Promise.race([child.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
      if (!ended) child.kill('SIGKILL');
    },
  };
  return app;
}
