/**
 * Storing a secret, done by the daemon. "All your projects" is the daemon's
 * own store (`~/.goodvibes/daemon/secrets.enc`), which every GoodVibes
 * program on this machine reads first; "This project" is the project store
 * the asking program reads (`<project>/.goodvibes/<program>/secrets.enc`). The
 * value goes into the store and nowhere else: never into an answer, a log or
 * a line on screen.
 */
import { isGoodVibesSecretReferenceValue, isMalformedGoodVibesSecretReferenceValue } from '../../config/secret-backed-config.js';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, resolveSecretRef } from '../../config/secret-refs.js';
import { unreadableSecretStore } from '../../config/secret-store-unreadable.js';
import { resolveSecretDeleteScope, type SecretsManager } from '../../config/secrets.js';
import { listDaemonNeededKeyPrefixes, listExactDaemonNeededKeys } from '../../config/credential-scope-registry.js';
import type { SecretScope, SecretStorageMedium } from '../../config/secrets-store-paths.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

/** The stores the asking program reads: the daemon's first, then the program's own and its project's. */
export type SecretsView = Pick<SecretsManager, 'listDetailed' | 'get' | 'getStored' | 'inspect' | 'delete' | 'confirmProjectSecret' | 'getSecretProviderHostConfig'>;

/** What the secrets capabilities need: the store a write of a scope lands in for the caller, and the stores it reads. */
export interface SecretsCapabilityServices {
  readonly secrets: {
    /** `key` decides it too: a key the daemon itself reads is kept in the daemon's store whatever scope is asked. */
    writerFor(scope: 'project' | 'user', caller: CapabilityCaller, key: string): {
      set(key: string, value: string, options: { readonly scope: SecretScope; readonly medium: SecretStorageMedium }): Promise<void>;
      /** The scope written (`daemon` for "All your projects"). */
      readonly scope: SecretScope;
      /** Where it is kept, in words, for the answer. */
      readonly where: string;
    };
    /** Every store the asking program reads, in its order (the daemon's own when no program asked). */
    viewFor(caller: CapabilityCaller): SecretsView;
    /** Told after a write or a delete, so every screen showing the secrets reads them again. */
    changed(key: string, change: 'created' | 'changed' | 'deleted'): void;
  };
}

/** What using a secret for this session needs: the environment of the program holding the conversation. */
export interface SecretsSessionServices {
  readonly environment?: { set(name: string, value: string): void } | undefined;
}

/** The stored secrets by name (the terminal's list reads them where they are kept). */
export const STORED_SECRETS_LIST = 'secrets.stored' as ListName;
/** The secrets in this project's store that wait for the owner to confirm them. */
export const UNCONFIRMED_SECRETS_LIST = 'secrets.unconfirmed' as ListName;

const SCOPES: readonly FixedChoice[] = [
  { value: 'project', label: 'This project', help: 'Kept in this project\'s secret store, read only here.' },
  { value: 'user', label: 'All your projects', help: 'Kept in the daemon\'s secret store, which every GoodVibes program on this machine reads first.' },
];

/**
 * The keys the daemon itself reads (a channel's token, a provider's key it runs with): it keeps them in its own store,
 * for every project, whatever scope is asked, so "This project" is not offered for them and the words say where they go.
 */
const DAEMON_HELD_KEYS: readonly string[] = [...new Set(listExactDaemonNeededKeys())].sort();
/** The families of keys the daemon reads, declared by their start (`GOODVIBES_PAYMENTS_CARD_<card>`): held the same way. */
const DAEMON_HELD_KEY_PREFIXES: readonly string[] = [...new Set(listDaemonNeededKeyPrefixes())].sort();
const DAEMON_HELD_SENTENCE = '{key} is read by the daemon itself, so it will be kept in the daemon\'s secret store ({storage}), for every project, until you change it.';
const MEDIA: readonly FixedChoice[] = [
  { value: 'secure', label: 'Encrypted', help: 'Kept encrypted on this machine.' },
  { value: 'plaintext', label: 'Plain text', help: 'Kept readable by anything that can read the file.', risk: 'loosens-a-protection' },
];

