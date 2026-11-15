import { randomUUID } from 'node:crypto';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { createClassicProtectedSourceOwner } from '@goodvibes-jev/engine/platform/platform/security';
import { isSecretRefInput, normalizeSecretRef, type ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createProtectedSourceOwner, type ProtectedSourceOwner, type ProtectedSource, type ProtectedResearchReference,
  type SourceScreeningReceipt, type ResearchReferenceScreeningReceipt } from '@goodvibes-jev/engine/platform/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { SecretsManager } from '../config/secrets.ts';
import { AGENT_HOSTED_RESEARCH_SCREENING_KEY } from '../config/host-settings.ts';

type ConfigOwner = Pick<ConfigManager, 'getHostBooleanSetting' | 'getIngestionQuarantine' | 'getConfigurationIncarnation'
  | 'onDidChangeIncarnation' | 'onDidInvalidate'>;
type CredentialOwner = Pick<SecretsManager, 'resolveLocalCredentialSnapshot' | 'getCredentialMutationState' | 'onDidInvalidateCredentials'>;
interface Acquisition { readonly owner: ProtectedSourceOwner; assertCurrent(): void; close(): Promise<void>; }

/** The general sentence, for a refusal raised before any cause is known. */
export const RESEARCH_SCREENING_UNCONFIGURED_DETAIL = `Research report screening needs ${AGENT_HOSTED_RESEARCH_SCREENING_KEY} turned on and the two screening provider keys (ABACUSAI_API_KEY, TYPESAFE_API_KEY), or the Classic decision policy.`;
/** One fixed sentence per cause; none names a value. */
const CONSENT_OFF = 'Turn on "Allow hosted report screening" in the Agent workspace (setting tools.hostedResearchScreening).';
const CONSENT_QUARANTINED = 'The settings file holding tools.hostedResearchScreening could not be read; fix or re-save it, then re-issue the call.';
const SETTINGS_CHANGED = 'Settings or credentials changed during the call; re-issue it.';
const SCREENING_CLOSED = 'Report screening is shutting down with this session.';
const missingKey = (key: string): string => `Set ${key} (environment or the GoodVibes secret store) to screen research reports.`;
const unconfigured = (detail: string): never => { throw new ToolInputProjectionError('unconfigured', detail); };
const changed = (): never => { throw new ToolInputProjectionError('stale', SETTINGS_CHANGED); };
// Widened so the guard does not narrow the environment string on either branch.
const isCredentialReference: (value: unknown) => boolean = isSecretRefInput;

/**
 * A credential read once at capture. The value never becomes an identifier.
 * Later changes are seen through the secrets owner's invalidation and its
 * mutation generation, and an environment value by one string compare.
 */
function captureCredential(key: string, secrets: CredentialOwner): { readonly value: string; assertCurrent(): void } {
  const environment = process.env[key];
  let localKey = key;
  if (environment !== undefined) {
    if (!isCredentialReference(environment)) {
      if (!environment || environment.trim() !== environment || /[\r\n\0]/.test(environment)) return unconfigured(missingKey(key));
      return { value: environment, assertCurrent() { if (process.env[key] !== environment) changed(); } };
    }
    const reference = normalizeSecretRef(environment);
    if (!reference || reference.source !== 'goodvibes') return unconfigured(missingKey(key));
    localKey = reference.id;
  }
  const snapshot = secrets.resolveLocalCredentialSnapshot(localKey);
  if (snapshot.state !== 'resolved' || !snapshot.value || snapshot.value.trim() !== snapshot.value || /[\r\n\0]/.test(snapshot.value)) {
    return unconfigured(missingKey(key));
  }
  return { value: snapshot.value, assertCurrent() { if (process.env[key] !== environment) changed(); } };
}

/**
 * One acquisition under the settings and credentials it was granted under.
 * The owners' own subscriptions abort `signal` on any settings or credential
 * change; what is left per check is integer compares and the abort signal.
 */
