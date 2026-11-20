/**
 * `/accounts`, described once (command-actions/): your model provider accounts,
 * how each is reached and how to fix one, and signing in to or out of a
 * GoodVibes daemon or listener. Both terminal apps register this one
 * description; how the snapshot is read, how a report is worded and whether
 * this app holds service sessions at all are each app's policy, read by the
 * actions' `run`.
 */
import type { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionValues, CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';

interface AccountContext extends CommandActionContext {
  readonly provider: { readonly providerRegistry: Pick<ProviderRegistry, 'listProviders'> };
}
interface AccountRecord {
  readonly providerId: string;
}
interface AccountSnapshot<Record extends AccountRecord> {
  readonly providers: readonly Record[];
}

/** Where a daemon or listener session is signed in or out, as typed or chosen. */
export interface ServiceSignIn {
  readonly service: 'daemon' | 'listener';
  readonly address: string;
  readonly user: string;
  readonly password: string;
  /** The secret-store name a listener session is kept under; empty for the usual one. */
  readonly key: string;
}
export type ServiceSignOut = Omit<ServiceSignIn, 'user' | 'password'>;

const ACCOUNT_PROVIDERS = defineList<AccountContext>({
  name: 'accounts.providers',
  async read(ctx) {
    return ctx.provider.providerRegistry.listProviders().map((provider): ListRow => ({ value: provider.name, label: provider.name }));
  },
  operator: { method: 'accounts.snapshot', input: {}, rows: { from: 'providers', value: 'providerId', label: 'providerId' } },
});

const SERVICES: readonly FixedChoice[] = [
  { value: 'daemon', label: 'A daemon', help: 'The GoodVibes service that runs sessions, on this machine or another' },
  { value: 'listener', label: 'A listener', help: 'A GoodVibes listener that receives messages from channels' },
];

const PROVIDER: InputDescription = {
  id: 'provider', label: 'Provider', help: 'The model providers you have', kind: 'choice',
  choices: { list: ACCOUNT_PROVIDERS }, required: true, typed: { position: 1 },
};
const SERVICE: InputDescription = {
  id: 'service', label: 'Service', help: 'A daemon or a listener', kind: 'choice', choices: SERVICES, required: true, typed: { position: 1 },
};
const ADDRESS: InputDescription = {
  id: 'address', label: 'Address', help: 'Its web address, such as https://host.example:3421', kind: 'text',
  freeTextReason: 'the address the service answers at', required: true, typed: { position: 2 },
};
const KEY: InputDescription = {
  id: 'key', label: 'Kept as', help: 'The name a listener session is kept under in your secret store', kind: 'text',
  freeTextReason: 'a secret name you choose', required: { default: '', defaultMeans: 'LISTENER_SESSION_TOKEN' },
  typed: { flag: '--key' }, showWhen: { input: 'service', is: 'listener' },
};

/** Snapshot acquisition, wording and service sessions remain tied to the calling product's authority. */
export function createProviderAccountCommands<
  Context extends AccountContext,
  Record extends AccountRecord,
  Snapshot extends AccountSnapshot<Record>,
>(policy: {
  readonly load: (context: Context) => Promise<Snapshot>;
  readonly open: (context: Context) => void;
  readonly unknown: (providerId: string) => string;
  readonly routes: (record: Record) => string[];
  readonly repair: (record: Record) => string[];
  readonly show: (record: Record) => string[];
  readonly review: (snapshot: Snapshot) => string[];
  readonly afterRepair?: ((context: Context, record: Record) => void) | undefined;
  readonly afterShow?: ((context: Context, record: Record) => void) | undefined;
  /** Sign in to a daemon or listener; prints what happened, or throws a refusal. */
  readonly signIn: (context: Context, input: ServiceSignIn) => Promise<void>;
  readonly signOut: (context: Context, input: ServiceSignOut) => Promise<void>;
}) {
  async function recordOf(ctx: Context, values: ActionValues): Promise<Record> {
    const snapshot = await policy.load(ctx);
    const record = snapshot.providers.find((entry) => entry.providerId === values.provider);
    if (!record) throw commandRefusal(policy.unknown(values.provider!), '/accounts review lists your provider accounts.');
    return record;
  }
  const description: CommandDescription<Context> = {
    name: 'accounts',
    title: 'Accounts',
    summary: 'Your model provider accounts, and signing in to a GoodVibes daemon or listener',
    group: 'Models',
    report: 'see-accounts',
    actions: [
      {
        id: 'see-accounts', label: 'See your provider accounts', word: 'review', inputs: [],
        sentence: 'Shows each model provider, how it is reached now and which way is preferred, how fresh its sign-in is, and anything wrong.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'accounts.snapshot', fields: {} }, example: {},
        async run(_values, ctx) {
          return policy.review(await policy.load(ctx)).join('\n');
        },
      },
      {
        id: 'see-account', label: 'See one provider\'s account', word: 'show', inputs: [PROVIDER],
        sentence: 'Shows {provider}\'s account: each way it can be reached, its sign-in, usage windows and what to do next.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'accounts.snapshot', fields: {} }, example: { provider: 'openai' },
        async run(values, ctx) {
          const record = await recordOf(ctx, values);
          ctx.print(policy.show(record).join('\n'));
          policy.afterShow?.(ctx, record);
        },
      },
      {
        id: 'see-routes', label: 'See how a provider is reached', word: 'routes', inputs: [PROVIDER],
        sentence: 'Shows each way {provider} can be reached (a key, a subscription, a local server), whether it works, and why one is used.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'accounts.snapshot', fields: {} }, example: { provider: 'openai' },
        async run(values, ctx) {
          return policy.routes(await recordOf(ctx, values)).join('\n');
        },
      },
      {
        id: 'fix-account', label: 'See how to fix a provider\'s account', word: 'repair', inputs: [PROVIDER],
        sentence: 'Shows what is wrong with {provider}\'s account and the steps that fix it.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'accounts.snapshot', fields: {} }, example: { provider: 'openai' },
        async run(values, ctx) {
          const record = await recordOf(ctx, values);
          ctx.print(policy.repair(record).join('\n'));
          policy.afterRepair?.(ctx, record);
        },
      },
      {
        id: 'open-screen', label: 'Open the providers screen', word: 'open', inputs: [],
        sentence: 'Opens the full-screen view of your providers and their accounts.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { terminalOnly: 'It is a terminal screen.' }, example: {},
        async run(_values, ctx) {
          policy.open(ctx);
        },
      },
      {
        id: 'sign-in', label: 'Sign in to a daemon or listener', word: 'sign-in',
        inputs: [
          SERVICE,
          ADDRESS,
          { id: 'user', label: 'User name', help: 'The name you sign in with there', kind: 'text', freeTextReason: 'your user name on that service', required: true, typed: { flag: '--user' } },
          { id: 'password', label: 'Password', help: 'Hidden as you type; sent only to the address you gave', kind: 'secret', required: true, typed: { flag: '--password' } },
          KEY,
        ],
        sentence: 'Your password for {user} will be sent to {address} to sign in to the {service}; the session it gives is kept until you change it (signing out ends it).',
        done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'sends-out', undoneBy: 'sign-out',
        operator: { terminalOnly: 'A session is kept by the terminal app that signs in.' },
        example: { service: 'daemon', address: 'https://host.example:3421', user: 'sam' },
        async run(values, ctx) {
          if (!values.password) throw commandRefusal('Not signed in: no password was given.');
          await policy.signIn(ctx, { service: values.service as ServiceSignIn['service'], address: values.address!, user: values.user!, password: values.password, key: values.key ?? '' });
        },
      },
      {
        id: 'sign-out', label: 'Sign out of a daemon or listener', word: 'sign-out', inputs: [SERVICE, ADDRESS, KEY],
        sentence: 'The {service} at {address} will be asked to end your session, and this terminal forgets it, until you change it (signing in starts a new one).',
        done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'sign-in',
        operator: { terminalOnly: 'A session is kept by the terminal app that signed in.' },
        example: { service: 'daemon', address: 'https://host.example:3421' },
        async run(values, ctx) {
          await policy.signOut(ctx, { service: values.service as ServiceSignIn['service'], address: values.address!, key: values.key ?? '' });
        },
      },
    ],
  };
  const command = defineCommand(description);
  function registerProviderAccountsRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register(command);
  }
  return { registerProviderAccountsRuntimeCommands };
}
