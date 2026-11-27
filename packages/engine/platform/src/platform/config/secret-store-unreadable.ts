/**
 * secret-store-unreadable.ts: a secret that reads as absent is not always
 * "not stored". `SecretsManager.get` answers null both when no store holds the
 * key and when a store exists that this process cannot read (a key file that
 * no longer matches, a damaged file); only `getStored` tells the two apart, by
 * throwing SecretStoreUnreadableError. Every place that tells a person a secret
 * is missing asks this first, so a store that cannot be read is said as such,
 * with its cause, and the person is never asked again for a secret they gave.
 */
import { SecretStoreUnreadableError } from './secrets-keyfile.js';

/** The words a person reads, before the cause. */
export const SECRET_STORE_UNREADABLE = 'The secret store on this computer could not be read';

/** What this needs of the secret store: the read that throws on a store it cannot read (a store without it is taken as read). */
export interface StoredSecretReader {
  // A property that may be undefined (not only absent): readers built with `exactOptionalPropertyTypes` pass one through.
  readonly getStored?: ((key: string) => Promise<unknown>) | undefined;
}

/** The sentence for a store that could not be read while looking for `what`: the cause, and that nothing is asked for again. */
export function secretStoreUnreadableSentence(cause: string, what: string): string {
  return `${SECRET_STORE_UNREADABLE} (${cause}), so ${what} could not be read; nothing already given there is asked for again.`;
}

/**
 * The secret stores this process opened (each SecretsManager notes itself), for a
 * reader that holds no store of its own but must not call an unreadable store
 * "no key" (a provider refusing a chat request it has no key for). Weakly held.
 */
const processStores = new Set<WeakRef<StoredSecretReader>>();
/** A store's entry goes when the store itself is gone (collected): the set never outgrows the stores that exist. */
const forgetStore = new FinalizationRegistry<WeakRef<StoredSecretReader>>((ref) => { processStores.delete(ref); });

/** Called by every SecretsManager this process makes. */
export function noteProcessSecretStore(store: StoredSecretReader): void {
  const ref = new WeakRef(store);
  processStores.add(ref);
  forgetStore.register(store, ref);
}

/**
 * The sentence for the first secret store this process opened that cannot be
 * read (looking for `what`), or null when every one was read. `key` is the
 * name looked for; any name answers whether the store itself can be read.
 */
export async function processSecretStoreUnreadable(key: string, what: string): Promise<string | null> {
  for (const ref of processStores) {
    const store = ref.deref();
    if (!store) { processStores.delete(ref); continue; }
    const words = await unreadableSecretStore(store, key, what);
    if (words) return words;
  }
  return null;
}

/**
 * After `key` read as absent: the sentence to show when a secret store this
 * process cannot read is the reason (`what` names the secret as the person
 * knows it, "the Cloudflare API token"), or null when the stores were read and
 * none holds it. Never throws; never reads or returns a secret's value.
 */
export async function unreadableSecretStore(
  secrets: StoredSecretReader | null | undefined,
  key: string,
  what: string,
): Promise<string | null> {
  if (!secrets || typeof secrets.getStored !== 'function') return null;
  try {
    await secrets.getStored(key);
    return null;
  } catch (error) {
    if (!(error instanceof SecretStoreUnreadableError)) return null;
    return secretStoreUnreadableSentence(error.reason ?? error.message, what);
  }
}
