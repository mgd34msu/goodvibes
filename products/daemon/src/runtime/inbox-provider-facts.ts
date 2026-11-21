/**
 * What one inbox source depends on, so it is replaced only when one of those
 * facts changes: every `surfaces.<provider>.*` setting it reads when built, the cluster switch that
 * decides how its poller is elected, the hosted-screening consent, the
 * provider's own credentials and the two screening credentials. A provider's
 * credential can be stored under several names: `GOODVIBES_SURFACES_<PROVIDER>_*`,
 * the store key channel setup writes for each of its secret targets (the
 * target's first environment name, such as `SLACK_BOT_TOKEN`), the keys its
 * service-registry entry names, and the secret a `goodvibes://secrets/...`
 * reference in one of its settings points at. A secret store rewritten by
 * another process is reported without a key, so it counts for every provider.
 *
 * Writes of anything else (a theme, a model choice, another provider's token)
 * leave the source, its store, its poller and its screening alone.
 */
import { CONFIG_KEYS, SERVICE_SECRET_KEY_FIELDS, SERVICE_SECRET_REFERENCE_FIELDS, daemonSecretKeyFor, normalizeSecretRef, type ConfigKey, type ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { getBuiltinSetupSchema } from '@goodvibes/engine/platform/platform/channels';

export type InboxProvider = 'slack' | 'email' | 'discord';

/** The settings and credentials hosted screening is admitted on. */
const SCREENING_CONSENT_KEY = 'surfaces.hostedInboxScreening';
const SCREENING_SECRET_KEYS: ReadonlySet<string> = new Set(['ABACUSAI_API_KEY', 'TYPESAFE_API_KEY']);

export interface InboxFactScope {
  readonly keys: readonly ConfigKey[];
  readonly secret: (key: string) => boolean;
}

/** Hosted screening alone: its consent setting and its two credentials. */
export const SCREENING_FACTS: InboxFactScope = Object.freeze({
  keys: Object.freeze([SCREENING_CONSENT_KEY as ConfigKey]),
  secret: (key: string) => SCREENING_SECRET_KEYS.has(key),
});

/**
 * Settings under the provider's prefix that its running source reads at the
 * moment of use, so a write to one must not rebuild the source: the label
 * write-back switch is read on every label write (tagged-owned.ts).
 */
const READ_AT_USE_SUFFIXES: readonly string[] = ['.inboxTagging'];

/** Where a provider's credential names are read: its settings, and the service registry. */
export interface InboxCredentialReaders {
  readonly config?: { get(key: string): unknown } | undefined;
  /** The secret-store keys the registry entry of `serviceName` names, empty when there is none. */
  readonly serviceSecretKeys?: ((serviceName: string) => readonly string[]) | undefined;
}

/** The secret-store keys a service-registry entry names: its key fields and its `goodvibes://secrets/...` references. */
export function serviceRegistrySecretKeys(registry: { get(serviceName: string): object | null }): (serviceName: string) => readonly string[] {
  return (serviceName) => {
    const entry = registry.get(serviceName) as Record<string, unknown> | null;
    if (!entry) return [];
    const names: string[] = [];
    for (const field of SERVICE_SECRET_KEY_FIELDS) if (typeof entry[field] === 'string' && entry[field]) names.push(entry[field]);
    for (const field of SERVICE_SECRET_REFERENCE_FIELDS) {
      const stored = referencedStoreKey(entry[field]);
      if (stored) names.push(stored);
    }
    return names;
  };
}

/** The secret targets a provider's channel setup declares; email has none. */
function secretTargetsOf(provider: InboxProvider): readonly { readonly serviceName?: string | undefined; readonly envKeys?: readonly string[] | undefined }[] {
  if (provider === 'email') return [];
  return getBuiltinSetupSchema(provider).secretTargets;
}

/** The secret-store key a `goodvibes://secrets/...` reference names, or undefined for any other value. */
function referencedStoreKey(value: unknown): string | undefined {
  const ref = normalizeSecretRef(value);
  if (ref?.source !== 'goodvibes') return undefined;
  // `goodvibes://secrets/goodvibes/<key>`: the store key is the last segment.
  return ref.id.split('/').at(-1);
}

/** One provider's facts, screening included (its source screens with it). */
export function inboxProviderFacts(provider: InboxProvider, readers: InboxCredentialReaders = {}): InboxFactScope {
  const prefix = `surfaces.${provider}.`;
  const providerKeys = [...CONFIG_KEYS].filter((key) => key.startsWith(prefix));
  const keys = [...new Set([...providerKeys.filter((key) => !READ_AT_USE_SUFFIXES.some((suffix) => key.endsWith(suffix))),
    'cluster.enabled', SCREENING_CONSENT_KEY])] as ConfigKey[];
  const secretPrefix = `${daemonSecretKeyFor(`surfaces.${provider}`)}_`;
  const targets = secretTargetsOf(provider);
  // Names fixed by the schema; the rest are read at each secret write (a few setting reads).
  const fixedNames = new Set(targets.flatMap((target) => target.envKeys?.[0] ? [target.envKeys[0]] : []));
  const serviceNames = [...new Set(targets.flatMap((target) => target.serviceName ? [target.serviceName] : []))];
  const currentNames = (): Set<string> => {
    const names = new Set<string>();
    for (const serviceName of serviceNames) for (const name of readers.serviceSecretKeys?.(serviceName) ?? []) names.add(name);
    if (readers.config) {
      for (const key of providerKeys) {
        const stored = referencedStoreKey(readers.config.get(key));
        if (stored) names.add(stored);
      }
    }
    return names;
  };
  return Object.freeze({
    keys: Object.freeze(keys),
    secret: (key: string) => key.startsWith(secretPrefix) || SCREENING_SECRET_KEYS.has(key) || fixedNames.has(key) || currentNames().has(key),
  });
}

export interface InboxFactOwners {
  readonly config: Pick<ConfigManager, 'subscribe'>;
  readonly secrets: {
    readonly onDidChange?: ((listener: (key: string) => void) => () => void) | undefined;
    readonly onDidChangeElsewhere?: ((listener: () => void) => () => void) | undefined;
  };
}

/**
 * Call `listener` when a fact in `scope` changes. One subscription per key and
 * one key filter per secret write; nothing is read per request.
 */
export function subscribeInboxFacts(owners: InboxFactOwners, scope: InboxFactScope, listener: () => void): () => void {
  const stops: Array<() => void> = [];
  const stop = (): void => {
    const failures: unknown[] = [];
    for (const unsubscribe of stops.splice(0).reverse()) { try { unsubscribe(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Inbox fact subscriptions did not close');
  };
  try {
    for (const key of scope.keys) stops.push(owners.config.subscribe(key, () => listener()));
    if (owners.secrets.onDidChange) stops.push(owners.secrets.onDidChange((key) => { if (scope.secret(key)) listener(); }));
    if (owners.secrets.onDidChangeElsewhere) stops.push(owners.secrets.onDidChangeElsewhere(listener));
    return stop;
  } catch (error) { stop(); throw error; }
}