export const SECRET_SCOPE_INPUT: InputDescription = {
  id: 'scope', label: 'Where to keep it', help: 'This project only, or every project', kind: 'choice', choices: SCOPES,
  required: { default: 'project', defaultMeans: 'this project only' }, typed: { flag: '--scope' },
  // Not asked for a key the daemon itself reads: it has one place, the daemon's store.
  showWhen: { input: 'key', isNoneOf: DAEMON_HELD_KEYS, startsWithNoneOf: DAEMON_HELD_KEY_PREFIXES },
};
export const SECRET_MEDIUM_INPUT: InputDescription = {
  id: 'storage', label: 'How to keep it', help: 'Encrypted, or as plain text', kind: 'choice', choices: MEDIA,
  required: { default: 'secure', defaultMeans: 'encrypted' }, typed: { flag: '--storage' },
};
export const SECRET_NEW_KEY_INPUT: InputDescription = {
  id: 'key', label: 'Name', help: 'The name programs read it by, such as OPENAI_API_KEY', kind: 'choice',
  choices: { list: STORED_SECRETS_LIST, allowOther: { reason: 'a new name, such as OPENAI_API_KEY' } }, required: true, typed: { position: 1 },
};
export const SECRET_SCOPE_CHOICES = SCOPES;
export const SECRET_MEDIUM_CHOICES = MEDIA;

