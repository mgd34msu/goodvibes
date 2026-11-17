import type { PowerState } from '@goodvibes-jev/engine/platform/platform/power';
import { describePowerStatus } from '../renderer/power-status.ts';

/**
 * The footer's power note, from the owner of keep-awake. With a daemon adopted
 * the daemon holds the host awake (its hold outlives this process), so the note
 * renders the daemon's `power.status.get`, read on an unref'd poll since the
 * adopted wire carries no power events. Without a daemon, or while the
 * daemon's answer is not in yet, the in-process manager is the truth.
 */
export interface PowerNoteSourceDeps {
  /** The in-process manager's state. */
  readonly local: () => PowerState;
  /** Whether a daemon is adopted right now (the adoption reconciler's fact). */
  readonly isAdopted: () => boolean;
  /** The daemon's `power.status.get`; null when it cannot be read. */
  readonly fetchDaemon: () => Promise<PowerState | null>;
  /** Repaint when the note changes. */
  readonly render: () => void;
  /** Poll cadence while adopted (default 5000 ms). */
  readonly pollIntervalMs?: number | undefined;
}

export interface PowerNoteSource {
  /** The note to show, or null when nothing is held. */
  get(): string | null;
  stop(): void;
}

export function createPowerNoteSource(deps: PowerNoteSourceDeps): PowerNoteSource {
  let daemonNote: string | null | undefined; // undefined: no daemon answer in hand
  let polling = false;
  const poll = async (): Promise<void> => {
    if (!deps.isAdopted()) {
      if (daemonNote !== undefined) {
        daemonNote = undefined;
        deps.render();
      }
      return;
    }
    if (polling) return;
    polling = true;
    try {
      const state = await deps.fetchDaemon().catch(() => null);
      let next: string | null | undefined;
      try {
        next = state ? describePowerStatus(state) : undefined;
      } catch {
        next = undefined; // an answer without the power fields says nothing about keep-awake
      }
      if (next !== daemonNote) {
        daemonNote = next;
        deps.render();
      }
    } finally {
      polling = false;
    }
  };
  const interval = setInterval(() => { void poll(); }, deps.pollIntervalMs ?? 5000);
  (interval as { unref?: () => void }).unref?.();
  void poll();
  return {
    get(): string | null {
      if (deps.isAdopted() && daemonNote !== undefined) return daemonNote;
      return describePowerStatus(deps.local());
    },
    stop(): void {
      clearInterval(interval);
    },
  };
}
