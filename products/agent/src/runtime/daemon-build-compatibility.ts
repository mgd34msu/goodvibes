/**
 * Daemon build compatibility, the other half of the build handshake.
 *
 * client-build-compatibility.ts is this process being judged: the daemon
 * publishes the oldest client it will let participate, and a build below that
 * floor stops taking shared-session work. This file is the reverse, and the
 * exposure it covers is real in a way that is easy to miss.
 *
 * This process talks to a daemon it did not start and cannot see, over a base
 * URL that may point at another machine. Every capability it has is something
 * the daemon performs on its behalf. When the daemon is too old to serve a verb
 * this build depends on, what an operator observes is one call returning 400 or
 * 404, which reads as a broken feature, not as an old daemon. The Agent keeps
 * running, half-working, against a peer nobody has any reason to suspect.
 *
 * So the daemon's build is checked once per attach against a floor this product
 * declares, using the `version` that `/status` has returned since the route
 * existed. The comparison is the platform's (`evaluateDaemonStatusCompatibility`);
 * what lives here is this process's state around it, the latch, and the
 * once-only notification, for the same reason the forward guard's does.
 *
 * ON THE FLOOR VALUE
 *
 * `AGENT_DAEMON_BUILD_FLOOR` is '3.1.2'. The platform is explicit that the floor
 * belongs to the consumer, not the platform: "the TUI, the agent and the web
 * UI need different daemon behaviors at different times, and a single
 * platform-wide constant would either over-refuse for one of them or under-refuse
 * for another. Each consumer passes its own and states, in its own release
 * notes, what it raised the floor for."
 *
 * The daemon shares this repository's release line. 3.1.2 is the oldest build
 * that serves every verb this Agent depends on: the hosted-session verbs its
 * conversation turns are routed through, `approvals.raise`, the conversation
 * rewind verbs and `sessions.permissionMode.set`. 3.1.1 and earlier answer
 * those with a 404 that reads as a broken feature; 3.1.2 and later serve them.
 *
 * The floor REFUSES, it does not merely warn. The verdict is set by the one
 * `/status` read on the adoption edge (`judgeForAdoption`). A daemon below the
 * floor is not adopted: the memory spine stays on its local store, the inbound
 * continuation dispatch never binds, and the connected-host resolution every
 * verb call and hosted conversation goes through (client/daemon-verbs.ts) answers
 * with the verdict's message instead of an address, so each of those paths
 * refuses with the same sentence naming both versions and none needs its own
 * check. Half-adopting an old daemon is the state this exists to prevent.
 *
 * The owner is told exactly once, naming both versions, and the number is
 * recorded in this repository's CHANGELOG and release notes because raising the
 * floor costs every operator on an older daemon that notice and a forced update.
 */

import { evaluateDaemonStatusCompatibility } from '@goodvibes-jev/engine/platform/platform/control-plane/daemon-compatibility';
import type { DaemonCompatibilityVerdict } from '@goodvibes-jev/engine/platform/platform/control-plane';

export type { DaemonCompatibilityVerdict };
export { evaluateDaemonStatusCompatibility };

/**
 * The oldest daemon build this Agent will work against, or undefined for "this
 * client is not asking for anything". See the note above before changing it.
 */
export const AGENT_DAEMON_BUILD_FLOOR: string | undefined = '3.1.2';

export interface DaemonBuildGuardOptions {
  /** The floor this client declares. Undefined means it declares none. */
  readonly floor?: string | undefined;
  /**
   * Invoked once, the first time an attached daemon is judged not adoptable
   * (too old, or no readable version), with the verdict's notice. Wiring it to
   * a visible surface is what turns "the daemon needs updating" into something
   * the owner actually sees, rather than a verb that quietly 404s.
   */
  readonly onDaemonUpdateRequired?: ((verdict: DaemonCompatibilityVerdict) => void) | undefined;
}

/**
 * The live verdict about the daemon this process is attached to.
 *
 * Set only by a `/status` body that was read. When no body could be read (the
 * daemon did not answer), the adoption gate keeps the last verdict rather than
 * clearing it, so a daemon judged too old is not adopted on a failed read.
 *
 * The latch is dropped by `reset()`, which the attach path calls when it moves
 * to a DIFFERENT daemon, a verdict about the old peer says nothing about the
 * new one, and carrying it over would report the wrong machine as stale.
 */
