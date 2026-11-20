/**
 * The daemon's one Google connection owner.
 *
 * The calendar verbs, the Gmail inbound reader and the start-up check all
 * reach Google through the same token manager, keyed by the daemon's secret
 * store, so a token refreshed for one serves the others and a grant Google has
 * declared dead is latched once for all of them.
 */
import { revealOrNull, type Secret } from '../security/secret.js';
import { GoogleConnectionOwner, sharedGoogleConnectionOwner, subscribeGoogleCredentialChanges } from './connection-owner.js';
import type { GoogleApiFetchPort } from './api-client.js';
import type { GoogleFetchPort } from './oauth-loopback.js';
import type { ConfigManager } from '../config/manager.js';
import type { GoogleBootCheckResult } from './token-manager.js';
import type { GoogleFilePort } from './credential-adoption.js';

export interface DaemonGoogleConnectionDeps {
  readonly configManager: { get(key: never): unknown };
  readonly secretsManager: { get(key: string): Promise<Secret | null> };
  readonly homeDirectory: string;
  /** Where the adopted credential files are read (the node file port in the daemon). */
  readonly files: GoogleFilePort;
  /** A substitute transport; an owner built with one is not shared, so it cannot reach another caller. */
  readonly fetch?: (GoogleFetchPort & GoogleApiFetchPort) | undefined;
}

/** The start-up check's inputs: the connection's, and the signal that ends it when the daemon stops. */
export interface DaemonGoogleBootCheckDeps extends DaemonGoogleConnectionDeps {
  readonly signal?: AbortSignal | undefined;
}

type SecretChanges = Parameters<typeof subscribeGoogleCredentialChanges>[0]['secrets'];

function configSubscriber(config: DaemonGoogleConnectionDeps['configManager']): Pick<ConfigManager, 'subscribe'> | undefined {
  return typeof (config as { readonly subscribe?: unknown }).subscribe === 'function'
    ? config as unknown as Pick<ConfigManager, 'subscribe'> : undefined;
}

function secretSubscriber(secrets: DaemonGoogleConnectionDeps['secretsManager']): SecretChanges {
  const candidate = secrets as { readonly onDidChange?: unknown; readonly onDidChangeElsewhere?: unknown };
  return typeof candidate.onDidChange === 'function' || typeof candidate.onDidChangeElsewhere === 'function'
    ? secrets as SecretChanges : undefined;
}

/** The daemon's shared owner (made on first use), or a private one when a substitute transport is given. */
export function daemonGoogleConnectionOwner(deps: DaemonGoogleConnectionDeps): GoogleConnectionOwner {
  const create = (): GoogleConnectionOwner => {
    const config = configSubscriber(deps.configManager);
    const secrets = secretSubscriber(deps.secretsManager);
    return new GoogleConnectionOwner({
      sources: {
        files: deps.files,
        homeDirectory: deps.homeDirectory,
        // `get` throws on a config section that does not exist yet; the
        // connector reads every value through its own guard, so an absent
        // section reads as "not configured".
        configGet: (key) => deps.configManager.get(key as never),
        secretGet: async (key) => revealOrNull(await deps.secretsManager.get(key), 'dispatch'),
      },
      fetch: deps.fetch ?? { fetch: (url: string, init: RequestInit) => fetch(url, init) },
      ...(config === undefined && secrets === undefined ? {} : {
        onCredentialChange: (listener: () => void) => subscribeGoogleCredentialChanges({ config, secrets }, listener),
      }),
    });
  };
  return deps.fetch === undefined ? sharedGoogleConnectionOwner(deps.secretsManager, create) : create();
}

/**
 * The start-up check of the daemon's Google grant: one token refresh, so a
 * revoked grant is found and latched at start instead of by the first failing
 * call. Never throws; a failure to check reads as not usable with the reason.
 */
export async function checkDaemonGoogleAtBoot(deps: DaemonGoogleBootCheckDeps): Promise<GoogleBootCheckResult> {
  try {
    return await daemonGoogleConnectionOwner(deps).checkAtBoot(deps.signal);
  } catch (error) {
    return {
      usable: false,
      detail: `The Google credential could not be checked at start: ${error instanceof Error ? error.message : String(error)}`,
      needsReauthorization: false,
      scopes: [],
    };
  }
}
