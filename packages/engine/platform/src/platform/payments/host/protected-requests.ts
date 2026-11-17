/** Original checkout facts, encrypted at rest. These records never confer
 * paired authority or browser access, and are not a continuation grant. */
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import type { PaymentStoreStop } from '../payment-host-health.js';
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
import { capturePaymentReplyHistory, capturePaymentReplyHistoryEntry, capturePaymentReplyReceiveCoverage, capturePaymentReplyReceiveSpans, paymentReplyHistoryBinding, historyEntryIdentity,
  type PaymentReplyHistory, type PaymentReplyHistoryBinding, type PaymentReplyHistoryEntry, type PaymentReplyReceiveCoverage, type PaymentReplyReceiveSpan } from '../reply-history.js';
import { missingScopes } from '@goodvibes-jev/engine/daemon-api/route-helpers';

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
  readonly supportsReplyReceiveCoverage?: boolean;
  readonly supportsReplyReceiveSpans?: boolean;
  retain(request: ProtectedPaymentRequest, assertCurrent: () => void): Promise<void>;
  read(purchaseId: string, operationId: string, assertCurrent: () => void): Promise<ProtectedPaymentRequest>;
  remove(purchaseId: string, operationId: string, assertCurrent: () => void): Promise<void>;
  checkpointWindow?(purchaseId: string, operationId: string, window: CheckoutWindowCheckpoint,
    browser: BrowserCheckoutRecovery | null, assertCurrent: () => void, receiveSpans?: readonly PaymentReplyReceiveSpan[]): Promise<void>;
  appendReply?(purchaseId: string, operationId: string, binding: PaymentReplyHistoryBinding,
    entry: PaymentReplyHistoryEntry, assertCurrent: () => void): Promise<void>;
  recordReceiveCoverage?(purchaseId: string, operationId: string, binding: PaymentReplyHistoryBinding,
    coverage: PaymentReplyReceiveCoverage, assertCurrent: () => void): Promise<void>;
  /** Remove a settled purchase's request, retiring its continuation first. Nothing to do when it is gone. */
  discard?(purchaseId: string, operationId: string, retire: RetireContinuation | undefined): Promise<void>;
  /**
   * Boot housekeeping: every stored request is judged by its purchase's
   * status. `remove` deletes it after retiring its continuation; `retire` keeps
   * it as evidence and retires only the continuation. A file that cannot be
   * read is left exactly as found. Returns how many requests were removed.
   */
  sweep?(judge: (purchaseId: string, operationId: string) => PaymentRequestVerdict, retire: RetireContinuation | undefined): Promise<number>;
}
export type PaymentRequestVerdict = 'remove' | 'retire' | 'keep';
export type RetireContinuation = (grant: NativeContinuationGrant) => void | Promise<void>;
export class ProtectedPaymentRequestError extends Error {
  override readonly name = 'ProtectedPaymentRequestError';
  constructor() { super('The encrypted purchase request could not be read or written. If purchases keep being refused, the request store has stopped itself: check payments.purchase.status, then restart the daemon.'); }
}
/**
 * A refusal that says nothing about the store's files: the owner that asked is
 * no longer current, or the request it brought is not acceptable. It leaves the
 * store usable for every other purchase. Anything else that goes wrong while a
 * file is read or written makes the store refuse all further work, because the
 * evidence there can no longer be trusted.
 */
