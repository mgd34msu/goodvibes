export type PaymentAnswer = 'approve' | 'deny' | 'acknowledge' | 'object';

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
export function readPaymentWindowStatus(value: unknown): { readonly windows: readonly PaymentWindowView[] } {
  const response = object(value, ['windows']);
  const windows = response['windows'];
  if (!Array.isArray(windows) || windows.length > 256) return failure();
  const ids = new Set<string>(), windowIds = new Set<string>();
  return Object.freeze({ windows: Object.freeze(windows.map((entry: unknown): PaymentWindowView => {
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
