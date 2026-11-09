/** Original native queue custody facts. These values select evidence; only
 * the held polling cursor and live account session can restore its custody. */
export interface TelegramPaymentReceiveSelector {
  readonly id: string;
  readonly accountId: string;
  readonly purchaseId: string;
  readonly sinceMs: number;
  readonly registeredAtMs: number;
  readonly offsetAtStart: number | null;
}
export interface TelegramPaymentReceiveScope { readonly conversationId: string; readonly threadId?: string | undefined }
export interface TelegramPaymentReceiveSpan extends TelegramPaymentReceiveSelector {
  readonly completedAtMs: number;
  readonly quietThroughMs: number | null;
  readonly invalid: boolean;
  readonly gaps: readonly TelegramPaymentReceiveScope[];
}
export const TELEGRAM_UPDATE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_TELEGRAM_PAYMENT_RECEIVE_SPANS = 256;
export const validReceiveTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const numberId = (value: unknown, negative = false): value is string => typeof value === 'string'
  && (negative ? /^-?[1-9]\d{0,15}$/ : /^[1-9]\d{0,15}$/).test(value) && Number.isSafeInteger(Number(value));
export function readTelegramPaymentReceiveSelector(value: unknown): TelegramPaymentReceiveSelector {
  if (!object(value) || !reference(value['id']) || !numberId(value['accountId']) || !reference(value['purchaseId'])
    || !validReceiveTime(value['sinceMs']) || !validReceiveTime(value['registeredAtMs']) || value['registeredAtMs'] < value['sinceMs']
    || !(value['offsetAtStart'] === null || typeof value['offsetAtStart'] === 'number' && Number.isSafeInteger(value['offsetAtStart']) && value['offsetAtStart'] >= 0)) throw new Error('Original Telegram receive custody is unavailable');
  return Object.freeze({ id: value['id'], accountId: value['accountId'], purchaseId: value['purchaseId'], sinceMs: value['sinceMs'],
    registeredAtMs: value['registeredAtMs'], offsetAtStart: value['offsetAtStart'] });
}
export function sameTelegramPaymentReceiveSelector(left: TelegramPaymentReceiveSelector, right: TelegramPaymentReceiveSelector): boolean {
  return left.id === right.id && left.accountId === right.accountId && left.purchaseId === right.purchaseId
    && left.sinceMs === right.sinceMs && left.registeredAtMs === right.registeredAtMs && left.offsetAtStart === right.offsetAtStart;
}
export function readTelegramPaymentReceiveSpan(value: unknown): TelegramPaymentReceiveSpan {
  const selector = readTelegramPaymentReceiveSelector(value);
  if (!object(value) || Object.keys(value).length !== 10 || !validReceiveTime(value['completedAtMs'])
    || value['completedAtMs'] < selector.registeredAtMs || typeof value['invalid'] !== 'boolean'
    || !(value['quietThroughMs'] === null || validReceiveTime(value['quietThroughMs']) && value['quietThroughMs'] >= selector.sinceMs && value['quietThroughMs'] <= value['completedAtMs'])
    || !Array.isArray(value['gaps']) || value['gaps'].length > 64) throw new Error('Original Telegram receive custody is unavailable');
  const seen = new Set<string>();
  const gaps = value['gaps'].map((scope: unknown): TelegramPaymentReceiveScope => {
    if (!object(scope) || !numberId(scope['conversationId'], true)
      || !(scope['threadId'] === undefined || numberId(scope['threadId']))
      || Object.keys(scope).some(key => key !== 'conversationId' && key !== 'threadId')) throw new Error('Original Telegram receive custody is unavailable');
    const key = JSON.stringify([scope['conversationId'], scope['threadId'] ?? null]);
    if (seen.has(key)) throw new Error('Original Telegram receive custody is unavailable'); seen.add(key);
    return Object.freeze({ conversationId: scope['conversationId'], ...(scope['threadId'] === undefined ? {} : { threadId: scope['threadId'] }) });
  });
  return Object.freeze({ ...selector, completedAtMs: value['completedAtMs'], quietThroughMs: value['quietThroughMs'], invalid: value['invalid'], gaps: Object.freeze(gaps) });
}
