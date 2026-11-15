/**
 * settings-modal-commit.ts, commitEdit(), extracted out of the SettingsModal
 * class body so the class file can stay under the repo's architecture
 * line-count gate without trimming arbitrary lines to clear the number.
 *
 * Same dependency-injection shape as settings-modal-activation.ts /
 * settings-modal-adjustment.ts / settings-modal-reset.ts: explicit getters
 * and setter callbacks instead of a bound `this`, so the logic is
 * unit-testable without a live SettingsModal instance and the class method
 * stays a thin delegator.
 */

import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';
import { isSecretConfigKey } from '../config/secret-config.ts';
import { setSecretBackedSettingValue, type SettingsSecretsManager } from './settings-modal-secrets.ts';
import { parseNumberEditBuffer } from './settings-modal-behavior.ts';
import { buildMcpEntries } from './settings-modal-data.ts';
import { isWorktreeSetupListConfigKey, parseWorktreeSetupListInput } from './worktree-setup-config.ts';
import { isSandboxExecListConfigKey, parseSandboxExecListInput } from './sandbox-exec-config.ts';
import { isExecEnvScrubAllowlistConfigKey, parseExecEnvScrubAllowlistInput } from './exec-env-scrub-config.ts';
import type { SettingsDaemonCredentialWriter } from './settings-modal-secrets.ts';
import type { McpEntry, SettingEntry } from './settings-modal-types.ts';

export interface CommitEditContext {
  readonly editingMode: boolean;
  readonly currentCategory: string;
  readonly editBuffer: string;
  readonly configManager: ConfigManager | null;
  readonly secretsManager: SettingsSecretsManager | null;
  /**
   * The daemon's credential write, when a daemon is adopted. A daemon-scoped
   * credential must land where the daemon reads it, not in this surface's own
   * tree, see settings-modal-secrets.ts.
   */
  readonly daemonCredentials?: SettingsDaemonCredentialWriter | null;
  /** Renders a refused credential write; without it a failure would be silent. */
  readonly reportError?: ((message: string) => void) | undefined;
  readonly mcpRegistry: McpRegistry | null;
  readonly mcpAllowAllConfirmationTarget: string | null;
  getSelectedMcp(): McpEntry | null;
  getSelected(): SettingEntry | null;
  setValue(key: ConfigKey, value: unknown): boolean | void;
  /** Tells the owner why an edit was rejected; without it the typed value just disappears. */
  rejectEdit?(message: string): void;
  /** Captured owner: completion must never target a subsequently reopened modal. */
  setSecretConfigValue?(key: ConfigKey, value: unknown): void | Promise<void>;
  trackSecretWrite?(write: Promise<boolean>): void;
  setEditingMode(value: boolean): void;
  setEditBuffer(value: string): void;
  setMcpEntries(entries: McpEntry[]): void;
  setMcpAllowAllConfirmationTarget(value: string | null): void;
}

/**
 * Commit the current editBuffer to the config. Returns true when accepted,
 * false if validation failed (the caller always clears editingMode/editBuffer
 * regardless, a failed commit never leaves stale edit state behind).
 */
