import { describe, expect, test } from 'bun:test';
import { extractMessageId, mergeCompanionMessages } from './companion-chat';

describe('mergeCompanionMessages dedupe', () => {
  test('a failed resend of text sent earlier stays visible', () => {
    const messages = mergeCompanionMessages(
      [{ id: 'a', role: 'user', content: 'continue', createdAt: 1 }],
      [{ id: 'l', sessionId: 's', role: 'user', content: 'continue', createdAt: 2, deliveryState: 'failed' }],
      's',
    );
    expect(messages.map(extractMessageId)).toEqual(['a', 'l']);
  });

  test('a pending message is not hidden by an identical fetched message, even a recent or untimed one', () => {
    const local = { id: 'l', sessionId: 's', role: 'user' as const, content: 'yes', createdAt: 10_000_000, deliveryState: 'local' as const };
    const recent = { id: 'a', role: 'user', content: 'yes', createdAt: 10_000_000 - 1000 };
    const untimed = { id: 'b', role: 'user', content: 'yes' };
    expect(mergeCompanionMessages([recent], [local], 's').map(extractMessageId)).toEqual(['a', 'l']);
    expect(mergeCompanionMessages([untimed], [local], 's').map(extractMessageId)).toEqual(['b', 'l']);
  });

  test('a sent message is replaced by the daemon copy, but not by an untimed or much older one', () => {
    const local = { id: 'l', sessionId: 's', role: 'user' as const, content: 'yes', createdAt: 10_000_000, deliveryState: 'sent' as const };
    const listed = { id: 'b', role: 'user', content: 'yes', createdAt: 10_000_100 };
    expect(mergeCompanionMessages([listed], [local], 's').map(extractMessageId)).toEqual(['b']);
    expect(mergeCompanionMessages([{ id: 'a', role: 'user', content: 'yes', createdAt: 1 }], [local], 's').map(extractMessageId)).toEqual(['a', 'l']);
    expect(mergeCompanionMessages([{ id: 'c', role: 'user', content: 'yes' }], [local], 's').map(extractMessageId)).toEqual(['c', 'l']);
  });
});
