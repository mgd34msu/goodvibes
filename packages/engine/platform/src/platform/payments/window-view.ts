import { readPaymentOperation, type PaymentOperationView } from './operation-view.js';

export type PaymentAnswer = 'approve' | 'deny' | 'acknowledge' | 'object';

export interface PaymentPurchaseStatus {
  readonly windows: readonly PaymentWindowView[];
  readonly operations: readonly PaymentOperationView[];
  /** Purchases whose status record could not be read; their evidence still has to be inspected. Empty when every record read. */
  readonly unreadable: readonly PaymentUnreadableOperation[];
  /** Approved purchases waiting for the owner to type the card security code (`payments.cvvHandling: 'prompt'`). */
  readonly securityCodes: readonly PaymentSecurityCodeRequestView[];
}

/** One purchase waiting for its card security code. Never carries a code. */
export interface PaymentSecurityCodeRequestView {
  readonly purchaseId: string;
  readonly windowId: string;
  readonly merchantDomain: string;
  readonly cardLast4: string;
  readonly deadlineMs: number;
}

export interface PaymentSecurityCodeAcceptance {
  readonly purchaseId: string;
  readonly windowId: string;
  readonly accepted: true;
}

/** One purchase the daemon could not read a status record for, with what to do about it. */
export interface PaymentUnreadableOperation {
  readonly purchaseId: string;
  readonly reason: string;
}

/** Owner-facing notice, never card material or a mutable waiter/capability. */
export interface PaymentWindowView {
  readonly purchaseId: string;
  readonly windowId: string;
  readonly kind: 'approval' | 'veto';
  readonly notice: string;
  readonly deadlineMs: number;
}
export interface PaymentWindowAnswer {
  readonly purchaseId: string;
  readonly windowId: string;
  readonly accepted: true;
  readonly answer: PaymentAnswer;
}

const failure = (): never => { throw new Error('The daemon returned an invalid purchase-window response. Refresh before answering.'); };
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return failure();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) return failure();
  return value as Record<string, unknown>;
}
function reference(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 ? value : failure();
}

/** Shared browser/terminal decoder: no stores, native runtime or model calls. */
export function readPaymentWindowStatus(value: unknown): PaymentPurchaseStatus {
  // `unreadable` and `securityCodes` are sent only when they have entries.
  const present = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const response = object(value, ['windows', 'operations', ...(['unreadable', 'securityCodes'] as const).filter(key => key in present)]);
  const windows = response['windows'];
  const operations = response['operations'];
  const unreadable = response['unreadable'] ?? [];
  const securityCodes = response['securityCodes'] ?? [];
  if (!Array.isArray(securityCodes) || securityCodes.length > 256) return failure();
  const capturedSecurityCodes = securityCodes.map((entry: unknown): PaymentSecurityCodeRequestView => {
    const row = object(entry, ['purchaseId', 'windowId', 'merchantDomain', 'cardLast4', 'deadlineMs']);
    if (typeof row['merchantDomain'] !== 'string' || row['merchantDomain'].length > 256 || typeof row['cardLast4'] !== 'string' || row['cardLast4'].length > 8
      || typeof row['deadlineMs'] !== 'number' || !Number.isFinite(row['deadlineMs'])) return failure();
    return Object.freeze({ purchaseId: reference(row['purchaseId']), windowId: reference(row['windowId']),
      merchantDomain: row['merchantDomain'], cardLast4: row['cardLast4'], deadlineMs: row['deadlineMs'] });
  });
  if (!Array.isArray(unreadable) || unreadable.length > 356) return failure();
  const capturedUnreadable = unreadable.map((entry: unknown): PaymentUnreadableOperation => {
    const row = object(entry, ['purchaseId', 'reason']);
    if (typeof row['reason'] !== 'string' || row['reason'].length > 1024) return failure();
    return Object.freeze({ purchaseId: reference(row['purchaseId']), reason: row['reason'] });
  });
  if (!Array.isArray(windows) || windows.length > 256 || !Array.isArray(operations) || operations.length > 356) return failure();
  const purchaseIds = new Set<string>(), operationIds = new Set<string>();
  const capturedOperations = operations.map((entry: unknown) => {
    const operation = readPaymentOperation(entry);
    if (purchaseIds.has(operation.purchaseId) || operationIds.has(operation.operationId)) return failure();
    purchaseIds.add(operation.purchaseId); operationIds.add(operation.operationId);
    return operation;
  });
  const ids = new Set<string>(), windowIds = new Set<string>();
  return Object.freeze({ operations: Object.freeze(capturedOperations), unreadable: Object.freeze(capturedUnreadable),
    securityCodes: Object.freeze(capturedSecurityCodes), windows: Object.freeze(windows.map((entry: unknown): PaymentWindowView => {
    const row = object(entry, ['purchaseId', 'windowId', 'kind', 'notice', 'deadlineMs']);
    const purchaseId = reference(row['purchaseId']), windowId = reference(row['windowId']);
    if (ids.has(purchaseId) || windowIds.has(windowId)) return failure();
    ids.add(purchaseId); windowIds.add(windowId);
    if ((row['kind'] !== 'approval' && row['kind'] !== 'veto') || typeof row['notice'] !== 'string'
      || typeof row['deadlineMs'] !== 'number' || !Number.isFinite(row['deadlineMs'])) return failure();
    return Object.freeze({ purchaseId, windowId, kind: row['kind'], notice: row['notice'], deadlineMs: row['deadlineMs'] });
  })) });
}

export function readPaymentWindowAnswer(value: unknown): PaymentWindowAnswer {
  const row = object(value, ['purchaseId', 'windowId', 'accepted', 'answer']);
  const purchaseId = reference(row['purchaseId']), windowId = reference(row['windowId']);
  const answer = row['answer'];
  if (row['accepted'] !== true || (answer !== 'approve' && answer !== 'deny' && answer !== 'acknowledge' && answer !== 'object')) return failure();
  return Object.freeze({ purchaseId, windowId, accepted: true, answer });
}

export function readPaymentSecurityCodeAcceptance(value: unknown): PaymentSecurityCodeAcceptance {
  const row = object(value, ['purchaseId', 'windowId', 'accepted']);
  if (row['accepted'] !== true) return failure();
  return Object.freeze({ purchaseId: reference(row['purchaseId']), windowId: reference(row['windowId']), accepted: true });
}
