import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { openModalCommand } from './runtime-services.ts';
import { registerPluginCommand } from '@goodvibes/engine/terminal-shell/plugin-trust-command';

/**
 * `/plugin`, described once for both terminal apps
 * (terminal-shell/plugin-trust-command.ts). This app adds the full-screen
 * plugins view and its local curated catalog, which /marketplace installs from.
 */
export function registerPluginRuntimeCommands(registry: CommandRegistry): void {
  registerPluginCommand<CommandContext>(registry, {
    manager: (ctx) => ctx.extensions.pluginManager,
    openScreen: (ctx) => openModalCommand(ctx, 'plugins-modal'),
    catalogSurfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
  });
}
