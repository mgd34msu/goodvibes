/**
 * What this terminal program itself does about pairing: pairing something new
 * on its own screen (a phone by QR code, this program with a daemon on another
 * machine, a device through the relay, a chat channel), and this program's own
 * credential for reaching its daemon (seeing how it reaches it, forgetting it).
 * The credential is the program's own file (the terminal app's connected-host
 * credentials, the Agent's connected-host pairing), which no daemon can hold for
 * a client reaching it, so these run in the program holding the conversation.
 * Their controls are in the Devices and network place.
 */
import { CapabilityRefusal, type CapabilityDefinition, type CapabilityResult, type ListName } from '../types.js';

/**
 * A request to pair this program with its daemon: the one way a device becomes the owner's own. The owner starts it in person
 * on a screen where they are signed in as themselves (the web UI, or their own program on the daemon's machine: Devices and
 * network, Pair something, A phone or another device, "Show the sign-in code once"), and this program completes it
 * with that code. Nothing here asks the daemon to mint a key for whoever asks.
 */
export interface PairHostRequest {
  readonly name: string;
  /** The sign-in code the owner's own screen showed; empty: say how this program reaches its daemon and what to do. */
  readonly code: string;
}

/**
 * What pairing a device answers: its words, and the one-time link or code that signs the device in (with its QR code, when
 * it has one). The value is shown once, in the reveal pane; it is never in the words.
 */
export interface PairingAnswer {
  readonly text: string;
  readonly reveal?: { readonly value: string; readonly qr?: string | undefined } | undefined;
}

/** This program's pairing: each piece it has; a piece it lacks is absent and refused in words. */
export interface DevicesSessionServices {
  readonly pairing?: {
    pairDevice(name: string): Promise<string | void | PairingAnswer>;
    readonly pairHost?: ((request: PairHostRequest) => Promise<string | void>) | undefined;
    readonly pairRelay?: ((name: string) => Promise<string | PairingAnswer>) | undefined;
    readonly pairChannel?: ((channel: string) => Promise<string | void>) | undefined;
    readonly hostStatus?: (() => Promise<string>) | undefined;
    readonly unpairHost?: (() => Promise<string>) | undefined;
  } | undefined;
}

type Pairing = NonNullable<DevicesSessionServices['pairing']>;

function pairingOf(services: DevicesSessionServices): Pairing {
  if (!services.pairing) throw new CapabilityRefusal('This program pairs nothing here: it has no screen of its own to pair on.');
  return services.pairing;
}

function piece<K extends keyof Pairing>(pairing: Pairing, key: K, what: string): NonNullable<Pairing[K]> {
  const found = pairing[key];
  if (!found) throw new CapabilityRefusal(`${what} is not something this program does.`);
  return found as NonNullable<Pairing[K]>;
}

/** The daemon's channels, as the channel setup chooses from them (terminal-shell channels-command.ts). */
const CHANNELS = 'channels' as ListName;

