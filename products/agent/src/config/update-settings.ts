/**
 * `update.*`, launch-time self-update behavior.
 *
 * Every key read here is a platform schema row (schema-domain-update.ts),
 * including `autoUpdateAtLaunch` and `launchCheckTimeoutMs`: the loader
 * validates them, and settings search, the settings screen and `settings set`
 * all reach them. The config manager applies their ranges and defaults; this
 * reader only gathers them.
 *
 * `update.auto` and `update.autoUpdateAtLaunch` are daemon settings: one value
 * for the machine's installation, in the daemon's settings file, read by the
 * daemon, the terminal app and the Agent alike (the installer's
 * --no-auto-update writes them there). The other `update.*` keys are the
 * Agent's own: its user-level file loads first and a working-directory
 * `.goodvibes/agent/settings.json` deep-merges on top.
 *
 * The feature defaults ON for binary installs, per the recorded owner
 * directive that clients update on start, and `update.autoUpdateAtLaunch:
 * false` is the explicit, persisted off switch.
 */
import type { ConfigKey, ConfigManager } from './index.ts';

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
  readonly autoUpdateAtLaunch: boolean;
  /** How long the launch-time version check may take before it is skipped. `update.launchCheckTimeoutMs`, default 2500, 250 to 30000. */
  readonly launchCheckTimeoutMs: number;
  /** How long the launch waits for its download, verification and swap before starting the installed version; the update keeps running in the background (`update.applyTimeoutMs`, default 45000, 5000 to 300000). */
  readonly applyTimeoutMs: number;
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
  readonly auto: boolean;
  /** Minutes between periodic checks. Mirrors the daemon's `update.intervalMinutes`. Default 60, 5 to 1440. */
  readonly intervalMinutes: number;
  /** Seconds after start before the FIRST periodic check. Mirrors the daemon's `update.firstCheckSeconds`. Default 30, 0 to 3600. */
  readonly firstCheckSeconds: number;
}

/** The `update.*` values in effect, as the config manager validated and defaulted them. */
export function readUpdateSettings(configManager: Pick<ConfigManager, 'get'>): UpdateSettings {
  return {
    autoUpdateAtLaunch: configManager.get('update.autoUpdateAtLaunch'),
    launchCheckTimeoutMs: configManager.get('update.launchCheckTimeoutMs'),
    applyTimeoutMs: configManager.get('update.applyTimeoutMs'),
    auto: configManager.get('update.auto'),
    intervalMinutes: configManager.get('update.intervalMinutes'),
    firstCheckSeconds: configManager.get('update.firstCheckSeconds'),
  };
}

/**
 * Whether the person stated a self-update switch (`update.auto`,
 * `update.autoUpdateAtLaunch`), as opposed to inheriting its default.
 *
 * `readUpdateSettings` reads the resolved config, and the platform ships real
 * defaults for both, so a resolved `auto: true` says nothing about whether
 * anyone chose it. That distinction is load-bearing for one decision and one
 * only: whether an explicit `autoUpdateAtLaunch: false` should also stop the
 * while-running updater, or whether the person has separately asked to keep it
 * (see runtime/periodic-update.ts).
 *
 * The settings loader is the one owner of that fact (ConfigManager.sourceOf):
 * a value it accepted from a file has that file's tier; a malformed value it
 * refused, or a key in a file that may not state it (a project file), leaves
 * the default, so a refused value can never count as a choice. No file is read here.
 */
export function updateKeyStated(
  configManager: Pick<ConfigManager, 'sourceOf'>,
  key: 'auto' | 'autoUpdateAtLaunch',
): boolean {
  return configManager.sourceOf(`update.${key}` as ConfigKey) !== 'default';
}