function acquire(config: ConfigOwner, secrets: CredentialOwner, hostSignal: AbortSignal, isClosing: () => boolean): Acquisition {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([hostSignal, lifetime.signal]);
  const subscriptions: Array<() => void> = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  let owner: ProtectedSourceOwner | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    // Claimed before the abort, so a listener that re-enters close shares this one.
    const finish = Promise.withResolvers<void>();
    closing = finish.promise;
    closed = true; lifetime.abort();
    const failures: unknown[] = [];
    for (const unsubscribe of subscriptions.splice(0).reverse()) {
      try { unsubscribe(); } catch (error) { failures.push(error); }
    }
    let pending: Promise<void> | undefined;
    try { pending = owner?.close(); } catch (error) { failures.push(error); }
    void Promise.resolve(pending).then(() => {
      if (failures.length) finish.reject(new AggregateError(failures, 'Research screening subscriptions did not close'));
      else finish.resolve();
    }, error => finish.reject(new AggregateError([...failures, error], 'Research screening owner did not close')));
    return closing;
  };
  const retire = (): void => { lifetime.abort(); };
  try {
    if (isClosing()) unconfigured(SCREENING_CLOSED);
    subscriptions.push(config.onDidChangeIncarnation(retire));
    subscriptions.push(config.onDidInvalidate(retire));
    subscriptions.push(secrets.onDidInvalidateCredentials(retire));
    const incarnation = config.getConfigurationIncarnation();
    const live = (): void => {
      signal.throwIfAborted();
      if (closed || isClosing()) unconfigured(SCREENING_CLOSED);
      if (config.getConfigurationIncarnation() !== incarnation) changed();
    };
    if (decisionModelPolicyState().operation === 'classic') {
      owner = createClassicProtectedSourceOwner(Object.freeze({ ownerId: `classic-agent-source-${randomUUID()}`,
        revision: randomUUID(), signal, assertCurrent: live }));
      return Object.freeze({ owner, assertCurrent: live, close });
    }
    const consent = config.getHostBooleanSetting(AGENT_HOSTED_RESEARCH_SCREENING_KEY);
    if (config.getIngestionQuarantine().some(entry => entry.key === '(whole file)' || entry.key === 'tools'
      || entry.key === AGENT_HOSTED_RESEARCH_SCREENING_KEY)) unconfigured(CONSENT_QUARANTINED);
    if (consent.get() !== true || consent.getResolved().value !== true) unconfigured(CONSENT_OFF);
    const credentialState = secrets.getCredentialMutationState();
    if (credentialState.pending) changed();
    const abacus = captureCredential('ABACUSAI_API_KEY', secrets);
    const typesafe = captureCredential('TYPESAFE_API_KEY', secrets);
    const assertCurrent = (): void => {
      live();
      const credentials = secrets.getCredentialMutationState();
      if (credentials.pending || credentials.generation !== credentialState.generation) changed();
      abacus.assertCurrent(); typesafe.assertCurrent();
    };
    owner = createProtectedSourceOwner(Object.freeze({ kind: 'hosted',
      authority: Object.freeze({ kind: 'hosted', ownerId: `agent-research-${randomUUID()}`, revision: randomUUID(),
        retention: 'provider-managed-zero-retention-unverified', signal, assertCurrent }),
      credentials: Object.freeze({ abacusApiKey: abacus.value, typesafeApiKey: typesafe.value }),
    }));
    return Object.freeze({ owner, assertCurrent, close });
  } catch (error) {
    // No provider operation was admitted; the subscriptions taken so far close.
    void close().catch(() => {});
    if (error instanceof ToolInputProjectionError) throw error;
    if (signal.aborted) throw new ToolInputProjectionError('cancelled');
    return unconfigured(RESEARCH_SCREENING_UNCONFIGURED_DETAIL);
  }
}

