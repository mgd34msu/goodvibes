/**
 * How the Agent's slash actions reach the daemon for a capability whose home
 * is the daemon (hooks, storing a secret, memory explain, ...): the connected
 * host, and which project and program is asking.
 */
import type { DaemonCapabilityBinding } from '@goodvibes/engine/terminal-shell/command-actions';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import type { CommandContext } from '../command-registry.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { withFileWorkHere } from '@goodvibes/engine/terminal-shell/support-bundle-cli';
import { configuredDaemonIsThisMachine } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';

/** A host on another machine: the bundle, support folder and moved-setup files are read and written here (bundle-file-work.ts). */
const hereWhenRemote = (ctx: CommandContext, caller: DaemonVerbCaller): DaemonVerbCaller =>
  withFileWorkHere(caller, () => !configuredDaemonIsThisMachine(ctx.platform.configManager), () => requireShellPaths(ctx).workingDirectory);

export const capabilityBinding: DaemonCapabilityBinding<CommandContext> = {
  daemon: (ctx) => hereWhenRemote(ctx, createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory })),
  caller: (ctx) => ({ workingDirectory: requireShellPaths(ctx).workingDirectory, program: 'agent', ...modelOf(ctx), ...sessionOf(ctx) }),
};

/**
 * The same, for a control a person pressed in one of the Agent's places (the place host's daemon capabilities and the
 * lists it reads as their request): with this machine's own daemon credential when the host is this machine, as the
 * terminal app's presses go, so the host keeps the person's claim (daemon-verbs.ts `ownerPress`). Only the place host
 * is given it; the Agent's model and its tools call with `capabilityBinding`.
 */
export const ownerPressBinding: DaemonCapabilityBinding<CommandContext> = {
  daemon: (ctx) => hereWhenRemote(ctx, createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory, ownerPress: true })),
  caller: capabilityBinding.caller,
};

/** The Agent's conversation, which a capability records as where a thing came from (a memory record's session). */
function sessionOf(ctx: CommandContext): { readonly sessionId?: string } {
  const sessionId = ctx.session?.runtime?.sessionId;
  return typeof sessionId === 'string' && sessionId ? { sessionId } : {};
}

/** The model the Agent's conversation uses, for a capability on it (its context window size); nothing when it cannot be read. */
function modelOf(ctx: CommandContext): { readonly model?: string } {
  try {
    return { model: ctx.provider.providerRegistry.getCurrentModel().registryKey };
  } catch {
    return {};
  }
}
