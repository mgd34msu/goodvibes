/**
 * How the terminal app's slash actions reach the daemon for a capability
 * whose home is the daemon (hooks, storing a secret, memory explain, ...):
 * the daemon this app talks to, and which project and program is asking.
 */
import type { DaemonCapabilityBinding } from '@goodvibes/engine/terminal-shell/command-actions';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import type { CommandContext } from '../command-registry.ts';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';

export const capabilityBinding: DaemonCapabilityBinding<CommandContext> = {
  daemon: (ctx) => createDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
  caller: (ctx) => ({ workingDirectory: requireShellPaths(ctx).workingDirectory, program: 'tui', ...modelOf(ctx) }),
};

/** The model this app's conversation uses, for a capability on it (its context window size); nothing when it cannot be read. */
function modelOf(ctx: CommandContext): { readonly model?: string } {
  try {
    return { model: ctx.provider.providerRegistry.getCurrentModel().registryKey };
  } catch {
    return {};
  }
}
