import { composeJudgmentVolumeMonitor, type JudgmentVolumeMonitorHandle } from './judgment-volume-monitor.js';
import { activateClassicFallback, configureDecisionModelPolicy } from './decision-policy.js';
import { assertDecisionModelsEnabled } from '@goodvibes-jev/engine/errors';
import { bindJudgmentPortAuthority, installJudgmentPort, restoreJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createJudgmentSourceLifetime } from './judgment-source-lifetime.js';
import { claimJudgmentRuntimeScope } from './judgment-runtime-scope.js';
import {
  createSystemOnePort,
  assertSynchronousJudgmentGuard,
  endpointKind,
  JudgmentError,
  captureJudgmentBackendSettings,
  HOSTED_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_DECISION_DEADLINE_MS,
  validDecisionDeadline,
  withDecisionLog,
  type JudgmentConfig,
  type JudgmentPort,
  type JudgmentRequest,
  type JudgmentResult,
  type Questions,
  type SqliteDecisionLog,
} from '@goodvibes-jev/judgment';
import type { JudgmentKeySource } from '../config/schema-types-judgment.js';
import type { SecretsManager } from '../config/secrets.js';
import { captureJudgmentFallbackSettings } from '../config/judgment-fallback-settings.js';
import { openStateDecisionLogWithNotice, scheduleDecisionLogRetention } from '../state/decision-log.js';
import { logger } from '../utils/logger.js';
import { withWebuiAnswerBoundary, type WebuiAnswerBoundaryOptions } from '../judgment-browser/batteries/webui-answers.js';
import type { DisposalRegistry } from './disposal.js';

/** The secret-store and environment name of the judgment API key. */
export const JUDGMENT_KEY_NAME = 'TYPESAFE_API_KEY';

/** What the judgment settings are read from. */
export interface JudgmentSettingsSource {
  readonly config: {
    get(key: 'judgment.policy' | 'judgment.endpoint' | 'judgment.keySource' | 'judgment.keyName' | 'judgment.model' | 'judgment.backend' | 'judgment.timeoutMs' | 'judgment.decisionDeadlineMs' | 'judgment.fallbacks' | 'judgment.volumeMonitor'): unknown;
    subscribe?(key: 'judgment.volumeMonitor', listener: () => void): () => void;
    getConfigurationIncarnation?(): number;
    onDidChangeIncarnation?(listener: () => void): () => void;
  };
  readonly secrets: {
    get(key: string): Promise<string | null>;
    getCredentialMutationState?(): Readonly<{ generation: number; pending: boolean }>;
    onDidInvalidateCredentials?(listener: () => void): () => void;
    /** Local alias/scope observation; its value and revision stay private. */
    readonly resolveLocalCredentialSnapshot?: SecretsManager['resolveLocalCredentialSnapshot'];
  };
  /** The process environment; TYPESAFE_API_KEY, TYPESAFE_BASE_URL and TYPESAFE_DEFAULT_MODEL. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The model a request names when it names none: judgment.model, then TYPESAFE_DEFAULT_MODEL, then jev-latest. */
function settingsModel(source: JudgmentSettingsSource): string {
  return text(source.config.get('judgment.model')) || text(source.env['TYPESAFE_DEFAULT_MODEL']) || DEFAULT_MODEL;
}

/** The deadline judge() gives a decision a person or tool call waits on: judgment.decisionDeadlineMs, else the default. */
function settingsDecisionDeadline(source: JudgmentSettingsSource): number {
  const value = source.config.get('judgment.decisionDeadlineMs');
  return validDecisionDeadline(value) ? value : DEFAULT_DECISION_DEADLINE_MS;
}

/** A secret-store read is local; a store that has not answered by then is reported as such, not waited on for the model's timeout. */
const KEY_LOOKUP_BOUND_MS = 5_000;

/**
 * The stored key, or undefined when the store has no such key. A store that
 * times out or fails is a different state from a missing key: the reading fails
 * with `unavailable` naming the store, instead of going out with an empty key and
 * coming back as "unauthorized" after a second wait.
 */
async function storedKey(secrets: JudgmentSettingsSource['secrets'], name: string, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = () => {};
  const boundMs = Math.min(timeoutMs, KEY_LOOKUP_BOUND_MS);
  try {
    signal?.throwIfAborted();
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new JudgmentError('unavailable', `judgment credential resolution timed out: the secret store did not return ${name} within ${boundMs} ms. Check that the secret store is unlocked and readable, then retry.`)), boundMs);
      cancelled = () => reject(new JudgmentError('aborted', 'the judgment call was cancelled'));
      signal?.addEventListener('abort', cancelled, { once: true });
    });
    const value = (await Promise.race([secrets.get(name), expired]))?.trim();
    return value === '' ? undefined : value;
  } catch (error) {
    if (signal?.aborted) throw new JudgmentError('aborted', 'the judgment call was cancelled');
    if (error instanceof JudgmentError) throw error;
    throw new JudgmentError('unavailable', `judgment credential resolution failed: the secret store could not read ${name} (${error instanceof Error ? error.message : String(error)}). Check that the secret store is unlocked and readable, then retry.`);
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); }
}

