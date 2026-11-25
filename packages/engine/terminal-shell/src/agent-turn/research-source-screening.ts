import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { decisionModelPolicyState } from '@goodvibes/engine/errors';
import { createClassicProtectedSourceOwner } from '@goodvibes/engine/platform/platform/security/source-screening/classic-owner';
import { ConfigManager, SecretsManager, isSecretRefInput, normalizeSecretRef, resolveGoodVibesDaemonHome,
  type SecretStorageMode } from '@goodvibes/engine/platform/platform/config';
import { createProtectedSourceOwner } from '@goodvibes/engine/platform/platform/security/source-screening/owner';
import type { ProtectedSourceOwner, ProtectedSource, ProtectedResearchReference, SourceScreeningReceipt, ResearchReferenceScreeningReceipt } from '@goodvibes/engine/platform/platform/security';
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';
import { AGENT_HOSTED_RESEARCH_SCREENING_KEY, AGENT_HOSTED_RESEARCH_SCREENING_SETTING } from '@goodvibes/engine/platform/platform/runtime/program-host-settings';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';

// The consent and its setting are declared once in the platform (runtime/program-host-settings.ts), so the daemon and
// the settings screen of either program know the Agent's setting too.
export { AGENT_HOSTED_RESEARCH_SCREENING_KEY, AGENT_HOSTED_RESEARCH_SCREENING_SETTING };

/** The settings a screening owner reads: the consent, the quarantine and the change signals. */
export type AgentResearchScreeningConfig = Pick<ConfigManager, 'getHostBooleanSetting' | 'getIngestionQuarantine' | 'getConfigurationIncarnation'
  | 'onDidChangeIncarnation' | 'onDidInvalidate'>;
type ConfigOwner = AgentResearchScreeningConfig;
/** The credentials a screening owner reads: the screening provider keys and their change signals. */
export type AgentResearchScreeningCredentials = Pick<SecretsManager, 'resolveLocalCredentialSnapshot' | 'getCredentialMutationState' | 'onDidInvalidateCredentials'>;
type CredentialOwner = AgentResearchScreeningCredentials;

/** The Agent's settings as a process that is not the Agent reads them: the screening consent and the Agent's secret-storage policy. */
export interface AgentSettingsReader extends AgentResearchScreeningConfig {
  /** The Agent's `storage.secretPolicy`, which decides which of its credential stores are read. */
  getSecretPolicy(): SecretStorageMode;
}

/**
 * The Agent's own settings, read by a process that is not the Agent (the
 * daemon, for a turn it hosts for the Agent): one read-only manager over the
 * Agent's user settings files with the consent registered, and the daemon tier
 * where the Agent reads it (GOODVIBES_DAEMON_HOME included), loaded again when
 * the Agent's settings file changes. Nothing is written. Each incarnation read
 * costs one `stat` of that file; a load happens only after it changed, and the
 * load moves the incarnation, so an acquisition made under the old file is
 * retired exactly as a settings change retires it in the Agent's own process.
 */
