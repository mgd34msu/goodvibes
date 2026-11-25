/**
 * `/secrets`, described once (command-actions/): store, point at, check, test,
 * use and delete secrets, see how they are stored, and use one for this
 * session only. Both terminal apps register this one description; what differs
 * between them (which tier a credential is filed in) is the app's policy, read
 * by the actions' `run`, never by the words.
 */
import {
  isGoodVibesSecretReferenceValue as isGoodVibesSecretRefInput,
  isMalformedGoodVibesSecretReferenceValue as isMalformedGoodVibesSecretRefInput,
} from '@goodvibes/engine/platform/platform/config';
export { isGoodVibesSecretRefInput, isMalformedGoodVibesSecretRefInput };
import {
  BUILTIN_SECRET_PROVIDER_SOURCES,
  describeSecretRef,
  resolveSecretRef,
  unreadableSecretStore,
  type SecretsManager,
  type SecretScope,
  type SecretStorageMedium,
} from '@goodvibes/engine/platform/platform/config';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { daemonCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { SECRETS_SET } from '@goodvibes/engine/platform/platform/capabilities';
import type { CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';

type SecretsStore = Pick<SecretsManager, 'get' | 'set' | 'delete' | 'listDetailed' | 'inspect'> & Partial<Pick<SecretsManager, 'confirmProjectSecret' | 'getSecretProviderHostConfig' | 'getStored'>>;

export interface SecretsCommandContext extends CommandActionContext {
  readonly platform: { readonly secretsManager?: SecretsStore | null | undefined };
}

/** What differs between the two apps: where a credential is filed and what is said about it. */
export interface SecretsCommandPolicy {
  /** The scope a write lands in for this key (the Agent files daemon-read credentials in the daemon tier). */
  readonly writeScope: (key: string, requested: SecretScope) => SecretScope;
  readonly deleteScope: (key: string, requested: SecretScope | undefined) => SecretScope | undefined;
  /** One more line when the write landed somewhere other than where it was asked. */
  readonly relocationNote: (key: string, requested: SecretScope) => string;
}

function storeOf(ctx: SecretsCommandContext): SecretsStore {
  const store = ctx.platform.secretsManager;
  if (!store) throw commandRefusal('Secrets are not available in this session.', 'Restart the app; the secret store loads with it.');
  return store;
}

const REFERENCE_EXAMPLES = [
  'OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY',
  'SLACK_BOT_TOKEN goodvibes://secrets/bitwarden?item=GoodVibes%20Slack&field=password',
  'SLACK_BOT_TOKEN goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test',
  'STRIPE_TOKEN goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value',
  'OPENAI_API_KEY goodvibes://secrets/1password?vault=Private&item=GoodVibes%20OpenAI&field=API%20Key',
];

const TERMINAL_ONLY = { terminalOnly: 'Secrets are kept by the app that reads them; manage them in a terminal app.' } as const;

// ---------------------------------------------------------------------------
// Live lists, read only when a guided step or a completion asks
// ---------------------------------------------------------------------------

function whereKept(record: { readonly source: string; readonly refSource?: string | undefined; readonly overriddenByEnv: boolean; readonly unconfirmed?: true | undefined }): string {
  return [
    record.source,
    ...(record.refSource ? [`points at ${record.refSource}`] : []),
    ...(record.overriddenByEnv ? ['an environment variable overrides it'] : []),
    ...(record.unconfirmed ? ['not used until you confirm it'] : []),
  ].join(', ');
}

const STORED_SECRETS = defineList<SecretsCommandContext>({
  name: 'secrets.stored',
  async read(ctx) {
    const records = (await storeOf(ctx).listDetailed()).filter((record) => record.source !== 'env');
    const byKey = new Map<string, ListRow>();
    for (const record of records) {
      const known = byKey.get(record.key);
      byKey.set(record.key, { value: record.key, label: record.key, state: known?.state ? `${known.state}; ${whereKept(record)}` : whereKept(record) });
    }
    return [...byKey.values()];
  },
  operator: TERMINAL_ONLY,
});

const UNCONFIRMED_SECRETS = defineList<SecretsCommandContext>({
  name: 'secrets.unconfirmed',
  async read(ctx) {
    return (await storeOf(ctx).listDetailed()).filter((record) => record.unconfirmed).map((record): ListRow => ({
      value: record.key, label: record.key, ...(record.path ? { detail: record.path } : {}), state: 'not used until you confirm it',
    }));
  },
  operator: TERMINAL_ONLY,
});

const SCOPES: readonly FixedChoice[] = [
  { value: 'project', label: 'This project', help: 'Kept in this project\'s secret store, read only here.' },
  { value: 'user', label: 'All your projects', help: 'Kept in your own secret store, read in every project.' },
];
const MEDIA: readonly FixedChoice[] = [
  { value: 'secure', label: 'Encrypted', help: 'Kept encrypted on this machine.' },
  { value: 'plaintext', label: 'Plain text', help: 'Kept readable by anything that can read the file.', risk: 'loosens-a-protection' },
];

const KEY_STORED: InputDescription = {
  id: 'key', label: 'Secret', help: 'The secrets you have stored', kind: 'choice',
  choices: { list: STORED_SECRETS }, required: true, typed: { position: 1 },
};
const KEY_NEW: InputDescription = {
  id: 'key', label: 'Name', help: 'The name programs read it by, such as OPENAI_API_KEY', kind: 'choice',
  choices: { list: STORED_SECRETS, allowOther: { reason: 'a new name, such as OPENAI_API_KEY' } }, required: true, typed: { position: 1 },
};
const SCOPE: InputDescription = {
  id: 'scope', label: 'Where to keep it', help: 'This project only, or every project', kind: 'choice', choices: SCOPES,
  required: { default: 'project', defaultMeans: 'this project only' }, typed: { flag: '--scope' },
};
const MEDIUM: InputDescription = {
  id: 'storage', label: 'How to keep it', help: 'Encrypted, or as plain text', kind: 'choice', choices: MEDIA,
  required: { default: 'secure', defaultMeans: 'encrypted' }, typed: { flag: '--storage' },
};
const REFERENCE: InputDescription = {
  id: 'reference', label: 'Reference', help: 'A goodvibes://secrets/... address of a password manager entry or variable', kind: 'text',
  freeTextReason: 'the address of an entry in your password manager (see "See where secrets can come from")', required: true, typed: { position: 2 },
};

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

function describeSecrets<Ctx extends SecretsCommandContext>(policy: SecretsCommandPolicy, binding: DaemonCapabilityBinding<Ctx>): CommandDescription<Ctx> {
  async function write(values: Readonly<Record<string, string>>, ctx: Ctx, value: string): Promise<string> {
    const key = values.key!;
    const requested = (values.scope || 'project') as SecretScope;
    const scope = policy.writeScope(key, requested);
    const medium = (values.storage || 'secure') as SecretStorageMedium;
    try {
      await storeOf(ctx).set(key, value, { scope, medium });
    } catch (error) {
      throw commandRefusal(`${key} was not stored: ${summarizeError(error)}`);
    }
    return policy.relocationNote(key, requested).trim();
  }
  return {
    name: 'secrets',
    title: 'Secrets',
    summary: 'Keep passwords and keys where programs can read them, without showing them',
    group: 'Setup',
    report: 'see-secrets',
    actions: [
      {
        id: 'see-secrets', label: 'See your secrets', readsOnlyThisMachine: true, word: 'list', inputs: [],
        async rowValue(ctx) {
          const keys = new Set((await storeOf(ctx).listDetailed()).filter((record) => record.source !== 'env').map((record) => record.key));
          return keys.size === 0 ? 'none stored yet' : `${keys.size} stored`;
        },
        sentence: 'Shows every stored secret by name, where it is kept and whether something overrides it; no value is shown.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none', operator: TERMINAL_ONLY, example: {},
        async run(_values, ctx) {
          const records = (await storeOf(ctx).listDetailed()).filter((record) => record.source !== 'env');
          if (records.length === 0) return 'No secrets stored yet. Store one with /secrets, "Store a secret".';
          return ['Stored secrets:', ...records.map((record) => `  ${record.key}  ${whereKept(record)}`)].join('\n');
        },
      },
      // Moved to the daemon (capabilities/builtin/secrets.ts): the daemon stores it, and the value goes nowhere else.
      daemonCapabilityAction<Ctx>(SECRETS_SET, binding),
      {
        id: 'link-secret', label: 'Point a secret at a password manager', word: 'link',
        inputs: [KEY_NEW, REFERENCE, SCOPE, MEDIUM],
        sentence: '{key} will be read from {reference}, kept in the {scope} secret store ({storage}), until you change it.',
        done: '{key} now reads from {reference}.',
        touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'delete-secret',
        operator: TERMINAL_ONLY, example: { key: 'OPENAI_API_KEY', reference: 'goodvibes://secrets/env/OPENAI_API_KEY' },
        async run(values, ctx) {
          if (!isGoodVibesSecretRefInput(values.reference!)) throw commandRefusal(`${values.reference} is not a secret reference; nothing was stored.`, '"See where secrets can come from" shows the reference forms.');
          return write(values, ctx, values.reference!);
        },
      },
      {
        id: 'check-secret', label: 'Check a secret is stored', word: 'get', inputs: [KEY_STORED],
        sentence: 'Says whether {key} is stored and can be read; its value is not shown.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none', operator: TERMINAL_ONLY, example: { key: 'OPENAI_API_KEY' },
        async run(values, ctx) {
          const value = await storeOf(ctx).get(values.key!);
          // A store this computer could not read is said as such, never as "not stored".
          const unreadable = value === null ? await unreadableSecretStore(storeOf(ctx), values.key!, values.key!) : null;
          if (unreadable) throw commandRefusal(unreadable);
          if (value === null) throw commandRefusal(`${values.key} is not stored.`, '/secrets list shows what is stored.');
          return `${values.key} is stored and can be read (value not shown).`;
        },
      },
      {
        id: 'test-reference', label: 'Test a secret reference', word: 'test',
        inputs: [{ ...REFERENCE, typed: { position: 1 } }],
        sentence: 'Reads {reference} once and says whether it gives a value; the value is not shown.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none', operator: TERMINAL_ONLY, example: { reference: 'goodvibes://secrets/env/OPENAI_API_KEY' },
        async run(values, ctx) {
          const reference = values.reference!;
          if (!isGoodVibesSecretRefInput(reference)) throw commandRefusal(`${reference} is not a secret reference.`, '"See where secrets can come from" shows the reference forms.');
          try {
            const result = await resolveSecretRef(reference, { resolveLocalSecret: (key) => storeOf(ctx).get(key), providers: storeOf(ctx).getSecretProviderHostConfig?.() });
            return `${describeSecretRef(reference)}: ${result.value !== null && !result.value.empty ? 'gives a value (not shown)' : 'gives nothing'}.`;
          } catch (error) {
            throw commandRefusal(`${describeSecretRef(reference)} could not be read: ${summarizeError(error)}`);
          }
        },
      },
      {
        id: 'see-sources', label: 'See where secrets can come from', word: 'providers', inputs: [],
        sentence: 'Lists the password managers and other places a secret can be read from, with a line for each.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none', operator: TERMINAL_ONLY, example: {},
        async run() {
          return [
            'A secret can be read from:',
            ...BUILTIN_SECRET_PROVIDER_SOURCES.map((source) => `  ${source}`),
            '',
            'For example:',
            ...REFERENCE_EXAMPLES.map((example) => `  /secrets link ${example}`),
          ].join('\n');
        },
      },
      {
        id: 'see-storage', label: 'See how secrets are kept', word: 'storage', inputs: [],
        sentence: 'Shows the storage rule, how many secrets are encrypted or plain text, and where each store is.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none', operator: TERMINAL_ONLY, example: {},
        async run(_values, ctx) {
          const review = await storeOf(ctx).inspect();
          const overridden = new Set((review.records ?? []).filter((record) => record.source !== 'env' && record.overriddenByEnv).map((record) => record.key)).size;
          return [
            'How secrets are kept',
            `  rule: ${review.policy.replace(/_/g, ' ')}`,
            `  stored: ${review.storedKeys} (${review.secureKeys} encrypted, ${review.plaintextKeys} plain text)`,
            `  overridden by an environment variable: ${overridden}`,
            ...review.locations.map((location) => `  ${location.source}: ${location.exists ? 'present' : 'absent'} (${location.path})`),
            ...review.warnings.map((warning) => `  warning: ${warning}`),
          ].join('\n');
        },
      },
      {
        id: 'trust-secret', label: 'Use a secret from this project\'s store', word: 'trust',
        inputs: [{ ...KEY_STORED, help: 'Secrets in this project\'s store that wait for you', choices: { list: UNCONFIRMED_SECRETS } }],
        sentence: '{key} from this project\'s secret store will be used whenever you have not set it yourself, until you change it (a changed value asks again).',
        done: '{key} from this project\'s secret store is used from now on.',
        touches: 'credential', lasts: 'kept', risk: 'loosens-a-protection',
        ownerOnly: { reason: 'a project\'s secret store is part of the checkout, so whoever wrote the repository may have put it there', instead: 'Ask the owner to choose "Use a secret from this project\'s store" in /secrets.' },
        operator: TERMINAL_ONLY, example: { key: 'OPENAI_API_KEY' },
        async run(values, ctx) {
          const store = storeOf(ctx);
          const key = values.key!;
          if (!store.confirmProjectSecret) throw commandRefusal(`Nothing was confirmed: this app does not read this project's secret store. Store ${key} with /secrets set ${key} --scope user.`);
          const confirmed = store.confirmProjectSecret(key);
          if (confirmed.length === 0) throw commandRefusal(`Nothing was confirmed: ${key} is not in this project's secret store.`, '/secrets list shows what is stored.');
          return confirmed.map((entry) => entry.pointsAt
            ? `  ${entry.path}: a pointer to ${describeSecretRef(entry.pointsAt)} inside this project's store`
            : `  ${entry.path}`).join('\n');
        },
      },
      {
        id: 'delete-secret', label: 'Delete a secret', word: 'delete',
        inputs: [
          KEY_STORED,
          { ...SCOPE, label: 'From', help: 'Which store to delete it from', required: { default: '', defaultMeans: 'every store that holds it' } },
          { ...MEDIUM, label: 'Kept as', help: 'Only the encrypted or only the plain-text copy', choices: MEDIA.map(({ risk: _risk, ...choice }) => choice), required: { default: '', defaultMeans: 'both' } },
        ],
        sentence: 'The stored value of {key} will be deleted; anything that reads it stops working until it is set again.',
        done: 'Deleted {key}.',
        touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
        operator: TERMINAL_ONLY, example: { key: 'OPENAI_API_KEY' },
        async run(values, ctx) {
          const requested = values.scope ? values.scope as SecretScope : undefined;
          try {
            await storeOf(ctx).delete(values.key!, {
              scope: policy.deleteScope(values.key!, requested),
              medium: values.storage ? values.storage as SecretStorageMedium : undefined,
            });
          } catch (error) {
            throw commandRefusal(`${values.key} was not deleted: ${summarizeError(error)}`);
          }
        },
      },
      {
        id: 'use-for-session', label: 'Use a secret for this session only', word: 'use',
        inputs: [
          { id: 'name', label: 'Name', help: 'The variable name programs read it by, such as GITHUB_TOKEN', kind: 'text', freeTextReason: 'a variable name you choose', required: true, typed: { position: 1 } },
          { id: 'value', label: 'Value', help: 'The password or key itself; hidden as you type', kind: 'secret', required: true, typed: { position: 2 } },
        ],
        sentence: 'Programs this app runs will read the value as ${name}, for this session only; it is not stored.',
        done: '${name} is set for this session only.',
        touches: 'credential', lasts: 'session', risk: 'none',
        operator: { terminalOnly: 'It is set in the terminal app\'s own session.' }, example: { name: 'GITHUB_TOKEN', value: 'example-value' },
        async run(values) {
          const name = values.name!.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
          if (!name) throw commandRefusal('A variable name holds letters, digits and underscores, such as GITHUB_TOKEN.');
          if (!values.value) throw commandRefusal(`${name} was not set: no value was given.`);
          process.env[name] = values.value;
          return `(${values.value.length} character${values.value.length === 1 ? '' : 's'}, value not shown${name !== values.name ? `; set as ${name}` : ''}.)`;
        },
      },
    ],
  };
}

/**
 * `/secrets` for one app: the one description, with the app's filing rule for
 * credentials and how it reaches the daemon (storing a secret runs there).
 */
export function createSecretsCommand<Ctx extends SecretsCommandContext>(policy: SecretsCommandPolicy, binding: DaemonCapabilityBinding<Ctx>): DescribedCommand<Ctx> {
  return defineCommand(describeSecrets<Ctx>(policy, binding));
}
