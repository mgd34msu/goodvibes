import { createDaemonPowerStateSource, type DaemonPowerEventHandlers, type DaemonPowerEventWatch, type PowerState } from '@goodvibes-jev/engine/platform/platform/power';
import { describePowerStatus } from '../renderer/power-status.ts';

/**
 * The footer's power note, from the owner of keep-awake. With a daemon adopted
 * the daemon holds the host awake (its hold outlives this process), so the note
 * renders the daemon's state, kept by the engine's one daemon power source
 * (platform/power/daemon-power-source.ts: the daemon's power events while its
 * stream is open, a short poll only while it is not). Without a daemon, or
 * while the daemon's answer is not in yet, the in-process manager is the truth.
 */
export interface PowerNoteSourceDeps {
  /** The in-process manager's state. */
  readonly local: () => PowerState;
  /** Whether a daemon is adopted right now (the adoption reconciler's fact). */
  readonly isAdopted: () => boolean;
  /** The daemon's `power.status.get`; null when it cannot be read. */
  readonly fetchDaemon: () => Promise<PowerState | null>;
  /** The daemon's power event stream; without it the note polls. */
  readonly watchEvents?: ((handlers: DaemonPowerEventHandlers) => Promise<DaemonPowerEventWatch | null>) | undefined;
  /** Repaint when the note changes. */
  readonly render: () => void;
}

export interface PowerNoteSource {
  /** The note to show, or null when nothing is held. */
  get(): string | null;
  /** Read the daemon now (keep-awake changed here, a turn ended). */
  refresh(): void;
  stop(): void;
}

function describe(state: PowerState): string | null | undefined {
  try {
    return describePowerStatus(state);
  } catch {
    return undefined; // an answer without the power fields says nothing about keep-awake
  }
}

export function createPowerNoteSource(deps: PowerNoteSourceDeps): PowerNoteSource {
  const daemon = createDaemonPowerStateSource({
    isAdopted: deps.isAdopted,
    fetchDaemon: deps.fetchDaemon,
    ...(deps.watchEvents ? { watchEvents: deps.watchEvents } : {}),
    onChange: deps.render,
  });
  return {
    get(): string | null {
      const state = daemon.current();
      const note = state ? describe(state) : undefined;
      return note !== undefined ? note : describePowerStatus(deps.local());
    },
    refresh: () => daemon.refresh(),
    stop: () => daemon.stop(),
  };
}
