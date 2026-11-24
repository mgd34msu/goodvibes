/**
 * relay-host.ts, the connected host's relay as the Agent reaches it: the
 * `relay.reachability.get`, `relay.pairing.mint`, `relay.codes.list` and
 * `relay.codes.revoke` verbs and the text each answer reads as. The relay
 * registration and its identity key belong to the daemon; `goodvibes-agent
 * relay` and `/devices` both ask it through these, each naming its own words
 * for the next step.
 */
import { FEATURE_SETTINGS } from '@goodvibes/engine/platform/platform/runtime/state';
import { mintRelayPairingInOneRun, type RelayTurnOnAnswer } from '@goodvibes/engine/terminal-shell/relay-pairing-ask';
import { ConnectedHostVerbError, describeConnectedHostVerbError, type AgentDaemonVerbCaller } from './client/daemon-verbs.ts';

/** How the program that prints a relay answer spells each relay action, for the next steps it names. */
export interface RelayActionWords {
  readonly status: string;
  readonly pair: string;
  readonly codes: string;
  readonly revoke: string;
}

export const RELAY_HOST_NEXT = 'Start the GoodVibes daemon (goodvibes-daemon) or check daemon.connectedHost.url (for the daemon on this machine, controlPlane.host and controlPlane.port), then retry.';

export interface RelayPairing {
  readonly protocol?: string;
  readonly relayUrl?: string;
  readonly rid?: string;
  readonly daemonPublicKey?: string;
  readonly code?: string;
}

/** One relay code as the host lists it: never the code itself. */
export interface RelayCodeView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt?: number;
}

/** Why the relay refused the host's registration, as the host reports it. */
export interface RelayRefusal {
  readonly code: string;
  readonly message: string;
  readonly state: string;
  readonly next: readonly string[];
  readonly retryable: boolean;
}

export interface RelayLiveStatus {
  readonly status: string;
  readonly configured: boolean;
  readonly rendezvousId?: string;
  readonly refusal?: RelayRefusal;
}

export interface RelayStatusView {
  readonly live: RelayLiveStatus;
  readonly config: { readonly enabled: boolean; readonly url: string; readonly label: string; readonly requireStepUpForMutations: boolean };
  readonly flag: { readonly id: string; readonly name: string; readonly defaultState: string };
}

export interface RelayPairAnswer {
  readonly pairing: RelayPairing | null;
  readonly status: string;
  readonly codeId?: string;
  readonly codeName?: string;
}

/** A failed relay verb, with what failed, the host's reason and the next step. */
export interface RelayHostFailure {
  readonly what: string;
  readonly reason: string;
  readonly status?: number;
  readonly next: string;
}

export function relayHostFailure(what: string, error: unknown): RelayHostFailure {
  const reason = describeConnectedHostVerbError(error);
  const status = error instanceof ConnectedHostVerbError ? error.status : undefined;
  const notServed = error instanceof ConnectedHostVerbError && status === 404
    && (error.code === undefined || error.code === 'METHOD_NOT_FOUND' || error.code === 'NOT_FOUND');
  // No relay address anywhere: the relay could not be turned on, and that, not the daemon, is what to fix.
  const noAddress = error instanceof ConnectedHostVerbError && error.code === 'RELAY_URL_REQUIRED';
  const next = notServed ? 'Update GoodVibes on the connected host; it does not serve the relay verbs yet.'
    : noAddress ? 'Pair again and type the relay\'s wss:// address in the "Turn the relay on?" step.'
      : RELAY_HOST_NEXT;
  return { what, reason, ...(status === undefined ? {} : { status }), next };
}

