import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { registerDevicesCommand } from '@goodvibes/engine/terminal-shell/devices-command';
import { askToTurnOnRelay } from '@goodvibes/engine/terminal-shell/relay-pairing-ask';
import { CHANNELS_LIST } from '@goodvibes/engine/terminal-shell/channels-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { mintAgentDevicePairing, pairingLinkCopy } from '../../agent/device-pairing.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import {
  formatRelayStatus, listRelayCodes, mintRelayPairing, readRelayStatus, relayHostFailure, relayPairingOutcome, revokeRelayCode,
  type RelayActionWords, type RelayPairAnswer,
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
    async revoke(ctx, id) {
      const answer = await invokeConnectedHostMethod(ctx, 'pairing.tokens.delete', { id });
      if (typeof answer.revoked === 'boolean') return answer.revoked;
      // A device this Agent's credential did not pair is the owner's to revoke: the host put it to him instead.
      const approval = 'approvalId' in answer ? ` as approval ${answer.approvalId}` : '';
      throw commandRefusal(`Revoking this device is the owner's own act, so the connected host put it to him${approval}; nothing is revoked until he approves it.`,
        'The owner approves it from his own app (/approval waiting); the device keeps working until then.', 'OWNER_APPROVAL_PENDING');
    },
    devices: (ctx) => ctx.platform.devices,
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
      const outcome = await mintAgentDevicePairing(hostVerbs(ctx), { ...(name ? { name } : {}), pairCommand: '/devices pair device', ...(askToServe ? { askToServe } : {}), mask: true });
      if (!outcome.ok) throw commandRefusal(outcome.error, outcome.next);
      if (!printBlock) return outcome.text;
      printBlock(outcome.text, pairingLinkCopy(outcome));
      return undefined;
    },
    pairHost: async (ctx, request) => await runAgentHostPair(ctx, { apply: request.apply, name: request.name }, 'devices'),
    hostStatus: async (ctx) => await readAgentHostPairingStatus(ctx),
    unpairHost: async (ctx) => await runAgentHostUnpair(ctx, 'devices'),
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