export function commitEditValue(ctx: CommitEditContext): boolean {
  if (!ctx.editingMode) return false;

  if (ctx.currentCategory === 'mcp') {
    const entry = ctx.getSelectedMcp();
    if (!entry || !ctx.mcpRegistry) return false;
    if (ctx.mcpAllowAllConfirmationTarget) {
      const expected = `ALLOW ALL ${ctx.mcpAllowAllConfirmationTarget}`;
      if (ctx.editBuffer.trim() !== expected) {
        ctx.rejectEdit?.(`Type exactly "${expected}" to allow all; the trust mode was not changed.`);
        return false;
      }
      ctx.mcpRegistry.setServerTrustMode(entry.name, 'allow-all');
      ctx.setMcpEntries(buildMcpEntries(ctx.mcpRegistry));
      ctx.setEditingMode(false);
      ctx.setEditBuffer('');
      ctx.setMcpAllowAllConfirmationTarget(null);
      return true;
    }

    const nextMode = ctx.editBuffer.trim() as McpEntry['trustMode'];
    const validModes: McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];
    if (!validModes.includes(nextMode)) {
      ctx.rejectEdit?.(`"${ctx.editBuffer.trim()}" is not a trust mode. Allowed: ${validModes.join(', ')}. The mode was not changed.`);
      ctx.setEditingMode(false);
      ctx.setEditBuffer('');
      ctx.setMcpAllowAllConfirmationTarget(null);
      return false;
    }
    if (nextMode === 'allow-all' && entry.trustMode !== 'allow-all') {
      ctx.setMcpAllowAllConfirmationTarget(entry.name);
      ctx.setEditBuffer('');
      return false;
    }
    ctx.mcpRegistry.setServerTrustMode(entry.name, nextMode);
    ctx.setMcpEntries(buildMcpEntries(ctx.mcpRegistry));
    ctx.setEditingMode(false);
    ctx.setEditBuffer('');
    ctx.setMcpAllowAllConfirmationTarget(null);
    return true;
  }

  const entry = ctx.getSelected();
  if (!entry || !ctx.configManager) return false;

  if (entry.kind === 'host' || entry.metadataUnavailable) return false;
  const { setting } = entry;
  let parsed: unknown = ctx.editBuffer;

  if (setting.type === 'number') {
    parsed = parseNumberEditBuffer(ctx.editBuffer);
    if (parsed === null) {
      ctx.rejectEdit?.(`"${ctx.editBuffer}" is not a number; ${setting.key} was not changed.`);
      ctx.setEditingMode(false);
      ctx.setEditBuffer('');
      return false;
    }
  }

  if (setting.type === 'object') {
    // Object-typed keys (e.g. pricing.modelPrices) edit as JSON; the
    // schema's validate() below still rules on the parsed shape.
    try {
      parsed = JSON.parse(ctx.editBuffer);
    } catch {
      ctx.rejectEdit?.(`That is not valid JSON; ${setting.key} was not changed.`);
      ctx.setEditingMode(false);
      ctx.setEditBuffer('');
      return false;
    }
  }

  if (setting.validate && !setting.validate(parsed)) {
    ctx.rejectEdit?.(`"${ctx.editBuffer}" is not accepted for ${setting.key}${setting.validationHint ? ` (${setting.validationHint})` : ''}; it was not changed.`);
    ctx.setEditingMode(false);
    ctx.setEditBuffer('');
    return false;
  }

  if (isWorktreeSetupListConfigKey(setting.key)) {
    // Comma-separated display/edit convention for the array-backed
    // worktree.setup.* keys, see worktree-setup-config.ts.
    ctx.setValue(setting.key, parseWorktreeSetupListInput(ctx.editBuffer));
  } else if (isSandboxExecListConfigKey(setting.key)) {
    // Same comma-separated convention for the array-backed
    // sandbox.egressAllowlist / sandbox.workspaceWritable keys, see
    // sandbox-exec-config.ts.
    ctx.setValue(setting.key, parseSandboxExecListInput(ctx.editBuffer));
  } else if (isExecEnvScrubAllowlistConfigKey(setting.key)) {
    // Same comma-separated convention for permissions.execEnvScrubAllowlist
    //, see exec-env-scrub-config.ts.
    ctx.setValue(setting.key, parseExecEnvScrubAllowlistInput(ctx.editBuffer));
  } else if (setting.type === 'string' && isSecretConfigKey(setting.key)) {
    const write = setSecretBackedSettingValue({
      key: setting.key,
      value: String(parsed ?? ''),
      configManager: ctx.configManager,
      secretsManager: ctx.secretsManager,
      daemonCredentials: ctx.daemonCredentials ?? null,
      setConfigValue: (key, value) => {
        if (ctx.setSecretConfigValue) return ctx.setSecretConfigValue(key, value);
        // A refused write must reach the secret-write rollback instead of reading as saved.
        if (ctx.setValue(key, value) === false) throw new Error(`${key} was not changed.`);
        return undefined;
      },
      ...(ctx.reportError ? { onError: ctx.reportError } : {}),
    });
    ctx.trackSecretWrite?.(write);
  } else {
    ctx.setValue(setting.key as ConfigKey, parsed);
  }
  ctx.setEditingMode(false);
  ctx.setEditBuffer('');
  return true;
}
