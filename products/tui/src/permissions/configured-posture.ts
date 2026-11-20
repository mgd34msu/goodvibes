import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { presetForMode } from '@goodvibes/engine/platform/platform/gate/presets';
import { describePermissionModeInForce } from '@goodvibes/engine/platform/platform/permissions';

/** Display the same canonical preset the permission owner applies. */
export function describePermissionMode(mode: unknown): { readonly label: string; readonly detail: string } {
  const preset = presetForMode(typeof mode === 'string' ? mode : undefined);
  return { label: preset.label, detail: preset.summary };
}

/** The preset in force, read the way the gate reads it: jev-decides is ask-me while no decision model works. */
export function describeConfiguredPermissions(config: Pick<ConfigManager, 'get'>) {
  return describePermissionMode(describePermissionModeInForce(config).mode);
}