export const SECRETS_SET: CapabilityDefinition<SecretsCapabilityServices> = {
  capability: { id: 'secrets.set', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'set-secret', label: 'Store a secret', word: 'set',
  inputs: [
    SECRET_NEW_KEY_INPUT,
    { id: 'value', label: 'Value', help: 'The password or key itself; hidden as you type', kind: 'secret', required: true, typed: { position: 2 } },
    SECRET_SCOPE_INPUT,
    SECRET_MEDIUM_INPUT,
  ],
  sentence: '{key} will be kept where you chose, {scope} ({storage}), until you change it.',
  sentenceWhen: { input: 'key', values: DAEMON_HELD_KEYS, startsWith: DAEMON_HELD_KEY_PREFIXES, sentence: DAEMON_HELD_SENTENCE },
  // Where it went is said by the run itself ("Kept in ..."), from the store that took it.
  done: 'Stored {key} ({storage}).',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'delete-secret',
  // Writing a credential: an admin's act, and never a model's (it is the owner who knows the value).
  effects: ['control-plane.write', 'secret.write'],
  example: { key: 'OPENAI_API_KEY', value: 'example-value', scope: 'user' },
  async run(values, services, caller) {
    const key = values.key!.trim();
    const value = values.value ?? '';
    if (!value) throw new CapabilityRefusal(`Nothing was stored: no value was given for ${key}.`);
    if (isMalformedGoodVibesSecretReferenceValue(value)) {
      throw new CapabilityRefusal('Nothing was stored: the value starts like a secret reference but is not one.', '"See where secrets can come from" shows the reference forms.');
    }
    const requested = values.scope === 'user' ? 'user' : 'project';
    const medium: SecretStorageMedium = values.storage === 'plaintext' ? 'plaintext' : 'secure';
    const writer = services.secrets.writerFor(requested, caller, key);
    try {
      await writer.set(key, value, { scope: writer.scope, medium });
    } catch (error) {
      // The store's own words, never the value.
      throw new CapabilityRefusal(`${key} was not stored: ${summarizeError(error).split(value).join('(not shown)')}`);
    }
    services.secrets.changed(key, 'changed');
    return { text: `Kept in ${writer.where}.`, data: { key, scope: requested, storage: medium, storedIn: writer.scope } };
  },
};

// ---------------------------------------------------------------------------
// The rest of the secrets: read, point at a password manager, check, test,
// confirm a project's own, delete (the daemon), and one for this session only
// (the program holding the conversation).
// ---------------------------------------------------------------------------

const REFERENCE_EXAMPLES = [
  'goodvibes://secrets/env/OPENAI_API_KEY',
  'goodvibes://secrets/bitwarden?item=GoodVibes%20Slack&field=password',
  'goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test',
  'goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value',
  'goodvibes://secrets/1password?vault=Private&item=GoodVibes%20OpenAI&field=API%20Key',
];

type StoredRecord = Awaited<ReturnType<SecretsView['listDetailed']>>[number];

/** A store, as a person says it. */
const SOURCE_WORDS: Readonly<Record<string, string>> = {
  'daemon-secure': 'the daemon\'s store, encrypted',
  'daemon-plaintext': 'the daemon\'s store, as plain text',
  'user-secure': 'this program\'s own store, encrypted',
  'user-plaintext': 'this program\'s own store, as plain text',
  'project-secure': 'this project\'s store, encrypted',
  'project-plaintext': 'this project\'s store, as plain text',
};

/** Where a stored secret is kept, in words: its store, what it points at, what overrides it, whether it waits. */
export function secretWhereKept(record: Pick<StoredRecord, 'source' | 'refSource' | 'overriddenByEnv' | 'unconfirmed'>): string {
  return [
    SOURCE_WORDS[record.source] ?? record.source,
    ...(record.refSource ? [`points at ${record.refSource}`] : []),
    ...(record.overriddenByEnv ? ['an environment variable overrides it'] : []),
    ...(record.unconfirmed ? ['not used until you confirm it'] : []),
  ].join(', ');
}

/** One stored secret by name, with every store that holds it: what a screen lists (never a value). */
export interface StoredSecretFacts {
  readonly key: string;
  /** Each store that holds it, in words. */
  readonly where: readonly string[];
  /** `waiting` while a project's own copy waits to be confirmed; `referenced` when it points at a password manager; else `stored`. */
  readonly state: 'stored' | 'referenced' | 'waiting';
  readonly overridden: boolean;
}

function storedFacts(records: readonly StoredRecord[]): StoredSecretFacts[] {
  const byKey = new Map<string, { where: string[]; referenced: boolean; waiting: boolean; overridden: boolean }>();
  for (const record of records) {
    if (record.source === 'env') continue;
    const held = byKey.get(record.key) ?? { where: [], referenced: false, waiting: false, overridden: false };
    held.where.push(secretWhereKept(record));
    held.referenced ||= Boolean(record.refSource);
    held.waiting ||= Boolean(record.unconfirmed);
    held.overridden ||= record.overriddenByEnv;
    byKey.set(record.key, held);
  }
  return [...byKey.entries()].map(([key, held]) => ({
    key, where: held.where, overridden: held.overridden,
    state: held.waiting ? 'waiting' : held.referenced ? 'referenced' : 'stored',
  }));
}

/** A store that could not be read is said as such, never as "nothing stored". */
async function listOrRefuse(view: SecretsView): Promise<StoredRecord[]> {
  try {
    return await view.listDetailed();
  } catch (error) {
    throw new CapabilityRefusal(`Your secrets could not be read: ${summarizeError(error)}`);
  }
}

const KEY_STORED: InputDescription = {
  id: 'key', label: 'Secret', help: 'The secrets you have stored', kind: 'choice',
  choices: { list: STORED_SECRETS_LIST }, required: true, typed: { position: 1 },
};
const REFERENCE: InputDescription = {
  id: 'reference', label: 'Reference', help: 'A goodvibes://secrets/... address of a password manager entry or variable', kind: 'text',
  freeTextReason: 'the address of an entry in your password manager (see "See where secrets can come from")', required: true, typed: { position: 2 },
};

export const SECRETS_LIST: CapabilityDefinition<SecretsCapabilityServices> = {
  capability: { id: 'secrets.list', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'see-secrets', label: 'See your secrets', word: 'list', inputs: [],
  sentence: 'Shows every stored secret by name, where it is kept and whether something overrides it; no value is shown.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const records = await listOrRefuse(services.secrets.viewFor(caller));
    const secrets = storedFacts(records);
    // The project's own copies that wait for the owner: the list "Use a secret from this project's store" chooses from.
    const waiting = records.filter((record) => record.unconfirmed).map((record) => ({ key: record.key, ...(record.path ? { path: record.path } : {}) }));
    const data = { secrets: secrets.map((secret) => ({ ...secret, detail: secret.where.join('; ') })), waiting };
    if (secrets.length === 0) return { text: 'No secrets stored yet.', data };
    return { text: ['Stored secrets:', ...secrets.map((secret) => `  ${secret.key}  ${secret.where.join('; ')}`)].join('\n'), data };
  },
};

export const SECRETS_LINK: CapabilityDefinition<SecretsCapabilityServices> = {
  capability: { id: 'secrets.link', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'link-secret', label: 'Point a secret at a password manager', word: 'link',
  inputs: [SECRET_NEW_KEY_INPUT, REFERENCE, SECRET_SCOPE_INPUT, SECRET_MEDIUM_INPUT],
  sentence: '{key} will be read from {reference}, kept where you chose, {scope} ({storage}), until you change it.',
  sentenceWhen: { input: 'key', values: DAEMON_HELD_KEYS, startsWith: DAEMON_HELD_KEY_PREFIXES,
    sentence: '{key} will be read from {reference}. The daemon itself reads it, so the reference is kept in the daemon\'s secret store ({storage}), for every project, until you change it.' },
  done: '{key} now reads from {reference}.',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'delete-secret',
  // It writes the secret store (which value a key reads from), as storing a secret does: the owner decides it for a
  // model, and it is his own act when a device asks.
  effects: ['control-plane.write', 'secret.write'],
  example: { key: 'OPENAI_API_KEY', reference: 'goodvibes://secrets/env/OPENAI_API_KEY' },
  async run(values, services, caller) {
    const key = values.key!.trim();
    const reference = values.reference!.trim();
    if (!isGoodVibesSecretReferenceValue(reference)) throw new CapabilityRefusal(`${reference} is not a secret reference; nothing was stored.`, '"See where secrets can come from" shows the reference forms.');
    const requested = values.scope === 'user' ? 'user' : 'project';
    const medium: SecretStorageMedium = values.storage === 'plaintext' ? 'plaintext' : 'secure';
    const writer = services.secrets.writerFor(requested, caller, key);
    try {
      await writer.set(key, reference, { scope: writer.scope, medium });
    } catch (error) {
      throw new CapabilityRefusal(`${key} was not stored: ${summarizeError(error)}`);
    }
    services.secrets.changed(key, 'changed');
    return { text: `Kept in ${writer.where}.`, data: { key, scope: requested, storage: medium, storedIn: writer.scope } };
  },
};

export const SECRETS_GET: CapabilityDefinition<SecretsCapabilityServices> = {
  capability: { id: 'secrets.get', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'check-secret', label: 'Check a secret is stored', word: 'get', inputs: [KEY_STORED],
  sentence: 'Says whether {key} is stored and can be read; its value is not shown.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { key: 'OPENAI_API_KEY' },
  async run(values, services, caller) {
    const key = values.key!.trim();
    const view = services.secrets.viewFor(caller);
    let value: unknown;
    try {
      value = await view.get(key);
    } catch (error) {
      throw new CapabilityRefusal(`${key} could not be read: ${summarizeError(error)}`);
    }
    // A store this computer could not read is said as such, never as "not stored".
    const unreadable = value === null ? await unreadableSecretStore(view, key, key) : null;
    if (unreadable) throw new CapabilityRefusal(unreadable);
    if (value === null) throw new CapabilityRefusal(`${key} is not stored.`, '"See your secrets" lists what is stored.');
    return { text: `${key} is stored and can be read (value not shown).`, data: { key, stored: true } };
  },
};

export const SECRETS_TEST: CapabilityDefinition<SecretsCapabilityServices> = {
  capability: { id: 'secrets.test', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'test-reference', label: 'Test a secret reference', word: 'test',
  inputs: [{ ...REFERENCE, typed: { position: 1 } }],
  sentence: 'Reads {reference} once and says whether it gives a value; the value is not shown.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { reference: 'goodvibes://secrets/env/OPENAI_API_KEY' },
  async run(values, services, caller) {
    const reference = values.reference!.trim();
    if (!isGoodVibesSecretReferenceValue(reference)) throw new CapabilityRefusal(`${reference} is not a secret reference.`, '"See where secrets can come from" shows the reference forms.');
    const view = services.secrets.viewFor(caller);
    try {
      const result = await resolveSecretRef(reference, { resolveLocalSecret: (key) => view.get(key), providers: view.getSecretProviderHostConfig() });
      const gives = result.value !== null && !result.value.empty;
      return { text: `${describeSecretRef(reference)}: ${gives ? 'gives a value (not shown)' : 'gives nothing'}.`, data: { gives } };
    } catch (error) {
      throw new CapabilityRefusal(`${describeSecretRef(reference)} could not be read: ${summarizeError(error)}`);
    }
  },
};

export const SECRETS_PROVIDERS: CapabilityDefinition<SecretsCapabilityServices> = {
  capability: { id: 'secrets.providers', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'see-sources', label: 'See where secrets can come from', word: 'providers', inputs: [],
  sentence: 'Lists the password managers and other places a secret can be read from, with a line for each.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run() {
    return {
      text: [
        'A secret can be read from:',
        ...BUILTIN_SECRET_PROVIDER_SOURCES.map((source) => `  ${source}`),
        '',
        'A reference looks like:',
        ...REFERENCE_EXAMPLES.map((example) => `  ${example}`),
      ].join('\n'),
      data: { sources: [...BUILTIN_SECRET_PROVIDER_SOURCES], examples: REFERENCE_EXAMPLES },
    };
  },
};

export const SECRETS_STORAGE: CapabilityDefinition<SecretsCapabilityServices> = {
  capability: { id: 'secrets.storage', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'see-storage', label: 'See how secrets are kept', word: 'storage', inputs: [],
  sentence: 'Shows the storage rule, how many secrets are encrypted or plain text, and where each store is.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    let review: Awaited<ReturnType<SecretsView['inspect']>>;
    try {
      review = await services.secrets.viewFor(caller).inspect();
    } catch (error) {
      throw new CapabilityRefusal(`How your secrets are kept could not be read: ${summarizeError(error)}`);
    }
    const overridden = new Set((review.records ?? []).filter((record) => record.source !== 'env' && record.overriddenByEnv).map((record) => record.key)).size;
    return {
      text: [
        'How secrets are kept',
        `  rule: ${review.policy.replace(/_/g, ' ')}`,
        `  stored: ${review.storedKeys} (${review.secureKeys} encrypted, ${review.plaintextKeys} plain text)`,
        `  overridden by an environment variable: ${overridden}`,
        ...review.locations.map((location) => `  ${location.source}: ${location.exists ? 'present' : 'absent'} (${location.path})`),
        ...review.warnings.map((warning) => `  warning: ${warning}`),
      ].join('\n'),
      data: {
        rule: review.policy, stored: review.storedKeys, encrypted: review.secureKeys, plainText: review.plaintextKeys, overridden,
        stores: review.locations.map((location) => ({ source: location.source, path: location.path, exists: location.exists })),
        warnings: [...review.warnings],
      },
    };
  },
};

export const SECRETS_TRUST: CapabilityDefinition<SecretsCapabilityServices> = {
  capability: { id: 'secrets.trust', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'trust-secret', label: 'Use a secret from this project\'s store', word: 'trust',
  inputs: [{ ...KEY_STORED, help: 'Secrets in this project\'s store that wait for you', choices: { list: UNCONFIRMED_SECRETS_LIST } }],
  sentence: '{key} from this project\'s secret store (a key or password that came with the repository) will be used whenever you have not set it yourself, until you change it (a changed value asks again).',
  done: '{key} from this project\'s secret store is used from now on.',
  touches: 'credential', lasts: 'kept', risk: 'loosens-a-protection',
  ownerOnly: { reason: 'a project\'s secret store is part of the checkout, so whoever wrote the repository may have put it there', instead: 'Ask the owner to choose "Use a secret from this project\'s store" under Permissions and safety.' },
  example: { key: 'OPENAI_API_KEY' },
  async run(values, services, caller) {
    const key = values.key!.trim();
    // A project's store is the caller's project's: with no folder named, none is confirmed (never the daemon's folder's).
    if (!caller.workingDirectory) throw new CapabilityRefusal(`Nothing was confirmed: "this project" needs the project's folder, and none was named.`, 'Send it from the project (its folder).');
    const confirmed = services.secrets.viewFor(caller).confirmProjectSecret(key);
    if (confirmed.length === 0) throw new CapabilityRefusal(`Nothing was confirmed: ${key} is not in this project's secret store.`, '"See your secrets" lists what is stored.');
    services.secrets.changed(key, 'changed');
    return {
      text: confirmed.map((entry) => entry.pointsAt
        ? `  ${entry.path}: a pointer to ${describeSecretRef(entry.pointsAt)} inside this project's store`
        : `  ${entry.path}`).join('\n'),
      data: { key, confirmed: confirmed.map((entry) => entry.path) },
    };
  },
};

export const SECRETS_DELETE: CapabilityDefinition<SecretsCapabilityServices> = {
  capability: { id: 'secrets.delete', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'delete-secret', label: 'Delete a secret', word: 'delete',
  inputs: [
    KEY_STORED,
    { ...SECRET_SCOPE_INPUT, label: 'From', help: 'Which store to delete it from', required: { default: '', defaultMeans: 'every store that holds it' } },
    { ...SECRET_MEDIUM_INPUT, label: 'Kept as', help: 'Only the encrypted or only the plain-text copy', choices: MEDIA.map(({ risk: _risk, ...choice }) => choice), required: { default: '', defaultMeans: 'both' } },
  ],
  sentence: 'The stored value of {key} (a token, key or password) will be deleted; anything that reads it stops working until it is set again.',
  done: 'Deleted {key}.',
  touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
  example: { key: 'OPENAI_API_KEY' },
  async run(values, services, caller) {
    const key = values.key!.trim();
    // "This project" is the caller's project: with no folder named there is no project store to delete from.
    if (values.scope === 'project' && !caller.workingDirectory) {
      throw new CapabilityRefusal(`${key} was not deleted: "This project" needs the project's folder, and none was named.`, 'Send it from the project (its folder).');
    }
    const view = services.secrets.viewFor(caller);
    const medium = values.storage === 'secure' || values.storage === 'plaintext' ? values.storage : undefined;
    // "All your projects" is the daemon's store and the program's own one before it (kept for a return to an earlier
    // release): both go, or the program would still read the old copy. "This project" is the project's store.
    // A credential the daemon reads lives in the daemon's store whatever was asked: every store is swept for it.
    const sweepAll = resolveSecretDeleteScope(key, 'project') === undefined;
    const scopes: readonly (SecretScope | undefined)[] = sweepAll ? [undefined]
      : values.scope === 'user' ? ['daemon', 'user'] : values.scope === 'project' ? ['project'] : [undefined];
    try {
      for (const scope of scopes) await view.delete(key, { ...(scope ? { scope } : {}), ...(medium ? { medium } : {}) });
    } catch (error) {
      throw new CapabilityRefusal(`${key} was not deleted: ${summarizeError(error)}`);
    }
    services.secrets.changed(key, 'deleted');
    return { text: '', data: { key, deleted: true } };
  },
};

export const SECRETS_USE: CapabilityDefinition<SecretsSessionServices> = {
  capability: { id: 'secrets.use', group: 'safety', home: 'session', repeat: 'safe' },
  actionId: 'use-for-session', label: 'Use a secret for this session only', word: 'use',
  inputs: [
    { id: 'name', label: 'Name', help: 'The variable name programs read it by, such as GITHUB_TOKEN', kind: 'text', freeTextReason: 'a variable name you choose', required: true, typed: { position: 1 } },
    { id: 'value', label: 'Value', help: 'The password or key itself; hidden as you type', kind: 'secret', required: true, typed: { position: 2 } },
  ],
  sentence: 'Programs this app runs will read the value as the environment variable ${name}, for this session only; it is not stored.',
  done: '${name} is set for this session only.',
  touches: 'credential', lasts: 'session', risk: 'none',
  example: { name: 'GITHUB_TOKEN', value: 'example-value' },
  async run(values, services) {
    if (!services.environment) throw new CapabilityRefusal('This program cannot set a variable for its session; nothing was set.');
    const name = values.name!.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
    if (!name) throw new CapabilityRefusal('A variable name holds letters, digits and underscores, such as GITHUB_TOKEN.');
    const value = values.value ?? '';
    if (!value) throw new CapabilityRefusal(`${name} was not set: no value was given.`);
    services.environment.set(name, value);
    return { text: `(${value.length} character${value.length === 1 ? '' : 's'}, value not shown${name !== values.name ? `; set as ${name}` : ''}.)`, data: { name } };
  },
};
