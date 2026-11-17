/**
 * What one inbox source depends on, so it is replaced only when one of those
 * facts changes: every `surfaces.<provider>.*` setting, the cluster switch that
 * decides how its poller is elected, the hosted-screening consent, the
 * provider's own credentials (`GOODVIBES_SURFACES_<PROVIDER>_*`) and the two
 * screening credentials. A secret store rewritten by another process is
 * reported without a key, so it counts for every provider.
 *
 * Writes of anything else (a theme, a model choice, another provider's token)
 * leave the source, its store, its poller and its screening alone.
 */
import { CONFIG_KEYS, daemonSecretKeyFor, type ConfigKey, type ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

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

/** One provider's facts, screening included (its source screens with it). */
export function inboxProviderFacts(provider: InboxProvider): InboxFactScope {
  const prefix = `surfaces.${provider}.`;
  const keys = [...new Set([...[...CONFIG_KEYS].filter((key) => key.startsWith(prefix)), 'cluster.enabled', SCREENING_CONSENT_KEY])] as ConfigKey[];
  const secretPrefix = `${daemonSecretKeyFor(`surfaces.${provider}`)}_`;
  return Object.freeze({
    keys: Object.freeze(keys),
    secret: (key: string) => key.startsWith(secretPrefix) || SCREENING_SECRET_KEYS.has(key),
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
