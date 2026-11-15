/**
 * settings-modal-daemon-writes.ts, the settings modal's half of the config
 * ownership split.
 *
 * A setting belongs to the runtime that ACTS on it. The modal writes to whichever
 * runtime that is; for a `surfaces.*` bot token, a `watchers.*` cadence or a
 * `device.*` gate that is the daemon, which reads a different file than this
 * process writes.
 *
 * Writing one of those locally is the defect this exists to end, and its shape is
 * the worst kind: the modal accepted the value, reported success, and configured
 * nothing. The setting then read back blank, so the same asymmetry ran backwards
 * and the modal reported it as unset.
 *
 * Split out of settings-modal.ts, which is at the line cap check-architecture.ts
 * enforces, and the seam is a natural one either way, matching
 * settings-modal-secrets.ts next door for the credential half.
 */
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  agentDaemonConfigClient,
  agentDaemonConfigClientInstalled,
  isDaemonOwnedConfigKey,
  routeDaemonOwnedConfigWrite,
} from '../config/daemon-config-routing.ts';

/** What the modal shows while and after a routed write. */
export interface DaemonSettingWriteReport {
  readonly ok: boolean;
  readonly message: string;
  /** True on the last report of a write (applied or refused); false while it is still in flight. */
  readonly settled?: boolean;
  /** The value the host holds for the key after an applied write. */
  readonly applied?: { readonly value: unknown };
}

/**
 * Route a setting write to the connected host when the host owns the key.
 *
 * Returns true when it took the write, the caller must then NOT write locally,
 * because two writers is exactly the problem. Returns false when the key is this
 * process's own, or when no connected-host client is installed (a one-shot CLI, a
 * unit test), which keeps the local path for a process that was never wired to
 * route rather than failing a write it cannot make.
 *
 * The modal is driven from a keystroke handler and cannot await, so the outcome
 *, including the refusal, which is the message that matters, arrives on
 * `report` a moment later.
 */
export function routeSettingWriteToConnectedHost(
  key: ConfigKey,
  value: unknown,
  report: (update: DaemonSettingWriteReport) => void,
): boolean {
  if (!agentDaemonConfigClientInstalled() || !isDaemonOwnedConfigKey(key)) return false;
  report({ ok: true, message: 'Saving on the connected host…' });
  void (async () => {
    try {
      await routeDaemonOwnedConfigWrite(key, value);
    } catch (error) {
      const message = summarizeError(error);
      logger.error('SettingsModal: the connected host refused a setting write', { key, error: message });
      report({ ok: false, settled: true, message: `Save failed: ${message}` });
      return;
    }
    // The host may coerce or clamp what it was sent, so show what it holds. If it cannot be read
    // back the write still stands; the value sent is the closest answer.
    let held = value;
    try {
      const live = await agentDaemonConfigClient()?.get(key);
      if (live !== undefined) held = live;
    } catch (error) {
      logger.warn('SettingsModal: the connected host applied a setting but it could not be read back', { key, error: summarizeError(error) });
    }
    report({
      ok: true,
      settled: true,
      message: 'Applied by the connected host; it takes effect for every client.',
      applied: { value: held },
    });
  })();
  return true;
}
