/**
 * credential-status.ts
 *
 * Promotes the internal SecretsManager to a secret-FREE status source for the
 * daemon's `credentials.get` wire method (config sharing, see CHANGELOG 1.0.0).
 *
 * The returned provider reports whether each credential in the shared store is
 * configured and usable, it NEVER exposes the plaintext value. `usable` is an
 * in-process resolution (env → store, a pointer followed, an `env:` or `file:`
 * reference read), reported only as a boolean. A reference that runs a command
 * to resolve (a password manager, `exec`) is resolved by a named probe
 * (`get(key)`), never by a listing: the listing reports it `usable: false`
 * with `reference: 'not-checked'`, so it starts no password-manager process and
 * never claims a credential works that it did not resolve. A project-store key
 * not yet confirmed is `usable: false`.
 *
 * Enumeration is never a `process.env` dump. It covers STORED keys, plus the
 * env-backed keys whose names are KNOWN credential names, the provider env
 * vars this platform itself publishes in BUILTIN_PROVIDER_ENV_KEYS. Every other
 * environment variable stays invisible, so `PATH`, `AWS_REGION` and the rest
 * of the shell can still never be enumerated over the wire.
 *
 * That intersection is what dropping every env record was reaching for, and it
 * was too wide a cut. `get()` consults env, so a provider key configured only
 * as `ANTHROPIC_API_KEY` answered `configured: true` from `get` while being
 * absent from `list` altogether, the two disagreeing about the same
 * credential. `list` is what a setup screen renders, so a key that was working
 * read as missing, which is the report that sends someone to re-enter a
 * credential they already have.
 */

import type {
  CredentialStatusProviderLike,
  CredentialStatusRecord,
} from '@goodvibes/engine/daemon-api';
import { BUILTIN_PROVIDER_ENV_KEYS } from './provider-credential-catalog.js';
import { isCommandBackedSecretSource, type SecretRecord, type SecretsManager } from './secrets.js';

function declaredProviders(key: string): readonly string[] {
  return Object.entries(BUILTIN_PROVIDER_ENV_KEYS).filter(([, names]) => names.includes(key)).map(([id]) => id);
}

/**
 * Every environment variable name this platform itself treats as a credential.
 *
 * Derived from the provider catalog rather than restated, so a provider added
 * there becomes enumerable here without a second edit, and so this set can
 * never drift into covering a name the catalog does not call a credential.
 */
function knownCredentialEnvNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const envVars of Object.values(BUILTIN_PROVIDER_ENV_KEYS)) {
    for (const name of envVars) names.add(name);
  }
  return names;
}

/** The SecretsManager surface this adapter needs (keeps callers free to inject a stub). */
type SecretsMetadataSource = Pick<SecretsManager, 'get' | 'list' | 'listDetailed'>;

/** Whether a credential resolves, or that a listing did not run the command that would tell. */
type Usability = Pick<CredentialStatusRecord, 'usable' | 'reference'>;

async function resolveUsable(secrets: SecretsMetadataSource, key: string, record: SecretRecord | undefined, runCommands: boolean): Promise<Usability> {
  if (record?.unconfirmed) return { usable: false };
  if (!runCommands && record?.refSource && !record.overriddenByEnv && isCommandBackedSecretSource(record.refSource)) {
    return { usable: false, reference: 'not-checked' };
  }
  try {
    const value = await secrets.get(key);
    return { usable: value !== null && !value.empty };
  } catch {
    return { usable: false };
  }
}

/**
 * Wrap a SecretsManager (the daemon's shared store) as a secret-free credential
 * status provider suitable for the `credentials.get` route context.
 */
export function createCredentialStatusProvider(
  secrets: SecretsMetadataSource,
): CredentialStatusProviderLike {
  return {
    async list(): Promise<readonly CredentialStatusRecord[]> {
      const detailed = await secrets.listDetailed();
      // Stored keys, plus env-backed keys whose NAME this platform publishes as a
      // credential. The bulk env enumeration is still filtered out, the
      // intersection is the whole point, and it is what keeps unrelated
      // environment variable names off the wire.
      const knownEnvNames = knownCredentialEnvNames();
      const storedKeys = new Set(
        detailed.filter((record) => record.source !== 'env').map((record) => record.key),
      );
      const visible = detailed.filter((record) =>
        record.source !== 'env'
          // A key that is BOTH stored and present in env already has a stored
          // record carrying overriddenByEnv; emitting the env record too would
          // list the same credential twice.
          || (knownEnvNames.has(record.key) && !storedKeys.has(record.key)),
      );
      const records: CredentialStatusRecord[] = [];
      for (const record of visible) {
        records.push({
          key: record.key,
          providerIds: declaredProviders(record.key),
          configured: true,
          ...await resolveUsable(secrets, record.key, record, false),
          source: record.source,
          scope: record.scope,
          secure: record.secure,
          overriddenByEnv: record.overriddenByEnv,
          ...(record.refSource ? { refSource: record.refSource } : {}),
        });
      }
      return records;
    },
    async get(key: string): Promise<CredentialStatusRecord | null> {
      const detailed = await secrets.listDetailed();
      // A named probe MAY consult env for this one caller-named key. Prefer a
      // stored record; fall back to the environment for the same name (the
      // listing carries env records only for stored or declared names, and a
      // custom provider may read any name).
      const fromEnv: SecretRecord | null = process.env[key] !== undefined ? { key, source: 'env', scope: 'env', secure: false, overriddenByEnv: false } : null;
      const match: SecretRecord | null =
        detailed.find((record) => record.key === key && record.source !== 'env') ??
        detailed.find((record) => record.key === key) ??
        fromEnv;
      if (!match) {
        return { key, configured: false, usable: false, source: 'none', scope: 'none', secure: false, overriddenByEnv: false };
      }
      return {
        key: match.key,
        providerIds: declaredProviders(match.key),
        configured: true,
        // One caller-named key: resolved whatever its source.
        ...await resolveUsable(secrets, key, match, true),
        source: match.source,
        scope: match.scope,
        secure: match.secure,
        overriddenByEnv: match.overriddenByEnv,
        ...(match.refSource ? { refSource: match.refSource } : {}),
      };
    },
  };
}