/**
 * One graph-owned report capability. A new capture may use a newly granted
 * native configuration; an existing handle always stays with its original
 * acquisition. No source, receipt or operation can supply consent.
 */
export function createAgentResearchSourceOwner(config: ConfigOwner, secrets: CredentialOwner, signal: AbortSignal): ProtectedSourceOwner {
  const handles = new WeakMap<ProtectedSource | ProtectedResearchReference, Acquisition>();
  const receipts = new WeakMap<SourceScreeningReceipt | ResearchReferenceScreeningReceipt, Acquisition>();
  const acquisitions = new Set<Acquisition>();
  const drains = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let active: Acquisition | undefined;
  let closing: Promise<void> | undefined;
  const drain = (acquisition: Acquisition): void => {
    if (!acquisitions.delete(acquisition)) return;
    let pending: Promise<void>;
    try { pending = acquisition.close(); } catch (error) { pending = Promise.reject(error); }
    drains.add(pending);
    void pending.then(() => drains.delete(pending), error => { drains.delete(pending); failures.push(error); });
  };
  const current = (): Acquisition => {
    signal.throwIfAborted();
    if (closing) return unconfigured(SCREENING_CLOSED);
    if (active) {
      try { active.assertCurrent(); return active; }
      catch { drain(active); active = undefined; }
    }
    active = acquire(config, secrets, signal, () => closing !== undefined); acquisitions.add(active);
    return active;
  };
  const staleOrCancelled = (aborted = false): { status: 'held'; reason: 'cancelled' | 'stale' } =>
    ({ status: 'held', reason: signal.aborted || closing || aborted ? 'cancelled' : 'stale' });
  return Object.freeze({
    capture(parts) {
      const acquisition = current(), handle = acquisition.owner.capture(parts);
      handles.set(handle, acquisition); return handle;
    },
    captureResearchReference(reference) {
      const acquisition = current(), handle = acquisition.owner.captureResearchReference(reference);
      handles.set(handle, acquisition); return handle;
    },
    async screen(handle) {
      const acquisition = handles.get(handle);
      if (!acquisition) return { status: 'held', reason: 'stale' };
      const result = await acquisition.owner.screen(handle);
      if (result.status === 'settled') {
        // The one compare after the screening await, before a receipt exists.
        try { acquisition.assertCurrent(); } catch { return staleOrCancelled(); }
        receipts.set(result.receipt, acquisition);
      }
      return result;
    },
    async screenResearchReference(handle, operation) {
      const acquisition = handles.get(handle);
      if (!acquisition) return { status: 'held', reason: 'stale' };
      const result = await acquisition.owner.screenResearchReference(handle, operation);
      if (result.status === 'settled') {
        try { acquisition.assertCurrent(); operation?.signal?.throwIfAborted(); operation?.assertCurrent?.(); }
        catch { return staleOrCancelled(operation?.signal?.aborted === true); }
        receipts.set(result.receipt, acquisition);
      }
      return result;
    },
    project(receipt) {
      const acquisition = receipts.get(receipt);
      if (!acquisition) return changed();
      return acquisition.owner.project(receipt);
    },
    projectResearchReference(receipt) {
      const acquisition = receipts.get(receipt);
      if (!acquisition) return changed();
      return acquisition.owner.projectResearchReference(receipt);
    },
    async release(handle) {
      const acquisition = handles.get(handle);
      if (!acquisition) return;
      await acquisition.owner.release(handle); handles.delete(handle);
    },
    close() {
      if (closing) return closing;
      // Retire before abort callbacks or native drain can reenter this graph.
      const finish = Promise.withResolvers<void>();
      closing = finish.promise;
      active = undefined;
      for (const acquisition of [...acquisitions]) drain(acquisition);
      void Promise.allSettled([...drains]).then(() => {
        if (failures.length) finish.reject(new AggregateError(failures, 'Research screening owners did not close'));
        else finish.resolve();
      });
      return closing;
    },
  } satisfies ProtectedSourceOwner);
}