async function settingsKey(secrets: JudgmentSettingsSource['secrets'], keySource: JudgmentKeySource, keyName: string, envKey: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  if (keySource === 'none') return undefined;
  if (keySource !== 'secret') return envKey;
  return storedKey(secrets, keyName, timeoutMs, signal);
}

/**
 * The judgment config the engine settings describe: judgmentConfigFromEnv
 * over the environment, with judgment.endpoint, the key from judgment.keySource
 * and judgment.model standing in for their environment variables when set.
 */
export async function judgmentConfigFromSettings(source: JudgmentSettingsSource, signal?: AbortSignal): Promise<JudgmentConfig> {
  // Capture the destination and its credential source together before a secret
  // lookup can yield or invoke borrowed code. Hot reload applies to the next
  // reading, never to only part of a reading already acquiring its key.
  signal?.throwIfAborted();
  const keyName = text(source.config.get('judgment.keyName')) || JUDGMENT_KEY_NAME;
  const env = {
    TYPESAFE_API_KEY: source.env[keyName],
    TYPESAFE_BASE_URL: text(source.config.get('judgment.endpoint')) || source.env['TYPESAFE_BASE_URL'],
  };
  const model = settingsModel(source);
  const backend = captureJudgmentBackendSettings(source.config.get('judgment.backend'));
  const timeoutMs = source.config.get('judgment.timeoutMs');
  const keySource = source.config.get('judgment.keySource') as JudgmentKeySource;
  let targets: ReturnType<typeof captureJudgmentFallbackSettings>;
  try { targets = captureJudgmentFallbackSettings(source.config.get('judgment.fallbacks')); }
  catch { throw new JudgmentError('invalid-request', 'Invalid judgment fallback settings'); }
  const environmentKeys = targets.map(target => target.keySource === 'env' ? source.env[target.keyName] : undefined);
  const keyTimeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30_000;
  env.TYPESAFE_API_KEY = await settingsKey(source.secrets, keySource, keyName, env.TYPESAFE_API_KEY, keyTimeoutMs, signal);
  signal?.throwIfAborted();
  const fallbacks: NonNullable<JudgmentConfig['fallbacks']>[number][] = [];
  for (const [index, target] of targets.entries()) {
    let key: string | null | undefined;
    try { key = target.keySource === 'none' ? undefined : target.keySource === 'env' ? environmentKeys[index] : await storedKey(source.secrets, target.keyName, keyTimeoutMs, signal); }
    catch (error) {
      signal?.throwIfAborted();
      // A fallback whose key cannot be read is left out of this reading rather than sent with no key.
      logger.warn('Judgment fallback left out: its key could not be read', { endpoint: target.endpoint, keyName: target.keyName, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    signal?.throwIfAborted();
    fallbacks.push({ endpoint: { kind: endpointKind(target.endpoint), baseURL: target.endpoint, apiKey: key?.trim() ?? '',
      ...(target.keySource === 'none' ? { authentication: 'none' as const } : {}), ...target.backend }, model: target.model });
  }
  const baseURL = env.TYPESAFE_BASE_URL?.trim() || HOSTED_BASE_URL;
  return {
    endpoint: { kind: endpointKind(baseURL), baseURL, apiKey: env.TYPESAFE_API_KEY?.trim() ?? '',
      ...(keySource === 'none' ? { authentication: 'none' as const } : {}), ...backend },
    model, timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : 30_000, retry: {},
    ...(targets.length > 0 ? { fallbacks } : {}),
  };
}

/** Whether two configs reach the same endpoint with the same key, model and timeout. */
const sameConfig = (a: JudgmentConfig, b: JudgmentConfig): boolean =>
  a.endpoint.baseURL === b.endpoint.baseURL && a.endpoint.apiKey === b.endpoint.apiKey && a.model === b.model && a.timeoutMs === b.timeoutMs
  && JSON.stringify(a.endpoint) === JSON.stringify(b.endpoint)
  && (a.fallbacks?.length ?? 0) === (b.fallbacks?.length ?? 0)
  && (a.fallbacks ?? []).every((target, index) => {
    const other = b.fallbacks?.[index];
    return other !== undefined && target.model === other.model && target.endpoint.baseURL === other.endpoint.baseURL
      && target.endpoint.apiKey === other.endpoint.apiKey && target.endpoint.kind === other.endpoint.kind
      && JSON.stringify(target.endpoint) === JSON.stringify(other.endpoint);
  });

/** A secret-store read cannot strand runtime cancellation or its decision log. */
async function activeSettings(source: JudgmentSettingsSource, signal?: AbortSignal): Promise<JudgmentConfig> {
  if (!signal) return judgmentConfigFromSettings(source);
  signal.throwIfAborted();
  let cancelled = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancelled = () => reject(new JudgmentError('aborted', 'the judgment call was cancelled'));
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
  try { return await Promise.race([interrupted, judgmentConfigFromSettings(source, signal)]); }
  finally { signal.removeEventListener('abort', cancelled); }
}

/**
 * A port over the live settings. Each call reads the settings, so a changed
 * endpoint, key or model applies on the next judgment with no restart. Each
 * reading keeps the settings captured before its key lookup and throughout
 * the shared transport's retries; an edit never redirects an in-flight key or
 * payload to a new endpoint. The System One client is rebuilt only when the
 * config changes. A missing key fails the call (and the decision log records
 * the failure); Preferred may then select Classic in the owning operation; Classic never opens the port.
 */
export function createSettingsJudgmentPort(source: JudgmentSettingsSource): JudgmentPort {
  let current: { config: JudgmentConfig; port: JudgmentPort } | undefined;
  // One integer for what decides the answers: it moves when the configuration
  // or the credential store changed since it was last read (two integer reads).
  let observed: readonly [number | undefined, number | undefined] = [undefined, undefined];
  let revision = 0;
  return {
    get model(): string {
      return settingsModel(source);
    },
    revision(): number {
      const configuration = source.config.getConfigurationIncarnation?.();
      const credentials = source.secrets.getCredentialMutationState?.().generation;
      if (configuration !== observed[0] || credentials !== observed[1]) { observed = [configuration, credentials]; revision++; }
      return revision;
    },
    get decisionDeadlineMs(): number {
      return settingsDecisionDeadline(source);
    },
    health: () => current?.port.health?.() ?? [],
    async ask(request) {
      assertDecisionModelsEnabled('configured decision transport');
      const signal = request.signal;
      if (!signal) throw new JudgmentError('invalid-request', 'settings judgment calls require an owning AbortSignal');
      let config: JudgmentConfig;
      // A secret store that did not answer is `unavailable` like an exhausted transport: Preferred may fall back to Classic.
      try { config = await activeSettings(source, signal); }
      catch (error) { activateClassicFallback(error); throw error; }
      // Key acquisition may finish after runtime shutdown or caller cancellation.
      // Never create another transport or send a late request in that case.
      signal.throwIfAborted();
      if (current === undefined || !sameConfig(current.config, config)) current = { config, port: createSystemOnePort(config) };
      const beforeAttempt = request.beforeAttempt;
      try {
        return await current.port.ask({ ...request, signal, beforeAttempt() {
          signal.throwIfAborted(); assertDecisionModelsEnabled('configured decision transport');
          assertSynchronousJudgmentGuard(beforeAttempt);
          signal.throwIfAborted(); assertDecisionModelsEnabled('configured decision transport');
        } });
      }
      catch (error) {
        // The transport has exhausted its configured chain before reporting
        // unavailable. Preserve that fact even if an optional feature later
        // translates the error into its own held/unavailable result.
        activateClassicFallback(error);
        throw error;
      }
    },
  };
}

/** Ports whose composition has been disposed; never reinstalled. */
const retired = new WeakSet<JudgmentPort>();

export interface JudgmentServices {
  /** The installed port: settings-driven, recording to the decision log. */
  readonly port: JudgmentPort;
  /**
   * The port browser-initiated readings use: the same transport, lifetime and decision log as
   * `port`, with answers and failures validated and scrubbed before anything is retained.
   * Absent for a composition that hands the browser route its own port.
   */
  readonly browserPort?: JudgmentPort;
  readonly decisionLog: SqliteDecisionLog;
  /** Set when the previous log could not be read: it was kept aside and this one is new. */
  readonly decisionLogNotice?: string;
  /** Notes (readings, actions) the log could not write since the composition started; the work they describe was done. */
  readonly unrecordedNotes?: () => number;
  /** The call-volume monitor's last alert (budget breach, unreadable log), for status reads; the log line stays too. */
  readonly volumeMonitor: JudgmentVolumeMonitorHandle;
}

export interface JudgmentServicesInput extends JudgmentSettingsSource {
  /** The composition's state root; the decision log opens here. */
  readonly stateRoot: string;
  /** Cancels owned calls, drains their records, then closes the log on disposal. */
  readonly disposal: DisposalRegistry;
}

/**
 * The model names the browser answer boundary admits, from the same settings that build the
 * transport chain: the primary model, every configured fallback, and the response-model aliases
 * each endpoint declares. Read on every call so an edited chain applies at once.
 */
function browserBoundaryOptions(source: JudgmentSettingsSource): WebuiAnswerBoundaryOptions {
  const targets = captureJudgmentFallbackSettings(source.config.get('judgment.fallbacks'));
  const returned = new Map<string, Set<string>>();
  const declare = (model: string, aliases: readonly string[] | undefined): void => {
    if (aliases === undefined) return;
    const set = returned.get(model) ?? new Set<string>();
    for (const alias of aliases) set.add(alias);
    returned.set(model, set);
  };
  declare(settingsModel(source), captureJudgmentBackendSettings(source.config.get('judgment.backend')).responseModels);
  for (const target of targets) declare(target.model, target.backend?.responseModels);
  return {
    fallbackModels: targets.map(target => target.model),
    returnedModels: Object.fromEntries([...returned].map(([model, aliases]) => [model, [...aliases]])),
  };
}

/**
 * Builds a composition's judgment port from the judgment settings, recording
 * every call to the state root's decision log, and installs it as the port
 * every engine decision site reads through. Disposal retires the port and
 * cancels its outstanding calls before closing the log after their records
 * settle. Awaitable scopes wait for this drain; synchronous scopes start it.
 * When still installed, the port it replaced is restored unless retired too.
 * It is installed alongside other compositions of the process (embedded
 * daemons for separate workspaces): a later one never ends this one's
 * readings, and retiring one hands the process to the newest still running.
 */
export function composeJudgment(input: JudgmentServicesInput): JudgmentServices {
  const restorePolicy = configureDecisionModelPolicy(() => input.config.get('judgment.policy'));
  input.disposal.add('decision-model policy', restorePolicy);
  const { log: decisionLog, notice: decisionLogNotice } = openStateDecisionLogWithNotice(input.stateRoot);
  const transport = createSettingsJudgmentPort(input);
  const retention = scheduleDecisionLogRetention(decisionLog);
  let unrecordedNotes = 0;
  const onUnrecordedNote = (count: number): void => {
    unrecordedNotes += 1;
    // One notice for the composition; the count stays readable after it.
    if (unrecordedNotes === 1) {
      logger.warn('The decision log could not record a note about a finished judgment; the work itself was done. Check free disk space and that no other process holds the log for long.', { count });
    }
  };
  const lifetime = new AbortController();
  const active = new Set<Promise<unknown>>();
  // Both ports share one lifetime, one set of owned calls and one decision log.
  const owned = (base: JudgmentPort): JudgmentPort => {
    const recorded = withDecisionLog(base, decisionLog, { onUnrecordedNote });
    return {
      get model() { return recorded.model; },
      get decisionDeadlineMs() { return recorded.decisionDeadlineMs; },
      ...(recorded.health ? { health: () => recorded.health!() } : {}),
      ...(recorded.revision ? { revision: () => recorded.revision!() } : {}),
      recorder: recorded.recorder!,
      ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
        // Retained port references must not reopen a retired runtime or write to
        // its closed log. Calls admitted before retirement still record failure.
        if (lifetime.signal.aborted) return Promise.reject(new JudgmentError('aborted', 'the judgment runtime is shutting down'));
        // Reserve ownership before reading borrowed inputs or live settings:
        // their accessors can synchronously initiate runtime disposal.
        const { promise: work, resolve, reject } = Promise.withResolvers<JudgmentResult<Q>>();
        active.add(work);
        const release = () => { active.delete(work); };
        void work.then(release, release);
        try {
          const callerSignal = request.signal;
          const signal = callerSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, callerSignal]);
          void recorded.ask({ ...request, signal }).then(resolve, reject);
        } catch (error) { reject(error); }
        return work;
      },
    };
  };
  const port = owned(transport);
  // The boundary is placed per call, around the non-recording transport and inside the decision
  // log, so a malformed answer or a failure echo is never retained.
  const browserPort = owned({
    get model() { return transport.model; },
    get decisionDeadlineMs() { return transport.decisionDeadlineMs; },
    health: () => transport.health?.() ?? [],
    revision: () => transport.revision?.() ?? 0,
    ask(request) {
      let options: WebuiAnswerBoundaryOptions;
      try { options = browserBoundaryOptions(input); }
      catch { return Promise.reject(new JudgmentError('invalid-request', 'Invalid judgment settings')); }
      return withWebuiAnswerBoundary(transport, options).ask(request);
    },
  });
  const sourceLifetime = createJudgmentSourceLifetime(input);
  bindJudgmentPortAuthority(port, sourceLifetime.capture);
  bindJudgmentPortAuthority(browserPort, sourceLifetime.capture);
  const previous = installJudgmentPort(port, { alongside: true });
  // A daemon composing this runtime inside its scope: its readings keep this port.
  claimJudgmentRuntimeScope(port);
  input.disposal.add('judgment port and decision log', () => {
    retired.add(port);
    retention.dispose();
    sourceLifetime.dispose();
    restoreJudgmentPort(port, previous !== undefined && !retired.has(previous) ? previous : undefined);
    lifetime.abort(new JudgmentError('aborted', 'the judgment runtime is shutting down'));
    if (active.size === 0) { decisionLog[Symbol.dispose](); return; }
    // Keep returning the promise even through DisposalRegistry's legacy void
    // shape: AsyncDisposalRegistry observes it and waits before older owners.
    return Promise.allSettled([...active]).then(() => { decisionLog[Symbol.dispose](); });
  });
  const volumeMonitor = composeJudgmentVolumeMonitor(decisionLog, input.env, input.disposal, input.config);
  return { port, browserPort, decisionLog, volumeMonitor, unrecordedNotes: () => unrecordedNotes,
    ...(decisionLogNotice === undefined ? {} : { decisionLogNotice }) };
}
