/**
 * daemon-attach-handshake.ts, attaching to a daemon is a handshake, not a
 * pointer swap.
 *
 * ONE `/status` read carries the three things this terminal has to settle
 * before it mirrors anything to a daemon, and as a pure client there is no
 * in-process daemon handle to fold any of them from:
 *
 *  - The DAEMON's own build. Every capability here is something the daemon
 *    performs on this terminal's behalf, so a daemon below this build's floor
 *    is refused rather than adopted, otherwise a verb it does not serve
 *    surfaces as one broken feature instead of as an old daemon, and the
 *    terminal keeps running half-working against a peer it has no reason to
 *    suspect. Refused means local-only, which is a state this app already
 *    renders honestly.
 *  - The minimum CLIENT build the daemon accepts. Below it the guard latches
 *    and the continuation runner stops taking shared-session work.
 *  - Its undelivered receipts (update applied, restarted after a crash,
 *    settings migrated), read with `/status?receipts=peek` and acknowledged
 *    once parsed, so the read that takes them is the read that renders them.
 *
 * Every one of those is decided from the same response, which is why this is
 * one function and not three callers each making their own read.
 *
 * A daemon that goes away and comes back gets the handshake again, off the
 * liveness flip a caller already observes rather than a timer of this module's
 * own: for an already-adopted daemon, coming back up is what its hourly
 * self-update looks like from here, and the build that came back may not be the
 * build that left. The flip an adoption's own first refresh causes runs the
 * handshake once more too; that costs one /status GET and is the price of never
 * having to decide which online flip is "really" a reconnect.
 */

import type { HostServiceStatus } from '@/runtime/index.ts';
import { readExternalDaemonAttach } from '../daemon-attach-notices.ts';
import { ClientBuildGuard, DaemonBuildFloor } from './build-floors.ts';

function isCompatibleDaemonBand(localVersion: string, remoteVersion: string | undefined): boolean {
  const parse = (raw: string | undefined): [number, number] | null => {
    if (!raw) return null;
    const match = /^v?(\d+)\.(\d+)\./i.exec(raw.trim());
    return match ? [Number(match[1]), Number(match[2])] : null;
  };
  const local = parse(localVersion);
  const remote = parse(remoteVersion);
  if (!local || !remote) return false;
  return remote[0] === local[0] && remote[1] >= local[1];
}

export interface DaemonAttachHandshakeDeps {
  /** The forward floor's latch, fed the floor this daemon announces. */
  readonly clientBuildGuard: ClientBuildGuard;
  /** The daemon this terminal is currently pointed at. Re-read on every attach. */
  readonly readDaemonStatus: () => HostServiceStatus;
  /**
   * Write a verdict onto the status every reader already consults, so the footer
   * and `/status` report "a daemon is there and this build will not adopt it"
   * rather than claiming a working mirror. It is also called with the original
   * status when a daemon that was refused comes back new enough.
   */
  readonly recordRefusal: (status: HostServiceStatus) => void;
  /** Bring the session and memory spines up against this daemon (or take them down). */
  readonly adopt: (status: HostServiceStatus, daemonToken: string) => void;
  /** Where a daemon notice is shown to the owner. */
  readonly notify: (text: string) => void;
  /** This terminal's own floor on the daemon; defaults to the shipped one. */
  readonly daemonFloor?: string | undefined;
  /** This terminal's own SemVer version, checked against the daemon on reprobe after a boot-time incompatibility. */
  readonly localVersion?: string | undefined;
  /** Injectable `/status` read for tests. */
  readonly read?: typeof readExternalDaemonAttach | undefined;
  /**
   * Runs `run` once after `delayMs` and returns a cancel function; injectable
   * for tests. The default is an unref'd timer.
   */
  readonly schedule?: ((run: () => void, delayMs: number) => () => void) | undefined;
}

/**
 * While a daemon is refused nothing else tells this terminal it was updated:
 * adopting an `incompatible` status takes the session spine down, and with it
 * the liveness probe that would report the flip. So the handshake re-reads a
 * refused daemon itself, a bounded number of times; after that only the restart
 * verb or the next boot attaches again.
 */
const REPROBE_INTERVAL_MS = 60_000;
const REPROBE_MAX_ATTEMPTS = 60;

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export interface DaemonAttachHandshake {
  /** Run the handshake against the current daemon status, then adopt or refuse. */
  attach(daemonToken: string, fromReprobe?: boolean): Promise<void>;
  /** Feed the adopted daemon's liveness flips; a flip to online re-handshakes. */
  onLivenessTransition(online: boolean): void;
}

