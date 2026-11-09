/** Browser-neutral views. A preview ID identifies private host preparation;
 * parsing or copying it grants no channel, payment or file authority. */
export type TelegramCursorPreview =
  | { readonly state: 'not-needed'; readonly message: string }
  | { readonly state: 'unbound'; readonly previewId: string; readonly accountId: string; readonly username: string;
      readonly offset: number; readonly updatedAt: string; readonly expiresAtMs: number };
export interface TelegramCursorMigrationResult {
  readonly state: 'migrated'; readonly accountId: string; readonly offset: number;
  readonly running: boolean; readonly message: string;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
}
function offset(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function account(value: unknown): value is string { return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value)); }
function fail(): never { throw new Error('The Telegram cursor response is unavailable. Refresh its preview before trying again.'); }
export function readTelegramCursorPreview(value: unknown): TelegramCursorPreview {
  if (!record(value)) return fail();
  if (value['state'] === 'not-needed' && keys(value, ['state', 'message']) && typeof value['message'] === 'string') {
    return Object.freeze({ state: 'not-needed', message: value['message'] });
  }
  if (value['state'] !== 'unbound' || !keys(value, ['state', 'previewId', 'accountId', 'username', 'offset', 'updatedAt', 'expiresAtMs'])
    || typeof value['previewId'] !== 'string' || !/^telegram-cursor:[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/.test(value['previewId'])
    || !account(value['accountId']) || typeof value['username'] !== 'string' || !/^[A-Za-z0-9_]+$/.test(value['username'])
    || !offset(value['offset']) || typeof value['updatedAt'] !== 'string' || !Number.isFinite(Date.parse(value['updatedAt']))
    || !offset(value['expiresAtMs'])) return fail();
  return Object.freeze({ state: 'unbound', previewId: value['previewId'], accountId: value['accountId'], username: value['username'],
    offset: value['offset'], updatedAt: value['updatedAt'], expiresAtMs: value['expiresAtMs'] });
}
export function readTelegramCursorMigrationResult(value: unknown): TelegramCursorMigrationResult {
  if (!record(value) || !keys(value, ['state', 'accountId', 'offset', 'running', 'message']) || value['state'] !== 'migrated'
    || !account(value['accountId']) || !offset(value['offset']) || typeof value['running'] !== 'boolean' || typeof value['message'] !== 'string') return fail();
  return Object.freeze({ state: 'migrated', accountId: value['accountId'], offset: value['offset'], running: value['running'], message: value['message'] });
}
