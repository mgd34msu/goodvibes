import { commandJsonOrText as jsonOrText } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import { FEATURE_SETTINGS } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createAgentDaemonVerbCaller, ConnectedHostVerbError, describeConnectedHostVerbError } from '../runtime/client/daemon-verbs.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

/**
 * `goodvibes-agent relay status|pair|codes|revoke`, the outbound zero-knowledge relay that
 * lets a daemon register with a rendezvous relay so surfaces can reach it from
 * outside the LAN. The relay registration and the relay identity key belong to
 * the connected GoodVibes daemon; this command asks it through the
 * `relay.reachability.get`, `relay.pairing.mint`, `relay.codes.list` and
 * `relay.codes.revoke` verbs (the control plane's
 * invoke-by-id endpoint) and shows this Agent's imported relay.* settings
 * beside the live answer.
 */

const RELAY_USAGE = 'Usage: goodvibes-agent relay [status|pair [name]|codes|revoke <id>]';
const HOST_NEXT = 'Start the GoodVibes daemon (goodvibes-daemon) or check controlPlane.host and controlPlane.port, then retry.';

interface RelayPairing {
  readonly protocol?: string;
  readonly relayUrl?: string;
  readonly rid?: string;
  readonly daemonPublicKey?: string;
  readonly code?: string;
}

/** One relay code as the host lists it: never the code itself. */
interface RelayCodeView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt?: number;
}

function relayConnectFlagSummary(): { readonly id: string; readonly name: string; readonly defaultState: string } {
  const feature = FEATURE_SETTINGS.find((entry) => entry.id === 'relay-connect');
  return {
    id: 'relay-connect',
    name: feature?.name ?? 'Outbound Zero-Knowledge Relay',
    defaultState: feature === undefined ? 'disabled' : feature.defaultEnabled ? 'enabled' : 'disabled',
  };
}

function hostVerbs(runtime: CliCommandRuntime) {
  return createAgentDaemonVerbCaller({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory, invokeTimeoutMs: 15_000 });
}

function hostFailure(runtime: CliCommandRuntime, what: string, error: unknown): CliCommandOutput {
  const reason = describeConnectedHostVerbError(error);
  const status = error instanceof ConnectedHostVerbError ? error.status : undefined;
  const next = status === 404 ? 'Update GoodVibes on the connected host; it does not serve the relay verbs yet.' : HOST_NEXT;
  const message = `${what} failed: ${reason}\n  next ${next}`;
  return {
    output: jsonOrText(runtime, { ok: false, kind: status === undefined ? 'connected_host_unavailable' : 'connected_host_error', error: reason, ...(status === undefined ? {} : { status }), next: [next] }, message),
    exitCode: 1,
  };
}

/** Why the relay refused the host's registration, as the host reports it. */
interface RelayRefusal {
  readonly code: string;
  readonly message: string;
  readonly state: string;
  readonly next: readonly string[];
  readonly retryable: boolean;
}

/** What a relay status means for the person reading it, and what to do. */
function statusMeaning(status: string, configured: boolean): string {
  if (!configured || status === 'disabled') return 'off: relay.enabled, the relay-connect capability or relay.url is not set on the host';
  if (status === 'registered') return 'registered with the relay; surfaces can reach the host through it';
  if (status === 'refused') return 'refused by the relay; the host stopped dialling it until its relay settings or identity change';
  if (status === 'connecting' || status === 'reconnecting') return `${status} to the relay`;
  if (status === 'idle') return 'configured, not started yet';
  return status;
}

