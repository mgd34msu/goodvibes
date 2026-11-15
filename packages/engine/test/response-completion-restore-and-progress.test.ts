import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConversationManager } from '../platform/src/platform/core/conversation.js';
import { ResponseCompletionGuard } from '../platform/src/platform/core/response-completion.js';
import { completionFinding } from '../platform/src/platform/core/response-completion-findings.js';
import { VerificationHeldError } from '../platform/src/platform/core/verification/types.js';
import { VerificationStore } from '../platform/src/platform/core/verification/store.js';
import { VerificationJournalSource } from '../platform/src/platform/core/verification/journal-source.js';
import { issueVerificationId } from '../platform/src/platform/core/verification/source.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(.01)).port); });
afterEach(() => { installJudgmentPort(previous); });

describe('a progress check that cannot run', () => {
  test('is recorded as a checker failure and does not tell the model its prose was unsupported', async () => {
    const conversation = new ConversationManager();
    // The person's own messages are never clipped, so an oversized one exceeds the evidence budget.
    conversation.addUserMessage('Review everything. ' + 'x'.repeat(450_000));
    const store = new VerificationStore();
    const guard = new ResponseCompletionGuard({ request: 'Review everything.', conversation, verificationStore: store });
    const outcome = await guard.checkProgress({ request: 'Review everything.', response: 'Reading the files now.', conversation, tools: ['read'] });
    expect(outcome.correction).toContain('progress check could not run');
    expect(outcome.correction).toContain('not a finding about the text');
    expect(outcome.correction).not.toContain('unsupported');
    expect([...store.proposals.keys()].some(key => key.includes('completion-verification-failure'))).toBe(true);
    expect(() => outcome.assertCurrent()).toThrow();
  });
});

/** A journal whose stored originals cannot be read back, as a failing disk read would behave. */
class UnreadableOriginals extends VerificationStore {
  override original(): never { throw new VerificationHeldError('unreadable journal original'); }
}

describe('resuming with a saved repair checkpoint', () => {
  function checkpointed(store: VerificationStore, conversation: ConversationManager): void {
    const request = VerificationJournalSource.capture(issueVerificationId('original'), { request: 'Write review.md.' });
    store.rememberOriginal(request);
    store.rememberRepairCheckpoint(conversation.getCurrentBranch(), { schemaVersion: 2, id: issueVerificationId('repair'), count: 0, requestSource: request.id, sourceIds: [],
      review: { findings: [{ ...completionFinding('unfinished'), assessment: 'confirmed' }] }, response: 'Done.' });
  }

  test('keeps the classic fallback closed when a saved checkpoint cannot be read', () => {
    const conversation = new ConversationManager();
    const store = new UnreadableOriginals();
    checkpointed(store, conversation);
    const guard = new ResponseCompletionGuard({ request: 'Write review.md.', conversation, verificationStore: store });
    expect((guard as unknown as { hasSemanticRefusal: boolean }).hasSemanticRefusal).toBe(true);
    expect([...store.proposals.keys()].some(key => key.includes('completion-verification-failure'))).toBe(true);
  });

  test('a readable checkpoint with confirmed defects restores the refusal', () => {
    const conversation = new ConversationManager();
    const store = new VerificationStore();
    checkpointed(store, conversation);
    const guard = new ResponseCompletionGuard({ request: 'Write review.md.', conversation, verificationStore: store });
    expect((guard as unknown as { hasSemanticRefusal: boolean }).hasSemanticRefusal).toBe(true);
  });

  test('without a saved checkpoint the fallback stays open', () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage('Write review.md.');
    const guard = new ResponseCompletionGuard({ request: 'Write review.md.', conversation, verificationStore: new VerificationStore() });
    expect((guard as unknown as { hasSemanticRefusal: boolean }).hasSemanticRefusal).toBe(false);
  });
});
