import { commandJsonOrText as jsonOrText } from '@goodvibes/engine/terminal-shell/cli-output';
import { createAgentDaemonVerbCaller } from '../runtime/client/daemon-verbs.ts';
import {
  formatRelayStatus, listRelayCodes, mintRelayPairing, readRelayStatus, relayHostFailure, relayPairingOutcome, revokeRelayCode,
  type RelayActionWords,
} from '../runtime/relay-host.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

/**
 * `goodvibes-agent relay status|pair|codes|revoke`, the outbound zero-knowledge relay that
 * lets a daemon register with a rendezvous relay so surfaces can reach it from
 * outside the LAN. The relay registration and the relay identity key belong to
 * the connected GoodVibes daemon; this command asks it through the relay verbs
 * in runtime/relay-host.ts (shared with /devices) and shows this Agent's
 * imported relay.* settings beside the live answer.
 */

const RELAY_USAGE = 'Usage: goodvibes-agent relay [status|pair [name]|codes|revoke <id>]';
const CLI_WORDS: RelayActionWords = {
  status: 'goodvibes-agent relay status',
  pair: 'goodvibes-agent relay pair',
  codes: 'goodvibes-agent relay codes',
  revoke: 'goodvibes-agent relay revoke <id>',
};

function hostVerbs(runtime: CliCommandRuntime) {
  return createAgentDaemonVerbCaller({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory, invokeTimeoutMs: 15_000 });
}

function hostFailure(runtime: CliCommandRuntime, what: string, error: unknown): CliCommandOutput {
  const failure = relayHostFailure(what, error);
  const message = `${failure.what} failed: ${failure.reason}\n  next ${failure.next}`;
  return {
    output: jsonOrText(runtime, { ok: false, kind: failure.status === undefined ? 'connected_host_unavailable' : 'connected_host_error', error: failure.reason, ...(failure.status === undefined ? {} : { status: failure.status }), next: [failure.next] }, message),
    exitCode: 1,
  };
}

async function handleRelayStatus(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  let view;
  try {
    view = await readRelayStatus(hostVerbs(runtime), runtime.configManager);
  } catch (error) {
    return hostFailure(runtime, 'Reading the connected host\'s relay status', error);
  }
  const payload = { ok: true, source: 'connected-host' as const, live: view.live, config: view.config, flag: view.flag };
  return { output: jsonOrText(runtime, payload, formatRelayStatus(view)), exitCode: 0 };
}

async function handleRelayPair(runtime: CliCommandRuntime, name: string | undefined): Promise<CliCommandOutput> {
  let answer;
  try {
    answer = await mintRelayPairing(hostVerbs(runtime), name);
  } catch (error) {
    return hostFailure(runtime, 'Minting a relay pairing payload on the connected host', error);
  }
  const outcome = relayPairingOutcome(answer, CLI_WORDS);
  if (!outcome.ok) {
    return {
      output: jsonOrText(runtime, { ok: false, kind: 'relay_not_registered', error: outcome.error, status: answer.status, next: [outcome.next] }, `${outcome.error}\n  next ${outcome.next}`),
      exitCode: 1,
    };
  }
  return { output: jsonOrText(runtime, { ok: true, pairing: outcome.pairing, status: answer.status, ...(answer.codeId ? { codeId: answer.codeId } : {}), ...(answer.codeName ? { codeName: answer.codeName } : {}) }, outcome.text), exitCode: 0 };
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

async function handleRelayCodes(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  let codes;
  try {
    codes = await listRelayCodes(hostVerbs(runtime));
  } catch (error) {
    return hostFailure(runtime, 'Listing the connected host\'s relay codes', error);
  }
  const lines = codes.length === 0
    ? ['No relay codes: no device is paired through the relay. goodvibes-agent relay pair [name] pairs one.']
    : [
      `Relay codes (${codes.length}), one per device paired through the relay:`,
      ...codes.map((code) => `  ${code.id}  ${code.name}  created ${formatTime(code.createdAt)}  ${code.lastSeenAt ? `last used ${formatTime(code.lastSeenAt)}` : 'not used yet'}`),
      '  goodvibes-agent relay revoke <id> cuts that device off the relay at its next request; every other device keeps working.',
    ];
  return { output: jsonOrText(runtime, { ok: true, codes }, lines.join('\n')), exitCode: 0 };
}

async function handleRelayRevoke(runtime: CliCommandRuntime, id: string | undefined): Promise<CliCommandOutput> {
  if (!id) {
    const message = `Missing relay code id.\n${RELAY_USAGE}\n  next goodvibes-agent relay codes lists the ids.`;
    return { output: jsonOrText(runtime, { ok: false, error: 'Missing relay code id.', next: ['goodvibes-agent relay codes lists the ids.'] }, message), exitCode: 2 };
  }
  let message: string;
  try {
    message = await revokeRelayCode(hostVerbs(runtime), id);
  } catch (error) {
    return hostFailure(runtime, `Revoking relay code ${id}`, error);
  }
  return { output: jsonOrText(runtime, { ok: true, id, revoked: true }, message), exitCode: 0 };
}

export async function handleRelayCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'status', ...rest] = runtime.cli.commandArgs;
  if (sub === 'status') return handleRelayStatus(runtime);
  if (sub === 'pair' || sub === 'pairing' || sub === 'qr' || sub === 'qrcode') return handleRelayPair(runtime, rest.join(' ').trim() || undefined);
  if (sub === 'codes') return handleRelayCodes(runtime);
  if (sub === 'revoke') return handleRelayRevoke(runtime, rest[0]);
  const message = `Unknown relay subcommand: ${sub}\n${RELAY_USAGE}`;
  return { output: jsonOrText(runtime, { ok: false, error: message }, message), exitCode: 2 };
}
