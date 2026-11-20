import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { registerDevicesCommand } from '@goodvibes/engine/terminal-shell/devices-command';
import { CHANNELS_LIST } from '@goodvibes/engine/terminal-shell/channels-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { mintAgentDevicePairing } from '../../agent/device-pairing.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { invokeConnectedHostMethod } from '../connected-host-routes.ts';
import { requirePlatform, requireShellPaths } from './runtime-services.ts';

/**
 * `/devices` is one description shared with the terminal app
 * (terminal-shell/devices-command.ts). Here the device tokens are the
 * connected host's (`pairing.tokens.*`), "Pair something" pairs a phone or
 * another device by minting a named device token on the host and showing its
 * link and QR, and the paired phones, grants and captures come from the
 * daemon's `devices.*` verbs. Pairing this terminal, the relay and channel
 * setup are the terminal app's, and are refused here saying where they are.
 */
export function registerDevicesRuntimeCommands(registry: CommandRegistry): void {
  registerDevicesCommand<CommandContext>(registry, {
    async tokens(ctx) {
      const listed = await invokeConnectedHostMethod(ctx, 'pairing.tokens.list', {});
      // The contract's token entries are the pairing store's public tokens.
      return { where: 'the connected host', tokens: listed.tokens as unknown as readonly PublicPairingToken[], sharedRevoked: listed.legacySharedRevoked };
    },
    rename: async (ctx, id, name) => (await invokeConnectedHostMethod(ctx, 'pairing.tokens.rename', { id, name })).renamed,
    revoke: async (ctx, id) => (await invokeConnectedHostMethod(ctx, 'pairing.tokens.delete', { id })).revoked,
    devices: (ctx) => ctx.platform.devices,
    async pairDevice(ctx, name) {
      const verbs = createAgentDaemonVerbCaller({ configManager: requirePlatform(ctx).configManager, homeDirectory: requireShellPaths(ctx).homeDirectory });
      const outcome = await mintAgentDevicePairing(verbs, name ? { name } : {});
      if (!outcome.ok) throw commandRefusal(outcome.error, outcome.next);
      return outcome.text;
    },
  }, CHANNELS_LIST);
}
