import { PACKAGED_COMMANDS, type ControlToolOptions } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandRegistry } from '../input/command-registry.ts';
import { listViewPanelIds } from '../views/view-panel-adapter.ts';
import type { RuntimeServices } from './services.ts';

/**
 * The control tool is registered with the engine's tools, before this shell's
 * command registry exists. It reads the registry here when a model calls it, so
 * it names only commands this build has. Until the registry is bound it names none.
 */
const commandRegistries = new WeakMap<RuntimeServices, CommandRegistry>();

export function bindControlCommands(services: RuntimeServices, registry: CommandRegistry): void {
  commandRegistries.set(services, registry);
}

export function controlSurfacesFor(services: RuntimeServices): ControlToolOptions {
  return {
    commands: () => {
      const registry = commandRegistries.get(services);
      return registry ? PACKAGED_COMMANDS.filter((name) => registry.get(name) !== undefined) : [];
    },
    // The terminal opens views as modals; those are its panels.
    panels: listViewPanelIds,
  };
}
