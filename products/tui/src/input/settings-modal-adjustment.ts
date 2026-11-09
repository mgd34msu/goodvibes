import { cycleSettingChoice, adjustedSettingValue } from '@goodvibes-jev/engine/terminal-shell/settings-behavior';
/**
 * settings-modal-adjustment, pure adjustment helpers for SettingsModal.
 *
 * These functions encapsulate the directional-adjustment operation:
 *   - adjustSelected: cycle enum/boolean/number values via left/right arrow keys
 *
 * Each function takes its dependencies as explicit arguments rather than
 * accessing class-level state directly, following the same pattern as
 * settings-modal-reset.ts and settings-modal-mutations.ts.
 */

import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { FlagEntry, McpEntry, SettingEntry } from './settings-modal-types.ts';
import { buildMcpEntries } from './settings-modal-data.ts';
import './settings-modal-behavior.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';

// ---------------------------------------------------------------------------
// adjustSelected
// ---------------------------------------------------------------------------

export interface AdjustSelectedContext {
  readonly editingMode: boolean;
  readonly currentCategory: string;
  readonly configManager: ConfigManager | null;
  readonly featureFlagManager: FeatureFlagManager | null;
  readonly mcpRegistry: McpRegistry | null;
  getSelectedFlag(): FlagEntry | null;
  getSelectedMcp(): McpEntry | null;
  getSelected(): SettingEntry | null;
  setValue(key: ConfigKey, value: unknown): void;
  setHostValue?(key: string, value: boolean): void;
  setMcpEntries(entries: McpEntry[]): void;
  setMcpAllowAllConfirmationTarget(value: string | null): void;
}

export function adjustSelected(ctx: AdjustSelectedContext, direction: 'left' | 'right', step = 1): void {
  if (ctx.editingMode) return;

  // Feature-unit headers are the real config rows for their enablement keys
  // (boolean or enum), so they fall through to the ordinary branches below,
  // a plain config write the settings bridge forwards to the gate manager.

  if (ctx.currentCategory === 'mcp') {
    const entry = ctx.getSelectedMcp();
    if (!entry || !ctx.mcpRegistry) return;
    const modes: McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];
    const nextMode = cycleSettingChoice(modes, entry.trustMode, direction);
    if (nextMode !== undefined) ctx.mcpRegistry.setServerTrustMode(entry.name, nextMode);
    ctx.setMcpEntries(buildMcpEntries(ctx.mcpRegistry));
    ctx.setMcpAllowAllConfirmationTarget(null);
    return;
  }

  const entry = ctx.getSelected();
  if (!entry || !ctx.configManager) return;
  if (entry.kind === 'host') {
    ctx.setHostValue?.(entry.setting.key, direction === 'right');
    return;
  }
  if (entry.metadataUnavailable) return;
  const { setting } = entry;

  const adjustment = adjustedSettingValue(setting, entry.currentValue, direction, step);
  if (adjustment) ctx.setValue(setting.key as ConfigKey, adjustment.value);
}
