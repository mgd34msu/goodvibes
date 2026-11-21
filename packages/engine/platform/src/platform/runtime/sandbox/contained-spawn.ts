/**
 * contained-spawn.ts, containment as a property of the spawn.
 *
 * A program the product chose itself (git, rg, bwrap, systemctl) is spawned
 * where it is needed, from a file on the architecture check's reviewed list
 * (scripts/daemon-architecture-check.ts `PRODUCT_PROGRAM_SPAWN_FILES`). A
 * program someone else chose (a project's formatter or verify script, a
 * command a model wrote, a plugin's helper) is started only here: the caller
 * states what the program may write, whether it has a network, and whether a
 * host run is acceptable when no boundary exists, and the result says what
 * actually applied. A boundary that cannot be built is a refusal that names
 * why and what to do, never a quiet host run: `network: 'off'` is never met by
 * a host process, and `boundary: 'required'` never runs on the host at all.
 *
 * Cost: one bubblewrap start per program (a few milliseconds); the host probe
 * is the exec sandbox's, made once per process.
 */
import { homedir } from 'node:os';
import { hostSandboxAvailability } from '../../tools/exec/sandbox.js';
import { containedArgv } from './backend.js';

/** Who chose the program: one the project, a model or a plugin picks must be contained. */
export type ProgramOrigin = 'project' | 'model' | 'plugin';

export interface Containment {
  /** `required`: no boundary, no run. `host-allowed`: with no boundary the program runs on the host, and the result says so. */
  readonly boundary: 'required' | 'host-allowed';
  /** `off` is never met by a host run: without a boundary that unshares the network the spawn is refused. */
  readonly network: 'off' | 'on';
  /** Absolute paths the program may write; nothing else is writable (the working directory too, unless listed). */
  readonly writable: readonly string[];
  /** Absolute paths it may read beyond the system, its own install root and its working directory. */
  readonly readOnly?: readonly string[] | undefined;
  /** Why the caller contains it, named in a refusal. */
  readonly reason: string;
}

export interface ContainedSpawn {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** `scrubbed`: PATH, locale, TZ and TERM only, with HOME pointing at the boundary's private home. */
  readonly env: 'scrubbed' | Readonly<Record<string, string>>;
  readonly stdin?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly origin: ProgramOrigin;
  readonly containment: Containment;
}

export interface ContainedResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** What actually applied; a result is trusted only as far as this says. */
  readonly applied: { readonly backend: 'bubblewrap' | 'host'; readonly network: 'off' | 'on' };
}

export class ContainmentUnavailableError extends Error {
  readonly code = 'CONTAINMENT_UNAVAILABLE';
  readonly reason: string;
  readonly next: string;
  constructor(reason: string, next: string) {
    super(`${reason} ${next}`);
    this.name = 'ContainmentUnavailableError';
    this.reason = reason;
    this.next = next;
  }
}

const SCRUBBED_ENV_NAMES = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'] as const;

function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = { HOME: homedir() };
  for (const name of SCRUBBED_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const INSTALL_BUBBLEWRAP = 'Install bubblewrap (the bwrap program) so the program can run inside a boundary.';

/** Where the program runs: the argv to start, and what will apply. Throws when the containment cannot be met. */
function plan(spawn: ContainedSpawn): { readonly argv: readonly string[]; readonly applied: ContainedResult['applied'] } {
  const [command, ...args] = spawn.argv;
  if (command === undefined) throw new Error('runContained needs a program to run');
  const availability = hostSandboxAvailability();
  const { containment } = spawn;
  if (availability.available && availability.bwrapPath) {
    if (containment.network === 'off' && !availability.networkIsolationGuaranteed) {
      throw new ContainmentUnavailableError(
        `The ${spawn.origin}'s program was not run: ${containment.reason}, with no network, and this host cannot prove a boundary without one (${availability.reason}).`,
        'Allow user namespaces with network isolation for bubblewrap on this host.');
    }
    return {
      argv: containedArgv({
        bwrapPath: availability.bwrapPath, command, args, cwd: spawn.cwd,
        writable: containment.writable, readOnly: containment.readOnly ?? [], network: containment.network,
      }),
      applied: { backend: 'bubblewrap', network: containment.network },
    };
  }
  if (containment.boundary === 'required') {
    throw new ContainmentUnavailableError(`The ${spawn.origin}'s program was not run: ${containment.reason}, and no boundary is available here (${availability.reason}).`, INSTALL_BUBBLEWRAP);
  }
  if (containment.network === 'off') {
    throw new ContainmentUnavailableError(`The ${spawn.origin}'s program was not run: ${containment.reason}, with no network, and a host process cannot be kept off the network (${availability.reason}).`, INSTALL_BUBBLEWRAP);
  }
  return { argv: [command, ...args], applied: { backend: 'host', network: 'on' } };
}

/** Read a pipe to its end, or to the moment it is cancelled; text read so far is kept. */
function readPipe(stream: ReadableStream<Uint8Array>): { readonly text: Promise<string>; cancel(): void } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const text = (async () => {
    let out = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
    } catch {
      // A cancelled or broken pipe ends the output; what arrived is kept.
    }
    return out + decoder.decode();
  })();
  return { text, cancel: () => { void reader.cancel().catch(() => {}); } };
}

/**
 * Run one program someone other than the product chose, inside the
 * containment the caller states. Resolves with its output and what applied;
 * rejects with `ContainmentUnavailableError` when the containment cannot be
 * met (nothing was started), or when the program could not be started.
 *
 * Off Windows the program leads its own process group. An abort stops the
 * whole group (a server a verify script left in the background included) and
 * stops reading its pipes, so a descendant that holds them open cannot keep
 * the run waiting; the result then has a null exit code.
 */
export async function runContained(spawn: ContainedSpawn): Promise<ContainedResult> {
  const { argv, applied } = plan(spawn);
  spawn.signal?.throwIfAborted();
  const ownGroup = process.platform !== 'win32';
  const child = Bun.spawn([...argv], {
    cwd: spawn.cwd,
    env: spawn.env === 'scrubbed' ? scrubbedEnv() : { ...spawn.env },
    stdin: spawn.stdin === undefined ? 'ignore' : new TextEncoder().encode(spawn.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: ownGroup,
  });
  const stdout = readPipe(child.stdout);
  const stderr = readPipe(child.stderr);
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (ownGroup) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
    }
    try { child.kill('SIGKILL'); } catch { /* the child is already gone */ }
    stdout.cancel();
    stderr.cancel();
  };
  spawn.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (spawn.signal?.aborted) stop();
    const [out, err, exitCode] = await Promise.all([stdout.text, stderr.text, child.exited]);
    return Object.freeze({ exitCode: stopped || child.signalCode !== null ? null : exitCode, stdout: out, stderr: err, applied: Object.freeze(applied) });
  } finally {
    spawn.signal?.removeEventListener('abort', stop);
  }
}
