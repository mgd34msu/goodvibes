/**
 * How the Agent's slash actions reach the daemon for a capability whose home
 * is the daemon (hooks, storing a secret, memory explain, ...): the connected
 * host, and which project and program is asking.
 */
import type { DaemonCapabilityBinding } from '@goodvibes/engine/terminal-shell/command-actions';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import type { CommandContext } from '../command-registry.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';

export const capabilityBinding: DaemonCapabilityBinding<CommandContext> = {
  daemon: (ctx) => createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
  caller: (ctx) => ({ workingDirectory: requireShellPaths(ctx).workingDirectory, program: 'agent' }),
};
