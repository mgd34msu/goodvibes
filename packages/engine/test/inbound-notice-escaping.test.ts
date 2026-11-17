// Proves: Text a stranger wrote in a subject or sender name reaches the owner's channel as a live link, a mention or a forged extra line.
// Red when: renderNoticeForSurface stops escaping untrusted spans or stops stripping line breaks.
/**
 * Every inbound mail is attacker-written text shown under the assistant's
 * name. Rendered for any surface, a subject or sender name carries no live
 * link, no mention and no line of its own, and no markup the surface would
 * interpret. Asserted by structure (line count, the characters that make a
 * link, a mention or markup), never by wording.
 *
 * The real notice producer and the real per-surface renderer; nothing else.
 */
import { expect, test } from 'bun:test';
import { receiptTimestamp, renderInboundMailNotice } from '../platform/src/platform/email/inbound-notice.ts';
import { renderNoticeForSurface } from '../platform/src/platform/email/inbound-notice-channels.ts';
import { deliveredRecipientFromDeliveryHeaders } from '../platform/src/platform/google/delivery-evidence.ts';

const SUBJECT = '[Approve](https://evil.example/x?t=1) @everyone\nStatus: approved <https://evil.example|ok> www.evil.example';
const SENDER = 'Billing <!channel> @here [pay](evil.example/pay?t=2)';

test('a subject and sender name with links, mentions, markup and a line break render inert on every surface', async () => {
  const notice = await renderInboundMailNotice({
    senderDisplay: SENDER, subject: SUBJECT,
    deliveredTo: deliveredRecipientFromDeliveryHeaders(['owner@example.test']),
    outcome: { kind: 'inert' }, links: [], receivedAt: receiptTimestamp(new Date('2026-11-17T12:00:00Z')),
  });
  const rows = ['telegram', 'discord', 'slack', 'ntfy', 'signal'].map((surface) => {
    const text = renderNoticeForSurface(notice, surface);
    const lines = text.split('\n');
    // Only the attacker's text: the values of the From and Subject lines.
    const untrusted = lines.filter((line) => line.startsWith('From: ') || line.startsWith('Subject: ')).map((line) => line.slice(line.indexOf(': ') + 2)).join('\n');
    const markup = surface === 'slack' ? /</
      : surface === 'discord' ? /(?<!\\)[[\]()]/
        : surface === 'signal' ? /[[\]()<>`*_~|&]/
          : null;
    return {
      surface,
      ownLines: lines.length === notice.fields.length + 1,
      liveLink: /(:\/\/|\bwww\.)[a-z0-9]/i.test(untrusted) || /\b[a-z0-9-]+\.example[/?]/i.test(untrusted),
      // Slack makes a mention only of `<!here>`, `<@id>` and the like; the others of a bare `@name`.
      mention: surface === 'slack' ? /<[!@#]/.test(untrusted) : /@\w/.test(untrusted),
      markup: markup?.test(untrusted) ?? false,
    };
  });
  expect(rows).toEqual(['telegram', 'discord', 'slack', 'ntfy', 'signal'].map((surface) => ({ surface, ownLines: true, liveLink: false, mention: false, markup: false })));
});
