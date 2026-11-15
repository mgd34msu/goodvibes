import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../platform/src/platform/core/conversation.ts';
import {
  appendVerificationObservation,
  appendVerificationRuntimeMessage,
  detachVerificationMessages,
  isVerificationRuntimeMessage,
  registerVerificationArchive,
  verificationMessages,
} from '../platform/src/platform/core/verification/archive.ts';

function archivedConversation(): { conversation: ConversationManager; failNextSave: () => void; saves: () => number } {
  const conversation = new ConversationManager();
  let failing = false, saved = 0;
  registerVerificationArchive(conversation, () => {
    if (failing) { failing = false; throw new Error('journal write refused'); }
    saved++;
  });
  return { conversation, failNextSave: () => { failing = true; }, saves: () => saved };
}

describe('archive edits write the journal before changing memory', () => {
  test('a failed save while detaching an undone turn leaves the runtime mark in place', () => {
    const { conversation, failNextSave } = archivedConversation();
    conversation.addUserMessage('Check the report.');
    appendVerificationObservation(conversation, 'Observed native delivery.');
    expect(isVerificationRuntimeMessage(conversation, 1)).toBe(true);

    failNextSave();
    expect(() => detachVerificationMessages(conversation, 1, {})).toThrow('journal write refused');
    expect(isVerificationRuntimeMessage(conversation, 1)).toBe(true);

    // The journal heals on the next successful save, and the same edit then applies.
    detachVerificationMessages(conversation, 1, {});
    expect(isVerificationRuntimeMessage(conversation, 1)).toBe(false);
  });

  test('a failed save while marking a host message leaves no mark behind', () => {
    const { conversation, failNextSave } = archivedConversation();
    conversation.addUserMessage('Look at the picture.');
    failNextSave();
    expect(() => appendVerificationRuntimeMessage(conversation, [{ type: 'text' as const, text: '[Images from read tool results]' }])).toThrow('journal write refused');
    expect(isVerificationRuntimeMessage(conversation, 1)).toBe(false);
  });
});

describe('host-made user-slot messages', () => {
  test('a runtime message with content parts is projected to the verifier as non-user evidence', () => {
    const { conversation } = archivedConversation();
    conversation.addUserMessage('What is in image.png?');
    appendVerificationRuntimeMessage(conversation, [{ type: 'text' as const, text: '[Images from read tool results]' }]);
    const projected = verificationMessages(conversation, conversation.getMessageSnapshot());
    expect(projected[0]!.role).toBe('user');
    expect(projected[1]!.role).toBe('system');
    expect(isVerificationRuntimeMessage(conversation, 1)).toBe(true);
    expect(isVerificationRuntimeMessage(conversation, 0)).toBe(false);
  });
});
