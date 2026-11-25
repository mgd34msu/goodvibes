/**
 * How the terminal app's slash actions reach the daemon for a capability
 * whose home is the daemon (hooks, storing a secret, memory explain, ...):
 * the daemon this app talks to, and which project and program is asking.
 */
import type { DaemonCapabilityBinding } from '@goodvibes/engine/terminal-shell/command-actions';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import type { CommandContext } from '../command-registry.ts';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import { withFileWorkHere } from '@goodvibes/engine/terminal-shell/support-bundle-cli';
import { configuredDaemonIsThisMachine } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';

export const capabilityBinding: DaemonCapabilityBinding<CommandContext> = {
  // A daemon on another machine: the bundle, support folder and moved-setup files are read and written here (bundle-file-work.ts).
  daemon: (ctx) => withFileWorkHere(
    createDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
    () => !configuredDaemonIsThisMachine(ctx.platform.configManager), () => requireShellPaths(ctx).workingDirectory),
  caller: (ctx) => ({ workingDirectory: requireShellPaths(ctx).workingDirectory, program: 'tui', ...modelOf(ctx), ...sessionOf(ctx) }),
};

/** This app's conversation, which a capability records as where a thing came from (a memory record's session). */
function sessionOf(ctx: CommandContext): { readonly sessionId?: string } {
  const sessionId = ctx.session?.runtime?.sessionId;
  return typeof sessionId === 'string' && sessionId ? { sessionId } : {};
}

/** The model this app's conversation uses, for a capability on it (its context window size); nothing when it cannot be read. */
function modelOf(ctx: CommandContext): { readonly model?: string } {
  try {
    return { model: ctx.provider.providerRegistry.getCurrentModel().registryKey };
  } catch {
    return {};
  }
}
