/**
 * Storing a secret, done by the daemon. "All your projects" is the daemon's
 * own store (`~/.goodvibes/daemon/secrets.enc`), which every GoodVibes
 * program on this machine reads first; "This project" is the project store
 * the asking program reads (`<project>/.goodvibes/<program>/secrets.enc`). The
 * value goes into the store and nowhere else: never into an answer, a log or
 * a line on screen.
 */
import { isMalformedGoodVibesSecretReferenceValue } from '../../config/secret-backed-config.js';
import type { SecretScope, SecretStorageMedium } from '../../config/secrets-store-paths.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

/** What storing a secret needs: the store a write of a scope lands in for the caller. */
export interface SecretsCapabilityServices {
  readonly secrets: {
    writerFor(scope: 'project' | 'user', caller: CapabilityCaller): {
      set(key: string, value: string, options: { readonly scope: SecretScope; readonly medium: SecretStorageMedium }): Promise<void>;
      /** The scope written (`daemon` for "All your projects"). */
      readonly scope: SecretScope;
      /** Where it is kept, in words, for the answer. */
      readonly where: string;
    };
  };
}

/** The stored secrets by name (the terminal's list reads them where they are kept). */
export const STORED_SECRETS_LIST = 'secrets.stored' as ListName;

const SCOPES: readonly FixedChoice[] = [
  { value: 'project', label: 'This project', help: 'Kept in this project\'s secret store, read only here.' },
  { value: 'user', label: 'All your projects', help: 'Kept in your own secret store, read in every project.' },
];
const MEDIA: readonly FixedChoice[] = [
  { value: 'secure', label: 'Encrypted', help: 'Kept encrypted on this machine.' },
  { value: 'plaintext', label: 'Plain text', help: 'Kept readable by anything that can read the file.', risk: 'loosens-a-protection' },
];

export const SECRET_SCOPE_INPUT: InputDescription = {
  id: 'scope', label: 'Where to keep it', help: 'This project only, or every project', kind: 'choice', choices: SCOPES,
  required: { default: 'project', defaultMeans: 'this project only' }, typed: { flag: '--scope' },
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
  sentence: '{key} will be kept in the {scope} secret store ({storage}) until you change it.',
  done: 'Stored {key} in the {scope} secret store ({storage}).',
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
    const writer = services.secrets.writerFor(requested, caller);
    try {
      await writer.set(key, value, { scope: writer.scope, medium });
    } catch (error) {
      // The store's own words, never the value.
      throw new CapabilityRefusal(`${key} was not stored: ${summarizeError(error).split(value).join('(not shown)')}`);
    }
    return { text: `Kept in ${writer.where}.`, data: { key, scope: requested, storage: medium, storedIn: writer.scope } };
  },
};
