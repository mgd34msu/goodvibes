import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { registerDevicesCommand } from '@goodvibes/engine/terminal-shell/devices-command';
import { CHANNELS_LIST } from '@goodvibes/engine/terminal-shell/channels-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { mintAgentDevicePairing } from '../../agent/device-pairing.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import {
  formatRelayStatus, listRelayCodes, mintRelayPairing, readRelayStatus, relayHostFailure, relayPairingOutcome, revokeRelayCode,
  type RelayActionWords,
} from '../../runtime/relay-host.ts';
import { invokeConnectedHostMethod } from '../connected-host-routes.ts';
import { readAgentHostPairingStatus, runAgentHostPair, runAgentHostUnpair } from './onboarding-runtime.ts';
import { requirePlatform, requireShellPaths } from './runtime-services.ts';

const DEVICES_RELAY_WORDS: RelayActionWords = {
  status: '/devices relay-status',
  pair: '/devices pair relay',
  codes: '/devices relay-codes',
  revoke: '/devices relay-revoke <code>',
};

function hostVerbs(ctx: CommandContext) {
  return createAgentDaemonVerbCaller({ configManager: requirePlatform(ctx).configManager, homeDirectory: requireShellPaths(ctx).homeDirectory });
}

/** One relay verb, its failure turned into the refusal /devices prints. */
async function relayCall<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const failure = relayHostFailure(what, error);
    throw commandRefusal(`${failure.what} failed: ${failure.reason}`, failure.next);
  }
}

/**
 * `/devices` is one description shared with the terminal app
 * (terminal-shell/devices-command.ts). Here the device tokens are the
 * connected host's (`pairing.tokens.*`), "Pair something" pairs a phone or
 * another device by minting a named device token on the host and showing its
 * link and QR, and the paired phones, grants and captures come from the
 * daemon's `devices.*` verbs. Pairing this Agent with its connected host is
 * the same owner-checked flow as `/setup pair` and `/setup unpair`; the relay
 * is the connected host's, reached through its `relay.*` verbs, and so are the
 * devices waiting to pair as nodes (`remote.pair.requests.*`). Channel setup
 * and the shared-token actions are the terminal app's, and are refused here
 * saying where they are.
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
      const outcome = await mintAgentDevicePairing(hostVerbs(ctx), name ? { name } : {});
      if (!outcome.ok) throw commandRefusal(outcome.error, outcome.next);
      return outcome.text;
    },
    pairHost: async (ctx, request) => await runAgentHostPair(ctx, { apply: request.apply, name: request.name }, 'devices'),
    hostStatus: async (ctx) => await readAgentHostPairingStatus(ctx),
    unpairHost: async (ctx) => await runAgentHostUnpair(ctx, 'devices'),
    async pairRelay(ctx, name) {
      const answer = await relayCall('Minting a relay pairing payload on the connected host', () => mintRelayPairing(hostVerbs(ctx), name || undefined));
      const outcome = relayPairingOutcome(answer, DEVICES_RELAY_WORDS);
      if (!outcome.ok) throw commandRefusal(outcome.error, outcome.next);
      return outcome.text;
    },
    relayStatus: async (ctx) => formatRelayStatus(await relayCall('Reading the connected host\'s relay status',
      () => readRelayStatus(hostVerbs(ctx), requirePlatform(ctx).configManager))),
    relayCodes: async (ctx) => await relayCall('Listing the connected host\'s relay codes', () => listRelayCodes(hostVerbs(ctx))),
    revokeRelayCode: async (ctx, id) => await relayCall(`Revoking relay code ${id}`, () => revokeRelayCode(hostVerbs(ctx), id)),
    // The connected host's devices waiting to pair as nodes; a refusal keeps the host's code.
    pairRequests: {
      list: async (ctx) => (await invokeConnectedHostMethod(ctx, 'remote.pair.requests.list', {})).requests,
      approve: async (ctx, id, confirmReplace) => (await invokeConnectedHostMethod(ctx, 'remote.pair.requests.approve', confirmReplace ? { requestId: id, confirmReplace: true } : { requestId: id })).request,
      reject: async (ctx, id) => (await invokeConnectedHostMethod(ctx, 'remote.pair.requests.reject', { requestId: id })).request,
    },
  }, CHANNELS_LIST);
}
