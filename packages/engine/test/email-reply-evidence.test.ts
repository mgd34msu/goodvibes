/**
 * A reply to a correspondent whose mail the daemon read is allowed past the
 * tainted-send refusal only on stored delivery evidence: the sender the
 * receiving server authenticated, selected by the Message-ID the reply names.
 */
import { describe, expect, test } from 'bun:test';
import { createEmailSendHandler } from '../platform/src/platform/control-plane/routes/email.ts';
import { UntrustedContentLedger, createUntrustedContentPort } from '../platform/src/platform/security/untrusted-content.ts';
import { describeSenderClaimNeutrally } from '../platform/src/platform/email/sender-claim.ts';
import { mailFixture } from './_helpers/mail-subject-source.ts';
import { useSecurityReadings } from './helpers/security-readings.ts';

useSecurityReadings();
const VERIFIED = { dkim: 'pass', spf: 'pass', dmarc: 'pass' } as const;

describe('reply delivery evidence', () => {
  test('only an authenticated sender is remembered, selected by Message-ID', async () => {
    const verified = mailFixture({
      plans: [{}],
      overrides: { describeSenderClaim: (from) => describeSenderClaimNeutrally(from, VERIFIED) },
    });
    await verified.service.readMessage(1);
    expect(verified.service.getReplyEnvelopeSenders('<synthetic@example.invalid>')).toEqual(['sender@example.invalid']);
    expect(verified.service.getReplyEnvelopeSenders('<other@example.invalid>')).toEqual([]);

    const unverified = mailFixture({ plans: [{}] });
    await unverified.service.readMessage(1);
    expect(unverified.service.getReplyEnvelopeSenders('<synthetic@example.invalid>')).toEqual([]);
  });

  test('a reply to the stored sender passes the taint check, any other recipient or Message-ID does not', async () => {
    const ledger = new UntrustedContentLedger();
    createUntrustedContentPort({ surface: 'email', toolName: 'email', ledger })
      .recordIngest({ origin: 'email:example.invalid (claimed)', at: new Date().toISOString(), content: 'Write back to sender@example.invalid or to other@example.invalid.' });
    const sent: unknown[] = [];
    const handler = createEmailSendHandler({
      listInbox: async () => ({ messages: [], total: 0 }),
      readMessage: async () => null,
      createDraft: async () => ({ draftId: 'Drafts', mailbox: 'Drafts' }),
      send: async (input) => { sent.push(input); return { messageId: 'sent-1', sentAt: '2026-07-27T00:00:00.000Z' }; },
      replyEnvelopeSenders: (id) => (id === '<known@example.invalid>' ? ['sender@example.invalid'] : []),
    }, ledger);
    const send = (body: Record<string, unknown>) =>
      handler({ body: { subject: 'Re: hello', body: 'Thanks', confirm: true, ...body }, context: {} });

    await expect(send({ to: 'sender@example.invalid', inReplyTo: '<known@example.invalid>' })).resolves.toMatchObject({ messageId: 'sent-1' });
    expect(sent).toHaveLength(1);
    // Same recipient, no Message-ID, or one nothing was read under.
    await expect(send({ to: 'sender@example.invalid' })).rejects.toThrow(/read from/);
    await expect(send({ to: 'sender@example.invalid', inReplyTo: '<unknown@example.invalid>' })).rejects.toThrow(/read from/);
    // Another address that only appears in the mail body is not the sender.
    await expect(send({ to: 'other@example.invalid', inReplyTo: '<known@example.invalid>' })).rejects.toThrow(/read from/);
    expect(sent).toHaveLength(1);
  });
});
