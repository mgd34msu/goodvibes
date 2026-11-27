/**
 * Adopted SETTINGS transport. A capture reads what a change would touch and the
 * settings revision it was read at; the apply is one write that carries that
 * revision, so the daemon refuses it if the settings moved in between. Nothing
 * is held on the daemon between the two, and the write carries a request id so
 * an answer lost in transit can be asked for again without writing twice.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Refusal } from '@goodvibes/engine/errors';
import { daemonSecretKeyFor } from './daemon-secret-keys.js';
import { isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import { configKeyScope, describeConfigOwnership } from './config-ownership.js';
import { deriveControlPlaneBaseUrl } from './control-plane-base-url.js';
import { daemonRecordBaseUrl, detachedDaemonProcessAlive, detachedDaemonRuntimePath, type DetachedDaemonRuntimeHint } from '../runtime/detached-daemon-runtime.js';
import type { ConfigWriteRoute, DaemonConfigEndpoint, DaemonConfigRouterDeps } from './daemon-config-route.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { SettingsRefusalError, refusalText } from './settings-refusal.js';
import {
  hasFields, isRecord as record, pickFields, settingsApplyFailure, settingsCaptureRefusal, settingsOwnerBase, settingsOwnerHeaders,
  settingsOwnerRefusal, settingsOwnerTransportFailure, settingsOwnerVersionMismatch,
} from './settings-owner-wire.js';
import type { SettingsPreconditionFacts, SettingsPreconditionReceipt, SettingsPreconditionRequest } from '@goodvibes/engine/daemon-api';

export type { SettingsPreconditionRequest, SettingsPreconditionReceipt };
/**
 * What an apply reports. `failure` says why a receipt is not `committed` when
 * the client knows (daemon not reached, not authorised, versions differ, the
 * daemon's own refusal); `receiptUnreadable` marks a success answer whose
 * receipt this build could not read.
 */
