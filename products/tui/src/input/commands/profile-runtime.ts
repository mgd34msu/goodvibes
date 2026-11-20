/**
 * profile-runtime.ts
 *
 * `/about-me` in the terminal app (terminal-shell/about-me-command.ts): what
 * the platform knows about the person who owns it, over the operator wire.
 * The daemon is the single writer of the profile file, which is what makes its
 * rename-based writes enough with no lock (§3, §5.4): this module has no file
 * path, no parser and no writer of its own. A failed call is described by
 * `describeOperatorRpcError`, which names the transport, never a value.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { registerAboutMeCommand } from '@goodvibes/engine/terminal-shell/about-me-command';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';

/** Which surface is recording a line; named in the provenance suffix. */
const TUI_SURFACE = 'tui';

export function registerProfileRuntimeCommands(registry: CommandRegistry): void {
  registerAboutMeCommand<CommandContext>(registry, {
    surface: TUI_SURFACE,
    async call(ctx, method, input) {
      const rpc = getOperatorRpc(ctx);
      if (!rpc.available) throw commandRefusal(rpc.reason);
      try {
        // The client checks every answer against the method's output schema before it resolves.
        return await rpc.platformClient.operator.invoke(method as string, input as unknown as Record<string, unknown>);
      } catch (error) {
        throw commandRefusal(describeOperatorRpcError(error));
      }
    },
  });
}
