import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { readConnectedDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { describeOperatorRpcError } from '../../runtime/client/operator-endpoint.ts';
import { namePairingOffer } from '../../views/modals/pairing-modal.ts';
import { getOperatorRpc } from './operator-rpc.ts';
import { wireDevicesLists, type DeviceTokens, type DevicesPairingHost, type PairRequest, type PairRequestsHost } from '@goodvibes/engine/terminal-shell/devices-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import { openModalCommand } from './runtime-services.ts';
import { capabilityBinding } from './capability-binding.ts';
import { runChannelPairing } from './channel-pairing.ts';
import { pairRelay, relayCodes } from './relay-runtime.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { formatTuiHostPairing, unpairTuiHost } from '../../runtime/tui-host-pairing.ts';

/** Where the person pairs this terminal with a daemon on another machine: the place's control, never a line to type. */
const PAIR_HOST_CONTROL = 'Pair something in the Devices and network place, then "This program with its daemon"';

/**
 * The device tokens of the daemon this terminal talks to, for the list a form chooses from. The pairing store is the
 * daemon's: it is read through the operator API (`pairing.tokens.list`), from the daemon at `daemon.connectedHost.url`
 * when one is set. With no daemon answering, the list says so (no fallback to this machine's file).
 */
async function readTokens(ctx: CommandContext): Promise<DeviceTokens> {
  const connected = readConnectedDaemonOrigin((key) => ctx.platform.configManager.get(key));
  const rpc = getOperatorRpc(ctx);
  if (!rpc.available) {
    throw commandRefusal(`The paired devices are kept by the daemon, which could not be asked: ${rpc.reason}.`, 'Start the daemon (or check its address in Settings), then read the list again', 'DAEMON_UNAVAILABLE');
  }
  try {
    const listed = await (rpc.platformClient.operator.invoke('pairing.tokens.list' as never, {} as never) as Promise<{ readonly tokens: readonly PublicPairingToken[]; readonly legacySharedRevoked: boolean }>);
    return { where: connected ? `the daemon at ${rpc.origin}` : 'this machine\'s daemon', tokens: listed.tokens, sharedRevoked: listed.legacySharedRevoked };
  } catch (error) {
    if (error instanceof Error && 'refusal' in error) throw error;
    throw commandRefusal(`Reading the devices did not finish: ${describeOperatorRpcError(error)}`, 'The Devices and network place lists the current devices', 'NOT_DONE');
  }
}

/**
 * The daemon's devices waiting to pair as nodes (`remote.pair.requests.*`). Kept
 * by the daemon only, so without one answering the list is refused; a
 * failure keeps the daemon's code on the refusal (REMOTE_PAIR_REPLACES_PEER).
 */
function pairRequestsOnDaemon(): PairRequestsHost<CommandContext> {
  const call = async <T,>(ctx: CommandContext, what: string, method: string, input: Record<string, unknown>): Promise<T> => {
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      throw commandRefusal(`Devices waiting to pair are kept by the daemon, which could not be asked: ${rpc.reason}.`, 'Start the daemon (or check its address in Settings), then read the list again', 'DAEMON_UNAVAILABLE');
    }
    try {
      return await (rpc.platformClient.operator.invoke(method as never, input as never) as Promise<T>);
    } catch (error) {
      if (error instanceof Error && 'refusal' in error) throw error;
      const code = error && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined;
      throw commandRefusal(`${what} did not finish: ${describeOperatorRpcError(error)}`, 'The Devices and network place lists the devices waiting to pair', typeof code === 'string' ? code : 'NOT_DONE');
    }
  };
  return {
    list: async (ctx) => (await call<{ readonly requests: readonly PairRequest[] }>(ctx, 'Reading the devices waiting to pair', 'remote.pair.requests.list', {})).requests,
  };
}

/** How this terminal reaches its daemon: a device pairing, or this machine's operator token. Local inspection only. */
function hostStatus(ctx: CommandContext): string {
  try {
    const credential = resolveNativeHostCredential({ configManager: ctx.platform.configManager, homeDirectory: requireShellPaths(ctx).homeDirectory });
    const reading = !credential.available ? credential.reason
      : credential.expectedPrincipalId
        ? `This terminal holds a device pairing for ${credential.baseUrl}. Live scopes and native authority are checked by each operation.`
        : `No device pairing is saved for ${credential.baseUrl}; it is the daemon on this machine, so the operator token this terminal already holds is used and no pairing is needed. Live scopes and native authority are checked by each operation.`;
    return `${reading}\nTo pair this terminal with a daemon on another machine: ${PAIR_HOST_CONTROL}.`;
  } catch {
    throw commandRefusal('This terminal\'s host credentials are unavailable here.', 'Use goodvibes host pair in an owner terminal');
  }
}

/**
 * This terminal's pairing on its own screen and its own credential for its daemon (platform builtin/devices-session.ts),
 * for its session capabilities' services. Only the owner's own press or line pairs or forgets: a model's call of
 * either is refused before it gets here (the capabilities are owner-only).
 */
export const TUI_PAIRING: DevicesPairingHost<CommandContext> = {
  async pairDevice(ctx, name) {
    // The pairing view shows a QR of an offer, minted with the name given; the device takes that token when it uses it.
    if (name) namePairingOffer(name);
    openModalCommand(ctx, 'pairing-modal');
    return name ? `Opened the pairing QR for "${name}"; the device is listed by that name once it pairs.` : 'Opened the pairing QR. Press r in it for a new offer; the one it replaces stops working unless a device already paired with it.';
  },
  async pairHost(ctx, request) {
    if (ctx.invokedByModel !== true && ctx.beginHostPairing) {
      await ctx.beginHostPairing({ apply: request.apply, bootstrapShared: request.bootstrapShared, name: request.name || 'GoodVibes TUI' });
      return undefined;
    }
    if (request.apply) throw commandRefusal(`Only you can pair this terminal with a daemon, on its own screen: ${PAIR_HOST_CONTROL}. A model or another program cannot grant lasting administrative access.`);
    return hostStatus(ctx);
  },
  hostStatus: async (ctx) => hostStatus(ctx),
  async unpairHost(ctx) {
    // Forgetting the credential cuts this terminal off from its host until the owner pairs again: only the owner's own press.
    if (ctx.invokedByModel === true) throw commandRefusal('Only you can make this terminal forget its daemon pairing, from the Devices and network place. Nothing was forgotten.');
    try {
      return formatTuiHostPairing(await unpairTuiHost({ configManager: ctx.platform.configManager, homeDirectory: requireShellPaths(ctx).homeDirectory }));
    } catch {
      throw commandRefusal('This terminal\'s host credentials are unavailable here.', 'Use goodvibes host unpair in an owner terminal');
    }
  },
  pairRelay: (ctx, name) => pairRelay(ctx, name || undefined),
  async pairChannel(ctx, channel) { await runChannelPairing(channel, ctx); },
};

/** The device lists this app's forms choose from (there is no `/devices` command: its actions are the place's controls). */
export function registerDevicesRuntimeCommands(_registry: CommandRegistry): void {
  wireDevicesLists<CommandContext>({
    tokens: readTokens,
    devices: (ctx) => ctx.platform.devices,
    relayCodes,
    pairRequests: pairRequestsOnDaemon(),
  }, capabilityBinding);
}
