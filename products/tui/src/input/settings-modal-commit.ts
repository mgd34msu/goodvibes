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
import { parseNumberEditBuffer } from '@goodvibes-jev/engine/terminal-shell/settings-behavior';
import { keepMcpToolRuleFromSettings, keepMcpTrustModeFromSettings, parseMcpToolRuleEdit } from '@goodvibes-jev/engine/terminal-shell/settings-mcp-entries';
import { parseListSettingEdit } from './settings-modal-lists.ts';
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
  /** Shows the outcome of a per-tool rule once it is written and applied, with the refreshed rows. */
  reportMcpToolRule?(message: string, entries: McpEntry[]): void;
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
      // Applied now and kept in the server's entry of the owner's global MCP config.
      keepMcpTrustModeFromSettings(ctx.mcpRegistry, entry.name, 'allow-all', (message, entries) => {
        if (ctx.reportMcpToolRule) ctx.reportMcpToolRule(message, entries); else ctx.setMcpEntries(entries);
      });
      ctx.setEditingMode(false);
      ctx.setEditBuffer('');
      ctx.setMcpAllowAllConfirmationTarget(null);
      return true;
    }

    // `deny <tool>`, `allow <tool>` or `clear <tool>`: a per-tool rule kept in the server's MCP config (clear also lifts this session's denial). This screen is the owner's own.
    const toolEdit = parseMcpToolRuleEdit(ctx.editBuffer);
    if (toolEdit) {
      ctx.rejectEdit?.(`Keeping ${toolEdit.rule} ${toolEdit.tool} for ${entry.name}...`);
      keepMcpToolRuleFromSettings(ctx.mcpRegistry, entry.name, toolEdit, (message, entries) => {
        if (ctx.reportMcpToolRule) ctx.reportMcpToolRule(message, entries);
        else ctx.rejectEdit?.(message);
      });
      ctx.setEditingMode(false);
      ctx.setEditBuffer('');
      ctx.setMcpAllowAllConfirmationTarget(null);
      return true;
    }

    const nextMode = ctx.editBuffer.trim() as McpEntry['trustMode'];
    const validModes: McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];
    if (!validModes.includes(nextMode)) {
      ctx.rejectEdit?.(`"${ctx.editBuffer.trim()}" is not a trust mode (${validModes.join(', ')}) or a tool rule (deny <tool>, allow <tool>, clear <tool>). Nothing was changed.`);
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
    keepMcpTrustModeFromSettings(ctx.mcpRegistry, entry.name, nextMode, (message, entries) => {
      if (ctx.reportMcpToolRule) ctx.reportMcpToolRule(message, entries); else ctx.setMcpEntries(entries);
    });
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

  // List rows (worktree.setup.*, the sandbox lists, the env-scrub allowlist)
  // go through the one list codec, settings-modal-lists.ts.
  const listEdit = parseListSettingEdit(setting.key, ctx.editBuffer);
  if (listEdit && !listEdit.ok) {
    ctx.rejectEdit?.(`Not saved: ${listEdit.reason}; ${setting.key} was not changed.`);
    ctx.setEditingMode(false);
    ctx.setEditBuffer('');
    return false;
  }
  if (listEdit) {
    ctx.setValue(setting.key, listEdit.value);
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
