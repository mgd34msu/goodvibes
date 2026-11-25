import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { wireDevicesLists, type DevicesPairingHost } from '@goodvibes/engine/terminal-shell/devices-command';
import { askToTurnOnRelay } from '@goodvibes/engine/terminal-shell/relay-pairing-ask';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { mintAgentDevicePairing, pairingLinkCopy } from '../../agent/device-pairing.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import {
  listRelayCodes, mintRelayPairing, relayHostFailure, relayPairingOutcome,
  type RelayActionWords, type RelayPairAnswer,
} from '../../runtime/relay-host.ts';
import { invokeConnectedHostMethod } from '../connected-host-routes.ts';
import { readAgentHostPairingStatus, runAgentHostPair, runAgentHostUnpair } from './onboarding-runtime.ts';
import { requirePlatform, requireShellPaths } from './runtime-services.ts';
import { capabilityBinding } from './capability-binding.ts';

/** The controls the relay's sentences name: the Devices place's Relay tab and its Pair something. */
const DEVICES_RELAY_WORDS: RelayActionWords = {
  status: 'The Devices place\'s Relay tab (is the relay reachable)',
  pair: 'Pair something in the Devices place',
  codes: 'the Devices place\'s Relay tab',
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
 * The Agent's pairing on its own screen and its own credential for its connected host (platform
 * builtin/devices-session.ts), for its session capabilities' services. A phone or another device is paired by minting
 * a named device token on the connected host and showing its link and QR; pairing this Agent with its host is the
 * same owner-checked flow `/setup pair` and `/setup unpair` run; the relay pairing is the connected host's, through its
 * `relay.*` verbs. Channel setup is the terminal app's (the Agent sets channels up in the Mail, calendar and channels
 * place), so it is not offered here. Only the owner's own press pairs or forgets: a model's call of either is refused
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
    // The conversation keeps every line it prints, so the link and the sign-in code are printed masked
    // (the address readable), as one block whose copy key copies the real link.
    const printBlock = ctx.printBlock;
    const outcome = await mintAgentDevicePairing(hostVerbs(ctx), { ...(name ? { name } : {}), pairCommand: 'Pair something in the Devices and network place', ...(askToServe ? { askToServe } : {}), mask: true });
    if (!outcome.ok) throw commandRefusal(outcome.error, outcome.next);
    if (!printBlock) return outcome.text;
    printBlock(outcome.text, pairingLinkCopy(outcome));
    return undefined;
  },
  // The press in the place is the owner's own: the same owner-checked flow /setup pair runs.
  pairHost: async (ctx, request) => await runAgentHostPair(ctx, { apply: request.apply, name: request.name }, 'devices', ctx.invokedByModel !== true),
  hostStatus: async (ctx) => await readAgentHostPairingStatus(ctx),
  unpairHost: async (ctx) => await runAgentHostUnpair(ctx, 'devices', ctx.invokedByModel !== true),
  async pairRelay(ctx, name) {
    // The relay off: asked in place (opening on No), with the relay's address in the same step when none is set;
    // yes saves it, turns the relay on and pairs in the same run (terminal-shell/relay-pairing-ask.ts).
    const confirm = ctx.confirm;
    const relayUrl = String(requirePlatform(ctx).configManager.get('relay.url') ?? '');
    // The yes, with the address the relay is turned on at; the same call then waits for the host to register.
    let saidYes: (address: string) => void = () => undefined;
    const turnedOn = new Promise<string>((resolve) => { saidYes = resolve; });
    const ask = confirm
      ? async (configuredUrl: string) => {
        const said = await askToTurnOnRelay(confirm, configuredUrl);
        if (said.turnOn) saidYes(said.url || configuredUrl);
        return said;
      }
      : undefined;
    const outcomeText = (answer: RelayPairAnswer): string => {
      const outcome = relayPairingOutcome(answer, DEVICES_RELAY_WORDS);
      return outcome.ok ? outcome.text : `${outcome.error} ${outcome.next}`;
    };
    const minting = relayCall('Minting a relay pairing payload on the connected host',
      () => mintRelayPairing(hostVerbs(ctx), name || undefined, { ...(ask ? { ask } : {}), ...(relayUrl ? { url: relayUrl } : {}) }))
      .then((answer) => ({ answer }), (error: unknown) => ({ error }));
    const first = await Promise.race([minting, turnedOn.then((address) => ({ waiting: address }))]);
    if ('waiting' in first) {
      // The screen is not held while the relay is not answering yet: the pairing is said here when it comes.
      void minting.then((done) => {
        ctx.print('answer' in done ? outcomeText(done.answer) : done.error instanceof Error ? done.error.message : String(done.error));
      });
      return `The relay is on at ${first.waiting}, and it is not answering yet. The pairing shows here as soon as it does; you can carry on meanwhile.`;
    }
    if ('error' in first) throw first.error;
    const outcome = relayPairingOutcome(first.answer, DEVICES_RELAY_WORDS);
    if (!outcome.ok) throw commandRefusal(outcome.error, outcome.next);
    return outcome.text;
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