class RefusedRequestError extends ProtectedPaymentRequestError {}
const TRANSIENT_IO: ReadonlySet<string> = new Set(['ENOSPC', 'EMFILE', 'ENFILE', 'EAGAIN', 'EINTR', 'ENOMEM']);
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
  try { assertSynchronousJudgmentGuard(check, () => new RefusedRequestError()); } catch { throw new RefusedRequestError(); }
}
/** Pure validation of what a caller supplied: no file is touched, so no failure here can mean damage. */
function refuse<T>(validate: () => T): T {
  try { return validate(); } catch { throw new RefusedRequestError(); }
}
function own(value: unknown): ProtectedPaymentRequest {
  const row = captureOwnedJson(value);
  if (!object(row) || Object.keys(row).length !== 7 + (Object.hasOwn(row, 'window') ? 1 : 0) + (Object.hasOwn(row, 'replyHistory') ? 1 : 0) || row['version'] !== 1
    || !text(row['principalId']) || !text(row['operationId']) || !/^payment-operation:[0-9a-p]{8}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{12}$/.test(row['operationId'])) throw new ProtectedPaymentRequestError();
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
    || input['merchantDiscovered'] !== undefined && typeof input['merchantDiscovered'] !== 'boolean'
    || input['ownerApprovedMaxMinorUnits'] !== undefined && !amount(input['ownerApprovedMaxMinorUnits'])
    || input['standingAuthorizationId'] !== undefined && !text(input['standingAuthorizationId'])) throw new ProtectedPaymentRequestError();
  const authority = host['authority'];
  if ((authority['kind'] !== 'pairing-token' && authority['kind'] !== 'local') || authority['principalId'] !== row['principalId'] || !text(authority['tokenId'])
    || !text(authority['authorityId']) || !text(authority['authorityRevision']) || !Array.isArray(authority['scopes'])
    || authority['scopes'].some(scope => !text(scope)) || missingScopes(authority['scopes'], ['write:payments']).length > 0) throw new ProtectedPaymentRequestError();
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
    input: optionalFields({ ...input, controls: optionalFields(controls, ['addressFields', 'shippingTargets', 'expirySeparator', 'twoDigitYear']) }, ['preferredTier', 'requestedMax', 'merchantDiscovered', 'ownerApprovedMaxMinorUnits', 'standingAuthorizationId']),
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
  private readonly transient = new WeakSet<ProtectedPaymentRequestError>();
  private readonly records = new Map<string, { operationId: string; physical: string }>();
  constructor(private readonly directory: string, private readonly beforeCheckpoint?: (version: 1 | 2) => void,
    private readonly beforeReplyHistory?: () => void, private readonly beforeReplyReceiveCoverage?: () => void,
    private readonly beforeReplyReceiveSpans?: () => void,
    private readonly beforeMultiRecipientCheckpoint?: () => void) {}
  get supportsReplyHistory(): boolean { return this.beforeReplyHistory !== undefined; }
  /** Why this store stopped itself, or null while it is serving. */
  stopped(): PaymentStoreStop | null {
    return this.failed ? { store: 'encrypted purchase request store', reason: 'its key, directory or a request file could not be trusted after a write or read that could not be confirmed', path: this.directory } : null;
  }
  get supportsReplyReceiveCoverage(): boolean { return this.beforeReplyHistory !== undefined && this.beforeReplyReceiveCoverage !== undefined; }
  get supportsReplyReceiveSpans(): boolean { return this.beforeReplyHistory !== undefined && this.beforeReplyReceiveSpans !== undefined; }
  private path(id: string): string { return join(this.directory, `${Buffer.from(checkoutRequestId(id)).toString('base64url')}.json`); }
  private safeDirectory(): void {
    const entry = lstatSync(this.directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new ProtectedPaymentRequestError();
  }
  /** A key or directory that cannot be trusted stops the whole store; only the stale-owner check is a plain refusal. */
  private keyBytes(create: boolean, check: () => void): Buffer {
    if (this.failed) throw new ProtectedPaymentRequestError();
    try { return this.loadKey(create, check); }
    catch (error) {
      throw this.fault(error);
    }
  }
  /** What a caught error means for the store: a refusal stays a refusal, anything else stops it. */
  private fault(error: unknown): ProtectedPaymentRequestError {
    if (error instanceof RefusedRequestError || (error instanceof ProtectedPaymentRequestError && this.transient.has(error))) return error;
    // Running out of descriptors or disk while reading says nothing about the
    // file: this call fails and the next one may succeed. The marker keeps an
    // outer catch from latching the store over the same, already judged error.
    if (object(error) && typeof error['code'] === 'string' && TRANSIENT_IO.has(error['code'])) {
      const transient = new ProtectedPaymentRequestError(); this.transient.add(transient); return transient;
    }
    this.failed = true; return new ProtectedPaymentRequestError();
  }
  private loadKey(create: boolean, check: () => void): Buffer {
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
  /** `operationId` null reads whichever operation the file names, for housekeeping only. */
  private readOwned(id: string, operationId: string | null, check: () => void): ProtectedPaymentRequest {
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
    this.declareMultiRecipientCheckpoint(request.window);
    if (request.purchaseId !== id || (operationId !== null && request.operationId !== operationId)) throw new ProtectedPaymentRequestError();
    current(check); this.keyBytes(false, check);
    if (fileObservationIdentity(path) !== file.physical) throw new ProtectedPaymentRequestError();
    const previous = this.records.get(id);
    if (previous && (previous.operationId !== request.operationId || previous.physical !== file.physical)) throw new ProtectedPaymentRequestError();
    this.records.set(id, { operationId: request.operationId, physical: file.physical });
    return request;
  }

  async discard(id: string, operationId: string, retire: RetireContinuation | undefined): Promise<void> {
    if (this.failed) throw new ProtectedPaymentRequestError();
    let request: ProtectedPaymentRequest;
    try {
      try { lstatSync(this.path(id)); } catch (error) { if (absent(error)) return; throw error; }
      request = this.readOwned(id, null, () => undefined);
    } catch (error) { throw this.fault(error); }
    // A different operation's request under the same identity is not this purchase's to remove.
    if (request.operationId !== operationId) return;
    if (request.host.continuation && retire) await retire(request.host.continuation);
    await this.remove(id, operationId, () => undefined);
  }

  async sweep(judge: (purchaseId: string, operationId: string) => PaymentRequestVerdict, retire: RetireContinuation | undefined): Promise<number> {
    if (this.failed) return 0;
    let names: string[];
    try { names = readdirSync(this.directory); } catch (error) { if (absent(error)) return 0; throw this.fault(error); }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      let id: string, request: ProtectedPaymentRequest;
      try {
        id = checkoutRequestId(Buffer.from(name.slice(0, -'.json'.length), 'base64url').toString('utf8'));
        if (this.path(id) !== join(this.directory, name)) continue;
        request = this.readOwned(id, null, () => undefined);
      } catch {
        if (this.failed) return removed;
        continue;
      }
      const verdict = judge(id, request.operationId);
      if (verdict === 'keep') continue;
      try {
        if (request.host.continuation && retire) await retire(request.host.continuation);
        if (verdict === 'remove') { await this.remove(id, request.operationId, () => undefined); removed++; }
      } catch {
        if (this.failed) return removed;
      }
    }
    return removed;
  }
  async retain(value: ProtectedPaymentRequest, check: () => void): Promise<void> {
    // Nothing is on disk yet, so a request this store will not accept (or an
    // owner that is no longer current) is refused without stopping the store.
    const { request, plaintext } = refuse(() => {
      current(check); const request = own(value), plaintext = JSON.stringify(request);
      if (Buffer.byteLength(plaintext) > MAX_REQUEST_BYTES) throw new Error();
      return { request, plaintext };
    });
    let staged: string | undefined, published = false;
    try {
      this.declareMultiRecipientCheckpoint(request.window); current(check);
      const replyHistory = request.replyHistory;
      if (replyHistory) {
        if (!this.beforeReplyHistory) throw new ProtectedPaymentRequestError();
        assertSynchronousJudgmentGuard(() => this.declareHistory(replyHistory), () => new ProtectedPaymentRequestError());
        current(check);
      }
      const path = this.path(request.purchaseId), key = this.keyBytes(true, check);
      try { lstatSync(path); throw new ProtectedPaymentRequestError(); } catch (error) { if (!absent(error)) throw error; }
      staged = join(this.directory, `.new-${crypto.randomUUID()}`);
      writeFileAtomic(staged, `${JSON.stringify(encryptStore(plaintext, key))}\n`, { mode: 0o600, durable: true, cleanupStaleTemps: false });
      current(check); this.keyBytes(false, check);
      linkSync(staged, path); published = true; unlinkSync(staged); staged = undefined;
      confirmFileDurable(path); current(check);
      if (!isDeepStrictEqual(this.readOwned(request.purchaseId, request.operationId, check), request)) throw new ProtectedPaymentRequestError();
    } catch (error) {
      // Only a record that may now exist needs the store stopped. Before the
      // link there is nothing to doubt, so a full disk or a refusal while
      // staging fails this one purchase and leaves the rest able to start.
      if (!published) throw error instanceof RefusedRequestError ? error : new ProtectedPaymentRequestError();
      this.failed = true; throw new ProtectedPaymentRequestError();
    }
    finally { if (staged) { try { unlinkSync(staged); } catch { /* Unpublished ciphertext grants no execution. */ } } }
  }
  async read(id: string, operationId: string, check: () => void): Promise<ProtectedPaymentRequest> {
    try { return this.readOwned(id, operationId, check); }
    catch (error) { throw this.fault(error); }
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
    try {
      before(); assertSynchronousJudgmentGuard(declare, () => new ProtectedPaymentRequestError());
      before(); atomicWriteFileSync(path, `${JSON.stringify(encryptStore(plaintext, key))}\n`, { mode: 0o600, assertCurrent: before });
    } catch (error) {
      if (error instanceof RefusedRequestError) throw error;
      // A failed write (full disk, no free descriptors) that left the file as
      // it was has damaged nothing: this purchase's update fails, the store
      // keeps serving the others. A file that changed or cannot be re-read
      // stops the store.
      let unchanged = false;
      try { const observed = readFileObservation(path); unchanged = observed.physical === file.physical && observed.bytes.equals(file.bytes); } catch { /* Unverifiable counts as changed. */ }
      if (unchanged) throw new RefusedRequestError();
      throw error;
    }
    // The new bytes are published: from here a stale owner cannot be treated as
    // a plain refusal, the store has to stop until someone inspects the file.
    try {
      current(check); this.keyBytes(false, check); this.records.set(id, { operationId, physical: fileObservationIdentity(path) });
      // The file holds JSON: a field the record carries as undefined is not in it, so the
      // record read back is compared with the record as JSON keeps it.
      if (!isDeepStrictEqual(this.readOwned(id, operationId, check), JSON.parse(JSON.stringify(next)) as unknown)) throw new ProtectedPaymentRequestError();
    } catch (error) { this.failed = true; throw error instanceof RefusedRequestError ? new ProtectedPaymentRequestError() : error; }
  }

  private declareMultiRecipientCheckpoint(window: CheckoutWindowCheckpoint | undefined): void {
    const deliveries = window?.record.windowDeliveries ?? [];
    if (new Set(deliveries.map(delivery => delivery.channel)).size === deliveries.length) return;
    // Older checkpoint readers accepted at most one recipient per channel.
    // Declare this exact new shape before publication/adoption, including
    // imported encrypted windows, so rollback preflight sees the requirement.
    if (!this.beforeMultiRecipientCheckpoint) throw new ProtectedPaymentRequestError();
    try { assertSynchronousJudgmentGuard(() => this.beforeMultiRecipientCheckpoint?.(), () => new ProtectedPaymentRequestError()); }
    catch (error) { throw error instanceof Error ? error : new ProtectedPaymentRequestError(); }
  }

  private declareHistory(history: PaymentReplyHistory): unknown {
    const declared: unknown = this.beforeReplyHistory?.();
    if (declared !== undefined) return declared;
    if (history.windows.some(window => window.receiveCoverage !== undefined)) {
      if (!this.beforeReplyReceiveCoverage) throw new ProtectedPaymentRequestError();
      const coverage: unknown = this.beforeReplyReceiveCoverage(); if (coverage !== undefined) return coverage;
    }
    if (history.windows.some(window => window.receiveSpans !== undefined)) {
      if (!this.beforeReplyReceiveSpans) throw new ProtectedPaymentRequestError();
      return this.beforeReplyReceiveSpans();
    }
    return undefined;
  }

  /** Called by the original live receiver only after its entire delivered
   * window is drained. The original operation, file, notice and source guard
   * remain current through durable publication; parsed proof is not authority. */
  async recordReceiveCoverage(id: string, operationId: string, binding: PaymentReplyHistoryBinding, value: PaymentReplyReceiveCoverage, check: () => void): Promise<void> {
    // A receiver retired before storage starts has not damaged its file. Keep
    // the original store usable for the executor's bookkeeping-only cleanup.
    try { current(check); } catch { throw new RefusedRequestError(); }
    try {
      if (!this.supportsReplyReceiveCoverage) throw new ProtectedPaymentRequestError();
      const original = this.readOwned(id, operationId, check), file = readFileObservation(this.path(id));
      const next = refuse(() => {
        if (!original.window || !original.replyHistory || !isDeepStrictEqual(paymentReplyHistoryBinding(original.window), binding)) throw new Error();
        const coverage = capturePaymentReplyReceiveCoverage(value, binding), history = original.replyHistory, window = history.windows.at(-1);
        if (!window || !isDeepStrictEqual(window.binding, binding)) throw new Error();
        const cutoff = window.receiveSpans?.find(span => isDeepStrictEqual(span.receipt, coverage.receipt))?.deadlineMs ?? binding.deadlineMs;
        if (coverage.throughMs !== cutoff) throw new Error();
        const previous = window.receiveCoverage?.find(entry => isDeepStrictEqual(entry.receipt, coverage.receipt));
        if (previous) return null;
        return own({ ...original, replyHistory: { ...history, windows: [...history.windows.slice(0, -1),
          { ...window, receiveCoverage: [...(window.receiveCoverage ?? []), coverage] }] } });
      });
      if (next === null) { current(check); return; }
      const nextHistory = next.replyHistory; if (!nextHistory) throw new ProtectedPaymentRequestError();
      this.replaceOwned(next, file, check, () => this.declareHistory(nextHistory));
    } catch (error) { throw this.fault(error); }
  }

  /** Native ingress must await this before confirming its provider cursor.
   * Duplicate redelivery preserves the first receive time; changed bytes under
   * the same bot/update event fail rather than overwrite. Edits are distinct
   * provider updates, retaining their actual event time and original message. */
  async appendReply(id: string, operationId: string, binding: PaymentReplyHistoryBinding, value: PaymentReplyHistoryEntry, check: () => void): Promise<void> {
    try {
      if (!this.beforeReplyHistory) throw new ProtectedPaymentRequestError();
      current(check); const original = this.readOwned(id, operationId, check), file = readFileObservation(this.path(id));
      // A message this purchase's archive will not take (a changed duplicate,
      // or one past the archive's size cap) is refused for this purchase only;
      // the caller does not confirm its cursor, so nothing is silently lost.
      const next = refuse(() => {
        const entry = capturePaymentReplyHistoryEntry(value);
        if (!original.window || !isDeepStrictEqual(paymentReplyHistoryBinding(original.window), binding)) throw new Error();
        const history = original.replyHistory ?? { version: 1 as const, windows: [{ startedAtMs: entry.receivedAtMs, binding, entries: [] }] };
        const window = history.windows.at(-1);
        if (!window || !isDeepStrictEqual(window.binding, binding)) throw new Error();
        const identity = historyEntryIdentity(entry), previous = window.entries.find(candidate => historyEntryIdentity(candidate) === identity);
        if (previous) {
          if (!isDeepStrictEqual({ ...entry, receivedAtMs: previous.receivedAtMs }, previous)) throw new Error();
          return null;
        }
        return own({ ...original, replyHistory: { ...history, windows: [...history.windows.slice(0, -1), { ...window, entries: [...window.entries, entry] }] } });
      });
      if (next === null) { current(check); return; }
      const nextHistory = next.replyHistory; if (!nextHistory) throw new ProtectedPaymentRequestError();
      this.replaceOwned(next, file, check, () => this.declareHistory(nextHistory));
    } catch (error) { throw this.fault(error); }
  }
  /** Refresh the same encrypted request under its execution lease. Original
   * identity, intent, paired grant, configuration and source evidence survive;
   * only the window's actual quote and native control observations advance. */
  async checkpointWindow(id: string, operationId: string, window: CheckoutWindowCheckpoint,
    browser: BrowserCheckoutRecovery | null, check: () => void, receiveSpans?: readonly PaymentReplyReceiveSpan[]): Promise<void> {
    try {
      current(check);
      const original = this.readOwned(id, operationId, check), path = this.path(id), file = readFileObservation(path);
      const { selected, next } = refuse(() => {
        const selected = captureCheckoutWindowCheckpoint(window);
        if (original.window && selected.record.updatedAtMs < original.window.record.updatedAtMs) throw new Error();
        const recovery = browser === null ? null : captureBrowserCheckoutRecovery(browser);
        const previousPage = original.window?.record ?? original.input;
        // Reconnection allocates new local IDs, while the actual native page
        // must remain the one independently restored by the host. Serialized
        // identity alone grants nothing; the caller still owns the real lease.
        if ((selected.record.sessionId !== previousPage.sessionId || selected.record.pageId !== previousPage.pageId)
          && (!recovery || !original.host.browser || !isDeepStrictEqual(recovery.connection, original.host.browser))) throw new Error();
        if (selected.terms && selected.terms.submitTarget !== original.input.controls.placeOrderTarget) throw new Error();
        const { browser: _oldBrowser, browserControls: _oldControls, ...authority } = original.host;
        if (original.replyHistory && !this.beforeReplyHistory) throw new Error();
        const binding = this.beforeReplyHistory ? paymentReplyHistoryBinding(selected) : undefined;
        const spans = binding && receiveSpans?.length ? capturePaymentReplyReceiveSpans(receiveSpans, binding, id) : undefined;
        const carriedCoverage = binding ? original.replyHistory?.windows.at(-1)?.receiveCoverage?.filter(coverage =>
          binding.receipts.some(receipt => isDeepStrictEqual(receipt, coverage.receipt))
          && coverage.throughMs === (spans?.find(span => isDeepStrictEqual(span.receipt, coverage.receipt))?.deadlineMs ?? binding.deadlineMs)) : undefined;
        const replyHistory = binding ? isDeepStrictEqual(original.replyHistory?.windows.at(-1)?.binding, binding) ? original.replyHistory
          : { version: 1, windows: [...(original.replyHistory?.windows ?? []), {
            startedAtMs: spans ? Math.min(selected.record.updatedAtMs, ...spans.map(span => span.selector.sinceMs)) : selected.record.updatedAtMs,
            binding, entries: [], ...(spans ? { receiveSpans: spans } : {}), ...(carriedCoverage?.length ? { receiveCoverage: carriedCoverage } : {}) }] } : undefined;
        const { replyHistory: _oldHistory, ...retained } = original;
        const next = own({ ...retained, window: selected, ...(replyHistory ? { replyHistory } : {}),
          host: { ...authority, ...(recovery ? { browser: recovery.connection, browserControls: recovery.controls } : {}) } });
        return { selected, next };
      });
      this.replaceOwned(next, file, check, () => {
        this.declareMultiRecipientCheckpoint(selected);
        const declared: unknown = this.beforeCheckpoint?.(selected.terms === undefined ? 1 : 2);
        if (declared !== undefined) return declared;
        return next.replyHistory ? this.declareHistory(next.replyHistory) : undefined;
      });
    } catch (error) { throw this.fault(error); }
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
      try {
        const fd = openSync(this.directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        current(check); this.records.delete(id);
      } catch { this.failed = true; throw new ProtectedPaymentRequestError(); }
    } catch (error) { throw this.fault(error); }
  }
}
