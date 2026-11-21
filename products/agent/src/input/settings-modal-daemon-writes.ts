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
import type { ConfigKey } from '@goodvibes/engine/platform/platform/config';
import type { DaemonConfigClient } from '@goodvibes/engine/platform/platform/runtime/client';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import {
  agentDaemonConfigClient,
  agentDaemonConfigClientRevision,
  isDaemonOwnedConfigKey,
} from '../config/daemon-config-routing.ts';

/**
 * The connected host a value was chosen for: the installed client (one host's
 * verb caller) and its installation revision. A follow-up write sent after the
 * modal closed goes to this host or nowhere, never to a host installed since.
 */
export interface ConnectedHostTarget {
  readonly client: DaemonConfigClient;
  readonly revision: number;
}

/** The host that owns `key` now, or null when the key is this process's own or no host client is installed. */
export function captureConnectedHostTarget(key: ConfigKey): ConnectedHostTarget | null {
  const client = agentDaemonConfigClient();
  if (!client || !isDaemonOwnedConfigKey(key) || !client.ownsKey(key)) return null;
  return { client, revision: agentDaemonConfigClientRevision() };
}

/**
 * The value a reset writes: the stored value is removed where it is kept (here
 * or on the connected host), so the key reads as its default and follows a
 * later change of that default, instead of being saved as an explicit choice.
 */
export const RESET_TO_DEFAULT: unique symbol = Symbol('reset-to-default');

/** What the modal shows while and after a routed write. */
export interface DaemonSettingWriteReport {
  readonly ok: boolean;
  readonly message: string;
  /** True on the last report of a write (applied or refused); false while it is still in flight. */
  readonly settled?: boolean;
  /** The value the host holds for the key after an applied write. */
  readonly applied?: { readonly value: unknown };
  /** The write was applied but the host's value could not be read back: what it holds is unknown. */
  readonly heldUnknown?: true;
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
  target: ConnectedHostTarget | null = captureConnectedHostTarget(key),
): boolean {
  if (!target) return false;
  // A follow-up chosen for one host is never sent to another installed since (a switch of host, or a re-composed runtime).
  if (agentDaemonConfigClientRevision() !== target.revision || agentDaemonConfigClient() !== target.client) {
    logger.warn('SettingsModal: a setting chosen for one connected host was not sent, because the connected host changed', { key });
    report({ ok: false, settled: true, message: `Not saved: ${key} was chosen for the host this window was connected to, and the connected host changed since, so it was not sent to the new one. Set it again if it is still wanted.` });
    return true;
  }
  report({ ok: true, message: 'Saving on the connected host…' });
  void (async () => {
    try {
      if (value !== RESET_TO_DEFAULT) await target.client.set(key, value);
      else if (target.client.reset) await target.client.reset(key);
      else throw new Error('the connected host cannot reset a setting to its default (it is older than this Agent); set the value instead');
    } catch (error) {
      const message = summarizeError(error);
      // A loosening change made with a token minted for automation is put to the owner, not refused.
      if ((error as { readonly code?: unknown } | null)?.code === 'OWNER_APPROVAL_PENDING') {
        report({ ok: false, settled: true, message: `Waiting for the owner's approval: nothing has changed yet. ${message}` });
        return;
      }
      logger.error('SettingsModal: the connected host refused a setting write', { key, error: message });
      report({ ok: false, settled: true, message: `Save failed: ${message}` });
      return;
    }
    // The host may coerce or clamp what it was sent, so show what it holds, read from the same host.
    // If it cannot be read back the write still stands, and what the host holds is unknown: never the value sent.
    let held: unknown;
    try {
      held = await target.client.get(key);
    } catch (error) {
      logger.warn('SettingsModal: the connected host applied a setting but it could not be read back', { key, error: summarizeError(error) });
    }
    report(held === undefined
      ? { ok: true, settled: true, heldUnknown: true, message: 'Applied by the connected host, but the value it now holds could not be read back (held value unknown).' }
      : { ok: true, settled: true, message: 'Applied by the connected host; it takes effect for every client.', applied: { value: held } });
  })();
  return true;
}