export type RemoteSettingsReceipt = SettingsPreconditionReceipt & { readonly failure?: Refusal; readonly receiptUnreadable?: true };
declare const remoteBrand: unique symbol;
export interface RemoteSettingsPrecondition { readonly [remoteBrand]: true; }
export interface RemoteSettingsPreconditionFacts extends SettingsPreconditionFacts {
  readonly endpoint: string;
}
interface Entry {
  readonly facts: RemoteSettingsPreconditionFacts;
  readonly request: SettingsPreconditionRequest;
  /** The daemon serving period the facts were read in; revisions from another one never match. */
  readonly serving: string;
  readonly requestId: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly assertCurrent?: () => void;
  spent: boolean;
}
const SUBJECT = 'Settings change';
const entries = new WeakMap<RemoteSettingsPrecondition, Entry>();
function stale(): SettingsRefusalError { return new SettingsRefusalError('stale', refusalText(SUBJECT, 'stale')); }
function invalidRequest(detail: string): Error {
  return settingsOwnerRefusal({ code: 'SETTINGS_REQUEST_INVALID', state: 'settings change not sent; nothing was applied',
    reason: `The settings change request is not one this client sends: ${detail}`, next: ['Request a set or reset of one setting'], retryable: false });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function baseUrl(endpoint: DaemonConfigEndpoint): string { return settingsOwnerBase(SUBJECT, endpoint); }
const headers = settingsOwnerHeaders;
function runtimeRecordUnreadable(path: string): Error {
  return settingsOwnerRefusal({ code: 'DAEMON_RECORD_UNREADABLE', state: 'settings change not sent; nothing was applied',
    reason: `The daemon's runtime record ${path} could not be read`, next: ['Restart the daemon so it writes its runtime record again', 'Check the file\'s permissions'], retryable: true });
}
interface RuntimeObservation { readonly value: DetachedDaemonRuntimeHint | null; readonly stamp: string; }
function readRecord(dir: string): RuntimeObservation {
  let raw: string; let stamp: string;
  const path = detachedDaemonRuntimePath(dir);
  try {
    const before = statSync(path, { bigint: true });
    raw = readFileSync(path, 'utf8');
    const after = statSync(path, { bigint: true });
    const identity = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
    if (identity(before) !== identity(after)) throw stale();
    stamp = `${identity(after)}:${raw}`; // Private equality only, never logged or hashed.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, stamp: 'absent' };
    throw error instanceof SettingsRefusalError ? error : runtimeRecordUnreadable(path);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || typeof parsed.host !== 'string' || !Number.isInteger(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535
      || (parsed.pid !== undefined && (!Number.isInteger(parsed.pid) || Number(parsed.pid) < 1))) throw runtimeRecordUnreadable(path);
    const scheme = parsed.scheme === 'https' ? 'https' as const : undefined;
    return { value: { host: parsed.host, port: Number(parsed.port), ...(scheme ? { scheme } : {}), ...(parsed.pid === undefined ? {} : { pid: Number(parsed.pid) }) }, stamp };
  } catch { throw runtimeRecordUnreadable(path); }
}
const routeChecks = new WeakMap<ConfigWriteRoute, () => void>();
/** Exact returned observation only; copying a route never copies its binding. */
export function assertPreparedConfigWriteRoute(route: ConfigWriteRoute): void {
  const check = routeChecks.get(route); if (!check) throw stale(); check();
}
/** Non-mutating discovery. No quarantine, stale record reaping or receipt writes. */
export async function resolvePreparedConfigWriteRoute(key: string, deps: DaemonConfigRouterDeps, assertOwner?: () => void): Promise<ConfigWriteRoute> {
  assertOwner?.();
  const scope = configKeyScope(key);
  const reason = describeConfigOwnership(key);
  const hostsDaemon = deps.hostsDaemon;
  const configured = deps.endpoint ? { ...deps.endpoint } : null;
  const directory = deps.daemonHomeDir;
  const token = deps.token;
  const readRuntime = deps.readRuntimeRecord;
  const readBinding = deps.readDaemonBinding;
  const isProcessAlive = deps.isProcessAlive;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.probeTimeoutMs ?? 2_000;
  // Local client ownership and an explicit remote endpoint never need a disk
  // observation. For absent-daemon routing, record arrival retires the capture.
  const discover = scope === 'daemon' && !hostsDaemon && !configured?.baseUrl.trim() && !!directory;
  const observeRuntime = (): RuntimeObservation => {
    if (!discover) return { value: null, stamp: '' };
    if (!readRuntime) return readRecord(directory!);
    const value = readRuntime(directory!);
    const copy = value ? { ...value } : null;
    return { value: copy, stamp: JSON.stringify(copy) };
  };
  const runtimeObservation = observeRuntime();
  const binding = discover ? readBinding?.() : null;
  const bindingSnapshot = binding ? { ...binding } : null;
  const bindingStamp = JSON.stringify(bindingSnapshot);
  const configuredStamp = JSON.stringify(configured);
  const finish = (route: ConfigWriteRoute): ConfigWriteRoute => {
    const check = () => {
      assertOwner?.();
      if (deps.hostsDaemon !== hostsDaemon || deps.daemonHomeDir !== directory || deps.token !== token
        || deps.readRuntimeRecord !== readRuntime || deps.readDaemonBinding !== readBinding || deps.isProcessAlive !== isProcessAlive
        || (deps.fetchImpl ?? globalThis.fetch) !== fetchImpl || JSON.stringify(deps.endpoint ? { ...deps.endpoint } : null) !== configuredStamp
        || observeRuntime().stamp !== runtimeObservation.stamp
        || (discover && JSON.stringify(readBinding?.() ?? null) !== bindingStamp)) throw stale();
      assertOwner?.();
    };
    check(); // A routing change during a probe cannot be silently captured.
    Object.freeze(route); routeChecks.set(route, check); return route;
  };
  if (scope !== 'daemon' || hostsDaemon) return finish({ mode: 'local', scope, reason });
  if (configured?.baseUrl.trim()) return finish({ mode: 'daemon', scope, reason, endpoint: Object.freeze({ ...configured, baseUrl: baseUrl(configured), certain: true }) });
  if (!directory) return finish({ mode: 'local', scope, reason });
  const runtime = runtimeObservation.value;
  const runtimeEndpoint: DaemonConfigEndpoint | null = runtime && detachedDaemonProcessAlive(runtime, isProcessAlive)
    ? Object.freeze({ baseUrl: baseUrl({ baseUrl: daemonRecordBaseUrl(runtime), source: 'runtime' }), token, source: 'running-daemon record', certain: true }) : null;
  const bindingEndpoint: DaemonConfigEndpoint | null = bindingSnapshot
    ? Object.freeze({ baseUrl: deriveControlPlaneBaseUrl(bindingSnapshot, 'loopback'), token, source: 'control-plane binding in the daemon config', certain: true }) : null;
  for (const endpoint of [runtimeEndpoint, bindingEndpoint]) {
    if (!endpoint) continue;
    let answered = false;
    try {
      const response = await fetchImpl(`${baseUrl(endpoint)}/config`, { method: 'GET', headers: headers(endpoint), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      answered = response.status < 500 && !response.redirected;
    } catch { /* Probe is only discovery; no writes or fallback after capture. */ }
    if (answered) return finish({ mode: 'daemon', scope, reason, endpoint });
  }
  // A live-pid runtime record promised a daemon: retain loud unavailability.
  if (runtimeEndpoint) return finish({ mode: 'daemon', scope, reason, endpoint: runtimeEndpoint });
  return finish({ mode: 'local', scope, reason });
}

const DESTINATION_FIELDS = ['path', 'operation', 'tier'] as const;
function validDestination(value: unknown): value is Record<string, unknown> {
  return record(value) && hasFields(value, DESTINATION_FIELDS) && typeof value.path === 'string' && value.path.length > 0;
}
/** The facts this build reads, with fields a newer daemon adds dropped; undefined when they do not describe `request`. */
function readFacts(value: unknown, request: SettingsPreconditionRequest): SettingsPreconditionFacts | undefined {
  const compound = request.credentialClear === true;
  if (!record(value) || !hasFields(value, ['operation', 'key', 'value', 'destinations', 'incarnation', ...(compound ? ['credentialClear', 'credential'] : [])])
    || value.operation !== request.operation || value.key !== request.key || !Number.isSafeInteger(value.incarnation) || Number(value.incarnation) < 0
    || !Array.isArray(value.destinations) || value.destinations.length === 0 || value.destinations.length > 16
    || !value.destinations.every(validDestination)) return undefined;
  const destinations = (value.destinations as Record<string, unknown>[]).map(destination => pickFields(destination, DESTINATION_FIELDS));
  // Configuration is published first, the credential last (so a failure between
  // them leaves an orphan credential, never configuration pointing at a deleted one).
  let configCount = destinations.length;
  let credential: Record<string, unknown> | undefined;
  if (compound) {
    const raw = value.credential;
    const scope = configKeyScope(request.key) === 'daemon' ? 'daemon' : 'user';
    if (value.credentialClear !== true || !record(raw) || !hasFields(raw, ['key', 'scope', 'destinations'])
      || raw.key !== daemonSecretKeyFor(request.key) || raw.scope !== scope
      || !Array.isArray(raw.destinations) || raw.destinations.length >= destinations.length || !raw.destinations.every(validDestination)) return undefined;
    configCount = destinations.length - raw.destinations.length;
    const credentialDestinations = (raw.destinations as Record<string, unknown>[]).map(destination => pickFields(destination, DESTINATION_FIELDS));
    if (!credentialDestinations.every((destination, index) => destination.operation === 'remove' && destination.tier === scope
      && DESTINATION_FIELDS.every(field => destination[field] === destinations[configCount + index]![field]))) return undefined;
    credential = { key: raw.key, scope, destinations: credentialDestinations };
  }
  if (!destinations.every((destination, index) => index < configCount
    ? destination.operation === 'set' && ['global', 'project', 'daemon', 'shared'].includes(String(destination.tier))
    : destination.operation === 'remove' && destination.tier === credential?.scope)) return undefined;
  return {
    operation: value.operation, key: value.key, value: value.value, incarnation: Number(value.incarnation),
    destinations, ...(credential ? { credentialClear: true, credential } : {}),
  } as unknown as SettingsPreconditionFacts;
}
export async function captureRemoteSettingsPrecondition(
  endpoint: DaemonConfigEndpoint,
  request: SettingsPreconditionRequest,
  deps: Pick<DaemonConfigRouterDeps, 'fetchImpl' | 'timeoutMs'> & {
    readonly assertCurrent?: () => void;
    /** Who decided this write, from the call site (manager.ts `DaemonWritePress`): sent with the capture and the apply. */
    readonly press?: { readonly personAsked?: boolean | undefined; readonly decidedByProgramGate?: boolean | undefined } | undefined;
  } = {},
): Promise<RemoteSettingsPrecondition> {
  try { deps.assertCurrent?.(); } catch { throw stale(); }
  if (!['set', 'reset-default'].includes(request.operation)) throw invalidRequest(`operation ${String(request.operation)}`);
  if (request.credentialClear !== undefined && request.credentialClear !== true) throw invalidRequest('credentialClear must be true when present');
  // Protect before serialization/network, not just before the later Jev call.
  const input = snapshotJudgmentInput({ mode: 'set', key: request.key, value: request.value }, 'goodvibes_settings') as { key: string; value: unknown };
  if (request.credentialClear && (!isSecretBearingConfigKey(input.key) || (request.operation === 'set' && input.value !== ''))) {
    throw invalidRequest('a credential can be cleared only with its own setting, by a reset or an empty value');
  }
  const capturedRequest: SettingsPreconditionRequest = Object.freeze({ operation: request.operation, key: input.key,
    ...(request.operation === 'set' ? { value: input.value } : {}), ...(request.credentialClear ? { credentialClear: true } : {}) });
  const endpointUrl = baseUrl(endpoint);
  const url = `${endpointUrl}/config`;
  const authHeaders = Object.freeze({
    ...headers(endpoint),
    ...(deps.press?.personAsked === true ? { 'x-goodvibes-explicit-user-request': 'true' } : {}),
    ...(deps.press?.decidedByProgramGate === true ? { 'x-goodvibes-decided-by-capability-gate': 'true' } : {}),
  });
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: authHeaders, redirect: 'error',
      body: JSON.stringify({ settingsPrecondition: { version: 1, action: 'capture', ...capturedRequest } }), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) { throw settingsOwnerTransportFailure(SUBJECT, error, { url: endpointUrl, applying: false }).error; }
  if (!response.ok || response.redirected) throw await settingsCaptureRefusal(SUBJECT, response);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw settingsOwnerVersionMismatch(SUBJECT, 'the capture answer is not JSON', false); }
  const arm = record(payload) && record(payload.settingsPrecondition) ? payload.settingsPrecondition : undefined;
  if (!arm || !hasFields(arm, ['version', 'action', 'facts', 'serving']) || arm.version !== 1 || arm.action !== 'captured'
    || typeof arm.serving !== 'string' || !arm.serving || arm.serving.length > 128) {
    throw settingsOwnerVersionMismatch(SUBJECT, 'the capture answer lacks the version 1 fields', false);
  }
  const read = readFacts(arm.facts, capturedRequest);
  if (!read) throw settingsOwnerVersionMismatch(SUBJECT, 'the captured facts do not describe this change', false);
  // Serving normalization still traverses the same protected-input boundary.
  const safe = snapshotJudgmentInput({ mode: 'set', key: read.key, value: read.value }, 'goodvibes_settings') as { value: unknown };
  const facts = freeze({ ...read, value: safe.value, endpoint: endpointUrl });
  try { deps.assertCurrent?.(); } catch { throw stale(); }
  const handle = Object.freeze({}) as RemoteSettingsPrecondition;
  entries.set(handle, { facts, request: capturedRequest, serving: arm.serving as string, requestId: randomUUID(), url, headers: authHeaders, fetchImpl, timeoutMs,
    ...(deps.assertCurrent ? { assertCurrent: deps.assertCurrent } : {}), spent: false });
  return handle;
}
export function inspectRemoteSettingsPrecondition(handle: RemoteSettingsPrecondition): RemoteSettingsPreconditionFacts {
  const entry = entries.get(handle); if (!entry) throw stale(); return entry.facts;
}
export function assertRemoteSettingsPrecondition(handle: RemoteSettingsPrecondition): void {
  const entry = entries.get(handle); if (!entry) throw stale();
  if (entry.spent) throw new SettingsRefusalError('spent', refusalText(SUBJECT, 'spent'));
  try { entry.assertCurrent?.(); } catch { entry.spent = true; throw stale(); }
}
/** The receipt fields this build reads, with fields a newer daemon adds dropped; undefined when it cannot be read. */
function readReceipt(value: unknown, facts: RemoteSettingsPreconditionFacts): SettingsPreconditionReceipt | undefined {
  if (!record(value) || !['committed', 'partial', 'unknown'].includes(String(value.status)) || !Array.isArray(value.completedPaths)
    || value.completedPaths.length > facts.destinations.length) return undefined;
  const paths = facts.destinations.map(destination => destination.path);
  if (!value.completedPaths.every((path, index) => typeof path === 'string' && path === paths[index])) return undefined;
  const completedPaths = Object.freeze([...value.completedPaths as string[]]);
  if (value.status === 'committed') {
    if (completedPaths.length !== paths.length || value.uncertainPath !== undefined) return undefined;
    return Object.freeze({ status: 'committed', completedPaths, verifiedInOwningStore: value.verifiedInOwningStore === true });
  }
  const uncertainPath = typeof value.uncertainPath === 'string' ? value.uncertainPath : undefined;
  if (value.status === 'partial' && (completedPaths.length === 0 || completedPaths.length >= paths.length)) return undefined;
  if (value.status === 'unknown' && completedPaths.length > 0) return undefined;
  return Object.freeze({ status: value.status as 'partial' | 'unknown', completedPaths, ...(uncertainPath === undefined ? {} : { uncertainPath }) });
}
/** The daemon's precondition refusals all precede any effect; only they mean "nothing was applied". */
const REFUSAL_CODES: readonly string[] = ['SETTINGS_PRECONDITION_STALE', 'SETTINGS_PRECONDITION_UNAVAILABLE', 'SETTINGS_PRECONDITION_INVALID', 'PAIRING_STORE_FAULTED'];
export async function applyRemoteSettingsPrecondition(handle: RemoteSettingsPrecondition): Promise<RemoteSettingsReceipt> {
  assertRemoteSettingsPrecondition(handle);
  const entry = entries.get(handle)!;
  // Synchronous retirement before the single dispatch. Authentic admission must
  // be checked by the manager/registry immediately before calling this method.
  entry.spent = true;
  const none = Object.freeze([]) as readonly string[];
  const body = JSON.stringify({ settingsPrecondition: { version: 1, action: 'write', ...entry.request,
    ifIncarnation: entry.facts.incarnation, ifServing: entry.serving, requestId: entry.requestId } });
  const send = () => entry.fetchImpl(entry.url, { method: 'POST', headers: entry.headers, redirect: 'error', body, signal: AbortSignal.timeout(entry.timeoutMs) });
  let response: Response;
  let resent = false;
  try {
    response = await send();
  } catch (error) {
    const failure = settingsOwnerTransportFailure(SUBJECT, error, { url: entry.facts.endpoint, applying: true });
    if (failure.notSent) return Object.freeze({ status: 'unknown', completedPaths: none, refused: true as const, failure: failure.error.refusal });
    // The write may have reached the daemon. The same request id is answered
    // with the first result, or written once if the first never arrived.
    try { response = await send(); } catch {
      return Object.freeze({ status: 'unknown', completedPaths: none, failure: failure.error.refusal });
    }
    resent = true;
  }
  if (!response.ok || response.redirected) {
    const failure = await settingsApplyFailure(SUBJECT, response, REFUSAL_CODES);
    if (resent) {
      // A refusal of the resend says nothing about the first attempt, which may
      // have been applied before its answer was lost (a daemon that restarted
      // since no longer knows the request id), so it is never "nothing applied".
      return Object.freeze({ status: 'unknown', completedPaths: none, ...(failure.reason ? { refusalReason: failure.reason } : {}),
        failure: { ...failure.refusal,
          state: 'settings change outcome unknown: the first attempt\'s answer was lost and the resend was refused, so it may or may not have been applied',
          next: [`Read ${entry.facts.key} on the daemon (goodvibes-daemon config get ${entry.facts.key}) before changing it again.`] } });
    }
    return Object.freeze({ status: 'unknown', completedPaths: none, ...(failure.refusedBeforeEffect ? { refused: true as const } : {}),
      ...(failure.reason ? { refusalReason: failure.reason } : {}), failure: failure.refusal });
  }
  const unreadable = (detail: string): RemoteSettingsReceipt => Object.freeze({ status: 'unknown', completedPaths: none, receiptUnreadable: true,
    failure: settingsOwnerVersionMismatch(SUBJECT, detail, true).refusal });
  let payload: unknown;
  try { payload = await response.json(); } catch { return unreadable('the write answer is not JSON'); }
  const arm = record(payload) && record(payload.settingsPrecondition) ? payload.settingsPrecondition : undefined;
  if (!arm || arm.version !== 1 || arm.action !== 'written' || arm.requestId !== entry.requestId) return unreadable('the write answer lacks the version 1 fields');
  return readReceipt(arm.receipt, entry.facts) ?? unreadable('the receipt does not match the captured destinations');
}
