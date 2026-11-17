import type { SettingsImportPreconditionRequest, SettingsImportPreconditionFacts, SettingsImportPreconditionReceipt } from '@goodvibes-jev/engine/daemon-api';
import type { Refusal } from '@goodvibes-jev/engine/errors';
import { SettingsRefusalError, refusalText } from './settings-refusal.js';
import {
  hasFields, isRecord as record, pickFields, settingsApplyFailure, settingsCaptureRefusal, settingsOwnerBase, settingsOwnerHeaders,
  settingsOwnerRefusal, settingsOwnerSignal, settingsOwnerTransportFailure, settingsOwnerVersionMismatch,
} from './settings-owner-wire.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { daemonSecretKeyFor } from './daemon-secret-keys.js';
import { isDaemonOwnedConfigKey } from './config-ownership.js';
import { isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import { isSecretRefInput } from './secret-refs.js';
import type { DaemonConfigEndpoint, DaemonConfigRouterDeps } from './daemon-config-route.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';

export type { SettingsImportPreconditionRequest, SettingsImportPreconditionReceipt };
/** What an import apply reports; `failure` and `receiptUnreadable` as for one change (settings-precondition-client.ts). */
export type RemoteSettingsImportReceipt = SettingsImportPreconditionReceipt & { readonly failure?: Refusal; readonly receiptUnreadable?: true };
declare const remoteImportBrand: unique symbol;
export interface RemoteSettingsImportPrecondition { readonly [remoteImportBrand]: true; }
export interface RemoteSettingsImportPreconditionFacts extends SettingsImportPreconditionFacts {
  readonly endpoint: string;
  readonly expiresAt: number;
}
export interface RemoteSettingsImportRestriction { readonly signal?: AbortSignal; readonly assertCurrent?: () => void; }
interface Entry {
  readonly facts: RemoteSettingsImportPreconditionFacts;
  readonly reference: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly expiresAt: number;
  readonly restriction: RemoteSettingsImportRestriction;
  phase: 'ready' | 'pending' | 'completed';
  receipt?: SettingsImportPreconditionReceipt;
}
const SUBJECT = 'Settings import';
const entries = new WeakMap<RemoteSettingsImportPrecondition, Entry>();
function stale(): SettingsRefusalError { return new SettingsRefusalError('stale', refusalText(SUBJECT, 'stale')); }
function invalidRequest(detail: string): Error {
  return settingsOwnerRefusal({ code: 'SETTINGS_REQUEST_INVALID', state: 'settings import not sent; nothing was applied',
    reason: `The settings import is not one this client sends: ${detail}`, next: ['Import a list of distinct daemon-owned settings, each with a key and a value'], retryable: false });
}
function assertSynchronous(check: (() => void) | undefined): void {
  assertSynchronousJudgmentGuard(check, stale);
}
const DESTINATION_FIELDS = ['path', 'operation', 'tier'] as const;
function destination(value: unknown): value is Record<string, unknown> {
  return record(value) && hasFields(value, DESTINATION_FIELDS) && typeof value.path === 'string' && value.path.length > 0
    && ['set', 'remove'].includes(String(value.operation)) && typeof value.tier === 'string' && value.tier.length > 0;
}
function expectedSetting(key: string, value: unknown): { value: unknown; credential?: { key: string; scope: 'daemon'; configured: boolean } } {
  if (!isSecretBearingConfigKey(key)) return { value };
  if (typeof value !== 'string') throw invalidRequest(`${key} holds a credential and takes a string`);
  const trimmed = value.trim(), secretKey = daemonSecretKeyFor(key);
  if (trimmed.startsWith('goodvibes://secrets/') && isSecretRefInput(trimmed)) return { value: trimmed };
  if (trimmed.startsWith('goodvibes://')) throw invalidRequest(`${key} holds a goodvibes:// address that is not a secret reference`);
  return { value: trimmed ? `goodvibes://secrets/goodvibes/${encodeURIComponent(secretKey)}` : '',
    credential: { key: secretKey, scope: 'daemon', configured: !!trimmed } };
}
/** The facts this build reads, with fields a newer daemon adds dropped; undefined when they do not describe `request`. */
function readFacts(value: unknown, request: SettingsImportPreconditionRequest): SettingsImportPreconditionFacts | undefined {
  if (!record(value) || !hasFields(value, ['operation', 'effects', 'incarnation', 'destinations'])
    || value.operation !== 'import' || !Number.isSafeInteger(value.incarnation) || Number(value.incarnation) < 0
    || !Array.isArray(value.effects) || value.effects.length !== request.settings.length || !Array.isArray(value.destinations)
    || !value.destinations.length || !value.destinations.every(destination)) return undefined;
  const expectedCredentials: { key: string; scope: 'daemon'; configured: boolean }[] = [];
  const effects: Record<string, unknown>[] = [];
  const effectDestinations: Record<string, unknown>[] = [];
  for (const [index, setting] of request.settings.entries()) {
    const effect: unknown = value.effects[index], expected = expectedSetting(setting.key, setting.value);
    if (!record(effect) || !hasFields(effect, ['operation', 'key', 'value', 'destinations']) || effect.operation !== 'set' || effect.key !== setting.key
      || JSON.stringify(effect.value) !== JSON.stringify(expected.value) || !Array.isArray(effect.destinations) || !effect.destinations.length
      || !effect.destinations.every(item => destination(item) && item.operation === 'set'
        && ['global', 'project', 'daemon', 'shared'].includes(String(item.tier)))) return undefined;
    const destinations = (effect.destinations as Record<string, unknown>[]).map(item => pickFields(item, DESTINATION_FIELDS));
    effects.push({ operation: 'set', key: effect.key, value: effect.value, destinations });
    effectDestinations.push(...destinations);
    if (expected.credential) expectedCredentials.push(expected.credential);
  }
  let credential: Record<string, unknown> | undefined;
  let credentialDestinations: Record<string, unknown>[] = [];
  if (expectedCredentials.length) {
    const raw = value.credential;
    if (!record(raw) || !hasFields(raw, ['items', 'destinations']) || !Array.isArray(raw.items)
      || raw.items.length !== expectedCredentials.length || !raw.items.every((item, index) => record(item)
        && hasFields(item, ['key', 'scope', 'configured']) && item.key === expectedCredentials[index]!.key
        && item.scope === 'daemon' && item.configured === expectedCredentials[index]!.configured)
      || !Array.isArray(raw.destinations) || !raw.destinations.every(item => destination(item)
        && item.operation === 'set' && ['daemon', 'keyfile'].includes(String(item.tier)))) return undefined;
    credentialDestinations = (raw.destinations as Record<string, unknown>[]).map(item => pickFields(item, DESTINATION_FIELDS));
    credential = { items: expectedCredentials.map(item => ({ ...item })), destinations: credentialDestinations };
  } else if (value.credential !== undefined) return undefined;
  const destinations = (value.destinations as Record<string, unknown>[]).map(item => pickFields(item, DESTINATION_FIELDS));
  if (JSON.stringify(destinations) !== JSON.stringify([...credentialDestinations, ...effectDestinations])) return undefined;
  // Original complete value-safe facts pass the protected-input boundary before any hosted judgment.
  return snapshotJudgmentInput({ operation: 'import', effects, incarnation: Number(value.incarnation), destinations,
    ...(credential ? { credential } : {}) }, 'goodvibes_settings') as unknown as SettingsImportPreconditionFacts;
}
function assertSource(entry: Entry): void {
  entry.restriction.signal?.throwIfAborted(); assertSynchronous(entry.restriction.assertCurrent);
  if (entry.expiresAt <= Date.now()) throw stale();
}
/** Private authenticated capture: raw imported values never enter a judgment request. */
export async function captureRemoteSettingsImportPrecondition(endpoint: DaemonConfigEndpoint, request: SettingsImportPreconditionRequest,
  deps: Pick<DaemonConfigRouterDeps, 'fetchImpl' | 'timeoutMs'> & RemoteSettingsImportRestriction = {}): Promise<RemoteSettingsImportPrecondition> {
  deps.signal?.throwIfAborted(); assertSynchronous(deps.assertCurrent);
  const input = captureStrictJudgmentJson(request, () => invalidRequest('the settings are not plain JSON'));
  if (!record(input) || !Array.isArray(input.settings) || !input.settings.length) throw invalidRequest('there are no settings to import');
  const settings = input.settings as unknown[];
  if (!settings.every(setting => record(setting) && hasFields(setting, ['key', 'value']) && typeof setting.key === 'string')) throw invalidRequest('every setting needs a key and a value');
  const typed = settings as { key: string; value: unknown }[];
  const notDaemon = typed.find(setting => !isDaemonOwnedConfigKey(setting.key));
  if (notDaemon) throw invalidRequest(`${notDaemon.key} is not a daemon-owned setting`);
  if (new Set(typed.map(setting => setting.key)).size !== typed.length) throw invalidRequest('a setting is listed twice');
  const captured: SettingsImportPreconditionRequest = { settings: typed.map(setting => ({ key: setting.key, value: setting.value })) };
  for (const setting of captured.settings) expectedSetting(setting.key, setting.value);
  const base = settingsOwnerBase(SUBJECT, endpoint), fetchImpl = deps.fetchImpl ?? globalThis.fetch, timeoutMs = deps.timeoutMs ?? 10_000;
  const headers = settingsOwnerHeaders(endpoint);
  const localExpiresAt = Date.now() + 300_000;
  deps.signal?.throwIfAborted(); assertSynchronous(deps.assertCurrent);
  let response: Response;
  try {
    response = await fetchImpl(`${base}/config`, { method: 'POST', headers, redirect: 'error',
      body: JSON.stringify({ settingsImportPrecondition: { version: 1, action: 'capture', settings: captured.settings } }), signal: settingsOwnerSignal(timeoutMs, deps.signal) });
  } catch (error) { throw settingsOwnerTransportFailure(SUBJECT, error, { signal: deps.signal, url: base, applying: false }).error; }
  if (!response.ok || response.redirected) throw await settingsCaptureRefusal(SUBJECT, response);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw settingsOwnerVersionMismatch(SUBJECT, 'the capture answer is not JSON', false); }
  const arm = record(payload) && record(payload.settingsImportPrecondition) ? payload.settingsImportPrecondition : undefined;
  if (!arm || !hasFields(arm, ['version', 'action', 'reference', 'expiresAt', 'facts']) || arm.version !== 1 || arm.action !== 'captured'
    || typeof arm.reference !== 'string' || !arm.reference || arm.reference.length > 128 || !Number.isSafeInteger(arm.expiresAt)) {
    throw settingsOwnerVersionMismatch(SUBJECT, 'the capture answer lacks the version 1 fields', false);
  }
  if (Number(arm.expiresAt) <= Date.now()) throw stale();
  const read = readFacts(arm.facts, captured);
  if (!read) throw settingsOwnerVersionMismatch(SUBJECT, 'the captured facts do not describe this import', false);
  const facts = captureStrictJudgmentJson({ ...read, endpoint: base, expiresAt: Number(arm.expiresAt) }, stale) as RemoteSettingsImportPreconditionFacts;
  const entry: Entry = { facts, reference: arm.reference, url: `${base}/config`, headers, fetchImpl, timeoutMs,
    expiresAt: Math.min(localExpiresAt, Number(arm.expiresAt)), restriction: Object.freeze({ ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.assertCurrent ? { assertCurrent: deps.assertCurrent } : {}) }), phase: 'ready' };
  assertSource(entry);
  const handle = Object.freeze({}) as RemoteSettingsImportPrecondition; entries.set(handle, entry); return handle;
}
export function inspectRemoteSettingsImportPrecondition(handle: RemoteSettingsImportPrecondition): RemoteSettingsImportPreconditionFacts {
  const entry = entries.get(handle); if (!entry) throw stale(); return entry.facts;
}
export function assertRemoteSettingsImportPrecondition(handle: RemoteSettingsImportPrecondition): void {
  const entry = entries.get(handle); if (!entry) throw stale();
  if (entry.phase !== 'ready') throw new SettingsRefusalError('spent', refusalText(SUBJECT, 'spent'));
  assertSource(entry);
}
/** The receipt fields this build reads, with fields a newer daemon adds dropped; undefined when it cannot be read. */
function readReceipt(value: unknown, facts: RemoteSettingsImportPreconditionFacts): SettingsImportPreconditionReceipt | undefined {
  if (!record(value) || !['committed', 'partial', 'unknown'].includes(String(value.status)) || !Array.isArray(value.completedPaths)) return undefined;
  const paths = facts.destinations.map(item => item.path), completed = value.completedPaths as unknown[];
  if (completed.length > paths.length || !completed.every((path, index) => path === paths[index])) return undefined;
  const completedPaths = Object.freeze([...completed as string[]]);
  if (value.status === 'committed') {
    if (completedPaths.length !== paths.length || value.uncertainPath !== undefined) return undefined;
    return Object.freeze({ status: 'committed', completedPaths, verifiedInOwningStore: value.verifiedInOwningStore === true });
  }
  if (value.status === 'partial' && (!completedPaths.length || completedPaths.length >= paths.length)) return undefined;
  if (value.status === 'unknown' && completedPaths.length) return undefined;
  const uncertainPath = typeof value.uncertainPath === 'string' ? value.uncertainPath : undefined;
  return Object.freeze({ status: value.status as 'partial' | 'unknown', completedPaths, ...(uncertainPath === undefined ? {} : { uncertainPath }) });
}
/** The daemon's import precondition refusals all precede any effect; only they mean "nothing was applied". */
const REFUSAL_CODES: readonly string[] = ['SETTINGS_IMPORT_PRECONDITION_STALE', 'SETTINGS_IMPORT_PRECONDITION_UNAVAILABLE', 'SETTINGS_IMPORT_PRECONDITION_INVALID', 'PAIRING_STORE_FAULTED'];
export async function applyRemoteSettingsImportPrecondition(handle: RemoteSettingsImportPrecondition,
  restriction: RemoteSettingsImportRestriction = {}): Promise<RemoteSettingsImportReceipt> {
  assertRemoteSettingsImportPrecondition(handle); restriction.signal?.throwIfAborted(); assertSynchronous(restriction.assertCurrent);
  const entry = entries.get(handle)!;
  entry.phase = 'pending';
  const none = Object.freeze([]) as readonly string[];
  const signal = restriction.signal ? (entry.restriction.signal ? AbortSignal.any([restriction.signal, entry.restriction.signal]) : restriction.signal) : entry.restriction.signal;
  let response: Response;
  try {
    assertSource(entry); restriction.signal?.throwIfAborted(); assertSynchronous(restriction.assertCurrent);
    response = await entry.fetchImpl(entry.url, { method: 'POST', headers: entry.headers, redirect: 'error',
      body: JSON.stringify({ settingsImportPrecondition: { version: 1, action: 'apply', reference: entry.reference } }),
      signal: settingsOwnerSignal(entry.timeoutMs, signal) });
  } catch (error) {
    if (error instanceof SettingsRefusalError || signal?.aborted) {
      return Object.freeze({ status: 'unknown', completedPaths: none, refused: true as const, failure: settingsOwnerRefusal({
        code: 'SETTINGS_IMPORT_CANCELLED', state: 'settings import not sent; nothing was applied', reason: 'The import was cancelled or went stale before it was sent', next: ['Capture the import again'] }).refusal });
    }
    const failure = settingsOwnerTransportFailure(SUBJECT, error, { url: entry.facts.endpoint, applying: true });
    return Object.freeze({ status: 'unknown', completedPaths: none, ...(failure.notSent ? { refused: true as const } : {}), failure: failure.error.refusal });
  }
  if (!response.ok || response.redirected) {
    const failure = await settingsApplyFailure(SUBJECT, response, REFUSAL_CODES);
    return Object.freeze({ status: 'unknown', completedPaths: none, ...(failure.refusedBeforeEffect ? { refused: true as const } : {}),
      ...(failure.reason ? { refusalReason: failure.reason } : {}), failure: failure.refusal });
  }
  const unreadable = (detail: string): RemoteSettingsImportReceipt => Object.freeze({ status: 'unknown', completedPaths: none, receiptUnreadable: true,
    failure: settingsOwnerVersionMismatch(SUBJECT, detail, true).refusal });
  let payload: unknown;
  try { payload = await response.json(); } catch { return unreadable('the apply answer is not JSON'); }
  const arm = record(payload) && record(payload.settingsImportPrecondition) ? payload.settingsImportPrecondition : undefined;
  if (!arm || arm.version !== 1 || arm.action !== 'applied' || arm.reference !== entry.reference) return unreadable('the apply answer lacks the version 1 fields');
  const receipt = readReceipt(arm.receipt, entry.facts);
  if (!receipt) return unreadable('the receipt does not match the captured destinations');
  // Preserve the actual receipt even if cancellation or source retirement follows the write.
  entry.receipt = receipt; entry.phase = 'completed';
  return receipt;
}
export function assertCompletedRemoteSettingsImportPrecondition(handle: RemoteSettingsImportPrecondition): void {
  const entry = entries.get(handle);
  if (!entry || entry.phase !== 'completed' || entry.receipt?.status !== 'committed' || entry.receipt.verifiedInOwningStore !== true) {
    throw settingsOwnerRefusal({ code: 'SETTINGS_IMPORT_UNCONFIRMED', state: 'the settings import is not confirmed in the daemon\'s settings',
      reason: entry?.receipt ? `The daemon reported the import as ${entry.receipt.status}${entry.receipt.status === 'committed' ? ' but could not read it back' : ''}` : 'The import has not completed',
      next: ['Read the imported settings to see which values took effect'], retryable: false });
  }
  assertSource(entry);
}
