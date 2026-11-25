/**
 * cli-config-overrides.ts, applying `--config key=value`, `--enable`/
 * `--disable`, `--hostname`/`--port`, and a front-end's own launch-time
 * settings defaults onto a live ConfigManager.
 */
import type { ConfigKey, ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '@goodvibes/engine/platform/platform/runtime/feature-announcements';
import type { NoticeLevel } from '@goodvibes/engine/platform/platform/core';
import { featureEnablementWrite, getFeatureSetting } from './cli-feature-settings.js';
import { FEATURE_SETTINGS } from '@goodvibes/engine/platform/platform/runtime/feature-flags/feature-settings';
import { TERMINAL_PROGRAM_DEFAULTS } from '@goodvibes/engine/platform/platform/runtime/program-host-settings';
import type { GoodVibesCliCommand, GoodVibesCliFlags } from './cli-types.js';
import { RUNTIME_ENDPOINT_CONFIG_KEYS, hostModeForHostname, type RuntimeEndpointId } from '@goodvibes/engine/platform/platform/support/service-posture';
import type { ModeManager, PrintLevelRouter } from '@goodvibes/engine/platform/platform/state';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/**
 * Read a settings value as a command line writes it.
 *
 * Two entry points need this and must agree: `--config key=value`, which
 * arrives as one string and is split here, and a `config set <key> <value>`
 * command, which arrives with the halves already apart. If they coerce
 * differently then `--config x=false` and `config set x false` write different
 * things into the same key, which is the sort of divergence nobody notices
 * until a boolean setting is mysteriously the string "false".
 *
 * The order is deliberate: JSON first, so `[1,2]`, `{"a":1}`, `"3"` and `null`
 * all mean what they look like; then the three bare literals a shell user
 * actually types (`true`, `false`, a number); then the raw string, returned
 * un-trimmed because trailing space can be significant in a string value.
 */
export function parseConfigValueText(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return value;
  }
}

/** Register a frontend default against the manager's last accepted persisted view. */
export function applyRuntimeConfigDefault(configManager: ConfigManager, key: ConfigKey, defaultValue: unknown): void {
  configManager.setRuntimeDefault(key, defaultValue as never);
}

/**
 * Every front-end-side config default applied at startup, in one place.
 * Show token speed ON (the platform schema default is false), and system and
 * operational messages in the transcript: the schema's `panel` default sends
 * them to the Notifications history only in this product.
 * The manager applies these below accepted persisted settings and invocation
 * overrides, independent of registration order. No disk read or write.
 */
export function applyTerminalRuntimeConfigDefaults(configManager: ConfigManager): void {
  // One list (platform runtime/program-host-settings.ts), so the daemon reading a program's settings reads these too.
  for (const [key, value] of TERMINAL_PROGRAM_DEFAULTS) applyRuntimeConfigDefault(configManager, key as ConfigKey, value);
}

/**
 * The settings notices this process has put in front of the person, by their
 * one line (describeIngestionNotice). A daemon's receipt for the same file and
 * key is written by the same formatter, so the app's own notice and the
 * attached daemon's are recognised as one and shown once.
 */
const shownSettingsNotices = new Set<string>();

/** True the first time `line` is offered in this process; false when it was already shown. */
export function firstShowingOfSettingsNotice(line: string): boolean {
  if (shownSettingsNotices.has(line)) return false;
  shownSettingsNotices.add(line);
  return true;
}

/**
 * Shows what the app's settings loads said for the first time on this machine
 * (ConfigManager.onSettingsAnnouncement): a setting it could not read as
 * written, settings an earlier version left that were carried forward. Each is
 * an announce-once receipt, so the next start says nothing about the same
 * file and key; the receipt is acknowledged here, so an attached daemon does
 * not deliver it a second time. A skipped or held setting is a warning; a
 * carried-forward one is information. Returns the unsubscribe function.
 */
export function announceSettingsIngestionNotices(
  configManager: Pick<ConfigManager, 'onSettingsAnnouncement' | 'getControlPlaneConfigDir'>,
  show: (line: string, level: NoticeLevel) => void,
): () => void {
  const store = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));
  return configManager.onSettingsAnnouncement(({ id, text }) => {
    store.acknowledge(new Set([id]));
    if (firstShowingOfSettingsNotice(text)) show(text, id.startsWith('carried-forward:') ? 'info' : 'warning');
  });
}

/**
 * Keeps the live mode manager, and the notification router when the app has
 * one, on the one print-less setting `behavior.hitlMode`: applied now and on
 * every change, whoever made it (/mode, the settings modal, the state tool,
 * the web UI). Unset or unrecognized values (and `off`) leave the default.
 * Returns the unsubscribe function.
 */
