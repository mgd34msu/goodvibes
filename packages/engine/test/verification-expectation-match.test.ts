// Proves: A forged mail is taken as the verification mail the agent is waiting for, and its link or code is used.
// Red when: matchCandidate accepts a mail on its To header alone, from an unrelated sender, or one of two that both match.
/**
 * Anyone can send mail naming the signup alias. A mail counts as the awaited
 * verification only when the receiving side proves it was delivered to that
 * alias, it comes from the service's own domain, and it is the only such mail;
 * anything else leaves the expectation open for the genuine one.
 *
 * The real expectation book; nothing is a stand-in.
 */
import { expect, test } from 'bun:test';
import { deliveredRecipientFromDeliveryHeaders } from '../platform/src/platform/google/delivery-evidence.ts';
import { VerificationExpectationBook, type CandidateEmail } from '../platform/src/platform/google/verification-expectations.ts';

const ALIAS = 'signup+k3x9@owner.example';
const now = new Date('2026-11-17T12:00:00Z');

function mail(messageId: string, from: string, delivered: boolean): CandidateEmail {
  return {
    messageId, from, toHeaderClaim: ALIAS, subject: 'Confirm your account',
    body: 'Open https://service.example/verify?t=1 to confirm.',
    deliveredTo: delivered ? deliveredRecipientFromDeliveryHeaders([ALIAS]) : null,
  };
}

test('only one mail delivered to the alias from the service\'s domain matches; a forged, unrelated or racing one leaves the expectation open', () => {
  const book = new VerificationExpectationBook();
  const { expectation } = book.openExpectation({ serviceDomain: 'service.example', recipientAddress: ALIAS, purpose: 'sign up at service.example', now });
  const stillOpen = () => book.get(expectation.id, now) !== null;

  const genuine = mail('genuine', 'Service <no-reply@service.example>', true);
  const rows = {
    toHeaderOnly: [book.matchCandidate(mail('forged', 'Service <no-reply@service.example>', false), now).kind, stillOpen()],
    unrelatedSender: [book.matchCandidate(mail('phish', 'Service <no-reply@service-login.example>', true), now).kind, stillOpen()],
    twoThatMatch: [book.matchCandidates([genuine, mail('racer', 'Service <alerts@service.example>', true)], now).kind, stillOpen()],
    genuine: [book.matchCandidates([genuine], now).kind, stillOpen()],
    genuineAgain: [book.matchCandidate(genuine, now).kind, stillOpen()],
  };

  expect(rows).toEqual({
    toHeaderOnly: ['no-delivery-evidence', true],
    unrelatedSender: ['sender-unrelated', true],
    twoThatMatch: ['ambiguous', true],
    genuine: ['matched', false],
    genuineAgain: ['no-expectation', false],
  });
});
