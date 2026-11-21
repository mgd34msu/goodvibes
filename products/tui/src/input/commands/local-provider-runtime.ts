import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { registerProviderCommand } from '@goodvibes/engine/terminal-shell/provider-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireProviderApi, requireSecretsManager, requireServiceRegistry, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';
import { ensureProviderKeyThenSelect } from '../provider-key-intake.ts';

/** `/provider` is one description shared with the other terminal app (terminal-shell/provider-command.ts); here a sign-in may wait for the browser, and a missing key is asked for before a switch lands. */
export function registerLocalProviderRuntimeCommands(registry: CommandRegistry): void {
  registerProviderCommand<CommandContext>(registry, {
    requireProviderApi,
    requireShellPaths,
    requireSecretsManager,
    requireSubscriptionManager,
    requireServiceRegistry,
    beforeSelection: ensureProviderKeyThenSelect,
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    signInListens: true,
    codeEditing: true,
    formatSource: (source) => source,
  });
}
