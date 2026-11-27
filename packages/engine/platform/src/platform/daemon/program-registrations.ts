/**
 * program-registrations.ts, the daemon's record of the terminal programs registered with it: which program (the terminal
 * app or the Agent) holds which registration, bound to the principal and the kind of credential it registered with,
 * and to the very process and connection that proved it.
 *
 * A registration is issued only over the daemon's program socket (daemon/program-socket.ts), to a process the kernel
 * names as the one that opened that connection itself and answered the daemon's challenge on it, judged from the system
 * to be one of the product's own programs (daemon/program-peer.ts). It is a random secret, sent once over that
 * connection and kept by the program in memory only (runtime/client/call-context.ts), never in a file, an environment
 * or a log. The program sends it as proof on every call to that daemon (`x-goodvibes-program-key`); the daemon's router
 * checks it here, once per request, against the request's own principal and credential kind, and against the
 * registration being alive: it ENDS when the process that proved it ends (the daemon holds a handle on that process,
 * so a reused process number is never it), when the connection that proved it closes, and at every daemon restart (it
 * is kept in memory only). A registration presented after its process ended, or another connection's challenge
 * answered, proves nothing. A connected host on another machine never issues one: a Unix socket does not cross
 * machines, and there the program's presses are the owner's only through the owner's own sign-in on that host.
 *
 * A registration names a program only; it grants nothing a credential does not already hold: a remembered answer and a
 * conversation belong to the program that made them, and a call a registered program of the owner's own credential says
 * its gate decided is taken so (daemon/method-owner-decision.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';

/**
 * The owner's programs that register: the terminal app, the Agent, and the daemon's own program. Each is the owner's
 * own program where the one owner rule asks (daemon/method-owner-decision.ts `ownerHimself`).
 */
export type RegisteredProgram = 'tui' | 'agent' | 'daemon';

export function isRegisteredProgram(value: unknown): value is RegisteredProgram {
  return value === 'tui' || value === 'agent' || value === 'daemon';
}

/**
 * The kind a command line registers as: the three `do`/`find` command lines (`goodvibes`, `goodvibes-agent`,
 * `goodvibes-daemon`), judged as the binary they run from but issued as their own kind, never as that program. It is
 * never the owner in person and never a person's press, whatever its environment, terminal or marks say: it runs no-risk
 * reads; every risky capability it names is held for the owner (capabilities/command-line-hold.ts); it answers no
 * question addressed to the owner and approves nothing (reading a held call's outcome by its id is a read). Known to the
 * daemon by this registration, not by an environment variable a command can unset.
 */
export const COMMAND_LINE_REGISTRATION = 'cli';
export type IssuedRegistration = RegisteredProgram | typeof COMMAND_LINE_REGISTRATION;

export function isCommandLineRegistration(value: unknown): value is typeof COMMAND_LINE_REGISTRATION {
  return value === COMMAND_LINE_REGISTRATION;
}

interface KeptRegistration {
  readonly principalId: string;
  readonly credentialKind: string;
  readonly program: IssuedRegistration;
  readonly issuedAt: number;
  /** The registered process on this machine (utils/process-identity.ts): a question it raises is held while it runs. */
  readonly process?: string | undefined;
  /** Whether the process that proved it still runs and its connection is still open (asked at every use). */
  readonly alive: () => boolean;
}

/** At most this many registrations at once (each live program process holds one); a further one is refused, never an older one dropped. */
export const REGISTRATIONS_LIMIT = 256;

/** One record per daemon home in this process: the router that checks and the socket that issues share it. */
const byHome = new Map<string, ProgramRegistrations>();

/** This daemon's registrations (its own home's). */
export function daemonProgramRegistrations(): ProgramRegistrations {
  return ProgramRegistrations.forDaemonHome(resolveGoodVibesDaemonHome(homedir()));
}

function hashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class ProgramRegistrations {
  private readonly byHash = new Map<string, KeptRegistration>();

  /** The registrations of the daemon whose home is `daemonHome`: one record per home in this process. */
  static forDaemonHome(daemonHome: string): ProgramRegistrations {
    let kept = byHome.get(daemonHome);
    if (!kept) {
      kept = new ProgramRegistrations();
      byHome.set(daemonHome, kept);
      // The file an earlier version kept registrations in: none survives a restart now.
      rmSync(join(daemonHome, 'program-registrations.json'), { force: true });
    }
    return kept;
  }

  /** Room for one more registration. */
  hasRoom(): boolean {
    return this.byHash.size < REGISTRATIONS_LIMIT;
  }

  /**
   * A new registration for `program`, bound to this principal and credential kind and alive only while `alive` says:
   * the secret, sent once; and how to end it (when its process or connection ends).
   */
  issue(input: { readonly principalId: string; readonly credentialKind: string; readonly program: IssuedRegistration; readonly process?: string | undefined; readonly alive: () => boolean }): { readonly key: string; readonly end: () => void } {
    const key = randomBytes(32).toString('base64url');
    const hash = hashOf(key);
    this.byHash.set(hash, { principalId: input.principalId, credentialKind: input.credentialKind, program: input.program, issuedAt: Date.now(),
      ...(input.process === undefined ? {} : { process: input.process }), alive: input.alive });
    return { key, end: () => { this.byHash.delete(hash); } };
  }

  /** The program a sent secret names for this principal and credential kind while it is alive, or undefined. */
  verify(key: string | null | undefined, principalId: string | undefined, credentialKind: string | null | undefined): IssuedRegistration | undefined {
    if (!key || key.length > 256 || !principalId || !credentialKind) return undefined;
    const hash = hashOf(key);
    const kept = this.byHash.get(hash);
    if (!kept || kept.principalId !== principalId || kept.credentialKind !== credentialKind) return undefined;
    if (!kept.alive()) {
      this.byHash.delete(hash);
      return undefined;
    }
    return kept.program;
  }

  /** The process a registration was issued to (its identity), for a sent secret `verify` accepted; undefined when none was read. */
  processOf(key: string): string | undefined {
    return this.byHash.get(hashOf(key))?.process;
  }

  /** How many registrations are alive now (for words a person reads). */
  count(): number {
    return this.byHash.size;
  }
}
