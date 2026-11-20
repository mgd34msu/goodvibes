/**
 * `update.*`, launch-time self-update behavior.
 *
 * Every key read here is a platform schema row (schema-domain-update.ts),
 * including `autoUpdateAtLaunch` and `launchCheckTimeoutMs`: the loader
 * validates them, and settings search, the settings screen and `settings set`
 * all reach them. This reader applies the Agent's clamps and defaults.
 *
 * `update.auto` and `update.autoUpdateAtLaunch` are daemon settings: one value
 * for the machine's installation, in the daemon's settings file, read by the
 * daemon, the terminal app and the Agent alike (the installer's
 * --no-auto-update writes them there). The other `update.*` keys are the
 * Agent's own: its user-level file loads first and a working-directory
 * `.goodvibes/agent/settings.json` deep-merges on top.
 *
 * The reader hand-validates each field and returns a PARTIAL object holding
 * only the keys the user actually set to a well-typed value, a missing or
 * malformed block degrades to "use the built-in defaults", never a crash. The
 * defaults themselves live in the consumer (src/cli/launch-auto-update.ts):
 * the feature defaults ON for binary installs, per the recorded owner
 * directive that clients update on start, and `update.autoUpdateAtLaunch:
 * false` is the explicit, persisted off switch.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { ConfigManager } from './index.ts';

type RawRecord = Record<string, unknown>;

export interface UpdateSettings {
  /**
   * Check for a newer release at launch and install it before starting.
   * Default: true.
   *
   * Setting this false is the off switch for this install replacing its own
   * binary: it stops the launch swap, and, unless `auto` is set explicitly,
   * the while-running swap as well. It used to gate only the launch path, so an
   * install with this set to false still replaced itself about thirty seconds
   * in, under `auto`'s separate default.
   */
  readonly autoUpdateAtLaunch?: boolean;
  /** How long the launch-time version check may take before it is skipped. Defaults to 2500; clamped to [250, 30000]. */
  readonly launchCheckTimeoutMs?: number;
  /**
   * Keep checking for a newer release WHILE the agent runs, and install it at
   * an idle moment. Mirrors the daemon's `update.auto`. Default: follows
   * `autoUpdateAtLaunch`, which defaults to true, a long-running agent that
   * only updated at launch went stale across every release the person never
   * restarted for.
   *
   * Set explicitly to override: an explicit value always wins, so
   * `{ autoUpdateAtLaunch: false, auto: true }` still means "do not update at
   * launch, but do update at an idle moment while running".
   */
  readonly auto?: boolean;
  /** Minutes between periodic checks. Mirrors the daemon's `update.intervalMinutes`. Defaults to 60; clamped to [5, 1440]. */
  readonly intervalMinutes?: number;
  /** Seconds after start before the FIRST periodic check. Mirrors the daemon's `update.firstCheckSeconds`. Defaults to 30; clamped to [0, 3600]. */
  readonly firstCheckSeconds?: number;
}

const LAUNCH_CHECK_MIN_TIMEOUT_MS = 250;
const LAUNCH_CHECK_MAX_TIMEOUT_MS = 30_000;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;
const MAX_FIRST_CHECK_SECONDS = 60 * 60;

/** A number field is honored only when finite and non-negative; then clamped. */
function readClamped(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Read `update.*` from settings.json, validating and clamping the timeout. */
export function readUpdateSettings(configManager: Pick<ConfigManager, 'getRaw'>): UpdateSettings {
  const raw = configManager.getRaw() as unknown as RawRecord;
  const block = raw['update'];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {};
  const src = block as RawRecord;
  const out: {
    autoUpdateAtLaunch?: boolean;
    launchCheckTimeoutMs?: number;
    auto?: boolean;
    intervalMinutes?: number;
    firstCheckSeconds?: number;
  } = {};
  if (typeof src['autoUpdateAtLaunch'] === 'boolean') out.autoUpdateAtLaunch = src['autoUpdateAtLaunch'];
  const timeout = src['launchCheckTimeoutMs'];
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) {
    out.launchCheckTimeoutMs = Math.min(LAUNCH_CHECK_MAX_TIMEOUT_MS, Math.max(LAUNCH_CHECK_MIN_TIMEOUT_MS, Math.floor(timeout)));
  }
  if (typeof src['auto'] === 'boolean') out.auto = src['auto'];
  const interval = readClamped(src['intervalMinutes'], MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES);
  if (interval !== undefined) out.intervalMinutes = interval;
  const firstCheck = readClamped(src['firstCheckSeconds'], 0, MAX_FIRST_CHECK_SECONDS);
  if (firstCheck !== undefined) out.firstCheckSeconds = firstCheck;
  return out;
}

/**
 * Which of the self-update switches (`update.auto`, `update.autoUpdateAtLaunch`)
 * the person actually WROTE, as opposed to inherited.
 *
 * `readUpdateSettings` reads the resolved config, and the platform ships real
 * defaults for both, so a resolved `auto: true` says nothing about whether
 * anyone chose it. That distinction is load-bearing for one decision and one
 * only: whether an explicit `autoUpdateAtLaunch: false` should also stop the
 * while-running updater, or whether the person has separately asked to keep it
 * (see runtime/periodic-update.ts).
 *
 * Both switches are daemon settings (config-ownership.ts): one choice for the
 * machine's installation, kept in the daemon's settings file and read by every
 * program. So that file is the one read here. The Agent's own file and a
 * project's file cannot state them (a daemon key there is left out at load),
 * which is what keeps a project's settings file from turning the while-running
 * update back on.
 *
 * Unreadable or malformed files yield "nothing was stated", which degrades to
 * the documented switch governing both updaters, the safe direction.
 */
export function readExplicitUpdateKeys(
  configManager: {
    readonly getDaemonTierPath?: () => string | null | undefined;
  },
): ReadonlySet<string> {
  const explicit = new Set<string>();
  const path = configManager.getDaemonTierPath?.();
  if (!path || !existsSync(path)) return explicit;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const block = parsed && typeof parsed === 'object' ? (parsed as RawRecord)['update'] : undefined;
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      for (const key of Object.keys(block as RawRecord)) explicit.add(key);
    }
  } catch {
    // A file that cannot be read stated nothing.
  }
  return explicit;
}
