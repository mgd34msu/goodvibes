/**
 * config-client.ts, reading and writing the settings the DAEMON owns.
 *
 * ── The split, and why it is not "all config goes over the wire" ───────────
 *
 * A config key belongs to the runtime that ACTS on it (config-ownership.ts is
 * the authority, and this module never keeps a second copy of its lists). Two
 * scopes matter here:
 *
 * - DAEMON-OWNED (`surfaces.*`, `controlPlane.*`, `watchers.*`, `device.*`,
 *   `automation.*`, `atRest.*`, `payments.*`, `voice.local.*`, …). The daemon
 *   executes these unattended. When a surface hosted the daemon, writing them to
 *   that surface's own settings file happened to work. It does not anymore: a
 *   Telegram bot token saved there would land in the surface's own settings
 *   file, the daemon would never read it, and the save would report success
 *   while configuring nothing. These go over `config.set` and come back over
 *   `config.get` / `settings.snapshot`.
 *
 * - SURFACE-OWNED (rendering, theme, transcript display, keybindings, and the
 *   `daemon.*` / `service.*` switches that say whether THIS installation runs a
 *   daemon at all). These stay local, in the surface's own file, read and
 *   written by the in-process ConfigManager exactly as before. Sending them to
 *   the daemon would make one machine's theme everyone's theme.
 *
 * ── Degrading honestly ─────────────────────────────────────────────────────
 *
 * With no reachable daemon a daemon-owned WRITE fails, loudly, with the
 * refusal reason, it does not fall back to writing the local file. A silent
 * local write is the exact failure this split exists to end: it looks like it
 * worked and changes nothing. A daemon-owned READ falls back to the local
 * value, because a stale-but-real number renders better than a blank field and
 * reads were always allowed to be optimistic.
 */
import { isDaemonOwnedConfigKey } from '../../config/index.js';
import { logger, summarizeError } from '../../utils/index.js';
import { pressInvokeOptions, type DaemonVerbCaller } from './daemon-verbs.js';
import type { DaemonWritePress } from '../../config/manager.js';
import {
  applyRemoteSettingsPrecondition, assertRemoteSettingsPrecondition, inspectRemoteSettingsPrecondition,
  type RemoteSettingsPrecondition, type RemoteSettingsPreconditionFacts, type RemoteSettingsReceipt,
  type SettingsPreconditionRequest,
} from '../../config/settings-precondition-client.js';

/**
 * A write an older daemon put to the owner instead of applying (`202` `OWNER_APPROVAL_PENDING`) is not written: said as
 * that, so the caller restores the value it showed and never reports it saved. This daemon sends none (a loosening from any
 * credential of the user is made at once). Shared with the credentials client.
 */
export function throwIfPutToOwner(answer: unknown, what: string): void {
  if (answer === null || typeof answer !== 'object') return;
  const held = answer as { readonly code?: unknown; readonly approvalId?: unknown };
  if (held.code !== 'OWNER_APPROVAL_PENDING') return;
  throw new Error(`${what} was not changed yet: it is waiting for the owner's answer in Waiting for you (approval ${String(held.approvalId ?? '')}); it applies when the owner approves it.`);
}

/** This is a deterministic owner capability, not an admission grant. */
export interface PreparedDaemonSettingsClient {
  /** `press`: who decided the write (the person's press, the program's gate), sent with the capture and its apply. */
  capture(request: SettingsPreconditionRequest, press?: DaemonWritePress): Promise<RemoteSettingsPrecondition>;
  inspect(handle: RemoteSettingsPrecondition): RemoteSettingsPreconditionFacts;
  assertCurrent(handle: RemoteSettingsPrecondition): void;
  /** The receipt, with the daemon's or transport's refusal (`failure`) and `receiptUnreadable` when the answer explains itself. */
  apply(handle: RemoteSettingsPrecondition): Promise<RemoteSettingsReceipt>;
}

/** Re-exported so call sites classify a key through one import, not two. */
export { isDaemonOwnedConfigKey };

export interface DaemonConfigClient {
  /** Absent on old/unbound transports; callers must fail closed, never fall back. */
  readonly preparedSettings?: PreparedDaemonSettingsClient;
  /** True when this key's value lives in the daemon's own settings tier. */
  ownsKey(key: string): boolean;
  /** Whether the daemon can take a write now (no request is made). */
  reachable(): boolean;
  /**
   * Whether that daemon runs on this machine, so its settings file is this
   * machine's file (no request is made). False for a connected host on another
   * machine: its settings are never written or read here.
   */
  thisMachine(): boolean;
  /**
   * Write a daemon-owned key. Rejects (never falls back to a local write) when
   * no daemon is reachable, a write that configures nothing must not report
   * success.
   */
  set(key: string, value: unknown, press?: DaemonWritePress): Promise<void>;
  /**
   * Write several daemon-owned keys as one update (`config.setMany`): the
   * daemon admits every entry before it writes any, so a refusal leaves all of
   * them as they were. Rejects, like `set`, when no daemon is reachable.
   * `press`: who decided the write, sent with it (config/manager.ts `DaemonWritePress`).
   */
  setMany(entries: readonly { readonly key: string; readonly value: unknown }[], press?: DaemonWritePress): Promise<void>;
  /**
   * Remove a daemon-owned key's explicit value so it reads as its default again
   * and follows later default changes. Absent on a client built before `config.reset`.
   */
  reset?(key: string, press?: DaemonWritePress): Promise<void>;
  /** Read a daemon-owned key; `undefined` when the daemon could not answer. */
  get(key: string): Promise<unknown>;
  /** The daemon's whole resolved config snapshot, for a settings view that opens cold. */
  snapshot(): Promise<Record<string, unknown> | null>;
}

