import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { readConnectedDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { describeOperatorRpcError } from '../../runtime/client/operator-endpoint.ts';
import { buildPairingConnectionInfo, servePairingToNetwork } from '../../runtime/pairing-offer.ts';
import { SERVE_TO_NETWORK_QUESTION, formatPairingOffers, generateQrMatrix, pairingPostureNotice, renderQrToString } from '@goodvibes/engine/platform/platform/pairing';
import { getOperatorRpc } from './operator-rpc.ts';
import { wireDevicesLists, type DeviceTokens, type DevicesPairingHost, type PairRequest, type PairRequestsHost } from '@goodvibes/engine/terminal-shell/devices-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import { capabilityBinding } from './capability-binding.ts';
import { pairRelay, relayCodes } from './relay-runtime.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { formatTuiHostPairing, pairTuiHostWithCode, unpairTuiHost } from '../../runtime/tui-host-pairing.ts';

/**
 * "Pair something, A chat channel": the channel's row in Mail, calendar and channels, where its keys are entered in its
 * own form ("enter its keys") and set up ("set it up").
 */
async function openChannelRow(ctx: CommandContext, channel: string): Promise<string | void> {
  if (!ctx.openPlace) return `A chat channel is set up on its row in Mail, calendar and channels, on the Channels tab: open the menu (Ctrl+G, then m) and choose it.`;
  ctx.openPlace('messages', { list: 'channels', ...(channel ? { item: channel } : {}) });
}

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
 * "This program with its daemon" with no code: with the daemon on this machine there is nothing to pair (this terminal is
 * your own program there, its registration checked at every start); with one on another machine, where the code comes
 * from. Local inspection only.
 */
function pairWithCodeWords(ctx: CommandContext): string {
  try {
    const credential = resolveNativeHostCredential({ configManager: ctx.platform.configManager, homeDirectory: requireShellPaths(ctx).homeDirectory });
    if (credential.available && !credential.expectedPrincipalId) {
      return `This terminal runs on the same computer as its daemon (${credential.baseUrl}): it is your own program there and already acts as you. There is nothing to pair.`;
    }
    if (credential.available) return `This terminal already keeps a device credential for ${credential.baseUrl}. There is nothing to pair; to pair it again, forget it first (Paired tab, Forget its daemon pairing).`;
  } catch {
    // Unreadable here: say where the code comes from.
  }
  return 'To make this terminal your own device on a daemon on another computer: where you are signed in as yourself (that daemon\'s web UI with your password, or your terminal app on that computer), open Devices and network, Pair something, A phone or another device, and press "Show the sign-in code once". Then choose This program with its daemon here and type that code under Sign-in code.';
}

/**
 * This terminal's pairing on its own screen and its own credential for its daemon (platform builtin/devices-session.ts),
 * for its session capabilities' services. Only the owner's own press or line pairs or forgets: a model's call of
 * either is refused before it gets here (the capabilities are owner-only).
 */
export const TUI_PAIRING: DevicesPairingHost<CommandContext> = {
  async pairDevice(ctx, name) {
    // An offer is minted with the name given: its link and QR code are the answer's one-time reveal, shown in the place's
    // reveal pane and never in the words. The device takes the offer when it uses it and is listed by that name once it pairs.
    const pairingTokens = ctx.platform.pairingTokens;
    if (!pairingTokens) throw commandRefusal('A device cannot be paired here: this program holds no store of pairing offers.');
    const configManager = ctx.platform.configManager;
    let info = buildPairingConnectionInfo({ configManager, pairingTokens }, name ? { name } : {});
    if ('kind' in info) throw commandRefusal(info.lines.join('\n'));
    // A link only this computer can open: the one real question, asked in place (opening on No); yes serves the web UI to the
    // network and makes the code for an address phones can open in the same request.
    if (info.thisMachineOnly && ctx.confirm) {
      const serve = await ctx.confirm({
        title: 'Serve GoodVibes to your network?',
        body: `${SERVE_TO_NETWORK_QUESTION}\nPhones and other devices on your network could then open GoodVibes; each still needs a pairing code to sign in. It stays served to your network until you take it back.`,
        confirmLabel: 'Serve it to my network',
        cancelLabel: 'Keep it on this computer',
        tone: 'warning',
      });
      if (serve) {
        try {
          info = await servePairingToNetwork({ configManager, homeDirectory: requireShellPaths(ctx).homeDirectory }, name || undefined);
        } catch (error) {
          throw commandRefusal(`The web UI was not served to your network: ${error instanceof Error ? error.message : String(error)}.`, 'Keep it on this computer, or check the daemon, then pair again.');
        }
      }
    }
    const here = info.thisMachineOnly;
    const notice = pairingPostureNotice(info.posture);
    return {
      text: [
        // No bare "device" in these words: a place reads that picked value ("device") as its label, and the line then says it twice.
        `A pairing offer was made for ${info.url}; it is listed under ${name ? `the name "${name}"` : 'a dated name'} once a phone or tablet pairs with it.`,
        ...(here ?? ['Scan its QR code with the phone\'s camera: it opens the web app already signed in.']),
        ...(info.offers.length > 0 ? ['', 'Offers carried in this pairing (each declinable in the web app):', ...formatPairingOffers(info.offers)] : []),
        ...(notice ? ['', notice] : []),
      ].join('\n'),
      reveal: { value: info.deepLink, ...(here ? {} : { qr: renderQrToString(generateQrMatrix(info.deepLink)) }) },
    };
  },
  async pairHost(ctx, request) {
    // The one way a device becomes yours: you start it on your own screen and this terminal completes it with that code.
    if (!request.code) return pairWithCodeWords(ctx);
    if (ctx.invokedByModel === true) throw commandRefusal(`Only you can pair this terminal with a daemon, on its own screen: ${PAIR_HOST_CONTROL}. A model or another program cannot.`);
    let result: Awaited<ReturnType<typeof pairTuiHostWithCode>>;
    try {
      result = await pairTuiHostWithCode({ configManager: ctx.platform.configManager, homeDirectory: requireShellPaths(ctx).homeDirectory }, request.code, request.name || 'GoodVibes TUI');
    } catch {
      throw commandRefusal('This terminal\'s host credentials are unavailable here. Nothing was changed.');
    }
    if (result.status !== 'paired') throw commandRefusal(result.message);
    return formatTuiHostPairing(result);
  },
  hostStatus: async (ctx) => hostStatus(ctx),
  async unpairHost(ctx) {
    // Forgetting the credential cuts this terminal off from its host until the owner pairs again: only the owner's own press.
    if (ctx.invokedByModel === true) throw commandRefusal('Only you can make this terminal forget its daemon pairing, from the Devices and network place. Nothing was forgotten.');
    let result: Awaited<ReturnType<typeof unpairTuiHost>>;
    try {
      result = await unpairTuiHost({ configManager: ctx.platform.configManager, homeDirectory: requireShellPaths(ctx).homeDirectory });
    } catch {
      throw commandRefusal('This terminal\'s host credentials are unavailable here.', 'Use goodvibes host unpair in an owner terminal');
    }
    // Nothing forgotten (none stored, or it could not be read) is said as a refusal: no "To undo" follows it.
    if (result.status === 'blocked') throw commandRefusal(result.message ?? 'Nothing was forgotten.');
    return formatTuiHostPairing(result);
  },
  pairRelay: (ctx, name) => pairRelay(ctx, name || undefined),
  pairChannel: openChannelRow,
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