export function applyConfiguredHitlMode(
  configManager: ConfigManager,
  modeManager: Pick<ModeManager, 'setHITLMode' | 'attachRouter'>,
  router?: PrintLevelRouter,
): () => void {
  const apply = (): void => {
    const hitlMode = configManager.get('behavior.hitlMode');
    try {
      if (hitlMode === 'quiet' || hitlMode === 'balanced' || hitlMode === 'operator') modeManager.setHITLMode(hitlMode);
    } catch (error) {
      logger.warn('The print level could not be applied', { hitlMode, error: summarizeError(error) });
    }
  };
  apply();
  // The mode manager re-applies itself to the router after every change, /mode set-domain included.
  const detach = router ? modeManager.attachRouter(router) : () => {};
  const unsubscribe = configManager.subscribe('behavior.hitlMode', apply);
  return () => { unsubscribe(); detach(); };
}

export function applyRuntimeConfigValue(configManager: ConfigManager, key: ConfigKey, value: unknown): void {
  configManager.setRuntimeOverride(key, value as never);
}

export function applyRuntimeConfigOverrides(
  configManager: ConfigManager,
  overrides: readonly string[],
): readonly string[] {
  const errors: string[] = [];
  for (const override of overrides) {
    const index = override.indexOf('=');
    if (index <= 0) {
      errors.push('Invalid --config override. Expected key=value.');
      continue;
    }
    const key = override.slice(0, index) as ConfigKey;
    const rawValue = override.slice(index + 1);
    try {
      applyRuntimeConfigValue(configManager, key, parseConfigValueText(rawValue));
    } catch (error) {
      errors.push(error instanceof Error ? `Invalid --config override: ${error.message}` : 'Invalid --config override.');
    }
  }
  return errors;
}

/**
 * Session-only feature overrides (--enable / --disable).
 * Each feature is switched through its real domain settings key (e.g.
 * sandbox.enabled, behavior.compactionStrategy) in the runtime config layer;
 * features without an off position (constant capabilities on non-boolean
 * keys) and unknown ids are reported as errors rather than silently ignored.
 */
export function applyRuntimeFeatureFlagOverrides(
  configManager: ConfigManager,
  options: {
    readonly enableFeatures: readonly string[];
    readonly disableFeatures: readonly string[];
  },
): readonly string[] {
  if (options.enableFeatures.length === 0 && options.disableFeatures.length === 0) return [];
  const errors: string[] = [];
  const apply = (feature: string, enabled: boolean, flagName: string): void => {
    const write = featureEnablementWrite(feature, enabled);
    if (!write) {
      errors.push(getFeatureSetting(feature)
        ? `${flagName} ${feature}: this capability has no ${enabled ? 'on' : 'off'} switch (its domain settings govern it directly).`
        : `${flagName} ${feature}: unknown feature id. The value is a feature id, not a settings key. Known ids: ${FEATURE_SETTINGS.map((entry) => entry.id).join(', ')}.`);
      return;
    }
    try { applyRuntimeConfigValue(configManager, write.key, write.value); }
    catch (error) { errors.push(error instanceof Error ? `${flagName}: ${error.message}` : `Invalid ${flagName}.`); }
  };
  for (const feature of options.enableFeatures) apply(feature, true, '--enable');
  for (const feature of options.disableFeatures) apply(feature, false, '--disable');
  return errors;
}

export function applyRuntimeEndpointFlagOverrides(
  configManager: ConfigManager,
  endpoint: RuntimeEndpointId,
  flags: Pick<GoodVibesCliFlags, 'hostname' | 'port'>,
): readonly string[] {
  const keys = RUNTIME_ENDPOINT_CONFIG_KEYS[endpoint];
  const errors: string[] = [];

  if (flags.hostname !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.hostMode, hostModeForHostname(flags.hostname));
      applyRuntimeConfigValue(configManager, keys.host, flags.hostname);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --hostname: ${error.message}`
        : 'Invalid --hostname.');
    }
  }

  if (flags.port !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.port, flags.port);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --port: ${error.message}`
        : 'Invalid --port.');
    }
  }

  return errors;
}

export function applyRuntimeCommandEndpointFlagOverrides(
  configManager: ConfigManager,
  command: GoodVibesCliCommand,
  flags: Pick<GoodVibesCliFlags, 'hostname' | 'port'>,
): readonly string[] {
  if (flags.hostname === undefined && flags.port === undefined) return [];
  if (command === 'web') return applyRuntimeEndpointFlagOverrides(configManager, 'web', flags);
  if (command === 'listener') return applyRuntimeEndpointFlagOverrides(configManager, 'httpListener', flags);
  if (command === 'control-plane' || command === 'pair' || command === 'serve') {
    return applyRuntimeEndpointFlagOverrides(configManager, 'controlPlane', flags);
  }
  return [];
}
