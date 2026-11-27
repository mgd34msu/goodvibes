import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { wireDevicesLists, type DevicesPairingHost } from '@goodvibes/engine/terminal-shell/devices-command';
import { askToTurnOnRelay } from '@goodvibes/engine/terminal-shell/relay-pairing-ask';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { mintAgentDevicePairing } from '../../agent/device-pairing.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import {
  listRelayCodes, mintRelayPairing, relayHostFailure, relayPairingOutcome,
  type RelayActionWords,
} from '../../runtime/relay-host.ts';
import { invokeConnectedHostMethod } from '../connected-host-routes.ts';
import { readAgentHostPairingStatus, runAgentHostUnpair } from './onboarding-runtime.ts';
import { pairAgentHostWithCode, unpairAgentHost } from '../../runtime/agent-host-pairing.ts';
import { resolveConnectedHost } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import { formatSetupPairing } from '../../runtime/setup-pairing-presentation.ts';
import { requirePlatform, requireShellPaths } from './runtime-services.ts';
import { capabilityBinding } from './capability-binding.ts';

/** The controls the relay's sentences name: the Devices place's Relay tab and its Pair something. */
const DEVICES_RELAY_WORDS: RelayActionWords = {
  status: 'The Relay tab of Devices and network (is the relay reachable)',
  pair: 'Pair something in Devices and network',
  codes: 'the Relay tab of Devices and network',
  revoke: 'cut off, on a device there,',
};

function hostVerbs(ctx: CommandContext) {
  return createAgentDaemonVerbCaller({ configManager: requirePlatform(ctx).configManager, homeDirectory: requireShellPaths(ctx).homeDirectory });
}

/** One relay verb, its failure turned into a refusal in the person's words. */
async function relayCall<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const failure = relayHostFailure(what, error);
    throw commandRefusal(`${failure.what} failed: ${failure.reason}`, failure.next);
  }
}

/**
 * "This program with its daemon" with no code: with the daemon on this computer there is nothing to pair (this Agent is
 * your own program there); already paired, nothing to pair; otherwise where the code comes from. Local reading only.
 */
async function agentPairWithCodeWords(ctx: CommandContext): Promise<string> {
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (homeDirectory) {
    const connection = resolveConnectedHost({ configManager: requirePlatform(ctx).configManager, homeDirectory });
    if (connection.token && connection.source === 'pairing') return `This Agent already keeps a key of its own for ${connection.baseUrl}. There is nothing to pair; to pair it again, forget it first (Paired tab, Forget its daemon pairing).`;
    if (connection.token && connection.source !== 'environment') return `This Agent runs on the same computer as its daemon (${connection.baseUrl}): it is your own program there and already acts as you. There is nothing to pair.`;
  }
  return 'To make this Agent your own device on a daemon on another computer: where you are signed in as yourself (that daemon\'s web UI with your password, or your terminal app on that computer), open Devices and network, Pair something, A phone or another device, and press "Show the sign-in code once". Then choose This program with its daemon here and type that code under Sign-in code.';
}

/**
 * The Agent's pairing on its own screen and its own credential for its connected host (platform
 * builtin/devices-session.ts), for its session capabilities' services. A phone or another device is paired by minting
 * a named device token on the connected host and showing its link and QR; pairing this Agent with its host is the
 * same owner-checked flow `goodvibes-agent setup pair` and `setup unpair` run; the relay pairing is the connected host's, through its
 * `relay.*` verbs. A chat channel opens its row in the Mail, calendar and channels place, as in the terminal app. Only
 * the owner's own press pairs or forgets: a model's call of either is refused
 * before it gets here (the capabilities are owner-only).
 */
