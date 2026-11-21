/**
 * keep-awake-remote.ts, reading the keep-awake toggle a daemon serves.
 *
 * `power.keepAwake` is daemon-owned (config/config-ownership.ts): a surface's
 * toggle is a settings write that goes to the daemon, or with none running into
 * the daemon's settings file it reads at start, and every surface reads the one
 * value from the daemon tier it overlays. Nothing here sends the toggle; these
 * readers parse the daemon's served power state (`power.status.get`) for a
 * surface's keep-awake chip.
 */

/** The daemon's served power state (`power.status.get`). */
export const POWER_STATUS_PATH = '/api/power/status';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** What a served power state says keep-awake is doing ('off', 'held', 'held-partial', 'refused'), when it says. */
export function readServedKeepAwakeState(body: unknown): string | undefined {
  const served = isRecord(body) && isRecord(body.keepAwake) ? body.keepAwake.state : undefined;
  return typeof served === 'string' ? served : undefined;
}

/** Whether a served power state says the owner's keep-awake toggle is on; undefined when it does not say. */
export function readServedKeepAwakeEnabled(body: unknown): boolean | undefined {
  const enabled = isRecord(body) && isRecord(body.keepAwake) ? body.keepAwake.enabled : undefined;
  return typeof enabled === 'boolean' ? enabled : undefined;
}