async function handleRelayStatus(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const config = runtime.configManager;
  const local = {
    enabled: config.get('relay.enabled') === true,
    url: String(config.get('relay.url') ?? ''),
    label: String(config.get('relay.label') ?? ''),
    requireStepUpForMutations: config.get('relay.requireStepUpForMutations') === true,
  };
  const flag = relayConnectFlagSummary();
  let live: { readonly status: string; readonly configured: boolean; readonly rendezvousId?: string; readonly refusal?: RelayRefusal };
  try {
    live = await hostVerbs(runtime).invoke<{ readonly status: string; readonly configured: boolean; readonly rendezvousId?: string; readonly refusal?: RelayRefusal }>('relay.reachability.get', {});
  } catch (error) {
    return hostFailure(runtime, 'Reading the connected host\'s relay status', error);
  }
  const payload = { ok: true, source: 'connected-host' as const, live, config: local, flag };
  const lines = [
    'GoodVibes relay (connected host)',
    `  status: ${live.status} (${statusMeaning(live.status, live.configured)})`,
    `  configured: ${live.configured ? 'yes' : 'no'}`,
    `  rendezvous id: ${live.rendezvousId || '(none: no live registration; derived from the host\'s relay identity key once one starts)'}`,
    ...(live.refusal ? [
      `  refused by the relay (${live.refusal.code}): ${live.refusal.state}${live.refusal.message ? ` (${live.refusal.message})` : ''}`,
      live.refusal.retryable
        ? '  the host keeps trying through its reconnect backoff'
        : '  the host stopped dialling the relay; it tries again when relay.url changes or when it restarts',
      ...live.refusal.next.map((step) => `  next ${step}`),
    ] : []),
    '',
    "  this Agent's imported relay settings:",
    `  relay.enabled: ${local.enabled ? 'true' : 'false'}`,
    `  relay.url: ${local.url || '(empty)'}`,
    `  relay.label: ${local.label || '(empty)'}`,
    `  relay.requireStepUpForMutations: ${local.requireStepUpForMutations ? 'true' : 'false'}`,
    `  ${flag.id} feature flag: ${flag.name} (default ${flag.defaultState})`,
  ];
  return { output: jsonOrText(runtime, payload, lines.join('\n')), exitCode: 0 };
}

async function handleRelayPair(runtime: CliCommandRuntime, name: string | undefined): Promise<CliCommandOutput> {
  let answer: { readonly pairing: RelayPairing | null; readonly status: string; readonly codeId?: string; readonly codeName?: string };
  try {
    answer = await hostVerbs(runtime).invoke<{ readonly pairing: RelayPairing | null; readonly status: string; readonly codeId?: string; readonly codeName?: string }>('relay.pairing.mint', name ? { name } : {});
  } catch (error) {
    return hostFailure(runtime, 'Minting a relay pairing payload on the connected host', error);
  }
  if (!answer.pairing) {
    const error = `The connected host has no live relay registration to pair against (relay status ${answer.status}).`;
    const next = answer.status === 'disabled'
      ? 'Turn the relay on for the host (relay.enabled, relay.url and the relay-connect capability), then run goodvibes-agent relay pair again.'
      : 'Wait for the host to register with the relay (goodvibes-agent relay status shows registered), then run goodvibes-agent relay pair again.';
    return {
      output: jsonOrText(runtime, { ok: false, kind: 'relay_not_registered', error, status: answer.status, next: [next] }, `${error}\n  next ${next}`),
      exitCode: 1,
    };
  }
  const pairing = answer.pairing;
  const lines = [
    'GoodVibes relay pairing (from the connected host)',
    `  relay URL: ${pairing.relayUrl ?? '(not given)'}`,
    `  rendezvous id: ${pairing.rid ?? '(not given)'}`,
    `  daemon public key: ${pairing.daemonPublicKey ?? '(not given)'}`,
    ...(pairing.protocol ? [`  protocol: ${pairing.protocol}`] : []),
    `  relay code: ${answer.codeName ?? 'this device'}${answer.codeId ? ` (${answer.codeId})` : ''}, for one device only`,
    '',
    `  payload ${JSON.stringify(pairing)}`,
    '',
    '  goodvibes-agent relay codes lists the devices; goodvibes-agent relay revoke <id> cuts one off the relay at its next request.',
  ];
  return { output: jsonOrText(runtime, { ok: true, pairing, status: answer.status, ...(answer.codeId ? { codeId: answer.codeId } : {}), ...(answer.codeName ? { codeName: answer.codeName } : {}) }, lines.join('\n')), exitCode: 0 };
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

async function handleRelayCodes(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  let answer: { readonly codes: readonly RelayCodeView[] };
  try {
    answer = await hostVerbs(runtime).invoke<{ readonly codes: readonly RelayCodeView[] }>('relay.codes.list', {});
  } catch (error) {
    return hostFailure(runtime, 'Listing the connected host\'s relay codes', error);
  }
  const codes = Array.isArray(answer?.codes) ? answer.codes : [];
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
  try {
    await hostVerbs(runtime).invoke('relay.codes.revoke', { id });
  } catch (error) {
    return hostFailure(runtime, `Revoking relay code ${id}`, error);
  }
  const message = `Relay code ${id} revoked: that device is refused at its next request through the relay. Pair it again on the home network to restore it.`;
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
