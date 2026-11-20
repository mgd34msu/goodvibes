import { createConfigCommand } from '@goodvibes-jev/engine/terminal-shell/entry-workspace-commands';
// The same text reader `--config key=value` and the daemon's `config set` use, so one line stores one value everywhere.
import { parseConfigValueText } from '@goodvibes-jev/engine/terminal-shell/cli-config-overrides';
import { TUI_NOTIFICATIONS_METADATA_ONLY_KEY } from '../../config/host-settings.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { setActiveThemeMode, setActiveThemeName, type ThemeMode } from '../../renderer/theme.ts';
import {
  buildGoodVibesSecretKey,
  defaultSecretBackedScope,
  isSecretConfigKey,
  persistSecretBackedConfigValue,
} from '../../config/secret-config.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

export function registerConfigCommand(registry: CommandRegistry): void {
  registry.register(configWorkspaceCommand);
}

/**
 * Store a credential-bearing config key through the secret manager instead of
 * writing it into a config file: the value goes to the secret store and the
 * config key keeps only a `goodvibes://secrets/...` reference to it.
 *
 * The entered value is never echoed. The transcript is a diagnostic surface,
 * it is scrolled back through, copied into support threads and captured in
 * screen recordings, so it gets the reference and the store key, never the
 * secret.
 *
 * With no secret manager in this runtime there is nowhere safe to put it, and
 * the command REFUSES rather than falling back to a plaintext config write.
 */
async function handleSecretConfigSet(ctx: CommandContext, key: ConfigKey, value: string): Promise<void> {
  const secretKey = buildGoodVibesSecretKey(key);
  const secretsManager = ctx.platform?.secretsManager;
  if (!secretsManager) {
    throw commandRefusal(
      `${key} holds a credential, and this runtime has no secret store to put it in; refusing rather than writing it in cleartext into a config file.`,
      `Store it with: /secrets set ${secretKey}`,
    );
  }
  try {
    const configValue = await persistSecretBackedConfigValue(ctx.platform.configManager, secretsManager, key, value);
    const scope = defaultSecretBackedScope(key);
    ctx.print(
      `Set ${key}: stored in the ${scope} secret tier as ${secretKey} (value hidden).\n` +
        `  ${key} now holds the reference ${configValue}; the value itself is never written to a config file.` +
        (scope === 'daemon' ? '\n  The daemon reads that tier, so this keeps working with this client closed.' : ''),
    );
  } catch (e) {
    throw commandRefusal(`Could not set ${key}; nothing was stored: ${summarizeError(e)}`);
  }
}

const configWorkspaceCommand = createConfigCommand<CommandContext>({
  async set(key, value, ctx) {
    // A credential key must never take the generic path below: setDynamic
    // writes the value it is handed straight into a settings JSON file. The
    // settings modal routes these keys through the secret manager
    // (settings-modal-secrets.ts); this command routes them the same way.
    if (isSecretConfigKey(key)) {
      await handleSecretConfigSet(ctx, key as ConfigKey, value);
      return;
    }
    try {
      if (key === TUI_NOTIFICATIONS_METADATA_ONLY_KEY) {
        const parsed = parseConfigValueText(value);
        if (typeof parsed !== 'boolean') throw new Error('Host setting requires a literal boolean.');
        const handle = ctx.platform.configManager.getHostBooleanSetting(key);
        // Refuse an unavailable policy view before a legacy writer can
        // quarantine it and accidentally erase the operator's warning.
        const before = handle.getResolved().value;
        handle.set(parsed);
        ctx.print(`Set ${key}: ${JSON.stringify(before)} → ${JSON.stringify(handle.get())}`);
        return;
      }
      const before = ctx.platform.configManager.get(key as ConfigKey);
      ctx.platform.configManager.setDynamic(key as ConfigKey, parseConfigValueText(value));
      // A daemon setting is written by the daemon: wait for its answer.
      const refused = (await ctx.platform.configManager.settleDaemonWrites()).find((entry) => entry.key === key);
      if (refused) {
        throw commandRefusal(`Not set: the daemon refused ${key}, and nothing was changed: ${refused.error instanceof Error ? refused.error.message : String(refused.error)}`);
      }
      const after = ctx.platform.configManager.get(key as ConfigKey);
      ctx.print(`Set ${key}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
      // Forced theme modes apply immediately (matches the settings-modal
      // path); 'auto' re-probes on the next launch (stated honestly).
      if (key === 'display.theme') {
        const applied = setActiveThemeName(after);
        ctx.requestFullRepaint?.();
        ctx.print(`Theme applied: ${applied}.`);
      }
      if (key === 'display.themeMode') {
        if (after === 'dark' || after === 'light') {
          setActiveThemeMode(after as ThemeMode);
          ctx.requestFullRepaint?.();
          ctx.print(
            'Theme applied. Note: transcript, modal, and header/footer/thinking chrome all flip; only the background colour follows your terminal.',
          );
        } else {
          ctx.print('Theme mode "auto" probes the terminal background on the next launch.');
        }
      }
    } catch (e) {
      if (readRefusal(e)) throw e;
      throw commandRefusal(`Could not set ${key}; nothing was changed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});
