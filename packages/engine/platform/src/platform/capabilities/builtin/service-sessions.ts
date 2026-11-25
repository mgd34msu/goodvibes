/**
 * Signing this terminal program in to a GoodVibes daemon or listener, and out
 * again: the session it gets is this program's own credential toward that
 * service (kept per address beside its other bearers, or a listener's in its
 * secret store), so it stays with the program holding the conversation. The
 * Agent keeps no such session (it connects to a host that manages its own
 * sign-in), so it has no control for these.
 */
import type { CapabilityDefinition, FixedChoice, InputDescription } from '../types.js';

/** What a daemon or listener sign-in is given, as typed or chosen. */
export interface ServiceSessionRequest {
  readonly service: 'daemon' | 'listener';
  readonly address: string;
  readonly user: string;
  readonly password: string;
  /** The secret-store name a listener session is kept under; empty for the usual one. */
  readonly key: string;
}

/** The program's own sessions toward a daemon or listener; absent in a program that keeps none. */
export interface ServiceSessionServices {
  readonly serviceSessions?: {
    /** Sign in; the words of what happened. Throws a refusal when nothing was stored. */
    signIn(request: ServiceSessionRequest): Promise<string>;
    signOut(request: Omit<ServiceSessionRequest, 'user' | 'password'>): Promise<string>;
  } | undefined;
}

const SERVICES: readonly FixedChoice[] = [
  { value: 'daemon', label: 'A daemon', help: 'The GoodVibes service that runs sessions, on this machine or another' },
  { value: 'listener', label: 'A listener', help: 'A GoodVibes listener that receives messages from channels' },
];

const SERVICE: InputDescription = { id: 'service', label: 'Service', help: 'A daemon or a listener', kind: 'choice', choices: SERVICES, required: true, typed: { position: 1 } };
const ADDRESS: InputDescription = {
  id: 'address', label: 'Address', help: 'Its web address, such as https://host.example:3421', kind: 'text',
  freeTextReason: 'the address the service answers at', required: true, typed: { position: 2 },
};
const KEY: InputDescription = {
  id: 'key', label: 'Kept as', help: 'The name a listener session is kept under in your secret store', kind: 'text',
  freeTextReason: 'a secret name you choose', required: { default: '', defaultMeans: 'LISTENER_SESSION_TOKEN' },
  typed: { flag: '--key' }, showWhen: { input: 'service', is: 'listener' },
};

function sessions(services: ServiceSessionServices): NonNullable<ServiceSessionServices['serviceSessions']> {
  // A program without sessions shows no control for these (`available`); a model's run says so in the refusal.
  if (!services.serviceSessions) throw new Error('This program keeps no daemon or listener session: it connects to a host that manages its own sign-in.');
  return services.serviceSessions;
}

export const ACCOUNTS_SIGN_IN: CapabilityDefinition<ServiceSessionServices> = {
  capability: { id: 'accounts.sign-in', group: 'models', home: 'session', repeat: 'unsafe' },
  actionId: 'sign-in', label: 'Sign in to a daemon or listener', word: 'sign-in',
  inputs: [
    SERVICE,
    ADDRESS,
    { id: 'user', label: 'User name', help: 'The name you sign in with there', kind: 'text', freeTextReason: 'your user name on that service', required: true, typed: { flag: '--user' } },
    { id: 'password', label: 'Password', help: 'Hidden as you type; sent only to the address you gave', kind: 'secret', required: true, typed: { flag: '--password' } },
    KEY,
  ],
  sentence: 'Your password for {user} will be sent to {address} to sign in to the {service}; the session it gives is kept by this program until you change it (signing out ends it).',
  done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'sends-out', undoneBy: 'sign-out',
  example: { service: 'daemon', address: 'https://host.example:3421', user: 'sam' },
  available: (services) => services.serviceSessions !== undefined,
  async run(values, services) {
    const text = await sessions(services).signIn({
      service: values.service === 'listener' ? 'listener' : 'daemon', address: values.address!.trim(), user: values.user!.trim(), password: values.password ?? '', key: values.key ?? '',
    });
    return { text, data: { service: values.service, address: values.address } };
  },
};

export const ACCOUNTS_SIGN_OUT: CapabilityDefinition<ServiceSessionServices> = {
  capability: { id: 'accounts.sign-out', group: 'models', home: 'session', repeat: 'safe' },
  actionId: 'sign-out', label: 'Sign out of a daemon or listener', word: 'sign-out', inputs: [SERVICE, ADDRESS, KEY],
  sentence: 'The {service} at {address} will be asked to end your session, and this program forgets it, until you change it (signing in starts a new one).',
  done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'sign-in',
  example: { service: 'daemon', address: 'https://host.example:3421' },
  available: (services) => services.serviceSessions !== undefined,
  async run(values, services) {
    const text = await sessions(services).signOut({ service: values.service === 'listener' ? 'listener' : 'daemon', address: values.address!.trim(), key: values.key ?? '' });
    return { text, data: { service: values.service, address: values.address } };
  },
};
