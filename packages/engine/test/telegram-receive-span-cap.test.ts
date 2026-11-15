import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramOffsetStore } from '../platform/src/platform/channels/telegram/offset-store.js';
import { TelegramReceiveCoverageError } from '../platform/src/platform/channels/telegram/receive-progress.js';
import { MAX_TELEGRAM_PAYMENT_RECEIVE_SPANS, type TelegramPaymentReceiveSpan } from '../platform/src/platform/channels/telegram/payment-receive-span.js';

function spans(accountId: string, count: number, prefix: string): TelegramPaymentReceiveSpan[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`, accountId, purchaseId: `purchase-${prefix}-${i}`, sinceMs: 1, registeredAtMs: 1, offsetAtStart: null,
    completedAtMs: 1, quietThroughMs: null, invalid: false, gaps: [],
  }));
}

test('the receive-span cap counts every bot in the file and refuses without latching the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-tg-cap-'));
  const file = join(dir, 'cursor.json');
  try {
    const a = new TelegramOffsetStore(file, '111').retainPolling();
    a.replaceReceiveSpans(spans('111', MAX_TELEGRAM_PAYMENT_RECEIVE_SPANS - 56, 'a'), () => {});
    a.release();
    const store = new TelegramOffsetStore(file, '222');
    const b = store.retainPolling();
    b.replaceReceiveSpans(spans('222', 56, 'b'), () => {});
    expect(() => b.replaceReceiveSpans(spans('222', 57, 'b'), () => {})).toThrow(TelegramReceiveCoverageError);
    // The refusal happened before any write, so the store still answers.
    expect(b.receiveSpans()).toHaveLength(56);
    expect(() => b.replaceReceiveSpans(spans('222', 55, 'b'), () => {})).not.toThrow();
    b.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
