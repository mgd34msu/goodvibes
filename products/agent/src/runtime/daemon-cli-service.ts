/**
 * daemon-cli-service.ts, asking the daemon's own CLI to install its service.
 *
 * ── Why the CLI and not the in-process service manager ─────────────────────
 *
 * The Agent already reads a service entry in-process, through the platform's
 * `createDaemonServiceControl` over `PlatformServiceManager`, and that stays
 * exactly where it is: it is the right seam for the boot-time start of an
 * installed-but-stopped host, because that path only ever needs to know
 * "installed?" and "start it".
 *
 * Repairing a machine needs one thing that seam cannot honestly do: INSTALL a
 * unit. A unit written by this process would carry a command line this process
 * resolved, and the Agent does not own the daemon's binary, its arguments, or
 * its environment. `goodvibes-daemon install-service` does, it is the daemon
 * naming itself. So the repair path talks to the daemon's CLI, which is
 * installed alongside the Agent (the Agent depends on @goodvibes/daemon
 * and its launcher lands on PATH), and which publishes a machine-readable
 * exit-code contract precisely so a caller never parses prose:
 *
 *   install-service        installs the unit AND starts it (exit 0 on success)
 *
 * Whether a unit is installed and running is read in-process
 * (daemon-repair.ts, over the platform service control), not through the CLI.
 *
 * ── The boundaries ─────────────────────────────────────────────────────────
 *
 * - The Agent process is not sandboxed, so it may spawn this directly. It is
 *   still the ONLY thing spawned here, always by bare name so an operator's
 *   PATH decides which one answers, and never with a shell.
 * - A CLI that is absent, unreadable, or too old to know these subcommands is a
 *   normal answer ('unavailable'), never an exception. A machine without the
 *   daemon installed must not be a machine where the Agent fails to boot.
 * - Nothing here decides anything. It reports what the CLI said; the policy in
 *   daemon-repair.ts decides what that means.
 * - The CLI runs asynchronously, bounded by an abort: the repair runs inside a
 *   keypress handler, and a synchronous spawn would freeze the terminal for as
 *   long as the service manager takes.
 */
import { spawn } from 'node:child_process';

/** The launcher name the daemon package installs; resolved through PATH. */
export const DAEMON_CLI_BINARY = 'goodvibes-daemon';

/** One completed run of the daemon CLI, or the honest reason there wasn't one. */
export interface DaemonCliRun {
  /** False when the binary could not be run at all (absent, not executable). */
  readonly ran: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Present only when `ran` is false, why the spawn itself did not happen. */
  readonly spawnError?: string;
}

/** The narrow seam every effect in this module goes through, so tests never spawn. */
export type DaemonCliRunner = (args: readonly string[]) => Promise<DaemonCliRun>;

/** One attempted service change, as the CLI reported it. */
export interface DaemonServiceActionReport {
  readonly ok: boolean;
  /** Honest, already-trimmed text from the CLI, its own wording, never invented here. */
  readonly detail: string;
}

/** Spawn the daemon CLI by bare name, capturing both streams. Never rejects. */
export function createDaemonCliRunner(options: {
  readonly timeoutMs?: number;
  readonly binary?: string;
} = {}): DaemonCliRunner {
  const binary = options.binary ?? DAEMON_CLI_BINARY;
  const timeout = options.timeoutMs ?? 30_000;
  return (args) => new Promise<DaemonCliRun>((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const settle = (run: DaemonCliRun): void => {
      if (settled) return;
      settled = true;
      resolve(run);
    };
    try {
      const child = spawn(binary, [...args], {
        // No shell: the argument vector is passed through verbatim, so nothing
        // in a unit name or a path is ever re-interpreted by a shell.
        shell: false,
        // Passed EXPLICITLY, and not left to default to "whatever the runtime
        // captured at startup". Without it, a bare command name is resolved
        // against a PATH snapshot taken when the process began, so a PATH set
        // after startup is ignored and a different binary answers than the one
        // the current environment names.
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(timeout),
      });
      child.stdout?.setEncoding('utf-8').on('data', (chunk: string) => { stdout.push(chunk); });
      child.stderr?.setEncoding('utf-8').on('data', (chunk: string) => { stderr.push(chunk); });
      child.on('error', (error) => {
        const aborted = (error as { name?: string }).name === 'AbortError';
        settle({
          ran: false, exitCode: -1, stdout: stdout.join(''), stderr: stderr.join(''),
          spawnError: aborted ? `did not finish within ${Math.round(timeout / 1000)} s` : error.message,
        });
      });
      child.on('close', (code, signal) => {
        // A signalled process has a null code; that is "the CLI did not answer",
        // not "the CLI answered zero".
        settle(code === null
          ? { ran: false, exitCode: -1, stdout: stdout.join(''), stderr: stderr.join(''), spawnError: signal ? `ended on signal ${signal}` : 'ended without an exit code' }
          : { ran: true, exitCode: code, stdout: stdout.join(''), stderr: stderr.join('') });
      });
    } catch (error) {
      settle({ ran: false, exitCode: -1, stdout: '', stderr: '', spawnError: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** First non-empty line of the CLI's output, for a one-line honest detail. */
function firstMeaningfulLine(run: DaemonCliRun): string {
  const candidates = [...run.stderr.split('\n'), ...run.stdout.split('\n')];
  for (const line of candidates) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** Install the daemon's service entry (which also starts it) via its own CLI. */
export async function installDaemonService(run: DaemonCliRunner): Promise<DaemonServiceActionReport> {
  return describeAction(await run(['install-service']), 'install-service');
}

function describeAction(result: DaemonCliRun, subcommand: string): DaemonServiceActionReport {
  if (!result.ran) {
    return {
      ok: false,
      detail: `the ${DAEMON_CLI_BINARY} command could not be run (${result.spawnError ?? 'no reason given'})`,
    };
  }
  if (result.exitCode === 0) {
    return { ok: true, detail: firstMeaningfulLine(result) || `${subcommand} completed` };
  }
  return {
    ok: false,
    detail: firstMeaningfulLine(result)
      || `${DAEMON_CLI_BINARY} ${subcommand} exited ${result.exitCode}`,
  };
}
