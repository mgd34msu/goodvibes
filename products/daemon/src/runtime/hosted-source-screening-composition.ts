/** Native consent and credential lifetime for the two explicitly approved hosted services. */
import { randomUUID } from 'node:crypto';
import { isSecretRefInput, normalizeSecretRef, type ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/platform/platform/security';
import type { SecretsManager } from '../config/secrets.js';
import { InboxAdmissionRefusal } from './inbox-admission-refusal.js';

export type HostedInboxScreeningSource = 'discord-bot-dms' | 'slack-inbox' | 'email-inbox';
export interface HostedInboxScreeningOperation {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}
export interface HostedInboxScreeningAcquisition {
  readonly options: ProtectedSourceOwnerOptions;
  close(): Promise<void>;
}
type ConfigOwner = Pick<ConfigManager, 'get' | 'getIngestionQuarantine'>;
type CredentialOwner = Pick<SecretsManager, 'resolveLocalCredentialSnapshot' | 'getCredentialMutationState'>;
export interface HostedInboxScreeningHost {
  readonly config: ConfigOwner;
  readonly secrets: CredentialOwner;
  readonly signal: AbortSignal;
  /**
   * Calls the listener when the screening consent setting or one of the two
   * screening credentials changes, in this process or (by the secret store
   * watcher) in another one. It is what keeps an acquisition current.
   */
  readonly onInvalidation: (listener: () => void) => () => void;
}

/** Values and alias revisions stay private; neither is an authority identifier. */
function captureCredential(key: string, secrets: CredentialOwner): { value: string; assertCurrent(): void } {
  const environment = process.env[key];
  let localKey = key;
  if (environment !== undefined) {
    const usableLiteral = environment.length > 0 && environment.trim() === environment && !/[\r\n\0]/.test(environment);
    if (!isSecretRefInput(environment)) {
      if (!usableLiteral) throw new InboxAdmissionRefusal('credential-unavailable', 'Hosted inbox screening credential is unavailable');
      return { value: environment, assertCurrent() {
        if (process.env[key] !== environment) throw new Error('Hosted inbox screening credential changed');
      } };
    }
    const reference = normalizeSecretRef(environment);
    if (!reference || reference.source !== 'goodvibes') throw new Error('Hosted inbox screening requires a native local credential');
    localKey = reference.id;
  }
  const snapshot = secrets.resolveLocalCredentialSnapshot(localKey);
  if (snapshot.state !== 'resolved' || !snapshot.value || snapshot.value.trim() !== snapshot.value
    || /[\r\n\0]/.test(snapshot.value)) throw new InboxAdmissionRefusal('credential-unavailable', 'Hosted inbox screening credential is unavailable');
  // A stored credential that changes fires the host's invalidation, which aborts the acquisition.
  return { value: snapshot.value, assertCurrent() {
    if (process.env[key] !== environment) throw new Error('Hosted inbox screening credential changed');
  } };
}

/** No network, global port, provider route inference or retention attestation is involved. */
export async function acquireHostedInboxScreening(host: HostedInboxScreeningHost,
  source: HostedInboxScreeningSource, operation: HostedInboxScreeningOperation): Promise<HostedInboxScreeningAcquisition> {
  if (!['discord-bot-dms', 'slack-inbox', 'email-inbox'].includes(source)) throw new Error('Hosted inbox screening source is unavailable');
  const { config, secrets } = host;
  const accountCurrent = operation.assertCurrent;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([host.signal, operation.signal, lifetime.signal]);
  const subscriptions: Array<() => void> = [];
  let closed = false;
  const retire = () => lifetime.abort();
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true; retire();
    const failures: unknown[] = [];
    for (const unsubscribe of subscriptions.reverse()) { try { unsubscribe(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Hosted inbox screening subscriptions did not close');
  };
  try {
    // The one currentness fact: the host aborts `signal` when the consent
    // setting or a screening credential changes. A check is the abort signal,
    // the environment and the account's own check; nothing is re-read from disk.
    subscriptions.push(host.onInvalidation(retire));
    // Read once, at acquisition: a quarantined consent section and a credential
    // write in progress are the facts a subscription cannot show.
    if (secrets.getCredentialMutationState().pending
      || config.getIngestionQuarantine().some(entry => entry.key === '(whole file)' || entry.key === 'surfaces'
        || entry.key === 'surfaces.hostedInboxScreening')) throw new Error('Hosted inbox screening consent or source changed');
    const reader: { get(key: string): unknown } = config;
    if (reader.get('surfaces.hostedInboxScreening') !== 'abacus-typesafe-provider-managed') {
      throw new InboxAdmissionRefusal('consent-missing', 'Hosted inbox screening consent or source changed');
    }
    const abacus = captureCredential('ABACUSAI_API_KEY', secrets);
    const typesafe = captureCredential('TYPESAFE_API_KEY', secrets);
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      if (closed) throw new Error('Hosted inbox screening consent or source changed');
      abacus.assertCurrent(); typesafe.assertCurrent();
      accountCurrent();
    };
    assertCurrent();
    const options: ProtectedSourceOwnerOptions = Object.freeze({ kind: 'hosted',
      authority: Object.freeze({ kind: 'hosted', ownerId: `daemon-inbox-${source}-${randomUUID()}`,
        revision: randomUUID(), retention: 'provider-managed-zero-retention-unverified', signal, assertCurrent }),
      credentials: Object.freeze({ abacusApiKey: abacus.value, typesafeApiKey: typesafe.value }),
    });
    return Object.freeze({ options, close });
  } catch (error) { await close(); throw error; }
}
