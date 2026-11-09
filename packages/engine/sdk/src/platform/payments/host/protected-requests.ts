/** Original checkout facts, encrypted at rest. These records never confer
 * paired authority or browser access, and are not a continuation grant. */
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { encryptStore, decryptStore, SECRETS_STORE_FORMAT_VERSION, type EncryptedStoreEnvelope } from '../../config/secrets-keyfile.js';
import { observeImportFile, assertImportFileCurrent, type ImportFileObservation } from '../../config/prepared-import.js';
import { confirmFileDurable, writeFileAtomic } from '../../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation, type FileObservation } from '../../utils/file-observation.js';
import { captureRetainedTaintEvidence, type RetainedTaintEvidence } from '../../security/untrusted-content.js';
import type { NativePairedSnapshot } from '../../security/http-auth.js';
import { readCheckoutReadingInput } from '../checkout-reading-input.js';
import type { BeginCheckoutInput, PaymentsServiceConfig } from '../payments-gateway-service.js';
import { checkoutRequestId } from './operation-store.js';
import type { NativeContinuationGrant } from '../../pairing/pairing-token-store.js';
import { capturePaymentContinuation } from './continuation-binding.js';
import { captureBrowserPageConnection, type BrowserPageConnection } from '../../browser/browser-page-connection-data.js';
import { captureBrowserControlSnapshot, type BrowserControlSnapshot } from '../../browser/browser-control-snapshot-data.js';
import { captureBrowserCheckoutRecovery, type BrowserCheckoutRecovery } from '../../browser/browser-checkout-recovery-data.js';
import { captureCheckoutWindowCheckpoint, type CheckoutWindowCheckpoint } from '../checkout-window-checkpoint.js';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { capturePaymentReplyHistory, capturePaymentReplyHistoryEntry, paymentReplyHistoryBinding, historyEntryIdentity,
  type PaymentReplyHistory, type PaymentReplyHistoryBinding, type PaymentReplyHistoryEntry } from '../reply-history.js';