function relayConnectFlagSummary(): RelayStatusView['flag'] {
  const feature = FEATURE_SETTINGS.find((entry) => entry.id === 'relay-connect');
  return {
    id: 'relay-connect',
    name: feature?.name ?? 'Outbound Zero-Knowledge Relay',
    defaultState: feature === undefined ? 'disabled' : feature.defaultEnabled ? 'enabled' : 'disabled',
  };
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

/** The host's live relay status beside this Agent's imported relay settings. Throws the verb's error. */
export async function readRelayStatus(
  verbs: AgentDaemonVerbCaller,
  config: { get(key: 'relay.enabled' | 'relay.url' | 'relay.label' | 'relay.requireStepUpForMutations'): unknown },
): Promise<RelayStatusView> {
  const live = await verbs.invoke<RelayLiveStatus>('relay.reachability.get', {});
  return {
    live,
    config: {
      enabled: config.get('relay.enabled') === true,
      url: String(config.get('relay.url') ?? ''),
      label: String(config.get('relay.label') ?? ''),
      requireStepUpForMutations: config.get('relay.requireStepUpForMutations') === true,
    },
    flag: relayConnectFlagSummary(),
  };
}

export function formatRelayStatus(view: RelayStatusView): string {
  const { live, config: local, flag } = view;
  return [
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
  ].join('\n');
}

/**
 * Mint a one-device relay pairing payload on the host, in one run (shared with the terminal app:
 * terminal-shell/relay-pairing-ask.ts). When the host's relay is off, `ask` puts the platform's
 * RELAY_TURN_ON_QUESTION (opening on No), with a field for the relay's wss:// address when none is
 * set; on yes the same `relay.pairing.mint` call saves the address, turns the relay on and waits for
 * the host's own "registered" answer before it mints. Throws the verb's error.
 */
export async function mintRelayPairing(
  verbs: AgentDaemonVerbCaller,
  name: string | undefined,
  options: { readonly ask?: ((configuredUrl: string) => Promise<RelayTurnOnAnswer>) | undefined; readonly url?: string | undefined } = {},
): Promise<RelayPairAnswer> {
  return await mintRelayPairingInOneRun<RelayPairAnswer>(
    <T>(method: string, input: Record<string, unknown>) => verbs.invoke<T>(method, input),
    { name, configuredUrl: options.url, ask: options.ask },
  );
}

/** The pairing payload as text, or why there is none and what to do. */
export function relayPairingOutcome(answer: RelayPairAnswer, words: RelayActionWords):
  | { readonly ok: true; readonly pairing: RelayPairing; readonly text: string }
  | { readonly ok: false; readonly error: string; readonly next: string } {
  if (!answer.pairing) {
    return answer.status === 'disabled'
      ? {
        ok: false,
        error: 'No relay pairing was made: the relay is off on the connected host, and it was left off.',
        next: `${words.pair} asks to turn it on when you want devices to reach this machine through the relay.`,
      }
      : {
        ok: false,
        error: `No relay pairing was made: the connected host could not register with the relay (relay status ${answer.status}).`,
        next: `${words.status} says why.`,
      };
  }
  const pairing = answer.pairing;
  return {
    ok: true,
    pairing,
    text: [
      'GoodVibes relay pairing (from the connected host)',
      `  relay URL: ${pairing.relayUrl ?? '(not given)'}`,
      `  rendezvous id: ${pairing.rid ?? '(not given)'}`,
      `  daemon public key: ${pairing.daemonPublicKey ?? '(not given)'}`,
      ...(pairing.protocol ? [`  protocol: ${pairing.protocol}`] : []),
      `  relay code: ${answer.codeName ?? 'this device'}${answer.codeId ? ` (${answer.codeId})` : ''}, for one device only`,
      '',
      `  payload ${JSON.stringify(pairing)}`,
      '',
      `  ${words.codes} lists the devices; ${words.revoke} cuts one off the relay at its next request.`,
    ].join('\n'),
  };
}

/** The host's relay codes, one per device paired through the relay. Throws the verb's error. */
export async function listRelayCodes(verbs: AgentDaemonVerbCaller): Promise<readonly RelayCodeView[]> {
  const answer = await verbs.invoke<{ readonly codes: readonly RelayCodeView[] }>('relay.codes.list', {});
  return Array.isArray(answer?.codes) ? answer.codes : [];
}

/** Revoke one relay code on the host. Throws the verb's error. */
export async function revokeRelayCode(verbs: AgentDaemonVerbCaller, id: string): Promise<string> {
  await verbs.invoke('relay.codes.revoke', { id });
  return `Relay code ${id} revoked: that device is refused at its next request through the relay. Pair it again on the home network to restore it.`;
}