export const DEVICES_PAIR: CapabilityDefinition<DevicesSessionServices> = {
  capability: { id: 'devices.pair', group: 'devices', home: 'session', repeat: 'unsafe' },
  actionId: 'pair', label: 'Pair something', word: 'pair',
  inputs: [
    { id: 'what', label: 'What to pair', help: 'A phone or another device, this program with its daemon, a device through the relay, or a chat channel', kind: 'choice',
      choices: [
        { value: 'device', label: 'A phone or another device', help: 'Shows a QR code; the device gets its own token' },
        { value: 'host', label: 'This program with its daemon', help: 'For a daemon on another machine: with the sign-in code your own screen shows, where you are signed in as yourself' },
        { value: 'relay', label: 'A device through the relay', help: 'Reaches the daemon from outside your network' },
        { value: 'channel', label: 'A chat channel', help: 'Slack, Telegram, Discord, ...: opens its row in Mail, calendar and channels, where its keys are entered' },
      ],
      required: true, typed: { position: 1 }, step: 1 },
    { id: 'channel', label: 'Channel', help: 'The channel to set up', kind: 'choice', choices: { list: CHANNELS, allowOther: { reason: 'a channel kind (slack, telegram, discord, ntfy, webhook, ...)' } },
      required: { default: '', defaultMeans: 'none' }, typed: { position: 2 }, showWhen: { input: 'what', is: 'channel' }, step: 2 },
    { id: 'name', label: 'Name', help: 'What to call it in the device list', kind: 'text', freeTextReason: 'a name you choose',
      required: { default: '', defaultMeans: 'a name chosen for it' }, typed: { flag: '--name' }, step: 2 },
    { id: 'code', label: 'Sign-in code', help: 'The code your own screen shows, where you are signed in as yourself: Devices and network, Pair something, A phone or another device, "Show the sign-in code once"; hidden as you type. Leave it empty to see how this program reaches its daemon', kind: 'secret',
      required: { default: '', defaultMeans: 'none: say how this program reaches its daemon' }, typed: { flag: '--code' }, showWhen: { input: 'what', is: 'host' }, step: 2 },
  ],
  sentence: 'The {what} you chose is paired and may reach the daemon, until you change it.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none',
  ownerOnly: { reason: 'pairing gives something new access to the daemon', instead: 'The Devices and network place lists what is paired.' },
  // A phone's or a relay device's link and QR code sign it in: shown once in the pane, never in the words.
  reveals: { label: 'Pairing link', note: 'Scan the QR code with the device, or open the link on it. The link signs one device in: it is shown this once here.' },
  example: { what: 'device' },
  async run(values, services) {
    const pairing = pairingOf(services);
    const name = values.name?.trim() ?? '';
    const answered = (said: string | void | PairingAnswer, otherwise: string): CapabilityResult => {
      if (said !== null && typeof said === 'object') return { text: said.text || otherwise, ...(said.reveal ? { reveal: said.reveal } : {}) };
      return { text: said || otherwise };
    };
    if (values.what === 'device') return answered(await pairing.pairDevice(name), 'A pairing offer was made for a phone or another device.');
    if (values.what === 'host') {
      return answered(await piece(pairing, 'pairHost', 'Pairing this program with its daemon')({ name, code: values.code?.trim() ?? '' }), 'This program is paired with its daemon.');
    }
    if (values.what === 'relay') return answered(await piece(pairing, 'pairRelay', 'Pairing a device through the relay')(name), 'A pairing code was made for a device through the relay.');
    if (!values.channel) throw new CapabilityRefusal('Name the channel to pair.', 'Choose the channel under Channel.');
    return answered(await piece(pairing, 'pairChannel', 'Setting up a channel')(values.channel), `Opened the row of ${values.channel} in Mail, calendar and channels, where its keys are entered.`);
  },
};

export const DEVICES_HOST_STATUS: CapabilityDefinition<DevicesSessionServices> = {
  capability: { id: 'devices.host-status', group: 'devices', home: 'session', repeat: 'safe' },
  actionId: 'host-status', label: 'See how this terminal connects to its daemon', word: 'host-status', inputs: [],
  sentence: 'Shows how this terminal program connects to its daemon: a device pairing it holds for a daemon on another machine, or this machine\'s operator token.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.pairing?.hostStatus !== undefined,
  async run(_values, services) {
    return { text: await piece(pairingOf(services), 'hostStatus', 'Reading this program\'s host pairing')() };
  },
};

export const DEVICES_UNPAIR_HOST: CapabilityDefinition<DevicesSessionServices> = {
  capability: { id: 'devices.unpair-host', group: 'devices', home: 'session', repeat: 'safe' },
  actionId: 'unpair-host', label: 'Forget this terminal\'s daemon pairing', word: 'unpair-host', inputs: [],
  sentence: 'This terminal program forgets its credential for its daemon and cannot reach that daemon until you pair it again, until you change it.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'pair',
  ownerOnly: { reason: 'it cuts this terminal off from its daemon', instead: 'See how this terminal connects to its daemon, in the Devices and network place.' },
  example: {},
  available: (services) => services.pairing?.unpairHost !== undefined,
  async run(_values, services) {
    return { text: await piece(pairingOf(services), 'unpairHost', 'Forgetting this program\'s host pairing')() };
  },
};

/** This program's pairing capabilities, in the order a person meets them. */
export const DEVICES_SESSION_CAPABILITIES: readonly CapabilityDefinition<DevicesSessionServices>[] = [DEVICES_PAIR, DEVICES_HOST_STATUS, DEVICES_UNPAIR_HOST];
