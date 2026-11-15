import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { extractVerification } from '../platform/src/platform/google/verification-extraction.js';
import { readVerificationArtifact } from '../platform/src/platform/google/verification-reading.js';
import type { CandidateEmail, VerificationExpectation } from '../platform/src/platform/google/verification-expectations.js';
import type { ProtectedSourceOwner } from '../platform/src/platform/security/source-screening/types.js';

/** Synthetic admission only; this does not establish the live privacy screen's accuracy. */
function sourceOwner(): ProtectedSourceOwner {
  const parts = new Map<object, readonly string[]>();
  return { capture(value: readonly string[]) { const source = {}; parts.set(source, value); return source; },
    async screen(source: object) { return { status: 'settled', receipt: source }; },
    project(receipt: object) { const value = parts.get(receipt); if (!value) throw new Error('released'); return value; },
    async release(source: object) { parts.delete(source); }, async close() {},
  } as unknown as ProtectedSourceOwner;
}
const expectation: VerificationExpectation = { id: 'test', kind: 'signup', serviceDomain: 'example.com', recipientAddress: 'test@example.com', purpose: 'signup', openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), authority: 'evidence-only' };
function email(body: string): CandidateEmail { return { messageId: 'mail', from: 'sender@example.com', deliveredTo: null, toHeaderClaim: 'test@example.com', subject: 'Verification', body }; }
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function reading(chosen: string | undefined, probability = 0.99) {
  const port = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, chosen ?? 'none', probability)
    : noulAnswer(name === `fits_${chosen?.split('_').at(-1)}` ? probability : 0.01));
  installJudgmentPort(port.port); return port;
}

test('a long mail with many numbers still yields the code beside verification wording', async () => {
  reading('artifact_0');
  const numbers = Array.from({ length: 70 }, (_, index) => `SKU${1000 + index}`).join(' ');
  const result = await readVerificationArtifact(email(`Prices: ${numbers}. Your verification code: 987654.`), expectation, { sourceOwner: sourceOwner() });
  expect(result.artifact).toEqual({ kind: 'code', code: '987654' });
});

test('when nothing can be chosen the result says why', async () => {
  reading('none');
  const none = await readVerificationArtifact(email('Your verification code: 987654.'), expectation);
  expect(none.artifact.kind === 'none' ? none.artifact.reason : '').toContain('source-screening');
  const empty = await readVerificationArtifact(email('Welcome aboard, nothing to enter.'), expectation, { sourceOwner: sourceOwner() });
  expect(empty.artifact.kind === 'none' ? empty.artifact.reason : '').toContain('no code');
});

test('a plain-http link to the service domain is refused, not followed', () => {
  const result = extractVerification(email('Confirm: http://example.com/verify?t=abc'), expectation);
  expect(result.artifact).toMatchObject({ kind: 'refused', reason: 'insecure-link', linkHost: 'example.com' });
  const secure = extractVerification(email('Confirm: http://example.com/a https://example.com/verify?t=abc'), expectation);
  expect(secure.artifact).toMatchObject({ kind: 'link', url: 'https://example.com/verify?t=abc' });
});

test('a code beside a plain-http footer link on the service domain is still returned', async () => {
  const body = 'Your verification code: 987654. Unsubscribe: http://example.com/unsub';
  expect(extractVerification(email(body), expectation).artifact).toEqual({ kind: 'code', code: '987654' });
  reading('artifact_0');
  const result = await readVerificationArtifact(email(body), expectation, { sourceOwner: sourceOwner() });
  expect(result.artifact).toEqual({ kind: 'code', code: '987654' });
});

test('a plain-http link with no code keeps its refusal through the reading path', async () => {
  reading('none');
  const result = await readVerificationArtifact(email('Confirm: http://example.com/verify?t=abc'), expectation, { sourceOwner: sourceOwner() });
  expect(result.artifact).toMatchObject({ kind: 'refused', reason: 'insecure-link' });
});
