import { createDaemonPowerStateSource, type DaemonPowerEventHandlers, type DaemonPowerEventWatch, type PowerState } from '@goodvibes-jev/engine/platform/platform/power';
import { describePowerChip } from '../renderer/power-status.ts';

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

/** The status line's short power chip and the full note behind it (posted to the notifications when it changes). */
export interface PowerNote {
  /** Null when only a warning applies (it is a notice, never status-bar text). */
  readonly chip: string | null;
  readonly detail: string;
}

export interface PowerNoteSource {
  /** The note to show, or null when nothing is held. */
  get(): PowerNote | null;
  /** Read the daemon now (keep-awake changed here, a turn ended). */
  refresh(): void;
  stop(): void;
}

function describe(state: PowerState): PowerNote | null | undefined {
  try {
    return describePowerChip(state);
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
    get(): PowerNote | null {
      const state = daemon.current();
      const note = state ? describe(state) : undefined;
      return note !== undefined ? note : describePowerChip(deps.local());
    },
    refresh: () => daemon.refresh(),
    stop: () => daemon.stop(),
  };
}
