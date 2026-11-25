/**
 * `/verbosity`, described once (command-actions/) for both terminal apps: how
 * much the app prints (quiet, balanced or operator), and one kind of
 * notification's own level. Saved as the `behavior.hitlMode` setting. Each
 * action is a capability of the program a person sits at
 * (capabilities/builtin/system-session.ts: verbosity.show, verbosity.set,
 * verbosity.set-domain), the same the model and the System place run.
 */
import { VERBOSITY_SET, VERBOSITY_SET_DOMAIN, VERBOSITY_SHOW, type SystemSessionServices } from '@goodvibes/engine/platform/platform/capabilities';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { sessionCapabilityAction } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';

const TERMINAL_ONLY = { terminalOnly: 'It is how this terminal app prints.' } as const;

/** Register `/verbosity` (one description for both apps), over the program's own services. */
export function registerInteractionModeCommand<Context extends CommandActionContext>(
  registry: Pick<TerminalCommandRegistry<Context>, 'register'>,
  services: (ctx: Context) => SystemSessionServices,
): void {
  registry.register(defineCommand<Context>({
    name: 'verbosity',
    title: 'How much the app prints',
    summary: 'Set how much the app prints: quiet, balanced or operator',
    group: 'Display',
    report: 'show',
    actions: [VERBOSITY_SHOW, VERBOSITY_SET, VERBOSITY_SET_DOMAIN]
      .map((definition) => sessionCapabilityAction<Context, SystemSessionServices>(definition, services, TERMINAL_ONLY)),
  }));
}