/**
 * Walk a dotted config path through a nested snapshot.
 *
 * `config.get` returns the whole RESOLVED config tree, it takes no key. That
 * is the right shape for the daemon (one read answers a settings view) and the
 * wrong shape for a single-key read, so the walk happens here rather than in
 * every caller that wanted one value.
 */
function readDottedPath(snapshot: Record<string, unknown> | null, key: string): unknown {
  let cursor: unknown = snapshot;
  for (const segment of key.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function createDaemonConfigClient(verbs: DaemonVerbCaller): DaemonConfigClient {
  const capture = verbs.captureSettingsPrecondition?.bind(verbs);
  const handles = new WeakSet<RemoteSettingsPrecondition>();
  const assertCurrent = (handle: RemoteSettingsPrecondition): void => {
    if (!handles.has(handle)) throw new Error('Settings owner precondition unavailable: this capture was not issued by this client or is no longer held. Nothing was applied; capture the setting again.');
    assertRemoteSettingsPrecondition(handle);
  };
  const preparedSettings: PreparedDaemonSettingsClient | undefined = capture ? Object.freeze({
    capture: async (request: SettingsPreconditionRequest, press?: DaemonWritePress) => {
      if (!isDaemonOwnedConfigKey(request.key)) throw new Error('Setting is not owned by the connected daemon.');
      const handle = await capture(request, press); handles.add(handle); return handle;
    },
    inspect: (handle: RemoteSettingsPrecondition) => {
      if (!handles.has(handle)) throw new Error('Settings owner precondition unavailable: this capture was not issued by this client or is no longer held. Nothing was applied; capture the setting again.');
      return inspectRemoteSettingsPrecondition(handle);
    },
    assertCurrent,
    apply: async (handle: RemoteSettingsPrecondition) => { assertCurrent(handle); return await applyRemoteSettingsPrecondition(handle); },
  }) : undefined;
  return {
    ...(preparedSettings ? { preparedSettings } : {}),
    ownsKey: (key) => isDaemonOwnedConfigKey(key),
    reachable: () => verbs.probe().available,
    thisMachine: () => verbs.probe().thisMachine !== false,

    set: async (key, value, press) => {
      const probe = verbs.probe();
      if (!probe.available) {
        throw new Error(`'${key}' is a daemon-owned setting and ${probe.reason}`);
      }
      // The route takes a body envelope, not a flat pair. Who decided it goes with it.
      throwIfPutToOwner(await verbs.invoke('config.set', { key, value }, pressInvokeOptions(press)), key);
    },

    setMany: async (entries, press) => {
      const probe = verbs.probe();
      if (!probe.available) {
        throw new Error(`'${entries.map(entry => entry.key).join(', ')}' ${entries.length === 1 ? 'is a daemon-owned setting' : 'are daemon-owned settings'} and ${probe.reason}`);
      }
      throwIfPutToOwner(await verbs.invoke('config.setMany', { entries: entries.map(({ key, value }) => ({ key, value })) }, pressInvokeOptions(press)), entries.map(entry => entry.key).join(', '));
    },

    reset: async (key, press) => {
      const probe = verbs.probe();
      if (!probe.available) {
        throw new Error(`'${key}' is a daemon-owned setting and ${probe.reason}`);
      }
      throwIfPutToOwner(await verbs.invoke('config.reset', { key }, pressInvokeOptions(press)), key);
    },

    get: async (key) => {
      try {
        // `config.get` takes no key: it answers with the whole resolved tree.
        const snapshot = await verbs.invoke<Record<string, unknown>>('config.get', {});
        return readDottedPath(snapshot ?? null, key);
      } catch (error) {
        logger.debug('[config] reading a daemon-owned key failed; showing the local value', {
          key,
          error: summarizeError(error),
        });
        return undefined;
      }
    },

    snapshot: async () => {
      try {
        return await verbs.invoke<Record<string, unknown>>('config.get', {}) ?? null;
      } catch (error) {
        logger.debug('[config] the daemon config snapshot was not available', { error: summarizeError(error) });
        return null;
      }
    },
  };
}