export function createAgentSettingsReader(homeDirectory: string): AgentSettingsReader {
  const manager = new ConfigManager({
    homeDir: homeDirectory,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    readOnly: true,
    hostSettings: [AGENT_HOSTED_RESEARCH_SCREENING_SETTING],
  });
  const settingsPath = manager.getConfigPath();
  const stamp = (): string => {
    try {
      const stat = statSync(settingsPath, { bigint: true, throwIfNoEntry: false });
      return stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}` : 'absent';
    } catch {
      return 'unreadable';
    }
  };
  let loaded = stamp();
  const fresh = (): ConfigManager => {
    const now = stamp();
    if (now !== loaded) { loaded = now; manager.load(); }
    return manager;
  };
  return {
    getHostBooleanSetting: (key) => fresh().getHostBooleanSetting(key),
    getIngestionQuarantine: () => fresh().getIngestionQuarantine(),
    getConfigurationIncarnation: () => fresh().getConfigurationIncarnation(),
    onDidChangeIncarnation: (listener) => manager.onDidChangeIncarnation(listener),
    onDidInvalidate: (listener) => manager.onDidInvalidate(listener),
    getSecretPolicy: () => {
      try {
        return (fresh().get('storage.secretPolicy') as SecretStorageMode | undefined) ?? 'preferred_secure';
      } catch {
        return 'preferred_secure';
      }
    },
  };
}

/**
 * The Agent's own credential stores, read by a process that is not the Agent
 * (the daemon, for a turn it hosts for the Agent), in the Agent's order: the
 * daemon tier where the Agent reads it, then the Agent's user store
 * `~/.goodvibes/agent/secrets.*`, under the Agent's own `storage.secretPolicy`.
 * The daemon's own store is a different surface's, so a screening key the
 * owner saved in the Agent would not be found there.
 *
 * Read only: nothing is written here, so the generation this reader reports is
 * the store's revision after re-`stat`ing the store files it has read (one
 * `stat` each per check). A key the Agent process rotates or removes moves it,
 * so the next check retires the acquisition and the next one reads the new
 * key, whether or not the directory watch saw the write. No settings object is
 * given to the stores, so a reference in them runs each password manager with
 * its own defaults. The project tier is left out: the Agent reads only its launch
 * directory's, and only for a key the owner confirmed there; here the project
 * paths are the user store itself, so they add nothing. One store object per
 * policy, made on first use; each read costs what the Agent's own read costs.
 */
export function createAgentCredentialReader(homeDirectory: string, settings: Pick<AgentSettingsReader, 'getSecretPolicy'>): AgentResearchScreeningCredentials {
  const stores = new Map<SecretStorageMode, SecretsManager>();
  const daemonHome = resolveGoodVibesDaemonHome(homeDirectory);
  const current = (): SecretsManager => {
    const policy = settings.getSecretPolicy();
    let store = stores.get(policy);
    if (!store) {
      store = new SecretsManager({ projectRoot: homeDirectory, globalHome: homeDirectory, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, daemonHome, policy });
      stores.set(policy, store);
    }
    return store;
  };
  return {
    resolveLocalCredentialSnapshot: (key) => current().resolveLocalCredentialSnapshot(key),
    getCredentialMutationState: () => {
      const store = current();
      const revision = store.checkStoresChangedElsewhere();
      return Object.freeze({ generation: revision, pending: store.getCredentialMutationState().pending });
    },
    onDidInvalidateCredentials: (listener) => current().onDidInvalidateCredentials(listener),
  };
}
interface Acquisition { readonly owner: ProtectedSourceOwner; assertCurrent(): void; close(): Promise<void>; }

/** The general sentence, for a refusal raised before any cause is known. */
export const RESEARCH_SCREENING_UNCONFIGURED_DETAIL = `Research report screening needs ${AGENT_HOSTED_RESEARCH_SCREENING_KEY} turned on and the two screening provider keys (ABACUSAI_API_KEY, TYPESAFE_API_KEY), or no Decision model set.`;
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
  // Revealed for the screening provider it is sent to.
  const text = snapshot.state === 'resolved' ? snapshot.value.reveal('dispatch') : '';
  if (snapshot.state !== 'resolved' || !text || text.trim() !== text || /[\r\n\0]/.test(text)) {
    return unconfigured(missingKey(key));
  }
  return { value: text, assertCurrent() { if (process.env[key] !== environment) changed(); } };
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
    if (decisionModelPolicyState().operation === 'no-decision-model') {
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
    assertAuthorizationCurrent(receipt) {
      // The acquisition that issued it, still the active one and still current: consent, settings and credentials unchanged.
      const acquisition = receipts.get(receipt);
      if (!acquisition || acquisition !== active || closing) return changed();
      acquisition.assertCurrent();
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
