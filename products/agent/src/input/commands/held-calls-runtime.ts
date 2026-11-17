import { createHeldCallsCommand } from '@goodvibes-jev/engine/terminal-shell/held-calls-command';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';

/** /held: approve or set aside the calls just-vibes held for the owner in this session. */
export function registerHeldCallsCommands(registry: CommandRegistry): void {
  registry.register(createHeldCallsCommand<CommandContext>({
    isOwner: (ctx, command) => isDirectOwnerCommandContext(ctx, command),
  }));
}