export function createDaemonAttachHandshake(deps: DaemonAttachHandshakeDeps): DaemonAttachHandshake {
  const daemonBuildFloor = new DaemonBuildFloor(deps.daemonFloor);
  const read = deps.read ?? readExternalDaemonAttach;
  const schedule = deps.schedule ?? defaultSchedule;
  let cancelReprobe: (() => void) | null = null;
  let reprobeAttempts = 0;
  let lastDaemonToken: string | null = null;
  // The status this module replaced with an `incompatible` one, kept so the next
  // handshake probes the real address again. Without it the refusal would be
  // permanent: the status it left behind is no longer `external`, so a daemon
  // that updated and came back would never be read again.
  let refusal: { readonly before: HostServiceStatus; readonly marked: HostServiceStatus } | null = null;
  let notifiedIncompatibleKey: string | null = null;
  // The forward floor's one line. The guard latches in the services graph,
  // where the continuation runner reads it; this is the surface that tells the
  // owner, and a verdict reached before now is held and delivered here.
  deps.clientBuildGuard.onRestartRequired((verdict) => deps.notify(verdict.message));

  const armReprobe = (): void => {
    cancelReprobe?.();
    cancelReprobe = null;
    if (refusal === null || lastDaemonToken === null || reprobeAttempts >= REPROBE_MAX_ATTEMPTS) return;
    reprobeAttempts += 1;
    cancelReprobe = schedule(() => {
      cancelReprobe = null;
      if (lastDaemonToken !== null) handshake.attach(lastDaemonToken, true).catch(() => undefined);
    }, REPROBE_INTERVAL_MS);
  };

  const handshake: DaemonAttachHandshake = {
    onLivenessTransition(online) {
      if (online && lastDaemonToken !== null) void handshake.attach(lastDaemonToken);
    },
    async attach(daemonToken, fromReprobe = false) {
      if (!fromReprobe) reprobeAttempts = 0;
      try {
        await attachOnce(daemonToken);
      } finally {
        armReprobe();
      }
    },
  };

  async function attachOnce(daemonToken: string): Promise<void> {
    {
      lastDaemonToken = daemonToken;
      let daemonStatus = deps.readDaemonStatus();
      const previous = refusal;
      const reprobing = previous !== null
        && daemonStatus.mode === 'incompatible'
        && daemonStatus.baseUrl === previous.marked.baseUrl
        && daemonStatus.reason === previous.marked.reason
        ? previous
        : null;
      if (reprobing) daemonStatus = reprobing.before;
      else refusal = null;
      // Boot-time version skew (bootstrap-services.ts) marks mode 'incompatible' before attach runs:
      // surface the refusal notice once and arm reprobe so restarting the daemon heals this session.
      if (!reprobing && daemonStatus.mode === 'incompatible' && daemonStatus.baseUrl) {
        const key = `${daemonStatus.baseUrl}|${daemonStatus.reason ?? ''}`;
        if (daemonStatus.reason && notifiedIncompatibleKey !== key) {
          notifiedIncompatibleKey = key;
          deps.notify(daemonStatus.reason);
        }
        refusal = { before: { ...daemonStatus, mode: 'external' }, marked: daemonStatus };
        deps.adopt(daemonStatus, daemonToken);
        return;
      }
      if (daemonStatus.mode !== 'external' || !daemonStatus.baseUrl) {
        deps.adopt(daemonStatus, daemonToken);
        return;
      }
      const answer = await read({
        baseUrl: daemonStatus.baseUrl,
        authToken: daemonToken,
        consumeReceipts: true,
      });
      // Nothing was read, so nothing is known, adopt as before and leave a
      // daemon that is not answering to the spine's own reachability handling.
      // Refusing on a failed read would turn one dropped request into a lost
      // mirror.
      if (!answer.answered) {
        // A daemon already refused stays refused until a read says otherwise.
        deps.adopt(reprobing ? reprobing.marked : daemonStatus, daemonToken);
        return;
      }
      const verdict = daemonBuildFloor.evaluate(answer.statusPayload, daemonStatus.baseUrl);
      const remoteVersion = typeof (answer.statusPayload as { version?: unknown } | null)?.version === 'string'
        ? (answer.statusPayload as { version: string }).version
        : undefined;
      const versionSkewed = deps.localVersion !== undefined
        && !isCompatibleDaemonBand(deps.localVersion, remoteVersion);
      if (versionSkewed) {
        const reason = reprobing?.marked.reason
          ?? `A GoodVibes daemon (version ${remoteVersion ?? 'unknown'}) is running on ${daemonStatus.baseUrl}, but this program is version ${deps.localVersion}. Restart it with goodvibes-daemon restart-service.`;
        const refused: HostServiceStatus = { ...daemonStatus, mode: 'incompatible', reason };
        refusal = { before: daemonStatus, marked: refused };
        deps.recordRefusal(refused);
        deps.adopt(refused, daemonToken);
        return;
      }
      const notice = daemonBuildFloor.noticeFor(verdict);
      if (notice) deps.notify(notice);
      // The read acknowledged these receipts at the daemon, so this is the only
      // place they can still be shown. They render before recording or adopting
      // so a throw there cannot lose them.
      for (const receipt of answer.notices) deps.notify(receipt);
      // Whether to adopt is the platform's decision, the same one the Agent reads.
      if (!verdict.adopt) {
        const refused: HostServiceStatus = { ...daemonStatus, mode: 'incompatible', reason: verdict.message };
        refusal = { before: daemonStatus, marked: refused };
        deps.recordRefusal(refused);
        deps.adopt(refused, daemonToken);
        return;
      }
      refusal = null;
      notifiedIncompatibleKey = null;
      if (reprobing) deps.recordRefusal({ ...daemonStatus, ...(remoteVersion ? { version: remoteVersion } : {}), reason: 'Existing GoodVibes daemon verified on configured host/port' });
      deps.clientBuildGuard.observeFloor(answer.clientFloor);
      deps.adopt(daemonStatus, daemonToken);
    }
  }
  return handshake;
}