export interface PaymentRequestHostFacts {
  readonly authority: NativePairedSnapshot;
  readonly configuration: PaymentsServiceConfig;
  /** A reference only; recovery must consult the original issuing owner. */
  readonly continuation?: NativeContinuationGrant;
  /** Actual original endpoint/tab/document facts; parsing cannot authorize attach. */
  readonly browser?: BrowserPageConnection;
  readonly browserControls?: BrowserControlSnapshot;
}
export interface ProtectedPaymentRequest {
  readonly version: 1;
  readonly purchaseId: string;
  readonly operationId: string;
  readonly principalId: string;
  readonly input: BeginCheckoutInput;
  readonly evidence: RetainedTaintEvidence;
  readonly host: PaymentRequestHostFacts;
  /** Actual latest window facts; admission-only records omit this field. */
  readonly window?: CheckoutWindowCheckpoint;
  readonly replyHistory?: PaymentReplyHistory;
}
export interface PaymentRequestStore {
  readonly supportsReplyHistory?: boolean;
  retain(request: ProtectedPaymentRequest, assertCurrent: () => void): Promise<void>;
  read(purchaseId: string, operationId: string, assertCurrent: () => void): Promise<ProtectedPaymentRequest>;
  remove(purchaseId: string, operationId: string, assertCurrent: () => void): Promise<void>;
  checkpointWindow?(purchaseId: string, operationId: string, window: CheckoutWindowCheckpoint,
    browser: BrowserCheckoutRecovery | null, assertCurrent: () => void): Promise<void>;
  appendReply?(purchaseId: string, operationId: string, binding: PaymentReplyHistoryBinding,
    entry: PaymentReplyHistoryEntry, assertCurrent: () => void): Promise<void>;
}
export class ProtectedPaymentRequestError extends Error {
  override readonly name = 'ProtectedPaymentRequestError';
  constructor() { super('The original protected checkout request could not be confirmed. Inspect this purchase status before retrying.'); }
}
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 2 * MAX_REQUEST_BYTES + 1_024;
const absent = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const amount = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const tier = (value: unknown): boolean => value === 'normal' || value === 'fast' || value === 'fastest';
function optionalFields(row: Record<string, unknown>, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const copy = { ...row };
  for (const key of keys) if (copy[key] === undefined) delete copy[key];
  return Object.freeze(copy);
}
function current(check: () => void): void {
  const result: unknown = check();
  if (result !== undefined) { drainOwned(result); throw new ProtectedPaymentRequestError(); }
}
function own(value: unknown): ProtectedPaymentRequest {
  const row = captureOwnedJson(value);
  if (!object(row) || Object.keys(row).length !== 7 + (Object.hasOwn(row, 'window') ? 1 : 0) + (Object.hasOwn(row, 'replyHistory') ? 1 : 0) || row['version'] !== 1
    || !text(row['principalId']) || !text(row['operationId']) || !/^payment-operation:[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/.test(row['operationId'])) throw new ProtectedPaymentRequestError();
  checkoutRequestId(row['purchaseId']);
  const input = row['input'], host = row['host'];
  if (!object(input) || !['sessionId', 'pageId', 'merchantDomain', 'checkoutUrl', 'item', 'cardId'].every(key => text(input[key]))
    || !Array.isArray(input['requestedLines']) || input['requestedLines'].length === 0
    || input['requestedLines'].some(line => !object(line) || !text(line['label']) || !Number.isSafeInteger(line['quantity']) || Number(line['quantity']) < 1)
    || !object(input['reading']) || !object(input['controls']) || !object(host)
    || Object.keys(host).some(key => !['authority', 'configuration', 'continuation', 'browser', 'browserControls'].includes(key))
    || host['browserControls'] !== undefined && host['browser'] === undefined
    || !object(host['authority']) || !object(host['configuration'])) throw new ProtectedPaymentRequestError();
  const window = row['window'] === undefined ? undefined : captureCheckoutWindowCheckpoint(row['window']);
  const replyHistory = row['replyHistory'] === undefined ? undefined : window ? capturePaymentReplyHistory(row['replyHistory'], window) : (() => { throw new ProtectedPaymentRequestError(); })();
  if (window && (window.record.purchaseId !== row['purchaseId'] || window.record.cardId !== input['cardId'] || window.record.item !== input['item']
    || window.record.reservationId !== row['purchaseId'])) throw new ProtectedPaymentRequestError();
  const reading = readCheckoutReadingInput(input['reading']);
  if (!reading.ok || !isDeepStrictEqual(captureOwnedJson(reading.reading), input['reading'])) throw new ProtectedPaymentRequestError();
  const controls = input['controls'];
  if (!text(controls['placeOrderTarget']) || !Array.isArray(controls['cardFields'])
    || controls['cardFields'].length === 0 || controls['cardFields'].some(field => !object(field) || !text(field['field']) || !text(field['ref']))
    || controls['addressFields'] !== undefined && (!Array.isArray(controls['addressFields']) || controls['addressFields'].some(field => !object(field) || !text(field['kind']) || !text(field['field']) || !text(field['ref'])))
    || controls['shippingTargets'] !== undefined && (!Array.isArray(controls['shippingTargets']) || controls['shippingTargets'].some(target => !text(target)))
    || controls['expirySeparator'] !== undefined && typeof controls['expirySeparator'] !== 'string'
    || controls['twoDigitYear'] !== undefined && typeof controls['twoDigitYear'] !== 'boolean'
    || input['preferredTier'] !== undefined && !tier(input['preferredTier'])
    || input['requestedMax'] !== undefined && (typeof input['requestedMax'] !== 'string' || !/^\d+(?:\.\d{1,3})?$/.test(input['requestedMax']))
    || input['merchantDiscovered'] !== undefined && typeof input['merchantDiscovered'] !== 'boolean') throw new ProtectedPaymentRequestError();
  const authority = host['authority'];
  if (authority['kind'] !== 'pairing-token' || authority['principalId'] !== row['principalId'] || !text(authority['tokenId'])
    || !text(authority['authorityId']) || !text(authority['authorityRevision']) || !Array.isArray(authority['scopes'])
    || authority['scopes'].some(scope => !text(scope)) || !(authority['scopes'].includes('*') || authority['scopes'].includes('write:payments'))) throw new ProtectedPaymentRequestError();
  const config = host['configuration'], limits = config['limits'];
  if (!object(limits) || !amount(limits['dailyItemMinorUnits']) || !amount(limits['dailyOverageMinorUnits'])
    || !object(limits['perPurchaseCeiling']) || typeof limits['perPurchaseCeiling']['enabled'] !== 'boolean' || !amount(limits['perPurchaseCeiling']['minorUnits'])
    || !object(limits['overageTolerance']) || typeof limits['overageTolerance']['enabled'] !== 'boolean' || !amount(limits['overageTolerance']['dailyAllowanceMinorUnits'])
    || typeof config['budgetCurrency'] !== 'string' || !/^[A-Z]{3}$/.test(config['budgetCurrency']) || !text(config['timezone'])
    || !tier(config['preferredTier']) || !amount(config['approvalMinutes']) || !amount(config['vetoMinutes'])
    || config['merchantPolicy'] !== undefined && !object(config['merchantPolicy'])) throw new ProtectedPaymentRequestError();
  const policy = config['merchantPolicy'];
  if (object(policy) && (['additional', 'excluded'].some(key => policy[key] !== undefined && typeof policy[key] !== 'string')
    || policy['marketplaces'] !== undefined && !['major', 'requires-approval', 'first-party-only'].includes(String(policy['marketplaces']))
    || policy['listingThresholds'] !== undefined && (!object(policy['listingThresholds'])
      || !amount(policy['listingThresholds']['minSellerFeedbackCount']) || !amount(policy['listingThresholds']['minSellerPositivePercent'])
      || policy['listingThresholds']['minAccountAgeDays'] !== null && !amount(policy['listingThresholds']['minAccountAgeDays'])))) throw new ProtectedPaymentRequestError();
  // Only optional object properties may disappear in JSON. Normalize those
  // before encryption/readback; null, false, zero and empty separators survive.
  const savedConfig = optionalFields({ ...config, ...(object(policy)
    ? { merchantPolicy: optionalFields(policy, ['additional', 'excluded', 'marketplaces', 'listingThresholds']) } : {}) }, ['merchantPolicy']);
  const browserControls = host['browserControls'] === undefined ? undefined : captureBrowserControlSnapshot(host['browserControls']);
  if (browserControls) {
    const requested = controls as unknown as BeginCheckoutInput['controls'];
    const refs = new Set([
      ...requested.cardFields.map(field => field.ref), ...(requested.addressFields ?? []).map(field => field.ref),
      ...(requested.shippingTargets ?? []), requested.placeOrderTarget,
    ]);
    if (browserControls.controls.length !== refs.size || browserControls.controls.some(control => !refs.has(control.ref))) throw new ProtectedPaymentRequestError();
  }
  return Object.freeze({ ...row, ...(window ? { window } : {}), ...(replyHistory ? { replyHistory } : {}), evidence: captureRetainedTaintEvidence(row['evidence']),
    input: optionalFields({ ...input, controls: optionalFields(controls, ['addressFields', 'shippingTargets', 'expirySeparator', 'twoDigitYear']) }, ['preferredTier', 'requestedMax', 'merchantDiscovered']),
    host: Object.freeze({ authority, configuration: savedConfig,
      ...(host['browser'] === undefined ? {} : { browser: captureBrowserPageConnection(host['browser']) }),
      ...(browserControls === undefined ? {} : { browserControls }),
      ...(host['continuation'] === undefined ? {} : { continuation: capturePaymentContinuation(host['continuation'], row['operationId']) }) }) }) as unknown as ProtectedPaymentRequest;
}

/** One native cipher file per admitted identity. Same-key/record substitution,
 * uncertain publication, unsafe files and missing observed evidence all refuse.
 * No environment, tier fallback, plaintext store or secret reference is read. */
export class ProtectedPaymentRequests implements PaymentRequestStore {
  private key: { bytes: Buffer; file: FileObservation; owner: ImportFileObservation } | undefined;
  private failed = false;
  private readonly records = new Map<string, { operationId: string; physical: string }>();
  constructor(private readonly directory: string, private readonly beforeCheckpoint?: (version: 1 | 2) => void,
    private readonly beforeReplyHistory?: () => void) {}
  get supportsReplyHistory(): boolean { return this.beforeReplyHistory !== undefined; }
  private path(id: string): string { return join(this.directory, `${Buffer.from(checkoutRequestId(id)).toString('base64url')}.json`); }
  private safeDirectory(): void {
    const entry = lstatSync(this.directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new ProtectedPaymentRequestError();
  }
  private keyBytes(create: boolean, check: () => void): Buffer {
    if (this.failed) throw new ProtectedPaymentRequestError();
    current(check);
    if (create) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.safeDirectory();
    const path = join(this.directory, '.key');
    if (this.key) {
      const file = readFileObservation(path);
      assertImportFileCurrent(path, this.key.owner);
      if (file.physical !== this.key.file.physical || !file.bytes.equals(this.key.file.bytes)) throw new ProtectedPaymentRequestError();
      current(check); return this.key.bytes;
    }
    let exists = true;
    try { lstatSync(path); } catch (error) { if (!absent(error)) throw error; exists = false; }
    // A lost key cannot be replaced over old ciphertext, including a staged
    // publication whose final outcome was not recorded by the earlier process.
    if (!exists && (!create || readdirSync(this.directory).length !== 0)) throw new ProtectedPaymentRequestError();
    current(check);
    if (exists) {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 1_024 || (entry.mode & 0o077) !== 0) throw new ProtectedPaymentRequestError();
    }
    const selected = observeImportFile(path);
    assertImportFileCurrent(path, selected); current(check);
    if (!exists) {
      try { writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (!object(error) || error['code'] !== 'EEXIST') throw error; }
    }
    const file = readFileObservation(path), owner = observeImportFile(path), encoded = file.bytes.toString('utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(encoded) || !isDeepStrictEqual(selected.parents, owner.parents)
      || file.physical !== fileObservationIdentity(path) || (lstatSync(path).mode & 0o077) !== 0) throw new ProtectedPaymentRequestError();
    if (exists) assertImportFileCurrent(path, selected);
    const bytes = Buffer.from(encoded, 'hex'); this.safeDirectory();
    confirmFileDurable(path); current(check); assertImportFileCurrent(path, owner);
    this.key = { bytes, file, owner };
    return bytes;
  }
  private readOwned(id: string, operationId: string, check: () => void): ProtectedPaymentRequest {
    const key = this.keyBytes(false, check), path = this.path(id), entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > MAX_ENVELOPE_BYTES) throw new ProtectedPaymentRequestError();
    const file = readFileObservation(path);
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
    if (!object(envelope) || Object.keys(envelope).length !== 4 || envelope['version'] !== SECRETS_STORE_FORMAT_VERSION
      || typeof envelope['iv'] !== 'string' || !/^[0-9a-f]{24}$/.test(envelope['iv'])
      || typeof envelope['tag'] !== 'string' || !/^[0-9a-f]{32}$/.test(envelope['tag'])
      || typeof envelope['data'] !== 'string' || envelope['data'].length > MAX_REQUEST_BYTES * 2
      || envelope['data'].length % 2 !== 0 || !/^[0-9a-f]+$/.test(envelope['data'])) throw new ProtectedPaymentRequestError();
    const request = own(JSON.parse(decryptStore(envelope as unknown as EncryptedStoreEnvelope, key)));
    if (request.purchaseId !== id || request.operationId !== operationId) throw new ProtectedPaymentRequestError();
    current(check); this.keyBytes(false, check);
    if (fileObservationIdentity(path) !== file.physical) throw new ProtectedPaymentRequestError();
    const previous = this.records.get(id);
    if (previous && (previous.operationId !== operationId || previous.physical !== file.physical)) throw new ProtectedPaymentRequestError();
    this.records.set(id, { operationId, physical: file.physical });
    return request;
  }
  async retain(value: ProtectedPaymentRequest, check: () => void): Promise<void> {
    let staged: string | undefined;
    try {
      current(check); const request = own(value), plaintext = JSON.stringify(request);
      if (request.replyHistory) {
        if (!this.beforeReplyHistory) throw new ProtectedPaymentRequestError();
        const declared: unknown = this.beforeReplyHistory();
        if (declared !== undefined) { drainOwned(declared); throw new ProtectedPaymentRequestError(); }
        current(check);
      }
      if (Buffer.byteLength(plaintext) > MAX_REQUEST_BYTES) throw new ProtectedPaymentRequestError();
      const path = this.path(request.purchaseId), key = this.keyBytes(true, check);
      try { lstatSync(path); throw new ProtectedPaymentRequestError(); } catch (error) { if (!absent(error)) throw error; }
      staged = join(this.directory, `.new-${crypto.randomUUID()}`);
      writeFileAtomic(staged, `${JSON.stringify(encryptStore(plaintext, key))}\n`, { mode: 0o600, durable: true, cleanupStaleTemps: false });
      current(check); this.keyBytes(false, check);
      linkSync(staged, path); unlinkSync(staged); staged = undefined;
      confirmFileDurable(path); current(check);
      if (!isDeepStrictEqual(this.readOwned(request.purchaseId, request.operationId, check), request)) throw new ProtectedPaymentRequestError();
    } catch { this.failed = true; throw new ProtectedPaymentRequestError(); }
    finally { if (staged) { try { unlinkSync(staged); } catch { /* Unpublished ciphertext grants no execution. */ } } }
  }
  async read(id: string, operationId: string, check: () => void): Promise<ProtectedPaymentRequest> {
    try { return this.readOwned(id, operationId, check); }
    catch { this.failed = true; throw new ProtectedPaymentRequestError(); }
  }
  private replaceOwned(next: ProtectedPaymentRequest, file: FileObservation, check: () => void, declare: () => unknown): void {
    const id = next.purchaseId, operationId = next.operationId, path = this.path(id), plaintext = JSON.stringify(next);
    if (Buffer.byteLength(plaintext) > MAX_REQUEST_BYTES) throw new ProtectedPaymentRequestError();
    const key = this.keyBytes(false, check);
    const before = () => {
      current(check); this.keyBytes(false, check);
      const observed = readFileObservation(path);
      if (observed.physical !== file.physical || !observed.bytes.equals(file.bytes)) throw new ProtectedPaymentRequestError();
    };
    before(); const declared = declare();
    if (declared !== undefined) { drainOwned(declared); throw new ProtectedPaymentRequestError(); }
    before(); atomicWriteFileSync(path, `${JSON.stringify(encryptStore(plaintext, key))}\n`, { mode: 0o600, assertCurrent: before });
    current(check); this.keyBytes(false, check); this.records.set(id, { operationId, physical: fileObservationIdentity(path) });
    if (!isDeepStrictEqual(this.readOwned(id, operationId, check), next)) throw new ProtectedPaymentRequestError();
  }

  /** Native ingress must await this before confirming its provider cursor.
   * Duplicate redelivery preserves the first receive time; changed bytes under
   * the same bot/update event fail rather than overwrite. Edits are distinct
   * provider updates, retaining their actual event time and original message. */
  async appendReply(id: string, operationId: string, binding: PaymentReplyHistoryBinding, value: PaymentReplyHistoryEntry, check: () => void): Promise<void> {
    try {
      if (!this.beforeReplyHistory) throw new ProtectedPaymentRequestError();
      current(check); const original = this.readOwned(id, operationId, check), file = readFileObservation(this.path(id));
      const entry = capturePaymentReplyHistoryEntry(value);
      if (!original.window || !isDeepStrictEqual(paymentReplyHistoryBinding(original.window), binding)) throw new ProtectedPaymentRequestError();
      const history = original.replyHistory ?? { version: 1 as const, windows: [{ startedAtMs: entry.receivedAtMs, binding, entries: [] }] };
      const window = history.windows.at(-1);
      if (!window || !isDeepStrictEqual(window.binding, binding)) throw new ProtectedPaymentRequestError();
      const identity = historyEntryIdentity(entry), previous = window.entries.find(candidate => historyEntryIdentity(candidate) === identity);
      if (previous) {
        if (!isDeepStrictEqual({ ...entry, receivedAtMs: previous.receivedAtMs }, previous)) throw new ProtectedPaymentRequestError();
        current(check); return;
      }
      const next = own({ ...original, replyHistory: { ...history, windows: [...history.windows.slice(0, -1), { ...window, entries: [...window.entries, entry] }] } });
      this.replaceOwned(next, file, check, this.beforeReplyHistory);
    } catch { this.failed = true; throw new ProtectedPaymentRequestError(); }
  }
  /** Refresh the same encrypted request under its execution lease. Original
   * identity, intent, paired grant, configuration and source evidence survive;
   * only the window's actual quote and native control observations advance. */
  async checkpointWindow(id: string, operationId: string, window: CheckoutWindowCheckpoint,
    browser: BrowserCheckoutRecovery | null, check: () => void): Promise<void> {
    try {
      current(check);
      const original = this.readOwned(id, operationId, check), path = this.path(id), file = readFileObservation(path);
      const selected = captureCheckoutWindowCheckpoint(window);
      if (original.window && selected.record.updatedAtMs < original.window.record.updatedAtMs) throw new ProtectedPaymentRequestError();
      const recovery = browser === null ? null : captureBrowserCheckoutRecovery(browser);
      const previousPage = original.window?.record ?? original.input;
      // Reconnection allocates new local IDs, while the actual native page
      // must remain the one independently restored by the host. Serialized
      // identity alone grants nothing; the caller still owns the real lease.
      if ((selected.record.sessionId !== previousPage.sessionId || selected.record.pageId !== previousPage.pageId)
        && (!recovery || !original.host.browser || !isDeepStrictEqual(recovery.connection, original.host.browser))) throw new ProtectedPaymentRequestError();
      if (selected.terms && selected.terms.submitTarget !== original.input.controls.placeOrderTarget) throw new ProtectedPaymentRequestError();
      const { browser: _oldBrowser, browserControls: _oldControls, ...authority } = original.host;
      if (original.replyHistory && !this.beforeReplyHistory) throw new ProtectedPaymentRequestError();
      const binding = this.beforeReplyHistory ? paymentReplyHistoryBinding(selected) : undefined;
      const replyHistory = binding ? isDeepStrictEqual(original.replyHistory?.windows.at(-1)?.binding, binding) ? original.replyHistory
        : { version: 1, windows: [...(original.replyHistory?.windows ?? []), { startedAtMs: selected.record.updatedAtMs, binding, entries: [] }] } : undefined;
      const { replyHistory: _oldHistory, ...retained } = original;
      const next = own({ ...retained, window: selected, ...(replyHistory ? { replyHistory } : {}),
        host: { ...authority, ...(recovery ? { browser: recovery.connection, browserControls: recovery.controls } : {}) } });
      this.replaceOwned(next, file, check, () => {
        const declared: unknown = this.beforeCheckpoint?.(selected.terms === undefined ? 1 : 2);
        if (declared !== undefined) return declared;
        return replyHistory ? this.beforeReplyHistory?.() : undefined;
      });
    } catch { this.failed = true; throw new ProtectedPaymentRequestError(); }
  }
  async remove(id: string, operationId: string, check: () => void): Promise<void> {
    try {
      current(check); this.keyBytes(false, check);
      const owned = this.records.get(id); if (!owned || owned.operationId !== operationId) throw new ProtectedPaymentRequestError();
      const path = this.path(id);
      if (fileObservationIdentity(path) !== owned.physical) throw new ProtectedPaymentRequestError();
      current(check);
      if (!this.key) throw new ProtectedPaymentRequestError();
      assertImportFileCurrent(join(this.directory, '.key'), this.key.owner);
      if (fileObservationIdentity(path) !== owned.physical) throw new ProtectedPaymentRequestError();
      unlinkSync(path);
      const fd = openSync(this.directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      current(check); this.records.delete(id);
    } catch { this.failed = true; throw new ProtectedPaymentRequestError(); }
  }
}
