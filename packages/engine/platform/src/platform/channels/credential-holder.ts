/**
 * The one per-process holder of resolved channel credentials.
 *
 * A channel credential kept in a password manager or behind a command (`op://`,
 * `bw://`, `vaultwarden://`, `bws://`, an `exec` reference) starts a child
 * process every time it is resolved. Status, the doctor, directory lookups, the
 * provider sockets and every outbound message all ask for the same credential,
 * so each such reference is resolved once and the value is served from here
 * until one of the three things that can make it wrong happens:
 *
 * - the setting names a different reference: the reference text is part of
 *   the key, so a changed setting is a different entry;
 * - the secret store changes (`SecretsManager.onDidChange` and its credential
 *   invalidation), which clears every entry;
 * - a provider refuses a send as unauthorised (401/403, or Slack's auth error
 *   codes), which clears every entry so the next send resolves afresh.
 *
 * A literal value, an environment reference and a GoodVibes secret-store
 * reference are read through each time: they start nothing, and a store file
 * rewritten by another process must still be noticed at the next read. A
 * resolution that yields nothing is not held, so a locked vault is asked again
 * next time instead of being remembered as empty.
 */
import { getSecretRefSource, type SecretProviderSource } from '../config/secret-refs.js';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';
import { DeliveryError } from '../integrations/delivery.js';

interface CredentialStoreEvents {
  onDidChange(listener: (key: string) => void): () => void;
  onDidInvalidateCredentials?(listener: () => void): () => void;
}

function hasStoreEvents(value: unknown): value is CredentialStoreEvents {
  return typeof value === 'object' && value !== null
    && typeof (value as { onDidChange?: unknown }).onDidChange === 'function';
}

/** Slack answers HTTP 200 with one of these when the token itself is refused. */
const SLACK_AUTH_ERROR = /\b(invalid_auth|not_authed|token_revoked|token_expired|account_inactive)\b/;

export class ChannelCredentialHolder {
  readonly #held = new Map<string, Promise<string | null>>();
  readonly #watched = new WeakSet<object>();
  #generation = 0;

  /**
   * The value `read` resolves for `slot` and `reference`, resolved once.
   * `reference` is the setting's value (or a registry entry); anything that is
   * not a secret reference is read through each time, since that costs nothing.
   */
  resolve(slot: string, reference: unknown, read: () => Promise<string | null>, store?: unknown): Promise<string | null> {
    this.watch(store);
    if (!isHeldReference(reference)) return read();
    const key = `${slot}\u0000${typeof reference === 'string' ? reference.trim() : JSON.stringify(reference)}`;
    const held = this.#held.get(key);
    if (held) return held;
    const generation = this.#generation;
    const forget = (): void => { if (this.#held.get(key) === pending) this.#held.delete(key); };
    const pending: Promise<string | null> = read().then((value) => {
      // A store change while the reference was being resolved makes this value suspect.
      if (value === null || this.#generation !== generation) forget();
      return value;
    }, (error: unknown) => {
      forget();
      throw error;
    });
    this.#held.set(key, pending);
    return pending;
  }

  /** Drop every held value; the next request for each credential resolves it again. */
  release(): void {
    this.#generation += 1;
    this.#held.clear();
  }

  /** Release on a refused send: a revoked or rotated credential must not be served again. */
  releaseOnRefusal(error: unknown): boolean {
    if (!isCredentialRefusal(error)) return false;
    this.release();
    return true;
  }

  /** How many credentials are held now. */
  get size(): number {
    return this.#held.size;
  }

  private watch(store: unknown): void {
    if (!hasStoreEvents(store) || this.#watched.has(store)) return;
    this.#watched.add(store);
    store.onDidChange(() => this.release());
    store.onDidInvalidateCredentials?.(() => this.release());
  }
}

/** The reference sources whose resolution starts a command. */
const COMMAND_SOURCES: ReadonlySet<SecretProviderSource> = new Set<SecretProviderSource>([
  'exec', '1password', 'onepassword', 'bitwarden', 'vaultwarden', 'bitwarden-secrets-manager', 'bws',
]);

/** True for a command-backed reference, or a registry entry that names one. */
function isHeldReference(reference: unknown): boolean {
  if (reference === null || reference === undefined) return false;
  const source = getSecretRefSource(reference);
  if (source !== null) return COMMAND_SOURCES.has(source);
  if (typeof reference !== 'object' || Array.isArray(reference)) return false;
  return Object.values(reference as Record<string, unknown>).some((value) => {
    const valueSource = getSecretRefSource(value);
    return valueSource !== null && COMMAND_SOURCES.has(valueSource);
  });
}

/** True when a provider refused the credential itself, not the message. */
export function isCredentialRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const fields = error as { readonly status?: unknown; readonly statusCode?: unknown };
  const status = typeof fields.status === 'number' ? fields.status : typeof fields.statusCode === 'number' ? fields.statusCode : undefined;
  if (status === 401 || status === 403) return true;
  return (error instanceof DeliveryError || error instanceof HttpStatusError) && SLACK_AUTH_ERROR.test(error.message);
}

/** The process's one holder. */
export const channelCredentials = new ChannelCredentialHolder();
