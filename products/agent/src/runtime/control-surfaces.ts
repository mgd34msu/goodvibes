import { createControlSurfaces } from '@goodvibes/engine/terminal-shell/bootstrap-runtime-bindings';
import type { CommandRegistry } from '../input/command-registry.ts';

// This shell has no panels: modals replaced them.
export const { bindControlCommands, controlSurfacesFor } = createControlSurfaces<CommandRegistry>();
