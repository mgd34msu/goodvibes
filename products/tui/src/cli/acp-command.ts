/**
 * acp-command.ts, `goodvibes acp`.
 *
 * Runs GoodVibes as an Agent Client Protocol agent on this process's stdio, so
 * an ACP-capable editor can launch the installed binary as its agent server.
 * The protocol adapter is the platform's `serveAcpAgent` (each `session/new`
 * boots an embedded session against the editor's cwd); this module only owns
 * the process contract around it.
 *
 * Stdout belongs to the protocol. Anything the runtime prints through
 * `console` while serving is redirected to stderr so it can never corrupt a
 * frame, a missing optional ACP library is one line on stderr with exit 1, and
 * the command ends, exit 0, when the editor closes stdin or the process is
 * told to stop.
 */
import { serveAcpAgent, type AcpStdio } from '@goodvibes-jev/engine/platform/platform/acp';
import { resolveGoodVibesHome } from '@goodvibes-jev/engine/platform/platform/config';

export const ACP_USAGE = 'Usage: goodvibes acp   (speaks the Agent Client Protocol on stdin/stdout; configure it as the editor\'s agent-server command)';

export interface RunAcpCommandInput {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** The process's own stdin/stdout unless an embedding supplies streams. */
  readonly stdio?: AcpStdio | undefined;
  /** Ends the command early, as SIGINT/SIGTERM do for the real process. */
  readonly signal?: AbortSignal | undefined;
}

/** Route `console` output to stderr for the duration of `run`. */
async function withConsoleOnStderr<T>(stderr: (line: string) => void, run: () => Promise<T>): Promise<T> {
  const original = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...parts: unknown[]): void => { stderr(parts.map(String).join(' ')); };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  try {
    return await run();
  } finally {
    Object.assign(console, original);
  }
}

/** Returns the process exit code: 0 on a normal close, 1 when ACP cannot run, 2 for a usage error. */
export async function runAcpCommand(input: RunAcpCommandInput): Promise<number> {
  if (input.args.length === 1 && (input.args[0] === '--help' || input.args[0] === '-h')) {
    input.stdout(ACP_USAGE);
    return 0;
  }
  if (input.args.length > 0) {
    input.stderr(ACP_USAGE);
    return 2;
  }
  return withConsoleOnStderr(input.stderr, async () => {
    let dispose: (() => Promise<void>) | undefined;
    try {
      // The same tree root every other entry point uses, so an editor that
      // launches this with HOME unset or GOODVIBES_HOME blank still reaches the
      // installed settings and accounts rather than the project directory.
      const served = await serveAcpAgent({ homeDirectory: resolveGoodVibesHome(input.env) }, input.stdio);
      dispose = served.dispose;
      const stopped = new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([served.connection.closed, stopped]);
      return 0;
    } catch (error) {
      input.stderr(`goodvibes acp: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    } finally {
      // A stream that broke mid-session still releases the embedded sessions.
      await dispose?.().catch(() => {});
    }
  });
}
