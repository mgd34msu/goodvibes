import { expect, test } from 'bun:test';
import { PaymentReplyInbox } from '@goodvibes-jev/engine/platform/platform/payments';
import { liveChannelPaymentNotifier } from '../../runtime/payments-composition.js';

function fixture(initial: string) {
  const values: Record<string, unknown> = { 'payments.notifyChannels': initial };
  const surfaces: string[] = [];
  const router = {
    async deliver(request: { target: { surfaceKind?: string } }) { surfaces.push(String(request.target.surfaceKind)); return 'notice'; },
    async deliverWithReceipt(request: { target: { surfaceKind?: string } }) {
      surfaces.push(String(request.target.surfaceKind));
      return { receipt: { surfaceKind: 'telegram' as const, conversationId: 'chat', messageId: 'notice' } };
    },
  };
  const replies = new PaymentReplyInbox();
  const notifier = liveChannelPaymentNotifier({ get: (key: string) => values[key] }, router, replies);
  return { values, surfaces, notifier, replies };
}

test('a notify channel set after the daemon started receives the next notice', async () => {
  const f = fixture('');
  try {
    expect(await f.notifier.deliver({ kind: 'notice', message: 'first' })).toEqual([]);
    f.values['payments.notifyChannels'] = 'telegram';
    const reports = await f.notifier.deliver({ kind: 'notice', message: 'second' });
    expect(f.surfaces).toEqual(['telegram']);
    expect(reports.map(report => report.channel)).toEqual(['telegram']);
  } finally { await f.replies.close(); }
});

test('a notify channel removed after the daemon started is no longer notified', async () => {
  const f = fixture('telegram');
  try {
    await f.notifier.deliver({ kind: 'notice', message: 'first' });
    f.values['payments.notifyChannels'] = '';
    expect(await f.notifier.deliver({ kind: 'notice', message: 'second' })).toEqual([]);
    expect(f.surfaces).toEqual(['telegram']);
  } finally { await f.replies.close(); }
});
