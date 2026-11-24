/**
 * relay-pairing-ask.ts, relay pairing in one run for both terminal apps.
 *
 * Pairing a device through the relay when the host's relay is off asks once,
 * opening on No, the platform's RELAY_TURN_ON_QUESTION. When no relay address
 * is set, the same ask carries a field for it (its shape checked as it is
 * typed). On yes the host's one method (`relay.pairing.mint` with `turnOn` and
 * `url`) saves the address, turns the relay on, waits for the host's own
 * "registered" answer and mints, in the same call. Nothing here waits on a
 * clock or asks a second time.
 */
import { RELAY_TURN_ON_QUESTION } from '@goodvibes/engine/platform/platform/relay';
import type { ConfirmOptions } from './confirm-dialog-types.js';

/** What a relay is and where its address comes from, in one line. */
export const RELAY_ADDRESS_HELP =
  'A relay passes encrypted traffic between your devices and this machine when they are not on the same network; its address (wss://…) comes from whoever runs the relay you use.';

/** Why `value` is not a relay address, or null when it is one (wss://host[:port][/path]). */
export function relayAddressProblem(value: string): string | null {
  const text = value.trim();
  if (text === '') return 'Type the relay\'s address, starting with wss://.';
  if (!/^wss:\/\//i.test(text)) return 'A relay address starts with wss://.';
  try {
    const url = new URL(text);
    if (url.hostname === '') return 'The address needs a host name after wss://.';
  } catch {
    return 'That is not a complete address yet.';
  }
  return null;
}

/** The person's answer: turn the relay on (with the address typed, when one was asked for), or not. */
export interface RelayTurnOnAnswer {
  readonly turnOn: boolean;
  readonly url?: string | undefined;
}

/** The ordinary ask (opening on No), with the address field when `configuredUrl` is empty. */
export async function askToTurnOnRelay(
  confirm: (options: ConfirmOptions) => Promise<boolean>,
  configuredUrl: string,
): Promise<RelayTurnOnAnswer> {
  let typed = '';
  const needsAddress = configuredUrl.trim() === '';
  const yes = await confirm({
    title: 'Turn the relay on?',
    body: `${RELAY_TURN_ON_QUESTION}\nDevices you pair could then reach this machine from outside your network through the relay, which sees only encrypted traffic. It stays on until you turn it off.`,
    confirmLabel: 'Turn the relay on',
    cancelLabel: 'Leave it off',
    tone: 'warning',
    ...(needsAddress ? {
      field: {
        label: 'Relay address',
        help: RELAY_ADDRESS_HELP,
        check: relayAddressProblem,
        onValue: (value: string) => { typed = value.trim(); },
      },
    } : {}),
  });
  return yes ? { turnOn: true, ...(needsAddress ? { url: typed } : {}) } : { turnOn: false };
}

/** What `relay.pairing.mint` answers. */
export interface RelayPairingMintAnswer {
  readonly pairing: unknown;
  readonly status: string;
  readonly codeId?: string | undefined;
  readonly codeName?: string | undefined;
}

/**
 * One run: the host's relay state (`relay.reachability.get`), the ask when it
 * is off, then `relay.pairing.mint` (with `turnOn` and the address on yes).
 * Without `ask` (a script) the mint is called as things stand.
 */
export async function mintRelayPairingInOneRun<Answer extends RelayPairingMintAnswer>(
  invoke: <T>(method: string, input: Record<string, unknown>) => Promise<T>,
  options: {
    readonly name?: string | undefined;
    readonly configuredUrl?: string | undefined;
    readonly ask?: ((configuredUrl: string) => Promise<RelayTurnOnAnswer>) | undefined;
  },
): Promise<Answer> {
  let answer: RelayTurnOnAnswer = { turnOn: false };
  const configuredUrl = options.configuredUrl?.trim() ?? '';
  if (options.ask) {
    const live = await invoke<{ readonly status?: unknown }>('relay.reachability.get', {});
    if (live.status === 'disabled') answer = await options.ask(configuredUrl);
  }
  const url = answer.url || configuredUrl;
  return await invoke<Answer>('relay.pairing.mint', {
    ...(options.name ? { name: options.name } : {}),
    ...(answer.turnOn ? { turnOn: true, ...(url ? { url } : {}) } : {}),
  });
}
