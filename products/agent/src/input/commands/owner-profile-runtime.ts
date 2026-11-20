/**
 * `/about-me` in the Agent (terminal-shell/about-me-command.ts): read, trace,
 * correct and forget what the platform knows about the owner, over the
 * connected host that owns the profile file. The owner's own line presents his
 * ordinary credential and is recorded as his own words (owner-direct), so a
 * write counts only when he types it; the model records a fact with its
 * `profile` tool, under its delegated authority. The shell-less
 * `goodvibes-agent owner-profile` runs the same daemon methods
 * (cli/owner-profile-command.ts).
 */
import { createProfileGatewayInvoke } from '@goodvibes-jev/engine/terminal-shell/agent-turn/profile-gateway';
import { connectedHostFamilyRemote } from '@goodvibes-jev/engine/terminal-shell/agent-turn/family-remote';
import { PROFILE_RECORDING_SURFACE } from '@goodvibes-jev/engine/terminal-shell/agent-turn/profile-types';
import { registerAboutMeCommand } from '@goodvibes-jev/engine/terminal-shell/about-me-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from './confirmation.ts';
import { requireShellPaths } from './runtime-services.ts';

export function registerOwnerProfileRuntimeCommands(registry: CommandRegistry): void {
  registerAboutMeCommand<CommandContext>(registry, {
    surface: PROFILE_RECORDING_SURFACE,
    async call(ctx, method, input) {
      // The owner's own command: his writes present the ordinary credential, not the Agent's delegated one.
      const invoke = createProfileGatewayInvoke({
        remote: connectedHostFamilyRemote({ configManager: ctx.platform.configManager, homeDirectory: requireShellPaths(ctx).homeDirectory, actor: 'owner' }),
      });
      const result = await invoke(method, input);
      // The error never carries a profile value.
      if (!result.ok) throw commandRefusal(result.error ?? 'The profile could not be reached.');
      return result.data;
    },
  });
}
