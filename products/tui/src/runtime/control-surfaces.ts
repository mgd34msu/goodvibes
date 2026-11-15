import { createControlSurfaces } from '@goodvibes-jev/engine/terminal-shell/bootstrap-runtime-bindings';
import type { CommandRegistry } from '../input/command-registry.ts';
import { listViewPanelIds } from '../views/view-panel-adapter.ts';

// The terminal opens views as modals; those are its panels.
export const { bindControlCommands, controlSurfacesFor } = createControlSurfaces<CommandRegistry>(
  () => listViewPanelIds().map((name) => ({ name })),
);