export class DaemonBuildGuard {
  private verdict: DaemonCompatibilityVerdict;
  private announced = false;

  constructor(private readonly options: DaemonBuildGuardOptions = {}) {
    this.verdict = this.initialVerdict();
  }

  private initialVerdict(): DaemonCompatibilityVerdict {
    return {
      status: 'ok',
      adopt: true,
      notice: null,
      message: 'No daemon build observed yet.',
      daemonVersion: undefined,
      floor: this.options.floor,
    };
  }

  /** Say a refusal once; the platform decided whether there is one. */
  private announce(verdict: DaemonCompatibilityVerdict): void {
    if (verdict.notice === null || this.announced) return;
    this.announced = true;
    this.options.onDaemonUpdateRequired?.(verdict);
  }

  /**
   * Judge a freshly-read `/status` for the ADOPTION decision.
   *
   * A daemon CAN become new enough while this process runs, that is exactly
   * what a daemon update does, so a read that positively reports a new-enough
   * build clears the finding and re-arms the notice for a future refusal.
   */
  judgeForAdoption(statusPayload: unknown, daemonLabel?: string): DaemonCompatibilityVerdict {
    const next = evaluateDaemonStatusCompatibility(statusPayload, this.options.floor, daemonLabel);
    this.verdict = next;
    if (!next.adopt) {
      this.announce(next);
      return next;
    }
    // A daemon that now meets the floor is a different situation from the one
    // that was announced, so the next refusal gets to speak again.
    this.announced = false;
    return next;
  }

  /**
   * The refusal every connected-host call answers with while the attached
   * daemon is judged not adoptable, or undefined when it may be used. A field
   * read; the verdict was settled by the adoption read.
   */
  refusal(): string | undefined {
    return this.verdict.adopt ? undefined : this.verdict.message;
  }

  /** Forget everything observed. For an attach to a different daemon. */
  reset(): void {
    this.verdict = this.initialVerdict();
    this.announced = false;
  }

  current(): DaemonCompatibilityVerdict {
    return this.verdict;
  }
}

export interface DaemonStatusConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  /** Set when this surface may not dial the daemon: nothing is read. */
  readonly unavailable?: string | undefined;
}

/**
 * Read `/status` for the daemon's build.
 *
 * Its own read rather than a field pulled off the liveness probe: that probe
 * reports reachability as a boolean and surfaces only the client-floor header,
 * so the body carrying `version` never reaches a caller. Best-effort by
 * design, an unreachable daemon yields null, which the guard reads as
 * "nothing observed" rather than as a verdict.
 */
export async function readDaemonStatusPayload(
  connection: DaemonStatusConnection,
  options: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {},
): Promise<unknown | null> {
  // A surface that may not dial the daemon (switch off, no credential bound to it) reads nothing.
  if (connection.unavailable !== undefined) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, options.timeoutMs ?? 2000);
  try {
    const response = await fetchImpl(`${connection.baseUrl}/status`, {
      signal: controller.signal,
      ...(connection.token ? { headers: { authorization: `Bearer ${connection.token}` } } : {}),
    });
    if (!response.ok) return null;
    return await response.json() as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The adoption gate. Asked on the adoption edge, before anything routes over
 * the wire, so a daemon below the floor is refused rather than half-used.
 *
 * Nothing read means nothing new: the answer is the verdict already held (adopt
 * when nothing was ever judged), and a daemon that is not answering is left to
 * the reachability handling that owns that question. Its own plain `/status`
 * read, never the receipt-consuming one, because that read has a side effect
 * and must not be what decides adoption.
 */
export function createDaemonAdoptionGate(deps: {
  readonly resolveConnection: () => DaemonStatusConnection;
  readonly readStatus: (connection: DaemonStatusConnection) => Promise<unknown | null>;
  readonly guard: Pick<DaemonBuildGuard, 'judgeForAdoption' | 'current'>;
}): () => Promise<boolean> {
  return async () => {
    const connection = deps.resolveConnection();
    const status = await deps.readStatus(connection);
    if (status === null) return deps.guard.current().adopt;
    return deps.guard.judgeForAdoption(status, connection.baseUrl).adopt;
  };
}