export const AGENT_PAIRING: DevicesPairingHost<CommandContext> = {
  async pairDevice(ctx, name) {
    // When phones cannot reach the host yet, the one real question is asked in place (opening on No):
    // yes serves the host's web UI to its network and makes the code in the same request; No keeps the this-computer link.
    const confirm = ctx.confirm;
    const askToServe = confirm
      ? (question: string) => confirm({
        title: 'Serve GoodVibes to your network?',
        body: `${question}\nPhones and other devices on your network could then open GoodVibes; each still needs a pairing code to sign in. It stays served to your network until you take it back.`,
        confirmLabel: 'Serve it to my network',
        cancelLabel: 'Keep it on this computer',
        tone: 'warning',
      })
      : undefined;
    // The words keep the link and the sign-in code masked (the address readable): the real link and its QR code are
    // the answer's one-time reveal, shown in the place's reveal pane and never written to the conversation.
    const outcome = await mintAgentDevicePairing(hostVerbs(ctx), { ...(name ? { name } : {}), pairCommand: 'Pair something in the Devices and network place', ...(askToServe ? { askToServe } : {}), mask: true, qrApart: true });
    if (!outcome.ok) throw commandRefusal(outcome.error, outcome.next);
    return { text: outcome.text, reveal: { value: outcome.link, ...(outcome.qr ? { qr: outcome.qr } : {}) } };
  },
  // The one way a device becomes yours: you start it on your own screen and this Agent completes it with that code
  // (the same as `goodvibes-agent setup pair --with-code`).
  async pairHost(ctx, request) {
    if (!request.code) return await agentPairWithCodeWords(ctx);
    if (ctx.invokedByModel === true) throw commandRefusal('Only you can pair this Agent with its daemon, on its own screen: Devices and network, Pair something. A model or another program cannot.');
    const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
    if (!homeDirectory) throw commandRefusal('Pairing is not available without an Agent home. Nothing was changed.');
    const result = await pairAgentHostWithCode({ configManager: requirePlatform(ctx).configManager, homeDirectory }, request.code, request.name || 'GoodVibes Agent');
    if (result.status !== 'paired') throw commandRefusal(result.message);
    return formatSetupPairing(result);
  },
  hostStatus: async (ctx) => await readAgentHostPairingStatus(ctx),
  async unpairHost(ctx) {
    // Nothing forgotten (no key kept, or the store could not be read) is said as a refusal, so no "To undo" follows it.
    if (ctx.invokedByModel !== true) {
      const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
      if (homeDirectory) {
        const result = await unpairAgentHost({ configManager: requirePlatform(ctx).configManager, homeDirectory });
        if (result.status === 'blocked' || result.status === 'pairing-store-unreadable') throw commandRefusal(result.message ?? 'Nothing was forgotten.');
        return formatSetupPairing(result);
      }
    }
    return await runAgentHostUnpair(ctx, 'devices', ctx.invokedByModel !== true);
  },
  async pairRelay(ctx, name) {
    // The relay off: asked in place (opening on No), with the relay's address in the same step when none is set;
    // yes saves it, turns the relay on and pairs in the same run (terminal-shell/relay-pairing-ask.ts).
    const confirm = ctx.confirm;
    const relayUrl = String(requirePlatform(ctx).configManager.get('relay.url') ?? '');
    const ask = confirm ? (configuredUrl: string) => askToTurnOnRelay(confirm, configuredUrl) : undefined;
    // The same call waits for the host to register with the relay, then mints: the payload is the answer's one-time
    // reveal, shown in the place's reveal pane once it exists, and never printed into the conversation.
    const answer = await relayCall('Minting a relay pairing payload on the connected host',
      () => mintRelayPairing(hostVerbs(ctx), name || undefined, { ...(ask ? { ask } : {}), ...(relayUrl ? { url: relayUrl } : {}) }));
    const outcome = relayPairingOutcome(answer, DEVICES_RELAY_WORDS);
    if (!outcome.ok) throw commandRefusal(outcome.error, outcome.next);
    return { text: outcome.summary, reveal: { value: outcome.payload } };
  },
  // A chat channel: its row in Mail, calendar and channels, where its keys are entered in its own form ("enter its keys").
  async pairChannel(ctx, channel) {
    if (!ctx.openPlace) return 'A chat channel is set up on its row in Mail, calendar and channels, on the Channels tab: open the menu (Ctrl+G, then m) and choose it.';
    ctx.openPlace('messages', { list: 'channels', ...(channel ? { item: channel } : {}) });
  },
};

/** The device lists this Agent's forms choose from, the connected host's (there is no `/devices` command). */
export function registerDevicesRuntimeCommands(_registry: CommandRegistry): void {
  wireDevicesLists<CommandContext>({
    async tokens(ctx) {
      const listed = await invokeConnectedHostMethod(ctx, 'pairing.tokens.list', {});
      // The contract's token entries are the pairing store's public tokens.
      return { where: 'the connected host', tokens: listed.tokens as unknown as readonly PublicPairingToken[], sharedRevoked: listed.legacySharedRevoked };
    },
    devices: (ctx) => ctx.platform.devices,
    relayCodes: async (ctx) => await relayCall('Listing the connected host\'s relay codes', () => listRelayCodes(hostVerbs(ctx))),
    // The connected host's devices waiting to pair as nodes, for the list a form chooses from.
    pairRequests: {
      list: async (ctx) => (await invokeConnectedHostMethod(ctx, 'remote.pair.requests.list', {})).requests,
    },
  }, capabilityBinding);
}
